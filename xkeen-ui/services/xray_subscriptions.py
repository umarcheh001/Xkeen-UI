"""Xray subscription management for XKeen UI.

The service stores subscription definitions in UI state, fetches V2Ray-style
subscription bodies, converts share links into Xray outbound fragments, and can
keep Xray observatory subjects in sync for leastPing/probing.
"""

from __future__ import annotations

import base64
import concurrent.futures
import contextlib
import copy
import hashlib
import json
import os
import re
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
from typing import Any, Callable, Dict, Iterable, List, Tuple
from urllib.parse import parse_qs, unquote, urlparse

from services.io.atomic import _atomic_write_json, _atomic_write_text
from services.url_policy import URLPolicy, env_flag, is_url_allowed
from services.xray_config_files import OUTBOUNDS_FILE, ROUTING_FILE, ensure_xray_jsonc_dir, jsonc_path_for
from services.xray_outbounds import LEGACY_VLESS_TAG, build_proxy_outbound_from_link


STATE_VERSION = 1
STATE_FILENAME = "xray_subscriptions.json"

DEFAULT_INTERVAL_HOURS = 6
MIN_INTERVAL_HOURS = 1
MAX_INTERVAL_HOURS = 168
DEFAULT_FETCH_TIMEOUT_SECONDS = 20
DEFAULT_MAX_BODY_BYTES = 1024 * 1024

SUPPORTED_SCHEMES = (
    "vless://",
    "trojan://",
    "vmess://",
    "ss://",
    "shadowsocks://",
    "hy2://",
    "hysteria2://",
    "hysteria://",
)

IGNORED_OUTBOUND_PROTOCOLS = {
    "blackhole",
    "dns",
    "freedom",
    "loopback",
}

RESERVED_TAGS = {
    "direct",
    "block",
    "dns",
    "freedom",
    "blackhole",
    "reject",
    "bypass",
    "api",
    "xray-api",
    "metrics",
}

_SUPPORTED_LINK_RE = re.compile(
    r"(?i)\b(?:vless|trojan|vmess|ss|shadowsocks|hy2|hysteria2|hysteria)://[^\s\"'<>]+"
)

_STATE_LOCK = threading.RLock()
_SCHEDULER_LOCK = threading.Lock()
_SCHEDULER_STARTED = False
_MISSING = object()

NAME_FILTER_KEYS = ("name_filter", "nameFilter", "name_regex", "nameRegex")
TYPE_FILTER_KEYS = ("type_filter", "typeFilter", "type_regex", "typeRegex")
TRANSPORT_FILTER_KEYS = ("transport_filter", "transportFilter", "transport_regex", "transportRegex")
EXCLUDED_NODE_KEYS_KEYS = ("excluded_node_keys", "excludedNodeKeys", "exclude_node_keys", "excludeNodeKeys")
LAST_NODES_KEYS = ("last_nodes", "lastNodes")
NODE_LATENCY_KEYS = ("node_latency", "nodeLatency")

DEFAULT_PROBE_URL = "https://www.gstatic.com/generate_204"
DEFAULT_PROBE_TIMEOUT_SECONDS = 8.0
PROBE_PROCESS_START_TIMEOUT_SECONDS = 4.0
PROBE_PROCESS_START_ATTEMPTS = 3
PROBE_BATCH_CONCURRENCY = 3
NODE_LATENCY_HISTORY_LIMIT = 5
AUTO_BALANCER_RULE_TAG = "xk_auto_leastPing"
AUTO_BALANCER_TAG = "proxy"
AUTO_BALANCER_FALLBACK_TAG = "direct"
AUTO_BALANCER_PRESERVE_TAGS = ("vless-reality",)
AUTO_MIGRATED_RULE_TAG_PREFIX = "xk_auto_vless_pool_"
ROUTING_MODE_SAFE = "safe-fallback"
ROUTING_MODE_STRICT = "migrate-vless-rules"


SnapshotCallback = Callable[[str], None]
RestartCallback = Callable[..., Any]


def subscription_state_path(ui_state_dir: str) -> str:
    return os.path.join(str(ui_state_dir or "/opt/etc/xkeen-ui"), STATE_FILENAME)


def _now() -> float:
    return time.time()


def _read_json_file(path: str, default: Any) -> Any:
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def _write_state(ui_state_dir: str, state: Dict[str, Any]) -> None:
    path = subscription_state_path(ui_state_dir)
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    _atomic_write_json(path, state)


def _clamp_interval(value: Any) -> int:
    try:
        hours = int(float(str(value).strip()))
    except Exception:
        hours = DEFAULT_INTERVAL_HOURS
    return max(MIN_INTERVAL_HOURS, min(MAX_INTERVAL_HOURS, hours))


def _clean_id(value: Any) -> str:
    raw = str(value or "").strip().lower()
    raw = re.sub(r"[^a-z0-9_.-]+", "-", raw)
    raw = re.sub(r"-{2,}", "-", raw).strip("-._")
    if not raw:
        raw = "sub"
    if raw[0].isdigit():
        raw = "sub-" + raw
    return raw[:40].strip("-._") or "sub"


def _clean_tag_prefix(value: Any, fallback: str) -> str:
    raw = str(value or "").strip()
    if not raw:
        raw = fallback
    raw = re.sub(r"\s+", "_", raw)
    raw = re.sub(r"[^A-Za-z0-9_.:-]+", "_", raw)
    raw = raw.strip("_.:-")
    if not raw:
        raw = fallback or "sub"
    if raw.lower() in RESERVED_TAGS:
        raw = raw + "_sub"
    return raw[:32].strip("_.:-") or "sub"


def _clean_regex_filter(value: Any) -> str:
    return str(value or "").strip()


def _clean_routing_mode(value: Any) -> str:
    raw = str(value or "").strip().lower()
    if raw in {
        ROUTING_MODE_STRICT,
        "migrate_vless_rules",
        "strict",
        "pool",
        "prefer-subscription-pool",
    }:
        return ROUTING_MODE_STRICT
    return ROUTING_MODE_SAFE


def _read_filter_value(data: Any, keys: tuple[str, ...]) -> Any:
    if not isinstance(data, dict):
        return _MISSING
    for key in keys:
        if key in data:
            return _clean_regex_filter(data.get(key))
    return _MISSING


def _stored_filter_value(data: Any, keys: tuple[str, ...]) -> str:
    value = _read_filter_value(data, keys)
    return "" if value is _MISSING else str(value)


def _clean_string_list(value: Any) -> List[str]:
    items = value if isinstance(value, list) else []
    out: List[str] = []
    seen: set[str] = set()
    for item in items:
        text = str(item or "").strip()
        if not text or text in seen:
            continue
        seen.add(text)
        out.append(text)
    return out


def _read_string_list_value(data: Any, keys: tuple[str, ...]) -> List[str]:
    if not isinstance(data, dict):
        return []
    for key in keys:
        if key in data:
            return _clean_string_list(data.get(key))
    return []


def _has_any_key(data: Any, keys: tuple[str, ...]) -> bool:
    if not isinstance(data, dict):
        return False
    return any(key in data for key in keys)


def _normalize_last_nodes(value: Any) -> List[Dict[str, Any]]:
    allowed_fields = {
        "key",
        "tag",
        "name",
        "protocol",
        "transport",
        "security",
        "host",
        "port",
        "detail",
        "source_format",
    }
    out: List[Dict[str, Any]] = []
    for item in value if isinstance(value, list) else []:
        if not isinstance(item, dict):
            continue
        clean: Dict[str, Any] = {}
        for field in allowed_fields:
            if field == "port":
                port = item.get("port")
                try:
                    clean["port"] = int(port)
                except Exception:
                    text = str(port or "").strip()
                    if text:
                        clean["port"] = text
                continue
            text = str(item.get(field) or "").strip()
            if text:
                clean[field] = text
        if clean.get("key") and clean.get("name"):
            out.append(clean)
    return out


def _safe_float(value: Any) -> float | None:
    try:
        return float(value)
    except Exception:
        return None


def _safe_positive_int(value: Any) -> int | None:
    try:
        out = int(float(value))
    except Exception:
        return None
    return out if out >= 0 else None


def _normalize_latency_history(value: Any) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for item in value if isinstance(value, list) else []:
        if not isinstance(item, dict):
            continue
        checked_at = _safe_float(item.get("checked_at") if "checked_at" in item else item.get("checkedAt"))
        status = str(item.get("status") or "").strip().lower() or "unknown"
        delay_ms = _safe_positive_int(item.get("delay_ms") if "delay_ms" in item else item.get("delayMs"))
        error = str(item.get("error") or "").strip()
        clean: Dict[str, Any] = {"status": status}
        if checked_at is not None:
            clean["checked_at"] = checked_at
        if delay_ms is not None:
            clean["delay_ms"] = delay_ms
        if error:
            clean["error"] = error[:240]
        out.append(clean)
        if len(out) >= NODE_LATENCY_HISTORY_LIMIT:
            break
    return out


def _normalize_node_latency_map(value: Any) -> Dict[str, Dict[str, Any]]:
    out: Dict[str, Dict[str, Any]] = {}
    if not isinstance(value, dict):
        return out
    for raw_key, item in value.items():
        key = str(raw_key or "").strip()
        if not key or not isinstance(item, dict):
            continue
        checked_at = _safe_float(item.get("checked_at") if "checked_at" in item else item.get("checkedAt"))
        delay_ms = _safe_positive_int(item.get("delay_ms") if "delay_ms" in item else item.get("delayMs"))
        status = str(item.get("status") or ("ok" if delay_ms is not None else "unknown")).strip().lower() or "unknown"
        error = str(item.get("error") or "").strip()
        probe_url = str(item.get("probe_url") if "probe_url" in item else item.get("probeUrl") or "").strip()
        history = _normalize_latency_history(item.get("history"))
        clean: Dict[str, Any] = {
            "status": status,
            "history": history,
        }
        if checked_at is not None:
            clean["checked_at"] = checked_at
        if delay_ms is not None:
            clean["delay_ms"] = delay_ms
        if error:
            clean["error"] = error[:240]
        if probe_url:
            clean["probe_url"] = probe_url
        out[key] = clean
    return out


def _prune_node_latency_map(value: Any, nodes: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    raw = _normalize_node_latency_map(value)
    allowed = {
        str(item.get("key") or "").strip()
        for item in (nodes or [])
        if isinstance(item, dict) and str(item.get("key") or "").strip()
    }
    if not allowed:
        return {}
    return {key: entry for key, entry in raw.items() if key in allowed}


def _compile_regex_filter(value: Any, label: str) -> re.Pattern[str] | None:
    raw = _clean_regex_filter(value)
    if not raw:
        return None
    try:
        return re.compile(raw, re.IGNORECASE)
    except re.error as exc:
        raise ValueError(f"Некорректный regex для {label}: {exc}") from exc


def _unique_id(base: str, existing: Iterable[str]) -> str:
    used = {str(x or "") for x in existing}
    cand = _clean_id(base)
    if cand not in used:
        return cand
    root = cand[:34].strip("-._") or "sub"
    idx = 2
    while True:
        next_id = f"{root}-{idx}"
        if next_id not in used:
            return next_id
        idx += 1


def _default_id_from_url(url: str) -> str:
    try:
        host = urlparse(str(url or "")).hostname or ""
    except Exception:
        host = ""
    return _clean_id(host or "subscription")


def _subscription_output_file(sub_id: str) -> str:
    return f"04_outbounds.{_clean_id(sub_id)}.json"


def _subscription_output_path(xray_configs_dir: str, sub: Dict[str, Any]) -> str:
    name = str(sub.get("output_file") or "").strip()
    if not name:
        name = _subscription_output_file(sub.get("id") or "sub")
    name = os.path.basename(name)
    if not name.lower().endswith(".json"):
        name += ".json"
    return os.path.join(str(xray_configs_dir or ""), name)


def _normalize_state(obj: Any) -> Dict[str, Any]:
    if not isinstance(obj, dict):
        obj = {}
    subs = obj.get("subscriptions")
    if not isinstance(subs, list):
        subs = []
    clean_subs: List[Dict[str, Any]] = []
    seen: set[str] = set()
    for item in subs:
        if not isinstance(item, dict):
            continue
        url = str(item.get("url") or "").strip()
        if not url:
            continue
        sub_id = _clean_id(item.get("id") or item.get("tag") or item.get("name") or _default_id_from_url(url))
        if sub_id in seen:
            sub_id = _unique_id(sub_id, seen)
        seen.add(sub_id)
        tag = _clean_tag_prefix(item.get("tag") or sub_id, sub_id)
        interval = _clamp_interval(item.get("interval_hours") or item.get("intervalHours") or DEFAULT_INTERVAL_HOURS)
        output_file = str(item.get("output_file") or item.get("outputFile") or _subscription_output_file(sub_id)).strip()
        output_file = os.path.basename(output_file) or _subscription_output_file(sub_id)
        if not output_file.lower().endswith(".json"):
            output_file += ".json"
        name_filter = _stored_filter_value(item, NAME_FILTER_KEYS)
        type_filter = _stored_filter_value(item, TYPE_FILTER_KEYS)
        transport_filter = _stored_filter_value(item, TRANSPORT_FILTER_KEYS)
        excluded_node_keys = _read_string_list_value(item, EXCLUDED_NODE_KEYS_KEYS)
        last_nodes = _normalize_last_nodes(
            item.get("last_nodes") if "last_nodes" in item else item.get("lastNodes")
        )
        node_latency = _normalize_node_latency_map(
            item.get("node_latency") if "node_latency" in item else item.get("nodeLatency")
        )

        clean = dict(item)
        for alias in (
            NAME_FILTER_KEYS[1:]
            + TYPE_FILTER_KEYS[1:]
            + TRANSPORT_FILTER_KEYS[1:]
            + EXCLUDED_NODE_KEYS_KEYS[1:]
            + LAST_NODES_KEYS[1:]
            + NODE_LATENCY_KEYS[1:]
        ):
            clean.pop(alias, None)
        clean.update(
            {
                "id": sub_id,
                "name": str(item.get("name") or tag).strip() or tag,
                "tag": tag,
                "url": url,
                "name_filter": name_filter,
                "type_filter": type_filter,
                "transport_filter": transport_filter,
                "excluded_node_keys": excluded_node_keys,
                "enabled": bool(item.get("enabled", True)),
                "ping_enabled": bool(item.get("ping_enabled", item.get("pingEnabled", True))),
                "routing_mode": _clean_routing_mode(item.get("routing_mode", item.get("routingMode"))),
                "interval_hours": interval,
                "output_file": output_file,
                "last_nodes": last_nodes,
                "node_latency": _prune_node_latency_map(node_latency, last_nodes),
                "last_tags": [str(x) for x in item.get("last_tags", []) if str(x or "").strip()]
                if isinstance(item.get("last_tags"), list)
                else [],
            }
        )
        clean_subs.append(clean)
    return {"version": STATE_VERSION, "subscriptions": clean_subs}


def load_subscription_state(ui_state_dir: str) -> Dict[str, Any]:
    with _STATE_LOCK:
        return _normalize_state(_read_json_file(subscription_state_path(ui_state_dir), {"subscriptions": []}))


def list_subscriptions(ui_state_dir: str) -> List[Dict[str, Any]]:
    return list(load_subscription_state(ui_state_dir).get("subscriptions") or [])


def _find_subscription(state: Dict[str, Any], sub_id: str) -> Tuple[int, Dict[str, Any] | None]:
    target = _clean_id(sub_id)
    subs = state.get("subscriptions") if isinstance(state, dict) else []
    if not isinstance(subs, list):
        return -1, None
    for idx, sub in enumerate(subs):
        if isinstance(sub, dict) and _clean_id(sub.get("id")) == target:
            return idx, sub
    return -1, None


def upsert_subscription(ui_state_dir: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    data = payload if isinstance(payload, dict) else {}
    url = str(data.get("url") or "").strip()
    if not url:
        raise ValueError("url is required")

    with _STATE_LOCK:
        state = load_subscription_state(ui_state_dir)
        subs = state.get("subscriptions")
        if not isinstance(subs, list):
            subs = []
            state["subscriptions"] = subs

        raw_id = str(data.get("id") or "").strip()
        if raw_id:
            sub_id = _clean_id(raw_id)
            idx, existing = _find_subscription(state, sub_id)
        else:
            existing_ids = [str(s.get("id") or "") for s in subs if isinstance(s, dict)]
            sub_id = _unique_id(data.get("tag") or data.get("name") or _default_id_from_url(url), existing_ids)
            idx, existing = -1, None

        base = dict(existing or {})
        tag = _clean_tag_prefix(data.get("tag") or base.get("tag") or sub_id, sub_id)
        interval = _clamp_interval(data.get("interval_hours") or data.get("intervalHours") or base.get("interval_hours") or DEFAULT_INTERVAL_HOURS)
        output_file = str(base.get("output_file") or _subscription_output_file(sub_id)).strip()
        output_file = os.path.basename(output_file) or _subscription_output_file(sub_id)
        if not output_file.lower().endswith(".json"):
            output_file += ".json"
        name_filter_raw = _read_filter_value(data, NAME_FILTER_KEYS)
        type_filter_raw = _read_filter_value(data, TYPE_FILTER_KEYS)
        transport_filter_raw = _read_filter_value(data, TRANSPORT_FILTER_KEYS)
        excluded_node_keys = (
            _read_string_list_value(data, EXCLUDED_NODE_KEYS_KEYS)
            if _has_any_key(data, EXCLUDED_NODE_KEYS_KEYS)
            else _read_string_list_value(base, EXCLUDED_NODE_KEYS_KEYS)
        )
        name_filter = _clean_regex_filter(
            _stored_filter_value(base, NAME_FILTER_KEYS) if name_filter_raw is _MISSING else name_filter_raw
        )
        type_filter = _clean_regex_filter(
            _stored_filter_value(base, TYPE_FILTER_KEYS) if type_filter_raw is _MISSING else type_filter_raw
        )
        transport_filter = _clean_regex_filter(
            _stored_filter_value(base, TRANSPORT_FILTER_KEYS) if transport_filter_raw is _MISSING else transport_filter_raw
        )
        routing_mode = _clean_routing_mode(data.get("routing_mode", data.get("routingMode", base.get("routing_mode"))))
        _compile_regex_filter(name_filter, "фильтра имени")
        _compile_regex_filter(type_filter, "фильтра типа")
        _compile_regex_filter(transport_filter, "фильтра транспорта")

        now_ts = _now()
        sub = dict(base)
        for alias in (
            NAME_FILTER_KEYS[1:]
            + TYPE_FILTER_KEYS[1:]
            + TRANSPORT_FILTER_KEYS[1:]
            + EXCLUDED_NODE_KEYS_KEYS[1:]
            + LAST_NODES_KEYS[1:]
            + NODE_LATENCY_KEYS[1:]
        ):
            sub.pop(alias, None)
        sub.update(
            {
                "id": sub_id,
                "name": str(data.get("name") or base.get("name") or tag).strip() or tag,
                "tag": tag,
                "url": url,
                "name_filter": name_filter,
                "type_filter": type_filter,
                "transport_filter": transport_filter,
                "excluded_node_keys": excluded_node_keys,
                "enabled": bool(data.get("enabled", base.get("enabled", True))),
                "ping_enabled": bool(data.get("ping_enabled", data.get("pingEnabled", base.get("ping_enabled", True)))),
                "routing_mode": routing_mode,
                "interval_hours": interval,
                "output_file": output_file,
                "node_latency": _prune_node_latency_map(base.get("node_latency"), _normalize_last_nodes(base.get("last_nodes"))),
                "updated_ts": now_ts,
            }
        )
        if not sub.get("created_ts"):
            sub["created_ts"] = now_ts
        if not sub.get("next_update_ts"):
            sub["next_update_ts"] = 0 if sub["enabled"] else None

        if idx >= 0:
            subs[idx] = sub
        else:
            subs.append(sub)
        _write_state(ui_state_dir, _normalize_state(state))

    return sub


def delete_subscription(
    ui_state_dir: str,
    sub_id: str,
    *,
    xray_configs_dir: str,
    snapshot: SnapshotCallback | None = None,
    remove_file: bool = True,
    restart_xkeen: RestartCallback | None = None,
) -> Dict[str, Any]:
    removed: Dict[str, Any] | None = None
    with _STATE_LOCK:
        state = load_subscription_state(ui_state_dir)
        idx, sub = _find_subscription(state, sub_id)
        if idx < 0 or sub is None:
            raise KeyError("subscription not found")
        removed = dict(sub)
        subs = state.get("subscriptions")
        if isinstance(subs, list):
            subs.pop(idx)
        _write_state(ui_state_dir, _normalize_state(state))

    output_removed = False
    if remove_file and removed:
        output_path = _subscription_output_path(xray_configs_dir, removed)
        try:
            if os.path.isfile(output_path):
                if snapshot:
                    snapshot(output_path)
                os.remove(output_path)
                output_removed = True
        except Exception:
            output_removed = False

    observatory_changed = False
    routing_changed = False
    routing_sync: Dict[str, Any] = {}
    old_tags = removed.get("last_tags") if removed else []
    preserved_tags = _preserved_balancer_tags(xray_configs_dir)
    effective_routing_mode = _effective_subscription_routing_mode(ui_state_dir)
    if isinstance(old_tags, list) and old_tags:
        observatory_changed = sync_observatory_subjects(
            xray_configs_dir=xray_configs_dir,
            add_tags=preserved_tags,
            remove_tags=[str(t) for t in old_tags],
            snapshot=snapshot,
        )
        routing_sync = sync_subscription_routing(
            xray_configs_dir=xray_configs_dir,
            add_tags=preserved_tags,
            remove_tags=[str(t) for t in old_tags],
            routing_mode=effective_routing_mode,
            snapshot=snapshot,
        )
        routing_changed = bool(routing_sync.get("changed"))

    restarted = False
    if restart_xkeen and (output_removed or observatory_changed or routing_changed):
        try:
            restarted = bool(restart_xkeen(source="xray-subscription-delete"))
        except TypeError:
            restarted = bool(restart_xkeen())
        except Exception:
            restarted = False

    return {
        "deleted": removed,
        "output_removed": output_removed,
        "observatory_changed": observatory_changed,
        "routing_changed": routing_changed,
        "routing_file": str(routing_sync.get("routing_file") or ""),
        "restarted": restarted,
    }


def _subscription_policy() -> URLPolicy:
    return URLPolicy(
        allow_hosts=(),
        allow_http=env_flag("XKEEN_SUBSCRIPTION_ALLOW_HTTP", False),
        allow_private_hosts=env_flag("XKEEN_SUBSCRIPTION_ALLOW_PRIVATE_HOSTS", False),
        allow_custom_urls=True,
    )


class _SafeRedirect(urllib.request.HTTPRedirectHandler):
    def __init__(self, policy: URLPolicy):
        super().__init__()
        self._policy = policy

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D401,N803
        ok, reason = is_url_allowed(newurl, self._policy)
        if not ok:
            raise urllib.error.URLError("url_blocked:" + reason)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def fetch_subscription_body(url: str) -> Tuple[str, Dict[str, str]]:
    url_s = str(url or "").strip()
    policy = _subscription_policy()
    ok, reason = is_url_allowed(url_s, policy)
    if not ok:
        raise RuntimeError("url_blocked:" + reason)

    timeout = DEFAULT_FETCH_TIMEOUT_SECONDS
    try:
        timeout = max(3, min(120, int(os.environ.get("XKEEN_SUBSCRIPTION_FETCH_TIMEOUT", str(timeout)))))
    except Exception:
        timeout = DEFAULT_FETCH_TIMEOUT_SECONDS

    max_bytes = DEFAULT_MAX_BODY_BYTES
    try:
        max_bytes = max(64 * 1024, int(os.environ.get("XKEEN_SUBSCRIPTION_MAX_BYTES", str(max_bytes))))
    except Exception:
        max_bytes = DEFAULT_MAX_BODY_BYTES

    opener = urllib.request.build_opener(_SafeRedirect(policy))
    req = urllib.request.Request(url_s, headers={"User-Agent": "XKeen-UI Subscription Fetcher"})
    with opener.open(req, timeout=timeout) as resp:
        status = getattr(resp, "status", None)
        if isinstance(status, int) and status >= 400:
            raise RuntimeError(f"http_{status}")
        try:
            length = resp.headers.get("Content-Length")
            if length is not None and int(length) > max_bytes:
                raise RuntimeError("size_limit")
        except ValueError:
            pass

        chunks: List[bytes] = []
        total = 0
        while True:
            chunk = resp.read(64 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > max_bytes:
                raise RuntimeError("size_limit")
            chunks.append(chunk)

        headers = {str(k).lower(): str(v) for k, v in dict(resp.headers.items()).items()}
        body = b"".join(chunks).decode("utf-8", errors="replace")
        return body, headers


def _looks_like_proxy_list(text: str) -> bool:
    low = str(text or "").lower()
    return any(s in low for s in SUPPORTED_SCHEMES)


def _decode_subscription_base64_text(text: str) -> str | None:
    raw = str(text or "").strip()
    if not raw:
        return None
    compact = re.sub(r"\s+", "", raw)
    if not compact:
        return None
    if not re.fullmatch(r"[A-Za-z0-9+/=_-]+", compact):
        return None
    try:
        padded = compact.replace("-", "+").replace("_", "/")
        padded += "=" * (-len(padded) % 4)
        decoded = base64.b64decode(padded.encode("utf-8"), validate=False).decode("utf-8", errors="replace")
    except Exception:
        return None
    decoded = decoded.strip()
    return decoded or None


def _decode_subscription_base64(text: str) -> str | None:
    decoded = _decode_subscription_base64_text(text)
    if decoded and _looks_like_proxy_list(decoded):
        return decoded
    return None


def parse_subscription_links(body: str) -> List[str]:
    text = str(body or "").strip().lstrip("\ufeff")
    if not text:
        return []

    decoded = _decode_subscription_base64(text)
    if decoded:
        text = decoded

    search_text = text.replace("\\/", "/")
    links: List[str] = []
    seen: set[str] = set()

    def add_link(value: str) -> None:
        value = str(value or "").strip()
        if not value:
            return
        value_l = value.lower()
        if not any(value_l.startswith(s) for s in SUPPORTED_SCHEMES):
            return
        if value in seen:
            return
        seen.add(value)
        links.append(value)

    for line in search_text.replace("\r", "\n").split("\n"):
        add_link(line)

    for match in _SUPPORTED_LINK_RE.finditer(search_text):
        value = match.group(0).strip().rstrip("]})")
        if any(value and value in existing for existing in seen):
            continue
        add_link(value)
    return links


def _load_subscription_json(body: str) -> Any | None:
    text = str(body or "").strip().lstrip("\ufeff")
    if not text:
        return None

    candidates = [text]
    decoded = _decode_subscription_base64_text(text)
    if decoded and decoded not in candidates:
        candidates.append(decoded)

    for candidate in candidates:
        stripped = str(candidate or "").strip().lstrip("\ufeff")
        if not stripped or stripped[0] not in "[{":
            continue
        try:
            return json.loads(stripped)
        except Exception:
            continue
    return None


def _json_name_hint(obj: Dict[str, Any]) -> str:
    for key in ("remarks", "remark", "name", "ps", "title", "tag"):
        value = str(obj.get(key) or "").strip()
        if value:
            return value
    return ""


def _is_proxy_outbound(obj: Any) -> bool:
    if not isinstance(obj, dict):
        return False
    protocol = str(obj.get("protocol") or "").strip().lower()
    if not protocol or protocol in IGNORED_OUTBOUND_PROTOCOLS:
        return False
    if not isinstance(obj.get("settings"), dict):
        return False
    return True


def _iter_json_proxy_outbounds(obj: Any, parent_name: str = "") -> Iterable[Tuple[Dict[str, Any], str]]:
    if isinstance(obj, list):
        for item in obj:
            yield from _iter_json_proxy_outbounds(item, parent_name)
        return

    if not isinstance(obj, dict):
        return

    name_hint = _json_name_hint(obj) or parent_name
    if _is_proxy_outbound(obj):
        yield obj, name_hint
        return

    outbounds = obj.get("outbounds")
    if isinstance(outbounds, list):
        for outbound in outbounds:
            if _is_proxy_outbound(outbound):
                yield outbound, name_hint
        return

    for key in ("configs", "items", "nodes", "profiles", "servers", "subscriptions"):
        child = obj.get(key)
        if isinstance(child, (dict, list)):
            yield from _iter_json_proxy_outbounds(child, name_hint)


def _parse_profile_interval_hours(headers: Dict[str, str]) -> int | None:
    for key in ("profile-update-interval", "profile_update_interval", "x-profile-update-interval"):
        value = headers.get(key)
        if value is None:
            continue
        try:
            n = int(float(str(value).strip()))
        except Exception:
            continue
        if n > 0:
            return _clamp_interval(n)
    return None


def _node_name_from_link(link: str) -> str:
    raw = str(link or "")
    try:
        if "#" in raw:
            frag = raw.rsplit("#", 1)[1]
            frag = unquote(frag).strip()
            if frag:
                return frag
    except Exception:
        pass

    try:
        if raw.lower().startswith("vmess://"):
            payload = raw[8:].strip()
            payload = payload.replace("-", "+").replace("_", "/")
            payload += "=" * (-len(payload) % 4)
            data = json.loads(base64.b64decode(payload.encode("utf-8")).decode("utf-8", errors="replace"))
            ps = str(data.get("ps") or data.get("name") or "").strip()
            if ps:
                return ps
    except Exception:
        pass

    try:
        parsed = urlparse(raw)
        return parsed.hostname or ""
    except Exception:
        return ""


def _first_qs_value(qs: Dict[str, List[str]], *keys: str) -> str:
    for key in keys:
        values = qs.get(key)
        if not values:
            continue
        value = str(values[0] or "").strip()
        if value:
            return value
    return ""


def _default_transport_for_protocol(protocol: str) -> str:
    value = str(protocol or "").strip().lower()
    if value in {"vless", "trojan", "vmess"}:
        return "tcp"
    if value in {"ss", "shadowsocks"}:
        return "tcp+udp"
    if value in {"hy2", "hysteria2", "hysteria"}:
        return "quic"
    return ""


def _default_security_for_protocol(protocol: str) -> str:
    value = str(protocol or "").strip().lower()
    if value == "trojan":
        return "tls"
    if value in {"hy2", "hysteria2", "hysteria"}:
        return "tls"
    return ""


def _transport_filter_text(transport: str, protocol: str = "") -> str:
    parts = [str(transport or "").strip().lower()]
    proto = str(protocol or "").strip().lower()
    if proto in {"hy2", "hysteria2", "hysteria"}:
        parts.extend(["quic", "udp"])
    unique: List[str] = []
    seen: set[str] = set()
    for item in parts:
        if not item or item in seen:
            continue
        seen.add(item)
        unique.append(item)
    return " ".join(unique)


def _node_fingerprint(value: Any) -> str:
    raw = str(value or "").strip().encode("utf-8", errors="replace")
    return hashlib.sha1(raw).hexdigest()[:16]


def _build_node_detail(parts: Iterable[str]) -> str:
    out: List[str] = []
    for part in parts:
        text = str(part or "").strip()
        if text:
            out.append(text)
    return " · ".join(out[:4])


def _link_node_meta(link: str, index: int) -> Dict[str, Any]:
    raw = str(link or "").strip()
    protocol = _protocol_from_link(raw)
    name = str(_node_name_from_link(raw) or f"node{index + 1}").strip() or f"node{index + 1}"
    host = ""
    port: int | str = ""
    transport = _default_transport_for_protocol(protocol)
    security = _default_security_for_protocol(protocol)
    detail = ""

    if protocol == "vmess":
        try:
            payload = raw[8:].strip().replace("-", "+").replace("_", "/")
            payload += "=" * (-len(payload) % 4)
            data = json.loads(base64.b64decode(payload.encode("utf-8")).decode("utf-8", errors="replace"))
            host = str(data.get("add") or "").strip()
            port = str(data.get("port") or "").strip()
            name = str(data.get("ps") or name).strip() or name
            transport = str(data.get("net") or transport or "").strip().lower() or transport
            security = str(data.get("security") or data.get("tls") or security or "").strip().lower() or security
            path = str(data.get("path") or "").strip()
            host_header = str(data.get("host") or "").strip()
            detail = _build_node_detail(
                [
                    f"path={path}" if path else "",
                    f"host={host_header}" if host_header and host_header != host else "",
                ]
            )
        except Exception:
            pass
    else:
        try:
            parsed = urlparse(raw)
            host = str(parsed.hostname or "").strip()
            try:
                port = parsed.port or ""
            except Exception:
                port = ""
            qs = parse_qs(parsed.query)
            transport = _first_qs_value(qs, "type", "network") or transport
            security = _first_qs_value(qs, "security", "tls") or security
            path = _first_qs_value(qs, "path")
            service = _first_qs_value(qs, "serviceName")
            host_header = _first_qs_value(qs, "host")
            mode = _first_qs_value(qs, "mode")
            sni = _first_qs_value(qs, "sni")
            detail = _build_node_detail(
                [
                    f"path={unquote(path)}" if path else "",
                    f"service={service}" if service else "",
                    f"host={unquote(host_header)}" if host_header and unquote(host_header) != host else "",
                    f"sni={sni}" if sni and sni != host else "",
                    f"mode={mode}" if mode else "",
                ]
            )
        except Exception:
            pass

    return {
        "key": _node_fingerprint(raw),
        "name": name,
        "protocol": protocol,
        "transport": str(transport or "").strip().lower(),
        "security": str(security or "").strip().lower(),
        "host": host,
        "port": port,
        "detail": detail,
        "source_format": "links",
    }


def _extract_outbound_endpoint(source: Dict[str, Any]) -> Tuple[str, int | str]:
    settings = source.get("settings") if isinstance(source.get("settings"), dict) else {}
    if isinstance(settings.get("vnext"), list) and settings["vnext"]:
        first = settings["vnext"][0] if isinstance(settings["vnext"][0], dict) else {}
        return str(first.get("address") or "").strip(), first.get("port") or ""
    if isinstance(settings.get("servers"), list) and settings["servers"]:
        first = settings["servers"][0] if isinstance(settings["servers"][0], dict) else {}
        return str(first.get("address") or "").strip(), first.get("port") or ""
    host = str(source.get("server") or source.get("address") or settings.get("address") or "").strip()
    port = source.get("server_port") or source.get("port") or settings.get("port") or ""
    return host, port


def _json_outbound_node_meta(source: Dict[str, Any], name_hint: str, index: int) -> Dict[str, Any]:
    protocol = str(source.get("protocol") or "").strip().lower()
    stream = source.get("streamSettings") if isinstance(source.get("streamSettings"), dict) else {}
    transport = str(stream.get("network") or _default_transport_for_protocol(protocol) or "").strip().lower()
    security = str(stream.get("security") or _default_security_for_protocol(protocol) or "").strip().lower()
    host, port = _extract_outbound_endpoint(source)
    name = str(name_hint or source.get("tag") or host or protocol or f"node{index + 1}").strip() or f"node{index + 1}"

    path = ""
    service = ""
    host_header = ""
    if transport == "ws" and isinstance(stream.get("wsSettings"), dict):
        ws = stream["wsSettings"]
        path = str(ws.get("path") or "").strip()
        headers = ws.get("headers") if isinstance(ws.get("headers"), dict) else {}
        host_header = str(headers.get("Host") or headers.get("host") or "").strip()
    elif transport == "grpc" and isinstance(stream.get("grpcSettings"), dict):
        grpc = stream["grpcSettings"]
        service = str(grpc.get("serviceName") or "").strip()
        host_header = str(grpc.get("authority") or "").strip()
    elif transport == "httpupgrade" and isinstance(stream.get("httpupgradeSettings"), dict):
        httpup = stream["httpupgradeSettings"]
        path = str(httpup.get("path") or "").strip()
        host_header = str(httpup.get("host") or "").strip()
    elif transport == "xhttp" and isinstance(stream.get("xhttpSettings"), dict):
        xhttp = stream["xhttpSettings"]
        path = str(xhttp.get("path") or "").strip()
        host_header = str(xhttp.get("host") or "").strip()

    detail = _build_node_detail(
        [
            f"path={path}" if path else "",
            f"service={service}" if service else "",
            f"host={host_header}" if host_header and host_header != host else "",
        ]
    )

    try:
        fingerprint_payload = json.dumps(source, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    except Exception:
        fingerprint_payload = f"{protocol}|{name}|{host}|{port}|{transport}|{security}"

    return {
        "key": _node_fingerprint(fingerprint_payload),
        "name": name,
        "protocol": protocol,
        "transport": transport,
        "security": security,
        "host": host,
        "port": port,
        "detail": detail,
        "source_format": "xray-json",
    }


def _protocol_from_link(link: str) -> str:
    match = re.match(r"^([a-z0-9+.-]+)://", str(link or "").strip(), re.IGNORECASE)
    return str(match.group(1) or "").strip().lower() if match else ""


def _protocol_filter_text(protocol: Any) -> str:
    value = str(protocol or "").strip().lower()
    if value in {"ss", "shadowsocks"}:
        return "ss shadowsocks"
    if value in {"hy2", "hysteria2", "hysteria"}:
        return "hy2 hysteria2 hysteria"
    return value


def _subscription_filter_reasons(
    *,
    key: str,
    node_name: str,
    protocol: str,
    transport: str,
    name_filter: re.Pattern[str] | None,
    type_filter: re.Pattern[str] | None,
    transport_filter: re.Pattern[str] | None,
    excluded_node_keys: set[str] | None = None,
) -> List[str]:
    reasons: List[str] = []
    excluded = excluded_node_keys or set()
    if key and key in excluded:
        reasons.append("manual")
    if name_filter and not name_filter.search(str(node_name or "")):
        reasons.append("name")
    if type_filter and not type_filter.search(_protocol_filter_text(protocol)):
        reasons.append("type")
    if transport_filter and not transport_filter.search(_transport_filter_text(transport, protocol)):
        reasons.append("transport")
    return reasons


def _clean_node_name(name: str, fallback: str) -> str:
    out: List[str] = []
    for ch in str(name or ""):
        if ch.isalnum() or ch in {" ", "_", "-", ".", ":"}:
            out.append(ch)
    value = "".join(out)
    value = re.sub(r"\s+", " ", value).strip()
    value = value.replace(" ", "_")
    value = re.sub(r"[_-]{2,}", "_", value)
    value = value.strip("_.:-")
    if not value:
        value = fallback
    return value[:36].strip("_.:-") or fallback


def _unique_tag(base: str, used: set[str]) -> str:
    tag = base[:64].strip("_.:-") or "sub"
    if tag.lower() in RESERVED_TAGS:
        tag = tag + "_sub"
    if tag not in used:
        used.add(tag)
        return tag

    root = tag[:58].strip("_.:-") or "sub"
    idx = 2
    while True:
        cand = f"{root}-{idx}"[:64].strip("_.:-")
        if cand not in used:
            used.add(cand)
            return cand
        idx += 1


def build_subscription_outbounds(
    links: List[str],
    *,
    tag_prefix: str,
    name_filter: str = "",
    type_filter: str = "",
    transport_filter: str = "",
    excluded_node_keys: List[str] | None = None,
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]], Dict[str, Any]]:
    prefix = _clean_tag_prefix(tag_prefix, "sub")
    name_pattern = _compile_regex_filter(name_filter, "фильтра имени")
    type_pattern = _compile_regex_filter(type_filter, "фильтра типа")
    transport_pattern = _compile_regex_filter(transport_filter, "фильтра транспорта")
    excluded_keys = {str(item or "").strip() for item in (excluded_node_keys or []) if str(item or "").strip()}
    candidates = [(link, _link_node_meta(link, idx)) for idx, link in enumerate(links or [])]
    source_count = len(candidates)
    filtered_links: List[Tuple[str, Dict[str, Any], int]] = []
    preview_nodes: List[Dict[str, Any]] = []
    for link, meta in candidates:
        reasons = _subscription_filter_reasons(
            key=str(meta.get("key") or ""),
            node_name=str(meta.get("name") or ""),
            protocol=str(meta.get("protocol") or ""),
            transport=str(meta.get("transport") or ""),
            name_filter=name_pattern,
            type_filter=type_pattern,
            transport_filter=transport_pattern,
            excluded_node_keys=excluded_keys,
        )
        preview_idx = len(preview_nodes)
        preview_nodes.append(dict(meta))
        if reasons:
            continue
        filtered_links.append((link, meta, preview_idx))

    outbounds: List[Dict[str, Any]] = []
    errors: List[Dict[str, Any]] = []
    used: set[str] = set()

    for idx, (link, meta, preview_idx) in enumerate(filtered_links):
        node = _clean_node_name(str(meta.get("name") or ""), f"node{idx + 1}")
        tag = _unique_tag(f"{prefix}--{node}", used)
        preview_nodes[preview_idx]["tag"] = tag
        try:
            outbound = build_proxy_outbound_from_link(link, tag)
            outbounds.append(outbound)
        except Exception as exc:
            errors.append({"idx": idx, "tag": tag, "error": str(exc)})

    return outbounds, errors, {
        "source_count": source_count,
        "filtered_out_count": max(0, source_count - len(filtered_links)),
        "nodes": preview_nodes,
    }


def build_subscription_json_outbounds(
    body: str,
    *,
    tag_prefix: str,
    name_filter: str = "",
    type_filter: str = "",
    transport_filter: str = "",
    excluded_node_keys: List[str] | None = None,
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]], Dict[str, Any]]:
    obj = _load_subscription_json(body)
    if obj is None:
        return [], [], {"source_count": 0, "filtered_out_count": 0, "nodes": []}

    prefix = _clean_tag_prefix(tag_prefix, "sub")
    name_pattern = _compile_regex_filter(name_filter, "фильтра имени")
    type_pattern = _compile_regex_filter(type_filter, "фильтра типа")
    transport_pattern = _compile_regex_filter(transport_filter, "фильтра транспорта")
    excluded_keys = {str(item or "").strip() for item in (excluded_node_keys or []) if str(item or "").strip()}
    candidates = [
        (source, _json_outbound_node_meta(source, name_hint, idx))
        for idx, (source, name_hint) in enumerate(_iter_json_proxy_outbounds(obj))
    ]
    source_count = len(candidates)
    filtered_candidates: List[Tuple[Dict[str, Any], Dict[str, Any], int]] = []
    preview_nodes: List[Dict[str, Any]] = []
    for source, meta in candidates:
        reasons = _subscription_filter_reasons(
            key=str(meta.get("key") or ""),
            node_name=str(meta.get("name") or ""),
            protocol=str(meta.get("protocol") or ""),
            transport=str(meta.get("transport") or ""),
            name_filter=name_pattern,
            type_filter=type_pattern,
            transport_filter=transport_pattern,
            excluded_node_keys=excluded_keys,
        )
        preview_idx = len(preview_nodes)
        preview_nodes.append(dict(meta))
        if reasons:
            continue
        filtered_candidates.append((source, meta, preview_idx))

    outbounds: List[Dict[str, Any]] = []
    errors: List[Dict[str, Any]] = []
    used: set[str] = set()

    for idx, (source, meta, preview_idx) in enumerate(filtered_candidates):
        protocol = str(source.get("protocol") or "node").strip() or "node"
        fallback = f"node{idx + 1}"
        node = _clean_node_name(str(meta.get("name") or protocol), fallback)
        tag = _unique_tag(f"{prefix}--{node}", used)
        preview_nodes[preview_idx]["tag"] = tag
        try:
            outbound = copy.deepcopy(source)
            outbound["tag"] = tag
            outbounds.append(outbound)
        except Exception as exc:
            errors.append({"idx": idx, "tag": tag, "error": str(exc)})

    return outbounds, errors, {
        "source_count": source_count,
        "filtered_out_count": max(0, source_count - len(filtered_candidates)),
        "nodes": preview_nodes,
    }


def _content_hash(obj: Any) -> str:
    raw = json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def _write_json_if_changed(path: str, obj: Any, *, snapshot: SnapshotCallback | None = None) -> bool:
    new_text = json.dumps(obj, ensure_ascii=False, indent=2) + "\n"
    try:
        with open(path, "r", encoding="utf-8") as f:
            if f.read() == new_text:
                return False
    except Exception:
        pass
    if snapshot and os.path.exists(path):
        snapshot(path)
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    _atomic_write_text(path, new_text)
    return True


def _write_jsonc_sidecar_if_changed(
    main_path: str,
    obj: Any,
    *,
    header: str,
    snapshot: SnapshotCallback | None = None,
) -> bool:
    ensure_xray_jsonc_dir()
    jsonc = jsonc_path_for(main_path)
    text = str(header or "")
    if text and not text.endswith("\n"):
        text += "\n"
    text += json.dumps(obj, ensure_ascii=False, indent=2) + "\n"
    try:
        old = ""
        try:
            with open(jsonc, "r", encoding="utf-8") as f:
                old = f.read()
        except Exception:
            old = ""
        if old == text:
            return False
        if snapshot and os.path.exists(jsonc):
            snapshot(jsonc)
        _atomic_write_text(jsonc, text)
        return True
    except Exception:
        return False


def _load_observatory(path: str) -> Dict[str, Any]:
    obj = _read_json_file(path, {})
    return obj if isinstance(obj, dict) else {}


def _config_fragment_path(xray_configs_dir: str, default_path: str) -> str:
    name = os.path.basename(str(default_path or "").strip())
    if not name:
        return str(default_path or "")
    base = str(xray_configs_dir or "").strip()
    return os.path.join(base, name) if base else name


def _clean_tags_list(values: Iterable[Any]) -> List[str]:
    out: List[str] = []
    seen: set[str] = set()
    for item in values:
        tag = str(item or "").strip()
        if not tag or tag in seen:
            continue
        seen.add(tag)
        out.append(tag)
    return out


def _load_outbound_tags(path: str) -> List[str]:
    obj = _read_json_file(path, {})
    outbounds = obj if isinstance(obj, list) else obj.get("outbounds") if isinstance(obj, dict) else []
    if not isinstance(outbounds, list):
        return []
    tags: List[str] = []
    seen: set[str] = set()
    for item in outbounds:
        if not isinstance(item, dict):
            continue
        tag = str(item.get("tag") or "").strip()
        if not tag or tag in seen:
            continue
        seen.add(tag)
        tags.append(tag)
    return tags


def _preserved_balancer_tags(xray_configs_dir: str) -> List[str]:
    path = _config_fragment_path(xray_configs_dir, OUTBOUNDS_FILE)
    available = set(_load_outbound_tags(path))
    return [tag for tag in AUTO_BALANCER_PRESERVE_TAGS if tag in available]


def _ensure_routing_model(cfg: Any) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    obj = cfg if isinstance(cfg, dict) else {}
    routing = obj.get("routing")
    if not isinstance(routing, dict):
        routing = {}
        obj["routing"] = routing
    if not isinstance(routing.get("balancers"), list):
        routing["balancers"] = []
    if not isinstance(routing.get("rules"), list):
        routing["rules"] = []
    return obj, routing


def _find_balancer_by_tag(balancers: List[Any], tag: str) -> Dict[str, Any] | None:
    target = str(tag or "").strip()
    if not target:
        return None
    for item in balancers if isinstance(balancers, list) else []:
        if isinstance(item, dict) and str(item.get("tag") or "").strip() == target:
            return item
    return None


def _balancer_strategy_type(balancer: Any) -> str:
    if not isinstance(balancer, dict):
        return ""
    strategy = balancer.get("strategy")
    if not isinstance(strategy, dict):
        return ""
    return str(strategy.get("type") or "").strip().lower()


def _find_least_ping_balancer(routing: Dict[str, Any]) -> Dict[str, Any] | None:
    balancers = routing.get("balancers") if isinstance(routing, dict) else []
    if not isinstance(balancers, list):
        return None
    for balancer in balancers:
        if _balancer_strategy_type(balancer) == "leastping":
            return balancer if isinstance(balancer, dict) else None
    return None


def _rule_inbound_tags(rule: Any) -> List[str]:
    if not isinstance(rule, dict):
        return []
    raw = rule.get("inboundTag")
    if isinstance(raw, list):
        return [str(item or "").strip() for item in raw if str(item or "").strip()]
    tag = str(raw or "").strip()
    return [tag] if tag else []


def _is_default_balancer_rule(rule: Any, balancer_tag: str) -> bool:
    target = str(balancer_tag or "").strip()
    if not target or not isinstance(rule, dict):
        return False
    if str(rule.get("balancerTag") or "").strip() != target:
        return False
    allowed = {"type", "balancerTag", "ruleTag", "inboundTag"}
    if any(key not in allowed for key in rule.keys()):
        return False
    inbound = set(_rule_inbound_tags(rule))
    return not inbound or "redirect" in inbound or "tproxy" in inbound


def _is_unconditional_rule(rule: Any) -> bool:
    if not isinstance(rule, dict):
        return False
    allowed = {"type", "outboundTag", "balancerTag", "ruleTag"}
    return all(key in allowed for key in rule.keys())


def _find_auto_rule_idx(rules: List[Any], auto_tag: str = AUTO_BALANCER_RULE_TAG) -> int:
    target = str(auto_tag or "").strip()
    if not target or not isinstance(rules, list):
        return -1
    for idx, rule in enumerate(rules):
        if isinstance(rule, dict) and str(rule.get("ruleTag") or "").strip() == target:
            return idx
    return -1


def _choose_insert_index(rules: List[Any]) -> int:
    if not isinstance(rules, list) or not rules:
        return 0
    for idx in range(len(rules) - 1, -1, -1):
        rule = rules[idx]
        if not isinstance(rule, dict):
            return len(rules)
        tail_tag = str(rule.get("outboundTag") or rule.get("balancerTag") or "").strip().lower()
        if tail_tag not in {"direct", "block", "blackhole", "reject"}:
            if not _is_unconditional_rule(rule):
                return len(rules)
            continue
        allowed = {"type", "outboundTag", "balancerTag", "ruleTag", "inboundTag"}
        if any(key not in allowed for key in rule.keys()):
            return len(rules)
        inbound = set(_rule_inbound_tags(rule))
        if inbound and not inbound.issubset({"redirect", "tproxy"}):
            return len(rules)
        return idx
    return len(rules)


def _unique_balancer_tag(balancers: List[Any], preferred: str) -> str:
    used = {
        str(item.get("tag") or "").strip()
        for item in balancers if isinstance(item, dict)
        if str(item.get("tag") or "").strip()
    }
    base = str(preferred or "xk-subscriptions-proxy").strip() or "xk-subscriptions-proxy"
    if base not in used:
        return base
    idx = 2
    while True:
        candidate = f"{base}-{idx}"
        if candidate not in used:
            return candidate
        idx += 1


def _choose_auto_balancer_tag(routing: Dict[str, Any]) -> str:
    rules = routing.get("rules") if isinstance(routing, dict) else []
    idx = _find_auto_rule_idx(rules if isinstance(rules, list) else [])
    if idx >= 0 and isinstance(rules[idx], dict):
        tag = str(rules[idx].get("balancerTag") or "").strip()
        if tag:
            return tag
    least = _find_least_ping_balancer(routing)
    if least is not None:
        tag = str(least.get("tag") or "").strip()
        if tag:
            return tag
    balancers = routing.get("balancers") if isinstance(routing, dict) else []
    preferred = _find_balancer_by_tag(balancers if isinstance(balancers, list) else [], AUTO_BALANCER_TAG)
    if preferred is not None and _balancer_strategy_type(preferred) not in {"", "leastping"}:
        return _unique_balancer_tag(balancers if isinstance(balancers, list) else [], "xk-subscriptions-proxy")
    return AUTO_BALANCER_TAG


def _auto_migrated_rule_tag(rule: Any) -> str:
    if not isinstance(rule, dict):
        return ""
    return str(rule.get("ruleTag") or "").strip()


def _is_auto_migrated_vless_rule(rule: Any) -> bool:
    return _auto_migrated_rule_tag(rule).startswith(AUTO_MIGRATED_RULE_TAG_PREFIX)


def _rule_targets_vless_reality(rule: Any) -> bool:
    return isinstance(rule, dict) and str(rule.get("outboundTag") or "").strip() == "vless-reality"


def _rule_touches_proxy_inbound(rule: Any) -> bool:
    inbound = set(_rule_inbound_tags(rule))
    return not inbound or bool(inbound.intersection({"redirect", "tproxy"}))


def _next_auto_migrated_rule_tag(rules: List[Any]) -> str:
    max_idx = 0
    for rule in rules if isinstance(rules, list) else []:
        tag = _auto_migrated_rule_tag(rule)
        if not tag.startswith(AUTO_MIGRATED_RULE_TAG_PREFIX):
            continue
        suffix = tag[len(AUTO_MIGRATED_RULE_TAG_PREFIX) :]
        try:
            max_idx = max(max_idx, int(suffix))
        except Exception:
            continue
    return f"{AUTO_MIGRATED_RULE_TAG_PREFIX}{max_idx + 1:03d}"


def _sync_vless_reality_rules_to_balancer(
    routing: Dict[str, Any],
    *,
    balancer_tag: str,
    enabled: bool,
) -> Dict[str, int | bool]:
    rules = routing.get("rules")
    if not isinstance(rules, list):
        return {"changed": False, "migrated": 0, "reverted": 0, "skipped": 0}

    changed = False
    migrated = 0
    reverted = 0
    skipped = 0
    for rule in rules:
        if not isinstance(rule, dict):
            continue
        if enabled:
            if _is_auto_migrated_vless_rule(rule):
                before = copy.deepcopy(rule)
                rule.pop("outboundTag", None)
                rule["balancerTag"] = str(balancer_tag or AUTO_BALANCER_TAG).strip() or AUTO_BALANCER_TAG
                if before != rule:
                    changed = True
                continue
            if not _rule_targets_vless_reality(rule) or not _rule_touches_proxy_inbound(rule):
                continue
            if str(rule.get("ruleTag") or "").strip():
                skipped += 1
                continue
            rule["balancerTag"] = str(balancer_tag or AUTO_BALANCER_TAG).strip() or AUTO_BALANCER_TAG
            rule.pop("outboundTag", None)
            rule["ruleTag"] = _next_auto_migrated_rule_tag(rules)
            migrated += 1
            changed = True
            continue
        if not _is_auto_migrated_vless_rule(rule):
            continue
        rule.pop("balancerTag", None)
        rule["outboundTag"] = "vless-reality"
        rule.pop("ruleTag", None)
        reverted += 1
        changed = True
    return {"changed": changed, "migrated": migrated, "reverted": reverted, "skipped": skipped}


def _effective_subscription_routing_mode(ui_state_dir: str) -> str:
    state = load_subscription_state(ui_state_dir)
    for item in state.get("subscriptions") if isinstance(state, dict) else []:
        if not isinstance(item, dict):
            continue
        if item.get("enabled", True) is False:
            continue
        if _clean_routing_mode(item.get("routing_mode")) == ROUTING_MODE_STRICT:
            return ROUTING_MODE_STRICT
    return ROUTING_MODE_SAFE


def _ensure_least_ping_balancer(
    routing: Dict[str, Any],
    *,
    balancer_tag: str,
    selector_tags: List[str],
) -> bool:
    balancers = routing.get("balancers")
    if not isinstance(balancers, list):
        balancers = []
        routing["balancers"] = balancers
    balancer = _find_balancer_by_tag(balancers, balancer_tag)
    if balancer is None:
        balancer = {"tag": balancer_tag}
        balancers.append(balancer)
    before = copy.deepcopy(balancer)
    balancer["tag"] = str(balancer_tag or AUTO_BALANCER_TAG).strip() or AUTO_BALANCER_TAG
    balancer["selector"] = list(selector_tags)
    balancer["strategy"] = {"type": "leastPing"}
    fallback = str(balancer.get("fallbackTag") or AUTO_BALANCER_FALLBACK_TAG).strip() or AUTO_BALANCER_FALLBACK_TAG
    balancer["fallbackTag"] = fallback
    return before != balancer


def _ensure_default_balancer_rule(routing: Dict[str, Any], *, balancer_tag: str) -> bool:
    rules = routing.get("rules")
    if not isinstance(rules, list):
        rules = []
        routing["rules"] = rules

    candidate_idx = _find_auto_rule_idx(rules)
    if candidate_idx < 0:
        for idx, rule in enumerate(rules):
            if _is_default_balancer_rule(rule, balancer_tag):
                candidate_idx = idx
                break

    before_idx = candidate_idx
    if candidate_idx >= 0:
        rule = rules.pop(candidate_idx)
        if not isinstance(rule, dict):
            rule = {}
    else:
        rule = {}
    before_rule = copy.deepcopy(rule)
    for key in tuple(rule.keys()):
        if key not in {"type", "balancerTag", "ruleTag", "inboundTag"}:
            rule.pop(key, None)
    rule["type"] = "field"
    rule["balancerTag"] = str(balancer_tag or AUTO_BALANCER_TAG).strip() or AUTO_BALANCER_TAG
    rule["inboundTag"] = ["redirect", "tproxy"]
    rule["ruleTag"] = AUTO_BALANCER_RULE_TAG
    insert_at = _choose_insert_index(rules)
    rules.insert(insert_at, rule)
    return before_idx != insert_at or before_rule != rule


def _remove_auto_balancer_rule(routing: Dict[str, Any]) -> bool:
    rules = routing.get("rules")
    if not isinstance(rules, list):
        return False
    idx = _find_auto_rule_idx(rules)
    if idx < 0:
        return False
    rules.pop(idx)
    return True


def _remove_auto_least_ping_balancer(
    routing: Dict[str, Any],
    *,
    balancer_tag: str,
    removed_tags: set[str],
    previous_selector: List[str],
) -> bool:
    balancers = routing.get("balancers")
    if not isinstance(balancers, list):
        return False

    tag = str(balancer_tag or AUTO_BALANCER_TAG).strip() or AUTO_BALANCER_TAG
    selector_before = _clean_tags_list(previous_selector)
    if selector_before and not all(item in removed_tags for item in selector_before):
        return False

    for idx, item in enumerate(balancers):
        if not isinstance(item, dict):
            continue
        if str(item.get("tag") or "").strip() != tag:
            continue
        if _balancer_strategy_type(item) != "leastping":
            return False
        balancers.pop(idx)
        return True
    return False


def sync_subscription_routing(
    *,
    xray_configs_dir: str,
    add_tags: Iterable[str],
    remove_tags: Iterable[str] | None = None,
    routing_mode: str = ROUTING_MODE_SAFE,
    snapshot: SnapshotCallback | None = None,
) -> Dict[str, Any]:
    add = _clean_tags_list(add_tags)
    remove = set(_clean_tags_list(remove_tags or []))
    if not add and not remove:
        return {"changed": False, "selector": [], "balancer_tag": "", "routing_file": ""}

    routing_path = _config_fragment_path(xray_configs_dir, ROUTING_FILE)
    cfg, routing = _ensure_routing_model(_read_json_file(routing_path, {}))
    balancer_tag = _choose_auto_balancer_tag(routing)
    balancer = _find_balancer_by_tag(routing.get("balancers", []), balancer_tag)
    current_selector = _clean_tags_list(
        balancer.get("selector") if isinstance(balancer, dict) and isinstance(balancer.get("selector"), list) else []
    )

    selector: List[str] = []
    seen: set[str] = set()
    for tag in current_selector:
        if tag in remove or tag in seen:
            continue
        seen.add(tag)
        selector.append(tag)
    for tag in add:
        if tag in seen:
            continue
        seen.add(tag)
        selector.append(tag)

    if selector:
        for tag in _preserved_balancer_tags(xray_configs_dir):
            if tag in seen:
                continue
            seen.add(tag)
            selector.append(tag)

    changed = False
    strict_enabled = (
        _clean_routing_mode(routing_mode) == ROUTING_MODE_STRICT
        and any(tag not in AUTO_BALANCER_PRESERVE_TAGS for tag in selector)
    )
    if selector:
        balancer_changed = _ensure_least_ping_balancer(
            routing,
            balancer_tag=balancer_tag,
            selector_tags=selector,
        )
        rule_changed = _ensure_default_balancer_rule(routing, balancer_tag=balancer_tag)
        migrate_stats = _sync_vless_reality_rules_to_balancer(
            routing,
            balancer_tag=balancer_tag,
            enabled=strict_enabled,
        )
        changed = bool(balancer_changed or rule_changed or migrate_stats.get("changed"))
    else:
        migrate_stats = _sync_vless_reality_rules_to_balancer(
            routing,
            balancer_tag=balancer_tag,
            enabled=False,
        )
        rule_changed = _remove_auto_balancer_rule(routing)
        balancer_changed = _remove_auto_least_ping_balancer(
            routing,
            balancer_tag=balancer_tag,
            removed_tags=remove,
            previous_selector=current_selector,
        )
        changed = bool(rule_changed or balancer_changed or migrate_stats.get("changed"))

    if not changed:
        return {
            "changed": False,
            "selector": selector,
            "balancer_tag": balancer_tag,
            "routing_file": os.path.basename(routing_path),
            "routing_mode": _clean_routing_mode(routing_mode),
            "migrated_rules": 0,
            "reverted_rules": 0,
            "skipped_rules": 0,
        }

    main_changed = _write_json_if_changed(routing_path, cfg, snapshot=snapshot)
    raw_changed = _write_jsonc_sidecar_if_changed(
        routing_path,
        cfg,
        header="// Generated by XKeen UI subscriptions (routing sync)",
        snapshot=snapshot,
    )
    return {
        "changed": bool(main_changed or raw_changed),
        "selector": selector,
        "balancer_tag": balancer_tag,
        "routing_file": os.path.basename(routing_path),
        "routing_mode": ROUTING_MODE_STRICT if strict_enabled else ROUTING_MODE_SAFE,
        "migrated_rules": int(migrate_stats.get("migrated") or 0),
        "reverted_rules": int(migrate_stats.get("reverted") or 0),
        "skipped_rules": int(migrate_stats.get("skipped") or 0),
    }


def sync_observatory_subjects(
    *,
    xray_configs_dir: str,
    add_tags: Iterable[str],
    remove_tags: Iterable[str] | None = None,
    snapshot: SnapshotCallback | None = None,
) -> bool:
    add = [str(t or "").strip() for t in add_tags if str(t or "").strip()]
    remove = {str(t or "").strip() for t in (remove_tags or []) if str(t or "").strip()}
    if not add and not remove:
        return False

    dst_json = os.path.join(str(xray_configs_dir or ""), "07_observatory.json")
    cfg = _load_observatory(dst_json)
    obs = cfg.get("observatory")
    if not isinstance(obs, dict):
        obs = {}

    current = obs.get("subjectSelector")
    subjects: List[str] = []
    seen: set[str] = set()
    if isinstance(current, list):
        for item in current:
            tag = str(item or "").strip()
            if not tag or tag in remove or tag in seen:
                continue
            seen.add(tag)
            subjects.append(tag)

    for tag in add:
        if tag in seen:
            continue
        seen.add(tag)
        subjects.append(tag)

    obs["subjectSelector"] = subjects
    obs.setdefault("probeUrl", "https://www.gstatic.com/generate_204")
    obs.setdefault("probeInterval", "60s")
    obs.setdefault("enableConcurrency", True)
    cfg["observatory"] = obs

    changed = _write_json_if_changed(dst_json, cfg, snapshot=snapshot)
    ensure_xray_jsonc_dir()
    jsonc = jsonc_path_for(dst_json)
    jsonc_text = (
        "// Generated by XKeen UI subscriptions (observatory subjects)\n"
        + json.dumps(cfg, ensure_ascii=False, indent=2)
        + "\n"
    )
    try:
        old = ""
        try:
            with open(jsonc, "r", encoding="utf-8") as f:
                old = f.read()
        except Exception:
            old = ""
        if old != jsonc_text:
            if snapshot and os.path.exists(jsonc):
                snapshot(jsonc)
            _atomic_write_text(jsonc, jsonc_text)
            changed = True
    except Exception:
        pass

    return changed


def refresh_subscription(
    ui_state_dir: str,
    sub_id: str,
    *,
    xray_configs_dir: str,
    snapshot: SnapshotCallback | None = None,
    restart_xkeen: RestartCallback | None = None,
    restart: bool = True,
) -> Dict[str, Any]:
    with _STATE_LOCK:
        state = load_subscription_state(ui_state_dir)
        idx, sub = _find_subscription(state, sub_id)
        if idx < 0 or sub is None:
            raise KeyError("subscription not found")
        sub = dict(sub)

    result: Dict[str, Any] = {
        "id": sub.get("id"),
        "ok": False,
        "changed": False,
        "observatory_changed": False,
        "routing_changed": False,
        "restarted": False,
        "count": 0,
        "source_count": 0,
        "filtered_out_count": 0,
        "last_nodes": [],
        "tags": [],
        "errors": [],
        "source_format": "",
    }
    now_ts = _now()
    source_count = 0
    filtered_out_count = 0
    preview_nodes: List[Dict[str, Any]] = []
    node_latency: Dict[str, Dict[str, Any]] = _prune_node_latency_map(sub.get("node_latency"), _normalize_last_nodes(sub.get("last_nodes")))

    try:
        body, headers = fetch_subscription_body(str(sub.get("url") or ""))
        links = parse_subscription_links(body)
        source_format = "links"
        if links:
            outbounds, errors, stats = build_subscription_outbounds(
                links,
                tag_prefix=str(sub.get("tag") or sub.get("id") or "sub"),
                name_filter=str(sub.get("name_filter") or ""),
                type_filter=str(sub.get("type_filter") or ""),
                transport_filter=str(sub.get("transport_filter") or ""),
                excluded_node_keys=_read_string_list_value(sub, EXCLUDED_NODE_KEYS_KEYS),
            )
        else:
            source_format = "xray-json"
            outbounds, errors, stats = build_subscription_json_outbounds(
                body,
                tag_prefix=str(sub.get("tag") or sub.get("id") or "sub"),
                name_filter=str(sub.get("name_filter") or ""),
                type_filter=str(sub.get("type_filter") or ""),
                transport_filter=str(sub.get("transport_filter") or ""),
                excluded_node_keys=_read_string_list_value(sub, EXCLUDED_NODE_KEYS_KEYS),
            )
        source_count = int(stats.get("source_count") or 0)
        filtered_out_count = int(stats.get("filtered_out_count") or 0)
        preview_nodes = _normalize_last_nodes(stats.get("nodes"))
        node_latency = _prune_node_latency_map(node_latency, preview_nodes)
        if not links and not outbounds:
            raise RuntimeError("no_supported_proxies")
        if source_count > 0 and not outbounds and filtered_out_count >= source_count:
            raise RuntimeError("Ни один узел не подошёл под фильтры подписки.")
        if not outbounds:
            raise RuntimeError("no_valid_outbounds")

        tags = [str(ob.get("tag") or "").strip() for ob in outbounds if isinstance(ob, dict) and ob.get("tag")]
        output_obj = {"outbounds": outbounds}
        output_path = _subscription_output_path(xray_configs_dir, sub)
        changed = _write_json_if_changed(output_path, output_obj, snapshot=snapshot)

        ensure_xray_jsonc_dir()
        raw_path = jsonc_path_for(output_path)
        raw_text = (
            f"// Generated by XKeen UI subscription: {sub.get('name') or sub.get('id')}\n"
            + json.dumps(output_obj, ensure_ascii=False, indent=2)
            + "\n"
        )
        try:
            raw_old = ""
            try:
                with open(raw_path, "r", encoding="utf-8") as f:
                    raw_old = f.read()
            except Exception:
                raw_old = ""
            if raw_old != raw_text:
                if snapshot and os.path.exists(raw_path):
                    snapshot(raw_path)
                _atomic_write_text(raw_path, raw_text)
                changed = True
        except Exception:
            pass

        previous_tags = [str(t) for t in sub.get("last_tags", []) if str(t or "").strip()] if isinstance(sub.get("last_tags"), list) else []
        observatory_changed = False
        routing_changed = False
        preserved_tags = _preserved_balancer_tags(xray_configs_dir)
        effective_routing_mode = _effective_subscription_routing_mode(ui_state_dir)
        if bool(sub.get("ping_enabled", True)):
            observatory_changed = sync_observatory_subjects(
                xray_configs_dir=xray_configs_dir,
                add_tags=tags + preserved_tags,
                remove_tags=previous_tags,
                snapshot=snapshot,
            )
            routing_sync = sync_subscription_routing(
                xray_configs_dir=xray_configs_dir,
                add_tags=tags,
                remove_tags=previous_tags,
                routing_mode=effective_routing_mode,
                snapshot=snapshot,
            )
            routing_changed = bool(routing_sync.get("changed"))
        elif previous_tags:
            observatory_changed = sync_observatory_subjects(
                xray_configs_dir=xray_configs_dir,
                add_tags=preserved_tags,
                remove_tags=previous_tags,
                snapshot=snapshot,
            )
            routing_sync = sync_subscription_routing(
                xray_configs_dir=xray_configs_dir,
                add_tags=[],
                remove_tags=previous_tags,
                routing_mode=effective_routing_mode,
                snapshot=snapshot,
            )
            routing_changed = bool(routing_sync.get("changed"))

        interval = _clamp_interval(sub.get("interval_hours") or DEFAULT_INTERVAL_HOURS)
        profile_interval = _parse_profile_interval_hours(headers)
        if profile_interval is not None:
            interval = profile_interval
            sub["profile_update_interval_hours"] = profile_interval

        sub.update(
            {
                "last_ok": True,
                "last_error": "",
                "last_update_ts": now_ts,
                "last_count": len(outbounds),
                "last_source_count": source_count,
                "last_filtered_out_count": filtered_out_count,
                "last_nodes": preview_nodes,
                "node_latency": node_latency,
                "last_tags": tags,
                "last_hash": _content_hash(output_obj),
                "last_changed": bool(changed),
                "last_observatory_changed": bool(observatory_changed),
                "last_routing_changed": bool(routing_changed),
                "last_errors": errors,
                "last_source_format": source_format,
                "next_update_ts": now_ts + (interval * 3600) if bool(sub.get("enabled", True)) else None,
                "interval_hours": interval,
            }
        )

        restarted = False
        if restart and restart_xkeen and (changed or observatory_changed or routing_changed):
            try:
                restarted = bool(restart_xkeen(source="xray-subscription-refresh"))
            except TypeError:
                restarted = bool(restart_xkeen())
            except Exception:
                restarted = False

        result.update(
            {
                "ok": True,
                "changed": bool(changed),
                "observatory_changed": bool(observatory_changed),
                "routing_changed": bool(routing_changed),
                "restarted": restarted,
                "count": len(outbounds),
                "source_count": source_count,
                "filtered_out_count": filtered_out_count,
                "last_nodes": preview_nodes,
                "node_latency": node_latency,
                "tags": tags,
                "errors": errors,
                "source_format": source_format,
                "output_file": os.path.basename(output_path),
                "routing_file": (routing_sync.get("routing_file") if "routing_sync" in locals() else ""),
                "routing_balancer_tag": (routing_sync.get("balancer_tag") if "routing_sync" in locals() else ""),
                "routing_selector_count": len(routing_sync.get("selector") or []) if "routing_sync" in locals() else 0,
                "routing_mode": (routing_sync.get("routing_mode") if "routing_sync" in locals() else _clean_routing_mode(sub.get("routing_mode"))),
                "routing_migrated_rules": int(routing_sync.get("migrated_rules") or 0) if "routing_sync" in locals() else 0,
                "routing_reverted_rules": int(routing_sync.get("reverted_rules") or 0) if "routing_sync" in locals() else 0,
                "routing_skipped_rules": int(routing_sync.get("skipped_rules") or 0) if "routing_sync" in locals() else 0,
                "next_update_ts": sub.get("next_update_ts"),
            }
        )
    except Exception as exc:
        interval = _clamp_interval(sub.get("interval_hours") or DEFAULT_INTERVAL_HOURS)
        sub.update(
            {
                "last_ok": False,
                "last_error": str(exc),
                "last_update_ts": now_ts,
                "last_source_count": source_count,
                "last_filtered_out_count": filtered_out_count,
                "last_nodes": preview_nodes or _normalize_last_nodes(sub.get("last_nodes")),
                "node_latency": _prune_node_latency_map(node_latency, preview_nodes or _normalize_last_nodes(sub.get("last_nodes"))),
                "next_update_ts": now_ts + (interval * 3600) if bool(sub.get("enabled", True)) else None,
            }
        )
        result.update(
            {
                "ok": False,
                "error": str(exc),
                "source_count": source_count,
                "filtered_out_count": filtered_out_count,
                "last_nodes": preview_nodes,
                "node_latency": node_latency,
                "next_update_ts": sub.get("next_update_ts"),
            }
        )

    with _STATE_LOCK:
        state = load_subscription_state(ui_state_dir)
        idx, _old = _find_subscription(state, str(sub.get("id") or sub_id))
        if idx >= 0 and isinstance(state.get("subscriptions"), list):
            state["subscriptions"][idx] = sub
            _write_state(ui_state_dir, _normalize_state(state))

    return result


def refresh_due_subscriptions(
    ui_state_dir: str,
    *,
    xray_configs_dir: str,
    snapshot: SnapshotCallback | None = None,
    restart_xkeen: RestartCallback | None = None,
    restart: bool = True,
) -> List[Dict[str, Any]]:
    state = load_subscription_state(ui_state_dir)
    now_ts = _now()
    results: List[Dict[str, Any]] = []
    for sub in list(state.get("subscriptions") or []):
        if not isinstance(sub, dict) or not bool(sub.get("enabled", True)):
            continue
        due = sub.get("next_update_ts")
        try:
            due_ts = float(due)
        except Exception:
            due_ts = 0.0
        if due_ts > now_ts:
            continue
        try:
            results.append(
                refresh_subscription(
                    ui_state_dir,
                    str(sub.get("id") or ""),
                    xray_configs_dir=xray_configs_dir,
                    snapshot=snapshot,
                    restart_xkeen=restart_xkeen,
                    restart=restart,
                )
            )
        except Exception as exc:
            results.append({"id": sub.get("id"), "ok": False, "error": str(exc)})
    return results


def _find_xray_binary() -> str | None:
    for cand in ("/opt/sbin/xray", "/opt/bin/xray", "xray"):
        try:
            resolved = shutil.which(cand) if os.path.basename(cand) == cand else cand
        except Exception:
            resolved = cand if os.path.isfile(cand) else None
        if resolved and os.path.isfile(resolved) and os.access(resolved, os.X_OK):
            return resolved
        if resolved and os.path.basename(cand) == cand:
            return resolved
    return None


def _reserve_local_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        sock.listen(1)
        return int(sock.getsockname()[1])


def _is_local_port_open(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.2)
        return sock.connect_ex(("127.0.0.1", int(port))) == 0


def _wait_for_local_port(port: int, proc: subprocess.Popen[Any], timeout_s: float) -> bool:
    deadline = time.time() + max(0.5, float(timeout_s or 0))
    while time.time() < deadline:
        if proc.poll() is not None:
            return False
        if _is_local_port_open(port):
            return True
        time.sleep(0.08)
    return False


def _wait_for_local_ports(ports: Iterable[int], proc: subprocess.Popen[Any], timeout_s: float) -> bool:
    pending = {int(port) for port in ports if int(port) > 0}
    if not pending:
        return True
    deadline = time.time() + max(0.5, float(timeout_s or 0))
    while time.time() < deadline:
        if proc.poll() is not None:
            return False
        for port in tuple(pending):
            if _is_local_port_open(port):
                pending.discard(port)
        if not pending:
            return True
        time.sleep(0.08)
    return False


def _terminate_process(proc: subprocess.Popen[Any], timeout_s: float = 1.5) -> tuple[str, str]:
    if proc.poll() is None:
        with contextlib.suppress(Exception):
            proc.terminate()
        try:
            stdout, stderr = proc.communicate(timeout=max(0.2, float(timeout_s or 0)))
            return str(stdout or ""), str(stderr or "")
        except subprocess.TimeoutExpired:
            with contextlib.suppress(Exception):
                proc.kill()
    try:
        stdout, stderr = proc.communicate(timeout=0.4)
    except Exception:
        stdout, stderr = "", ""
    return str(stdout or ""), str(stderr or "")


def _history_entry(*, status: str, checked_at: float, delay_ms: int | None = None, error: str = "") -> Dict[str, Any]:
    item: Dict[str, Any] = {
        "status": str(status or "unknown").strip().lower() or "unknown",
        "checked_at": float(checked_at),
    }
    if delay_ms is not None:
        item["delay_ms"] = int(delay_ms)
    if error:
        item["error"] = str(error)[:240]
    return item


def _merge_latency_entry(existing: Any, *, checked_at: float, probe_url: str, delay_ms: int | None = None, error: str = "") -> Dict[str, Any]:
    base = _normalize_node_latency_map({"node": existing}).get("node", {})
    status = "ok" if delay_ms is not None else "error"
    latest = _history_entry(status=status, checked_at=checked_at, delay_ms=delay_ms, error=error)
    history = [latest]
    for item in base.get("history") if isinstance(base.get("history"), list) else []:
        if len(history) >= NODE_LATENCY_HISTORY_LIMIT:
            break
        history.append(item)
    out: Dict[str, Any] = {
        "status": status,
        "checked_at": float(checked_at),
        "probe_url": str(probe_url or "").strip(),
        "history": history[:NODE_LATENCY_HISTORY_LIMIT],
    }
    if delay_ms is not None:
        out["delay_ms"] = int(delay_ms)
    if error:
        out["error"] = str(error)[:240]
    return out


def _config_outbounds_list(config: Any) -> List[Dict[str, Any]]:
    raw = config
    if isinstance(config, dict):
        raw = config.get("outbounds")
    out: List[Dict[str, Any]] = []
    for item in raw if isinstance(raw, list) else []:
        if isinstance(item, dict):
            out.append(item)
    return out


def _is_probeable_outbound(outbound: Dict[str, Any]) -> bool:
    protocol = str(outbound.get("protocol") or "").strip().lower()
    if not protocol:
        return False
    return protocol not in {"freedom", "blackhole", "dns", "loopback"}


def _outbound_identity_without_tag(outbound: Dict[str, Any]) -> str:
    try:
        clean = copy.deepcopy(outbound)
        if isinstance(clean, dict):
            clean.pop("tag", None)
        return json.dumps(clean, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    except Exception:
        return str(outbound)


def build_xray_outbounds_nodes(config: Any) -> List[Dict[str, Any]]:
    """Return user-facing proxy nodes from an outbounds fragment.

    A single-link config generated by the panel usually contains a legacy
    vless-reality alias in addition to proxy. That alias points to the same
    outbound, so hide only that duplicate; real proxy-pool tags remain visible.
    """
    nodes: List[Dict[str, Any]] = []
    outbounds = _config_outbounds_list(config)
    non_legacy_identities = {
        _outbound_identity_without_tag(outbound)
        for outbound in outbounds
        if _is_probeable_outbound(outbound) and str(outbound.get("tag") or "").strip() != LEGACY_VLESS_TAG
    }
    for outbound in outbounds:
        if not _is_probeable_outbound(outbound):
            continue
        tag = str(outbound.get("tag") or "").strip()
        if not tag:
            continue
        identity = _outbound_identity_without_tag(outbound)
        if tag == LEGACY_VLESS_TAG and identity in non_legacy_identities:
            continue
        meta = _json_outbound_node_meta(outbound, tag, len(nodes))
        meta["tag"] = tag
        nodes.append(meta)
    return _normalize_last_nodes(nodes)


def normalize_xray_outbounds_node_latency(value: Any, nodes: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    return _prune_node_latency_map(value, _normalize_last_nodes(nodes))


def _outbounds_map_by_tag(config: Any) -> Dict[str, Dict[str, Any]]:
    out: Dict[str, Dict[str, Any]] = {}
    for outbound in _config_outbounds_list(config):
        if not _is_probeable_outbound(outbound):
            continue
        tag = str(outbound.get("tag") or "").strip()
        if not tag or tag in out:
            continue
        out[tag] = copy.deepcopy(outbound)
    return out


def probe_xray_outbounds_node_latency(
    config: Any,
    node_key: str,
    *,
    xray_configs_dir: str,
    existing_latency: Any = None,
    timeout_s: float = DEFAULT_PROBE_TIMEOUT_SECONDS,
) -> Dict[str, Any]:
    target_key = str(node_key or "").strip()
    if not target_key:
        raise ValueError("node_key is required")
    batch = probe_xray_outbounds_nodes_latency(
        config,
        [target_key],
        xray_configs_dir=xray_configs_dir,
        existing_latency=existing_latency,
        timeout_s=timeout_s,
        strict=True,
    )
    items = batch.get("results") if isinstance(batch, dict) else None
    if not isinstance(items, list) or not items:
        raise RuntimeError("outbounds node latency probe returned no results")
    first = items[0]
    if not isinstance(first, dict):
        raise RuntimeError("outbounds node latency probe returned invalid result")
    return dict(first)


def probe_xray_outbounds_nodes_latency(
    config: Any,
    node_keys: Iterable[Any],
    *,
    xray_configs_dir: str,
    existing_latency: Any = None,
    timeout_s: float = DEFAULT_PROBE_TIMEOUT_SECONDS,
    strict: bool = False,
) -> Dict[str, Any]:
    target_keys = _normalize_probe_node_keys(list(node_keys) if not isinstance(node_keys, list) else node_keys)
    if not target_keys:
        raise ValueError("node_keys is required")

    nodes = build_xray_outbounds_nodes(config)
    nodes_by_key = {
        str(item.get("key") or "").strip(): dict(item)
        for item in nodes
        if str(item.get("key") or "").strip()
    }
    latency_map = normalize_xray_outbounds_node_latency(existing_latency, nodes)
    outbounds_by_tag = _outbounds_map_by_tag(config)
    timeout_value = max(2.0, float(timeout_s or DEFAULT_PROBE_TIMEOUT_SECONDS))
    probe_url = _probe_url_for_subscription(xray_configs_dir)

    probe_targets: List[Dict[str, Any]] = []
    immediate_results: Dict[str, Dict[str, Any]] = {}
    for target_key in target_keys:
        node = nodes_by_key.get(target_key)
        if not node:
            if strict:
                raise KeyError("node not found")
            immediate_results[target_key] = {
                "ok": False,
                "node_key": target_key,
                "probe_url": probe_url,
                "error": "node not found",
            }
            continue

        tag = str(node.get("tag") or "").strip()
        outbound = outbounds_by_tag.get(tag)
        if outbound is None:
            if strict:
                raise KeyError("node tag not found")
            immediate_results[target_key] = {
                "ok": False,
                "node_key": target_key,
                "tag": tag,
                "probe_url": probe_url,
                "error": "node tag not found",
            }
            continue

        probe_targets.append({"key": target_key, "tag": tag, "outbound": outbound})

    probe_results: Dict[str, Dict[str, Any]] = {}
    if probe_targets:
        xray_bin = _find_xray_binary()
        if not xray_bin:
            raise RuntimeError("xray binary not found")
        probe_results = _probe_outbounds_batch(
            xray_bin=xray_bin,
            targets=probe_targets,
            probe_url=probe_url,
            timeout_value=timeout_value,
            concurrency=PROBE_BATCH_CONCURRENCY,
        )

    results: List[Dict[str, Any]] = []
    entries_by_key: Dict[str, Dict[str, Any]] = {}
    ok_count = 0
    failed_count = 0
    for target_key in target_keys:
        if target_key in immediate_results:
            failed_count += 1
            results.append(dict(immediate_results[target_key]))
            continue

        node = nodes_by_key.get(target_key) or {}
        tag = str(node.get("tag") or "").strip()
        probe_item = probe_results.get(target_key, {})
        checked_at = _now()
        delay_ms = probe_item.get("delay_ms")
        error_text = str(probe_item.get("error") or "")
        entry = _merge_latency_entry(
            latency_map.get(target_key),
            checked_at=checked_at,
            probe_url=probe_url,
            delay_ms=delay_ms,
            error=error_text,
        )
        entries_by_key[target_key] = entry
        latency_map[target_key] = entry

        item: Dict[str, Any] = {
            "ok": delay_ms is not None,
            "node_key": target_key,
            "tag": tag,
            "probe_url": probe_url,
            "checked_at": checked_at,
            "entry": entry,
        }
        if delay_ms is not None:
            item["delay_ms"] = delay_ms
            ok_count += 1
        else:
            item["error"] = error_text
            failed_count += 1
        results.append(item)

    return {
        "ok": failed_count == 0,
        "probe_url": probe_url,
        "requested": len(target_keys),
        "updated": len(entries_by_key),
        "ok_count": ok_count,
        "failed_count": failed_count,
        "nodes": nodes,
        "node_latency": normalize_xray_outbounds_node_latency(latency_map, nodes),
        "results": results,
    }


def _load_generated_outbounds_map(sub: Dict[str, Any], xray_configs_dir: str) -> Dict[str, Dict[str, Any]]:
    output_path = _subscription_output_path(xray_configs_dir, sub)
    obj = _read_json_file(output_path, {})
    outbounds = obj.get("outbounds") if isinstance(obj, dict) else []
    if not isinstance(outbounds, list):
        raise RuntimeError("generated_fragment_invalid")
    out: Dict[str, Dict[str, Any]] = {}
    for outbound in outbounds:
        if not isinstance(outbound, dict):
            continue
        tag = str(outbound.get("tag") or "").strip()
        if not tag or tag in out:
            continue
        out[tag] = copy.deepcopy(outbound)
    return out


def _reserve_local_ports(count: int) -> List[int]:
    ports: List[int] = []
    seen: set[int] = set()
    while len(ports) < max(0, int(count)):
        port = _reserve_local_port()
        if port in seen:
            continue
        seen.add(port)
        ports.append(port)
    return ports


def _build_batch_probe_config(targets: List[Dict[str, Any]]) -> Dict[str, Any]:
    inbounds: List[Dict[str, Any]] = []
    outbounds: List[Dict[str, Any]] = []
    rules: List[Dict[str, Any]] = []
    seen_tags: set[str] = set()
    for idx, item in enumerate(targets):
        outbound = copy.deepcopy(item.get("outbound") or {})
        outbound_tag = str(outbound.get("tag") or item.get("tag") or f"probe-out-{idx}").strip() or f"probe-out-{idx}"
        inbound_tag = f"probe-http-{idx}"
        listen_port = int(item.get("port"))
        inbounds.append(
            {
                "tag": inbound_tag,
                "listen": "127.0.0.1",
                "port": listen_port,
                "protocol": "http",
                "settings": {},
                "sniffing": {"enabled": False},
            }
        )
        if outbound_tag not in seen_tags:
            seen_tags.add(outbound_tag)
            outbound["tag"] = outbound_tag
            outbounds.append(outbound)
        rules.append({"type": "field", "inboundTag": [inbound_tag], "outboundTag": outbound_tag})
    outbounds.extend(
        [
            {"tag": "direct", "protocol": "freedom"},
            {"tag": "block", "protocol": "blackhole"},
        ]
    )
    return {
        "log": {"loglevel": "warning"},
        "inbounds": inbounds,
        "outbounds": outbounds,
        "routing": {
            "domainStrategy": "AsIs",
            "rules": rules,
        },
    }


def _probe_via_local_proxy(port: int, probe_url: str, timeout_value: float) -> tuple[int | None, str]:
    error_text = ""
    delay_ms: int | None = None
    proxy_url = f"http://127.0.0.1:{int(port)}"
    opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({"http": proxy_url, "https": proxy_url})
    )
    try:
        started = time.perf_counter()
        req = urllib.request.Request(
            probe_url,
            headers={"User-Agent": "XKeen-UI Latency Probe"},
            method="GET",
        )
        with opener.open(req, timeout=timeout_value) as resp:
            with contextlib.suppress(Exception):
                resp.read(1)
        delay_ms = max(0, int(round((time.perf_counter() - started) * 1000.0)))
    except Exception as exc:
        error_text = str(exc)
    return delay_ms, error_text


def _start_probe_process(
    *,
    xray_bin: str,
    config_path: str,
    wait_ports: Iterable[int],
) -> tuple[subprocess.Popen[Any] | None, str]:
    cmd_options = (
        [xray_bin, "run", "-c", config_path],
        [xray_bin, "-c", config_path],
    )
    last_error = "xray probe start failed"
    ports = [int(port) for port in wait_ports if int(port) > 0]
    for cmd in cmd_options:
        candidate = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        if _wait_for_local_ports(ports, candidate, PROBE_PROCESS_START_TIMEOUT_SECONDS):
            return candidate, ""
        stdout, stderr = _terminate_process(candidate)
        last_error = (stderr or stdout or "xray probe start failed").strip()
    return None, last_error


def _probe_outbounds_batch(
    *,
    xray_bin: str,
    targets: List[Dict[str, Any]],
    probe_url: str,
    timeout_value: float,
    concurrency: int = 3,
) -> Dict[str, Dict[str, Any]]:
    if not targets:
        return {}
    last_error = "xray probe start failed"
    max_attempts = max(1, int(PROBE_PROCESS_START_ATTEMPTS or 1))
    for _attempt_idx in range(max_attempts):
        ports = _reserve_local_ports(len(targets))
        prepared: List[Dict[str, Any]] = []
        for item, port in zip(targets, ports):
            prepared.append({**item, "port": int(port)})

        with tempfile.TemporaryDirectory(prefix="xkeen-xray-probe-batch-") as tmpdir:
            config_path = os.path.join(tmpdir, "probe-batch.json")
            with open(config_path, "w", encoding="utf-8") as fh:
                json.dump(_build_batch_probe_config(prepared), fh, ensure_ascii=False, indent=2)
                fh.write("\n")

            proc, last_error = _start_probe_process(
                xray_bin=xray_bin,
                config_path=config_path,
                wait_ports=[int(item["port"]) for item in prepared],
            )
            if proc is None:
                continue

            results: Dict[str, Dict[str, Any]] = {}
            try:
                max_workers = max(1, min(int(concurrency or 1), len(prepared)))
                with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
                    future_map = {
                        executor.submit(_probe_via_local_proxy, int(item["port"]), probe_url, timeout_value): str(item.get("key") or "")
                        for item in prepared
                        if str(item.get("key") or "")
                    }
                    for future in concurrent.futures.as_completed(future_map):
                        key = future_map[future]
                        try:
                            delay_ms, error_text = future.result()
                        except Exception as exc:
                            delay_ms, error_text = None, str(exc)
                        results[key] = {"delay_ms": delay_ms, "error": error_text}
            finally:
                _terminate_process(proc)
            return results

    error_text = last_error or "xray probe start failed"
    return {
        str(item.get("key") or ""): {"delay_ms": None, "error": error_text}
        for item in targets
        if str(item.get("key") or "")
    }


def _probe_url_for_subscription(xray_configs_dir: str) -> str:
    try:
        cfg = _load_observatory(os.path.join(str(xray_configs_dir or ""), "07_observatory.json"))
        obs = cfg.get("observatory") if isinstance(cfg.get("observatory"), dict) else {}
        probe_url = str(obs.get("probeUrl") or "").strip()
        if probe_url:
            return probe_url
    except Exception:
        pass
    return DEFAULT_PROBE_URL


def _normalize_probe_node_keys(value: Any) -> List[str]:
    raw_items = value if isinstance(value, (list, tuple, set)) else [value]
    out: List[str] = []
    seen: set[str] = set()
    for item in raw_items:
        key = str(item or "").strip()
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(key)
    return out


def _save_subscription_latency_entries(
    ui_state_dir: str,
    sub_id: str,
    entries_by_key: Dict[str, Dict[str, Any]],
) -> int:
    if not entries_by_key:
        return 0
    with _STATE_LOCK:
        state = load_subscription_state(ui_state_dir)
        idx, current = _find_subscription(state, sub_id)
        if idx < 0 or current is None or not isinstance(state.get("subscriptions"), list):
            raise KeyError("subscription not found")
        current = dict(current)
        current_nodes = _normalize_last_nodes(current.get("last_nodes"))
        allowed_keys = {
            str(item.get("key") or "").strip()
            for item in current_nodes
            if str(item.get("key") or "").strip()
        }
        node_latency = _prune_node_latency_map(current.get("node_latency"), current_nodes)
        saved = 0
        for key, entry in entries_by_key.items():
            key_text = str(key or "").strip()
            if not key_text or key_text not in allowed_keys:
                continue
            node_latency[key_text] = entry
            saved += 1
        current["node_latency"] = node_latency
        state["subscriptions"][idx] = current
        _write_state(ui_state_dir, _normalize_state(state))
    return saved


def probe_subscription_node_latency(
    ui_state_dir: str,
    sub_id: str,
    node_key: str,
    *,
    xray_configs_dir: str,
    timeout_s: float = DEFAULT_PROBE_TIMEOUT_SECONDS,
) -> Dict[str, Any]:
    target_key = str(node_key or "").strip()
    if not target_key:
        raise ValueError("node_key is required")
    batch_result = probe_subscription_nodes_latency(
        ui_state_dir,
        sub_id,
        [target_key],
        xray_configs_dir=xray_configs_dir,
        timeout_s=timeout_s,
        strict=True,
    )
    items = batch_result.get("results") if isinstance(batch_result, dict) else None
    if not isinstance(items, list) or not items:
        raise RuntimeError("node latency probe returned no results")
    first = items[0]
    if not isinstance(first, dict):
        raise RuntimeError("node latency probe returned invalid result")
    return dict(first)


def probe_subscription_nodes_latency(
    ui_state_dir: str,
    sub_id: str,
    node_keys: Iterable[Any],
    *,
    xray_configs_dir: str,
    timeout_s: float = DEFAULT_PROBE_TIMEOUT_SECONDS,
    strict: bool = False,
) -> Dict[str, Any]:
    target_keys = _normalize_probe_node_keys(list(node_keys) if not isinstance(node_keys, list) else node_keys)
    if not target_keys:
        raise ValueError("node_keys is required")

    with _STATE_LOCK:
        state = load_subscription_state(ui_state_dir)
        idx, sub = _find_subscription(state, sub_id)
        if idx < 0 or sub is None:
            raise KeyError("subscription not found")
        sub = dict(sub)

    nodes = _normalize_last_nodes(sub.get("last_nodes"))
    nodes_by_key = {
        str(item.get("key") or "").strip(): dict(item)
        for item in nodes
        if str(item.get("key") or "").strip()
    }
    existing_latency = _normalize_node_latency_map(sub.get("node_latency"))
    timeout_value = max(2.0, float(timeout_s or DEFAULT_PROBE_TIMEOUT_SECONDS))
    probe_url = _probe_url_for_subscription(xray_configs_dir)
    generated_outbounds: Dict[str, Dict[str, Any]] | None = None

    results: List[Dict[str, Any]] = []
    entries_by_key: Dict[str, Dict[str, Any]] = {}
    ok_count = 0
    failed_count = 0
    probe_targets: List[Dict[str, Any]] = []
    immediate_results: Dict[str, Dict[str, Any]] = {}

    for target_key in target_keys:
        node = nodes_by_key.get(target_key)
        if not node:
            if strict:
                raise KeyError("node not found")
            immediate_results[target_key] = {
                "ok": False,
                "id": str(sub.get("id") or sub_id),
                "node_key": target_key,
                "probe_url": probe_url,
                "error": "node not found",
            }
            continue

        tag = str(node.get("tag") or "").strip()
        if not tag:
            if strict:
                raise ValueError("Узел сейчас не входит в generated fragment.")
            immediate_results[target_key] = {
                "ok": False,
                "id": str(sub.get("id") or sub_id),
                "node_key": target_key,
                "probe_url": probe_url,
                "error": "Узел сейчас не входит в generated fragment.",
            }
            continue

        if generated_outbounds is None:
            generated_outbounds = _load_generated_outbounds_map(sub, xray_configs_dir)
        outbound = generated_outbounds.get(tag)
        if outbound is None:
            if strict:
                raise KeyError("node tag not found")
            immediate_results[target_key] = {
                "ok": False,
                "id": str(sub.get("id") or sub_id),
                "node_key": target_key,
                "tag": tag,
                "probe_url": probe_url,
                "error": "node tag not found",
            }
            continue

        probe_targets.append(
            {
                "key": target_key,
                "tag": tag,
                "outbound": outbound,
            }
        )

    probe_results: Dict[str, Dict[str, Any]] = {}
    if probe_targets:
        xray_bin = _find_xray_binary()
        if not xray_bin:
            raise RuntimeError("xray binary not found")
        probe_results = _probe_outbounds_batch(
            xray_bin=xray_bin,
            targets=probe_targets,
            probe_url=probe_url,
            timeout_value=timeout_value,
            concurrency=PROBE_BATCH_CONCURRENCY,
        )

    for target_key in target_keys:
        if target_key in immediate_results:
            item = dict(immediate_results[target_key])
            failed_count += 1
            results.append(item)
            continue

        node = nodes_by_key.get(target_key) or {}
        tag = str(node.get("tag") or "").strip()
        probe_item = probe_results.get(target_key, {})
        checked_at = _now()
        delay_ms = probe_item.get("delay_ms")
        error_text = str(probe_item.get("error") or "")
        entry = _merge_latency_entry(
            existing_latency.get(target_key),
            checked_at=checked_at,
            probe_url=probe_url,
            delay_ms=delay_ms,
            error=error_text,
        )
        entries_by_key[target_key] = entry

        item: Dict[str, Any] = {
            "ok": delay_ms is not None,
            "id": str(sub.get("id") or sub_id),
            "node_key": target_key,
            "tag": tag,
            "probe_url": probe_url,
            "checked_at": checked_at,
            "entry": entry,
        }
        if delay_ms is not None:
            item["delay_ms"] = delay_ms
            ok_count += 1
        else:
            item["error"] = error_text
            failed_count += 1
        results.append(item)

    saved_count = _save_subscription_latency_entries(ui_state_dir, sub_id, entries_by_key)
    return {
        "ok": failed_count == 0,
        "id": str(sub.get("id") or sub_id),
        "probe_url": probe_url,
        "requested": len(target_keys),
        "updated": saved_count,
        "ok_count": ok_count,
        "failed_count": failed_count,
        "results": results,
    }


def _log(level: str, message: str, **extra: Any) -> None:
    try:
        from core.logging import core_log

        core_log(level, message, **extra)
    except Exception:
        pass


def start_subscription_scheduler(
    ui_state_dir: str,
    *,
    xray_configs_dir: str,
    snapshot: SnapshotCallback | None = None,
    restart_xkeen: RestartCallback | None = None,
) -> bool:
    global _SCHEDULER_STARTED

    if not env_flag("XKEEN_SUBSCRIPTIONS_SCHEDULER", True):
        return False

    with _SCHEDULER_LOCK:
        if _SCHEDULER_STARTED:
            return False
        _SCHEDULER_STARTED = True

    try:
        tick = int(os.environ.get("XKEEN_SUBSCRIPTIONS_SCHEDULER_TICK", "60") or "60")
    except Exception:
        tick = 60
    tick = max(15, min(3600, tick))

    def _loop() -> None:
        time.sleep(min(15, tick))
        while True:
            try:
                results = refresh_due_subscriptions(
                    ui_state_dir,
                    xray_configs_dir=xray_configs_dir,
                    snapshot=snapshot,
                    restart_xkeen=restart_xkeen,
                    restart=True,
                )
                if results:
                    ok_count = sum(1 for r in results if r.get("ok"))
                    _log("info", "xray subscriptions auto-refresh", total=len(results), ok=ok_count)
            except Exception as exc:
                _log("warning", "xray subscriptions scheduler failed", error=str(exc))
            time.sleep(tick)

    thread = threading.Thread(target=_loop, name="xkeen-xray-subscriptions", daemon=True)
    thread.start()
    return True

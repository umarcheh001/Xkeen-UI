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
from utils.fs import load_text


STATE_VERSION = 1
STATE_FILENAME = "xray_subscriptions.json"
MANAGED_BASELINES_KEY = "managed_baselines"
MANAGED_BASELINE_ROUTING_KEY = "routing"
MANAGED_BASELINE_OBSERVATORY_KEY = "observatory"
MANAGED_BASELINE_TARGETS = {
    MANAGED_BASELINE_ROUTING_KEY: ROUTING_FILE,
    MANAGED_BASELINE_OBSERVATORY_KEY: "07_observatory.json",
}

DEFAULT_INTERVAL_HOURS = 24
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
ROUTING_BALANCER_TAGS_KEYS = ("routing_balancer_tags", "routingBalancerTags")
ROUTING_AUTO_RULE_KEYS = ("routing_auto_rule", "routingAutoRule")
LAST_NODES_KEYS = ("last_nodes", "lastNodes")
NODE_LATENCY_KEYS = ("node_latency", "nodeLatency")
LAST_WARNINGS_KEYS = ("last_warnings", "lastWarnings")
LAST_SELECTOR_TERMS_KEYS = ("last_selector_terms", "lastSelectorTerms")
LAST_GENERATED_OUTBOUNDS_KEYS = ("last_generated_outbounds", "lastGeneratedOutbounds")
LAST_RUNTIME_BALANCER_TAGS_KEYS = ("last_routing_balancer_tags", "lastRoutingBalancerTags")
LAST_RUNTIME_AUTO_RULE_KEYS = ("last_routing_auto_rule", "lastRoutingAutoRule")
LAST_RUNTIME_ROUTING_MODE_KEYS = ("last_routing_mode", "lastRoutingMode")
LAST_RUNTIME_ACTIVE_KEYS = ("last_runtime_active", "lastRuntimeActive")

DEFAULT_PROBE_URL = "https://www.gstatic.com/generate_204"
DEFAULT_PROBE_TIMEOUT_SECONDS = 8.0
PROBE_PROCESS_START_TIMEOUT_SECONDS = 4.0
PROBE_PROCESS_START_ATTEMPTS = 3
PROBE_BATCH_CONCURRENCY = 3
NODE_LATENCY_HISTORY_LIMIT = 5
AUTO_BALANCER_RULE_TAG = "xk_auto_leastPing"
AUTO_BALANCER_TAG = "proxy"
AUTO_BALANCER_ALT_TAG = "xk-subscriptions-proxy"
AUTO_BALANCER_FALLBACK_TAG = "direct"
AUTO_BALANCER_PRESERVE_TAGS = ("vless-reality",)
AUTO_MIGRATED_RULE_TAG_PREFIX = "xk_auto_vless_pool_"
ROUTING_MODE_SAFE = "safe-fallback"
ROUTING_MODE_STRICT = "migrate-vless-rules"
ROUTING_ROOT_KEYS = ("domainStrategy", "domainMatcher", "rules", "balancers")
_TAG_PREFIX_MAX_LEN = 64
_NODE_NAME_MAX_LEN = 36
_TAG_MAX_LEN = 128
_TAG_SEPARATOR = "--"


SnapshotCallback = Callable[[str], None]
RestartCallback = Callable[..., Any]


def subscription_state_path(ui_state_dir: str) -> str:
    return os.path.join(str(ui_state_dir or "/opt/etc/xkeen-ui"), STATE_FILENAME)


def _now() -> float:
    return time.time()


def _read_json_file(path: str, default: Any) -> Any:
    try:
        text = load_text(path, default=None)
        if text is None:
            return default
        return json.loads(text)
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
    return raw[:_TAG_PREFIX_MAX_LEN].strip("_.:-") or "sub"


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


def _read_bool_value(data: Any, keys: tuple[str, ...], default: bool) -> bool:
    if not isinstance(data, dict):
        return bool(default)
    for key in keys:
        if key in data:
            return bool(data.get(key))
    return bool(default)


def _derive_selector_terms_from_tags(tags: Any) -> List[str]:
    values = _clean_string_list(tags)
    if not values:
        return []
    prefixes: List[str] = []
    for tag in values:
        if "--" not in tag:
            return values
        prefix = str(tag.split("--", 1)[0] or "").strip()
        if not prefix:
            return values
        prefixes.append(prefix)
    if prefixes and all(prefix == prefixes[0] for prefix in prefixes[1:]):
        return [prefixes[0]]
    return values


def _ensure_runtime_snapshot_defaults(item: Any) -> Dict[str, Any]:
    data = dict(item) if isinstance(item, dict) else {}
    last_tags = _clean_string_list(data.get("last_tags"))
    if not last_tags:
        data.setdefault("last_selector_terms", [])
        data.setdefault("last_routing_balancer_tags", [])
        data.setdefault("last_routing_auto_rule", True)
        data.setdefault("last_routing_mode", _clean_routing_mode(data.get("routing_mode")))
        data.setdefault("last_runtime_active", False)
        return data
    if not _has_any_key(data, LAST_SELECTOR_TERMS_KEYS):
        data["last_selector_terms"] = _derive_selector_terms_from_tags(last_tags)
    if not _has_any_key(data, LAST_RUNTIME_BALANCER_TAGS_KEYS):
        data["last_routing_balancer_tags"] = []
    if not _has_any_key(data, LAST_RUNTIME_AUTO_RULE_KEYS):
        data["last_routing_auto_rule"] = True
    if not _has_any_key(data, LAST_RUNTIME_ROUTING_MODE_KEYS):
        data["last_routing_mode"] = _clean_routing_mode(data.get("routing_mode"))
    if not _has_any_key(data, LAST_RUNTIME_ACTIVE_KEYS):
        data["last_runtime_active"] = bool(data.get("ping_enabled", True))
    return data


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


def _normalize_generated_outbound_baselines(value: Any) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    seen: set[str] = set()
    for item in value if isinstance(value, list) else []:
        if not isinstance(item, dict):
            continue
        key = str(item.get("key") or "").strip()
        outbound = item.get("outbound")
        if not key or key in seen or not isinstance(outbound, dict):
            continue
        seen.add(key)
        out.append({"key": key, "outbound": copy.deepcopy(outbound)})
    return out


def _deprecated_transport_message(transport: str) -> str:
    value = str(transport or "").strip().lower()
    if value == "grpc":
        return "Transport gRPC устарел в актуальных версиях Xray; по возможности используйте XHTTP (stream-up H2)."
    return ""


def _normalize_xhttp_mode_value(value: Any) -> str | None:
    text = str(value or "").strip()
    if not text or text.lower() == "auto":
        return None
    lowered = text.lower()
    if lowered in {"stream-one", "stream-up", "packet-up"}:
        return lowered
    return text


def _subscription_result_warnings(nodes: Iterable[Dict[str, Any]]) -> List[str]:
    grpc_nodes: List[str] = []
    for node in nodes:
        if not isinstance(node, dict):
            continue
        if str(node.get("transport") or "").strip().lower() != "grpc":
            continue
        if not str(node.get("tag") or "").strip():
            continue
        name = str(node.get("name") or node.get("tag") or "node").strip() or "node"
        grpc_nodes.append(name)

    if not grpc_nodes:
        return []

    if len(grpc_nodes) == 1:
        name = grpc_nodes[0]
        return [
            f'Узел "{name}" использует устаревший transport gRPC. {_deprecated_transport_message("grpc")}'
        ]

    preview = ", ".join(grpc_nodes[:3])
    if len(grpc_nodes) > 3:
        preview += f" и ещё {len(grpc_nodes) - 3}"
    return [
        f"В generated fragment есть {len(grpc_nodes)} узла с устаревшим transport gRPC ({preview}). {_deprecated_transport_message('grpc')}"
    ]


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


def _normalize_managed_file_baseline(value: Any) -> Dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    path = os.path.basename(str(value.get("path") or "").strip())
    if not path:
        return None
    exists = bool(value.get("exists"))
    jsonc_exists = bool(value.get("jsonc_exists", value.get("jsoncExists")))
    clean: Dict[str, Any] = {
        "path": path,
        "exists": exists,
        "jsonc_exists": jsonc_exists,
    }
    if exists:
        clean["text"] = str(value.get("text") or "")
    if jsonc_exists:
        clean["jsonc_text"] = str(value.get("jsonc_text", value.get("jsoncText")) or "")
    return clean


def _normalize_managed_baselines(value: Any) -> Dict[str, Dict[str, Any]]:
    if not isinstance(value, dict):
        return {}
    out: Dict[str, Dict[str, Any]] = {}
    for key in MANAGED_BASELINE_TARGETS:
        clean = _normalize_managed_file_baseline(value.get(key))
        if clean is not None:
            out[key] = clean
    return out


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
        last_warnings = _read_string_list_value(item, LAST_WARNINGS_KEYS)
        last_nodes = _normalize_last_nodes(
            item.get("last_nodes") if "last_nodes" in item else item.get("lastNodes")
        )
        last_generated_outbounds = _normalize_generated_outbound_baselines(
            item.get("last_generated_outbounds")
            if "last_generated_outbounds" in item
            else item.get("lastGeneratedOutbounds")
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
            + ROUTING_BALANCER_TAGS_KEYS[1:]
            + ROUTING_AUTO_RULE_KEYS[1:]
            + LAST_WARNINGS_KEYS[1:]
            + LAST_NODES_KEYS[1:]
            + NODE_LATENCY_KEYS[1:]
            + LAST_SELECTOR_TERMS_KEYS[1:]
            + LAST_GENERATED_OUTBOUNDS_KEYS[1:]
            + LAST_RUNTIME_BALANCER_TAGS_KEYS[1:]
            + LAST_RUNTIME_AUTO_RULE_KEYS[1:]
            + LAST_RUNTIME_ROUTING_MODE_KEYS[1:]
            + LAST_RUNTIME_ACTIVE_KEYS[1:]
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
                "routing_balancer_tags": _read_string_list_value(item, ROUTING_BALANCER_TAGS_KEYS),
                "routing_auto_rule": _read_bool_value(item, ROUTING_AUTO_RULE_KEYS, True),
                "interval_hours": interval,
                "output_file": output_file,
                "last_warnings": last_warnings,
                "last_nodes": last_nodes,
                "last_generated_outbounds": last_generated_outbounds,
                "node_latency": _prune_node_latency_map(node_latency, last_nodes),
                "last_tags": [str(x) for x in item.get("last_tags", []) if str(x or "").strip()]
                if isinstance(item.get("last_tags"), list)
                else [],
                "last_selector_terms": _read_string_list_value(item, LAST_SELECTOR_TERMS_KEYS),
                "last_routing_balancer_tags": _read_string_list_value(item, LAST_RUNTIME_BALANCER_TAGS_KEYS),
                "last_routing_auto_rule": _read_bool_value(item, LAST_RUNTIME_AUTO_RULE_KEYS, True),
                "last_routing_mode": _clean_routing_mode(
                    item.get("last_routing_mode", item.get("lastRoutingMode", item.get("routing_mode")))
                ),
                "last_runtime_active": _read_bool_value(item, LAST_RUNTIME_ACTIVE_KEYS, bool(item.get("ping_enabled", True))),
            }
        )
        clean_subs.append(_ensure_runtime_snapshot_defaults(clean))
    state = {"version": STATE_VERSION, "subscriptions": clean_subs}
    baselines = _normalize_managed_baselines(obj.get(MANAGED_BASELINES_KEY))
    if baselines:
        state[MANAGED_BASELINES_KEY] = baselines
    return state


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

        base = _ensure_runtime_snapshot_defaults(dict(existing or {}))
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
        routing_balancer_tags = (
            _read_string_list_value(data, ROUTING_BALANCER_TAGS_KEYS)
            if _has_any_key(data, ROUTING_BALANCER_TAGS_KEYS)
            else _read_string_list_value(base, ROUTING_BALANCER_TAGS_KEYS)
        )
        routing_auto_rule = _read_bool_value(
            data,
            ROUTING_AUTO_RULE_KEYS,
            _read_bool_value(base, ROUTING_AUTO_RULE_KEYS, True),
        )
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
            + ROUTING_BALANCER_TAGS_KEYS[1:]
            + ROUTING_AUTO_RULE_KEYS[1:]
            + LAST_WARNINGS_KEYS[1:]
            + LAST_NODES_KEYS[1:]
            + NODE_LATENCY_KEYS[1:]
            + LAST_SELECTOR_TERMS_KEYS[1:]
            + LAST_GENERATED_OUTBOUNDS_KEYS[1:]
            + LAST_RUNTIME_BALANCER_TAGS_KEYS[1:]
            + LAST_RUNTIME_AUTO_RULE_KEYS[1:]
            + LAST_RUNTIME_ROUTING_MODE_KEYS[1:]
            + LAST_RUNTIME_ACTIVE_KEYS[1:]
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
                "routing_balancer_tags": routing_balancer_tags,
                "routing_auto_rule": routing_auto_rule,
                "interval_hours": interval,
                "output_file": output_file,
                "node_latency": _prune_node_latency_map(base.get("node_latency"), _normalize_last_nodes(base.get("last_nodes"))),
                "updated_ts": now_ts,
            }
        )
        if not sub.get("created_ts"):
            sub["created_ts"] = now_ts
        if not sub.get("next_update_ts"):
            # Schedule the first auto-refresh one full interval out instead of
            # marking the subscription due immediately. The UI provides an
            # explicit "Обновить сразу" path that does the immediate fetch+
            # restart; without this guard the background scheduler would pick
            # up a freshly-saved sub within ~60s and restart Xray even when
            # the user unchecked that option.
            sub["next_update_ts"] = (now_ts + interval * 3600) if sub["enabled"] else None

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
    remaining_state: Dict[str, Any] = {"subscriptions": []}
    previous_state: Dict[str, Any] = {"subscriptions": []}
    with _STATE_LOCK:
        state = load_subscription_state(ui_state_dir)
        previous_state = _normalize_state(copy.deepcopy(state))
        idx, sub = _find_subscription(state, sub_id)
        if idx < 0 or sub is None:
            raise KeyError("subscription not found")
        removed = dict(sub)
        subs = state.get("subscriptions")
        if isinstance(subs, list):
            subs.pop(idx)
        remaining_state = _normalize_state(state)
        _write_state(ui_state_dir, remaining_state)

    output_removed = False
    if remove_file and removed:
        output_path = _subscription_output_path(xray_configs_dir, removed)
        output_removed = bool(_remove_file_if_exists(output_path, snapshot=snapshot) or output_removed)
        try:
            raw_path = jsonc_path_for(output_path)
        except Exception:
            raw_path = ""
        if raw_path:
            output_removed = bool(_remove_file_if_exists(raw_path, snapshot=snapshot) or output_removed)

    observatory_changed = False
    routing_changed = False
    routing_sync: Dict[str, Any] = {}
    restored_baseline = False
    rebuild_stats = _rebuild_subscription_runtime(
        ui_state_dir,
        xray_configs_dir=xray_configs_dir,
        snapshot=snapshot,
        previous_state=previous_state,
        state_override=remaining_state,
    )
    restored_baseline = bool(rebuild_stats.get("baseline_restored"))
    observatory_changed = bool(rebuild_stats.get("observatory_changed"))
    routing_changed = bool(rebuild_stats.get("routing_changed"))
    routing_sync = rebuild_stats.get("routing_sync") if isinstance(rebuild_stats.get("routing_sync"), dict) else {}
    if not rebuild_stats.get("has_runtime_targets"):
        _clear_subscription_managed_baselines(ui_state_dir)

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
        "routing_balancer_tag": str(routing_sync.get("balancer_tag") or ""),
        "routing_manual_balancer_tags": list(routing_sync.get("manual_balancer_tags") or []),
        "baseline_restored": restored_baseline,
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


VOLATILE_LINK_QUERY_KEYS = {"sid", "spx"}


def _stable_link_fingerprint_payload(raw: str, protocol: str, name: str) -> str:
    source = str(raw or "").strip()
    proto = str(protocol or "").strip().lower()
    node_name = str(name or "").strip()

    if proto == "vmess":
        try:
            payload = source[8:].strip().replace("-", "+").replace("_", "/")
            payload += "=" * (-len(payload) % 4)
            data = json.loads(base64.b64decode(payload.encode("utf-8")).decode("utf-8", errors="replace"))
            return json.dumps(
                {
                    "protocol": proto,
                    "name": node_name,
                    "data": data,
                },
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            )
        except Exception:
            return source

    try:
        parsed = urlparse(source)
        query = parse_qs(parsed.query)
        normalized_query: Dict[str, List[str]] = {}
        for raw_key, values in sorted(query.items()):
            key = str(raw_key or "").strip().lower()
            if not key or key in VOLATILE_LINK_QUERY_KEYS:
                continue
            clean_values = [unquote(str(item or "").strip()) for item in values if str(item or "").strip()]
            if clean_values:
                normalized_query[key] = clean_values
        return json.dumps(
            {
                "protocol": proto,
                "name": node_name,
                "username": unquote(str(parsed.username or "").strip()),
                "password": unquote(str(parsed.password or "").strip()),
                "host": str(parsed.hostname or "").strip(),
                "port": parsed.port or "",
                "query": normalized_query,
            },
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
    except Exception:
        return source


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
        "key": _node_fingerprint(_stable_link_fingerprint_payload(raw, protocol, name)),
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
        fingerprint_payload = json.dumps(
            {
                "name": name,
                "source": source,
            },
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
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
    return value[:_NODE_NAME_MAX_LEN].strip("_.:-") or fallback


def _unique_tag(prefix: str, node: str, used: set[str]) -> str:
    prefix_part = str(prefix or "").strip("_.:-") or "sub"
    node_part = str(node or "").strip("_.:-") or "sub"

    overflow = len(prefix_part) + len(_TAG_SEPARATOR) + len(node_part) - _TAG_MAX_LEN
    if overflow > 0:
        budget = max(1, len(prefix_part) - overflow)
        prefix_part = prefix_part[:budget].strip("_.:-") or "sub"

    tag = f"{prefix_part}{_TAG_SEPARATOR}{node_part}"[:_TAG_MAX_LEN].strip("_.:-") or "sub"
    if tag.lower() in RESERVED_TAGS:
        tag = tag + "_sub"
    if tag not in used:
        used.add(tag)
        return tag

    root = tag[: _TAG_MAX_LEN - 6].strip("_.:-") or "sub"
    idx = 2
    while True:
        cand = f"{root}-{idx}"[:_TAG_MAX_LEN].strip("_.:-")
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
        tag = _unique_tag(prefix, node, used)
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
        tag = _unique_tag(prefix, node, used)
        preview_nodes[preview_idx]["tag"] = tag
        try:
            outbound = copy.deepcopy(source)
            stream_settings = outbound.get("streamSettings") if isinstance(outbound.get("streamSettings"), dict) else None
            xhttp_settings = stream_settings.get("xhttpSettings") if isinstance(stream_settings, dict) and isinstance(stream_settings.get("xhttpSettings"), dict) else None
            if isinstance(xhttp_settings, dict):
                normalized_mode = _normalize_xhttp_mode_value(xhttp_settings.get("mode"))
                if normalized_mode is None:
                    xhttp_settings.pop("mode", None)
                else:
                    xhttp_settings["mode"] = normalized_mode
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


def _subscription_outbound_compare_key(item: Any) -> Tuple[str, str]:
    tag = str(item.get("tag") or "").strip() if isinstance(item, dict) else ""
    try:
        payload = json.dumps(item, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    except Exception:
        payload = str(item)
    return tag, payload


def _canonical_subscription_output_for_compare(obj: Any) -> Any:
    data = copy.deepcopy(obj)
    if isinstance(data, dict) and isinstance(data.get("outbounds"), list):
        data["outbounds"] = sorted(data["outbounds"], key=_subscription_outbound_compare_key)
    return data


def _subscription_output_hash(obj: Any) -> str:
    return _content_hash(_canonical_subscription_output_for_compare(obj))


def _subscription_outbounds_from_obj(obj: Any) -> List[Dict[str, Any]]:
    raw = obj.get("outbounds") if isinstance(obj, dict) else obj if isinstance(obj, list) else []
    return [item for item in raw if isinstance(item, dict)] if isinstance(raw, list) else []


def _load_subscription_output_obj(path: str) -> Dict[str, Any] | None:
    obj = _read_json_file(path, None)
    if isinstance(obj, dict) and isinstance(obj.get("outbounds"), list):
        return obj
    if isinstance(obj, list):
        return {"outbounds": obj}
    return None


def _outbound_hash_without_tag(obj: Any) -> str:
    data = copy.deepcopy(obj) if isinstance(obj, dict) else obj
    if isinstance(data, dict):
        data.pop("tag", None)
    return _content_hash(data)


def _subscription_node_key_by_tag(nodes: Iterable[Any]) -> Dict[str, str]:
    out: Dict[str, str] = {}
    for item in nodes:
        if not isinstance(item, dict):
            continue
        key = str(item.get("key") or "").strip()
        tag = str(item.get("tag") or "").strip()
        if key and tag and tag not in out:
            out[tag] = key
    return out


def _subscription_generated_baselines(outbounds: List[Dict[str, Any]], nodes: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    key_by_tag = _subscription_node_key_by_tag(nodes)
    out: List[Dict[str, Any]] = []
    seen: set[str] = set()
    for outbound in outbounds:
        tag = str(outbound.get("tag") or "").strip()
        key = key_by_tag.get(tag, "")
        if not key or key in seen:
            continue
        seen.add(key)
        out.append({"key": key, "outbound": copy.deepcopy(outbound)})
    return out


def _unique_outbound_hash_to_key(baselines_by_key: Dict[str, Dict[str, Any]]) -> Dict[str, str]:
    buckets: Dict[str, List[str]] = {}
    for key, outbound in baselines_by_key.items():
        buckets.setdefault(_outbound_hash_without_tag(outbound), []).append(key)
    return {hash_value: keys[0] for hash_value, keys in buckets.items() if len(keys) == 1}


def _merge_user_json_value(baseline: Any, current: Any, generated: Any) -> Any:
    if current == baseline:
        return copy.deepcopy(generated)
    if generated == baseline or current == generated:
        return copy.deepcopy(current)
    if isinstance(baseline, dict) and isinstance(current, dict) and isinstance(generated, dict):
        result: Dict[str, Any] = {}
        keys = list(generated.keys()) + [key for key in current.keys() if key not in generated]
        for key in keys:
            has_baseline = key in baseline
            has_current = key in current
            has_generated = key in generated
            if not has_current:
                if has_baseline:
                    continue
                if has_generated:
                    result[key] = copy.deepcopy(generated[key])
                continue
            if not has_baseline:
                result[key] = copy.deepcopy(current[key])
                continue
            if not has_generated:
                if current[key] != baseline[key]:
                    result[key] = copy.deepcopy(current[key])
                continue
            result[key] = _merge_user_json_value(baseline[key], current[key], generated[key])
        return result
    return copy.deepcopy(current)


def _collect_subscription_manual_overrides(
    sub: Dict[str, Any],
    output_path: str,
    generated_outbounds: List[Dict[str, Any]],
    preview_nodes: List[Dict[str, Any]],
) -> Dict[str, Any]:
    current_obj = _load_subscription_output_obj(output_path)
    if current_obj is None:
        return {"current_by_key": {}, "deleted_node_keys": [], "baseline_by_key": {}, "current_hash": ""}

    current_hash = _subscription_output_hash(current_obj)
    stored_baselines = _normalize_generated_outbound_baselines(sub.get("last_generated_outbounds"))
    if not stored_baselines:
        last_hash = str(sub.get("last_hash") or "").strip()
        if last_hash and current_hash == last_hash:
            return {"current_by_key": {}, "deleted_node_keys": [], "baseline_by_key": {}, "current_hash": current_hash}
        stored_baselines = _subscription_generated_baselines(generated_outbounds, preview_nodes)

    baseline_by_key = {
        str(item.get("key") or "").strip(): copy.deepcopy(item.get("outbound"))
        for item in stored_baselines
        if str(item.get("key") or "").strip() and isinstance(item.get("outbound"), dict)
    }
    if not baseline_by_key:
        return {"current_by_key": {}, "deleted_node_keys": [], "baseline_by_key": {}, "current_hash": current_hash}

    key_by_tag = _subscription_node_key_by_tag(sub.get("last_nodes") or [])
    for key, outbound in baseline_by_key.items():
        tag = str(outbound.get("tag") or "").strip()
        if tag and tag not in key_by_tag:
            key_by_tag[tag] = key

    key_by_hash_without_tag = _unique_outbound_hash_to_key(baseline_by_key)
    current_by_key: Dict[str, Dict[str, Any]] = {}
    used_keys: set[str] = set()
    for outbound in _subscription_outbounds_from_obj(current_obj):
        tag = str(outbound.get("tag") or "").strip()
        key = key_by_tag.get(tag, "")
        if not key:
            key = key_by_hash_without_tag.get(_outbound_hash_without_tag(outbound), "")
        if not key or key in used_keys or key not in baseline_by_key:
            continue
        used_keys.add(key)
        current_by_key[key] = copy.deepcopy(outbound)

    current_source_keys = {
        str(item.get("key") or "").strip()
        for item in preview_nodes
        if isinstance(item, dict) and str(item.get("key") or "").strip()
    }
    previous_active_keys = {
        str(item.get("key") or "").strip()
        for item in _normalize_last_nodes(sub.get("last_nodes"))
        if str(item.get("key") or "").strip() and str(item.get("tag") or "").strip()
    }
    deleted_node_keys = [
        key
        for key in previous_active_keys
        if key in current_source_keys and key in baseline_by_key and key not in current_by_key
    ]

    return {
        "current_by_key": current_by_key,
        "deleted_node_keys": deleted_node_keys,
        "baseline_by_key": baseline_by_key,
        "current_hash": current_hash,
    }


def _apply_subscription_manual_overrides(
    generated_outbounds: List[Dict[str, Any]],
    preview_nodes: List[Dict[str, Any]],
    overrides: Dict[str, Any],
) -> Tuple[List[Dict[str, Any]], int]:
    current_by_key = overrides.get("current_by_key") if isinstance(overrides, dict) else {}
    baseline_by_key = overrides.get("baseline_by_key") if isinstance(overrides, dict) else {}
    if not isinstance(current_by_key, dict) or not isinstance(baseline_by_key, dict) or not current_by_key:
        return generated_outbounds, 0

    key_by_tag = _subscription_node_key_by_tag(preview_nodes)
    final_tag_by_key: Dict[str, str] = {}
    merged_count = 0
    out: List[Dict[str, Any]] = []
    for outbound in generated_outbounds:
        tag = str(outbound.get("tag") or "").strip()
        key = key_by_tag.get(tag, "")
        current = current_by_key.get(key)
        baseline = baseline_by_key.get(key)
        if isinstance(current, dict) and isinstance(baseline, dict):
            merged = _merge_user_json_value(baseline, current, outbound)
            if merged != outbound:
                merged_count += 1
        else:
            merged = copy.deepcopy(outbound)
        final_tag = str(merged.get("tag") or "").strip() if isinstance(merged, dict) else ""
        if key and final_tag:
            final_tag_by_key[key] = final_tag
        out.append(merged)

    if final_tag_by_key:
        for node in preview_nodes:
            if not isinstance(node, dict):
                continue
            key = str(node.get("key") or "").strip()
            if key in final_tag_by_key:
                node["tag"] = final_tag_by_key[key]
    return out, merged_count


def _jsonc_semantically_matches_subscription_output(text: str, obj: Any) -> bool:
    parsed = _load_jsonc_text(text)
    if parsed is None:
        return False
    return _subscription_output_hash(parsed) == _subscription_output_hash(obj)


def _write_subscription_output_if_changed(path: str, obj: Any, *, snapshot: SnapshotCallback | None = None) -> bool:
    new_text = json.dumps(obj, ensure_ascii=False, indent=2) + "\n"
    try:
        old_text = load_text(path, default=None)
        if old_text == new_text:
            return False
        if isinstance(old_text, str):
            try:
                old_obj = json.loads(old_text)
            except Exception:
                old_obj = None
            if old_obj is not None and _subscription_output_hash(old_obj) == _subscription_output_hash(obj):
                return False
    except Exception:
        pass
    if snapshot and os.path.exists(path):
        snapshot(path)
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    _atomic_write_text(path, new_text)
    return True


def _write_json_if_changed(path: str, obj: Any, *, snapshot: SnapshotCallback | None = None) -> bool:
    new_text = json.dumps(obj, ensure_ascii=False, indent=2) + "\n"
    try:
        if load_text(path, default=None) == new_text:
            return False
    except Exception:
        pass
    if snapshot and os.path.exists(path):
        snapshot(path)
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    _atomic_write_text(path, new_text)
    return True


def _write_text_if_changed(path: str, text: str, *, snapshot: SnapshotCallback | None = None) -> bool:
    next_text = str(text or "")
    try:
        if load_text(path, default=None) == next_text:
            return False
    except Exception:
        pass
    if snapshot and os.path.exists(path):
        snapshot(path)
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    _atomic_write_text(path, next_text)
    return True


def _remove_file_if_exists(path: str, *, snapshot: SnapshotCallback | None = None) -> bool:
    try:
        if not os.path.isfile(path):
            return False
    except Exception:
        return False
    try:
        if snapshot:
            snapshot(path)
    except Exception:
        pass
    try:
        os.remove(path)
        return True
    except Exception:
        return False


def _capture_managed_file_baseline(state: Dict[str, Any], *, key: str, path: str) -> bool:
    baselines = state.get(MANAGED_BASELINES_KEY)
    if not isinstance(baselines, dict):
        baselines = {}
        state[MANAGED_BASELINES_KEY] = baselines
    if isinstance(baselines.get(key), dict):
        return False

    entry: Dict[str, Any] = {"path": os.path.basename(path), "exists": False, "jsonc_exists": False}
    try:
        text = load_text(path, default=None)
        if text is not None:
            entry["text"] = text
            entry["exists"] = True
    except Exception:
        pass

    try:
        jsonc = jsonc_path_for(path)
    except Exception:
        jsonc = ""
    if jsonc:
        try:
            jsonc_text = load_text(jsonc, default=None)
            if jsonc_text is not None:
                entry["jsonc_text"] = jsonc_text
                entry["jsonc_exists"] = True
        except Exception:
            pass

    baselines[key] = entry
    return True


def _ensure_subscription_managed_baselines(ui_state_dir: str, xray_configs_dir: str) -> bool:
    with _STATE_LOCK:
        state = load_subscription_state(ui_state_dir)
        changed = False
        for key, default_name in MANAGED_BASELINE_TARGETS.items():
            path = _config_fragment_path(xray_configs_dir, default_name)
            changed = bool(_capture_managed_file_baseline(state, key=key, path=path) or changed)
        if changed:
            _write_state(ui_state_dir, state)
        return changed


def _restore_managed_file_baseline(
    xray_configs_dir: str,
    baseline: Dict[str, Any],
    *,
    default_name: str,
    snapshot: SnapshotCallback | None = None,
) -> bool:
    path = _config_fragment_path(xray_configs_dir, baseline.get("path") or default_name)
    changed = False
    if baseline.get("exists"):
        changed = bool(_write_text_if_changed(path, str(baseline.get("text") or ""), snapshot=snapshot) or changed)
    else:
        changed = bool(_remove_file_if_exists(path, snapshot=snapshot) or changed)

    try:
        jsonc = jsonc_path_for(path)
    except Exception:
        jsonc = ""
    if jsonc:
        if baseline.get("jsonc_exists"):
            changed = bool(
                _write_text_if_changed(jsonc, str(baseline.get("jsonc_text") or ""), snapshot=snapshot) or changed
            )
        else:
            changed = bool(_remove_file_if_exists(jsonc, snapshot=snapshot) or changed)
    return changed


def _managed_file_snapshot(path: str) -> Tuple[str | None, str | None]:
    try:
        main_text = load_text(path, default=None)
    except Exception:
        main_text = None
    try:
        jsonc = jsonc_path_for(path)
    except Exception:
        jsonc = ""
    if jsonc:
        try:
            jsonc_text = load_text(jsonc, default=None)
        except Exception:
            jsonc_text = None
    else:
        jsonc_text = None
    return main_text, jsonc_text


def _restore_subscription_managed_baselines(
    ui_state_dir: str,
    *,
    xray_configs_dir: str,
    snapshot: SnapshotCallback | None = None,
) -> Dict[str, bool]:
    with _STATE_LOCK:
        state = load_subscription_state(ui_state_dir)
        baselines = _normalize_managed_baselines(state.get(MANAGED_BASELINES_KEY))

    if not baselines:
        return {"restored": False, "routing_changed": False, "observatory_changed": False}

    routing_changed = False
    observatory_changed = False
    routing_baseline = baselines.get(MANAGED_BASELINE_ROUTING_KEY)
    if routing_baseline is not None:
        routing_changed = _restore_managed_file_baseline(
            xray_configs_dir,
            routing_baseline,
            default_name=ROUTING_FILE,
            snapshot=snapshot,
        )
    observatory_baseline = baselines.get(MANAGED_BASELINE_OBSERVATORY_KEY)
    if observatory_baseline is not None:
        observatory_changed = _restore_managed_file_baseline(
            xray_configs_dir,
            observatory_baseline,
            default_name="07_observatory.json",
            snapshot=snapshot,
        )
    return {
        "restored": True,
        "routing_changed": bool(routing_changed),
        "observatory_changed": bool(observatory_changed),
    }


def _clear_subscription_managed_baselines(ui_state_dir: str) -> bool:
    with _STATE_LOCK:
        state = load_subscription_state(ui_state_dir)
        if MANAGED_BASELINES_KEY not in state:
            return False
        state.pop(MANAGED_BASELINES_KEY, None)
        _write_state(ui_state_dir, state)
        return True


def _strip_jsonc_comments(text: str) -> str:
    src = str(text or "")
    out: List[str] = []
    i = 0
    in_string = False
    quote = ""
    escaped = False
    while i < len(src):
        ch = src[i]
        nxt = src[i + 1] if i + 1 < len(src) else ""
        if in_string:
            out.append(ch)
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == quote:
                in_string = False
                quote = ""
            i += 1
            continue
        if ch in ("\"", "'"):
            in_string = True
            quote = ch
            escaped = False
            out.append(ch)
            i += 1
            continue
        if ch == "/" and nxt == "/":
            while i < len(src) and src[i] not in "\r\n":
                i += 1
            continue
        if ch == "/" and nxt == "*":
            i += 2
            while i + 1 < len(src) and not (src[i] == "*" and src[i + 1] == "/"):
                if src[i] in "\r\n":
                    out.append(src[i])
                i += 1
            i += 2 if i + 1 < len(src) else 0
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def _load_jsonc_text(text: str) -> Any:
    try:
        return json.loads(_strip_jsonc_comments(text))
    except Exception:
        return None


def _json_pointer_join(path: str, part: str) -> str:
    token = str(part).replace("~", "~0").replace("/", "~1")
    return (str(path or "") + "/" + token) if path else "/" + token


def _json_pointer_parts(path: str) -> List[str]:
    raw = str(path or "")
    if not raw:
        return []
    return [item.replace("~1", "/").replace("~0", "~") for item in raw.strip("/").split("/") if item != ""]


def _read_json_string_token(src: str, start: int) -> Tuple[str, int]:
    quote = src[start]
    i = start + 1
    escaped = False
    while i < len(src):
        ch = src[i]
        if escaped:
            escaped = False
        elif ch == "\\":
            escaped = True
        elif ch == quote:
            raw = src[start : i + 1]
            try:
                return str(json.loads(raw)), i + 1
            except Exception:
                return raw[1:-1], i + 1
        i += 1
    return src[start + 1 :], len(src)


def _is_generated_jsonc_comment(text: str) -> bool:
    raw = str(text or "")
    return "Generated by XKeen UI subscription" in raw or "Generated by XKeen UI subscriptions" in raw


def _routing_rule_comment_key(rule: Any) -> str:
    if not isinstance(rule, dict):
        return ""
    explicit = str(rule.get("ruleTag") or "").strip()
    if explicit and not explicit.startswith((AUTO_MIGRATED_RULE_TAG_PREFIX, "xk_auto_")):
        return "ruleTag:" + explicit
    identity: Dict[str, Any] = {}
    for key in ("type", "inboundTag", "domain", "ip", "port", "network", "source", "user", "protocol", "attrs"):
        if key in rule:
            identity[key] = rule.get(key)
    if not identity:
        for key in ("outboundTag", "balancerTag", "ruleTag"):
            if key in rule:
                identity[key] = rule.get(key)
    try:
        return "rule:" + json.dumps(identity, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    except Exception:
        return "rule:" + str(identity)


def _routing_balancer_comment_key(balancer: Any) -> str:
    if not isinstance(balancer, dict):
        return ""
    tag = str(balancer.get("tag") or "").strip()
    if tag:
        return "balancer:" + tag
    try:
        return "balancer:" + json.dumps(balancer, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    except Exception:
        return "balancer:" + str(balancer)


def _semantic_comment_key(path: str, root_obj: Any) -> str:
    parts = _json_pointer_parts(path)
    if len(parts) >= 3 and parts[0] == "routing" and parts[1] == "rules":
        try:
            idx = int(parts[2])
        except Exception:
            idx = -1
        rules = ((root_obj or {}).get("routing") or {}).get("rules") if isinstance(root_obj, dict) else []
        rule = rules[idx] if isinstance(rules, list) and 0 <= idx < len(rules) else None
        rule_key = _routing_rule_comment_key(rule)
        if rule_key:
            suffix = "/" + "/".join(parts[3:]) if len(parts) > 3 else ""
            return "/routing/rules/" + rule_key + suffix
    if len(parts) >= 3 and parts[0] == "routing" and parts[1] == "balancers":
        try:
            idx = int(parts[2])
        except Exception:
            idx = -1
        balancers = ((root_obj or {}).get("routing") or {}).get("balancers") if isinstance(root_obj, dict) else []
        balancer = balancers[idx] if isinstance(balancers, list) and 0 <= idx < len(balancers) else None
        balancer_key = _routing_balancer_comment_key(balancer)
        if balancer_key:
            suffix = "/" + "/".join(parts[3:]) if len(parts) > 3 else ""
            return "/routing/balancers/" + balancer_key + suffix
    return str(path or "")


def _collect_jsonc_comments_by_semantic_key(text: str, root_obj: Any) -> Dict[str, List[str]]:
    src = str(text or "")
    comments_by_key: Dict[str, List[str]] = {}
    pending: List[str] = []
    stack: List[Dict[str, Any]] = []
    last_path = ""
    i = 0

    def add_comment(path: str, comment: str) -> None:
        raw = str(comment or "")
        if not raw.strip() or _is_generated_jsonc_comment(raw):
            return
        key = _semantic_comment_key(path, root_obj)
        bucket = comments_by_key.setdefault(key, [])
        if raw not in bucket:
            bucket.append(raw)

    def current_value_path() -> str:
        if not stack:
            return ""
        top = stack[-1]
        if top.get("type") == "object":
            return _json_pointer_join(str(top.get("path") or ""), str(top.get("pending_key") or ""))
        return _json_pointer_join(str(top.get("path") or ""), str(int(top.get("index") or 0)))

    def attach_pending(path: str) -> None:
        nonlocal pending
        if not pending:
            return
        for comment in pending:
            add_comment(path, comment)
        pending = []

    def complete_value() -> None:
        if not stack:
            return
        top = stack[-1]
        if top.get("type") == "object":
            top["pending_key"] = ""
            top["expect"] = "comma_or_end"
        elif top.get("type") == "array":
            top["index"] = int(top.get("index") or 0) + 1
            top["expect"] = "comma_or_end"

    while i < len(src):
        ch = src[i]
        nxt = src[i + 1] if i + 1 < len(src) else ""
        if ch.isspace():
            i += 1
            continue
        if ch == "/" and nxt in ("/", "*"):
            line_start = src.rfind("\n", 0, i) + 1
            inline = bool(src[line_start:i].strip())
            if nxt == "/":
                end = i + 2
                while end < len(src) and src[end] not in "\r\n":
                    end += 1
            else:
                end = i + 2
                while end + 1 < len(src) and not (src[end] == "*" and src[end + 1] == "/"):
                    end += 1
                end = min(len(src), end + 2)
            raw_comment = src[i:end]
            if inline and last_path:
                add_comment(last_path, raw_comment)
            else:
                pending.append(raw_comment)
            i = end
            continue
        if ch in ("\"", "'"):
            value, end = _read_json_string_token(src, i)
            top = stack[-1] if stack else None
            if top and top.get("type") == "object" and top.get("expect") in ("key", "value_or_end"):
                path = _json_pointer_join(str(top.get("path") or ""), value)
                attach_pending(path)
                top["pending_key"] = value
                top["expect"] = "colon"
                last_path = path
            else:
                path = current_value_path()
                attach_pending(path)
                last_path = path
                complete_value()
            i = end
            continue
        if ch in "{[":
            path = current_value_path()
            attach_pending(path)
            last_path = path
            if ch == "{":
                stack.append({"type": "object", "path": path, "expect": "key", "pending_key": ""})
            else:
                stack.append({"type": "array", "path": path, "expect": "value_or_end", "index": 0})
            i += 1
            continue
        if ch in "}]":
            if pending and stack:
                attach_pending(str(stack[-1].get("path") or ""))
            if stack:
                stack.pop()
                complete_value()
            i += 1
            continue
        if ch == ":":
            if stack and stack[-1].get("type") == "object":
                stack[-1]["expect"] = "value"
            i += 1
            continue
        if ch == ",":
            if stack:
                top = stack[-1]
                top["expect"] = "key" if top.get("type") == "object" else "value_or_end"
            i += 1
            continue
        # number / true / false / null
        path = current_value_path()
        attach_pending(path)
        last_path = path
        while i < len(src) and src[i] not in ",]} \t\r\n":
            i += 1
        complete_value()

    if pending:
        for comment in pending:
            add_comment("", comment)
    return comments_by_key


def _format_preserved_comment(comment: str, indent: str) -> List[str]:
    lines: List[str] = []
    for raw in str(comment or "").splitlines() or [str(comment or "")]:
        stripped = raw.strip()
        if not stripped:
            continue
        lines.append(indent + stripped)
    return lines


def _render_jsonc_with_comments(obj: Any, comments_by_key: Dict[str, List[str]], *, header: str) -> str:
    consumed: set[str] = set()

    def comments_for(path: str, value: Any, level: int) -> List[str]:
        key = _semantic_comment_key(path, obj)
        if key in consumed:
            return []
        consumed.add(key)
        out: List[str] = []
        for comment in comments_by_key.get(key, []):
            out.extend(_format_preserved_comment(comment, "  " * level))
        return out

    def add_comma(lines: List[str]) -> List[str]:
        if lines:
            lines[-1] = lines[-1] + ","
        return lines

    def render_value(value: Any, path: str, level: int) -> List[str]:
        indent = "  " * level
        if isinstance(value, dict):
            if not value:
                return [indent + "{}"]
            lines = [indent + "{"]
            items = list(value.items())
            for idx, (key, child) in enumerate(items):
                child_path = _json_pointer_join(path, str(key))
                child_indent = "  " * (level + 1)
                lines.extend(comments_for(child_path, child, level + 1))
                key_text = json.dumps(str(key), ensure_ascii=False)
                if isinstance(child, (dict, list)):
                    child_lines = render_value(child, child_path, level + 1)
                    child_lines[0] = child_indent + key_text + ": " + child_lines[0].lstrip()
                    if idx < len(items) - 1:
                        child_lines = add_comma(child_lines)
                    lines.extend(child_lines)
                else:
                    suffix = "," if idx < len(items) - 1 else ""
                    lines.append(child_indent + key_text + ": " + json.dumps(child, ensure_ascii=False) + suffix)
            lines.append(indent + "}")
            return lines
        if isinstance(value, list):
            if not value:
                return [indent + "[]"]
            lines = [indent + "["]
            for idx, child in enumerate(value):
                child_path = _json_pointer_join(path, str(idx))
                lines.extend(comments_for(child_path, child, level + 1))
                if isinstance(child, (dict, list)):
                    child_lines = render_value(child, child_path, level + 1)
                    if idx < len(value) - 1:
                        child_lines = add_comma(child_lines)
                    lines.extend(child_lines)
                else:
                    suffix = "," if idx < len(value) - 1 else ""
                    lines.append("  " * (level + 1) + json.dumps(child, ensure_ascii=False) + suffix)
            lines.append(indent + "]")
            return lines
        return [indent + json.dumps(value, ensure_ascii=False)]

    output: List[str] = []
    header_text = str(header or "")
    if header_text:
        output.append(header_text.rstrip("\n"))
    output.extend(comments_for("", obj, 0))
    output.extend(render_value(obj, "", 0))

    remaining: List[str] = []
    for key, comments in comments_by_key.items():
        if key in consumed:
            continue
        for comment in comments:
            remaining.extend(_format_preserved_comment(comment, ""))
    if remaining:
        output.insert(1 if header_text else 0, "// Preserved comments from previous routing JSONC:")
        output[2:2] = remaining if header_text else []
        if not header_text:
            output[1:1] = remaining
    return "\n".join(output).rstrip() + "\n"


def _write_jsonc_sidecar_if_changed(
    main_path: str,
    obj: Any,
    *,
    header: str,
    snapshot: SnapshotCallback | None = None,
    preserve_existing_comments: bool = False,
) -> bool:
    ensure_xray_jsonc_dir()
    jsonc = jsonc_path_for(main_path)
    try:
        old = ""
        try:
            with open(jsonc, "r", encoding="utf-8") as f:
                old = f.read()
        except Exception:
            old = ""
        if preserve_existing_comments and old:
            old_obj = _load_jsonc_text(old)
            comments = _collect_jsonc_comments_by_semantic_key(old, old_obj if old_obj is not None else obj)
            text = _render_jsonc_with_comments(obj, comments, header=header)
        else:
            text = str(header or "")
            if text and not text.endswith("\n"):
                text += "\n"
            text += json.dumps(obj, ensure_ascii=False, indent=2) + "\n"
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


def _routing_field_missing(routing: Dict[str, Any], key: str) -> bool:
    if key in {"rules", "balancers"}:
        return not isinstance(routing.get(key), list)
    return not str(routing.get(key) or "").strip()


def _ensure_routing_model(cfg: Any) -> Tuple[Dict[str, Any], Dict[str, Any], bool]:
    obj = cfg if isinstance(cfg, dict) else {}
    normalized = False
    routing = obj.get("routing")
    if not isinstance(routing, dict):
        routing = {}
        obj["routing"] = routing
        normalized = True
    for key in ROUTING_ROOT_KEYS:
        if key not in obj:
            continue
        if _routing_field_missing(routing, key):
            routing[key] = copy.deepcopy(obj.get(key))
        del obj[key]
        normalized = True
    if not isinstance(routing.get("balancers"), list):
        routing["balancers"] = []
        normalized = True
    if not isinstance(routing.get("rules"), list):
        routing["rules"] = []
        normalized = True
    return obj, routing, normalized


def _prune_empty_routing_collections(routing: Dict[str, Any]) -> bool:
    if not isinstance(routing, dict):
        return False
    changed = False
    if isinstance(routing.get("balancers"), list) and not routing.get("balancers"):
        routing.pop("balancers", None)
        changed = True
    return changed


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


def _existing_auto_balancer_tag(routing: Dict[str, Any]) -> str:
    rules = routing.get("rules") if isinstance(routing, dict) else []
    idx = _find_auto_rule_idx(rules if isinstance(rules, list) else [])
    if idx >= 0 and isinstance(rules[idx], dict):
        return str(rules[idx].get("balancerTag") or "").strip()
    return ""


def list_subscription_routing_balancers(xray_configs_dir: str) -> List[Dict[str, Any]]:
    routing_path = _config_fragment_path(xray_configs_dir, ROUTING_FILE)
    _cfg, routing, _normalized = _ensure_routing_model(_read_json_file(routing_path, {}))
    auto_tag = _existing_auto_balancer_tag(routing)
    items: List[Dict[str, Any]] = []
    for balancer in routing.get("balancers") if isinstance(routing, dict) else []:
        if not isinstance(balancer, dict):
            continue
        tag = str(balancer.get("tag") or "").strip()
        if not tag:
            continue
        strategy = str(((balancer.get("strategy") or {}).get("type") if isinstance(balancer.get("strategy"), dict) else "") or "").strip()
        selector = _clean_tags_list(balancer.get("selector") if isinstance(balancer.get("selector"), list) else [])
        items.append(
            {
                "tag": tag,
                "selector": selector,
                "selector_count": len(selector),
                "strategy_type": strategy,
                "fallback_tag": str(balancer.get("fallbackTag") or "").strip(),
                "auto_managed": tag == auto_tag,
            }
        )
    return items


def _rule_target_summary(rule: Any) -> Dict[str, str]:
    if not isinstance(rule, dict):
        return {"kind": "", "tag": "", "label": ""}
    balancer_tag = str(rule.get("balancerTag") or "").strip()
    if balancer_tag:
        return {"kind": "balancer", "tag": balancer_tag, "label": f'balancer "{balancer_tag}"'}
    outbound_tag = str(rule.get("outboundTag") or "").strip()
    if outbound_tag:
        return {"kind": "outbound", "tag": outbound_tag, "label": f'outbound "{outbound_tag}"'}
    return {"kind": "", "tag": "", "label": ""}


def _rule_string_terms(rule: Any, key: str) -> List[str]:
    if not isinstance(rule, dict):
        return []
    raw = rule.get(key)
    if isinstance(raw, list):
        return [str(item or "").strip() for item in raw if str(item or "").strip()]
    term = str(raw or "").strip()
    return [term] if term else []


def _rule_targets_direct(rule: Any) -> bool:
    return isinstance(rule, dict) and str(rule.get("outboundTag") or "").strip().lower() == "direct"


def _looks_like_ru_direct_term(value: Any) -> bool:
    raw = str(value or "").strip().lower()
    if not raw:
        return False
    if ":!ru" in raw:
        return False
    if any(token in raw for token in ("geosite:ru", "geoip:ru", "category-ru")):
        return True
    if any(token in raw for token in ("domain:ru", "domain:рф", "domain:рус", "domain:москва")):
        return True
    if any(token in raw for token in ("xn--p1ai", "xn--p1acf", "xn--80adx1ks")):
        return True
    return False


def _routing_direct_rule_summary(routing: Dict[str, Any]) -> Dict[str, int]:
    direct_rule_count = 0
    ru_direct_rule_count = 0
    for rule in routing.get("rules") if isinstance(routing, dict) else []:
        if not _rule_targets_direct(rule):
            continue
        direct_rule_count += 1
        terms = _rule_string_terms(rule, "domain") + _rule_string_terms(rule, "ip")
        if any(_looks_like_ru_direct_term(term) for term in terms):
            ru_direct_rule_count += 1
    return {
        "direct_rule_count": int(direct_rule_count),
        "ru_direct_rule_count": int(ru_direct_rule_count),
    }


def _is_proxy_inbound_catchall_rule(rule: Any) -> bool:
    if not isinstance(rule, dict) or not _rule_touches_proxy_inbound(rule):
        return False
    if str(rule.get("ruleTag") or "").strip() == AUTO_BALANCER_RULE_TAG:
        return False
    target = _rule_target_summary(rule)
    if not target.get("tag"):
        return False
    for key in ("domain", "ip", "source", "sourcePort", "user", "protocol", "attrs", "app", "apps"):
        if key in rule:
            return False
    if "port" in rule and str(rule.get("port") or "").strip():
        return False
    network = str(rule.get("network") or "").strip().lower().replace(" ", "")
    if network and network not in {"tcp", "udp", "tcp,udp", "udp,tcp"}:
        return False
    return True


def _subscription_auto_rule_shadow_info(routing: Dict[str, Any]) -> Dict[str, Any]:
    rules = routing.get("rules") if isinstance(routing, dict) else []
    if not isinstance(rules, list) or not rules:
        return {"rule_tag": "", "target_kind": "", "target_tag": "", "target_label": ""}

    insert_at = _choose_insert_index(rules)
    candidate: Dict[str, Any] | None = None
    for idx, rule in enumerate(rules):
        if idx >= insert_at:
            break
        if not _is_proxy_inbound_catchall_rule(rule):
            continue
        candidate = rule if isinstance(rule, dict) else None

    if not isinstance(candidate, dict):
        return {"rule_tag": "", "target_kind": "", "target_tag": "", "target_label": ""}

    target = _rule_target_summary(candidate)
    return {
        "rule_tag": str(candidate.get("ruleTag") or "").strip(),
        "target_kind": str(target.get("kind") or "").strip(),
        "target_tag": str(target.get("tag") or "").strip(),
        "target_label": str(target.get("label") or "").strip(),
    }


def get_subscription_routing_meta(xray_configs_dir: str) -> Dict[str, Any]:
    routing_path = _config_fragment_path(xray_configs_dir, ROUTING_FILE)
    _cfg, routing, _normalized = _ensure_routing_model(_read_json_file(routing_path, {}))
    shadow = _subscription_auto_rule_shadow_info(routing)
    direct_summary = _routing_direct_rule_summary(routing)
    return {
        "existing_auto_balancer_tag": _existing_auto_balancer_tag(routing),
        "auto_balancer_candidate_tag": _choose_auto_balancer_tag(routing),
        "auto_rule_shadowing_rule_tag": str(shadow.get("rule_tag") or ""),
        "auto_rule_shadowing_target_kind": str(shadow.get("target_kind") or ""),
        "auto_rule_shadowing_target_tag": str(shadow.get("target_tag") or ""),
        "auto_rule_shadowing_target_label": str(shadow.get("target_label") or ""),
        "direct_rule_count": int(direct_summary.get("direct_rule_count") or 0),
        "ru_direct_rule_count": int(direct_summary.get("ru_direct_rule_count") or 0),
    }


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
    tag = _existing_auto_balancer_tag(routing)
    if tag:
        return tag

    balancers = routing.get("balancers") if isinstance(routing, dict) else []
    if not isinstance(balancers, list):
        balancers = []

    preferred = _find_balancer_by_tag(balancers, AUTO_BALANCER_TAG)
    if preferred is None:
        return AUTO_BALANCER_TAG

    alt = _find_balancer_by_tag(balancers, AUTO_BALANCER_ALT_TAG)
    if alt is None:
        return AUTO_BALANCER_ALT_TAG
    if _balancer_strategy_type(alt) in {"", "leastping"}:
        return AUTO_BALANCER_ALT_TAG
    return _unique_balancer_tag(balancers, AUTO_BALANCER_ALT_TAG)


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


def _subscription_runtime_selector_terms(item: Any) -> List[str]:
    if not isinstance(item, dict):
        return []
    explicit = _read_string_list_value(item, LAST_SELECTOR_TERMS_KEYS)
    if explicit:
        return explicit
    return _derive_selector_terms_from_tags(item.get("last_tags"))


def _subscription_runtime_active(item: Any) -> bool:
    if not isinstance(item, dict):
        return False
    if _read_bool_value(item, LAST_RUNTIME_ACTIVE_KEYS, False):
        return bool(_subscription_runtime_selector_terms(item))
    raw = item.get("last_tags")
    return bool(item.get("ping_enabled", True)) and isinstance(raw, list) and any(str(tag or "").strip() for tag in raw)


def _build_runtime_sync_plan(state: Any) -> Dict[str, Any]:
    observatory_terms: List[str] = []
    auto_terms: List[str] = []
    manual_balancers: Dict[str, List[str]] = {}
    seen_observatory: set[str] = set()
    seen_auto: set[str] = set()
    strict_enabled = False

    for raw_item in state.get("subscriptions") if isinstance(state, dict) else []:
        item = _ensure_runtime_snapshot_defaults(raw_item)
        if not _subscription_runtime_active(item):
            continue
        terms = _subscription_runtime_selector_terms(item)
        if not terms:
            continue
        for term in terms:
            if term not in seen_observatory:
                seen_observatory.add(term)
                observatory_terms.append(term)

        if _read_bool_value(item, LAST_RUNTIME_AUTO_RULE_KEYS, True):
            for term in terms:
                if term not in seen_auto:
                    seen_auto.add(term)
                    auto_terms.append(term)
            if _clean_routing_mode(item.get("last_routing_mode")) == ROUTING_MODE_STRICT:
                strict_enabled = True

        for balancer_tag in _read_string_list_value(item, LAST_RUNTIME_BALANCER_TAGS_KEYS):
            bucket = manual_balancers.setdefault(balancer_tag, [])
            seen_bucket = set(bucket)
            for term in terms:
                if term in seen_bucket:
                    continue
                seen_bucket.add(term)
                bucket.append(term)

    return {
        "observatory_terms": observatory_terms,
        "auto_terms": auto_terms,
        "manual_balancers": manual_balancers,
        "routing_mode": ROUTING_MODE_STRICT if strict_enabled and auto_terms else ROUTING_MODE_SAFE,
        "has_runtime_targets": bool(observatory_terms or auto_terms or manual_balancers),
    }


def _collect_runtime_subscription_tags(state: Any) -> List[str]:
    tags: List[str] = []
    seen: set[str] = set()
    for item in state.get("subscriptions") if isinstance(state, dict) else []:
        if not isinstance(item, dict):
            continue
        if item.get("ping_enabled", True) is False:
            continue
        raw = item.get("last_tags")
        if not isinstance(raw, list):
            continue
        for value in raw:
            tag = str(value or "").strip()
            if not tag or tag in seen:
                continue
            seen.add(tag)
            tags.append(tag)
    return tags


def _effective_runtime_routing_mode_from_state(state: Any) -> str:
    for item in state.get("subscriptions") if isinstance(state, dict) else []:
        if not isinstance(item, dict):
            continue
        if item.get("ping_enabled", True) is False:
            continue
        raw_tags = item.get("last_tags")
        if not isinstance(raw_tags, list):
            continue
        if not any(str(tag or "").strip() for tag in raw_tags):
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
    cfg, routing, normalized_model = _ensure_routing_model(_read_json_file(routing_path, {}))
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

    changed = bool(normalized_model)
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
        changed = bool(changed or balancer_changed or rule_changed or migrate_stats.get("changed"))
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
        changed = bool(changed or rule_changed or balancer_changed or migrate_stats.get("changed"))

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

    _prune_empty_routing_collections(routing)
    main_changed = _write_json_if_changed(routing_path, cfg, snapshot=snapshot)
    raw_changed = _write_jsonc_sidecar_if_changed(
        routing_path,
        cfg,
        header="// Generated by XKeen UI subscriptions (routing sync)",
        snapshot=snapshot,
        preserve_existing_comments=True,
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


def _merge_selector_terms(current: Any, extra: Iterable[str]) -> List[str]:
    selector: List[str] = []
    seen: set[str] = set()
    for tag in _clean_tags_list(current if isinstance(current, list) else []):
        if tag in seen:
            continue
        seen.add(tag)
        selector.append(tag)
    for tag in _clean_tags_list(extra):
        if tag in seen:
            continue
        seen.add(tag)
        selector.append(tag)
    return selector


def _subtract_selector_terms(current: Any, removed: Iterable[str]) -> List[str]:
    remove = set(_clean_tags_list(removed))
    if not remove:
        return _clean_tags_list(current if isinstance(current, list) else [])
    return [
        tag
        for tag in _clean_tags_list(current if isinstance(current, list) else [])
        if tag not in remove
    ]


def _replace_existing_balancer_selector_terms(
    routing: Dict[str, Any],
    *,
    balancer_tag: str,
    remove_terms: Iterable[str],
    add_terms: Iterable[str],
) -> bool:
    balancers = routing.get("balancers")
    if not isinstance(balancers, list):
        return False
    balancer = _find_balancer_by_tag(balancers, balancer_tag)
    if balancer is None:
        return False
    before = copy.deepcopy(balancer)
    selector = _subtract_selector_terms(balancer.get("selector"), remove_terms)
    balancer["selector"] = _merge_selector_terms(selector, add_terms)
    return before != balancer


def _update_existing_balancer_selector(
    routing: Dict[str, Any],
    *,
    balancer_tag: str,
    selector_terms: Iterable[str],
) -> bool:
    balancers = routing.get("balancers")
    if not isinstance(balancers, list):
        return False
    balancer = _find_balancer_by_tag(balancers, balancer_tag)
    if balancer is None:
        return False
    before = copy.deepcopy(balancer)
    balancer["selector"] = _merge_selector_terms(balancer.get("selector"), selector_terms)
    return before != balancer


def _remove_balancer_by_tag_if_leastping(
    routing: Dict[str, Any],
    *,
    balancer_tag: str,
) -> bool:
    balancers = routing.get("balancers")
    if not isinstance(balancers, list):
        return False
    tag = str(balancer_tag or AUTO_BALANCER_TAG).strip() or AUTO_BALANCER_TAG
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


def _normalize_runtime_manual_balancers(plan: Any) -> Dict[str, List[str]]:
    raw = plan.get("manual_balancers") if isinstance(plan, dict) else {}
    out: Dict[str, List[str]] = {}
    for tag, values in raw.items() if isinstance(raw, dict) else []:
        clean_tag = str(tag or "").strip()
        clean_values = _clean_tags_list(values if isinstance(values, list) else [])
        if not clean_tag:
            continue
        out[clean_tag] = clean_values
    return out


def sync_subscription_runtime_plan_delta(
    *,
    xray_configs_dir: str,
    previous_plan: Dict[str, Any] | None = None,
    next_plan: Dict[str, Any] | None = None,
    snapshot: SnapshotCallback | None = None,
) -> Dict[str, Any]:
    prev = previous_plan if isinstance(previous_plan, dict) else {}
    nxt = next_plan if isinstance(next_plan, dict) else {}

    prev_observatory_terms = _clean_tags_list(prev.get("observatory_terms") or [])
    next_observatory_terms = _clean_tags_list(nxt.get("observatory_terms") or [])
    prev_auto_terms = _clean_tags_list(prev.get("auto_terms") or [])
    next_auto_terms = _clean_tags_list(nxt.get("auto_terms") or [])
    prev_manual_targets = _normalize_runtime_manual_balancers(prev)
    next_manual_targets = _normalize_runtime_manual_balancers(nxt)
    next_has_runtime_targets = bool(nxt.get("has_runtime_targets"))
    preserved_tags = _preserved_balancer_tags(xray_configs_dir)

    observatory_changed = sync_observatory_subjects(
        xray_configs_dir=xray_configs_dir,
        add_tags=next_observatory_terms + (preserved_tags if next_has_runtime_targets else []),
        remove_tags=[tag for tag in prev_observatory_terms if tag not in set(next_observatory_terms)],
        managed_active=next_has_runtime_targets,
        snapshot=snapshot,
    )

    routing_path = _config_fragment_path(xray_configs_dir, ROUTING_FILE)
    cfg, routing, normalized_model = _ensure_routing_model(_read_json_file(routing_path, {}))
    changed = bool(normalized_model)
    selector: List[str] = []
    balancer_tag = _choose_auto_balancer_tag(routing)
    applied_manual_tags: List[str] = []

    balancer = _find_balancer_by_tag(routing.get("balancers", []), balancer_tag)
    current_selector = _clean_tags_list(
        balancer.get("selector") if isinstance(balancer, dict) and isinstance(balancer.get("selector"), list) else []
    )

    if next_auto_terms:
        selector = _subtract_selector_terms(current_selector, prev_auto_terms)
        selector = _merge_selector_terms(selector, next_auto_terms)
        selector = _merge_selector_terms(selector, preserved_tags)
        changed = bool(
            _ensure_least_ping_balancer(
                routing,
                balancer_tag=balancer_tag,
                selector_tags=selector,
            )
            or changed
        )
        changed = bool(_ensure_default_balancer_rule(routing, balancer_tag=balancer_tag) or changed)
    else:
        changed = bool(_remove_auto_balancer_rule(routing) or changed)
        if isinstance(balancer, dict):
            selector = _subtract_selector_terms(current_selector, prev_auto_terms)
            non_preserved_selector = [tag for tag in selector if tag not in preserved_tags]
            if non_preserved_selector:
                before_balancer = copy.deepcopy(balancer)
                balancer["selector"] = selector
                changed = bool(before_balancer != balancer or changed)
            else:
                changed = bool(_remove_balancer_by_tag_if_leastping(routing, balancer_tag=balancer_tag) or changed)
                selector = []

    manual_tags = sorted(set(prev_manual_targets) | set(next_manual_targets))
    for tag in manual_tags:
        if _replace_existing_balancer_selector_terms(
            routing,
            balancer_tag=tag,
            remove_terms=prev_manual_targets.get(tag) or [],
            add_terms=next_manual_targets.get(tag) or [],
        ):
            changed = True
        if (next_manual_targets.get(tag) or []) and _find_balancer_by_tag(routing.get("balancers", []), tag) is not None:
            applied_manual_tags.append(tag)

    strict_enabled = (
        _clean_routing_mode(nxt.get("routing_mode")) == ROUTING_MODE_STRICT
        and any(tag not in AUTO_BALANCER_PRESERVE_TAGS for tag in next_auto_terms)
    )
    migrate_stats = _sync_vless_reality_rules_to_balancer(
        routing,
        balancer_tag=balancer_tag,
        enabled=strict_enabled,
    )
    changed = bool(changed or migrate_stats.get("changed"))

    routing_changed = False
    if changed:
        routing_header = (
            "// Generated by XKeen UI subscriptions (routing sync)"
            if next_has_runtime_targets
            else ""
        )
        _prune_empty_routing_collections(routing)
        main_changed = _write_json_if_changed(routing_path, cfg, snapshot=snapshot)
        raw_changed = _write_jsonc_sidecar_if_changed(
            routing_path,
            cfg,
            header=routing_header,
            snapshot=snapshot,
            preserve_existing_comments=True,
        )
        routing_changed = bool(main_changed or raw_changed)

    return {
        "baseline_restored": False,
        "observatory_changed": bool(observatory_changed),
        "routing_changed": bool(routing_changed),
        "routing_sync": {
            "changed": bool(routing_changed),
            "selector": selector,
            "balancer_tag": balancer_tag if next_auto_terms else "",
            "routing_file": os.path.basename(routing_path),
            "routing_mode": ROUTING_MODE_STRICT if strict_enabled else ROUTING_MODE_SAFE,
            "migrated_rules": int(migrate_stats.get("migrated") or 0),
            "reverted_rules": int(migrate_stats.get("reverted") or 0),
            "skipped_rules": int(migrate_stats.get("skipped") or 0),
            "manual_balancer_tags": applied_manual_tags,
        },
        "has_runtime_targets": next_has_runtime_targets,
    }


def sync_subscription_routing_plan(
    *,
    xray_configs_dir: str,
    auto_selector_terms: Iterable[str],
    manual_balancers: Dict[str, List[str]] | None = None,
    routing_mode: str = ROUTING_MODE_SAFE,
    snapshot: SnapshotCallback | None = None,
) -> Dict[str, Any]:
    auto_terms = _clean_tags_list(auto_selector_terms)
    manual_targets = {
        str(tag or "").strip(): _clean_tags_list(values)
        for tag, values in (manual_balancers or {}).items()
        if str(tag or "").strip() and _clean_tags_list(values)
    }
    if not auto_terms and not manual_targets:
        return {
            "changed": False,
            "selector": [],
            "balancer_tag": "",
            "routing_file": "",
            "routing_mode": ROUTING_MODE_SAFE,
            "migrated_rules": 0,
            "reverted_rules": 0,
            "skipped_rules": 0,
            "manual_balancer_tags": [],
        }

    routing_path = _config_fragment_path(xray_configs_dir, ROUTING_FILE)
    cfg, routing, normalized_model = _ensure_routing_model(_read_json_file(routing_path, {}))
    changed = bool(normalized_model)
    selector: List[str] = []
    balancer_tag = ""
    migrated_rules = 0
    reverted_rules = 0
    skipped_rules = 0
    applied_manual_tags: List[str] = []

    if auto_terms:
        balancer_tag = _choose_auto_balancer_tag(routing)
        balancer = _find_balancer_by_tag(routing.get("balancers", []), balancer_tag)
        current_selector = _clean_tags_list(
            balancer.get("selector") if isinstance(balancer, dict) and isinstance(balancer.get("selector"), list) else []
        )
        selector = _merge_selector_terms(current_selector, auto_terms)
        for tag in _preserved_balancer_tags(xray_configs_dir):
            if tag not in selector:
                selector.append(tag)
        changed = bool(
            _ensure_least_ping_balancer(
                routing,
                balancer_tag=balancer_tag,
                selector_tags=selector,
            )
            or changed
        )
        changed = bool(_ensure_default_balancer_rule(routing, balancer_tag=balancer_tag) or changed)
        strict_enabled = (
            _clean_routing_mode(routing_mode) == ROUTING_MODE_STRICT
            and any(tag not in AUTO_BALANCER_PRESERVE_TAGS for tag in selector)
        )
        migrate_stats = _sync_vless_reality_rules_to_balancer(
            routing,
            balancer_tag=balancer_tag,
            enabled=strict_enabled,
        )
        changed = bool(changed or migrate_stats.get("changed"))
        migrated_rules = int(migrate_stats.get("migrated") or 0)
        reverted_rules = int(migrate_stats.get("reverted") or 0)
        skipped_rules = int(migrate_stats.get("skipped") or 0)
    else:
        strict_enabled = False

    for tag in sorted(manual_targets):
        if _update_existing_balancer_selector(routing, balancer_tag=tag, selector_terms=manual_targets.get(tag) or []):
            changed = True
        if _find_balancer_by_tag(routing.get("balancers", []), tag) is not None:
            applied_manual_tags.append(tag)

    if not changed:
        return {
            "changed": False,
            "selector": selector,
            "balancer_tag": balancer_tag,
            "routing_file": os.path.basename(routing_path),
            "routing_mode": ROUTING_MODE_STRICT if strict_enabled else ROUTING_MODE_SAFE,
            "migrated_rules": migrated_rules,
            "reverted_rules": reverted_rules,
            "skipped_rules": skipped_rules,
            "manual_balancer_tags": applied_manual_tags,
        }

    _prune_empty_routing_collections(routing)
    main_changed = _write_json_if_changed(routing_path, cfg, snapshot=snapshot)
    raw_changed = _write_jsonc_sidecar_if_changed(
        routing_path,
        cfg,
        header="// Generated by XKeen UI subscriptions (routing sync)",
        snapshot=snapshot,
        preserve_existing_comments=True,
    )
    return {
        "changed": bool(main_changed or raw_changed),
        "selector": selector,
        "balancer_tag": balancer_tag,
        "routing_file": os.path.basename(routing_path),
        "routing_mode": ROUTING_MODE_STRICT if strict_enabled else ROUTING_MODE_SAFE,
        "migrated_rules": migrated_rules,
        "reverted_rules": reverted_rules,
        "skipped_rules": skipped_rules,
        "manual_balancer_tags": applied_manual_tags,
    }


def _rebuild_subscription_runtime(
    ui_state_dir: str,
    *,
    xray_configs_dir: str,
    snapshot: SnapshotCallback | None = None,
    previous_state: Dict[str, Any] | None = None,
    state_override: Dict[str, Any] | None = None,
) -> Dict[str, Any]:
    prev_state = _normalize_state(previous_state) if isinstance(previous_state, dict) else load_subscription_state(ui_state_dir)
    next_state = _normalize_state(state_override) if isinstance(state_override, dict) else load_subscription_state(ui_state_dir)
    prev_plan = _build_runtime_sync_plan(prev_state)
    next_plan = _build_runtime_sync_plan(next_state)
    return sync_subscription_runtime_plan_delta(
        xray_configs_dir=xray_configs_dir,
        previous_plan=prev_plan,
        next_plan=next_plan,
        snapshot=snapshot,
    )


def sync_observatory_subjects(
    *,
    xray_configs_dir: str,
    add_tags: Iterable[str],
    remove_tags: Iterable[str] | None = None,
    managed_active: bool | None = None,
    snapshot: SnapshotCallback | None = None,
) -> bool:
    add = [str(t or "").strip() for t in add_tags if str(t or "").strip()]
    remove = {str(t or "").strip() for t in (remove_tags or []) if str(t or "").strip()}
    if not add and not remove:
        return False

    dst_json = os.path.join(str(xray_configs_dir or ""), "07_observatory.json")
    cfg = _load_observatory(dst_json)
    obs = cfg.get("observatory")
    created_observatory = not isinstance(obs, dict)
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
    if created_observatory or not obs:
        obs.setdefault("probeUrl", "https://www.gstatic.com/generate_204")
        obs.setdefault("probeInterval", "60s")
        obs.setdefault("enableConcurrency", True)
    cfg["observatory"] = obs

    changed = _write_json_if_changed(dst_json, cfg, snapshot=snapshot)
    observatory_header = (
        "// Generated by XKeen UI subscriptions (observatory subjects)"
        if (bool(add) if managed_active is None else bool(managed_active))
        else ""
    )
    jsonc_changed = _write_jsonc_sidecar_if_changed(
        dst_json,
        cfg,
        header=observatory_header,
        snapshot=snapshot,
        preserve_existing_comments=True,
    )
    changed = bool(changed or jsonc_changed)

    return changed


def preview_subscription(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Fetch and parse a subscription URL without saving anything to disk.

    Mirrors the parse path of :func:`refresh_subscription` but performs no
    state mutation, no file writes, no observatory/routing sync, and no
    Xray restart. Used by the modal's "Предпросмотр" button so users can
    inspect, filter, and exclude nodes before committing the subscription.
    """
    data = payload if isinstance(payload, dict) else {}
    url = str(data.get("url") or "").strip()
    if not url:
        raise ValueError("url is required")

    tag_prefix = _clean_tag_prefix(data.get("tag") or data.get("name") or _default_id_from_url(url), "sub")
    name_filter = _stored_filter_value(data, NAME_FILTER_KEYS)
    type_filter = _stored_filter_value(data, TYPE_FILTER_KEYS)
    transport_filter = _stored_filter_value(data, TRANSPORT_FILTER_KEYS)
    excluded = _read_string_list_value(data, EXCLUDED_NODE_KEYS_KEYS)
    _compile_regex_filter(name_filter, "фильтра имени")
    _compile_regex_filter(type_filter, "фильтра типа")
    _compile_regex_filter(transport_filter, "фильтра транспорта")

    body, headers = fetch_subscription_body(url)
    links = parse_subscription_links(body)
    if links:
        source_format = "links"
        outbounds, errors, stats = build_subscription_outbounds(
            links,
            tag_prefix=tag_prefix,
            name_filter=name_filter,
            type_filter=type_filter,
            transport_filter=transport_filter,
            excluded_node_keys=excluded,
        )
    else:
        source_format = "xray-json"
        outbounds, errors, stats = build_subscription_json_outbounds(
            body,
            tag_prefix=tag_prefix,
            name_filter=name_filter,
            type_filter=type_filter,
            transport_filter=transport_filter,
            excluded_node_keys=excluded,
        )

    nodes = _normalize_last_nodes(stats.get("nodes"))
    source_count = int(stats.get("source_count") or 0)
    filtered_out_count = int(stats.get("filtered_out_count") or 0)
    profile_interval = _parse_profile_interval_hours(headers)

    return {
        "ok": True,
        "nodes": nodes,
        "count": len(outbounds),
        "source_count": source_count,
        "filtered_out_count": filtered_out_count,
        "warnings": _subscription_result_warnings(nodes),
        "errors": errors,
        "source_format": source_format,
        "profile_update_interval_hours": profile_interval,
        "tag_prefix": tag_prefix,
    }


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
        "warnings": [],
        "last_nodes": [],
        "tags": [],
        "errors": [],
        "source_format": "",
        "manual_edits_preserved": 0,
        "manual_exclusions_added": 0,
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
        excluded_node_keys = _read_string_list_value(sub, EXCLUDED_NODE_KEYS_KEYS)
        if links:
            outbounds, errors, stats = build_subscription_outbounds(
                links,
                tag_prefix=str(sub.get("tag") or sub.get("id") or "sub"),
                name_filter=str(sub.get("name_filter") or ""),
                type_filter=str(sub.get("type_filter") or ""),
                transport_filter=str(sub.get("transport_filter") or ""),
                excluded_node_keys=excluded_node_keys,
            )
        else:
            source_format = "xray-json"
            outbounds, errors, stats = build_subscription_json_outbounds(
                body,
                tag_prefix=str(sub.get("tag") or sub.get("id") or "sub"),
                name_filter=str(sub.get("name_filter") or ""),
                type_filter=str(sub.get("type_filter") or ""),
                transport_filter=str(sub.get("transport_filter") or ""),
                excluded_node_keys=excluded_node_keys,
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

        output_path = _subscription_output_path(xray_configs_dir, sub)
        manual_overrides = _collect_subscription_manual_overrides(sub, output_path, outbounds, preview_nodes)
        manual_deleted_keys = _clean_string_list(manual_overrides.get("deleted_node_keys"))
        manual_exclusions_added = 0
        if manual_deleted_keys:
            merged_excluded = _clean_string_list(excluded_node_keys + manual_deleted_keys)
            manual_exclusions_added = max(0, len(merged_excluded) - len(excluded_node_keys))
            if manual_exclusions_added:
                excluded_node_keys = merged_excluded
                sub["excluded_node_keys"] = excluded_node_keys
                if links:
                    outbounds, errors, stats = build_subscription_outbounds(
                        links,
                        tag_prefix=str(sub.get("tag") or sub.get("id") or "sub"),
                        name_filter=str(sub.get("name_filter") or ""),
                        type_filter=str(sub.get("type_filter") or ""),
                        transport_filter=str(sub.get("transport_filter") or ""),
                        excluded_node_keys=excluded_node_keys,
                    )
                else:
                    outbounds, errors, stats = build_subscription_json_outbounds(
                        body,
                        tag_prefix=str(sub.get("tag") or sub.get("id") or "sub"),
                        name_filter=str(sub.get("name_filter") or ""),
                        type_filter=str(sub.get("type_filter") or ""),
                        transport_filter=str(sub.get("transport_filter") or ""),
                        excluded_node_keys=excluded_node_keys,
                    )
                source_count = int(stats.get("source_count") or 0)
                filtered_out_count = int(stats.get("filtered_out_count") or 0)
                preview_nodes = _normalize_last_nodes(stats.get("nodes"))
                node_latency = _prune_node_latency_map(node_latency, preview_nodes)
                if source_count > 0 and not outbounds and filtered_out_count >= source_count:
                    raise RuntimeError("Ни один узел не подошёл под фильтры подписки.")
                if not outbounds:
                    raise RuntimeError("no_valid_outbounds")

        generated_baselines = _subscription_generated_baselines(outbounds, preview_nodes)
        outbounds, manual_edits_preserved = _apply_subscription_manual_overrides(outbounds, preview_nodes, manual_overrides)
        tags = [str(ob.get("tag") or "").strip() for ob in outbounds if isinstance(ob, dict) and ob.get("tag")]
        output_obj = {"outbounds": outbounds}
        changed = _write_subscription_output_if_changed(output_path, output_obj, snapshot=snapshot)
        current_file_hash = str(manual_overrides.get("current_hash") or "").strip() if isinstance(manual_overrides, dict) else ""
        previous_output_hash = str(sub.get("last_hash") or "").strip()
        accepted_manual_file_change = bool(
            (manual_edits_preserved or manual_exclusions_added)
            and current_file_hash
            and current_file_hash != previous_output_hash
        )
        changed = bool(changed or accepted_manual_file_change)

        ensure_xray_jsonc_dir()
        raw_path = jsonc_path_for(output_path)
        raw_text = (
            f"// Generated by XKeen UI subscription: {sub.get('name') or sub.get('id')}\n"
            + json.dumps(output_obj, ensure_ascii=False, indent=2)
            + "\n"
        )
        try:
            if changed or not os.path.exists(raw_path):
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
            else:
                raw_old = load_text(raw_path, default="")
                if isinstance(raw_old, str) and raw_old != raw_text and not _jsonc_semantically_matches_subscription_output(raw_old, output_obj):
                    if snapshot and os.path.exists(raw_path):
                        snapshot(raw_path)
                    _atomic_write_text(raw_path, raw_text)
        except Exception:
            pass

        interval = _clamp_interval(sub.get("interval_hours") or DEFAULT_INTERVAL_HOURS)
        profile_interval = _parse_profile_interval_hours(headers)
        if profile_interval is not None:
            sub["profile_update_interval_hours"] = profile_interval
        else:
            sub.pop("profile_update_interval_hours", None)

        warnings = _subscription_result_warnings(preview_nodes)

        sub.update(
            {
                "last_ok": True,
                "last_error": "",
                "last_update_ts": now_ts,
                "last_count": len(outbounds),
                "last_source_count": source_count,
                "last_filtered_out_count": filtered_out_count,
                "last_warnings": warnings,
                "last_nodes": preview_nodes,
                "node_latency": node_latency,
                "last_tags": tags,
                "last_selector_terms": _derive_selector_terms_from_tags(tags) if bool(sub.get("ping_enabled", True)) and tags else [],
                "last_routing_balancer_tags": _read_string_list_value(sub, ROUTING_BALANCER_TAGS_KEYS),
                "last_routing_auto_rule": _read_bool_value(sub, ROUTING_AUTO_RULE_KEYS, True),
                "last_routing_mode": _clean_routing_mode(sub.get("routing_mode")),
                "last_runtime_active": bool(sub.get("ping_enabled", True)) and bool(tags),
                "last_hash": _subscription_output_hash(output_obj),
                "last_generated_outbounds": generated_baselines,
                "last_errors": errors,
                "last_source_format": source_format,
                "next_update_ts": now_ts + (interval * 3600) if bool(sub.get("enabled", True)) else None,
                "interval_hours": interval,
            }
        )

        _ensure_subscription_managed_baselines(ui_state_dir, xray_configs_dir)
        state_for_runtime = load_subscription_state(ui_state_dir)
        previous_state_for_runtime = _normalize_state(copy.deepcopy(state_for_runtime))
        subs_for_runtime = state_for_runtime.get("subscriptions")
        if not isinstance(subs_for_runtime, list):
            subs_for_runtime = []
        replaced = False
        for pos, existing_sub in enumerate(subs_for_runtime):
            if not isinstance(existing_sub, dict):
                continue
            if _clean_id(existing_sub.get("id")) != _clean_id(sub.get("id")):
                continue
            subs_for_runtime[pos] = dict(sub)
            replaced = True
            break
        if not replaced:
            subs_for_runtime.append(dict(sub))
        state_for_runtime["subscriptions"] = subs_for_runtime
        rebuild_stats = _rebuild_subscription_runtime(
            ui_state_dir,
            xray_configs_dir=xray_configs_dir,
            snapshot=snapshot,
            previous_state=previous_state_for_runtime,
            state_override=state_for_runtime,
        )
        observatory_changed = bool(rebuild_stats.get("observatory_changed"))
        routing_changed = bool(rebuild_stats.get("routing_changed"))
        routing_sync = rebuild_stats.get("routing_sync") if isinstance(rebuild_stats.get("routing_sync"), dict) else {}
        if not rebuild_stats.get("has_runtime_targets"):
            _clear_subscription_managed_baselines(ui_state_dir)

        sub.update(
            {
                "last_changed": bool(changed),
                "last_observatory_changed": bool(observatory_changed),
                "last_routing_changed": bool(routing_changed),
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
                "warnings": warnings,
                "last_nodes": preview_nodes,
                "node_latency": node_latency,
                "tags": tags,
                "errors": errors,
                "source_format": source_format,
                "manual_edits_preserved": int(manual_edits_preserved),
                "manual_exclusions_added": int(manual_exclusions_added),
                "output_file": os.path.basename(output_path),
                "interval_hours": interval,
                "profile_update_interval_hours": sub.get("profile_update_interval_hours"),
                "routing_file": (routing_sync.get("routing_file") if "routing_sync" in locals() else ""),
                "routing_balancer_tag": (routing_sync.get("balancer_tag") if "routing_sync" in locals() else ""),
                "routing_manual_balancer_tags": list(routing_sync.get("manual_balancer_tags") or []) if "routing_sync" in locals() else [],
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

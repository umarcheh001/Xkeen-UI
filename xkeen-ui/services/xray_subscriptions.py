"""Xray subscription management for XKeen UI.

The service stores subscription definitions in UI state, fetches V2Ray-style
subscription bodies, converts share links into Xray outbound fragments, and can
keep Xray observatory subjects in sync for leastPing/probing.
"""

from __future__ import annotations

import base64
import copy
import hashlib
import json
import os
import re
import threading
import time
import urllib.error
import urllib.request
from typing import Any, Callable, Dict, Iterable, List, Tuple
from urllib.parse import unquote, urlparse

from services.io.atomic import _atomic_write_json, _atomic_write_text
from services.url_policy import URLPolicy, env_flag, is_url_allowed
from services.xray_config_files import ensure_xray_jsonc_dir, jsonc_path_for
from services.xray_outbounds import build_proxy_outbound_from_link


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

        clean = dict(item)
        for alias in NAME_FILTER_KEYS[1:] + TYPE_FILTER_KEYS[1:]:
            clean.pop(alias, None)
        clean.update(
            {
                "id": sub_id,
                "name": str(item.get("name") or tag).strip() or tag,
                "tag": tag,
                "url": url,
                "name_filter": name_filter,
                "type_filter": type_filter,
                "enabled": bool(item.get("enabled", True)),
                "ping_enabled": bool(item.get("ping_enabled", item.get("pingEnabled", True))),
                "interval_hours": interval,
                "output_file": output_file,
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
        name_filter = _clean_regex_filter(
            _stored_filter_value(base, NAME_FILTER_KEYS) if name_filter_raw is _MISSING else name_filter_raw
        )
        type_filter = _clean_regex_filter(
            _stored_filter_value(base, TYPE_FILTER_KEYS) if type_filter_raw is _MISSING else type_filter_raw
        )
        _compile_regex_filter(name_filter, "фильтра имени")
        _compile_regex_filter(type_filter, "фильтра типа")

        now_ts = _now()
        sub = dict(base)
        for alias in NAME_FILTER_KEYS[1:] + TYPE_FILTER_KEYS[1:]:
            sub.pop(alias, None)
        sub.update(
            {
                "id": sub_id,
                "name": str(data.get("name") or base.get("name") or tag).strip() or tag,
                "tag": tag,
                "url": url,
                "name_filter": name_filter,
                "type_filter": type_filter,
                "enabled": bool(data.get("enabled", base.get("enabled", True))),
                "ping_enabled": bool(data.get("ping_enabled", data.get("pingEnabled", base.get("ping_enabled", True)))),
                "interval_hours": interval,
                "output_file": output_file,
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
    old_tags = removed.get("last_tags") if removed else []
    if isinstance(old_tags, list) and old_tags:
        observatory_changed = sync_observatory_subjects(
            xray_configs_dir=xray_configs_dir,
            add_tags=[],
            remove_tags=[str(t) for t in old_tags],
            snapshot=snapshot,
        )

    restarted = False
    if restart_xkeen and (output_removed or observatory_changed):
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


def _match_subscription_filters(
    *,
    node_name: str,
    protocol: str,
    name_filter: re.Pattern[str] | None,
    type_filter: re.Pattern[str] | None,
) -> bool:
    if name_filter and not name_filter.search(str(node_name or "")):
        return False
    if type_filter and not type_filter.search(_protocol_filter_text(protocol)):
        return False
    return True


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
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]], Dict[str, int]]:
    prefix = _clean_tag_prefix(tag_prefix, "sub")
    name_pattern = _compile_regex_filter(name_filter, "фильтра имени")
    type_pattern = _compile_regex_filter(type_filter, "фильтра типа")
    source_count = len(list(links or []))
    filtered_links: List[str] = []
    for link in links or []:
        protocol = _protocol_from_link(link)
        node_name = _node_name_from_link(link) or protocol or "node"
        if not _match_subscription_filters(
            node_name=node_name,
            protocol=protocol,
            name_filter=name_pattern,
            type_filter=type_pattern,
        ):
            continue
        filtered_links.append(link)

    outbounds: List[Dict[str, Any]] = []
    errors: List[Dict[str, Any]] = []
    used: set[str] = set()

    for idx, link in enumerate(filtered_links):
        node = _clean_node_name(_node_name_from_link(link), f"node{idx + 1}")
        tag = _unique_tag(f"{prefix}--{node}", used)
        try:
            outbound = build_proxy_outbound_from_link(link, tag)
            outbounds.append(outbound)
        except Exception as exc:
            errors.append({"idx": idx, "tag": tag, "error": str(exc)})

    return outbounds, errors, {
        "source_count": source_count,
        "filtered_out_count": max(0, source_count - len(filtered_links)),
    }


def build_subscription_json_outbounds(
    body: str,
    *,
    tag_prefix: str,
    name_filter: str = "",
    type_filter: str = "",
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]], Dict[str, int]]:
    obj = _load_subscription_json(body)
    if obj is None:
        return [], [], {"source_count": 0, "filtered_out_count": 0}

    prefix = _clean_tag_prefix(tag_prefix, "sub")
    name_pattern = _compile_regex_filter(name_filter, "фильтра имени")
    type_pattern = _compile_regex_filter(type_filter, "фильтра типа")
    candidates = list(_iter_json_proxy_outbounds(obj))
    source_count = len(candidates)
    filtered_candidates: List[Tuple[Dict[str, Any], str]] = []
    for source, name_hint in candidates:
        protocol = str(source.get("protocol") or "node").strip().lower() or "node"
        original_tag = str(source.get("tag") or "").strip()
        node_name = name_hint or original_tag or protocol
        if not _match_subscription_filters(
            node_name=node_name,
            protocol=protocol,
            name_filter=name_pattern,
            type_filter=type_pattern,
        ):
            continue
        filtered_candidates.append((source, name_hint))

    outbounds: List[Dict[str, Any]] = []
    errors: List[Dict[str, Any]] = []
    used: set[str] = set()

    for idx, (source, name_hint) in enumerate(filtered_candidates):
        protocol = str(source.get("protocol") or "node").strip() or "node"
        fallback = f"node{idx + 1}"
        original_tag = str(source.get("tag") or "").strip()
        node = _clean_node_name(name_hint or original_tag or protocol, fallback)
        tag = _unique_tag(f"{prefix}--{node}", used)
        try:
            outbound = copy.deepcopy(source)
            outbound["tag"] = tag
            outbounds.append(outbound)
        except Exception as exc:
            errors.append({"idx": idx, "tag": tag, "error": str(exc)})

    return outbounds, errors, {
        "source_count": source_count,
        "filtered_out_count": max(0, source_count - len(filtered_candidates)),
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


def _load_observatory(path: str) -> Dict[str, Any]:
    obj = _read_json_file(path, {})
    return obj if isinstance(obj, dict) else {}


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
        "restarted": False,
        "count": 0,
        "source_count": 0,
        "filtered_out_count": 0,
        "tags": [],
        "errors": [],
        "source_format": "",
    }
    now_ts = _now()
    source_count = 0
    filtered_out_count = 0

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
            )
        else:
            source_format = "xray-json"
            outbounds, errors, stats = build_subscription_json_outbounds(
                body,
                tag_prefix=str(sub.get("tag") or sub.get("id") or "sub"),
                name_filter=str(sub.get("name_filter") or ""),
                type_filter=str(sub.get("type_filter") or ""),
            )
        source_count = int(stats.get("source_count") or 0)
        filtered_out_count = int(stats.get("filtered_out_count") or 0)
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
        if bool(sub.get("ping_enabled", True)):
            observatory_changed = sync_observatory_subjects(
                xray_configs_dir=xray_configs_dir,
                add_tags=tags,
                remove_tags=previous_tags,
                snapshot=snapshot,
            )
        elif previous_tags:
            observatory_changed = sync_observatory_subjects(
                xray_configs_dir=xray_configs_dir,
                add_tags=[],
                remove_tags=previous_tags,
                snapshot=snapshot,
            )

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
                "last_tags": tags,
                "last_hash": _content_hash(output_obj),
                "last_changed": bool(changed),
                "last_observatory_changed": bool(observatory_changed),
                "last_errors": errors,
                "last_source_format": source_format,
                "next_update_ts": now_ts + (interval * 3600) if bool(sub.get("enabled", True)) else None,
                "interval_hours": interval,
            }
        )

        restarted = False
        if restart and restart_xkeen and (changed or observatory_changed):
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
                "restarted": restarted,
                "count": len(outbounds),
                "source_count": source_count,
                "filtered_out_count": filtered_out_count,
                "tags": tags,
                "errors": errors,
                "source_format": source_format,
                "output_file": os.path.basename(output_path),
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
                "next_update_ts": now_ts + (interval * 3600) if bool(sub.get("enabled", True)) else None,
            }
        )
        result.update(
            {
                "ok": False,
                "error": str(exc),
                "source_count": source_count,
                "filtered_out_count": filtered_out_count,
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

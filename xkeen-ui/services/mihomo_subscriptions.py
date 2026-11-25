"""Managed Mihomo subscriptions with conditional fetches and file-provider updates."""

from __future__ import annotations

import copy
import hashlib
import json
import os
import re
import threading
import time
from typing import Any, Callable, Dict, List, Sequence, Tuple
from urllib.parse import urlparse

from mihomo_config_generator import build_full_config
from services.io.atomic import _atomic_write_json, _atomic_write_text
from services.mihomo_proxy_config import apply_proxy_insert, insert_proxy_into_groups
from services.mihomo_xray_json import convert_subscription_source_text, convert_subscription_text
from services.subscription_schedule import plan_alignment
from services.url_policy import env_flag
from services.xray_subscriptions import fetch_subscription_body_for_xray as fetch_subscription_body
from utils.fs import load_text


STATE_VERSION = 1
STATE_FILENAME = "mihomo_subscriptions.json"

DEFAULT_INTERVAL_HOURS = 24
MIN_INTERVAL_HOURS = 1
MAX_INTERVAL_HOURS = 168
DEFAULT_REFRESH_LOOKAHEAD_SECONDS = 5 * 60
MAX_REFRESH_LOOKAHEAD_SECONDS = 3600
REFRESH_PARSER_XRAY_JSON = "xray-json"
REFRESH_PARSER_MIHOMO_PROVIDER = "mihomo-provider"
_CONNECTION_FINGERPRINTS = {"chrome", "firefox", "safari", "iOS", "android", "edge", "360", "qq", "random"}
_CONNECTION_X25519_MODES = {"inherit", "enable", "disable"}

_STATE_LOCK = threading.RLock()
_SCHEDULER_LOCK = threading.Lock()
_SCHEDULER_STARTED = False

RestartCallback = Callable[..., Any]
SaveCallback = Callable[[str], Any]


def _fetch_xray_subscription_body(url: str, validators: Dict[str, str] | None = None) -> Tuple[str, Dict[str, str], Dict[str, Any]]:
    result = fetch_subscription_body(str(url or ""), **({"validators": validators} if validators else {}))
    if not isinstance(result, tuple):
        raise RuntimeError("unexpected_subscription_fetch_result")
    if len(result) == 2:
        body, headers = result
        return str(body or ""), dict(headers or {}), {}
    if len(result) == 3:
        body, headers, meta = result
        return str(body or ""), dict(headers or {}), dict(meta or {})
    raise RuntimeError("unexpected_subscription_fetch_result")


def subscription_state_path(ui_state_dir: str) -> str:
    return os.path.join(str(ui_state_dir or "/opt/etc/xkeen-ui"), STATE_FILENAME)


def _now() -> float:
    return time.time()


def _hash_text(text: Any) -> str:
    normalised = str(text or "").replace("\r\n", "\n").replace("\r", "\n").rstrip("\n")
    return hashlib.sha256(normalised.encode("utf-8", errors="ignore")).hexdigest()


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


def _clean_id(value: Any) -> str:
    raw = str(value or "").strip().lower()
    raw = re.sub(r"[^a-z0-9_.-]+", "-", raw)
    raw = re.sub(r"-{2,}", "-", raw).strip("-._")
    if not raw:
        raw = "mihomo-sub"
    if raw[0].isdigit():
        raw = "sub-" + raw
    return raw[:60].strip("-._") or "mihomo-sub"


def _clamp_interval(value: Any) -> int:
    try:
        hours = int(float(str(value).strip()))
    except Exception:
        hours = DEFAULT_INTERVAL_HOURS
    return max(MIN_INTERVAL_HOURS, min(MAX_INTERVAL_HOURS, hours))


def _clean_string_list(value: Any) -> List[str]:
    if isinstance(value, (list, tuple, set)):
        raw = value
    else:
        raw = re.split(r"[,;]+", str(value or "").strip()) if str(value or "").strip() else []
    out: List[str] = []
    seen: set[str] = set()
    for item in raw:
        text = str(item or "").strip()
        if not text or text in seen:
            continue
        seen.add(text)
        out.append(text)
    return out


def _clean_connection_options(value: Any) -> Dict[str, str]:
    data = value if isinstance(value, dict) else {}
    fingerprint = str(data.get("fingerprint") or "").strip()
    if fingerprint not in _CONNECTION_FINGERPRINTS:
        fingerprint = ""
    x25519 = str(data.get("x25519") or "inherit").strip().lower()
    if x25519 not in _CONNECTION_X25519_MODES:
        x25519 = "inherit"
    return {"fingerprint": fingerprint, "x25519": x25519}


def _apply_flow_reality_option(line: str, mode: str) -> str:
    """Update a YAML flow mapping without splitting quoted values or comments."""
    start = line.index("{")
    quote = ""
    depth = 0
    segments = []
    segment_start = start + 1
    i = start
    comment = False
    while i < len(line):
        char = line[i]
        if comment:
            if char == "\n":
                comment = False
        elif quote:
            if quote == '"' and char == "\\":
                i += 2
                continue
            if char == quote:
                if quote == "'" and i + 1 < len(line) and line[i + 1] == "'":
                    i += 2
                    continue
                quote = ""
        elif char in "\"'":
            quote = char
        elif char == "#" and (i == 0 or line[i - 1].isspace()):
            comment = True
        elif char in "[{":
            depth += 1
        elif char in "]}":
            depth -= 1
            if depth == 0:
                segments.append(line[segment_start:i])
                break
        elif char == "," and depth == 1:
            segments.append(line[segment_start:i])
            segment_start = i + 1
        i += 1
    if depth != 0 or quote:
        raise ValueError("Не удалось обработать параметры Reality в подписке")
    existing = None
    key_match = None
    for index, segment in enumerate(segments):
        key_match = re.search(r"(?m)^\s*(?:support-x25519mlkem768|'support-x25519mlkem768'|\"support-x25519mlkem768\")\s*:", segment)
        if key_match:
            existing = index
            break
    if existing is not None and mode == "inherit":
        return line
    value = "false" if mode == "disable" else "true"
    if existing is None:
        if not segments[-1].strip():
            whitespace = segments[-1]
            segments[-1] = f"{whitespace}support-x25519mlkem768: {value}"
        else:
            segments.append(f" support-x25519mlkem768: {value}")
    else:
        segment = segments[existing]
        tail = segment[key_match.end():]
        suffix_match = re.search(r"\s+#.*|\s+$", tail, re.DOTALL)
        suffix = suffix_match.group(0) if suffix_match else ""
        segments[existing] = segment[:key_match.end()] + f" {value}" + suffix
    return line[:start + 1] + ",".join(segments) + line[i:]


def _apply_connection_options_to_proxy_block(block: Any, options: Any) -> str:
    """Apply imported node overrides without requiring PyYAML on the router."""
    values = _clean_connection_options(options)
    text = str(block or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    if not text:
        return text
    lines = text.split("\n")
    item_match = re.match(r"^(\s*)-\s+", lines[0])
    item_indent = len(item_match.group(1)) if item_match else 0
    key_indent = item_indent + 2
    fingerprint_idx = -1
    reality_idx = -1
    for idx, line in enumerate(lines):
        if len(line) - len(line.lstrip()) != key_indent:
            continue
        stripped = line.strip()
        if stripped.startswith("client-fingerprint:"):
            fingerprint_idx = idx
        elif stripped.startswith("reality-opts:"):
            reality_idx = idx

    has_tls = reality_idx >= 0 or any(
        len(line) - len(line.lstrip()) == key_indent and re.fullmatch(r"tls:\s*true\s*(?:#.*)?", line.strip())
        for line in lines
    )
    if not has_tls:
        return text
    supports_reality = any(
        len(line) - len(line.lstrip()) == key_indent
        and re.fullmatch(r"type:\s*(?:vless|vmess|trojan|'vless'|'vmess'|'trojan'|\"vless\"|\"vmess\"|\"trojan\")\s*(?:#.*)?", line.strip())
        for line in lines
    )

    if values["fingerprint"]:
        fingerprint_line = " " * key_indent + f"client-fingerprint: {values['fingerprint']}"
        if fingerprint_idx >= 0:
            lines[fingerprint_idx] = fingerprint_line
        else:
            insert_at = len(lines)
            while insert_at > 0 and not lines[insert_at - 1].strip():
                insert_at -= 1
            lines.insert(insert_at, fingerprint_line)

    if reality_idx >= 0 and supports_reality:
        reality_value = lines[reality_idx].split(":", 1)[1].lstrip()
        if reality_value.startswith("{"):
            flow = _apply_flow_reality_option("\n".join(lines[reality_idx:]), values["x25519"])
            return "\n".join(lines[:reality_idx] + [flow]).strip()
        child_indents = []
        for line in lines[reality_idx + 1:]:
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            indent = len(line) - len(line.lstrip())
            if indent <= key_indent:
                break
            child_indents.append(indent)
        reality_child_indent = min(child_indents, default=key_indent + 2)
        child_idx = -1
        for idx in range(reality_idx + 1, len(lines)):
            stripped = lines[idx].strip()
            indent = len(lines[idx]) - len(lines[idx].lstrip())
            if stripped and indent <= key_indent:
                break
            if indent == reality_child_indent and re.match(r"(?:support-x25519mlkem768|'support-x25519mlkem768'|\"support-x25519mlkem768\")\s*:", stripped):
                child_idx = idx
                break
        child_line = " " * reality_child_indent + f"support-x25519mlkem768: {'false' if values['x25519'] == 'disable' else 'true'}"
        if child_idx >= 0 and values["x25519"] != "inherit":
            lines[child_idx] = child_line
        elif child_idx < 0 and re.fullmatch(r"reality-opts:\s*(?:#.*)?", lines[reality_idx].strip()):
            insert_at = reality_idx + 1
            while insert_at < len(lines):
                stripped = lines[insert_at].strip()
                indent = len(lines[insert_at]) - len(lines[insert_at].lstrip())
                if stripped and indent <= key_indent:
                    break
                insert_at += 1
            lines.insert(insert_at, child_line)

    return "\n".join(lines).strip()


def _apply_connection_options_to_blocks(blocks: Sequence[Any], options: Any) -> List[str]:
    return [_apply_connection_options_to_proxy_block(block, options) for block in blocks if str(block or "").strip()]


def _clean_refresh_parser(value: Any) -> str:
    raw = str(value or "").strip().lower().replace("_", "-")
    if raw in {"mihomo-provider", "provider", "proxy-provider", "hwid-provider"}:
        return REFRESH_PARSER_MIHOMO_PROVIDER
    return REFRESH_PARSER_XRAY_JSON


def _derive_tag_from_url(url: str) -> str:
    try:
        host = urlparse(str(url or "")).hostname or ""
    except Exception:
        host = ""
    return "xray-sub:" + host if host else "xray-sub"


def _entry_id_from_url(url: str, tag: str) -> str:
    digest = hashlib.sha1(str(url or "").encode("utf-8", errors="ignore")).hexdigest()[:10]
    base = _clean_id(str(tag or "").replace("xray-sub:", "xray-"))
    return _clean_id(f"{base}-{digest}")


def _normalise_saved_state(raw: Any) -> Dict[str, Any]:
    state = raw if isinstance(raw, dict) else {}
    subs_raw = state.get("subscriptions") if isinstance(state.get("subscriptions"), list) else []
    subs: List[Dict[str, Any]] = []
    for item in subs_raw:
        if not isinstance(item, dict):
            continue
        url = str(item.get("url") or "").strip()
        if not url:
            continue
        sub_id = _clean_id(item.get("id") or _entry_id_from_url(url, item.get("tag") or "xray-sub"))
        entry = dict(item)
        entry["id"] = sub_id
        entry["url"] = url
        entry["source"] = str(item.get("source") or ("config" if item.get("proxy_names") else "generator")).strip() or "generator"
        entry["tag"] = str(item.get("tag") or _derive_tag_from_url(url)).strip() or "xray-sub"
        entry["refresh_parser"] = _clean_refresh_parser(item.get("refresh_parser") or item.get("refreshParser"))
        entry["enabled"] = bool(item.get("enabled", True))
        entry["interval_hours"] = _clamp_interval(item.get("interval_hours", item.get("intervalHours")))
        entry["groups"] = _clean_string_list(item.get("groups"))
        entry["proxy_names"] = _clean_string_list(item.get("proxy_names") or item.get("proxyNames"))
        entry["connection_options"] = _clean_connection_options(item.get("connection_options") or item.get("connectionOptions"))
        if "managed_yaml" in item:
            entry["managed_yaml"] = str(item.get("managed_yaml") or "")
        if not entry["enabled"]:
            entry["next_update_ts"] = None
        elif entry.get("next_update_ts") in (None, ""):
            entry["next_update_ts"] = _now() + entry["interval_hours"] * 3600
        subs.append(entry)

    return {
        "version": STATE_VERSION,
        "subscriptions": subs,
        "generator_state": copy.deepcopy(state.get("generator_state") or {}),
        "last_config_hash": str(state.get("last_config_hash") or ""),
        "last_synced_ts": float(state.get("last_synced_ts") or 0),
    }


def load_subscription_state(ui_state_dir: str) -> Dict[str, Any]:
    return _normalise_saved_state(_read_json_file(subscription_state_path(ui_state_dir), {}))


def list_subscriptions(ui_state_dir: str) -> List[Dict[str, Any]]:
    state = load_subscription_state(ui_state_dir)
    return copy.deepcopy(state.get("subscriptions") or [])


def update_subscription_settings(
    ui_state_dir: str,
    sub_id: str,
    payload: Dict[str, Any],
) -> Dict[str, Any]:
    """Update persisted settings for one managed Mihomo subscription."""
    data = payload if isinstance(payload, dict) else {}
    with _STATE_LOCK:
        state = load_subscription_state(ui_state_dir)
        sub_idx, sub = _find_subscription(state, sub_id)
        if sub_idx < 0 or sub is None:
            raise KeyError("subscription not found")

        now_ts = _now()
        entry = dict(sub)
        old_interval = _clamp_interval(entry.get("interval_hours"))
        if "interval_hours" in data or "intervalHours" in data or "interval" in data:
            interval = _clamp_interval(
                data.get("interval_hours", data.get("intervalHours", data.get("interval")))
            )
        else:
            interval = old_interval

        if "enabled" in data:
            enabled = bool(data.get("enabled"))
        else:
            enabled = bool(entry.get("enabled", True))

        schedule_changed = interval != old_interval or enabled != bool(entry.get("enabled", True))
        entry["interval_hours"] = interval
        entry["enabled"] = enabled
        entry["settings_updated_ts"] = now_ts
        if not enabled:
            entry["next_update_ts"] = None
        elif schedule_changed or entry.get("next_update_ts") in (None, ""):
            entry["next_update_ts"] = now_ts + interval * 3600

        generator_state = state.get("generator_state")
        if isinstance(generator_state, dict):
            proxy_index = _find_proxy_index_for_subscription(generator_state, entry)
            proxies = generator_state.get("proxies")
            if proxy_index >= 0 and isinstance(proxies, list) and proxy_index < len(proxies):
                proxy = proxies[proxy_index]
                if isinstance(proxy, dict):
                    meta = _extract_meta(proxy) or {}
                    meta.update(
                        {
                            "id": entry.get("id"),
                            "url": entry.get("url"),
                            "tag": entry.get("tag") or _derive_tag_from_url(entry.get("url") or ""),
                            "enabled": enabled,
                            "interval_hours": interval,
                            "proxy_index": proxy_index,
                        }
                    )
                    proxy["xray_json_subscription"] = meta
                    proxy.pop("xrayJsonSubscription", None)
                    proxy.pop("xraySubscription", None)
                    entry["proxy_index"] = proxy_index

        state["subscriptions"][sub_idx] = entry
        _write_state(ui_state_dir, state)
        return copy.deepcopy(entry)


def delete_subscription(
    ui_state_dir: str,
    sub_id: str,
    *,
    mihomo_config_file: str | None = None,
    remove_config_blocks: bool = False,
    config_text: str | None = None,
    save_callback: SaveCallback | None = None,
) -> Dict[str, Any]:
    """Delete a managed Mihomo subscription entry.

    For subscriptions imported directly into ``config.yaml`` the caller may also
    ask to remove the proxy blocks that were created from that subscription. If
    ``config_text`` is provided, the patched text is returned without writing to
    disk so the open editor can stay the source of truth.
    """
    with _STATE_LOCK:
        state = load_subscription_state(ui_state_dir)
        sub_idx, sub = _find_subscription(state, sub_id)
        if sub_idx < 0 or sub is None:
            raise KeyError("subscription not found")

        entry = dict(sub)
        removed_config_blocks = False
        changed = False
        patched_content: str | None = None

        if remove_config_blocks:
            if str(entry.get("source") or "generator") != "config":
                raise RuntimeError("remove_config_blocks_supported_only_for_config_source")

            old_names = _clean_string_list(entry.get("proxy_names"))
            if not old_names:
                old_names = _extract_proxy_names_from_yaml(entry.get("managed_yaml") or "")
            if not old_names:
                raise RuntimeError("managed_proxy_not_found")

            if config_text is not None:
                active_text = str(config_text or "")
                should_write = False
            else:
                if not mihomo_config_file:
                    raise ValueError("mihomo_config_file is required")
                active_text = load_text(mihomo_config_file, default="") or ""
                should_write = True

            if entry.get("provider_name"):
                from services.mihomo_subscription_providers import remove_provider

                patched = remove_provider(active_text, entry["provider_name"])
            else:
                patched = _remove_group_references(active_text, old_names)
                patched = _remove_proxy_blocks(patched, old_names)
            patched_content = patched.rstrip("\n")
            changed = _hash_text(patched_content) != _hash_text(active_text)
            removed_config_blocks = True

            if should_write and changed:
                if save_callback is not None:
                    save_callback(patched_content)
                else:
                    _atomic_write_text(str(mihomo_config_file), patched_content + "\n")

            state["last_config_hash"] = _hash_text(patched_content)
            state["last_synced_ts"] = _now()

        generator_state = state.get("generator_state")
        if isinstance(generator_state, dict):
            proxy_index = _find_proxy_index_for_subscription(generator_state, entry)
            proxies = generator_state.get("proxies")
            if proxy_index >= 0 and isinstance(proxies, list) and proxy_index < len(proxies):
                proxy = proxies[proxy_index]
                if isinstance(proxy, dict):
                    proxy.pop("xray_json_subscription", None)
                    proxy.pop("xrayJsonSubscription", None)
                    proxy.pop("xraySubscription", None)

        state["subscriptions"] = [
            copy.deepcopy(item)
            for idx, item in enumerate(state.get("subscriptions") or [])
            if idx != sub_idx
        ]
        _write_state(ui_state_dir, state)

        result: Dict[str, Any] = {
            "ok": True,
            "id": entry.get("id"),
            "removed": True,
            "removed_config_blocks": removed_config_blocks,
            "changed": bool(changed),
            "subscription": copy.deepcopy(entry),
        }
        if patched_content is not None:
            result["content"] = patched_content
        return result


def _extract_meta(proxy: Dict[str, Any]) -> Dict[str, Any] | None:
    for key in ("xray_json_subscription", "xrayJsonSubscription", "xraySubscription"):
        value = proxy.get(key)
        if isinstance(value, dict):
            return value
    return None


def _normalise_proxy_meta(
    proxy: Dict[str, Any],
    *,
    index: int,
    previous: Dict[str, Any] | None = None,
    used_ids: set[str] | None = None,
) -> Dict[str, Any] | None:
    meta = _extract_meta(proxy)
    if not isinstance(meta, dict):
        return None

    url = str(meta.get("url") or meta.get("source_url") or meta.get("sourceUrl") or "").strip()
    if not url:
        return None

    tags = _clean_string_list(proxy.get("tags"))
    tag = str(meta.get("tag") or "").strip()
    if not tag:
        tag = next((t for t in tags if t.startswith("xray-sub:")), "") or _derive_tag_from_url(url)

    wanted_id = _clean_id(meta.get("id") or (previous or {}).get("id") or _entry_id_from_url(url, tag))
    used_ids = used_ids if used_ids is not None else set()
    sub_id = wanted_id
    suffix = 2
    while sub_id in used_ids:
        sub_id = _clean_id(f"{wanted_id}-{suffix}")
        suffix += 1
    used_ids.add(sub_id)

    interval = _clamp_interval(
        meta.get("interval_hours", meta.get("intervalHours", (previous or {}).get("interval_hours")))
    )

    return {
        "id": sub_id,
        "url": url,
        "tag": tag,
        "enabled": bool(meta.get("enabled", (previous or {}).get("enabled", True))),
        "interval_hours": interval,
        "proxy_index": index,
    }


def _entry_from_proxy_meta(
    proxy: Dict[str, Any],
    meta: Dict[str, Any],
    *,
    previous: Dict[str, Any] | None = None,
    now_ts: float,
) -> Dict[str, Any]:
    prev = dict(previous or {})
    changed_schedule = (
        str(prev.get("url") or "") != str(meta.get("url") or "")
        or int(prev.get("interval_hours") or 0) != int(meta.get("interval_hours") or 0)
        or bool(prev.get("enabled", True)) != bool(meta.get("enabled", True))
    )

    entry = {
        **prev,
        "id": meta["id"],
        "url": meta["url"],
        "source": "generator",
        "tag": meta["tag"],
        "enabled": bool(meta.get("enabled", True)),
        "interval_hours": int(meta.get("interval_hours") or DEFAULT_INTERVAL_HOURS),
        "proxy_index": int(meta.get("proxy_index") or 0),
        "groups": _clean_string_list(proxy.get("groups")),
        "updated_from_generator_ts": now_ts,
    }
    entry.setdefault("created_ts", now_ts)

    if not entry["enabled"]:
        entry["next_update_ts"] = None
    elif changed_schedule or entry.get("next_update_ts") in (None, ""):
        entry["next_update_ts"] = now_ts + entry["interval_hours"] * 3600

    return entry


def sync_from_generator_state(
    ui_state_dir: str,
    generator_state: Dict[str, Any],
    *,
    config_text: str | None = None,
) -> Dict[str, Any]:
    """Persist the generator state and managed Xray-JSON subscription metadata."""
    with _STATE_LOCK:
        previous_state = load_subscription_state(ui_state_dir)
        previous_by_id = {
            str(item.get("id") or ""): item
            for item in previous_state.get("subscriptions") or []
            if isinstance(item, dict)
        }
        now_ts = _now()
        state_copy = copy.deepcopy(generator_state if isinstance(generator_state, dict) else {})
        proxies = state_copy.get("proxies")
        if not isinstance(proxies, list):
            proxies = []
            state_copy["proxies"] = proxies

        used_ids: set[str] = set()
        entries: List[Dict[str, Any]] = []
        for idx, proxy in enumerate(proxies):
            if not isinstance(proxy, dict):
                continue
            previous = None
            existing_meta = _extract_meta(proxy)
            if isinstance(existing_meta, dict) and existing_meta.get("id"):
                previous = previous_by_id.get(_clean_id(existing_meta.get("id")))

            meta = _normalise_proxy_meta(proxy, index=idx, previous=previous, used_ids=used_ids)
            if not meta:
                continue
            if previous is None:
                previous = previous_by_id.get(meta["id"])

            tags = _clean_string_list(proxy.get("tags"))
            if meta["tag"] and meta["tag"] not in tags:
                tags.append(meta["tag"])
                proxy["tags"] = tags

            proxy["xray_json_subscription"] = dict(meta)
            proxy.pop("xrayJsonSubscription", None)
            proxy.pop("xraySubscription", None)
            entries.append(_entry_from_proxy_meta(proxy, meta, previous=previous, now_ts=now_ts))
            if config_text is not None:
                entry = entries[-1]
                if entry.get("provider_name") and entry["provider_name"] not in config_text:
                    entry.pop("provider_name", None)
                    entry.pop("pending_apply", None)
                block = str(proxy.get("yaml") or "")
                if _hash_text(block) != entry.get("last_hash"):
                    entry.pop("http_validators", None)
                entry["managed_yaml"] = block
                entry["proxy_names"] = _extract_proxy_names_from_yaml(block)

        generator_ids = {str(item.get("id") or "") for item in entries if isinstance(item, dict)}
        preserved_entries = [
            copy.deepcopy(item)
            for item in previous_state.get("subscriptions") or []
            if isinstance(item, dict)
            and str(item.get("source") or "generator") != "generator"
            and str(item.get("id") or "") not in generator_ids
        ]

        out_state = {
            "version": STATE_VERSION,
            "subscriptions": entries + preserved_entries,
            "generator_state": state_copy,
            "last_config_hash": previous_state.get("last_config_hash") or "",
            "last_synced_ts": now_ts,
        }
        if config_text is not None:
            out_state["last_config_hash"] = _hash_text(config_text)

        _write_state(ui_state_dir, out_state)
        return copy.deepcopy(out_state)


def sync_imported_xray_subscription(
    ui_state_dir: str,
    *,
    url: str,
    config_text: str,
    proxy_yamls: Sequence[Any],
    groups: Sequence[Any] | None = None,
    interval_hours: Any = DEFAULT_INTERVAL_HOURS,
    tag: str | None = None,
    refresh_parser: Any = REFRESH_PARSER_XRAY_JSON,
    connection_options: Any = None,
) -> Dict[str, Any]:
    """Persist a parsed subscription inserted directly into config.yaml.

    The Mihomo panel import modal patches raw YAML instead of saving generator
    state.  These entries keep enough source metadata to refresh only the
    inserted proxy blocks inside the active config.
    """
    clean_url = str(url or "").strip()
    if not clean_url:
        raise ValueError("url is required")

    options = _clean_connection_options(connection_options)
    blocks = _apply_connection_options_to_blocks(proxy_yamls or [], options)
    if not blocks:
        raise ValueError("proxy_yamls is required")

    parser = _clean_refresh_parser(refresh_parser)
    fallback_tag = (
        "mihomo-provider:" + (urlparse(clean_url).hostname or "provider")
        if parser == REFRESH_PARSER_MIHOMO_PROVIDER
        else _derive_tag_from_url(clean_url)
    )
    clean_tag = str(tag or fallback_tag).strip() or "xray-sub"
    sub_id = _entry_id_from_url(clean_url, clean_tag)
    proxy_names = _extract_proxy_names_from_yaml("\n\n".join(blocks))
    if not proxy_names:
        raise ValueError("proxy_names is required")

    with _STATE_LOCK:
        state = load_subscription_state(ui_state_dir)
        previous_by_id = {
            str(item.get("id") or ""): item
            for item in state.get("subscriptions") or []
            if isinstance(item, dict)
        }
        prev = dict(previous_by_id.get(sub_id) or {})
        now_ts = _now()
        interval = _clamp_interval(interval_hours)
        enabled = bool(prev.get("enabled", True))
        schedule_changed = int(prev.get("interval_hours") or 0) != interval or bool(prev.get("enabled", True)) != enabled

        entry = {
            **prev,
            "id": sub_id,
            "url": clean_url,
            "source": "config",
            "tag": clean_tag,
            "refresh_parser": parser,
            "enabled": enabled,
            "interval_hours": interval,
            "groups": _clean_string_list(groups or prev.get("groups")),
            "proxy_names": proxy_names,
            "managed_yaml": "\n\n".join(blocks),
            "connection_options": options,
            "updated_from_import_ts": now_ts,
            "last_ok": True,
            "last_error": "",
            "last_count": len(proxy_names),
            "last_hash": _hash_text("\n\n".join(blocks)),
        }
        if prev.get("last_hash") != entry["last_hash"] or prev.get("connection_options") != options:
            entry.pop("http_validators", None)
        if entry.get("provider_name") and entry["provider_name"] not in config_text:
            entry.pop("provider_name", None)
            entry.pop("pending_apply", None)
        entry.setdefault("created_ts", now_ts)
        if not enabled:
            entry["next_update_ts"] = None
        elif schedule_changed or entry.get("next_update_ts") in (None, ""):
            entry["next_update_ts"] = now_ts + interval * 3600

        state["subscriptions"] = [
            copy.deepcopy(item)
            for item in state.get("subscriptions") or []
            if isinstance(item, dict) and str(item.get("id") or "") != sub_id
        ] + [entry]
        state["last_config_hash"] = _hash_text(config_text)
        state["last_synced_ts"] = now_ts
        _write_state(ui_state_dir, state)
        return copy.deepcopy(entry)


def _find_subscription(state: Dict[str, Any], sub_id: str) -> Tuple[int, Dict[str, Any] | None]:
    wanted = _clean_id(sub_id)
    for idx, item in enumerate(state.get("subscriptions") or []):
        if isinstance(item, dict) and _clean_id(item.get("id")) == wanted:
            return idx, item
    return -1, None


def _find_proxy_index_for_subscription(generator_state: Dict[str, Any], sub: Dict[str, Any]) -> int:
    proxies = generator_state.get("proxies")
    if not isinstance(proxies, list):
        return -1

    candidates: List[int] = []
    try:
        proxy_index = int(sub.get("proxy_index"))
        candidates.append(proxy_index)
    except Exception:
        pass
    candidates.extend(range(len(proxies)))

    seen: set[int] = set()
    for idx in candidates:
        if idx in seen or idx < 0 or idx >= len(proxies):
            continue
        seen.add(idx)
        proxy = proxies[idx]
        if not isinstance(proxy, dict):
            continue
        meta = _extract_meta(proxy) or {}
        if _clean_id(meta.get("id")) == _clean_id(sub.get("id")):
            return idx
        if str(meta.get("url") or "").strip() and str(meta.get("url") or "").strip() == str(sub.get("url") or "").strip():
            return idx
    return -1


def _extract_proxy_names_from_yaml(yaml_text: Any) -> List[str]:
    names: List[str] = []
    for match in re.finditer(r"(?m)^\s*-\s*name\s*:\s*([^\n#]+)", str(yaml_text or "")):
        value = match.group(1).strip().strip('"').strip("'")
        if value:
            names.append(value)
    return names


def _provider_proxy_blocks_from_payload(payload: Any, *, max_count: int = 256) -> List[str]:
    text = str(payload or "").replace("\r\n", "\n").replace("\r", "\n")
    lines = text.splitlines()
    section_start = -1
    section_indent = 0
    for idx, line in enumerate(lines):
        stripped = line.lstrip()
        if not stripped or stripped.startswith("#"):
            continue
        indent = len(line) - len(stripped)
        if re.match(r"^proxies\s*:\s*(?:#.*)?$", stripped):
            section_start = idx + 1
            section_indent = indent
            break

    section = lines[section_start:] if section_start >= 0 else lines
    if section_start >= 0:
        clipped: List[str] = []
        for line in section:
            stripped = line.lstrip()
            indent = len(line) - len(stripped)
            if stripped and not stripped.startswith("#") and indent <= section_indent:
                break
            clipped.append(line)
        section = clipped

    starts: List[int] = []
    item_indent: int | None = None
    for idx, line in enumerate(section):
        m = re.match(r"^(\s*)-\s*name\s*:", line)
        if not m:
            continue
        indent = len(m.group(1))
        if item_indent is None:
            item_indent = indent
        if indent == item_indent:
            starts.append(idx)

    if not starts or item_indent is None:
        return []

    blocks: List[str] = []
    for pos, start in enumerate(starts[:max_count]):
        end = starts[pos + 1] if pos + 1 < len(starts) else len(section)
        normalized: List[str] = []
        for line in section[start:end]:
            if len(line) >= item_indent and line[:item_indent].strip() == "":
                normalized.append(line[item_indent:])
            else:
                normalized.append(line)
        while normalized and not normalized[-1].strip():
            normalized.pop()
        block = "\n".join(normalized).strip()
        if block and _extract_proxy_names_from_yaml(block):
            blocks.append(block)
    return blocks


def _fetch_mihomo_provider_proxy_blocks(url: str, *, validators=None, metadata=None) -> Tuple[List[str], List[Dict[str, Any]]]:
    from services.mihomo_hwid_sub import fetch_provider_payload, get_device_info

    info = get_device_info()
    headers = info.get("headers") if isinstance(info, dict) else {}
    payload, meta = fetch_provider_payload(str(url or ""), headers=headers if isinstance(headers, dict) else {},
                                         **({"validators": validators} if validators else {}))
    if metadata is not None:
        metadata.update(meta)
    if meta.get("not_modified"):
        return [], []
    blocks = _provider_proxy_blocks_from_payload(payload)
    skipped: List[Dict[str, Any]] = []
    if isinstance(meta, dict) and meta.get("skipped_count"):
        skipped.append({"name": "provider", "reason": f"skipped_count: {meta.get('skipped_count')}"})
    return blocks, skipped


def _existing_names_for_refresh(generator_state: Dict[str, Any], *, skip_index: int) -> List[str]:
    proxies = generator_state.get("proxies")
    if not isinstance(proxies, list):
        return []
    names: List[str] = []
    seen: set[str] = set()
    for idx, proxy in enumerate(proxies):
        if idx == skip_index or not isinstance(proxy, dict):
            continue
        if str(proxy.get("name") or "").strip():
            names.append(str(proxy.get("name")).strip())
        if str(proxy.get("kind") or "").lower() == "yaml":
            names.extend(_extract_proxy_names_from_yaml(proxy.get("yaml")))
    out: List[str] = []
    for name in names:
        if name in seen:
            continue
        seen.add(name)
        out.append(name)
    return out


def _format_proxy_yaml_blocks(proxies: Any) -> str:
    blocks: List[str] = []
    for proxy in proxies or []:
        text = str(getattr(proxy, "yaml", "") or "").strip()
        if text:
            blocks.append(text)
    return "\n\n".join(blocks)


def _normalise_proxy_block_name(raw: Any) -> str:
    value = str(raw or "").strip()
    if not value:
        return ""
    value = re.sub(r"\s+#.*$", "", value).strip()
    if len(value) >= 2 and ((value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'"))):
        value = value[1:-1]
    return value.replace("''", "'").strip()


def _all_proxy_names_from_config(config_text: str) -> List[str]:
    return _extract_proxy_names_from_yaml(config_text)


def _remove_group_references(content: str, proxy_names: Sequence[str]) -> str:
    targets = {str(name or "").strip() for name in proxy_names if str(name or "").strip()}
    if not targets:
        return content

    def _inline_item_name(raw: str) -> str:
        return _normalise_proxy_block_name(raw)

    def _filter_inline(line: str) -> str:
        match = re.match(r"^(\s*proxies\s*:\s*\[)(.*?)(\]\s*(#.*)?)$", line)
        if not match:
            return line
        inner = (match.group(2) or "").strip()
        if not inner:
            return line
        items = [item.strip() for item in inner.split(",")]
        kept = [item for item in items if _inline_item_name(item) not in targets]
        if len(kept) == len(items):
            return line
        return f"{match.group(1)}{', '.join(kept)}{match.group(3)}"

    lines = str(content or "").replace("\r\n", "\n").replace("\r", "\n").splitlines()
    out: List[str] = []
    in_groups = False
    in_group_proxies = False
    proxies_indent = -1

    for line in lines:
        stripped = line.lstrip()
        indent = len(line) - len(stripped)

        if indent == 0 and stripped.startswith("proxy-groups:"):
            in_groups = True
            in_group_proxies = False
            proxies_indent = -1
            out.append(line)
            continue

        if in_groups and indent == 0 and stripped and not stripped.startswith("#"):
            in_groups = False
            in_group_proxies = False
            proxies_indent = -1

        if in_groups and in_group_proxies and stripped and not stripped.startswith("#") and indent <= proxies_indent:
            in_group_proxies = False
            proxies_indent = -1

        if in_groups and stripped.startswith("proxies:"):
            if "[" in stripped and "]" in stripped:
                out.append(_filter_inline(line))
            else:
                in_group_proxies = True
                proxies_indent = indent
                out.append(line)
            continue

        if in_groups and in_group_proxies:
            match = re.match(r"^(\s*)-\s*(.+?)\s*$", line)
            if match and len(match.group(1)) > proxies_indent:
                if _normalise_proxy_block_name(match.group(2)) in targets:
                    continue

        out.append(line)

    return "\n".join(out) + ("\n" if str(content or "").endswith("\n") else "")


def _remove_proxy_blocks(content: str, proxy_names: Sequence[str]) -> str:
    return _rewrite_proxy_blocks(content, proxy_names)[0]


def _rewrite_proxy_blocks(
    content: str, proxy_names: Sequence[str], replacement_yaml: str = "",
) -> Tuple[str, bool]:
    """Remove managed blocks, placing their replacement at the first old block."""
    targets = {str(name or "").strip() for name in proxy_names if str(name or "").strip()}
    if not targets:
        return content, False

    content_n = str(content or "").replace("\r\n", "\n").replace("\r", "\n")
    had_trailing_newline = content_n.endswith("\n")
    lines = content_n.splitlines()

    proxies_idx = None
    for idx, line in enumerate(lines):
        if re.fullmatch(r"proxies\s*:\s*(?:#.*)?", line):
            proxies_idx = idx
            break
    if proxies_idx is None:
        return content_n, False

    end_idx = len(lines)
    for idx in range(proxies_idx + 1, len(lines)):
        line = lines[idx]
        stripped = line.lstrip()
        if not stripped or stripped.startswith("#"):
            continue
        if (len(line) - len(stripped) == 0) and not stripped.startswith("-"):
            end_idx = idx
            break

    name_line_re = re.compile(r"^(\s*)-\s+name:\s*(.+?)\s*$")
    item_indent_len = None
    for idx in range(proxies_idx + 1, end_idx):
        match = name_line_re.match(lines[idx])
        if match:
            item_indent_len = len(match.group(1))
            break
    if item_indent_len is None:
        return content_n, False

    remove_ranges: List[Tuple[int, int]] = []
    idx = proxies_idx + 1
    while idx < end_idx:
        match = name_line_re.match(lines[idx])
        if not match or len(match.group(1)) != item_indent_len:
            idx += 1
            continue
        block_start = idx
        block_end = end_idx
        for nxt in range(idx + 1, end_idx):
            match2 = name_line_re.match(lines[nxt])
            if match2 and len(match2.group(1)) == item_indent_len:
                block_end = nxt
                break
        if _normalise_proxy_block_name(match.group(2)) in targets:
            remove_ranges.append((block_start, block_end))
        idx = block_end

    if not remove_ranges:
        return content_n, False

    keep = [True] * len(lines)
    insert_at = remove_ranges[0][0]
    for start, end in remove_ranges:
        while not replacement_yaml and start > proxies_idx + 1 and not lines[start - 1].strip():
            start -= 1
        for pos in range(start, end):
            keep[pos] = False

    replacement = [" " * item_indent_len + line for line in replacement_yaml.splitlines()]
    out_lines = []
    for pos, line in enumerate(lines):
        if pos == insert_at:
            out_lines.extend(replacement)
        if keep[pos]:
            out_lines.append(line)
    out = "\n".join(out_lines).rstrip("\n")
    return out + ("\n" if had_trailing_newline else ""), True


def _replace_config_subscription_blocks(
    content: str,
    *,
    old_proxy_names: Sequence[str],
    new_proxy_blocks: Sequence[str],
    groups: Sequence[Any],
) -> str:
    patched = _remove_group_references(content, old_proxy_names)
    blocks = [str(block or "").strip() for block in new_proxy_blocks if str(block or "").strip()]
    patched, replaced = _rewrite_proxy_blocks(patched, old_proxy_names, "\n\n".join(blocks))
    for block_text in blocks:
        names = _extract_proxy_names_from_yaml(block_text)
        proxy_name = names[0] if names else ""
        if proxy_name:
            if replaced:
                patched = insert_proxy_into_groups(patched, proxy_name, groups)
            else:
                patched = apply_proxy_insert(patched, block_text, proxy_name, groups)
    return patched


def _schedule_next(entry: Dict[str, Any], now_ts: float) -> None:
    if not bool(entry.get("enabled", True)):
        entry["next_update_ts"] = None
        return
    entry["next_update_ts"] = now_ts + _clamp_interval(entry.get("interval_hours")) * 3600


def _apply_or_restart(
    mihomo_config_file: str,
    restart_xkeen: RestartCallback | None,
    *,
    source: str,
) -> Dict[str, Any]:
    """Reload with Mihomo/Prizrak, preserving restart for unavailable APIs."""
    from services.mihomo_clash_client import MihomoClashClient, MihomoClashClientError
    from services.mihomo_clash_target import discover_mihomo_clash_target

    discovery = discover_mihomo_clash_target(
        mihomo_config_file, os.path.dirname(os.path.abspath(mihomo_config_file)),
    )
    reason = "controller_unavailable"
    if discovery.target is not None:
        try:
            MihomoClashClient(discovery.target).reload_config_file(os.path.abspath(mihomo_config_file))
            from services.mihomo_clash_cache import invalidate_shared_mihomo_cache

            try:
                invalidate_shared_mihomo_cache(namespaces={"status", "groups", "providers", "rules", "dns"})
            except Exception:
                pass  # A cache failure cannot undo a successful core apply.
            return {"restarted": False, "hot_applied": True, "apply_method": "mihomo-api"}
        except MihomoClashClientError as exc:
            # A parse rejection leaves the old runtime intact. Never
            # restart into a config the running core has just rejected.
            if exc.upstream_status in {400, 422} or exc.code == "config_payload_invalid":
                raise RuntimeError("mihomo_config_rejected") from exc
            reason = exc.code
    if restart_xkeen is None:
        raise RuntimeError("mihomo_apply_unavailable")
    try:
        try:
            restarted = restart_xkeen(source=source)
        except TypeError:
            restarted = restart_xkeen(source)
        if restarted is False:
            raise RuntimeError("mihomo_restart_failed")
    except Exception as exc:
        raise RuntimeError("mihomo_restart_failed") from exc
    return {
        "restarted": True, "hot_applied": False, "apply_method": "restart",
        "hot_apply_fallback": True, "hot_apply_reason": reason,
    }


def _mark_failed(
    ui_state_dir: str,
    state: Dict[str, Any],
    sub_idx: int,
    entry: Dict[str, Any],
    error: str,
    *,
    now_ts: float,
    persist: bool = True,
) -> Dict[str, Any]:
    entry = dict(entry)
    entry["last_ok"] = False
    entry["last_error"] = str(error or "refresh_failed")
    entry["last_update_ts"] = now_ts
    entry["failure_count"] = min(3, int(entry.get("failure_count") or 0) + 1)
    retry = (300, 900, 3600)[entry["failure_count"] - 1]
    entry["last_error_retry_seconds"] = retry
    entry["next_update_ts"] = now_ts + min(retry, _clamp_interval(entry.get("interval_hours")) * 3600) if entry.get("enabled", True) else None
    state["subscriptions"][sub_idx] = entry
    if persist:
        _write_state(ui_state_dir, state)
    return {
        "ok": False,
        "id": entry.get("id"),
        "changed": False,
        "restarted": False,
        "hot_applied": False,
        "error": entry["last_error"],
        "next_update_ts": entry.get("next_update_ts"),
    }


def _prepare_subscription(state, sub, active_text, *, config_file, migrate):
    from services import mihomo_subscription_providers as providers

    entry = copy.deepcopy(sub)
    generator = state.get('generator_state') or {}
    index = _find_proxy_index_for_subscription(generator, sub)
    is_generator = sub.get('source', 'generator') == 'generator'
    if is_generator and index < 0:
        raise RuntimeError('managed_proxy_not_found')
    old_yaml = str(sub.get('managed_yaml') or '')
    if not old_yaml and is_generator:
        old_yaml = str(generator['proxies'][index].get('yaml') or '')
    old_names = _clean_string_list(sub.get('proxy_names')) or _extract_proxy_names_from_yaml(old_yaml)
    if not old_names:
        raise RuntimeError('managed_proxy_not_found')
    parser = _clean_refresh_parser(sub.get('refresh_parser'))
    validators = dict(sub.get('http_validators') or {})
    if validators.get('url') != sub.get('url') or not validators.get('request_key') or not (validators.get('etag') or validators.get('last_modified')):
        validators = {}
    meta, headers = {}, {}
    if parser == REFRESH_PARSER_MIHOMO_PROVIDER:
        blocks, skipped = _fetch_mihomo_provider_proxy_blocks(sub['url'], validators=validators, metadata=meta)
    else:
        body, headers, meta = _fetch_xray_subscription_body(sub['url'], **({'validators': validators} if validators else {}))
        if meta.get('not_modified') or headers.get('x-xkeen-not-modified') == '1':
            blocks, skipped = [], []
        else:
            existing = [name for name in _all_proxy_names_from_config(active_text) if name not in set(old_names)]
            for other in state.get('subscriptions', []):
                if other.get('id') != sub['id']:
                    existing.extend(other.get('proxy_names') or [])
            parsed, skipped, _ = convert_subscription_source_text(body, existing_names=existing)
            blocks = [str(proxy.yaml).strip() for proxy in parsed]
    not_modified = bool(meta.get('not_modified') or headers.get('x-xkeen-not-modified') == '1')
    if not_modified:
        if not old_yaml:
            raise RuntimeError('subscription_cache_missing')
        entry['http_validators'] = {**validators, **{k: v for k, v in meta.get('validators', {}).items() if v}}
        blocks = _provider_proxy_blocks_from_payload(providers.provider_payload([old_yaml]))
        skipped = []
    else:
        if not blocks:
            raise RuntimeError('no_supported_proxies')
        blocks = _apply_connection_options_to_blocks(blocks, sub.get('connection_options'))
        incoming = meta.get('validators') or {
            'etag': headers.get('etag', ''), 'last_modified': headers.get('last-modified', ''),
            'request_key': headers.get('x-xkeen-request-key', ''),
        }
        entry['http_validators'] = {**incoming, 'url': sub['url']}
    names = _extract_proxy_names_from_yaml('\n\n'.join(blocks))
    name, cache_path = providers.provider_identity(config_file, sub['id'])
    migrated = False
    native = bool(sub.get('provider_name'))
    if native:
        if sub['provider_name'] != name:
            raise RuntimeError('managed_provider_identity_changed')
        patched = providers.check_provider(active_text, name, cache_path)
    else:
        patched = active_text
        if migrate:
            migrated_text = providers.migrate_config(active_text, old_names, name, cache_path)
            if migrated_text is not None:
                patched, native, migrated = migrated_text, True, True
        if not native:
            if is_generator:
                proxy = generator['proxies'][index]
                proxy['kind'] = 'yaml'
                proxy['yaml'] = '\n\n'.join(blocks)
                try:
                    import yaml
                except ImportError:
                    patched = build_full_config(generator).rstrip('\n')
                else:
                    groups = [group['name'] for group in (yaml.safe_load(active_text).get('proxy-groups') or [])
                              if set(old_names).intersection(group.get('proxies') or [])]
                    patched = _replace_config_subscription_blocks(active_text, old_proxy_names=old_names,
                        new_proxy_blocks=blocks, groups=groups).rstrip('\n')
            else:
                patched = _replace_config_subscription_blocks(active_text, old_proxy_names=old_names,
                    new_proxy_blocks=blocks, groups=_clean_string_list(sub.get('groups'))).rstrip('\n')
    if native:
        entry['provider_name'] = name
    if is_generator:
        generator['proxies'][index]['yaml'] = '\n\n'.join(blocks)
    entry.update(managed_yaml='\n\n'.join(blocks), proxy_names=names,
                 last_count=len(names), last_skipped_count=len(skipped), refresh_parser=parser,
                 last_hash=_hash_text('\n\n'.join(blocks)))
    payload = providers.provider_payload(blocks) if native else None
    cache_changed = native and (not cache_path.exists() or _hash_text(cache_path.read_text(encoding='utf-8')) != _hash_text(payload))
    changed = bool(migrated or cache_changed or _hash_text(patched) != _hash_text(active_text))
    result = {'ok': True, 'id': sub['id'], 'count': len(names), 'skipped': skipped,
              'changed': changed, 'restarted': False, 'hot_applied': False, 'not_modified': not_modified}
    return {'entry': entry, 'content': patched, 'cache_path': cache_path if native else None,
            'payload': payload, 'cache_changed': cache_changed, 'migrated': migrated, 'result': result}


def _refresh_many(ui_state_dir, ids, *, mihomo_config_file, restart_xkeen, restart, force=False, save_callback=None):
    from services.mihomo_clash_client import MihomoClashClient
    from services.mihomo_clash_target import discover_mihomo_clash_target

    with _STATE_LOCK:
        previous = load_subscription_state(ui_state_dir)
        state = copy.deepcopy(previous)
        original = load_text(mihomo_config_file, default='') or ''
        content = original
        now_ts = _now()
        active_apply = bool(restart and restart_xkeen is not None)
        client = None
        if active_apply:
            discovery = discover_mihomo_clash_target(mihomo_config_file, os.path.dirname(os.path.abspath(mihomo_config_file)))
            if discovery.target is not None:
                try:
                    probe = MihomoClashClient(discovery.target)
                    probe.request_json('providers_proxies')
                    client = probe
                except Exception:
                    pass  # Existing static configs retain their reload/restart path.
        prepared, results = [], []
        # Move tail members first so each provider keeps its position relative
        # to other subscriptions in fallback/select groups.
        for sub_id in reversed(ids):
            idx, sub = _find_subscription(state, sub_id)
            if sub is None:
                raise KeyError('subscription not found')
            try:
                expected = previous.get('last_config_hash')
                rebasing = bool(expected and _hash_text(original) != expected and not force and not sub.get('provider_name'))
                if rebasing:
                    from services.mihomo_subscription_providers import owned_nodes_unchanged
                    if client is None or sub.get('source') != 'config' or not owned_nodes_unchanged(original, sub.get('managed_yaml') or ''):
                        raise RuntimeError('active_config_changed')
                candidate_state = copy.deepcopy(state)
                item = _prepare_subscription(candidate_state, sub, content, config_file=mihomo_config_file, migrate=client is not None)
                if rebasing and not item['entry'].get('provider_name'):
                    raise RuntimeError('active_config_changed')
                state = candidate_state
                content = item['content']
                entry = item['entry']
                entry.update(last_ok=True, last_error='', last_update_ts=now_ts, last_success_ts=now_ts,
                             last_changed=item['result']['changed'], failure_count=0)
                entry.pop('last_error_retry_seconds', None)
                _schedule_next(entry, now_ts)
                state['subscriptions'][idx] = entry
                item['result']['next_update_ts'] = entry.get('next_update_ts')
                prepared.append(item)
                results.append(item['result'])
            except Exception as exc:
                results.append(_mark_failed(ui_state_dir, state, idx, sub, str(exc), now_ts=now_ts, persist=False))
        config_changed = _hash_text(content) != _hash_text(original)
        changed_files = [item for item in prepared if item['cache_changed']]
        pending = [item for item in prepared if item['entry'].get('pending_apply')]
        snapshots, updated = {}, []
        attempted_reload = False
        wrote_config = False
        try:
            for item in changed_files:
                path = item['cache_path']
                snapshots[path] = path.read_text(encoding='utf-8') if path.exists() else None
            # One save creates one backup, including provider snapshots, before
            # any cache is overwritten. Provider-only updates do not reload YAML.
            if config_changed or changed_files:
                if _hash_text(load_text(mihomo_config_file, default='') or '') != _hash_text(original):
                    raise RuntimeError('active_config_changed')
                wrote_config = True
                if save_callback is not None:
                    from services.mihomo_runtime import save_config
                    if save_callback is save_config:
                        save_callback(content, provider_updates={str(item['cache_path']): item['payload'] for item in changed_files})
                    else:
                        save_callback(content)
                elif config_changed:
                    _atomic_write_text(os.path.realpath(mihomo_config_file), content + '\n')
            for item in changed_files:
                path = item['cache_path']
                if path.exists() and path.read_text(encoding='utf-8') == item['payload']:
                    continue
                path.parent.mkdir(parents=True, exist_ok=True)
                _atomic_write_text(str(path), item['payload'])
            if active_apply and (config_changed or any(not item['entry'].get('provider_name') for item in pending)):
                attempted_reload = True
                applied = _apply_or_restart(mihomo_config_file, restart_xkeen, source='mihomo-subscriptions-batch' if len(ids) > 1 else 'mihomo-subscription-refresh')
                for item in prepared:
                    if item['result']['changed'] or item in pending:
                        item['result'].update(applied)
                        item['entry'].pop('pending_apply', None)
            elif active_apply:
                for item in changed_files + [p for p in pending if p not in changed_files]:
                    if client is None:
                        raise RuntimeError('mihomo_provider_api_unavailable')
                    updated.append(item)
                    client.update_provider('proxy', item['entry']['provider_name'])
                    item['result'].update(hot_applied=True, apply_method='mihomo-provider')
                    item['entry'].pop('pending_apply', None)
            elif config_changed or changed_files:
                for item in prepared:
                    if item['result']['changed']:
                        item['entry']['pending_apply'] = True
            state['last_config_hash'] = _hash_text(content)
            state['last_synced_ts'] = now_ts
            _write_state(ui_state_dir, state)
        except Exception as exc:
            for path, text in snapshots.items():
                if text is None:
                    path.unlink(missing_ok=True)
                else:
                    _atomic_write_text(str(path), text)
            if config_changed and wrote_config:
                _atomic_write_text(os.path.realpath(mihomo_config_file), original)
            recovery_failed = False
            if client is not None:
                try:
                    if attempted_reload and str(exc) != 'mihomo_config_rejected':
                        client.reload_config(original)
                    for item in updated:
                        client.update_provider('proxy', item['entry']['provider_name'])
                except Exception:
                    recovery_failed = True
            state = copy.deepcopy(previous)
            for result in results:
                idx, sub = _find_subscription(state, result['id'])
                error = str(exc) if result.get('ok') else result.get('error', 'refresh_failed')
                result.update(_mark_failed(ui_state_dir, state, idx, sub, error, now_ts=now_ts, persist=False))
                if recovery_failed:
                    result['recovery_failed'] = True
            _write_state(ui_state_dir, state)
        else:
            try:
                from services.mihomo_clash_cache import invalidate_shared_mihomo_cache
                invalidate_shared_mihomo_cache(namespaces={'status', 'groups', 'providers', 'rules', 'yaml'})
            except Exception:
                pass
            for item in prepared:
                if item['entry'].get('source') == 'generator':
                    item['result']['generator_state'] = copy.deepcopy(state.get('generator_state') or {})
        order = {sub_id: index for index, sub_id in enumerate(ids)}
        return sorted(results, key=lambda result: order[result['id']])


def refresh_subscription(ui_state_dir: str, sub_id: str, *, mihomo_config_file: str,
                         restart_xkeen: RestartCallback | None = None, restart: bool = True,
                         force: bool = False, save_callback: SaveCallback | None = None) -> Dict[str, Any]:
    return _refresh_many(ui_state_dir, [sub_id], mihomo_config_file=mihomo_config_file,
                         restart_xkeen=restart_xkeen, restart=restart, force=force,
                         save_callback=save_callback)[0]


def _refresh_lookahead_seconds() -> int:
    """Window used to pull almost-due subscriptions into the current batch.

    Subscriptions added at slightly different moments drift apart and become
    due in different scheduler ticks, which used to cost one core restart
    each. Refreshing the ones that would fire within the window together
    realigns their ``next_update_ts`` from a single instant, so afterwards
    they keep landing in the same batch on their own.
    """

    try:
        raw = int(
            os.environ.get(
                "XKEEN_MIHOMO_SUBSCRIPTIONS_LOOKAHEAD_SEC",
                str(DEFAULT_REFRESH_LOOKAHEAD_SECONDS),
            )
            or DEFAULT_REFRESH_LOOKAHEAD_SECONDS
        )
    except Exception:
        raw = DEFAULT_REFRESH_LOOKAHEAD_SECONDS
    return max(0, min(MAX_REFRESH_LOOKAHEAD_SECONDS, raw))


def plan_schedule_alignment(ui_state_dir: str) -> Dict[str, Any]:
    """Посчитать общий срок обновления, не трогая состояние."""
    return plan_alignment(list_subscriptions(ui_state_dir), now_ts=_now())


def apply_schedule_alignment(ui_state_dir: str) -> Dict[str, Any]:
    """Свести сроки обновления к одному моменту.

    Подписки не скачиваются, конфиг не переписывается и ядро не
    перезапускается: меняется только ``next_update_ts``. Состояние пишется
    целиком — рядом со списком в нём лежат ``generator_state`` и хеш
    последнего конфига, и собирать словарь заново значит их потерять.
    """
    with _STATE_LOCK:
        state = load_subscription_state(ui_state_dir)
        subs = state.get("subscriptions")
        if not isinstance(subs, list):
            subs = []
        plan = plan_alignment(subs, now_ts=_now())
        if not plan["moves"]:
            return plan

        anchor = plan["anchor_ts"]
        targets = {str(move["id"]) for move in plan["moves"]}
        for sub in subs:
            if isinstance(sub, dict) and str(sub.get("id") or "") in targets:
                sub["next_update_ts"] = anchor
        _write_state(ui_state_dir, state)

    return plan


def refresh_due_subscriptions(
    ui_state_dir: str,
    *,
    mihomo_config_file: str,
    restart_xkeen: RestartCallback | None = None,
    restart: bool = True,
    save_callback: SaveCallback | None = None,
) -> List[Dict[str, Any]]:
    with _STATE_LOCK:
        state = load_subscription_state(ui_state_dir)
        now_ts = _now()
        lookahead = _refresh_lookahead_seconds()

        due_subs: List[Dict[str, Any]] = []
        has_due = False
        for sub in list(state.get("subscriptions") or []):
            if not isinstance(sub, dict) or not bool(sub.get("enabled", True)):
                continue
            try:
                due_ts = float(sub.get("next_update_ts") or 0)
            except Exception:
                due_ts = 0.0
            if due_ts <= now_ts:
                has_due = True
            elif due_ts > now_ts + lookahead:
                continue
            due_subs.append(sub)

        # Never refresh early on its own: the look-ahead only widens a batch that
        # already has at least one genuinely due subscription. Without this guard
        # every tick would keep pulling schedules forward.
        if not has_due:
            return []

        batch = env_flag("XKEEN_MIHOMO_SUBSCRIPTIONS_RESTART_BATCH", True)
        if batch:
            return _refresh_many(ui_state_dir, [sub["id"] for sub in due_subs],
                mihomo_config_file=mihomo_config_file, restart_xkeen=restart_xkeen,
                restart=restart, save_callback=save_callback)
        return [refresh_subscription(ui_state_dir, sub["id"], mihomo_config_file=mihomo_config_file,
                    restart_xkeen=restart_xkeen, restart=restart, save_callback=save_callback)
                for sub in due_subs]


def start_subscription_scheduler(
    ui_state_dir: str,
    *,
    mihomo_config_file: str,
    restart_xkeen: RestartCallback | None = None,
    save_callback: SaveCallback | None = None,
) -> bool:
    global _SCHEDULER_STARTED

    if not env_flag("XKEEN_MIHOMO_SUBSCRIPTIONS_SCHEDULER", True):
        return False

    with _SCHEDULER_LOCK:
        if _SCHEDULER_STARTED:
            return False
        _SCHEDULER_STARTED = True

    try:
        tick = int(os.environ.get("XKEEN_MIHOMO_SUBSCRIPTIONS_SCHEDULER_TICK", "60") or "60")
    except Exception:
        tick = 60
    tick = max(15, min(3600, tick))

    def _loop() -> None:
        time.sleep(min(15, tick))
        while True:
            try:
                results = refresh_due_subscriptions(
                    ui_state_dir,
                    mihomo_config_file=mihomo_config_file,
                    restart_xkeen=restart_xkeen,
                    restart=True,
                    save_callback=save_callback,
                )
                if results:
                    try:
                        from core.logging import core_log_once

                        core_log_once(
                            "info",
                            "mihomo_subscriptions_auto_refresh",
                            "mihomo subscriptions auto-refresh",
                            total=len(results),
                            ok=sum(1 for r in results if r.get("ok")),
                            restarted=any(r.get("restarted") for r in results),
                            hot_applied=any(r.get("hot_applied") for r in results),
                        )
                    except Exception:
                        pass
            except Exception as exc:
                try:
                    from core.logging import core_log_once

                    core_log_once(
                        "warning",
                        "mihomo_subscriptions_scheduler_failed",
                        "mihomo subscriptions scheduler failed",
                        error=str(exc),
                    )
                except Exception:
                    pass
            time.sleep(tick)

    thread = threading.Thread(target=_loop, name="xkeen-mihomo-subscriptions", daemon=True)
    thread.start()
    return True


__all__ = [
    "DEFAULT_INTERVAL_HOURS",
    "STATE_FILENAME",
    "apply_schedule_alignment",
    "delete_subscription",
    "load_subscription_state",
    "list_subscriptions",
    "plan_schedule_alignment",
    "refresh_due_subscriptions",
    "refresh_subscription",
    "start_subscription_scheduler",
    "subscription_state_path",
    "sync_from_generator_state",
    "update_subscription_settings",
]

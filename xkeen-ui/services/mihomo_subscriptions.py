"""Managed Mihomo subscriptions produced from Xray-JSON sources.

Mihomo cannot consume XKeen/Xray JSON subscriptions directly as
``proxy-provider`` entries, so the generator converts them to static proxy YAML.
This service keeps the original URL next to the generated YAML block and can
refresh that block later from the saved generator state.
"""

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
from services.mihomo_proxy_config import apply_proxy_insert
from services.mihomo_xray_json import convert_subscription_source_text, convert_subscription_text
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

_STATE_LOCK = threading.RLock()
_SCHEDULER_LOCK = threading.Lock()
_SCHEDULER_STARTED = False

RestartCallback = Callable[..., Any]
SaveCallback = Callable[[str], Any]


def _fetch_xray_subscription_body(url: str) -> Tuple[str, Dict[str, str], Dict[str, Any]]:
    result = fetch_subscription_body(str(url or ""))
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
) -> Dict[str, Any]:
    """Persist a parsed subscription inserted directly into config.yaml.

    The Mihomo panel import modal patches raw YAML instead of saving generator
    state.  These entries keep enough source metadata to refresh only the
    inserted proxy blocks inside the active config.
    """
    clean_url = str(url or "").strip()
    if not clean_url:
        raise ValueError("url is required")

    blocks = [str(item or "").strip() for item in proxy_yamls or [] if str(item or "").strip()]
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
            "updated_from_import_ts": now_ts,
            "last_ok": True,
            "last_error": "",
            "last_count": len(proxy_names),
            "last_hash": _hash_text("\n\n".join(blocks)),
        }
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


def _fetch_mihomo_provider_proxy_blocks(url: str) -> Tuple[List[str], List[Dict[str, Any]]]:
    from services.mihomo_hwid_sub import fetch_provider_payload, get_device_info

    info = get_device_info()
    headers = info.get("headers") if isinstance(info, dict) else {}
    payload, meta = fetch_provider_payload(str(url or ""), headers=headers if isinstance(headers, dict) else {})
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
    targets = {str(name or "").strip() for name in proxy_names if str(name or "").strip()}
    if not targets:
        return content

    content_n = str(content or "").replace("\r\n", "\n").replace("\r", "\n")
    had_trailing_newline = content_n.endswith("\n")
    lines = content_n.splitlines()

    proxies_idx = None
    for idx, line in enumerate(lines):
        if line.strip() == "proxies:" and (len(line) - len(line.lstrip()) == 0):
            proxies_idx = idx
            break
    if proxies_idx is None:
        return content_n if had_trailing_newline else content_n.rstrip("\n")

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
        return content_n

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
        return content_n

    keep = [True] * len(lines)
    for start, end in remove_ranges:
        while start > proxies_idx + 1 and not lines[start - 1].strip():
            start -= 1
        for pos in range(start, end):
            keep[pos] = False

    out = "\n".join(line for pos, line in enumerate(lines) if keep[pos]).rstrip("\n")
    return out + ("\n" if had_trailing_newline else "")


def _replace_config_subscription_blocks(
    content: str,
    *,
    old_proxy_names: Sequence[str],
    new_proxy_blocks: Sequence[str],
    groups: Sequence[Any],
) -> str:
    patched = _remove_group_references(content, old_proxy_names)
    patched = _remove_proxy_blocks(patched, old_proxy_names)
    for block in new_proxy_blocks:
        block_text = str(block or "").strip()
        if not block_text:
            continue
        names = _extract_proxy_names_from_yaml(block_text)
        proxy_name = names[0] if names else ""
        if proxy_name:
            patched = apply_proxy_insert(patched, block_text, proxy_name, groups)
    return patched


def _schedule_next(entry: Dict[str, Any], now_ts: float) -> None:
    if not bool(entry.get("enabled", True)):
        entry["next_update_ts"] = None
        return
    entry["next_update_ts"] = now_ts + _clamp_interval(entry.get("interval_hours")) * 3600


def _mark_failed(
    ui_state_dir: str,
    state: Dict[str, Any],
    sub_idx: int,
    entry: Dict[str, Any],
    error: str,
    *,
    now_ts: float,
) -> Dict[str, Any]:
    entry = dict(entry)
    entry["last_ok"] = False
    entry["last_error"] = str(error or "refresh_failed")
    entry["last_update_ts"] = now_ts
    _schedule_next(entry, now_ts)
    state["subscriptions"][sub_idx] = entry
    _write_state(ui_state_dir, state)
    return {
        "ok": False,
        "id": entry.get("id"),
        "changed": False,
        "restarted": False,
        "error": entry["last_error"],
        "next_update_ts": entry.get("next_update_ts"),
    }


def _refresh_config_subscription(
    ui_state_dir: str,
    state: Dict[str, Any],
    sub_idx: int,
    sub: Dict[str, Any],
    *,
    active_text: str,
    mihomo_config_file: str,
    restart_xkeen: RestartCallback | None,
    restart: bool,
    save_callback: SaveCallback | None,
    now_ts: float,
) -> Dict[str, Any]:
    try:
        old_names = _clean_string_list(sub.get("proxy_names"))
        if not old_names:
            old_names = _extract_proxy_names_from_yaml(sub.get("managed_yaml") or "")
        if not old_names:
            raise RuntimeError("managed_proxy_not_found")

        old_names_set = set(old_names)
        existing_names = [name for name in _all_proxy_names_from_config(active_text) if name not in old_names_set]
        parser = _clean_refresh_parser(sub.get("refresh_parser") or sub.get("refreshParser"))
        if parser == REFRESH_PARSER_MIHOMO_PROVIDER:
            new_blocks, skipped = _fetch_mihomo_provider_proxy_blocks(str(sub.get("url") or ""))
        else:
            body, _headers, _meta = _fetch_xray_subscription_body(str(sub.get("url") or ""))
            proxies, skipped, _source_format = convert_subscription_source_text(
                body,
                existing_names=existing_names,
            )
            if not proxies:
                raise RuntimeError("no_supported_proxies")
            new_blocks = [str(getattr(proxy, "yaml", "") or "").strip() for proxy in proxies]
        new_blocks = [block for block in new_blocks if block]
        if not new_blocks:
            raise RuntimeError("empty_proxy_yaml")

        new_names = _extract_proxy_names_from_yaml("\n\n".join(new_blocks))
        groups = _clean_string_list(sub.get("groups"))
        patched = _replace_config_subscription_blocks(
            active_text,
            old_proxy_names=old_names,
            new_proxy_blocks=new_blocks,
            groups=groups,
        )
        cfg_to_save = patched.rstrip("\n")
        changed = _hash_text(cfg_to_save) != _hash_text(active_text)
        if changed:
            if save_callback is not None:
                save_callback(cfg_to_save)
            else:
                _atomic_write_text(mihomo_config_file, cfg_to_save + "\n")

            if restart and restart_xkeen is not None:
                try:
                    restart_xkeen(source="mihomo-subscription-refresh")
                except TypeError:
                    restart_xkeen("mihomo-subscription-refresh")

        sub["source"] = "config"
        sub["refresh_parser"] = parser
        sub["groups"] = groups
        sub["proxy_names"] = new_names
        sub["managed_yaml"] = "\n\n".join(new_blocks)
        sub["last_ok"] = True
        sub["last_error"] = ""
        sub["last_update_ts"] = now_ts
        sub["last_count"] = len(new_names)
        sub["last_skipped_count"] = len(skipped)
        sub["last_hash"] = _hash_text(sub["managed_yaml"])
        sub["last_changed"] = bool(changed)
        _schedule_next(sub, now_ts)

        state["last_config_hash"] = _hash_text(cfg_to_save if changed else active_text)
        state["last_synced_ts"] = now_ts
        state["subscriptions"][sub_idx] = sub
        _write_state(ui_state_dir, state)

        return {
            "ok": True,
            "id": sub.get("id"),
            "changed": bool(changed),
            "restarted": bool(changed and restart and restart_xkeen is not None),
            "count": len(new_names),
            "skipped": skipped,
            "next_update_ts": sub.get("next_update_ts"),
        }
    except RuntimeError as exc:
        return _mark_failed(ui_state_dir, state, sub_idx, sub, str(exc), now_ts=now_ts)
    except Exception as exc:
        return _mark_failed(
            ui_state_dir,
            state,
            sub_idx,
            sub,
            f"{type(exc).__name__}: {exc}",
            now_ts=now_ts,
        )


def refresh_subscription(
    ui_state_dir: str,
    sub_id: str,
    *,
    mihomo_config_file: str,
    restart_xkeen: RestartCallback | None = None,
    restart: bool = True,
    force: bool = False,
    save_callback: SaveCallback | None = None,
) -> Dict[str, Any]:
    now_ts = _now()
    with _STATE_LOCK:
        state = load_subscription_state(ui_state_dir)
        sub_idx, sub = _find_subscription(state, sub_id)
        if sub_idx < 0 or sub is None:
            raise KeyError("subscription not found")
        sub = dict(sub)

        active_text = load_text(mihomo_config_file, default="") or ""
        expected_hash = str(state.get("last_config_hash") or "")
        if expected_hash and _hash_text(active_text) != expected_hash and not force:
            return _mark_failed(
                ui_state_dir,
                state,
                sub_idx,
                sub,
                "active_config_changed",
                now_ts=now_ts,
            )

        if str(sub.get("source") or "generator") == "config":
            return _refresh_config_subscription(
                ui_state_dir,
                state,
                sub_idx,
                sub,
                active_text=active_text,
                mihomo_config_file=mihomo_config_file,
                restart_xkeen=restart_xkeen,
                restart=restart,
                save_callback=save_callback,
                now_ts=now_ts,
            )

        generator_state = copy.deepcopy(state.get("generator_state") or {})
        proxy_index = _find_proxy_index_for_subscription(generator_state, sub)
        if proxy_index < 0:
            return _mark_failed(
                ui_state_dir,
                state,
                sub_idx,
                sub,
                "managed_proxy_not_found",
                now_ts=now_ts,
            )

        try:
            body, _headers, _meta = _fetch_xray_subscription_body(str(sub.get("url") or ""))
            proxies, skipped, _source_format = convert_subscription_source_text(
                body,
                existing_names=_existing_names_for_refresh(generator_state, skip_index=proxy_index),
            )
            if not proxies:
                raise RuntimeError("no_supported_proxies")
            proxy_yaml = _format_proxy_yaml_blocks(proxies)
            if not proxy_yaml.strip():
                raise RuntimeError("empty_proxy_yaml")

            proxies_list = generator_state.get("proxies")
            if not isinstance(proxies_list, list):
                raise RuntimeError("generator_state_invalid")
            proxy_item = proxies_list[proxy_index]
            if not isinstance(proxy_item, dict):
                raise RuntimeError("managed_proxy_invalid")

            proxy_item["kind"] = "yaml"
            proxy_item["yaml"] = proxy_yaml
            tags = _clean_string_list(proxy_item.get("tags"))
            tag = str(sub.get("tag") or _derive_tag_from_url(sub.get("url") or "")).strip() or "xray-sub"
            if tag not in tags:
                tags.append(tag)
            proxy_item["tags"] = tags
            proxy_item["xray_json_subscription"] = {
                "id": sub.get("id"),
                "url": sub.get("url"),
                "tag": tag,
                "enabled": bool(sub.get("enabled", True)),
                "interval_hours": _clamp_interval(sub.get("interval_hours")),
                "proxy_index": proxy_index,
            }

            cfg = build_full_config(generator_state)
            cfg_to_save = cfg.rstrip("\n")
            changed = _hash_text(cfg_to_save) != _hash_text(active_text)
            if changed:
                if save_callback is not None:
                    save_callback(cfg_to_save)
                else:
                    _atomic_write_text(mihomo_config_file, cfg_to_save + "\n")

                if restart and restart_xkeen is not None:
                    try:
                        restart_xkeen(source="mihomo-subscription-refresh")
                    except TypeError:
                        restart_xkeen("mihomo-subscription-refresh")

            final_hash = _hash_text(cfg_to_save if changed else active_text)
            sub["proxy_index"] = proxy_index
            sub["last_ok"] = True
            sub["last_error"] = ""
            sub["last_update_ts"] = now_ts
            sub["last_count"] = len(proxies)
            sub["last_skipped_count"] = len(skipped)
            sub["last_hash"] = _hash_text(proxy_yaml)
            sub["last_changed"] = bool(changed)
            _schedule_next(sub, now_ts)

            state["generator_state"] = generator_state
            state["last_config_hash"] = final_hash
            state["last_synced_ts"] = now_ts
            state["subscriptions"][sub_idx] = sub
            _write_state(ui_state_dir, state)

            return {
                "ok": True,
                "id": sub.get("id"),
                "changed": bool(changed),
                "restarted": bool(changed and restart and restart_xkeen is not None),
                "count": len(proxies),
                "skipped": skipped,
                "next_update_ts": sub.get("next_update_ts"),
                "generator_state": copy.deepcopy(generator_state),
            }
        except RuntimeError as exc:
            return _mark_failed(ui_state_dir, state, sub_idx, sub, str(exc), now_ts=now_ts)
        except Exception as exc:
            return _mark_failed(
                ui_state_dir,
                state,
                sub_idx,
                sub,
                f"{type(exc).__name__}: {exc}",
                now_ts=now_ts,
            )


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


def _refresh_result_needs_restart(result: Any) -> bool:
    return bool(isinstance(result, dict) and result.get("ok") and result.get("changed"))


def refresh_due_subscriptions(
    ui_state_dir: str,
    *,
    mihomo_config_file: str,
    restart_xkeen: RestartCallback | None = None,
    restart: bool = True,
    save_callback: SaveCallback | None = None,
) -> List[Dict[str, Any]]:
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

    batch_restart = bool(
        restart and restart_xkeen is not None and env_flag("XKEEN_MIHOMO_SUBSCRIPTIONS_RESTART_BATCH", True)
    )
    item_restart = bool(restart and not batch_restart)

    results: List[Dict[str, Any]] = []
    for sub in due_subs:
        try:
            results.append(
                refresh_subscription(
                    ui_state_dir,
                    str(sub.get("id") or ""),
                    mihomo_config_file=mihomo_config_file,
                    restart_xkeen=restart_xkeen,
                    restart=item_restart,
                    save_callback=save_callback,
                )
            )
        except Exception as exc:
            results.append({"ok": False, "id": sub.get("id"), "error": str(exc)})

    if batch_restart and any(_refresh_result_needs_restart(item) for item in results):
        restarted = False
        try:
            try:
                restart_xkeen(source="mihomo-subscriptions-batch")
            except TypeError:
                restart_xkeen("mihomo-subscriptions-batch")
            restarted = True
        except Exception:
            restarted = False
        for item in results:
            if _refresh_result_needs_restart(item):
                item["restarted"] = restarted

    return results


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
    "delete_subscription",
    "load_subscription_state",
    "list_subscriptions",
    "refresh_due_subscriptions",
    "refresh_subscription",
    "start_subscription_scheduler",
    "subscription_state_path",
    "sync_from_generator_state",
    "update_subscription_settings",
]

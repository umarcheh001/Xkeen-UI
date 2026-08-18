"""Device names for Xray access logs.

The router already exposes Keenetic's registered clients via RCI:
``show device-list`` -> ``http://localhost:79/rci/show/device-list``.
This module keeps a small manual alias layer on top of that list so users can
override or add names without changing the router client list.
"""

from __future__ import annotations

import ipaddress
import json
import os
import time
import urllib.request
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Tuple

from core.paths import UI_STATE_DIR
from services.io.atomic import _atomic_write_json
from services.keenetic_rci import build_rci_request


DEVICE_NAMES_FILENAME = "device-names.json"
RCI_DEVICE_LIST_URL = "http://localhost:79/rci/show/device-list"
DEFAULT_RCI_TIMEOUT = 2.0
MAX_DEVICE_NAME_LEN = 96
MOJIBAKE_MARKERS = ("\u00c3", "\u00c2", "\u00d0", "\u00d1")

DeviceEntry = Dict[str, Any]
DeviceMap = Dict[str, DeviceEntry]
RouterFetcher = Callable[[], Any]


def _now_ts() -> int:
    return int(time.time())


def _state_path(ui_state_dir: Optional[str] = None) -> str:
    root = str(ui_state_dir or UI_STATE_DIR or "/opt/etc/xkeen-ui").strip() or "/opt/etc/xkeen-ui"
    return os.path.join(root, DEVICE_NAMES_FILENAME)


def normalize_ip(value: Any) -> str:
    """Return canonical usable IP address text, or an empty string when invalid."""
    raw = str(value or "").strip()
    if not raw:
        return ""

    if raw.startswith("[") and "]" in raw:
        raw = raw[1 : raw.index("]")]
    elif raw.count(":") == 1 and "." in raw:
        host, maybe_port = raw.rsplit(":", 1)
        if maybe_port.isdigit():
            raw = host

    if "%" in raw:
        raw = raw.split("%", 1)[0].strip()

    try:
        ip = ipaddress.ip_address(raw)
    except Exception:
        return ""
    if ip.is_unspecified:
        return ""
    return str(ip)


def _cyrillic_count(value: str) -> int:
    return sum(1 for ch in value if "\u0400" <= ch <= "\u04ff")


def _c1_control_count(value: str) -> int:
    return sum(1 for ch in value if 0x80 <= ord(ch) <= 0x9F)


def _looks_like_utf8_mojibake(value: str) -> bool:
    return any(marker in value for marker in MOJIBAKE_MARKERS) or _c1_control_count(value) > 0


def _repair_utf8_mojibake(value: str) -> str:
    """Repair UTF-8 text that was accidentally decoded as Latin-1/CP1252."""
    if not value or not _looks_like_utf8_mojibake(value):
        return value

    best = value
    best_score = (_cyrillic_count(value), -_c1_control_count(value), -sum(value.count(m) for m in MOJIBAKE_MARKERS))
    for encoding in ("latin1", "cp1252"):
        try:
            candidate = value.encode(encoding).decode("utf-8")
        except Exception:
            continue
        score = (
            _cyrillic_count(candidate),
            -_c1_control_count(candidate),
            -sum(candidate.count(m) for m in MOJIBAKE_MARKERS),
        )
        if score > best_score and _cyrillic_count(candidate) > _cyrillic_count(value):
            best = candidate
            best_score = score
    return best


def normalize_device_name(value: Any) -> str:
    name = _repair_utf8_mojibake(str(value or "")).strip()
    if not name:
        return ""

    cleaned = []
    for ch in name:
        if ch in ("\r", "\n", "\t"):
            cleaned.append(" ")
        elif ord(ch) >= 32 and ord(ch) != 127:
            cleaned.append(ch)
    name = " ".join("".join(cleaned).split())
    if len(name) > MAX_DEVICE_NAME_LEN:
        name = name[:MAX_DEVICE_NAME_LEN].rstrip()
    return name


def _read_json_file(path: str, default: Any) -> Any:
    try:
        with open(path, "r", encoding="utf-8", errors="ignore") as f:
            return json.load(f)
    except Exception:
        return default


def _entry(ip: str, name: str, source: str, **extra: Any) -> DeviceEntry:
    item: DeviceEntry = {"ip": ip, "name": name, "source": source}
    for key, value in extra.items():
        if value not in (None, "", [], {}):
            item[key] = value
    return item


def _iter_ip_values(value: Any) -> Iterable[Any]:
    if isinstance(value, (list, tuple)):
        for item in value:
            yield item
    elif value not in (None, ""):
        yield value


def extract_device_entries_from_device_list(data: Any) -> DeviceMap:
    """Extract ``ip -> device`` entries from Keenetic ``show device-list`` JSON."""
    if not isinstance(data, Mapping):
        return {}

    hosts = data.get("host")
    if not isinstance(hosts, list):
        return {}

    out: DeviceMap = {}
    for host in hosts:
        if not isinstance(host, Mapping):
            continue

        name = normalize_device_name(host.get("name")) or normalize_device_name(host.get("hostname"))
        if not name:
            continue

        ips: List[Any] = []
        ips.extend(_iter_ip_values(host.get("ip")))
        ips.extend(_iter_ip_values(host.get("ip6")))

        mac = normalize_device_name(host.get("mac") or host.get("hwaddr") or host.get("hardware-address"))
        hostname = normalize_device_name(host.get("hostname"))

        for raw_ip in ips:
            ip = normalize_ip(raw_ip)
            if not ip:
                continue
            out[ip] = _entry(ip, name, "router", mac=mac, hostname=hostname)

    return out


def _fetch_router_device_list(timeout: float = DEFAULT_RCI_TIMEOUT) -> Any:
    req = build_rci_request(
        RCI_DEVICE_LIST_URL,
        user_agent="XKeen-UI",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 - local router RCI
        raw = resp.read(1024 * 1024)
    return json.loads(raw.decode("utf-8", "ignore"))


def discover_router_device_names(
    *,
    timeout: float = DEFAULT_RCI_TIMEOUT,
    fetcher: Optional[RouterFetcher] = None,
) -> Tuple[DeviceMap, str]:
    try:
        data = fetcher() if callable(fetcher) else _fetch_router_device_list(timeout=timeout)
        return extract_device_entries_from_device_list(data), ""
    except Exception as exc:  # noqa: BLE001 - best-effort enrichment
        return {}, str(exc)


def load_manual_device_names(ui_state_dir: Optional[str] = None) -> DeviceMap:
    path = _state_path(ui_state_dir)
    raw = _read_json_file(path, {})
    items = raw.get("items") if isinstance(raw, Mapping) else raw
    if not isinstance(items, Mapping):
        return {}

    out: DeviceMap = {}
    for raw_ip, raw_item in items.items():
        ip = normalize_ip(raw_ip)
        if not ip:
            continue

        if isinstance(raw_item, Mapping):
            name = normalize_device_name(raw_item.get("name"))
            updated_at = raw_item.get("updated_at") or raw_item.get("updatedAt")
        else:
            name = normalize_device_name(raw_item)
            updated_at = None

        if not name:
            continue

        extra: Dict[str, Any] = {}
        try:
            updated = int(updated_at)
            if updated > 0:
                extra["updated_at"] = updated
        except Exception:
            pass
        out[ip] = _entry(ip, name, "manual", **extra)

    return out


def _write_manual_device_names(ui_state_dir: Optional[str], devices: DeviceMap) -> None:
    items: Dict[str, Dict[str, Any]] = {}
    for ip in sorted(devices.keys(), key=_ip_sort_key):
        entry = devices[ip]
        name = normalize_device_name(entry.get("name"))
        if not name:
            continue
        updated_at = entry.get("updated_at") or _now_ts()
        items[ip] = {"name": name, "updated_at": int(updated_at)}

    _atomic_write_json(_state_path(ui_state_dir), {"version": 1, "items": items}, mode=0o600)


def set_manual_device_name(ui_state_dir: Optional[str], raw_ip: Any, raw_name: Any) -> DeviceEntry:
    ip = normalize_ip(raw_ip)
    if not ip:
        raise ValueError("invalid_ip")

    name = normalize_device_name(raw_name)
    if not name:
        raise ValueError("empty_name")

    devices = load_manual_device_names(ui_state_dir)
    entry = _entry(ip, name, "manual", updated_at=_now_ts())
    devices[ip] = entry
    _write_manual_device_names(ui_state_dir, devices)
    return entry


def delete_manual_device_name(ui_state_dir: Optional[str], raw_ip: Any) -> bool:
    ip = normalize_ip(raw_ip)
    if not ip:
        raise ValueError("invalid_ip")

    devices = load_manual_device_names(ui_state_dir)
    existed = ip in devices
    if existed:
        devices.pop(ip, None)
        _write_manual_device_names(ui_state_dir, devices)
    return existed


def _ip_sort_key(value: Any) -> Tuple[int, int, str]:
    ip_text = str(value.get("ip") if isinstance(value, Mapping) else value or "")
    try:
        ip_obj = ipaddress.ip_address(ip_text)
        return (int(ip_obj.version), int(ip_obj), ip_text)
    except Exception:
        return (99, 0, ip_text)


def _sorted_devices(devices: DeviceMap) -> List[DeviceEntry]:
    def _sort_key(item: DeviceEntry):
        return (*_ip_sort_key(item), str(item.get("name") or ""))

    return [dict(item) for item in sorted(devices.values(), key=_sort_key)]


def get_xray_device_names_state(
    ui_state_dir: Optional[str] = None,
    *,
    refresh_router: bool = True,
    router_fetcher: Optional[RouterFetcher] = None,
) -> Dict[str, Any]:
    router: DeviceMap = {}
    router_error = ""
    if refresh_router:
        router, router_error = discover_router_device_names(fetcher=router_fetcher)

    manual = load_manual_device_names(ui_state_dir)
    merged: DeviceMap = {ip: dict(entry) for ip, entry in router.items()}
    for ip, entry in manual.items():
        next_entry = dict(entry)
        if ip in router:
            next_entry["router_name"] = router[ip].get("name")
            if router[ip].get("mac"):
                next_entry["mac"] = router[ip].get("mac")
        merged[ip] = next_entry

    return {
        "ok": True,
        "updated_at": _now_ts(),
        "router_error": router_error,
        "devices": _sorted_devices(merged),
        "manual": _sorted_devices(manual),
        "router": _sorted_devices(router),
        "device_map": {ip: dict(entry) for ip, entry in sorted(merged.items())},
    }

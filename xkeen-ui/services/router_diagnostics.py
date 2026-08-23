"""Read-only router diagnostics used by the compact panel dashboard.

The frequently refreshed snapshot intentionally avoids the very large RCI
branches (NAT and processes).  ``show/processes`` is exposed separately and is
only requested after an explicit user action.
"""

from __future__ import annotations

import json
import copy
import math
import re
import statistics
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable, Iterable

from services.keenetic_rci import build_rci_request


RCI_ROOT = "http://127.0.0.1:79/rci"
PROC_CONNTRACK_COUNT = Path("/proc/sys/net/netfilter/nf_conntrack_count")
PROC_CONNTRACK_MAX = Path("/proc/sys/net/netfilter/nf_conntrack_max")

_interface_lock = threading.Lock()
_previous_interfaces: tuple[float, dict[str, tuple[int, int]]] | None = None
_snapshot_lock = threading.Lock()
_cached_snapshot: tuple[float, dict[str, Any]] | None = None
_capability_lock = threading.Lock()
_cached_capabilities: tuple[float, dict[str, Any]] | None = None
_incident_log: list[dict[str, Any]] = []
_previous_health: str | None = None


class RciUnavailable(RuntimeError):
    """A sanitized RCI failure safe to handle at the route boundary."""

    def __init__(self, state: str = "unavailable") -> None:
        super().__init__(state)
        self.state = state


def _read_limited(response: Any, limit: int) -> bytes:
    data = response.read(limit + 1)
    if len(data) > limit:
        raise RciUnavailable("response_too_large")
    return data


def _contains_rci_error(value: Any) -> bool:
    if isinstance(value, dict):
        if str(value.get("status") or "").strip().lower() == "error":
            return True
        return any(_contains_rci_error(item) for item in value.values())
    if isinstance(value, list):
        return any(_contains_rci_error(item) for item in value)
    return False


def fetch_rci_json(
    path: str,
    *,
    timeout: float = 2.0,
    limit: int = 512 * 1024,
    opener: Callable[..., Any] = urllib.request.urlopen,
) -> Any:
    """Fetch one local RCI branch with bounded time and response size."""

    endpoint = str(path or "").strip().strip("/")
    if not endpoint or ".." in endpoint:
        raise ValueError("invalid RCI path")
    request = build_rci_request(f"{RCI_ROOT}/{endpoint}")
    try:
        with opener(request, timeout=timeout) as response:  # noqa: S310 - fixed local RCI root
            raw = _read_limited(response, limit)
        payload = json.loads(raw.decode("utf-8"))
    except urllib.error.HTTPError as exc:
        if int(getattr(exc, "code", 0) or 0) in (401, 403):
            raise RciUnavailable("unauthorized") from None
        raise RciUnavailable("http_error") from None
    except RciUnavailable:
        raise
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError):
        raise RciUnavailable("unavailable") from None
    if _contains_rci_error(payload):
        raise RciUnavailable("rci_error")
    return payload


def _bool(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    normalized = str(value or "").strip().lower()
    if normalized in {"yes", "true", "up", "on", "online", "connected", "1"}:
        return True
    if normalized in {"no", "false", "down", "off", "offline", "disconnected", "0"}:
        return False
    return None


def _number(value: Any) -> float | None:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return max(0.0, result) if math.isfinite(result) else None


def _signed_number(value: Any) -> float | None:
    """Parse a finite metric without clamping signal values below zero."""
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def _integer(value: Any) -> int | None:
    number = _number(value)
    return int(number) if number is not None else None


def _kib(value: Any) -> int:
    """Parse Keenetic process memory fields (for example ``"2048 kB"``)."""
    if isinstance(value, str):
        value = value.strip().split()[0] if value.strip() else ""
    return _integer(value) or 0


def _first(mapping: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in mapping and mapping[key] not in (None, ""):
            return mapping[key]
    return None


def _walk_dicts(payload: Any) -> Iterable[dict[str, Any]]:
    """Yield nested RCI records without assuming one firmware response shape."""
    if isinstance(payload, dict):
        yield payload
        for value in payload.values():
            yield from _walk_dicts(value)
    elif isinstance(payload, list):
        for value in payload:
            yield from _walk_dicts(value)


def normalize_capabilities(payload: Any, *, sampled_at: int) -> dict[str, Any]:
    """Reduce ``show/version`` to safe feature flags used by optional panels."""
    source = payload if isinstance(payload, dict) else {}
    text = json.dumps(source, ensure_ascii=False).lower()
    components: list[str] = []
    features: list[str] = []
    def extend_names(value: Any, target: list[str]) -> None:
        if isinstance(value, (list, tuple)):
            target.extend(str(item).strip()[:64] for item in value if str(item).strip())
        elif isinstance(value, dict):
            target.extend(str(item).strip()[:64] for item in value.keys() if str(item).strip())
        elif isinstance(value, str):
            target.extend(item.strip()[:64] for item in value.split(",") if item.strip())

    for branch in _walk_dicts(source):
        extend_names(branch.get("components"), components)
        extend_names(branch.get("features"), features)
    components.extend(re.findall(r"\b(?:wifi|wireless|lte|modem|mesh|usb)[a-z0-9_-]*", text))
    all_names = {item.lower() for item in components + features}
    return {
        "available": bool(source),
        "sampled_at": sampled_at,
        "model": str(_first(source, "model", "product", "hw-id", "hardware") or "")[:96],
        "firmware": str(_first(source, "version", "release", "firmware") or "")[:96],
        "wifi": any("wifi" in item or "wireless" in item for item in all_names) or "wifi" in text or "wifimaster" in text,
        "lte": any("lte" in item or "modem" in item or "qmi" in item for item in all_names) or "lte" in text or "modem" in text or "usbqmi" in text,
        "mesh": "mesh" in text,
        "components": sorted(set(components))[:64],
        "features": sorted(set(features))[:64],
    }


def _counter(record: dict[str, Any], *keys: str) -> int:
    return _integer(_first(record, *keys)) or 0


def _client_nested_value(record: dict[str, Any], key: str) -> Any:
    """Read a client metric from the host row or its Keenetic ``mws`` block."""

    direct = record.get(key)
    if direct not in (None, ""):
        return direct
    mws = record.get("mws")
    return mws.get(key) if isinstance(mws, dict) else None


def _client_interface(record: dict[str, Any]) -> str:
    mws = record.get("mws")
    if isinstance(mws, dict):
        access_point = _first(mws, "ap", "access-point", "interface")
        if access_point is not None:
            return str(access_point)[:64]
    interface = record.get("interface")
    if isinstance(interface, dict):
        return str(_first(interface, "id", "name", "description") or "")[:64]
    return str(_first(record, "interface", "access-point", "ap") or "")[:64]


def _client_link_rate(value: Any) -> int | None:
    """Return RCI Wi-Fi link rate in bit/s (Keenetic reports it in Mbit/s)."""

    parsed = _number(value)
    if parsed is None:
        return None
    # Keenetic ``show associations``/hotspot mws values are small Mbit/s
    # numbers (for example 192 or 2401). Preserve already-normalized bps
    # values used by alternative firmware response shapes.
    return round(parsed * 1_000_000) if parsed <= 10_000 else round(parsed)


def normalize_clients(payload: Any, *, sampled_at: int) -> dict[str, Any]:
    """Normalize hotspot/device-list entries for Top-5 and Wi-Fi client views."""
    items: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for raw in _walk_dicts(payload):
        address = str(_first(raw, "mac", "mac-address", "mac_address") or "").strip()[:48]
        ip = str(_first(raw, "ip", "address", "ipv4") or "").strip()[:64]
        # Nested RCI metadata contains interface/AP dictionaries with an IP or
        # a MAC-like identifier of their own.  Only hotspot host rows have a
        # stable client address *and* one of the host/device fields below.
        if not address and not ip:
            continue
        if not address and not any(key in raw for key in ("hostname", "host", "active", "registered", "mws", "rxbytes", "txbytes")):
            continue
        # The user-visible Keenetic ``name`` can contain a long registration
        # suffix (and, on older migrations, invalidly decoded text).  Prefer
        # the compact DHCP hostname when it is present.
        name = str(_first(raw, "hostname", "name", "host", "description", "id") or address or ip)[:96]
        key = (address.lower(), ip.lower())
        if key in seen:
            continue
        seen.add(key)
        rx = _counter(raw, "rxbytes", "rx-bytes", "received-bytes", "download", "rx")
        tx = _counter(raw, "txbytes", "tx-bytes", "sent-bytes", "upload", "tx")
        rssi_value = _signed_number(_client_nested_value(raw, "rssi"))
        items.append({
            "name": name,
            "mac": address,
            "ip": ip,
            "interface": _client_interface(raw),
            "rssi": int(rssi_value) if rssi_value is not None else None,
            "rx_rate": _client_link_rate(_client_nested_value(raw, "rxrate") or _first(raw, "rx-rate", "receive-rate")),
            "tx_rate": _client_link_rate(_client_nested_value(raw, "txrate") or _first(raw, "tx-rate", "send-rate")),
            "received_bytes": rx,
            "sent_bytes": tx,
            "traffic_bytes": rx + tx,
            "online": _bool(_first(raw, "active", "online", "connected", "link", "state")),
        })
    items.sort(key=lambda item: (-item["traffic_bytes"], item["name"].lower()))
    wifi = [item for item in items if item.get("rssi") is not None or "wifi" in item.get("interface", "").lower() or "wifimaster" in item.get("interface", "").lower()]
    return {"available": bool(items), "sampled_at": sampled_at, "count": len(items), "items": items[:100], "top": items[:5], "wifi": wifi[:64], "truncated": len(items) > 100}


def normalize_lte(payload: Any, *, sampled_at: int) -> dict[str, Any]:
    """Normalize every modem exposed by a Keenetic RCI branch.

    ``show/interface`` contains one top-level record per UsbQmi/UsbLte modem,
    but it also contains nested carrier records.  The previous implementation
    returned the first dictionary with a radio metric and therefore silently
    discarded every modem after the first one.  Keep a compact compatibility
    view at the top level while exposing the complete list in ``items``.
    """

    def modem_record(raw: dict[str, Any], *, top_level: bool) -> bool:
        identity = " ".join(
            str(value or "")
            for value in (
                _first(raw, "id", "interface-name", "type"),
                raw.get("description"),
                " ".join(str(item) for item in raw.get("traits", []) if item) if isinstance(raw.get("traits"), list) else "",
            )
        ).lower()
        has_modem_identity = any(token in identity for token in ("usbqmi", "usblte", "usbmbim", "modem", "mobile"))
        has_network_identity = any(key in raw for key in ("operator", "provider", "imei", "apn", "sim", "ati", "connection-state"))
        has_radio_data = any(key in raw for key in ("rsrp", "rsrq", "cinr", "sinr", "rssi", "signal", "band", "mobile"))
        return has_radio_data and (has_modem_identity or has_network_identity or top_level)

    def active_carriers(raw: dict[str, Any]) -> list[dict[str, Any]]:
        carriers = raw.get("carrier")
        source = carriers.values() if isinstance(carriers, dict) else carriers if isinstance(carriers, list) else []
        result: list[dict[str, Any]] = []
        for carrier in source:
            if not isinstance(carrier, dict) or _bool(carrier.get("active")) is False:
                continue
            result.append({
                "technology": str(_first(carrier, "technology", "mobile", "mode", "rat") or "")[:32],
                "band": str(_first(carrier, "band") or "")[:32],
                "bandwidth": _signed_number(_first(carrier, "bandwidth")),
                "earfcn": _integer(_first(carrier, "earfcn")),
                "phy_cell_id": str(_first(carrier, "phy-cell-id", "phy_cell_id") or "")[:32],
                "downlink_frequency": _integer(_first(carrier, "dl-freq", "downlink-frequency")),
                "uplink_frequency": _integer(_first(carrier, "ul-freq", "uplink-frequency")),
            })
        return result[:8]

    items: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw in _walk_dicts(payload):
        if not modem_record(raw, top_level=raw is payload):
            continue
        modem_id = str(_first(raw, "id", "interface-name") or "").strip()[:64]
        dedupe_key = modem_id.lower() or f"{_first(raw, 'imei', 'operator', 'provider')}:{len(items)}"
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)
        ati = raw.get("ati") if isinstance(raw.get("ati"), dict) else {}
        firmware = str(_first(raw, "fw", "firmware", "revision") or "")[:256]
        item = {
            "id": modem_id,
            "name": str(_first(raw, "description", "name") or modem_id or "LTE-модем")[:96],
            "operator": str(_first(raw, "operator", "provider", "network") or "")[:96],
            "technology": str(_first(raw, "technology", "mobile", "mode", "rat") or "")[:32],
            "connection_state": str(_first(raw, "connection-state", "state", "link") or "")[:32],
            "connected": _bool(_first(raw, "connected", "link")),
            "default_route": _bool(_first(raw, "defaultgw", "default-gateway")),
            "address": str(_first(raw, "address", "ip", "ipv4") or "")[:64],
            "mask": str(_first(raw, "mask", "netmask") or "")[:64],
            "priority": _integer(_first(raw, "priority")),
            "uptime": _integer(_first(raw, "uptime")),
            "band": str(_first(raw, "band", "cell", "earfcn") or "")[:32],
            "bandwidth": _signed_number(_first(raw, "bandwidth")),
            "rsrp": _signed_number(_first(raw, "rsrp", "signal-rsrp")),
            "rsrq": _signed_number(_first(raw, "rsrq", "signal-rsrq")),
            "cinr": _signed_number(_first(raw, "cinr", "sinr", "signal-cinr")),
            "rssi": _signed_number(_first(raw, "rssi", "signal")),
            "signal_level": _integer(_first(raw, "signal-level", "signal_level")),
            "imei": str(_first(raw, "imei") or "")[:32],
            "sim": str(_first(raw, "sim", "sim-state") or "")[:32],
            "apn": str(_first(raw, "apn") or "")[:96],
            "roaming": _bool(_first(raw, "roaming")),
            "base_station": str(_first(raw, "bssid", "base-station") or "")[:64],
            "enb_id": str(_first(raw, "enb-id", "enb_id") or "")[:32],
            "sector_id": str(_first(raw, "sector-id", "sector_id") or "")[:32],
            "tac": str(_first(raw, "tac") or "")[:32],
            "phy_cell_id": str(_first(raw, "phy-cell-id", "phy_cell_id") or "")[:32],
            "earfcn": _integer(_first(raw, "earfcn")),
            "distance": _integer(_first(raw, "distance")),
            "model": str(_first(ati, "model") or _first(raw, "product", "model-name") or "")[:128],
            "manufacturer": str(_first(ati, "manufacturer") or _first(raw, "manufacturer") or "")[:96],
            "firmware": firmware,
            "carriers": active_carriers(raw),
        }
        items.append(item)

    items.sort(key=lambda item: (not bool(item.get("default_route")), str(item.get("id") or item.get("name") or "").lower()))
    result: dict[str, Any] = {
        "available": bool(items),
        "sampled_at": sampled_at,
        "count": len(items),
        "items": items,
    }
    if items:
        # Preserve the original single-modem contract for older frontends.
        result.update({key: value for key, value in items[0].items() if key not in {"id", "name", "carriers"}})
        result["signal"] = items[0].get("rssi")
    return result


def sample_router_clients(
    *,
    rci_fetcher: Callable[[str], Any] = fetch_rci_json,
    clock: Callable[[], float] = time.time,
) -> dict[str, Any]:
    """Fetch the rich client list only after the user opens the section."""
    sampled_at = int(clock())
    errors: list[str] = []
    for path in ("show/ip/hotspot", "show/device-list"):
        try:
            payload = rci_fetcher(path)
            result = normalize_clients(payload, sampled_at=sampled_at)
            result["source"] = path
            return result
        except RciUnavailable as exc:
            errors.append(exc.state)
    return {"available": False, "sampled_at": sampled_at, "count": 0, "items": [], "top": [], "wifi": [], "state": errors[0] if errors else "unavailable"}


def cached_router_capabilities(*, cache_ttl: float = 3600.0, clock: Callable[[], float] = time.time) -> dict[str, Any]:
    global _cached_capabilities
    now = clock()
    with _capability_lock:
        cached = _cached_capabilities
        if cached is None or now - cached[0] >= max(60.0, cache_ttl):
            try:
                payload = normalize_capabilities(fetch_rci_json("show/version"), sampled_at=int(now))
            except RciUnavailable as exc:
                payload = {"available": False, "sampled_at": int(now), "state": exc.state, "wifi": False, "lte": False, "mesh": False, "components": [], "features": []}
            _cached_capabilities = (now, payload)
        return copy.deepcopy(_cached_capabilities[1])


def sample_router_lte(
    *,
    rci_fetcher: Callable[[str], Any] = fetch_rci_json,
    clock: Callable[[], float] = time.time,
) -> dict[str, Any]:
    """Probe optional modem branches on demand; LTE absence is not an error."""
    sampled_at = int(clock())
    # Current KeeneticOS exposes UsbQmi/UsbLte radio metrics directly inside
    # show/interface.  Older releases may still have one of the dedicated
    # branches below.
    for path in ("show/interface", "show/lte", "show/modem", "show/usb/modem"):
        try:
            result = normalize_lte(rci_fetcher(path), sampled_at=sampled_at)
            result["source"] = path
            if result.get("available"):
                return result
        except RciUnavailable:
            continue
    return {"available": False, "sampled_at": sampled_at}


def _ping_numbers(output: str) -> list[float]:
    samples: list[float] = []
    for value in re.findall(r"(?:time|время)[=<]\s*([0-9]+(?:[.,][0-9]+)?)\s*ms", output, re.I):
        try:
            samples.append(float(value.replace(",", ".")))
        except ValueError:
            continue
    return samples


def channel_check(
    target: str = "1.1.1.1",
    *,
    count: int = 4,
    include_trace: bool = False,
    runner: Callable[..., Any] = subprocess.run,
    clock: Callable[[], float] = time.time,
) -> dict[str, Any]:
    """Run a bounded ping and optional trace only from an explicit user action."""
    target = str(target or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9_.:-]{1,253}", target):
        raise ValueError("invalid target")
    count = max(1, min(8, int(count or 4)))
    started = int(clock())
    try:
        ping = runner(["ping", "-c", str(count), "-W", "1", target], capture_output=True, text=True, timeout=12, check=False)
        output = f"{getattr(ping, 'stdout', '')}\n{getattr(ping, 'stderr', '')}"[:16_384]
    except (OSError, subprocess.SubprocessError) as exc:
        return {"available": False, "target": target, "sampled_at": started, "state": "unavailable", "error": str(exc)[:160]}
    samples = _ping_numbers(output)
    loss_match = re.search(r"([0-9]+(?:[.,][0-9]+)?)%\s*(?:packet\s+)?loss", output, re.I)
    loss = float(loss_match.group(1).replace(",", ".")) if loss_match else (0.0 if samples else 100.0)
    average = round(statistics.fmean(samples), 1) if samples else None
    jitter = round(statistics.pstdev(samples), 1) if len(samples) > 1 else 0.0 if samples else None
    result: dict[str, Any] = {"available": bool(samples) or loss < 100, "target": target, "sampled_at": started, "sent": count, "received": len(samples), "loss_percent": round(loss, 1), "latency_ms": average, "jitter_ms": jitter, "state": "good" if loss == 0 and (average is None or average < 120) else "warning" if loss < 25 else "bad"}
    if include_trace:
        try:
            trace = runner(["traceroute", "-m", "8", "-w", "1", target], capture_output=True, text=True, timeout=20, check=False)
            result["trace"] = f"{getattr(trace, 'stdout', '')}\n{getattr(trace, 'stderr', '')}"[:16_384]
        except (OSError, subprocess.SubprocessError) as exc:
            result["trace"] = f"traceroute недоступен: {exc}"[:512]
        result["trace_command"] = "traceroute"
    return result


def _record_incident(snapshot: dict[str, Any], *, now: int) -> None:
    global _previous_health
    internet = snapshot.get("internet") or {}
    conntrack = snapshot.get("conntrack") or {}
    state = "offline" if internet.get("available") is False or internet.get("internet") is False else "degraded" if conntrack.get("tone") in {"warning", "danger"} else "normal"
    if state != _previous_health:
        if _previous_health is not None:
            _incident_log.insert(0, {"at": now, "state": state, "previous": _previous_health, "message": {"offline": "Связь с интернетом потеряна", "degraded": "Таблица соединений заполнена выше нормы", "normal": "Состояние восстановлено"}[state]})
            del _incident_log[30:]
        _previous_health = state
    snapshot["incidents"] = copy.deepcopy(_incident_log)


def normalize_internet_status(payload: Any) -> dict[str, Any]:
    source = payload if isinstance(payload, dict) else {}
    gateway_value = _first(source, "gateway-accessible", "gateway_accessible")
    dns_value = _first(source, "dns-accessible", "dns_accessible")
    captive_value = _first(source, "captive-accessible", "captive_accessible")
    host_value = _first(source, "host-accessible", "host_accessible")
    gateway = source.get("gateway")
    if isinstance(gateway, list):
        gateway = gateway[0] if gateway else {}
    if isinstance(gateway, dict):
        gateway_value = gateway_value if gateway_value is not None else gateway.get("accessible")
    else:
        gateway = {}
    internet = _bool(source.get("internet"))
    return {
        "available": True,
        "internet": internet,
        "gateway": _bool(gateway_value),
        "dns": _bool(dns_value),
        "captive": _bool(captive_value),
        "host": _bool(host_value),
        "reliable": _bool(source.get("reliable")),
        "checking": _bool(source.get("checking")),
        "checked": str(source.get("checked") or "")[:96],
        "interface": str(_first(source, "interface") or gateway.get("interface") or "")[:64],
        "address": str(_first(source, "address") or gateway.get("address") or "")[:64],
    }


def _read_nonnegative_int(path: Path, reader: Callable[[Path], str]) -> int | None:
    try:
        return max(0, int(reader(path).strip()))
    except (OSError, ValueError, TypeError):
        return None


def sample_conntrack(*, reader: Callable[[Path], str]) -> dict[str, Any]:
    count = _read_nonnegative_int(PROC_CONNTRACK_COUNT, reader)
    maximum = _read_nonnegative_int(PROC_CONNTRACK_MAX, reader)
    if count is None or maximum is None or maximum <= 0:
        return {"available": False}
    percent = round(min(999.9, count * 100.0 / maximum), 1)
    return {
        "available": True,
        "count": count,
        "max": maximum,
        "available_entries": max(0, maximum - count),
        "percent": percent,
        "tone": "danger" if percent >= 90 else "warning" if percent >= 75 else "normal",
    }


def _interface_records(payload: Any) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    if isinstance(payload, list):
        records.extend(item for item in payload if isinstance(item, dict))
    elif isinstance(payload, dict):
        direct = payload.get("interface")
        if isinstance(direct, list):
            records.extend(item for item in direct if isinstance(item, dict))
        elif isinstance(direct, dict):
            records.append(direct)
        elif _first(payload, "id", "name", "interface-name") is not None:
            records.append(payload)
        else:
            for key, value in payload.items():
                if not isinstance(value, dict):
                    continue
                item = dict(value)
                item.setdefault("id", key)
                records.append(item)
    return records


def _interface_kind(item: dict[str, Any], name: str) -> str:
    combined = f"{name} {item.get('type', '')} {item.get('description', '')}".lower()
    if _bool(item.get("defaultgw")) is True or any(token in combined for token in ("isp", "pppoe", "usbqmi", "usblte")):
        return "wan"
    if any(token in combined for token in ("wireguard", "openvpn", "sstp", "l2tp", "pptp", "ipsec", "vpn")):
        return "vpn"
    if any(token in combined for token in ("wifi", "accesspoint", "radio")):
        return "wifi"
    return "lan"


def _interface_online(item: dict[str, Any]) -> bool | None:
    values = [_bool(item.get(key)) for key in ("state", "link", "connected")]
    known = [value for value in values if value is not None]
    if not known:
        return None
    return all(known)


_INTERFACE_COUNTER_KEYS = (
    "rxbytes", "received-bytes", "received_bytes", "txbytes", "sent-bytes", "sent_bytes",
    "rxspeed", "receive-speed", "txspeed", "send-speed", "rxerrors", "rx-errors",
    "receive-errors", "txerrors", "tx-errors", "send-errors", "rxdropped", "rx-dropped",
    "receive-dropped", "txdropped", "tx-dropped", "send-dropped",
)


def _has_interface_metrics(record: dict[str, Any]) -> bool:
    return any(key in record and record[key] not in (None, "") for key in _INTERFACE_COUNTER_KEYS)


def _interface_stat_targets(payload: Any) -> list[str]:
    """Select active rows which need the cheap per-interface stat request."""

    candidates: list[tuple[int, str]] = []
    for raw in _interface_records(payload):
        name = str(_first(raw, "id", "name", "interface-name") or "").strip()
        if not name or _interface_online(raw) is not True or _has_interface_metrics(raw):
            continue
        kind = _interface_kind(raw, name)
        # Master radio rows duplicate their active access-point counters on
        # current KeeneticOS and do not expose a meaningful instantaneous
        # bitrate of their own.  Query AP rows instead.
        item_type = str(raw.get("type") or "").strip().lower()
        if item_type == "wifimaster" or ("/" not in name and name.lower().startswith("wifimaster")):
            continue
        priority = 0 if _bool(raw.get("defaultgw")) is True else {"wan": 1, "vpn": 2, "wifi": 3, "lan": 4}.get(kind, 5)
        candidates.append((priority, name))
    targets: list[str] = []
    for _priority, name in sorted(candidates, key=lambda item: (item[0], item[1].lower())):
        if name not in targets:
            targets.append(name)
        if len(targets) >= 16:
            break
    return targets


def normalize_interfaces(
    payload: Any,
    *,
    now: float,
    interface_stats: dict[str, Any] | None = None,
) -> dict[str, Any]:
    global _previous_interfaces
    normalized: list[dict[str, Any]] = []
    counters: dict[str, tuple[int, int]] = {}
    for raw in _interface_records(payload):
        name = str(_first(raw, "id", "name", "interface-name") or "").strip()[:64]
        if not name:
            continue
        stat = (interface_stats or {}).get(name)
        metrics = stat if isinstance(stat, dict) and _has_interface_metrics(stat) else raw
        metrics_available = _has_interface_metrics(metrics)
        received = _integer(_first(metrics, "rxbytes", "received-bytes", "received_bytes"))
        sent = _integer(_first(metrics, "txbytes", "sent-bytes", "sent_bytes"))
        if received is not None and sent is not None:
            counters[name] = (received, sent)
        normalized.append({
            "name": name,
            "description": str(raw.get("description") or "")[:96],
            "kind": _interface_kind(raw, name),
            "online": _interface_online(raw),
            "state": str(raw.get("state") or "")[:24],
            "link": str(raw.get("link") or "")[:24],
            "connected": str(raw.get("connected") or "")[:24],
            "address": str(raw.get("address") or "")[:64],
            "default_gateway": _bool(raw.get("defaultgw")) is True,
            "metrics_available": metrics_available,
            "received_bytes": received,
            "sent_bytes": sent,
            "receive_bits_per_second": _integer(_first(metrics, "rxspeed", "receive-speed")),
            "send_bits_per_second": _integer(_first(metrics, "txspeed", "send-speed")),
            "receive_errors": _integer(_first(metrics, "rxerrors", "rx-errors", "receive-errors")),
            "send_errors": _integer(_first(metrics, "txerrors", "tx-errors", "send-errors")),
            "receive_dropped": _integer(_first(metrics, "rxdropped", "rx-dropped", "receive-dropped")),
            "send_dropped": _integer(_first(metrics, "txdropped", "tx-dropped", "send-dropped")),
        })

    with _interface_lock:
        previous = _previous_interfaces
        _previous_interfaces = (now, counters)
    elapsed = max(0.0, now - previous[0]) if previous else 0.0
    old = previous[1] if previous else {}
    for item in normalized:
        if item["receive_bits_per_second"] is not None or item["send_bits_per_second"] is not None or not elapsed:
            continue
        current = counters.get(item["name"])
        previous_counter = old.get(item["name"])
        if current is None or previous_counter is None:
            continue
        old_rx, old_tx = previous_counter
        if item["received_bytes"] is not None and item["received_bytes"] >= old_rx:
            item["receive_bits_per_second"] = round((item["received_bytes"] - old_rx) * 8 / elapsed)
        if item["sent_bytes"] is not None and item["sent_bytes"] >= old_tx:
            item["send_bits_per_second"] = round((item["sent_bytes"] - old_tx) * 8 / elapsed)

    priority = {"wan": 0, "vpn": 1, "wifi": 2, "lan": 3}
    normalized.sort(key=lambda item: (priority.get(item["kind"], 4), not bool(item["online"]), item["name"].lower()))
    return {"available": bool(normalized), "count": len(normalized), "items": normalized[:64], "truncated": len(normalized) > 64}


def sample_router_diagnostics(
    *,
    reader: Callable[[Path], str] = lambda path: path.read_text(encoding="utf-8", errors="ignore"),
    rci_fetcher: Callable[[str], Any] = fetch_rci_json,
    clock: Callable[[], float] = time.time,
) -> dict[str, Any]:
    """Return the lightweight diagnostics snapshot; individual branches may fail."""

    now = clock()
    result: dict[str, Any] = {
        "schema_version": 1,
        "sampled_at": int(now),
        "freshness": {"state": "fresh", "age_seconds": 0, "stale_after_seconds": 15},
        "conntrack": sample_conntrack(reader=reader),
    }
    rci_states: list[str] = []
    try:
        result["internet"] = normalize_internet_status(rci_fetcher("show/internet/status"))
    except RciUnavailable as exc:
        rci_states.append(exc.state)
        result["internet"] = {"available": False}
    try:
        interface_payload = rci_fetcher("show/interface")
        interface_stats: dict[str, Any] = {}
        for name in _interface_stat_targets(interface_payload):
            try:
                encoded = urllib.parse.quote(name, safe="")
                interface_stats[name] = rci_fetcher(f"show/interface/stat?name={encoded}")
            except RciUnavailable:
                continue
        result["interfaces"] = normalize_interfaces(interface_payload, now=now, interface_stats=interface_stats)
    except RciUnavailable as exc:
        rci_states.append(exc.state)
        result["interfaces"] = {"available": False, "count": 0, "items": [], "truncated": False}
    result["rci"] = {
        "available": bool(result["internet"].get("available") or result["interfaces"].get("available")),
        "state": "available" if not rci_states else rci_states[0],
    }
    _record_incident(result, now=int(now))
    return result


def cached_router_diagnostics(
    *,
    cache_ttl: float = 10.0,
    stale_after: int = 15,
    clock: Callable[[], float] = time.time,
) -> dict[str, Any]:
    """Return a short-lived copy so 5 s UI polling does not hammer RCI."""

    global _cached_snapshot
    now = clock()
    with _snapshot_lock:
        cached = _cached_snapshot
        if cached is None or now - cached[0] >= max(1.0, cache_ttl):
            snapshot = sample_router_diagnostics(clock=clock)
            _cached_snapshot = (now, snapshot)
        else:
            snapshot = cached[1]
        result = copy.deepcopy(snapshot)
    age = max(0, int(now - float(result.get("sampled_at") or now)))
    result["freshness"] = {
        "state": "fresh" if age <= stale_after else "stale",
        "age_seconds": age,
        "stale_after_seconds": stale_after,
    }
    return result


def _walk_processes(payload: Any) -> Iterable[dict[str, Any]]:
    if isinstance(payload, dict):
        if _first(payload, "pid", "name", "id") is not None and any(
            key in payload for key in ("pid", "vm-size", "statistics", "service")
        ):
            yield payload
        for value in payload.values():
            yield from _walk_processes(value)
    elif isinstance(payload, list):
        for value in payload:
            yield from _walk_processes(value)


def _nested_cpu(item: dict[str, Any]) -> float:
    statistics = item.get("statistics")
    cpu = statistics.get("cpu") if isinstance(statistics, dict) else None
    if not isinstance(cpu, dict):
        cpu = item.get("cpu")
    if isinstance(cpu, dict):
        return round(_number(_first(cpu, "cur", "current", "avg")) or 0.0, 1)
    return round(_number(cpu) or 0.0, 1)


def normalize_processes(payload: Any, *, sampled_at: int) -> dict[str, Any]:
    items: list[dict[str, Any]] = []
    seen: set[tuple[int, str]] = set()
    for raw in _walk_processes(payload):
        pid = _integer(raw.get("pid")) or 0
        name = str(raw.get("comm") or raw.get("name") or raw.get("id") or "process").strip()[:96]
        identity = (pid, name)
        if identity in seen:
            continue
        seen.add(identity)
        # RSS is the useful "memory in use" value. Older fixtures only expose
        # vm-size, so keep it as the bounded fallback.
        vm_kib = _kib(_first(raw, "vm-rss", "vm_rss", "rss", "memory", "vm-size", "vm_size"))
        service = raw.get("service") if isinstance(raw.get("service"), dict) else {}
        object_info = raw.get("object") if isinstance(raw.get("object"), dict) else {}
        items.append({
            "pid": pid,
            "name": name,
            "service": str(object_info.get("id") or raw.get("id") or "")[:128],
            "state": str(raw.get("state") or service.get("state") or "")[:48],
            "cpu_percent": _nested_cpu(raw),
            "memory_bytes": vm_kib * 1024,
            "threads": _integer(raw.get("threads")) or 0,
        })
    items.sort(key=lambda item: (-item["cpu_percent"], -item["memory_bytes"], item["name"].lower()))
    return {
        "schema_version": 1,
        "sampled_at": sampled_at,
        "source": "rci",
        "count": len(items),
        "items": items[:80],
        "truncated": len(items) > 80,
    }


def sample_router_processes(
    *,
    rci_fetcher: Callable[[str], Any] = fetch_rci_json,
    clock: Callable[[], float] = time.time,
) -> dict[str, Any]:
    """Fetch the heavy RCI process list. This function must only run on demand."""

    return normalize_processes(rci_fetcher("show/processes"), sampled_at=int(clock()))


def reset_router_diagnostic_sampler() -> None:
    global _previous_interfaces, _cached_snapshot, _cached_capabilities, _incident_log, _previous_health
    with _interface_lock:
        _previous_interfaces = None
    with _snapshot_lock:
        _cached_snapshot = None
    with _capability_lock:
        _cached_capabilities = None
    _incident_log = []
    _previous_health = None

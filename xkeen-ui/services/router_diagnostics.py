"""Read-only router diagnostics used by the compact panel dashboard.

The frequently refreshed snapshot intentionally avoids the very large RCI
branches (NAT and processes).  ``show/processes`` is exposed separately and is
only requested after an explicit user action.
"""

from __future__ import annotations

import json
import copy
import math
import threading
import time
import urllib.error
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


def normalize_interfaces(payload: Any, *, now: float) -> dict[str, Any]:
    global _previous_interfaces
    normalized: list[dict[str, Any]] = []
    counters: dict[str, tuple[int, int]] = {}
    for raw in _interface_records(payload):
        name = str(_first(raw, "id", "name", "interface-name") or "").strip()[:64]
        if not name:
            continue
        received = _integer(_first(raw, "rxbytes", "received-bytes", "received_bytes")) or 0
        sent = _integer(_first(raw, "txbytes", "sent-bytes", "sent_bytes")) or 0
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
            "received_bytes": received,
            "sent_bytes": sent,
            "receive_bits_per_second": _integer(_first(raw, "rxspeed", "receive-speed")) or 0,
            "send_bits_per_second": _integer(_first(raw, "txspeed", "send-speed")) or 0,
            "receive_errors": _integer(_first(raw, "rxerrors", "rx-errors", "receive-errors")) or 0,
            "send_errors": _integer(_first(raw, "txerrors", "tx-errors", "send-errors")) or 0,
            "receive_dropped": _integer(_first(raw, "rxdropped", "rx-dropped", "receive-dropped")) or 0,
            "send_dropped": _integer(_first(raw, "txdropped", "tx-dropped", "send-dropped")) or 0,
        })

    with _interface_lock:
        previous = _previous_interfaces
        _previous_interfaces = (now, counters)
    elapsed = max(0.0, now - previous[0]) if previous else 0.0
    old = previous[1] if previous else {}
    for item in normalized:
        if item["receive_bits_per_second"] or item["send_bits_per_second"] or not elapsed:
            continue
        old_rx, old_tx = old.get(item["name"], (item["received_bytes"], item["sent_bytes"]))
        if item["received_bytes"] >= old_rx:
            item["receive_bits_per_second"] = round((item["received_bytes"] - old_rx) * 8 / elapsed)
        if item["sent_bytes"] >= old_tx:
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
        result["interfaces"] = normalize_interfaces(rci_fetcher("show/interface"), now=now)
    except RciUnavailable as exc:
        rci_states.append(exc.state)
        result["interfaces"] = {"available": False, "count": 0, "items": [], "truncated": False}
    result["rci"] = {
        "available": bool(result["internet"].get("available") or result["interfaces"].get("available")),
        "state": "available" if not rci_states else rci_states[0],
    }
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
    global _previous_interfaces, _cached_snapshot
    with _interface_lock:
        _previous_interfaces = None
    with _snapshot_lock:
        _cached_snapshot = None

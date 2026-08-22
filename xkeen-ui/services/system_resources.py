"""Small, dependency-free router resource sampler.

The panel polls this sampler at a deliberately low frequency.  Linux procfs is
used instead of spawning utilities so the feature also works on constrained
Entware router builds.
"""

from __future__ import annotations

import os
import shutil
import threading
import time
from pathlib import Path
from typing import Any, Callable


PROC_STAT = Path("/proc/stat")
PROC_MEMINFO = Path("/proc/meminfo")
PROC_LOADAVG = Path("/proc/loadavg")
PROC_UPTIME = Path("/proc/uptime")
PROC_NET_DEV = Path("/proc/net/dev")
THERMAL_ZONE = Path("/sys/class/thermal/thermal_zone0/temp")

_cpu_lock = threading.Lock()
_previous_cpu: tuple[int, int] | None = None
_network_lock = threading.Lock()
_previous_network: tuple[float, dict[str, tuple[int, int]]] | None = None


def _read_text(path: Path, *, limit: int = 64 * 1024) -> str:
    with path.open("r", encoding="utf-8", errors="replace") as stream:
        return stream.read(limit)


def _cpu_counters(text: str) -> tuple[int, int]:
    first = next((line for line in text.splitlines() if line.startswith("cpu ")), "")
    values = [int(value) for value in first.split()[1:] if value.isdigit()]
    if len(values) < 4:
        raise ValueError("invalid /proc/stat")
    total = sum(values)
    idle = values[3] + (values[4] if len(values) > 4 else 0)
    return total, idle


def _cpu_percent(current: tuple[int, int]) -> float:
    global _previous_cpu
    with _cpu_lock:
        previous = _previous_cpu
        _previous_cpu = current
    if previous is None or current[0] <= previous[0]:
        total_delta, idle_delta = current
    else:
        total_delta = current[0] - previous[0]
        idle_delta = max(0, current[1] - previous[1])
    if total_delta <= 0:
        return 0.0
    return round(max(0.0, min(100.0, (1.0 - idle_delta / total_delta) * 100.0)), 1)


def _memory(text: str) -> dict[str, int | float]:
    values: dict[str, int] = {}
    for line in text.splitlines():
        key, separator, remainder = line.partition(":")
        if not separator:
            continue
        raw = remainder.strip().split()
        if not raw or not raw[0].isdigit():
            continue
        amount = int(raw[0])
        if len(raw) > 1 and raw[1].lower() == "kb":
            amount *= 1024
        values[key] = amount

    total = max(0, values.get("MemTotal", 0))
    available = values.get("MemAvailable")
    if available is None:
        available = values.get("MemFree", 0) + values.get("Buffers", 0) + values.get("Cached", 0)
    available = max(0, min(total, available))
    used = max(0, total - available)
    swap_total = max(0, values.get("SwapTotal", 0))
    swap_free = max(0, min(swap_total, values.get("SwapFree", 0)))
    return {
        "total_bytes": total,
        "used_bytes": used,
        "available_bytes": available,
        "percent": round(used * 100.0 / total, 1) if total else 0.0,
        "swap_total_bytes": swap_total,
        "swap_used_bytes": max(0, swap_total - swap_free),
    }


def _network_counters(text: str) -> dict[str, tuple[int, int]]:
    counters: dict[str, tuple[int, int]] = {}
    for line in text.splitlines():
        if ":" not in line:
            continue
        raw_name, raw_values = line.split(":", 1)
        name = raw_name.strip()
        values = raw_values.split()
        if not name or len(values) < 9:
            continue
        try:
            counters[name] = (max(0, int(values[0])), max(0, int(values[8])))
        except ValueError:
            continue
    return counters


def _network(text: str, *, now: float) -> dict[str, Any]:
    global _previous_network
    counters = _network_counters(text)
    visible = {name: value for name, value in counters.items() if name != "lo"}
    if not visible:
        visible = counters

    with _network_lock:
        previous = _previous_network
        _previous_network = (now, counters)

    elapsed = max(0.0, now - previous[0]) if previous else 0.0
    previous_counters = previous[1] if previous else {}
    interfaces: list[dict[str, Any]] = []
    for name, (received, sent) in sorted(visible.items()):
        old_received, old_sent = previous_counters.get(name, (received, sent))
        receive_rate = (received - old_received) / elapsed if elapsed and received >= old_received else 0.0
        send_rate = (sent - old_sent) / elapsed if elapsed and sent >= old_sent else 0.0
        interfaces.append({
            "name": name[:32],
            "received_bytes": received,
            "sent_bytes": sent,
            "receive_bytes_per_second": round(max(0.0, receive_rate), 1),
            "send_bytes_per_second": round(max(0.0, send_rate), 1),
        })

    return {
        "received_bytes": sum(item[0] for item in visible.values()),
        "sent_bytes": sum(item[1] for item in visible.values()),
        "receive_bytes_per_second": round(sum(item["receive_bytes_per_second"] for item in interfaces), 1),
        "send_bytes_per_second": round(sum(item["send_bytes_per_second"] for item in interfaces), 1),
        "interfaces": interfaces[:16],
    }


def _storage(disk_usage: Callable[[str], Any]) -> dict[str, int | float | str]:
    # The firmware rootfs is a read-only image and normally reports 100% by
    # design. Xkeen and Entware live on /opt; that is the actionable capacity.
    path = "/opt" if os.path.isdir("/opt") else "/"
    usage = disk_usage(path)
    total = max(0, int(usage.total))
    used = max(0, min(total, int(usage.used)))
    free = max(0, min(total, int(usage.free)))
    return {
        "total_bytes": total,
        "used_bytes": used,
        "free_bytes": free,
        "percent": round(used * 100.0 / total, 1) if total else 0.0,
        "path": path,
    }


def _temperature(text: str) -> float | None:
    raw = text.strip().splitlines()[0] if text.strip() else ""
    try:
        value = float(raw)
    except ValueError:
        return None
    if abs(value) >= 1000:
        value /= 1000.0
    if value < -50 or value > 200:
        return None
    return round(value, 1)


def _optional_read(reader: Callable[[Path], str], path: Path) -> str:
    try:
        return reader(path)
    except (OSError, ValueError, KeyError):
        return ""


def sample_system_resources(
    *,
    reader: Callable[[Path], str] = _read_text,
    clock: Callable[[], float] = time.time,
    disk_usage: Callable[[str], Any] = shutil.disk_usage,
) -> dict[str, Any]:
    """Return one bounded resource snapshot or raise ``OSError``/``ValueError``."""

    now = clock()
    cpu = _cpu_counters(reader(PROC_STAT))
    memory = _memory(reader(PROC_MEMINFO))
    load_parts = reader(PROC_LOADAVG).split()
    uptime_parts = reader(PROC_UPTIME).split()
    loads = [round(float(value), 2) for value in load_parts[:3]]
    while len(loads) < 3:
        loads.append(0.0)
    uptime = int(float(uptime_parts[0])) if uptime_parts else 0
    tasks = load_parts[3].split("/", 1) if len(load_parts) > 3 else []
    try:
        runnable_tasks = max(0, int(tasks[0]))
        total_tasks = max(0, int(tasks[1]))
    except (ValueError, IndexError):
        runnable_tasks = total_tasks = 0

    payload: dict[str, Any] = {
        # Keep the original envelope version: the added diagnostic fields are
        # optional and older panel clients can safely ignore them.
        "schema_version": 1,
        "sampled_at": int(now),
        "cpu": {
            "percent": _cpu_percent(cpu),
            "cores": max(1, int(os.cpu_count() or 1)),
            "load_1m": loads[0],
            "load_5m": loads[1],
            "load_15m": loads[2],
            "runnable_tasks": runnable_tasks,
            "total_tasks": total_tasks,
        },
        "memory": memory,
        "uptime_seconds": max(0, uptime),
    }

    network_text = _optional_read(reader, PROC_NET_DEV)
    if network_text:
        payload["network"] = _network(network_text, now=now)
    try:
        payload["storage"] = _storage(disk_usage)
    except (OSError, ValueError, TypeError, AttributeError):
        pass
    temperature = _temperature(_optional_read(reader, THERMAL_ZONE))
    if temperature is not None:
        payload["temperature_celsius"] = temperature
    return payload


def reset_system_resource_sampler() -> None:
    """Reset the CPU delta baseline (used by tests)."""

    global _previous_cpu, _previous_network
    with _cpu_lock:
        _previous_cpu = None
    with _network_lock:
        _previous_network = None

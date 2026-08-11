"""Small, dependency-free router resource sampler.

The panel polls this sampler at a deliberately low frequency.  Linux procfs is
used instead of spawning utilities so the feature also works on constrained
Entware router builds.
"""

from __future__ import annotations

import os
import threading
import time
from pathlib import Path
from typing import Any, Callable


PROC_STAT = Path("/proc/stat")
PROC_MEMINFO = Path("/proc/meminfo")
PROC_LOADAVG = Path("/proc/loadavg")
PROC_UPTIME = Path("/proc/uptime")

_cpu_lock = threading.Lock()
_previous_cpu: tuple[int, int] | None = None


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


def sample_system_resources(
    *,
    reader: Callable[[Path], str] = _read_text,
    clock: Callable[[], float] = time.time,
) -> dict[str, Any]:
    """Return one bounded resource snapshot or raise ``OSError``/``ValueError``."""

    cpu = _cpu_counters(reader(PROC_STAT))
    memory = _memory(reader(PROC_MEMINFO))
    load_parts = reader(PROC_LOADAVG).split()
    uptime_parts = reader(PROC_UPTIME).split()
    loads = [round(float(value), 2) for value in load_parts[:3]]
    while len(loads) < 3:
        loads.append(0.0)
    uptime = int(float(uptime_parts[0])) if uptime_parts else 0
    return {
        "schema_version": 1,
        "sampled_at": int(clock()),
        "cpu": {
            "percent": _cpu_percent(cpu),
            "cores": max(1, int(os.cpu_count() or 1)),
            "load_1m": loads[0],
            "load_5m": loads[1],
            "load_15m": loads[2],
        },
        "memory": memory,
        "uptime_seconds": max(0, uptime),
    }


def reset_system_resource_sampler() -> None:
    """Reset the CPU delta baseline (used by tests)."""

    global _previous_cpu
    with _cpu_lock:
        _previous_cpu = None

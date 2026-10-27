"""Pure parsing of router sensors, memory and swap for the diagnostics history.

Everything here takes already-read text, or a ``reader``/``lister`` pair so
tests can substitute the filesystem.  A sensor that cannot be read is skipped.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Literal

Reader = Callable[[Path], str]
Lister = Callable[[Path], "list[str]"]

THERMAL_ROOT = Path("/sys/class/thermal")
CPUFREQ_DIR = Path("/sys/devices/system/cpu/cpu0/cpufreq")


def _default_reader(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def _default_lister(path: Path) -> list[str]:
    return os.listdir(path)


@dataclass
class ThermalZone:
    type: str
    temp_c: float
    shutdown_c: float | None


@dataclass
class TempGroup:
    id: str
    label: str
    kind: Literal["chip", "wifi"]
    value_c: float | None
    sensors: list[tuple[str, float]] = field(default_factory=list)
    shutdown_c: float | None = None


def _number(text: str) -> float | None:
    try:
        return float(str(text).strip())
    except (TypeError, ValueError):
        return None


def _read_number(reader: Reader, path: Path) -> float | None:
    try:
        return _number(reader(path))
    except (OSError, ValueError):
        return None


def _natural_key(name: str) -> tuple[str, int]:
    match = re.search(r"(\d+)$", name)
    return (name[: match.start()] if match else name, int(match.group(1)) if match else -1)


def _shutdown_c(zone_dir: Path, reader: Reader, lister: Lister) -> float | None:
    try:
        names = lister(zone_dir)
    except OSError:
        return None
    trips: list[tuple[float, bool]] = []
    for name in names:
        match = re.fullmatch(r"trip_point_(\d+)_temp", name)
        if not match:
            continue
        temp = _read_number(reader, zone_dir / name)
        if temp is None or temp <= 0:
            continue
        try:
            kind = reader(zone_dir / f"trip_point_{match.group(1)}_type").strip()
        except OSError:
            kind = ""
        trips.append((temp / 1000.0, kind == "critical"))
    if not trips:
        return None
    critical = [t for t, is_critical in trips if is_critical]
    return max(critical) if critical else max(t for t, _ in trips)


def read_thermal_zones(
    reader: Reader = _default_reader, lister: Lister = _default_lister
) -> list[ThermalZone]:
    return read_zone_temperatures(discover_thermal_zones(reader, lister), reader)


@dataclass(frozen=True)
class ZoneInfo:
    """What does not change about a thermal zone: its directory, type and shutdown trip."""

    name: str
    type: str
    shutdown_c: float | None


def discover_thermal_zones(
    reader: Reader = _default_reader, lister: Lister = _default_lister
) -> list[ZoneInfo]:
    """The list of zones with their types and trip points; ask for it rarely."""
    try:
        names = [n for n in lister(THERMAL_ROOT) if re.fullmatch(r"thermal_zone\d+", n)]
    except OSError:
        return []
    found: list[ZoneInfo] = []
    for name in sorted(names, key=_natural_key):
        zone_dir = THERMAL_ROOT / name
        try:
            zone_type = reader(zone_dir / "type").strip()
        except (OSError, ValueError):
            continue
        if zone_type:
            found.append(ZoneInfo(name, zone_type, _shutdown_c(zone_dir, reader, lister)))
    return found


def read_zone_temperatures(infos: list[ZoneInfo], reader: Reader = _default_reader) -> list[ThermalZone]:
    """Only the temperature of every known zone is read; one that cannot be read is skipped."""
    zones: list[ThermalZone] = []
    for info in infos:
        raw_temp = _read_number(reader, THERMAL_ROOT / info.name / "temp")
        if raw_temp is not None:
            zones.append(ThermalZone(info.type, raw_temp / 1000.0, info.shutdown_c))
    return zones


_CHIP_GROUPS: list[tuple[str, str, tuple[str, ...]]] = [
    ("cpu", "Процессор", ("mcusys_thermal", "mtktscpu")),
    ("soc", "Главный чип", ("soc_thermal",)),
    ("npu", "Сетевой ускоритель", ("tops_thermal",)),
    ("ports", "Порты и коммутатор", ("ethsys_thermal", "eth2p5g_thermal")),
]
_WIFI_GROUPS: list[tuple[str, str]] = [
    ("wifi24", "Wi‑Fi 2,4 ГГц"),
    ("wifi5", "Wi‑Fi 5 ГГц"),
]


def _known_group(zone_type: str) -> str | None:
    for group_id, _label, prefixes in _CHIP_GROUPS:
        if any(zone_type.startswith(prefix) for prefix in prefixes):
            return group_id
    return None


def _max_or_none(values: list[float | None]) -> float | None:
    present = [v for v in values if v is not None]
    return max(present) if present else None


def group_temperatures(zones: list[ThermalZone], wifi: dict[str, float | None]) -> list[TempGroup]:
    labels = {gid: label for gid, label, _ in _CHIP_GROUPS}
    members: dict[str, list[ThermalZone]] = {gid: [] for gid, _l, _p in _CHIP_GROUPS}
    unknown: dict[str, list[ThermalZone]] = {}
    for zone in zones:
        gid = _known_group(zone.type)
        if len(zones) == 1:
            # The only sensor of a model measures the chip as a whole, whatever its name
            # (`mtktscpu` on KN-1811): the tile says so (owner's decision 27.10.2026).
            members["soc"].append(zone)
        elif gid is not None:
            members[gid].append(zone)
        else:
            unknown.setdefault(zone.type, []).append(zone)

    groups: list[TempGroup] = []

    def add(gid: str, label: str, items: list[ThermalZone]) -> None:
        groups.append(
            TempGroup(
                id=gid,
                label=label,
                kind="chip",
                value_c=max(z.temp_c for z in items),
                sensors=[(z.type, z.temp_c) for z in items],
                shutdown_c=_max_or_none([z.shutdown_c for z in items]),
            )
        )

    for gid, items in members.items():
        if items:
            add(gid, labels[gid], items)
    for zone_type, items in unknown.items():
        add(zone_type, zone_type, items)
    for gid, label in _WIFI_GROUPS:
        if gid not in wifi:
            continue
        value = wifi[gid]
        groups.append(
            TempGroup(
                id=gid,
                label=label,
                kind="wifi",
                value_c=value,
                sensors=[] if value is None else [(gid, value)],
                shutdown_c=None,
            )
        )
    return groups


def _meminfo_kb(meminfo: str) -> dict[str, int]:
    values: dict[str, int] = {}
    for line in str(meminfo).splitlines():
        match = re.match(r"\s*([A-Za-z_()0-9]+):\s*(\d+)", line)
        if match:
            values[match.group(1)] = int(match.group(2))
    return values


def memory_split(meminfo: str) -> dict:
    info = _meminfo_kb(meminfo)
    total = info.get("MemTotal", 0)
    free = min(info.get("MemFree", 0), total)
    if "MemAvailable" in info:
        available = info["MemAvailable"]
    else:
        available = free + info.get("Buffers", 0) + info.get("Cached", 0)
    available = max(free, min(available, total))
    programs = total - available
    cache = available - free
    return {
        "total_bytes": total * 1024,
        "programs_bytes": programs * 1024,
        "cache_bytes": cache * 1024,
        "free_bytes": free * 1024,
        "percent": (programs / total * 100.0) if total else 0.0,
    }


def procs_running(stat: str) -> int:
    for line in str(stat).splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[0] == "procs_running":
            try:
                return max(int(parts[1]) - 1, 0)
            except ValueError:
                return 0
    return 0


def per_core_busy(prev: dict, stat: str) -> tuple[dict, list[float]]:
    """Return ``(new_state, percent per core)``; state maps core name to (busy, total)."""
    state: dict[str, tuple[int, int]] = {}
    percents: list[float] = []
    for line in str(stat).splitlines():
        parts = line.split()
        if not parts or not re.fullmatch(r"cpu\d+", parts[0]):
            continue
        try:
            values = [int(v) for v in parts[1:]]
        except ValueError:
            continue
        if len(values) < 4:
            continue
        idle = values[3] + (values[4] if len(values) > 4 else 0)
        total = sum(values[:8])
        busy = total - idle
        name = parts[0]
        state[name] = (busy, total)
        before = prev.get(name)
        percent = 0.0
        if before is not None:
            d_total = total - before[1]
            d_busy = busy - before[0]
            if d_total > 0 and d_busy >= 0:
                percent = min(100.0, d_busy / d_total * 100.0)
        percents.append(percent)
    return state, percents


def zram_state(swaps: str, reader: Reader = _default_reader) -> dict | None:
    for line in str(swaps).splitlines()[1:]:
        parts = line.split()
        if len(parts) < 4 or "zram" not in parts[0]:
            continue
        device = Path(parts[0]).name
        used_kb = _number(parts[3])
        size = _read_number(reader, Path("/sys/block") / device / "disksize")
        if size is None:
            size_kb = _number(parts[2])
            if size_kb is None:
                continue
            size = size_kb * 1024
        return {"size_bytes": int(size), "used_bytes": int((used_kb or 0) * 1024)}
    return None


def cpu_frequency(reader: Reader = _default_reader) -> dict | None:
    current = _read_number(reader, CPUFREQ_DIR / "scaling_cur_freq")
    maximum = _read_number(reader, CPUFREQ_DIR / "scaling_max_freq")
    if current is None or maximum is None or maximum <= 0:
        return None
    # "below the maximum" is only a fact about one sample (ondemand/schedutil idle there
    # all day); whether it is throttling is for the collector to judge.
    return {
        "current_mhz": int(round(current / 1000)),
        "max_mhz": int(round(maximum / 1000)),
        "below_max": current < maximum,  # raw kHz, not the rounded MHz
    }

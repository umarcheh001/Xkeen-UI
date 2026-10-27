"""Who loaded the processor: per-process shares and their small history.

Once a minute the collector reads ``/proc/<pid>/stat`` of every process (cheap
files, unlike the firmware's ``show/processes``) and turns the tick deltas into
shares of the whole processor, grouped by program name (``ksoftirqd/0`` and
``ksoftirqd/1`` are one line).  ``TopStore`` keeps the few biggest names per
point in three tiers, so a chart column of any range can say who loaded it.
Nothing here starts threads; everything outside the process is injected.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path
from typing import Any, Callable, Iterable

Reader = Callable[[Path], str]
Lister = Callable[[Path], "list[str]"]

PROC = Path("/proc")
KEEP = 5  # names kept per point: folding columns needs more than are shown
SHOWN = 3  # names in a column
MIN_SHARE = 1.0  # % of the whole processor below which a program is not worth a line
FORMAT_VERSION = 1

# tier -> (point step in seconds, number of points)
TIERS: dict[str, tuple[int, int]] = {
    "minute": (60, 60),
    "day": (300, 288),
    "week": (1800, 336),
}


def parse_pid_stat(text: str) -> tuple[str, int] | None:
    """``(name, utime + stime)`` from one ``/proc/<pid>/stat``; the name may hold spaces and brackets."""
    head, sep, rest = str(text or "").rpartition(")")
    if not sep or "(" not in head:
        return None
    name = head.split("(", 1)[1]
    fields = rest.split()
    try:
        return name, int(fields[11]) + int(fields[12])
    except (IndexError, ValueError):
        return None


def process_name(comm: str) -> str:
    """One name per program: kernel threads lose their per-core suffix (``kworker/u4:2`` -> ``kworker``)."""
    name = str(comm or "").strip()
    name = re.sub(r"/.*$", "", name) or name
    return sys.intern(name) if name else "?"


def total_ticks(stat: str) -> int | None:
    """All processor time so far, every core together, from ``/proc/stat``."""
    summary = None
    cores = 0
    found = False
    for line in str(stat or "").splitlines():
        parts = line.split()
        if not parts or not parts[0].startswith("cpu"):
            continue
        try:
            ticks = sum(int(v) for v in parts[1:9])
        except ValueError:
            continue
        if parts[0] == "cpu":
            summary = ticks
        else:
            cores += ticks
            found = True
    return cores if found else summary


def scan_processes(reader: Reader, lister: Lister) -> dict[int, tuple[str, int]]:
    """``{pid: (comm, ticks)}``; a process that ends while being read is simply missing."""
    out: dict[int, tuple[str, int]] = {}
    for entry in lister(PROC):
        if not entry.isdigit():
            continue
        try:
            parsed = parse_pid_stat(reader(PROC / entry / "stat"))
        except (OSError, ValueError):
            continue
        if parsed is not None:
            out[int(entry)] = parsed
    return out


def cpu_shares(prev: dict[int, tuple[str, int]], cur: dict[int, tuple[str, int]], d_total: int) -> dict[str, float]:
    """Percent of the whole processor each program took between two scans."""
    if not d_total or d_total <= 0:
        return {}
    shares: dict[str, float] = {}
    for pid, (comm, ticks) in cur.items():
        old = prev.get(pid)
        if old is None or old[0] != comm:  # new, or the pid went to another program
            continue
        delta = ticks - old[1]
        if delta <= 0:
            continue
        name = process_name(comm)
        shares[name] = shares.get(name, 0.0) + delta * 100.0 / d_total
    return shares


def _top(sums: dict[str, float], count: int, n: int) -> tuple:
    best = sorted(sums.items(), key=lambda kv: (-kv[1], kv[0]))[:n]
    flat: list[Any] = []
    for name, total in best:
        flat += [name, total / count]
    return tuple(flat)


class _Tier:
    def __init__(self, name: str) -> None:
        self.step, self.size = TIERS[name]
        self.starts: list[int] = [-1] * self.size
        self.points: list[tuple | None] = [None] * self.size
        self.cur: int | None = None
        self.run: dict[str, float] = {}
        self.cnt = 0

    def _close(self) -> None:
        if self.cur is None:
            return
        slot = self.cur % self.size
        self.starts[slot] = self.cur * self.step
        self.points[slot] = _top(self.run, self.cnt, KEEP) if self.cnt else None
        self.run, self.cnt = {}, 0

    def add(self, ts: float, shares: dict[str, float]) -> None:
        p = int(ts // self.step)
        if self.cur is None:
            self.cur = p
        elif p != self.cur:
            self._close()
            self.cur = p
        for name, share in shares.items():
            self.run[name] = self.run.get(name, 0.0) + share
        self.cnt += 1

    def point(self, p: int) -> tuple | None:
        if p == self.cur:
            return _top(self.run, self.cnt, KEEP) if self.cnt else None
        slot = p % self.size
        return self.points[slot] if self.starts[slot] == p * self.step else None


def _merge(points: Iterable[tuple | None]) -> list[list] | None:
    sums: dict[str, float] = {}
    n = 0
    for point in points:
        if point is None:
            continue
        n += 1
        for i in range(0, len(point), 2):
            sums[point[i]] = sums.get(point[i], 0.0) + point[i + 1]
    if not n:
        return None
    flat = _top(sums, n, SHOWN)
    return [[flat[i], round(flat[i + 1], 1)] for i in range(0, len(flat), 2) if flat[i + 1] >= MIN_SHARE]


class TopStore:
    def __init__(self) -> None:
        self._tiers = {name: _Tier(name) for name in TIERS}

    def add(self, ts: float, shares: dict[str, float]) -> None:
        """One scan; an empty dict is a measured minute where nobody worked."""
        for tier in self._tiers.values():
            tier.add(ts, shares)

    def _tier_for(self, step_s: float) -> _Tier:
        if step_s >= TIERS["week"][0]:
            return self._tiers["week"]
        if step_s >= TIERS["day"][0]:
            return self._tiers["day"]
        return self._tiers["minute"]

    def _range(self, tier: _Tier, start: float, end: float) -> list[tuple | None]:
        first, last = int(start // tier.step), int((end - 1) // tier.step)
        return [tier.point(p) for p in range(first, last + 1)]

    def columns(self, step_s: float, start: float, count: int) -> list[list[list] | None]:
        """Leaders of each chart column: ``[[name, percent], ...]``, ``None`` without data."""
        tier = self._tier_for(step_s)
        return [_merge(self._range(tier, start + i * step_s, start + (i + 1) * step_s)) for i in range(count)]

    def window(self, start: float, end: float) -> list[list]:
        """Leaders over a stretch of time (an open problem), from the finest tier that still holds it."""
        minute = self._tiers["minute"]
        newest = minute.cur if minute.cur is not None else 0
        tier = minute if start >= (newest - minute.size + 1) * minute.step else self._tiers["day"]
        return _merge(self._range(tier, start, max(end, start + 1))) or []

    def to_dict(self) -> dict[str, Any]:
        return {
            "version": FORMAT_VERSION,
            "tiers": {
                name: {
                    "starts": list(t.starts),
                    "points": [None if p is None else [round(v, 1) if isinstance(v, float) else v for v in p] for p in t.points],
                    "cur": t.cur,
                    "run": {k: round(v, 1) for k, v in t.run.items()},
                    "cnt": t.cnt,
                }
                for name, t in self._tiers.items()
            },
        }

    @classmethod
    def from_dict(cls, data: Any) -> "TopStore":
        """Restore; anything unusable gives an empty store, never an exception."""
        store = cls()
        try:
            if data.get("version") != FORMAT_VERSION:
                return store
            for name, tier in store._tiers.items():
                saved = data["tiers"][name]
                starts = [int(v) for v in saved["starts"]]
                points = saved["points"]
                if len(starts) != tier.size or len(points) != tier.size:
                    raise ValueError("top tier size mismatch")
                parsed: list[tuple | None] = []
                for p in points:
                    if p is None:
                        parsed.append(None)
                        continue
                    flat: list[Any] = []
                    for i in range(0, len(p) - 1, 2):
                        flat += [sys.intern(str(p[i])), float(p[i + 1])]
                    parsed.append(tuple(flat))
                cur = saved.get("cur")
                run = {sys.intern(str(k)): float(v) for k, v in (saved.get("run") or {}).items()}
                tier.starts, tier.points = starts, parsed
                tier.cur = None if cur is None else int(cur)
                tier.run, tier.cnt = run, int(saved.get("cnt") or 0)
        except Exception:  # noqa: BLE001 - a broken copy costs the leaders, not the start
            return cls()
        return store


def leaders_text(leaders: list[list] | None) -> str:
    return " · ".join(f"{name} {share:.0f} %" for name, share in leaders or [])

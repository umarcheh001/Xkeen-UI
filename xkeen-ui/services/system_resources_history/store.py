"""In-memory ring-buffer history of router resources in three tiers.

Each tier keeps, per metric, two ``array('f')`` rings (average and peak of a
point) with NaN meaning "no data", plus one ``array('q')`` of point start
times shared by the tier.  A ring slot is valid only when its start time equals
the expected start of the point, so gaps need no explicit clearing.  Nothing
here does I/O.
"""

from __future__ import annotations

import math
import statistics
from array import array
from typing import Any, Iterable

NAN = float("nan")

# tier -> (point step in seconds, number of points)
TIERS: dict[str, tuple[int, int]] = {
    "fresh": (15, 240),
    "day": (300, 288),
    "week": (1800, 336),
}

# range id -> (tier, points folded into one column, number of columns)
RANGES: dict[str, tuple[str, int, int]] = {
    "15m": ("fresh", 1, 60),
    "30m": ("fresh", 2, 60),
    "1h": ("fresh", 4, 60),
    "6h": ("day", 1, 72),
    "24h": ("day", 3, 96),
    "7d": ("week", 1, 336),
}

BACK_JUMP_RESET_S = 60
WEEK_SPAN_S = TIERS["week"][0] * TIERS["week"][1]  # a forward gap longer than all the history
FORMAT_VERSION = 1


class _Tier:
    def __init__(self, name: str, metrics: Iterable[str]) -> None:
        self.name = name
        self.step, self.size = TIERS[name]
        self.starts = array("q", [-1]) * self.size
        self.avg: list[array] = []
        self.peak: list[array] = []
        # running (open) point
        self.cur: int | None = None
        self.sum: list[float] = []
        self.cnt: list[int] = []
        self.mx: list[float] = []
        for _ in metrics:
            self.add_metric()

    def add_metric(self) -> None:
        self.avg.append(array("f", [NAN]) * self.size)
        self.peak.append(array("f", [NAN]) * self.size)
        self.sum.append(0.0)
        self.cnt.append(0)
        self.mx.append(NAN)

    def reset(self) -> None:
        self.starts = array("q", [-1]) * self.size
        for i in range(len(self.avg)):
            self.avg[i] = array("f", [NAN]) * self.size
            self.peak[i] = array("f", [NAN]) * self.size
        self._clear_running()
        self.cur = None

    def _clear_running(self) -> None:
        for i in range(len(self.sum)):
            self.sum[i] = 0.0
            self.cnt[i] = 0
            self.mx[i] = NAN

    def _close(self) -> None:
        if self.cur is None:
            return
        slot = self.cur % self.size
        self.starts[slot] = self.cur * self.step
        for i in range(len(self.sum)):
            if self.cnt[i]:
                self.avg[i][slot] = self.sum[i] / self.cnt[i]
                self.peak[i][slot] = self.mx[i]
            else:
                self.avg[i][slot] = NAN
                self.peak[i][slot] = NAN
        self._clear_running()

    def add(self, ts: float, samples: list[float | None], allow_back: bool) -> None:
        p = int(ts // self.step)
        if self.cur is None:
            self.cur = p
        elif p > self.cur or (p < self.cur and not allow_back):
            # forward: normal rollover; backward (clock corrected): close the
            # running point and restart at p, keeping the older history.
            self._close()
            self.cur = p
        for i, v in enumerate(samples):
            if v is None:
                continue
            self.sum[i] += v
            self.cnt[i] += 1
            if not (self.mx[i] >= v):  # also true when mx is NaN
                self.mx[i] = v

    def point(self, p: int, i: int) -> tuple[float, float]:
        if p == self.cur:
            if self.cnt[i]:
                return self.sum[i] / self.cnt[i], self.mx[i]
            return NAN, NAN
        slot = p % self.size
        if self.starts[slot] == p * self.step:
            return self.avg[i][slot], self.peak[i][slot]
        return NAN, NAN

    def valid_points(self, i: int) -> list[float]:
        out: list[float] = []
        for slot in range(self.size):
            point = self.starts[slot] // self.step
            if self.starts[slot] >= 0 and self.cur != point and (self.cur is None or point <= self.cur):
                v = self.avg[i][slot]
                if not math.isnan(v):
                    out.append(v)
        if self.cur is not None and self.cnt[i]:
            out.append(self.sum[i] / self.cnt[i])
        return out


def _clean(value: float) -> float | None:
    return None if math.isnan(value) else value


class HistoryStore:
    def __init__(self, metrics: tuple[str, ...]) -> None:
        self._metrics: list[str] = []
        self._index: dict[str, int] = {}
        self._tiers = {name: _Tier(name, ()) for name in TIERS}
        self._last_ts: float | None = None
        self._since: float | None = None
        for name in metrics:
            self.add_metric(name)

    @property
    def metrics(self) -> tuple[str, ...]:
        return tuple(self._metrics)

    def add_metric(self, name: str) -> None:
        if name in self._index:
            return
        self._index[name] = len(self._metrics)
        self._metrics.append(name)
        for tier in self._tiers.values():
            tier.add_metric()

    def add(self, ts: float, values: dict[str, float | None]) -> None:
        samples: list[float | None] = [None] * len(self._metrics)
        for name, value in values.items():
            i = self._index.get(name)
            if i is None or value is None:
                continue
            try:
                number = float(value)
            except (TypeError, ValueError):
                continue
            if math.isnan(number) or math.isinf(number):
                continue
            samples[i] = number
        fresh = self._tiers["fresh"]
        if self._last_ts is not None and ts - self._last_ts > WEEK_SPAN_S:
            # The clock was set (NTP after boot): what came before was never real time.
            for tier in self._tiers.values():
                tier.reset()
            self._since = None
        elif self._last_ts is not None and ts < self._last_ts - BACK_JUMP_RESET_S:
            fresh.reset()
        for name, tier in self._tiers.items():
            tier.add(ts, samples, allow_back=(name == "fresh"))
        self._last_ts = ts
        if self._since is None or ts < self._since:
            self._since = ts

    def columns(self, range_id: str, now: float) -> dict[str, Any]:
        return self.columns_spec(RANGES[range_id], now)

    def columns_spec(self, spec: tuple[str, int, int], now: float) -> dict[str, Any]:
        """Like :meth:`columns` for any ``(tier, points per column, column count)``."""
        tier_name, fold, count = spec
        tier = self._tiers[tier_name]
        col_step = tier.step * fold
        last_col = int(now // col_step)
        first_col = last_col - count + 1
        metrics: dict[str, dict[str, list[float | None]]] = {}
        for name, i in self._index.items():
            avgs: list[float | None] = []
            maxs: list[float | None] = []
            for col in range(first_col, last_col + 1):
                total = 0.0
                n = 0
                peak = NAN
                for p in range(col * fold, col * fold + fold):
                    a, m = tier.point(p, i)
                    if math.isnan(a):
                        continue
                    total += a
                    n += 1
                    if math.isnan(peak) or m > peak:
                        peak = m
                avgs.append(total / n if n else None)
                maxs.append(_clean(peak))
            metrics[name] = {"avg": avgs, "max": maxs}
        return {
            "step_s": col_step,
            "start": first_col * col_step,
            "metrics": metrics,
            "history_since": self._since,
        }

    def median(self, metric: str, tier: str = "week") -> float | None:
        i = self._index.get(metric)
        if i is None or tier not in self._tiers:
            return None
        points = self._tiers[tier].valid_points(i)
        return float(statistics.median(points)) if points else None

    def memory_bytes(self) -> int:
        total = 0
        for tier in self._tiers.values():
            total += len(tier.starts) * tier.starts.itemsize
            for arr in tier.avg + tier.peak:
                total += len(arr) * arr.itemsize
        return total

    def to_dict(self) -> dict[str, Any]:
        tiers: dict[str, Any] = {}
        for name, tier in self._tiers.items():
            tiers[name] = {
                "starts": list(tier.starts),
                "cur": tier.cur,
                "metrics": {
                    m: {
                        "avg": [_clean(v) for v in tier.avg[i]],
                        "max": [_clean(v) for v in tier.peak[i]],
                        "sum": tier.sum[i],
                        "cnt": tier.cnt[i],
                        "mx": _clean(tier.mx[i]),
                    }
                    for m, i in self._index.items()
                },
            }
        return {
            "version": FORMAT_VERSION,
            "last_ts": self._last_ts,
            "since": self._since,
            "tiers": tiers,
        }

    def with_metrics(self, metrics: Iterable[str]) -> "HistoryStore":
        """Copy for another metric set: common metrics keep their history,
        new ones are empty, the ones not listed are dropped."""
        out = HistoryStore(tuple(metrics))
        out._last_ts = self._last_ts
        out._since = self._since
        for name, tier in self._tiers.items():
            new = out._tiers[name]
            new.starts = array("q", tier.starts)
            new.cur = tier.cur
            for m, j in out._index.items():
                i = self._index.get(m)
                if i is None:
                    continue
                new.avg[j] = array("f", tier.avg[i])
                new.peak[j] = array("f", tier.peak[i])
                new.sum[j] = tier.sum[i]
                new.cnt[j] = tier.cnt[i]
                new.mx[j] = tier.mx[i]
        return out

    @classmethod
    def from_dict(cls, data: dict, metrics: Iterable[str]) -> "HistoryStore":
        """Restore a store; raises ValueError/KeyError/TypeError on bad data."""
        if data.get("version") != FORMAT_VERSION:
            raise ValueError("unsupported history format")
        store = cls(tuple(metrics))
        store._last_ts = data.get("last_ts")
        store._since = data.get("since")
        for name, tier in store._tiers.items():
            saved = data["tiers"][name]
            starts = saved["starts"]
            if len(starts) != tier.size:
                raise ValueError("history tier size mismatch")
            tier.starts = array("q", [int(v) for v in starts])
            cur = saved.get("cur")
            tier.cur = None if cur is None else int(cur)
            for m, i in store._index.items():
                rec = saved["metrics"].get(m)
                if rec is None:
                    continue
                if len(rec["avg"]) != tier.size or len(rec["max"]) != tier.size:
                    raise ValueError("history tier size mismatch")
                tier.avg[i] = array("f", [NAN if v is None else float(v) for v in rec["avg"]])
                tier.peak[i] = array("f", [NAN if v is None else float(v) for v in rec["max"]])
                tier.sum[i] = float(rec.get("sum", 0.0))
                tier.cnt[i] = int(rec.get("cnt", 0))
                mx = rec.get("mx")
                tier.mx[i] = NAN if mx is None else float(mx)
        return store

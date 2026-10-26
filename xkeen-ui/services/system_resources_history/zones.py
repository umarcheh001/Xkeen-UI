"""Fixed severity zones for the router-resources dashboard.

Zone numbers: 0 - normal, 1 - orange (colours the card), 2 - red (counts as a
problem when held long enough).  A value equal to a threshold already belongs
to the higher zone.  ``None`` means "no data".  The thresholds live only here.
"""

from __future__ import annotations

# (orange from, red from)
_FIXED: dict[str, tuple[float, float]] = {
    "cpu": (60.0, 85.0),
    "memory": (75.0, 90.0),
    "link_up": (70.0, 90.0),
    "link_down": (70.0, 90.0),
}
_TEMP: dict[str, tuple[float, float]] = {
    "chip": (80.0, 95.0),
    "wifi": (85.0, 100.0),
}
_QUEUE = (0.7, 1.0)  # multiplied by the number of cores

HOTTER_THAN_USUAL_C = 15.0


def _classify(value: float, orange: float, red: float) -> int:
    if value >= red:
        return 2
    if value >= orange:
        return 1
    return 0


def zone(metric: str, value: float | None, *, cores: int = 1, kind: str | None = None) -> int | None:
    """Zone 0/1/2 of ``value`` for ``metric``; ``None`` without data or for an unknown metric."""
    if value is None:
        return None
    if metric in _FIXED:
        return _classify(value, *_FIXED[metric])
    if metric == "queue":
        n = max(1, int(cores))
        return _classify(value, _QUEUE[0] * n, _QUEUE[1] * n)
    if metric.startswith("temp:") and kind in _TEMP:
        return _classify(value, *_TEMP[kind])
    return None


def hotter_than_usual(value: float, median: float | None) -> int | None:
    """Degrees above the usual (median) temperature when that is 15 or more, else ``None``."""
    if median is None:
        return None
    diff = value - median
    if diff >= HOTTER_THAN_USUAL_C:
        return int(round(diff))
    return None

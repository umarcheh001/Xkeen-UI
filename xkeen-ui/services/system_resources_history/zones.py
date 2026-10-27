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
    "storage": (75.0, 90.0),
    "conntrack": (75.0, 90.0),
}
ZRAM_PRESSURE_SHARE = 0.25  # compressed swap above this share of its ceiling: the router lacks memory
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
    if metric == "online":  # share of the time the internet answered: a gap in it is a failure
        return 0 if value >= 1.0 else 2
    if metric == "queue":
        n = max(1, int(cores))
        return _classify(value, _QUEUE[0] * n, _QUEUE[1] * n)
    if metric.startswith("temp:") and kind in _TEMP:
        return _classify(value, *_TEMP[kind])
    return None


def red_from(metric: str) -> float | None:
    """Percent from which a fixed-threshold metric (``cpu``, ``memory``, ``link_*``) is red."""
    return _FIXED[metric][1] if metric in _FIXED else None


def chart_bands(cores: int = 1) -> dict[str, dict[str, float]]:
    """Scale values from which the big chart paints a segment orange / red, per chart metric.

    ``cpu``, ``memory`` and ``link`` are percents; ``queue`` is in tasks, with ``scale_max``
    (twice the cores) as the top of its scale.
    """
    n = max(1, int(cores))
    return {
        "cpu": {"orange": _FIXED["cpu"][0], "red": _FIXED["cpu"][1]},
        "memory": {"orange": _FIXED["memory"][0], "red": _FIXED["memory"][1]},
        "link": {"orange": _FIXED["link_up"][0], "red": _FIXED["link_up"][1]},
        "queue": {"orange": _QUEUE[0] * n, "red": _QUEUE[1] * n, "scale_max": 2.0 * n},
    }


def zram_pressure(size_bytes: float | None, used_bytes: float | None) -> bool | None:
    """True when zram holds more than a quarter of its ceiling; ``None`` without sizes."""
    if not size_bytes or used_bytes is None:
        return None
    return used_bytes > size_bytes * ZRAM_PRESSURE_SHARE


def temp_bands(kind: str | None) -> dict[str, float] | None:
    """Degrees from which a sensor kind is orange / red, for drawing the scale; ``None`` for an unknown kind."""
    if kind not in _TEMP:
        return None
    return {"orange_c": _TEMP[kind][0], "red_c": _TEMP[kind][1]}


def hotter_than_usual(value: float, median: float | None) -> int | None:
    """Degrees above the usual (median) temperature when that is 15 or more, else ``None``."""
    if median is None:
        return None
    diff = value - median
    if diff >= HOTTER_THAN_USUAL_C:
        return int(round(diff))
    return None

"""Saving and loading of the router-resources history.

The file is written only through ``services.io.atomic`` and read tolerantly:
anything unusable (other format, other tier steps, broken or truncated JSON,
wrong shape) makes that copy be ignored, never an exception.  A different set
of metrics (another router model, another WAN interface) is not a reason to
throw the history away: common metrics keep their history, new ones start
empty, vanished ones are dropped.
"""

from __future__ import annotations

import json
import math
from typing import Any

from services.io.atomic import _atomic_write_json

from .store import FORMAT_VERSION as _STORE_FORMAT_VERSION
from .store import TIERS, HistoryStore

FORMAT_VERSION = 1


def _round(value: Any) -> Any:
    if isinstance(value, float):
        return round(value, 1)
    if isinstance(value, list):
        return [_round(v) for v in value]
    if isinstance(value, dict):
        return {k: _round(v) for k, v in value.items()}
    return value


def _tiers_meta() -> dict[str, list[int]]:
    return {name: [step, size] for name, (step, size) in TIERS.items()}


def save_history(path: str, store: HistoryStore, events: list[dict], *, now: float) -> None:
    dumped = store.to_dict()
    # Point start times and counters are exact integers; only values are rounded.
    dumped["tiers"] = _round(dumped["tiers"])
    payload = {
        "version": FORMAT_VERSION,
        "saved_at": now,
        "metrics": list(store.metrics),
        "tiers": _tiers_meta(),
        "store": dumped,
        "events": list(events),
    }
    _atomic_write_json(path, payload, indent=None)


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _read_one(path: str, metrics: tuple[str, ...]) -> tuple[HistoryStore, list[dict], float] | None:
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return None
        if data.get("version") != FORMAT_VERSION:
            return None
        saved_at = data.get("saved_at")
        if not _is_number(saved_at):
            return None
        if data.get("tiers") != _tiers_meta():
            return None
        saved_metrics = data.get("metrics")
        if not isinstance(saved_metrics, list) or not all(isinstance(m, str) for m in saved_metrics):
            return None
        body = data.get("store")
        if not isinstance(body, dict) or body.get("version") != _STORE_FORMAT_VERSION:
            return None
        restored = HistoryStore.from_dict(body, saved_metrics)
        store = restored if restored.metrics == tuple(metrics) else restored.with_metrics(metrics)
        raw_events = data.get("events")
        events = [e for e in raw_events if isinstance(e, dict)] if isinstance(raw_events, list) else []
        return store, events, float(saved_at)
    except Exception:
        return None


def load_history(
    paths: list[str], metrics: tuple[str, ...]
) -> tuple[HistoryStore, list[dict], float] | None:
    """Return the freshest valid copy among ``paths`` or None.  Never raises."""
    best: tuple[HistoryStore, list[dict], float] | None = None
    for path in paths:
        got = _read_one(path, tuple(metrics))
        if got is not None and (best is None or got[2] > best[2]):
            best = got
    return best

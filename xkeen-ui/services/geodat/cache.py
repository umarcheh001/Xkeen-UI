from __future__ import annotations

"""In-memory cache + inflight de-duplication for geodat helpers.

This is intentionally process-local and best-effort.
"""

import os
import threading
import time
from typing import Any, Dict, Tuple


_GEODAT_CACHE: Dict[Tuple[Any, ...], Tuple[float, Any]] = {}
_GEODAT_CACHE_LOCK = threading.Lock()
_GEODAT_INFLIGHT: Dict[Tuple[Any, ...], threading.Event] = {}
_GEODAT_INFLIGHT_LOCK = threading.Lock()


def _geodat_cache_get(key: Tuple[Any, ...], ttl_s: int) -> Any | None:
    if ttl_s <= 0:
        return None
    now = time.time()
    with _GEODAT_CACHE_LOCK:
        v = _GEODAT_CACHE.get(key)
        if not v:
            return None
        ts, payload = v
        if (now - ts) > ttl_s:
            try:
                del _GEODAT_CACHE[key]
            except Exception:
                pass
            return None
        return payload


def _geodat_cache_set(key: Tuple[Any, ...], payload: Any, ttl_s: int, *, max_items: int = 256) -> None:
    if ttl_s <= 0:
        return
    try:
        with _GEODAT_CACHE_LOCK:
            _GEODAT_CACHE[key] = (time.time(), payload)
            # very small in-memory LRU-ish eviction
            if len(_GEODAT_CACHE) > max_items:
                # delete ~25% oldest; sort a snapshot to avoid holding the lock
                # during an expensive sort - snapshot is already under the lock
                try:
                    items = sorted(_GEODAT_CACHE.items(), key=lambda kv: kv[1][0])
                    n_del = max(1, int(max_items * 0.25))
                    for k, _ in items[:n_del]:
                        _GEODAT_CACHE.pop(k, None)
                except Exception:
                    pass
    except Exception:
        return


def _geodat_inflight_acquire(key: Tuple[Any, ...]) -> tuple[threading.Event, bool]:
    """Return (event, is_leader). Only leader should run the expensive command."""
    try:
        with _GEODAT_INFLIGHT_LOCK:
            ev = _GEODAT_INFLIGHT.get(key)
            if ev is not None:
                return ev, False
            ev = threading.Event()
            _GEODAT_INFLIGHT[key] = ev
            return ev, True
    except Exception:
        # Fail open: caller becomes leader.
        return threading.Event(), True


def _geodat_inflight_release(key: Tuple[Any, ...], ev: threading.Event) -> None:
    try:
        with _GEODAT_INFLIGHT_LOCK:
            _GEODAT_INFLIGHT.pop(key, None)
    except Exception:
        pass
    try:
        ev.set()
    except Exception:
        pass


def _geodat_page_window() -> int:
    """Window size for paging cache (must be <=500)."""
    raw = (os.getenv('XKEEN_GEODAT_PAGE_WINDOW', '') or '').strip()
    try:
        v = int(float(raw))
    except Exception:
        v = 500
    # keep within 50..500 (plan limit <=500)
    return max(50, min(v, 500))

from __future__ import annotations

"""In-memory cache + inflight de-duplication for geodat helpers.

This is intentionally process-local and best-effort.
"""

import os
import threading
import time
from collections import OrderedDict
from typing import Any, Dict, Tuple

from services.cache_size import cache_value_size

MAX_GEODAT_CACHE_BYTES = 8 * 1024 * 1024
_GEODAT_CACHE: OrderedDict[Tuple[Any, ...], Tuple[float, float, Any, int]] = OrderedDict()
_GEODAT_CACHE_BYTES = 0
_GEODAT_CACHE_LOCK = threading.Lock()
_GEODAT_INFLIGHT: Dict[Tuple[Any, ...], threading.Event] = {}
_GEODAT_INFLIGHT_LOCK = threading.Lock()


def clear_geodat_cache() -> int:
    """Drop completed geodat payloads without disturbing in-flight work."""

    global _GEODAT_CACHE_BYTES
    with _GEODAT_CACHE_LOCK:
        count = len(_GEODAT_CACHE)
        _GEODAT_CACHE.clear()
        _GEODAT_CACHE_BYTES = 0
        return count


def _geodat_cache_get(key: Tuple[Any, ...], ttl_s: int) -> Any | None:
    global _GEODAT_CACHE_BYTES
    if ttl_s <= 0:
        return None
    now = time.time()
    with _GEODAT_CACHE_LOCK:
        v = _GEODAT_CACHE.get(key)
        if not v:
            return None
        ts, expires_at, payload, size = v
        if (now - ts) > ttl_s or now > expires_at:
            del _GEODAT_CACHE[key]
            _GEODAT_CACHE_BYTES -= size
            return None
        _GEODAT_CACHE.move_to_end(key)
        return payload


def _geodat_cache_set(key: Tuple[Any, ...], payload: Any, ttl_s: int, *, max_items: int = 256) -> None:
    global _GEODAT_CACHE_BYTES
    if ttl_s <= 0:
        return
    size = cache_value_size((key, payload), MAX_GEODAT_CACHE_BYTES)
    now = time.time()
    try:
        with _GEODAT_CACHE_LOCK:
            for old_key, (_, expires_at, _, old_size) in list(_GEODAT_CACHE.items()):
                if now > expires_at:
                    del _GEODAT_CACHE[old_key]
                    _GEODAT_CACHE_BYTES -= old_size
            old = _GEODAT_CACHE.pop(key, None)
            if old is not None:
                _GEODAT_CACHE_BYTES -= old[3]
            if size > MAX_GEODAT_CACHE_BYTES:
                return
            _GEODAT_CACHE[key] = (now, now + ttl_s, payload, size)
            _GEODAT_CACHE_BYTES += size
            while len(_GEODAT_CACHE) > max(1, max_items) or _GEODAT_CACHE_BYTES > MAX_GEODAT_CACHE_BYTES:
                _, (_, _, _, old_size) = _GEODAT_CACHE.popitem(last=False)
                _GEODAT_CACHE_BYTES -= old_size
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
        v = 200
    # keep within 50..500 (plan limit <=500)
    return max(50, min(v, 500))

"""Short-lived Keenetic device-map cache for Mihomo connection enrichment."""

from __future__ import annotations

import threading
import time
from typing import Any, Callable, Mapping

from services.xray_device_names import get_xray_device_names_state


DEFAULT_DEVICE_MAP_TTL_SECONDS = 30.0
_LOCK = threading.Lock()
_CACHED_AT = 0.0
_CACHED_MAP: dict[str, Any] = {}
_CACHE_READY = False


def get_mihomo_clash_device_map(
    *,
    ttl_seconds: float = DEFAULT_DEVICE_MAP_TTL_SECONDS,
    clock: Callable[[], float] = time.monotonic,
    state_factory: Callable[..., Mapping[str, Any]] = get_xray_device_names_state,
) -> dict[str, Any]:
    """Return one process-wide cached map without querying RCI per frame."""

    global _CACHED_AT, _CACHED_MAP, _CACHE_READY
    now = float(clock())
    ttl = max(1.0, float(ttl_seconds))
    with _LOCK:
        if _CACHE_READY and now - _CACHED_AT < ttl:
            return dict(_CACHED_MAP)
        try:
            state = state_factory(refresh_router=True)
            discovered = state.get("device_map") if isinstance(state, Mapping) else {}
            next_map = dict(discovered) if isinstance(discovered, Mapping) else {}
        except Exception:
            next_map = {}
        _CACHED_AT = now
        _CACHED_MAP = next_map
        _CACHE_READY = True
        return dict(_CACHED_MAP)


def reset_mihomo_clash_device_map_cache() -> None:
    global _CACHED_AT, _CACHED_MAP, _CACHE_READY
    with _LOCK:
        _CACHED_AT = 0.0
        _CACHED_MAP = {}
        _CACHE_READY = False


__all__ = [
    "DEFAULT_DEVICE_MAP_TTL_SECONDS",
    "get_mihomo_clash_device_map",
    "reset_mihomo_clash_device_map_cache",
]

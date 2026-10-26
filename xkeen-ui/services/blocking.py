"""Long processor work that must not hold the panel's gevent loop.

Under ``gevent.monkey.patch_all`` every request shares one loop: a second of
hashing or unpacking in one of them stops all the others for that second.
Such work goes to the hub's pool of real threads; hashlib and zlib let go of
the GIL, so the loop keeps answering meanwhile. Without gevent (tests, tools)
the call simply runs here.
"""

from __future__ import annotations

from typing import Any, Callable, TypeVar

T = TypeVar("T")


def _threading_patched() -> bool:
    try:
        from gevent import monkey
    except ImportError:
        return False
    return bool(monkey.is_module_patched("threading"))


def _hub() -> Any:
    import gevent

    return gevent.get_hub()


def run_blocking(fn: Callable[..., T], *args: Any, **kwargs: Any) -> T:
    if not _threading_patched():
        return fn(*args, **kwargs)
    return _hub().threadpool.apply(fn, args, kwargs)

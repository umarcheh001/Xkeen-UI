"""Network helpers.

PR15: Centralize blocking network calls behind a small thread pool so the UI
server (often single-threaded on routers) doesn't freeze.

Keep this module dependency-free.
"""

from __future__ import annotations

import os
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError
from typing import Any, Callable


_MAX_WORKERS_ENV = os.environ.get("XKEEN_NET_MAX_WORKERS", "4")
try:
    _MAX_WORKERS = max(1, min(int(_MAX_WORKERS_ENV or "4"), 16))
except Exception:
    _MAX_WORKERS = 4


# Shared pool for all network calls.
NET_EXECUTOR = ThreadPoolExecutor(max_workers=_MAX_WORKERS)


def net_call(fn: Callable[[], Any], wait_seconds: float):
    """Run a blocking function in a worker thread and wait up to wait_seconds.

    Raises:
        TimeoutError: if the call didn't finish in time.
        Any exception raised by ``fn`` is re-raised.
    """
    fut = NET_EXECUTOR.submit(fn)
    try:
        return fut.result(timeout=max(0.1, float(wait_seconds)))
    except FutureTimeoutError as e:
        raise TimeoutError("timeout") from e

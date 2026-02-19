"""Access log middleware.

This module keeps request logging out of app.py so the main module can stay
focused on app composition.

Design goals:
- Logging is **best-effort**: it must never affect request/response flow.
- Behavior is intentionally conservative (no cookies/auth headers in log line).
"""

from __future__ import annotations

import time
from typing import Callable, Iterable, Optional


def init_access_log(
    app,
    enabled_fn: Callable[[], bool],
    logger_fn: Callable[[], object],
    *,
    skip_prefixes: Iterable[str] = ("/static/", "/ws/"),
    include_ms: bool = True,
):
    """Attach before/after request hooks for access logging.

    Args:
        app: Flask app instance.
        enabled_fn: callable returning True when access logging is enabled.
        logger_fn: callable returning a logger with .info().
        skip_prefixes: path prefixes to exclude from logging.
        include_ms: whether to include request duration when available.

    Returns:
        (before_handler, after_handler)
    """

    # Import inside to avoid hard dependency during module import.
    from flask import request, g  # type: ignore

    _skip = tuple(str(p or "") for p in (skip_prefixes or ()))

    def _before_request():
        try:
            g._xkeen_t0 = time.time()
        except Exception:
            pass
        return None

    def _after_request(response):
        try:
            if not enabled_fn():
                return response

            path = request.path or ""
            # Skip noisy assets + websocket endpoints.
            try:
                for pref in _skip:
                    if pref and path.startswith(pref):
                        return response
            except Exception:
                pass

            method = request.method or ""
            status = getattr(response, "status_code", 0) or 0
            client = request.headers.get("X-Forwarded-For") or request.remote_addr or ""

            dt_ms: Optional[int] = None
            if include_ms:
                try:
                    t0 = getattr(g, "_xkeen_t0", None)
                    if t0:
                        dt_ms = int((time.time() - float(t0)) * 1000.0)
                except Exception:
                    dt_ms = None

            if dt_ms is None:
                line = f"{client} {method} {path} -> {status}"
            else:
                line = f"{client} {method} {path} -> {status} ({dt_ms}ms)"

            try:
                lg = logger_fn()
                # logger_fn() is expected to return logging.Logger, but keep it duck-typed.
                if lg is not None:
                    getattr(lg, "info")(line)
            except Exception:
                pass
        except Exception:
            # Logging must never affect response.
            pass
        return response

    # Register as middleware hooks.
    try:
        app.before_request(_before_request)
    except Exception:
        pass
    try:
        app.after_request(_after_request)
    except Exception:
        pass

    return _before_request, _after_request

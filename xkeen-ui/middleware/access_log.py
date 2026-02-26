"""Access log middleware.

This module keeps request logging out of app.py so the main module can stay
focused on app composition.

Design goals:
- Logging is **best-effort**: it must never affect request/response flow.
- Behavior is intentionally conservative (no cookies/auth headers in log line).
"""

from __future__ import annotations

import os
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

    # Best-effort: if core logger is configured, we can leave breadcrumbs
    # without ever breaking request flow.
    try:
        from core.logging import core_log as _core_log  # type: ignore
    except Exception:  # noqa: BLE001
        _core_log = None  # type: ignore

    # Avoid log spam: cap internal error reports.
    _err_budget = int(os.environ.get("XKEEN_ACCESS_LOG_ERR_BUDGET", "5") or 5)
    _err_count = {"n": 0}

    def _warn(msg: str, **extra) -> None:
        if _core_log is None:
            return
        if _err_count["n"] >= _err_budget:
            return
        _err_count["n"] += 1
        try:
            _core_log("warning", msg, **extra)
        except Exception:  # noqa: BLE001
            return

    _skip = tuple(str(p or "") for p in (skip_prefixes or ()))

    def _before_request():
        try:
            g._xkeen_t0 = time.time()
        except Exception as e:  # noqa: BLE001
            _warn("access_log before_request failed", error=str(e))
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
            except Exception as e:  # noqa: BLE001
                _warn("access_log skip_prefix check failed", error=str(e), path=path)

            method = request.method or ""
            status = getattr(response, "status_code", 0) or 0
            client = request.headers.get("X-Forwarded-For") or request.remote_addr or ""

            dt_ms: Optional[int] = None
            if include_ms:
                try:
                    t0 = getattr(g, "_xkeen_t0", None)
                    if t0:
                        dt_ms = int((time.time() - float(t0)) * 1000.0)
                except Exception as e:  # noqa: BLE001
                    dt_ms = None
                    _warn("access_log duration calc failed", error=str(e))

            if dt_ms is None:
                line = f"{client} {method} {path} -> {status}"
            else:
                line = f"{client} {method} {path} -> {status} ({dt_ms}ms)"

            try:
                lg = logger_fn()
                # logger_fn() is expected to return logging.Logger, but keep it duck-typed.
                if lg is not None:
                    getattr(lg, "info")(line)
            except Exception as e:  # noqa: BLE001
                _warn("access_log logger_fn/info failed", error=str(e))
        except Exception as e:  # noqa: BLE001
            # Logging must never affect response.
            _warn("access_log after_request failed", error=str(e))
        return response

    # Register as middleware hooks.
    try:
        app.before_request(_before_request)
    except Exception as e:  # noqa: BLE001
        _warn("access_log hook before_request attach failed", error=str(e))
    try:
        app.after_request(_after_request)
    except Exception as e:  # noqa: BLE001
        _warn("access_log hook after_request attach failed", error=str(e))

    return _before_request, _after_request

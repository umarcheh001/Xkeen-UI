"""Common JSON error helpers for routes.

Multiple route modules historically had their own `error_response()`.
Centralizing it reduces duplication and keeps response format consistent.
"""

from __future__ import annotations

from typing import Any, Dict, Mapping

from flask import current_app, jsonify


def error_response(message: str, status: int = 400, *, ok: bool | None = None, **extra: Any):
    """Return JSON error response compatible with historical app.api_error.

    Payload format:
      {"error": "...", "ok": false?, ...extra}
    """
    payload: Dict[str, Any] = {"error": message}
    if ok is not None:
        payload["ok"] = ok
    if extra:
        payload.update(extra)
    return jsonify(payload), status


def log_route_exception(tag: str, **extra: Any) -> None:
    """Best-effort exception logging for API handlers.

    Call this from an ``except`` block. It logs the active traceback without
    ever failing the request path if logging itself is unavailable.
    """
    try:
        logger = current_app.logger
    except Exception:
        logger = None
    if logger is None:
        return
    try:
        if extra:
            logger.exception("%s | %r", str(tag or "route_error"), extra)
        else:
            logger.exception("%s", str(tag or "route_error"))
    except Exception:
        pass


def exception_response(
    message: str,
    status: int = 500,
    *,
    code: str | None = None,
    hint: str | None = None,
    ok: bool | None = None,
    exc: BaseException | None = None,
    log_tag: str | None = None,
    log_extra: Mapping[str, Any] | None = None,
    **extra: Any,
):
    """Return a sanitized JSON error response and log the active exception."""
    if exc is not None:
        try:
            log_route_exception(str(log_tag or code or "route_exception"), **dict(log_extra or {}))
        except Exception:
            pass
    if code and "code" not in extra:
        extra["code"] = str(code)
    if hint and "hint" not in extra:
        extra["hint"] = str(hint)
    return error_response(message, status, ok=ok, **extra)

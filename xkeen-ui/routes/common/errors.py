"""Common JSON error helpers for routes.

Multiple route modules historically had their own `error_response()`.
Centralizing it reduces duplication and keeps response format consistent.
"""

from __future__ import annotations

from typing import Any, Dict

from flask import jsonify


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

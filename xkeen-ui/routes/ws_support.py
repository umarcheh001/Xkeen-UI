"""WebSocket support helper API routes.

PR11: move WS helper endpoints out of app.py.

Contains:
- POST /api/ws-token : issue one-time WS token (scope: pty/cmd)
- POST /api/ws-debug : frontend sends debug events to ws.log

Important: keep URL paths and response schema stable.
"""

from __future__ import annotations

from typing import Any, Dict

from flask import Blueprint, jsonify, request

from services.ws_debug import ws_debug
from services.ws_tokens import WS_TOKEN_SCOPES, issue_ws_token


def _api_error(message: str, status: int = 400, *, ok: bool | None = None):
    """Local copy of api_error() to avoid circular imports.

    Must match app.api_error() response schema:
      {"error": "...", "ok": false?}
    """
    payload: Dict[str, Any] = {"error": message}
    if ok is not None:
        payload["ok"] = ok
    return jsonify(payload), status


def create_ws_support_blueprint() -> Blueprint:
    bp = Blueprint("ws_support", __name__)

    @bp.post("/api/ws-token")
    def api_ws_token():
        # Requires login + CSRF (enforced by global auth guard)
        ttl = 60
        scope = "pty"
        try:
            data = request.get_json(silent=True) or {}
            if isinstance(data, dict) and data.get("ttl"):
                ttl = max(10, min(300, int(data.get("ttl"))))
            if isinstance(data, dict) and data.get("scope"):
                scope = str(data.get("scope") or "pty").strip().lower()
        except Exception:
            ttl = 60
            scope = "pty"

        if scope not in WS_TOKEN_SCOPES:
            scope = "pty"

        token = issue_ws_token(scope=scope, ttl_seconds=ttl)
        return jsonify({"ok": True, "token": token, "ttl": ttl, "scope": scope}), 200

    @bp.post("/api/ws-debug")
    def api_ws_debug():
        """Accept debug events from frontend and write them to ws.log.

        body JSON: { "msg": "...", "extra": { ... } }
        """
        data = request.get_json(silent=True) or {}
        if not isinstance(data, dict):
            return _api_error("invalid payload", 400, ok=False)
        msg = data.get("msg", "")
        extra = data.get("extra") or {}
        if not isinstance(extra, dict):
            extra = {"extra": str(extra)}
        try:
            extra["remote_addr"] = request.remote_addr or "unknown"
        except Exception:
            extra["remote_addr"] = "unknown"
        ws_debug("FRONTEND: " + str(msg), **extra)
        return jsonify({"ok": True}), 200

    return bp

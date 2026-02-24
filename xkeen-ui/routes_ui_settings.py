"""UI settings API (server-side persisted preferences).

Commit 2: expose feature-neutral endpoints so the UI can start reading/writing
settings later without changing any existing behavior today.

Endpoints:
  - GET   /api/ui-settings
  - PATCH /api/ui-settings

Auth/CSRF:
  - Protected by the global auth guard in services/auth_setup.py.
  - PATCH requires X-CSRF-Token (like other /api mutating endpoints).
"""

from __future__ import annotations

from typing import Any

from flask import Blueprint, jsonify, request

from routes.common.errors import error_response
from services.ui_settings import load_settings, patch_settings


def create_ui_settings_blueprint() -> Blueprint:
    bp = Blueprint("ui_settings", __name__)

    @bp.get("/api/ui-settings")
    def api_ui_settings_get():
        """Return effective UI settings (defaults merged with persisted values)."""
        try:
            cfg = load_settings()
        except Exception as e:  # noqa: BLE001
            return error_response(f"failed to load settings: {e}", 500, ok=False)
        return jsonify({"ok": True, "settings": cfg}), 200

    @bp.patch("/api/ui-settings")
    def api_ui_settings_patch():
        """Deep-merge patch into settings and persist to disk."""
        payload: Any = request.get_json(silent=True)
        if payload is None:
            # Empty body or invalid JSON.
            return error_response("invalid json", 400, ok=False)
        if not isinstance(payload, dict):
            return error_response("payload must be an object", 400, ok=False)

        try:
            cfg = patch_settings(payload)
        except Exception as e:  # noqa: BLE001
            return error_response(f"failed to save settings: {e}", 500, ok=False)
        return jsonify({"ok": True, "settings": cfg}), 200

    return bp

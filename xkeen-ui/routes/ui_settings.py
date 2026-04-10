"""UI settings API (server-side persisted preferences).

This module is the new home for UI settings routes as part of the gradual
refactor into the `routes/` package.

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

from routes.common.errors import error_response, exception_response
from services import get_ui_settings_store
from services.ui_settings import UISettingsValidationError


def create_ui_settings_blueprint() -> Blueprint:
    """Create blueprint for /api/ui-settings endpoints (no behavior change)."""

    bp = Blueprint("ui_settings", __name__)

    @bp.get("/api/ui-settings")
    def api_ui_settings_get():
        """Return effective UI settings (defaults merged with persisted values)."""
        try:
            cfg = get_ui_settings_store().load()
        except Exception as e:  # noqa: BLE001
            return exception_response(
                "Не удалось загрузить настройки интерфейса.",
                500,
                ok=False,
                code="settings_load_failed",
                hint="Подробности смотрите в server logs.",
                exc=e,
                log_tag="ui_settings.load_failed",
            )
        return jsonify({"ok": True, "settings": cfg}), 200

    @bp.patch("/api/ui-settings")
    def api_ui_settings_patch():
        """Deep-merge patch into settings and persist to disk."""
        # Hard guard against accidentally sending huge payloads.
        try:
            if request.content_length and int(request.content_length) > 64 * 1024:
                return error_response("payload too large", 400, ok=False)
        except Exception:
            # If headers are weird, continue; downstream validation will still protect storage.
            pass

        payload: Any = request.get_json(silent=True)
        if payload is None:
            # Empty body or invalid JSON.
            return error_response("invalid json", 400, ok=False)
        if not isinstance(payload, dict):
            return error_response("payload must be an object", 400, ok=False)

        try:
            cfg, report = get_ui_settings_store().patch(payload)
        except UISettingsValidationError as e:
            # Predictable client feedback for bad patches.
            return error_response(
                "validation_error",
                400,
                ok=False,
                code=str(e) or "bad_patch",
                errors=getattr(e, "errors", []) or [],
            )
        except Exception as e:  # noqa: BLE001
            return exception_response(
                "Не удалось сохранить настройки интерфейса.",
                500,
                ok=False,
                code="settings_save_failed",
                hint="Подробности смотрите в server logs.",
                exc=e,
                log_tag="ui_settings.save_failed",
            )

        # Client can ignore report; it is helpful for debugging.
        resp: dict[str, Any] = {"ok": True, "settings": cfg}
        if isinstance(report, dict) and (report.get("warnings") or report.get("errors")):
            resp["report"] = report
        return jsonify(resp), 200

    return bp

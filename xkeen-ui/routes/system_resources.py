from __future__ import annotations

from flask import Blueprint, jsonify

from routes.common.errors import error_response
from services.system_resources import sample_system_resources


def create_system_resources_blueprint() -> Blueprint:
    bp = Blueprint("system_resources", __name__)

    @bp.get("/api/system/resources")
    def api_system_resources():
        try:
            payload = sample_system_resources()
        except (OSError, ValueError):
            return error_response(
                "Мониторинг ресурсов недоступен на этом устройстве.",
                503,
                ok=False,
                code="system_resources_unavailable",
                retryable=True,
            )
        payload["ok"] = True
        response = jsonify(payload)
        response.headers["Cache-Control"] = "no-store"
        return response, 200

    return bp

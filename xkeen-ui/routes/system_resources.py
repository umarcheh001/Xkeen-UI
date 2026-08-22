from __future__ import annotations

from flask import Blueprint, jsonify

from routes.common.errors import error_response
from services.router_diagnostics import (
    RciUnavailable,
    cached_router_diagnostics,
    sample_router_processes,
)
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
        try:
            payload["router"] = cached_router_diagnostics()
        except Exception:  # noqa: BLE001 - optional router telemetry must not hide procfs metrics
            payload["router"] = {
                "schema_version": 1,
                "sampled_at": payload.get("sampled_at"),
                "freshness": {"state": "unavailable", "age_seconds": 0, "stale_after_seconds": 15},
                "rci": {"available": False, "state": "unavailable"},
                "internet": {"available": False},
                "conntrack": {"available": False},
                "interfaces": {"available": False, "count": 0, "items": [], "truncated": False},
            }
        payload["ok"] = True
        response = jsonify(payload)
        response.headers["Cache-Control"] = "no-store"
        return response, 200

    @bp.get("/api/system/processes")
    def api_system_processes():
        try:
            payload = sample_router_processes()
        except RciUnavailable:
            return error_response(
                "Список процессов недоступен через RCI.",
                503,
                ok=False,
                code="router_processes_unavailable",
                retryable=True,
            )
        payload["ok"] = True
        response = jsonify(payload)
        response.headers["Cache-Control"] = "no-store"
        return response, 200

    return bp

"""Xkeen lists API routes (ports / excludes).

PR13: moved /api/xkeen/* endpoints out of app.py.

Important: keep URL paths and response schema stable.
"""

from __future__ import annotations

from typing import Any, Callable

from flask import Blueprint, jsonify, request

from services.command_jobs import create_command_job
from services.xkeen_lists import (
    KIND_IP_EXCLUDE,
    KIND_CONFIG,
    KIND_PORT_EXCLUDE,
    KIND_PORT_PROXYING,
    get_list_content,
    set_list_content,
)


def _get_json_payload() -> dict:
    return request.get_json(silent=True) or {}


def _is_true_flag(value: Any) -> bool:
    try:
        raw = str(value or "").strip().lower()
    except Exception:
        raw = ""
    return raw in ("1", "true", "yes", "on", "y")


def create_xkeen_lists_blueprint(restart_xkeen: Callable[..., Any]) -> Blueprint:
    """Create blueprint that serves /api/xkeen/*.lst endpoints.

    ``restart_xkeen`` must be a callable compatible with restart_xkeen(source="...") -> bool.
    """
    bp = Blueprint("xkeen_lists", __name__)

    def _restart_response(payload: dict, source: str):
        restart_flag = bool(payload.get("restart", True))
        async_flag = _is_true_flag(request.args.get("async", None))

        if restart_flag and async_flag:
            try:
                job = create_command_job(flag="-restart", stdin_data=None, cmd=None, use_pty=True)
                return jsonify({
                    "ok": True,
                    "restarted": False,
                    "restart_queued": True,
                    "restart_job_id": job.id,
                }), 202
            except Exception as e:
                return jsonify({"ok": False, "error": f"failed to schedule restart job: {e}"}), 500

        restarted = restart_flag and restart_xkeen(source=source)
        return jsonify({"ok": True, "restarted": restarted}), 200

    # ----- port-proxying -----

    @bp.get("/api/xkeen/port-proxying")
    def api_get_port_proxying():
        content = get_list_content(KIND_PORT_PROXYING)
        return jsonify({"content": content}), 200

    @bp.post("/api/xkeen/port-proxying")
    def api_set_port_proxying():
        payload = _get_json_payload()
        content = payload.get("content", "")
        set_list_content(KIND_PORT_PROXYING, content)
        return _restart_response(payload, "port-proxying")

    # ----- port-exclude -----

    @bp.get("/api/xkeen/port-exclude")
    def api_get_port_exclude():
        content = get_list_content(KIND_PORT_EXCLUDE)
        return jsonify({"content": content}), 200

    @bp.post("/api/xkeen/port-exclude")
    def api_set_port_exclude():
        payload = _get_json_payload()
        content = payload.get("content", "")
        set_list_content(KIND_PORT_EXCLUDE, content)
        return _restart_response(payload, "port-exclude")

    # ----- ip-exclude -----

    @bp.get("/api/xkeen/ip-exclude")
    def api_get_ip_exclude():
        content = get_list_content(KIND_IP_EXCLUDE)
        return jsonify({"content": content}), 200

    @bp.post("/api/xkeen/ip-exclude")
    def api_set_ip_exclude():
        payload = _get_json_payload()
        content = payload.get("content", "")
        set_list_content(KIND_IP_EXCLUDE, content)
        return _restart_response(payload, "ip-exclude")


    # ----- xkeen config (xkeen.json) -----

    @bp.get("/api/xkeen/config")
    def api_get_xkeen_config():
        content = get_list_content(KIND_CONFIG)
        return jsonify({"content": content}), 200

    @bp.post("/api/xkeen/config")
    def api_set_xkeen_config():
        payload = _get_json_payload()
        content = payload.get("content", "")
        set_list_content(KIND_CONFIG, content)
        return _restart_response(payload, "xkeen-config")

    return bp

"""Xkeen lists API routes (ports / excludes).

PR13: moved /api/xkeen/* endpoints out of app.py.

Important: keep URL paths and response schema stable.
"""

from __future__ import annotations

from typing import Any, Callable

from flask import Blueprint, jsonify, request

from services.xkeen_lists import (
    KIND_IP_EXCLUDE,
    KIND_PORT_EXCLUDE,
    KIND_PORT_PROXYING,
    get_list_content,
    set_list_content,
)


def _get_json_payload() -> dict:
    return request.get_json(silent=True) or {}


def create_xkeen_lists_blueprint(restart_xkeen: Callable[..., Any]) -> Blueprint:
    """Create blueprint that serves /api/xkeen/*.lst endpoints.

    ``restart_xkeen`` must be a callable compatible with restart_xkeen(source="...") -> bool.
    """
    bp = Blueprint("xkeen_lists", __name__)

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
        restart_flag = bool(payload.get("restart", True))
        restarted = restart_flag and restart_xkeen(source="port-proxying")
        return jsonify({"ok": True, "restarted": restarted}), 200

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
        restart_flag = bool(payload.get("restart", True))
        restarted = restart_flag and restart_xkeen(source="port-exclude")
        return jsonify({"ok": True, "restarted": restarted}), 200

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
        restart_flag = bool(payload.get("restart", True))
        restarted = restart_flag and restart_xkeen(source="ip-exclude")
        return jsonify({"ok": True, "restarted": restarted}), 200

    return bp

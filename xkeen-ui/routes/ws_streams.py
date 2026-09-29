# -*- coding: utf-8 -*-
"""WebSocket streaming endpoints.

PR16: moved from app.py into a blueprint.
URL/methods/payloads are kept intact.
"""

from __future__ import annotations

import json
import os
from typing import Any

from flask import Blueprint, current_app, request

from services.auth_setup import auth_is_configured, _is_logged_in
from services.ws_debug import ws_debug
from services.ws_tokens import validate_ws_token

ws_streams_bp = Blueprint("ws_streams", __name__)


def _module_active(module_id: str) -> bool:
    activation = current_app.extensions.get("xkeen.module_activation", {})
    return module_id in set(activation.get("active_module_ids", []))


def create_ws_streams_blueprint() -> Blueprint:
    return ws_streams_bp


def _ws_send(ws: Any, payload: dict) -> bool:
    try:
        ws.send(json.dumps(payload, ensure_ascii=False))
        return True
    except Exception:
        return False


@ws_streams_bp.route("/ws/xray-logs")
def ws_xray_logs():
    """WebSocket-стрим логов Xray (legacy payloads)."""
    if not _module_active("engine.xray"):
        return "Not Found", 404
    from services.log_filter import build_line_matcher as _build_line_matcher
    from services.ws_tail import stream_xray_logs_ws
    from services.xray_log_api import (
        adjust_log_timezone,
        resolve_xray_log_path_for_ws as _resolve_xray_log_path_for_ws,
        tail_lines,
    )
    file_name = request.args.get("file", "error")
    filter_expr = request.args.get("filter")
    client_ip = request.remote_addr or "unknown"

    try:
        max_lines = int((request.args.get("max_lines", "800") or "800").strip())
    except Exception:
        max_lines = 800
    max_lines = max(50, min(5000, int(max_lines or 800)))

    ws_debug(
        "ws_xray_logs: handler called",
        client=client_ip,
        file=file_name,
        max_lines=max_lines,
        filter=bool(filter_expr),
    )

    ws = request.environ.get("wsgi.websocket")
    if ws is None:
        ws_debug("ws_xray_logs: no WebSocket in environ, returning 400", path=request.path)
        return "Expected WebSocket", 400

    token = (request.args.get("token") or "").strip()
    if not validate_ws_token(token, scope="logs"):
        _ws_send(ws, {"type": "error", "error": "unauthorized"})
        try:
            ws.close()
        except Exception:
            pass
        return ""

    # Defense in depth: WS endpoints must be authenticated (auth_guard handles it too).
    if auth_is_configured() and not _is_logged_in():
        _ws_send(ws, {"type": "error", "error": "unauthorized"})
        try:
            ws.close()
        except Exception:
            pass
        return ""

    path = _resolve_xray_log_path_for_ws(file_name)
    ws_debug("ws_xray_logs: resolved log path", path=path)

    if not path or not os.path.isfile(path):
        ws_debug("ws_xray_logs: logfile not found", path=path)
        _ws_send(ws, {"type": "init", "lines": [], "error": "logfile not found"})
        try:
            ws.close()
        except Exception:
            pass
        return ""

    stream_xray_logs_ws(
        ws,
        path=path,
        max_lines=max_lines,
        tail_lines=tail_lines,
        adjust_log_timezone=adjust_log_timezone,
        line_matcher=_build_line_matcher(filter_expr),
        ws_debug=ws_debug,
        client_ip=client_ip,
    )
    return ""


@ws_streams_bp.route("/ws/xray-logs2")
def ws_xray_logs2():
    """WebSocket-стрим логов Xray (v2 protocol: switch/clear/pause without reconnect)."""
    if not _module_active("engine.xray"):
        return "Not Found", 404
    from services.log_filter import build_line_matcher as _build_line_matcher
    from services.ws_logs2 import stream_xray_logs_ws2
    from services.xray_log_api import (
        adjust_log_timezone,
        resolve_xray_log_path_for_ws as _resolve_xray_log_path_for_ws,
        tail_lines,
    )
    file_name = request.args.get("file", "error")
    filter_expr = request.args.get("filter")
    client_ip = request.remote_addr or "unknown"

    try:
        max_lines = int((request.args.get("max_lines", "800") or "800").strip())
    except Exception:
        max_lines = 800
    max_lines = max(50, min(5000, int(max_lines or 800)))

    ws_debug(
        "ws_xray_logs2: handler called",
        client=client_ip,
        file=file_name,
        max_lines=max_lines,
        filter=bool(filter_expr),
    )

    ws = request.environ.get("wsgi.websocket")
    if ws is None:
        ws_debug("ws_xray_logs2: no WebSocket in environ, returning 400", path=request.path)
        return "Expected WebSocket", 400

    token = (request.args.get("token") or "").strip()
    if not validate_ws_token(token, scope="logs"):
        _ws_send(ws, {"type": "error", "error": "unauthorized"})
        try:
            ws.close()
        except Exception:
            pass
        return ""

    # Defense in depth: WS endpoints must be authenticated (auth_guard handles it too).
    if auth_is_configured() and not _is_logged_in():
        _ws_send(ws, {"type": "error", "error": "unauthorized"})
        try:
            ws.close()
        except Exception:
            pass
        return ""

    stream_xray_logs_ws2(
        ws,
        initial_file=file_name,
        initial_filter=filter_expr,
        max_lines=max_lines,
        resolve_path=_resolve_xray_log_path_for_ws,
        tail_lines=tail_lines,
        adjust_log_timezone=adjust_log_timezone,
        build_line_matcher=_build_line_matcher,
        ws_debug=ws_debug,
        client_ip=client_ip,
    )
    return ""


@ws_streams_bp.route("/ws/devtools-logs")
def ws_devtools_logs():
    """WebSocket tail -f for DevTools logs (legacy payloads)."""
    if not _module_active("tool.advanced-diagnostics"):
        return "Not Found", 404
    from services import devtools as _svc_devtools
    from services.ws_tail import stream_devtools_logs_ws

    name = (request.args.get("name") or "").strip()
    cursor_in = request.args.get("cursor")
    try:
        lines_req = int(request.args.get("lines", "400") or "400")
    except Exception:
        lines_req = 400
    lines_req = max(1, min(5000, int(lines_req or 400)))

    client_ip = request.remote_addr or "unknown"
    ws_debug("ws_devtools_logs: handler called", client=client_ip, name=name)

    ws = request.environ.get("wsgi.websocket")
    if ws is None:
        ws_debug("ws_devtools_logs: no WebSocket in environ, returning 400", path=request.path)
        return "Expected WebSocket", 400

    # Defense in depth: WS endpoints must be authenticated (auth_guard handles it too).
    if auth_is_configured() and not _is_logged_in():
        _ws_send(ws, {"type": "error", "error": "unauthorized"})
        try:
            ws.close()
        except Exception:
            pass
        return ""

    if not name:
        _ws_send(ws, {"type": "error", "error": "missing_name"})
        try:
            ws.close()
        except Exception:
            pass
        return ""

    stream_devtools_logs_ws(
        ws,
        name=name,
        lines_req=lines_req,
        cursor_in=cursor_in,
        svc_devtools=_svc_devtools,
        ws_debug=ws_debug,
        client_ip=client_ip,
    )
    return ""

#!/opt/bin/python3
"""Thin compatibility layer.

PR18: the real Flask app construction lives in :mod:`app_factory`.

This module keeps:
- gevent/geventwebsocket optional imports used across the project
- WS_RUNTIME + set_ws_runtime() (run_server.py toggles WS runtime)
- re-exports required by run_server.py (see README invariants)
"""

from __future__ import annotations

import time  # needed for gevent fallback stubs

try:
    from geventwebsocket import WebSocketError  # type: ignore
    import gevent  # type: ignore

    HAS_GEVENT = True
except Exception:  # gevent/geventwebsocket are optional
    HAS_GEVENT = False

    class WebSocketError(Exception):
        """Fallback WebSocketError when geventwebsocket is not installed."""

        pass

    class _GeventStub:
        @staticmethod
        def sleep(seconds: float) -> None:
            time.sleep(seconds)

    gevent = _GeventStub()  # type: ignore


# True only when the app is served via gevent-websocket handler (run_server.py).
# When running under Flask/werkzeug dev server, WS routes exist but upgrades are not supported.
WS_RUNTIME = False


def set_ws_runtime(enabled: bool = True) -> None:
    """Mark WebSocket runtime as actually active (called by run_server.py)."""

    global WS_RUNTIME
    WS_RUNTIME = bool(enabled)
    # Also expose as env marker for capabilities detection.
    try:
        import os as _os

        _os.environ["XKEEN_WS_RUNTIME"] = "1" if WS_RUNTIME else "0"
    except Exception:
        pass


# Build the Flask application.
from app_factory import create_app

app = create_app(ws_runtime=WS_RUNTIME)


# ----------------------------
# Re-exports for run_server.py
# ----------------------------

from services.ws_debug import ws_debug  # noqa: E402
from services.ws_tokens import WS_TOKEN_SCOPES, validate_ws_token  # noqa: E402
from services.xray_log_api import (  # noqa: E402
    resolve_xray_log_path_for_ws as _resolve_xray_log_path_for_ws,
    tail_lines,
    adjust_log_timezone,
)
from services.command_jobs import get_command_job as _get_command_job  # noqa: E402
from services.events import EVENT_SUBSCRIBERS, subscribe as _subscribe_ws, unsubscribe as _unsubscribe_ws  # noqa: E402


__all__ = [
    "app",
    "ws_debug",
    "validate_ws_token",
    "WS_TOKEN_SCOPES",
    "_resolve_xray_log_path_for_ws",
    "tail_lines",
    "adjust_log_timezone",
    "_get_command_job",
    "EVENT_SUBSCRIBERS",
    "_subscribe_ws",
    "_unsubscribe_ws",
    "WS_RUNTIME",
    "set_ws_runtime",
]

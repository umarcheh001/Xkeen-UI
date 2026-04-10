#!/opt/bin/python3
import os

GEVENT_AVAILABLE = True
try:
    from gevent import pywsgi
    from geventwebsocket.handler import WebSocketHandler
except Exception:
    GEVENT_AVAILABLE = False
    pywsgi = None  # type: ignore
    WebSocketHandler = None  # type: ignore


def _server_port() -> int:
    raw = str(os.environ.get("XKEEN_UI_PORT") or "8088").strip()
    try:
        port = int(raw)
    except Exception:
        port = 8088
    if port <= 0 or port > 65535:
        port = 8088
    return port


from app import (
    app,
    ws_debug,
    _resolve_xray_log_path_for_ws,
    validate_ws_token,
    tail_lines,
    adjust_log_timezone,
    _get_command_job,
    EVENT_SUBSCRIBERS,
    _subscribe_ws,
    _unsubscribe_ws,
)
from services.ws_pty import handle_pty_request, start_cleanup_loop as start_pty_cleanup_loop
from services.ws_wsgi import (
    redact_ws_query_string,
    handle_xray_logs_request,
    handle_xray_logs2_request,
    handle_command_status_request,
    handle_events_request,
)


try:
    import app as _appmod  # noqa

    try:
        if hasattr(_appmod, "set_ws_runtime"):
            _appmod.set_ws_runtime(True)
        else:
            _appmod.WS_RUNTIME = True
    except Exception:
        pass
except Exception:
    pass


def application(environ, start_response):
    path = environ.get("PATH_INFO", "")
    qs_safe = redact_ws_query_string(environ.get("QUERY_STRING", ""))

    if GEVENT_AVAILABLE and path == "/ws/xray-logs":
        return handle_xray_logs_request(
            environ,
            start_response,
            fallback_app=app,
            qs_safe=qs_safe,
            ws_debug=ws_debug,
            resolve_xray_log_path_for_ws=_resolve_xray_log_path_for_ws,
            validate_ws_token=validate_ws_token,
            tail_lines=tail_lines,
            adjust_log_timezone=adjust_log_timezone,
        )

    if GEVENT_AVAILABLE and path == "/ws/xray-logs2":
        return handle_xray_logs2_request(
            environ,
            start_response,
            fallback_app=app,
            qs_safe=qs_safe,
            ws_debug=ws_debug,
            resolve_xray_log_path_for_ws=_resolve_xray_log_path_for_ws,
            validate_ws_token=validate_ws_token,
            tail_lines=tail_lines,
            adjust_log_timezone=adjust_log_timezone,
        )

    if GEVENT_AVAILABLE and path == "/ws/command-status":
        return handle_command_status_request(
            environ,
            start_response,
            fallback_app=app,
            qs_safe=qs_safe,
            ws_debug=ws_debug,
            validate_ws_token=validate_ws_token,
            get_command_job=_get_command_job,
        )

    if GEVENT_AVAILABLE and path == "/ws/pty":
        return handle_pty_request(
            environ,
            start_response,
            fallback_app=app,
            qs_safe=qs_safe,
            ws_debug=ws_debug,
            validate_ws_token=validate_ws_token,
        )

    if GEVENT_AVAILABLE and path == "/ws/events":
        return handle_events_request(
            environ,
            start_response,
            fallback_app=app,
            qs_safe=qs_safe,
            ws_debug=ws_debug,
            validate_ws_token=validate_ws_token,
            subscribe_ws=_subscribe_ws,
            unsubscribe_ws=_unsubscribe_ws,
            event_subscribers=EVENT_SUBSCRIBERS,
        )

    return app(environ, start_response)


if __name__ == "__main__":
    server_port = _server_port()
    if GEVENT_AVAILABLE:
        try:
            start_pty_cleanup_loop()
        except Exception:
            pass

        server = pywsgi.WSGIServer(
            ("0.0.0.0", server_port),
            application,
            handler_class=WebSocketHandler,
        )
        server.serve_forever()
    else:
        app.run(host="0.0.0.0", port=server_port)

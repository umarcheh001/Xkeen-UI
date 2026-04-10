"""WSGI WebSocket handlers extracted from ``run_server.py``."""

from __future__ import annotations

import json
import os
import time
from typing import Any, Callable, Sequence
from urllib.parse import parse_qs, urlencode

try:
    from gevent import sleep as _gevent_sleep  # type: ignore
except Exception:  # pragma: no cover

    def _gevent_sleep(sec: float) -> None:
        time.sleep(sec)


try:
    from geventwebsocket import WebSocketError  # type: ignore
except Exception:  # pragma: no cover

    class WebSocketError(Exception):
        """Fallback WebSocketError when geventwebsocket is unavailable."""


def redact_ws_query_string(qs: str) -> str:
    try:
        params = parse_qs(qs or "", keep_blank_values=True)
        if "token" in params:
            vals = params.get("token") or []
            params["token"] = ["***" for _ in vals] or ["***"]
        return urlencode(params, doseq=True)
    except Exception:
        try:
            return str(qs or "")
        except Exception:
            return ""


def _close_ws(ws: Any) -> None:
    try:
        ws.close()
    except Exception:
        pass


def _send_ws_json(ws: Any, payload: dict) -> None:
    try:
        ws.send(json.dumps(payload, ensure_ascii=False))
    except Exception:
        pass


def handle_xray_logs_request(
    environ,
    start_response,
    *,
    fallback_app,
    qs_safe: str,
    ws_debug: Callable[..., Any],
    resolve_xray_log_path_for_ws: Callable[[str], str | None],
    validate_ws_token: Callable[[str, str], bool],
    tail_lines: Callable[..., list[str]],
    adjust_log_timezone: Callable[[list[str]], list[str]],
):
    path = environ.get("PATH_INFO", "")
    method = environ.get("REQUEST_METHOD", "")
    client_ip = environ.get("REMOTE_ADDR", "unknown")
    qs = environ.get("QUERY_STRING", "")
    has_ws = "wsgi.websocket" in environ and environ.get("wsgi.websocket") is not None

    ws_debug(
        "WSGI WS handler: request to /ws/xray-logs",
        has_ws=has_ws,
        method=method,
        qs=qs_safe,
        client=client_ip,
    )

    if not has_ws:
        return fallback_app(environ, start_response)

    ws = environ["wsgi.websocket"]
    params = parse_qs(qs or "")
    token = (params.get("token", [""])[0] or "").strip()
    if not validate_ws_token(token, scope="logs"):
        _send_ws_json(ws, {"type": "error", "error": "unauthorized"})
        _close_ws(ws)
        return []
    file_name = (params.get("file", ["error"])[0] or "error").lower()

    try:
        max_lines = int((params.get("max_lines", ["800"])[0] or "800").strip())
    except Exception:
        max_lines = 800
    max_lines = max(50, min(5000, int(max_lines or 800)))

    ws_debug("ws_raw: handler entered", client=client_ip, file=file_name, max_lines=max_lines)

    path_log = resolve_xray_log_path_for_ws(file_name)
    ws_debug("ws_raw: resolved log path", path=path_log)

    if not path_log or not os.path.isfile(path_log):
        try:
            ws.send(json.dumps({"type": "init", "lines": [], "error": "logfile not found"}, ensure_ascii=False))
        except Exception as e:
            ws_debug("ws_raw: failed to send 'not found'", error=str(e))
        return []

    sent_lines = 0

    try:
        try:
            last_lines = tail_lines(path_log, max_lines=max_lines)
            last_lines = adjust_log_timezone(last_lines)
            ws_debug(
                "ws_raw: initial snapshot ready",
                lines_count=len(last_lines),
                path=path_log,
            )
        except Exception as e:
            ws_debug(
                "ws_raw: failed to read initial snapshot",
                error=str(e),
                path=path_log,
            )
            last_lines = []

        try:
            ws.send(json.dumps({"type": "init", "lines": last_lines}, ensure_ascii=False))
            sent_lines += len(last_lines)
            ws_debug("ws_raw: initial snapshot sent", total_sent=sent_lines)
        except WebSocketError as e:
            ws_debug("ws_raw: WebSocketError on initial send, closing", error=str(e))
            return []
        except Exception as e:
            ws_debug("ws_raw: unexpected error on initial send, closing", error=str(e))
            return []

        with open(path_log, "r") as f:
            f.seek(0, os.SEEK_END)
            ws_debug(
                "ws_raw: entering tail loop",
                path=path_log,
                start_pos=f.tell(),
            )

            while True:
                line = f.readline()
                if not line:
                    _gevent_sleep(0.3)
                    continue

                try:
                    adj = adjust_log_timezone([line])
                    ws.send(json.dumps({"type": "line", "line": adj[0]}, ensure_ascii=False))
                    sent_lines += 1

                    if sent_lines % 100 == 0:
                        ws_debug("ws_raw: still streaming", total_sent=sent_lines)

                except WebSocketError as e:
                    ws_debug(
                        "ws_raw: WebSocketError while streaming, client probably closed",
                        error=str(e),
                        total_sent=sent_lines,
                    )
                    break
                except Exception as e:
                    ws_debug("ws_raw: error while streaming single line", error=str(e))
                    continue

    finally:
        ws_debug("ws_raw: closing WebSocket", client=client_ip, total_sent=sent_lines)
        _close_ws(ws)

    return []


def handle_xray_logs2_request(
    environ,
    start_response,
    *,
    fallback_app,
    qs_safe: str,
    ws_debug: Callable[..., Any],
    resolve_xray_log_path_for_ws: Callable[[str], str | None],
    validate_ws_token: Callable[[str, str], bool],
    tail_lines: Callable[..., list[str]],
    adjust_log_timezone: Callable[[list[str]], list[str]],
):
    path = environ.get("PATH_INFO", "")
    method = environ.get("REQUEST_METHOD", "")
    client_ip = environ.get("REMOTE_ADDR", "unknown")
    qs = environ.get("QUERY_STRING", "")
    has_ws = "wsgi.websocket" in environ and environ.get("wsgi.websocket") is not None

    ws_debug(
        "WSGI WS handler: request to /ws/xray-logs2",
        has_ws=has_ws,
        method=method,
        qs=qs_safe,
        client=client_ip,
    )

    if not has_ws:
        return fallback_app(environ, start_response)

    ws = environ["wsgi.websocket"]
    params = parse_qs(qs or "")
    token = (params.get("token", [""])[0] or "").strip()
    if not validate_ws_token(token, scope="logs"):
        _send_ws_json(ws, {"type": "error", "error": "unauthorized"})
        _close_ws(ws)
        return []
    file_name = (params.get("file", ["error"])[0] or "error").lower()
    filter_expr = (params.get("filter", [""])[0] or "").strip()

    try:
        max_lines = int((params.get("max_lines", ["800"])[0] or "800").strip())
    except Exception:
        max_lines = 800
    max_lines = max(50, min(5000, int(max_lines or 800)))

    ws_debug(
        "ws2_raw: handler entered",
        client=client_ip,
        file=file_name,
        max_lines=max_lines,
        filter=bool(filter_expr),
    )

    try:
        from services.ws_logs2 import stream_xray_logs_ws2
        from services.log_filter import build_line_matcher as _build_line_matcher
    except Exception as e:
        ws_debug("ws2_raw: import failed", error=str(e))
        _send_ws_json(ws, {"type": "error", "error": "ws2_import_failed"})
        _close_ws(ws)
        return []

    try:
        stream_xray_logs_ws2(
            ws,
            initial_file=file_name,
            initial_filter=filter_expr,
            max_lines=max_lines,
            resolve_path=resolve_xray_log_path_for_ws,
            tail_lines=tail_lines,
            adjust_log_timezone=adjust_log_timezone,
            build_line_matcher=_build_line_matcher,
            ws_debug=ws_debug,
            client_ip=client_ip,
        )
    except Exception as e:
        ws_debug("ws2_raw: unhandled exception", error=str(e))
        _send_ws_json(ws, {"type": "error", "error": "ws2_exception", "message": str(e)})
        _close_ws(ws)
    return []


def handle_command_status_request(
    environ,
    start_response,
    *,
    fallback_app,
    qs_safe: str,
    ws_debug: Callable[..., Any],
    validate_ws_token: Callable[[str, str], bool],
    get_command_job: Callable[[str], Any],
):
    method = environ.get("REQUEST_METHOD", "")
    client_ip = environ.get("REMOTE_ADDR", "unknown")
    qs = environ.get("QUERY_STRING", "")
    has_ws = "wsgi.websocket" in environ and environ.get("wsgi.websocket") is not None

    ws_debug(
        "WSGI WS handler: request to /ws/command-status",
        has_ws=has_ws,
        method=method,
        qs=qs_safe,
        client=client_ip,
    )

    if not has_ws:
        return fallback_app(environ, start_response)

    ws = environ["wsgi.websocket"]
    params = parse_qs(qs or "")
    token = (params.get("token", [""])[0] or "").strip()
    if not validate_ws_token(token, scope="cmd"):
        _send_ws_json(ws, {"type": "error", "message": "unauthorized"})
        _close_ws(ws)
        return []

    job_id = (params.get("job_id", [""])[0] or "").strip()
    if not job_id:
        try:
            ws.send(json.dumps({"type": "error", "message": "job_id is required"}, ensure_ascii=False))
        except Exception as e:
            ws_debug("ws_cmd: failed to send 'job_id required'", error=str(e))
        _close_ws(ws)
        return []

    last_len = 0
    try:
        while True:
            job = get_command_job(job_id)
            if job is None:
                try:
                    ws.send(json.dumps({"type": "error", "message": "Unknown job_id"}, ensure_ascii=False))
                except Exception as e:
                    ws_debug("ws_cmd: failed to send 'job not found'", error=str(e))
                break

            output = job.output or ""
            status = job.status
            exit_code = job.exit_code
            error_msg = getattr(job, "error", None)

            if len(output) > last_len:
                chunk = output[last_len:]
                last_len = len(output)
                if chunk:
                    try:
                        ws.send(json.dumps({"type": "chunk", "data": chunk}, ensure_ascii=False))
                    except WebSocketError as e:
                        ws_debug(
                            "ws_cmd: WebSocketError while sending chunk, client probably closed",
                            error=str(e),
                        )
                        break
                    except Exception as e:
                        ws_debug("ws_cmd: unexpected error while sending chunk", error=str(e))
                        break

            if status in ("finished", "error"):
                try:
                    ws.send(
                        json.dumps(
                            {
                                "type": "done",
                                "status": status,
                                "exit_code": exit_code,
                                "error": error_msg,
                            },
                            ensure_ascii=False,
                        )
                    )
                except WebSocketError as e:
                    ws_debug("ws_cmd: WebSocketError while sending done", error=str(e))
                except Exception as e:
                    ws_debug("ws_cmd: unexpected error while sending done", error=str(e))
                break

            _gevent_sleep(0.2)
    except WebSocketError as e:
        ws_debug("ws_cmd: WebSocketError in main loop, client probably closed", error=str(e))
    except Exception as e:
        ws_debug("ws_cmd: unexpected error in main loop", error=str(e))
        _send_ws_json(ws, {"type": "error", "message": str(e)})
    finally:
        _close_ws(ws)

    return []


def handle_events_request(
    environ,
    start_response,
    *,
    fallback_app,
    qs_safe: str,
    ws_debug: Callable[..., Any],
    validate_ws_token: Callable[[str, str], bool],
    subscribe_ws: Callable[[Any], None],
    unsubscribe_ws: Callable[[Any], None],
    event_subscribers: Sequence[Any],
):
    method = environ.get("REQUEST_METHOD", "")
    client_ip = environ.get("REMOTE_ADDR", "unknown")
    qs = environ.get("QUERY_STRING", "")
    has_ws = "wsgi.websocket" in environ and environ.get("wsgi.websocket") is not None

    ws_debug(
        "WSGI WS handler: request to /ws/events",
        has_ws=has_ws,
        method=method,
        qs=qs_safe,
        client=client_ip,
    )

    if not has_ws:
        return fallback_app(environ, start_response)

    ws = environ["wsgi.websocket"]
    params = parse_qs(qs or "")
    token = (params.get("token", [""])[0] or "").strip()
    if not validate_ws_token(token, scope="events"):
        _send_ws_json(ws, {"type": "error", "error": "unauthorized"})
        _close_ws(ws)
        return []

    subscribe_ws(ws)
    ws_debug("ws_events: subscriber added", total=len(event_subscribers), client=client_ip)

    try:
        while True:
            _gevent_sleep(60.0)
    except WebSocketError as e:
        ws_debug("ws_events: WebSocketError in main loop, client probably closed", error=str(e))
    except Exception as e:
        ws_debug("ws_events: unexpected error in main loop", error=str(e))
    finally:
        unsubscribe_ws(ws)
        ws_debug("ws_events: subscriber removed", total=len(event_subscribers))

    return []

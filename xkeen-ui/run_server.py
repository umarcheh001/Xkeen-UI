#!/opt/bin/python3
import json
import os
from urllib.parse import parse_qs
import time

GEVENT_AVAILABLE = True
try:
    from gevent import pywsgi, sleep as _gevent_sleep
    from geventwebsocket.handler import WebSocketHandler
    from geventwebsocket import WebSocketError  # type: ignore
except Exception:
    GEVENT_AVAILABLE = False

    # Stubs so the module can still be imported without gevent/geventwebsocket
    pywsgi = None  # type: ignore
    WebSocketHandler = None  # type: ignore

    class WebSocketError(Exception):
        """Fallback WebSocketError when WebSocket support is not available."""
        pass

    def _gevent_sleep(sec: float) -> None:
        time.sleep(sec)

from app import (
    app,
    ws_debug,
    _resolve_xray_log_path_for_ws,
    tail_lines,
    adjust_log_timezone,
    _get_command_job,
    EVENT_SUBSCRIBERS,
)



def application(environ, start_response):
    """
    Верхнеуровневое WSGI-приложение.

    - Все обычные HTTP-запросы прокидываем во Flask `app`.
    - Запросы к /ws/xray-logs с wsgi.websocket обрабатываем сами,
      реализуя tail -f логов через WebSocket.
    """
    path = environ.get("PATH_INFO", "")
    method = environ.get("REQUEST_METHOD", "")
    client_ip = environ.get("REMOTE_ADDR", "unknown")
    qs = environ.get("QUERY_STRING", "")

    # Интересует только наш WS-эндпоинт (только если доступен gevent)
    if GEVENT_AVAILABLE and path == "/ws/xray-logs":
        has_ws = "wsgi.websocket" in environ and environ.get("wsgi.websocket") is not None
        ws_debug(
            "WSGI WS handler: request to /ws/xray-logs",
            has_ws=has_ws,
            method=method,
            qs=qs,
            client=client_ip,
        )

        # Если это обычный HTTP (нет Upgrade) — отдаём во Flask (Expected WebSocket)
        if not has_ws:
            return app(environ, start_response)

        # Тут уже точно WebSocket
        ws = environ["wsgi.websocket"]

        # Разбираем ?file=error|access
        params = parse_qs(qs or "")
        file_name = (params.get("file", ["error"])[0] or "error").lower()

        ws_debug("ws_raw: handler entered", client=client_ip, file=file_name)

        path_log = _resolve_xray_log_path_for_ws(file_name)
        ws_debug("ws_raw: resolved log path", path=path_log)

        if not path_log or not os.path.isfile(path_log):
            try:
                ws.send(json.dumps({"type": "init", "lines": [], "error": "logfile not found"}, ensure_ascii=False))
            except Exception as e:
                ws_debug("ws_raw: failed to send 'not found'", error=str(e))
            return []

        sent_lines = 0

        try:
            # 1) начальный снимок
            try:
                last_lines = tail_lines(path_log, max_lines=800)
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
                ws_debug(
                    "ws_raw: WebSocketError on initial send, closing",
                    error=str(e),
                )
                return []
            except Exception as e:
                ws_debug(
                    "ws_raw: unexpected error on initial send, closing",
                    error=str(e),
                )
                return []

            # 2) tail -f
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
                            ws_debug(
                                "ws_raw: still streaming",
                                total_sent=sent_lines,
                            )

                    except WebSocketError as e:
                        ws_debug(
                            "ws_raw: WebSocketError while streaming, client probably closed",
                            error=str(e),
                            total_sent=sent_lines,
                        )
                        break
                    except Exception as e:
                        ws_debug(
                            "ws_raw: error while streaming single line",
                            error=str(e),
                        )
                        continue

        finally:
            ws_debug(
                "ws_raw: closing WebSocket",
                client=client_ip,
                total_sent=sent_lines,
            )
            try:
                ws.close()
            except Exception:
                pass

        # Для WebSocket ничего не возвращаем — WebSocketHandler всё делает сам
        return []

    
    # WebSocket endpoint for long-running xkeen commands
    if GEVENT_AVAILABLE and path == "/ws/command-status":
        has_ws = "wsgi.websocket" in environ and environ.get("wsgi.websocket") is not None
        ws_debug(
            "WSGI WS handler: request to /ws/command-status",
            has_ws=has_ws,
            method=method,
            qs=qs,
            client=client_ip,
        )

        # If it's not actually a WebSocket upgrade – delegate to Flask
        if not has_ws:
            return app(environ, start_response)

        ws = environ["wsgi.websocket"]

        # Parse ?job_id=<id>
        params = parse_qs(qs or "")
        job_id = (params.get("job_id", [""])[0] or "").strip()

        if not job_id:
            try:
                ws.send(
                    json.dumps(
                        {"type": "error", "message": "job_id is required"},
                        ensure_ascii=False,
                    )
                )
            except Exception as e:
                ws_debug("ws_cmd: failed to send 'job_id required'", error=str(e))
            try:
                ws.close()
            except Exception:
                pass
            return []

        last_len = 0
        try:
            while True:
                job = _get_command_job(job_id)
                if job is None:
                    # Unknown job – report error and close
                    try:
                        ws.send(
                            json.dumps(
                                {"type": "error", "message": "Unknown job_id"},
                                ensure_ascii=False,
                            )
                        )
                    except Exception as e:
                        ws_debug("ws_cmd: failed to send 'job not found'", error=str(e))
                    break

                output = job.output or ""
                status = job.status
                exit_code = job.exit_code
                error_msg = getattr(job, "error", None)

                # Send new chunk if output has grown
                if len(output) > last_len:
                    chunk = output[last_len:]
                    last_len = len(output)
                    if chunk:
                        try:
                            ws.send(
                                json.dumps(
                                    {"type": "chunk", "data": chunk},
                                    ensure_ascii=False,
                                )
                            )
                        except WebSocketError as e:
                            ws_debug(
                                "ws_cmd: WebSocketError while sending chunk, client probably closed",
                                error=str(e),
                            )
                            break
                        except Exception as e:
                            ws_debug(
                                "ws_cmd: unexpected error while sending chunk",
                                error=str(e),
                            )
                            break

                if status in ("finished", "error"):
                    # Final status packet
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
                        ws_debug(
                            "ws_cmd: WebSocketError while sending done",
                            error=str(e),
                        )
                    except Exception as e:
                        ws_debug(
                            "ws_cmd: unexpected error while sending done",
                            error=str(e),
                        )
                    break

                _gevent_sleep(0.2)
        except WebSocketError as e:
            ws_debug(
                "ws_cmd: WebSocketError in main loop, client probably closed",
                error=str(e),
            )
        except Exception as e:
            ws_debug("ws_cmd: unexpected error in main loop", error=str(e))
            try:
                ws.send(
                    json.dumps(
                        {"type": "error", "message": str(e)},
                        ensure_ascii=False,
                    )
                )
            except Exception:
                pass
        finally:
            try:
                ws.close()
            except Exception:
                pass

        return []

    # WebSocket endpoint for service / status events
    if GEVENT_AVAILABLE and path == "/ws/events":
        has_ws = "wsgi.websocket" in environ and environ.get("wsgi.websocket") is not None
        ws_debug(
            "WSGI WS handler: request to /ws/events",
            has_ws=has_ws,
            method=method,
            qs=qs,
            client=client_ip,
        )

        # Если это не настоящий WebSocket upgrade – передаём во Flask
        if not has_ws:
            return app(environ, start_response)

        ws = environ["wsgi.websocket"]
        EVENT_SUBSCRIBERS.append(ws)
        ws_debug("ws_events: subscriber added", total=len(EVENT_SUBSCRIBERS), client=client_ip)

        try:
            # Ничего сами не посылаем – только держим соединение открытым,
            # пока broadcast_event не будет слать события этим подписчикам.
            while True:
                _gevent_sleep(60.0)
        except WebSocketError as e:
            ws_debug("ws_events: WebSocketError in main loop, client probably closed", error=str(e))
        except Exception as e:  # noqa: BLE001
            ws_debug("ws_events: unexpected error in main loop", error=str(e))
        finally:
            try:
                EVENT_SUBSCRIBERS.remove(ws)
                ws_debug("ws_events: subscriber removed", total=len(EVENT_SUBSCRIBERS))
            except ValueError:
                # подписчик уже удалён
                pass
            except Exception:
                pass

        return []

# Всё остальное — обычный Flask
    return app(environ, start_response)


if __name__ == "__main__":
    if GEVENT_AVAILABLE:
        server = pywsgi.WSGIServer(
            ("0.0.0.0", 8088),
            application,
            handler_class=WebSocketHandler,
        )
        server.serve_forever()
    else:
        # Fallback: simple Flask dev server without WebSocket support.
        # Xray logs will still be available via HTTP polling (/api/xray-logs).
        app.run(host="0.0.0.0", port=8088)

#!/opt/bin/python3
import json
import os
from urllib.parse import parse_qs
import time
import fcntl
import termios
import struct
import signal
import subprocess
import uuid

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
    validate_pty_ws_token,
    tail_lines,
    adjust_log_timezone,
    _get_command_job,
    EVENT_SUBSCRIBERS,
)




def _pty_set_winsize(fd, rows, cols):
    try:
        rows_i = int(rows)
        cols_i = int(cols)
        if rows_i <= 0 or cols_i <= 0:
            return
        winsz = struct.pack("HHHH", rows_i, cols_i, 0, 0)
        fcntl.ioctl(fd, termios.TIOCSWINSZ, winsz)
    except Exception:
        pass


def _pty_choose_shell():
    # Prefer Entware shells if present (Keenetic часто имеет /bin/sh без поддержки -i)
    for path in (
        '/opt/bin/ash',
        '/opt/bin/bash',
        '/bin/ash',
        '/bin/bash',
        '/opt/bin/sh',
        '/bin/sh',
    ):
        try:
            if os.path.exists(path) and os.access(path, os.X_OK):
                return path
        except Exception:
            pass
    return '/bin/sh'


def _pty_shell_args(shell_path: str):
    """Build argv for the chosen shell.

    Some Keenetic /bin/sh implementations reject '-i'.
    BusyBox/ash and bash are fine with '-i', so we enable it only there.
    """
    base = os.path.basename(shell_path or '')
    args = [shell_path]
    if base in ('ash', 'bash'):
        args.append('-i')
    return args


def _pty_preexec(slave_fd: int) -> None:
    """Ensure the spawned shell has a controlling TTY.

    Without this, some shells may immediately exit on embedded systems.
    """
    os.setsid()
    try:
        fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)
    except Exception:
        pass


# ------------------------------
# PTY session manager (supports reconnect by session_id)
# ------------------------------
from dataclasses import dataclass, field
from collections import deque
from contextlib import contextmanager
import threading

try:
    from gevent import spawn as _gspawn  # type: ignore
    from gevent import select as _gselect  # type: ignore
except Exception:
    _gspawn = None
    _gselect = None

try:
    from gevent.lock import Semaphore as _GeventSemaphore  # type: ignore
except Exception:
    _GeventSemaphore = None


PTY_MAX_BUF_CHARS = int(os.environ.get("XKEEN_PTY_MAX_BUF_CHARS", "65536"))
PTY_IDLE_TTL_SECONDS = int(os.environ.get("XKEEN_PTY_IDLE_TTL_SECONDS", "1800"))  # 30 min


@dataclass
class PtySession:
    session_id: str
    master_fd: int
    proc: subprocess.Popen
    shell: str
    created_ts: float = field(default_factory=time.time)
    last_activity_ts: float = field(default_factory=time.time)
    seq: int = 0
    buf: deque = field(default_factory=deque)  # deque[(seq:int, data:str)]
    buf_chars: int = 0
    ws: object | None = None  # currently attached websocket (single client)
    closed: bool = False
    lock: object = field(default_factory=threading.Lock)
    reader_g: object | None = None

    def is_alive(self) -> bool:
        try:
            if self.closed:
                return False
            if self.proc.poll() is not None:
                return False
            return True
        except Exception:
            return False

    def _append_buf_locked(self, txt: str) -> int:
        # lock must be held
        self.seq += 1
        seq = self.seq
        self.buf.append((seq, txt))
        self.buf_chars += len(txt)
        # keep last N chars
        while self.buf and self.buf_chars > PTY_MAX_BUF_CHARS:
            _, t0 = self.buf.popleft()
            self.buf_chars -= len(t0)
        return seq

    def replay_since(self, last_seq: int) -> list[tuple[int, str]]:
        # Return a copy of buffered chunks newer than last_seq
        with self.lock:  # type: ignore[attr-defined]
            return [(s, t) for (s, t) in list(self.buf) if int(s) > int(last_seq or 0)]

    def attach(self, ws_obj) -> tuple[int, bool]:
        # Returns (current_seq, replaced_old)
        replaced = False
        with self.lock:  # type: ignore[attr-defined]
            old = self.ws
            if old is not None and old is not ws_obj:
                replaced = True
                try:
                    old.close()
                except Exception:
                    pass
            self.ws = ws_obj
            self.last_activity_ts = time.time()
            return self.seq, replaced

    def detach(self, ws_obj) -> None:
        with self.lock:  # type: ignore[attr-defined]
            if self.ws is ws_obj:
                self.ws = None
            self.last_activity_ts = time.time()

    def write_input(self, data: str) -> None:
        if not data:
            return
        try:
            os.write(self.master_fd, data.encode("utf-8", errors="ignore"))
        except Exception:
            pass
        self.last_activity_ts = time.time()

    def resize(self, rows: int, cols: int) -> None:
        try:
            _pty_set_winsize(self.master_fd, rows, cols)
            try:
                os.killpg(self.proc.pid, signal.SIGWINCH)
            except Exception:
                pass
        except Exception:
            pass
        self.last_activity_ts = time.time()

    def send_to_ws(self, payload: dict) -> bool:
        ws_obj = None
        with self.lock:  # type: ignore[attr-defined]
            ws_obj = self.ws
        if ws_obj is None:
            return False
        try:
            ws_obj.send(json.dumps(payload, ensure_ascii=False))
            return True
        except Exception:
            # detach on any send failure
            try:
                with self.lock:  # type: ignore[attr-defined]
                    if self.ws is ws_obj:
                        self.ws = None
            except Exception:
                pass
            return False

    def start_reader(self) -> None:
        if self.reader_g is not None:
            return

        def _reader():
            while True:
                if not self.is_alive():
                    break
                try:
                    if _gselect:
                        r, _, _ = _gselect.select([self.master_fd], [], [], 0.2)
                        if self.master_fd not in r:
                            continue
                    else:
                        _gevent_sleep(0.05) if GEVENT_AVAILABLE else time.sleep(0.05)

                    data = os.read(self.master_fd, 4096)
                    if not data:
                        break
                    try:
                        txt = data.decode("utf-8", errors="replace")
                    except Exception:
                        txt = ""
                    if not txt:
                        continue

                    # buffer + optionally send to attached WS
                    seq = None
                    with self.lock:  # type: ignore[attr-defined]
                        seq = self._append_buf_locked(txt)
                        ws_obj = self.ws
                    if ws_obj is not None:
                        try:
                            ws_obj.send(json.dumps({"type": "output", "data": txt, "seq": int(seq)}, ensure_ascii=False))
                        except Exception:
                            self.detach(ws_obj)
                except Exception:
                    break

        if _gspawn:
            try:
                self.reader_g = _gspawn(_reader)
                return
            except Exception:
                self.reader_g = None

        # fallback: no gevent spawn (shouldn't happen if GEVENT_AVAILABLE)
        try:
            th = threading.Thread(target=_reader, daemon=True)
            th.start()
            self.reader_g = th
        except Exception:
            self.reader_g = None

    def close(self, *, kill: bool = True) -> None:
        if self.closed:
            return
        self.closed = True
        # stop reader
        try:
            if self.reader_g is not None and hasattr(self.reader_g, "kill"):
                self.reader_g.kill()  # type: ignore[call-arg]
        except Exception:
            pass
        # detach ws
        try:
            with self.lock:  # type: ignore[attr-defined]
                ws_obj = self.ws
                self.ws = None
        except Exception:
            ws_obj = None
        try:
            if ws_obj is not None:
                ws_obj.close()
        except Exception:
            pass

        if kill:
            try:
                if self.proc is not None and self.proc.poll() is None:
                    try:
                        os.killpg(self.proc.pid, signal.SIGTERM)
                    except Exception:
                        pass
                    try:
                        _gevent_sleep(0.2) if GEVENT_AVAILABLE else time.sleep(0.2)
                    except Exception:
                        pass
                    if self.proc.poll() is None:
                        try:
                            os.killpg(self.proc.pid, signal.SIGKILL)
                        except Exception:
                            pass
            except Exception:
                pass

        try:
            os.close(self.master_fd)
        except Exception:
            pass


_PTY_SESSIONS: dict[str, PtySession] = {}
_PTY_SESSIONS_LOCK = (_GeventSemaphore(1) if _GeventSemaphore else threading.Lock())


@contextmanager
def _pty_sessions_lock():
    try:
        _PTY_SESSIONS_LOCK.acquire()  # type: ignore[attr-defined]
    except Exception:
        try:
            _PTY_SESSIONS_LOCK.acquire()
        except Exception:
            pass
    try:
        yield
    finally:
        try:
            _PTY_SESSIONS_LOCK.release()  # type: ignore[attr-defined]
        except Exception:
            try:
                _PTY_SESSIONS_LOCK.release()
            except Exception:
                pass


def _pty_cleanup_sessions(now: float | None = None) -> None:
    now = float(now or time.time())
    to_remove: list[str] = []
    with _pty_sessions_lock():
        for sid, sess in list(_PTY_SESSIONS.items()):
            try:
                alive = sess.is_alive()
            except Exception:
                alive = False

            if not alive:
                to_remove.append(sid)
                continue

            try:
                # If detached and idle for too long -> close
                with sess.lock:  # type: ignore[attr-defined]
                    has_ws = sess.ws is not None
                if (not has_ws) and (now - float(sess.last_activity_ts) > PTY_IDLE_TTL_SECONDS):
                    to_remove.append(sid)
            except Exception:
                # be safe
                pass

        for sid in to_remove:
            sess = _PTY_SESSIONS.pop(sid, None)
            if sess is not None:
                try:
                    sess.close(kill=True)
                except Exception:
                    pass


def _pty_create_session(rows0: int = 0, cols0: int = 0) -> PtySession:
    master_fd, slave_fd = os.openpty()
    shell = _pty_choose_shell()

    if cols0 > 0 and rows0 > 0:
        _pty_set_winsize(slave_fd, rows0, cols0)

    env = os.environ.copy()
    env.setdefault("TERM", "xterm-256color")

    proc = subprocess.Popen(
        _pty_shell_args(shell),
        stdin=slave_fd,
        stdout=slave_fd,
        stderr=slave_fd,
        close_fds=True,
        env=env,
        preexec_fn=lambda: _pty_preexec(slave_fd),
    )

    try:
        os.close(slave_fd)
    except Exception:
        pass

    sid = str(uuid.uuid4())
    sess = PtySession(session_id=sid, master_fd=master_fd, proc=proc, shell=shell)
    sess.start_reader()
    return sess



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
    
    # WebSocket endpoint for interactive PTY shell (reconnectable by session_id)
    if GEVENT_AVAILABLE and path == "/ws/pty":
        has_ws = "wsgi.websocket" in environ and environ.get("wsgi.websocket") is not None
        ws_debug(
            "WSGI WS handler: request to /ws/pty",
            has_ws=has_ws,
            method=method,
            path=path,
            remote_addr=environ.get("REMOTE_ADDR"),
            qs=qs,
        )
        if not has_ws:
            return app(environ, start_response)

        ws = environ["wsgi.websocket"]

        # Token required (issued via /api/ws-token)
        params = parse_qs(qs or "")
        token = (params.get("token", [""])[0] or "").strip()
        if not validate_pty_ws_token(token):
            try:
                ws.send(json.dumps({"type": "error", "message": "unauthorized"}, ensure_ascii=False))
            except Exception:
                pass
            try:
                ws.close()
            except Exception:
                pass
            return []

        # Periodic cleanup of old/detached sessions
        try:
            _pty_cleanup_sessions()
        except Exception:
            pass

        # Optional reconnect params
        req_sid = (params.get("session_id", [""])[0] or "").strip()
        try:
            last_seq = int((params.get("last_seq", ["0"])[0] or "0"))
        except Exception:
            last_seq = 0

        try:
            cols0 = int((params.get("cols", ["0"])[0] or "0"))
            rows0 = int((params.get("rows", ["0"])[0] or "0"))
        except Exception:
            cols0, rows0 = 0, 0

        sess = None
        reused = False

        with _pty_sessions_lock():
            if req_sid:
                sess = _PTY_SESSIONS.get(req_sid)
                if sess is not None and not sess.is_alive():
                    # stale
                    try:
                        sess.close(kill=True)
                    except Exception:
                        pass
                    _PTY_SESSIONS.pop(req_sid, None)
                    sess = None

            if sess is None:
                # create new session
                try:
                    sess = _pty_create_session(rows0=rows0, cols0=cols0)
                except Exception as e:
                    try:
                        ws.send(json.dumps({"type": "error", "message": "openpty/spawn failed: " + str(e)}, ensure_ascii=False))
                    except Exception:
                        pass
                    try:
                        ws.close()
                    except Exception:
                        pass
                    return []
                _PTY_SESSIONS[sess.session_id] = sess
                reused = False
            else:
                reused = True

        # Apply initial resize on reconnect too (if provided)
        if sess and cols0 > 0 and rows0 > 0:
            try:
                sess.resize(rows0, cols0)
            except Exception:
                pass

        # Attach websocket (single active connection per PTY)
        try:
            cur_seq, replaced_old = sess.attach(ws)
        except Exception:
            cur_seq, replaced_old = 0, False

        # Init packet (client stores session_id + can request replay by last_seq)
        try:
            ws.send(
                json.dumps(
                    {
                        "type": "init",
                        "shell": getattr(sess, "shell", ""),
                        "session_id": getattr(sess, "session_id", ""),
                        "reused": bool(reused),
                        "seq": int(cur_seq or 0),
                        "replaced_old": bool(replaced_old),
                    },
                    ensure_ascii=False,
                )
            )
        except Exception:
            try:
                sess.detach(ws)
            except Exception:
                pass
            try:
                ws.close()
            except Exception:
                pass
            return []

        # Replay buffered output that client missed
        try:
            if last_seq < int(cur_seq or 0):
                chunks = sess.replay_since(last_seq)
                for s, t in chunks:
                    try:
                        ws.send(json.dumps({"type": "output", "data": t, "seq": int(s)}, ensure_ascii=False))
                    except Exception:
                        break
        except Exception:
            pass

        close_requested = False

        # Main loop: WS -> PTY
        try:
            while True:
                if sess is None or not sess.is_alive():
                    break

                msg = ws.receive()
                if msg is None:
                    break

                if isinstance(msg, (bytes, bytearray)):
                    try:
                        msg = msg.decode("utf-8", errors="replace")
                    except Exception:
                        msg = ""

                try:
                    obj = json.loads(msg)
                except Exception:
                    continue

                t = obj.get("type")
                if t == "input":
                    s = obj.get("data", "")
                    if isinstance(s, str) and s:
                        sess.write_input(s)
                elif t == "resize":
                    try:
                        cols = int(obj.get("cols", 0))
                        rows = int(obj.get("rows", 0))
                        if cols > 0 and rows > 0:
                            sess.resize(rows, cols)
                    except Exception:
                        pass
                elif t == "signal":
                    name = (obj.get("name") or "").upper()
                    sig = {
                        "INT": signal.SIGINT,
                        "TERM": signal.SIGTERM,
                        "KILL": signal.SIGKILL,
                        "HUP": signal.SIGHUP,
                        "QUIT": signal.SIGQUIT,
                    }.get(name)
                    if sig and sess is not None:
                        try:
                            os.killpg(sess.proc.pid, sig)
                        except Exception:
                            pass
                elif t == "close":
                    close_requested = True
                    break
        except WebSocketError:
            pass
        finally:
            # If client explicitly requested close -> terminate and remove session
            if sess is not None and close_requested:
                try:
                    sess.send_to_ws({"type": "exit", "code": -1})
                except Exception:
                    pass
                try:
                    sess.close(kill=True)
                except Exception:
                    pass
                with _pty_sessions_lock():
                    try:
                        _PTY_SESSIONS.pop(sess.session_id, None)
                    except Exception:
                        pass
            else:
                # Detach only (session stays alive for reconnect)
                try:
                    if sess is not None:
                        sess.detach(ws)
                except Exception:
                    pass

            # If process died, clean up session
            try:
                if sess is not None and not sess.is_alive():
                    code = -1
                    try:
                        code = sess.proc.poll()
                    except Exception:
                        pass
                    try:
                        ws.send(json.dumps({"type": "exit", "code": int(code if code is not None else -1)}, ensure_ascii=False))
                    except Exception:
                        pass
                    try:
                        sess.close(kill=False)
                    except Exception:
                        pass
                    with _pty_sessions_lock():
                        try:
                            _PTY_SESSIONS.pop(sess.session_id, None)
                        except Exception:
                            pass
            except Exception:
                pass

            try:
                ws.close()
            except Exception:
                pass

        return []
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

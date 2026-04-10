"""PTY WebSocket runtime extracted from ``run_server.py``.

Keeps the interactive shell session manager in a dedicated module so the
runtime entrypoint can stay focused on server bootstrap and WS dispatch.
"""

from __future__ import annotations

import fcntl
import json
import os
import signal
import struct
import subprocess
import termios
import threading
import time
import uuid
from collections import deque
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Iterable
from urllib.parse import parse_qs

try:
    from gevent import spawn as _gspawn  # type: ignore
    from gevent import select as _gselect  # type: ignore
    from gevent import sleep as _gevent_sleep  # type: ignore
except Exception:  # pragma: no cover
    _gspawn = None
    _gselect = None

    def _gevent_sleep(sec: float) -> None:
        time.sleep(sec)

try:
    from gevent.lock import Semaphore as _GeventSemaphore  # type: ignore
except Exception:  # pragma: no cover
    _GeventSemaphore = None

try:
    from geventwebsocket import WebSocketError  # type: ignore
except Exception:  # pragma: no cover

    class WebSocketError(Exception):
        """Fallback WebSocketError when geventwebsocket is unavailable."""


def _make_lock():
    """Return a gevent-friendly lock when possible."""
    try:
        if _GeventSemaphore:
            return _GeventSemaphore(1)
    except Exception:
        pass
    return threading.Lock()


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
    for path in (
        "/opt/bin/ash",
        "/opt/bin/bash",
        "/bin/ash",
        "/bin/bash",
        "/opt/bin/sh",
        "/bin/sh",
    ):
        try:
            if os.path.exists(path) and os.access(path, os.X_OK):
                return path
        except Exception:
            pass
    return "/bin/sh"


def _pty_shell_args(shell_path: str):
    """Build argv for the chosen shell."""
    base = os.path.basename(shell_path or "")
    args = [shell_path]
    if base in ("ash", "bash"):
        args.append("-i")
    return args


def _pty_preexec(slave_fd: int) -> None:
    """Ensure the spawned shell has a controlling TTY."""
    os.setsid()
    try:
        fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)
    except Exception:
        pass


def _pty_build_env(shell_path: str) -> dict:
    """Build a sane environment for interactive PTY shells."""
    env = os.environ.copy()
    env.setdefault("TERM", "xterm-256color")

    orig_path = env.get("PATH") or ""
    parts = [p for p in orig_path.split(":") if p]
    opt_first = ["/opt/sbin", "/opt/bin"]
    for d in opt_first:
        parts = [p for p in parts if p != d]
    env["PATH"] = ":".join(opt_first + parts) if parts else ":".join(opt_first)

    if not (env.get("HOME") or "").strip():
        for cand in ("/opt/root", "/root", "/tmp"):
            try:
                if os.path.isdir(cand) and os.access(cand, os.W_OK):
                    env["HOME"] = cand
                    break
            except Exception:
                pass
    env.setdefault("HOME", "/tmp")

    env.setdefault("TMPDIR", "/tmp")
    env.setdefault("SHELL", shell_path or "/bin/sh")
    env.setdefault("USER", "root")
    env.setdefault("LOGNAME", env.get("USER") or "root")

    for prof in ("/opt/etc/profile", "/etc/profile"):
        try:
            if os.path.isfile(prof):
                env.setdefault("ENV", prof)
                break
        except Exception:
            pass

    return env


def _pty_default_cwd(env: dict) -> str | None:
    h = (env.get("HOME") or "").strip()
    try:
        if h and os.path.isdir(h) and os.access(h, os.W_OK):
            return h
    except Exception:
        pass
    return None


PTY_MAX_BUF_CHARS = int(os.environ.get("XKEEN_PTY_MAX_BUF_CHARS", "65536"))
PTY_IDLE_TTL_SECONDS = int(os.environ.get("XKEEN_PTY_IDLE_TTL_SECONDS", "1800"))


@dataclass
class PtySession:
    session_id: str
    master_fd: int
    proc: subprocess.Popen
    shell: str
    created_ts: float = field(default_factory=time.time)
    last_activity_ts: float = field(default_factory=time.time)
    seq: int = 0
    buf: deque = field(default_factory=deque)
    buf_chars: int = 0
    ws: object | None = None
    closed: bool = False
    lock: object = field(default_factory=_make_lock)
    reader_g: object | None = None
    exit_code: int | None = None
    exit_notified: bool = False

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
        self.seq += 1
        seq = self.seq
        self.buf.append((seq, txt))
        self.buf_chars += len(txt)
        while self.buf and self.buf_chars > PTY_MAX_BUF_CHARS:
            _, t0 = self.buf.popleft()
            self.buf_chars -= len(t0)
        return seq

    def replay_since(self, last_seq: int) -> list[tuple[int, str]]:
        with self.lock:  # type: ignore[attr-defined]
            return [(s, t) for (s, t) in list(self.buf) if int(s) > int(last_seq or 0)]

    def attach(self, ws_obj) -> tuple[int, bool]:
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
            try:
                with self.lock:  # type: ignore[attr-defined]
                    if self.ws is ws_obj:
                        self.ws = None
            except Exception:
                pass
            return False

    def notify_exit(self, code: int | None = None) -> None:
        try:
            code_i = int(code if code is not None else -1)
        except Exception:
            code_i = -1

        ws_obj = None
        with self.lock:  # type: ignore[attr-defined]
            if self.exit_notified:
                return
            self.exit_notified = True
            self.exit_code = code_i
            ws_obj = self.ws

        if ws_obj is None:
            return

        try:
            ws_obj.send(json.dumps({"type": "exit", "code": code_i}, ensure_ascii=False))
        except Exception:
            pass
        try:
            ws_obj.close()
        except Exception:
            pass

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
                        time.sleep(0.05)

                    data = os.read(self.master_fd, 4096)
                    if not data:
                        break
                    try:
                        txt = data.decode("utf-8", errors="replace")
                    except Exception:
                        txt = ""
                    if not txt:
                        continue

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

            try:
                code = self.proc.poll()
            except Exception:
                code = None
            if code is not None:
                self.notify_exit(code)

        if _gspawn:
            try:
                self.reader_g = _gspawn(_reader)
                return
            except Exception:
                self.reader_g = None

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
        try:
            if self.reader_g is not None and hasattr(self.reader_g, "kill"):
                self.reader_g.kill()  # type: ignore[call-arg]
        except Exception:
            pass

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

        try:
            if self.proc is not None:
                if kill and self.proc.poll() is None:
                    try:
                        os.killpg(self.proc.pid, signal.SIGTERM)
                    except Exception:
                        pass
                    try:
                        self.proc.wait(timeout=1.0)
                    except Exception:
                        try:
                            os.killpg(self.proc.pid, signal.SIGKILL)
                        except Exception:
                            pass
                        try:
                            self.proc.wait(timeout=1.0)
                        except Exception:
                            pass
                else:
                    try:
                        self.proc.wait(timeout=0.2)
                    except Exception:
                        pass
        except Exception:
            pass

        try:
            os.close(self.master_fd)
        except Exception:
            pass


_PTY_SESSIONS: Dict[str, PtySession] = {}
_PTY_SESSIONS_LOCK = (_GeventSemaphore(1) if _GeventSemaphore else threading.Lock())
_PTY_CLEANUP_LOOP_STARTED = False


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


def cleanup_sessions(now: float | None = None) -> None:
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
                with sess.lock:  # type: ignore[attr-defined]
                    has_ws = sess.ws is not None
                if (not has_ws) and (now - float(sess.last_activity_ts) > PTY_IDLE_TTL_SECONDS):
                    to_remove.append(sid)
            except Exception:
                pass

        for sid in to_remove:
            sess = _PTY_SESSIONS.pop(sid, None)
            if sess is not None:
                try:
                    sess.close(kill=True)
                except Exception:
                    pass


def _cleanup_loop():
    while True:
        try:
            cleanup_sessions()
        except Exception:
            pass
        try:
            _gevent_sleep(60.0)
        except Exception:
            time.sleep(60.0)


def start_cleanup_loop() -> bool:
    global _PTY_CLEANUP_LOOP_STARTED
    if _PTY_CLEANUP_LOOP_STARTED:
        return False
    _PTY_CLEANUP_LOOP_STARTED = True
    if _gspawn:
        _gspawn(_cleanup_loop)
        return True

    th = threading.Thread(target=_cleanup_loop, daemon=True)
    th.start()
    return True


def _create_session(rows0: int = 0, cols0: int = 0) -> PtySession:
    master_fd, slave_fd = os.openpty()
    shell = _pty_choose_shell()

    if cols0 > 0 and rows0 > 0:
        _pty_set_winsize(slave_fd, rows0, cols0)

    env = _pty_build_env(shell)
    cwd = _pty_default_cwd(env)

    proc = subprocess.Popen(
        _pty_shell_args(shell),
        stdin=slave_fd,
        stdout=slave_fd,
        stderr=slave_fd,
        close_fds=True,
        env=env,
        cwd=cwd,
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


def handle_pty_request(
    environ,
    start_response,
    *,
    fallback_app,
    qs_safe: str,
    ws_debug: Callable[..., Any],
    validate_ws_token: Callable[[str, str], bool],
):
    has_ws = "wsgi.websocket" in environ and environ.get("wsgi.websocket") is not None
    ws_debug(
        "WSGI WS handler: request to /ws/pty",
        has_ws=has_ws,
        method=environ.get("REQUEST_METHOD", ""),
        path=environ.get("PATH_INFO", ""),
        remote_addr=environ.get("REMOTE_ADDR"),
        qs=qs_safe,
    )
    if not has_ws:
        return fallback_app(environ, start_response)

    ws = environ["wsgi.websocket"]
    params = parse_qs(environ.get("QUERY_STRING", "") or "")
    token = (params.get("token", [""])[0] or "").strip()
    if not validate_ws_token(token, scope="pty"):
        try:
            ws.send(json.dumps({"type": "error", "message": "unauthorized"}, ensure_ascii=False))
        except Exception:
            pass
        try:
            ws.close()
        except Exception:
            pass
        return []

    try:
        cleanup_sessions()
    except Exception:
        pass

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
                try:
                    sess.close(kill=True)
                except Exception:
                    pass
                _PTY_SESSIONS.pop(req_sid, None)
                sess = None

        if sess is None:
            try:
                sess = _create_session(rows0=rows0, cols0=cols0)
            except Exception as e:
                try:
                    ws.send(
                        json.dumps(
                            {"type": "error", "message": "openpty/spawn failed: " + str(e)},
                            ensure_ascii=False,
                        )
                    )
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

    if sess and cols0 > 0 and rows0 > 0:
        try:
            sess.resize(rows0, cols0)
        except Exception:
            pass

    try:
        cur_seq, replaced_old = sess.attach(ws)
    except Exception:
        cur_seq, replaced_old = 0, False

    try:
        replay_upto = int(cur_seq or 0)
    except Exception:
        replay_upto = 0

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

    try:
        if last_seq < int(replay_upto or 0):
            chunks = sess.replay_since(last_seq)
            for s, t in chunks:
                try:
                    if int(s) > int(replay_upto):
                        break
                except Exception:
                    pass
                try:
                    ws.send(json.dumps({"type": "output", "data": t, "seq": int(s)}, ensure_ascii=False))
                except Exception:
                    break
    except Exception:
        pass

    close_requested = False

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
            elif t == "ping":
                try:
                    sess.last_activity_ts = time.time()
                except Exception:
                    pass
                try:
                    ws.send(json.dumps({"type": "pong"}, ensure_ascii=False))
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
            try:
                if sess is not None:
                    sess.detach(ws)
            except Exception:
                pass

        try:
            if sess is not None and not sess.is_alive():
                code = getattr(sess, "exit_code", None)
                try:
                    if code is None:
                        code = sess.proc.poll()
                except Exception:
                    pass
                already_notified = bool(getattr(sess, "exit_notified", False))
                if not already_notified:
                    try:
                        sess.exit_notified = True
                        sess.exit_code = int(code if code is not None else -1)
                    except Exception:
                        pass
                    try:
                        ws.send(
                            json.dumps(
                                {"type": "exit", "code": int(code if code is not None else -1)},
                                ensure_ascii=False,
                            )
                        )
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
        except Exception:
            pass

        try:
            ws.close()
        except Exception:
            pass

    return []

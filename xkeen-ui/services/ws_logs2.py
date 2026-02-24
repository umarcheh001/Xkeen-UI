# -*- coding: utf-8 -*-
"""Xray logs WebSocket v2 with a simple command protocol.

Goal:
  - Keep a single WebSocket connection while switching file/filter or clearing.
  - Avoid reconnects on low-powered devices.

Protocol (JSON messages):
  Commands (client -> server):
    {"cmd":"switch","file":"error|access", "filter":"...", "max_lines":800?}
    {"cmd":"clear"}
    {"cmd":"pause"} / {"cmd":"resume"}

  Events (server -> client):
    {"type":"init","lines":[...], ...meta}
    {"type":"append","lines":[...], ...meta}
    {"type":"status", ...state/meta}
    {"type":"error","error":"...", ...optional}

Notes:
  - This module is backend-only (frontend integration is done in a later commit).
  - gevent/geventwebsocket are optional at runtime for the whole project; we keep
    imports defensive so the module can be imported without WS support.
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional, Tuple

try:
    from geventwebsocket import WebSocketError  # type: ignore
except Exception:  # pragma: no cover

    class WebSocketError(Exception):
        """Fallback WebSocketError when geventwebsocket is not installed."""


try:
    import gevent  # type: ignore
    from gevent.queue import Queue, Empty  # type: ignore

    _HAS_GEVENT = True
except Exception:  # pragma: no cover
    import threading
    from queue import Queue, Empty  # type: ignore

    _HAS_GEVENT = False

    class _GeventStub:
        @staticmethod
        def sleep(seconds: float) -> None:
            time.sleep(seconds)

        @staticmethod
        def spawn(fn, *args, **kwargs):
            th = threading.Thread(target=fn, args=args, kwargs=kwargs, daemon=True)
            th.start()
            return th

    gevent = _GeventStub()  # type: ignore


def _json_send(ws: Any, payload: Dict[str, Any]) -> bool:
    try:
        ws.send(json.dumps(payload, ensure_ascii=False))
        return True
    except WebSocketError:
        return False
    except Exception:
        return False


def _ws_recv(ws: Any) -> Optional[str]:
    """Best-effort recv. Returns None when socket is closed."""
    try:
        msg = ws.receive()
    except WebSocketError:
        return None
    except Exception:
        return None

    if msg is None:
        return None
    if isinstance(msg, bytes):
        try:
            return msg.decode("utf-8", "replace")
        except Exception:
            return ""
    return str(msg)



# Chunking limits for WS2 messages (avoid huge frames on embedded routers/proxies).
# Can be overridden via env for troubleshooting.
_WS2_MAX_LINES = int(os.environ.get("XKEEN_WS2_MAX_LINES_PER_MSG", "200"))
_WS2_MAX_CHARS = int(os.environ.get("XKEEN_WS2_MAX_CHARS_PER_MSG", "48000"))


def _iter_line_chunks(lines: List[str]):
    """Yield line chunks limited by both line count and total chars.

    This prevents sending very large WebSocket frames which some embedded
    stacks/proxies close without a close frame (client sees code=1005).
    """
    if not lines:
        yield []
        return

    max_lines = max(1, int(_WS2_MAX_LINES or 200))
    max_chars = max(1024, int(_WS2_MAX_CHARS or 48000))

    chunk: List[str] = []
    chars = 0

    for ln in lines:
        s = str(ln)
        ln_len = len(s)

        if chunk and (len(chunk) >= max_lines or (chars + ln_len) > max_chars):
            yield chunk
            chunk = []
            chars = 0

        chunk.append(s)
        chars += ln_len

    if chunk:
        yield chunk


def _stat_meta(path: str) -> Dict[str, Any]:
    meta: Dict[str, Any] = {"exists": False, "ino": 0, "size": 0, "mtime": 0.0}
    try:
        st = os.stat(path)
        meta = {
            "exists": True,
            "ino": int(getattr(st, "st_ino", 0) or 0),
            "size": int(getattr(st, "st_size", 0) or 0),
            "mtime": float(getattr(st, "st_mtime", 0.0) or 0.0),
        }
    except Exception:
        pass
    return meta


@dataclass
class _State:
    file: str = "error"
    filter_expr: str = ""
    paused: bool = False
    max_lines: int = 800

    # runtime
    path: str = ""
    matcher: Optional[Callable[[str], bool]] = None
    ino: int = 0
    off: int = 0
    carry: bytes = b""


def stream_xray_logs_ws2(
    ws: Any,
    *,
    initial_file: str,
    initial_filter: Optional[str],
    max_lines: int,
    resolve_path: Callable[[str], Optional[str]],
    tail_lines: Callable[[str, int], List[str]],
    adjust_log_timezone: Callable[[List[str]], List[str]],
    build_line_matcher: Callable[[Optional[str]], Callable[[str], bool]],
    ws_debug: Optional[Callable[..., Any]] = None,
    client_ip: str = "unknown",
) -> None:
    """Serve WS v2 stream.

    This function blocks until the WS closes.
    """

    st = _State(
        file=(initial_file or "error").lower(),
        filter_expr=str(initial_filter or "").strip(),
        paused=False,
        max_lines=max(50, min(5000, int(max_lines or 800))),
    )

    cmd_q: "Queue[Dict[str, Any]]" = Queue()  # type: ignore[type-arg]
    closed_q: "Queue[bool]" = Queue()  # type: ignore[type-arg]

    def _recv_loop() -> None:
        try:
            while True:
                raw = _ws_recv(ws)
                if raw is None:
                    break
                raw = (raw or "").strip()
                if not raw:
                    continue
                try:
                    data = json.loads(raw)
                except Exception:
                    cmd_q.put({"cmd": "_invalid", "raw": raw})
                    continue
                if not isinstance(data, dict):
                    cmd_q.put({"cmd": "_invalid", "raw": raw})
                    continue
                cmd_q.put(data)
        finally:
            try:
                closed_q.put(True)
            except Exception:
                pass

    # Start command receiver.
    try:
        gevent.spawn(_recv_loop)
    except Exception:
        _json_send(ws, {"type": "error", "error": "ws_receiver_failed"})
        try:
            ws.close()
        except Exception:
            pass
        return

    def _send_status(extra: Optional[Dict[str, Any]] = None) -> bool:
        meta = _stat_meta(st.path) if st.path else {"exists": False, "ino": 0, "size": 0, "mtime": 0.0}
        payload: Dict[str, Any] = {
            "type": "status",
            "file": st.file,
            "filter": st.filter_expr,
            "paused": bool(st.paused),
            "max_lines": int(st.max_lines),
            "path": st.path,
            "off": int(st.off or 0),
            **meta,
        }
        if extra:
            payload.update(extra)
        return _json_send(ws, payload)

    def _resolve_and_prepare(
        new_file: Optional[str] = None,
        new_filter: Optional[str] = None,
        *,
        force_seek_end: bool = True,
    ) -> Tuple[bool, str]:
        """Resolve file->path and rebuild matcher.

        Returns (ok, err_msg).
        """
        if new_file is not None:
            st.file = (new_file or "error").lower()
        if new_filter is not None:
            st.filter_expr = str(new_filter or "").strip()
        try:
            st.matcher = build_line_matcher(st.filter_expr)
        except Exception:
            st.matcher = build_line_matcher(None)

        path = resolve_path(st.file) or ""
        if not path:
            return False, "logfile not configured"

        st.path = path
        meta = _stat_meta(st.path)
        if not meta.get("exists"):
            return False, "logfile not found"

        # Reset runtime cursor. We'll seek to end after init snapshot.
        st.ino = int(meta.get("ino", 0) or 0)
        if force_seek_end:
            st.off = int(meta.get("size", 0) or 0)
        st.carry = b""
        return True, ""

    def _send_init_snapshot(err: str = "") -> bool:
        lines: List[str] = []
        meta = {"exists": False, "ino": 0, "size": 0, "mtime": 0.0}
        if st.path:
            meta = _stat_meta(st.path)
        if meta.get("exists"):
            try:
                lines = tail_lines(st.path, int(st.max_lines))
            except Exception as e:
                if ws_debug:
                    try:
                        ws_debug("ws_xray_logs2: tail_lines failed", error=str(e), path=st.path, client=client_ip)
                    except Exception:
                        pass
                lines = []

            try:
                lines = adjust_log_timezone(lines)
            except Exception:
                pass

            # Apply server-side matcher.
            try:
                m = st.matcher or (lambda _ln: True)
                if lines:
                    lines = [ln for ln in lines if m(ln)]
            except Exception:
                pass

        base_payload: Dict[str, Any] = {
            "file": st.file,
            "filter": st.filter_expr,
            "paused": bool(st.paused),
            "max_lines": int(st.max_lines),
            "path": st.path,
            **meta,
        }
        if err:
            base_payload["error"] = err

        # Send init snapshot in chunks to avoid huge WS frames.
        chunks = list(_iter_line_chunks(lines))
        if not chunks:
            chunks = [[]]

        first = chunks[0]
        init_payload = dict(base_payload)
        init_payload["type"] = "init"
        init_payload["lines"] = first

        if not _json_send(ws, init_payload):
            if ws_debug:
                try:
                    ws_debug(
                        "ws_xray_logs2: send init failed",
                        client=client_ip,
                        file=st.file,
                        path=st.path,
                        lines=len(lines),
                        chunk_lines=len(first),
                    )
                except Exception:
                    pass
            return False

        # Remaining snapshot chunks are sent as append.
        if len(chunks) > 1:
            for ch in chunks[1:]:
                if not ch:
                    continue
                if not _json_send(
                    ws,
                    {
                        "type": "append",
                        "lines": ch,
                        "file": st.file,
                        "filter": st.filter_expr,
                        "path": st.path,
                        "off": int(meta.get("size", 0) or 0),
                    },
                ):
                    if ws_debug:
                        try:
                            ws_debug(
                                "ws_xray_logs2: send init-append failed",
                                client=client_ip,
                                file=st.file,
                                path=st.path,
                                chunk_lines=len(ch),
                            )
                        except Exception:
                            pass
                    return False

        # After init, seek to end so we don't re-send old data.
        if meta.get("exists"):
            try:
                st.ino = int(meta.get("ino", 0) or 0)
            except Exception:
                pass
            try:
                st.off = int(meta.get("size", 0) or 0)
            except Exception:
                pass
        return True

    def _open_for_follow() -> Optional[Any]:
        if not st.path:
            return None
        try:
            f = open(st.path, "rb", buffering=0)
        except Exception as e:
            if ws_debug:
                try:
                    ws_debug("ws_xray_logs2: open failed", error=str(e), path=st.path, client=client_ip)
                except Exception:
                    pass
            return None
        # Seek to current offset.
        try:
            f.seek(int(st.off or 0), os.SEEK_SET)
        except Exception:
            try:
                f.seek(0, os.SEEK_END)
                st.off = int(f.tell() or 0)
            except Exception:
                pass
        return f

    # Initial resolve + init snapshot.
    ok, err = _resolve_and_prepare(st.file, st.filter_expr)
    if not ok:
        # Send init with error and keep connection alive so the client can switch.
        _send_init_snapshot(err)
        _send_status({"note": "waiting_for_switch"})
    else:
        if not _send_init_snapshot():
            try:
                ws.close()
            except Exception:
                pass
            return
        _send_status({"note": "connected"})

    f = _open_for_follow() if ok else None
    last_stat_check = time.time()
    last_ping_ts = time.time()
    idle_sleep = 0.05

    def _close_file() -> None:
        nonlocal f
        try:
            if f:
                f.close()
        except Exception:
            pass
        f = None

    try:
        while True:
            # Closed?
            try:
                _ = closed_q.get_nowait()
                break
            except Empty:
                pass

            # Process pending commands.
            while True:
                try:
                    cmd = cmd_q.get_nowait()
                except Empty:
                    break

                c = str(cmd.get("cmd", "") or "").strip().lower()

                if c in ("_invalid", ""):
                    _json_send(ws, {"type": "error", "error": "invalid_command"})
                    continue

                if c == "switch":
                    new_file = cmd.get("file")
                    new_filter = cmd.get("filter")
                    new_max = cmd.get("max_lines")
                    if new_max is not None:
                        try:
                            st.max_lines = max(50, min(5000, int(new_max)))
                        except Exception:
                            pass

                    # Resolve without losing current state if invalid.
                    prev = (st.file, st.filter_expr, st.path, st.ino, st.off)
                    ok2, err2 = _resolve_and_prepare(
                        str(new_file).lower() if new_file is not None else None,
                        str(new_filter) if new_filter is not None else None,
                        force_seek_end=True,
                    )
                    if not ok2:
                        # Roll back to previous state.
                        st.file, st.filter_expr, st.path, st.ino, st.off = prev
                        try:
                            st.matcher = build_line_matcher(st.filter_expr)
                        except Exception:
                            st.matcher = build_line_matcher(None)
                        _json_send(ws, {"type": "error", "error": err2, "cmd": "switch"})
                        _send_status({"note": "switch_failed"})
                        continue

                    _close_file()
                    if not _send_init_snapshot():
                        return
                    _send_status({"note": "switched"})
                    f = _open_for_follow()
                    continue

                if c == "clear":
                    # Clear client view + reset follow cursor to end.
                    meta = _stat_meta(st.path) if st.path else {"exists": False, "size": 0, "ino": 0, "mtime": 0.0}
                    try:
                        st.off = int(meta.get("size", 0) or 0)
                        st.ino = int(meta.get("ino", 0) or 0)
                    except Exception:
                        pass
                    st.carry = b""
                    _close_file()
                    if not _json_send(
                        ws,
                        {
                            "type": "init",
                            "lines": [],
                            "file": st.file,
                            "filter": st.filter_expr,
                            "paused": bool(st.paused),
                            "max_lines": int(st.max_lines),
                            "path": st.path,
                            **meta,
                        },
                    ):
                        return
                    _send_status({"note": "cleared"})
                    f = _open_for_follow()
                    continue

                if c == "pause":
                    st.paused = True
                    _send_status({"note": "paused"})
                    continue

                if c == "resume":
                    st.paused = False
                    # On resume send a fresh snapshot (user likely expects context).
                    if not _send_init_snapshot():
                        return
                    _send_status({"note": "resumed"})
                    _close_file()
                    f = _open_for_follow()
                    continue

                _json_send(ws, {"type": "error", "error": "unknown_command", "cmd": c})

            # If we don't have a valid file, just idle until switch.
            if not st.path or not _stat_meta(st.path).get("exists"):
                gevent.sleep(0.15)
                continue

            # If paused - don't append, but still watch for file disappearance.
            if st.paused:
                gevent.sleep(0.10)
                # Periodic stat check to report missing file.
                now = time.time()
                if now - last_stat_check > 2.0:
                    last_stat_check = now
                    if not _stat_meta(st.path).get("exists"):
                        _json_send(ws, {"type": "error", "error": "logfile not found"})
                        _send_status({"note": "missing"})
                continue

            if not f:
                f = _open_for_follow()
                if not f:
                    gevent.sleep(0.20)
                    continue

            # Read next chunk.
            try:
                chunk = f.read(64 * 1024)
            except Exception:
                chunk = b""

            if chunk:
                st.off += len(chunk)
                buf = (st.carry or b"") + chunk
                parts = buf.splitlines(True)
                new_carry = b""
                if parts:
                    last = parts[-1]
                    if not last.endswith(b"\n") and not last.endswith(b"\r"):
                        new_carry = last
                        parts = parts[:-1]
                st.carry = new_carry

                if parts:
                    lines_out = [p.decode("utf-8", "replace") for p in parts]
                    try:
                        lines_out = adjust_log_timezone(lines_out)
                    except Exception:
                        pass

                    # Match + pack.
                    try:
                        m = st.matcher or (lambda _ln: True)
                        lines_out = [ln for ln in lines_out if m(ln)]
                    except Exception:
                        pass
                    if lines_out:
                        send_ok = True
                        for ch in _iter_line_chunks(lines_out):
                            if not ch:
                                continue
                            if not _json_send(
                                ws,
                                {
                                    "type": "append",
                                    "lines": ch,
                                    "file": st.file,
                                    "filter": st.filter_expr,
                                    "path": st.path,
                                    "off": int(st.off or 0),
                                },
                            ):
                                send_ok = False
                                if ws_debug:
                                    try:
                                        ws_debug(
                                            "ws_xray_logs2: send append failed",
                                            client=client_ip,
                                            file=st.file,
                                            path=st.path,
                                            chunk_lines=len(ch),
                                        )
                                    except Exception:
                                        pass
                                break
                        if not send_ok:
                            break

                idle_sleep = 0.02
                continue

            # Idle.
            gevent.sleep(idle_sleep)
            if idle_sleep < 0.30:
                idle_sleep = min(0.30, idle_sleep * 1.3)

            now = time.time()
            if now - last_stat_check < 1.0:
                continue
            last_stat_check = now

            # Keep connection alive on networks that drop idle WebSockets.
            if now - last_ping_ts > 15.0:
                # If the socket is already closed, send() may fail without a close
                # frame (client sees code=1005). Treat that as a hard close.
                if not _send_status({"note": "ping"}):
                    if ws_debug:
                        try:
                            ws_debug(
                                "ws_xray_logs2: ping send failed",
                                client=client_ip,
                                file=st.file,
                                path=st.path,
                            )
                        except Exception:
                            pass
                    break
                last_ping_ts = now

            meta = _stat_meta(st.path)
            if not meta.get("exists"):
                _json_send(ws, {"type": "error", "error": "logfile not found"})
                _send_status({"note": "missing"})
                _close_file()
                continue

            cur_ino = int(meta.get("ino", 0) or 0)
            cur_size = int(meta.get("size", 0) or 0)
            rotated = bool(st.ino and cur_ino and cur_ino != st.ino)
            truncated = bool(cur_size < int(st.off or 0))

            if rotated or truncated:
                if ws_debug:
                    try:
                        ws_debug(
                            "ws_xray_logs2: rotation/truncate detected",
                            client=client_ip,
                            path=st.path,
                            rotated=rotated,
                            truncated=truncated,
                            old_ino=st.ino,
                            new_ino=cur_ino,
                            old_off=int(st.off or 0),
                            new_size=cur_size,
                        )
                    except Exception:
                        pass
                st.ino = cur_ino
                st.off = cur_size
                st.carry = b""
                _close_file()
                if not _send_init_snapshot():
                    break
                _send_status({"note": "reloaded"})
                f = _open_for_follow()

    finally:
        try:
            _close_file()
        except Exception:
            pass
        try:
            ws.close()
        except Exception:
            pass

# -*- coding: utf-8 -*-
"""WebSocket tailing helpers.

PR16: move WS tail loops out of app.py to keep it thin.

Notes:
  - gevent/geventwebsocket are optional at runtime; we provide a small fallback
    so the module can be imported even when WS is not available.
  - We keep payload formats unchanged (init/line for xray; init/append for devtools).
"""

from __future__ import annotations

import json
import os
import time
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple

try:
    from geventwebsocket import WebSocketError  # type: ignore
    import gevent  # type: ignore
except Exception:  # pragma: no cover

    class WebSocketError(Exception):
        """Fallback WebSocketError when geventwebsocket is not installed."""

    class _GeventStub:
        @staticmethod
        def sleep(_seconds: float) -> None:
            time.sleep(_seconds)

    gevent = _GeventStub()  # type: ignore


def _send_json(
    ws: Any,
    payload: Dict[str, Any],
    *,
    ws_debug: Optional[Callable[..., Any]] = None,
    client_ip: str = "unknown",
    tag: str = "ws_tail",
) -> bool:
    """Best-effort JSON send. Returns False when the socket is gone."""
    try:
        ws.send(json.dumps(payload, ensure_ascii=False))
        return True
    except WebSocketError as e:
        if ws_debug:
            try:
                ws_debug(f"{tag}: WebSocketError on send", error=str(e), client=client_ip)
            except Exception:
                pass
        return False
    except Exception as e:
        if ws_debug:
            try:
                ws_debug(f"{tag}: error on send", error=str(e), client=client_ip)
            except Exception:
                pass
        return False


def stream_xray_logs_ws(
    ws: Any,
    *,
    path: str,
    max_lines: int,
    tail_lines: Callable[[str], List[str]],
    adjust_log_timezone: Callable[[List[str]], List[str]],
    ws_debug: Optional[Callable[..., Any]] = None,
    client_ip: str = "unknown",
) -> None:
    """Stream a text log file like `tail -f` with the legacy payload format."""

    sent_lines = 0

    # 1) Initial snapshot
    try:
        last_lines = tail_lines(path, max_lines=max_lines)  # type: ignore[arg-type]
        last_lines = adjust_log_timezone(last_lines)
    except Exception as e:
        if ws_debug:
            try:
                ws_debug(
                    "ws_xray_logs: failed to read initial snapshot",
                    error=str(e),
                    path=path,
                )
            except Exception:
                pass
        last_lines = []

    if not _send_json(ws, {"type": "init", "lines": last_lines}, ws_debug=ws_debug, client_ip=client_ip, tag="ws_xray_logs"):
        return
    sent_lines += len(last_lines)

    # 2) Follow loop
    try:
        with open(path, "r") as f:
            try:
                f.seek(0, os.SEEK_END)
            except Exception:
                pass

            if ws_debug:
                try:
                    ws_debug(
                        "ws_xray_logs: entering tail loop",
                        path=path,
                        start_pos=int(getattr(f, "tell", lambda: 0)() or 0),
                    )
                except Exception:
                    pass

            while True:
                line = f.readline()
                if not line:
                    gevent.sleep(0.3)
                    continue

                try:
                    adj = adjust_log_timezone([line])
                    if not _send_json(ws, {"type": "line", "line": adj[0]}, ws_debug=ws_debug, client_ip=client_ip, tag="ws_xray_logs"):
                        break
                    sent_lines += 1

                    if ws_debug and sent_lines % 100 == 0:
                        try:
                            ws_debug(
                                "ws_xray_logs: still streaming",
                                total_sent=sent_lines,
                                path=path,
                            )
                        except Exception:
                            pass
                except Exception as e:
                    if ws_debug:
                        try:
                            ws_debug("ws_xray_logs: error while streaming single line", error=str(e))
                        except Exception:
                            pass
                    continue
    finally:
        if ws_debug:
            try:
                ws_debug(
                    "ws_xray_logs: closing WebSocket",
                    client=client_ip,
                    total_sent=sent_lines,
                )
            except Exception:
                pass
        try:
            ws.close()
        except Exception:
            pass


def stream_devtools_logs_ws(
    ws: Any,
    *,
    name: str,
    lines_req: int,
    cursor_in: Optional[str],
    svc_devtools: Any,
    ws_debug: Optional[Callable[..., Any]] = None,
    client_ip: str = "unknown",
) -> None:
    """Stream DevTools logs with legacy cursor/meta payloads."""

    sent_msgs = 0

    def _stat_meta(p: str) -> Dict[str, Any]:
        meta: Dict[str, Any] = {"size": 0, "mtime": 0.0, "ino": 0, "exists": False}
        try:
            st = os.stat(p)
            meta = {
                "size": int(getattr(st, "st_size", 0) or 0),
                "mtime": float(getattr(st, "st_mtime", 0.0) or 0.0),
                "ino": int(getattr(st, "st_ino", 0) or 0),
                "exists": True,
            }
        except Exception:
            pass
        return meta

    def _send(payload: Dict[str, Any]) -> bool:
        nonlocal sent_msgs
        ok = _send_json(ws, payload, ws_debug=ws_debug, client_ip=client_ip, tag="ws_devtools_logs")
        if ok:
            sent_msgs += 1
        return ok

    # Initial snapshot (or resume-append if cursor is valid)
    try:
        path, lns, new_cursor, mode = svc_devtools.tail_log(name, lines=lines_req, cursor=cursor_in)
    except ValueError:
        _send({"type": "error", "error": "unknown_log", "name": name})
        try:
            ws.close()
        except Exception:
            pass
        return
    except Exception as e:
        _send({"type": "error", "error": "tail_failed", "name": name, "details": str(e)})
        try:
            ws.close()
        except Exception:
            pass
        return

    meta = _stat_meta(path)
    init_type = "append" if mode == "append" else "init"
    if not _send(
        {
            "type": init_type,
            "mode": mode,
            "name": name,
            "path": path,
            "lines": lns,
            "cursor": new_cursor,
            **meta,
        }
    ):
        return

    if not meta.get("exists"):
        if ws_debug:
            try:
                ws_debug("ws_devtools_logs: log file missing, closing", name=name, path=path)
            except Exception:
                pass
        try:
            ws.close()
        except Exception:
            pass
        return

    # Decode cursor state for follow loop.
    cur: Optional[Dict[str, Any]]
    try:
        cur = svc_devtools._decode_cursor(new_cursor)  # type: ignore[attr-defined]
    except Exception:
        cur = None
    ino = int((cur or {}).get("ino", 0) or 0)
    off = int((cur or {}).get("off", meta.get("size", 0) or 0) or 0)
    try:
        carry = svc_devtools._b64d(str((cur or {}).get("carry", "")))  # type: ignore[attr-defined]
    except Exception:
        carry = b""  # type: ignore[assignment]

    f = None
    try:
        f = open(path, "rb", buffering=0)
        try:
            f.seek(off, os.SEEK_SET)
        except Exception:
            try:
                f.seek(0, os.SEEK_END)
                off = int(f.tell() or 0)
            except Exception:
                off = int(meta.get("size", 0) or 0)
    except Exception as e:
        if ws_debug:
            try:
                ws_debug("ws_devtools_logs: failed to open log for follow", error=str(e), path=path)
            except Exception:
                pass
        try:
            ws.close()
        except Exception:
            pass
        return

    last_stat_check = time.time()
    idle_sleep = 0.10

    try:
        while True:
            try:
                chunk = f.read(64 * 1024)  # type: ignore[union-attr]
            except Exception:
                chunk = b""  # type: ignore[assignment]

            if chunk:
                off += len(chunk)
                buf = (carry or b"") + chunk  # type: ignore[operator]
                parts = buf.splitlines(True)
                new_carry = b""  # type: ignore[assignment]
                if parts:
                    last = parts[-1]
                    if not last.endswith(b"\n") and not last.endswith(b"\r"):
                        new_carry = last
                        parts = parts[:-1]
                carry = new_carry  # type: ignore[assignment]

                if parts:
                    lines_out = [p.decode("utf-8", "replace") for p in parts]
                    try:
                        cur_str = svc_devtools._encode_cursor({"ino": ino, "off": int(off), "carry": svc_devtools._b64e(carry)})  # type: ignore[attr-defined]
                    except Exception:
                        cur_str = new_cursor
                    new_cursor = cur_str
                    meta_now = _stat_meta(path)
                    if not _send(
                        {
                            "type": "append",
                            "mode": "append",
                            "name": name,
                            "path": path,
                            "lines": lines_out,
                            "cursor": new_cursor,
                            **meta_now,
                        }
                    ):
                        break

                idle_sleep = 0.05
                continue

            gevent.sleep(idle_sleep)
            if idle_sleep < 0.25:
                idle_sleep = min(0.25, idle_sleep * 1.3)

            now = time.time()
            if now - last_stat_check < 1.0:
                continue
            last_stat_check = now

            try:
                st = os.stat(path)
            except Exception:
                if ws_debug:
                    try:
                        ws_debug("ws_devtools_logs: log file disappeared", name=name, path=path)
                    except Exception:
                        pass
                _send(
                    {
                        "type": "init",
                        "mode": "full",
                        "name": name,
                        "path": path,
                        "lines": [],
                        "cursor": "",
                        "exists": False,
                        "size": 0,
                        "mtime": 0.0,
                        "ino": 0,
                    }
                )
                break

            cur_ino = int(getattr(st, "st_ino", 0) or 0)
            cur_size = int(getattr(st, "st_size", 0) or 0)

            rotated = bool(ino and cur_ino and cur_ino != ino)
            truncated = bool(cur_size < int(off or 0))

            if rotated or truncated:
                if ws_debug:
                    try:
                        ws_debug(
                            "ws_devtools_logs: rotation/truncate detected",
                            name=name,
                            path=path,
                            rotated=rotated,
                            truncated=truncated,
                            old_ino=ino,
                            new_ino=cur_ino,
                            old_off=off,
                            new_size=cur_size,
                        )
                    except Exception:
                        pass

                try:
                    path2, lns2, new_cur2, _mode2 = svc_devtools.tail_log(name, lines=lines_req, cursor=None)
                except Exception:
                    lns2, new_cur2, path2 = [], None, path

                meta2 = _stat_meta(path2)
                if new_cur2:
                    try:
                        cur2 = svc_devtools._decode_cursor(new_cur2)  # type: ignore[attr-defined]
                    except Exception:
                        cur2 = None
                    ino = int((cur2 or {}).get("ino", meta2.get("ino", 0) or 0) or 0)
                    off = int((cur2 or {}).get("off", meta2.get("size", 0) or 0) or 0)
                    try:
                        carry = svc_devtools._b64d(str((cur2 or {}).get("carry", "")))  # type: ignore[attr-defined]
                    except Exception:
                        carry = b""  # type: ignore[assignment]
                    new_cursor = new_cur2
                else:
                    ino = int(meta2.get("ino", 0) or 0)
                    off = int(meta2.get("size", 0) or 0)
                    carry = b""  # type: ignore[assignment]
                    try:
                        new_cursor = svc_devtools._encode_cursor({"ino": int(ino), "off": int(off), "carry": ""})  # type: ignore[attr-defined]
                    except Exception:
                        new_cursor = ""

                _send(
                    {
                        "type": "init",
                        "mode": "full",
                        "name": name,
                        "path": path2,
                        "lines": lns2,
                        "cursor": new_cursor,
                        **meta2,
                    }
                )

                try:
                    if f:
                        f.close()
                except Exception:
                    pass
                try:
                    f = open(path2, "rb", buffering=0)
                    try:
                        f.seek(off, os.SEEK_SET)
                    except Exception:
                        try:
                            f.seek(0, os.SEEK_END)
                            off = int(f.tell() or 0)
                        except Exception:
                            off = int(meta2.get("size", 0) or 0)
                except Exception:
                    break
    finally:
        try:
            if f:
                f.close()
        except Exception:
            pass
        try:
            ws.close()
        except Exception:
            pass

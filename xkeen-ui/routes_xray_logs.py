"""Xray live logs endpoints (HTTP).

Extracted from legacy app.py.

Endpoints:
 - GET  /api/xray-logs
 - POST /api/xray-logs/clear
 - GET  /api/xray-logs/download
 - GET  /api/xray-logs/status
 - POST /api/xray-logs/enable
 - POST /api/xray-logs/disable
"""

from __future__ import annotations

import base64
import json
import os
from typing import Any, Dict, Optional, Tuple

from flask import Blueprint, jsonify, request, send_file

from services.xray_logs import read_new_lines as _svc_read_new_lines
from services.xray_logs import tail_lines_fast as _svc_tail_lines_fast
from services.xray_log_api import (
    adjust_log_timezone,
    clear_logs,
    disable_logs,
    enable_logs,
    get_status,
    resolve_xray_log_path_for_ws,
)


def _xray_b64e(data: bytes) -> str:
    if not data:
        return ""
    try:
        return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")
    except Exception:
        return ""


def _xray_b64d(s: str) -> bytes:
    if not s:
        return b""
    try:
        pad = "=" * (-len(s) % 4)
        return base64.urlsafe_b64decode((s + pad).encode("ascii"))
    except Exception:
        return b""


def _xray_encode_cursor(obj: Dict[str, Any]) -> str:
    try:
        raw = json.dumps(obj, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")
    except Exception:
        return ""


def _xray_decode_cursor(cur: Optional[str]) -> Optional[Dict[str, Any]]:
    if not cur:
        return None
    try:
        pad = "=" * (-len(cur) % 4)
        raw = base64.urlsafe_b64decode((cur + pad).encode("ascii"))
    except Exception:
        return None
    try:
        obj = json.loads(raw.decode("utf-8", "ignore"))
        return obj if isinstance(obj, dict) else None
    except Exception:
        return None


def create_xray_logs_blueprint(
    *,
    ws_debug: Any,
    restart_xray_core: Any,
) -> Blueprint:
    bp = Blueprint("xray_logs", __name__)

    @bp.get("/api/xray-logs")
    def api_xray_logs():
        """Pseudo-tail Xray logs over HTTP.

        query:
          file=error|access (или error.log/access.log)
          max_lines=число (по умолчанию 800, 50–5000)
          cursor=строка (опционально) — инкрементальный курсор (DevTools-like)
          source=строка — для debug-логов
        """
        file_name = request.args.get("file", "error")
        cursor = request.args.get("cursor")
        try:
            max_lines = int(request.args.get("max_lines", 800))
        except (TypeError, ValueError):
            max_lines = 800

        # sanity clamp
        if max_lines < 50:
            max_lines = 50
        if max_lines > 5000:
            max_lines = 5000

        source = request.args.get("source", "manual")
        try:
            ws_debug(
                "api_xray_logs: HTTP tail requested",
                file=file_name,
                max_lines=max_lines,
                cursor=bool(cursor),
                source=source,
                client=request.remote_addr or "unknown",
            )
        except Exception:
            pass

        path = resolve_xray_log_path_for_ws(file_name)
        if not path or not os.path.isfile(path):
            return (
                jsonify({"lines": [], "mode": "full", "cursor": "", "exists": False, "size": 0, "mtime": 0.0, "ino": 0}),
                200,
            )

        try:
            st = os.stat(path)
            ino = int(getattr(st, "st_ino", 0) or 0)
            size = int(getattr(st, "st_size", 0) or 0)
            mtime = float(getattr(st, "st_mtime", 0.0) or 0.0)
        except Exception:
            return (
                jsonify({"lines": [], "mode": "full", "cursor": "", "exists": False, "size": 0, "mtime": 0.0, "ino": 0}),
                200,
            )

        # Try incremental append mode first (when cursor matches the same file inode)
        cur = _xray_decode_cursor(cursor)
        if cur and int(cur.get("ino", -1)) == ino:
            try:
                off = int(cur.get("off", 0) or 0)
            except Exception:
                off = 0

            if 0 <= off <= size:
                carry = _xray_b64d(str(cur.get("carry", "")))
                new_lines, new_off, new_carry = _svc_read_new_lines(path, off, carry=carry, max_bytes=128 * 1024)
                new_cursor = _xray_encode_cursor({"ino": ino, "off": int(new_off), "carry": _xray_b64e(new_carry)})
                new_lines = adjust_log_timezone(new_lines)
                return (
                    jsonify(
                        {
                            "lines": new_lines,
                            "mode": "append",
                            "cursor": new_cursor,
                            "exists": True,
                            "size": size,
                            "mtime": mtime,
                            "ino": ino,
                        }
                    ),
                    200,
                )

        # Full tail snapshot
        lines = _svc_tail_lines_fast(path, max_lines=max_lines, max_bytes=256 * 1024)
        lines = adjust_log_timezone(lines)
        new_cursor = _xray_encode_cursor({"ino": ino, "off": size, "carry": ""})
        return (
            jsonify(
                {
                    "lines": lines,
                    "mode": "full",
                    "cursor": new_cursor,
                    "exists": True,
                    "size": size,
                    "mtime": mtime,
                    "ino": ino,
                }
            ),
            200,
        )

    @bp.post("/api/xray-logs/clear")
    def api_xray_logs_clear():
        """Clear Xray log files."""
        data = request.get_json(silent=True) or {}
        file_name = data.get("file")
        clear_logs(file_name)
        return jsonify({"ok": True}), 200

    @bp.get("/api/xray-logs/download")
    def api_xray_logs_download():
        """Download current Xray log file (error/access)."""
        file_name = request.args.get("file", "error")
        path = resolve_xray_log_path_for_ws(file_name)
        if not path or not os.path.isfile(path):
            return jsonify({"ok": False, "error": "not_found"}), 404

        base = "error" if str(file_name or "").lower() in ("error", "error.log") else "access"
        try:
            return send_file(path, as_attachment=True, download_name=f"xray-{base}.log")
        except TypeError:
            # Flask < 2.0
            return send_file(path, as_attachment=True, attachment_filename=f"xray-{base}.log")

    @bp.get("/api/xray-logs/status")
    def api_xray_logs_status():
        """Return current loglevel and paths."""
        return jsonify(get_status()), 200

    @bp.post("/api/xray-logs/enable")
    def api_xray_logs_enable():
        """Enable Xray logs by setting loglevel and restarting Xray core."""
        data = request.get_json(silent=True) or {}
        level = str(data.get("loglevel") or "warning").strip().lower()

        resp_ok, detail, normalized_level, xray_restarted = enable_logs(level, restart_xray_core=restart_xray_core)
        return (
            jsonify(
                {
                    "ok": bool(resp_ok),
                    "loglevel": normalized_level,
                    "restarted": False,
                    "xray_restarted": bool(xray_restarted),
                    "detail": detail,
                }
            ),
            200 if resp_ok else 500,
        )

    @bp.post("/api/xray-logs/disable")
    def api_xray_logs_disable():
        """Disable Xray logs (loglevel=none), snapshot logs, restart Xray core."""
        resp_ok, detail, xray_restarted = disable_logs(restart_xray_core=restart_xray_core)
        return (
            jsonify(
                {
                    "ok": bool(resp_ok),
                    "restarted": False,
                    "xray_restarted": bool(xray_restarted),
                    "detail": detail,
                }
            ),
            200 if resp_ok else 500,
        )

    return bp

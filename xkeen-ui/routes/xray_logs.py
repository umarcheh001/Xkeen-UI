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
import time
from typing import Any, Dict, Optional, Tuple

from flask import Blueprint, Response, jsonify, request, send_file

from services.xray_logs import read_new_lines as _svc_read_new_lines
from services.xray_logs import tail_lines_fast as _svc_tail_lines_fast
from services.log_filter import build_line_matcher as _build_line_matcher
from services.log_filter import filter_lines as _filter_lines
from services.xray_log_api import (
    adjust_log_timezone,
    clear_logs,
    disable_logs,
    enable_logs,
    get_status,
    get_log_generation,
    load_xray_log_config,
    resolve_xray_log_path_for_ws,
)
from services.xray_subscriptions import list_subscriptions
from services.xray_device_names import (
    delete_manual_device_name,
    get_xray_device_names_state,
    set_manual_device_name,
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


def _diagnostic_tail(path: str, cur: Optional[Dict[str, Any]], max_lines: int) -> dict:
    """Read a fresh bounded window; stale cursors must not build an endless backlog."""
    limit = 128 * 1024
    generation = get_log_generation()
    with open(path, "rb") as stream:
        stat = os.fstat(stream.fileno())
        size, ino = stat.st_size, stat.st_ino
        try:
            offset = int(cur.get("off", -1)) if cur else -1
            valid = bool(cur and cur.get("g") == generation and cur.get("ino") == ino and 0 <= offset <= size)
            if valid:
                stream.seek(max(0, offset - 64))
                valid = _xray_b64e(stream.read(min(64, offset))) == cur.get("boundary")
        except (TypeError, ValueError, OverflowError):
            valid, offset = False, -1
        skipped = (size - offset > limit) if valid else size > limit
        reset = not valid or skipped
        start = max(0, size - limit) if reset else offset
        carry = b"" if reset else _xray_b64d(str(cur.get("carry", "")))[:4096]
        drop_first = False
        if reset and start:
            stream.seek(start - 1)
            drop_first = stream.read(1) != b"\n"
        stream.seek(start)
        data = carry + stream.read(limit)
        new_offset = stream.tell()
        caught_up = new_offset >= os.fstat(stream.fileno()).st_size
        stream.seek(max(0, new_offset - 64))
        boundary = _xray_b64e(stream.read(min(64, new_offset)))
    parts = data.splitlines(True)
    if drop_first and parts:
        parts.pop(0)
    carry = b""
    if parts and not parts[-1].endswith((b"\n", b"\r")):
        carry = parts.pop()
    if len(carry) > 4096:
        carry, skipped, reset = b"", True, True
    if len(parts) > max_lines:
        parts, skipped, reset = parts[-max_lines:], True, True
    return {
        "lines": adjust_log_timezone([line.decode("utf-8", "replace") for line in parts]),
        "mode": "full" if reset else "append",
        "cursor": _xray_encode_cursor({"ino": ino, "off": new_offset, "carry": _xray_b64e(carry), "g": generation, "boundary": boundary}),
        "exists": True, "size": size, "mtime": stat.st_mtime, "ino": ino,
        "reset": reset, "skipped": skipped, "caught_up": caught_up,
    }


def create_xray_logs_blueprint(
    *,
    ws_debug: Any,
    restart_xray_core: Any,
    ui_state_dir: Optional[str] = None,
    append_restart_log: Any = None,
) -> Blueprint:
    bp = Blueprint("xray_logs", __name__)
    from core.paths import UI_STATE_DIR
    from services import xray_config_files
    from services import xray_log_api
    from services.xray_routing_debug import RoutingDebug, HEADER
    debug = RoutingDebug(xray_config_files.XRAY_CONFIGS_DIR, ui_state_dir or UI_STATE_DIR)

    @bp.record_once
    def bind_routing_debug(state):
        state.app.extensions['xkeen.xray_routing_debug'] = debug
        state.app.extensions['xkeen.runtime_control'] = debug.control_runtime
        app = state.app

        def expire_restart():
            from services.xkeen import _process_ids
            if not _process_ids('xray'):
                return True, ''
            with app.app_context():
                return recover_core()

        debug.watch_viewers(logging=logs_enabled, restart=expire_restart,
                            on_error=lambda: app.logger.exception('Не удалось автоматически выключить отладку маршрутизации Xray'))

    def logs_enabled():
        return str(load_xray_log_config().get('log', {}).get('loglevel', 'none')).lower() != 'none'

    def recover_core():
        return restart_xray_core()

    @bp.post('/api/xray-logs/routing-debug/viewer')
    def api_xray_routing_viewer():
        if not debug.status()['enabled']:
            return jsonify({'ok': False}), 409

        def presence():
            viewer = object()
            debug.viewer_join(viewer)
            try:
                while debug.status()['enabled']:
                    yield b': viewer\n\n'
                    time.sleep(5)
            finally:
                debug.viewer_leave(viewer)

        return Response(presence(), mimetype='text/event-stream',
                        headers={'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no'})

    @bp.post('/api/xray-logs/routing-event/<rule_key>')
    def api_xray_routing_event(rule_key):
        if not debug.authorize(request.remote_addr, request.headers.get(HEADER, '')):
            return jsonify({'ok': False, 'error': 'forbidden'}), 403
        if request.content_length is None or request.content_length > 16384:
            return jsonify({'ok': False, 'error': 'payload too large'}), 413
        if not debug.ingest(rule_key, request.get_json(silent=True)):
            return jsonify({'ok': False, 'error': 'invalid event'}), 400
        return '', 204

    @bp.get('/api/xray-logs/routing-debug/events')
    def api_xray_routing_events():
        from services import xray_log_api
        data = debug.events()
        offset = xray_log_api._TZ_OFFSET_HOURS * 3600000
        data['events'] = [{**event, 'stamp': event['stamp'] + offset} for event in data['events']]
        data['since'] += offset
        if data['expired_until']:
            data['expired_until'] += offset
        return jsonify(data), 200

    @bp.post('/api/xray-logs/routing-debug')
    def api_xray_routing_debug():
        data = request.get_json(silent=True)
        if not isinstance(data, dict) or type(data.get('enabled')) is not bool:
            return jsonify({'ok': False, 'error': 'Нужно указать enabled: true или false.'}), 400
        logging = logs_enabled()
        try:
            return jsonify(debug.configure(data['enabled'], logging=logging, restart=recover_core)), 200
        except ValueError as exc:
            return jsonify({'ok': False, 'error': str(exc)}), 409
        except Exception:
            return jsonify({'ok': False, 'error': 'Не удалось сохранить отладку маршрутизации.'}), 500

    def _append_restart_log(ok: bool, source: str = "api", **meta: object) -> None:
        if append_restart_log is None:
            return
        try:
            append_restart_log(ok, source=source, **meta)
        except TypeError:
            try:
                append_restart_log(ok, source=source)
            except Exception:
                pass
        except Exception:
            pass

    @bp.get("/api/xray-logs")
    def api_xray_logs():
        """Pseudo-tail Xray logs over HTTP.

        query:
          file=error|access (или error.log/access.log)
          max_lines=число (по умолчанию 800, 50–5000)
          cursor=строка (опционально) — инкрементальный курсор (DevTools-like)
          filter=строка (опционально) — серверный фильтр строк (AND по пробелам, OR по '|')
          source=строка — для debug-логов
        """
        file_name = request.args.get("file", "error")
        cursor = request.args.get("cursor")
        filter_expr = request.args.get("filter")
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
        matcher = _build_line_matcher(filter_expr)
        try:
            ws_debug(
                "api_xray_logs: HTTP tail requested",
                file=file_name,
                max_lines=max_lines,
                cursor=bool(cursor),
                filter=bool(filter_expr),
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

        if request.args.get("diagnostic") == "1" and str(file_name).lower() in ("error", "error.log"):
            try:
                return jsonify(_diagnostic_tail(path, _xray_decode_cursor(cursor), max_lines)), 200
            except OSError:
                return jsonify({"lines": [], "cursor": "", "reset": True, "skipped": True, "caught_up": False}), 200

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
                # Server-side filter reduces payload (client may still filter further).
                if filter_expr:
                    new_lines = _filter_lines(new_lines, matcher)
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

        # Full tail snapshot.
        # Domain-hint polling needs enough history to pair `sniffed domain` lines
        # with their `dialing/tunneling tcp:IP` counterpart (same connId), so we
        # allow a larger byte window for that source only; regular views stay at 256KB.
        tail_max_bytes = (1024 * 1024) if source == "domain_hints" else (256 * 1024)
        lines = _svc_tail_lines_fast(path, max_lines=max_lines, max_bytes=tail_max_bytes)
        if filter_expr:
            lines = _filter_lines(lines, matcher)
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
        return jsonify({**get_status(), 'routing_debug': debug.status()}), 200

    @bp.get("/api/xray-logs/devices")
    def api_xray_logs_devices():
        """Return router/manual device names used to enrich Xray access logs."""
        raw_refresh = str(request.args.get("refresh", "1") or "1").strip().lower()
        refresh_router = raw_refresh not in ("0", "false", "no", "off")
        return jsonify(get_xray_device_names_state(ui_state_dir, refresh_router=refresh_router)), 200

    @bp.post("/api/xray-logs/devices")
    def api_xray_logs_devices_set():
        """Create or update a manual IP -> device name alias."""
        data = request.get_json(silent=True) or {}
        try:
            entry = set_manual_device_name(ui_state_dir, data.get("ip"), data.get("name"))
        except ValueError as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400
        payload = get_xray_device_names_state(ui_state_dir, refresh_router=True)
        payload["entry"] = entry
        return jsonify(payload), 200

    @bp.delete("/api/xray-logs/devices/<path:ip>")
    def api_xray_logs_devices_delete(ip: str):
        """Delete a manual device alias."""
        try:
            existed = delete_manual_device_name(ui_state_dir, ip)
        except ValueError as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400
        payload = get_xray_device_names_state(ui_state_dir, refresh_router=True)
        payload["deleted"] = bool(existed)
        return jsonify(payload), 200

    @bp.get("/api/xray-logs/outbound-names")
    def api_xray_logs_outbound_names():
        """Subscription node names by outbound tag for the access.log table.

        Generated tags drop flag emoji and spaces; the stored node name keeps
        them, so the table can show the country and the name people know.
        """
        names: Dict[str, Dict[str, str]] = {}
        try:
            subscriptions = list_subscriptions(str(ui_state_dir or "")) if ui_state_dir else []
        except Exception:
            subscriptions = []
        for sub in subscriptions:
            if not isinstance(sub, dict):
                continue
            sub_name = str(sub.get("name") or sub.get("tag") or "").strip()
            for node in sub.get("last_nodes") or []:
                if not isinstance(node, dict):
                    continue
                tag = str(node.get("tag") or "").strip()
                name = str(node.get("name") or "").strip()
                if tag and name and tag not in names:
                    names[tag] = {"name": name, "subscription": sub_name}
        return jsonify({"ok": True, "names": names}), 200

    @bp.post("/api/xray-logs/enable")
    def api_xray_logs_enable():
        """Enable Xray logs by setting loglevel and restarting Xray core."""
        data = request.get_json(silent=True) or {}
        level = str(data.get("loglevel") or "warning").strip().lower()
        writes = {}
        try:
            resp_ok, detail, normalized_level, xray_restarted = debug.perform(True,
                lambda: enable_logs(level, restart_xray_core=restart_xray_core,
                                    on_saved=lambda raw: writes.update({xray_log_api._CONFIG_PATH: raw})),
                recover=recover_core, writes=writes)
        except Exception as exc:
            return jsonify({'ok': False, 'error': str(exc), 'detail': str(exc)}), 500
        _append_restart_log(
            resp_ok,
            source="xray-logs-enable",
            loglevel=normalized_level,
            xray_restarted=bool(xray_restarted),
            detail=detail,
        )
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
        writes = {}
        try:
            # Removing hooks still needs a restart when loglevel was already none.
            resp_ok, detail, xray_restarted = debug.perform(False,
                lambda: disable_logs(restart_xray_core=restart_xray_core,
                                     force_restart=any(path != str(debug.state_path) for path in writes),
                                     on_saved=lambda raw: writes.update({xray_log_api._CONFIG_PATH: raw})),
                recover=recover_core, writes=writes)
        except Exception as exc:
            return jsonify({'ok': False, 'error': str(exc), 'detail': str(exc)}), 500
        _append_restart_log(
            resp_ok,
            source="xray-logs-disable",
            xray_restarted=bool(xray_restarted),
            detail=detail,
        )
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

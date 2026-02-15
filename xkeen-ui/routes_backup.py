"""Backup-related page and API routes as a Flask Blueprint.

This module is a blueprint *factory* so the main app can inject paths and helpers.

Fragment-aware patch (dropdown fragments):
  - /api/backup, /api/backup-inbounds, /api/backup-outbounds accept ?file=<fragment>
  - /api/restore-auto accepts JSON body {target, file}
  - routing backups may include raw JSONC with comments and can restore them.
"""

from __future__ import annotations

import json
import os
import time
from typing import Any, Callable, Dict, Optional

from flask import Blueprint, jsonify, redirect, render_template, request, url_for

from services.xray_backups import (
    is_snapshot_filename,
    safe_basename,
    safe_child_realpath,
    read_text_limited,
    atomic_write_bytes,
)


# --- core.log helpers (never fail) ---
try:
    from services.logging_setup import core_logger as _get_core_logger

    _CORE_LOGGER = _get_core_logger()
except Exception:
    _CORE_LOGGER = None


def _core_log(level: str, msg: str, **extra) -> None:
    if _CORE_LOGGER is None:
        return
    try:
        if extra:
            try:
                tail = ", ".join(f"{k}={v}" for k, v in extra.items())
            except Exception:
                tail = repr(extra)
            full = f"{msg} | {tail}"
        else:
            full = msg
        fn = getattr(_CORE_LOGGER, str(level or "info").lower(), None)
        if callable(fn):
            fn(full)
        else:
            _CORE_LOGGER.info(full)
    except Exception:
        pass


def error_response(message: str, status: int = 400, *, ok: bool | None = None) -> Any:
    """Return a JSON error response for this blueprint."""
    payload: Dict[str, Any] = {"error": message}
    if ok is not None:
        payload["ok"] = ok
    return jsonify(payload), status


def create_backups_blueprint(
    BACKUP_DIR: str,
    ROUTING_FILE: str,
    ROUTING_FILE_RAW: str,
    INBOUNDS_FILE: str,
    OUTBOUNDS_FILE: str,
    load_json: Callable[[str, Optional[Dict[str, Any]]], Optional[Dict[str, Any]]],
    save_json: Callable[[str, Any], None],
    list_backups: Callable[[], Any],
    _detect_backup_target_file: Callable[[str], str],
    _find_latest_auto_backup_for: Callable[[str], tuple[Optional[str], Optional[float]]],
    strip_json_comments_text: Callable[[str], str],
    restart_xkeen: Callable[..., bool],
) -> Blueprint:
    """Create blueprint with /backups page and backup-related endpoints."""

    bp = Blueprint("backups", __name__)

    # Resolve base dir for safe fragment selection.
    try:
        _CONFIGS_DIR = os.path.realpath(
            os.path.dirname(ROUTING_FILE)
            or os.path.dirname(INBOUNDS_FILE)
            or os.path.dirname(OUTBOUNDS_FILE)
            or "/opt/etc/xray/configs"
        )
    except Exception:
        _CONFIGS_DIR = "/opt/etc/xray/configs"

    try:
        _CONFIGS_DIR_REAL = os.path.realpath(_CONFIGS_DIR)
    except Exception:
        _CONFIGS_DIR_REAL = _CONFIGS_DIR

    def _resolve_fragment(file_arg: str, fallback_path: str, kind: str = "") -> str:
        """Resolve selectable fragment file within configs dir (safe)."""
        try:
            v = str(file_arg or "").strip()
        except Exception:
            v = ""

        if not v:
            return fallback_path

        try:
            if v.startswith("/"):
                cand = v
            else:
                # Disallow nested paths to avoid directory traversal.
                if "/" in v or "\\" in v:
                    raise ValueError("invalid filename")
                cand = os.path.join(_CONFIGS_DIR, v)

            cand_real = os.path.realpath(cand)
            base = _CONFIGS_DIR_REAL
            if not (cand_real == base or cand_real.startswith(base + os.sep)):
                raise ValueError("outside configs dir")

            if not (cand_real.endswith(".json") or cand_real.endswith(".jsonc")):
                raise ValueError("unsupported extension")

            # Mild validation: keep the user inside the right family of fragments.
            if kind:
                lname = os.path.basename(cand_real).lower()
                if kind not in lname:
                    raise ValueError("kind mismatch")

            return cand_real
        except Exception:
            return fallback_path

    def _routing_paths_for(selected: str) -> tuple[str, str]:
        """Return (routing_main_json, routing_raw_jsonc) for selected path."""
        if selected.endswith(".jsonc"):
            return selected[:-1], selected
        return selected, selected + "c"

    # ---- pages ----

    @bp.get("/backups")
    def backups_page() -> Any:
        # UI hint: show which fragment names are active (classic vs *_hys2.json).
        try:
            xray_profile = "hys2" if "_hys2" in os.path.basename(ROUTING_FILE) else "classic"
        except Exception:
            xray_profile = "classic"

        return render_template(
            "backups.html",
            backups=list_backups(),
            backup_dir=BACKUP_DIR,
            xray_profile=xray_profile,
            routing_file=os.path.basename(ROUTING_FILE),
            inbounds_file=os.path.basename(INBOUNDS_FILE),
            outbounds_file=os.path.basename(OUTBOUNDS_FILE),
        )

    # ---- API: Xray snapshots (rollback) ----

    def _configs_child_realpath(name: str) -> Optional[str]:
        """Safe child resolver inside configs dir (basename-only)."""
        bn = safe_basename(name)
        if not bn:
            return None
        try:
            cand = os.path.realpath(os.path.join(_CONFIGS_DIR, bn))
            base = _CONFIGS_DIR_REAL
            if cand == base:
                return None
            if not (cand == base or cand.startswith(base + os.sep)):
                return None
            return cand
        except Exception:
            return None

    @bp.get("/api/xray/snapshots")
    def api_xray_snapshots_list() -> Any:
        items: list[dict[str, Any]] = []
        if not os.path.isdir(BACKUP_DIR):
            return jsonify(items), 200

        for name in os.listdir(BACKUP_DIR):
            if not is_snapshot_filename(name):
                continue
            full = os.path.join(BACKUP_DIR, name)
            try:
                st = os.stat(full)
            except OSError:
                continue
            items.append(
                {
                    "name": name,
                    "size": int(st.st_size),
                    "mtime": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(st.st_mtime)),
                }
            )
        items.sort(key=lambda x: x.get("mtime") or "", reverse=True)
        return jsonify(items), 200

    @bp.get("/api/xray/snapshots/read")
    def api_xray_snapshots_read() -> Any:
        name = request.args.get("name", "")
        if not is_snapshot_filename(name):
            return error_response("bad_name", 400, ok=False)

        src = safe_child_realpath(BACKUP_DIR, name)
        if not src or not os.path.isfile(src):
            return error_response("not_found", 404, ok=False)

        text, truncated, size = read_text_limited(src, max_bytes=512 * 1024)
        return jsonify({"ok": True, "name": os.path.basename(src), "text": text, "truncated": bool(truncated), "size": int(size)}), 200

    @bp.post("/api/xray/snapshots/restore")
    def api_xray_snapshots_restore() -> Any:
        payload = request.get_json(silent=True) or {}
        name = payload.get("name") or ""
        restart_flag = bool(payload.get("restart", True))

        if not is_snapshot_filename(name):
            return error_response("bad_name", 400, ok=False)

        src = safe_child_realpath(BACKUP_DIR, name)
        if not src or not os.path.isfile(src):
            return error_response("not_found", 404, ok=False)

        dst = _configs_child_realpath(name)
        if not dst:
            return error_response("bad_destination", 400, ok=False)

        # Preserve metadata from the existing destination (if any), else from source.
        st0 = None
        try:
            st0 = os.stat(dst) if os.path.exists(dst) else os.stat(src)
        except Exception:
            st0 = None

        data: bytes
        try:
            with open(src, "rb") as f:
                data = f.read()
        except Exception:
            return error_response("read_failed", 400, ok=False)

        ok = atomic_write_bytes(dst, data)
        if not ok:
            return error_response("write_failed", 400, ok=False)

        # Best-effort restore mode/owner/group.
        try:
            if st0 is not None:
                mode = int(getattr(st0, "st_mode", 0) or 0) & 0o7777
                if mode:
                    try:
                        os.chmod(dst, mode)
                    except Exception:
                        pass
                uid = int(getattr(st0, "st_uid", -1))
                gid = int(getattr(st0, "st_gid", -1))
                if uid >= 0 and gid >= 0:
                    try:
                        os.chown(dst, uid, gid)
                    except Exception:
                        pass
        except Exception:
            pass

        restarted = restart_flag and restart_xkeen(source="snapshot-restore")
        _core_log(
            "info",
            "snapshot.restore",
            name=os.path.basename(src),
            dst=os.path.basename(dst),
            restarted=bool(restarted),
            remote_addr=str(request.remote_addr or ""),
        )
        return jsonify({"ok": True, "restarted": bool(restarted), "file": os.path.basename(dst)}), 200

    # ---- API: create backups ----

    @bp.post("/api/backup")
    def api_create_backup() -> Any:
        """Create manual backup of routing config.

        Supports selected fragments via ?file=...

        If a raw routing file with comments (.jsonc) exists, the backup will include
        it under a special key so that comments can be restored later.
        """

        file_arg = request.args.get("file", "")
        selected = _resolve_fragment(file_arg, ROUTING_FILE, kind="routing")
        routing_main, routing_raw = _routing_paths_for(selected)

        raw_text = None
        if os.path.exists(routing_raw):
            try:
                with open(routing_raw, "r", encoding="utf-8") as f:
                    raw_text = f.read()
            except OSError:
                raw_text = None

        # Always try to load cleaned JSON as well for sanity / future use
        data = load_json(routing_main, default=None)

        if raw_text is None and data is None:
            return jsonify({"ok": False, "error": "routing file missing or invalid"}), 400

        if not os.path.isdir(BACKUP_DIR):
            os.makedirs(BACKUP_DIR, exist_ok=True)

        ts = time.strftime("%Y%m%d-%H%M%S")
        base = os.path.basename(routing_main)
        prefix = os.path.splitext(base)[0] or "05_routing"
        fname = f"{prefix}-{ts}.json"
        path = os.path.join(BACKUP_DIR, fname)

        # Payload format:
        # - legacy: plain JSON object (no special keys) if raw_text is None
        # - new: {"__xkeen_raw_jsonc__": "<raw>", "__xkeen_data__": <obj?>}
        if raw_text is not None:
            payload: Any = {"__xkeen_raw_jsonc__": raw_text}
            if data is not None:
                payload["__xkeen_data__"] = data
        else:
            payload = data

        save_json(path, payload)
        _core_log(
            "info",
            "backup.create",
            kind="routing",
            filename=fname,
            file=os.path.basename(routing_main),
            remote_addr=str(request.remote_addr or ""),
        )
        return jsonify({"ok": True, "filename": fname}), 200

    @bp.post("/api/backup-inbounds")
    def api_create_backup_inbounds() -> Any:
        file_arg = request.args.get("file", "")
        selected = _resolve_fragment(file_arg, INBOUNDS_FILE, kind="inbounds")

        data = load_json(selected, default=None)
        if data is None:
            return jsonify({"ok": False, "error": "inbounds file missing or invalid"}), 400

        if not os.path.isdir(BACKUP_DIR):
            os.makedirs(BACKUP_DIR, exist_ok=True)

        ts = time.strftime("%Y%m%d-%H%M%S")
        base = os.path.basename(selected)
        prefix = os.path.splitext(base)[0] or "03_inbounds"
        fname = f"{prefix}-{ts}.json"
        path = os.path.join(BACKUP_DIR, fname)
        save_json(path, data)
        _core_log(
            "info",
            "backup.create",
            kind="inbounds",
            filename=fname,
            file=os.path.basename(selected),
            remote_addr=str(request.remote_addr or ""),
        )
        return jsonify({"ok": True, "filename": fname}), 200

    @bp.post("/api/backup-outbounds")
    def api_create_backup_outbounds() -> Any:
        file_arg = request.args.get("file", "")
        selected = _resolve_fragment(file_arg, OUTBOUNDS_FILE, kind="outbounds")

        data = load_json(selected, default=None)
        if data is None:
            return jsonify({"ok": False, "error": "outbounds file missing or invalid"}), 400

        if not os.path.isdir(BACKUP_DIR):
            os.makedirs(BACKUP_DIR, exist_ok=True)

        ts = time.strftime("%Y%m%d-%H%M%S")
        base = os.path.basename(selected)
        prefix = os.path.splitext(base)[0] or "04_outbounds"
        fname = f"{prefix}-{ts}.json"
        path = os.path.join(BACKUP_DIR, fname)
        save_json(path, data)
        _core_log(
            "info",
            "backup.create",
            kind="outbounds",
            filename=fname,
            file=os.path.basename(selected),
            remote_addr=str(request.remote_addr or ""),
        )
        return jsonify({"ok": True, "filename": fname}), 200

    # ---- API: list / restore / delete ----

    @bp.get("/api/backups")
    def api_list_backups() -> Any:
        return jsonify(list_backups()), 200

    @bp.post("/api/restore")
    def api_restore_backup() -> Any:
        payload = request.get_json(silent=True) or {}
        filename = payload.get("filename")
        if not filename:
            return jsonify({"ok": False, "error": "filename is required"}), 400

        path = os.path.join(BACKUP_DIR, filename)
        if not os.path.isfile(path):
            return jsonify({"ok": False, "error": "backup not found"}), 404

        data = load_json(path, default=None)
        if data is None:
            return jsonify({"ok": False, "error": "backup file invalid"}), 400

        target_file = _detect_backup_target_file(filename)

        # routing backups created by /api/backup may include raw JSONC with comments.
        if isinstance(data, dict) and "__xkeen_raw_jsonc__" in data:
            raw = data.get("__xkeen_raw_jsonc__") or ""
            try:
                # Restore raw JSONC next to the target routing JSON.
                raw_path = target_file + "c" if target_file.endswith(".json") else target_file
                with open(raw_path, "w", encoding="utf-8") as f:
                    f.write(raw)

                cleaned = strip_json_comments_text(raw)
                if cleaned.strip():
                    obj = json.loads(cleaned)
                    save_json(target_file, obj)
            except Exception:
                cleaned_obj = data.get("__xkeen_data__")
                if cleaned_obj is not None:
                    save_json(target_file, cleaned_obj)
        else:
            save_json(target_file, data)

        _core_log(
            "info",
            "backup.restore",
            filename=str(filename),
            target=str(target_file),
            remote_addr=str(request.remote_addr or ""),
        )

        return jsonify({"ok": True}), 200

    @bp.post("/api/delete-backup")
    def api_delete_backup() -> Any:
        payload = request.get_json(silent=True) or {}
        filename = payload.get("filename")
        if not filename:
            return jsonify({"ok": False, "error": "filename is required"}), 400

        path = os.path.join(BACKUP_DIR, filename)
        if not os.path.isfile(path):
            return jsonify({"ok": False, "error": "backup not found"}), 404

        try:
            os.remove(path)
        except OSError:
            return jsonify({"ok": False, "error": "failed to delete backup"}), 500

        return jsonify({"ok": True}), 200

    @bp.post("/api/restore-auto")
    def api_restore_auto_backup() -> Any:
        payload = request.get_json(silent=True) or {}
        target = (payload.get("target") or "").strip()
        if target not in ("routing", "inbounds", "outbounds"):
            return jsonify({"ok": False, "error": "invalid target"}), 400

        file_arg = (payload.get("file") or "").strip()

        if target == "routing":
            config_path = _resolve_fragment(file_arg, ROUTING_FILE, kind="routing")
            # Auto-backups are made for main .json file
            if config_path.endswith(".jsonc"):
                config_path = config_path[:-1]
        elif target == "inbounds":
            config_path = _resolve_fragment(file_arg, INBOUNDS_FILE, kind="inbounds")
        else:
            config_path = _resolve_fragment(file_arg, OUTBOUNDS_FILE, kind="outbounds")

        backup_path, _mtime = _find_latest_auto_backup_for(config_path)
        if not backup_path:
            return jsonify({"ok": False, "error": "auto-backup not found"}), 404

        data = load_json(backup_path, default=None)
        if data is None:
            return jsonify({"ok": False, "error": "auto-backup file invalid"}), 400

        # If auto backup contains raw JSONC (rare), restore it too.
        if target == "routing" and isinstance(data, dict) and "__xkeen_raw_jsonc__" in data:
            raw = data.get("__xkeen_raw_jsonc__") or ""
            try:
                raw_path = config_path + "c"
                with open(raw_path, "w", encoding="utf-8") as f:
                    f.write(raw)

                cleaned = strip_json_comments_text(raw)
                if cleaned.strip():
                    obj = json.loads(cleaned)
                    save_json(config_path, obj)
            except Exception:
                cleaned_obj = data.get("__xkeen_data__")
                if cleaned_obj is not None:
                    save_json(config_path, cleaned_obj)
        else:
            save_json(config_path, data)

        filename = os.path.basename(backup_path)
        return (
            jsonify({"ok": True, "filename": filename, "target": target, "file": os.path.basename(config_path)}),
            200,
        )

    # ---- HTML restore (Backups page) ----

    @bp.post("/restore")
    def restore_from_backups_page() -> Any:
        filename = request.form.get("filename")
        if not filename:
            return redirect(url_for(".backups_page"))

        path = os.path.join(BACKUP_DIR, filename)
        if os.path.isfile(path):
            data = load_json(path, default=None)
            if data is not None:
                target_file = _detect_backup_target_file(filename)

                if isinstance(data, dict) and "__xkeen_raw_jsonc__" in data:
                    raw = data.get("__xkeen_raw_jsonc__") or ""
                    try:
                        raw_path = target_file + "c" if target_file.endswith(".json") else target_file
                        with open(raw_path, "w", encoding="utf-8") as f:
                            f.write(raw)

                        cleaned = strip_json_comments_text(raw)
                        if cleaned.strip():
                            obj = json.loads(cleaned)
                            save_json(target_file, obj)
                    except Exception:
                        cleaned_obj = data.get("__xkeen_data__")
                        if cleaned_obj is not None:
                            save_json(target_file, cleaned_obj)
                else:
                    save_json(target_file, data)

                restart_xkeen(source="backups-page")

        return redirect(url_for(".backups_page"))

    return bp

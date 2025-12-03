"""Backup-related page and API routes as a Flask Blueprint."""
from __future__ import annotations

import os
import json
import time

from flask import Blueprint, request, jsonify, render_template, redirect, url_for
from typing import Any, Callable, Dict, Optional



def error_response(message: str, status: int = 400, *, ok: bool | None = None) -> Any:
    """Return a JSON error response for this blueprint.

    Mirrors ``app.api_error`` format: at least ``{"error": ...}``,
    optionally with ``"ok": False`` when ``ok`` is explicitly passed.
    """
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

    @bp.get("/backups")
    def backups_page() -> Any:
        return render_template("backups.html", backups=list_backups(), backup_dir=BACKUP_DIR)

    # ---------- API: backups ----------

    @bp.post("/api/backup")
    def api_create_backup() -> Any:
        """Create manual backup of routing config.

        If a raw routing file with comments (ROUTING_FILE_RAW) exists, the backup
        will include it under a special key so that comments can be restored later.
        Otherwise we fall back to backing up the parsed JSON as before.
        """
        raw_text = None
        if os.path.exists(ROUTING_FILE_RAW):
            try:
                with open(ROUTING_FILE_RAW, "r") as f:
                    raw_text = f.read()
            except OSError:
                raw_text = None

        # Always try to load cleaned JSON as well for sanity / future use
        data = load_json(ROUTING_FILE, default=None)

        if raw_text is None and data is None:
            return jsonify({"ok": False, "error": "routing file missing or invalid"}), 400

        if not os.path.isdir(BACKUP_DIR):
            os.makedirs(BACKUP_DIR, exist_ok=True)

        ts = time.strftime("%Y%m%d-%H%M%S")
        fname = f"05_routing-{ts}.json"
        path = os.path.join(BACKUP_DIR, fname)

        # Payload format:
        # - legacy: plain JSON object (no special keys) if raw_text is None
        # - new: {"__xkeen_raw_jsonc__": "<raw>", "__xkeen_data__": <obj?>}
        if raw_text is not None:
            payload = {"__xkeen_raw_jsonc__": raw_text}
            if data is not None:
                payload["__xkeen_data__"] = data
        else:
            payload = data

        save_json(path, payload)
        return jsonify({"ok": True, "filename": fname}), 200


    @bp.post("/api/backup-inbounds")
    def api_create_backup_inbounds() -> Any:
        data = load_json(INBOUNDS_FILE, default=None)
        if data is None:
            return jsonify({"ok": False, "error": "inbounds file missing or invalid"}), 400

        if not os.path.isdir(BACKUP_DIR):
            os.makedirs(BACKUP_DIR, exist_ok=True)

        ts = time.strftime("%Y%m%d-%H%M%S")
        fname = f"03_inbounds-{ts}.json"
        path = os.path.join(BACKUP_DIR, fname)
        save_json(path, data)
        return jsonify({"ok": True, "filename": fname}), 200


    @bp.post("/api/backup-outbounds")
    def api_create_backup_outbounds() -> Any:
        data = load_json(OUTBOUNDS_FILE, default=None)
        if data is None:
            return jsonify({"ok": False, "error": "outbounds file missing or invalid"}), 400

        if not os.path.isdir(BACKUP_DIR):
            os.makedirs(BACKUP_DIR, exist_ok=True)

        ts = time.strftime("%Y%m%d-%H%M%S")
        fname = f"04_outbounds-{ts}.json"
        path = os.path.join(BACKUP_DIR, fname)
        save_json(path, data)
        return jsonify({"ok": True, "filename": fname}), 200


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
        save_json(target_file, data)
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

        if target == "routing":
            config_path = ROUTING_FILE
        elif target == "inbounds":
            config_path = INBOUNDS_FILE
        else:
            config_path = OUTBOUNDS_FILE

        backup_path, mtime = _find_latest_auto_backup_for(config_path)
        if not backup_path:
            return jsonify({"ok": False, "error": "auto-backup not found"}), 404

        data = load_json(backup_path, default=None)
        if data is None:
            return jsonify({"ok": False, "error": "auto-backup file invalid"}), 400

        save_json(config_path, data)
        filename = os.path.basename(backup_path)
        return jsonify(
            {
                "ok": True,
                "filename": filename,
                "target": target,
            }
        ), 200


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

                # Special handling for routing backups created by /api/backup:
                # if backup file contains __xkeen_raw_jsonc__, we restore comments too.
                if target_file == ROUTING_FILE and isinstance(data, dict) and "__xkeen_raw_jsonc__" in data:
                    raw = data.get("__xkeen_raw_jsonc__") or ""
                    try:
                        # 1) Restore raw JSONC with comments
                        with open(ROUTING_FILE_RAW, "w") as f:
                            f.write(raw)

                        # 2) Rebuild cleaned JSON into ROUTING_FILE from raw text
                        cleaned = strip_json_comments_text(raw)
                        if cleaned.strip():
                            obj = json.loads(cleaned)
                            save_json(ROUTING_FILE, obj)
                    except Exception:
                        # Fallback: if anything goes wrong, at least restore the cleaned data
                        cleaned_obj = data.get("__xkeen_data__")
                        if cleaned_obj is not None:
                            save_json(ROUTING_FILE, cleaned_obj)
                else:
                    # All other backups (including old-format routing) behave as before
                    save_json(target_file, data)

                restart_xkeen(source="backups-page")
        return redirect(url_for(".backups_page"))

    return bp

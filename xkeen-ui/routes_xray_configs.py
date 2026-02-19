"""Xray inbounds/outbounds API routes as a Flask Blueprint.

PR14: extracted from app.py.

Routes:
- GET/POST /api/inbounds
- GET/POST /api/outbounds
- GET /api/outbounds/fragments
- GET /api/xray/outbound-tags
- POST /api/xray/observatory/preset

All endpoints preserve historical response formats.
"""

from __future__ import annotations

import json
import os
from typing import Any, Callable, Dict

from flask import Blueprint, jsonify, request

from services.io.atomic import _atomic_write_json, _atomic_write_text

from services.xray_backups import atomic_write_bytes as _atomic_write_bytes
from services.xray_config_files import (
    INBOUNDS_FILE,
    OUTBOUNDS_FILE,
    XRAY_CONFIGS_DIR,
    ensure_xray_jsonc_dir,
    jsonc_path_for,
    legacy_jsonc_path_for,
    list_xray_fragments,
    resolve_xray_fragment_file,
)
from services.xray_inbounds import MIXED_INBOUNDS, REDIRECT_INBOUNDS, TPROXY_INBOUNDS, detect_inbounds_mode
from services.xray_outbounds import build_outbounds_config_from_link, build_proxy_url_from_config


from routes.common.errors import error_response


def create_xray_configs_blueprint(
    *,
    restart_xkeen: Callable[..., bool],
    load_json: Callable[..., Any],
    save_json: Callable[..., Any],
    strip_json_comments_text: Callable[[str], str],
    snapshot_xray_config_before_overwrite: Callable[[str], None],
) -> Blueprint:
    bp = Blueprint("xray_configs", __name__)

    # --- helpers ---

    def _normalize_main_json_path(p: str) -> str:
        """Normalize selected path to the main *.json fragment in XRAY_CONFIGS_DIR.

        Legacy/compatibility behavior:
          - if a caller passes a *.jsonc file path, treat it as a selection hint
            and map it to the corresponding *.json.
        """
        try:
            v = str(p or "")
        except Exception:
            v = ""
        lv = v.lower()
        if lv.endswith(".jsonc"):
            return v[:-1]  # .jsonc -> .json
        return v

    def _choose_raw_or_main(sel_path: str) -> tuple[str, str, bool]:
        """Return (chosen_path, raw_path, raw_exists).

        Stage 3 behavior:
          - raw JSONC sidecar is mapped into XRAY_JSONC_DIR via jsonc_path_for()
          - legacy raw JSONC next to main file is still read (fallback only)
          - choose raw for UI when it exists and is newer than main JSON
        """

        main_path = _normalize_main_json_path(sel_path)

        raw_path_canon = jsonc_path_for(main_path)
        raw_path_legacy = legacy_jsonc_path_for(main_path)

        raw_path = raw_path_canon
        raw_exists = False
        legacy_exists = False
        main_exists = False
        try:
            raw_exists = os.path.exists(raw_path_canon)
            legacy_exists = bool(raw_path_legacy) and os.path.exists(raw_path_legacy)
            main_exists = os.path.exists(main_path)
        except Exception:
            raw_exists = False
            legacy_exists = False
            main_exists = False

        # Fallback: if canonical sidecar doesn't exist yet, use legacy for read.
        if not raw_exists and legacy_exists:
            raw_path = raw_path_legacy
            raw_exists = True

        chosen_path = main_path

        if raw_exists:
            if main_exists:
                try:
                    st_raw = os.stat(raw_path)
                    st_main = os.stat(main_path)
                    raw_mtime_ns = getattr(st_raw, "st_mtime_ns", int(st_raw.st_mtime * 1_000_000_000))
                    main_mtime_ns = getattr(st_main, "st_mtime_ns", int(st_main.st_mtime * 1_000_000_000))
                    chosen_path = main_path if main_mtime_ns > raw_mtime_ns else raw_path
                except Exception:
                    chosen_path = raw_path
            else:
                chosen_path = raw_path

        return chosen_path, raw_path, bool(raw_exists)

    def _read_text_silent(path: str) -> str:
        try:
            with open(path, "r", encoding="utf-8") as f:
                return f.read()
        except Exception:
            return ""

    # --- API: inbounds ---

    @bp.get("/api/inbounds")
    def api_get_inbounds():
        file_arg = request.args.get("file", "")
        sel_path = resolve_xray_fragment_file(file_arg, kind="inbounds", default_path=INBOUNDS_FILE)
        sel_path = _normalize_main_json_path(sel_path)

        chosen_path, raw_path, raw_exists = _choose_raw_or_main(sel_path)
        text = _read_text_silent(chosen_path)

        obj: Any = None
        try:
            if text.strip():
                cleaned = strip_json_comments_text(text)
                obj = json.loads(cleaned) if cleaned.strip() else None
            else:
                obj = load_json(sel_path, default=None)
        except Exception:
            obj = load_json(sel_path, default=None)

        if obj is None:
            obj = {"inbounds": []}

        mode = detect_inbounds_mode(data=obj)

        if not text.strip():
            try:
                text = (json.dumps(obj, ensure_ascii=False, indent=2) if obj is not None else "{}") + "\n"
            except Exception:
                text = "{}\n"

        return (
            jsonify(
                {
                    "ok": True,
                    "mode": mode,
                    "config": obj,
                    "text": text,
                    "file": os.path.basename(sel_path),
                    "path": sel_path,
                    "raw_path": raw_path if raw_exists else None,
                    "using_raw": bool(chosen_path == raw_path and raw_exists),
                }
            ),
            200,
        )

    @bp.post("/api/inbounds")
    def api_set_inbounds():
        payload = request.get_json(silent=True) or {}
        file_arg = request.args.get("file", "")
        sel_path = resolve_xray_fragment_file(file_arg, kind="inbounds", default_path=INBOUNDS_FILE)
        sel_path = _normalize_main_json_path(sel_path)

        # Raw JSON/JSONC save mode (keeps comments in *.jsonc)
        if isinstance(payload.get("text"), str):
            raw_text = payload.get("text") or ""
            if not raw_text.strip():
                return error_response("empty text", 400, ok=False)

            cleaned = strip_json_comments_text(raw_text)
            try:
                obj = json.loads(cleaned)
            except Exception as e:
                return error_response(f"invalid json: {e}", 400, ok=False)

            if not isinstance(obj, dict):
                return error_response("config must be object", 400, ok=False)

            raw_path = jsonc_path_for(sel_path)
            ensure_xray_jsonc_dir()

            snapshot_xray_config_before_overwrite(sel_path)
            snapshot_xray_config_before_overwrite(raw_path)

            # IMPORTANT: write clean JSON first, then raw JSONC last.
            try:
                d = os.path.dirname(sel_path)
                if d and not os.path.isdir(d):
                    os.makedirs(d, exist_ok=True)
                _atomic_write_json(sel_path, obj)
            except Exception as e:
                return error_response(f"failed to write file: {e}", 500, ok=False)

            try:
                d_raw = os.path.dirname(raw_path)
                if d_raw and not os.path.isdir(d_raw):
                    os.makedirs(d_raw, exist_ok=True)
                _atomic_write_text(raw_path, raw_text)
            except Exception as e:
                return error_response(f"failed to write raw file: {e}", 500, ok=False)

            restart_flag = bool(payload.get("restart", True))
            restarted = restart_flag and restart_xkeen(source="inbounds")
            mode = detect_inbounds_mode(data=obj)
            return jsonify({"ok": True, "restarted": restarted, "file": os.path.basename(sel_path), "mode": mode}), 200

        mode = (payload.get("mode") or "").strip().lower()
        if mode == "mixed":
            data = MIXED_INBOUNDS
        elif mode == "tproxy":
            data = TPROXY_INBOUNDS
        elif mode == "redirect":
            data = REDIRECT_INBOUNDS
        else:
            data = payload.get("config")
            if not isinstance(data, dict):
                return error_response("config must be object", 400, ok=False)

        snapshot_xray_config_before_overwrite(sel_path)
        try:
            save_json(sel_path, data)
        except Exception as e:
            return error_response(str(e), 500, ok=False)

        restart_flag = bool(payload.get("restart", True))
        restarted = restart_flag and restart_xkeen(source="inbounds")
        mode2 = detect_inbounds_mode(data=data)
        return jsonify({"ok": True, "restarted": restarted, "file": os.path.basename(sel_path), "mode": mode2}), 200

    # --- API: outbounds ---

    @bp.get("/api/outbounds")
    def api_get_outbounds():
        file_arg = request.args.get("file", "")
        sel_path = resolve_xray_fragment_file(file_arg, kind="outbounds", default_path=OUTBOUNDS_FILE)
        sel_path = _normalize_main_json_path(sel_path)

        chosen_path, raw_path, raw_exists = _choose_raw_or_main(sel_path)
        text = _read_text_silent(chosen_path)

        cfg = None
        try:
            if text.strip():
                cleaned = strip_json_comments_text(text)
                cfg = json.loads(cleaned) if cleaned.strip() else None
            else:
                cfg = load_json(sel_path, default=None)
        except Exception:
            cfg = load_json(sel_path, default=None)

        url = None
        if cfg:
            try:
                url = build_proxy_url_from_config(cfg)
            except Exception:
                url = None

        if not text.strip():
            try:
                text = (json.dumps(cfg, ensure_ascii=False, indent=2) if cfg is not None else "{}") + "\n"
            except Exception:
                text = "{}\n"

        return (
            jsonify(
                {
                    "ok": True,
                    "url": url,
                    "config": cfg,
                    "text": text,
                    "file": os.path.basename(sel_path),
                    "path": sel_path,
                    "raw_path": raw_path if raw_exists else None,
                    "using_raw": bool(chosen_path == raw_path and raw_exists),
                }
            ),
            200,
        )

    @bp.post("/api/outbounds")
    def api_set_outbounds():
        payload = request.get_json(silent=True) or {}
        file_arg = request.args.get("file", "")
        sel_path = resolve_xray_fragment_file(file_arg, kind="outbounds", default_path=OUTBOUNDS_FILE)
        sel_path = _normalize_main_json_path(sel_path)

        # Raw JSON/JSONC save mode (keeps comments in *.jsonc)
        if isinstance(payload.get("text"), str):
            raw_text = payload.get("text") or ""
            if not raw_text.strip():
                return error_response("empty text", 400, ok=False)

            cleaned = strip_json_comments_text(raw_text)
            try:
                obj = json.loads(cleaned)
            except Exception as e:
                return error_response(f"invalid json: {e}", 400, ok=False)

            if not isinstance(obj, dict):
                return error_response("config must be object", 400, ok=False)

            raw_path = jsonc_path_for(sel_path)
            ensure_xray_jsonc_dir()

            snapshot_xray_config_before_overwrite(sel_path)
            snapshot_xray_config_before_overwrite(raw_path)

            # IMPORTANT: write clean JSON first, then raw JSONC last.
            try:
                d = os.path.dirname(sel_path)
                if d and not os.path.isdir(d):
                    os.makedirs(d, exist_ok=True)
                _atomic_write_json(sel_path, obj)
            except Exception as e:
                return error_response(f"failed to write file: {e}", 500, ok=False)

            try:
                d_raw = os.path.dirname(raw_path)
                if d_raw and not os.path.isdir(d_raw):
                    os.makedirs(d_raw, exist_ok=True)
                _atomic_write_text(raw_path, raw_text)
            except Exception as e:
                return error_response(f"failed to write raw file: {e}", 500, ok=False)

            restart_flag = bool(payload.get("restart", True))
            restarted = restart_flag and restart_xkeen(source="outbounds")
            return jsonify({"ok": True, "restarted": restarted, "file": os.path.basename(sel_path)}), 200

        # New: direct config save
        if "config" in payload:
            cfg = payload.get("config")
            if not isinstance(cfg, dict):
                return error_response("config must be object", 400, ok=False)
        else:
            # Old: build config from URL
            url = (payload.get("url") or "").strip()
            if not url:
                return error_response("url is required", 400, ok=False)
            try:
                cfg = build_outbounds_config_from_link(url)
            except Exception as e:
                return error_response(str(e), 400, ok=False)

        snapshot_xray_config_before_overwrite(sel_path)
        try:
            save_json(sel_path, cfg)
        except Exception as e:
            return error_response(str(e), 500, ok=False)

        restart_flag = bool(payload.get("restart", True))
        restarted = restart_flag and restart_xkeen(source="outbounds")
        return jsonify({"ok": True, "restarted": restarted, "file": os.path.basename(sel_path)}), 200

    # --- API: outbounds fragments list ---

    @bp.get("/api/outbounds/fragments")
    def api_list_outbounds_fragments():
        items = list_xray_fragments("outbounds")
        current_name = os.path.basename(OUTBOUNDS_FILE)
        return jsonify({"ok": True, "dir": XRAY_CONFIGS_DIR, "current": current_name, "items": items}), 200

    # --- API: Xray outbound tags (for selector UI) ---

    @bp.get("/api/xray/outbound-tags")
    def api_xray_outbound_tags():
        file_arg = request.args.get("file", "")
        sel_path = resolve_xray_fragment_file(file_arg, kind="outbounds", default_path=OUTBOUNDS_FILE)
        sel_path = _normalize_main_json_path(sel_path)

        # Prefer raw JSONC variant (with comments) if present.
        chosen_path, raw_path, raw_exists = _choose_raw_or_main(sel_path)

        text = _read_text_silent(chosen_path)

        tags: list[str] = []
        seen: set[str] = set()
        try:
            obj: Any = None
            if text.strip():
                cleaned = strip_json_comments_text(text)
                obj = json.loads(cleaned) if cleaned.strip() else None
            else:
                obj = load_json(sel_path, default=None)

            outbounds = None
            if isinstance(obj, dict):
                outbounds = obj.get("outbounds")
            elif isinstance(obj, list):
                outbounds = obj

            if isinstance(outbounds, list):
                for o in outbounds:
                    if not isinstance(o, dict):
                        continue
                    t = o.get("tag")
                    if not isinstance(t, str):
                        continue
                    t = t.strip()
                    if not t or t in seen:
                        continue
                    seen.add(t)
                    tags.append(t)
        except Exception:
            tags = []

        return jsonify({"ok": True, "tags": tags}), 200

    # --- API: Xray observatory preset (for balancer leastPing) ---

    @bp.post("/api/xray/observatory/preset")
    def api_xray_observatory_preset():
        """Create 07_observatory.json (+ .jsonc) from the bundled template."""
        payload = request.get_json(silent=True) or {}
        restart_flag = bool(payload.get("restart", False))

        dst_json = os.path.join(XRAY_CONFIGS_DIR, "07_observatory.json")
        dst_jsonc = jsonc_path_for(dst_json)
        legacy_dst_jsonc = legacy_jsonc_path_for(dst_json)
        ensure_xray_jsonc_dir()

        existed_json = False
        existed_jsonc = False
        existed_legacy_jsonc = False
        try:
            existed_json = os.path.exists(dst_json)
            existed_jsonc = os.path.exists(dst_jsonc)
            existed_legacy_jsonc = bool(legacy_dst_jsonc) and os.path.exists(legacy_dst_jsonc)
        except Exception:
            existed_json = False
            existed_jsonc = False
            existed_legacy_jsonc = False

        # If JSON already exists — don't overwrite.
        if existed_json:
            wrote: list[str] = []
            if not existed_jsonc:
                try:
                    tpl_text = ""
                    tpl_default = os.path.join(
                        (os.environ.get("XKEEN_UI_STATE_DIR") or os.environ.get("XKEEN_UI_DIR") or "/opt/etc/xkeen-ui"),
                        "templates", "observatory", "07_observatory_base.jsonc",
                    )
                    tpl_path = os.environ.get("XKEEN_XRAY_OBSERVATORY_TEMPLATE", tpl_default)
                    if tpl_path and os.path.exists(tpl_path):
                        with open(tpl_path, "r", encoding="utf-8") as f:
                            tpl_text = f.read()
                    if not tpl_text:
                        base_dir = os.path.dirname(os.path.abspath(__file__))
                        bundled = os.path.join(
                            base_dir,
                            "opt",
                            "etc",
                            "xray",
                            "templates",
                            "observatory",
                            "07_observatory_base.jsonc",
                        )
                        if os.path.exists(bundled):
                            with open(bundled, "r", encoding="utf-8") as f:
                                tpl_text = f.read()
                    if tpl_text:
                        _atomic_write_bytes(dst_jsonc, (tpl_text.rstrip("\n") + "\n").encode("utf-8"), mode=0o644)
                        wrote.append(os.path.basename(dst_jsonc))
                except Exception:
                    pass

            restarted = restart_flag and restart_xkeen(source="observatory-preset")
            return jsonify({"ok": True, "existed": True, "files": wrote, "restarted": restarted}), 200

        # Load template text (prefer /opt/etc, fallback to bundled UI archive).
        tpl_text = ""
        tpl_default = os.path.join(
            (os.environ.get("XKEEN_UI_STATE_DIR") or os.environ.get("XKEEN_UI_DIR") or "/opt/etc/xkeen-ui"),
            "templates", "observatory", "07_observatory_base.jsonc",
        )
        tpl_path = os.environ.get("XKEEN_XRAY_OBSERVATORY_TEMPLATE", tpl_default)
        try:
            if tpl_path and os.path.exists(tpl_path):
                with open(tpl_path, "r", encoding="utf-8") as f:
                    tpl_text = f.read()
        except Exception:
            tpl_text = ""

        if not tpl_text:
            try:
                base_dir = os.path.dirname(os.path.abspath(__file__))
                bundled = os.path.join(
                    base_dir,
                    "opt",
                    "etc",
                    "xray",
                    "templates",
                    "observatory",
                    "07_observatory_base.jsonc",
                )
                if os.path.exists(bundled):
                    with open(bundled, "r", encoding="utf-8") as f:
                        tpl_text = f.read()
            except Exception:
                tpl_text = ""

        # Final fallback: minimal config in code.
        if not tpl_text:
            tpl_text = (
                '{\n'
                '  "observatory": {\n'
                '    "subjectSelector": ["proxy"],\n'
                '    "probeUrl": "https://www.google.com/generate_204",\n'
                '    "probeInterval": "60s",\n'
                '    "enableConcurrency": true\n'
                '  }\n'
                '}\n'
            )

        # Parse JSON from JSONC template.
        cfg_obj: dict[str, Any] = {}
        try:
            cleaned = strip_json_comments_text(tpl_text)
            parsed = json.loads(cleaned) if cleaned.strip() else {}
            if isinstance(parsed, dict):
                cfg_obj = parsed
        except Exception:
            cfg_obj = {}

        if not isinstance(cfg_obj, dict) or not cfg_obj:
            cfg_obj = {
                "observatory": {
                    "subjectSelector": ["proxy"],
                    "probeUrl": "https://www.google.com/generate_204",
                    "probeInterval": "60s",
                    "enableConcurrency": True,
                }
            }

        files_written: list[str] = []

        # Write JSON (for Xray)
        try:
            pretty = json.dumps(cfg_obj, ensure_ascii=False, indent=2) + "\n"
            _atomic_write_bytes(dst_json, pretty.encode("utf-8"), mode=0o644)
            files_written.append(os.path.basename(dst_json))
        except Exception:
            return error_response("failed to write observatory json", 500, ok=False)

        # Write JSONC (for UI), but don't overwrite if already exists.
        try:
            if not existed_jsonc:
                _atomic_write_bytes(dst_jsonc, (tpl_text.rstrip("\n") + "\n").encode("utf-8"), mode=0o644)
                files_written.append(os.path.basename(dst_jsonc))
        except Exception:
            pass

        restarted = restart_flag and restart_xkeen(source="observatory-preset")
        return jsonify({"ok": True, "existed": False, "files": files_written, "restarted": restarted}), 200

    return bp

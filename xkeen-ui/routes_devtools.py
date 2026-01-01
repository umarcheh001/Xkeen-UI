"""DevTools API routes (UI logs, UI service control, env editor).

Blueprint endpoints are protected by the global auth_guard in app.py.
"""

from __future__ import annotations

import os

from flask import Blueprint, jsonify, request, send_file

from typing import Any, Dict

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


def _redact_env_updates(updates: dict) -> dict:
    """Return a safe-to-log version of env updates (keys only, values redacted)."""
    out = {}
    try:
        for k in list(updates.keys())[:50]:
            key = str(k)
            lk = key.upper()
            sensitive = any(s in lk for s in ("PASS", "PASSWORD", "SECRET", "TOKEN", "KEY", "COOKIE"))
            out[key] = "***" if sensitive else "(set)"
    except Exception:
        return {"_error": "redact_failed"}
    return out


from services import devtools as dt
from services import branding as br

try:
    from services.logging_setup import refresh_runtime_from_env as _refresh_logging
except Exception:  # logging is optional
    _refresh_logging = None



def create_devtools_blueprint(ui_state_dir: str) -> Blueprint:
    bp = Blueprint("devtools", __name__)

    @bp.get("/api/devtools/env")
    def api_devtools_env_get() -> Any:
        items = dt.get_env_items(ui_state_dir)
        return jsonify(
            {
                "ok": True,
                "env_file": dt._env_file_path(ui_state_dir),  # type: ignore[attr-defined]
                "items": [
                    {
                        "key": it.key,
                        "current": it.current,
                        "configured": it.configured,
                        "effective": it.effective,
                        "is_sensitive": bool(it.is_sensitive),
                        "readonly": bool(getattr(it, "readonly", False)),
                    }
                    for it in items
                ],
            }
        )

    @bp.post("/api/devtools/env")
    def api_devtools_env_set() -> Any:
        payload = request.get_json(silent=True) or {}

        updates: Dict[str, Any] = {}
        if isinstance(payload.get("updates"), dict):
            updates = dict(payload.get("updates") or {})
        else:
            # Single-key format
            k = payload.get("key")
            if isinstance(k, str) and k.strip():
                updates[k.strip()] = payload.get("value")

        _core_log("info", "devtools.env_set", updates=_redact_env_updates(updates), remote_addr=str(request.remote_addr or ""))
        items = dt.set_env(ui_state_dir, updates)

        try:
            if _refresh_logging:
                _refresh_logging()
        except Exception:
            pass
        return jsonify(
            {
                "ok": True,
                "env_file": dt._env_file_path(ui_state_dir),  # type: ignore[attr-defined]
                "items": [
                    {
                        "key": it.key,
                        "current": it.current,
                        "configured": it.configured,
                        "effective": it.effective,
                        "is_sensitive": bool(it.is_sensitive),
                        "readonly": bool(getattr(it, "readonly", False)),
                    }
                    for it in items
                ],
            }
        )

    

    # --- Theme editor (global custom theme stored in UI_STATE_DIR) ---

    @bp.get("/api/devtools/theme")
    def api_devtools_theme_get() -> Any:
        data = dt.theme_get(ui_state_dir)
        return jsonify({"ok": True, **data})

    @bp.post("/api/devtools/theme")
    def api_devtools_theme_set() -> Any:
        payload = request.get_json(silent=True) or {}
        cfg_in = payload.get("config") if isinstance(payload, dict) else None
        if cfg_in is None:
            cfg_in = payload
        data = dt.theme_set(ui_state_dir, cfg_in)
        return jsonify({"ok": True, **data})

    @bp.post("/api/devtools/theme/reset")
    def api_devtools_theme_reset() -> Any:
        data = dt.theme_reset(ui_state_dir)
        return jsonify({"ok": True, **data})


    # --- Branding (global, stored in UI_STATE_DIR/branding.json) ---

    @bp.get("/api/devtools/branding")
    def api_devtools_branding_get() -> Any:
        data = br.branding_get(ui_state_dir)
        return jsonify({"ok": True, **data})

    @bp.post("/api/devtools/branding")
    def api_devtools_branding_set() -> Any:
        payload = request.get_json(silent=True) or {}
        cfg_in = payload.get("config") if isinstance(payload, dict) else None
        if cfg_in is None:
            cfg_in = payload
        data = br.branding_set(ui_state_dir, cfg_in)
        return jsonify({"ok": True, **data})

    @bp.post("/api/devtools/branding/reset")
    def api_devtools_branding_reset() -> Any:
        data = br.branding_reset(ui_state_dir)
        return jsonify({"ok": True, **data})


    # --- Custom CSS editor (global custom.css stored in UI_STATE_DIR) ---

    @bp.get("/api/devtools/custom_css")
    def api_devtools_custom_css_get() -> Any:
        data = dt.custom_css_get(ui_state_dir)
        return jsonify({"ok": True, **data})

    @bp.post("/api/devtools/custom_css/save")
    def api_devtools_custom_css_save() -> Any:
        payload = request.get_json(silent=True) or {}
        css = None
        if isinstance(payload, dict):
            css = payload.get("css")
            if css is None:
                css = payload.get("content")
        try:
            data = dt.custom_css_set(ui_state_dir, css)
        except ValueError as e:
            return jsonify({"ok": False, "error": str(e) or "invalid"}), 400
        return jsonify({"ok": True, **data})

    @bp.post("/api/devtools/custom_css/disable")
    def api_devtools_custom_css_disable() -> Any:
        data = dt.custom_css_disable(ui_state_dir)
        return jsonify({"ok": True, **data})

    @bp.post("/api/devtools/custom_css/reset")
    def api_devtools_custom_css_reset() -> Any:
        data = dt.custom_css_reset(ui_state_dir)
        return jsonify({"ok": True, **data})

    @bp.get("/api/devtools/logs")
    def api_devtools_logs_list() -> Any:
        return jsonify({"ok": True, "logs": dt.list_logs()})

    @bp.get("/api/devtools/logs/<name>")
    def api_devtools_logs_tail(name: str) -> Any:
        cursor = request.args.get("cursor")
        try:
            lines = int(request.args.get("lines", "400") or "400")
        except Exception:
            lines = 400
        try:
            path, lns, new_cursor, mode = dt.tail_log(name, lines=lines, cursor=cursor)
        except ValueError:
            return jsonify({"ok": False, "error": "unknown_log"}), 404

        # Include lightweight metadata for UI (size/mtime/ino), so the sidebar can update
        # without an extra stat call.
        meta = {"size": 0, "mtime": 0.0, "ino": 0, "exists": False}
        try:
            st = os.stat(path)
            meta = {
                "size": int(getattr(st, "st_size", 0) or 0),
                "mtime": float(getattr(st, "st_mtime", 0.0) or 0.0),
                "ino": int(getattr(st, "st_ino", 0) or 0),
                "exists": True,
            }
        except Exception:
            pass

        return jsonify({"ok": True, "name": name, "path": path, "lines": lns, "cursor": new_cursor, "mode": mode, **meta})


    @bp.get("/api/devtools/logs/<name>/download")
    def api_devtools_logs_download(name: str) -> Any:
        path = dt._resolve_log_path(name)  # type: ignore[attr-defined]
        if not path:
            return jsonify({"ok": False, "error": "unknown_log"}), 404
        if not os.path.isfile(path):
            return jsonify({"ok": False, "error": "not_found"}), 404
        try:
            return send_file(path, as_attachment=True, download_name=f"{name}.log")
        except TypeError:
            # Flask < 2.0
            return send_file(path, as_attachment=True, attachment_filename=f"{name}.log")

    @bp.post("/api/devtools/logs/<name>/truncate")
    def api_devtools_logs_truncate(name: str) -> Any:
        _core_log("info", "devtools.log_truncate", name=name, remote_addr=str(request.remote_addr or ""))
        try:
            path = dt.truncate_log(name)
        except ValueError:
            return jsonify({"ok": False, "error": "unknown_log"}), 404
        return jsonify({"ok": True, "name": name, "path": path})

    @bp.get("/api/devtools/ui/status")
    def api_devtools_ui_status() -> Any:
        st = dt.ui_status()
        return jsonify({"ok": True, **st})

    @bp.post("/api/devtools/ui/<action>")
    def api_devtools_ui_action(action: str) -> Any:
        try:
            res = dt.ui_action(action)
        except ValueError:
            return jsonify({"ok": False, "error": "bad_action"}), 400
        code = 200 if res.get("ok") else 500
        return jsonify(res), code

    return bp

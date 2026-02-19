"""/api/routing/templates* endpoints.

Moved from routes_routing.py as part of refactor checklist (B3 step 6).

Template helper functions are in services.routing.templates (B3 step 4).
"""

from __future__ import annotations

import json
import os
from typing import Any, Callable, Dict

from flask import Blueprint, request, jsonify, current_app

from routes.common.errors import error_response

from services.routing.templates import (
    _compose_template_text,
    _normalize_template_filename,
    _read_template_file_meta,
    _seed_routing_templates_once,
)

from .errors import _no_cache


def register_templates_routes(
    bp: Blueprint,
    *,
    routing_file: str,
    strip_json_comments_text: Callable[[str], str],
    template_meta: Dict[str, Dict[str, str]],
) -> None:
    # Routing templates should live OUTSIDE /opt/etc/xray so that Xray/xkeen
    # won't accidentally pick them up from -confdir scans.
    # Default: <UI_STATE_DIR>/templates/routing
    try:
        from core.paths import get_ui_state_dir
        _ui_state = get_ui_state_dir()
    except Exception:
        _ui_state = os.environ.get("XKEEN_UI_STATE_DIR") or os.environ.get("XKEEN_UI_DIR") or "/opt/etc/xkeen-ui"

    routing_templates_dir = os.getenv(
        "XKEEN_XRAY_ROUTING_TEMPLATES_DIR",
        os.path.join(_ui_state, "templates", "routing"),
    )

    # Seed built-in templates only once.
    try:
        _seed_routing_templates_once(routing_templates_dir)
    except Exception:
        pass

    @bp.get("/api/routing/templates")
    def api_list_routing_templates() -> Any:
        """List available routing templates (local files)."""
        items = []
        try:
            os.makedirs(routing_templates_dir, exist_ok=True)
        except Exception:
            pass

        try:
            names = []
            for n in os.listdir(routing_templates_dir):
                if not (n.endswith(".json") or n.endswith(".jsonc")):
                    continue
                if n.startswith("_routing_templates_meta"):
                    continue
                p = os.path.join(routing_templates_dir, n)
                if os.path.isfile(p):
                    names.append(n)
        except Exception:
            names = []

        try:
            known = [n for n in template_meta.keys() if n in names]
            rest = sorted([n for n in names if n not in template_meta])
            names = known + rest
        except Exception:
            names = sorted(names)

        for fname in names:
            path = os.path.join(routing_templates_dir, fname)
            meta: Dict[str, str] = {}
            try:
                meta = _read_template_file_meta(path)
            except Exception:
                meta = {}

            builtin_meta = template_meta.get(fname, {})
            title = (meta.get("title") or builtin_meta.get("title") or fname)
            desc = (meta.get("description") or builtin_meta.get("description") or "")
            builtin = fname in template_meta

            items.append({
                "filename": fname,
                "title": title,
                "description": desc,
                "builtin": bool(builtin),
            })

        return jsonify({"ok": True, "items": items, "templates": items})

    @bp.get("/api/routing/templates/<string:filename>")
    def api_get_routing_template(filename: str) -> Any:
        """Return a template file content as text/plain."""
        fname = str(filename or "").strip()
        if not fname or "/" in fname or "\\" in fname:
            return error_response("invalid template name", 400, ok=False)
        if not (fname.endswith(".json") or fname.endswith(".jsonc")):
            return error_response("invalid template extension", 400, ok=False)

        path = os.path.join(routing_templates_dir, fname)
        if not os.path.isfile(path):
            return error_response("template not found", 404, ok=False)
        try:
            with open(path, "r", encoding="utf-8") as f:
                text = f.read()
        except Exception as e:
            return error_response(f"failed to read template: {e}", 500, ok=False)

        resp = current_app.response_class(text, mimetype="text/plain; charset=utf-8")
        return _no_cache(resp)

    @bp.post("/api/routing/templates")
    def api_save_routing_template() -> Any:
        """Create/update a user routing template."""
        data = request.get_json(silent=True) or {}
        fname = _normalize_template_filename(data.get("filename") or data.get("name") or "")
        if not fname:
            return error_response("invalid template name", 400, ok=False)

        if fname in template_meta:
            return error_response("built-in templates cannot be overwritten", 403, ok=False)

        content = str(data.get("content") or "")
        if not content.strip():
            return error_response("empty content", 400, ok=False)

        overwrite = bool(data.get("overwrite"))
        title = str(data.get("title") or "")
        desc = str(data.get("description") or "")

        try:
            cleaned = strip_json_comments_text(content)
            json.loads(cleaned)
        except Exception as e:
            return error_response(f"invalid json/jsonc: {e}", 400, ok=False)

        try:
            os.makedirs(routing_templates_dir, exist_ok=True)
        except Exception:
            pass

        path = os.path.join(routing_templates_dir, fname)
        exists = os.path.isfile(path)
        if exists and not overwrite:
            return error_response("template already exists", 409, ok=False)

        if exists and overwrite and (not title.strip() or not desc.strip()):
            try:
                old_meta = _read_template_file_meta(path)
            except Exception:
                old_meta = {}
            if not title.strip():
                title = str(old_meta.get("title") or "")
            if not desc.strip():
                desc = str(old_meta.get("description") or "")

        final_text = _compose_template_text(title, desc, content)

        try:
            tmp_path = path + ".tmp"
            with open(tmp_path, "w", encoding="utf-8") as f:
                f.write(final_text)
            os.replace(tmp_path, path)
        except Exception as e:
            return error_response(f"failed to write template: {e}", 500, ok=False)

        out_meta = _read_template_file_meta(path)
        return jsonify({
            "ok": True,
            "filename": fname,
            "title": out_meta.get("title") or fname,
            "description": out_meta.get("description") or "",
            "builtin": False,
        })

    @bp.delete("/api/routing/templates/<string:filename>")
    def api_delete_routing_template(filename: str) -> Any:
        """Delete a user routing template file."""
        fname = _normalize_template_filename(filename)
        if not fname:
            return error_response("invalid template name", 400, ok=False)
        if fname in template_meta:
            return error_response("built-in templates cannot be deleted", 403, ok=False)

        path = os.path.join(routing_templates_dir, fname)
        if not os.path.isfile(path):
            return error_response("template not found", 404, ok=False)
        try:
            os.remove(path)
        except Exception as e:
            return error_response(f"failed to delete template: {e}", 500, ok=False)
        return jsonify({"ok": True, "deleted": fname})

"""Utility / helper API routes.

PR10: move small standalone endpoints out of app.py.

Currently contains:
- POST /api/json/format : format JSON/JSONC text while trying to preserve comments.
- POST /api/log/event   : record a UI-side event (e.g. diff.compare) into core.log.

Important: keep URL paths and response schema stable.
"""

from __future__ import annotations

import json
from typing import Any, Dict

from flask import Blueprint, jsonify, request

from routes.common.errors import error_response
from services.ui_settings import load_settings
from utils.jsonc import strip_json_comments_text, format_jsonc_text

try:
    from services.logging_setup import core_logger as _core_logger_factory
    _CORE_LOGGER = _core_logger_factory()
except Exception:
    _CORE_LOGGER = None


_ALLOWED_EVENT_KINDS = frozenset({
    "diff.compare",
})

_MAX_FIELD_LEN = 120


def _api_error(message: str, status: int = 400, *, ok: bool | None = None, **extra: Any):
    """Local copy of api_error() to avoid circular imports.

    Must match app.api_error() response schema:
      {"error": "...", "ok": false?}
    """
    payload: Dict[str, Any] = {"error": message}
    if ok is not None:
        payload["ok"] = ok
    if extra:
        payload.update(extra)
    return jsonify(payload), status


def _load_json_format_preferences() -> Dict[str, int]:
    try:
        cfg = load_settings()
    except Exception:
        cfg = {}

    fmt = cfg.get("format") if isinstance(cfg, dict) else {}
    if not isinstance(fmt, dict):
        fmt = {}

    tab_width = fmt.get("tabWidth", 2)
    print_width = fmt.get("printWidth", 80)

    try:
        tab_width = int(tab_width)
    except Exception:
        tab_width = 2
    try:
        print_width = int(print_width)
    except Exception:
        print_width = 80

    tab_width = max(1, min(8, tab_width))
    print_width = max(40, min(200, print_width))
    return {"tabWidth": tab_width, "printWidth": print_width}


def create_utils_blueprint() -> Blueprint:
    bp = Blueprint("utils", __name__)

    @bp.post("/api/json/format")
    def api_format_jsonc():
        """Format JSON/JSONC text with indentation while trying to preserve comments.

        Request JSON:
          {"text": "..."}

        Response:
          {"ok": true, "text": "...", "engine": "xkeen_jsonc"|"json"}
        """
        payload = request.get_json(silent=True) or {}
        text = payload.get("text", "")
        if not isinstance(text, str):
            try:
                text = str(text)
            except Exception:
                text = ""
        if not text.strip():
            return _api_error("empty text", 400, ok=False)

        # Validate JSON ignoring comments.
        cleaned = strip_json_comments_text(text)
        try:
            obj = json.loads(cleaned)
        except Exception:
            return error_response(
                "Передан некорректный JSON.",
                400,
                ok=False,
                code="invalid_json",
                hint="Исправьте синтаксис JSON и попробуйте снова.",
            )

        prefs = _load_json_format_preferences()

        # Dependency-free JSONC formatter (keeps comments).
        try:
            formatted = format_jsonc_text(text, indent_size=prefs["tabWidth"])
            return jsonify({"ok": True, "text": formatted, "engine": "xkeen_jsonc", "tabWidth": prefs["tabWidth"], "printWidth": prefs["printWidth"]}), 200
        except Exception:
            # Fallback: strict JSON pretty print (comments will be removed)
            formatted = json.dumps(obj, ensure_ascii=False, indent=prefs["tabWidth"]) + "\n"
            return jsonify({"ok": True, "text": formatted, "engine": "json", "tabWidth": prefs["tabWidth"], "printWidth": prefs["printWidth"]}), 200

    @bp.post("/api/log/event")
    def api_log_event():
        """Record a small UI-side event into core.log.

        Body: {"kind": "diff.compare", ...arbitrary string fields}
        Only kinds from _ALLOWED_EVENT_KINDS are accepted; values are clamped.
        """
        payload = request.get_json(silent=True) or {}
        if not isinstance(payload, dict):
            return _api_error("bad_payload", 400, ok=False)

        kind = str(payload.get("kind", "")).strip()
        if kind not in _ALLOWED_EVENT_KINDS:
            return _api_error("bad_kind", 400, ok=False)

        extra: Dict[str, str] = {}
        for k, v in payload.items():
            if k == "kind":
                continue
            try:
                key = str(k)[:32]
                val = str(v)[:_MAX_FIELD_LEN]
            except Exception:
                continue
            if key:
                extra[key] = val

        if _CORE_LOGGER is not None:
            try:
                if extra:
                    tail = ", ".join(f"{k}={v}" for k, v in extra.items())
                    _CORE_LOGGER.info(f"ui.event {kind} | {tail}")
                else:
                    _CORE_LOGGER.info(f"ui.event {kind}")
            except Exception:
                pass

        return jsonify({"ok": True}), 200

    return bp

"""Utility / helper API routes.

PR10: move small standalone endpoints out of app.py.

Currently contains:
- POST /api/json/format : format JSON/JSONC text while trying to preserve comments.

Important: keep URL paths and response schema stable.
"""

from __future__ import annotations

import json
from typing import Any, Dict

from flask import Blueprint, jsonify, request

from utils.jsonc import strip_json_comments_text, format_jsonc_text


def _api_error(message: str, status: int = 400, *, ok: bool | None = None):
    """Local copy of api_error() to avoid circular imports.

    Must match app.api_error() response schema:
      {"error": "...", "ok": false?}
    """
    payload: Dict[str, Any] = {"error": message}
    if ok is not None:
        payload["ok"] = ok
    return jsonify(payload), status


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
        except Exception as e:
            return _api_error(f"invalid json: {e}", 400, ok=False)

        # Dependency-free JSONC formatter (keeps comments).
        try:
            formatted = format_jsonc_text(text, indent_size=2)
            return jsonify({"ok": True, "text": formatted, "engine": "xkeen_jsonc"}), 200
        except Exception:
            # Fallback: strict JSON pretty print (comments will be removed)
            formatted = json.dumps(obj, ensure_ascii=False, indent=2) + "\n"
            return jsonify({"ok": True, "text": formatted, "engine": "json"}), 200

    return bp

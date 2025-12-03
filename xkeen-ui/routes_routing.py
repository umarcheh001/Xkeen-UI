"""Routing-related API routes as a Flask Blueprint."""
from __future__ import annotations

import os
import json

from flask import Blueprint, request, jsonify, current_app
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



def create_routing_blueprint(
    ROUTING_FILE: str,
    ROUTING_FILE_RAW: str,
    load_json: Callable[[str, Dict[str, Any]], Optional[Dict[str, Any]]],
    strip_json_comments_text: Callable[[str], str],
    restart_xkeen: Callable[..., bool],
) -> Blueprint:
    """Create blueprint with /api/routing endpoints.

    All heavy lifting is still done by the original helper functions and
    constants passed in from app.py.
    """
    bp = Blueprint("routing", __name__)

    @bp.get("/api/routing")
    def api_get_routing() -> Any:
        """Return routing config as raw text with comments if available.

        - If ROUTING_FILE_RAW exists, return its contents.
        - Else, read ROUTING_FILE and return it as text.
        """
        # Prefer raw file with comments if it exists
        if os.path.exists(ROUTING_FILE_RAW):
            try:
                with open(ROUTING_FILE_RAW, "r") as f:
                    raw = f.read()
                return current_app.response_class(raw, mimetype="application/json")
            except FileNotFoundError:
                pass

        # Fallback: pretty-print cleaned JSON from main file
        data = load_json(ROUTING_FILE, default={})
        if data is None:
            text = ""
        else:
            text = json.dumps(data, ensure_ascii=False, indent=2)
        return current_app.response_class(text, mimetype="application/json")


    @bp.post("/api/routing")
    def api_set_routing() -> Any:
        """Accept raw routing JSON with comments, validate it and save.

        - Raw body (with comments) is saved to ROUTING_FILE_RAW.
        - Cleaned JSON (without comments) is written to ROUTING_FILE for xkeen/xray.
        """
        raw_bytes = request.get_data(cache=False)
        try:
            raw_text = raw_bytes.decode("utf-8")
        except UnicodeDecodeError:
            try:
                raw_text = raw_bytes.decode("utf-8", errors="replace")
            except Exception:
                return jsonify({"ok": False, "error": "cannot decode body as utf-8"}), 400

        if not raw_text.strip():
            return jsonify({"ok": False, "error": "empty body"}), 400

        # Remove comments and validate JSON
        cleaned = strip_json_comments_text(raw_text)
        try:
            obj = json.loads(cleaned)
        except Exception as e:
            return jsonify({"ok": False, "error": f"invalid json: {e}"}), 400

        # Save raw text (with comments)
        try:
            d_raw = os.path.dirname(ROUTING_FILE_RAW)
            if d_raw and not os.path.isdir(d_raw):
                os.makedirs(d_raw, exist_ok=True)
            with open(ROUTING_FILE_RAW, "w") as f:
                f.write(raw_text)
        except Exception as e:
            return jsonify({"ok": False, "error": f"failed to write raw file: {e}"}), 500

        # Save cleaned JSON for xkeen/xray
        try:
            d = os.path.dirname(ROUTING_FILE)
            if d and not os.path.isdir(d):
                os.makedirs(d, exist_ok=True)
            tmp_path = ROUTING_FILE + ".tmp"
            with open(tmp_path, "w") as f:
                json.dump(obj, f, ensure_ascii=False, indent=2)
            os.replace(tmp_path, ROUTING_FILE)
        except Exception as e:
            return jsonify({"ok": False, "error": f"failed to write routing file: {e}"}), 500

        restart_arg = request.args.get("restart", None)
        restart_flag = True
        if restart_arg is not None:
            restart_arg = restart_arg.strip().lower()
            restart_flag = restart_arg in ("1", "true", "yes", "on", "y")
        restarted = restart_flag and restart_xkeen(source="routing")

        return jsonify({"ok": True, "restarted": restarted}), 200

    return bp

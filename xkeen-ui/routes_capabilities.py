"""Capabilities API.

PR17: extracted /api/capabilities from app.py.
"""

from __future__ import annotations

import os

from flask import Blueprint, current_app, jsonify

from services.capabilities import detect_capabilities


def create_capabilities_blueprint() -> Blueprint:
    bp = Blueprint("capabilities", __name__)

    @bp.get("/api/capabilities")
    def api_capabilities():
        """Return backend capabilities for the frontend (stable payload)."""
        caps = detect_capabilities(dict(os.environ))
        try:
            current_app.extensions["xkeen.capabilities"] = caps
        except Exception:
            pass
        return jsonify(caps)

    return bp

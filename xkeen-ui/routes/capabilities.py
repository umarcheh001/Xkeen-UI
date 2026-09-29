"""Capabilities API.

PR17: extracted /api/capabilities from app.py.
"""

from __future__ import annotations

import os
from typing import TYPE_CHECKING

from flask import Blueprint, current_app, jsonify

from services import get_capabilities

if TYPE_CHECKING:
    from services.module_registry import ModuleRegistry


def create_capabilities_blueprint(module_registry: "ModuleRegistry | None" = None) -> Blueprint:
    bp = Blueprint("capabilities", __name__)

    @bp.get("/api/capabilities")
    def api_capabilities():
        """Return backend capabilities for the frontend (stable payload)."""
        caps = get_capabilities(dict(os.environ), module_registry=module_registry)
        try:
            current_app.extensions["xkeen.capabilities"] = caps
        except Exception:
            pass
        return jsonify(caps)

    return bp

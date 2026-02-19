"""Shim for routing blueprint.

Refactor checklist (B3 step 7): keep this module as a facade so existing
imports continue to work.

All implementation lives in routes.routing.blueprint.
"""

from __future__ import annotations

from routes.routing.blueprint import create_routing_blueprint

__all__ = ["create_routing_blueprint"]

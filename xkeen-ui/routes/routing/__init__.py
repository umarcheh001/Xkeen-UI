"""Routing API blueprint package.

Implementation lives in :mod:`routes.routing.blueprint`.
Expose a stable import path: ``from routes.routing import create_routing_blueprint``.
"""

from .blueprint import create_routing_blueprint  # noqa: F401

__all__ = ["create_routing_blueprint"]

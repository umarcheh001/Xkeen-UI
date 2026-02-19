"""Backward-compatible shim.

The /api/remotefs/* implementation moved to routes.remotefs.blueprint.
Keep this module so existing imports keep working.
"""

from routes.remotefs.blueprint import create_remotefs_blueprint  # noqa: F401

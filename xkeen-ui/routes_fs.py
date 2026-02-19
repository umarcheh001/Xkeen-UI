"""Legacy facade for the Filesystem API blueprint.

The project historically exposed the FS blueprint from this module. Starting
with the refactor (commit 3), the implementation lives in `routes.fs`.

This file intentionally keeps the old import path stable:

    from routes_fs import create_fs_blueprint

"""

from __future__ import annotations

from routes.fs.blueprint import create_fs_blueprint

__all__ = ["create_fs_blueprint"]

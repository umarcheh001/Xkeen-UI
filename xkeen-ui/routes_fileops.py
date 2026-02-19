"""Compatibility facade for FileOps routes.

Historically the project exposed FileOps routes from this top-level module.
Starting with the refactor, the implementation lives in :mod:`routes.fileops`.

Keeping this facade avoids touching imports in :mod:`app_factory` and other
modules.
"""

from __future__ import annotations

from routes.fileops.blueprint import create_fileops_blueprint

__all__ = ["create_fileops_blueprint"]

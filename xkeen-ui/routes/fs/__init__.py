"""Filesystem routes package.

Implementation lives in :mod:`routes.fs.blueprint`.

We expose :func:`create_fs_blueprint` at the package level to make the new
import path short and consistent with other migrated route modules.

Legacy top-level ``routes_*.py`` shims were removed in the cleanup phase
once the new :mod:`routes` package became the single source of truth.
"""

from __future__ import annotations

from .blueprint import create_fs_blueprint

__all__ = ["create_fs_blueprint"]

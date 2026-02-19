"""FileOps routes package.

This package hosts the /api/fileops/* backend implementation.
"""

from __future__ import annotations

from .blueprint import create_fileops_blueprint

__all__ = ["create_fileops_blueprint"]

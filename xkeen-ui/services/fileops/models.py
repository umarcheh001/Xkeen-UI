"""Backward-compatible re-exports for FileOps.

Historically the fileops job model and manager lived in a single module.
As part of the refactor, the implementation was split into:
- job_models.py (dataclass)
- queue.py (cleanup/pruning helpers)
- workers.py (worker loop)
- manager.py (public manager class)

Keep this module so existing imports continue to work:
    from services.fileops.models import FileOpJob, FileOpJobManager
"""

from __future__ import annotations

from .job_models import FileOpJob
from .manager import FileOpJobManager

__all__ = ["FileOpJob", "FileOpJobManager"]

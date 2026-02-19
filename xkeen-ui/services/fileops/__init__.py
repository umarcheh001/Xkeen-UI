"""FileOps service layer.

This package progressively hosts the business logic for /api/fileops/*:
- job models, manager, queue and worker loop
- local/remote backends
- helpers such as spool management and WS token issuing
"""

from __future__ import annotations

from .local_backend import _copyfile_no_stat, _copytree_no_stat, _safe_move_no_stat
from .job_models import FileOpJob
from .manager import FileOpJobManager
from .spool import SpoolManager
from .ws_tokens import WsTokenManager

__all__ = [
    "_copyfile_no_stat",
    "_copytree_no_stat",
    "_safe_move_no_stat",
    "FileOpJob",
    "FileOpJobManager",
    "SpoolManager",
    "WsTokenManager",
]

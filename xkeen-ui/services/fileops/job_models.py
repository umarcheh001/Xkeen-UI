"""FileOps job data model.

This module intentionally contains only the job structure.
The manager/queue/worker logic lives in sibling modules.

Keep this Flask-agnostic so it can be unit-tested independently.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass
from typing import Any, Dict


@dataclass
class FileOpJob:
    job_id: str
    op: str
    created_ts: float
    state: str = "queued"
    rev: int = 0
    started_ts: float | None = None
    finished_ts: float | None = None
    progress: Dict[str, Any] | None = None
    error: str | None = None
    cancel_flag: threading.Event | None = None
    _proc: Any | None = None  # optional subprocess handle

    def to_dict(self) -> Dict[str, Any]:
        return {
            "job_id": self.job_id,
            "op": self.op,
            "state": self.state,
            "created_ts": self.created_ts,
            "started_ts": self.started_ts,
            "finished_ts": self.finished_ts,
            "progress": self.progress or {},
            "error": self.error,
        }


__all__ = ["FileOpJob"]

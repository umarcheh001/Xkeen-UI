"""Names, paths and the status file shared by every part of a module operation."""

from __future__ import annotations

import json
import os
import secrets
import time
from pathlib import Path
from typing import Any, Mapping

from services.io.atomic import _atomic_write_json
from services.self_update.state import _pid_is_running


STEPS = (
    "prepared",
    "downloading",
    "verifying",
    "applying",
    "state",
    "restarting",
    "health",
    "committed",
    "rolling_back",
)
RESULTS = ("running", "committed", "rolled_back", "interrupted", "rollback_failed")


class ModuleTransactionError(Exception):
    """A refused or failed module operation with a stable machine-readable code."""

    def __init__(self, code: str, message: str, **details: Any) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
        self.details = details


def transactions_root(panel_root: Path) -> Path:
    """Where operation directories live: next to the panel, on its filesystem.

    A sibling keeps the copies of replaced files out of the managed tree and
    still lets them come back with a rename.
    """

    panel_root = Path(panel_root)
    return panel_root.parent / (panel_root.name + ".module-transactions")


def status_path(state_dir: Path) -> Path:
    return Path(state_dir) / "module-operations" / "status.json"


def read_status(state_dir: Path) -> dict[str, Any]:
    """The current or the last operation; never raises, the panel polls this."""

    try:
        status = json.loads(status_path(state_dir).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"result": None}
    return status if isinstance(status, dict) else {"result": None}


def write_status(state_dir: Path, status: Mapping[str, Any]) -> None:
    path = status_path(state_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    _atomic_write_json(str(path), dict(status))


def new_operation_id(now: float | None = None) -> str:
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime(time.time() if now is None else now))
    return f"{stamp}-{secrets.token_hex(3)}"


def pid_alive(pid: object) -> bool:
    """Whether the process still runs; one that only waits to be collected does not."""

    if not _pid_is_running(pid):
        return False
    try:
        stat = Path(f"/proc/{int(pid)}/stat").read_text(encoding="ascii", errors="replace")
    except (OSError, ValueError, TypeError):
        # No /proc here (or the process is gone by now, and the next look says so).
        return True
    # "<pid> (<name>) <state> ...": the name may hold spaces and brackets.
    state = stat.rpartition(")")[2].split()
    return not state or state[0] != "Z"

"""Start a module operation from the panel without running it in the panel.

The operation restarts the panel, so it cannot live in the panel process or
in a request thread: the panel only hands the plan to a detached runner and
then reads its status file.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path
from typing import Sequence

from services.self_update.state import get_update_paths, read_lock

from .executor import recover
from .journal import Journal
from .plan import Plan
from .state import ModuleTransactionError, new_operation_id, pid_alive, read_status, write_status


def _default_script() -> Path:
    return Path(__file__).resolve().parents[2] / "scripts" / "module_transaction.py"


def ensure_idle(panel_root: Path, state_dir: Path) -> None:
    """Refuse a new operation while another change of the panel tree is under way."""

    operation_dir = Journal.find(Path(panel_root))
    if operation_dir is not None:
        try:
            pid = Journal.open(operation_dir).meta().get("pid")
        except ModuleTransactionError:
            pid = None
        if pid and pid_alive(pid):
            raise ModuleTransactionError("operation_in_progress", "a module operation is already running")
        if read_status(state_dir).get("result") == "rollback_failed":
            # The tree is a mix of two states; nothing may be laid over it.
            raise ModuleTransactionError(
                "operation_rollback_failed",
                "the previous operation could not be undone; repeat the undo or reinstall the panel",
            )
    lock = read_lock(get_update_paths(str(state_dir))["lock_file"])
    if lock.get("exists") and lock.get("alive"):
        raise ModuleTransactionError("operation_in_progress", "the panel is being updated")


def launch(
    plan: Plan,
    *,
    panel_root: Path,
    state_dir: Path,
    health_url: str,
    restart_cmd: Sequence[str],
    python: str = sys.executable,
    script: Path | None = None,
    extra_args: Sequence[str] = (),
) -> str:
    """Record the operation and start its runner; returns the operation id."""

    panel_root, state_dir = Path(panel_root), Path(state_dir)
    ensure_idle(panel_root, state_dir)
    # Whatever a dead runner left behind is undone before a new plan is laid.
    if recover(panel_root, state_dir) == "rollback_failed":
        raise ModuleTransactionError(
            "operation_rollback_failed",
            "the previous operation could not be undone; repeat the undo or reinstall the panel",
        )
    operation_id = new_operation_id()
    journal = Journal.create(
        panel_root, plan, operation_id, extra={"health_url": str(health_url), "restart_cmd": [str(part) for part in restart_cmd]}
    )
    meta = journal.meta()
    write_status(
        state_dir,
        {
            "operation_id": operation_id,
            "operation": plan.operation,
            "module_id": plan.module_id,
            "version": plan.version,
            "step": "prepared",
            "result": "running",
            "error_code": None,
            "error": None,
            "started_at": meta["started_at"],
            "finished_at": None,
            "log": [],
        },
    )
    command = [
        python, str(script or _default_script()), "run",
        "--panel-root", str(panel_root), "--state-dir", str(state_dir), "--operation", operation_id,
        *[str(part) for part in extra_args],
    ]
    options: dict = {
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
        "close_fds": True,
        "cwd": str(panel_root),
    }
    if os.name == "nt":
        options["creationflags"] = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        # A session of its own: stopping the panel must not take the runner along.
        options["start_new_session"] = True
    try:
        subprocess.Popen(command, **options)
    except OSError as error:
        journal.commit()
        write_status(
            state_dir,
            {**read_status(state_dir), "result": "interrupted", "error_code": "operation_start_failed", "error": str(error)},
        )
        raise ModuleTransactionError("operation_start_failed", "the module runner could not be started") from error
    return operation_id

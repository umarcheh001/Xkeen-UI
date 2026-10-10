"""Start a module operation from the panel without running it in the panel.

The operation restarts the panel, so it cannot live in the panel process or
in a request thread: the panel only hands the plan to a detached runner and
then reads its status file.
"""

from __future__ import annotations

import os
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any, Callable, Sequence

from services.self_update.state import (
    get_update_paths,
    read_lock,
    release_lock,
    try_acquire_lock,
)

from .cancel_channel import send_cancel
from .executor import recover
from .journal import Journal
from .plan import Plan
from .provision import build_provision
from .state import ModuleTransactionError, new_operation_id, read_status, write_status


def _default_script() -> Path:
    return Path(__file__).resolve().parents[2] / "scripts" / "module_transaction.py"


# One undo at a time in this process: the panel is asked for the status by
# every open page, and two of them must not put the same files back together.
_RECOVERY = threading.Lock()


def recover_abandoned(panel_root: Path, state_dir: Path, *, panel_running: bool = False) -> str | None:
    """Undo an operation nobody carries, the environment outside the folder included.

    ``None`` also when another request of this panel is already doing it.
    """

    if not _RECOVERY.acquire(blocking=False):
        return None
    try:
        return recover(
            Path(panel_root), Path(state_dir), panel_running=panel_running, provision=build_provision(Path(panel_root))
        )
    finally:
        _RECOVERY.release()


def settle_restart_on_startup(state_dir: Path) -> bool:
    """Forget the restart the last operation asked of the panel; it has just had it.

    Called by the panel as it starts. An undo done under a running panel
    leaves ``restart_required`` in the status, and nothing else takes it
    away: the status is rewritten only by the next operation.
    """

    status = read_status(Path(state_dir))
    if status.pop("restart_required", None) is None:
        return False
    write_status(Path(state_dir), status)
    return True


def ensure_idle(
    panel_root: Path,
    state_dir: Path,
    *,
    lock_owner_pid: int | None = None,
) -> None:
    """Refuse a new operation while another change of the panel tree is under way."""

    operation_dir = Journal.find(Path(panel_root))
    if operation_dir is not None:
        try:
            running = Journal.open(operation_dir).busy()
        except ModuleTransactionError:
            running = False
        if running:
            raise ModuleTransactionError("operation_in_progress", "a module operation is already running")
        if read_status(state_dir).get("result") == "rollback_failed":
            # The tree is a mix of two states; nothing may be laid over it.
            raise ModuleTransactionError(
                "operation_rollback_failed",
                "the previous operation could not be undone; repeat the undo or reinstall the panel",
            )
    lock = read_lock(get_update_paths(str(state_dir))["lock_file"])
    owned = lock_owner_pid is not None and lock.get("pid") == lock_owner_pid
    if lock.get("exists") and lock.get("alive") and not owned:
        raise ModuleTransactionError("operation_in_progress", "the panel is being updated")


def request_cancel(panel_root: Path, state_dir: Path, operation_id: str) -> None:
    """Ask the live runner of an operation to cancel itself.

    The request goes to the address the runner recorded when it started; the
    runner interrupts itself. No signal is sent by process id, so there is
    no other process it could reach by mistake.
    """

    operation_dir = Journal.find(Path(panel_root))
    if operation_dir is None:
        raise ModuleTransactionError("operation_not_found", "the module operation does not exist")
    journal = Journal.open(operation_dir)
    meta = journal.meta()
    if meta.get("operation_id") != operation_id:
        raise ModuleTransactionError("operation_not_found", "the module operation does not exist")

    status = read_status(Path(state_dir))
    if status.get("operation_id") != operation_id:
        raise ModuleTransactionError("operation_not_found", "the module operation does not exist")
    if status.get("result") != "running" or not journal.runner_alive():
        raise ModuleTransactionError("operation_not_running", "the module operation is not running")

    try:
        accepted = send_cancel(meta.get("cancel"), operation_id)
    except ConnectionRefusedError as error:
        # The runner finished between the look at its record and the request.
        raise ModuleTransactionError(
            "operation_not_running", "the module operation is not running"
        ) from error
    except (OSError, ValueError) as error:
        raise ModuleTransactionError(
            "operation_cancel_failed", "the module operation could not be cancelled"
        ) from error
    if not accepted:
        raise ModuleTransactionError(
            "operation_cancel_failed", "the module operation could not be cancelled"
        )


def ensure_restartable(panel_root: Path, state_dir: Path) -> None:
    """Refuse an explicit restart while panel files need transaction recovery."""

    panel_root, state_dir = Path(panel_root), Path(state_dir)
    ensure_idle(panel_root, state_dir)
    if Journal.find(panel_root) is not None:
        raise ModuleTransactionError(
            "operation_recovery_required",
            "the interrupted module operation must be recovered before restart",
        )


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
    prepare_plan: Callable[[], Plan] | None = None,
) -> str:
    """Record the operation and start its runner; returns the operation id."""

    panel_root, state_dir = Path(panel_root), Path(state_dir)
    if panel_root.resolve() != state_dir.resolve():
        # The plan is read from the state directory and written to the panel
        # root: apart, the operation would change one set of records by another.
        raise ModuleTransactionError(
            "operation_state_dir_mismatch",
            "module operations need the panel state to live in the panel directory",
        )
    lock_file = get_update_paths(str(state_dir))["lock_file"]
    acquired, _lock = try_acquire_lock(lock_file)
    if not acquired:
        raise ModuleTransactionError("operation_in_progress", "the panel is being updated")
    handed_off = False
    try:
        ensure_idle(panel_root, state_dir, lock_owner_pid=os.getpid())
        if _RECOVERY.locked():
            # Another request is putting the files of a dead operation back.
            raise ModuleTransactionError("operation_in_progress", "an interrupted operation is being undone")
        # Whatever a dead runner left behind is undone before a new plan is laid.
        if recover_abandoned(panel_root, state_dir) == "rollback_failed":
            raise ModuleTransactionError(
                "operation_rollback_failed",
                "the previous operation could not be undone; repeat the undo or reinstall the panel",
            )
        if prepare_plan is not None:
            plan = prepare_plan()
        operation_id = new_operation_id()
        journal = Journal.create(
            panel_root, plan, operation_id, extra={"health_url": str(health_url), "restart_cmd": [str(part) for part in restart_cmd]}
        )
        meta = journal.meta()
        write_status(
            state_dir,
            {
                "operation_id": operation_id,
                "scope": plan.scope,
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
            "--lock-owner-pid", str(os.getpid()),
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
            runner = subprocess.Popen(command, **options)
        except OSError as error:
            journal.commit()
            write_status(
                state_dir,
                {**read_status(state_dir), "result": "interrupted", "error_code": "operation_start_failed", "error": str(error)},
            )
            raise ModuleTransactionError("operation_start_failed", "the module runner could not be started") from error
        handed_off = True
    finally:
        if not handed_off:
            release_lock(lock_file, owner_pid=os.getpid())
    # A runner that ends while the panel lives must not linger as a process
    # nobody collected: its pid would keep looking busy.
    def reap() -> None:
        runner.wait()
        release_lock(lock_file, owner_pid=os.getpid())

    threading.Thread(target=reap, name="module-operation-reaper", daemon=True).start()
    return operation_id


def observe_status(panel_root: Path, state_dir: Path) -> dict[str, Any]:
    """The status for the panel to show, settled when the runner is gone.

    The file alone says ``running`` for ever after the runner was killed:
    nobody is left to write the outcome. The panel is the one that looks, so
    it finishes such an operation here instead of waiting for its next start.
    """

    panel_root, state_dir = Path(panel_root), Path(state_dir)
    status = read_status(state_dir)
    if status.get("result") != "running":
        return status
    operation_dir = Journal.find(panel_root)
    if operation_dir is None:
        if status.get("step") == "committed":
            # The runner confirmed the operation and put its record away, and
            # was cut short before the last word in the status: it is done.
            status.update(result="committed", finished_at=time.time())
            write_status(state_dir, status)
            return status
        # The record of the operation is gone (the installer cleared it).
        status.update(result="interrupted", finished_at=time.time())
        if not status.get("error_code"):
            status["error_code"] = "operation_interrupted"
        write_status(state_dir, status)
        return status
    try:
        busy = Journal.open(operation_dir).busy()
    except ModuleTransactionError:
        busy = False
    if busy:
        return status
    recover_abandoned(panel_root, state_dir, panel_running=True)
    return read_status(state_dir)

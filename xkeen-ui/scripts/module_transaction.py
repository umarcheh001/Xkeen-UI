#!/usr/bin/env python3
"""Run or finish one module operation of the panel, outside the panel process.

    module_transaction.py run     --panel-root DIR --state-dir DIR --operation ID
    module_transaction.py recover --panel-root DIR --state-dir DIR
    module_transaction.py status  --state-dir DIR
    module_transaction.py busy    --panel-root DIR
    module_transaction.py forget  --panel-root DIR --state-dir DIR

``run`` is started by the panel for an operation it has already planned.
``recover`` is called by the init script and by the installer: it undoes an
operation whose runner is gone (a power cut, a kill) and does nothing when
there is none or when it is still running.

Exit codes of ``run``: 0 - done or undone cleanly; 1 - the operation did not
happen or its undo failed; 2 - wrong call. ``recover`` answers 1 only when
the previous files could not be put back: an operation cancelled cleanly is
not a failure. ``busy`` answers 3 while an operation is being carried and 0
otherwise: the installer asks before it lays its own files. ``forget`` is for
the installer that has just replaced every managed file from its archive:
whatever an operation left behind no longer describes the panel.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path


PANEL_DIR = Path(__file__).resolve().parents[1]
if str(PANEL_DIR) not in sys.path:
    sys.path.insert(0, str(PANEL_DIR))

from services.module_transactions.cancel_channel import CancelListener  # noqa: E402
from services.module_transactions.executor import OperationCancelled, recover, run_operation, wait_for_panel  # noqa: E402
from services.module_transactions.journal import Journal  # noqa: E402
from services.module_transactions.state import (  # noqa: E402
    ModuleTransactionError,
    read_status,
    transactions_root,
    write_status,
)
from services.self_update.state import (  # noqa: E402
    get_update_paths,
    release_lock,
    transfer_lock,
    try_acquire_lock,
)


DEFAULT_HEALTH_TIMEOUT_S = 120.0
BUSY_EXIT_CODE = 3
RESTART_TIMEOUT_S = 180.0


def _health_timeout() -> float:
    try:
        value = float(os.environ.get("XKEEN_UI_MODULE_TX_HEALTH_TIMEOUT") or DEFAULT_HEALTH_TIMEOUT_S)
    except ValueError:
        return DEFAULT_HEALTH_TIMEOUT_S
    return value if value > 0 else DEFAULT_HEALTH_TIMEOUT_S


def _default_client(state_dir: Path, architecture: str, version: str):
    # Imported here: the catalog client needs the signature library, and
    # ``recover`` at boot has to work even when that library is broken.
    from services.module_catalog_client import ModuleCatalogClient

    return ModuleCatalogClient(state_dir, platform_architecture=architecture, core_version=version)


PROVISION_TIMEOUTS_S = {"prepare": 1500.0, "apply": 300.0}


def build_provision(panel_root: Path):
    """How the runner asks the panel's shared script to bring the router in line.

    The script is the one the installer uses; here it is run as a command.
    A panel installed before the script existed has none: nothing is called.
    """

    def provision(phase: str, script: Path) -> None:
        script = Path(script)
        if not script.is_file():
            return
        environment = dict(os.environ, UI_DIR=str(panel_root), PYTHON_BIN=sys.executable)
        try:
            process = subprocess.run(
                ["sh", script.as_posix() if os.name == "nt" else str(script), phase],
                env=environment,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                timeout=PROVISION_TIMEOUTS_S.get(phase, 300.0),
            )
        except subprocess.TimeoutExpired as error:
            raise ModuleTransactionError(
                "operation_environment_failed",
                "preparing the router for the release took too long",
                phase=phase,
            ) from error
        except OSError as error:
            raise ModuleTransactionError(
                "operation_environment_failed", "the router could not be prepared for the release", phase=phase
            ) from error
        if process.returncode == 0:
            return
        output = process.stdout.decode("utf-8", "replace") if process.stdout else ""
        # The script names the reason on its last line that starts with "[!]".
        reasons = [line[3:].strip() for line in output.splitlines() if line.startswith("[!]")]
        raise ModuleTransactionError(
            "operation_environment_failed",
            reasons[-1] if reasons else "the router could not be prepared for the release",
            phase=phase,
        )

    return provision


def _run(args, *, client_factory, architecture, on_step) -> int:
    panel_root, state_dir = Path(args.panel_root), Path(args.state_dir)
    operation_dir = transactions_root(panel_root) / args.operation
    try:
        journal = Journal.open(operation_dir)
    except ModuleTransactionError:
        print(f"module operation {args.operation} is not prepared in {operation_dir.parent}", file=sys.stderr)
        return 2
    meta = journal.meta()
    plan = journal.plan
    if meta.get("step") != "prepared" or meta.get("pid"):
        # Starting it over would treat files this operation already laid
        # as the previous ones and throw the real copies away.
        print(f"module operation {args.operation} already started; use recover", file=sys.stderr)
        return 2

    lock_file = get_update_paths(str(state_dir))["lock_file"]
    if args.lock_owner_pid is not None:
        acquired = transfer_lock(lock_file, args.lock_owner_pid)
    else:
        acquired, _ = try_acquire_lock(lock_file)
    if not acquired:
        # A panel update or another operation owns the tree right now.
        journal.commit()
        write_status(
            state_dir,
            {
                **read_status(state_dir),
                "operation_id": meta.get("operation_id"),
                "operation": plan.operation,
                "module_id": plan.module_id,
                "result": "interrupted",
                "error_code": "operation_in_progress",
                "error": "the panel tree is being changed by another operation",
            },
        )
        return 1
    listener: CancelListener | None = None
    try:
        journal.set_pid(os.getpid())

        def cancel(_signum, _frame) -> None:
            raise OperationCancelled()

        signal.signal(signal.SIGTERM, cancel)

        main_thread = threading.main_thread().ident

        def interrupt() -> None:
            # The panel asked to stop. The signal goes from this process to
            # its own main thread, which wakes it out of a download as well.
            if hasattr(signal, "pthread_kill") and main_thread is not None:
                signal.pthread_kill(main_thread, signal.SIGTERM)
            else:
                signal.raise_signal(signal.SIGTERM)

        listener = CancelListener(args.operation, interrupt)
        try:
            journal.set_cancel_channel(listener.start())
        except OSError:
            # Without a listener the operation cannot be cancelled from the
            # panel; that is no reason not to carry it out.
            listener = None

        restart_cmd = [str(part) for part in (meta.get("restart_cmd") or [])]
        health_url = str(meta.get("health_url") or "")

        def restart() -> None:
            if not restart_cmd:
                raise ModuleTransactionError("operation_restart_failed", "the operation has no restart command")
            subprocess.run(
                restart_cmd,
                check=True,
                timeout=RESTART_TIMEOUT_S,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )

        def wait_healthy(phase: str) -> bool:
            return wait_for_panel(
                health_url,
                state_dir,
                plan.module_id,
                plan.operation,
                timeout_s=_health_timeout(),
                check_module=phase == "operation",
                target_module_ids=plan.installed_after if plan.scope != "module" else None,
            )

        if architecture is None:
            # Imported here: the package contract loads the signature library,
            # which ``recover`` must not depend on.
            from services.module_package_contract import detect_platform_architecture

            architecture = detect_platform_architecture()
        resolved_architecture = architecture
        result = run_operation(
            journal,
            state_dir=state_dir,
            # The version of the panel that runs, not of the release it lays:
            # the catalog client holds only its own release to its registry.
            client=client_factory(state_dir, resolved_architecture, plan.source_version or plan.version),
            architecture=resolved_architecture,
            restart=restart,
            wait_healthy=wait_healthy,
            on_step=on_step,
            shield=lambda: signal.signal(signal.SIGTERM, signal.SIG_IGN),
            panel_archive_cache=Path(args.archive_cache) if args.archive_cache else None,
            provision=build_provision(panel_root),
        )
    finally:
        if listener is not None:
            listener.close()
        release_lock(lock_file, owner_pid=os.getpid())
    return 0 if result in ("committed", "rolled_back") else 1


def _recover(args) -> int:
    result = recover(Path(args.panel_root), Path(args.state_dir))
    return 1 if result == "rollback_failed" else 0


def _busy(args) -> int:
    operation_dir = Journal.find(Path(args.panel_root))
    if operation_dir is None:
        return 0
    try:
        return BUSY_EXIT_CODE if Journal.open(operation_dir).busy() else 0
    except ModuleTransactionError:
        return 0


def _forget(args) -> int:
    panel_root, state_dir = Path(args.panel_root), Path(args.state_dir)
    shutil.rmtree(transactions_root(panel_root), ignore_errors=True)
    status = read_status(state_dir)
    if status.get("result") in ("running", "rollback_failed"):
        status.update(
            result="interrupted",
            error_code="operation_superseded",
            error="the panel files were replaced from the panel archive",
            finished_at=time.time(),
        )
        status.pop("failed_path", None)
        status.pop("failed_error", None)
        write_status(state_dir, status)
    return 0


def _status(args) -> int:
    print(json.dumps(read_status(Path(args.state_dir)), ensure_ascii=False, indent=2))
    return 0


def main(argv=None, *, client_factory=None, architecture=None, on_step=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    run = commands.add_parser("run")
    run.add_argument("--panel-root", required=True)
    run.add_argument("--state-dir", required=True)
    run.add_argument("--operation", required=True)
    run.add_argument("--lock-owner-pid", type=int)
    # Where the panel left the archive it has already downloaded and verified.
    run.add_argument("--archive-cache")
    again = commands.add_parser("recover")
    again.add_argument("--panel-root", required=True)
    again.add_argument("--state-dir", required=True)
    status = commands.add_parser("status")
    status.add_argument("--state-dir", required=True)
    busy = commands.add_parser("busy")
    busy.add_argument("--panel-root", required=True)
    forget = commands.add_parser("forget")
    forget.add_argument("--panel-root", required=True)
    forget.add_argument("--state-dir", required=True)
    args = parser.parse_args(argv)

    if args.command == "run":
        return _run(args, client_factory=client_factory or _default_client, architecture=architecture, on_step=on_step)
    if args.command == "recover":
        return _recover(args)
    if args.command == "busy":
        return _busy(args)
    if args.command == "forget":
        return _forget(args)
    return _status(args)


if __name__ == "__main__":
    raise SystemExit(main())

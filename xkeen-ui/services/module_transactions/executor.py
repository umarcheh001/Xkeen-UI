"""Carry one module operation from its plan to a confirmed result or an undo."""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable

from services.module_catalog_client import ModuleCatalogClient
from services.module_package_contract import validate_module_archive

from .extract import extract_payload
from .install_state import rebuild_frontend_manifests, state_file_updates
from .journal import Journal
from .plan import load_ownership_map
from .state import ModuleTransactionError, write_status


class OperationCancelled(ModuleTransactionError):
    """The operation was asked to stop; before files change this is harmless."""

    def __init__(self) -> None:
        super().__init__("operation_cancelled", "the operation was cancelled")


def _code(error: BaseException) -> str:
    code = getattr(error, "code", None)
    if isinstance(code, str) and code:
        return code
    return "operation_io_error" if isinstance(error, OSError) else "operation_failed"


def wait_for_panel(
    health_url: str,
    state_dir: Path,
    module_id: str,
    operation: str,
    *,
    timeout_s: float,
    sleep: Callable[[float], None] = time.sleep,
    check_module: bool = True,
) -> bool:
    """Wait until the restarted panel answers and the module did not fail to start."""

    deadline = time.monotonic() + float(timeout_s)
    while True:
        try:
            with urllib.request.urlopen(health_url, timeout=5) as response:
                answered = getattr(response, "status", 200) == 200
        except (urllib.error.URLError, OSError, ValueError):
            answered = False
        if answered:
            if not check_module or operation == "remove":
                return True
            # The registry records a module that failed to start before the
            # panel begins to serve, so one look after the first answer is final.
            try:
                state = json.loads((Path(state_dir) / "modules.json").read_text(encoding="utf-8"))
                item = state["modules"][module_id]
                return not (isinstance(item, dict) and item.get("last_error"))
            except (OSError, ValueError, KeyError, TypeError):
                return True
        if time.monotonic() >= deadline:
            return False
        sleep(1.0)


def run_operation(
    journal: Journal,
    *,
    state_dir: Path,
    client: ModuleCatalogClient,
    architecture: str,
    restart: Callable[[], None],
    wait_healthy: Callable[[str], bool],
    on_step: Callable[[str], None] | None = None,
) -> str:
    plan = journal.plan
    meta = journal.meta()
    status: dict[str, Any] = {
        "operation_id": meta.get("operation_id"),
        "operation": plan.operation,
        "module_id": plan.module_id,
        "version": plan.version,
        "step": "prepared",
        "result": "running",
        "error_code": None,
        "error": None,
        "started_at": meta.get("started_at") or time.time(),
        "finished_at": None,
        "log": [],
    }

    def enter(step: str) -> None:
        status["step"] = step
        status["log"].append({"step": step, "at": time.time()})
        journal.set_step(step)
        write_status(state_dir, status)
        if on_step is not None:
            on_step(step)

    def finish(result: str, error: BaseException | None = None, **extra: Any) -> str:
        status["result"] = result
        status["finished_at"] = time.time()
        if error is not None:
            status["error_code"] = _code(error)
            status["error"] = getattr(error, "message", None) or str(error)
        status.update(extra)
        write_status(state_dir, status)
        return result

    # Nothing in the panel changes until "applying": a failure here needs no undo.
    try:
        enter("prepared")
        if plan.archive is not None:
            enter("downloading")
            snapshot = client.get_release_catalog(plan.version)
            entry = next((item for item in snapshot.catalog["modules"] if item.get("id") == plan.module_id), None)
            if entry is None or (entry.get("archive"), entry.get("size"), entry.get("sha256")) != (
                plan.archive.archive, plan.archive.size, plan.archive.sha256,
            ):
                raise ModuleTransactionError(
                    "module_version_mismatch",
                    "the release catalog no longer matches the planned operation",
                    module_id=plan.module_id,
                )
            archive_path = client.download_verified_archive(snapshot, plan.module_id, journal.staging)
            enter("verifying")
            checked = validate_module_archive(
                archive_path, entry, platform_architecture=architecture, core_version=plan.version
            )
            if set(checked["payload_files"]) != set(plan.files_add):
                raise ModuleTransactionError(
                    "module_ownership_conflict",
                    "the archive does not hold exactly the files this panel build assigns to the module",
                    module_id=plan.module_id,
                )
            extract_payload(archive_path, journal.staging / "payload", plan.files_add)
    except Exception as error:
        journal.commit()
        return finish("interrupted", error)

    restarted = False
    try:
        enter("applying")
        payload = journal.staging / "payload"
        for relative in plan.files_add:
            journal.apply_file(relative, payload.joinpath(*relative.split("/")))
        for relative in plan.files_remove:
            journal.remove_file(relative)
        journal.align_precompressed()

        enter("state")
        root = journal.panel_root
        shared = rebuild_frontend_manifests(root, load_ownership_map(root).frontend)
        shared.update(state_file_updates(root, plan))
        for relative, content in sorted(shared.items()):
            target = root.joinpath(*relative.split("/"))
            if not target.is_file() or target.read_bytes() != content:
                journal.write_state_file(relative, content)

        enter("restarting")
        restarted = True
        restart()

        enter("health")
        if not wait_healthy("operation"):
            raise ModuleTransactionError("operation_health_failed", "the panel did not come up after the operation")

        enter("committed")
        journal.commit()
        return finish("committed")
    except Exception as error:
        status["step"] = "rolling_back"
        status["log"].append({"step": "rolling_back", "at": time.time()})
        try:
            journal.set_step("rolling_back")
            write_status(state_dir, status)
        except OSError:
            pass
        try:
            journal.rollback()
        except ModuleTransactionError as failure:
            # The copy of the previous files stays where it is: it is the only
            # one. The panel may still work in the mixed state, so start it.
            if restarted:
                try:
                    restart()
                except Exception:
                    pass
            return finish(
                "rollback_failed",
                error,
                failed_path=failure.details.get("path"),
                failed_error=failure.details.get("error"),
            )
        unresponsive = False
        if restarted:
            # The running panel has loaded nothing new unless it was restarted.
            try:
                restart()
                unresponsive = not wait_healthy("rollback")
            except Exception:
                unresponsive = True
        journal.commit()
        return finish("rolled_back", error, panel_unresponsive=unresponsive)

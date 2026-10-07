"""Carry one module operation from its plan to a confirmed result or an undo."""

from __future__ import annotations

import json
import os
import shutil
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable

from .extract import extract_panel_payload, extract_payload
from .install_state import rebuild_frontend_manifests, state_file_updates
from .journal import Journal
from .plan import load_ownership_map
from .state import ModuleTransactionError, pid_alive, read_status, write_status

if TYPE_CHECKING:
    # The catalog client needs the signature library. Undoing an interrupted
    # operation at boot must not depend on it, so it is not imported here.
    from services.module_catalog_client import ModuleCatalogClient


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
    module_id: str | None,
    operation: str,
    *,
    timeout_s: float,
    sleep: Callable[[float], None] = time.sleep,
    check_module: bool = True,
    target_module_ids: tuple[str, ...] | None = None,
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
                module_ids = target_module_ids or ((module_id,) if module_id else ())
                return all(
                    not (isinstance(state["modules"].get(current), dict) and state["modules"][current].get("last_error"))
                    for current in module_ids
                )
            except (OSError, ValueError, KeyError, TypeError):
                return True
        if time.monotonic() >= deadline:
            return False
        sleep(1.0)


def _take_kept_panel_archive(cache: Path | None, plan_archive: Any, staging: Path) -> Path | None:
    """Move the archive the panel has already downloaded into the staging of the operation.

    It is checked again like a downloaded one, so a wrong or damaged copy
    costs nothing but the download it was meant to save.
    """

    if cache is None:
        return None
    try:
        kept = Path(cache) / f"{plan_archive.sha256}.tar.gz"
        if not kept.is_file() or kept.stat().st_size != plan_archive.size:
            return None
        staging.mkdir(parents=True, exist_ok=True)
        target = staging / "panel-archive.tar.gz"
        shutil.move(str(kept), str(target))
        return target
    except OSError:
        return None


PROVISION_SCRIPT = ("scripts", "provision_env.sh")


def provision_script(journal: Journal, *, staged: bool) -> Path:
    """The script that brings the router in line with a panel release.

    Before files change the release speaks for itself: its own copy is taken
    from the unpacked payload. A release that did not change the script does
    not carry it (unchanged files are not unpacked), and after the files are
    laid the panel holds the right one either way.
    """

    if staged:
        candidate = journal.staging.joinpath("payload", *PROVISION_SCRIPT)
        if candidate.is_file():
            return candidate
    return journal.panel_root.joinpath(*PROVISION_SCRIPT)


def _build_stamp(root: Path, version: str, commit: str | None) -> bytes:
    """``BUILD.json`` of the release that was just laid.

    The repository and the channel of updates are the owner's choice and
    stay; everything that described the previous build goes.
    """

    kept: dict[str, Any] = {}
    try:
        previous = json.loads((root / "BUILD.json").read_text(encoding="utf-8"))
        if isinstance(previous, dict):
            kept = {key: previous[key] for key in ("repo", "channel") if isinstance(previous.get(key), str)}
    except (OSError, ValueError):
        kept = {}
    return (json.dumps({**kept, "version": version, "commit": commit}, ensure_ascii=False, indent=2) + "\n").encode(
        "utf-8"
    )


def run_operation(
    journal: Journal,
    *,
    state_dir: Path,
    client: "ModuleCatalogClient",
    architecture: str,
    restart: Callable[[], None],
    wait_healthy: Callable[[str], bool],
    on_step: Callable[[str], None] | None = None,
    shield: Callable[[], None] | None = None,
    panel_archive_cache: Path | None = None,
    provision: Callable[[str, Path], None] | None = None,
) -> str:
    """Run the planned operation; ``shield`` is called once nothing may interrupt it.

    ``provision`` does what lies outside the panel folder and has to match
    the release: ``prepare`` (libraries) before a single file changes, so a
    router that cannot run the release is refused while nothing is touched;
    ``apply`` (service, templates, commands) once the files are laid.

    From the moment the panel is confirmed, and from the moment an undo
    starts, a cancel request can only do harm: the runner uses ``shield``
    to stop listening to termination signals there.
    """

    plan = journal.plan
    meta = journal.meta()
    status: dict[str, Any] = {
        "operation_id": meta.get("operation_id"),
        "scope": plan.scope,
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
        try:
            write_status(state_dir, status)
        except OSError:
            # The outcome is what happened to the files, not whether the
            # note about it could be written (a full storage, for one).
            pass
        return result

    def raise_shield() -> None:
        if shield is not None:
            try:
                shield()
            except Exception:
                pass

    # Nothing in the panel changes until "applying": a failure here needs no undo.
    catalog_source_commit: str | None = None
    try:
        enter("prepared")
        if plan.archive is not None:
            enter("downloading")
            snapshot = client.get_release_catalog(plan.version)
            if plan.scope == "module":
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
                from services.module_package_contract import validate_module_archive

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
                # Unpacked: the archive is only taking room from here on.
                archive_path.unlink(missing_ok=True)
            else:
                descriptor = snapshot.catalog.get("panel")
                if not isinstance(descriptor, dict) or (
                    descriptor.get("archive"), descriptor.get("size"), descriptor.get("sha256")
                ) != (plan.archive.archive, plan.archive.size, plan.archive.sha256):
                    raise ModuleTransactionError(
                        "operation_plan_stale",
                        "the release catalog no longer matches the planned panel operation",
                    )
                from services.module_package_contract import ModulePackageContractError
                from services.panel_package_contract import validate_panel_archive

                archive_path = _take_kept_panel_archive(panel_archive_cache, plan.archive, journal.staging)
                kept = archive_path is not None
                if archive_path is None:
                    archive_path = client.download_verified_panel_archive(snapshot, journal.staging)
                enter("verifying")
                try:
                    checked = validate_panel_archive(
                        archive_path,
                        descriptor,
                        platform_architecture=architecture,
                    )
                except ModulePackageContractError:
                    if not kept:
                        raise
                    # The copy kept by the panel did not survive; the release itself may be fine.
                    archive_path.unlink(missing_ok=True)
                    archive_path = client.download_verified_panel_archive(snapshot, journal.staging)
                    checked = validate_panel_archive(
                        archive_path,
                        descriptor,
                        platform_architecture=architecture,
                    )
                if not set(plan.files_add) <= set(checked["payload_files"]):
                    raise ModuleTransactionError(
                        "module_ownership_conflict",
                        "the panel archive does not contain every planned target file",
                    )
                extract_panel_payload(archive_path, journal.staging / "payload", plan.files_add)
                archive_path.unlink(missing_ok=True)
                catalog_source_commit = str(snapshot.catalog.get("source_commit") or "")
                if provision is not None and plan.scope == "panel":
                    # Libraries the release needs: a failure here leaves the
                    # panel exactly as it was.
                    provision("prepare", provision_script(journal, staged=True))
    except Exception as error:
        journal.commit()
        return finish("interrupted", error)

    restarted = False
    try:
        enter("applying")
        payload = journal.staging / "payload"
        for relative in plan.files_add:
            # Moved, not copied: the release must not lie on the storage twice.
            journal.apply_file(relative, payload.joinpath(*relative.split("/")), consume=True)
        for relative in plan.files_remove:
            journal.remove_file(relative)
        journal.align_precompressed()

        enter("state")
        root = journal.panel_root
        shared = rebuild_frontend_manifests(root, load_ownership_map(root).frontend)
        shared.update(state_file_updates(root, plan))
        if plan.scope == "panel":
            shared["BUILD.json"] = _build_stamp(root, plan.target_version, catalog_source_commit)
        for relative, content in sorted(shared.items()):
            target = root.joinpath(*relative.split("/"))
            if not target.is_file() or target.read_bytes() != content:
                journal.write_state_file(relative, content)

        if provision is not None:
            # The service, the templates and the commands of the release that
            # now lies in the panel folder.
            provision("apply", provision_script(journal, staged=False))

        # The new files must be on the storage before anything relies on them.
        journal.flush()
        enter("restarting")
        restarted = True
        restart()

        enter("health")
        if not wait_healthy("operation"):
            raise ModuleTransactionError("operation_health_failed", "the panel did not come up after the operation")
    except Exception as error:
        raise_shield()
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
        if provision is not None:
            # The previous files are back, the previous script among them:
            # it puts back what the failed release changed outside the folder.
            try:
                provision("apply", provision_script(journal, staged=False))
            except Exception:
                status["environment_restored"] = False
        unresponsive = False
        if restarted:
            # The running panel has loaded nothing new unless it was restarted.
            try:
                restart()
                unresponsive = not wait_healthy("rollback")
            except Exception:
                unresponsive = True
        journal.flush()
        journal.commit()
        return finish("rolled_back", error, panel_unresponsive=unresponsive)

    # The panel answered on the new files: the operation is done. Nothing
    # below may turn it back - not a cancel request, not a status that
    # cannot be written, not a power cut halfway through the cleanup.
    raise_shield()
    try:
        enter("committed")
    except Exception:
        status["step"] = "committed"
    journal.flush()
    journal.commit()
    return finish("committed")


_UNTOUCHED_STEPS = frozenset({"prepared", "downloading", "verifying"})
# From these steps on the panel may already run on the files of the operation.
_RESTARTED_STEPS = frozenset({"restarting", "health", "rolling_back"})


def recover(panel_root: Path, state_dir: Path, *, panel_running: bool = False) -> str | None:
    """Finish an operation nobody is running any more; ``None`` when there is none.

    Runs before the panel starts (the init script, the installer) and before
    a new operation. An operation that was not confirmed counts as not done:
    its changes are undone. The panel is neither restarted nor waited for
    here - the caller is about to start it. A caller that is the running
    panel says so with ``panel_running``: the status then tells whether the
    panel has to be restarted to match the files that were put back.
    """

    panel_root = Path(panel_root)
    Journal.sweep(panel_root)
    operation_dir = Journal.find(panel_root)
    if operation_dir is None:
        return None
    try:
        journal = Journal.open(operation_dir)
        readable = True
    except ModuleTransactionError:
        journal = Journal.salvage(operation_dir, panel_root)
        readable = False
    meta = journal.meta()
    if meta.get("pid") != os.getpid() and journal.busy():
        # The runner restarts the panel through the init script, which calls
        # this function: a live operation must not be undone under its feet.
        return None

    operation_id = meta.get("operation_id") or operation_dir.name
    status = read_status(state_dir)
    if status.get("operation_id") != operation_id:
        status = {
            "operation_id": operation_id,
            "operation": journal.plan.operation if readable else None,
            "module_id": journal.plan.module_id if readable else None,
            "version": journal.plan.version if readable else None,
            "error_code": None,
            "error": None,
            "started_at": meta.get("started_at"),
            "log": [],
        }
    status["recovered"] = True
    status["finished_at"] = time.time()
    step = meta.get("step")

    if readable and step == "committed":
        journal.commit()
        result = "committed"
    elif readable and step in _UNTOUCHED_STEPS:
        journal.commit()
        result = "interrupted"
    else:
        try:
            journal.rollback()
        except ModuleTransactionError as failure:
            status.update(
                result="rollback_failed",
                failed_path=failure.details.get("path"),
                failed_error=failure.details.get("error"),
            )
            if not status.get("error_code"):
                status["error_code"] = "operation_interrupted"
            write_status(state_dir, status)
            return "rollback_failed"
        journal.flush()
        journal.commit()
        # Without a readable record there is no telling how far it went.
        result = "rolled_back" if readable else "interrupted"
        status.pop("failed_path", None)
        status.pop("failed_error", None)
        if panel_running and (not readable or step in _RESTARTED_STEPS):
            status["restart_required"] = True
    if result != "committed" and not status.get("error_code"):
        status["error_code"] = "operation_interrupted"
    status["result"] = result
    write_status(state_dir, status)
    return result

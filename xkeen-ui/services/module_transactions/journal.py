"""The directory of one module operation: its plan, a write-ahead log and the undo.

Files of a module live in the shared panel root, so switching a module is not
a single rename. Instead every change is announced in ``actions.log`` before
it happens and the previous file is kept in ``backup/``. Whatever the moment
the process dies at, the log and the copies are enough to put the tree back.
"""

from __future__ import annotations

import json
import os
import shutil
import time
from pathlib import Path
from typing import Any, Mapping

from services.io.atomic import _atomic_write_json

from .plan import Plan, plan_from_json, plan_to_json
from .state import ModuleTransactionError, pid_alive, transactions_root


_TEMP_SUFFIX = ".xk-tx-new"
_GZIP_SUFFIX = ".gz"
# A confirmed operation is renamed to this suffix before its directory is
# removed: whatever a power cut leaves of it is rubbish, not an operation.
_DONE_SUFFIX = ".done"
# The panel records an operation and only then starts its runner, which
# writes its pid a moment later. For that long the operation has no owner on
# record and still must not be taken for an abandoned one.
_START_GRACE_S = 30.0


def current_boot_id() -> str | None:
    """An identifier that changes with every boot of the router, if the system has one."""

    try:
        return Path("/proc/sys/kernel/random/boot_id").read_text(encoding="ascii").strip() or None
    except (OSError, ValueError):
        return None


def _plain(relative: str) -> bool:
    """Whether the path names something under the panel root and nothing else."""

    if not relative or "\\" in relative or ":" in relative:
        return False
    return all(part not in {"", ".", ".."} for part in relative.split("/"))


def _same_file(first: Path, second: Path) -> bool:
    try:
        return os.path.samefile(first, second)
    except OSError:
        return False


class Journal:
    def __init__(self, operation_dir: Path, panel_root: Path, plan: Plan, meta: dict[str, Any]) -> None:
        self.dir = Path(operation_dir)
        self.panel_root = Path(panel_root)
        self.plan = plan
        self.staging = self.dir / "staging"
        self.backup = self.dir / "backup"
        self._meta = meta
        self._log = self.dir / "actions.log"

    # -- lifecycle ---------------------------------------------------------

    @classmethod
    def create(cls, panel_root: Path, plan: Plan, operation_id: str, *, extra: Mapping[str, Any]) -> "Journal":
        panel_root = Path(panel_root)
        operation_dir = transactions_root(panel_root) / operation_id
        operation_dir.mkdir(parents=True)
        meta = {
            **dict(extra),
            "schema_version": 1,
            "operation_id": operation_id,
            "panel_root": str(panel_root),
            "plan": plan_to_json(plan),
            "step": "prepared",
            "pid": None,
            "started_at": time.time(),
            # The wall clock of a router jumps when the time is synchronised;
            # the time since boot does not, and it is the same for every process.
            "boot_id": current_boot_id(),
            "created_uptime": time.monotonic(),
        }
        journal = cls(operation_dir, panel_root, plan, meta)
        journal.staging.mkdir()
        journal.backup.mkdir()
        journal._save()
        return journal

    @classmethod
    def open(cls, operation_dir: Path) -> "Journal":
        operation_dir = Path(operation_dir)
        try:
            meta = json.loads((operation_dir / "operation.json").read_text(encoding="utf-8"))
            if not isinstance(meta, dict) or meta.get("schema_version") != 1:
                raise ValueError("unsupported operation record")
            panel_root = Path(meta["panel_root"])
            plan = plan_from_json(meta["plan"])
        except (OSError, ValueError, KeyError, TypeError) as error:
            raise ModuleTransactionError("operation_journal_invalid", "the operation record cannot be read") from error
        return cls(operation_dir, panel_root, plan, meta)

    @classmethod
    def salvage(cls, operation_dir: Path, panel_root: Path) -> "Journal":
        """Open an operation whose record is unreadable, for the undo alone.

        The undo needs only the action log and the kept copies, so a damaged
        ``operation.json`` must not leave the panel half replaced.
        """

        plan = Plan(
            scope="module", operation="repair", module_id="salvage", version="",
            source_version="", target_version="", target_profile=None, files_add=(), files_remove=(),
            archive=None, required_free_bytes=0, restart_required=False, installed_after=(),
        )
        return cls(Path(operation_dir), Path(panel_root), plan, {"schema_version": 1, "step": None, "pid": None})

    @staticmethod
    def find(panel_root: Path) -> Path | None:
        """The directory of the unfinished operation, if there is one."""

        root = transactions_root(Path(panel_root))
        try:
            candidates = sorted(
                path for path in root.iterdir() if path.is_dir() and not path.name.endswith(_DONE_SUFFIX)
            )
        except OSError:
            return None
        return candidates[-1] if candidates else None

    @staticmethod
    def sweep(panel_root: Path) -> None:
        """Remove what an interrupted confirmation left behind."""

        root = transactions_root(Path(panel_root))
        try:
            leftovers = [path for path in root.iterdir() if path.name.endswith(_DONE_SUFFIX)]
        except OSError:
            return
        for path in leftovers:
            shutil.rmtree(path, ignore_errors=True)
        try:
            root.rmdir()
        except OSError:
            pass

    def meta(self) -> dict[str, Any]:
        return dict(self._meta)

    def set_step(self, step: str) -> None:
        self._meta["step"] = step
        self._save()

    def set_pid(self, pid: int) -> None:
        self._meta["pid"] = int(pid)
        # A process id alone lies after a reboot: the number may belong to
        # some long-lived daemon by then.
        self._meta["boot_id"] = current_boot_id()
        self._save()

    def set_cancel_channel(self, address: Mapping[str, Any]) -> None:
        """Record where the runner listens for a request to stop."""

        self._meta["cancel"] = dict(address)
        self._save()

    def runner_alive(self) -> bool:
        """Whether the process that carries this operation still exists."""

        pid = self._meta.get("pid")
        if not pid or not pid_alive(pid):
            return False
        recorded = self._meta.get("boot_id")
        return not recorded or recorded == current_boot_id()

    def starting(self) -> bool:
        """Whether the runner of a just recorded operation may not have reported yet."""

        if self._meta.get("pid") or self._meta.get("step") != "prepared":
            return False
        created = self._meta.get("created_uptime")
        if isinstance(created, bool) or not isinstance(created, (int, float)):
            return False
        if self._meta.get("boot_id") != current_boot_id():
            return False
        return 0 <= time.monotonic() - created < _START_GRACE_S

    def busy(self) -> bool:
        """Whether somebody still carries this operation, or is about to."""

        return self.runner_alive() or self.starting()

    def flush(self) -> None:
        """Ask the system to put everything written so far on the storage.

        Copies of the previous files are about to be dropped or relied on;
        a file that exists only in the page cache is lost with the power.
        """

        sync = getattr(os, "sync", None)
        if sync is not None:
            try:
                sync()
            except OSError:
                pass

    def commit(self) -> None:
        # One rename takes the directory out of sight of ``find``. Removing
        # it file by file first would leave, after a power cut, an action
        # log without its record - and the next start would undo a
        # confirmed operation by it.
        done = self.dir.with_name(self.dir.name + _DONE_SUFFIX)
        try:
            os.replace(self.dir, done)
        except OSError:
            done = self.dir
            try:
                self._log.unlink()
            except OSError:
                pass
        shutil.rmtree(done, ignore_errors=True)
        try:
            # The parent is only a holder of operations; leave no empty shell.
            self.dir.parent.rmdir()
        except OSError:
            pass

    def keep_as(self, destination: Path, record: Mapping[str, Any], *, record_name: str) -> bool:
        """Move a confirmed operation aside with its copies; ``False`` if it could not be.

        The copies of what the operation replaced are the previous state of
        the tree. One rename takes the directory out of sight of ``find``,
        exactly like ``commit`` does, so a power cut leaves either an
        operation that is confirmed or a kept copy, never half of each.
        """

        destination = Path(destination)
        stale = destination.with_name(destination.name + ".old")
        try:
            shutil.rmtree(self.staging, ignore_errors=True)
            _atomic_write_json(str(self.dir / record_name), dict(record))
            shutil.rmtree(stale, ignore_errors=True)
            if destination.exists():
                os.replace(destination, stale)
            os.replace(self.dir, destination)
        except OSError:
            try:
                (self.dir / record_name).unlink()
            except OSError:
                pass
            return False
        shutil.rmtree(stale, ignore_errors=True)
        try:
            self.dir.parent.rmdir()
        except OSError:
            pass
        return True

    def _save(self) -> None:
        _atomic_write_json(str(self.dir / "operation.json"), self._meta)

    # -- changing the panel tree -------------------------------------------

    def apply_file(self, relative: str, source: Path, *, consume: bool = False) -> None:
        """Put a new file of the module in place, keeping what it replaces.

        A source that is given away (``consume``) is moved, not copied: the
        staged payload and the panel are on one storage, and a release that
        lies there twice is room the router may not have.
        """

        if relative not in self.plan.files_add:
            self._unsafe(relative, "the path is not part of the operation plan")
        target = self._target(relative)
        # Directories first: the undo walks the log backwards and can remove
        # a directory only after the file created in it is gone.
        self._ensure_parent(relative)
        self._record("replace" if target.is_file() else "add", relative)
        if target.is_file():
            self._keep(relative, target)
        if consume:
            try:
                os.replace(source, target)
                return
            except OSError:
                # Another storage, or a file system that will not rename over
                # the target: fall back to the copy and drop the source after.
                pass
        temporary = target.with_name(target.name + _TEMP_SUFFIX)
        shutil.copy2(source, temporary)
        os.replace(temporary, target)
        if consume:
            try:
                Path(source).unlink()
            except OSError:
                pass

    def remove_file(self, relative: str) -> None:
        if relative not in self.plan.files_remove:
            self._unsafe(relative, "the path is not part of the operation plan")
        target = self._target(relative)
        if not target.is_file():
            return
        self._record("remove", relative)
        self._keep(relative, target)
        target.unlink()
        self._prune_empty_parents(relative)

    def write_state_file(self, relative: str, payload: bytes) -> None:
        """Rewrite a file shared by all modules (state, frontend manifests)."""

        target = self._target(relative)
        existed = target.is_file()
        self._ensure_parent(relative)
        self._record("state" if existed else "add", relative)
        if existed:
            self._keep(relative, target)
        temporary = target.with_name(target.name + _TEMP_SUFFIX)
        temporary.write_bytes(payload)
        if existed:
            # A file the user closed for others stays closed.
            shutil.copymode(target, temporary)
        os.replace(temporary, target)

    def align_precompressed(self) -> None:
        """Give every added ``.gz`` the time of its source.

        The panel serves a precompressed copy only when it is not older than
        the file it stands for, and files of one package land a moment apart.
        The source may not be part of the operation at all: an update leaves
        an unchanged file alone, and its time can be ahead of the clock.
        """

        for relative in sorted(self.plan.files_add):
            if not relative.endswith(_GZIP_SUFFIX):
                continue
            packed = self._path(relative)
            source = self._path(relative[: -len(_GZIP_SUFFIX)])
            try:
                stamp = source.stat().st_mtime_ns
                os.utime(packed, ns=(stamp, stamp))
            except OSError:
                continue

    # -- undo ---------------------------------------------------------------

    def rollback(self) -> None:
        """Put back everything the log mentions; safe to run again after a failure."""

        actions = self._actions()
        logged = {action.get("path") for action in actions}
        # A copy in ``backup/`` is the previous file whatever the log says:
        # a damaged or missing log line must not cost the user that file.
        for relative in self._kept_paths():
            if relative not in logged:
                actions.insert(0, {"kind": "replace", "path": relative})
        for action in reversed(actions):
            kind, relative = action.get("kind"), action.get("path")
            if not isinstance(relative, str) or kind not in {"add", "replace", "remove", "state", "mkdir"}:
                continue
            if not _plain(relative):
                # The log is read back from the storage: a damaged line must
                # not send the undo outside the panel directory.
                continue
            try:
                if kind == "mkdir":
                    try:
                        self._path(relative).rmdir()
                    except OSError:
                        pass
                    continue
                target = self._path(relative)
                temporary = target.with_name(target.name + _TEMP_SUFFIX)
                if temporary.is_file():
                    temporary.unlink()
                if kind == "add":
                    if target.is_file():
                        target.unlink()
                    continue
                kept = self._kept(relative)
                if not kept.is_file():
                    # Announced but never started: the original is untouched.
                    continue
                if _same_file(target, kept):
                    # The previous file is still in place (announced, kept and
                    # never replaced, or put back by an earlier undo). Renaming
                    # another name of a file onto it does nothing on POSIX and
                    # would leave the temporary name behind.
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                try:
                    # A link needs no free space; the undo often runs exactly
                    # because the storage is full.
                    os.link(kept, temporary)
                except OSError:
                    shutil.copy2(kept, temporary)
                os.replace(temporary, target)
            except OSError as error:
                raise ModuleTransactionError(
                    "operation_rollback_failed",
                    "a previous file could not be restored",
                    path=relative,
                    error=str(error),
                ) from error

    # -- helpers --------------------------------------------------------------

    def _path(self, relative: str) -> Path:
        return self.panel_root.joinpath(*relative.split("/"))

    def _kept(self, relative: str) -> Path:
        return (self.backup / "files").joinpath(*relative.split("/"))

    def _kept_paths(self) -> list[str]:
        root = self.backup / "files"
        try:
            return sorted(
                path.relative_to(root).as_posix()
                for path in root.rglob("*")
                if path.is_file() and not path.name.endswith(_TEMP_SUFFIX)
            )
        except OSError:
            return []

    def _unsafe(self, relative: str, reason: str) -> None:
        raise ModuleTransactionError("operation_target_unsafe", reason, path=relative)

    def _target(self, relative: str) -> Path:
        parts = relative.split("/")
        if not _plain(relative):
            self._unsafe(relative, "the path leaves the panel directory")
        current = self.panel_root
        for part in parts[:-1]:
            current = current / part
            if current.is_symlink() or (current.exists() and not current.is_dir()):
                self._unsafe(relative, "a parent of the path is not a plain directory")
        target = current / parts[-1]
        if target.is_symlink() or target.is_dir():
            self._unsafe(relative, "the path is not a plain file")
        return target

    def _record(self, kind: str, relative: str) -> None:
        with open(self._log, "ab") as handle:
            handle.write((json.dumps({"kind": kind, "path": relative}, ensure_ascii=False) + "\n").encode("utf-8"))
            handle.flush()
            os.fsync(handle.fileno())

    def _actions(self) -> list[dict[str, Any]]:
        try:
            raw = self._log.read_bytes()
        except OSError:
            return []
        actions: list[dict[str, Any]] = []
        for line in raw.split(b"\n"):
            if not line.strip():
                continue
            try:
                action = json.loads(line.decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                # A line cut short by a power loss: its action never began.
                continue
            if isinstance(action, dict):
                actions.append(action)
        return actions

    def _keep(self, relative: str, target: Path) -> None:
        kept = self._kept(relative)
        if kept.exists():
            # The first copy is the original; a later one would be our own file.
            return
        kept.parent.mkdir(parents=True, exist_ok=True)
        try:
            os.link(target, kept)
        except OSError:
            temporary = kept.with_name(kept.name + _TEMP_SUFFIX)
            shutil.copy2(target, temporary)
            os.replace(temporary, kept)

    def _ensure_parent(self, relative: str) -> None:
        parts = relative.split("/")[:-1]
        current = self.panel_root
        for index, part in enumerate(parts):
            current = current / part
            if not current.exists():
                self._record("mkdir", "/".join(parts[: index + 1]))
                current.mkdir()

    def _prune_empty_parents(self, relative: str) -> None:
        parts = relative.split("/")[:-1]
        for depth in range(len(parts), 0, -1):
            directory = self.panel_root.joinpath(*parts[:depth])
            try:
                directory.rmdir()
            except OSError:
                return

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
from .state import ModuleTransactionError, transactions_root


_TEMP_SUFFIX = ".xk-tx-new"
_GZIP_SUFFIX = ".gz"


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

    @staticmethod
    def find(panel_root: Path) -> Path | None:
        """The directory of the unfinished operation, if there is one."""

        root = transactions_root(Path(panel_root))
        try:
            candidates = sorted(path for path in root.iterdir() if path.is_dir())
        except OSError:
            return None
        return candidates[-1] if candidates else None

    def meta(self) -> dict[str, Any]:
        return dict(self._meta)

    def set_step(self, step: str) -> None:
        self._meta["step"] = step
        self._save()

    def set_pid(self, pid: int) -> None:
        self._meta["pid"] = int(pid)
        self._save()

    def commit(self) -> None:
        shutil.rmtree(self.dir, ignore_errors=True)
        try:
            # The parent is only a holder of operations; leave no empty shell.
            self.dir.parent.rmdir()
        except OSError:
            pass

    def _save(self) -> None:
        _atomic_write_json(str(self.dir / "operation.json"), self._meta)

    # -- changing the panel tree -------------------------------------------

    def apply_file(self, relative: str, source: Path) -> None:
        """Put a new file of the module in place, keeping what it replaces."""

        if relative not in self.plan.files_add:
            self._unsafe(relative, "the path is not part of the operation plan")
        target = self._target(relative)
        # Directories first: the undo walks the log backwards and can remove
        # a directory only after the file created in it is gone.
        self._ensure_parent(relative)
        self._record("replace" if target.is_file() else "add", relative)
        if target.is_file():
            self._keep(relative, target)
        temporary = target.with_name(target.name + _TEMP_SUFFIX)
        shutil.copy2(source, temporary)
        os.replace(temporary, target)

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
        os.replace(temporary, target)

    def align_precompressed(self) -> None:
        """Give every added ``.gz`` the time of its source.

        The panel serves a precompressed copy only when it is not older than
        the file it stands for, and files of one package land a moment apart.
        """

        added = set(self.plan.files_add)
        for relative in sorted(added):
            if not relative.endswith(_GZIP_SUFFIX) or relative[: -len(_GZIP_SUFFIX)] not in added:
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

        for action in reversed(self._actions()):
            kind, relative = action.get("kind"), action.get("path")
            if not isinstance(relative, str) or kind not in {"add", "replace", "remove", "state", "mkdir"}:
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
                target.parent.mkdir(parents=True, exist_ok=True)
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

    def _unsafe(self, relative: str, reason: str) -> None:
        raise ModuleTransactionError("operation_target_unsafe", reason, path=relative)

    def _target(self, relative: str) -> Path:
        parts = relative.split("/")
        if not relative or "\\" in relative or ":" in relative or any(part in {"", ".", ".."} for part in parts):
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

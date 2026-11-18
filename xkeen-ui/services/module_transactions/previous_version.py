"""The release the panel ran before its last update, kept for going back.

An update of the panel already keeps every file it replaces: that is how it
undoes itself when the new release does not start. Once the update is
confirmed those copies used to be thrown away. Now the directory of the
operation is moved aside and stays as the previous version: the copies of
replaced, removed and rewritten files plus the log of what was added. It
costs the size of what the update changed and needs no network to use.

The copy describes one step back and only the tree the update left behind.
Module and profile operations extend the delta back to the same release.
Changes outside that journal make the copy stale.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import time
from dataclasses import dataclass
from itertools import chain
from pathlib import Path, PurePosixPath
from typing import TYPE_CHECKING, Any

from services.io.atomic import _atomic_write_json, _sync_dir

from .state import ModuleTransactionError

if TYPE_CHECKING:
    from .journal import Journal


RECORD_FILENAME = "previous.json"
MANAGED_MANIFEST = "install-managed.json"
_KINDS_WITH_COPY = frozenset({"replace", "remove", "state"})


def previous_version_root(panel_root: Path) -> Path:
    """Next to the panel, on its file system, like the operations themselves."""

    panel_root = Path(panel_root)
    return panel_root.parent / (panel_root.name + ".previous-version")


def _file_digest(path: Path) -> str | None:
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except FileNotFoundError:
        return None


def _panel_version(panel_root: Path) -> str | None:
    try:
        build = json.loads((Path(panel_root) / "BUILD.json").read_text(encoding="utf-8"))
        version = build.get("version") if isinstance(build, dict) else None
        return version.removeprefix("v") if isinstance(version, str) else None
    except (FileNotFoundError, ValueError):
        return None


def _plain(relative: Any) -> bool:
    if not isinstance(relative, str) or not relative or "\\" in relative or ":" in relative:
        return False
    pure = PurePosixPath(relative)
    return not pure.is_absolute() and all(part not in {"", ".", ".."} for part in pure.parts) and pure.as_posix() == relative


def record_for(panel_root: Path, *, operation_id: Any, from_version: str, to_version: str) -> dict[str, Any]:
    """What is written next to the kept copies when an update is confirmed."""

    return {
        "schema_version": 1,
        "operation_id": operation_id,
        "from_version": str(from_version),
        "to_version": str(to_version),
        "kept_at": time.time(),
        # The managed list as the update left it: a later operation on the
        # tree rewrites it, and the copy is then known to be stale.
        "managed_sha256": _file_digest(Path(panel_root) / MANAGED_MANIFEST),
    }


def drop_previous_version(panel_root: Path) -> None:
    root = previous_version_root(panel_root)
    for path in (root, root.with_name(root.name + ".old")):
        shutil.rmtree(path, ignore_errors=True)


@dataclass(frozen=True, slots=True)
class PreviousVersion:
    root: Path
    from_version: str
    to_version: str
    kept_at: float | None
    # Files the previous release had and the update replaced, removed or rewrote.
    restore: tuple[str, ...]
    # Files the update added; the previous release did not have them.
    added: tuple[str, ...]
    size: int

    def copy_of(self, relative: str) -> Path:
        return (self.root / "backup" / "files").joinpath(*relative.split("/"))


def _unavailable(reason: str) -> ModuleTransactionError:
    return ModuleTransactionError(
        "panel_rollback_unavailable",
        "there is no previous version of the panel to go back to",
        reason=reason,
    )


def read_previous_version(panel_root: Path) -> PreviousVersion:
    """The kept previous version, checked against the tree it has to be laid over.

    Raises ``panel_rollback_unavailable`` with the reason when there is no
    copy or the panel has changed since the update that left it.
    """

    from .journal import Journal

    panel_root = Path(panel_root)
    pending = Journal.find(panel_root)
    if pending is not None:
        try:
            step = Journal.open(pending).meta().get("step")
        except ModuleTransactionError as error:
            raise _unavailable("operation_recovery_required") from error
        if step == "committed":
            raise _unavailable("operation_recovery_required")
    try:
        return _read_previous(panel_root, previous_version_root(panel_root), panel_root / MANAGED_MANIFEST)
    except OSError as error:
        raise _unavailable("previous_version_unreadable") from error


def _read_previous(panel_root: Path, root: Path, managed_before: Path) -> PreviousVersion:
    try:
        record = json.loads((root / RECORD_FILENAME).read_text(encoding="utf-8"))
        if not isinstance(record, dict) or record.get("schema_version") != 1:
            raise ValueError("unsupported record")
        from_version, to_version = record["from_version"], record["to_version"]
        if not isinstance(from_version, str) or not isinstance(to_version, str):
            raise ValueError("invalid versions")
    except FileNotFoundError as error:
        raise _unavailable("no_previous_version") from error
    except (ValueError, KeyError, TypeError) as error:
        raise _unavailable("previous_version_unreadable") from error

    if _panel_version(panel_root) != to_version:
        raise _unavailable("panel_version_changed")
    recorded = record.get("managed_sha256")
    if not isinstance(recorded, str) or recorded != _file_digest(managed_before):
        raise _unavailable("panel_changed_since_update")

    kinds = _read_actions(root / "actions.log")
    restore: list[str] = []
    added: list[str] = []
    size = 0
    files = root / "backup" / "files"
    for relative, kind in sorted(kinds.items()):
        if kind == "add":
            added.append(relative)
            continue
        copy = files.joinpath(*relative.split("/"))
        try:
            if copy.is_symlink() or not copy.is_file():
                raise _unavailable("previous_version_incomplete")
            size += copy.stat().st_size
        except FileNotFoundError as error:
            raise _unavailable("previous_version_incomplete") from error
        restore.append(relative)
    if not restore and not added:
        raise _unavailable("previous_version_unreadable")
    kept_at = record.get("kept_at")
    return PreviousVersion(
        root=root,
        from_version=from_version,
        to_version=to_version,
        kept_at=float(kept_at) if isinstance(kept_at, (int, float)) and not isinstance(kept_at, bool) else None,
        restore=tuple(restore),
        added=tuple(added),
        size=size,
    )


def _read_actions(log: Path) -> dict[str, str]:
    kinds: dict[str, str] = {}
    try:
        raw = log.read_bytes()
    except FileNotFoundError as error:
        raise _unavailable("previous_version_unreadable") from error
    for line in raw.split(b"\n"):
        if not line.strip():
            continue
        try:
            action = json.loads(line.decode("utf-8"))
        except (ValueError, UnicodeDecodeError) as error:
            # Every line of a confirmed operation was written in full.
            raise _unavailable("previous_version_unreadable") from error
        kind, relative = (action.get("kind"), action.get("path")) if isinstance(action, dict) else (None, None)
        if kind == "mkdir":
            continue
        if kind not in _KINDS_WITH_COPY | {"add"} or not _plain(relative):
            raise _unavailable("previous_version_unreadable")
        # The first mention is what the update found: a later one is about
        # the file the update itself had put there.
        kinds.setdefault(relative, kind)
    return kinds


def extend_previous_version(journal: Journal) -> None:
    panel = journal.panel_root
    root = previous_version_root(panel)
    old = root.with_name(root.name + ".old")
    origin = root if root.is_dir() else old
    if not origin.is_dir():
        return
    record = json.loads((origin / RECORD_FILENAME).read_text(encoding="utf-8"))
    operation_id = journal.meta()["operation_id"]
    if root.is_dir() and record.get("last_operation_id") == operation_id:
        shutil.rmtree(old, ignore_errors=True)
        return
    actions_log = journal.dir / "actions.log"
    actions = _read_actions(actions_log) if actions_log.exists() else {}
    backup = journal.backup / "files"
    if actions.get(MANAGED_MANIFEST) == "add":
        raise _unavailable("panel_changed_since_update")
    managed_before = (backup if MANAGED_MANIFEST in actions else panel) / MANAGED_MANIFEST
    previous = _read_previous(panel, origin, managed_before)
    known = set(previous.restore + previous.added)
    if journal.plan.scope == "profile" and "modules.json" not in known:
        # Copies made by older updaters may lack the logical profile.
        raise _unavailable("previous_version_incomplete")
    actions = {path: kind for path, kind in actions.items() if path not in known}
    paths = known | actions.keys()
    # shortcut: file/directory changes across releases require a journal that restores both shapes.
    if any(parent.as_posix() in paths for path in paths for parent in PurePosixPath(path).parents):
        raise _unavailable("previous_version_incomplete")

    candidate = journal.dir / "previous"
    if candidate.exists():
        shutil.rmtree(candidate)
    candidate.mkdir()
    for path, source in chain(
        ((path, previous.copy_of(path)) for path in previous.restore),
        ((path, backup / path) for path, kind in actions.items() if kind != "add"),
    ):
        if source.is_symlink() or not source.is_file():
            raise _unavailable("previous_version_incomplete")
        target = candidate / "backup" / "files" / path
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            os.link(source, target)
        except OSError:
            shutil.copy2(source, target)
    actions.update(dict.fromkeys(previous.restore, "replace"))
    actions.update(dict.fromkeys(previous.added, "add"))
    (candidate / "actions.log").write_bytes(
        b"".join(json.dumps({"kind": kind, "path": path}).encode() + b"\n" for path, kind in actions.items())
    )
    managed_after = _file_digest(panel / MANAGED_MANIFEST)
    if managed_after is None:
        raise _unavailable("panel_changed_since_update")
    record.update(managed_sha256=managed_after, last_operation_id=operation_id)
    _atomic_write_json(str(candidate / RECORD_FILENAME), record)
    journal.flush()
    if origin == root:
        shutil.rmtree(old, ignore_errors=True)
        os.replace(root, old)
        _sync_dir(str(root))
    os.replace(candidate, root)
    _sync_dir(str(root))
    _sync_dir(str(candidate))
    shutil.rmtree(old, ignore_errors=True)


def describe_previous_version(panel_root: Path) -> dict[str, Any]:
    """For the panel to show: is there a way back, to which release, why not."""

    try:
        previous = read_previous_version(panel_root)
    except ModuleTransactionError as error:
        return {"available": False, "reason": error.details.get("reason"), "version": None, "kept_at": None, "size": 0}
    return {
        "available": True,
        "reason": None,
        "version": previous.from_version,
        "kept_at": previous.kept_at,
        "size": previous.size,
    }


__all__ = [
    "PreviousVersion",
    "describe_previous_version",
    "drop_previous_version",
    "previous_version_root",
    "read_previous_version",
    "record_for",
]

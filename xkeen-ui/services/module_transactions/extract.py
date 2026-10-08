"""Unpack the files of a verified module archive into a staging directory."""

from __future__ import annotations

import os
import shutil
import tarfile
from pathlib import Path, PurePosixPath
from typing import Collection

from .state import ModuleTransactionError


_PAYLOAD_PREFIX = "payload/"


def _safe(name: str) -> bool:
    if not name or "\\" in name or ":" in name or name.startswith("/"):
        return False
    return all(part not in {"", ".", ".."} for part in name.split("/")) and PurePosixPath(name).as_posix() == name


def extract_payload(archive: Path, destination: Path, only: Collection[str]) -> tuple[str, ...]:
    """Write the requested payload files under ``destination`` and return their paths.

    The archive was already checked against its manifest. Paths are checked
    again here because this is the code that actually creates files: nothing
    but a regular file with a plain relative name is ever written.
    """

    wanted = set(only)
    for relative in wanted:
        if not _safe(relative):
            raise ModuleTransactionError("archive_path_unsafe", "requested payload path is unsafe", path=relative)
    destination = Path(destination)
    extracted: list[str] = []
    try:
        with tarfile.open(archive, "r:gz") as source:
            for member in source:
                if member.issym() or member.islnk():
                    raise ModuleTransactionError("archive_link_forbidden", "archive links are not allowed", path=member.name)
                if not _safe(member.name):
                    raise ModuleTransactionError("archive_path_unsafe", "archive contains an unsafe member path", path=member.name)
                if not member.isreg() or not member.name.startswith(_PAYLOAD_PREFIX):
                    continue
                relative = member.name[len(_PAYLOAD_PREFIX):]
                if relative not in wanted:
                    continue
                stream = source.extractfile(member)
                if stream is None:
                    raise ModuleTransactionError("archive_invalid", "module archive cannot be read", path=member.name)
                target = destination.joinpath(*relative.split("/"))
                target.parent.mkdir(parents=True, exist_ok=True)
                with stream, open(target, "wb") as output:
                    shutil.copyfileobj(stream, output)
                # Only the executable bit is taken from the archive: a script
                # of the module has to stay runnable, nothing else is trusted.
                os.chmod(target, 0o755 if member.mode & 0o111 else 0o644)
                extracted.append(relative)
    except ModuleTransactionError:
        raise
    except (tarfile.TarError, OSError, EOFError) as error:
        raise ModuleTransactionError("archive_invalid", "module archive cannot be read", error=str(error)) from error
    missing = sorted(wanted - set(extracted))
    if missing:
        raise ModuleTransactionError("archive_member_missing", "the archive lacks files of the module", paths=missing)
    return tuple(sorted(extracted))


def read_panel_member(archive: Path, relative: str, *, max_bytes: int) -> bytes | None:
    """One small file of a verified panel archive; ``None`` when it is not there.

    For what the release carries outside of any module (the uninstall
    script): too few bytes to stage as a file, and no reason to fail an
    update over.
    """

    if not _safe(relative):
        return None
    wanted = "xkeen-ui/" + relative
    try:
        with tarfile.open(archive, "r:gz") as source:
            for member in source:
                if member.name != wanted:
                    continue
                if not member.isreg() or member.size > int(max_bytes):
                    return None
                stream = source.extractfile(member)
                if stream is None:
                    return None
                with stream:
                    return stream.read(int(max_bytes) + 1)[: int(max_bytes)]
    except (tarfile.TarError, OSError, EOFError):
        return None
    return None


def extract_panel_payload(archive: Path, destination: Path, only: Collection[str]) -> tuple[str, ...]:
    """Extract selected verified files from the single ``xkeen-ui/`` root."""

    wanted = set(only)
    for relative in wanted:
        if not _safe(relative):
            raise ModuleTransactionError("archive_path_unsafe", "requested panel path is unsafe", path=relative)
    destination = Path(destination)
    extracted: list[str] = []
    try:
        with tarfile.open(archive, "r:gz") as source:
            for member in source:
                if member.issym() or member.islnk():
                    raise ModuleTransactionError("archive_link_forbidden", "archive links are not allowed", path=member.name)
                if not _safe(member.name):
                    raise ModuleTransactionError("archive_path_unsafe", "archive contains an unsafe member path", path=member.name)
                if not member.isreg() or not member.name.startswith("xkeen-ui/"):
                    continue
                relative = member.name[len("xkeen-ui/"):]
                if relative not in wanted:
                    continue
                stream = source.extractfile(member)
                if stream is None:
                    raise ModuleTransactionError("archive_invalid", "panel archive cannot be read", path=member.name)
                target = destination.joinpath(*relative.split("/"))
                target.parent.mkdir(parents=True, exist_ok=True)
                with stream, open(target, "wb") as output:
                    shutil.copyfileobj(stream, output)
                os.chmod(target, 0o755 if member.mode & 0o111 else 0o644)
                extracted.append(relative)
    except ModuleTransactionError:
        raise
    except (tarfile.TarError, OSError, EOFError) as error:
        raise ModuleTransactionError("archive_invalid", "panel archive cannot be read", error=str(error)) from error
    missing = sorted(wanted - set(extracted))
    if missing:
        raise ModuleTransactionError("archive_member_missing", "the panel archive lacks planned files", paths=missing)
    return tuple(sorted(extracted))

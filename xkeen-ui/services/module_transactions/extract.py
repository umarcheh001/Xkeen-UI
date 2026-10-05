"""Unpack the files of a verified module archive into a staging directory."""

from __future__ import annotations

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
                extracted.append(relative)
    except ModuleTransactionError:
        raise
    except (tarfile.TarError, OSError, EOFError) as error:
        raise ModuleTransactionError("archive_invalid", "module archive cannot be read", error=str(error)) from error
    missing = sorted(wanted - set(extracted))
    if missing:
        raise ModuleTransactionError("archive_member_missing", "the archive lacks files of the module", paths=missing)
    return tuple(sorted(extracted))

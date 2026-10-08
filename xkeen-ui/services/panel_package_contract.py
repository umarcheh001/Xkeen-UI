"""Static trust checks for a signed whole-panel release archive."""

from __future__ import annotations

import hashlib
import json
import os
import re
import tarfile
import zlib
from pathlib import PurePosixPath
from typing import Any, Mapping

from services.module_package_contract import (
    ModulePackageContractError,
    validate_panel_catalog_descriptor,
)
from services.module_profile_plan import user_owned
from services.module_registry import is_module_id


MAX_PANEL_EXPANDED_BYTES = 256 * 1024 * 1024
MAX_OWNERSHIP_BYTES = 4 * 1024 * 1024
_BOOTSTRAP_FILES = {"install.sh", "uninstall.sh"}
_WINDOWS_DRIVE = re.compile(r"^[A-Za-z]:")


def _fail(code: str, message: str, **details: Any) -> None:
    raise ModulePackageContractError(code, message, **details)


def _safe_member_path(value: object) -> str:
    if not isinstance(value, str) or not value or "\\" in value or _WINDOWS_DRIVE.match(value):
        _fail("panel_archive_path_unsafe", "panel archive path is not normalized")
    parsed = PurePosixPath(value)
    if parsed.is_absolute() or any(part in {"", ".", ".."} for part in parsed.parts):
        _fail("panel_archive_path_unsafe", "panel archive path is not relative and normalized", path=value)
    if any(ord(character) < 32 for character in value) or str(parsed) != value.rstrip("/"):
        _fail("panel_archive_path_unsafe", "panel archive path is not normalized", path=value)
    return str(parsed)


def _user_owned(relative: str) -> bool:
    # One rule for the whole panel. The installer is the only file of the
    # owner's that a release carries: the archive is also what bootstraps.
    return relative not in _BOOTSTRAP_FILES and user_owned(relative)


def _string_paths(value: object, *, module_id: str) -> list[str]:
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        _fail("panel_archive_ownership_invalid", "ownership entries must be lists of paths", module_id=module_id)
    normalized: list[str] = []
    for item in value:
        checked = _safe_member_path(item)
        if checked != item or checked.startswith("xkeen-ui/") or _user_owned(checked):
            _fail("panel_archive_ownership_invalid", "ownership path is outside the managed package", path=item)
        normalized.append(checked)
    if len(normalized) != len(set(normalized)):
        _fail("panel_archive_ownership_invalid", "ownership paths must not contain duplicates", module_id=module_id)
    return normalized


def _validate_ownership(payload: bytes, managed_files: set[str]) -> dict[str, Any]:
    try:
        raw = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as error:
        _fail("panel_archive_ownership_invalid", "module ownership is not valid UTF-8 JSON")
    # Keys a later release adds are passed over: the archive is the one the
    # signed catalog names, and what this build needs from the map is below.
    if not isinstance(raw, Mapping) or not {"schema_version", "modules", "frontend"} <= set(raw):
        _fail("panel_archive_ownership_invalid", "module ownership has an invalid shape")
    if raw["schema_version"] != 1 or not isinstance(raw["modules"], Mapping) or not isinstance(raw["frontend"], Mapping):
        _fail("panel_archive_ownership_invalid", "module ownership has an unsupported schema")
    modules: dict[str, list[str]] = {}
    claimed: set[str] = set()
    for module_id, paths in raw["modules"].items():
        # A later release may own files through modules this build does not
        # know; the name only has to be a module name.
        if not is_module_id(module_id):
            _fail("panel_archive_ownership_invalid", "module ownership names an invalid module", module_id=str(module_id))
        normalized = _string_paths(paths, module_id=module_id)
        overlap = claimed.intersection(normalized)
        if overlap:
            _fail("panel_archive_ownership_invalid", "managed path has more than one owner", paths=sorted(overlap))
        claimed.update(normalized)
        modules[module_id] = normalized
    if claimed != managed_files:
        _fail(
            "panel_archive_ownership_mismatch",
            "module ownership does not match packaged managed files",
            missing=sorted(managed_files - claimed),
            extra=sorted(claimed - managed_files),
        )
    frontend = dict(raw["frontend"])
    if not {"bridge", "build"} <= set(frontend) or any(
        not isinstance(frontend[key], Mapping) for key in ("bridge", "build")
    ):
        _fail("panel_archive_ownership_invalid", "frontend ownership manifests have an invalid shape")
    return {
        "schema_version": 1,
        "modules": modules,
        "frontend": {"bridge": dict(frontend["bridge"]), "build": dict(frontend["build"])},
    }


def validate_panel_archive(
    archive_path: os.PathLike[str] | str,
    descriptor: Mapping[str, Any],
    *,
    platform_architecture: str,
) -> dict[str, Any]:
    """Verify archive identity, tar safety, mutable-state exclusion, and ownership."""

    version = str(descriptor.get("version", "")) if isinstance(descriptor, Mapping) else ""
    key_id = str(descriptor.get("signing_key_id", "")) if isinstance(descriptor, Mapping) else ""
    normalized = validate_panel_catalog_descriptor(
        descriptor,
        release_version=version,
        signing_key_id=key_id,
        platform_architecture=platform_architecture,
    )
    path = os.fspath(archive_path)
    if not os.path.isfile(path):
        _fail("panel_archive_missing", "panel archive does not exist")
    if os.path.getsize(path) != normalized["size"]:
        _fail("panel_archive_size_mismatch", "panel archive size does not match its descriptor")
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    if digest.hexdigest() != normalized["sha256"]:
        _fail("panel_archive_checksum_mismatch", "panel archive checksum does not match its descriptor")

    seen: set[str] = set()
    payload_files: list[str] = []
    payload_sizes: dict[str, int] = {}
    payload_digests: dict[str, str] = {}
    payload_executable: list[str] = []
    ownership_data: bytes | None = None
    expanded_size = 0
    try:
        with tarfile.open(path, "r:gz") as archive:
            for member in archive:
                member_path = _safe_member_path(member.name)
                if member_path in seen:
                    _fail("panel_archive_member_duplicate", "panel archive contains duplicate members", path=member_path)
                seen.add(member_path)
                parts = PurePosixPath(member_path).parts
                if not parts or parts[0] != "xkeen-ui":
                    _fail("panel_archive_root_invalid", "panel archive must contain exactly one xkeen-ui root")
                if member.isdir():
                    continue
                if not member.isreg():
                    _fail("panel_archive_member_type_forbidden", "panel archive contains a non-regular member")
                if len(parts) == 1:
                    _fail("panel_archive_root_invalid", "xkeen-ui root cannot be a regular file")
                relative = PurePosixPath(*parts[1:]).as_posix()
                if _user_owned(relative):
                    _fail("panel_archive_user_path_forbidden", "panel archive contains mutable user state", path=relative)
                expanded_size += member.size
                if expanded_size > MAX_PANEL_EXPANDED_BYTES:
                    _fail("panel_archive_expanded_too_large", "panel archive exceeds its expanded size limit")
                payload_files.append(relative)
                payload_sizes[relative] = int(member.size)
                if member.mode & 0o111:
                    payload_executable.append(relative)
                if relative == "module-ownership.json" and member.size > MAX_OWNERSHIP_BYTES:
                    _fail("panel_archive_ownership_invalid", "module ownership exceeds its size limit")
                extracted = archive.extractfile(member)
                if extracted is None:
                    _fail("panel_archive_member_unreadable", "panel archive member cannot be read", path=relative)
                # The stream is unpacked to walk the archive anyway; the sum of
                # each file lets an update leave alone what did not change.
                member_digest = hashlib.sha256()
                kept = bytearray() if relative == "module-ownership.json" else None
                for chunk in iter(lambda: extracted.read(1024 * 1024), b""):
                    member_digest.update(chunk)
                    if kept is not None:
                        kept.extend(chunk)
                payload_digests[relative] = member_digest.hexdigest()
                if kept is not None:
                    ownership_data = bytes(kept)
    except ModulePackageContractError:
        raise
    except (OSError, EOFError, tarfile.TarError, zlib.error) as error:
        raise ModulePackageContractError("panel_archive_invalid", "panel archive cannot be read") from error

    if ownership_data is None:
        _fail("panel_archive_ownership_missing", "panel archive has no module ownership map")
    managed_files = set(payload_files) - _BOOTSTRAP_FILES
    ownership = _validate_ownership(ownership_data, managed_files)
    return {
        "root": "xkeen-ui",
        "payload_files": sorted(payload_files),
        # Enough to plan an operation without unpacking the archive.
        "payload_sizes": payload_sizes,
        # Enough to tell which files on the storage are already the target's.
        "payload_digests": payload_digests,
        "payload_executable": sorted(payload_executable),
        "expanded_size": expanded_size,
        "ownership": ownership,
    }

"""Static contract checks for official module catalogs and archives.

This module deliberately has no network, installer, or activation side effects.  It
is the preflight boundary used before a future updater is allowed to unpack a
module archive.
"""

from __future__ import annotations

import hashlib
import json
import os
import platform
import re
import sys
import tarfile
from pathlib import PurePosixPath
from typing import AbstractSet, Any, Mapping
from urllib.parse import urlsplit

from services.module_catalog_trust import TRUSTED_SIGNING_KEY_IDS
from services.module_registry import MODULE_DEFINITIONS, MODULE_IDS


SUPPORTED_PANEL_API = "1"
SUPPORTED_MODULE_API = "1"
MANIFEST_SCHEMA_VERSION = 1
# The ids a catalog entry may name. The release builder keeps the same list.
CATALOG_ARCHITECTURES = ("aarch64", "mips", "mipsel")
OFFICIAL_CATALOG_PREFIX = "/umarcheh001/Xkeen-UI/releases/download/"
_SEMVER_RE = re.compile(
    r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)"
    r"(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$"
)
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_HOOK_NAMES = {"install.sh", "uninstall.sh", "install", "uninstall"}


class ModulePackageContractError(ValueError):
    """A deterministic, client-safe static package validation failure."""

    def __init__(self, code: str, message: str, **details: Any):
        self.code = str(code)
        self.details = details
        super().__init__(f"{self.code}: {message}")


def _fail(code: str, message: str, **details: Any) -> None:
    raise ModulePackageContractError(code, message, **details)


def detect_platform_architecture(*, machine: str | None = None, byteorder: str | None = None) -> str:
    """Return the catalog architecture id of the router the panel runs on.

    ``uname -m`` answers ``mips`` on Keenetic routers of both byte orders, so
    for MIPS the byte order of the running interpreter decides. A platform the
    catalog is not built for is refused instead of being guessed.
    """

    if machine is None:
        try:
            machine = os.uname().machine
        except (AttributeError, OSError):
            machine = platform.machine()
    normalized = str(machine or "").strip().lower()
    order = str(byteorder if byteorder is not None else sys.byteorder).strip().lower()
    if normalized in {"aarch64", "arm64"}:
        return "aarch64"
    if normalized in {"mipsel", "mipsle"}:
        return "mipsel"
    if normalized == "mips":
        return "mipsel" if order == "little" else "mips"
    _fail(
        "platform_architecture_unsupported",
        "the catalog is not built for this platform",
        machine=normalized,
        supported=list(CATALOG_ARCHITECTURES),
    )


def _mapping(value: object, label: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        _fail(f"{label}_not_object", f"{label} must be an object")
    return value


def validate_semver(value: object, label: str) -> str:
    """Return a canonical SemVer string or raise a contract error."""

    normalized = str(value or "").strip()
    if not _SEMVER_RE.fullmatch(normalized):
        _fail(f"{label}_invalid", f"{label} must use semantic versioning", value=normalized)
    _, separator, prerelease_and_build = normalized.partition("-")
    if separator:
        prerelease = prerelease_and_build.partition("+")[0]
        if any(identifier.isdigit() and len(identifier) > 1 and identifier.startswith("0") for identifier in prerelease.split(".")):
            _fail(f"{label}_invalid", f"{label} must use semantic versioning", value=normalized)
    return normalized


def _semver_key(version: str) -> tuple[tuple[int, int, int], tuple[tuple[int, int | str], ...] | None]:
    base, separator, suffix = version.partition("-")
    numeric = tuple(int(part) for part in base.split("+", 1)[0].split("."))
    if not separator:
        return numeric, None
    prerelease = suffix.split("+", 1)[0]
    identifiers: list[tuple[int, int | str]] = []
    for identifier in prerelease.split("."):
        identifiers.append((0, int(identifier)) if identifier.isdigit() else (1, identifier))
    return numeric, tuple(identifiers)


def compare_semver(left: str, right: str) -> int:
    """Compare two semantic versions using SemVer prerelease ordering."""

    left_normalized = validate_semver(left, "left_version")
    right_normalized = validate_semver(right, "right_version")
    left_numeric, left_prerelease = _semver_key(left_normalized)
    right_numeric, right_prerelease = _semver_key(right_normalized)
    if left_numeric != right_numeric:
        return -1 if left_numeric < right_numeric else 1
    if left_prerelease is None and right_prerelease is None:
        return 0
    if left_prerelease is None:
        return 1
    if right_prerelease is None:
        return -1
    if left_prerelease == right_prerelease:
        return 0
    return -1 if left_prerelease < right_prerelease else 1


def _semver_at_least(actual: str, required: str) -> bool:
    return compare_semver(actual, required) >= 0


def _string_list(value: object, label: str) -> list[str]:
    if not isinstance(value, list) or any(not isinstance(item, str) or not item.strip() for item in value):
        _fail(f"{label}_invalid", f"{label} must be a list of non-empty strings")
    normalized = [item.strip() for item in value]
    if len(normalized) != len(set(normalized)):
        _fail(f"{label}_duplicate", f"{label} must not contain duplicates")
    return normalized


def _safe_relative_path(value: object, code: str) -> str:
    if not isinstance(value, str):
        _fail(code, "archive path must be a string")
    path = value.replace("\\", "/")
    parsed = PurePosixPath(path)
    if not path or parsed.is_absolute() or any(part in {"", ".", ".."} for part in parsed.parts):
        _fail(code, "archive path must be relative and normalized", path=path)
    if any(ord(character) < 32 for character in path):
        _fail(code, "archive path contains a control character", path=path)
    return str(parsed)


def _module_definition(module_id: str):
    for definition in MODULE_DEFINITIONS:
        if definition.id == module_id:
            return definition
    _fail("catalog_module_unknown", "module is not part of the official registry", module_id=module_id)


def validate_catalog_source(source: str) -> str:
    """Validate the immutable HTTPS endpoint for the official stable catalog."""

    parsed = urlsplit(str(source or ""))
    if parsed.scheme != "https" or parsed.hostname != "github.com":
        _fail("catalog_source_not_official", "catalog source must be the official GitHub endpoint")
    if parsed.query or parsed.fragment:
        _fail("catalog_source_not_stable", "catalog source must not contain mutable URL selectors")
    if not parsed.path.startswith(OFFICIAL_CATALOG_PREFIX) or not parsed.path.endswith("/catalog.json"):
        _fail("catalog_source_not_official", "catalog source must point to an official release catalog")
    version = parsed.path[len(OFFICIAL_CATALOG_PREFIX) : -len("/catalog.json")]
    validate_semver(version.removeprefix("v"), "catalog_release_version")
    return parsed.geturl()


def validate_catalog_entry(
    catalog: Mapping[str, Any],
    *,
    trusted_signing_key_ids: set[str] | frozenset[str] | None = None,
    platform_architecture: str | None = None,
    core_version: str | None = None,
) -> dict[str, Any]:
    """Validate one stable catalog entry without fetching or trusting it."""

    entry = _mapping(catalog, "catalog")
    required = (
        "id",
        "version",
        "channel",
        "panel_api",
        "module_api",
        "min_core",
        "architectures",
        "requires",
        "conflicts",
        "requires_restart",
        "archive",
        "size",
        "sha256",
        "signing_key_id",
    )
    missing = [field for field in required if field not in entry]
    if missing:
        _fail("catalog_required_field", "catalog entry is missing required fields", fields=missing)

    module_id = str(entry["id"] or "").strip()
    if module_id not in MODULE_IDS:
        _fail("catalog_module_unknown", "module is not part of the official registry", module_id=module_id)
    version = validate_semver(entry["version"], "catalog_version")
    if entry["channel"] != "stable":
        _fail("catalog_channel_unsupported", "only stable releases are accepted")
    if entry["panel_api"] != SUPPORTED_PANEL_API or entry["module_api"] != SUPPORTED_MODULE_API:
        _fail("catalog_api_unsupported", "catalog API versions are not supported")
    min_core = validate_semver(entry["min_core"], "catalog_min_core")
    if core_version is not None:
        normalized_core = validate_semver(core_version, "current_core_version")
        if not _semver_at_least(normalized_core, min_core):
            _fail(
                "catalog_min_core_unsupported",
                "catalog requires a newer core version",
                current_core=normalized_core,
                min_core=min_core,
            )
    architectures = _string_list(entry["architectures"], "catalog_architectures")
    if platform_architecture is not None and str(platform_architecture).strip() not in architectures:
        _fail(
            "catalog_architecture_unsupported",
            "catalog does not contain the requested normalized platform architecture",
            architecture=str(platform_architecture).strip(),
        )
    requires = _string_list(entry["requires"], "catalog_requires")
    conflicts = _string_list(entry["conflicts"], "catalog_conflicts")
    known_modules = set(MODULE_IDS)
    unknown = sorted((set(requires) | set(conflicts)) - known_modules)
    if unknown:
        _fail("catalog_dependency_unknown", "catalog references unknown modules", module_ids=unknown)
    if module_id in requires or module_id in conflicts:
        _fail("catalog_self_reference", "catalog module cannot require or conflict with itself")
    definition = _module_definition(module_id)
    if requires != list(definition.dependencies) or conflicts != list(definition.conflicts):
        _fail("catalog_dependency_mismatch", "catalog dependencies do not match the registry", module_id=module_id)
    if not isinstance(entry["requires_restart"], bool):
        _fail("catalog_requires_restart_invalid", "requires_restart must be boolean")
    if entry["requires_restart"] != definition.requires_restart:
        _fail("catalog_requires_restart_mismatch", "requires_restart does not match the registry")

    archive = str(entry["archive"] or "").strip()
    expected_archive = f"xkeen-module-{module_id}-{version}.tar.gz"
    if archive != expected_archive or "/" in archive or "\\" in archive:
        _fail("catalog_archive_not_filename", "archive must be the official release filename")
    size = entry["size"]
    if not isinstance(size, int) or isinstance(size, bool) or size <= 0:
        _fail("catalog_size_invalid", "archive size must be a positive integer")
    sha256 = str(entry["sha256"] or "")
    if not _SHA256_RE.fullmatch(sha256):
        _fail("catalog_sha256_invalid", "archive sha256 must be lowercase hexadecimal")
    signing_key_id = str(entry["signing_key_id"] or "").strip()
    if not signing_key_id or "/" in signing_key_id or "\\" in signing_key_id:
        _fail("catalog_signing_key_invalid", "signing_key_id must be a stable identifier")
    trusted_keys = TRUSTED_SIGNING_KEY_IDS if trusted_signing_key_ids is None else trusted_signing_key_ids
    if signing_key_id not in trusted_keys:
        _fail("catalog_signing_key_unknown", "catalog signing key is not trusted", signing_key_id=signing_key_id)

    return {
        "id": module_id,
        "version": version,
        "channel": "stable",
        "panel_api": SUPPORTED_PANEL_API,
        "module_api": SUPPORTED_MODULE_API,
        "min_core": min_core,
        "architectures": architectures,
        "requires": requires,
        "conflicts": conflicts,
        "requires_restart": entry["requires_restart"],
        "archive": archive,
        "size": size,
        "sha256": sha256,
        "signing_key_id": signing_key_id,
    }


def validate_catalog_document(
    document: Mapping[str, Any],
    *,
    release_version: str,
    signing_key_id: str,
    trusted_signing_key_ids: AbstractSet[str] | None = None,
    platform_architecture: str | None = None,
    core_version: str | None = None,
) -> dict[str, Any]:
    """Validate one signed stable catalog after its envelope is verified."""

    catalog = _mapping(document, "catalog")
    required = ("schema_version", "release_version", "channel", "source_commit", "modules")
    missing = [field for field in required if field not in catalog]
    if missing:
        _fail("catalog_required_field", "catalog document is missing required fields", fields=missing)
    if not isinstance(catalog["schema_version"], int) or isinstance(catalog["schema_version"], bool) or catalog["schema_version"] != 1:
        _fail("catalog_schema_unsupported", "catalog schema is not supported")
    normalized_release = validate_semver(catalog["release_version"], "catalog_release_version")
    expected_release = validate_semver(release_version, "expected_release_version")
    if normalized_release != expected_release:
        _fail(
            "catalog_release_version_mismatch",
            "catalog release version does not match its immutable source URL",
            catalog_release_version=normalized_release,
            expected_release_version=expected_release,
        )
    if catalog["channel"] != "stable":
        _fail("catalog_channel_unsupported", "only stable catalog releases are accepted")
    source_commit = catalog["source_commit"]
    if not isinstance(source_commit, str) or not source_commit.strip():
        _fail("catalog_source_commit_invalid", "catalog source_commit must be a non-empty string")
    modules = catalog["modules"]
    if not isinstance(modules, list):
        _fail("catalog_modules_invalid", "catalog modules must be a list")
    if not modules:
        _fail("catalog_modules_empty", "catalog modules must not be empty")

    normalized_modules: list[dict[str, Any]] = []
    seen_module_ids: set[str] = set()
    for item in modules:
        entry = validate_catalog_entry(
            _mapping(item, "catalog"),
            trusted_signing_key_ids=trusted_signing_key_ids,
            platform_architecture=platform_architecture,
            core_version=core_version,
        )
        if entry["id"] in seen_module_ids:
            _fail("catalog_module_duplicate", "catalog contains duplicate module IDs", module_id=entry["id"])
        if entry["signing_key_id"] != signing_key_id:
            _fail(
                "catalog_signing_key_mismatch",
                "catalog entry key does not match the verified signature envelope",
                module_id=entry["id"],
                entry_signing_key_id=entry["signing_key_id"],
                signing_key_id=signing_key_id,
            )
        seen_module_ids.add(entry["id"])
        normalized_modules.append(entry)

    return {
        "schema_version": 1,
        "release_version": normalized_release,
        "channel": "stable",
        "source_commit": source_commit.strip(),
        "modules": normalized_modules,
    }


def _validate_manifest(manifest: Mapping[str, Any], catalog: Mapping[str, Any]) -> list[str]:
    required = (
        "schema_version",
        "id",
        "version",
        "channel",
        "panel_api",
        "module_api",
        "min_core",
        "architectures",
        "requires",
        "conflicts",
        "requires_restart",
        "ownership",
        "max_size",
    )
    missing = [field for field in required if field not in manifest]
    if missing:
        _fail("manifest_required_field", "module manifest is missing required fields", fields=missing)
    if manifest["schema_version"] != MANIFEST_SCHEMA_VERSION:
        _fail("manifest_schema_unsupported", "module manifest schema is not supported")
    identity_fields = ("id", "version", "channel", "panel_api", "module_api", "min_core", "architectures", "requires", "conflicts", "requires_restart")
    for field in identity_fields:
        if manifest[field] != catalog[field]:
            _fail("manifest_identity_mismatch", "module manifest does not match its catalog entry", field=field)
    ownership = _string_list(manifest["ownership"], "manifest_ownership")
    max_size = manifest["max_size"]
    if not isinstance(max_size, int) or isinstance(max_size, bool) or max_size <= 0:
        _fail("manifest_max_size_invalid", "manifest max_size must be a positive integer")
    for path in ownership:
        normalized = _safe_relative_path(path, "manifest_path_unsafe")
        if normalized != path:
            _fail("manifest_path_unsafe", "manifest ownership path is not normalized", path=path)
        if PurePosixPath(normalized).name.lower() in _HOOK_NAMES or any(
            segment.lower() == "hooks" for segment in PurePosixPath(normalized).parts
        ):
            _fail("manifest_hook_forbidden", "install/uninstall shell hooks are outside the contract", path=path)
    return ownership


def validate_module_archive(
    archive_path: os.PathLike[str] | str,
    catalog: Mapping[str, Any],
    *,
    trusted_signing_key_ids: set[str] | frozenset[str] | None = None,
    platform_architecture: str | None = None,
    core_version: str | None = None,
) -> dict[str, Any]:
    """Validate archive bytes, paths, manifest identity, and ownership allow-list."""

    normalized_catalog = validate_catalog_entry(
        catalog,
        trusted_signing_key_ids=trusted_signing_key_ids,
        platform_architecture=platform_architecture,
        core_version=core_version,
    )
    path = os.fspath(archive_path)
    if not os.path.isfile(path):
        _fail("archive_missing", "module archive does not exist", path=path)
    actual_size = os.path.getsize(path)
    if actual_size != normalized_catalog["size"]:
        _fail("archive_size_mismatch", "archive size does not match catalog")
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    if digest.hexdigest() != normalized_catalog["sha256"]:
        _fail("archive_checksum_mismatch", "archive SHA-256 does not match catalog")

    manifest_data: bytes | None = None
    payload_files: list[str] = []
    payload_size = 0
    try:
        with tarfile.open(path, "r:gz") as archive:
            for member in archive.getmembers():
                name = member.name.replace("\\", "/")
                if name != member.name or name.startswith("/") or any(part in {"", ".", ".."} for part in PurePosixPath(name).parts):
                    _fail("archive_path_unsafe", "archive contains an unsafe member path", path=member.name)
                if member.issym() or member.islnk():
                    _fail("archive_link_forbidden", "archive links are outside the module root", path=member.name)
                if member.isdir():
                    if name != "payload" and not name.startswith("payload/"):
                        _fail("archive_layout_invalid", "directories must stay under payload/", path=member.name)
                    continue
                if not member.isreg():
                    _fail("archive_entry_type_forbidden", "archive contains a non-regular entry", path=member.name)
                if name == "module-manifest.json":
                    if manifest_data is not None:
                        _fail("manifest_duplicate", "archive contains duplicate module manifests")
                    extracted = archive.extractfile(member)
                    manifest_data = extracted.read() if extracted is not None else b""
                    continue
                if not name.startswith("payload/") or name == "payload/":
                    _fail("archive_layout_invalid", "payload files must stay under payload/")
                payload_name = name.removeprefix("payload/")
                normalized_name = _safe_relative_path(payload_name, "archive_path_unsafe")
                if normalized_name != payload_name:
                    _fail("archive_path_unsafe", "archive payload path is not normalized", path=name)
                if PurePosixPath(normalized_name).name.lower() in _HOOK_NAMES or any(
                    segment.lower() == "hooks" for segment in PurePosixPath(normalized_name).parts
                ):
                    _fail("manifest_hook_forbidden", "install/uninstall shell hooks are outside the contract", path=name)
                payload_files.append(normalized_name)
                payload_size += member.size
    except ModulePackageContractError:
        raise
    except (tarfile.TarError, OSError) as exc:
        _fail("archive_invalid", "module archive cannot be read", error=str(exc))

    if manifest_data is None:
        _fail("manifest_missing", "archive must contain module-manifest.json")
    try:
        manifest = json.loads(manifest_data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        _fail("manifest_invalid_json", "module manifest is not valid UTF-8 JSON", error=str(exc))
    manifest = _mapping(manifest, "manifest")
    ownership = _validate_manifest(manifest, normalized_catalog)
    if sorted(payload_files) != sorted(ownership):
        _fail("manifest_ownership_mismatch", "archive payload does not match manifest ownership")
    if payload_size > manifest["max_size"]:
        _fail("archive_payload_too_large", "payload exceeds the manifest size limit")
    return {
        "id": normalized_catalog["id"],
        "version": normalized_catalog["version"],
        "payload_files": sorted(payload_files),
    }

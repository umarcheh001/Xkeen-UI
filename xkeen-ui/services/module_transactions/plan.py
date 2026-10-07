"""Decide whether a module operation is allowed and what exactly it will touch.

Building a plan reads the panel and writes nothing: the panel shows it to the
user before anything starts, and the runner executes the same plan later.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import uuid
from dataclasses import asdict, dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Mapping

from services.module_profile_plan import (
    PRESETS,
    ProfilePlanError,
    build_profile_target,
    build_profile_target_from_ownership,
    user_owned,
)
from services.module_registry import MODULE_IDS

from .state import ModuleTransactionError, transactions_root


OPERATIONS = ("install", "repair", "remove")
SCOPES = ("module", "panel", "profile")
OWNERSHIP_MAP_FILENAME = "module-ownership.json"
# The editor is a dependency of both engines and its variant belongs to the
# installer, so it can only be laid out again, never added or taken away.
_REPAIR_ONLY_MODULES = frozenset({"tool.editor"})

# Compatibility exports for Stage 8.3 callers; the predicate itself is shared
# with the profile planner so these contracts cannot diverge in production.
STATE_FILES = {"modules.json", "module-installed.json", "install-profile.json", "install-managed.json"}
USER_TOP_LEVEL = {"xray-jsonc", "var", "bin"}
USER_FILES = {"secret.key", "devtools.env", "ui-settings.json", "branding.json", "terminal_theme.json", "terminal_theme.css"}
USER_PREFIXES = ("opt/etc/mihomo/profiles/", "opt/etc/mihomo/backup/")

@dataclass(frozen=True, slots=True)
class OwnershipMap:
    """Which files each module of this panel build consists of."""

    modules: Mapping[str, tuple[str, ...]]
    frontend: Mapping[str, Mapping[str, Any]]


@dataclass(frozen=True, slots=True)
class ArchiveSource:
    archive: str
    size: int
    sha256: str


@dataclass(frozen=True, slots=True)
class Plan:
    scope: str
    operation: str
    module_id: str | None
    version: str
    source_version: str
    target_version: str
    target_profile: Mapping[str, Any] | None
    files_add: tuple[str, ...]
    files_remove: tuple[str, ...]
    archive: ArchiveSource | None
    required_free_bytes: int
    restart_required: bool
    installed_after: tuple[str, ...]


def _fail(code: str, message: str, **details: Any) -> None:
    raise ModuleTransactionError(code, message, **details)


def load_ownership_map(panel_root: Path) -> OwnershipMap:
    path = Path(panel_root) / OWNERSHIP_MAP_FILENAME
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict) or data.get("schema_version") != 1:
            raise ValueError("unsupported ownership map")
        modules = data["modules"]
        frontend = data["frontend"]
        if not isinstance(modules, dict) or not isinstance(frontend, dict):
            raise ValueError("invalid ownership map")
        normalized: dict[str, tuple[str, ...]] = {}
        for module_id, paths in modules.items():
            if not isinstance(module_id, str) or not isinstance(paths, list) or not all(isinstance(item, str) for item in paths):
                raise ValueError("invalid ownership map entry")
            normalized[module_id] = tuple(paths)
        bridge = frontend.get("bridge", {})
        build = frontend.get("build", {})
        if not isinstance(bridge, dict) or not isinstance(build, dict):
            raise ValueError("invalid frontend manifests")
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise ModuleTransactionError(
            "module_ownership_unavailable",
            "this panel build does not describe which files its modules own",
        ) from error
    return OwnershipMap(modules=normalized, frontend={"bridge": bridge, "build": build})


def installed_panel_listing(panel_root: Path) -> dict[str, Any]:
    """The installed release described the way a verified panel archive is.

    A profile transition stays on the installed release, whose ownership map
    already lies in the panel: what the target profile consists of is known
    without downloading anything. Sizes are those of the files on the storage;
    a file that is not there counts as zero and has to come from the archive.
    """

    root = Path(panel_root)
    try:
        raw = json.loads((root / OWNERSHIP_MAP_FILENAME).read_text(encoding="utf-8"))
        modules = raw["modules"]
        if not isinstance(modules, dict) or any(
            not isinstance(paths, list) or any(not isinstance(path, str) for path in paths)
            for paths in modules.values()
        ):
            raise ValueError("invalid ownership map")
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise ModuleTransactionError(
            "module_ownership_unavailable",
            "this panel build does not describe which files its modules own",
        ) from error
    return {
        "ownership": raw,
        "payload_sizes": {
            path: _file_size(root / path)
            for paths in modules.values()
            for path in paths
            if _safe_relative(path)
        },
    }


def read_panel_version(panel_root: Path) -> str:
    """The release the panel was built from; only such a build has a catalog."""

    # Imported here, not at the top: the package contract loads the signature
    # library, and undoing an interrupted operation at boot must not need it.
    from services.module_package_contract import ModulePackageContractError, validate_semver

    try:
        build = json.loads((Path(panel_root) / "BUILD.json").read_text(encoding="utf-8"))
        version = build.get("version") if isinstance(build, dict) else None
        if not isinstance(version, str):
            raise ValueError("no version")
        return validate_semver(version.removeprefix("v"), "panel_version")
    except (OSError, ValueError, ModulePackageContractError) as error:
        raise ModuleTransactionError(
            "panel_version_unsupported",
            "modules can be managed only on a panel installed from a release",
        ) from error


def read_installed_modules(state_dir: Path) -> frozenset[str]:
    try:
        data = json.loads((Path(state_dir) / "module-installed.json").read_text(encoding="utf-8"))
        modules = data["modules"]
        if isinstance(modules, dict):
            return frozenset(str(module_id) for module_id, installed in modules.items() if installed is True)
        if isinstance(modules, list):
            return frozenset(str(module_id) for module_id in modules)
        raise ValueError("invalid install manifest")
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise ModuleTransactionError(
            "module_state_unavailable",
            "the list of installed modules cannot be read",
        ) from error


def _safe_relative(path: str) -> bool:
    if not path or "\\" in path or ":" in path:
        return False
    pure = PurePosixPath(path)
    return not pure.is_absolute() and all(part not in {"", ".", ".."} for part in pure.parts) and pure.as_posix() == path


def _module_files(ownership: OwnershipMap, module_id: str) -> tuple[str, ...]:
    foreign = {path for other, paths in ownership.modules.items() if other != module_id for path in paths}
    files = ownership.modules[module_id]
    for path in files:
        if not _safe_relative(path) or user_owned(path) or path in foreign:
            _fail(
                "module_ownership_conflict",
                "the module claims a path it must not manage",
                module_id=module_id,
                path=path,
            )
    return tuple(sorted(set(files)))


_LINK_SUPPORT: dict[tuple[int, int], bool] = {}


def hard_links_supported(panel_root: Path) -> bool:
    """Whether a replaced file can be kept as a hard link, which takes no room.

    The journal keeps what an operation replaces next to the panel. As a
    link that costs nothing; as a real copy it costs the size of everything
    replaced, and the plan has to ask for that room. The answer is found by
    trying, with two empty files that are removed at once.
    """

    panel_root = Path(panel_root)
    beside = transactions_root(panel_root).parent
    try:
        key = (panel_root.stat().st_dev, beside.stat().st_dev)
    except OSError:
        return False
    if key in _LINK_SUPPORT:
        return _LINK_SUPPORT[key]
    name = f".xk-link-probe-{os.getpid()}-{uuid.uuid4().hex[:8]}"
    source, target = panel_root / name, beside / (name + ".kept")
    supported = False
    try:
        source.write_bytes(b"")
        os.link(source, target)
        supported = True
    except OSError:
        supported = False
    finally:
        for path in (target, source):
            try:
                path.unlink()
            except OSError:
                pass
    _LINK_SUPPORT[key] = supported
    return supported


def _backup_cost(panel_root: Path, replaced_bytes: int) -> int:
    """Room the copy of replaced and removed files takes while an operation runs."""

    return 0 if hard_links_supported(panel_root) else replaced_bytes


def _file_size(path: Path) -> int:
    try:
        return path.stat().st_size if path.is_file() else 0
    except OSError:
        return 0


# Sums of files on the storage by path, kept while the file has the same size
# and time: a plan is built up to three times for one update.
_DISK_DIGESTS: dict[str, tuple[int, int, str]] = {}


def _hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _disk_digest(path: Path) -> str | None:
    """SHA-256 of a regular file, ``None`` when there is no such file."""

    try:
        if not path.is_file():
            return None
        info = path.stat()
        key = os.fspath(path)
        cached = _DISK_DIGESTS.get(key)
        if cached is not None and cached[:2] == (info.st_size, info.st_mtime_ns):
            return cached[2]
        digest = _hash_file(path)
        _DISK_DIGESTS[key] = (info.st_size, info.st_mtime_ns, digest)
        return digest
    except OSError:
        return None


def _executable(path: Path) -> bool:
    try:
        return bool(path.stat().st_mode & 0o111)
    except OSError:
        return False


def build_plan(
    operation: str,
    module_id: str,
    *,
    panel_root: Path,
    state_dir: Path,
    catalog: Mapping[str, Any],
    architecture: str,
    active_engines: frozenset[str] = frozenset(),
    free_bytes: int | None = None,
) -> Plan:
    panel_root = Path(panel_root)
    version = read_panel_version(panel_root)
    ownership = load_ownership_map(panel_root)
    if (
        operation not in OPERATIONS
        or module_id == "core"
        or module_id not in ownership.modules
        or (module_id in _REPAIR_ONLY_MODULES and operation != "repair")
    ):
        _fail("module_operation_forbidden", "this operation is not available for the module", operation=operation, module_id=module_id)

    entries = {
        str(item.get("id")): item
        for item in catalog.get("modules", [])
        if isinstance(item, Mapping)
    }
    if catalog.get("release_version") != version:
        _fail(
            "module_version_mismatch",
            "the catalog belongs to another panel release",
            panel_version=version,
            catalog_version=catalog.get("release_version"),
        )
    entry = entries.get(module_id)
    if entry is None:
        _fail("catalog_module_unknown", "module does not exist in the trusted catalog", module_id=module_id)
    if entry.get("version") != version:
        _fail(
            "module_version_mismatch",
            "a module is installed only from the release of the panel itself",
            panel_version=version,
            module_version=entry.get("version"),
        )
    if architecture not in entry.get("architectures", ()):
        _fail("catalog_architecture_unsupported", "the module is not published for this router", architecture=architecture)

    installed = read_installed_modules(Path(state_dir))
    files = _module_files(ownership, module_id)
    if operation == "install":
        if module_id in installed:
            _fail("module_already_installed", "the module is already installed", module_id=module_id)
        missing = sorted(set(entry.get("requires", ())) - installed)
        if missing:
            _fail("module_dependency_missing", "the module needs modules that are not installed", module_ids=missing)
        conflicts = sorted(set(entry.get("conflicts", ())) & installed)
        if conflicts:
            _fail("module_conflict", "the module conflicts with an installed module", module_ids=conflicts)
    elif module_id not in installed:
        _fail("module_not_installed", "the module is not installed", module_id=module_id)

    if operation == "remove":
        dependants = sorted(
            other for other in installed
            if other != module_id and module_id in entries.get(other, {}).get("requires", ())
        )
        if dependants:
            _fail("module_required_by", "installed modules depend on this module", module_ids=dependants)
        if module_id in active_engines:
            _fail("module_engine_active", "the engine is running; stop it before removing its module", module_id=module_id)
        files_add: tuple[str, ...] = ()
        files_remove = tuple(path for path in files if (panel_root / path).is_file())
        archive = None
        installed_after = installed - {module_id}
        incoming = 0
    else:
        files_add = files
        files_remove = ()
        archive = ArchiveSource(archive=str(entry["archive"]), size=int(entry["size"]), sha256=str(entry["sha256"]))
        installed_after = installed | {module_id}
        # The archive itself plus its unpacked payload. The normalized catalog
        # does not carry the payload size; half of a payload is already
        # compressed, so four archive sizes is a generous ceiling.
        incoming = archive.size + 4 * archive.size

    # A copy of every replaced or removed file is a link where the storage
    # can make one, and a real copy otherwise.
    replaced = sum(_file_size(panel_root / path) for path in (*files_add, *files_remove))
    required = (incoming + _backup_cost(panel_root, replaced)) * 6 // 5
    if free_bytes is None:
        probe = transactions_root(panel_root).parent
        free_bytes = shutil.disk_usage(probe if probe.exists() else panel_root).free
    if free_bytes < required:
        _fail("module_free_space", "not enough free space for the operation and its rollback copy", required=required, free=free_bytes)

    return Plan(
        scope="module",
        operation=operation,
        module_id=module_id,
        version=version,
        source_version=version,
        target_version=version,
        target_profile=None,
        files_add=files_add,
        files_remove=files_remove,
        archive=archive,
        required_free_bytes=required,
        restart_required=bool(entry.get("requires_restart", True)),
        installed_after=tuple(sorted(installed_after)),
    )


def plan_to_json(plan: Plan) -> dict[str, Any]:
    data = asdict(plan)
    data["files_add"] = list(plan.files_add)
    data["files_remove"] = list(plan.files_remove)
    data["installed_after"] = list(plan.installed_after)
    return data


def plan_from_json(data: Mapping[str, Any]) -> Plan:
    try:
        scope = str(data.get("scope", "module"))
        if scope not in SCOPES:
            raise ValueError("unknown plan scope")
        archive = data["archive"]
        version = str(data["version"])
        raw_module_id = data.get("module_id")
        module_id = None if raw_module_id is None else str(raw_module_id)
        if scope == "module" and not module_id:
            raise ValueError("module plan has no module_id")
        raw_profile = data.get("target_profile")
        if raw_profile is not None and not isinstance(raw_profile, Mapping):
            raise ValueError("target profile is not an object")
        return Plan(
            scope=scope,
            operation=str(data["operation"]),
            module_id=module_id,
            version=version,
            source_version=str(data.get("source_version", version)),
            target_version=str(data.get("target_version", version)),
            target_profile=None if raw_profile is None else dict(raw_profile),
            files_add=tuple(str(item) for item in data["files_add"]),
            files_remove=tuple(str(item) for item in data["files_remove"]),
            archive=None if archive is None else ArchiveSource(
                archive=str(archive["archive"]), size=int(archive["size"]), sha256=str(archive["sha256"])
            ),
            required_free_bytes=int(data["required_free_bytes"]),
            restart_required=bool(data["restart_required"]),
            installed_after=tuple(str(item) for item in data["installed_after"]),
        )
    except (KeyError, TypeError, ValueError) as error:
        raise ModuleTransactionError("operation_journal_invalid", "the stored operation plan cannot be read") from error


PHYSICAL_REQUEST_KEY = "physical_request"


def _read_requested_profile(state_dir: Path) -> tuple[str, list[str] | None, str] | None:
    """The physical profile the owner asked for; ``None`` when nothing was asked.

    Module switches are not read here: a module that is switched off stays
    installed. Only an explicit profile request changes what lies on the
    storage, and it is recorded apart from the switches.
    """

    try:
        state = json.loads((Path(state_dir) / "modules.json").read_text(encoding="utf-8"))
        if not isinstance(state, Mapping):
            raise ValueError("invalid module state")
        request = state.get(PHYSICAL_REQUEST_KEY)
        if request is None:
            return None
        profile = request["profile"]
        editor_variant = request["editor_variant"]
        modules = request["module_ids"]
        if (
            not isinstance(profile, str)
            or not isinstance(editor_variant, str)
            or not isinstance(modules, list)
            or any(not isinstance(module_id, str) for module_id in modules)
        ):
            raise ValueError("invalid physical profile request")
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise ModuleTransactionError(
            "profile_state_unavailable",
            "the requested physical profile cannot be read",
        ) from error
    selected = [module_id for module_id in MODULE_IDS if module_id in modules]
    return profile, selected if profile == "custom" else None, editor_variant


def _read_managed_paths(state_dir: Path) -> tuple[str, ...]:
    try:
        document = json.loads((Path(state_dir) / "install-managed.json").read_text(encoding="utf-8"))
        paths = document["paths"]
        if not isinstance(paths, list) or any(
            not isinstance(path, str) or not _safe_relative(path) or user_owned(path) for path in paths
        ):
            raise ValueError("invalid managed paths")
        return tuple(sorted(set(paths)))
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise ModuleTransactionError(
            "profile_installed_state_unavailable",
            "the physical install manifest cannot be read",
        ) from error


def _read_installed_profile(state_dir: Path) -> tuple[str, frozenset[str], str]:
    try:
        document = json.loads((Path(state_dir) / "install-profile.json").read_text(encoding="utf-8"))
        profile = document["profile"]
        modules = document["module_ids"]
        editor_variant = document["editor_variant"]
        if (
            not isinstance(profile, str)
            or not isinstance(modules, list)
            or any(not isinstance(module_id, str) for module_id in modules)
            or not isinstance(editor_variant, str)
        ):
            raise ValueError("invalid installed profile")
        return profile, frozenset(modules), editor_variant
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise ModuleTransactionError(
            "profile_installed_state_unavailable",
            "the physical install profile cannot be read",
        ) from error


def _full_scope_plan(
    *,
    scope: str,
    operation: str,
    panel_root: Path,
    state_dir: Path,
    catalog: Mapping[str, Any],
    target_panel_root: Path | None,
    target_archive: Mapping[str, Any] | None,
    architecture: str,
    require_newer: bool,
    free_bytes: int | None,
) -> Plan:
    if (target_panel_root is None) == (target_archive is None):
        raise TypeError("a full-scope plan needs either an unpacked target tree or a verified archive listing")
    # Signature/semver dependencies are not imported while boot recovery only
    # deserializes an existing journal.
    from services.module_package_contract import compare_semver

    source_version = read_panel_version(panel_root)
    target_version = str(catalog.get("release_version") or "")
    comparison = compare_semver(target_version, source_version)
    if require_newer and comparison <= 0:
        _fail(
            "panel_update_not_newer",
            "the stable catalog does not contain a newer panel release",
            current_version=source_version,
            target_version=target_version,
        )
    if not require_newer and comparison != 0:
        _fail(
            "profile_release_mismatch",
            "a profile transition must use the installed panel release",
            current_version=source_version,
            catalog_version=target_version,
        )
    descriptor = catalog.get("panel")
    if not isinstance(descriptor, Mapping) or descriptor.get("version") != target_version:
        _fail("catalog_panel_invalid", "the trusted catalog has no matching panel descriptor")
    if architecture not in descriptor.get("architectures", ()):
        _fail("catalog_architecture_unsupported", "the panel is not published for this router", architecture=architecture)
    installed_profile, installed_profile_modules, installed_editor_variant = _read_installed_profile(state_dir)
    if scope == "profile":
        requested = _read_requested_profile(state_dir)
        if requested is None:
            _fail("profile_transition_not_required", "no other physical profile was requested")
        profile, requested_modules, editor_variant = requested
    else:
        # An update keeps what is installed, switched on or not: a module that
        # is switched off is updated with the rest and stays switched off.
        profile, editor_variant = installed_profile, installed_editor_variant
        if profile in PRESETS and set(PRESETS[profile]) == set(installed_profile_modules):
            requested_modules = None
        else:
            profile = "custom"
            requested_modules = [module_id for module_id in MODULE_IDS if module_id in installed_profile_modules]
    try:
        if target_archive is not None:
            # The verified listing of the archive: nothing has to be unpacked
            # to know what the operation will lay and how much room it needs.
            target_sizes = {str(path): int(size) for path, size in target_archive["payload_sizes"].items()}
            listed_digests = target_archive.get("payload_digests")
            listed_executable = frozenset(target_archive.get("payload_executable") or ())
            target_digest = None if listed_digests is None else listed_digests.get
            target_executable = listed_executable.__contains__
            target = build_profile_target_from_ownership(
                target_archive["ownership"],
                target_sizes,
                profile=profile,
                module_ids=requested_modules,
                editor_variant=editor_variant,
            )
        else:
            target_sizes = None
            target_digest = lambda path: _disk_digest(Path(target_panel_root) / path)  # noqa: E731
            target_executable = lambda path: _executable(Path(target_panel_root) / path)  # noqa: E731
            target = build_profile_target(
                Path(target_panel_root),
                profile=profile,
                module_ids=requested_modules,
                editor_variant=editor_variant,
            )
    except ProfilePlanError as error:
        raise ModuleTransactionError(error.code, "the desired physical profile is invalid", **error.details) from error
    installed_paths = set(_read_managed_paths(state_dir))
    installed_modules = set(read_installed_modules(state_dir))
    target_paths = set(target.payload_files)
    target_modules = set(target.module_ids)
    payload_matches = installed_paths == target_paths and installed_modules == target_modules
    metadata_matches = (
        installed_profile == target.profile
        and installed_profile_modules == target_modules
        and installed_editor_variant == target.editor_variant
    )
    if scope == "profile" and payload_matches and metadata_matches:
        _fail("profile_transition_not_required", "the desired profile is already installed")
    files_remove = tuple(sorted(installed_paths - target_paths))
    archive: ArchiveSource | None = ArchiveSource(
        archive=str(descriptor["archive"]),
        size=int(descriptor["size"]),
        sha256=str(descriptor["sha256"]),
    )
    if scope == "profile":
        # The release stays the same, so a file that is already in place is
        # the file the target wants: only what is missing gets laid. Taking a
        # module away then needs neither the archive nor the network.
        files_add = tuple(
            sorted(
                path
                for path in target_paths
                if path not in installed_paths or not (Path(panel_root) / path).is_file()
            )
        )
        if not files_add:
            archive = None
        backup = sum(_file_size(Path(panel_root) / path) for path in (*files_add, *files_remove))
    else:
        # Most of a release is the previous one. A managed file that already
        # has the content and the executable bit the target wants is left
        # alone: it is neither unpacked nor copied for the undo. A file with
        # the same content that the panel does not manage is laid all the
        # same, so that the managed list ends up equal to the target.
        def in_place(path: str) -> bool:
            if target_digest is None or path not in installed_paths:
                return False
            current = Path(panel_root) / path
            if target_sizes is not None and _file_size(current) != target_sizes.get(path):
                return False
            wanted = target_digest(path)
            if wanted is None or _disk_digest(current) != wanted:
                return False
            return os.name == "nt" or _executable(current) == target_executable(path)

        files_add = tuple(sorted(path for path in target_paths if not in_place(path)))
        backup = sum(_file_size(Path(panel_root) / path) for path in (*files_add, *files_remove))
    if target_sizes is not None:
        expanded = sum(target_sizes.get(path, 0) for path in files_add)
    else:
        expanded = sum(_file_size(Path(target_panel_root) / path) for path in files_add)
    # The archive and one unpacked copy of what is laid: the runner moves the
    # unpacked files into the panel and drops the archive once it is unpacked.
    required = (
        (archive.size if archive is not None else 0) + expanded + _backup_cost(Path(panel_root), backup)
    ) * 6 // 5
    if free_bytes is None:
        probe = transactions_root(Path(panel_root)).parent
        free_bytes = shutil.disk_usage(probe if probe.exists() else panel_root).free
    if free_bytes < required:
        _fail("module_free_space", "not enough free space for the operation and its rollback copy", required=required, free=free_bytes)
    target_profile = {
        "profile": target.profile,
        "module_ids": list(target.module_ids),
        "editor_variant": target.editor_variant,
    }
    return Plan(
        scope=scope,
        operation=operation,
        module_id=None,
        version=target_version,
        source_version=source_version,
        target_version=target_version,
        target_profile=target_profile,
        files_add=files_add,
        files_remove=files_remove,
        archive=archive,
        required_free_bytes=required,
        restart_required=True,
        installed_after=target.module_ids,
    )


def build_panel_update_plan(
    *,
    panel_root: Path,
    state_dir: Path,
    catalog: Mapping[str, Any],
    target_panel_root: Path | None = None,
    target_archive: Mapping[str, Any] | None = None,
    architecture: str,
    free_bytes: int | None = None,
) -> Plan:
    return _full_scope_plan(
        scope="panel",
        operation="panel-update",
        panel_root=panel_root,
        state_dir=state_dir,
        catalog=catalog,
        target_panel_root=target_panel_root,
        target_archive=target_archive,
        architecture=architecture,
        require_newer=True,
        free_bytes=free_bytes,
    )


def build_profile_transition_plan(
    *,
    panel_root: Path,
    state_dir: Path,
    catalog: Mapping[str, Any],
    target_panel_root: Path | None = None,
    target_archive: Mapping[str, Any] | None = None,
    architecture: str,
    free_bytes: int | None = None,
) -> Plan:
    return _full_scope_plan(
        scope="profile",
        operation="profile-transition",
        panel_root=panel_root,
        state_dir=state_dir,
        catalog=catalog,
        target_panel_root=target_panel_root,
        target_archive=target_archive,
        architecture=architecture,
        require_newer=False,
        free_bytes=free_bytes,
    )

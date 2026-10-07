"""Decide whether a module operation is allowed and what exactly it will touch.

Building a plan reads the panel and writes nothing: the panel shows it to the
user before anything starts, and the runner executes the same plan later.
"""

from __future__ import annotations

import json
import shutil
from dataclasses import asdict, dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Mapping

from services.module_profile_plan import user_owned

from .state import ModuleTransactionError, transactions_root


OPERATIONS = ("install", "repair", "remove")
OWNERSHIP_MAP_FILENAME = "module-ownership.json"
# The editor is a dependency of both engines and its variant belongs to the
# installer, so it can only be laid out again, never added or taken away.
_REPAIR_ONLY_MODULES = frozenset({"tool.editor"})

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
    operation: str
    module_id: str
    version: str
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


def _file_size(path: Path) -> int:
    try:
        return path.stat().st_size if path.is_file() else 0
    except OSError:
        return 0


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

    # A copy of every replaced or removed file may be a real copy, not a link.
    replaced = sum(_file_size(panel_root / path) for path in (*files_add, *files_remove))
    required = (incoming + replaced) * 6 // 5
    if free_bytes is None:
        probe = transactions_root(panel_root).parent
        free_bytes = shutil.disk_usage(probe if probe.exists() else panel_root).free
    if free_bytes < required:
        _fail("module_free_space", "not enough free space for the operation and its rollback copy", required=required, free=free_bytes)

    return Plan(
        operation=operation,
        module_id=module_id,
        version=version,
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
        archive = data["archive"]
        return Plan(
            operation=str(data["operation"]),
            module_id=str(data["module_id"]),
            version=str(data["version"]),
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

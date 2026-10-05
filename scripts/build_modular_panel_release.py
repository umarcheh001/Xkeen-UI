#!/usr/bin/env python3
"""Build deterministic Stage 8 modular-panel release assets.

The builder is intentionally offline: it turns a checked-out Xkeen UI tree into
release assets that the Stage 8.0 static contract can preflight before a future
updater is introduced.
"""

from __future__ import annotations

import argparse
import ast
import gzip
import hashlib
import importlib.util
import io
import json
import os
import re
import sys
import tarfile
from dataclasses import dataclass
from pathlib import Path
from pathlib import PurePosixPath
from typing import Any, Mapping, Sequence


# The payload is Python, templates and static files: it does not depend on the
# CPU. The catalog still has to name every router architecture the panel is
# installed on, or the catalog client refuses the whole catalog there.
SUPPORTED_ARCHITECTURES = ("aarch64", "mips", "mipsel")
DEFAULT_ARCHITECTURES = SUPPORTED_ARCHITECTURES
DEFAULT_MIN_CORE = "1.0.0"
PACKAGE_DIRNAME = "xkeen-ui"
_IGNORED_DIR_NAMES = {"__pycache__"}
_IGNORED_FILE_NAMES = {".DS_Store", "BUILD.json"}
_IGNORED_FILE_SUFFIXES = {".pyc", ".pyo", ".tmp"}
_LOCAL_DECRYPTOR_PREFIXES = ("happ",)
_LOCAL_DECRYPTOR_KEEP = {"README.happ-decryptor.txt"}
_MODULE_EXCLUDED_FILES = {"install.sh", "uninstall.sh"}
_KNOWN_PACKAGE_ROOTS = {
    "bin",
    "core",
    "middleware",
    "opt",
    "routes",
    "scripts",
    "services",
    "static",
    "templates",
    "tools",
    "utils",
}
_KNOWN_PACKAGE_FILES = {
    "app.py",
    "app_factory.py",
    "bootstrap_mihomo_env.py",
    "install.sh",
    "mihomo_config_generator.py",
    "mihomo_server_core.py",
    "module-sizes.json",
    "run_server.py",
    "uninstall.sh",
    "xkeen_mihomo_service.py",
}
# Files whose name does not tell which module they serve. Without these the
# import closure below drags what they import into the core package. Every
# importer of a file listed here already belongs to the same module.
_PACKAGE_OWNER_OVERRIDES = {
    "mihomo_config_generator.py": "engine.mihomo",
    # A facade over the Mihomo services; the core takes the config path and
    # the save helpers straight from services/mihomo_runtime.py.
    "mihomo_server_core.py": "engine.mihomo",
    "services/mihomo_runtime.py": "core",
    "xkeen_mihomo_service.py": "engine.mihomo",
    "services/mihomo_backups.py": "engine.mihomo",
    "services/subscription_pause.py": "engine.xray",
    # Import of Xray configs from GitHub and from a local file, the shell of
    # the Xray config tabs and the window with the contents of a .dat file.
    "static/js/features/compat/github.js": "engine.xray",
    "static/js/features/compat/local_io.js": "engine.xray",
    "static/js/features/github.js": "engine.xray",
    "static/js/features/local_io.js": "engine.xray",
    "static/js/pages/config_shell.shared.js": "engine.xray",
    "static/js/ui/dat_contents_modal.js": "engine.xray",
    # Schema helpers that only the editors import.
    "static/js/ui/schema_diagnostic_format.js": "tool.editor",
    "static/js/ui/yaml_schema.js": "tool.editor",
    # Shared by every page in spite of the name.
    "static/js/features/devtools_namespace.js": "core",
    "static/js/features/xray_log_line_class.js": "core",
    "static/js/pages/panel.mihomo_header.js": "core",
    "static/js/pages/top_level_panel_mihomo.shared.js": "core",
}
# Mirrors services.module_package_contract, which the offline builder cannot
# import before it has located the package root.
_SEMVER_RE = re.compile(
    r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)"
    r"(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$"
)
_STAGE7_PATH = Path(__file__).resolve().parents[1] / PACKAGE_DIRNAME / "scripts" / "module_profile_install.py"
_STAGE7_MODULE: Any | None = None
_REGISTRY_MODULES: dict[Path, Any] = {}
_OWNERSHIP_CACHE: dict[tuple[Any, ...], dict[str, tuple[str, ...]]] = {}


class ReleaseBuildError(ValueError):
    """A local release assembly input is unsafe or cannot be packaged."""


def normalize_architectures(architectures: Sequence[str]) -> list[str]:
    """Return the sorted catalog architecture ids or refuse an unknown one."""

    if isinstance(architectures, str):
        architectures = (architectures,)
    normalized = sorted({str(item).strip() for item in architectures})
    if not normalized:
        raise ReleaseBuildError("at least one catalog architecture is required")
    unknown = [item for item in normalized if item not in SUPPORTED_ARCHITECTURES]
    if unknown:
        raise ReleaseBuildError(
            f"unknown catalog architecture {unknown!r}: supported are {list(SUPPORTED_ARCHITECTURES)!r}"
        )
    return normalized


def _safe_member_path(value: str) -> str:
    if "\\" in str(value):
        raise ReleaseBuildError(f"unsafe archive member path: {value!r}")
    normalized = str(value).replace("\\", "/")
    parsed = PurePosixPath(normalized)
    if (
        not normalized
        or parsed.is_absolute()
        or any(part in {"", ".", ".."} for part in parsed.parts)
        or ":" in normalized
    ):
        raise ReleaseBuildError(f"unsafe archive member path: {value!r}")
    return str(parsed)


def _source_bytes(source: Path | bytes) -> tuple[bytes, int]:
    if isinstance(source, bytes):
        return source, 0o644
    path = Path(source)
    if path.is_symlink():
        raise ReleaseBuildError(f"symlink source is forbidden: {path}")
    if not path.is_file():
        raise ReleaseBuildError(f"archive source is not a regular file: {path}")
    try:
        data = path.read_bytes()
        mode = path.stat().st_mode
    except OSError as error:
        raise ReleaseBuildError(f"cannot read archive source: {path}") from error
    if path.suffix.lower() in {".py", ".sh"} or data.startswith(b"#!"):
        data = data.replace(b"\r\n", b"\n").replace(b"\r", b"\n")
    executable = bool(mode & 0o111) or path.suffix.lower() in {".sh"}
    return data, 0o755 if executable else 0o644


def build_deterministic_tar(
    output_path: Path,
    files: Mapping[str, Path | bytes],
    *,
    epoch: int,
) -> str:
    """Write a reproducible gzip-compressed USTAR archive and return its SHA-256."""

    if int(epoch) < 0:
        raise ReleaseBuildError("source date epoch must be non-negative")
    members: dict[str, tuple[bytes, int]] = {}
    directories: set[str] = set()
    for raw_name, source in files.items():
        name = _safe_member_path(raw_name)
        if name in members:
            raise ReleaseBuildError(f"duplicate archive member path: {name}")
        data, mode = _source_bytes(source)
        members[name] = (data, mode)
        parts = name.split("/")[:-1]
        for index in range(1, len(parts) + 1):
            directories.add("/".join(parts[:index]))

    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with output_path.open("wb") as raw:
            with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=int(epoch), compresslevel=9) as packed:
                with tarfile.open(fileobj=packed, mode="w", format=tarfile.USTAR_FORMAT) as archive:
                    for directory in sorted(directories):
                        info = tarfile.TarInfo(directory)
                        info.type = tarfile.DIRTYPE
                        info.mode = 0o755
                        info.mtime = int(epoch)
                        info.uid = 0
                        info.gid = 0
                        info.uname = ""
                        info.gname = ""
                        archive.addfile(info)
                    for name in sorted(members):
                        data, mode = members[name]
                        info = tarfile.TarInfo(name)
                        info.size = len(data)
                        info.mode = mode
                        info.mtime = int(epoch)
                        info.uid = 0
                        info.gid = 0
                        info.uname = ""
                        info.gname = ""
                        archive.addfile(info, io.BytesIO(data))
    except OSError as error:
        raise ReleaseBuildError(f"cannot write release archive: {output_path}") from error
    return hashlib.sha256(output_path.read_bytes()).hexdigest()


def read_archive_members(path: Path) -> list[tarfile.TarInfo]:
    """Read archive headers for tests and static release inspection."""

    try:
        with tarfile.open(path, "r:gz") as archive:
            return archive.getmembers()
    except (OSError, tarfile.TarError) as error:
        raise ReleaseBuildError(f"cannot inspect release archive: {path}") from error


def _stage7_module(root: Path | None = None) -> Any:
    global _STAGE7_MODULE
    stage7_path = (
        Path(root).resolve() / PACKAGE_DIRNAME / "scripts" / "module_profile_install.py"
        if root is not None
        else _STAGE7_PATH
    )
    if _STAGE7_MODULE is not None and stage7_path == _STAGE7_PATH:
        return _STAGE7_MODULE
    if not stage7_path.is_file():
        stage7_path = _STAGE7_PATH
    if not stage7_path.is_file():
        raise ReleaseBuildError(f"Stage 7 classifier is missing: {stage7_path}")
    module_name = "xkeen_stage7_module_profile_install" + ("_root" if stage7_path != _STAGE7_PATH else "")
    spec = importlib.util.spec_from_file_location(module_name, stage7_path)
    if spec is None or spec.loader is None:
        raise ReleaseBuildError("cannot load Stage 7 ownership classifier")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    if stage7_path == _STAGE7_PATH:
        _STAGE7_MODULE = module
    return module


def _is_ignored_package_path(relative: str) -> bool:
    path = PurePosixPath(relative)
    if any(part in _IGNORED_DIR_NAMES for part in path.parts):
        return True
    name = path.name
    if name in _IGNORED_FILE_NAMES or path.suffix.lower() in _IGNORED_FILE_SUFFIXES:
        return True
    if len(path.parts) >= 2 and path.parts[0] == "bin" and path.parts[1].lower().startswith(_LOCAL_DECRYPTOR_PREFIXES):
        return path.parts[1] not in _LOCAL_DECRYPTOR_KEEP
    return False


def build_module_ownership(root: Path) -> dict[str, tuple[str, ...]]:
    """Project managed package files into the official Stage 7 module owners."""

    package = Path(root).resolve() / PACKAGE_DIRNAME
    if not package.is_dir():
        raise ReleaseBuildError(f"package root is missing: {package}")
    stage7 = _stage7_module(root)
    module_ids = tuple(stage7.MODULE_IDS)
    ownership: dict[str, list[str]] = {module_id: [] for module_id in module_ids}
    sources = sorted(package.rglob("*"))
    # One release build asks for the ownership of every module in turn, and the
    # import graph is not cheap to read: remember it while the tree is the same.
    fingerprint: tuple[Any, ...] = (str(package),) + tuple(
        (source.as_posix(), source.lstat().st_size, source.lstat().st_mtime_ns)
        for source in sources
        if source.is_file() or source.is_symlink()
    )
    if fingerprint in _OWNERSHIP_CACHE:
        return dict(_OWNERSHIP_CACHE[fingerprint])
    for source in sources:
        if not source.is_file() and not source.is_symlink():
            continue
        relative = source.relative_to(package).as_posix()
        if _is_ignored_package_path(relative):
            continue
        if relative in _MODULE_EXCLUDED_FILES:
            continue
        if source.is_symlink():
            raise ReleaseBuildError(f"symlink source is forbidden: {source}")
        if bool(stage7._user_owned(relative)):
            continue
        top_level = PurePosixPath(relative).parts[0]
        if top_level not in _KNOWN_PACKAGE_ROOTS and relative not in _KNOWN_PACKAGE_FILES:
            raise ReleaseBuildError(f"unclassified package path: {relative}")
        if relative in _PACKAGE_OWNER_OVERRIDES:
            module_id = _PACKAGE_OWNER_OVERRIDES[relative]
        elif relative in _KNOWN_PACKAGE_FILES:
            module_id = "core"
        else:
            marker_owner = {
                marker: module_id
                for module_id, markers in stage7.INSTALL_MARKERS.items()
                for marker in markers
            }.get(relative)
            module_id = str(marker_owner or stage7.owner(relative))
            if module_id == "editor-full":
                module_id = "tool.editor"
        if module_id not in ownership:
            raise ReleaseBuildError(f"unclassified module owner {module_id!r}: {relative}")
        ownership[module_id].append(relative)
    owner_of = {relative: module_id for module_id, paths in ownership.items() for relative in paths}
    _close_ownership_over_imports(package, owner_of, stage7, _dependency_closures(root, module_ids))
    closed: dict[str, list[str]] = {module_id: [] for module_id in module_ids}
    for relative, module_id in owner_of.items():
        closed[module_id].append(relative)
    result = {module_id: tuple(sorted(paths)) for module_id, paths in closed.items()}
    _OWNERSHIP_CACHE.clear()
    _OWNERSHIP_CACHE[fingerprint] = result
    return dict(result)


def _dependency_closures(root: Path, module_ids: Sequence[str]) -> dict[str, frozenset[str]]:
    """Each module with everything the registry says it depends on."""

    direct = {
        definition.id: tuple(definition.dependencies)
        for definition in (_registry_definition(root, module_id) for module_id in module_ids)
    }
    closures: dict[str, frozenset[str]] = {}
    for module_id in module_ids:
        seen = {module_id}
        queue = [module_id]
        while queue:
            for dependency in direct.get(queue.pop(), ()):
                if dependency in direct and dependency not in seen:
                    seen.add(dependency)
                    queue.append(dependency)
        closures[module_id] = frozenset(seen)
    return closures


def _javascript_import_edges(package: Path, owner_of: Mapping[str, str], stage7: Any) -> dict[str, tuple[str, ...]]:
    """Static imports of the scripts a browser actually loads.

    The walk starts where a page does: the page entries and the scripts named
    by the templates. A dynamic ``import()`` only extends the walk, it is how
    an optional module is loaded and is not a dependency by itself.
    """

    static: dict[str, set[str]] = {}
    dynamic: dict[str, set[str]] = {}

    def scan(relative: str) -> None:
        try:
            text = (package / relative).read_text(encoding="utf-8")
        except (OSError, UnicodeError) as error:
            raise ReleaseBuildError(f"invalid script payload {relative}: {error}") from error
        static[relative] = set()
        dynamic[relative] = set()
        for specifier in stage7._JS_FROM_IMPORT.findall(text) + stage7._JS_BARE_IMPORT.findall(text):
            dependency = stage7._js_dependency(relative, specifier)
            if dependency in owner_of:
                static[relative].add(dependency)
        for specifier in stage7._JS_DYNAMIC_IMPORT.findall(text):
            dependency = stage7._js_dependency(relative, specifier)
            if dependency in owner_of:
                dynamic[relative].add(dependency)

    queue = sorted(
        relative for relative in owner_of
        if relative.startswith("static/js/pages/") and relative.endswith(".entry.js")
    )
    for relative in sorted(owner_of):
        if not (relative.startswith("templates/") and relative.endswith(".html")):
            continue
        try:
            markup = (package / relative).read_text(encoding="utf-8")
        except (OSError, UnicodeError) as error:
            raise ReleaseBuildError(f"invalid template payload {relative}: {error}") from error
        for filename in stage7._TEMPLATE_STATIC_SCRIPT.findall(markup):
            if "static/" + filename in owner_of:
                queue.append("static/" + filename)
    while queue:
        relative = queue.pop()
        if relative in static:
            continue
        scan(relative)
        queue.extend(sorted(static[relative] | dynamic[relative]))
    return {relative: tuple(sorted(targets)) for relative, targets in static.items() if targets}


def _python_import_edges(package: Path, owner_of: Mapping[str, str]) -> dict[str, tuple[str, ...]]:
    """Imports a Python file performs unconditionally when it is loaded.

    An import under ``if`` or ``try``, or inside a function, is how the panel
    reaches an optional module, so only plain module-level statements count.
    """

    edges: dict[str, tuple[str, ...]] = {}
    for relative in sorted(owner_of):
        if not relative.endswith(".py"):
            continue
        try:
            tree = ast.parse((package / relative).read_text(encoding="utf-8"), filename=relative)
        except (OSError, UnicodeError, SyntaxError):
            # A placeholder file of a test tree: it imports nothing.
            continue
        current = relative.removesuffix("/__init__.py").removesuffix(".py").replace("/", ".")
        if not relative.endswith("/__init__.py"):
            current = current.rpartition(".")[0]
        names: set[str] = set()
        for node in tree.body:
            if isinstance(node, ast.Import):
                names.update(alias.name for alias in node.names)
            elif isinstance(node, ast.ImportFrom):
                base = node.module or ""
                if node.level:
                    parts = current.split(".") if current else []
                    base = ".".join(parts[: len(parts) - node.level + 1] + ([base] if base else []))
                names.add(base)
                names.update(base + "." + alias.name for alias in node.names if alias.name != "*")
        targets = {
            candidate
            for name in names
            for candidate in (name.replace(".", "/") + ".py", name.replace(".", "/") + "/__init__.py")
            if candidate in owner_of and candidate != relative
        }
        if targets:
            edges[relative] = tuple(sorted(targets))
    return edges


def _close_ownership_over_imports(
    package: Path,
    owner_of: dict[str, str],
    stage7: Any,
    closures: Mapping[str, frozenset[str]],
) -> None:
    """Move a file to a package that every unconditional importer can rely on.

    Ownership is first decided by file name. A script or a Python file of one
    package may still import a file that the name rules gave to a package the
    importer does not depend on, and then the importer does not load at all
    when that package is absent. Such a file moves to the deepest package both
    sides depend on; in the worst case that is ``core``.
    """

    edges = {**_python_import_edges(package, owner_of), **_javascript_import_edges(package, owner_of, stage7)}
    for _ in range(len(owner_of) + 1):
        changed = False
        for source in sorted(edges):
            for target in edges[source]:
                importer, owner = owner_of[source], owner_of[target]
                if owner in closures[importer]:
                    continue
                shared = closures[importer] & closures[owner]
                if not shared:
                    raise ReleaseBuildError(f"no common package for {source} -> {target}")
                owner_of[target] = max(shared, key=lambda module_id: (len(closures[module_id]), module_id))
                changed = True
        if not changed:
            return
    raise ReleaseBuildError("module ownership does not settle over the import graph")


def _registry_definition(root: Path, module_id: str) -> Any:
    candidates = [
        Path(root).resolve() / PACKAGE_DIRNAME / "services" / "module_registry.py",
        _STAGE7_PATH.parents[1] / "services" / "module_registry.py",
    ]
    last_error: Exception | None = None
    for registry_path in dict.fromkeys(candidates):
        if not registry_path.is_file():
            continue
        try:
            if registry_path in _REGISTRY_MODULES:
                return next(item for item in _REGISTRY_MODULES[registry_path].MODULE_DEFINITIONS if item.id == module_id)
            package_import_root = str(registry_path.parents[1])
            if package_import_root not in sys.path:
                sys.path.insert(0, package_import_root)
            spec = importlib.util.spec_from_file_location(
                "xkeen_release_module_registry_" + str(len(sys.modules)), registry_path
            )
            if spec is None or spec.loader is None:
                raise ReleaseBuildError("cannot load module registry")
            module = importlib.util.module_from_spec(spec)
            sys.modules[spec.name] = module
            spec.loader.exec_module(module)
            _REGISTRY_MODULES[registry_path] = module
            return next(item for item in module.MODULE_DEFINITIONS if item.id == module_id)
        except Exception as error:
            last_error = error
    raise ReleaseBuildError(f"unknown registry module: {module_id}") from last_error


def build_module_manifest(
    root: Path,
    module_id: str,
    *,
    version: str,
    architectures: Sequence[str] = DEFAULT_ARCHITECTURES,
    min_core: str = DEFAULT_MIN_CORE,
) -> dict[str, Any]:
    """Build the Stage 8.0 manifest for one registry module."""

    definition = _registry_definition(root, module_id)
    ownership = build_module_ownership(root).get(module_id, ())
    if not ownership:
        raise ReleaseBuildError(f"module has no managed payload files: {module_id}")
    package = Path(root).resolve() / PACKAGE_DIRNAME
    max_size = sum((package / relative).stat().st_size for relative in ownership)
    return {
        "schema_version": 1,
        "id": definition.id,
        "version": str(version),
        "channel": "stable",
        "panel_api": "1",
        "module_api": "1",
        "min_core": str(min_core),
        "architectures": normalize_architectures(architectures),
        "requires": list(definition.dependencies),
        "conflicts": list(definition.conflicts),
        "requires_restart": bool(definition.requires_restart),
        "ownership": list(ownership),
        "max_size": max(1, max_size),
    }


def module_archive_spec(
    root: Path,
    module_id: str,
    *,
    version: str,
    architectures: Sequence[str] = DEFAULT_ARCHITECTURES,
    min_core: str = DEFAULT_MIN_CORE,
) -> ArchiveSpec:
    manifest = build_module_manifest(
        root,
        module_id,
        version=version,
        architectures=architectures,
        min_core=min_core,
    )
    package = Path(root).resolve() / PACKAGE_DIRNAME
    manifest_data = (json.dumps(manifest, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
    members: list[tuple[str, Path | bytes]] = [("module-manifest.json", manifest_data)]
    members.extend((f"payload/{relative}", package / relative) for relative in manifest["ownership"])
    return ArchiveSpec(
        filename=f"xkeen-module-{module_id}-{version}.tar.gz",
        members=tuple(members),
    )


def _built_asset(path: Path) -> BuiltAsset:
    path = Path(path)
    return BuiltAsset(
        path=path,
        sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
        size=path.stat().st_size,
    )


def _write_checksum(asset: BuiltAsset) -> Path:
    sidecar = asset.path.with_name(asset.path.name + ".sha256")
    sidecar.write_text(f"{asset.sha256}  {asset.path.name}\n", encoding="utf-8", newline="\n")
    return sidecar


def _panel_members(root: Path) -> dict[str, Path]:
    package = Path(root).resolve() / PACKAGE_DIRNAME
    if not package.is_dir():
        raise ReleaseBuildError(f"package root is missing: {package}")
    stage7 = _stage7_module(root)
    members: dict[str, Path] = {}
    for source in sorted(package.rglob("*")):
        if not source.is_file() and not source.is_symlink():
            continue
        relative = source.relative_to(package).as_posix()
        if _is_ignored_package_path(relative):
            continue
        if source.is_symlink():
            raise ReleaseBuildError(f"symlink source is forbidden: {source}")
        if relative != "install.sh" and bool(stage7._user_owned(relative)):
            continue
        members[f"{PACKAGE_DIRNAME}/{relative}"] = source
    return members


def build_panel_archive(root: Path, output_dir: Path, *, version: str, epoch: int) -> BuiltAsset:
    """Build the legacy-compatible panel payload without mutable runtime state."""

    path = Path(output_dir) / f"xkeen-ui-panel-{version}.tar.gz"
    build_deterministic_tar(path, _panel_members(root), epoch=epoch)
    return _built_asset(path)


def build_module_archive(
    root: Path,
    output_dir: Path,
    module_id: str,
    *,
    version: str,
    architectures: Sequence[str],
    min_core: str,
    epoch: int,
) -> BuiltAsset:
    """Build one self-describing Stage 8 module tarball."""

    spec = module_archive_spec(
        root,
        module_id,
        version=version,
        architectures=architectures,
        min_core=min_core,
    )
    path = Path(output_dir) / spec.filename
    build_deterministic_tar(path, dict(spec.members), epoch=epoch)
    return _built_asset(path)


def _catalog_entry(manifest: Mapping[str, Any], asset: BuiltAsset) -> dict[str, Any]:
    return {
        **manifest,
        "archive": asset.path.name,
        "size": asset.size,
        "sha256": asset.sha256,
        "signing_key_id": "release-2026",
    }


def _write_json(path: Path, payload: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n",
        encoding="utf-8",
        newline="\n",
    )


@dataclass(frozen=True, slots=True)
class ReleaseInputs:
    """Immutable inputs shared by local and CI release builds."""

    root: Path
    output_dir: Path
    version: str
    source_date_epoch: int
    source_commit: str
    architectures: Sequence[str] = DEFAULT_ARCHITECTURES
    min_core: str = DEFAULT_MIN_CORE


@dataclass(frozen=True, slots=True)
class ArchiveSpec:
    """One deterministic tarball and the source members it must contain."""

    filename: str
    members: tuple[tuple[str, Path | bytes], ...]


@dataclass(frozen=True, slots=True)
class BuiltAsset:
    """A generated asset with the digest and compressed size published to users."""

    path: Path
    sha256: str
    size: int


@dataclass(frozen=True, slots=True)
class ReleaseBundle:
    """All release files emitted from one immutable set of source inputs."""

    inputs: ReleaseInputs
    panel: BuiltAsset
    modules: tuple[BuiltAsset, ...]
    catalog_path: Path
    metadata_path: Path


def build_release(
    inputs: ReleaseInputs | Path,
    output_dir: Path | None = None,
    *,
    version: str | None = None,
    source_date_epoch: int | None = None,
    source_commit: str | None = None,
    architectures: Sequence[str] = DEFAULT_ARCHITECTURES,
    min_core: str = DEFAULT_MIN_CORE,
) -> ReleaseBundle:
    """Build panel/module archives, checksums, catalog and metadata."""

    if isinstance(inputs, ReleaseInputs):
        if output_dir is not None or version is not None or source_date_epoch is not None or source_commit is not None:
            raise TypeError("ReleaseInputs cannot be combined with individual release arguments")
    else:
        if output_dir is None or version is None or source_date_epoch is None or source_commit is None:
            raise TypeError("root, output_dir, version, source_date_epoch and source_commit are required")
        inputs = ReleaseInputs(
            root=Path(inputs),
            output_dir=Path(output_dir),
            version=version,
            source_date_epoch=int(source_date_epoch),
            source_commit=source_commit,
            architectures=architectures,
            min_core=min_core,
        )

    root = Path(inputs.root).resolve()
    output_dir = Path(inputs.output_dir).resolve()
    if not root.is_dir():
        raise ReleaseBuildError(f"release root is missing: {root}")
    if not str(inputs.version).strip():
        raise ReleaseBuildError("release version is required")
    if not _SEMVER_RE.fullmatch(str(inputs.version)):
        # The catalog client compares versions as semver. A tag such as
        # v2.9.2a used to pass here and fail the preflight a step later.
        raise ReleaseBuildError(
            f"release version must be MAJOR.MINOR.PATCH, got {inputs.version!r}: "
            "tag releases as vX.Y.Z, without a letter suffix"
        )
    if not str(inputs.source_commit).strip():
        raise ReleaseBuildError("source commit is required")
    if int(inputs.source_date_epoch) < 0:
        raise ReleaseBuildError("source date epoch must be non-negative")
    output_dir.mkdir(parents=True, exist_ok=True)

    panel = build_panel_archive(root, output_dir, version=inputs.version, epoch=inputs.source_date_epoch)
    ownership = build_module_ownership(root)
    modules: list[BuiltAsset] = []
    catalog_entries: list[dict[str, Any]] = []
    for module_id in sorted(module_id for module_id, paths in ownership.items() if paths):
        asset = build_module_archive(
            root,
            output_dir,
            module_id,
            version=inputs.version,
            architectures=inputs.architectures,
            min_core=inputs.min_core,
            epoch=inputs.source_date_epoch,
        )
        manifest = build_module_manifest(
            root,
            module_id,
            version=inputs.version,
            architectures=inputs.architectures,
            min_core=inputs.min_core,
        )
        modules.append(asset)
        catalog_entries.append(_catalog_entry(manifest, asset))

    catalog_path = output_dir / "catalog.json"
    _write_json(
        catalog_path,
        {
            "schema_version": 1,
            "release_version": inputs.version,
            "channel": "stable",
            "source_commit": inputs.source_commit,
            "modules": catalog_entries,
        },
    )
    catalog_asset = _built_asset(catalog_path)
    sidecars = [_write_checksum(asset) for asset in (panel, *modules, catalog_asset)]
    metadata_path = output_dir / "release-metadata.json"
    metadata_assets = sorted(
        [panel.path.name, *(asset.path.name for asset in modules), catalog_path.name, *(path.name for path in sidecars), metadata_path.name]
    )
    _write_json(
        metadata_path,
        {
            "schema_version": 1,
            "release_version": inputs.version,
            "source_commit": inputs.source_commit,
            "source_date_epoch": int(inputs.source_date_epoch),
            "assets": metadata_assets,
        },
    )
    return ReleaseBundle(
        inputs=inputs,
        panel=panel,
        modules=tuple(modules),
        catalog_path=catalog_path,
        metadata_path=metadata_path,
    )


def write_release_bundle(inputs: ReleaseInputs | ReleaseBundle) -> ReleaseBundle:
    """Build and return a release bundle for callers that prefer an action name."""

    if isinstance(inputs, ReleaseBundle):
        return inputs
    return build_release(inputs)


def parse_args(argv: list[str] | None = None) -> ReleaseInputs:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--source-date-epoch", type=int, required=True)
    parser.add_argument("--source-commit", required=True)
    parser.add_argument(
        "--architecture",
        action="append",
        dest="architectures",
        choices=SUPPORTED_ARCHITECTURES,
        help="catalog architecture id; repeat for several, default: all supported",
    )
    parser.add_argument("--min-core", default=DEFAULT_MIN_CORE)
    args = parser.parse_args(argv)
    return ReleaseInputs(
        root=args.root.resolve(),
        output_dir=args.output_dir.resolve(),
        version=args.version,
        source_date_epoch=args.source_date_epoch,
        source_commit=args.source_commit,
        architectures=tuple(args.architectures or DEFAULT_ARCHITECTURES),
        min_core=args.min_core,
    )


def main(argv: list[str] | None = None) -> int:
    bundle = write_release_bundle(parse_args(argv))
    print(bundle.metadata_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

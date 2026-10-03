#!/usr/bin/env python3
"""Build deterministic Stage 8 modular-panel release assets.

The builder is intentionally offline: it turns a checked-out Xkeen UI tree into
release assets that the Stage 8.0 static contract can preflight before a future
updater is introduced.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import importlib.util
import io
import os
import sys
import tarfile
from dataclasses import dataclass
from pathlib import Path
from pathlib import PurePosixPath
from typing import Any, Mapping


DEFAULT_ARCHITECTURE = "aarch64"
DEFAULT_MIN_CORE = "1.0.0"
PACKAGE_DIRNAME = "xkeen-ui"
_IGNORED_DIR_NAMES = {"__pycache__"}
_IGNORED_FILE_NAMES = {".DS_Store", "BUILD.json"}
_IGNORED_FILE_SUFFIXES = {".pyc", ".pyo", ".tmp"}
_LOCAL_DECRYPTOR_PREFIXES = ("happ",)
_LOCAL_DECRYPTOR_KEEP = {"README.happ-decryptor.txt"}
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
_STAGE7_PATH = Path(__file__).resolve().parents[1] / PACKAGE_DIRNAME / "scripts" / "module_profile_install.py"
_STAGE7_MODULE: Any | None = None


class ReleaseBuildError(ValueError):
    """A local release assembly input is unsafe or cannot be packaged."""


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


def _stage7_module() -> Any:
    global _STAGE7_MODULE
    if _STAGE7_MODULE is not None:
        return _STAGE7_MODULE
    if not _STAGE7_PATH.is_file():
        raise ReleaseBuildError(f"Stage 7 classifier is missing: {_STAGE7_PATH}")
    spec = importlib.util.spec_from_file_location("xkeen_stage7_module_profile_install", _STAGE7_PATH)
    if spec is None or spec.loader is None:
        raise ReleaseBuildError("cannot load Stage 7 ownership classifier")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    _STAGE7_MODULE = module
    return module


def _is_ignored_package_path(relative: str) -> bool:
    path = PurePosixPath(relative)
    if any(part in _IGNORED_DIR_NAMES for part in path.parts):
        return True
    name = path.name
    if name in _IGNORED_FILE_NAMES or path.suffix.lower() in _IGNORED_FILE_SUFFIXES:
        return True
    if path.parts and path.parts[0] == "bin" and name.lower().startswith(_LOCAL_DECRYPTOR_PREFIXES):
        return name not in _LOCAL_DECRYPTOR_KEEP
    return False


def build_module_ownership(root: Path) -> dict[str, tuple[str, ...]]:
    """Project managed package files into the official Stage 7 module owners."""

    package = Path(root).resolve() / PACKAGE_DIRNAME
    if not package.is_dir():
        raise ReleaseBuildError(f"package root is missing: {package}")
    stage7 = _stage7_module()
    module_ids = tuple(stage7.MODULE_IDS)
    ownership: dict[str, list[str]] = {module_id: [] for module_id in module_ids}
    for source in sorted(package.rglob("*")):
        if not source.is_file() and not source.is_symlink():
            continue
        relative = source.relative_to(package).as_posix()
        if _is_ignored_package_path(relative):
            continue
        if source.is_symlink():
            raise ReleaseBuildError(f"symlink source is forbidden: {source}")
        if bool(stage7._user_owned(relative)):
            continue
        top_level = PurePosixPath(relative).parts[0]
        if top_level not in _KNOWN_PACKAGE_ROOTS and relative not in _KNOWN_PACKAGE_FILES:
            raise ReleaseBuildError(f"unclassified package path: {relative}")
        if relative in _KNOWN_PACKAGE_FILES:
            module_id = "core"
        else:
            module_id = str(stage7.owner(relative))
            if module_id == "editor-full":
                module_id = "tool.editor"
        if module_id not in ownership:
            raise ReleaseBuildError(f"unclassified module owner {module_id!r}: {relative}")
        ownership[module_id].append(relative)
    return {module_id: tuple(sorted(paths)) for module_id, paths in ownership.items()}


@dataclass(frozen=True, slots=True)
class ReleaseInputs:
    """Immutable inputs shared by local and CI release builds."""

    root: Path
    output_dir: Path
    version: str
    source_date_epoch: int
    source_commit: str
    architecture: str = DEFAULT_ARCHITECTURE
    min_core: str = DEFAULT_MIN_CORE


@dataclass(frozen=True, slots=True)
class ArchiveSpec:
    """One deterministic tarball and the source members it must contain."""

    filename: str
    members: tuple[tuple[str, Path], ...]


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


def build_release(inputs: ReleaseInputs) -> ReleaseBundle:
    """Build the complete release bundle.

    The assembly implementation is deliberately added in the following
    incremental steps; keeping this entry point stable lets CI and tests adopt
    the finished builder without a second interface change.
    """

    raise NotImplementedError("modular release assembly is not implemented yet")


def write_release_bundle(inputs: ReleaseInputs) -> ReleaseBundle:
    """Build and return a release bundle for callers that prefer an action name."""

    return build_release(inputs)


def parse_args(argv: list[str] | None = None) -> ReleaseInputs:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--source-date-epoch", type=int, required=True)
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--architecture", default=DEFAULT_ARCHITECTURE)
    parser.add_argument("--min-core", default=DEFAULT_MIN_CORE)
    args = parser.parse_args(argv)
    return ReleaseInputs(
        root=args.root.resolve(),
        output_dir=args.output_dir.resolve(),
        version=args.version,
        source_date_epoch=args.source_date_epoch,
        source_commit=args.source_commit,
        architecture=args.architecture,
        min_core=args.min_core,
    )


def main(argv: list[str] | None = None) -> int:
    bundle = write_release_bundle(parse_args(argv))
    print(bundle.metadata_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

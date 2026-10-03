#!/usr/bin/env python3
"""Build deterministic Stage 8 modular-panel release assets.

The builder is intentionally offline: it turns a checked-out Xkeen UI tree into
release assets that the Stage 8.0 static contract can preflight before a future
updater is introduced.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from pathlib import Path
from typing import Any


DEFAULT_ARCHITECTURE = "aarch64"
DEFAULT_MIN_CORE = "1.0.0"


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


from __future__ import annotations

import importlib.util
import sys
import tarfile
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
BUILDER_PATH = ROOT / "scripts" / "build_modular_panel_release.py"


def _load_builder():
    assert BUILDER_PATH.is_file()
    spec = importlib.util.spec_from_file_location("build_modular_panel_release", BUILDER_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_release_builder_exposes_stable_input_and_asset_contract() -> None:
    builder = _load_builder()

    inputs = builder.ReleaseInputs(
        root=ROOT,
        output_dir=ROOT / "dist",
        version="1.2.3",
        source_date_epoch=1_700_000_000,
        source_commit="a" * 40,
    )

    assert inputs.version == "1.2.3"
    assert inputs.source_date_epoch == 1_700_000_000
    assert inputs.source_commit == "a" * 40
    assert inputs.architecture == "aarch64"
    assert inputs.min_core == "1.0.0"

    for name in ("ArchiveSpec", "BuiltAsset", "ReleaseBundle"):
        assert hasattr(builder, name)

    assert callable(builder.build_release)
    assert callable(builder.write_release_bundle)


def test_deterministic_tar_is_reproducible_and_normalizes_metadata(tmp_path: Path) -> None:
    builder = _load_builder()
    source = tmp_path / "source"
    source.mkdir()
    executable = source / "run.sh"
    executable.write_text("#!/bin/sh\necho ready\n", encoding="utf-8")
    executable.chmod(0o755)
    nested = source / "nested"
    nested.mkdir()
    (nested / "payload.txt").write_text("release payload\n", encoding="utf-8")

    first = tmp_path / "first.tar.gz"
    second = tmp_path / "second.tar.gz"
    members = {
        "payload/nested/payload.txt": nested / "payload.txt",
        "payload/run.sh": executable,
    }

    first_digest = builder.build_deterministic_tar(first, members, epoch=1_700_000_000)
    second_digest = builder.build_deterministic_tar(second, dict(reversed(tuple(members.items()))), epoch=1_700_000_000)

    assert first.read_bytes() == second.read_bytes()
    assert first_digest == second_digest
    with tarfile.open(first, "r:gz") as archive:
        entries = archive.getmembers()
    assert [entry.name for entry in entries] == [
        "payload",
        "payload/nested",
        "payload/nested/payload.txt",
        "payload/run.sh",
    ]
    assert all(entry.mtime == 1_700_000_000 for entry in entries)
    assert all(entry.uid == 0 and entry.gid == 0 for entry in entries)
    assert entries[-1].mode == 0o755


@pytest.mark.parametrize("member", ["../outside", "/absolute", "payload/../outside", "payload\\unsafe"])
def test_deterministic_tar_rejects_unsafe_member_names(tmp_path: Path, member: str) -> None:
    builder = _load_builder()
    source = tmp_path / "source.txt"
    source.write_text("payload", encoding="utf-8")

    with pytest.raises(builder.ReleaseBuildError, match="unsafe archive member path"):
        builder.build_deterministic_tar(tmp_path / "unsafe.tar.gz", {member: source}, epoch=0)


def test_deterministic_tar_rejects_symlink_sources(tmp_path: Path) -> None:
    builder = _load_builder()
    source = tmp_path / "source.txt"
    source.write_text("payload", encoding="utf-8")
    link = tmp_path / "source-link.txt"
    try:
        link.symlink_to(source)
    except OSError as error:
        pytest.skip(f"symlinks are unavailable: {error}")

    with pytest.raises(builder.ReleaseBuildError, match="symlink source is forbidden"):
        builder.build_deterministic_tar(tmp_path / "symlink.tar.gz", {"payload/source.txt": link}, epoch=0)

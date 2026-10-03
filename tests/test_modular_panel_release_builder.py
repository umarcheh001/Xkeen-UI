from __future__ import annotations

import importlib.util
import json
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


def test_module_ownership_uses_stage7_boundaries_and_excludes_user_state(tmp_path: Path) -> None:
    builder = _load_builder()
    package = tmp_path / "xkeen-ui"
    files = {
        "services/module_registry.py": "core\n",
        "routes/mihomo.py": "mihomo\n",
        "routes/routing/__init__.py": "xray\n",
        "static/js/pages/terminal.lazy.entry.js": "terminal\n",
        "opt/etc/mihomo/templates/template.yaml": "template\n",
        "modules.json": "{}\n",
        "install-profile.json": "{}\n",
        "opt/etc/mihomo/config.yaml": "user\n",
        "opt/etc/mihomo/profiles/user.yaml": "user\n",
        "bin/happ-decrypt-universal": "binary\n",
    }
    for relative, content in files.items():
        path = package / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")

    ownership = builder.build_module_ownership(tmp_path)

    assert ownership["core"] == ("services/module_registry.py",)
    assert ownership["engine.mihomo"] == (
        "opt/etc/mihomo/templates/template.yaml",
        "routes/mihomo.py",
    )
    assert ownership["engine.xray"] == ("routes/routing/__init__.py",)
    assert ownership["tool.terminal"] == ("static/js/pages/terminal.lazy.entry.js",)
    all_paths = {path for paths in ownership.values() for path in paths}
    assert "modules.json" not in all_paths
    assert "install-profile.json" not in all_paths
    assert "opt/etc/mihomo/config.yaml" not in all_paths
    assert "opt/etc/mihomo/profiles/user.yaml" not in all_paths
    assert "bin/happ-decrypt-universal" not in all_paths


def test_module_ownership_rejects_unmanaged_top_level_paths(tmp_path: Path) -> None:
    builder = _load_builder()
    package = tmp_path / "xkeen-ui"
    unknown = package / "untracked-root.txt"
    unknown.parent.mkdir(parents=True, exist_ok=True)
    unknown.write_text("must be classified\n", encoding="utf-8")

    with pytest.raises(builder.ReleaseBuildError, match="unclassified package path"):
        builder.build_module_ownership(tmp_path)


def test_module_manifest_uses_registry_metadata_and_exact_ownership(tmp_path: Path) -> None:
    builder = _load_builder()
    package = tmp_path / "xkeen-ui"
    source = package / "static/js/pages/terminal.lazy.entry.js"
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_text("terminal\n", encoding="utf-8")

    manifest = builder.build_module_manifest(
        tmp_path,
        "tool.terminal",
        version="1.2.3",
        architecture="aarch64",
        min_core="1.0.0",
    )

    assert manifest == {
        "schema_version": 1,
        "id": "tool.terminal",
        "version": "1.2.3",
        "channel": "stable",
        "panel_api": "1",
        "module_api": "1",
        "min_core": "1.0.0",
        "architectures": ["aarch64"],
        "requires": ["core"],
        "conflicts": [],
        "requires_restart": True,
        "ownership": ["static/js/pages/terminal.lazy.entry.js"],
        "max_size": len(source.read_bytes()),
    }

    spec = builder.module_archive_spec(
        tmp_path,
        "tool.terminal",
        version="1.2.3",
        architecture="aarch64",
        min_core="1.0.0",
    )
    assert spec.filename == "xkeen-module-tool.terminal-1.2.3.tar.gz"
    assert [name for name, _source in spec.members] == [
        "module-manifest.json",
        "payload/static/js/pages/terminal.lazy.entry.js",
    ]
    assert json.loads(dict(spec.members)["module-manifest.json"].decode("utf-8")) == manifest

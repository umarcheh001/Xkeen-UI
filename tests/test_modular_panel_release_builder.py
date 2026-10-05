from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import tarfile
from pathlib import Path

import pytest

from services.module_package_contract import validate_module_archive


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


def test_panel_source_root_excludes_ignored_runtime_files(panel_source_root: Path) -> None:
    assert (panel_source_root / "xkeen-ui" / "app.py").is_file()
    assert not (panel_source_root / "xkeen-ui" / "opt/etc/mihomo/config.yaml").exists()


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
    assert inputs.architectures == ("aarch64", "mips", "mipsel")
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


def test_deterministic_tar_normalizes_script_line_endings(tmp_path: Path) -> None:
    builder = _load_builder()
    source = tmp_path / "install.sh"
    source.write_bytes(b"#!/bin/sh\r\necho ready\r\n")
    archive_path = tmp_path / "scripts.tar.gz"

    builder.build_deterministic_tar(archive_path, {"install.sh": source}, epoch=0)

    with tarfile.open(archive_path, "r:gz") as archive:
        assert archive.extractfile("install.sh").read() == b"#!/bin/sh\necho ready\n"


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
        "install.sh": "#!/bin/sh\n",
        "uninstall.sh": "#!/bin/sh\n",
        "opt/etc/mihomo/config.yaml": "user\n",
        "opt/etc/mihomo/profiles/user.yaml": "user\n",
        "bin/happ-decrypt-universal": "binary\n",
        "bin/happ-decrypt-universal.assets/keytable.json": "key material\n",
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
    assert "install.sh" not in all_paths
    assert "uninstall.sh" not in all_paths
    assert "opt/etc/mihomo/config.yaml" not in all_paths
    assert "opt/etc/mihomo/profiles/user.yaml" not in all_paths
    assert "bin/happ-decrypt-universal" not in all_paths
    assert "bin/happ-decrypt-universal.assets/keytable.json" not in all_paths


def _hard_import_violations(builder, root: Path) -> list[str]:
    """Unconditional imports that leave the importer's package and its dependencies."""

    package = root / "xkeen-ui"
    ownership = builder.build_module_ownership(root)
    owner_of = {path: module_id for module_id, paths in ownership.items() for path in paths}
    stage7 = builder._stage7_module(root)
    closures = builder._dependency_closures(root, tuple(ownership))
    edges = {
        **builder._python_import_edges(package, owner_of),
        **builder._javascript_import_edges(package, owner_of, stage7),
    }
    return [
        f"{owner_of[source]}:{source} -> {owner_of[target]}:{target}"
        for source, targets in sorted(edges.items())
        for target in targets
        if owner_of[target] not in closures[owner_of[source]]
    ]


def test_module_ownership_follows_unconditional_imports(tmp_path: Path) -> None:
    builder = _load_builder()
    package = tmp_path / "xkeen-ui"
    files = {
        "services/module_registry.py": ["core"],
        # A page script of the core imports a file that its name gives to Mihomo.
        "static/js/pages/panel.entry.js": ["import './panel.mihomo_header.js';", "import('./terminal.lazy.entry.js');"],
        "static/js/pages/panel.mihomo_header.js": ["export const header = 1;"],
        "static/js/pages/terminal.lazy.entry.js": ["import '../terminal/core.js';"],
        "static/js/terminal/core.js": ["export const terminal = 1;"],
        # Two engines that both depend on the editor share a file.
        "static/js/features/mihomo_panel.js": ["import './outbounds.js';"],
        "static/js/features/outbounds.js": ["export const outbounds = 1;"],
        "static/js/pages/panel.mihomo.bundle.entry.js": ["import '../features/mihomo_panel.js';"],
        # Python: only a plain module-level import is unconditional.
        "run_server.py": [
            "from services.ws_pty import handle",
            "if True:",
            "    from services.xray_log_api import tail",
        ],
        "services/ws_pty.py": ["handle = None"],
        "services/xray_log_api.py": ["tail = None"],
        "routes/mihomo.py": ["def view():", "    from services.mihomo_backups import list_backups"],
        "services/mihomo_backups.py": ["list_backups = None"],
    }
    for relative, lines in files.items():
        path = package / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("".join(line + chr(10) for line in lines), encoding="utf-8")

    ownership = builder.build_module_ownership(tmp_path)
    owner_of = {path: module_id for module_id, paths in ownership.items() for path in paths}

    assert owner_of["static/js/pages/panel.mihomo_header.js"] == "core"
    assert owner_of["static/js/features/outbounds.js"] == "tool.editor"
    assert owner_of["services/ws_pty.py"] == "core"
    # Optional modules stay where the name rules put them.
    assert owner_of["static/js/pages/terminal.lazy.entry.js"] == "tool.terminal"
    assert owner_of["static/js/terminal/core.js"] == "tool.terminal"
    assert owner_of["services/xray_log_api.py"] == "engine.xray"
    assert owner_of["services/mihomo_backups.py"] == "tool.backups"
    assert owner_of["static/js/features/mihomo_panel.js"] == "engine.mihomo"
    assert _hard_import_violations(builder, tmp_path) == []


def test_every_real_package_loads_with_only_its_registry_dependencies() -> None:
    builder = _load_builder()

    assert _hard_import_violations(builder, ROOT) == []
    ownership = builder.build_module_ownership(ROOT)
    assert all(ownership[module_id] for module_id in ownership)
    paths = [path for module_paths in ownership.values() for path in module_paths]
    assert len(paths) == len(set(paths))


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
        architectures=("aarch64",),
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
        architectures=("aarch64",),
        min_core="1.0.0",
    )
    assert spec.filename == "xkeen-module-tool.terminal-1.2.3.tar.gz"
    assert [name for name, _source in spec.members] == [
        "module-manifest.json",
        "payload/static/js/pages/terminal.lazy.entry.js",
    ]
    assert json.loads(dict(spec.members)["module-manifest.json"].decode("utf-8")) == manifest


def test_catalog_architectures_are_sorted_and_limited_to_supported_routers() -> None:
    builder = _load_builder()

    assert builder.DEFAULT_ARCHITECTURES == ("aarch64", "mips", "mipsel")
    assert builder.normalize_architectures(("mipsel", "aarch64", "mipsel")) == ["aarch64", "mipsel"]
    assert builder.normalize_architectures("aarch64") == ["aarch64"]
    with pytest.raises(builder.ReleaseBuildError, match="unknown catalog architecture"):
        builder.normalize_architectures(("aarch64", "x86_64"))
    with pytest.raises(builder.ReleaseBuildError, match="at least one"):
        builder.normalize_architectures(())


def test_panel_and_module_assets_have_release_names_and_static_preflight(tmp_path: Path) -> None:
    builder = _load_builder()
    package = tmp_path / "xkeen-ui"
    for relative, content in {
        "install.sh": "#!/bin/sh\necho install\n",
        "uninstall.sh": "#!/bin/sh\necho uninstall\n",
        "app.py": "print('panel')\n",
        "services/module_registry.py": "core\n",
        "static/js/pages/terminal.lazy.entry.js": "terminal\n",
    }.items():
        path = package / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")

    panel = builder.build_panel_archive(tmp_path, tmp_path / "dist", version="1.2.3", epoch=1_700_000_000)
    module = builder.build_module_archive(
        tmp_path,
        tmp_path / "dist",
        "tool.terminal",
        version="1.2.3",
        architectures=("aarch64",),
        min_core="1.0.0",
        epoch=1_700_000_000,
    )

    assert panel.path.name == "xkeen-ui-panel-1.2.3.tar.gz"
    assert module.path.name == "xkeen-module-tool.terminal-1.2.3.tar.gz"
    assert panel.size == panel.path.stat().st_size
    assert module.sha256 == __import__("hashlib").sha256(module.path.read_bytes()).hexdigest()
    with tarfile.open(panel.path, "r:gz") as archive:
        names = {member.name for member in archive.getmembers()}
    assert "xkeen-ui/install.sh" in names
    assert "xkeen-ui/uninstall.sh" in names

    manifest = builder.build_module_manifest(
        tmp_path,
        "tool.terminal",
        version="1.2.3",
        architectures=("aarch64",),
        min_core="1.0.0",
    )
    catalog_entry = {
        **manifest,
        "archive": module.path.name,
        "size": module.size,
        "sha256": module.sha256,
        "signing_key_id": "release-2026",
    }
    assert validate_module_archive(
        module.path,
        catalog_entry,
        platform_architecture="aarch64",
        core_version="1.0.0",
    )["payload_files"] == manifest["ownership"]


def test_catalog_and_release_metadata_publish_every_generated_asset(tmp_path: Path) -> None:
    builder = _load_builder()
    package = tmp_path / "xkeen-ui"
    for relative in ("install.sh", "services/module_registry.py", "static/js/pages/terminal.lazy.entry.js"):
        path = package / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("payload\n", encoding="utf-8")

    bundle = builder.build_release(
        builder.ReleaseInputs(
            root=tmp_path,
            output_dir=tmp_path / "dist",
            version="1.2.3",
            source_date_epoch=1_700_000_000,
            source_commit="a" * 40,
        )
    )
    catalog = json.loads(bundle.catalog_path.read_text(encoding="utf-8"))
    metadata = json.loads(bundle.metadata_path.read_text(encoding="utf-8"))
    assert catalog["release_version"] == "1.2.3"
    assert catalog["channel"] == "stable"
    assert [entry["id"] for entry in catalog["modules"]] == ["core", "tool.terminal"]
    assert metadata["source_commit"] == "a" * 40
    assert len(metadata["assets"]) == len(set(metadata["assets"]))
    assert bundle.catalog_path.name in metadata["assets"]
    assert bundle.metadata_path.name in metadata["assets"]


def test_release_builder_supports_plan_level_function_signature(tmp_path: Path) -> None:
    builder = _load_builder()
    package = tmp_path / "xkeen-ui"
    for relative in ("install.sh", "services/module_registry.py", "static/js/pages/terminal.lazy.entry.js"):
        path = package / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("payload\n", encoding="utf-8")

    bundle = builder.build_release(
        tmp_path,
        tmp_path / "dist",
        version="1.2.3",
        source_date_epoch=1_700_000_000,
        source_commit="test-commit",
    )
    assert builder.write_release_bundle(bundle) is bundle


def test_release_builder_cli_loads_registry_without_test_runner_pythonpath(tmp_path: Path) -> None:
    package = tmp_path / "xkeen-ui"
    for relative in ("install.sh", "services/module_registry.py", "static/js/pages/terminal.lazy.entry.js"):
        path = package / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("payload\n", encoding="utf-8")

    result = subprocess.run(
        [
            sys.executable,
            str(BUILDER_PATH),
            "--root",
            str(tmp_path),
            "--output-dir",
            str(tmp_path / "dist"),
            "--version",
            "1.2.3",
            "--source-date-epoch",
            "1700000000",
            "--source-commit",
            "a" * 40,
        ],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert (tmp_path / "dist" / "release-metadata.json").is_file()


def test_complete_bundle_is_reproducible_and_passes_static_preflight(tmp_path: Path, panel_source_root: Path) -> None:
    builder = _load_builder()
    inputs = builder.ReleaseInputs(
        root=panel_source_root,
        output_dir=tmp_path / "first",
        version="1.0.0",
        source_date_epoch=1_700_000_000,
        source_commit="test-commit",
    )
    first = builder.build_release(inputs)
    second = builder.build_release(
        builder.ReleaseInputs(
            root=panel_source_root,
            output_dir=tmp_path / "second",
            version=inputs.version,
            source_date_epoch=inputs.source_date_epoch,
            source_commit=inputs.source_commit,
        )
    )

    first_files = sorted(path.name for path in inputs.output_dir.iterdir())
    second_files = sorted(path.name for path in second.inputs.output_dir.iterdir())
    assert first_files == second_files
    assert "catalog.json.sig" not in first_files
    for name in first_files:
        assert (inputs.output_dir / name).read_bytes() == (second.inputs.output_dir / name).read_bytes()

    catalog = json.loads(first.catalog_path.read_text(encoding="utf-8"))
    assert len(catalog["modules"]) == 9
    for entry in catalog["modules"]:
        # The payload does not depend on the CPU: a MIPS router must find
        # itself in the catalog just as an aarch64 one does.
        assert entry["architectures"] == ["aarch64", "mips", "mipsel"]
        for architecture in entry["architectures"]:
            result = validate_module_archive(
                inputs.output_dir / entry["archive"],
                entry,
                platform_architecture=architecture,
                core_version="1.0.0",
            )
            assert result["id"] == entry["id"]


def test_panel_asset_preserves_legacy_bootstrap_entrypoints(tmp_path: Path, panel_source_root: Path) -> None:
    builder = _load_builder()
    panel = builder.build_panel_archive(panel_source_root, tmp_path, version="1.0.0", epoch=1_700_000_000)

    with tarfile.open(panel.path, "r:gz") as archive:
        names = {member.name for member in archive.getmembers()}

    assert {
        "xkeen-ui/install.sh",
        "xkeen-ui/uninstall.sh",
        "xkeen-ui/app.py",
        "xkeen-ui/app_factory.py",
        "xkeen-ui/run_server.py",
        "xkeen-ui/services/module_registry.py",
        "xkeen-ui/static/js/pages/panel.entry.js",
    } <= names

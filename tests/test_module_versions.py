"""Каждый модуль, кроме core, имеет свою версию: файл module-versions.json."""

from __future__ import annotations

import importlib.util
import json
import sys
import tarfile
from pathlib import Path

from services.module_registry import MODULE_IDS, ModuleRegistry
from services.module_versions import (
    BASE_MODULE_VERSION,
    MODULE_VERSIONS_FILENAME,
    read_installed_module_versions,
    read_panel_module_versions,
)

REPO = Path(__file__).resolve().parents[1]
BUILDER_PATH = REPO / "scripts" / "build_modular_panel_release.py"
USER_ARCHIVE_PATH = REPO / "scripts" / "build_user_archive.py"


def write_json(path: Path, payload: object) -> None:
    path.write_text(json.dumps(payload), encoding="utf-8")


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_module_versions_file_covers_every_module_except_core():
    data = json.loads((REPO / "module-versions.json").read_text(encoding="utf-8"))
    assert set(data) == set(MODULE_IDS) - {"core"}
    assert set(data.values()) == {"1.0.0"}


def test_missing_copy_reads_base_version(tmp_path):
    versions = read_panel_module_versions(tmp_path)

    assert versions["tool.files"] == BASE_MODULE_VERSION == "1.0.0"
    assert set(versions) == set(MODULE_IDS) - {"core"}


def test_damaged_copy_reads_base_version(tmp_path):
    (tmp_path / MODULE_VERSIONS_FILENAME).write_text("{not json", encoding="utf-8")

    assert set(read_panel_module_versions(tmp_path).values()) == {"1.0.0"}


def test_panel_copy_sets_the_version_and_ignores_junk(tmp_path):
    write_json(tmp_path / MODULE_VERSIONS_FILENAME, {"tool.files": "1.2.0", "tool.terminal": "latest", "tool.unknown": "9.9.9"})

    versions = read_panel_module_versions(tmp_path)

    assert versions["tool.files"] == "1.2.0"
    assert versions["tool.terminal"] == "1.0.0"
    assert "tool.unknown" not in versions


def test_installed_version_wins_over_panel_copy(tmp_path):
    write_json(tmp_path / "module-versions.json", {"tool.files": "1.0.0"})
    write_json(
        tmp_path / "module-installed.json",
        {"schema_version": 1, "modules": {"tool.files": True}, "versions": {"tool.files": "1.0.3"}},
    )

    versions = read_installed_module_versions(tmp_path, tmp_path)

    assert versions["tool.files"] == "1.0.3"
    assert versions["tool.terminal"] == "1.0.0"


def test_installed_manifest_without_versions_falls_back_to_panel_copy(tmp_path):
    write_json(tmp_path / "module-versions.json", {"tool.files": "1.1.0"})
    write_json(tmp_path / "module-installed.json", {"schema_version": 1, "modules": {"tool.files": True}})

    assert read_installed_module_versions(tmp_path, tmp_path)["tool.files"] == "1.1.0"


def test_panel_archive_carries_generated_copy(shared_panel_source_root, tmp_path):
    builder = _load("build_modular_panel_release", BUILDER_PATH)
    builder.ARCHIVE_COMPRESSLEVEL = 1
    assert not (shared_panel_source_root / "xkeen-ui" / "module-versions.json").exists()

    panel = builder.build_panel_archive(shared_panel_source_root, tmp_path, version="1.0.0", epoch=1_700_000_000)

    with tarfile.open(panel.path, "r:gz") as archive:
        member = archive.extractfile("xkeen-ui/module-versions.json")
        assert member is not None
        carried = member.read()
        ownership = json.loads(archive.extractfile("xkeen-ui/module-ownership.json").read())
    assert carried == (REPO / "module-versions.json").read_bytes()
    assert "module-versions.json" in ownership["modules"]["core"]


def test_user_archive_writes_the_copy_into_the_package_tree(shared_panel_source_root, tmp_path):
    import shutil

    builder = _load("build_user_archive", USER_ARCHIVE_PATH)
    package_root = tmp_path / "xkeen-ui"
    shutil.copytree(shared_panel_source_root / "xkeen-ui", package_root)

    written = builder.write_module_ownership_map(package_root, strict=True)

    assert written is not None
    assert (package_root / "module-versions.json").read_bytes() == (REPO / "module-versions.json").read_bytes()
    ownership = json.loads((package_root / "module-ownership.json").read_text(encoding="utf-8"))
    assert "module-versions.json" in ownership["modules"]["core"]


def test_registry_reports_installed_version(tmp_path):
    write_json(
        tmp_path / "module-installed.json",
        {"schema_version": 1, "modules": {"tool.files": True}, "versions": {"tool.files": "1.0.3"}},
    )
    write_json(tmp_path / "BUILD.json", {"version": "3.1.0"})
    registry = ModuleRegistry(str(tmp_path), which=lambda name: f"/usr/bin/{name}", environ={"ComSpec": "cmd.exe"})

    snapshot = registry.get_registry()

    by_id = {item["id"]: item for item in snapshot["modules"]}
    assert by_id["tool.files"]["version"] == "1.0.3"
    assert by_id["tool.terminal"]["version"] == "1.0.0"
    assert by_id["core"]["version"] == "3.1.0"
    assert snapshot["registry_version"] == "1.0.0"


def test_registry_keeps_core_version_when_build_info_is_unreadable(tmp_path):
    (tmp_path / "BUILD.json").write_text("{broken", encoding="utf-8")
    registry = ModuleRegistry(str(tmp_path), which=lambda name: f"/usr/bin/{name}", environ={"ComSpec": "cmd.exe"})

    core = next(item for item in registry.get_registry()["modules"] if item["id"] == "core")

    assert core["version"] == "1.0.0"

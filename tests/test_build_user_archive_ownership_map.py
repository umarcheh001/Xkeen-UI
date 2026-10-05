"""Архив панели везёт карту «модуль → файлы» для менеджера модулей.

Без карты панель на роутере не знает, какие файлы убрать при удалении модуля,
который поставил установщик. Карта описывает дерево вместе со сжатой статикой,
поэтому пишется после сжатия и до штампа сборки: `tree_sha256` обязан её учесть.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "build_user_archive.py"
WORKFLOW = ROOT / ".github" / "workflows" / "build-user-archive.yml"


def _load_builder():
    spec = importlib.util.spec_from_file_location("build_user_archive", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_map_is_written_into_the_package_tree(panel_source_root: Path) -> None:
    builder = _load_builder()
    package_root = panel_source_root / "xkeen-ui"

    written = builder.write_module_ownership_map(package_root)

    assert written == package_root / "module-ownership.json"
    data = json.loads(written.read_text(encoding="utf-8"))
    assert "module-ownership.json" in data["modules"]["core"]
    assert "services/ws_pty.py" in data["modules"]["tool.terminal"]


def test_map_lists_precompressed_copies_with_their_sources(panel_source_root: Path) -> None:
    builder = _load_builder()
    package_root = panel_source_root / "xkeen-ui"
    builder.precompress_static_assets(package_root)

    data = json.loads(builder.write_module_ownership_map(package_root).read_text(encoding="utf-8"))

    owner_of = {path: module for module, paths in data["modules"].items() for path in paths}
    packed = [path for path in owner_of if path.endswith(".gz") and path[:-3] in owner_of]
    assert packed, "the tree must contain precompressed static files"
    assert all(owner_of[path] == owner_of[path[:-3]] for path in packed)


def test_local_build_survives_a_tree_the_map_cannot_describe(tmp_path: Path, capsys) -> None:
    builder = _load_builder()
    package_root = tmp_path / "xkeen-ui"
    package_root.mkdir()
    (package_root / "unclassified-top-level-file.bin").write_bytes(b"x")

    assert builder.write_module_ownership_map(package_root) is None
    assert "module-ownership.json" in capsys.readouterr().out
    assert not (package_root / "module-ownership.json").exists()


def test_release_build_fails_on_a_tree_the_map_cannot_describe(tmp_path: Path) -> None:
    builder = _load_builder()
    package_root = tmp_path / "xkeen-ui"
    package_root.mkdir()
    (package_root / "unclassified-top-level-file.bin").write_bytes(b"x")

    with pytest.raises(Exception) as failure:
        builder.write_module_ownership_map(package_root, strict=True)
    assert not isinstance(failure.value, (AttributeError, TypeError))
    assert not (package_root / "module-ownership.json").exists()


def test_local_archive_writes_the_map_after_compression_and_before_the_stamp() -> None:
    source = SCRIPT.read_text(encoding="utf-8")
    main_source = source[source.index("def main() -> int:"):]

    compress = main_source.index("precompress_static_assets(package_root)")
    ownership = main_source.index("write_module_ownership_map(package_root)")
    stamp = main_source.index("write_build_json(package_root")
    assert compress < ownership < stamp


def test_workflow_writes_the_map_after_compression_and_before_the_stamp() -> None:
    source = WORKFLOW.read_text(encoding="utf-8")

    compress = source.index("builder.precompress_static_assets(root)")
    ownership = source.index("builder.write_module_ownership_map(root, strict=True)")
    stamp = source.index("builder.write_build_json(")
    archive = source.index("      - name: Create user archive")
    assert compress < ownership < stamp < archive


def test_workflow_builds_module_packages_from_the_packaged_tree() -> None:
    source = WORKFLOW.read_text(encoding="utf-8")
    start = source.index("python scripts/build_modular_panel_release.py")
    command = source[start:source.index("      - name: Sign modular panel catalog", start)]

    assert "--root package-root" in command
    assert "--root . " not in command and "--root .\n" not in command

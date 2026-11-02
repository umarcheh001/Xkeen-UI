"""Сравнение с архивом панели на настоящем дереве и настоящем сборщике.

Панель собирается дважды из копии настоящего пакета. Во второй раз меняется
либо только отделённый модуль (исходники, бэкенд и хэшированный пакет сборки с
манифестом модуля), либо файл core. Первое сравнение обязано пройти чисто,
иначе отделённые модули нельзя выпускать отдельно.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from scripts import build_modular_panel_release as builder
from scripts.check_module_release import NEEDS_PANEL, compare_with_panel_archive, extract_panel_archive

ROOT = Path(__file__).resolve().parents[1]
PANEL = ROOT / "xkeen-ui"
MODULE = "tool.advanced-diagnostics"
BUNDLE_DIR = PANEL / "static" / "frontend-build" / "modules" / MODULE

pytestmark = pytest.mark.skipif(
    not (BUNDLE_DIR.is_dir() and (PANEL / "static" / "frontend-build" / ".vite" / "manifest.json").is_file()),
    reason="needs npm run frontend:build",
)


def _build(root: Path, out: Path):
    out.mkdir(parents=True, exist_ok=True)
    return builder.build_panel_archive(root, out, version="9.9.9", epoch=0).path


def _change_module(tree: Path) -> None:
    owned = builder.build_ownership_map(tree.parent)["modules"][MODULE]
    backend = next(path for path in owned if path.endswith(".py"))
    with (tree / backend).open("ab") as handle:
        handle.write(b"\n# release change\n")
    manifest_path = tree / "static" / "frontend-build" / ".vite" / f"module.{MODULE}.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    for entry in manifest.values():
        old = tree / "static" / "frontend-build" / "modules" / MODULE / entry["file"]
        new_name = entry["file"].replace("-", "-new", 1)
        old.write_bytes(old.read_bytes() + b"\n/* release change */\n")
        old.rename(old.with_name(new_name))
        entry["file"] = new_name
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")


def test_split_module_release_matches_panel_archive_and_core_change_does_not(tmp_path):
    root = tmp_path / "root"
    tree = root / "xkeen-ui"
    shutil.copytree(
        PANEL, tree,
        ignore=shutil.ignore_patterns("__pycache__", ".DS_Store", "BUILD.json", "module-ownership.json", "*.gz"),
    )
    base_archive = _build(root, tmp_path / "base")

    _change_module(tree)
    module_tree = extract_panel_archive(_build(root, tmp_path / "module"), tmp_path / "module-tree")
    assert compare_with_panel_archive(module_tree, base_archive, MODULE) == []

    (tree / "app.py").write_bytes((tree / "app.py").read_bytes() + b"\n# core change\n")
    core_tree = extract_panel_archive(_build(root, tmp_path / "core"), tmp_path / "core-tree")
    errors = compare_with_panel_archive(core_tree, base_archive, MODULE)
    assert errors and all(NEEDS_PANEL in error for error in errors)
    assert any("app.py" in error for error in errors)

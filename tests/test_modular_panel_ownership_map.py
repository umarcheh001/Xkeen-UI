from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BUILDER_PATH = ROOT / "scripts" / "build_modular_panel_release.py"


def _load_builder():
    spec = importlib.util.spec_from_file_location("build_modular_panel_release", BUILDER_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _write_frontend_manifests(root: Path) -> None:
    vite = root / "xkeen-ui" / "static" / "frontend-build" / ".vite"
    vite.mkdir(parents=True, exist_ok=True)
    (vite / "manifest.json").write_text(
        json.dumps({"static/js/pages/panel.entry.js": {"file": "assets/panel-bridge.js", "src": "static/js/pages/panel.entry.js"}}),
        encoding="utf-8",
    )
    (vite / "manifest.build.json").write_text(
        json.dumps({"static/js/pages/panel.entry.js": {"file": "assets/panel-abc.js", "imports": []}}),
        encoding="utf-8",
    )


def test_gz_follows_its_source_owner(panel_source_root: Path) -> None:
    builder = _load_builder()
    packed = panel_source_root / "xkeen-ui" / "static" / "js" / "pages" / "terminal.lazy.entry.js.gz"
    packed.write_bytes(b"gz")

    ownership = builder.build_module_ownership(panel_source_root)

    assert "static/js/pages/terminal.lazy.entry.js.gz" in ownership["tool.terminal"]


def test_gz_of_a_file_moved_by_import_closure_moves_with_it(panel_source_root: Path) -> None:
    builder = _load_builder()
    before = builder.build_module_ownership(panel_source_root)
    owner_of = {path: module for module, paths in before.items() for path in paths}
    # The name rules give this script to the terminal, the closure keeps it in core.
    relative = "static/js/pages/top_level_panel_mihomo.shared.js"
    assert owner_of[relative] == "core"
    (panel_source_root / "xkeen-ui" / (relative + ".gz")).write_bytes(b"gz")

    after = builder.build_module_ownership(panel_source_root)

    assert relative + ".gz" in after["core"]


def test_every_file_belongs_to_exactly_one_module(panel_source_root: Path) -> None:
    builder = _load_builder()
    (panel_source_root / "xkeen-ui" / "static" / "js" / "pages" / "terminal.lazy.entry.js.gz").write_bytes(b"gz")

    data = builder.build_ownership_map(panel_source_root)

    paths = [path for files in data["modules"].values() for path in files]
    assert len(paths) == len(set(paths))
    assert data["schema_version"] == 1
    assert all(files == sorted(files) for files in data["modules"].values())


def test_map_contains_itself_and_full_frontend_manifests(panel_source_root: Path) -> None:
    builder = _load_builder()
    _write_frontend_manifests(panel_source_root)

    path = builder.write_ownership_map(panel_source_root)

    assert path == panel_source_root / "xkeen-ui" / "module-ownership.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    assert "module-ownership.json" in data["modules"]["core"]
    assert set(data["frontend"]) == {"bridge", "build"}
    assert data["frontend"]["bridge"]["static/js/pages/panel.entry.js"]["file"] == "assets/panel-bridge.js"
    assert data["frontend"]["build"]["static/js/pages/panel.entry.js"]["file"] == "assets/panel-abc.js"
    assert b"\r\n" not in path.read_bytes()


def test_map_without_a_frontend_build_has_empty_manifests(panel_source_root: Path) -> None:
    builder = _load_builder()

    data = builder.build_ownership_map(panel_source_root)

    assert data["frontend"] == {"bridge": {}, "build": {}}


def test_map_is_deterministic(panel_source_root: Path) -> None:
    builder = _load_builder()

    first = builder.write_ownership_map(panel_source_root).read_bytes()
    second = builder.write_ownership_map(panel_source_root).read_bytes()

    assert first == second


def test_cli_writes_only_the_map(panel_source_root: Path, capsys) -> None:
    builder = _load_builder()

    assert builder.main(["--root", str(panel_source_root), "--write-ownership-map"]) == 0

    written = panel_source_root / "xkeen-ui" / "module-ownership.json"
    assert written.is_file()
    assert capsys.readouterr().out.strip() == str(written)
    assert not (panel_source_root / "dist").exists()

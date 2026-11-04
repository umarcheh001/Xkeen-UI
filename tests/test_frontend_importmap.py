"""Отдельная сборка модуля и его подключение через importmap.

Панель и модуль связаны только именем `xk-module/<id>`: правка внутри модуля не
меняет ни одного файла сборки core. Настоящая сборка здесь не нужна: манифесты
раскладываются во временное дерево.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from routes.ui_assets import is_hashed_build_asset_filename
from scripts import build_modular_panel_release as builder
from services.frontend_importmap import (
    SOURCE_FALLBACKS,
    build_core_importmap,
    build_core_public_importmap,
    build_module_importmap,
)
from tests.support.panel_render import FULL_MODULE_IDS, ROOT, XRAY_MINIMAL_MODULE_IDS, build_panel_app
from tests.test_installer_frontend_build_cleanup import _run_cleanup


MODULE_ID = "tool.advanced-diagnostics"
MODULE_KEY = f"xk-module/{MODULE_ID}"
SOURCE_ENTRY = "js/features/resource_monitor.js"
ASSETS_HELPER_KEY = "xkeen_ui_assets"
SYNC_SCRIPT = ROOT / "scripts" / "sync_frontend_build_manifest.py"


def owner(path: str) -> str:
    return builder._stage7_module().owner(path)


def lay_module_manifest(panel_root: Path, module_id: str, filename: str) -> Path:
    vite = panel_root / "static/frontend-build/.vite"
    vite.mkdir(parents=True, exist_ok=True)
    manifest = vite / f"module.{module_id}.json"
    manifest.write_text(
        json.dumps({SOURCE_ENTRY: {"file": filename, "isEntry": True, "src": SOURCE_ENTRY}}),
        encoding="utf-8",
    )
    return manifest


def lay_source(panel_root: Path) -> None:
    source = panel_root / "static" / SOURCE_ENTRY
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_text("", encoding="utf-8")


def extract_importmap(html: str) -> str:
    return re.search(r'<script type="importmap"[^>]*>(.*?)</script>', html, re.DOTALL).group(1)


def render_imports(monkeypatch, tmp_path: Path, active_module_ids: list[str] | None, panel_root: Path) -> dict[str, str]:
    """The importmap of a real page, with the helper pointed at a fixture tree."""

    monkeypatch.setenv("XKEEN_UI_FRONTEND_SOURCE_FALLBACK", "1")
    app = build_panel_app(active_module_ids, tmp_path)
    app.extensions[ASSETS_HELPER_KEY].static_folder = str(panel_root / "static")
    response = app.test_client().get("/")
    assert response.status_code == 200
    return json.loads(extract_importmap(response.get_data(as_text=True)))["imports"]


def test_importmap_lists_active_built_module(tmp_path: Path) -> None:
    lay_module_manifest(tmp_path, MODULE_ID, "resource_monitor-AbCd1234.js")

    assert build_module_importmap(tmp_path, {"core", MODULE_ID}) == {
        MODULE_KEY: f"frontend-build/modules/{MODULE_ID}/resource_monitor-AbCd1234.js",
    }


def test_switched_off_module_is_absent(tmp_path: Path) -> None:
    lay_module_manifest(tmp_path, MODULE_ID, "resource_monitor-AbCd1234.js")

    assert build_module_importmap(tmp_path, {"core"}) == {}


def test_removed_module_is_absent_without_error(tmp_path: Path) -> None:
    assert build_module_importmap(tmp_path, {"core", MODULE_ID}) == {}


def test_source_fallback_without_build(tmp_path: Path) -> None:
    lay_source(tmp_path)

    assert SOURCE_FALLBACKS == {MODULE_ID: SOURCE_ENTRY}
    assert build_module_importmap(tmp_path, {MODULE_ID}) == {MODULE_KEY: SOURCE_ENTRY}


def test_built_module_wins_over_its_source(tmp_path: Path) -> None:
    lay_source(tmp_path)
    lay_module_manifest(tmp_path, MODULE_ID, "resource_monitor-AbCd1234.js")

    assert build_module_importmap(tmp_path, {MODULE_ID}) == {
        MODULE_KEY: f"frontend-build/modules/{MODULE_ID}/resource_monitor-AbCd1234.js",
    }


def test_no_activation_data_means_every_module_found(tmp_path: Path) -> None:
    lay_module_manifest(tmp_path, MODULE_ID, "resource_monitor-AbCd1234.js")
    lay_module_manifest(tmp_path, "engine.mihomo", "mihomo-AbCd1234.js")

    assert build_module_importmap(tmp_path, None) == {
        MODULE_KEY: f"frontend-build/modules/{MODULE_ID}/resource_monitor-AbCd1234.js",
        "xk-module/engine.mihomo": "frontend-build/modules/engine.mihomo/mihomo-AbCd1234.js",
    }


@pytest.mark.parametrize(
    "payload",
    [
        "not json",
        "[]",
        json.dumps({SOURCE_ENTRY: {"file": "a-AbCd1234.js"}}),
        json.dumps({"a": {"file": "a-AbCd1234.js", "isEntry": True}, "b": {"file": "b-AbCd1234.js", "isEntry": True}}),
        json.dumps({SOURCE_ENTRY: {"isEntry": True}}),
    ],
    ids=["broken", "not-an-object", "no-entry", "two-entries", "entry-without-file"],
)
def test_unusable_manifest_omits_the_module_quietly(tmp_path: Path, payload: str) -> None:
    lay_source(tmp_path)
    lay_module_manifest(tmp_path, MODULE_ID, "x.js").write_text(payload, encoding="utf-8")

    assert build_module_importmap(tmp_path, {MODULE_ID}) == {}


def test_changed_manifest_is_read_again(tmp_path: Path) -> None:
    manifest = lay_module_manifest(tmp_path, MODULE_ID, "resource_monitor-AbCd1234.js")
    assert build_module_importmap(tmp_path, {MODULE_ID})

    lay_module_manifest(tmp_path, MODULE_ID, "resource_monitor-EfGh5678.js")
    stats = manifest.stat()
    os.utime(manifest, ns=(stats.st_atime_ns, stats.st_mtime_ns + 1_000_000))

    assert build_module_importmap(tmp_path, {MODULE_ID})[MODULE_KEY].endswith("resource_monitor-EfGh5678.js")


def test_core_importmap_maps_public_paths_to_hashed_files() -> None:
    manifest = {
        "js/ui/toast.js": {"file": "assets/toast-AbCd1234.js"},
        "js/ui/other.js": {"file": "assets/other-AbCd1234.js"},
    }

    assert build_core_importmap(manifest, {"ui/toast": "js/ui/toast.js", "ui/gone": "js/ui/gone.js"}) == {
        "xk-core/ui/toast": "frontend-build/assets/toast-AbCd1234.js",
    }
    assert build_core_importmap(manifest, {}) == {}


def lay_core_build_manifest(panel_root: Path, payload: dict) -> None:
    vite = panel_root / "static/frontend-build/.vite"
    vite.mkdir(parents=True, exist_ok=True)
    (vite / "manifest.build.json").write_text(json.dumps(payload), encoding="utf-8")


CORE_BUILD_MANIFEST = {
    "js/features/xkeen_runtime.js": {
        "file": "assets/xk-core-0123456789-AbCd1234.js",
        "isEntry": True,
        "name": "xk-core-0123456789",
        "src": "js/features/xkeen_runtime.js",
    },
    "_shared-EfGh5678.js": {"file": "assets/shared-EfGh5678.js", "name": "shared"},
    "js/ui/lazy.js": {"file": "assets/lazy-IjKl9012.js", "isDynamicEntry": True, "src": "js/ui/lazy.js"},
}


def test_core_public_entries_are_mapped_to_built_files(monkeypatch, tmp_path: Path) -> None:
    panel_root = tmp_path / "panel"
    lay_core_build_manifest(panel_root, CORE_BUILD_MANIFEST)

    assert build_core_public_importmap(panel_root) == {
        "xk-core/js/features/xkeen_runtime.js": "frontend-build/assets/xk-core-0123456789-AbCd1234.js",
    }

    imports = render_imports(monkeypatch, tmp_path, FULL_MODULE_IDS, panel_root)
    assert imports["xk-core/js/features/xkeen_runtime.js"] == (
        "/static/frontend-build/assets/xk-core-0123456789-AbCd1234.js"
    )
    assert "xk-core/" not in imports


def test_core_prefix_without_build(monkeypatch, tmp_path: Path) -> None:
    panel_root = tmp_path / "panel"
    (panel_root / "static").mkdir(parents=True)

    assert build_core_public_importmap(panel_root) == {"xk-core/": ""}

    imports = render_imports(monkeypatch, tmp_path, FULL_MODULE_IDS, panel_root)
    assert imports["xk-core/"] == "/static/"


def test_unreadable_core_manifest_falls_back_to_the_sources(tmp_path: Path) -> None:
    vite = tmp_path / "static/frontend-build/.vite"
    vite.mkdir(parents=True)
    (vite / "manifest.build.json").write_text("not json", encoding="utf-8")

    assert build_core_public_importmap(tmp_path) == {"xk-core/": ""}


def test_node_resolves_core_public_names_to_the_same_module() -> None:
    """The node hook gives the tests what the importmap gives a page without a build."""

    from tests.support.node_js import NODE_MODULE_COMMAND

    if shutil.which("node") is None:
        pytest.skip("node is not available in this environment")
    script = (
        "const named = await import('xk-core/js/features/module_parts.js');\n"
        "const relative = await import('./xkeen-ui/static/js/features/module_parts.js');\n"
        "console.log(named === relative ? 'same' : 'different');\n"
    )
    result = subprocess.run(
        [*NODE_MODULE_COMMAND], input=script, cwd=ROOT, capture_output=True, text=True, encoding="utf-8", check=False
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "same"


def test_js_unit_tests_run_with_the_core_hook() -> None:
    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))

    assert package["scripts"]["test:js"].startswith("node --import ./tests/js/xk_core_hooks.mjs --test ")


def test_module_assets_are_immutable() -> None:
    assert is_hashed_build_asset_filename(
        f"frontend-build/modules/{MODULE_ID}/resource_monitor-AbCd1234.js"
    )


def test_module_build_files_belong_to_module() -> None:
    assert owner(f"static/frontend-build/modules/{MODULE_ID}/x-AbCd1234.js") == MODULE_ID
    assert owner(f"static/frontend-build/modules/{MODULE_ID}/x-AbCd1234.js.gz") == MODULE_ID
    assert owner(f"static/frontend-build/.vite/module.{MODULE_ID}.json") == MODULE_ID
    assert owner("static/frontend-build/.vite/manifest.build.json") == "core"
    assert owner("static/frontend-build/.vite/manifest.json") == "core"


def test_rendered_importmap_is_valid_json(monkeypatch, tmp_path: Path) -> None:
    panel_root = tmp_path / "panel"
    lay_module_manifest(panel_root, MODULE_ID, "resource_monitor-AbCd1234.js")

    imports = render_imports(monkeypatch, tmp_path, FULL_MODULE_IDS, panel_root)

    assert imports[MODULE_KEY] == f"/static/frontend-build/modules/{MODULE_ID}/resource_monitor-AbCd1234.js"
    assert imports["codemirror"].endswith("vendor/npm/codemirror/dist/index.js")


def test_page_without_the_module_has_no_importmap_entry(monkeypatch, tmp_path: Path) -> None:
    panel_root = tmp_path / "panel"
    lay_module_manifest(panel_root, MODULE_ID, "resource_monitor-AbCd1234.js")

    imports = render_imports(monkeypatch, tmp_path, XRAY_MINIMAL_MODULE_IDS, panel_root)

    assert MODULE_KEY not in imports
    assert imports["codemirror"].endswith("vendor/npm/codemirror/dist/index.js")


def test_panel_reaches_the_module_only_by_its_public_name() -> None:
    bundle = (ROOT / "xkeen-ui/static/js/pages/panel.diagnostics.bundle.js").read_text(encoding="utf-8")

    assert f"import('{MODULE_KEY}')" in bundle
    assert "resource_monitor.js" not in bundle


def test_build_passes_are_chained_in_one_command() -> None:
    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    command = package["scripts"]["frontend:build"]

    vite = command.index("vite build --config vite.config.mjs")
    modules = command.index("node scripts/build_frontend_modules.mjs")
    sync = command.index("scripts/sync_frontend_build_manifest.py")
    assert vite < modules < sync


def test_module_pass_is_described_by_its_own_config() -> None:
    core = (ROOT / "vite.config.mjs").read_text(encoding="utf-8")
    module = (ROOT / "vite.module.config.mjs").read_text(encoding="utf-8")

    assert "xk-module" in core
    assert "CORE_PUBLIC_ENTRIES" in core
    assert "emptyOutDir: true" in module
    # Vite drops the exports of an entry by default, and the core calls them.
    assert "preserveEntrySignatures: 'strict'" in module
    assert "XK_MODULE_ID" in module
    assert f"'{MODULE_ID}': {{ entry: '{SOURCE_ENTRY}' }}" in module


def _inventory_generator():
    import importlib.util

    # The generator imports its neighbours from scripts/ as top-level modules.
    if str(ROOT / "scripts") not in sys.path:
        sys.path.insert(0, str(ROOT / "scripts"))
    spec = importlib.util.spec_from_file_location(
        "generate_modular_panel_inventory_for_importmap", ROOT / "scripts" / "generate_modular_panel_inventory.py"
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    generator = module.ModularPanelInventoryGenerator.__new__(module.ModularPanelInventoryGenerator)
    generator.root = ROOT
    generator.project_root = ROOT / "xkeen-ui"
    return generator


def test_inventory_follows_the_public_name_into_the_module() -> None:
    """The core bundle still loads the module's window, only by its public name now."""

    generator = _inventory_generator()
    bundle = ROOT / "xkeen-ui/static/js/pages/panel.diagnostics.bundle.js"

    assert generator._resolve_js_import(bundle, MODULE_KEY) == (ROOT / "xkeen-ui/static" / SOURCE_ENTRY).resolve()
    assert generator._resolve_js_import(bundle, "xk-module/tool.unknown") is None


def test_inventory_follows_the_core_public_name_into_the_core() -> None:
    generator = _inventory_generator()
    routing = ROOT / "xkeen-ui/static/js/features/routing.js"

    assert generator._resolve_js_import(routing, "xk-core/js/features/xkeen_runtime.js") == (
        ROOT / "xkeen-ui/static/js/features/xkeen_runtime.js"
    ).resolve()
    assert generator._resolve_js_import(routing, "xk-core/js/features/gone.js") is None


@pytest.fixture
def build_dir(tmp_path: Path) -> Path:
    root = tmp_path / "frontend-build"
    (root / "assets").mkdir(parents=True)
    (root / "assets/panel-AbCd1234.js").write_text("", encoding="utf-8")
    (root / ".vite").mkdir()
    (root / ".vite/manifest.build.json").write_text(
        json.dumps({"js/pages/panel.entry.js": {"file": "assets/panel-AbCd1234.js"}}), encoding="utf-8"
    )
    lay_module_manifest(tmp_path / "tree", MODULE_ID, "resource_monitor-AbCd1234.js")
    (root / ".vite" / f"module.{MODULE_ID}.json").write_bytes(
        (tmp_path / "tree/static/frontend-build/.vite" / f"module.{MODULE_ID}.json").read_bytes()
    )
    module_dir = root / "modules" / MODULE_ID
    module_dir.mkdir(parents=True)
    (module_dir / "resource_monitor-AbCd1234.js").write_text("", encoding="utf-8")
    return root


def test_installer_cleanup_keeps_module_build_files(build_dir: Path) -> None:
    module_dir = build_dir / "modules" / MODULE_ID
    (module_dir / "resource_monitor-AbCd1234.js.gz").write_bytes(b"\x1f\x8b")
    stale = module_dir / "resource_monitor-Stale123.js"
    stale.write_text("", encoding="utf-8")
    orphan = build_dir / "modules" / "tool.gone" / "x-AbCd1234.js"
    orphan.parent.mkdir()
    orphan.write_text("", encoding="utf-8")

    _run_cleanup(build_dir)

    assert (build_dir / ".vite" / f"module.{MODULE_ID}.json").is_file()
    assert (module_dir / "resource_monitor-AbCd1234.js").is_file()
    assert (module_dir / "resource_monitor-AbCd1234.js.gz").is_file()
    assert not stale.exists()
    assert not orphan.exists()


def test_build_prune_keeps_module_files_and_drops_the_rest(tmp_path: Path) -> None:
    project = tmp_path / "xkeen-ui"
    source = project / "static/js/pages/panel.entry.js"
    source.parent.mkdir(parents=True)
    source.write_text("export {};\n", encoding="utf-8")
    build = project / "static/frontend-build"
    (build / "assets").mkdir(parents=True)
    (build / "assets/panel-AbCd1234.js").write_text("", encoding="utf-8")
    (build / ".vite").mkdir()
    (build / ".vite/manifest.build.json").write_text(
        json.dumps({
            "js/pages/panel.entry.js": {
                "file": "assets/panel-AbCd1234.js", "isEntry": True, "name": "panel",
                "src": "js/pages/panel.entry.js",
            }
        }),
        encoding="utf-8",
    )
    lay_module_manifest(project, MODULE_ID, "resource_monitor-AbCd1234.js")
    module_dir = build / "modules" / MODULE_ID
    module_dir.mkdir(parents=True)
    kept = module_dir / "resource_monitor-AbCd1234.js"
    kept.write_text("", encoding="utf-8")
    stale = module_dir / "resource_monitor-Stale123.js"
    stale.write_text("", encoding="utf-8")

    result = subprocess.run(
        [sys.executable, str(SYNC_SCRIPT), "--repo-root", str(tmp_path)],
        capture_output=True, text=True, check=False,
    )

    assert result.returncode == 0, result.stdout + result.stderr
    assert kept.is_file()
    assert (build / ".vite" / f"module.{MODULE_ID}.json").is_file()
    assert not stale.exists()


def _reduced_profile_tree(tmp_path: Path) -> Path:
    root = tmp_path / "tree"
    build = root / "static/frontend-build"
    (build / ".vite").mkdir(parents=True)
    (build / ".vite/manifest.build.json").write_text("{}", encoding="utf-8")
    lay_module_manifest(root, MODULE_ID, "resource_monitor-AbCd1234.js")
    module_dir = build / "modules" / MODULE_ID
    module_dir.mkdir(parents=True)
    (module_dir / "resource_monitor-AbCd1234.js").write_text("", encoding="utf-8")
    (module_dir / "resource_monitor-AbCd1234.js.gz").write_text("", encoding="utf-8")
    return root


MODULE_BUILD_FILES = {
    f"static/frontend-build/.vite/module.{MODULE_ID}.json",
    f"static/frontend-build/modules/{MODULE_ID}/resource_monitor-AbCd1234.js",
    f"static/frontend-build/modules/{MODULE_ID}/resource_monitor-AbCd1234.js.gz",
}


def test_profile_with_the_module_lays_its_build_files(tmp_path: Path) -> None:
    files, _, _ = builder._stage7_module()._frontend_files(_reduced_profile_tree(tmp_path), {"core", MODULE_ID}, "light")

    assert MODULE_BUILD_FILES <= files


def test_profile_without_the_module_lays_none_of_them(tmp_path: Path) -> None:
    files, manifest, _ = builder._stage7_module()._frontend_files(_reduced_profile_tree(tmp_path), {"core"}, "light")

    assert not files & MODULE_BUILD_FILES
    assert manifest == {}


def test_ownership_map_gives_module_build_files_to_the_module(panel_source_root: Path) -> None:
    build = panel_source_root / "xkeen-ui/static/frontend-build"
    (build / ".vite").mkdir(parents=True)
    (build / ".vite/manifest.build.json").write_text("{}", encoding="utf-8")
    (build / ".vite/manifest.json").write_text("{}", encoding="utf-8")
    lay_module_manifest(panel_source_root / "xkeen-ui", MODULE_ID, "resource_monitor-AbCd1234.js")
    module_dir = build / "modules" / MODULE_ID
    module_dir.mkdir(parents=True)
    (module_dir / "resource_monitor-AbCd1234.js").write_text("", encoding="utf-8")
    (module_dir / "resource_monitor-AbCd1234.js.gz").write_text("", encoding="utf-8")

    ownership = builder.build_module_ownership(panel_source_root)

    assert MODULE_BUILD_FILES <= set(ownership[MODULE_ID])
    assert not MODULE_BUILD_FILES & set(ownership["core"])

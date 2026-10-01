from __future__ import annotations

import json
import re
from pathlib import Path

from tests.support.panel_render import (
    FULL_MODULE_IDS,
    MIHOMO_MINIMAL_MODULE_IDS,
    XRAY_MINIMAL_MODULE_IDS,
    render_panel,
)


ROOT = Path(__file__).resolve().parents[1]
PAGES = ROOT / "xkeen-ui" / "static" / "js" / "pages"


def _panel_config(html: str) -> dict[str, object]:
    match = re.search(r"var pageConfig = (\{.*?\});\s*window\.XKeen\.pageConfig", html, re.DOTALL)
    assert match, "panel page config must be published"
    return json.loads(match.group(1))


def _bundle_keys(config: dict[str, object]) -> set[str]:
    frontend_modules = config["frontendModules"]
    assert isinstance(frontend_modules, dict)
    bundles = frontend_modules["bundles"]
    assert isinstance(bundles, list)
    return {str(bundle["key"]) for bundle in bundles if isinstance(bundle, dict)}


def test_xray_minimal_page_config_excludes_mihomo_bundle(tmp_path):
    config = _panel_config(render_panel(XRAY_MINIMAL_MODULE_IDS, tmp_path))

    assert _bundle_keys(config) >= {"panel-core", "panel-routing", "editor-runtime"}
    assert "panel-mihomo" not in _bundle_keys(config)

    frontend_modules = config["frontendModules"]
    assert isinstance(frontend_modules, dict)
    for bundle in frontend_modules["bundles"]:
        assert isinstance(bundle, dict)
        assert "path" not in bundle
        assert "import" not in bundle


def test_mihomo_minimal_page_config_excludes_xray_bundle(tmp_path):
    config = _panel_config(render_panel(MIHOMO_MINIMAL_MODULE_IDS, tmp_path))

    assert _bundle_keys(config) >= {"panel-core", "panel-mihomo", "editor-runtime"}
    assert "panel-routing" not in _bundle_keys(config)


def test_full_and_legacy_publish_equal_frontend_descriptors(tmp_path):
    legacy = _panel_config(render_panel(None, tmp_path / "legacy"))
    full = _panel_config(render_panel(FULL_MODULE_IDS, tmp_path / "full"))

    assert legacy["frontendModules"] == full["frontendModules"]


def test_loader_uses_a_local_allowlist_not_server_import_specifiers():
    source = (PAGES / "panel.module_loader.js").read_text(encoding="utf-8")

    assert "const BUNDLE_LOADERS = Object.freeze" in source
    assert "() => import(" in source
    assert "import(descriptor" not in source
    assert "frontendModules" in source


def test_panel_bootstrap_delegates_engine_bundles_to_loader():
    source = (PAGES / "panel.screen.bootstrap.js").read_text(encoding="utf-8")

    assert "ensurePanelModule('panel-routing', 'startup')" in source
    assert "ensurePanelModule('panel-mihomo', 'startup')" in source
    assert "await import('./panel.routing.bundle.js')" not in source
    assert "await import('./panel.mihomo.bundle.js')" not in source

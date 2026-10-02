from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

from tests.support.panel_render import (
    FULL_MODULE_IDS,
    MIHOMO_MINIMAL_MODULE_IDS,
    XRAY_MINIMAL_MODULE_IDS,
    render_panel,
)


ROOT = Path(__file__).resolve().parents[1]
PAGES = ROOT / "xkeen-ui" / "static" / "js" / "pages"
E2E_SERVER = ROOT / "scripts" / "run_e2e_server.py"
STAGE5_GENERATOR = ROOT / "scripts" / "generate_modular_panel_stage5_frontend_loading.py"
STAGE5_SNAPSHOT = ROOT / "docs" / "modular-panel-stage5-frontend-loading.json"
STAGE5_E2E = ROOT / "e2e" / "modular_panel_dynamic_loading.spec.mjs"


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
    assert "ensurePanelModule('editor-runtime', 'startup')" not in source


def test_panel_view_and_watcher_do_not_statically_import_optional_modules():
    view_runtime = (PAGES / "panel.view_runtime.js").read_text(encoding="utf-8")
    watcher = (PAGES / "panel.core_ui_watch.runtime.js").read_text(encoding="utf-8")

    assert "ensurePanelModuleForView(viewName)" in view_runtime
    assert "../features/mihomo_panel.js" not in view_runtime
    assert "../features/file_manager.js" not in view_runtime
    assert "../features/mihomo_panel.js" not in watcher
    assert "../features/file_manager.js" not in watcher


def test_panel_view_runtime_stops_on_inactive_or_missing_root_loader_results():
    source = (PAGES / "panel.view_runtime.js").read_text(encoding="utf-8")

    assert "if (!loaded || loaded.status !== 'ready') return loaded;" in source


def test_xray_shell_facades_are_not_in_the_static_panel_entry_graph():
    bootstrap = (PAGES / "panel.screen.bootstrap.js").read_text(encoding="utf-8")
    shell = (PAGES / "panel_shell.shared.js").read_text(encoding="utf-8")
    lazy_bindings = (PAGES / "panel.lazy_bindings.runtime.js").read_text(encoding="utf-8")

    assert "./config_shell.shared.js" not in bootstrap
    assert "./logs_shell.shared.js" not in bootstrap
    assert "./logs_shell.shared.js" not in shell
    assert "./config_shell.shared.js" not in lazy_bindings


def test_terminal_css_is_not_initial_html_and_is_loader_owned(tmp_path):
    html = render_panel(FULL_MODULE_IDS, tmp_path)
    loader = (PAGES / "panel.module_loader.js").read_text(encoding="utf-8")

    assert "xterm/xterm.css" not in html
    assert "xterm/xterm.css" in loader
    assert "data-xk-module-css" in loader
    assert "if (!descriptor || !hasOwnedRoot(descriptor.domRoots)) return false;" in loader


def test_panel_terminal_actions_use_the_module_loader_boundary():
    lazy_bindings = (PAGES / "panel.lazy_bindings.runtime.js").read_text(encoding="utf-8")

    assert "ensurePanelModule('terminal-lazy', 'terminal-action')" in lazy_bindings
    assert "api.ensureTerminalReady" not in lazy_bindings


def test_editor_runtime_is_loaded_only_through_editor_support():
    bootstrap = (PAGES / "panel.screen.bootstrap.js").read_text(encoding="utf-8")
    lazy_bindings = (PAGES / "panel.lazy_bindings.runtime.js").read_text(encoding="utf-8")

    assert "editor-runtime" not in bootstrap
    assert "ensurePanelModule('editor-runtime', 'editor-support')" in lazy_bindings


def test_view_runtime_loads_editor_support_before_a_screen_initialises():
    # Screens build their editors during init and fall back to a plain textarea
    # when the editor helpers are missing, so the request has to come first.
    source = (PAGES / "panel.view_runtime.js").read_text(encoding="utf-8")

    ensure = "await ensurePanelEditorSupport('codemirror');"
    assert source.count(ensure) == 1
    assert source.index(ensure) < source.index("initViewOnce('mihomo'")
    assert source.index(ensure) < source.index("initViewOnce('routing'")


def test_e2e_fixture_seeds_module_profile_before_flask_starts():
    source = E2E_SERVER.read_text(encoding="utf-8")

    assert "XKEEN_E2E_MODULE_PROFILE" in source
    assert 'STATE_DIR / "modules.json"' in source
    assert "module_profile" in source
    assert "def _e2e_run_namespace()" in source
    assert 'REPO_ROOT / ".tmp" / "e2e-runs"' in source


def test_playwright_auth_state_is_profile_and_port_scoped():
    config = (ROOT / "playwright.config.mjs").read_text(encoding="utf-8")
    setup = (ROOT / "e2e" / "global-setup.mjs").read_text(encoding="utf-8")

    assert "user-${E2E_PROFILE}-${E2E_PORT}.json" in config
    assert "function e2eRunNamespace()" in setup
    assert "user-${e2eRunNamespace()}.json" in setup


def test_restart_log_uses_page_runtime_and_module_ownership_before_opening_events_ws():
    source = (ROOT / "xkeen-ui" / "static" / "js" / "features" / "restart_log.js").read_text(encoding="utf-8")

    assert "function canUseRestartLogWs()" in source
    assert "if (!canUseRestartLogWs()) return;" in source
    assert "pageConfig?.runtime" in source
    assert "runtime.websocket === false" in source
    assert "'tool.terminal'" in source
    assert "'engine.xray'" in source
    assert "'engine.mihomo'" in source


def test_e2e_server_does_not_advertise_websocket_without_a_websocket_server():
    source = E2E_SERVER.read_text(encoding="utf-8")

    assert 'env["XKEEN_WS_RUNTIME"] = "0"' in source


def _generate_stage5(tmp_path: Path) -> dict[str, object]:
    output = tmp_path / "modular-panel-stage5-frontend-loading.json"
    result = subprocess.run(
        [sys.executable, str(STAGE5_GENERATOR), "--root", str(ROOT), "--json-out", str(output)],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr or result.stdout
    return json.loads(output.read_text(encoding="utf-8"))


def test_stage5_frontend_loading_snapshot_is_current(tmp_path):
    assert STAGE5_SNAPSHOT.is_file()
    assert json.loads(STAGE5_SNAPSHOT.read_text(encoding="utf-8")) == _generate_stage5(tmp_path)


def test_stage5_e2e_records_network_websocket_and_console_boundaries():
    source = STAGE5_E2E.read_text(encoding="utf-8")

    assert "page.on('request'" in source
    assert "page.on('websocket'" in source
    assert "page.on('console'" in source
    assert "XKEEN_E2E_MODULE_PROFILE" in source
    assert "data-xk-module-css" in source

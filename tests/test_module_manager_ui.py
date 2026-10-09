"""Core-owned Modules screen route and host contract."""

import json

from tests.support.panel_render import ROOT, build_panel_app


PAGES = ROOT / "xkeen-ui" / "static" / "js" / "pages"
MANAGER = ROOT / "xkeen-ui" / "static" / "js" / "features" / "module_manager"


def test_modules_page_is_core_owned_and_uses_its_canonical_entry(tmp_path, monkeypatch):
    monkeypatch.setenv("XKEEN_UI_FRONTEND_SOURCE_FALLBACK", "1")
    app = build_panel_app(["core"], tmp_path)
    app.extensions["xkeen_ui_assets"].static_folder = str(tmp_path)
    response = app.test_client().get("/modules")

    assert response.status_code == 200
    html = response.get_data(as_text=True)
    assert 'data-xk-top-level-screen="modules"' in html
    assert 'src="/static/js/pages/modules.entry.js?v=0"' in html
    assert 'window.XKeen.pageConfig = pageConfig;' in html
    assert "frontend_page_entry_url('modules')" in (ROOT / "xkeen-ui/templates/modules.html").read_text(encoding="utf-8")
    assert "devtools.screen.bootstrap.js" not in html
    assert 'href="/"' in html
    assert 'href="/devtools"' not in html
    assert 'href="/modules"' in app.test_client().get("/").get_data(as_text=True)


def test_modules_page_renders_production_build_entry(tmp_path, monkeypatch):
    monkeypatch.setenv("XKEEN_UI_FRONTEND_SOURCE_FALLBACK", "0")
    build_root = tmp_path / "frontend-build"
    manifest = build_root / ".vite" / "manifest.json"
    bridge = build_root / "assets" / "modules-bridge.js"
    other_bridge = build_root / "assets" / "panel-bridge.js"
    manifest.parent.mkdir(parents=True)
    bridge.parent.mkdir(parents=True)
    manifest.write_text(json.dumps({
        "static/js/pages/modules.entry.js": {"file": "assets/modules-bridge.js"},
        "static/js/pages/panel.entry.js": {"file": "assets/panel-bridge.js"},
    }), encoding="utf-8")
    bridge.write_text("export {};\n", encoding="utf-8")
    other_bridge.write_text("export {};\n", encoding="utf-8")

    app = build_panel_app(["core"], tmp_path)
    app.extensions["xkeen_ui_assets"].static_folder = str(tmp_path)
    response = app.test_client().get("/modules")

    assert response.status_code == 200
    assert 'src="/static/frontend-build/assets/modules-bridge.js?v=' in response.get_data(as_text=True)


def test_top_level_registry_exposes_modules_route_and_core_navigation():
    registry = (PAGES / "top_level_screen_registry.js").read_text(encoding="utf-8")
    panel_routes = (ROOT / "xkeen-ui/routes/pages.py").read_text(encoding="utf-8")

    assert "modules: '/modules'" in registry
    assert 'href_endpoint="modules_page", top_nav=True' in panel_routes
    assert '"modules": "js/pages/modules.entry.js"' in (ROOT / "xkeen-ui/routes/ui_assets.py").read_text(encoding="utf-8")
    assert "modules: path.resolve(pageDir, 'modules.entry.js')" in (ROOT / "vite.config.mjs").read_text(encoding="utf-8")


def test_modules_screen_has_a_lifecycle_adapter_and_accessible_shell():
    template = (ROOT / "xkeen-ui/templates/modules.html").read_text(encoding="utf-8")
    screen = (PAGES / "top_level_modules_screen.js").read_text(encoding="utf-8")
    bootstrap = (PAGES / "modules.screen.bootstrap.js").read_text(encoding="utf-8")
    init = (PAGES / "modules.init.js").read_text(encoding="utf-8")

    assert 'id="xk-modules-manager"' in template
    assert 'aria-live="polite"' in template
    assert 'id="modules-error"' in template
    assert 'aria-live="assertive"' in template
    assert 'role="tablist"' in template
    assert 'id="modules-plan-confirm"' in template
    assert 'id="modules-plan-cancel"' in template
    assert 'id="modules-plan-apply"' in template
    assert "createScreenActivationTracker()" in screen
    assert "detachScreenRoot(snapshot)" in screen
    assert "bootModulesScreen" in bootstrap
    assert "getModulesTopLevelApi" in bootstrap
    assert "wireTopLevelNavigation(document)" in init


def test_modules_uses_the_panel_shell_and_stable_devtools_pointer_is_compact():
    template = (ROOT / "xkeen-ui/templates/modules.html").read_text(encoding="utf-8")
    manager_css = (ROOT / "xkeen-ui/static/modules-manager.css").read_text(encoding="utf-8")
    devtools_update = (ROOT / "xkeen-ui/static/js/features/devtools/update.js").read_text(encoding="utf-8")
    devtools_css = (ROOT / "xkeen-ui/static/devtools.css").read_text(encoding="utf-8")

    assert '<body class="modules-page"' in template
    assert '<body class="modules-page panel-page"' not in template
    assert 'class="modules-workspace"' in template
    assert "body.modules-page .container-wide" in manager_css
    assert "body.modules-page.panel-page" not in manager_css
    assert "dt-update-card--modules-manager" in devtools_update
    assert "#dt-update-card.dt-update-card--modules-manager" in devtools_css


def test_manager_source_is_isolated_and_entry_stays_thin():
    sources = [path.read_text(encoding="utf-8") for path in MANAGER.glob("*.js")]
    assert sources
    assert all("features/devtools/" not in source for source in sources)
    assert all("features/compat/devtools.js" not in source for source in sources)
    entry = (PAGES / "modules.entry.js").read_text(encoding="utf-8")
    assert "bootTopLevelShell" in entry
    assert "bootModulesScreen" in entry
    assert "/api/modules/" not in entry


def test_stable_devtools_update_is_a_modules_link_not_a_second_runner():
    source = (ROOT / "xkeen-ui/static/js/features/devtools/update.js").read_text(encoding="utf-8")
    notifier = (ROOT / "xkeen-ui/static/js/features/update_notifier.js").read_text(encoding="utf-8")

    assert "openModulesManager" in source
    assert "startLegacyMainUpdater" in source
    assert "stable" in notifier and "_stopSchedule" in notifier


def test_idle_operation_status_does_not_refer_to_restart_state():
    source = (MANAGER / "render.js").read_text(encoding="utf-8")

    assert "if (!status || status.result === 'idle') return;" in source

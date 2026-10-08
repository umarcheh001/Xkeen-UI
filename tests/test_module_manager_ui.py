"""Core-owned Modules screen route and host contract."""

from tests.support.panel_render import ROOT, build_panel_app


PAGES = ROOT / "xkeen-ui" / "static" / "js" / "pages"
MANAGER = ROOT / "xkeen-ui" / "static" / "js" / "features" / "module_manager"


def test_modules_page_is_core_owned_and_uses_its_canonical_entry(tmp_path, monkeypatch):
    monkeypatch.setenv("XKEEN_UI_FRONTEND_SOURCE_FALLBACK", "1")
    app = build_panel_app(["core"], tmp_path)
    response = app.test_client().get("/modules")

    assert response.status_code == 200
    html = response.get_data(as_text=True)
    assert 'data-xk-top-level-screen="modules"' in html
    assert 'window.XKeen.pageConfig = pageConfig;' in html
    assert "frontend_page_entry_url('modules')" in (ROOT / "xkeen-ui/templates/modules.html").read_text(encoding="utf-8")
    assert "devtools.screen.bootstrap.js" not in html
    assert 'href="/"' in html
    assert 'href="/devtools"' not in html
    assert 'href="/modules"' in app.test_client().get("/").get_data(as_text=True)


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
    assert 'role="tablist"' in template
    assert 'id="modules-plan-confirm"' in template
    assert 'id="modules-plan-cancel"' in template
    assert 'id="modules-plan-apply"' in template
    assert "createScreenActivationTracker()" in screen
    assert "detachScreenRoot(snapshot)" in screen
    assert "bootModulesScreen" in bootstrap
    assert "getModulesTopLevelApi" in bootstrap
    assert "wireTopLevelNavigation(document)" in init


def test_manager_source_is_isolated_and_entry_stays_thin():
    sources = [path.read_text(encoding="utf-8") for path in MANAGER.glob("*.js")]
    assert sources
    assert all("features/devtools/" not in source for source in sources)
    assert all("features/compat/devtools.js" not in source for source in sources)
    entry = (PAGES / "modules.entry.js").read_text(encoding="utf-8")
    assert "bootTopLevelShell" in entry
    assert "bootModulesScreen" in entry
    assert "/api/modules/" not in entry

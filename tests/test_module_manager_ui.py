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
    assert 'href="/devtools"' in html  # DevTools is core, like this page
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
    assert '@app.get("/modules")' in panel_routes
    header = (ROOT / "xkeen-ui/templates/panel/header.html").read_text(encoding="utf-8")
    assert "url_for('modules_page')" in header and 'data-xk-top-nav="1"' in header
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
    shell_css = (ROOT / "xkeen-ui/static/page-shell.css").read_text(encoding="utf-8")

    assert 'class="modules-workspace"' in template
    # Ширина и кнопки шапки — общие с DevTools и генератором Mihomo.
    assert "container container-wide xk-page-container" in template
    assert "xk-page-header" in template
    assert "filename='page-shell.css'" in template
    assert "body.modules-page .container-wide" not in manager_css
    assert ".modules-header-main .header-actions" not in manager_css
    assert "body.modules-page.panel-page" not in manager_css
    assert "createModuleLifecycleClient" in devtools_update
    # Сводка о панели одна на шапку модулей и карточку DevTools.
    assert "from '../panel_summary.js'" in devtools_update
    assert ":root body .xk-summary-stats," in shell_css
    assert 'data-xk-devtools-available=' in template
    assert 'id="confirm-modal"' in template
    assert 'class="modules-update-channel"' not in template
    assert ".modules-channel-switch" not in manager_css
    assert ".modules-update-check" not in manager_css


def test_manager_source_is_isolated_and_entry_stays_thin():
    sources = [path.read_text(encoding="utf-8") for path in MANAGER.glob("*.js")]
    assert sources
    assert all("features/devtools/" not in source for source in sources)
    assert all("features/compat/devtools.js" not in source for source in sources)
    entry = (PAGES / "modules.entry.js").read_text(encoding="utf-8")
    assert "bootTopLevelShell" in entry
    assert "bootModulesScreen" in entry
    assert "/api/modules/" not in entry


def test_manager_shows_the_module_version_not_the_catalog_entry_version():
    source = (MANAGER / "render.js").read_text(encoding="utf-8")

    # The catalog entry's own `version` is the panel release; the screen says
    # what the module itself is at.
    assert "item.module_version" in source
    assert source.count("item.module_version") >= 2


def test_stable_devtools_update_is_a_modules_link_not_a_second_runner():
    source = (ROOT / "xkeen-ui/static/js/features/devtools/update.js").read_text(encoding="utf-8")

    # The card starts nothing by itself. That it asks the old update API for
    # nothing and holds one link to the Modules screen is checked in a browser.
    assert "api.plan(" not in source and "api.apply(" not in source
    assert not (ROOT / "xkeen-ui/static/js/features/update_notifier.js").exists()


def test_download_speed_is_said_in_megabits():
    source = (MANAGER / "render.js").read_text(encoding="utf-8")

    # Providers sell megabits a second: the speed is said the same way, sizes stay in megabytes.
    assert "Мбит/с" in source
    assert "МБ/с" not in source


def test_module_update_notification_leads_to_the_modules_screen():
    source = (ROOT / "xkeen-ui/static/js/features/notification_center.js").read_text(encoding="utf-8")

    assert "module_update_available" in source

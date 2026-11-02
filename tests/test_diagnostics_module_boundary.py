"""DevTools belongs to core; tool.advanced-diagnostics is the window and its history."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import pytest

from scripts import build_modular_panel_release as builder
from services.module_registry import _MODULE_INSTALL_MARKERS, MODULE_DEFINITIONS
from tests.support.panel_render import ROOT, XRAY_MINIMAL_MODULE_IDS, build_panel_app
from tests.test_module_backend_gates import _register


MODULE_ID = "tool.advanced-diagnostics"


def owner(path: str) -> str:
    return builder._stage7_module().owner(path)


def definition(module_id: str):
    return next(item for item in MODULE_DEFINITIONS if item.id == module_id)


def page_config(html: str) -> dict:
    return json.loads(re.search(r"var pageConfig = (\{.*\});", html).group(1))


@pytest.fixture
def app_without_diagnostics(tmp_path: Path):
    return build_panel_app(XRAY_MINIMAL_MODULE_IDS, tmp_path)


@pytest.fixture
def ownership(shared_panel_source_root: Path) -> dict[str, tuple[str, ...]]:
    return builder.build_module_ownership(shared_panel_source_root)


def test_devtools_page_belongs_to_core() -> None:
    for path in (
        "templates/devtools.html",
        "static/js/pages/devtools.entry.js",
        "static/js/pages/devtools.init.js",
        "static/js/features/devtools.js",
        "static/js/features/devtools/update.js",
        "static/frontend-build/assets/devtools-Bj4Uvh59.js",
        "static/frontend-build/assets/devtools-bridge.js",
        "routes/devtools.py",
    ):
        assert owner(path) == "core", path


def test_diagnostics_window_belongs_to_module() -> None:
    for path in (
        "static/js/features/resource_monitor.js",
        "static/js/features/resource_monitor_model.js",
        "static/js/features/resource_monitor/dashboard.js",
        "static/frontend-build/assets/resource_monitor-CkGHKoVT.js",
        "routes/system_resources.py",
        "services/system_resources_history/collector.py",
        "templates/panel/modals/diagnostics.html",
        "templates/panel/slots/diagnostics_summary.html",
    ):
        assert owner(path) == MODULE_ID, path


def test_ownership_map_keeps_the_boundary_after_import_closure(ownership) -> None:
    module_files = set(ownership[MODULE_ID])
    core_files = set(ownership["core"])

    for path in (
        "static/js/features/resource_monitor.js",
        "static/js/features/resource_monitor_model.js",
        "static/js/features/resource_monitor/dashboard.js",
        "routes/system_resources.py",
        "services/system_resources_history/collector.py",
        "templates/panel/modals/diagnostics.html",
    ):
        assert path in module_files, path
    for path in (
        "templates/devtools.html",
        "templates/panel/slots/resource_monitor_unavailable.html",
        "static/js/pages/devtools.entry.js",
        "static/js/pages/top_level_devtools_screen.js",
        "static/js/features/devtools.js",
        "static/js/features/devtools/update.js",
        "static/js/features/devtools/happ_decryptor.js",
        "routes/devtools.py",
    ):
        assert path in core_files, path
    assert not [path for path in module_files if "devtools" in path]


def test_shared_diagnostics_services_stay_in_core(ownership) -> None:
    for path in (
        "services/router_diagnostics.py",
        "services/system_resources.py",
        "services/system_resources_history/sensors.py",
    ):
        assert owner(path) == "core", path
        assert path in ownership["core"], path
        assert builder._PACKAGE_OWNER_OVERRIDES[path] == "core", path


def test_devtools_link_of_the_panel_header_belongs_to_core(ownership) -> None:
    path = "templates/panel/slots/diagnostics_actions.html"
    assert owner(path) == "core"
    assert path in ownership["core"]


def test_module_install_markers_point_at_the_window_and_the_history() -> None:
    installer = builder._stage7_module()
    expected = ("routes/system_resources.py", "static/js/features/resource_monitor.js")

    assert installer.INSTALL_MARKERS[MODULE_ID] == expected
    assert _MODULE_INSTALL_MARKERS[MODULE_ID] == tuple("xkeen-ui/" + path for path in expected)
    for marker in _MODULE_INSTALL_MARKERS[MODULE_ID]:
        assert (ROOT / marker).is_file(), marker


def test_registry_gives_the_devtools_page_to_core() -> None:
    core, module = definition("core"), definition(MODULE_ID)

    assert "devtools-page" in core.frontend_bundles
    assert "devtools" in core.navigation_views
    assert module.frontend_bundles == ("diagnostics-panel",)
    assert module.navigation_views == ()
    assert module.description == "Окно диагностики роутера: графики, история и события."


def test_devtools_page_opens_without_diagnostics_module(app_without_diagnostics) -> None:
    response = app_without_diagnostics.test_client().get("/devtools")

    assert response.status_code == 200
    assert 'id="dt-update-card"' in response.get_data(as_text=True)


def test_panel_links_devtools_without_diagnostics_module(app_without_diagnostics) -> None:
    html = app_without_diagnostics.test_client().get("/").get_data(as_text=True)
    config = page_config(html)

    assert "devtools" in config["sections"]["panelWhitelist"].split(",")
    assert 'class="service-core-text xk-header-btn xk-header-btn-devtools"' in html
    # hasDiagnostics of the plan: pageConfig tells the module apart by its frontend entry.
    assert "diagnostics-panel" not in json.dumps(config["frontendModules"])
    assert 'id="xk-resource-monitor"' not in html
    assert 'id="xk-resource-dashboard-modal"' not in html
    assert 'id="xk-resource-monitor-install-offer"' in html


def test_devtools_api_answers_without_diagnostics_module(tmp_path: Path) -> None:
    # The cards of the page talk to these routes, and the page no longer goes
    # away together with the module.
    client = _register(tmp_path, XRAY_MINIMAL_MODULE_IDS).test_client()

    for path in ("/api/devtools/env", "/api/devtools/branding", "/api/devtools/logs", "/api/devtools/ui/status"):
        assert client.get(path).status_code == 200, path


@pytest.mark.parametrize("module_ids", [["core"], XRAY_MINIMAL_MODULE_IDS], ids=["core-only", "xray-minimal"])
def test_devtools_log_stream_is_registered_without_diagnostics_module(tmp_path: Path, module_ids) -> None:
    app = _register(tmp_path, module_ids)

    assert "/ws/devtools-logs" in {rule.rule for rule in app.url_map.iter_rules()}
    # Without a WebSocket server the route answers, it does not refuse the module.
    response = app.test_client().get("/ws/devtools-logs?name=core")
    assert response.status_code != 404
    assert response.get_data(as_text=True) != "Not Found"


@pytest.fixture
def sampled_resources(monkeypatch):
    import routes.devtools

    monkeypatch.setattr(
        routes.devtools,
        "sample_system_resources",
        lambda: {"sampled_at": 10, "cpu": {"percent": 56.0}, "memory": {"percent": 48.0}},
    )
    monkeypatch.setattr(routes.devtools, "cached_router_diagnostics", lambda: {"internet": {"available": False}})
    monkeypatch.setattr(routes.devtools, "cached_router_system", lambda: {"available": False})


def test_resource_summary_has_empty_zones_without_diagnostics_module(tmp_path: Path, sampled_resources) -> None:
    client = _register(tmp_path, XRAY_MINIMAL_MODULE_IDS).test_client()

    response = client.get("/api/system/resources")

    assert response.status_code == 200
    assert response.get_json()["zones"] == {}


def test_resource_summary_survives_missing_zones_file(tmp_path: Path, sampled_resources, monkeypatch) -> None:
    client = _register(tmp_path, [*XRAY_MINIMAL_MODULE_IDS, MODULE_ID]).test_client()
    # The module counts as active, but its files are gone.
    monkeypatch.setitem(sys.modules, "services.system_resources_history.zones", None)

    response = client.get("/api/system/resources")

    assert response.status_code == 200
    assert response.get_json()["zones"] == {}


def test_resource_summary_keeps_zones_with_diagnostics_module(tmp_path: Path, sampled_resources) -> None:
    client = _register(tmp_path, [*XRAY_MINIMAL_MODULE_IDS, MODULE_ID]).test_client()

    assert set(client.get("/api/system/resources").get_json()["zones"]) == {"cpu", "memory"}

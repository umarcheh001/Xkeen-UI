"""tool.server-diagnostics on the page and the server: nothing without the module, a clear refusal without an engine."""

from __future__ import annotations

import ast
import json
import re
import sys
from pathlib import Path

import pytest

from services import provider_diagnostics
from services.provider_diagnostics import EngineUnavailable, parse_source
from tests.support.panel_render import FULL_MODULE_IDS, ROOT, render_panel
from tests.test_module_backend_gates import _register


MODULE_ID = "tool.server-diagnostics"
WITH = [*FULL_MODULE_IDS, MODULE_ID]
SERVICE = ROOT / "xkeen-ui" / "services" / "provider_diagnostics.py"
# What the module takes from the engines. A rename inside an engine must fail
# here, not in the module on a router.
ENGINE_IMPORTS = [
    ("services.amnezia_premium", "import_connection_key"),
    ("services.mihomo_proxy_parsers", "_yaml_append_list_item"),
    ("services.mihomo_proxy_parsers", "_yaml_str"),
    ("services.mihomo_proxy_parsers", "parse_openvpn"),
    ("services.mihomo_proxy_parsers", "parse_proxy_uri"),
    ("services.mihomo_proxy_parsers", "parse_tailscale"),
    ("services.mihomo_proxy_parsers", "parse_wireguard"),
    ("services.mihomo_runtime", "_mihomo_binary"),
    ("services.xray_observatory", "DEFAULT_PROBE_URL"),
    ("services.xray_outbounds", "build_proxy_outbound_from_link"),
    ("services.xray_subscriptions", "_build_batch_probe_config"),
    ("services.xray_subscriptions", "_find_xray_binary"),
    ("services.xray_subscriptions", "_probe_once_via_local_proxy"),
    ("services.xray_subscriptions", "_probe_outbounds_batch"),
    ("services.xray_subscriptions", "_reserve_local_port"),
    ("services.xray_subscriptions", "_start_probe_process"),
    ("services.xray_subscriptions", "_terminate_process"),
    ("services.xray_subscriptions", "_wait_for_local_port"),
    ("services.xray_subscriptions", "build_subscription_json_outbounds"),
    ("services.xray_subscriptions", "fetch_subscription_body_for_xray"),
    ("services.xray_subscriptions", "parse_subscription_links"),
]


def page_config(html: str) -> dict:
    return json.loads(re.search(r"var pageConfig = (\{.*\});", html).group(1))


def _api_status(module_ids, tmp_path: Path) -> int:
    rules = {rule.rule for rule in _register(tmp_path, list(module_ids)).url_map.iter_rules()}
    return 200 if "/api/provider-diagnostics/targets" in rules else 404


def test_panel_without_module_has_no_window_buttons_styles_or_api(tmp_path):
    html = render_panel(FULL_MODULE_IDS, tmp_path / "page")
    assert 'id="provider-check-modal"' not in html
    assert "xk-provider-check-trigger" not in html
    assert "server-diagnostics.css" not in html
    assert page_config(html)["flags"]["hasServerDiagnostics"] is False
    assert _api_status(FULL_MODULE_IDS, tmp_path / "api") == 404


def test_panel_with_module_has_window_both_buttons_and_styles(tmp_path):
    html = render_panel(WITH, tmp_path)
    assert 'id="provider-check-modal"' in html
    assert 'data-provider-check-core="xray"' in html
    assert 'data-provider-check-core="mihomo"' in html
    assert "server-diagnostics.css" in html
    assert page_config(html)["flags"]["hasServerDiagnostics"] is True


def test_buttons_follow_their_engine(tmp_path):
    html = render_panel(["core", "tool.editor", "engine.mihomo", MODULE_ID], tmp_path)
    assert 'data-provider-check-core="mihomo"' in html
    assert 'data-provider-check-core="xray"' not in html


def test_module_without_engines_registers_nothing(tmp_path):
    ids = ["core", MODULE_ID]
    html = render_panel(ids, tmp_path / "page")
    assert "xk-provider-check-trigger" not in html
    assert page_config(html)["flags"]["hasServerDiagnostics"] is False
    assert _api_status(ids, tmp_path / "api") == 404


def _bundle_keys(html: str) -> set[str]:
    return {bundle["key"] for bundle in page_config(html)["frontendModules"]["bundles"]}


def test_window_bundle_loads_only_with_an_engine(tmp_path):
    # Without Xray and Mihomo there is nothing to check: the window is not loaded.
    assert "server-diagnostics-panel" not in _bundle_keys(render_panel(["core", MODULE_ID], tmp_path / "none"))
    assert "server-diagnostics-panel" in _bundle_keys(
        render_panel(["core", "tool.editor", "engine.mihomo", MODULE_ID], tmp_path / "mihomo")
    )
    assert "server-diagnostics-panel" not in _bundle_keys(render_panel(FULL_MODULE_IDS, tmp_path / "without"))


def test_module_api_answers_with_module(tmp_path):
    assert _api_status(WITH, tmp_path) != 404


def test_vless_link_without_xray_is_refused_not_crashed(monkeypatch):
    monkeypatch.setitem(sys.modules, "services.xray_outbounds", None)
    with pytest.raises(EngineUnavailable, match="нужен модуль Xray"):
        parse_source("vless://00000000-0000-0000-0000-000000000000@example.com:443", allow_fetch=False, core="mihomo")


def test_mihomo_proxy_probe_without_xray_says_what_is_missing(monkeypatch):
    # The Mihomo probe borrows the local proxy helpers of the Xray module. On a
    # Mihomo-only router a retry never helps, so the answer must name the module.
    monkeypatch.setitem(sys.modules, "services.xray_observatory", None)
    monkeypatch.setitem(sys.modules, "services.xray_subscriptions", None)
    token = provider_diagnostics.register_proxy_context(
        [{"_diagnostics_engine": "mihomo", "name": "node", "type": "ss", "server": "example.com", "port": 443}], 1
    )
    with pytest.raises(EngineUnavailable, match="нужен модуль Xray"):
        provider_diagnostics.probe_proxy_context(token, 0)


def test_engine_refusal_is_a_value_error_the_routes_turn_into_400():
    assert issubclass(EngineUnavailable, ValueError)


def test_engine_names_used_by_module_are_listed():
    tree = ast.parse(SERVICE.read_text(encoding="utf-8"))
    found = sorted(
        {
            (node.module, alias.name)
            for node in ast.walk(tree)
            if isinstance(node, ast.ImportFrom) and node.module and node.module.startswith("services.")
            for alias in node.names
        }
    )
    assert found == ENGINE_IMPORTS
    for module_name, name in ENGINE_IMPORTS:
        module = __import__(module_name, fromlist=[name])
        assert hasattr(module, name), (module_name, name)


def test_guard_is_on_every_entry_point_that_reaches_an_engine():
    for name in ("parse_source", "probe_proxy_context", "compare_resource_paths"):
        assert getattr(getattr(provider_diagnostics, name), "__wrapped__", None) is not None, name

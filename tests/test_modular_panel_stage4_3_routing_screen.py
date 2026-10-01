from __future__ import annotations

import re
from pathlib import Path

from routes.pages import PANEL_COMPOSITION
from scripts.panel_template_source import compose_panel_template


ROOT = Path(__file__).resolve().parents[1]
PANEL = ROOT / "xkeen-ui/templates/panel.html"
ROUTING = ROOT / "xkeen-ui/templates/panel/screens/routing.html"


def test_routing_screen_is_owned_by_engine_xray_partial():
    panel = PANEL.read_text(encoding="utf-8")
    routing = ROUTING.read_text(encoding="utf-8")

    assert "{% for screen_partial in page_context.screen_partials %}" in panel
    assert "{% include screen_partial %}" in panel
    assert 'id="view-routing"' not in panel
    assert [
        entry.owners
        for entry in PANEL_COMPOSITION
        if entry.template == "panel/screens/routing.html"
    ] == [("engine.xray",)]
    assert '{% if has_xray %}' not in routing
    assert 'id="view-routing"' in routing
    assert 'data-xk-section="routing"' in routing
    assert 'id="view-mihomo"' not in routing


def test_routing_screen_composition_preserves_dom_contract():
    source = compose_panel_template(ROOT)

    assert source.count('id="view-routing"') == 1
    assert source.count('data-xk-section="routing"') >= 1
    assert source.index('id="view-routing"') < source.index('id="view-mihomo"')
    for required_id in (
        "routing-dat-header",
        "inbounds-header",
        "routing-scenario-header",
        "outbounds-header",
        "routing-rules-card",
        "routing-editor-card",
        "routing-status",
    ):
        assert f'id="{required_id}"' in source

    ids = re.findall(r'\bid=["\']([^"\']+)["\']', source)
    assert len(ids) == len(set(ids))


def test_routing_screen_closure_is_documented():
    plan = (ROOT / "README-modular-panel-plan.md").read_text(encoding="utf-8")
    contract = (
        ROOT / "docs/modular-panel-stage4.3-routing-screen.md"
    ).read_text(encoding="utf-8")
    index = (ROOT / "docs/README.md").read_text(encoding="utf-8")

    assert "Routing screen: **закрыт 30 сентября 2026 года**" in plan
    assert "modular-panel-stage4.3-routing-screen.md" in plan
    assert "modular-panel-stage4.3-routing-screen.md" in index
    assert "Критерий завершения **выполнен**" in contract

from __future__ import annotations

import re
from pathlib import Path

from routes.pages import PANEL_COMPOSITION
from scripts.panel_template_source import compose_panel_template
from tests.support.panel_render import (
    MIHOMO_MINIMAL_MODULE_IDS,
    XRAY_MINIMAL_MODULE_IDS,
    render_panel,
)


ROOT = Path(__file__).resolve().parents[1]
PANEL = ROOT / "xkeen-ui/templates/panel.html"
XKEEN = ROOT / "xkeen-ui/templates/panel/screens/xkeen.html"


def test_xkeen_screen_is_a_core_owned_partial_without_module_gate():
    panel = PANEL.read_text(encoding="utf-8")
    xkeen = XKEEN.read_text(encoding="utf-8")

    assert "{% for screen_partial in page_context.screen_partials %}" in panel
    assert "{% include screen_partial %}" in panel
    assert 'id="view-xkeen"' not in panel
    assert [
        entry.owners
        for entry in PANEL_COMPOSITION
        if entry.template == "panel/screens/xkeen.html"
    ] == [("core",)]
    assert "{% if " not in xkeen
    assert 'id="view-xkeen"' in xkeen
    assert 'data-xk-section="xkeen"' in xkeen
    for foreign in ('id="view-mihomo"', 'id="view-commands"', 'id="view-routing"'):
        assert foreign not in xkeen


def test_xkeen_screen_composition_preserves_dom_contract():
    source = compose_panel_template(ROOT)

    assert source.count('id="view-xkeen"') == 1
    assert source.index('id="view-mihomo"') < source.index('id="view-xkeen"')
    assert source.index('id="view-xkeen"') < source.index('id="view-commands"')
    for required_id in (
        "xkeen-body",
        "port-proxying-editor",
        "port-proxying-save-btn",
        "port-exclude-editor",
        "ip-exclude-editor",
        "xkeen-config-editor",
        "xkeen-config-save-btn",
    ):
        assert f'id="{required_id}"' in source

    ids = re.findall(r'\bid=["\']([^"\']+)["\']', source)
    assert len(ids) == len(set(ids))


def test_xkeen_screen_is_rendered_for_every_engine_profile(tmp_path, monkeypatch):
    monkeypatch.delenv("XKEEN_UI_PANEL_SECTIONS_WHITELIST", raising=False)
    for name, module_ids in (
        ("xray", XRAY_MINIMAL_MODULE_IDS),
        ("mihomo", MIHOMO_MINIMAL_MODULE_IDS),
    ):
        html = render_panel(module_ids, tmp_path / name)
        assert html.count('id="view-xkeen"') == 1
        assert 'id="port-proxying-editor"' in html


def test_xkeen_screen_closure_is_documented():
    plan = (ROOT / "README-modular-panel-plan.md").read_text(encoding="utf-8")
    contract = (
        ROOT / "docs/modular-panel-stage4.3-xkeen-screen.md"
    ).read_text(encoding="utf-8")
    index = (ROOT / "docs/README.md").read_text(encoding="utf-8")

    assert "Xkeen screen: **закрыт 30 сентября 2026 года**" in plan
    assert "modular-panel-stage4.3-xkeen-screen.md" in plan
    assert "modular-panel-stage4.3-xkeen-screen.md" in index
    assert "Критерий завершения **выполнен**" in contract

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
MIHOMO = ROOT / "xkeen-ui/templates/panel/screens/mihomo.html"


def test_mihomo_screen_is_owned_by_engine_mihomo_partial():
    panel = PANEL.read_text(encoding="utf-8")
    mihomo = MIHOMO.read_text(encoding="utf-8")

    assert "{% for screen_partial in page_context.screen_partials %}" in panel
    assert "{% include screen_partial %}" in panel
    assert 'id="view-mihomo"' not in panel
    assert [
        entry.owners
        for entry in PANEL_COMPOSITION
        if entry.template == "panel/screens/mihomo.html"
    ] == [("engine.mihomo",)]
    assert "{% if has_mihomo %}" not in mihomo
    assert 'id="view-mihomo"' in mihomo
    assert 'data-xk-section="mihomo"' in mihomo
    for foreign in ('id="view-routing"', 'id="view-xkeen"', 'id="view-xray-logs"'):
        assert foreign not in mihomo
    # Mihomo modals move with the modal split in 4.4.
    assert 'class="modal' not in mihomo


def test_mihomo_screen_composition_preserves_dom_contract():
    source = compose_panel_template(ROOT)

    assert source.count('id="view-mihomo"') == 1
    assert source.index('id="view-routing"') < source.index('id="view-mihomo"')
    assert source.index('id="view-mihomo"') < source.index('id="view-xkeen"')
    for required_id in (
        "mihomo-editor",
        "mihomo-editor-meta",
        "mihomo-template-select",
        "mihomo-dns-dot",
        "mihomo-clash-runtime",
        "mihomo-clash-tab-config",
        "mihomo-clash-tab-control",
        "mihomo-import-node-btn",
        "mihomo-proxy-tools-btn",
        # integration.happ-owned button; composite gate is a 4.4 task.
        "mihomo-hwid-sub-btn",
    ):
        assert f'id="{required_id}"' in source

    ids = re.findall(r'\bid=["\']([^"\']+)["\']', source)
    assert len(ids) == len(set(ids))


def test_mihomo_screen_follows_profile_in_initial_html(tmp_path, monkeypatch):
    monkeypatch.delenv("XKEEN_UI_PANEL_SECTIONS_WHITELIST", raising=False)
    xray_html = render_panel(XRAY_MINIMAL_MODULE_IDS, tmp_path / "xray")
    mihomo_html = render_panel(MIHOMO_MINIMAL_MODULE_IDS, tmp_path / "mihomo")

    assert mihomo_html.count('id="view-mihomo"') == 1
    assert 'id="mihomo-editor"' in mihomo_html
    assert 'id="view-mihomo"' not in xray_html
    assert 'id="mihomo-editor"' not in xray_html
    assert 'id="mihomo-clash-runtime"' not in xray_html
    for html in (xray_html, mihomo_html):
        ids = re.findall(r'\bid=["\']([^"\']+)["\']', html)
        assert len(ids) == len(set(ids))
        assert "{{" not in html and "{%" not in html


def test_mihomo_screen_closure_is_documented():
    plan = (ROOT / "README-modular-panel-plan.md").read_text(encoding="utf-8")
    contract = (
        ROOT / "docs/modular-panel-stage4.3-mihomo-screen.md"
    ).read_text(encoding="utf-8")
    index = (ROOT / "docs/README.md").read_text(encoding="utf-8")

    assert "Mihomo screen: **закрыт 30 сентября 2026 года**" in plan
    assert "modular-panel-stage4.3-mihomo-screen.md" in plan
    assert "modular-panel-stage4.3-mihomo-screen.md" in index
    assert "Критерий завершения **выполнен**" in contract

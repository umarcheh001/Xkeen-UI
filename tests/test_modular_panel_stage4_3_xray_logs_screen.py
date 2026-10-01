from __future__ import annotations

import re
from pathlib import Path

from flask import Flask

from routes.pages import PANEL_COMPOSITION
from scripts.panel_template_source import compose_panel_template
from tests.support.panel_render import (
    MIHOMO_MINIMAL_MODULE_IDS,
    XRAY_MINIMAL_MODULE_IDS,
    render_panel,
)


ROOT = Path(__file__).resolve().parents[1]
PANEL = ROOT / "xkeen-ui/templates/panel.html"
XRAY_LOGS = ROOT / "xkeen-ui/templates/panel/screens/xray_logs.html"


def test_xray_logs_screen_is_owned_by_engine_xray_partial():
    panel = PANEL.read_text(encoding="utf-8")
    xray_logs = XRAY_LOGS.read_text(encoding="utf-8")

    assert "{% for screen_partial in page_context.screen_partials %}" in panel
    assert "{% include screen_partial %}" in panel
    assert 'id="view-xray-logs"' not in panel
    assert [
        entry.owners
        for entry in PANEL_COMPOSITION
        if entry.template == "panel/screens/xray_logs.html"
    ] == [("engine.xray",)]
    assert "{% if has_xray %}" not in xray_logs
    assert 'id="view-xray-logs"' in xray_logs
    assert 'data-xk-section="xray-logs"' in xray_logs
    # The log context modal is an engine.xray modal partial since 4.4.
    assert 'id="xray-context-modal"' not in xray_logs
    for foreign in ('id="view-routing"', 'id="view-mihomo"', 'id="view-files"'):
        assert foreign not in xray_logs


def test_xray_logs_screen_composition_preserves_dom_contract():
    source = compose_panel_template(ROOT)

    assert source.count('id="view-xray-logs"') == 1
    assert source.index('id="view-files"') < source.index('id="view-xray-logs"')
    assert source.index('id="view-xray-logs"') < source.index('id="xray-context-modal"')
    for required_id in (
        "xray-logs-title",
        "xray-log-lamp",
        "xray-log-file",
        "xray-log-level",
        "xray-log-live",
        "xray-log-follow",
        "xray-log-output",
        "xray-log-status",
    ):
        assert f'id="{required_id}"' in source

    ids = re.findall(r'\bid=["\']([^"\']+)["\']', source)
    assert len(ids) == len(set(ids))


def _render_screen(has_xray: bool) -> str:
    app = Flask("xray-logs-screen", template_folder=str(ROOT / "xkeen-ui/templates"))
    template = (
        "{% if has_xray %}"
        '{% include "panel/screens/xray_logs.html" %}'
        "{% endif %}"
    )
    with app.test_request_context():
        return app.jinja_env.from_string(template).render(has_xray=has_xray)


def test_xray_logs_screen_renders_only_with_engine_xray():
    rendered = _render_screen(True)

    assert 'id="view-xray-logs"' in rendered
    assert "{{" not in rendered and "{%" not in rendered
    assert "<svg" in rendered  # op_icon macro resolves inside the partial
    assert _render_screen(False).strip() == ""


def test_xray_logs_screen_follows_profile_in_initial_html(tmp_path, monkeypatch):
    monkeypatch.delenv("XKEEN_UI_PANEL_SECTIONS_WHITELIST", raising=False)
    xray_html = render_panel(XRAY_MINIMAL_MODULE_IDS, tmp_path / "xray")
    mihomo_html = render_panel(MIHOMO_MINIMAL_MODULE_IDS, tmp_path / "mihomo")

    assert xray_html.count('id="view-xray-logs"') == 1
    assert 'id="xray-log-output"' in xray_html
    assert 'id="view-xray-logs"' not in mihomo_html
    assert 'id="xray-log-output"' not in mihomo_html
    assert 'id="view-routing"' not in mihomo_html
    for html in (xray_html, mihomo_html):
        ids = re.findall(r'\bid=["\']([^"\']+)["\']', html)
        assert len(ids) == len(set(ids))
        assert "{{" not in html and "{%" not in html


def test_xray_logs_screen_closure_is_documented():
    plan = (ROOT / "README-modular-panel-plan.md").read_text(encoding="utf-8")
    contract = (
        ROOT / "docs/modular-panel-stage4.3-xray-logs-screen.md"
    ).read_text(encoding="utf-8")
    index = (ROOT / "docs/README.md").read_text(encoding="utf-8")

    assert "Xray logs screen: **закрыт 30 сентября 2026 года**" in plan
    assert "modular-panel-stage4.3-xray-logs-screen.md" in plan
    assert "modular-panel-stage4.3-xray-logs-screen.md" in index
    assert "Критерий завершения **выполнен**" in contract

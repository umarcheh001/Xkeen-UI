from __future__ import annotations

import re
from pathlib import Path

from flask import Flask

from scripts.panel_template_source import compose_panel_template


ROOT = Path(__file__).resolve().parents[1]
PANEL = ROOT / "xkeen-ui/templates/panel.html"
XRAY_LOGS = ROOT / "xkeen-ui/templates/panel/screens/xray_logs.html"


def test_xray_logs_screen_is_owned_by_engine_xray_partial():
    panel = PANEL.read_text(encoding="utf-8")
    xray_logs = XRAY_LOGS.read_text(encoding="utf-8")

    include = '{% include "panel/screens/xray_logs.html" %}'
    assert include in panel
    assert 'id="view-xray-logs"' not in panel
    # The gate lives in the composition root, directly around the include.
    gate_start = panel.rindex("{% if has_xray %}", 0, panel.index(include))
    assert panel.index("{% endif %}", gate_start) > panel.index(include)
    assert "{% if has_xray %}" not in xray_logs
    assert 'id="view-xray-logs"' in xray_logs
    assert 'data-xk-section="xray-logs"' in xray_logs
    # Modals are split in 4.4; the log context modal stays in panel.html.
    assert 'id="xray-context-modal"' not in xray_logs
    assert 'id="xray-context-modal"' in panel
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


def _render_panel(active_module_ids: list[str], tmp_path: Path) -> str:
    from routes.pages import register_pages_routes
    from routes.ui_assets import init_ui_assets_helpers, register_build_stamp_global

    app = Flask(
        "panel-profile",
        root_path=str(ROOT / "xkeen-ui"),
        static_folder="static",
        template_folder="templates",
    )
    init_ui_assets_helpers(app)
    register_build_stamp_global(app, str(tmp_path))
    # Endpoints owned by other blueprints; the page only builds their URLs.
    app.add_url_rule("/logout", "logout_post", lambda: "", methods=["POST"])
    app.add_url_rule("/terminal-theme.css", "terminal_theme_css", lambda: "")
    if "tool.advanced-diagnostics" not in active_module_ids:
        app.add_url_rule("/devtools", "devtools_page", lambda: "")
    if "engine.mihomo" not in active_module_ids:
        app.add_url_rule("/mihomo_generator", "mihomo_generator_page", lambda: "")
    app.context_processor(lambda: {"csrf_token": "token", "terminal_theme_v": 0})
    register_pages_routes(
        app,
        module_activation={"active_module_ids": active_module_ids},
        ROUTING_FILE=str(tmp_path / "05_routing.json"),
        MIHOMO_CONFIG_FILE=str(tmp_path / "config.yaml"),
        INBOUNDS_FILE=str(tmp_path / "03_inbounds.json"),
        OUTBOUNDS_FILE=str(tmp_path / "04_outbounds.json"),
        BACKUP_DIR=str(tmp_path / "backups"),
        COMMAND_GROUPS=[],
        GITHUB_REPO_URL="https://example.invalid/repo",
    )
    response = app.test_client().get("/")
    assert response.status_code == 200
    return response.get_data(as_text=True)


def test_xray_logs_screen_follows_profile_in_initial_html(tmp_path, monkeypatch):
    monkeypatch.delenv("XKEEN_UI_PANEL_SECTIONS_WHITELIST", raising=False)
    xray_html = _render_panel(["core", "tool.editor", "engine.xray"], tmp_path / "xray")
    mihomo_html = _render_panel(["core", "tool.editor", "engine.mihomo"], tmp_path / "mihomo")

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

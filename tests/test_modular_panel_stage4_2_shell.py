from __future__ import annotations

import re
from pathlib import Path

from flask import Flask

from scripts.panel_template_source import compose_panel_template


ROOT = Path(__file__).resolve().parents[1]
TEMPLATE_ROOT = ROOT / "xkeen-ui/templates"
PANEL = TEMPLATE_ROOT / "panel.html"


def test_stage4_2_shell_partials_and_thin_composition_root_exist():
    expected = {
        "macros.html",
        "head.html",
        "page_config.html",
        "shell.html",
        "header.html",
        "navigation.html",
    }
    actual = {path.name for path in (TEMPLATE_ROOT / "panel").glob("*.html")}
    assert expected <= actual

    source = PANEL.read_text(encoding="utf-8")
    assert '{% include "panel/head.html" %}' in source
    assert '{% include "panel/shell.html" %}' in source
    assert "<head>" not in source
    assert '<body class=' not in source
    assert '<header class="panel-header' not in source
    assert '{% include "panel/screens/routing.html" %}' in source
    assert 'id="view-routing"' not in source
    assert 'id="view-mihomo"' in source


def test_stage4_2_composed_source_preserves_shell_and_screen_contract():
    source = compose_panel_template(ROOT)

    assert source.count("<head>") == 1
    assert source.count("<body ") == 1
    assert source.count('data-xk-shell="panel-header"') == 1
    assert source.count('id="view-routing"') == 1
    assert source.count('id="view-mihomo"') == 1
    assert source.count('id="view-xkeen"') == 1
    assert source.count('id="view-commands"') == 1
    assert source.count('id="view-files"') == 1
    assert source.count('id="view-xray-logs"') == 1
    assert source.index("window.XKeen.pageConfig") < source.index(
        "frontend_page_entry_url('panel')"
    )
    assert source.index('data-xk-shell="panel-header"') < source.index(
        'id="view-routing"'
    )

    ids = re.findall(r'\bid=["\']([^"\']+)["\']', source)
    assert len(ids) == len(set(ids))


def test_stage4_2_panel_template_compiles_with_flask_jinja():
    app = Flask(
        "stage4-2-template-compile",
        template_folder=str(TEMPLATE_ROOT),
    )
    with app.app_context():
        template = app.jinja_env.get_template("panel.html")
        assert template.name == "panel.html"


def test_stage4_2_closure_is_reflected_in_documentation():
    plan = (ROOT / "README-modular-panel-plan.md").read_text(encoding="utf-8")
    contract = (
        ROOT / "docs/modular-panel-stage4.2-frontend-shell.md"
    ).read_text(encoding="utf-8")
    index = (ROOT / "docs/README.md").read_text(encoding="utf-8")

    assert "### Подэтап 4.2. Выделение общего frontend shell" in plan
    assert "Критерий готовности 4.2:** **выполнен**" in plan
    assert "modular-panel-stage4.2-frontend-shell.md" in plan
    assert "modular-panel-stage4.2-frontend-shell.md" in index
    assert "Критерий завершения" in contract

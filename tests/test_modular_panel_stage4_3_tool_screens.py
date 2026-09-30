from __future__ import annotations

import re
from pathlib import Path

import pytest

from scripts.panel_template_source import compose_panel_template
from tests.support.panel_render import (
    FULL_MODULE_IDS,
    XRAY_MINIMAL_MODULE_IDS,
    render_panel,
)


ROOT = Path(__file__).resolve().parents[1]
PANEL = ROOT / "xkeen-ui/templates/panel.html"
SCREENS = {
    # screen -> (partial, gate, module owner, required ids)
    "commands": (
        "commands.html",
        "has_terminal",
        "tool.terminal",
        (
            "terminal-open-shell-btn",
            "terminal-open-pty-btn",
            "cores-check-btn",
            "commands-status-row",
            "core-xray-update-btn",
            "core-mihomo-update-btn",
        ),
    ),
    "files": (
        "files.html",
        "has_files",
        "tool.files",
        ("fm-title", "fm-volumes-btn", "fm-ops-btn", "fm-root", "fm-help-btn"),
    ),
}


@pytest.mark.parametrize("screen", sorted(SCREENS))
def test_tool_screen_is_owned_by_module_partial(screen):
    partial, gate, _owner, _ids = SCREENS[screen]
    panel = PANEL.read_text(encoding="utf-8")
    markup = (ROOT / "xkeen-ui/templates/panel/screens" / partial).read_text(encoding="utf-8")

    include = f'{{% include "panel/screens/{partial}" %}}'
    assert include in panel
    assert f'id="view-{screen}"' not in panel
    # The gate lives in the composition root, directly around the include.
    gate_start = panel.rindex(f"{{% if {gate} %}}", 0, panel.index(include))
    assert panel.index("{% endif %}", gate_start) > panel.index(include)
    assert gate not in markup
    assert f'id="view-{screen}"' in markup
    assert f'data-xk-section="{screen}"' in markup
    assert 'class="modal' not in markup
    for other in SCREENS:
        if other != screen:
            assert f'id="view-{other}"' not in markup


def test_tool_screens_keep_dom_contract_and_order():
    source = compose_panel_template(ROOT)
    order = [
        source.index(f'id="view-{name}"')
        for name in ("xkeen", "commands", "files", "xray-logs")
    ]
    assert order == sorted(order)
    for screen, (_partial, _gate, _owner, required_ids) in SCREENS.items():
        assert source.count(f'id="view-{screen}"') == 1
        for required_id in required_ids:
            assert f'id="{required_id}"' in source

    ids = re.findall(r'\bid=["\']([^"\']+)["\']', source)
    assert len(ids) == len(set(ids))


def test_commands_partial_restores_the_shared_is_mips_flag():
    markup = (ROOT / "xkeen-ui/templates/panel/screens/commands.html").read_text(encoding="utf-8")

    # The terminal buttons override is_mips locally; it must not leak.
    assert markup.index("{% set __xk_commands_is_mips = is_mips %}") < markup.index(
        "{% set is_mips = __xk_commands_is_mips %}"
    )


def test_tool_screens_follow_active_modules_in_initial_html(tmp_path, monkeypatch):
    monkeypatch.delenv("XKEEN_UI_PANEL_SECTIONS_WHITELIST", raising=False)
    full_html = render_panel(FULL_MODULE_IDS, tmp_path / "full")
    minimal_html = render_panel(XRAY_MINIMAL_MODULE_IDS, tmp_path / "minimal")
    terminal_only = render_panel([*XRAY_MINIMAL_MODULE_IDS, "tool.terminal"], tmp_path / "terminal")
    files_only = render_panel([*XRAY_MINIMAL_MODULE_IDS, "tool.files"], tmp_path / "files")

    for screen in SCREENS:
        assert full_html.count(f'id="view-{screen}"') == 1
        assert f'id="view-{screen}"' not in minimal_html
    assert 'id="view-commands"' in terminal_only and 'id="view-files"' not in terminal_only
    assert 'id="view-files"' in files_only and 'id="view-commands"' not in files_only
    for html in (full_html, minimal_html, terminal_only, files_only):
        ids = re.findall(r'\bid=["\']([^"\']+)["\']', html)
        assert len(ids) == len(set(ids))
        assert "{{" not in html and "{%" not in html


def test_stage4_3_tool_screens_closure_is_documented():
    plan = (ROOT / "README-modular-panel-plan.md").read_text(encoding="utf-8")
    contract = (
        ROOT / "docs/modular-panel-stage4.3-tool-screens.md"
    ).read_text(encoding="utf-8")
    index = (ROOT / "docs/README.md").read_text(encoding="utf-8")

    assert "Commands и Files screens: **закрыты 30 сентября 2026 года**" in plan
    # 4.3 stays open until minimal profiles load without console errors.
    assert "5. `commands.html` — `tool.terminal` — **выполнено**;" in plan
    assert "6. `files.html` — `tool.files` — **выполнено**." in plan
    assert "не выполнен критерий console errors" in plan
    assert "modular-panel-stage4.3-tool-screens.md" in plan
    assert "modular-panel-stage4.3-tool-screens.md" in index
    assert "Критерий завершения **выполнен**" in contract

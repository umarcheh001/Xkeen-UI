from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
GENERATOR = ROOT / "scripts/generate_operator_icon_sprite.py"
SPRITE = ROOT / "xkeen-ui/static/icons/operator.svg"
LICENSE = ROOT / "xkeen-ui/static/icons/tabler-icons.LICENSE"
TEMPLATE = ROOT / "xkeen-ui/templates/panel.html"
CSS = ROOT / "xkeen-ui/static/panel-operator.css"
HELPER = ROOT / "xkeen-ui/static/js/ui/operator_icons.js"
OUTBOUNDS = ROOT / "xkeen-ui/static/js/features/outbounds.js"
RULE_RENDER = ROOT / "xkeen-ui/static/js/features/routing_cards/rules/render.js"
QUICK_BALANCER = ROOT / "xkeen-ui/static/js/features/routing_cards/rules/quick_balancer.js"
FORCED_RULES = ROOT / "xkeen-ui/static/js/features/routing_cards/rules/forced_rules_wizard.js"


def routing_markup() -> str:
    template = TEMPLATE.read_text(encoding="utf-8")
    return template[template.index('<div id="view-routing"') : template.index('<div id="view-mihomo"')]


def test_operator_sprite_is_generated_and_committed_with_tabler_license(tmp_path):
    generated = tmp_path / "operator.svg"
    generated_license = tmp_path / "tabler-icons.LICENSE"
    result = subprocess.run(
        [
            sys.executable,
            str(GENERATOR),
            "--output",
            str(generated),
            "--license-output",
            str(generated_license),
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr or result.stdout
    assert generated.read_text(encoding="utf-8") == SPRITE.read_text(encoding="utf-8")
    assert generated_license.read_text(encoding="utf-8") == LICENSE.read_text(encoding="utf-8")
    assert "MIT License" in LICENSE.read_text(encoding="utf-8")


def test_routing_xray_uses_semantic_operator_icons_without_emoji_actions():
    markup = routing_markup()
    helper = HELPER.read_text(encoding="utf-8")
    outbounds = OUTBOUNDS.read_text(encoding="utf-8")
    rules = RULE_RENDER.read_text(encoding="utf-8")
    quick_balancer = QUICK_BALANCER.read_text(encoding="utf-8")
    forced_rules = FORCED_RULES.read_text(encoding="utf-8")

    for name in (
        "refresh",
        "upload",
        "download",
        "edit",
        "save",
        "archive",
        "restore",
        "ping",
        "normalize",
        "tools",
        "pool",
        "subscriptions",
        "quick-start",
        "add-balancer",
        "add-rule",
        "lock",
        "more",
    ):
        assert f"op_icon('{name}')" in markup or f"op_icon('{name}'," in markup

    assert "XKeen.ui.operatorIcons" in helper
    assert "iconHtml('ping'" in outbounds
    assert "setIcon(delBtn, 'trash')" in rules
    assert "setIcon(dupBtn, 'duplicate')" in rules
    assert "setIcon(editBtn, 'edit')" in rules
    assert "setIcon(handle, 'drag')" in rules
    assert "iconHtml('check'" in quick_balancer
    assert "iconHtml('transfer'" in forced_rules

    emoji = re.compile(r"[\U0001F300-\U0001FAFF]")
    assert not emoji.search(markup)


def test_operator_icon_css_contract_is_monochrome_and_state_driven():
    css = CSS.read_text(encoding="utf-8")
    start = css.index("/* Operator icon contract:")
    contract = css[start : css.index("body.panel-page :is(", start + 50)]
    for fragment in (
        ".xk-action-icon",
        "width: 16px;",
        "height: 16px;",
        "fill: none;",
        "stroke: currentColor;",
        "stroke-width: 1.75;",
        "pointer-events: none;",
    ):
        assert fragment in contract


def test_mihomo_routing_and_related_forms_use_operator_sprite_contract():
    panel = TEMPLATE.read_text(encoding="utf-8")
    generator = (ROOT / "xkeen-ui/templates/mihomo_generator.html").read_text(encoding="utf-8")
    panel_mihomo = panel[panel.index('<div id="view-mihomo"') : panel.index('<div id="view-xkeen"')]
    related_forms = panel[panel.index('id="mihomo-import-modal"') : panel.index('id="fm-upload-conflict-modal"') ]
    dynamic_sources = {
        "panel": (ROOT / "xkeen-ui/static/js/features/mihomo_panel.js").read_text(encoding="utf-8"),
        "import": (ROOT / "xkeen-ui/static/js/features/mihomo_import.js").read_text(encoding="utf-8"),
        "generator": (ROOT / "xkeen-ui/static/js/features/mihomo_generator.js").read_text(encoding="utf-8"),
    }

    for name in (
        "save", "restart", "more", "download", "add-node", "hwid", "tools", "dashboard",
        "format", "validate", "refresh", "trash", "edit", "transfer", "close",
    ):
        assert f"op_icon('{name}')" in panel_mihomo or f"op_icon('{name}')" in related_forms

    for name in (
        "back", "add-node", "refresh", "import", "normalize", "format", "restore",
        "duplicate", "save", "validate", "apply", "trash", "preview", "close",
    ):
        assert f"op_icon('{name}')" in generator

    assert "iconHtml(o.icon" in dynamic_sources["panel"]
    assert "iconHtml(iconName)" in dynamic_sources["import"]
    assert "iconHtml(iconName)" in dynamic_sources["generator"]
    assert "iconHtml('trash')" in dynamic_sources["generator"]
    assert "bulkImportApplyBtn.innerHTML = iconHtml('import')" in dynamic_sources["generator"]

    emoji = re.compile(r"[\U0001F300-\U0001FAFF]")
    for markup in (panel_mihomo, related_forms, generator):
        for control in re.findall(r"<(?:button|summary)\b[^>]*>.*?</(?:button|summary)>", markup, flags=re.DOTALL):
            assert not emoji.search(control), control

    assert "\u00d7</button>" not in related_forms
    assert "\u00d7</button>" not in generator

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
GENERATOR = ROOT / "scripts/generate_operator_icon_sprite.py"
SPRITE = ROOT / "xkeen-ui/static/icons/operator.svg"
LICENSE = ROOT / "xkeen-ui/static/icons/tabler-icons.LICENSE"
MANIFEST = ROOT / "xkeen-ui/static/js/ui/operator_icons_manifest.js"
INVENTORY_GENERATOR = ROOT / "scripts/generate_operator_icon_inventory.py"
INVENTORY = ROOT / "docs/panel-operator-icon-inventory.json"
TEMPLATE = ROOT / "xkeen-ui/templates/panel.html"
CSS = ROOT / "xkeen-ui/static/panel-operator.css"
HELPER = ROOT / "xkeen-ui/static/js/ui/operator_icons.js"
OUTBOUNDS = ROOT / "xkeen-ui/static/js/features/outbounds.js"
RULE_RENDER = ROOT / "xkeen-ui/static/js/features/routing_cards/rules/render.js"
QUICK_BALANCER = ROOT / "xkeen-ui/static/js/features/routing_cards/rules/quick_balancer.js"
FORCED_RULES = ROOT / "xkeen-ui/static/js/features/routing_cards/rules/forced_rules_wizard.js"
FILE_MANAGER_WIRE = ROOT / "xkeen-ui/static/js/features/file_manager/wire.js"
FILE_MANAGER_RENDER = ROOT / "xkeen-ui/static/js/features/file_manager/render.js"
FILE_MANAGER_CONTEXT = ROOT / "xkeen-ui/static/js/features/file_manager/context_menu.js"
FILE_MANAGER_CHROME = ROOT / "xkeen-ui/static/js/features/file_manager/chrome.js"
FILE_MANAGER_BOOKMARKS = ROOT / "xkeen-ui/static/js/features/file_manager/bookmarks.js"
XRAY_LOGS = ROOT / "xkeen-ui/static/js/features/xray_logs.js"
RESTART_LOG = ROOT / "xkeen-ui/static/js/features/restart_log.js"
THEME = ROOT / "xkeen-ui/static/js/ui/theme.js"
FILE_MANAGER_ACTIONS = ROOT / "xkeen-ui/static/js/features/file_manager/actions.js"
FILE_MANAGER_EDITOR = ROOT / "xkeen-ui/static/js/features/file_manager/editor.js"
FILE_MANAGER_STORAGE = ROOT / "xkeen-ui/static/js/features/file_manager/storage.js"


def header_markup() -> str:
    template = TEMPLATE.read_text(encoding="utf-8")
    return template[template.index('<header ') : template.index('<div id="view-routing"')]


def top_level_markup() -> str:
    template = TEMPLATE.read_text(encoding="utf-8")
    return template[template.index('<div id="view-xkeen"') : template.index('<!-- Xray log: context modal -->')]


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


def test_operator_icon_manifest_and_machine_readable_inventory_are_reproducible(tmp_path):
    generated_manifest = tmp_path / "operator_icons_manifest.js"
    generated_inventory = tmp_path / "panel-operator-icon-inventory.json"
    generated_sprite = tmp_path / "operator.svg"
    generated_license = tmp_path / "tabler-icons.LICENSE"

    result = subprocess.run(
        [
            sys.executable,
            str(GENERATOR),
            "--output", str(generated_sprite),
            "--license-output", str(generated_license),
            "--manifest-output", str(generated_manifest),
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr or result.stdout
    result = subprocess.run(
        [sys.executable, str(INVENTORY_GENERATOR), "--output", str(generated_inventory)],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr or result.stdout

    assert generated_manifest.read_text(encoding="utf-8") == MANIFEST.read_text(encoding="utf-8")
    assert generated_inventory.read_text(encoding="utf-8") == INVENTORY.read_text(encoding="utf-8")
    inventory = __import__("json").loads(INVENTORY.read_text(encoding="utf-8"))
    assert inventory["item_count"] == len(re.findall(r'^  "[a-z0-9-]+"', MANIFEST.read_text(encoding="utf-8"), re.MULTILINE))
    assert inventory["unused_semantic_names"] == []
    assert inventory["unknown_direct_semantic_names"] == []
    assert all(item["usage"] for item in inventory["items"])


def test_every_operator_use_reference_is_resolved_and_names_are_allowlisted():
    symbols = set(re.findall(r'<symbol\s+id="xk-([a-z0-9-]+)"', SPRITE.read_text(encoding="utf-8")))
    manifest_names = set(re.findall(r'^  "([a-z0-9-]+)"', MANIFEST.read_text(encoding="utf-8"), re.MULTILINE))
    assert symbols == manifest_names

    source_paths = [*TEMPLATE.parent.glob("*.html"), *(ROOT / "xkeen-ui/static/js").rglob("*.js")]
    references: list[tuple[Path, str]] = []
    for path in source_paths:
        if "vendor" in path.parts or "frontend-build" in path.parts:
            continue
        source = path.read_text(encoding="utf-8", errors="replace")
        for match in re.finditer(r'#xk-([a-z0-9-]+)', source):
            references.append((path, match.group(1)))
    assert references
    assert all(name in symbols for _, name in references)

    helper = HELPER.read_text(encoding="utf-8")
    assert "KNOWN_ICON_NAMES" in helper
    assert "!KNOWN_ICON_NAMES.has(value)" in helper


def test_i6_guard_rejects_action_emoji_and_feature_local_svg_except_documented_content_assets():
    emoji_or_legacy_action = re.compile(r"[\U0001F300-\U0001FAFF×✕✖←→↔⛶⋯▶■⛔🗑📋⚙✏➕➖⌕⟳↻⇣↓↑⏹⏸⏻🗕⌚👁]")
    controls = re.compile(r'<(?:button|summary)\b[^>]*>(.*?)</(?:button|summary)>', re.IGNORECASE | re.DOTALL)
    for path in (TEMPLATE, ROOT / "xkeen-ui/templates/mihomo_generator.html"):
        source = path.read_text(encoding="utf-8")
        for control in controls.findall(source):
            visible = re.sub(r'<[^>]+>|{{\s*op_icon\([^}]+}}', '', control)
            assert not emoji_or_legacy_action.search(visible), path

    allowed_inline_svg = {
        ROOT / "xkeen-ui/static/js/ui/operator_icons.js",
        ROOT / "xkeen-ui/static/js/features/outbounds.js",  # content country flags
    }
    for path in (ROOT / "xkeen-ui/static/js").rglob("*.js"):
        if "vendor" in path.parts or "frontend-build" in path.parts or path in allowed_inline_svg:
            continue
        source = path.read_text(encoding="utf-8", errors="replace")
        assert not re.search(r"<svg\b|<path\b", source), path


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


def test_other_top_level_views_share_semantic_operator_icon_dictionary():
    markup = top_level_markup()
    sources = {
        "file_wire": FILE_MANAGER_WIRE.read_text(encoding="utf-8"),
        "file_render": FILE_MANAGER_RENDER.read_text(encoding="utf-8"),
        "file_context": FILE_MANAGER_CONTEXT.read_text(encoding="utf-8"),
        "file_chrome": FILE_MANAGER_CHROME.read_text(encoding="utf-8"),
        "file_bookmarks": FILE_MANAGER_BOOKMARKS.read_text(encoding="utf-8"),
        "logs": XRAY_LOGS.read_text(encoding="utf-8"),
        "restart_log": RESTART_LOG.read_text(encoding="utf-8"),
        "theme": THEME.read_text(encoding="utf-8"),
        "file_actions": FILE_MANAGER_ACTIONS.read_text(encoding="utf-8"),
        "file_editor": FILE_MANAGER_EDITOR.read_text(encoding="utf-8"),
        "file_storage": FILE_MANAGER_STORAGE.read_text(encoding="utf-8"),
    }
    header = header_markup()
    assert "op_icon('sun', 'theme-toggle-icon')" in header
    assert "op_icon('settings')" in header

    for name in (
        "storage", "list-details", "home", "move-up", "refresh", "close", "help",
        "search", "play", "stop", "clear", "trash", "duplicate", "devices",
        "fullscreen", "pause", "more",
    ):
        assert f"op_icon('{name}')" in markup

    for fragment in (
        "iconHtml('fullscreen')", "iconHtml('fullscreen-exit')", "iconHtml('terminal')",
        "iconHtml('folder-add')", "iconHtml('file-add')", "iconHtml('upload')",
        "iconHtml('download')", "iconHtml('refresh')", "ACTION_ICONS",
        "iconHtml('pause')", "iconHtml('play')", "iconHtml(icon, 'theme-toggle-icon')",
    ):
        assert any(fragment in source for source in sources.values()), fragment

    assert "setIcon" not in sources["file_wire"]
    assert "const ACTION_ICONS" in sources["file_context"]


def test_top_level_action_controls_have_no_emoji_or_feature_local_svg():
    markup = top_level_markup()
    header = header_markup()
    emoji = re.compile(r"[\U0001F300-\U0001FAFF]")
    for scope in (header, markup):
        for control in re.findall(r"<(?:button|summary)\b[^>]*>.*?</(?:button|summary)>", scope, flags=re.DOTALL):
            assert not emoji.search(control), control
            assert "<path" not in control and "<svg" not in control, control

    action_sources = (
        FILE_MANAGER_WIRE,
        FILE_MANAGER_RENDER,
        FILE_MANAGER_CONTEXT,
        FILE_MANAGER_CHROME,
        FILE_MANAGER_BOOKMARKS,
        FILE_MANAGER_ACTIONS,
        FILE_MANAGER_EDITOR,
        FILE_MANAGER_STORAGE,
        XRAY_LOGS,
        RESTART_LOG,
    )
    for path in action_sources:
        text = path.read_text(encoding="utf-8")
        assert "<path" not in text and "<svg" not in text, path



def test_modal_action_icons_are_inline_and_duplicate_dismiss_controls_are_presentation_only():
    template = TEMPLATE.read_text(encoding="utf-8")
    css = CSS.read_text(encoding="utf-8")

    for control_id, icon in (
        ("json-editor-format-btn", "format"),
        ("json-editor-save-btn", "save"),
        ("fm-editor-download-btn", "download"),
        ("fm-editor-save-btn", "save"),
        ("routing-dat-contents-install-geodat-btn", "download"),
        ("routing-template-refresh-btn", "refresh"),
        ("routing-template-edit-btn", "edit"),
    ):
        match = re.search(
            rf'<button\b[^>]*\bid="{control_id}"[^>]*>(.*?)</button>', template, re.DOTALL
        )
        assert match, control_id
        assert f"op_icon('{icon}')" in match.group(1), control_id
        assert not re.search(r"[\U0001F000-\U0001FAFF]", match.group(1)), control_id

    for fragment in (
        '.modal-actions :is(button, .btn-primary, .btn-secondary):has(.xk-action-icon)',
        '#routing-dat-contents-modal .xk-dat-controls .btn-secondary:has(.xk-action-icon)',
        'align-items: center;',
        'gap: 7px;',
        '[data-operator-dismiss-duplicate="true"]',
    ):
        assert fragment in css

    assert template.count('data-operator-dismiss-duplicate="true"') >= 40
    assert not re.search(
        r'<button\b[^>]*class="modal-close"[^>]*data-operator-dismiss-duplicate',
        template,
    )

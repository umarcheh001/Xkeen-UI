from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CSS = ROOT / "xkeen-ui/static/panel-operator.css"
EDITOR_ACTIONS = ROOT / "xkeen-ui/static/js/ui/editor_actions.js"
MONACO_SHARED = ROOT / "xkeen-ui/static/js/ui/monaco_shared.js"
PANEL_TEMPLATE = ROOT / "xkeen-ui/templates/panel.html"


def test_operator_editor_menus_replace_legacy_blue_glass_surfaces():
    css = CSS.read_text(encoding="utf-8")
    stage = css[css.index("/* Editor overflow menus are flat operator surfaces") : css.index("body.panel-page .routing-editor-meta {")]

    for fragment in (
        ".xk-routing-menu-panel",
        ".xk-mihomo-menu-panel",
        ".context-view.monaco-menu-container",
        ".quick-input-widget",
        ".xk-routing-monaco-menu",
        ".xk-routing-monaco-menu-item",
        "background: var(--op-surface) !important;",
        "background: var(--op-surface-2) !important;",
        "border-color: var(--op-border-strong) !important;",
        "backdrop-filter: none !important;",
    ):
        assert fragment in stage

    for legacy in ("linear-gradient(", "radial-gradient(", "translateY("):
        assert legacy not in stage

    for fragment in (
        "margin: 3px 0;",
        "border: 1px solid var(--op-border) !important;",
        ".xk-routing-monaco-menu-item:is(:hover, :focus-visible)",
        ".xk-routing-monaco-menu-item[disabled]",
        ".xk-routing-monaco-menu-sep",
    ):
        assert fragment in stage


def test_mihomo_menu_and_fullscreen_toolbar_stay_inside_viewport():
    css = CSS.read_text(encoding="utf-8")
    script = EDITOR_ACTIONS.read_text(encoding="utf-8")

    for fragment in (
        "body.panel-page .xk-mihomo-menu .xk-mihomo-menu-panel",
        "right: auto;",
        "left: 0;",
        "body.panel-page > .xkeen-cm-toolbar.is-fullscreen",
        "right: max(10px, env(safe-area-inset-right)) !important;",
        "max-width: calc(100vw - 20px) !important;",
    ):
        assert fragment in css

    for fragment in (
        "placeholder: null,",
        "document.createComment('xk-editor-toolbar-fs')",
        "placeholderParent.replaceChild(toolbar, st.placeholder);",
    ):
        assert fragment in script


def test_operator_editors_share_panel_canvas_and_schema_hover_is_readable():
    css = CSS.read_text(encoding="utf-8")
    monaco = MONACO_SHARED.read_text(encoding="utf-8")
    template = PANEL_TEMPLATE.read_text(encoding="utf-8")

    for fragment in (
        "--op-editor: #0d0f13;",
        "--op-editor: #f1f2f5;",
        "--xk-cm-bg: var(--op-editor);",
        ".xkeen-cm6-host .cm-scroller",
        ".CodeMirror-gutters",
        "JSON Schema hovers are Monaco overflow widgets",
        "background: var(--xk-monaco-hover-bg) !important;",
        "--op-schema-hover-size: calc(14px * var(--xk-font-scale, 1));",
        "--op-schema-hover-weight: 400;",
        "font-family: var(--op-schema-hover-font) !important;",
        "font-size: var(--op-schema-hover-size) !important;",
        "font-weight: var(--op-schema-hover-weight) !important;",
        "line-height: var(--op-schema-hover-line-height) !important;",
        "opacity: 0.74;",
        "backdrop-filter: none !important;",
        "--xk-cm-popup-bg: var(--op-surface-2);",
        ".cm-tooltip.cm-tooltip-hover",
        ".cm6-json-schema-hover",
        "background: var(--op-surface-2) !important;",
        "background: transparent !important;",
        ".cm6-json-schema-hover code {",
        "border: 0 !important;",
        "border-radius: 0 !important;",
        "box-shadow: none !important;",
    ):
        assert fragment in css

    for fragment in (
        "function _getPanelCssVar(name, fallback)",
        "editorBg: isActive ? _getPanelCssVar('--op-editor'",
        "'editor.background': darkUi.editorBg",
        "'editorGutter.background': darkUi.editorBg",
        "'editor.background': lightUi.editorBg",
        "'editorGutter.background': lightUi.editorBg",
        "const fontSize = Math.max(13, Math.round(17 * scale));",
    ):
        assert fragment in monaco

    assert "filename='panel-operator.css', v='20260807b'" in template

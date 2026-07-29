from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CSS = ROOT / "xkeen-ui/static/panel-operator.css"
EDITOR_ACTIONS = ROOT / "xkeen-ui/static/js/ui/editor_actions.js"


def test_operator_editor_menus_replace_legacy_blue_glass_surfaces():
    css = CSS.read_text(encoding="utf-8")
    stage = css[css.index("/* Editor overflow menus are flat operator surfaces") : css.index("body.panel-page .xkeen-cm6-host {")]

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

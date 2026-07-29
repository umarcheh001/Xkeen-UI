from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / "xkeen-ui/templates/devtools.html"
CSS = ROOT / "xkeen-ui/static/devtools-operator.css"
LEGACY_CSS = ROOT / "xkeen-ui/static/devtools.css"
PLAN = ROOT / "docs/panel-operator-redesign-completion-plan.md"
DOC = ROOT / "docs/devtools-operator-theme.md"
INDEX = ROOT / "docs/README.md"
THEME_BOOTSTRAP = ROOT / "xkeen-ui/templates/_top_level_host_theme_bootstrap.html"
PANEL_TEMPLATE = ROOT / "xkeen-ui/templates/panel.html"


def test_devtools_operator_stylesheet_is_isolated_and_loaded_last():
    template = TEMPLATE.read_text(encoding="utf-8")
    css = CSS.read_text(encoding="utf-8")

    legacy_pos = template.index("filename='devtools.css'")
    terminal_pos = template.index("id=\"xk-terminal-theme-link\"")
    operator_pos = template.index("filename='devtools-operator.css'")
    assert legacy_pos < terminal_pos < operator_pos
    assert template.count("filename='devtools-operator.css'") == 1

    unscoped = []
    without_comments = re.sub(r"/\*.*?\*/", "", css, flags=re.DOTALL)
    for match in re.finditer(r"([^{}]+)\{", without_comments):
        prelude = " ".join(match.group(1).split())
        if not prelude or prelude.startswith("@") or prelude.endswith(("from", "to")):
            continue
        if "body.devtools-page" not in prelude and not prelude.startswith(("0%", "50%", "100%")):
            unscoped.append(prelude)
    assert not unscoped


def test_devtools_operator_layer_uses_panel_tokens_and_flat_chrome():
    css = CSS.read_text(encoding="utf-8")

    for token in (
        "--op-bg: #0d0f13;",
        "--op-surface: #14171c;",
        "--op-border: #2a2f38;",
        "--op-accent: #7477e8;",
        "--op-control-h: 32px;",
        "--op-touch-target: 40px;",
        "--op-bg: #f1f2f5;",
        "--op-accent: #5b5fc7;",
    ):
        assert token in css

    assert not re.search(
        r"(?:linear|radial|conic|repeating-linear|repeating-radial)-gradient\(",
        css,
    )
    assert "background-image: none !important;" in css
    assert "backdrop-filter: none !important;" in css
    assert "transform: none !important;" in css
    assert "border-radius: var(--op-radius-sm) !important;" in css
    assert "box-shadow: inset 0 -2px 0 var(--op-accent) !important;" in css


def test_devtools_operator_layer_covers_shell_tools_env_logs_modals_and_mobile():
    css = CSS.read_text(encoding="utf-8")

    for anchor in (
        ".dt-page-header",
        ".dt-tabs",
        ".dt-tools-layout",
        "#dt-service-card",
        "#dt-env-card",
        ".dt-env-group-toggle",
        ".dt-logs-layout",
        ".dt-log-view",
        ".modal-content",
        '#dt-env-card table',
        "@media (max-width: 1180px)",
        "@media (max-width: 720px)",
        "@media (prefers-reduced-motion: reduce)",
    ):
        assert anchor in css

    assert "grid-template-columns: minmax(400px, 440px) minmax(0, 1fr);" in css
    assert "#xk-tooltip-portal .xk-tooltip-bubble" in css
    assert "#dt-env-card thead th:nth-child(4) { width: 156px; }" in css
    assert "text-align: right;" in css
    assert ".dt-log-interval" in css
    assert "max-height: calc(100vh - 210px);" in css
    assert "min-width: 760px;" in css
    assert "min-height: 100dvh;" in css


def test_legacy_devtools_theme_remains_untouched_as_runtime_compatibility_layer():
    legacy = LEGACY_CSS.read_text(encoding="utf-8")
    assert "/* DevTools premium glass redesign */" in legacy
    assert "body.devtools-page .dt-tools-layout" in legacy
    assert "body.devtools-page .dt-env-group-toggle" in legacy


def test_devtools_operator_migration_is_documented():
    plan = PLAN.read_text(encoding="utf-8")
    doc = DOC.read_text(encoding="utf-8")
    index = INDEX.read_text(encoding="utf-8")

    assert "Параллельный проход: DevTools — закрыт 29 июля 2026 года" in plan
    assert "devtools-operator-theme.md" in plan
    assert "Статус: **закрыт 29 июля 2026 года**." in doc
    assert "## Автоматические проверки" in doc
    assert "devtools-operator-theme.md" in index


def test_devtools_back_navigation_has_operator_first_paint_guard():
    bootstrap = THEME_BOOTSTRAP.read_text(encoding="utf-8")
    panel = PANEL_TEMPLATE.read_text(encoding="utf-8")

    assert "document.referrer" in bootstrap
    assert "(location.pathname || '') === '/'" in bootstrap
    assert "xk-panel-operator-pending" in bootstrap
    assert "xk-panel-operator-paint-guard" in bootstrap
    assert "classList.remove('xk-panel-operator-pending')" in panel
    assert "getElementById('xk-panel-operator-paint-guard')?.remove()" in panel

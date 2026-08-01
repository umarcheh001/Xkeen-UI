from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CSS = ROOT / "xkeen-ui/static/panel-operator.css"
E2E = ROOT / "e2e/panel_operator_i5.spec.mjs"
SPRITE = ROOT / "xkeen-ui/static/icons/operator.svg"


def test_i5_css_publishes_accessibility_and_forced_colors_contract():
    css = CSS.read_text(encoding="utf-8")
    for fragment in (
        "I5. ACCESSIBILITY / THEMES / RESPONSIVE ICON CONTRACT",
        "currentColor",
        "@media (forced-colors: active)",
        "forced-color-adjust: auto",
        "@media (max-width: 720px), (any-pointer: coarse)",
        "--op-touch-target: 40px",
        "outline: 2px solid var(--op-accent-hover)",
        "xk-operator-icon-spin",
        "@media (prefers-reduced-motion: reduce)",
    ):
        assert fragment in css

    assert 'fill="' not in SPRITE.read_text(encoding="utf-8")
    assert 'stroke="' not in SPRITE.read_text(encoding="utf-8")


def test_i5_chromium_contract_covers_themes_zoom_forced_colors_and_snapshots():
    spec = E2E.read_text(encoding="utf-8")
    for fragment in (
        "forcedColors: 'active'",
        "document.documentElement.style.zoom = '1.25'",
        "document.documentElement.style.zoom = '1.5'",
        "toHaveScreenshot",
        "i5-editor-workbench-dark-desktop.png",
        "keyboard focus, hover tooltip",
    ):
        assert fragment in spec

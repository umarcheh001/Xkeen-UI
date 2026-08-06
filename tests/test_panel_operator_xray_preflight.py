from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CSS = ROOT / "xkeen-ui/static/panel-operator.css"
MODAL = ROOT / "xkeen-ui/static/js/ui/xray_preflight_modal.js"
TEMPLATE = ROOT / "xkeen-ui/templates/panel.html"


def test_dynamic_xray_preflight_uses_operator_modal_contract():
    source = MODAL.read_text(encoding="utf-8")

    assert "modal.dataset.operatorModalFamily = 'master-detail';" in source
    assert "xk-preflight-panel--output" in source
    assert "data-xk-preflight-output-panel" in source
    assert "setVisible(els.outputPanel, showStderr || showStdout);" in source
    assert "els.modal.classList.toggle('has-output', showStderr || showStdout);" in source
    assert 'data-operator-dismiss-duplicate="true"' in source
    assert "closeBtn.focus();" in source
    assert "okBtn.focus();" not in source
    assert "iconHtml('duplicate')" in source


def test_xray_preflight_operator_layer_is_flat_and_state_aware():
    css = CSS.read_text(encoding="utf-8")

    for fragment in (
        "#xray-preflight-modal .xk-preflight-modal {",
        "#xray-preflight-modal.has-output .xk-preflight-modal {",
        "#xray-preflight-modal.has-output .xk-preflight-grid {",
        "#xray-preflight-modal .xk-preflight-panel {",
        "#xray-preflight-modal .xk-preflight-meta-card {",
        "#xray-preflight-modal .xk-preflight-terminal-line.is-problem {",
        "background: var(--op-surface) !important;",
        "background: var(--op-editor) !important;",
    ):
        assert fragment in css

    operator_block = css[css.index("/* Xray preflight is an operational diagnostic") :]
    assert "linear-gradient" not in operator_block
    assert "radial-gradient" not in operator_block
    assert "#60a5fa" not in operator_block.lower()


def test_xray_preflight_stylesheet_cache_key_is_current():
    template = TEMPLATE.read_text(encoding="utf-8")
    assert "filename='panel-operator.css', v='20260806u'" in template

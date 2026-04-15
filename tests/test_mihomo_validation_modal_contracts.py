from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_mihomo_panel_validation_modal_uses_compact_premium_rendering_contract():
    script = (ROOT / "xkeen-ui" / "static" / "js" / "features" / "mihomo_panel.js").read_text(encoding="utf-8")
    template = (ROOT / "xkeen-ui" / "templates" / "panel.html").read_text(encoding="utf-8")
    styles = (ROOT / "xkeen-ui" / "static" / "styles.css").read_text(encoding="utf-8")

    assert "validationGrid: 'mihomo-validation-grid'" in script
    assert "validationCopyBtn: 'mihomo-validation-copy-btn'" in script
    assert "function buildValidationExplainItems(payload) {" in script
    assert "function extractMihomoValidationMessage(line) {" in script
    assert "function humanizeValidationMessage(message, lineCol) {" in script
    assert "mapping values are not allowed" in script
    assert "const rawSummary = String(" in script
    assert "function buildValidationCopyText(payload) {" in script
    assert "async function copyValidationDetails() {" in script
    assert "async function performValidationFromEditor() {" in script
    assert "firstMeaningfulValidationLine(log)" in script
    assert "if (grid && grid.dataset) grid.dataset.hasLog = hasLog ? '1' : '0';" in script
    assert "if (sidePanel) sidePanel.style.display = hasLog ? '' : 'none';" in script
    assert "setValidationSectionVisible(explainWrap, !!explainHtml);" in script
    assert "buildValidationMetaItems(payload)" in script
    assert "validationMetaWrap" not in script
    assert "renderValidationMetaHtml" not in script

    assert 'id="mihomo-validation-grid"' in template
    assert 'id="mihomo-validation-explain"' in template
    assert 'id="mihomo-validation-meta-wrap"' not in template
    assert 'id="mihomo-validation-copy-btn"' in template
    assert 'class="xk-mihomo-validation-terminal"' in template

    assert "#mihomo-validation-modal .modal-content {" in styles
    assert "max-height: min(86vh, 720px);" in styles
    assert "#mihomo-validation-modal .xk-mihomo-validation-grid[data-has-log=\"0\"] {" in styles
    assert "#mihomo-validation-modal .xk-mihomo-validation-terminal {" in styles
    assert "#mihomo-validation-modal .xk-mihomo-validation-copy-status.is-error {" in styles
    assert ".xk-mihomo-validation-meta-card" not in styles
    assert "html[data-theme=\"light\"] #mihomo-validation-modal .modal-content {" in styles

"""Stage 4 result-card contracts; interaction coverage lives in Playwright."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
JS = (ROOT / "xkeen-ui/static/js/features/mihomo_import.js").read_text(encoding="utf-8")
RESULT = (ROOT / "xkeen-ui/static/js/features/mihomo_import_result.js").read_text(encoding="utf-8")
TEMPLATE = (ROOT / "xkeen-ui/templates/panel/modals/mihomo.html").read_text(encoding="utf-8")
CSS = (ROOT / "xkeen-ui/static/panel-operator.css").read_text(encoding="utf-8")
PLAN = (ROOT / "README-mihomo-node-import-redesign-plan.md").read_text(encoding="utf-8")
DOC = (ROOT / "docs/mihomo-node-import-stage4.md").read_text(encoding="utf-8")


def test_stage4_has_a_safe_presentation_model_and_compact_status_host():
    assert "createMihomoImportPresentation" in JS
    assert "buildImportStatusSummary" in JS
    assert 'id="mihomo-import-status"' in TEMPLATE
    assert 'id="mihomo-import-result-cards"' not in TEMPLATE
    assert "safeMihomoSourceDomain" in RESULT
    assert "redactMihomoImportDiagnostic" in RESULT
    assert "textContent" in JS


def test_stage4_distinguishes_result_outcomes_and_special_sources():
    for fragment in (
        "outcome === 'blocked'",
        "outcome === 'unsupported'",
        "xray-subscription",
        "hwid-subscription",
        "provider-subscription",
        "amnezia",
        "name_conflict",
        "duplicateConnection",
    ):
        assert fragment in RESULT
    assert "mihomoCountryFlag" in JS
    assert "renderAmneziaLocations" in JS


def test_stage4_docs_and_operator_styles_are_present():
    assert "### Этап 4. Карточки результата и специальные источники — закрыт" in PLAN
    assert "Этап 4" in DOC
    assert "xk-mi-status" in CSS
    assert "safe domain" in DOC.lower() or "безопасн" in DOC.lower()

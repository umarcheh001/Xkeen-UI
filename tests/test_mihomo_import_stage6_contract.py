"""Stage 6 candidate/save/apply contracts; Playwright covers modal actions."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
JS = (ROOT / "xkeen-ui/static/js/features/mihomo_import.js").read_text(encoding="utf-8")
PANEL = (ROOT / "xkeen-ui/static/js/features/mihomo_panel.js").read_text(encoding="utf-8")
TEMPLATE = (ROOT / "xkeen-ui/templates/panel/modals/mihomo.html").read_text(encoding="utf-8")
ROUTE = (ROOT / "xkeen-ui/routes/mihomo.py").read_text(encoding="utf-8")
PLAN = (ROOT / "README-mihomo-node-import-redesign-plan.md").read_text(encoding="utf-8")
DOC = (ROOT / "docs/mihomo-node-import-stage6.md").read_text(encoding="utf-8")


def test_stage6_has_three_explicit_actions_and_candidate_summary():
    for fragment in (
        'id="mihomo-import-candidate-summary"',
        'id="mihomo-import-action-status"',
        'id="mihomo-import-insert-btn"',
        'id="mihomo-import-save-btn"',
        'id="mihomo-import-apply-btn"',
    ):
        assert fragment in TEMPLATE
    for fragment in (
        "buildImportCandidate",
        "draftCandidateToEditor",
        "commitCandidate(restart)",
        "base_revision: candidate.baseRevision",
        "restart: restart === true",
        "registerImportedXraySubscriptions(candidate.content",
    ):
        assert fragment in JS


def test_stage6_reuses_explicit_backend_commit_and_dirty_tracking():
    assert '@bp.post("/api/mihomo/import/commit")' in ROUTE
    assert "validate_config(new_content=content)" in ROUTE
    assert "restart_queued" in ROUTE
    assert "stale_config" in ROUTE
    assert "MP.markEditorClean = markEditorClean" in PANEL
    assert "### Этап 6. Полный candidate, summary и действия сохранения/применения — закрыт" in PLAN
    assert "Этап 6" in DOC

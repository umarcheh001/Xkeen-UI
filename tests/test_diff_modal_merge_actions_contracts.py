from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_diff_modal_exposes_bidirectional_apply_and_save_contracts():
    diff_modal = (ROOT / "xkeen-ui" / "static" / "js" / "ui" / "diff_modal.js").read_text(encoding="utf-8")
    routing = (ROOT / "xkeen-ui" / "static" / "js" / "features" / "routing.js").read_text(encoding="utf-8")
    mihomo = (ROOT / "xkeen-ui" / "static" / "js" / "features" / "mihomo_panel.js").read_text(encoding="utf-8")
    json_modal = (ROOT / "xkeen-ui" / "static" / "js" / "ui" / "json_editor_modal.js").read_text(encoding="utf-8")
    editor_shared = (ROOT / "xkeen-ui" / "static" / "js" / "pages" / "editor.shared.js").read_text(encoding="utf-8")
    styles = (ROOT / "xkeen-ui" / "static" / "styles.css").read_text(encoding="utf-8")

    assert "_applyToLeftBtnEl = makeBtn('← Влево'" in diff_modal
    assert "_applyToRightBtnEl = makeBtn('Вправо →'" in diff_modal
    assert "_saveBtnEl = makeBtn('Сохранить файл'" in diff_modal
    assert "function refreshActionButtons()" in diff_modal
    assert "async function applyHunkToSide(side)" in diff_modal
    assert "async function saveComparedFile()" in diff_modal
    assert "let _draftSideState = { left: false, right: false };" in diff_modal
    assert "function _getDraftSaveSide()" in diff_modal
    assert "_setSideTextState(targetSide, newText, true);" in diff_modal
    assert "const draftSaveSide = _getDraftSaveSide();" in diff_modal
    assert "() => applyHunkToSide('left')" in diff_modal
    assert "() => applyHunkToSide('right')" in diff_modal
    assert "scope.saveClosesOwner" in diff_modal
    assert "String(ev.key || '').toLowerCase() === 's'" in diff_modal

    # Disabled-state contracts: apply/save buttons must surface a tooltip reason
    # rather than disappearing when the action is structurally available but
    # contextually blocked (inline mode, no diff, nothing to save).
    assert "function _hasAnyDiff()" in diff_modal
    assert "function _hasAnyDraft()" in diff_modal
    assert "function _applyDisabledReason(side)" in diff_modal
    assert "function _saveDisabledReason()" in diff_modal
    assert "Перенос хунков доступен только в режиме «Бок-о-бок»" in diff_modal
    assert "Нет изменений для переноса" in diff_modal
    assert "Нет изменений для сохранения" in diff_modal
    assert "btn.classList.toggle('is-disabled', disabled);" in diff_modal

    # Dirty-state contract: Save button surfaces a visual indicator after Apply
    # and the modal asks for confirmation before discarding a non-buffer draft.
    assert "let _dirtySinceOpen = false;" in diff_modal
    assert "_dirtySinceOpen = true;" in diff_modal
    assert "_dirtySinceOpen = false;" in diff_modal
    assert "_saveBtnEl.classList.toggle('is-dirty'" in diff_modal
    assert "async function _confirmDiscardDraft()" in diff_modal
    assert "Несохранённые изменения" in diff_modal
    assert "if (r !== 'save' && _hasAnyDraft()) {" in diff_modal

    assert ".xkeen-diff-apply-group {" in styles
    assert ".xkeen-diff-foot-actions {" in styles
    assert ".xkeen-diff-save-btn {" in styles
    assert ".xkeen-diff-apply-btn.is-disabled" in styles
    assert ".xkeen-diff-save-btn.is-disabled" in styles
    assert ".xkeen-diff-save-btn.is-dirty::before" in styles

    assert "reason: 'diff.apply.side'" in routing
    assert "applyTextToSide: (_side, newText) => {" in routing

    assert "save: () => MP.saveConfig()," in mihomo
    assert "applyTextToSide: (_side, newText) => {" in mihomo
    assert "_diffBaselineText = content;" in mihomo

    assert "saveClosesOwner: true," in json_modal
    assert "const wasOpen = !!(modal && modal.classList && !modal.classList.contains('hidden'));" in json_modal
    assert "return wasOpen ? isClosed : false;" in json_modal

    assert "?v=20260428-diff4" in editor_shared

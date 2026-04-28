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

    assert "_applyToLeftBtnEl = makeBtn(" in diff_modal
    assert "_applyToRightBtnEl = makeBtn(" in diff_modal
    assert "_applyAllToLeftBtnEl = makeBtn(" in diff_modal
    assert "_applyAllToRightBtnEl = makeBtn(" in diff_modal
    assert "_revertBtnEl = makeBtn(" in diff_modal
    assert "_saveBtnEl = makeBtn(" in diff_modal
    assert "_ignoreWhitespaceToggleEl" in diff_modal
    assert "_ignoreWhitespaceInputEl" in diff_modal
    assert "function refreshActionButtons()" in diff_modal
    assert "async function applyAllChangesToSide(side)" in diff_modal
    assert "async function applyHunkToSide(side)" in diff_modal
    assert "async function revertComparedChanges()" in diff_modal
    assert "async function saveComparedFile()" in diff_modal
    assert "let _draftSideState = { left: false, right: false };" in diff_modal
    assert "let _dirtySinceOpen = false;" in diff_modal
    assert "let _baselineLeft = '';" in diff_modal
    assert "let _baselineRight = '';" in diff_modal
    assert "let _activeCm6Chunk = null;" in diff_modal
    assert "let _cm6ActiveHunkSyncTimer = 0;" in diff_modal
    assert "function _getDraftSaveSide()" in diff_modal
    assert "function _captureBaselineState()" in diff_modal
    assert "function _resetBaselineState()" in diff_modal
    assert "function _scheduleNextDiffNavigation()" in diff_modal
    assert "function _canRevertFromDiff()" in diff_modal
    assert "function _revertDisabledReason()" in diff_modal
    assert "function _supportsIgnoreTrimWhitespace()" in diff_modal
    assert "function _syncIgnoreWhitespaceToggle()" in diff_modal
    assert "function setIgnoreTrimWhitespace(flag)" in diff_modal
    assert "rt.view.EditorView.lineWrapping" in diff_modal
    assert "async function _refreshSourceOptions(scopeDef)" in diff_modal
    assert "function _setAppliedSummaryCount(count)" in diff_modal
    assert "function _resetAppliedSummaryCount()" in diff_modal
    assert "function _formatSummaryText(base)" in diff_modal
    assert "function _readCm6SideText(side)" in diff_modal
    assert "function _queueCm6SplitRefresh(next)" in diff_modal
    assert "function _ensureCm6ActiveHunkSupport(rt)" in diff_modal
    assert "function cm6ActiveHunkExtension(rt)" in diff_modal
    assert "function cm6SelectionSyncExtension(rt, side)" in diff_modal
    assert "function _applyActiveCm6HunkHighlight(chunk)" in diff_modal
    assert "function _syncActiveCm6HunkHighlight(preferredSide)" in diff_modal
    assert "function _scheduleCm6ActiveHunkHighlight(preferredSide)" in diff_modal
    assert "function _getMonacoInnerEditor(side)" in diff_modal
    assert "function _applyActiveMonacoHunkHighlight(change)" in diff_modal
    assert "function _syncActiveMonacoHunkHighlight(preferredSide)" in diff_modal
    assert "_setSideTextState(targetSide, newText, true);" in diff_modal
    assert "const draftSaveSide = _getDraftSaveSide();" in diff_modal
    assert "() => applyHunkToSide('left')" in diff_modal
    assert "() => applyHunkToSide('right')" in diff_modal
    assert "() => applyAllChangesToSide('left')" in diff_modal
    assert "() => applyAllChangesToSide('right')" in diff_modal
    assert "() => revertComparedChanges()" in diff_modal
    assert "() => setIgnoreTrimWhitespace(!!ignoreWhitespaceInput.checked)" in diff_modal
    assert "_scheduleNextDiffNavigation();" in diff_modal
    assert "_captureBaselineState();" in diff_modal
    assert "_resetBaselineState();" in diff_modal
    assert "_resetAppliedSummaryCount();" in diff_modal
    assert "_syncActiveMonacoHunkHighlight('right')" in diff_modal
    assert "await _refreshSourceOptions(scope);" in diff_modal
    assert "ignoreTrimWhitespace: !!_ignoreTrimWhitespace" in diff_modal
    assert "scope.saveClosesOwner" in diff_modal
    assert "String(ev.key || '').toLowerCase() === 's'" in diff_modal
    assert "_labelsRowEl.classList.toggle('hidden', !!hidden);" in diff_modal
    assert "перенесено: " in diff_modal
    assert "Хунк перенесён" not in diff_modal

    assert "function _hasAnyDiff()" in diff_modal
    assert "function _hasAnyDraft()" in diff_modal
    assert "function _applyDisabledReason(side)" in diff_modal
    assert "function _saveDisabledReason()" in diff_modal
    assert "btn.classList.toggle('is-disabled', disabled);" in diff_modal

    assert "_dirtySinceOpen = true;" in diff_modal
    assert "_dirtySinceOpen = false;" in diff_modal
    assert "_saveBtnEl.classList.toggle('is-dirty'" in diff_modal
    assert "async function _confirmDiscardDraft()" in diff_modal
    assert "if (r !== 'save' && _hasAnyDraft()) {" in diff_modal

    assert ".xkeen-diff-apply-group {" in styles
    assert ".xkeen-diff-foot-actions {" in styles
    assert ".xkeen-diff-save-btn {" in styles
    assert ".xkeen-diff-revert-btn {" in styles
    assert ".xkeen-diff-modal .xkeen-diff-ignore-toggle {" in styles
    assert ".xkeen-diff-modal .xkeen-diff-ignore-toggle input {" in styles
    assert ".xkeen-diff-modal .xkeen-diff-ignore-toggle.is-disabled {" in styles
    assert ".xkeen-diff-modal .monaco-editor .xkeen-diff-active-hunk-line {" in styles
    assert ".xkeen-diff-modal .monaco-editor .xkeen-diff-active-hunk-line-left {" in styles
    assert ".xkeen-diff-modal .monaco-editor .xkeen-diff-active-hunk-line-right {" in styles
    assert ".xkeen-diff-apply-btn.is-disabled" in styles
    assert ".xkeen-diff-revert-btn.is-disabled" in styles
    assert ".xkeen-diff-save-btn.is-disabled" in styles
    assert ".xkeen-diff-save-btn.is-dirty::before" in styles

    # CM6 backend visual contracts: vibrant Monaco-like syntax highlight,
    # synchronized two-pane scrolling.
    assert "function cm6HighlightExtension(rt)" in diff_modal
    assert "function _bindCm6ScrollSync()" in diff_modal
    assert "_bindCm6ScrollSync();" in diff_modal
    assert "@codemirror/language" in diff_modal
    assert "@lezer/highlight" in diff_modal
    # CM6 palette must cascade to .xkeen-diff-host so var(--xk-cm-keyword) etc.
    # resolve to the shared dark-Monaco-like palette and selection stays visible.
    assert "--xk-cm-keyword: #569cd6;" in styles
    assert ".xkeen-diff-modal .xkeen-diff-host .cm-selectionBackground" in styles
    assert ".xkeen-diff-modal .xkeen-diff-host .cm-lineWrapping {" in styles
    assert ".xkeen-diff-modal .xkeen-diff-host .cm-lineWrapping .cm-line {" in styles
    assert ".xkeen-diff-modal .xkeen-diff-host .cm-gutters {" in styles
    assert ".xkeen-diff-modal .xkeen-diff-host .cm-line.xkeen-diff-cm6-active-hunk-line {" in styles
    assert ".xkeen-diff-modal .xkeen-diff-host .cm-line.xkeen-diff-cm6-active-hunk-line-left {" in styles
    assert ".xkeen-diff-modal .xkeen-diff-host .cm-line.xkeen-diff-cm6-active-hunk-line-right {" in styles
    assert ".xkeen-diff-modal .xkeen-diff-host .cm-line.xkeen-diff-cm6-active-hunk-start {" in styles
    assert ".xkeen-diff-modal .xkeen-diff-host .cm-line.xkeen-diff-cm6-active-hunk-end {" in styles
    assert "background: var(--xk-cm-bg, #020617);" in styles
    assert "background-color: var(--xk-cm-bg, #020617);" in styles
    assert "background-color: var(--xk-cm-gutter-bg, var(--xk-cm-bg, #020617));" in styles
    assert "overflow-x: hidden;" in styles
    assert "overflow-y: auto;" in styles

    assert "reason: 'diff.apply.side'" in routing
    assert "applyTextToSide: (_side, newText) => {" in routing

    assert "save: () => MP.saveConfig()," in mihomo
    assert "applyTextToSide: (_side, newText) => {" in mihomo
    assert "_diffBaselineText = content;" in mihomo

    assert "saveClosesOwner: true," in json_modal
    assert "const wasOpen = !!(modal && modal.classList && !modal.classList.contains('hidden'));" in json_modal
    assert "return wasOpen ? isClosed : false;" in json_modal

    assert "?v=20260429-diff18" in editor_shared

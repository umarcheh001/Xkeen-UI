(() => {
  'use strict';

  // Diff modal — UI shell for comparing two text versions.
  //
  // Phase 1: Monaco backend only. The modal lazy-loads the Monaco runtime via
  // editorEngine.ensureRuntime('monaco') and uses monaco.editor.createDiffEditor.
  // CodeMirror 6 backend is planned for Phase 2 (@codemirror/merge).
  //
  // Public API:
  //   XKeen.ui.diffModal.open({
  //     title, language,
  //     left:  { text, title?, descriptor?, error? },
  //     right: { text, title?, descriptor?, error? },
  //     mode:  'split' | 'inline',
  //     ignoreTrimWhitespace: false,
  //     readOnly: true,
  //     scope: <scopeDef>     // optional, used for snapshot dropdown (Phase 3)
  //   })
  //   XKeen.ui.diffModal.close()
  //   XKeen.ui.diffModal.isOpen()

  window.XKeen = window.XKeen || {};
  const XKeen = window.XKeen;
  XKeen.ui = XKeen.ui || {};

  const ROOT_ID = 'xkeen-diff-modal';
  const HOST_ID = 'xkeen-diff-modal-host';

  let _bound = false;
  let _modalEl = null;
  let _hostEl = null;
  let _titleEl = null;
  let _leftLabelEl = null;
  let _rightLabelEl = null;
  let _leftSelectEl = null;
  let _rightSelectEl = null;
  let _summaryEl = null;
  let _errorEl = null;
  let _modeBtnSplitEl = null;
  let _modeBtnInlineEl = null;
  let _ignoreWhitespaceToggleEl = null;
  let _ignoreWhitespaceInputEl = null;
  let _navPrevBtnEl = null;
  let _navNextBtnEl = null;
  let _applyToLeftBtnEl = null;
  let _applyToRightBtnEl = null;
  let _applyAllToLeftBtnEl = null;
  let _applyAllToRightBtnEl = null;
  let _revertBtnEl = null;
  let _saveBtnEl = null;
  let _closeBtnEl = null;
  let _xBtnEl = null;

  let _diffEditor = null;
  let _originalModel = null;
  let _modifiedModel = null;
  let _activeSpec = null;
  let _activeMonaco = null;
  let _resizeBound = false;
  let _resolveOpen = null;
  let _sourceOptions = [];
  let _draftSideState = { left: false, right: false };
  let _dirtySinceOpen = false;
  let _baselineLeft = '';
  let _baselineRight = '';
  let _activeMonacoHunk = null;
  let _activeMonacoDecorationIds = { left: [], right: [] };
  let _ignoreTrimWhitespace = false;

  // 'monaco' | 'cm6' — chosen at open() time per the active editor engine.
  let _backendKind = null;
  let _cm6Runtime = null;
  let _cm6MergeView = null;
  let _cm6View = null;
  let _cm6BackendMode = null; // 'split' | 'inline'

  function isFn(x) { return typeof x === 'function'; }
  function asString(v) { return v == null ? '' : String(v); }
  function clone(o) { try { return JSON.parse(JSON.stringify(o || {})); } catch (e) { return {}; } }

  function getModalApi() {
    try { return (XKeen.ui && XKeen.ui.modal) ? XKeen.ui.modal : null; } catch (e) {}
    return null;
  }

  function getEditorEngine() {
    try { return (XKeen.ui && XKeen.ui.editorEngine) ? XKeen.ui.editorEngine : null; } catch (e) {}
    return null;
  }

  function showFeedback(message, kind) {
    const text = asString(message);
    if (!text) return;
    const tone = String(kind || 'info').toLowerCase();
    try {
      if (window.XKeen && XKeen.ui && isFn(XKeen.ui.toast)) return XKeen.ui.toast(text, tone);
    } catch (e) {}
    try { if (isFn(window.toast)) return window.toast(text, tone); } catch (e2) {}
    try { console.log('[xkeen-diff]', text); } catch (e3) {}
  }

  function ensureDom() {
    if (_modalEl) return _modalEl;

    const modal = document.createElement('div');
    modal.id = ROOT_ID;
    modal.className = 'modal hidden xkeen-diff-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', ROOT_ID + '-title');

    const card = document.createElement('div');
    card.className = 'modal-content xkeen-diff-card';

    const head = document.createElement('div');
    head.className = 'modal-header xkeen-diff-head';

    const title = document.createElement('h2');
    title.id = ROOT_ID + '-title';
    title.className = 'modal-title';
    title.textContent = 'Сравнить версии';
    _titleEl = title;

    const headRight = document.createElement('div');
    headRight.className = 'xkeen-diff-head-actions';

    const modeGroup = document.createElement('div');
    modeGroup.className = 'xkeen-diff-mode';
    modeGroup.setAttribute('role', 'group');
    modeGroup.setAttribute('aria-label', 'Режим сравнения');

    _modeBtnSplitEl = makeBtn('Бок-о-бок', 'btn-secondary xkeen-diff-mode-btn is-active',
      () => setMode('split'),
      'Бок-о-бок · оригинал и новая версия в двух колонках');
    _modeBtnSplitEl.dataset.mode = 'split';
    _modeBtnInlineEl = makeBtn('Подряд', 'btn-secondary xkeen-diff-mode-btn',
      () => setMode('inline'),
      'Подряд · все изменения в одном потоке (как git diff)');
    _modeBtnInlineEl.dataset.mode = 'inline';
    modeGroup.appendChild(_modeBtnSplitEl);
    modeGroup.appendChild(_modeBtnInlineEl);

    const ignoreWhitespaceToggle = document.createElement('label');
    ignoreWhitespaceToggle.className = 'xkeen-diff-ignore-toggle';
    ignoreWhitespaceToggle.setAttribute('data-tooltip', 'Игнорировать различия только в пробельных символах');
    const ignoreWhitespaceInput = document.createElement('input');
    ignoreWhitespaceInput.type = 'checkbox';
    ignoreWhitespaceInput.setAttribute('aria-label', 'Игнорировать пробелы');
    ignoreWhitespaceInput.addEventListener('change', () => setIgnoreTrimWhitespace(!!ignoreWhitespaceInput.checked));
    const ignoreWhitespaceText = document.createElement('span');
    ignoreWhitespaceText.textContent = 'Игнорировать пробелы';
    ignoreWhitespaceToggle.appendChild(ignoreWhitespaceInput);
    ignoreWhitespaceToggle.appendChild(ignoreWhitespaceText);
    _ignoreWhitespaceToggleEl = ignoreWhitespaceToggle;
    _ignoreWhitespaceInputEl = ignoreWhitespaceInput;

    const navGroup = document.createElement('div');
    navGroup.className = 'xkeen-diff-nav';
    _navPrevBtnEl = makeBtn('▲', 'btn-secondary btn-icon', () => navigateDiff(-1), 'К предыдущему изменению (Shift+F3)');
    _navNextBtnEl = makeBtn('▼', 'btn-secondary btn-icon', () => navigateDiff(1), 'К следующему изменению (F3)');
    navGroup.appendChild(_navPrevBtnEl);
    navGroup.appendChild(_navNextBtnEl);

    const applyGroup = document.createElement('div');
    applyGroup.className = 'xkeen-diff-apply-group';
    _applyAllToLeftBtnEl = makeBtn('Все ←', 'btn-secondary xkeen-diff-apply-btn hidden',
      () => applyAllChangesToSide('left'),
      'Перенести все изменения из правой версии в левую');
    _applyAllToRightBtnEl = makeBtn('Все →', 'btn-secondary xkeen-diff-apply-btn hidden',
      () => applyAllChangesToSide('right'),
      'Перенести все изменения из левой версии в правую');
    _applyToLeftBtnEl = makeBtn('← Влево', 'btn-secondary xkeen-diff-apply-btn hidden',
      () => applyHunkToSide('left'),
      'Перенести текущий хунк из правой версии в левую');
    _applyToRightBtnEl = makeBtn('Вправо →', 'btn-secondary xkeen-diff-apply-btn hidden',
      () => applyHunkToSide('right'),
      'Перенести текущий хунк из левой версии в правую');
    applyGroup.appendChild(_applyAllToLeftBtnEl);
    applyGroup.appendChild(_applyAllToRightBtnEl);
    applyGroup.appendChild(_applyToLeftBtnEl);
    applyGroup.appendChild(_applyToRightBtnEl);

    _xBtnEl = makeBtn('×', 'btn-icon xkeen-diff-close-x', () => close('x'), 'Закрыть окно сравнения (Esc)');

    headRight.appendChild(modeGroup);
    headRight.appendChild(ignoreWhitespaceToggle);
    headRight.appendChild(navGroup);
    headRight.appendChild(applyGroup);
    headRight.appendChild(_xBtnEl);

    head.appendChild(title);
    head.appendChild(headRight);

    const labels = document.createElement('div');
    labels.className = 'xkeen-diff-labels';

    const leftWrap = document.createElement('div');
    leftWrap.className = 'xkeen-diff-side xkeen-diff-side-left';
    _leftLabelEl = document.createElement('span');
    _leftLabelEl.className = 'xkeen-diff-label xkeen-diff-label-left';
    _leftLabelEl.textContent = 'Слева';
    _leftSelectEl = document.createElement('select');
    _leftSelectEl.className = 'xkeen-diff-source';
    _leftSelectEl.setAttribute('aria-label', 'Источник слева');
    _leftSelectEl.setAttribute('data-tooltip', 'Источник для левой стороны: текущий буфер редактора, файл с диска или сохранённый снэпшот');
    _leftSelectEl.addEventListener('change', () => onSourceChanged('left'));
    leftWrap.appendChild(_leftLabelEl);
    leftWrap.appendChild(_leftSelectEl);

    const sep = document.createElement('span');
    sep.className = 'xkeen-diff-side-sep';
    sep.textContent = '↔';

    const rightWrap = document.createElement('div');
    rightWrap.className = 'xkeen-diff-side xkeen-diff-side-right';
    _rightLabelEl = document.createElement('span');
    _rightLabelEl.className = 'xkeen-diff-label xkeen-diff-label-right';
    _rightLabelEl.textContent = 'Справа';
    _rightSelectEl = document.createElement('select');
    _rightSelectEl.className = 'xkeen-diff-source';
    _rightSelectEl.setAttribute('aria-label', 'Источник справа');
    _rightSelectEl.setAttribute('data-tooltip', 'Источник для правой стороны: текущий буфер редактора, файл с диска или сохранённый снэпшот');
    _rightSelectEl.addEventListener('change', () => onSourceChanged('right'));
    rightWrap.appendChild(_rightLabelEl);
    rightWrap.appendChild(_rightSelectEl);

    labels.appendChild(leftWrap);
    labels.appendChild(sep);
    labels.appendChild(rightWrap);

    const errorBanner = document.createElement('div');
    errorBanner.className = 'xkeen-diff-error hidden';
    errorBanner.setAttribute('role', 'alert');
    _errorEl = errorBanner;

    const host = document.createElement('div');
    host.id = HOST_ID;
    host.className = 'xkeen-diff-host';
    _hostEl = host;

    const summary = document.createElement('div');
    summary.className = 'xkeen-diff-summary';
    _summaryEl = summary;

    const foot = document.createElement('div');
    foot.className = 'modal-actions xkeen-diff-foot';
    const footActions = document.createElement('div');
    footActions.className = 'xkeen-diff-foot-actions';
    _revertBtnEl = makeBtn('Отменить изменения', 'btn-secondary xkeen-diff-revert-btn hidden',
      () => revertComparedChanges(),
      'Вернуть обе стороны к состоянию на момент открытия сравнения');
    _saveBtnEl = makeBtn('Сохранить файл', 'btn-primary xkeen-diff-save-btn hidden',
      () => saveComparedFile(),
      'Сохранить активный буфер в файл (Ctrl+S)');
    _closeBtnEl = makeBtn('Закрыть', 'btn-secondary', () => close('close'), 'Закрыть окно сравнения (Esc)');
    footActions.appendChild(_revertBtnEl);
    footActions.appendChild(_saveBtnEl);
    footActions.appendChild(_closeBtnEl);
    foot.appendChild(summary);
    foot.appendChild(footActions);

    card.appendChild(head);
    card.appendChild(labels);
    card.appendChild(errorBanner);
    card.appendChild(host);
    card.appendChild(foot);
    modal.appendChild(card);

    document.body.appendChild(modal);

    if (!_bound) {
      _bound = true;
      modal.addEventListener('click', (ev) => {
        if (ev && ev.target === modal) close('backdrop');
      });
      document.addEventListener('keydown', (ev) => {
        if (!isOpen()) return;
        if (ev && ev.key === 'Escape') {
          ev.preventDefault();
          close('escape');
        } else if (ev && ev.key === 'F3') {
          ev.preventDefault();
          navigateDiff(ev.shiftKey ? -1 : 1);
        } else if (ev && (ev.ctrlKey || ev.metaKey) && !ev.altKey && String(ev.key || '').toLowerCase() === 's') {
          if (!_canSaveFromDiff()) return;
          ev.preventDefault();
          saveComparedFile();
        }
      });
    }

    _modalEl = modal;
    return modal;
  }

  function makeBtn(text, cls, onClick, tip) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls || '';
    b.textContent = text;
    if (tip) {
      try { b.setAttribute('data-tooltip', tip); } catch (e) {}
      try { b.setAttribute('aria-label', tip); } catch (e2) {}
    }
    b.addEventListener('click', (ev) => {
      try { ev.preventDefault(); ev.stopPropagation(); } catch (e) {}
      try { if (isFn(onClick)) onClick(); } catch (e2) {}
    });
    return b;
  }

  function isOpen() {
    if (!_modalEl) return false;
    try { return !_modalEl.classList.contains('hidden'); } catch (e) {}
    return false;
  }

  function showError(message) {
    if (!_errorEl) return;
    const text = asString(message);
    _errorEl.textContent = text;
    _errorEl.classList.toggle('hidden', !text);
  }

  function setLabels(spec) {
    const s = spec || {};
    if (_leftLabelEl) _leftLabelEl.textContent = asString((s.left && s.left.title) || 'Слева');
    if (_rightLabelEl) _rightLabelEl.textContent = asString((s.right && s.right.title) || 'Справа');
  }

  function descriptorToValue(d) {
    if (!d || typeof d !== 'object') return 'buffer';
    const kind = String(d.source || '').trim().toLowerCase();
    if (kind === 'snapshot') {
      const id = String(d.id || d.snapshotId || '').trim();
      return id ? ('snapshot:' + id) : 'snapshot';
    }
    if (kind === 'reload') return 'disk';
    return kind || 'buffer';
  }

  function findOption(value) {
    const v = String(value == null ? '' : value);
    for (let i = 0; i < _sourceOptions.length; i += 1) {
      if (_sourceOptions[i] && _sourceOptions[i].value === v) return _sourceOptions[i];
    }
    return null;
  }

  function buildOptions(scopeDef, snapshots) {
    const out = [];
    if (!scopeDef) return out;
    if (isFn(scopeDef.getCurrent)) {
      out.push({ value: 'buffer', label: 'Текущий буфер', descriptor: { source: 'buffer' } });
    }
    if (isFn(scopeDef.getBaseline) || isFn(scopeDef.reloadFromDisk)) {
      out.push({ value: 'disk', label: 'Сохранённый файл', descriptor: { source: 'disk' } });
    }
    const list = Array.isArray(snapshots) ? snapshots : [];
    list.forEach((s) => {
      if (!s || typeof s !== 'object') return;
      const id = String(s.id || '').trim();
      if (!id) return;
      const label = String(s.label || id).trim();
      out.push({
        value: 'snapshot:' + id,
        label: 'Снэпшот · ' + label,
        descriptor: { source: 'snapshot', id: id, label: label },
      });
    });
    return out;
  }

  function populateSelect(selectEl, options, selectedValue) {
    if (!selectEl) return;
    while (selectEl.firstChild) selectEl.removeChild(selectEl.firstChild);
    options.forEach((opt) => {
      const o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.label;
      selectEl.appendChild(o);
    });
    const want = String(selectedValue == null ? '' : selectedValue);
    if (want && findOption(want)) {
      selectEl.value = want;
    } else if (options.length) {
      selectEl.value = options[0].value;
    }
  }

  async function loadSnapshotList(scopeDef) {
    if (!scopeDef || !isFn(scopeDef.listSnapshots)) return [];
    try {
      const items = await Promise.resolve(scopeDef.listSnapshots());
      return Array.isArray(items) ? items : [];
    } catch (e) {
      return [];
    }
  }

  function setSelectorsHidden(hidden) {
    if (_leftSelectEl) _leftSelectEl.classList.toggle('hidden', !!hidden);
    if (_rightSelectEl) _rightSelectEl.classList.toggle('hidden', !!hidden);
  }

  async function _refreshSourceOptions(scopeDef) {
    if (!scopeDef) return;
    const snaps = await loadSnapshotList(scopeDef);
    _sourceOptions = buildOptions(scopeDef, snaps);
    const leftValue = descriptorToValue(_activeSpec && _activeSpec.left && _activeSpec.left.descriptor);
    const rightValue = descriptorToValue(_activeSpec && _activeSpec.right && _activeSpec.right.descriptor);
    populateSelect(_leftSelectEl, _sourceOptions, leftValue);
    populateSelect(_rightSelectEl, _sourceOptions, rightValue);
  }

  async function onSourceChanged(side) {
    const scopeDef = _activeSpec && _activeSpec.scope;
    if (!scopeDef) return;
    const sel = side === 'left' ? _leftSelectEl : _rightSelectEl;
    if (!sel) return;
    const opt = findOption(sel.value);
    if (!opt) return;
    const descriptor = opt.descriptor || { source: 'buffer' };
    const diffApi = (XKeen.ui && XKeen.ui.diff) || null;
    if (!diffApi || !isFn(diffApi.resolveSourceText)) return;
    showError('');
    let text = '';
    try {
      text = await diffApi.resolveSourceText(scopeDef, descriptor);
    } catch (err) {
      showError((side === 'left' ? 'Слева: ' : 'Справа: ') + String(err && err.message || err));
      return;
    }
    if (_backendKind === 'cm6') {
      cm6SetText(side, asString(text));
    } else {
      const model = side === 'left' ? _originalModel : _modifiedModel;
      try {
        if (model && isFn(model.setValue)) model.setValue(asString(text));
      } catch (e) {}
    }
    if (_activeSpec) {
      const sideKey = side === 'left' ? 'left' : 'right';
      const cur = _activeSpec[sideKey] || {};
      _activeSpec[sideKey] = Object.assign({}, cur, {
        text: asString(text),
        descriptor: descriptor,
        title: opt.label,
        error: '',
      });
    }
    _setSideDraft(side, false);
    if (!_dirtySinceOpen && !_hasAnyDraft()) _captureBaselineState();
    refreshActionButtons();
    try {
      const leftDesc = _activeSpec && _activeSpec.left && _activeSpec.left.descriptor;
      const rightDesc = _activeSpec && _activeSpec.right && _activeSpec.right.descriptor;
      if (diffApi && isFn(diffApi.logDiff)) {
        diffApi.logDiff(
          scopeDef.scope || '',
          (leftDesc && leftDesc.source) || '',
          (rightDesc && rightDesc.source) || ''
        );
      }
    } catch (e) {}
    setTimeout(updateSummary, 60);
  }

  function setMode(mode) {
    const next = (String(mode || '').toLowerCase() === 'inline') ? 'inline' : 'split';
    if (_modeBtnSplitEl) _modeBtnSplitEl.classList.toggle('is-active', next === 'split');
    if (_modeBtnInlineEl) _modeBtnInlineEl.classList.toggle('is-active', next === 'inline');
    if (_backendKind === 'monaco' && _diffEditor && isFn(_diffEditor.updateOptions)) {
      try { _diffEditor.updateOptions({ renderSideBySide: next === 'split' }); } catch (e) {}
    } else if (_backendKind === 'cm6' && next !== _cm6BackendMode && _activeSpec) {
      const left = (_activeSpec.left && _activeSpec.left.text) || '';
      const right = (_activeSpec.right && _activeSpec.right.text) || '';
      const language = _activeSpec.language || 'text';
      const readOnly = _activeSpec.readOnly !== false;
      renderCM6Diff(_hostEl, { leftText: left, rightText: right, language: language, mode: next, readOnly: readOnly })
        .then(() => setTimeout(updateSummary, 60))
        .catch((err) => showError(String(err && err.message || err)));
    }
    if (_activeSpec) _activeSpec.mode = next;
    refreshActionButtons();
    try {
      const lazy = window.XKeen && XKeen.runtime && XKeen.runtime.lazy;
      if (lazy && isFn(lazy.scheduleLayout)) lazy.scheduleLayout();
    } catch (e) {}
    try { if (_backendKind === 'monaco' && _diffEditor && isFn(_diffEditor.layout)) _diffEditor.layout(); } catch (e2) {}
    if (_backendKind === 'monaco') setTimeout(() => _syncActiveMonacoHunkHighlight('right'), 0);
  }

  function _supportsIgnoreTrimWhitespace() {
    return _backendKind === 'monaco';
  }

  function _syncIgnoreWhitespaceToggle() {
    if (!_ignoreWhitespaceToggleEl || !_ignoreWhitespaceInputEl) return;
    const supported = _supportsIgnoreTrimWhitespace();
    try {
      _ignoreWhitespaceInputEl.checked = !!_ignoreTrimWhitespace;
      _ignoreWhitespaceInputEl.disabled = !supported;
      _ignoreWhitespaceToggleEl.classList.toggle('is-disabled', !supported);
      _ignoreWhitespaceToggleEl.setAttribute('data-tooltip', supported
        ? 'Игнорировать различия только в пробельных символах'
        : 'Игнорирование пробелов сейчас доступно только для Monaco diff');
    } catch (e) {}
  }

  function setIgnoreTrimWhitespace(flag) {
    const next = !!flag;
    _ignoreTrimWhitespace = next;
    if (_activeSpec) _activeSpec.ignoreTrimWhitespace = next;
    _syncIgnoreWhitespaceToggle();
    if (_backendKind !== 'monaco' || !_diffEditor || !isFn(_diffEditor.updateOptions)) return;
    try {
      _diffEditor.updateOptions({ ignoreTrimWhitespace: next });
    } catch (e) {}
    setTimeout(updateSummary, 80);
  }

  function _getMonacoInnerEditor(side) {
    if (!_diffEditor) return null;
    try {
      if (side === 'left' && isFn(_diffEditor.getOriginalEditor)) return _diffEditor.getOriginalEditor();
      if (side === 'right' && isFn(_diffEditor.getModifiedEditor)) return _diffEditor.getModifiedEditor();
    } catch (e) {}
    return null;
  }

  function _normalizeMonacoHighlightLine(startLine, endLine, fallbackLine) {
    let start = Number(startLine || 0);
    let end = Number(endLine || 0);
    const fallback = Math.max(1, Number(fallbackLine || 1));
    if (start <= 0 && end <= 0) {
      start = fallback;
      end = fallback;
    } else {
      if (start <= 0) start = end > 0 ? end : fallback;
      if (end <= 0) end = start;
    }
    if (end < start) end = start;
    return { start: start, end: end };
  }

  function _createMonacoHunkDecoration(side, change) {
    if (!_activeMonaco || !change) return null;
    const isLeft = side === 'left';
    const startLine = isLeft ? change.originalStartLineNumber : change.modifiedStartLineNumber;
    const endLine = isLeft ? change.originalEndLineNumber : change.modifiedEndLineNumber;
    const fallbackLine = isLeft
      ? (change.originalStartLineNumber || change.modifiedStartLineNumber || change.modifiedEndLineNumber || 1)
      : (change.modifiedStartLineNumber || change.originalStartLineNumber || change.originalEndLineNumber || 1);
    const span = _normalizeMonacoHighlightLine(startLine, endLine, fallbackLine);
    return {
      range: new _activeMonaco.Range(span.start, 1, span.end, 1),
      options: {
        description: 'xkeen-diff-active-hunk-' + side,
        isWholeLine: true,
        className: 'xkeen-diff-active-hunk-line xkeen-diff-active-hunk-line-' + side,
        linesDecorationsClassName: 'xkeen-diff-active-hunk-gutter xkeen-diff-active-hunk-gutter-' + side,
      },
    };
  }

  function _clearActiveMonacoHunkHighlight() {
    const leftEditor = _getMonacoInnerEditor('left');
    const rightEditor = _getMonacoInnerEditor('right');
    try {
      if (leftEditor && isFn(leftEditor.deltaDecorations)) {
        _activeMonacoDecorationIds.left = leftEditor.deltaDecorations(_activeMonacoDecorationIds.left || [], []);
      }
    } catch (e) {}
    try {
      if (rightEditor && isFn(rightEditor.deltaDecorations)) {
        _activeMonacoDecorationIds.right = rightEditor.deltaDecorations(_activeMonacoDecorationIds.right || [], []);
      }
    } catch (e2) {}
    _activeMonacoHunk = null;
  }

  function _applyActiveMonacoHunkHighlight(change) {
    if (!_activeMonaco || !_diffEditor || !change) {
      _clearActiveMonacoHunkHighlight();
      return;
    }
    const leftEditor = _getMonacoInnerEditor('left');
    const rightEditor = _getMonacoInnerEditor('right');
    const leftDecorations = [];
    const rightDecorations = [];
    const leftDecoration = _createMonacoHunkDecoration('left', change);
    const rightDecoration = _createMonacoHunkDecoration('right', change);
    if (leftDecoration) leftDecorations.push(leftDecoration);
    if (rightDecoration) rightDecorations.push(rightDecoration);
    try {
      if (leftEditor && isFn(leftEditor.deltaDecorations)) {
        _activeMonacoDecorationIds.left = leftEditor.deltaDecorations(_activeMonacoDecorationIds.left || [], leftDecorations);
      }
    } catch (e) {}
    try {
      if (rightEditor && isFn(rightEditor.deltaDecorations)) {
        _activeMonacoDecorationIds.right = rightEditor.deltaDecorations(_activeMonacoDecorationIds.right || [], rightDecorations);
      }
    } catch (e2) {}
    _activeMonacoHunk = change || null;
  }

  function _syncActiveMonacoHunkHighlight(preferredSide) {
    if (_backendKind !== 'monaco' || !_diffEditor || !isFn(_diffEditor.getLineChanges)) {
      _clearActiveMonacoHunkHighlight();
      return null;
    }
    let changes = [];
    try {
      changes = _diffEditor.getLineChanges() || [];
    } catch (e) {
      changes = [];
    }
    if (!changes.length) {
      _clearActiveMonacoHunkHighlight();
      return null;
    }
    const sideKey = preferredSide === 'left' ? 'left' : 'right';
    const primaryEditor = _getMonacoInnerEditor(sideKey);
    const fallbackEditor = _getMonacoInnerEditor(sideKey === 'left' ? 'right' : 'left');
    const editor = primaryEditor || fallbackEditor;
    let currentLine = 1;
    try {
      const pos = editor && isFn(editor.getPosition) ? editor.getPosition() : null;
      currentLine = pos ? Number(pos.lineNumber || 1) : 1;
    } catch (e2) {}
    const chunk = _pickMonacoHunk(changes, currentLine, 1);
    if (!chunk) {
      _clearActiveMonacoHunkHighlight();
      return null;
    }
    _applyActiveMonacoHunkHighlight(chunk);
    return chunk;
  }

  function navigateDiff(direction) {
    const dir = (Number(direction) || 0) >= 0 ? 1 : -1;
    if (_backendKind === 'cm6') {
      cm6Navigate(dir);
      return;
    }
    if (!_diffEditor) return;
    const id = dir > 0 ? 'editor.action.diffReview.next' : 'editor.action.diffReview.prev';

    try {
      const inner = isFn(_diffEditor.getModifiedEditor) ? _diffEditor.getModifiedEditor() : null;
      if (inner && isFn(inner.getAction)) {
        const action = inner.getAction(id);
        if (action && isFn(action.run)) {
          Promise.resolve(action.run())
            .then(() => setTimeout(() => _syncActiveMonacoHunkHighlight('right'), 20))
            .catch(() => {});
          return;
        }
      }
    } catch (e) {}

    try {
      if (isFn(_diffEditor.getLineChanges)) {
        const changes = _diffEditor.getLineChanges() || [];
        if (!changes.length) {
          showFeedback('Различий не найдено', 'info');
          return;
        }
        const inner = isFn(_diffEditor.getModifiedEditor) ? _diffEditor.getModifiedEditor() : null;
        const pos = inner && isFn(inner.getPosition) ? inner.getPosition() : null;
        const currentLine = pos ? Number(pos.lineNumber || 1) : 1;
        let target = null;
        if (dir > 0) {
          for (let i = 0; i < changes.length; i += 1) {
            const c = changes[i];
            if (c && Number(c.modifiedStartLineNumber || 0) > currentLine) { target = c; break; }
          }
          if (!target) target = changes[0];
        } else {
          for (let i = changes.length - 1; i >= 0; i -= 1) {
            const c = changes[i];
            if (c && Number(c.modifiedStartLineNumber || 0) < currentLine) { target = c; break; }
          }
          if (!target) target = changes[changes.length - 1];
        }
        if (target && inner && isFn(inner.revealLineInCenter)) {
          inner.revealLineInCenter(Number(target.modifiedStartLineNumber || 1));
          if (isFn(inner.setPosition)) inner.setPosition({
            lineNumber: Number(target.modifiedStartLineNumber || 1),
            column: 1,
          });
        }
        _applyActiveMonacoHunkHighlight(target);
      }
    } catch (e) {}
  }

  function updateSummary() {
    if (!_summaryEl) return;
    try {
      if (_backendKind === 'cm6') {
        const stats = cm6Stats();
        if (!stats.count) {
          _clearActiveMonacoHunkHighlight();
          _summaryEl.textContent = 'Различий нет';
          return;
        }
        _clearActiveMonacoHunkHighlight();
        _summaryEl.textContent = 'Изменений: ' + stats.count + '  ·  +' + stats.added + ' / −' + stats.removed;
        return;
      }
      const changes = _diffEditor && isFn(_diffEditor.getLineChanges) ? (_diffEditor.getLineChanges() || []) : [];
      if (!changes.length) {
        _clearActiveMonacoHunkHighlight();
        _summaryEl.textContent = 'Различий нет';
        return;
      }
      let added = 0;
      let removed = 0;
      for (let i = 0; i < changes.length; i += 1) {
        const c = changes[i] || {};
        const ms = Number(c.modifiedStartLineNumber || 0);
        const me = Number(c.modifiedEndLineNumber || 0);
        const os = Number(c.originalStartLineNumber || 0);
        const oe = Number(c.originalEndLineNumber || 0);
        if (me >= ms && ms > 0) added += (me - ms + 1);
        if (oe >= os && os > 0) removed += (oe - os + 1);
      }
      _summaryEl.textContent = 'Изменений: ' + changes.length + '  ·  +' + added + ' / −' + removed;
      _syncActiveMonacoHunkHighlight('right');
    } catch (e) {
      _clearActiveMonacoHunkHighlight();
      _summaryEl.textContent = '';
    }
    try { refreshActionButtons(); } catch (e) {}
  }

  async function ensureMonaco() {
    const engine = getEditorEngine();
    if (!engine) throw new Error('editorEngine is not available');

    const support = isFn(engine.ensureSupport) ? await engine.ensureSupport('monaco', {}) : null;
    if (!support || !support.api) {
      throw new Error('Не удалось загрузить Monaco для сравнения');
    }
    if (!support.api.editor || !isFn(support.api.editor.createDiffEditor)) {
      throw new Error('Monaco DiffEditor API недоступен');
    }
    return support.api;
  }

  function disposeDiff() {
    _clearActiveMonacoHunkHighlight();
    try { if (_diffEditor && isFn(_diffEditor.dispose)) _diffEditor.dispose(); } catch (e) {}
    _diffEditor = null;
    try { if (_originalModel && isFn(_originalModel.dispose)) _originalModel.dispose(); } catch (e) {}
    try { if (_modifiedModel && isFn(_modifiedModel.dispose)) _modifiedModel.dispose(); } catch (e) {}
    _originalModel = null;
    _modifiedModel = null;
    _activeMonacoDecorationIds = { left: [], right: [] };
    _activeMonacoHunk = null;
    disposeCM6();
    _backendKind = null;
    _syncIgnoreWhitespaceToggle();
  }

  function disposeCM6() {
    try { if (_cm6MergeView && isFn(_cm6MergeView.destroy)) _cm6MergeView.destroy(); } catch (e) {}
    try { if (_cm6View && isFn(_cm6View.destroy)) _cm6View.destroy(); } catch (e) {}
    _cm6MergeView = null;
    _cm6View = null;
    _cm6BackendMode = null;
  }

  function pickBackend() {
    try {
      const eng = (XKeen.ui && XKeen.ui.editorEngine) ? XKeen.ui.editorEngine : null;
      if (eng && isFn(eng.get) && String(eng.get() || '') === 'codemirror') return 'cm6';
    } catch (e) {}
    return 'monaco';
  }

  async function ensureCM6Merge() {
    if (_cm6Runtime) return _cm6Runtime;
    const merge = await import('@codemirror/merge');
    const state = await import('@codemirror/state');
    const view = await import('@codemirror/view');
    const cm = await import('codemirror');
    let langJson = null;
    let langYaml = null;
    try { langJson = await import('@codemirror/lang-json'); } catch (e) {}
    try { langYaml = await import('@codemirror/lang-yaml'); } catch (e) {}
    _cm6Runtime = { merge, state, view, cm, langJson, langYaml };
    return _cm6Runtime;
  }

  function cm6LanguageExtension(rt, language) {
    const want = String(language || '').toLowerCase().trim();
    if ((want === 'json' || want === 'jsonc') && rt.langJson && isFn(rt.langJson.json)) {
      try { return rt.langJson.json(); } catch (e) {}
    }
    if ((want === 'yaml' || want === 'yml') && rt.langYaml && isFn(rt.langYaml.yaml)) {
      try { return rt.langYaml.yaml(); } catch (e) {}
    }
    return null;
  }

  function cm6BaseExtensions(rt, language, readOnly) {
    const ext = [];
    if (rt.cm && rt.cm.basicSetup) ext.push(rt.cm.basicSetup);
    const langExt = cm6LanguageExtension(rt, language);
    if (langExt) ext.push(langExt);
    if (readOnly && rt.view && rt.view.EditorView && isFn(rt.view.EditorView.editable && rt.view.EditorView.editable.of)) {
      ext.push(rt.view.EditorView.editable.of(false));
    }
    // Localize the merge view's "$ unchanged lines" placeholder shown by
    // collapsedUnchanged folds — the default English copy looks foreign in
    // the panel and gives no hint that it's clickable. The phrase facet
    // substitutes "$" with the line count automatically.
    try {
      if (rt.state && rt.state.EditorState && isFn(rt.state.EditorState.phrases && rt.state.EditorState.phrases.of)) {
        ext.push(rt.state.EditorState.phrases.of({
          '$ unchanged lines': '$ одинаковых строк свёрнуто · нажмите, чтобы развернуть',
        }));
      }
    } catch (e) {}
    return ext;
  }

  async function renderCM6Diff(host, opts) {
    const rt = await ensureCM6Merge();
    const leftText = asString(opts.leftText);
    const rightText = asString(opts.rightText);
    const language = opts.language || 'text';
    const mode = String(opts.mode || 'split').toLowerCase() === 'inline' ? 'inline' : 'split';
    const readOnly = opts.readOnly !== false;
    // Don't fold when both sides are identical — otherwise the entire document
    // collapses into a single "N unchanged lines" stub and the user sees an
    // empty modal (Monaco shows full text in this case, so match that).
    const collapseUnchanged = (leftText === rightText) ? null : { margin: 3, minSize: 4 };

    disposeCM6();
    while (host && host.firstChild) host.removeChild(host.firstChild);

    if (mode === 'inline') {
      const baseExt = cm6BaseExtensions(rt, language, readOnly);
      const unifiedOpts = {
        original: leftText,
        mergeControls: false,
      };
      if (collapseUnchanged) unifiedOpts.collapseUnchanged = collapseUnchanged;
      const unified = rt.merge.unifiedMergeView(unifiedOpts);
      const state = rt.state.EditorState.create({
        doc: rightText,
        extensions: [].concat(baseExt, unified),
      });
      _cm6View = new rt.view.EditorView({ state: state, parent: host });
      _cm6BackendMode = 'inline';
    } else {
      const baseExtA = cm6BaseExtensions(rt, language, true);
      const baseExtB = cm6BaseExtensions(rt, language, readOnly);
      const mergeOpts = {
        a: { doc: leftText, extensions: baseExtA },
        b: { doc: rightText, extensions: baseExtB },
        parent: host,
        orientation: 'a-b',
        highlightChanges: true,
        gutter: true,
      };
      if (collapseUnchanged) mergeOpts.collapseUnchanged = collapseUnchanged;
      _cm6MergeView = new rt.merge.MergeView(mergeOpts);
      _cm6BackendMode = 'split';
    }
    _backendKind = 'cm6';
  }

  function cm6PrimaryView() {
    if (_cm6BackendMode === 'inline') return _cm6View;
    return _cm6MergeView ? _cm6MergeView.b : null;
  }

  function cm6SetText(side, text) {
    const rt = _cm6Runtime;
    if (!rt) return;
    const value = asString(text);
    if (_cm6BackendMode === 'inline') {
      const view = _cm6View;
      if (!view) return;
      if (side === 'left') {
        try {
          if (rt.merge && rt.merge.updateOriginalDoc && rt.state && rt.state.Text && rt.state.ChangeSet) {
            const newDoc = rt.state.Text.of(value.split('\n'));
            const empty = rt.state.ChangeSet.empty(view.state.doc.length);
            view.dispatch({
              effects: rt.merge.updateOriginalDoc.of({ doc: newDoc, changes: empty }),
            });
            return;
          }
        } catch (e) {}
        // Fallback: rebuild the view with the new "original".
        renderCM6Diff(_hostEl, {
          leftText: value,
          rightText: view.state.doc.toString(),
          language: _activeSpec && _activeSpec.language,
          mode: 'inline',
          readOnly: _activeSpec && _activeSpec.readOnly !== false,
        }).then(() => setTimeout(updateSummary, 60)).catch(() => {});
        return;
      }
      try {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
      } catch (e) {}
      return;
    }
    const target = side === 'left' ? (_cm6MergeView && _cm6MergeView.a) : (_cm6MergeView && _cm6MergeView.b);
    if (!target) return;
    try {
      target.dispatch({ changes: { from: 0, to: target.state.doc.length, insert: value } });
    } catch (e) {}
  }

  function cm6Navigate(dir) {
    const rt = _cm6Runtime;
    if (!rt || !rt.merge) return;
    const view = cm6PrimaryView();
    if (!view) return;
    try {
      if (dir > 0 && isFn(rt.merge.goToNextChunk)) rt.merge.goToNextChunk(view);
      else if (dir < 0 && isFn(rt.merge.goToPreviousChunk)) rt.merge.goToPreviousChunk(view);
    } catch (e) {}
  }

  function _cm6CountLines(doc, from, to) {
    if (!doc || from === to) return 0;
    try {
      const lo = Math.max(0, Math.min(from, to));
      const hi = Math.min(doc.length, Math.max(from, to));
      if (lo === hi) return 0;
      const startLine = doc.lineAt(lo).number;
      const endLine = doc.lineAt(hi === lo ? hi : hi - 1).number;
      return Math.max(1, endLine - startLine + 1);
    } catch (e) {
      return 0;
    }
  }

  function cm6Stats() {
    const rt = _cm6Runtime;
    if (!rt || !rt.merge || !isFn(rt.merge.getChunks)) return { count: 0, added: 0, removed: 0 };
    const view = cm6PrimaryView();
    if (!view) return { count: 0, added: 0, removed: 0 };

    let chunks = [];
    try {
      const got = rt.merge.getChunks(view.state);
      if (got && Array.isArray(got.chunks)) chunks = got.chunks;
    } catch (e) {}
    if (!chunks.length) return { count: 0, added: 0, removed: 0 };

    let docA = null;
    let docB = null;
    if (_cm6BackendMode === 'inline') {
      docB = view.state.doc;
      try {
        if (rt.merge && isFn(rt.merge.getOriginalDoc)) docA = rt.merge.getOriginalDoc(view.state);
      } catch (e) {}
    } else if (_cm6MergeView) {
      docA = _cm6MergeView.a && _cm6MergeView.a.state ? _cm6MergeView.a.state.doc : null;
      docB = _cm6MergeView.b && _cm6MergeView.b.state ? _cm6MergeView.b.state.doc : null;
    }

    let added = 0;
    let removed = 0;
    for (let i = 0; i < chunks.length; i += 1) {
      const c = chunks[i] || {};
      removed += _cm6CountLines(docA, Number(c.fromA || 0), Number(c.toA || 0));
      added += _cm6CountLines(docB, Number(c.fromB || 0), Number(c.toB || 0));
    }
    return { count: chunks.length, added: added, removed: removed };
  }

  // -------------------------- apply-hunk (Phase 5) --------------------------

  function _splitLines(text) {
    return String(text == null ? '' : text).split('\n');
  }

  function _spliceLines(originalLines, oStart, oEndInclusive, insertLines) {
    // Line numbers are 1-based; oEndInclusive < oStart means a pure insertion.
    const before = originalLines.slice(0, Math.max(0, oStart - 1));
    const skip = (oEndInclusive >= oStart) ? (oEndInclusive - oStart + 1) : 0;
    const after = originalLines.slice(Math.max(0, oStart - 1) + skip);
    return before.concat(insertLines || []).concat(after);
  }

  function _pickMonacoHunk(changes, currentLine, dir) {
    if (!changes || !changes.length) return null;
    const cur = Math.max(1, Number(currentLine || 1));
    let best = null;
    let bestDist = Infinity;
    for (let i = 0; i < changes.length; i += 1) {
      const c = changes[i] || {};
      const ms = Number(c.modifiedStartLineNumber || 0);
      const me = Number(c.modifiedEndLineNumber || 0);
      const os = Number(c.originalStartLineNumber || 0);
      const oe = Number(c.originalEndLineNumber || 0);
      // Cursor inside a chunk wins.
      if ((ms > 0 && me >= ms && cur >= ms && cur <= me) ||
          (os > 0 && oe >= os && cur >= os && cur <= oe)) {
        return c;
      }
      const anchor = ms || os || 0;
      if (anchor) {
        const dist = Math.abs(anchor - cur);
        if (dist < bestDist) { bestDist = dist; best = c; }
      }
    }
    return best || changes[0];
  }

  function _pickCm6Chunk(chunks, pos, side) {
    if (!chunks || !chunks.length) return null;
    const p = Math.max(0, Number(pos || 0));
    const keyFrom = side === 'left' ? 'fromA' : 'fromB';
    const keyTo = side === 'left' ? 'toA' : 'toB';
    let best = null;
    let bestDist = Infinity;
    for (let i = 0; i < chunks.length; i += 1) {
      const c = chunks[i] || {};
      const from = Number(c[keyFrom] || 0);
      const to = Number(c[keyTo] || 0);
      if (to >= from && p >= from && p <= to) return c;
      const dist = Math.min(Math.abs(p - from), Math.abs(p - to));
      if (dist < bestDist) { bestDist = dist; best = c; }
    }
    return best || chunks[0];
  }

  function _applyMonacoHunk(originalText, modifiedText, change) {
    const oLines = _splitLines(originalText);
    const mLines = _splitLines(modifiedText);
    const oStart = Number(change.originalStartLineNumber || 0);
    const oEnd = Number(change.originalEndLineNumber || 0); // 0 = pure insertion in modified
    const mStart = Number(change.modifiedStartLineNumber || 0);
    const mEnd = Number(change.modifiedEndLineNumber || 0); // 0 = pure deletion from original
    const insert = (mEnd >= mStart && mStart > 0) ? mLines.slice(mStart - 1, mEnd) : [];
    // For pure insertions (oEnd === 0), Monaco reports oStart as the line BEFORE
    // the insertion. We splice after that line by passing oStart+1 with no removal.
    if (oEnd === 0) {
      return _spliceLines(oLines, Math.max(1, oStart + 1), 0, insert).join('\n');
    }
    return _spliceLines(oLines, Math.max(1, oStart), oEnd, insert).join('\n');
  }

  function _applyCm6Chunk(originalText, modifiedText, chunk) {
    const original = String(originalText == null ? '' : originalText);
    const modified = String(modifiedText == null ? '' : modifiedText);
    const fromA = Math.max(0, Math.min(original.length, Number(chunk.fromA || 0)));
    const toA = Math.max(fromA, Math.min(original.length, Number(chunk.toA || 0)));
    const fromB = Math.max(0, Math.min(modified.length, Number(chunk.fromB || 0)));
    const toB = Math.max(fromB, Math.min(modified.length, Number(chunk.toB || 0)));
    return original.slice(0, fromA) + modified.slice(fromB, toB) + original.slice(toA);
  }

  function _readDescriptorKind(d) {
    if (!d || typeof d !== 'object') return '';
    return String(d.source || '').trim().toLowerCase();
  }

  function _isBufferDescriptor(d) {
    const kind = _readDescriptorKind(d);
    return !kind || kind === 'buffer';
  }

  function _hasWritableScope() {
    const scope = _activeSpec && _activeSpec.scope;
    return !!(scope && (isFn(scope.applyTextToSide) || isFn(scope.applyText)));
  }

  function _getVisibleBufferSide() {
    if (!_activeSpec) return '';
    if (_isBufferDescriptor(_activeSpec.left && _activeSpec.left.descriptor)) return 'left';
    if (_isBufferDescriptor(_activeSpec.right && _activeSpec.right.descriptor)) return 'right';
    return '';
  }

  function _hasWritableBufferSide() {
    return !!(_hasWritableScope() && _getVisibleBufferSide());
  }

  function _isSideDraft(side) {
    const sideKey = side === 'right' ? 'right' : 'left';
    return !!(_draftSideState && _draftSideState[sideKey]);
  }

  function _setSideDraft(side, flag) {
    const sideKey = side === 'right' ? 'right' : 'left';
    if (!_draftSideState || typeof _draftSideState !== 'object') {
      _draftSideState = { left: false, right: false };
    }
    _draftSideState[sideKey] = !!flag;
  }

  function _captureBaselineState() {
    _baselineLeft = asString(_activeSpec && _activeSpec.left && _activeSpec.left.text);
    _baselineRight = asString(_activeSpec && _activeSpec.right && _activeSpec.right.text);
  }

  function _resetBaselineState() {
    _baselineLeft = '';
    _baselineRight = '';
  }

  function _getDraftSaveSide() {
    if (_isSideDraft('left')) return 'left';
    if (_isSideDraft('right')) return 'right';
    return '';
  }

  function _isApplyStructurallyAvailable(side) {
    if (!_activeSpec) return false;
    if (!_hasWritableScope()) return false;
    const sideKey = side === 'right' ? 'right' : 'left';
    const descriptor = _activeSpec[sideKey] && _activeSpec[sideKey].descriptor;
    if (_isBufferDescriptor(descriptor)) return true;
    return _canSaveFromDiff() && _hasWritableBufferSide();
  }

  function _canWriteSide(side) {
    if (!_isApplyStructurallyAvailable(side)) return false;
    const mode = String(_activeSpec.mode || 'split').toLowerCase();
    if (mode === 'inline') return false;
    return true;
  }

  function _hasVisibleBufferSide() {
    if (!_activeSpec) return false;
    return _isBufferDescriptor(_activeSpec.left && _activeSpec.left.descriptor) ||
      _isBufferDescriptor(_activeSpec.right && _activeSpec.right.descriptor);
  }

  function _canSaveFromDiff() {
    if (!_activeSpec) return false;
    const scope = _activeSpec && _activeSpec.scope;
    return !!(scope && isFn(scope.save) && _hasWritableBufferSide());
  }

  function _canRevertFromDiff() {
    if (!_activeSpec) return false;
    return _hasWritableBufferSide();
  }

  function _hasAnyDiff() {
    if (_backendKind === 'monaco') {
      if (!_diffEditor || !isFn(_diffEditor.getLineChanges)) return false;
      try { return (_diffEditor.getLineChanges() || []).length > 0; } catch (e) { return false; }
    }
    if (_backendKind === 'cm6') {
      try { return cm6Stats().count > 0; } catch (e) { return false; }
    }
    return false;
  }

  function _hasAnyDraft() {
    return _isSideDraft('left') || _isSideDraft('right');
  }

  function _applyDisabledReason(side) {
    if (!_isApplyStructurallyAvailable(side)) return null;
    const mode = String(_activeSpec.mode || 'split').toLowerCase();
    if (mode === 'inline') return 'Перенос хунков доступен только в режиме «Бок-о-бок»';
    if (!_hasAnyDiff()) return 'Нет изменений для переноса';
    return '';
  }

  function _saveDisabledReason() {
    if (!_canSaveFromDiff()) return null;
    if (!_hasAnyDiff() && !_hasAnyDraft()) return 'Нет изменений для сохранения';
    return '';
  }

  function _revertDisabledReason() {
    if (!_canRevertFromDiff()) return null;
    if (!_dirtySinceOpen && !_hasAnyDraft()) return 'Нет изменений для отката';
    return '';
  }

  function _setBtnState(btn, reason, defaultTip) {
    if (!btn) return;
    if (reason === null) {
      try { btn.classList.add('hidden'); } catch (e) {}
      return;
    }
    try {
      btn.classList.remove('hidden');
      const disabled = !!reason;
      btn.classList.toggle('is-disabled', disabled);
      if (disabled) {
        btn.setAttribute('aria-disabled', 'true');
        btn.setAttribute('data-tooltip', reason);
      } else {
        btn.removeAttribute('aria-disabled');
        if (defaultTip) btn.setAttribute('data-tooltip', defaultTip);
      }
    } catch (e) {}
  }

  function refreshActionButtons() {
    _setBtnState(_applyAllToLeftBtnEl, _applyDisabledReason('left'),
      'Перенести все изменения из правой версии в левую');
    _setBtnState(_applyAllToRightBtnEl, _applyDisabledReason('right'),
      'Перенести все изменения из левой версии в правую');
    _setBtnState(_applyToLeftBtnEl, _applyDisabledReason('left'),
      'Перенести текущий хунк из правой версии в левую');
    _setBtnState(_applyToRightBtnEl, _applyDisabledReason('right'),
      'Перенести текущий хунк из левой версии в правую');
    _setBtnState(_revertBtnEl, _revertDisabledReason(),
      'Отменить все перенесённые изменения и вернуть исходное состояние');
    const saveActive = _saveDisabledReason() === '';
    const saveTip = (_dirtySinceOpen && saveActive)
      ? 'Сохранить · есть несохранённые изменения (Ctrl+S)'
      : 'Сохранить активный буфер в файл (Ctrl+S)';
    _setBtnState(_saveBtnEl, _saveDisabledReason(), saveTip);
    if (_saveBtnEl) {
      try { _saveBtnEl.classList.toggle('is-dirty', !!(_dirtySinceOpen && saveActive)); } catch (e) {}
    }
  }

  function _reverseMonacoHunk(change) {
    const c = change || {};
    return {
      originalStartLineNumber: Number(c.modifiedStartLineNumber || 0),
      originalEndLineNumber: Number(c.modifiedEndLineNumber || 0),
      modifiedStartLineNumber: Number(c.originalStartLineNumber || 0),
      modifiedEndLineNumber: Number(c.originalEndLineNumber || 0),
    };
  }

  function _reverseCm6Chunk(chunk) {
    const c = chunk || {};
    return {
      fromA: Number(c.fromB || 0),
      toA: Number(c.toB || 0),
      fromB: Number(c.fromA || 0),
      toB: Number(c.toA || 0),
    };
  }

  function _getMonacoEditorForSide(side) {
    if (!_diffEditor) return null;
    try {
      return side === 'left'
        ? (isFn(_diffEditor.getOriginalEditor) ? _diffEditor.getOriginalEditor() : null)
        : (isFn(_diffEditor.getModifiedEditor) ? _diffEditor.getModifiedEditor() : null);
    } catch (e) {}
    return null;
  }

  function _getMonacoCursorLine(side) {
    const preferred = _getMonacoEditorForSide(side);
    const fallback = _getMonacoEditorForSide(side === 'left' ? 'right' : 'left');
    const editor = preferred || fallback;
    try {
      const pos = editor && isFn(editor.getPosition) ? editor.getPosition() : null;
      return pos ? Math.max(1, Number(pos.lineNumber || 1)) : 1;
    } catch (e) {}
    return 1;
  }

  function _getCm6ViewForSide(side) {
    if (_cm6BackendMode === 'inline') return _cm6View;
    return side === 'left'
      ? (_cm6MergeView && _cm6MergeView.a ? _cm6MergeView.a : null)
      : (_cm6MergeView && _cm6MergeView.b ? _cm6MergeView.b : null);
  }

  function _getCm6CursorPos(side) {
    const preferred = _getCm6ViewForSide(side);
    const fallback = _getCm6ViewForSide(side === 'left' ? 'right' : 'left');
    const view = preferred || fallback;
    try {
      const sel = view && view.state && view.state.selection ? view.state.selection.main : null;
      return sel ? Math.max(0, Number(sel.head || 0)) : 0;
    } catch (e) {}
    return 0;
  }

  async function _writeTextToSide(side, newText) {
    const scope = _activeSpec && _activeSpec.scope;
    if (!scope) throw new Error('Scope is not available');
    if (isFn(scope.applyTextToSide)) {
      await Promise.resolve(scope.applyTextToSide(side, newText));
      return;
    }
    if (!isFn(scope.applyText)) throw new Error('Target side is read-only');
    await Promise.resolve(scope.applyText(newText));
  }

  function _setRenderedSideText(side, text) {
    const value = asString(text);
    if (_backendKind === 'cm6') {
      try { cm6SetText(side, value); } catch (e) {}
      return;
    }
    const model = side === 'left' ? _originalModel : _modifiedModel;
    try {
      if (model && isFn(model.setValue)) model.setValue(value);
    } catch (e) {}
  }

  function _setSideTextState(side, text, draft) {
    const sideKey = side === 'right' ? 'right' : 'left';
    const value = asString(text);
    if (_activeSpec) {
      const cur = _activeSpec[sideKey] || {};
      _activeSpec[sideKey] = Object.assign({}, cur, { text: value, error: '' });
    }
    _setRenderedSideText(sideKey, value);
    _setSideDraft(sideKey, !!draft);
  }

  function _syncBufferSideText(side, text) {
    const sideKey = side === 'right' ? 'right' : 'left';
    const otherKey = sideKey === 'left' ? 'right' : 'left';
    const value = asString(text);
    _setSideTextState(sideKey, value, false);

    if (_activeSpec && _isBufferDescriptor(_activeSpec[otherKey] && _activeSpec[otherKey].descriptor)) {
      _setSideTextState(otherKey, value, false);
    }
  }

  async function _refreshSideFromDescriptor(side) {
    const scopeDef = _activeSpec && _activeSpec.scope;
    const diffApi = (XKeen.ui && XKeen.ui.diff) || null;
    if (!scopeDef || !diffApi || !isFn(diffApi.resolveSourceText)) return;
    const sideKey = side === 'right' ? 'right' : 'left';
    const current = _activeSpec && _activeSpec[sideKey] ? _activeSpec[sideKey] : {};
    const descriptor = current && current.descriptor ? current.descriptor : { source: 'buffer' };
    const opt = findOption(descriptorToValue(descriptor));
    const title = opt && opt.label ? opt.label : (current && current.title) || '';
    showError('');
    try {
      const text = await Promise.resolve(diffApi.resolveSourceText(scopeDef, descriptor));
      _setRenderedSideText(sideKey, text);
      _setSideDraft(sideKey, false);
      if (_activeSpec) {
        _activeSpec[sideKey] = Object.assign({}, current, {
          text: asString(text),
          descriptor: descriptor,
          title: title || current.title || '',
          error: '',
        });
      }
    } catch (err) {
      showError((sideKey === 'left' ? 'Слева: ' : 'Справа: ') + String(err && err.message || err));
    }
  }

  function _scheduleNextDiffNavigation() {
    setTimeout(() => {
      try { updateSummary(); } catch (e) {}
      try {
        if (_hasAnyDiff()) navigateDiff(1);
      } catch (e2) {}
    }, 60);
  }

  async function applyAllChangesToSide(side) {
    const targetSide = side === 'right' ? 'right' : 'left';
    if (!_canWriteSide(targetSide)) return;
    if (!_hasAnyDiff()) {
      showFeedback('Различий нет', 'info');
      return;
    }

    const sourceSide = targetSide === 'left' ? 'right' : 'left';
    const targetDescriptor = _activeSpec && _activeSpec[targetSide] ? _activeSpec[targetSide].descriptor : null;
    const writesLiveBuffer = _isBufferDescriptor(targetDescriptor);
    const sourceText = asString(_activeSpec && _activeSpec[sourceSide] && _activeSpec[sourceSide].text);

    if (!writesLiveBuffer) {
      _setSideTextState(targetSide, sourceText, true);
      _dirtySinceOpen = true;
      refreshActionButtons();
      setTimeout(updateSummary, 60);
      showFeedback(targetSide === 'left' ? 'Все изменения перенесены в левую версию' : 'Все изменения перенесены в правую версию', 'success');
      return;
    }

    try {
      await _writeTextToSide(targetSide, sourceText);
    } catch (err) {
      showError('Применение всех хунков: ' + String(err && err.message || err));
      return;
    }

    _syncBufferSideText(targetSide, sourceText);
    _dirtySinceOpen = true;
    refreshActionButtons();
    setTimeout(updateSummary, 60);
    showFeedback(targetSide === 'left' ? 'Все изменения перенесены в левую версию' : 'Все изменения перенесены в правую версию', 'success');
  }

  async function applyHunkToSide(side) {
    const targetSide = side === 'right' ? 'right' : 'left';
    if (!_canWriteSide(targetSide)) return;
    const sourceSide = targetSide === 'left' ? 'right' : 'left';
    const targetDescriptor = _activeSpec && _activeSpec[targetSide] ? _activeSpec[targetSide].descriptor : null;
    const writesLiveBuffer = _isBufferDescriptor(targetDescriptor);
    const targetText = asString(_activeSpec && _activeSpec[targetSide] && _activeSpec[targetSide].text);
    const sourceText = asString(_activeSpec && _activeSpec[sourceSide] && _activeSpec[sourceSide].text);

    let newText = '';
    if (_backendKind === 'monaco' && _diffEditor && isFn(_diffEditor.getLineChanges)) {
      const changes = _diffEditor.getLineChanges() || [];
      if (!changes.length) {
        showFeedback('Различий нет', 'info');
        return;
      }
      const cur = _getMonacoCursorLine(targetSide);
      const chunk = _pickMonacoHunk(changes, cur, 1);
      if (!chunk) return;
      const patch = targetSide === 'left' ? chunk : _reverseMonacoHunk(chunk);
      newText = _applyMonacoHunk(targetText, sourceText, patch);
    } else if (_backendKind === 'cm6' && _cm6Runtime && _cm6Runtime.merge && isFn(_cm6Runtime.merge.getChunks)) {
      if (_cm6BackendMode === 'inline') {
        showFeedback('Перенос хунков доступен только в режиме "Бок-о-бок"', 'info');
        return;
      }
      const view = cm6PrimaryView();
      if (!view) return;
      let chunks = [];
      try {
        const got = _cm6Runtime.merge.getChunks(view.state);
        if (got && Array.isArray(got.chunks)) chunks = got.chunks;
      } catch (e) {}
      if (!chunks.length) {
        showFeedback('Различий нет', 'info');
        return;
      }
      const head = _getCm6CursorPos(targetSide);
      const chunk = _pickCm6Chunk(chunks, head, targetSide);
      if (!chunk) return;
      const patch = targetSide === 'left' ? chunk : _reverseCm6Chunk(chunk);
      newText = _applyCm6Chunk(targetText, sourceText, patch);
    } else {
      showFeedback('Перенос хунка недоступен для текущего backend', 'error');
      return;
    }

    if (!writesLiveBuffer) {
      _setSideTextState(targetSide, newText, true);
      _dirtySinceOpen = true;
      refreshActionButtons();
      _scheduleNextDiffNavigation();
      showFeedback(targetSide === 'left' ? 'Хунк перенесён в левую версию' : 'Хунк перенесён в правую версию', 'success');
      return;
    }

    try {
      await _writeTextToSide(targetSide, newText);
    } catch (err) {
      showError('Применение хунка: ' + String(err && err.message || err));
      return;
    }

    _syncBufferSideText(targetSide, newText);
    _dirtySinceOpen = true;
    refreshActionButtons();
    _scheduleNextDiffNavigation();
    showFeedback(targetSide === 'left' ? 'Хунк перенесён в левую версию' : 'Хунк перенесён в правую версию', 'success');
  }

  async function revertComparedChanges() {
    if (!_canRevertFromDiff()) return;
    if (!_dirtySinceOpen && !_hasAnyDraft()) {
      showFeedback('Нет изменений для отката', 'info');
      return;
    }

    showError('');
    const leftBaseline = asString(_baselineLeft);
    const rightBaseline = asString(_baselineRight);
    const bufferSide = _getVisibleBufferSide();

    if (bufferSide) {
      const bufferBaseline = bufferSide === 'left' ? leftBaseline : rightBaseline;
      try {
        await _writeTextToSide(bufferSide, bufferBaseline);
      } catch (err) {
        showError('Отмена изменений: ' + String(err && err.message || err));
        return;
      }
      _syncBufferSideText(bufferSide, bufferBaseline);
    }

    if (!_isBufferDescriptor(_activeSpec && _activeSpec.left && _activeSpec.left.descriptor)) {
      _setSideTextState('left', leftBaseline, false);
    }
    if (!_isBufferDescriptor(_activeSpec && _activeSpec.right && _activeSpec.right.descriptor)) {
      _setSideTextState('right', rightBaseline, false);
    }

    _dirtySinceOpen = false;
    refreshActionButtons();
    setTimeout(updateSummary, 60);
    showFeedback('Изменения отменены', 'success');
  }

  async function saveComparedFile() {
    if (!_canSaveFromDiff()) return;
    if (!_hasAnyDiff() && !_hasAnyDraft()) {
      showFeedback('Нет изменений для сохранения', 'info');
      return;
    }
    const scope = _activeSpec && _activeSpec.scope;
    if (!scope || !isFn(scope.save)) return;
    const draftSaveSide = _getDraftSaveSide();
    if (draftSaveSide) {
      const bufferSide = _getVisibleBufferSide();
      const saveText = asString(_activeSpec && _activeSpec[draftSaveSide] && _activeSpec[draftSaveSide].text);
      if (!bufferSide) {
        showError('Сохранение: нет активного буфера для записи');
        return;
      }
      try {
        await _writeTextToSide(bufferSide, saveText);
      } catch (err) {
        showError('Сохранение: ' + String(err && err.message || err));
        return;
      }
      _syncBufferSideText(bufferSide, saveText);
      refreshActionButtons();
    }

    showError('');
    let result = null;
    try {
      result = await Promise.resolve(scope.save());
    } catch (err) {
      showError('Сохранение: ' + String(err && err.message || err));
      return;
    }
    if (result === false) return;

    _dirtySinceOpen = false;

    if (scope.saveClosesOwner) {
      close('save');
      return;
    }

    await _refreshSourceOptions(scope);
    await _refreshSideFromDescriptor('left');
    await _refreshSideFromDescriptor('right');
    _captureBaselineState();
    refreshActionButtons();
    setTimeout(updateSummary, 60);
  }

  function bindLayoutHooks(monaco) {
    if (_resizeBound) return;
    _resizeBound = true;
    const handler = () => {
      try { if (_diffEditor && isFn(_diffEditor.layout) && isOpen()) _diffEditor.layout(); } catch (e) {}
    };
    try { window.addEventListener('resize', handler); } catch (e) {}
  }

  function languageFor(monaco, requested) {
    const want = String(requested || '').toLowerCase().trim();
    if (!want) return 'plaintext';
    const langs = monaco && monaco.languages && isFn(monaco.languages.getLanguages)
      ? monaco.languages.getLanguages() : [];
    const ids = new Set(langs.map((l) => String(l && l.id || '').toLowerCase()));
    if (ids.has(want)) return want;
    if (want === 'jsonc' && ids.has('json')) return 'json';
    if (want === 'yml' && ids.has('yaml')) return 'yaml';
    return 'plaintext';
  }

  async function open(spec) {
    const o = clone(spec || {});
    if (!o.left) o.left = { text: '' };
    if (!o.right) o.right = { text: '' };

    ensureDom();
    // Keep the live scope reference; clone() above strips functions.
    const scopeDef = (spec && spec.scope) ? spec.scope : null;
    o.scope = scopeDef;
    _activeSpec = o;
    _draftSideState = { left: false, right: false };
    _dirtySinceOpen = false;
    _ignoreTrimWhitespace = !!o.ignoreTrimWhitespace;
    _captureBaselineState();
    _syncIgnoreWhitespaceToggle();

    if (_titleEl) _titleEl.textContent = asString(o.title) || 'Сравнить версии';

    if (scopeDef) {
      const snaps = await loadSnapshotList(scopeDef);
      _sourceOptions = buildOptions(scopeDef, snaps);
      const leftValue = descriptorToValue(o.left && o.left.descriptor);
      const rightValue = descriptorToValue(o.right && o.right.descriptor);
      populateSelect(_leftSelectEl, _sourceOptions, leftValue);
      populateSelect(_rightSelectEl, _sourceOptions, rightValue);
      setSelectorsHidden(false);
      if (_leftLabelEl) _leftLabelEl.textContent = 'Слева';
      if (_rightLabelEl) _rightLabelEl.textContent = 'Справа';
    } else {
      _sourceOptions = [];
      setSelectorsHidden(true);
      setLabels(o);
    }

    const errorParts = [];
    if (o.left && o.left.error) errorParts.push('Слева: ' + o.left.error);
    if (o.right && o.right.error) errorParts.push('Справа: ' + o.right.error);
    showError(errorParts.join(' · '));

    setMode(o.mode || 'split');

    const api = getModalApi();
    try {
      if (api && isFn(api.open)) api.open(_modalEl, { source: 'diff_modal' });
      else _modalEl.classList.remove('hidden');
    } catch (e) { _modalEl.classList.remove('hidden'); }

    try {
      const useCM6 = pickBackend() === 'cm6';
      disposeDiff();

      if (useCM6) {
        await renderCM6Diff(_hostEl, {
          leftText: o.left.text,
          rightText: o.right.text,
          language: o.language || 'text',
          mode: o.mode || 'split',
          readOnly: o.readOnly !== false,
        });
        bindLayoutHooks(null);
        setTimeout(updateSummary, 60);
      } else {
        const monaco = await ensureMonaco();
        _activeMonaco = monaco;
        bindLayoutHooks(monaco);

        while (_hostEl && _hostEl.firstChild) _hostEl.removeChild(_hostEl.firstChild);

        const lang = languageFor(monaco, o.language || 'text');
        _originalModel = monaco.editor.createModel(asString(o.left.text), lang);
        _modifiedModel = monaco.editor.createModel(asString(o.right.text), lang);

        _diffEditor = monaco.editor.createDiffEditor(_hostEl, {
          renderSideBySide: o.mode !== 'inline',
          readOnly: o.readOnly !== false,
          originalEditable: false,
          automaticLayout: true,
          scrollBeyondLastLine: false,
          minimap: { enabled: false },
          renderOverviewRuler: true,
          ignoreTrimWhitespace: !!_ignoreTrimWhitespace,
          diffWordWrap: 'on',
        });

        _diffEditor.setModel({ original: _originalModel, modified: _modifiedModel });
        _backendKind = 'monaco';

        try {
          if (isFn(_diffEditor.onDidUpdateDiff)) {
            _diffEditor.onDidUpdateDiff(updateSummary);
          }
        } catch (e) {}
        try {
          const originalEditor = _getMonacoInnerEditor('left');
          if (originalEditor && isFn(originalEditor.onDidChangeCursorPosition)) {
            originalEditor.onDidChangeCursorPosition(() => _syncActiveMonacoHunkHighlight('left'));
          }
        } catch (e2) {}
        try {
          const modifiedEditor = _getMonacoInnerEditor('right');
          if (modifiedEditor && isFn(modifiedEditor.onDidChangeCursorPosition)) {
            modifiedEditor.onDidChangeCursorPosition(() => _syncActiveMonacoHunkHighlight('right'));
          }
        } catch (e3) {}
        setTimeout(updateSummary, 80);

        try { if (isFn(_diffEditor.layout)) _diffEditor.layout(); } catch (e) {}
      }

      try {
        const diffApi = (XKeen.ui && XKeen.ui.diff) || null;
        if (diffApi && isFn(diffApi.logDiff) && scopeDef) {
          const lk = (o.left && o.left.descriptor && o.left.descriptor.source) || '';
          const rk = (o.right && o.right.descriptor && o.right.descriptor.source) || '';
          diffApi.logDiff(scopeDef.scope || '', lk, rk);
        }
      } catch (e) {}
      _syncIgnoreWhitespaceToggle();
      refreshActionButtons();
    } catch (err) {
      showError(String(err && err.message || err));
      showFeedback('Не удалось открыть сравнение: ' + (err && err.message || err), 'error');
    }

    return new Promise((resolve) => {
      _resolveOpen = resolve;
    });
  }

  async function _confirmDiscardDraft() {
    const ui = (window.XKeen && XKeen.ui && isFn(XKeen.ui.confirm)) ? XKeen.ui.confirm : null;
    const message = 'В сравнении есть перенесённые блоки, которые ещё не записаны на диск.\n' +
      'Закрыть без сохранения?';
    if (!ui) {
      try { return !!window.confirm(message); } catch (e) { return true; }
    }
    try {
      return !!(await ui({
        title: 'Несохранённые изменения',
        message: message,
        okText: 'Закрыть без сохранения',
        cancelText: 'Отменить',
        danger: true,
        focus: 'cancel',
      }));
    } catch (e) { return true; }
  }

  async function close(reason) {
    if (!_modalEl) return;
    const r = String(reason || 'close');
    if (r !== 'save' && _hasAnyDraft()) {
      const ok = await _confirmDiscardDraft();
      if (!ok) return;
    }
    const api = getModalApi();
    try {
      if (api && isFn(api.close)) api.close(_modalEl, { source: 'diff_modal:' + r });
      else _modalEl.classList.add('hidden');
    } catch (e) { _modalEl.classList.add('hidden'); }
    disposeDiff();
    _activeMonaco = null;
    _activeSpec = null;
    _sourceOptions = [];
    _draftSideState = { left: false, right: false };
    _dirtySinceOpen = false;
    _resetBaselineState();
    const resolver = _resolveOpen;
    _resolveOpen = null;
    if (isFn(resolver)) {
      try { resolver({ reason: r }); } catch (e) {}
    }
  }

  XKeen.ui.diffModal = XKeen.ui.diffModal || {};
  XKeen.ui.diffModal.open = open;
  XKeen.ui.diffModal.close = close;
  XKeen.ui.diffModal.isOpen = isOpen;
  XKeen.ui.diffModal.setMode = setMode;
})();

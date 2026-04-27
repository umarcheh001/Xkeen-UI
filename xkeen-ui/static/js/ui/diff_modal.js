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
  let _navPrevBtnEl = null;
  let _navNextBtnEl = null;
  let _applyBtnEl = null;
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

    const navGroup = document.createElement('div');
    navGroup.className = 'xkeen-diff-nav';
    _navPrevBtnEl = makeBtn('▲', 'btn-secondary btn-icon', () => navigateDiff(-1), 'К предыдущему изменению (Shift+F3)');
    _navNextBtnEl = makeBtn('▼', 'btn-secondary btn-icon', () => navigateDiff(1), 'К следующему изменению (F3)');
    navGroup.appendChild(_navPrevBtnEl);
    navGroup.appendChild(_navNextBtnEl);

    _applyBtnEl = makeBtn('Применить хунк ←', 'btn-secondary xkeen-diff-apply-btn hidden',
      () => applyHunkFromRight(),
      'Применить текущий хунк из правой стороны в активный буфер');

    _xBtnEl = makeBtn('×', 'btn-icon xkeen-diff-close-x', () => close('x'), 'Закрыть окно сравнения (Esc)');

    headRight.appendChild(modeGroup);
    headRight.appendChild(navGroup);
    headRight.appendChild(_applyBtnEl);
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
    _closeBtnEl = makeBtn('Закрыть', 'btn-secondary', () => close('close'), 'Закрыть окно сравнения (Esc)');
    foot.appendChild(summary);
    foot.appendChild(_closeBtnEl);

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
    refreshApplyButton();
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
    refreshApplyButton();
    try {
      const lazy = window.XKeen && XKeen.runtime && XKeen.runtime.lazy;
      if (lazy && isFn(lazy.scheduleLayout)) lazy.scheduleLayout();
    } catch (e) {}
    try { if (_backendKind === 'monaco' && _diffEditor && isFn(_diffEditor.layout)) _diffEditor.layout(); } catch (e2) {}
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
          Promise.resolve(action.run()).catch(() => {});
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
      }
    } catch (e) {}
  }

  function updateSummary() {
    if (!_summaryEl) return;
    try {
      if (_backendKind === 'cm6') {
        const stats = cm6Stats();
        if (!stats.count) {
          _summaryEl.textContent = 'Различий нет';
          return;
        }
        _summaryEl.textContent = 'Изменений: ' + stats.count + '  ·  +' + stats.added + ' / −' + stats.removed;
        return;
      }
      const changes = _diffEditor && isFn(_diffEditor.getLineChanges) ? (_diffEditor.getLineChanges() || []) : [];
      if (!changes.length) {
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
    } catch (e) {
      _summaryEl.textContent = '';
    }
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
    try { if (_diffEditor && isFn(_diffEditor.dispose)) _diffEditor.dispose(); } catch (e) {}
    _diffEditor = null;
    try { if (_originalModel && isFn(_originalModel.dispose)) _originalModel.dispose(); } catch (e) {}
    try { if (_modifiedModel && isFn(_modifiedModel.dispose)) _modifiedModel.dispose(); } catch (e) {}
    _originalModel = null;
    _modifiedModel = null;
    disposeCM6();
    _backendKind = null;
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

  function _pickCm6Chunk(chunks, doc, pos) {
    if (!chunks || !chunks.length) return null;
    const p = Math.max(0, Number(pos || 0));
    let best = null;
    let bestDist = Infinity;
    for (let i = 0; i < chunks.length; i += 1) {
      const c = chunks[i] || {};
      const fromB = Number(c.fromB || 0);
      const toB = Number(c.toB || 0);
      if (toB >= fromB && p >= fromB && p <= toB) return c;
      const dist = Math.min(Math.abs(p - fromB), Math.abs(p - toB));
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

  function _canApplyHunk() {
    if (!_activeSpec) return false;
    const scope = _activeSpec.scope;
    if (!scope || !isFn(scope.applyText)) return false;
    // Apply only makes sense in split mode and when LEFT is the buffer.
    const mode = String(_activeSpec.mode || 'split').toLowerCase();
    if (mode === 'inline') return false;
    const leftKind = _readDescriptorKind(_activeSpec.left && _activeSpec.left.descriptor);
    if (leftKind && leftKind !== 'buffer') return false;
    return true;
  }

  function refreshApplyButton() {
    if (!_applyBtnEl) return;
    const ok = _canApplyHunk();
    try { _applyBtnEl.classList.toggle('hidden', !ok); } catch (e) {}
  }

  async function applyHunkFromRight() {
    if (!_canApplyHunk()) return;
    const scope = _activeSpec && _activeSpec.scope;
    const leftText = asString(_activeSpec.left && _activeSpec.left.text);
    const rightText = asString(_activeSpec.right && _activeSpec.right.text);

    let newText = '';
    if (_backendKind === 'monaco' && _diffEditor && isFn(_diffEditor.getLineChanges)) {
      const changes = _diffEditor.getLineChanges() || [];
      if (!changes.length) {
        showFeedback('Различий нет', 'info');
        return;
      }
      const inner = isFn(_diffEditor.getOriginalEditor) ? _diffEditor.getOriginalEditor() : null;
      const pos = inner && isFn(inner.getPosition) ? inner.getPosition() : null;
      const cur = pos ? Number(pos.lineNumber || 1) : 1;
      const chunk = _pickMonacoHunk(changes, cur, 1);
      if (!chunk) return;
      newText = _applyMonacoHunk(leftText, rightText, chunk);
    } else if (_backendKind === 'cm6' && _cm6Runtime && _cm6Runtime.merge && isFn(_cm6Runtime.merge.getChunks)) {
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
      const head = view.state.selection && view.state.selection.main ? view.state.selection.main.head : 0;
      // For split mode the cursor sits in pane B; for inline the cursor is in
      // the merged view. Either way we use offsets in B for the lookup.
      const docB = (_cm6BackendMode === 'inline') ? view.state.doc
        : (_cm6MergeView && _cm6MergeView.b && _cm6MergeView.b.state ? _cm6MergeView.b.state.doc : view.state.doc);
      const docA = (_cm6BackendMode === 'inline')
        ? (isFn(_cm6Runtime.merge.getOriginalDoc) ? _cm6Runtime.merge.getOriginalDoc(view.state) : null)
        : (_cm6MergeView && _cm6MergeView.a && _cm6MergeView.a.state ? _cm6MergeView.a.state.doc : null);
      const chunk = _pickCm6Chunk(chunks, docB, Number(head || 0));
      if (!chunk) return;
      const aText = docA ? docA.toString() : leftText;
      const bText = docB ? docB.toString() : rightText;
      newText = _applyCm6Chunk(aText, bText, chunk);
    } else {
      showFeedback('Apply: backend недоступен', 'error');
      return;
    }

    try {
      await Promise.resolve(scope.applyText(newText));
    } catch (err) {
      showError('Apply: ' + String(err && err.message || err));
      return;
    }

    // Reflect the new buffer in the modal so subsequent navigations and apply
    // operations see the post-apply state.
    if (_activeSpec) {
      _activeSpec.left = Object.assign({}, _activeSpec.left || {}, { text: newText });
    }
    if (_backendKind === 'cm6') {
      try { cm6SetText('left', newText); } catch (e) {}
    } else if (_originalModel && isFn(_originalModel.setValue)) {
      try { _originalModel.setValue(newText); } catch (e) {}
    }
    setTimeout(updateSummary, 60);
    showFeedback('Хунк применён', 'success');
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
          ignoreTrimWhitespace: false,
          diffWordWrap: 'on',
        });

        _diffEditor.setModel({ original: _originalModel, modified: _modifiedModel });
        _backendKind = 'monaco';

        try {
          if (isFn(_diffEditor.onDidUpdateDiff)) {
            _diffEditor.onDidUpdateDiff(updateSummary);
          }
        } catch (e) {}
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
      refreshApplyButton();
    } catch (err) {
      showError(String(err && err.message || err));
      showFeedback('Не удалось открыть сравнение: ' + (err && err.message || err), 'error');
    }

    return new Promise((resolve) => {
      _resolveOpen = resolve;
    });
  }

  function close(reason) {
    if (!_modalEl) return;
    const api = getModalApi();
    try {
      if (api && isFn(api.close)) api.close(_modalEl, { source: 'diff_modal:' + (reason || 'close') });
      else _modalEl.classList.add('hidden');
    } catch (e) { _modalEl.classList.add('hidden'); }
    disposeDiff();
    _activeMonaco = null;
    _activeSpec = null;
    _sourceOptions = [];
    const r = _resolveOpen;
    _resolveOpen = null;
    if (isFn(r)) {
      try { r({ reason: asString(reason) || 'close' }); } catch (e) {}
    }
  }

  XKeen.ui.diffModal = XKeen.ui.diffModal || {};
  XKeen.ui.diffModal.open = open;
  XKeen.ui.diffModal.close = close;
  XKeen.ui.diffModal.isOpen = isOpen;
  XKeen.ui.diffModal.setMode = setMode;
})();

(() => {
  // JSON editor modal for 03_inbounds.json / 04_outbounds.json
  // Public API:
  //   XKeen.jsonEditor.open('inbounds'|'outbounds')
  //   XKeen.jsonEditor.close()
  //   XKeen.jsonEditor.save()
  //   XKeen.jsonEditor.init()  (optional)

  window.XKeen = window.XKeen || {};
  XKeen.state = XKeen.state || {};
  XKeen.ui = XKeen.ui || {};
  XKeen.jsonEditor = XKeen.jsonEditor || {};

  let _inited = false;
  let _cm = null;
  let _cmFacade = null;
  let _monaco = null;
  let _monacoFacade = null;
  let _kind = 'codemirror';
  let _engineUnsub = null;
  let _dirtyUnsub = null;
  let _currentTarget = null;
  let _savedText = '';
  let _viewStateStore = null;

  function el(id) {
    return document.getElementById(id);
  }

  function getModalApi() {
    try {
      if (window.XKeen && XKeen.ui && XKeen.ui.modal) return XKeen.ui.modal;
    } catch (e) {}
    return null;
  }

  function getConfigDirtyApi() {
    try {
      if (window.XKeen && XKeen.ui && XKeen.ui.configDirty) return XKeen.ui.configDirty;
    } catch (e) {}
    return null;
  }


  function getUiSettingsApi() {
    try {
      if (window.XKeen && XKeen.ui && XKeen.ui.settings) return XKeen.ui.settings;
    } catch (e) {}
    return null;
  }

  function getFormattersApi() {
    try {
      if (window.XKeen && XKeen.ui && XKeen.ui.formatters) return XKeen.ui.formatters;
    } catch (e) {}
    return null;
  }

  async function getPreferPrettierFlag() {
    try {
      const api = getUiSettingsApi();
      if (!api) return false;
      if (typeof api.fetchOnce === 'function') {
        const st = await api.fetchOnce().catch(() => null);
        if (st && st.format && typeof st.format.preferPrettier === 'boolean') {
          return !!st.format.preferPrettier;
        }
      }
      if (typeof api.get === 'function') {
        const st2 = api.get();
        if (st2 && st2.format && typeof st2.format.preferPrettier === 'boolean') {
          return !!st2.format.preferPrettier;
        }
      }
    } catch (e) {}
    return false;
  }

  function refreshRestartLog() {
    try {
      const api = window.XKeen && XKeen.features ? XKeen.features.restartLog : null;
      if (api && typeof api.load === 'function') return api.load();
    } catch (e) {}
    return null;
  }

  function clearDirtyListener() {
    try {
      if (typeof _dirtyUnsub === 'function') _dirtyUnsub();
    } catch (e) {}
    _dirtyUnsub = null;
  }

  function clearTargetDirtyState(target) {
    const scope = String(target || '').trim();
    if (!scope) return;
    const api = getConfigDirtyApi();
    if (!api || typeof api.clearSource !== 'function') return;
    try { api.clearSource(scope, 'jsonEditor'); } catch (e) {}
  }

  function syncTargetDirtyState(forceDirty) {
    if (!_currentTarget) return false;
    let dirty = false;
    try {
      dirty = (typeof forceDirty === 'boolean')
        ? !!forceDirty
        : (String(getCurrentValue() || '') !== String(_savedText || ''));
    } catch (e) {
      dirty = false;
    }

    const api = getConfigDirtyApi();
    if (api && typeof api.setDirty === 'function') {
      try {
        api.setDirty(_currentTarget, 'jsonEditor', dirty, {
          label: 'JSON editor',
          summary: dirty ? 'Есть несохранённые правки в модальном JSON-редакторе.' : '',
        });
      } catch (e) {}
    }
    return dirty;
  }

  function bindDirtyListener() {
    clearDirtyListener();

    const fac = getActiveFacade();
    if (fac && typeof fac.onChange === 'function') {
      try {
        const unsub = fac.onChange(() => {
          try { syncTargetDirtyState(); } catch (e) {}
          try { validateCurrentJson(getCurrentValue(), { silent: false }); } catch (e2) {}
        });
        if (typeof unsub === 'function') {
          _dirtyUnsub = unsub;
          return;
        }
      } catch (e) {}
    }

    const textarea = el('json-editor-textarea');
    if (!textarea) return;
    const handler = () => {
      try { syncTargetDirtyState(); } catch (e) {}
      try { validateCurrentJson(getCurrentValue(), { silent: false }); } catch (e2) {}
    };
    textarea.addEventListener('input', handler);
    _dirtyUnsub = () => {
      try { textarea.removeEventListener('input', handler); } catch (e) {}
    };
  }

  function showModal(modal, source) {
    if (!modal) return false;
    const api = getModalApi();
    try {
      if (api && typeof api.open === 'function') return api.open(modal, { source: source || 'json_editor_modal' });
    } catch (e) {}
    try { modal.classList.remove('hidden'); } catch (e2) {}
    try {
      if (api && typeof api.syncBodyScrollLock === 'function') api.syncBodyScrollLock();
    } catch (e3) {}
    return true;
  }

  function hideModal(modal, source) {
    if (!modal) return false;
    const api = getModalApi();
    try {
      if (api && typeof api.close === 'function') return api.close(modal, { source: source || 'json_editor_modal' });
    } catch (e) {}
    try { modal.classList.add('hidden'); } catch (e2) {}
    try {
      if (api && typeof api.syncBodyScrollLock === 'function') api.syncBodyScrollLock();
    } catch (e3) {}
    return true;
  }


  function cmThemeFromPage() {
    const t = document.documentElement.getAttribute('data-theme');
    return t === 'light' ? 'default' : 'material-darker';
  }

  function shouldRestartAfterSave() {
    // Panel toggle; on other pages default to true.
    const cb = el('global-autorestart-xkeen');
    if (!cb) return true;
    return !!cb.checked;
  }

  function setError(msg) {
    const errorEl = el('json-editor-error');
    if (errorEl) errorEl.textContent = msg ? String(msg) : '';
  }

  function activeFileParam(kind) {
    try {
      if (window.XKeen && XKeen.state && XKeen.state.fragments && XKeen.state.fragments[kind]) {
        return String(XKeen.state.fragments[kind] || '').trim();
      }
    } catch (e) {}
    // Fallback: use whatever is shown as active file label in window.XKEEN_FILES
    try {
      const fp = window.XKEEN_FILES && window.XKEEN_FILES[kind];
      if (!fp) return '';
      const parts = String(fp).split('/');
      const b = parts[parts.length - 1];
      return String(b || '').trim();
    } catch (e) {}
    return '';
  }

  function buildTargetUrl(target, baseUrl) {
    const active = activeFileParam(target);
    return baseUrl + (active ? ('?file=' + encodeURIComponent(active)) : '');
  }

  function setHeader(target) {
    const titleEl = el('json-editor-title');
    const fileLabelEl = el('json-editor-file-label');

    function _baseName(p, fallback) {
      try {
        if (!p) return fallback;
        const parts = String(p).split('/');
        const b = parts[parts.length - 1];
        return b || fallback;
      } catch (e) {
        return fallback;
      }
    }

    function _activeFileParam(kind) {
      try {
        if (window.XKeen && XKeen.state && XKeen.state.fragments && XKeen.state.fragments[kind]) {
          return String(XKeen.state.fragments[kind] || '').trim();
        }
      } catch (e) {}
      // Fallback: use whatever is shown as active file label in window.XKEEN_FILES
      try {
        const fp = window.XKEEN_FILES && window.XKEEN_FILES[kind];
        const b = _baseName(fp, '');
        return b || '';
      } catch (e) {}
      return '';
    }

    if (target === 'inbounds') {
      const active = activeFileParam('inbounds');
      const base = active ? active : _baseName(window.XKEEN_FILES && window.XKEEN_FILES.inbounds, '03_inbounds.json');
      if (titleEl) titleEl.textContent = 'Редактор ' + base;
      if (fileLabelEl) fileLabelEl.textContent = 'Файл: ' + base;
      return buildTargetUrl('inbounds', '/api/inbounds');
    }

    if (target === 'outbounds') {
      const active = activeFileParam('outbounds');
      const base = active ? active : _baseName(window.XKEEN_FILES && window.XKEEN_FILES.outbounds, '04_outbounds.json');
      if (titleEl) titleEl.textContent = 'Редактор ' + base;
      if (fileLabelEl) fileLabelEl.textContent = 'Файл: ' + base;
      return buildTargetUrl('outbounds', '/api/outbounds');
    }

    return null;
  }

  function jsonLintAvailable(runtime) {
    const target = runtime || getCodeMirrorValidationRuntime();
    try {
      return !!(target && typeof target.validateText === 'function');
    } catch (e) {
      return false;
    }
  }

  function normalizeEngine(v) {
    const s = String(v || '').toLowerCase();
    return (s === 'monaco' || s === 'codemirror') ? s : 'codemirror';
  }

  function getEngineHelper() {
    try { return (window.XKeen && XKeen.ui && XKeen.ui.editorEngine) ? XKeen.ui.editorEngine : null; } catch (e) { return null; }
  }

  const CM6_SCOPE = 'json-modal';

  function withCm6Scope(opts) {
    return Object.assign({ cm6Scope: CM6_SCOPE }, opts || {});
  }

  function getEditorRuntime(engine, opts) {
    const helper = getEngineHelper();
    if (!helper || typeof helper.getRuntime !== 'function') return null;
    try { return helper.getRuntime(engine, withCm6Scope(opts)); } catch (e) {}
    return null;
  }

  async function ensureEditorRuntime(engine, opts) {
    const helper = getEngineHelper();
    if (!helper) return null;
    try {
      if (typeof helper.ensureRuntime === 'function') return await helper.ensureRuntime(engine, withCm6Scope(opts));
      if (typeof helper.getRuntime === 'function') return helper.getRuntime(engine, withCm6Scope(opts));
    } catch (e) {}
    return null;
  }

  function isCm6Editor(cm) {
    try {
      return !!(cm && cm.__xkeen_cm6_bridge === true);
    } catch (e) {}
    return false;
  }

  function getCodeMirrorValidationRuntime() {
    try {
      return (window.XKeen && XKeen.ui && XKeen.ui.cm6Runtime) ? XKeen.ui.cm6Runtime : null;
    } catch (e) {}
    return null;
  }

  function jsonValidationMode(text) {
    return hasJsonComments(text) ? 'jsonc' : 'application/json';
  }

  function validateCurrentJson(text, opts) {
    const raw = String(text ?? '');
    const options = opts || {};
    const cm = _cm;
    const runtime = getCodeMirrorValidationRuntime();
    const mode = jsonValidationMode(raw);
    const allowComments = mode === 'jsonc';
    let result = { ok: true, diagnostics: [], summary: '' };

    try {
      if (runtime && typeof runtime.applyValidation === 'function') {
        result = runtime.applyValidation(cm || null, {
          text: raw,
          mode,
          allowComments,
        }) || result;
      } else if (runtime && typeof runtime.validateText === 'function') {
        result = runtime.validateText(raw, { mode, allowComments }) || result;
      }
    } catch (e) {}

    if (!result || typeof result !== 'object') result = { ok: true, diagnostics: [], summary: '' };

    if (cm && isCm6Editor(cm) && typeof cm.setDiagnostics === 'function') {
      try {
        cm.setDiagnostics(Array.isArray(result.diagnostics) ? result.diagnostics : []);
      } catch (e) {}
    }

    if (result.ok === false) {
      const msg = String(result.summary || 'Ошибка JSON.');
      if (!options.silent) setError(msg);
      return { ok: false, summary: msg, diagnostics: Array.isArray(result.diagnostics) ? result.diagnostics : [] };
    }

    if (!options.silent) setError('');
    return { ok: true, diagnostics: Array.isArray(result.diagnostics) ? result.diagnostics : [], summary: '' };
  }

  function createCodeMirrorFacade(cm) {
    if (!cm) return null;
    const helper = getEngineHelper();
    if (!helper || typeof helper.fromCodeMirror !== 'function') return null;
    try {
      return helper.fromCodeMirror(cm, {
        set: (value) => {
          const next = String(value ?? '');
          try { updateLintForText(cm, next); } catch (e) {}
          try { cm.setValue(next); } catch (e2) {}
          try { validateCurrentJson(next, { silent: false }); } catch (e3) {}
        },
        layout: () => {
          try { cm.refresh(); } catch (e) {}
        },
      });
    } catch (e) {}
    return null;
  }

  function createMonacoFacade(editor) {
    if (!editor) return null;
    const helper = getEngineHelper();
    if (!helper || typeof helper.fromMonaco !== 'function') return null;
    try {
      return helper.fromMonaco(editor);
    } catch (e) {}
    return null;
  }

  function getTextareaFacade() {
    const textarea = el('json-editor-textarea');
    if (!textarea) return null;
    const helper = getEngineHelper();
    if (!helper || typeof helper.fromTextarea !== 'function') return null;
    try {
      return helper.fromTextarea(textarea, { kind: 'codemirror' });
    } catch (e) {}
    return null;
  }

  function getActiveFacade() {
    if (_kind === 'monaco' && _monacoFacade) return _monacoFacade;
    if (_kind !== 'monaco' && _cmFacade) return _cmFacade;
    return getTextareaFacade();
  }

  function getViewStateStore() {
    if (_viewStateStore) return _viewStateStore;
    const helper = getEngineHelper();
    if (!helper || typeof helper.createViewStateStore !== 'function') return null;
    try {
      _viewStateStore = helper.createViewStateStore({
        buildKey: (ctx) => {
          const scope = ctx && ctx.target ? String(ctx.target || '').trim() : '';
          const file = ctx && ctx.file ? String(ctx.file || '').trim() : '';
          if (!scope) return '';
          return 'xkeen.json_editor.viewstate.v1::'
            + encodeURIComponent(scope)
            + '::'
            + encodeURIComponent(file || '__default__');
        },
      });
    } catch (e) {
      _viewStateStore = null;
    }
    return _viewStateStore;
  }

  function getViewStateContext(target) {
    const scope = String(target || _currentTarget || '').trim();
    if (!scope) return null;
    const file = activeFileParam(scope) || scope;
    return { target: scope, file };
  }

  function captureCurrentViewState() {
    const store = getViewStateStore();
    if (!store || typeof store.capture !== 'function') return null;
    return store.capture({
      engine: _kind,
      facade: getActiveFacade(),
      textarea: el('json-editor-textarea'),
      capture: () => {
        const fac = getActiveFacade();
        if (fac && typeof fac.saveViewState === 'function') {
          return fac.saveViewState({ memoryOnly: true });
        }
        return null;
      },
    });
  }

  function loadSavedViewState(target, engine) {
    const store = getViewStateStore();
    const ctx = getViewStateContext(target);
    if (!store || !ctx || typeof store.load !== 'function') return null;
    return store.load({ ctx, engine: engine || _kind });
  }

  function restoreCurrentViewState(view) {
    const store = getViewStateStore();
    if (!store || typeof store.restore !== 'function') return false;
    return !!store.restore({
      engine: _kind,
      facade: getActiveFacade(),
      textarea: el('json-editor-textarea'),
      view,
    });
  }

  function saveCurrentViewState(opts) {
    const store = getViewStateStore();
    const ctx = getViewStateContext(opts && opts.target ? opts.target : null);
    if (!store || !ctx || typeof store.save !== 'function') return null;
    return store.save({
      ctx,
      engine: (opts && opts.engine) || _kind,
      view: (opts && typeof opts.view !== 'undefined') ? opts.view : captureCurrentViewState(),
    });
  }

  function clearViewStateTracking() {
    const store = getViewStateStore();
    if (!store) return;
    try { if (typeof store.clearTimer === 'function') store.clearTimer(); } catch (e) {}
    try { if (typeof store.clearBindings === 'function') store.clearBindings(); } catch (e2) {}
  }

  function bindViewStateTracking() {
    const store = getViewStateStore();
    const ctx = getViewStateContext();
    if (!store || !ctx || typeof store.bind !== 'function') return;
    store.bind({
      ctx,
      engine: _kind,
      monaco: _kind === 'monaco' ? _monaco : null,
      codemirror: _kind === 'codemirror' ? _cm : null,
      textarea: el('json-editor-textarea'),
      waitMs: 180,
      capture: () => captureCurrentViewState(),
    });
  }

  function setEngineSelect(engine) {
    const sel = el('json-editor-engine-select');
    if (!sel) return;
    try { sel.value = normalizeEngine(engine); } catch (e) {}
  }

  function showEditorKind(kind) {
    const k = normalizeEngine(kind);
    const host = el('json-editor-monaco');

    // CodeMirror wrapper
    try {
      if (_cm && _cm.getWrapperElement) {
        const w = _cm.getWrapperElement();
        if (w) w.style.display = (k === 'codemirror') ? '' : 'none';
      }
    } catch (e) {}

    // Textarea fallback (if CM failed)
    try {
      const ta = el('json-editor-textarea');
      if (ta && !_cm) ta.style.display = (k === 'codemirror') ? '' : 'none';
    } catch (e) {}

    // Monaco host
    try {
      if (host) host.classList.toggle('hidden', k !== 'monaco');
    } catch (e) {}
  }

  async function ensureEditor(textarea) {
    if (_cm || !textarea) return _cm;

    let runtime = null;
    try {
      runtime = await ensureEditorRuntime('codemirror', {
        jsonLint: true,
        search: true,
        rulers: true,
        trailingSpace: true,
      });
      if (runtime && typeof runtime.ensureAssets === 'function') {
        await runtime.ensureAssets({
          jsonLint: true,
          search: true,
          rulers: true,
          trailingSpace: true,
        });
      }
    } catch (e) {}

    const canUseRuntime = !!(runtime && typeof runtime.create === 'function');
    if (!canUseRuntime) return null;

    const canLint = jsonLintAvailable(runtime);

    _cm = runtime.create(textarea, {
      mode: 'jsonc',
      theme: cmThemeFromPage(),
      lineNumbers: true,
      styleActiveLine: true,
      showIndentGuides: true,
      matchBrackets: true,
      showTrailingSpace: true,
      rulers: [{ column: 120 }],
      lineWrapping: true,
      gutters: ['CodeMirror-lint-markers'],
      lint: canLint,
      tabSize: 2,
      indentUnit: 2,
      indentWithTabs: false,
      extraKeys: {
        'Ctrl-F': 'findPersistent',
        'Cmd-F': 'findPersistent',
        'Ctrl-G': 'findNext',
        'Cmd-G': 'findNext',
        'Shift-Ctrl-G': 'findPrev',
        'Shift-Cmd-G': 'findPrev',
        'Ctrl-H': 'replace',
        'Shift-Ctrl-H': 'replaceAll',
      },
      viewportMargin: Infinity,
    });

    try {
      if (_cm.getWrapperElement) {
        _cm.getWrapperElement().classList.add('xkeen-cm');
      }
    } catch (e) {}

    try {
      if (window.xkeenAttachCmToolbar && window.XKEEN_CM_TOOLBAR_MINI) {
        window.xkeenAttachCmToolbar(_cm, window.XKEEN_CM_TOOLBAR_MINI);
      }
    } catch (e) {}

    try {
      XKeen.state.jsonModalEditor = _cm;
    } catch (e) {}

    _cmFacade = createCodeMirrorFacade(_cm);

    return _cm;
  }

  async function ensureMonacoEditor(initialText) {
    const host = el('json-editor-monaco');
    if (_monacoFacade && _monaco) return _monacoFacade;
    if (!host) return null;

    const runtime = await ensureEditorRuntime('monaco');
    if (!runtime || typeof runtime.create !== 'function') return null;

    _monaco = await runtime.create(host, {
      language: 'json',
      readOnly: false,
      value: String(initialText ?? ''),
      tabSize: 2,
      insertSpaces: true,
      wordWrap: 'on',
    });

    if (_monaco) _monacoFacade = createMonacoFacade(_monaco);
    return _monacoFacade;
  }

  function getCurrentValue() {
    const fac = getActiveFacade();
    try {
      if (fac && typeof fac.get === 'function') return String(fac.get() || '');
    } catch (e) {}
    return '';
  }

  function setCurrentValue(text) {
    const v = String(text ?? '');
    const fac = getActiveFacade();
    try {
      if (fac && typeof fac.set === 'function') {
        fac.set(v);
        return;
      }
    } catch (e) {}
    const textarea = el('json-editor-textarea');
    if (textarea) textarea.value = v;
  }

  async function switchEngine(nextEngine, opts) {
    const next = normalizeEngine(nextEngine);
    if (next === _kind) return;

    const prevText = getCurrentValue();
    const preservedView = captureCurrentViewState();
    let cmCursor = null;
    let cmScroll = null;
    try { if (_cm) cmCursor = _cm.getCursor(); } catch (e) {}
    try { if (_cm) cmScroll = _cm.getScrollInfo(); } catch (e) {}

    _kind = next;
    setEngineSelect(_kind);

    if (_kind === 'monaco') {
      const fac = await ensureMonacoEditor(prevText);
      if (fac) {
        try { fac.set(prevText); } catch (e) {}
        try { setError(''); } catch (e2) {}
        try { fac.layout(); } catch (e3) {}
        try { fac.focus(); } catch (e4) {}
      }
    } else {
      const textarea = el('json-editor-textarea');
      const cm = await ensureEditor(textarea);
      const fac = _cmFacade || createCodeMirrorFacade(cm);
      if (cm) {
        try { cm.setOption('theme', cmThemeFromPage()); } catch (e) {}
        try { if (fac && typeof fac.set === 'function') fac.set(prevText); } catch (e) {}
        try { validateCurrentJson(prevText, { silent: false }); } catch (e2) {}
        try {
          if (cmCursor) cm.setCursor(cmCursor);
          if (cmScroll && typeof cm.scrollTo === 'function') cm.scrollTo(cmScroll.left || 0, cmScroll.top || 0);
        } catch (e) {}
        setTimeout(() => {
          try { if (fac && typeof fac.layout === 'function') fac.layout(); } catch (e) {}
          try { if (fac && typeof fac.focus === 'function') fac.focus(); } catch (e2) {}
        }, 0);
      } else if (textarea) {
        textarea.value = prevText;
        try { validateCurrentJson(prevText, { silent: false }); } catch (e) {}
        textarea.focus();
      }
    }

    showEditorKind(_kind);
    try { if (preservedView) restoreCurrentViewState(preservedView); } catch (e) {}
    try { bindViewStateTracking(); } catch (e) {}
    try { bindDirtyListener(); } catch (e) {}
    try { syncTargetDirtyState(); } catch (e) {}

    // Persist as global preference (best-effort)
    try {
      const helper = getEngineHelper();
      if (helper && typeof helper.set === 'function' && !(opts && opts.noPersist)) {
        helper.set(_kind);
      }
    } catch (e) {}
  }

  function ensureWired() {
    if (_inited) return;
    _inited = true;

    const modal = el('json-editor-modal');
    const closeBtn = el('json-editor-close-btn');
    const cancelBtn = el('json-editor-cancel-btn');
    const saveBtn = el('json-editor-save-btn');
    const formatBtn = el('json-editor-format-btn');
    const engineSel = el('json-editor-engine-select');

    const onClose = async (e) => {
      if (e && e.preventDefault) e.preventDefault();
      const ok = await confirmCloseIfDirty();
      if (!ok) return;
      close();
    };

    if (closeBtn) closeBtn.addEventListener('click', onClose);
    if (cancelBtn) cancelBtn.addEventListener('click', onClose);

    if (saveBtn) {
      saveBtn.addEventListener('click', (e) => {
        e.preventDefault();
        save();
      });
    }

    if (formatBtn) {
      formatBtn.addEventListener('click', (e) => {
        e.preventDefault();
        formatCurrent();
      });
    }

    if (engineSel && !(engineSel.dataset && engineSel.dataset.xkeenWired === '1')) {
      engineSel.addEventListener('change', (e) => {
        const v = e && e.target ? e.target.value : null;
        switchEngine(v);
      });
      if (engineSel.dataset) engineSel.dataset.xkeenWired = '1';
    }

    // Sync with global engine changes (best-effort)
    try {
      const helper = getEngineHelper();
      if (helper && typeof helper.onChange === 'function') {
        if (_engineUnsub) { try { _engineUnsub(); } catch (e) {} }
        _engineUnsub = helper.onChange((d) => {
          try {
            const m = el('json-editor-modal');
            if (!m || m.classList.contains('hidden')) return;
            const eng = normalizeEngine(d && d.engine);
            if (eng && eng !== _kind) switchEngine(eng, { noPersist: true });
          } catch (e) {}
        });
      }
    } catch (e) {}

  }

  async function open(target) {
    ensureWired();

    const url = setHeader(target);
    if (!url) return;

    const modal = el('json-editor-modal');
    const textarea = el('json-editor-textarea');
    if (!modal || !textarea) return;

    try { saveCurrentViewState(); } catch (e) {}
    try { clearViewStateTracking(); } catch (e) {}
    try { clearDirtyListener(); } catch (e) {}
    try { clearTargetDirtyState(_currentTarget); } catch (e) {}
    _currentTarget = target;
    try { clearTargetDirtyState(_currentTarget); } catch (e) {}
    setError('');
    showModal(modal, 'json_editor_open');

    // Adopt preferred engine (server/local). Default is CodeMirror.
    try {
      const helper = getEngineHelper();
      if (helper && typeof helper.ensureLoaded === 'function') {
        await helper.ensureLoaded();
      }
      const pref = helper && typeof helper.get === 'function' ? helper.get() : 'codemirror';
      _kind = normalizeEngine(pref);
      setEngineSelect(_kind);
    } catch (e) {
      _kind = 'codemirror';
      setEngineSelect(_kind);
    }

    try {
      const res = await fetch(url, { method: 'GET' });
      if (!res.ok) {
        setError('Не удалось загрузить конфиг.');
        return;
      }

      const data = await res.json().catch(() => ({}));
      const finalText = (data && typeof data.text === 'string')
        ? data.text
        : (data && data.config ? JSON.stringify(data.config, null, 2) : '{}');
      _savedText = String(finalText || '');

      // JSONC sidecar status (no absolute paths in UI)
      try {
        const badge = el('json-editor-comments-status');
        if (badge) {
          const hasSidecar = !!(data && data.raw_path);
          badge.classList.toggle('xk-comments-on', hasSidecar);
          badge.classList.toggle('xk-comments-off', !hasSidecar);
          badge.textContent = hasSidecar ? 'Комментарии: включены' : 'Комментарии: выключены';
        }
      } catch (e) {}

      if (_kind === 'monaco') {
        await ensureMonacoEditor(finalText || '');
        try {
          if (_monacoFacade) {
            _monacoFacade.set(finalText || '');
            setError('');
            _monacoFacade.focus();
            _monacoFacade.layout();
          }
        } catch (e) {}
      } else {
        const cm = await ensureEditor(textarea);
        const fac = _cmFacade || createCodeMirrorFacade(cm);
        if (cm) {
          try { cm.setOption('theme', cmThemeFromPage()); } catch (e) {}
          try { if (fac && typeof fac.set === 'function') fac.set(finalText || ''); } catch (e) {}
          try { validateCurrentJson(finalText || '', { silent: false }); } catch (e2) {}
          setTimeout(() => {
            try { if (fac && typeof fac.layout === 'function') fac.layout(); } catch (e) {}
            try { if (fac && typeof fac.focus === 'function') fac.focus(); } catch (e2) {}
          }, 0);
        } else {
          textarea.value = finalText || '';
          try { validateCurrentJson(finalText || '', { silent: false }); } catch (e) {}
          textarea.focus();
        }
      }

      showEditorKind(_kind);
      try {
        const savedView = loadSavedViewState(_currentTarget, _kind);
        if (savedView) restoreCurrentViewState(savedView);
      } catch (e) {}
      try { bindViewStateTracking(); } catch (e) {}
      try { bindDirtyListener(); } catch (e) {}
      try { syncTargetDirtyState(false); } catch (e) {}
    } catch (e) {
      console.error(e);
      setError('Ошибка загрузки конфига.');
    }
  }

  function close() {
    const target = _currentTarget;
    try { saveCurrentViewState(); } catch (e) {}
    try { clearViewStateTracking(); } catch (e) {}
    const modal = el('json-editor-modal');
    if (modal) hideModal(modal, 'json_editor_close');
    try { clearDirtyListener(); } catch (e) {}
    try { if (_cm && typeof _cm.clearDiagnostics === 'function') _cm.clearDiagnostics(); } catch (e2) {}
    try { clearTargetDirtyState(target); } catch (e3) {}
    setError('');
    _currentTarget = null;
    _savedText = '';
  }

  function isDirty() {
    if (!_currentTarget) return false;
    try {
      return String(getCurrentValue() || '') !== String(_savedText || '');
    } catch (e) {
      return false;
    }
  }

  async function confirmCloseIfDirty() {
    if (!isDirty()) return true;

    const target = String(_currentTarget || 'config');
    const message = 'В JSON-редакторе ' + target + ' есть несохранённые изменения. Закрыть и потерять их?';

    try {
      if (window.XKeen && XKeen.ui && typeof XKeen.ui.confirm === 'function') {
        return await XKeen.ui.confirm({
          title: 'Закрыть редактор?',
          message,
          okText: 'Закрыть',
          cancelText: 'Остаться',
          danger: true,
        });
      }
    } catch (e) {}

    try {
      return !!window.confirm(message);
    } catch (e) {}
    return false;
  }



  function hasJsonComments(text) {
    const t = String(text || '');
    // Rough detection: ignore URLs by requiring comment token not preceded by ':'
    return /(^|[^:])\/\/|\n\s*#|\/\*/.test(t);
  }

  function updateLintForText(cm, text) {
    if (!cm) return;
    if (isCm6Editor(cm)) {
      try { validateCurrentJson(text, { silent: false }); } catch (e) {}
      return;
    }
    try {
      const canLint = jsonLintAvailable();
      cm.setOption('lint', canLint && !hasJsonComments(text));
    } catch (e) {}
  }

  async function formatCurrent() {
    ensureWired();
    const text = String(getCurrentValue() || '');
    if (!text.trim()) {
      setError('Пустой JSON.');
      return;
    }
    setError('');

    let preferPrettier = false;
    try {
      preferPrettier = await getPreferPrettierFlag();
    } catch (e) {
      preferPrettier = false;
    }

    if (preferPrettier) {
      try {
        const ensureFeature = (window.XKeen && XKeen.lazy && typeof XKeen.lazy.ensureFeature === 'function')
          ? XKeen.lazy.ensureFeature
          : null;
        if (ensureFeature) {
          await Promise.resolve(ensureFeature('formatters'));
        }
      } catch (e) {}

      try {
        const formatters = getFormattersApi();
        if (formatters && typeof formatters.formatJson === 'function') {
          const parser = hasJsonComments(text) ? 'jsonc' : 'json';
          const result = await formatters.formatJson(text, { parser });
          if (result && result.ok === true && typeof result.text === 'string') {
            const pretty = String(result.text || '');
            setCurrentValue(pretty);
            try {
              const fac = getActiveFacade();
              if (fac && typeof fac.focus === 'function') fac.focus();
            } catch (e) {}
            toast('JSON отформатирован.', false);
            return;
          }
        }
      } catch (e) {
        // Fallback to server formatter below.
      }
    }

    try {
      const res = await fetch('/api/json/format', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data || data.ok !== true || typeof data.text !== 'string') {
        const msg = 'Ошибка форматирования: ' + ((data && data.error) || res.statusText || ('HTTP ' + res.status));
        setError(msg);
        toast(msg, true);
        return;
      }

      const next = String(data.text || '');
      setCurrentValue(next);
      try {
        const fac = getActiveFacade();
        if (fac && typeof fac.focus === 'function') fac.focus();
      } catch (e) {}
      toast('JSON отформатирован.', false);
    } catch (e) {
      console.error(e);
      const msg = 'Ошибка форматирования.';
      setError(msg);
      toast(msg, true);
    }
  }

  async function save() {
    ensureWired();

    if (!_currentTarget) return;

    const target = _currentTarget;
    const text = String(getCurrentValue() || '');
    if (text === null || typeof text !== 'string') return;
    const validation = validateCurrentJson(text, { silent: false });
    if (validation && validation.ok === false) {
      const msg = String(validation.summary || 'Ошибка JSON.');
      setError(msg);
      toast(msg, true);
      try {
        const fac = getActiveFacade();
        if (fac && typeof fac.focus === 'function') fac.focus();
      } catch (e) {}
      return;
    }
    // Send raw JSON/JSONC text to backend (keeps comments).
    const url = target === 'inbounds'
      ? buildTargetUrl('inbounds', '/api/inbounds')
      : buildTargetUrl('outbounds', '/api/outbounds');

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          restart: shouldRestartAfterSave(),
        }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok || !data || data.ok !== true) {
        const msg = 'Ошибка сохранения: ' + ((data && data.error) || res.statusText || ('HTTP ' + res.status));
        setError(msg);
        toast(msg, true);
        return;
      }

      _savedText = text;
      close();

      // Refresh related panels (modular)
      try {
        if (target === 'inbounds' && window.XKeen && XKeen.features && XKeen.features.inbounds && typeof XKeen.features.inbounds.load === 'function') {
          await XKeen.features.inbounds.load();
        }
        if (target === 'outbounds' && window.XKeen && XKeen.features && XKeen.features.outbounds && typeof XKeen.features.outbounds.load === 'function') {
          await XKeen.features.outbounds.load();
        }
      } catch (e) {
        console.error(e);
      }
      if (!data || !data.restarted) {
        // Show correct file name (supports *_hys2 variants)
        function _baseName(p, fallback) {
          try {
            if (!p) return fallback;
            const parts = String(p).split(/[\\/]/);
            const b = parts[parts.length - 1];
            return b || fallback;
          } catch (e) {
            return fallback;
          }
        }

        const files = (window.XKEEN_FILES && typeof window.XKEEN_FILES === 'object') ? window.XKEEN_FILES : {};
        const label = target === 'inbounds'
          ? _baseName(files.inbounds, '03_inbounds.json')
          : _baseName(files.outbounds, '04_outbounds.json');

        toast(label + ' сохранён.', false);
      }

      try { refreshRestartLog(); } catch (e) {}
    } catch (e) {
      console.error(e);
      setError('Ошибка сохранения.');
      toast('Ошибка сохранения.', true);
    }
  }

  XKeen.jsonEditor.init = ensureWired;
  XKeen.jsonEditor.open = open;
  XKeen.jsonEditor.close = close;
  XKeen.jsonEditor.isDirty = isDirty;
  XKeen.jsonEditor.save = save;
})();

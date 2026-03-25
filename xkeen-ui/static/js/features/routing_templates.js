(() => {
  'use strict';

  // Routing templates (Xray): UI modal that loads presets from /opt/etc/xray/templates/routing
  // API:
  //   GET  /api/routing/templates
  //   GET  /api/routing/templates/<filename>

  window.XKeen = window.XKeen || {};
  const XK = window.XKeen;
  XK.features = XK.features || {};

  const IDS = {
    btnOpen: 'routing-import-template-btn',
    modal: 'routing-template-modal',
    list: 'routing-template-list',
    count: 'routing-template-count',
    title: 'routing-template-title',
    desc: 'routing-template-desc',
    preview: 'routing-template-preview',
    previewMonaco: 'routing-template-preview-monaco',
    previewEngineSelect: 'routing-template-preview-engine-select',
    status: 'routing-template-status',
    btnRefresh: 'routing-template-refresh-btn',
    btnSave: 'routing-template-save-btn',
    btnEdit: 'routing-template-edit-btn',
    btnDelete: 'routing-template-delete-btn',
    btnImport: 'routing-template-import-btn',
    btnCloseX: 'routing-template-close-btn',
    btnCancel: 'routing-template-cancel-btn',

    // Save user template modal
    saveModal: 'routing-template-save-modal',
    saveFilename: 'routing-template-save-filename',
    saveTitle: 'routing-template-save-title',
    saveDesc: 'routing-template-save-desc',
    saveStatus: 'routing-template-save-status',
    saveConfirm: 'routing-template-save-confirm-btn',
    saveCancel: 'routing-template-save-cancel-btn',
    saveCloseX: 'routing-template-save-close-btn',


// Edit user template modal
editModal: 'routing-template-edit-modal',
editFilename: 'routing-template-edit-filename',
editTitle: 'routing-template-edit-title',
editDesc: 'routing-template-edit-desc',
editContent: 'routing-template-edit-content',
editStatus: 'routing-template-edit-status',
editConfirm: 'routing-template-edit-confirm-btn',
editCancel: 'routing-template-edit-cancel-btn',
editCloseX: 'routing-template-edit-close-btn',
editMonaco: 'routing-template-edit-monaco',
editEngineSelect: 'routing-template-edit-engine-select',
  };

  let _inited = false;
  let _templates = [];
  let _selected = null; // {filename,title,description,builtin?}
  let _selectedContent = '';

  let _editOriginalFilename = '';
  let _editCm = null;
  let _editCmFacade = null;
  let _previewCm = null;
  let _previewCmFacade = null;

  // Monaco state (lazy; created only when engine=monaco)
  let _previewMonaco = null;
  let _previewMonacoFacade = null;
  let _previewKind = 'codemirror';

  let _editMonaco = null;
  let _editMonacoFacade = null;
  let _editKind = 'codemirror';

  let _engineSyncing = false;
  let _previewViewStateStore = null;
  let _editViewStateStore = null;

  function currentCmTheme() {
    try {
      return document.documentElement.getAttribute('data-theme') === 'light' ? 'default' : 'material-darker';
    } catch (e) {
      return 'material-darker';
    }
  }

  function el(id) {
    return document.getElementById(id);
  }

  function getRoutingShellApi() {
    try {
      if (window.XKeen && XKeen.features && XKeen.features.routingShell) return XKeen.features.routingShell;
    } catch (e) {}
    return null;
  }

  function getRoutingEditor() {
    const shell = getRoutingShellApi();
    if (shell && typeof shell.getEditorInstance === 'function') {
      try {
        return shell.getEditorInstance();
      } catch (e) {}
    }
    return null;
  }

  function setStatus(msg, isError) {
    const s = el(IDS.status);
    if (s) {
      s.textContent = String(msg || '');
      s.classList.toggle('error', !!isError);
    }

  }


  // -------------------------- engine toggle (CodeMirror / Monaco) --------------------------
  const PREVIEW_PLACEHOLDER = '// превью появится здесь';

  function normalizeEngine(v) {
    const s = String(v || '').toLowerCase();
    return (s === 'monaco' || s === 'codemirror') ? s : 'codemirror';
  }

  function getEngineHelper() {
    try { return (window.XKeen && XKeen.ui && XKeen.ui.editorEngine) ? XKeen.ui.editorEngine : null; } catch (e) { return null; }
  }

  const CM6_SCOPE = 'routing-templates';

  function withCm6Scope(opts) {
    return Object.assign({ cm6Scope: CM6_SCOPE, scope: CM6_SCOPE }, opts || {});
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

  function isCm6Runtime(runtime) {
    try { return !!(runtime && runtime.backend === 'cm6'); } catch (e) {}
    return false;
  }

  function isCm6Editor(editor) {
    try {
      if (!editor) return false;
      if (editor.__xkeenCm6Bridge || editor.backend === 'cm6') return true;
      const wrap = (typeof editor.getWrapperElement === 'function') ? editor.getWrapperElement() : null;
      return !!(wrap && wrap.classList && wrap.classList.contains('xkeen-cm6-editor'));
    } catch (e) {}
    return false;
  }

  function disposeCodeMirrorEditor(editor) {
    if (!editor) return false;
    try { if (typeof editor.dispose === 'function') return !!editor.dispose(); } catch (e) {}
    try {
      if (typeof editor.toTextArea === 'function') {
        editor.toTextArea();
        return true;
      }
    } catch (e) {}
    return false;
  }

  function createCodeMirrorFacade(cm) {
    if (!cm) return null;
    const runtime = getEditorRuntime('codemirror');
    if (runtime && typeof runtime.toFacade === 'function') {
      try {
        return runtime.toFacade(cm, {
          layout: () => {
            try { if (cm.layout) cm.layout(); else if (cm.refresh) cm.refresh(); } catch (e) {}
          },
        });
      } catch (e) {}
    }
    const helper = getEngineHelper();
    if (!helper || typeof helper.fromCodeMirror !== 'function') return null;
    try {
      return helper.fromCodeMirror(cm, {
        layout: () => {
          try { if (cm.layout) cm.layout(); else if (cm.refresh) cm.refresh(); } catch (e) {}
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

  function previewActiveFacade() {
    if (_previewKind === 'monaco' && _previewMonacoFacade) return _previewMonacoFacade;
    if (_previewCmFacade) return _previewCmFacade;
    return null;
  }

  function editActiveFacade() {
    if (_editKind === 'monaco' && _editMonacoFacade) return _editMonacoFacade;
    if (_editCmFacade) return _editCmFacade;
    return null;
  }

  function getScopedViewStateStore(kind) {
    const slot = String(kind || '').toLowerCase() === 'edit' ? 'edit' : 'preview';
    if (slot === 'edit' && _editViewStateStore) return _editViewStateStore;
    if (slot === 'preview' && _previewViewStateStore) return _previewViewStateStore;

    const helper = getEngineHelper();
    if (!helper || typeof helper.createViewStateStore !== 'function') return null;
    try {
      const store = helper.createViewStateStore({
        buildKey: (ctx) => {
          const filename = ctx && ctx.filename ? String(ctx.filename || '').trim() : '';
          if (!filename) return '';
          return 'xkeen.routing.templates.viewstate.v1::'
            + slot
            + '::'
            + encodeURIComponent(filename);
        },
      });
      if (slot === 'edit') _editViewStateStore = store;
      else _previewViewStateStore = store;
      return store;
    } catch (e) {}
    return null;
  }

  function getPreviewViewStateContext(filename) {
    const value = String(filename || (_selected && _selected.filename) || '').trim();
    if (!value) return null;
    return { filename: value };
  }

  function getEditViewStateContext(filename) {
    const value = String(filename || _editOriginalFilename || '').trim();
    if (!value) return null;
    return { filename: value };
  }

  function capturePreviewViewState() {
    const store = getScopedViewStateStore('preview');
    if (!store || typeof store.capture !== 'function') return null;
    return store.capture({
      engine: _previewKind,
      facade: previewActiveFacade(),
      textarea: el(IDS.preview),
      capture: () => {
        const fac = previewActiveFacade();
        if (fac && typeof fac.saveViewState === 'function') {
          return fac.saveViewState({ memoryOnly: true });
        }
        return null;
      },
    });
  }

  function savePreviewViewState(opts) {
    const store = getScopedViewStateStore('preview');
    const ctx = getPreviewViewStateContext(opts && opts.filename ? opts.filename : null);
    if (!store || !ctx || typeof store.save !== 'function') return null;
    return store.save({
      ctx,
      engine: (opts && opts.engine) || _previewKind,
      view: (opts && typeof opts.view !== 'undefined') ? opts.view : capturePreviewViewState(),
    });
  }

  function loadPreviewViewState(filename, engine) {
    const store = getScopedViewStateStore('preview');
    const ctx = getPreviewViewStateContext(filename);
    if (!store || !ctx || typeof store.load !== 'function') return null;
    return store.load({ ctx, engine: engine || _previewKind });
  }

  function restorePreviewViewState(view) {
    const store = getScopedViewStateStore('preview');
    if (!store || typeof store.restore !== 'function') return false;
    return !!store.restore({
      engine: _previewKind,
      facade: previewActiveFacade(),
      textarea: el(IDS.preview),
      view,
    });
  }

  function bindPreviewViewStateTracking() {
    const store = getScopedViewStateStore('preview');
    const ctx = getPreviewViewStateContext();
    if (!store || !ctx || typeof store.bind !== 'function') return;
    store.bind({
      ctx,
      engine: _previewKind,
      monaco: _previewKind === 'monaco' ? _previewMonaco : null,
      codemirror: _previewKind === 'codemirror' ? _previewCm : null,
      textarea: el(IDS.preview),
      waitMs: 180,
      capture: () => capturePreviewViewState(),
    });
  }

  function clearPreviewViewStateTracking() {
    const store = getScopedViewStateStore('preview');
    if (!store) return;
    try { if (typeof store.clearTimer === 'function') store.clearTimer(); } catch (e) {}
    try { if (typeof store.clearBindings === 'function') store.clearBindings(); } catch (e2) {}
  }

  function captureEditViewState() {
    const store = getScopedViewStateStore('edit');
    if (!store || typeof store.capture !== 'function') return null;
    return store.capture({
      engine: _editKind,
      facade: editActiveFacade(),
      textarea: el(IDS.editContent),
      capture: () => {
        const fac = editActiveFacade();
        if (fac && typeof fac.saveViewState === 'function') {
          return fac.saveViewState({ memoryOnly: true });
        }
        return null;
      },
    });
  }

  function saveEditViewState(opts) {
    const store = getScopedViewStateStore('edit');
    const ctx = getEditViewStateContext(opts && opts.filename ? opts.filename : null);
    if (!store || !ctx || typeof store.save !== 'function') return null;
    return store.save({
      ctx,
      engine: (opts && opts.engine) || _editKind,
      view: (opts && typeof opts.view !== 'undefined') ? opts.view : captureEditViewState(),
    });
  }

  function loadEditViewState(filename, engine) {
    const store = getScopedViewStateStore('edit');
    const ctx = getEditViewStateContext(filename);
    if (!store || !ctx || typeof store.load !== 'function') return null;
    return store.load({ ctx, engine: engine || _editKind });
  }

  function restoreEditViewState(view) {
    const store = getScopedViewStateStore('edit');
    if (!store || typeof store.restore !== 'function') return false;
    return !!store.restore({
      engine: _editKind,
      facade: editActiveFacade(),
      textarea: el(IDS.editContent),
      view,
    });
  }

  function bindEditViewStateTracking() {
    const store = getScopedViewStateStore('edit');
    const ctx = getEditViewStateContext();
    if (!store || !ctx || typeof store.bind !== 'function') return;
    store.bind({
      ctx,
      engine: _editKind,
      monaco: _editKind === 'monaco' ? _editMonaco : null,
      codemirror: _editKind === 'codemirror' ? _editCm : null,
      textarea: el(IDS.editContent),
      waitMs: 180,
      capture: () => captureEditViewState(),
    });
  }

  function clearEditViewStateTracking() {
    const store = getScopedViewStateStore('edit');
    if (!store) return;
    try { if (typeof store.clearTimer === 'function') store.clearTimer(); } catch (e) {}
    try { if (typeof store.clearBindings === 'function') store.clearBindings(); } catch (e2) {}
  }

  function setEngineSelects(engine) {
    const e = normalizeEngine(engine);
    const a = el(IDS.previewEngineSelect);
    const b = el(IDS.editEngineSelect);
    try { if (a) a.value = e; } catch (e2) {}
    try { if (b) b.value = e; } catch (e3) {}
  }

  function modalOpen(id) {
    const m = el(id);
    return !!(m && !m.classList.contains('hidden'));
  }

  function showNode(node) {
    if (!node) return;
    try { node.classList.remove('hidden'); } catch (e) {}
  }

  function hideNode(node) {
    if (!node) return;
    try { node.classList.add('hidden'); } catch (e) {}
  }

  function cmWrapper(cm) {
    try { return (cm && typeof cm.getWrapperElement === 'function') ? cm.getWrapperElement() : null; } catch (e) { return null; }
  }

  function resetPreviewVisibility() {
    const host = el(IDS.previewMonaco);
    const ta = el(IDS.preview);
    hideNode(host);
    const w = cmWrapper(_previewCm);
    if (w) showNode(w);
    if (!w && ta) showNode(ta);
  }

  function resetEditVisibility() {
    const host = el(IDS.editMonaco);
    const ta = el(IDS.editContent);
    hideNode(host);
    const w = cmWrapper(_editCm);
    if (w) showNode(w);
    if (!w && ta) showNode(ta);
  }

  function disposePreviewMonaco() {
    try { if (_previewMonaco && _previewMonaco.dispose) _previewMonaco.dispose(); } catch (e) {}
    _previewMonaco = null;
    _previewMonacoFacade = null;
    _previewKind = 'codemirror';
  }

  function disposeEditMonaco() {
    try { if (_editMonaco && _editMonaco.dispose) _editMonaco.dispose(); } catch (e) {}
    _editMonaco = null;
    _editMonacoFacade = null;
    _editKind = 'codemirror';
  }

  async function resolvePreferredEngine() {
    let engine = 'codemirror';
    const ee = getEngineHelper();
    try {
      if (ee && typeof ee.ensureLoaded === 'function') engine = normalizeEngine(await ee.ensureLoaded());
      else if (ee && typeof ee.get === 'function') engine = normalizeEngine(ee.get());
    } catch (e) {
      try { engine = normalizeEngine(ee && ee.get ? ee.get() : 'codemirror'); } catch (e2) { engine = 'codemirror'; }
    }
    return engine;
  }

  function previewTextFallback() {
    try {
      const fac = previewActiveFacade();
      if (fac && typeof fac.get === 'function') return String(fac.get() || '');
    } catch (e) {}
    const ta = el(IDS.preview);
    return ta ? String(ta.value || '') : '';
  }

  async function activatePreviewEngine(engine) {
    const next = normalizeEngine(engine);
    const host = el(IDS.previewMonaco);
    const preservedView = capturePreviewViewState();

    if (next === 'monaco') {
      const runtime = await ensureEditorRuntime('monaco');
      if (!runtime || !host || typeof runtime.create !== 'function') {
        try { if (window.toast) window.toast('Monaco недоступен — используется CodeMirror', 'warning'); } catch (e) {}
        const ee = getEngineHelper();
        try { if (ee && ee.set) await ee.set('codemirror'); } catch (e2) {}
        return activatePreviewEngine('codemirror');
      }

      // Hide CodeMirror/textarea, show Monaco host
      const w = cmWrapper(_previewCm);
      if (w) hideNode(w);
      const ta = el(IDS.preview);
      if (ta) hideNode(ta);
      showNode(host);

      const value = previewTextFallback() || PREVIEW_PLACEHOLDER;

      if (!_previewMonaco) {
        const ed = await runtime.create(host, {
          // Monaco core ships JSON support; JSONC is not always registered.
          // Templates may include comments, but for syntax highlighting we use 'json'.
          language: 'json',
          readOnly: true,
          value: value,
        });
        if (!ed) {
          try { if (window.toast) window.toast('Не удалось загрузить Monaco — переключаю на CodeMirror', 'warning'); } catch (e) {}
          const ee = getEngineHelper();
          try { if (ee && ee.set) await ee.set('codemirror'); } catch (e2) {}
          resetPreviewVisibility();
          return activatePreviewEngine('codemirror');
        }
        _previewMonaco = ed;
        _previewMonacoFacade = createMonacoFacade(ed);
      } else if (_previewMonacoFacade && _previewMonacoFacade.set) {
        _previewMonacoFacade.set(value);
      }

      _previewKind = 'monaco';
      try {
        if (!(preservedView && restorePreviewViewState(preservedView)) && _previewMonacoFacade) {
          _previewMonacoFacade.scrollTo(0, 0);
        }
      } catch (e) {}
      try { bindPreviewViewStateTracking(); } catch (e2) {}
      return 'monaco';
    }

    // CodeMirror
    try { await ensureEditorRuntime('codemirror', { mode: 'application/jsonc' }); } catch (e) {}
    hideNode(host);
    try { disposePreviewMonaco(); } catch (e) {}

    const cm = ensurePreviewEditor();
    const fac = _previewCmFacade || createCodeMirrorFacade(cm);
    const value = previewTextFallback() || PREVIEW_PLACEHOLDER;
    if (cm && cm.setValue) {
      try {
        if (fac && typeof fac.set === 'function') fac.set(value);
        if (fac && typeof fac.scrollTo === 'function') fac.scrollTo(0, 0);
        setTimeout(() => { try { if (fac && fac.layout) fac.layout(); } catch (e2) {} }, 30);
      } catch (e) {}
      const w = cmWrapper(cm);
      if (w) showNode(w);
    } else {
      const ta = el(IDS.preview);
      if (ta) {
        try { ta.value = value; } catch (e) {}
        showNode(ta);
      }
    }

    _previewKind = 'codemirror';
    try { if (preservedView) restorePreviewViewState(preservedView); } catch (e3) {}
    try { bindPreviewViewStateTracking(); } catch (e4) {}
    return 'codemirror';
  }

  async function activateEditEngine(engine) {
    const next = normalizeEngine(engine);
    const host = el(IDS.editMonaco);
    const preservedView = captureEditViewState();

    if (next === 'monaco') {
      const runtime = await ensureEditorRuntime('monaco');
      if (!runtime || !host || typeof runtime.create !== 'function') {
        try { if (window.toast) window.toast('Monaco недоступен — используется CodeMirror', 'warning'); } catch (e) {}
        const ee = getEngineHelper();
        try { if (ee && ee.set) await ee.set('codemirror'); } catch (e2) {}
        return activateEditEngine('codemirror');
      }

      // Preserve current value before switching
      const value = getEditEditorText();

      // Hide CodeMirror/textarea, show Monaco host
      const w = cmWrapper(_editCm);
      if (w) hideNode(w);
      const ta = el(IDS.editContent);
      if (ta) hideNode(ta);
      showNode(host);

      if (!_editMonaco) {
        const ed = await runtime.create(host, {
          // Monaco core ships JSON support; JSONC is not always registered.
          language: 'json',
          readOnly: false,
          value: value,
        });
        if (!ed) {
          try { if (window.toast) window.toast('Не удалось загрузить Monaco — переключаю на CodeMirror', 'warning'); } catch (e) {}
          const ee = getEngineHelper();
          try { if (ee && ee.set) await ee.set('codemirror'); } catch (e2) {}
          resetEditVisibility();
          return activateEditEngine('codemirror');
        }
        _editMonaco = ed;
        _editMonacoFacade = createMonacoFacade(ed);
      }

      try { if (_editMonacoFacade && _editMonacoFacade.set) _editMonacoFacade.set(value); } catch (e) {}
      _editKind = 'monaco';
      try { if (preservedView) restoreEditViewState(preservedView); } catch (e2) {}
      try { bindEditViewStateTracking(); } catch (e3) {}
      try { if (_editMonacoFacade) _editMonacoFacade.focus(); } catch (e) {}
      return 'monaco';
    }

    // CodeMirror
    try { await ensureEditorRuntime('codemirror', { mode: 'application/jsonc' }); } catch (e) {}
    hideNode(host);
    try { disposeEditMonaco(); } catch (e) {}

    const value = getEditEditorText();
    const cm = ensureEditEditor();
    const fac = _editCmFacade || createCodeMirrorFacade(cm);
    if (cm && cm.setValue) {
      try {
        if (fac && typeof fac.set === 'function') fac.set(String(value || ''));
        if (fac && typeof fac.scrollTo === 'function') fac.scrollTo(0, 0);
        setTimeout(() => { try { if (fac && fac.layout) fac.layout(); } catch (e2) {} }, 30);
      } catch (e) {}
      const w = cmWrapper(cm);
      if (w) showNode(w);
    } else {
      const ta = el(IDS.editContent);
      if (ta) {
        try { ta.value = String(value || ''); } catch (e) {}
        showNode(ta);
      }
    }

    _editKind = 'codemirror';
    try { if (preservedView) restoreEditViewState(preservedView); } catch (e4) {}
    try { bindEditViewStateTracking(); } catch (e5) {}
    return 'codemirror';
  }

  async function syncEngineNow() {
    if (_engineSyncing) return;
    _engineSyncing = true;
    try {
      const engine = await resolvePreferredEngine();
      setEngineSelects(engine);
      if (modalOpen(IDS.modal)) await activatePreviewEngine(engine);
      if (modalOpen(IDS.editModal)) await activateEditEngine(engine);
    } finally {
      _engineSyncing = false;
    }
  }

  function scheduleEngineSync() {
    try { setTimeout(() => { try { syncEngineNow(); } catch (e) {} }, 0); } catch (e) {}
  }

  function openModal() {
    const m = el(IDS.modal);
    if (!m) return;
    m.classList.remove('hidden');

    // Defer engine init until modal is visible (CodeMirror / Monaco).
    try { scheduleEngineSync(); } catch (e) {}

    // Make sure scroll lock is correct
    try {
      if (XK.ui && XK.ui.modal && typeof XK.ui.modal.syncBodyScrollLock === 'function') {
        XK.ui.modal.syncBodyScrollLock();
      }
    } catch (e) {}
  }

  function closeModal() {
    const m = el(IDS.modal);
    if (!m) return;
    try { savePreviewViewState(); } catch (e) {}
    try { clearPreviewViewStateTracking(); } catch (e2) {}
    m.classList.add('hidden');

    // Dispose Monaco preview editor to avoid leaks.
    try { disposePreviewMonaco(); } catch (e) {}
    try { resetPreviewVisibility(); } catch (e) {}

    // Make sure scroll lock is correct
    try {
      if (XK.ui && XK.ui.modal && typeof XK.ui.modal.syncBodyScrollLock === 'function') {
        XK.ui.modal.syncBodyScrollLock();
      }
    } catch (e) {}
  }

  function openSaveModal() {
    const m = el(IDS.saveModal);
    if (!m) return;
    m.classList.remove('hidden');
    try {
      if (XK.ui && XK.ui.modal && typeof XK.ui.modal.syncBodyScrollLock === 'function') {
        XK.ui.modal.syncBodyScrollLock();
      }
    } catch (e) {}
  }

  function closeSaveModal() {
    const m = el(IDS.saveModal);
    if (!m) return;
    m.classList.add('hidden');
    try {
      if (XK.ui && XK.ui.modal && typeof XK.ui.modal.syncBodyScrollLock === 'function') {
        XK.ui.modal.syncBodyScrollLock();
      }
    } catch (e) {}
  }

  function setSaveStatus(msg, isError) {
    const s = el(IDS.saveStatus);
    if (s) {
      s.textContent = String(msg || '');
      s.classList.toggle('error', !!isError);
    }
  }


function openEditModal() {
  const m = el(IDS.editModal);
  if (!m) return;
  m.classList.remove('hidden');
  try {
    if (XK.ui && XK.ui.modal && typeof XK.ui.modal.syncBodyScrollLock === 'function') {
      XK.ui.modal.syncBodyScrollLock();
    }
  } catch (e) {}

  // Defer engine init until modal is visible (CodeMirror / Monaco).
  try { scheduleEngineSync(); } catch (e) {}
}

function closeEditModal() {
  const m = el(IDS.editModal);
  if (!m) return;
  try { saveEditViewState(); } catch (e) {}
  try { clearEditViewStateTracking(); } catch (e2) {}
  m.classList.add('hidden');
  try {
    if (XK.ui && XK.ui.modal && typeof XK.ui.modal.syncBodyScrollLock === 'function') {
      XK.ui.modal.syncBodyScrollLock();
    }
  } catch (e) {}

  // Dispose Monaco editor to avoid leaks and restore default visibility.
  try { disposeEditMonaco(); } catch (e) {}
  try { resetEditVisibility(); } catch (e) {}
}

function setEditStatus(msg, isError) {
  const s = el(IDS.editStatus);
  if (s) {
    s.textContent = String(msg || '');
    s.classList.toggle('error', !!isError);
  }
}

function stripTemplateHeader(text) {
  // Remove the first-line meta header if present: // xkeen-template: {...}
  if (typeof text !== 'string') return '';
  return text.replace(/^\s*\/\/\s*xkeen-template:\s*\{[^\n]*\}\s*\n?/m, '');
}

function ensureEditEditor() {
  const ta = el(IDS.editContent);
  if (!ta) return null;

  const runtime = getEditorRuntime('codemirror');
  const preferCm6 = isCm6Runtime(runtime);

  if (_editCm) {
    if (!preferCm6 || isCm6Editor(_editCm)) {
      if (!_editCmFacade) _editCmFacade = createCodeMirrorFacade(_editCm);
      return _editCm;
    }
    try { disposeCodeMirrorEditor(_editCm); } catch (e) {}
    _editCm = null;
    _editCmFacade = null;
  }

  try {
    if (!runtime || typeof runtime.create !== 'function') return null;

    _editCm = runtime.create(ta, {
        mode: 'application/jsonc',
        theme: currentCmTheme(),
      lineNumbers: true,
      lineWrapping: true,
      styleActiveLine: true,
      matchBrackets: true,
      autoCloseBrackets: true,
      tabSize: 2,
      indentUnit: 2,
      indentWithTabs: false,
      viewportMargin: Infinity,
    });
    try {
      if (_editCm.getWrapperElement) {
        _editCm.getWrapperElement().classList.add('xkeen-cm');
        _editCm.getWrapperElement().classList.add('routing-template-edit-cm');
      }
    } catch (e2) {}

      // Register this editor for theme sync (light/dark)
      try {
        window.__xkeenEditors = window.__xkeenEditors || [];
        window.__xkeenEditors.push(_editCm);
      } catch (e3) {}
      _editCmFacade = createCodeMirrorFacade(_editCm);
  } catch (e) {
    console.error(e);
    _editCm = null;
  }
  return _editCm;
}

  function ensurePreviewEditor() {
    const ta = el(IDS.preview);
    if (!ta) return null;

    const runtime = getEditorRuntime('codemirror');
    const preferCm6 = isCm6Runtime(runtime);

    if (_previewCm) {
      if (!preferCm6 || isCm6Editor(_previewCm)) {
        if (!_previewCmFacade) _previewCmFacade = createCodeMirrorFacade(_previewCm);
        return _previewCm;
      }
      try { disposeCodeMirrorEditor(_previewCm); } catch (e) {}
      _previewCm = null;
      _previewCmFacade = null;
    }

    try {
      if (!runtime || typeof runtime.create !== 'function') return null;

      _previewCm = runtime.create(ta, {
        mode: 'application/jsonc',
        theme: currentCmTheme(),
        readOnly: 'nocursor',
        lineNumbers: false,
        lineWrapping: true,
        styleActiveLine: false,
        matchBrackets: true,
        tabSize: 2,
        indentUnit: 2,
        indentWithTabs: false,
        viewportMargin: Infinity,
      });
      try {
        if (_previewCm.getWrapperElement) {
          _previewCm.getWrapperElement().classList.add('xkeen-cm');
          _previewCm.getWrapperElement().classList.add('routing-template-preview-cm');
        }
      } catch (e2) {}

      // Register this editor for theme sync (light/dark)
      try {
        window.__xkeenEditors = window.__xkeenEditors || [];
        window.__xkeenEditors.push(_previewCm);
      } catch (e3) {}

      _previewCmFacade = createCodeMirrorFacade(_previewCm);

      try {
        if (_previewCmFacade && typeof _previewCmFacade.set === 'function') _previewCmFacade.set(PREVIEW_PLACEHOLDER);
        if (_previewCmFacade && typeof _previewCmFacade.scrollTo === 'function') _previewCmFacade.scrollTo(0, 0);
      } catch (e4) {}
    } catch (e) {
      console.error(e);
      _previewCm = null;
    }
    return _previewCm;
  }

function setPreviewText(text) {
  const value = String(text || '');

    // Always keep textarea in sync (fallback + source of truth before editor is inited).
    const ta = el(IDS.preview);
    if (ta) {
      try { ta.value = value; } catch (e) {}
    }

  // Update CodeMirror if present.
  try {
    if (_previewCmFacade && typeof _previewCmFacade.set === 'function') {
      _previewCmFacade.set(value);
      try { _previewCmFacade.scrollTo(0, 0); } catch (e2) {}
    }
  } catch (e) {}

  // Update Monaco if present.
  try {
    if (_previewMonacoFacade && typeof _previewMonacoFacade.set === 'function') {
      _previewMonacoFacade.set(value);
      try { _previewMonacoFacade.scrollTo(0, 0); } catch (e2) {}
    }
  } catch (e) {}
}


function getEditEditorText() {
  try {
    if (_editKind === 'monaco' && _editMonacoFacade && typeof _editMonacoFacade.get === 'function') {
      return String(_editMonacoFacade.get() || '');
    }
  } catch (e) {}
  if (_editCmFacade && typeof _editCmFacade.get === 'function') return String(_editCmFacade.get() || '');
  const ta = el(IDS.editContent);
  if (ta) return String(ta.value || '');
  return '';
}

function setEditEditorText(text) {
  const value = String(text || '');
  const ta = el(IDS.editContent);
  if (ta) {
    try { ta.value = value; } catch (e) {}
  }
  if (_editCmFacade && typeof _editCmFacade.set === 'function') {
    try {
      _editCmFacade.set(value);
      try { _editCmFacade.scrollTo(0, 0); } catch (e2) {}
    } catch (e) {}
  }
  try {
    if (_editMonacoFacade && typeof _editMonacoFacade.set === 'function') {
      _editMonacoFacade.set(value);
      try { _editMonacoFacade.scrollTo(0, 0); } catch (e2) {}
    }
  } catch (e) {}
}

  async function openEditForSelected() {
    if (!_selected || !_selected.filename) {
      setStatus('Сначала выбери шаблон.', true);
      return;
  }
  if (_selected.builtin) {
    setStatus('Встроенные шаблоны нельзя редактировать.', true);
    return;
  }

  setEditStatus('', false);

  // Make sure we have content
  let content = _selectedContent;
  if (!content) {
    content = await fetchTemplateContent(_selected.filename);
  }
  if (!content) {
    setStatus('Не удалось загрузить содержимое шаблона.', true);
    return;
  }

  _editOriginalFilename = _selected.filename;

  try {
    const inpName = el(IDS.editFilename);
    const inpTitle = el(IDS.editTitle);
    const inpDesc = el(IDS.editDesc);

    if (inpName) inpName.value = _selected.filename || '';
    if (inpTitle) inpTitle.value = _selected.title || '';
    if (inpDesc) inpDesc.value = _selected.description || '';
  } catch (e) {}

  // Edit body without meta header
  setEditEditorText(stripTemplateHeader(content));

  openEditModal();
  try {
    const savedView = loadEditViewState(_editOriginalFilename, _editKind);
    if (savedView) restoreEditViewState(savedView);
  } catch (e) {}
  try { bindEditViewStateTracking(); } catch (e2) {}

  try {
    const inp = el(IDS.editFilename);
    if (inp) inp.focus();
  } catch (e2) {}
}

async function submitEditTemplate() {
  const filename = String((el(IDS.editFilename) && el(IDS.editFilename).value) || '').trim();
  const title = String((el(IDS.editTitle) && el(IDS.editTitle).value) || '').trim();
  const description = String((el(IDS.editDesc) && el(IDS.editDesc).value) || '').trim();
  const content = getEditEditorText();

  if (!filename) {
    setEditStatus('Укажи имя файла (например: my_template.jsonc).', true);
    return false;
  }
  if (!content.trim()) {
    setEditStatus('Шаблон пустой — нечего сохранять.', true);
    return false;
  }

  const original = String(_editOriginalFilename || '').trim();
  const isRename = !!(original && filename !== original);

  setEditStatus('Сохраняю изменения...', false);

  // For rename: "бережный" — сначала без overwrite, и только при конфликте спрашиваем.
  let overwrite = !isRename;

  let { res, data, error } = await saveTemplateRequest({
    filename,
    title,
    description,
    content,
    overwrite,
  });

  if (error || !res) {
    setEditStatus('Ошибка сети при сохранении.', true);
    return false;
  }

  if (res.status === 409 && isRename) {
    let ok = false;
    try {
      ok = await (XK.ui && typeof XK.ui.confirm === 'function'
        ? XK.ui.confirm({
            title: 'Файл уже существует',
            message: 'Шаблон с таким именем уже есть. Перезаписать его?',
            okText: 'Перезаписать',
            cancelText: 'Отмена',
            danger: true,
          })
        : Promise.resolve(window.confirm('Шаблон уже существует. Перезаписать?')));
    } catch (e) {
      ok = window.confirm('Шаблон уже существует. Перезаписать?');
    }
    if (!ok) {
      setEditStatus('Сохранение отменено.', false);
      return false;
    }

    ({ res, data } = await saveTemplateRequest({
      filename,
      title,
      description,
      content,
      overwrite: true,
    }));
  }

  if (!res || !res.ok || !data || !data.ok) {
    const msg = (data && data.error) ? data.error : (res ? (res.statusText || ('HTTP ' + res.status)) : 'network error');
    setEditStatus('Не удалось сохранить: ' + msg, true);
    return false;
  }

  // If renamed — delete old file (best-effort)
  if (isRename && original) {
    try {
      await fetch('/api/routing/templates/' + encodeURIComponent(original), { method: 'DELETE' });
    } catch (e) {}
  }

  try {
    if (typeof window.toast === 'function') {
      window.toast('Шаблон обновлён: ' + (data.filename || filename), false);
    }
  } catch (e) {}

  closeEditModal();

  // Refresh list and re-select edited template
  try {
    await fetchList();
    const savedName = String(data.filename || filename).trim();
    const found = (_templates || []).find((t) => t && t.filename === savedName);
    if (found) {
      await selectTemplate(found);
    }
  } catch (e) {}

  return true;
}

  function setCount(n) {
    const c = el(IDS.count);
    if (!c) return;
    const num = Number(n || 0);
    c.textContent = String(Math.max(0, Math.floor(num)));
  }

  function clearPreview() {
    try { if (_selected && _selected.filename) savePreviewViewState({ filename: _selected.filename }); } catch (e) {}
    try { clearPreviewViewStateTracking(); } catch (e2) {}
    _selected = null;
    _selectedContent = '';

    const t = el(IDS.title);
    const d = el(IDS.desc);
    const b = el(IDS.btnImport);
    const del = el(IDS.btnDelete);
    const edit = el(IDS.btnEdit);

    if (t) t.textContent = '—';
    if (d) d.textContent = 'Выбери шаблон слева, чтобы увидеть описание и превью.';
    setPreviewText('// превью появится здесь');
    if (b) b.disabled = true;
    if (del) del.disabled = true;
    if (edit) edit.disabled = true;
  }

  function normalizePreview(text) {
    // Avoid rendering massive templates in preview; still import full content.
    if (typeof text !== 'string') return '';
    const max = 20000; // chars
    if (text.length <= max) return text;
    return text.slice(0, max) + '\n\n// ... (превью обрезано)';
  }

  function renderList() {
    const list = el(IDS.list);
    if (!list) return;

    list.innerHTML = '';

    if (!_templates || !_templates.length) {
      const empty = document.createElement('div');
      empty.className = 'routing-template-empty';
      empty.innerHTML = `
        <div class="routing-template-empty-title">Шаблоны не найдены</div>
        <div class="routing-template-empty-sub">
          Добавь <b>*.jsonc</b> в <code>/opt/etc/xray/templates/routing</code>
        </div>
      `;
      list.appendChild(empty);
      return;
    }

    _templates.forEach((tpl) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'routing-template-item';
      btn.dataset.filename = tpl.filename || '';

      const title = document.createElement('div');
      title.className = 'routing-template-item-title';
      title.textContent = tpl.title || tpl.filename || 'Шаблон';

      const desc = document.createElement('div');
      desc.className = 'routing-template-item-desc';
      desc.textContent = tpl.description || '';

      btn.appendChild(title);
      if (tpl.description) btn.appendChild(desc);

      btn.addEventListener('click', () => {
        selectTemplate(tpl);
      });

      list.appendChild(btn);
    });

    // Keep selection highlight if modal was reopened
    if (_selected && _selected.filename) {
      try {
        list.querySelectorAll('.routing-template-item').forEach((b) => {
          b.classList.toggle('active', b.dataset.filename === _selected.filename);
        });
      } catch (e) {}
    }
  }

  async function fetchList() {
    setStatus('Загрузка списка шаблонов...', false);
    clearPreview();

    try {
      const res = await fetch('/api/routing/templates', { method: 'GET' });
      const data = await res.json().catch(() => null);

      if (!res.ok || !data || !data.ok) {
        const msg = (data && data.error) ? data.error : (res.statusText || ('HTTP ' + res.status));
        setStatus('Ошибка: ' + msg, true);
        _templates = [];
        setCount(0);
        renderList();
        return;
      }

      // API compatibility:
      // - Current backend returns { ok:true, items:[...] }
      // - Older versions used { ok:true, templates:[...] }
      if (Array.isArray(data.items)) {
        _templates = data.items;
      } else {
        _templates = Array.isArray(data.templates) ? data.templates : [];
      }
      setCount(_templates.length);
      renderList();
      setStatus('Выбери шаблон слева и нажми «Импортировать».', false);
    } catch (e) {
      console.error(e);
      setStatus('Ошибка загрузки шаблонов (см. консоль браузера).', true);
      _templates = [];
      setCount(0);
      renderList();
    }
  }

  async function fetchTemplateContent(filename) {
    if (!filename) return '';
    try {
      const res = await fetch('/api/routing/templates/' + encodeURIComponent(filename), { method: 'GET' });
      if (!res.ok) {
        return '';
      }
      return await res.text();
    } catch (e) {
      console.error(e);
      return '';
    }
  }

  async function selectTemplate(tpl) {
    if (!tpl || !tpl.filename) return;
    const prevFilename = _selected && _selected.filename ? String(_selected.filename) : '';
    try { if (prevFilename && prevFilename !== tpl.filename) savePreviewViewState({ filename: prevFilename }); } catch (e) {}
    _selected = tpl;
    _selectedContent = '';


    // highlight
    const list = el(IDS.list);
    if (list) {
      try {
        list.querySelectorAll('.routing-template-item').forEach((b) => {
          b.classList.toggle('active', b.dataset.filename === tpl.filename);
        });
      } catch (e) {}
    }

    const t = el(IDS.title);
    const d = el(IDS.desc);
    const edit = el(IDS.btnEdit);
    const b = el(IDS.btnImport);
    const del = el(IDS.btnDelete);

    if (t) t.textContent = tpl.title || tpl.filename;
    if (d) d.textContent = tpl.description || '';
    setPreviewText('// загрузка...');
    if (b) b.disabled = true;
    if (del) del.disabled = !!tpl.builtin;
    if (edit) edit.disabled = !!tpl.builtin;

    setStatus('Загрузка шаблона: ' + tpl.filename + ' ...', false);

    const content = await fetchTemplateContent(tpl.filename);
    if (!content) {
      setPreviewText('// не удалось загрузить шаблон');
      setStatus('Не удалось загрузить содержимое шаблона.', true);
      return;
    }

    _selectedContent = content;
    setPreviewText(normalizePreview(content));
    try {
      const savedView = loadPreviewViewState(tpl.filename, _previewKind);
      if (!(savedView && restorePreviewViewState(savedView))) {
        const fac = previewActiveFacade();
        if (fac && typeof fac.scrollTo === 'function') fac.scrollTo(0, 0);
      }
    } catch (e2) {}
    try { bindPreviewViewStateTracking(); } catch (e3) {}
    if (b) b.disabled = false;
    if (del) del.disabled = !!tpl.builtin;
    if (edit) edit.disabled = !!tpl.builtin;

    setStatus('Шаблон готов к импорту.', false);
  }

  async function confirmReplaceIfDirty() {
    const shell = getRoutingShellApi();
    const cm = getRoutingEditor();
    const ta = el('routing-editor') || el('routing-textarea');

    let current = '';
    if (cm && typeof cm.get === 'function') current = cm.get();
    else if (cm && typeof cm.getValue === 'function') current = cm.getValue();
    else if (ta) current = ta.value || '';

    let isDirty = false;
    if (shell && typeof shell.hasUnsavedChanges === 'function') {
      try {
        isDirty = !!shell.hasUnsavedChanges(current);
      } catch (e) {}
    } else {
      isDirty = current.trim().length > 0;
    }

    if (!isDirty) return true;

    // Use themed confirm modal if available
    try {
      if (XK.ui && typeof XK.ui.confirm === 'function') {
        const ok = await XK.ui.confirm({
          title: 'Заменить текущий текст?',
          message: 'В редакторе есть несохранённые изменения. Импорт шаблона заменит текущий текст. Продолжить?',
          okText: 'Да, заменить',
          cancelText: 'Отмена',
          danger: true,
        });
        return !!ok;
      }
    } catch (e) {}

    return window.confirm('В редакторе есть несохранённые изменения. Импорт шаблона заменит текст. Продолжить?');
  }

  function markDirty() {
    const shell = getRoutingShellApi();
    if (shell && typeof shell.setDirty === 'function') {
      try { shell.setDirty(true); } catch (e) {}
    }
    try {
      const saveBtn = document.getElementById('routing-save-btn');
      if (saveBtn) saveBtn.classList.add('dirty');
    } catch (e) {}
  }

  function getEditorText() {
    const shell = getRoutingShellApi();
    if (shell && typeof shell.getEditorText === 'function') {
      try {
        return String(shell.getEditorText() || '');
      } catch (e) {}
    }
    const cm = getRoutingEditor();
    const ta = el('routing-editor') || el('routing-textarea');
    if (cm && typeof cm.get === 'function') return String(cm.get() || '');
    if (cm && typeof cm.getValue === 'function') return String(cm.getValue() || '');
    if (ta) return String(ta.value || '');
    return '';
  }

  async function doImport() {
    if (!_selected || !_selected.filename || !_selectedContent) {
      setStatus('Сначала выбери шаблон.', true);
      return;
    }

    const ok = await confirmReplaceIfDirty();
    if (!ok) return;

    let replaced = false;
    try {
      const shell = getRoutingShellApi();
      if (shell && typeof shell.replaceEditorText === 'function') {
        shell.replaceEditorText(_selectedContent, {
          reason: 'template-import',
          markDirty: true,
          scrollTop: true,
        });
        replaced = true;
      } else if (XK.routing && typeof XK.routing.replaceEditorText === 'function') {
        XK.routing.replaceEditorText(_selectedContent, {
          reason: 'template-import',
          markDirty: true,
          scrollTop: true,
        });
        replaced = true;
      }
    } catch (e) {}

    if (!replaced) {
      const cm = getRoutingEditor();
      const ta = el('routing-editor') || el('routing-textarea');

      if (cm && typeof cm.set === 'function') {
        cm.set(_selectedContent);
        try { if (cm.scrollTo) cm.scrollTo(0, 0); } catch (e) {}
      } else if (cm && typeof cm.setValue === 'function') {
        cm.setValue(_selectedContent);
        try { cm.scrollTo(0, 0); } catch (e) {}
      } else if (ta) {
        ta.value = _selectedContent;
      }

      markDirty();
      try {
        document.dispatchEvent(new CustomEvent('xkeen:routing-editor-content', {
          detail: { reason: 'template-import', dirty: true, file: '' }
        }));
      } catch (e) {}
    }

    try {
      if (typeof window.toast === 'function') {
        window.toast('Шаблон импортирован в редактор. Проверь и нажми «Сохранить».', false);
      }
    } catch (e) {}

    closeModal();
  }

  function prefillSaveModalFromSelection() {
    const inpName = el(IDS.saveFilename);
    const inpTitle = el(IDS.saveTitle);
    const inpDesc = el(IDS.saveDesc);
    if (inpName) inpName.value = '';
    if (inpTitle) inpTitle.value = '';
    if (inpDesc) inpDesc.value = '';
    setSaveStatus('', false);

    // If the user selected a non-builtin template, allow quick "save/overwrite" workflow.
    if (_selected && _selected.filename && !_selected.builtin) {
      if (inpName) inpName.value = _selected.filename;
      if (inpTitle) inpTitle.value = _selected.title || '';
      if (inpDesc) inpDesc.value = _selected.description || '';
    }
  }

  async function saveTemplateRequest(payload) {
    try {
      const res = await fetch('/api/routing/templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => null);
      return { res, data };
    } catch (e) {
      console.error(e);
      return { res: null, data: null, error: e };
    }
  }

  async function submitSaveTemplate() {
    const filename = String((el(IDS.saveFilename) && el(IDS.saveFilename).value) || '').trim();
    const title = String((el(IDS.saveTitle) && el(IDS.saveTitle).value) || '').trim();
    const description = String((el(IDS.saveDesc) && el(IDS.saveDesc).value) || '').trim();

    if (!filename) {
      setSaveStatus('Укажи имя файла (например: my_template.jsonc).', true);
      return false;
    }

    const content = getEditorText();
    if (!content.trim()) {
      setSaveStatus('Редактор пустой — нечего сохранять в шаблон.', true);
      return false;
    }

    setSaveStatus('Сохраняю шаблон...', false);

    let { res, data, error } = await saveTemplateRequest({
      filename,
      title,
      description,
      content,
      overwrite: false,
    });

    if (error || !res) {
      setSaveStatus('Ошибка сети при сохранении шаблона.', true);
      return false;
    }

    // If already exists: ask overwrite
    if (res.status === 409) {
      let ok = false;
      try {
        ok = await (XK.ui && typeof XK.ui.confirm === 'function'
          ? XK.ui.confirm({
              title: 'Шаблон уже существует',
              message: 'Файл с таким именем уже есть. Перезаписать его?',
              okText: 'Перезаписать',
              cancelText: 'Отмена',
              danger: true,
            })
          : Promise.resolve(window.confirm('Шаблон уже существует. Перезаписать?')));
      } catch (e) {
        ok = window.confirm('Шаблон уже существует. Перезаписать?');
      }
      if (!ok) {
        setSaveStatus('Сохранение отменено.', false);
        return false;
      }

      ({ res, data } = await saveTemplateRequest({
        filename,
        title,
        description,
        content,
        overwrite: true,
      }));
    }

    if (!res || !res.ok || !data || !data.ok) {
      const msg = (data && data.error) ? data.error : (res ? (res.statusText || ('HTTP ' + res.status)) : 'network error');
      setSaveStatus('Не удалось сохранить: ' + msg, true);
      return false;
    }

    // Success
    try {
      if (typeof window.toast === 'function') {
        window.toast('Шаблон сохранён: ' + (data.filename || filename), false);
      }
    } catch (e) {}

    closeSaveModal();

    // Refresh list and re-select saved template if possible
    try {
      await fetchList();
      const savedName = String(data.filename || filename).trim();
      const found = (_templates || []).find((t) => t && t.filename === savedName);
      if (found) {
        await selectTemplate(found);
      }
    } catch (e) {}

    return true;
  }

  async function doDeleteSelected() {
    if (!_selected || !_selected.filename) {
      setStatus('Сначала выбери шаблон.', true);
      return;
    }
    if (_selected.builtin) {
      setStatus('Этот шаблон встроенный — удаление отключено.', true);
      return;
    }

    let ok = false;
    try {
      ok = await (XK.ui && typeof XK.ui.confirm === 'function'
        ? XK.ui.confirm({
            title: 'Удалить шаблон?',
            message: 'Удалить файл ' + _selected.filename + ' из /opt/etc/xray/templates/routing?',
            okText: 'Удалить',
            cancelText: 'Отмена',
            danger: true,
          })
        : Promise.resolve(window.confirm('Удалить шаблон ' + _selected.filename + '?')));
    } catch (e) {
      ok = window.confirm('Удалить шаблон ' + _selected.filename + '?');
    }
    if (!ok) return;

    setStatus('Удаляю шаблон ' + _selected.filename + ' ...', false);
    try {
      const res = await fetch('/api/routing/templates/' + encodeURIComponent(_selected.filename), {
        method: 'DELETE',
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || !data.ok) {
        const msg = (data && data.error) ? data.error : (res.statusText || ('HTTP ' + res.status));
        setStatus('Не удалось удалить: ' + msg, true);
        return;
      }

      try {
        if (typeof window.toast === 'function') {
          window.toast('Удалено: ' + _selected.filename, false);
        }
      } catch (e) {}

      clearPreview();
      await fetchList();
      setStatus('Шаблон удалён.', false);
    } catch (e) {
      console.error(e);
      setStatus('Ошибка сети при удалении шаблона.', true);
    }
  }

  function wireUI() {
    const openBtn = el(IDS.btnOpen);
    if (openBtn && !(openBtn.dataset && openBtn.dataset.xkWired === '1')) {
      openBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        openModal();
        await fetchList();
      });
      if (openBtn.dataset) openBtn.dataset.xkWired = '1';
    }

    // Engine toggles (global setting)
    const previewSel = el(IDS.previewEngineSelect);
    if (previewSel && !(previewSel.dataset && previewSel.dataset.xkWired === '1')) {
      previewSel.addEventListener('change', async (e) => {
        try {
          const ee = getEngineHelper();
          if (ee && typeof ee.set === 'function') {
            await ee.set(previewSel.value);
          }
        } catch (e2) {}
        try { scheduleEngineSync(); } catch (e3) {}
      });
      if (previewSel.dataset) previewSel.dataset.xkWired = '1';
    }

    const editSel = el(IDS.editEngineSelect);
    if (editSel && !(editSel.dataset && editSel.dataset.xkWired === '1')) {
      editSel.addEventListener('change', async (e) => {
        try {
          const ee = getEngineHelper();
          if (ee && typeof ee.set === 'function') {
            await ee.set(editSel.value);
          }
        } catch (e2) {}
        try { scheduleEngineSync(); } catch (e3) {}
      });
      if (editSel.dataset) editSel.dataset.xkWired = '1';
    }

    // React to engine changes made elsewhere (routing editor, file manager, etc.)
    try {
      const ee = getEngineHelper();
      if (ee && typeof ee.onChange === 'function' && document.body && document.body.dataset && document.body.dataset.xkRoutingTplEngineWatch !== '1') {
        ee.onChange((d) => {
          try {
            const next = normalizeEngine(d && d.engine ? d.engine : 'codemirror');
            setEngineSelects(next);
            // If modals are open, re-activate editors to match the new engine.
            if (modalOpen(IDS.modal) || modalOpen(IDS.editModal)) {
              scheduleEngineSync();
            }
          } catch (e4) {}
        });
        document.body.dataset.xkRoutingTplEngineWatch = '1';
      }
    } catch (e) {}

    const btnRefresh = el(IDS.btnRefresh);
    if (btnRefresh && !(btnRefresh.dataset && btnRefresh.dataset.xkWired === '1')) {
      btnRefresh.addEventListener('click', async (e) => {
        e.preventDefault();
        await fetchList();
      });
      if (btnRefresh.dataset) btnRefresh.dataset.xkWired = '1';
    }

    const btnImport = el(IDS.btnImport);
    if (btnImport && !(btnImport.dataset && btnImport.dataset.xkWired === '1')) {
      btnImport.addEventListener('click', async (e) => {
        e.preventDefault();
        await doImport();
      });
      if (btnImport.dataset) btnImport.dataset.xkWired = '1';
    }

    // Save as user template (open modal)
    const btnSave = el(IDS.btnSave);
    if (btnSave && !(btnSave.dataset && btnSave.dataset.xkWired === '1')) {
      btnSave.addEventListener('click', (e) => {
        e.preventDefault();
        prefillSaveModalFromSelection();
        openSaveModal();
        try {
          const inp = el(IDS.saveFilename);
          if (inp) inp.focus();
        } catch (e2) {}
      });
      if (btnSave.dataset) btnSave.dataset.xkWired = '1';
    }


// Edit selected user template
const btnEdit = el(IDS.btnEdit);
if (btnEdit && !(btnEdit.dataset && btnEdit.dataset.xkWired === '1')) {
  btnEdit.addEventListener('click', async (e) => {
    e.preventDefault();
    await openEditForSelected();
  });
  if (btnEdit.dataset) btnEdit.dataset.xkWired = '1';
}

// Delete selected user template
    const btnDelete = el(IDS.btnDelete);
    if (btnDelete && !(btnDelete.dataset && btnDelete.dataset.xkWired === '1')) {
      btnDelete.addEventListener('click', async (e) => {
        e.preventDefault();
        await doDeleteSelected();
      });
      if (btnDelete.dataset) btnDelete.dataset.xkWired = '1';
    }


// Edit modal actions
const editCloseButtons = [el(IDS.editCloseX), el(IDS.editCancel)];
editCloseButtons.forEach((b) => {
  if (!b) return;
  if (b.dataset && b.dataset.xkWired === '1') return;
  b.addEventListener('click', (e) => {
    e.preventDefault();
    closeEditModal();
  });
  if (b.dataset) b.dataset.xkWired = '1';
});

const editConfirm = el(IDS.editConfirm);
if (editConfirm && !(editConfirm.dataset && editConfirm.dataset.xkWired === '1')) {
  editConfirm.addEventListener('click', async (e) => {
    e.preventDefault();
    const btn = editConfirm;
    try { btn.disabled = true; } catch (e2) {}
    try {
      await submitEditTemplate();
    } finally {
      try { btn.disabled = false; } catch (e3) {}
    }
  });
  if (editConfirm.dataset) editConfirm.dataset.xkWired = '1';
}

// Save modal actions
    const saveCloseButtons = [el(IDS.saveCloseX), el(IDS.saveCancel)];
    saveCloseButtons.forEach((b) => {
      if (!b) return;
      if (b.dataset && b.dataset.xkWired === '1') return;
      b.addEventListener('click', (e) => {
        e.preventDefault();
        closeSaveModal();
      });
      if (b.dataset) b.dataset.xkWired = '1';
    });

    const saveConfirm = el(IDS.saveConfirm);
    if (saveConfirm && !(saveConfirm.dataset && saveConfirm.dataset.xkWired === '1')) {
      saveConfirm.addEventListener('click', async (e) => {
        e.preventDefault();
        const btn = saveConfirm;
        try { btn.disabled = true; } catch (e2) {}
        try {
          await submitSaveTemplate();
        } finally {
          try { btn.disabled = false; } catch (e3) {}
        }
      });
      if (saveConfirm.dataset) saveConfirm.dataset.xkWired = '1';
    }

    const closeButtons = [el(IDS.btnCloseX), el(IDS.btnCancel)];
    closeButtons.forEach((b) => {
      if (!b) return;
      if (b.dataset && b.dataset.xkWired === '1') return;
      b.addEventListener('click', (e) => {
        e.preventDefault();
        closeModal();
      });
      if (b.dataset) b.dataset.xkWired = '1';
    });

    // Close on backdrop click
    const modal = el(IDS.modal);
    if (modal && !(modal.dataset && modal.dataset.xkBackdrop === '1')) {
      modal.addEventListener('mousedown', (e) => {
        if (e.target === modal) closeModal();
      });
      if (modal.dataset) modal.dataset.xkBackdrop = '1';
    }


const editModal = el(IDS.editModal);
if (editModal && !(editModal.dataset && editModal.dataset.xkBackdrop === '1')) {
  editModal.addEventListener('mousedown', (e) => {
    if (e.target === editModal) closeEditModal();
  });
  if (editModal.dataset) editModal.dataset.xkBackdrop = '1';
}

const saveModal = el(IDS.saveModal);
    if (saveModal && !(saveModal.dataset && saveModal.dataset.xkBackdrop === '1')) {
      saveModal.addEventListener('mousedown', (e) => {
        if (e.target === saveModal) closeSaveModal();
      });
      if (saveModal.dataset) saveModal.dataset.xkBackdrop = '1';
    }

    // ESC to close
    if (!(document.body && document.body.dataset && document.body.dataset.xkRoutingTplEsc === '1')) {
      document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        const em = el(IDS.editModal);
        if (em && !em.classList.contains('hidden')) {
          closeEditModal();
          return;
        }
        const sm = el(IDS.saveModal);
        if (sm && !sm.classList.contains('hidden')) {
          closeSaveModal();
          return;
        }
        const m = el(IDS.modal);
        if (!m || m.classList.contains('hidden')) return;
        closeModal();
      });
      if (document.body && document.body.dataset) document.body.dataset.xkRoutingTplEsc = '1';
    }
  }

  function init() {
    if (_inited) return;
    _inited = true;

    wireUI();
  }

  XK.features.routingTemplates = {
    init,
    fetchList,
    open: () => {
      openModal();
      fetchList();
    },
    close: closeModal,
  };
})();

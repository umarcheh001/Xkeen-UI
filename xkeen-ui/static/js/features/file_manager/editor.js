import { getFileManagerNamespace } from '../file_manager_namespace.js';
import {
  attachXkeenEditorToolbar,
  getXkeenEditorToolbarDefaultItems,
  getXkeenEditorToolbarIcons,
} from '../xkeen_runtime.js';

(() => {
  'use strict';

  window.XKeen = window.XKeen || {};
  const XKeen = window.XKeen;
  const FM = getFileManagerNamespace();
  const C = FM.common || {};

  // Local helpers (keep module independent from file_manager.js impl details)
  function el(id) {
    try { if (C && typeof C.el === 'function') return C.el(id); } catch (e) {}
    try { return document.getElementById(id); } catch (e2) { return null; }
  }

  function modalOpen(modal) {
    try { if (C && typeof C.modalOpen === 'function') return C.modalOpen(modal); } catch (e) {}
    if (!modal) return;
    try { modal.classList.remove('hidden'); } catch (e2) {}
    try { document.body.classList.add('modal-open'); } catch (e3) {}
  }

  function modalClose(modal) {
    try { if (C && typeof C.modalClose === 'function') return C.modalClose(modal); } catch (e) {}
    if (!modal) return;
    try { modal.classList.add('hidden'); } catch (e2) {}
    try { document.body.classList.remove('modal-open'); } catch (e3) {}
  }

  function toast(msg, level) {
    try { if (C && typeof C.toast === 'function') return C.toast(msg, level); } catch (e) {}
    return undefined;
  }

  function api() {
    return (FM && FM.api) ? FM.api : {};
  }

  // -------------------------- text file viewer/editor (CodeMirror / Monaco modal) --------------------------
  const STATE = {
    wired: false,
    cm: null,
    monaco: null,
    monacoFacade: null,
    monacoFsWired: false,
    fsHeaderBar: null,
    fsHeaderBtn: null,
    activeKind: 'codemirror',
    activeFacade: null,
    switching: false,
    ctx: null,          // { target, sid, path, name, side, truncated, readOnly }
    dirty: false,
    lastSaved: '',
    viewStateTimer: null,
    viewStateCache: { key: null, value: null },
    viewStateUnsubs: [],
    modalResizeWired: false,
  };

  const VIEW_STATE_LS_PREFIX = 'xkeen.fm.editor.viewstate.v1::';
  const VIEW_STATE_SAVE_MS = 160;
  let _viewStateStore = null;

  function els() {
    const modal = el('fm-editor-modal');
    if (!modal) return null;
    return {
      modal,
      title: el('fm-editor-title'),
      subtitle: el('fm-editor-subtitle'),
      engineSelect: el('fm-editor-engine-select'),
      monacoHost: el('fm-editor-monaco'),
      textarea: el('fm-editor-textarea'),
      saveBtn: el('fm-editor-save-btn'),
      cancelBtn: el('fm-editor-cancel-btn'),
      closeBtn: el('fm-editor-close-btn'),
      downloadBtn: el('fm-editor-download-btn'),
      warn: el('fm-editor-warning'),
      err: el('fm-editor-error'),
    };
  }

  function sampleText(text, maxLen = 4000) {
    const s = String(text == null ? '' : text);
    if (!s) return '';
    return s.length > maxLen ? s.slice(0, maxLen) : s;
  }

  function looksLikeJson(text) {
    const s = sampleText(text, 5000).trimStart();
    if (!s) return false;
    const c = s[0];
    if (c !== '{' && c !== '[') return false;
    if (/\b(server|location|upstream)\b\s*\{/i.test(s.slice(0, 2000))) return false;
    return true;
  }

  // JSONC (JSON with comments) note:
  // CodeMirror's built-in JSON linter (jsonlint) is strict JSON and
  // will throw on comment tokens (//, /* */). For *.jsonc we therefore
  // disable lint to avoid false red errors in the editor modal.
  function hasJsonComments(text) {
    const t = String(text || '');
    // Rough detection: ignore URLs by requiring comment token not preceded by ':'
    return /(^|[^:])\/\/|\/\*/.test(t);
  }

  function looksLikeYaml(text) {
    const s = sampleText(text, 3000);
    if (!s) return false;
    if (/^\s*---\s*(\r?\n|$)/.test(s)) return true;
    return /^\s*[A-Za-z0-9_\-\."']+\s*:\s*[^\n]*$/m.test(s.slice(0, 1200));
  }

  function looksLikeShell(text) {
    const s = sampleText(text, 3000);
    if (!s) return false;
    if (/^\s*#!.*\b(sh|bash|ash|zsh)\b/i.test(s)) return true;
    return /^\s*(export\s+\w+|set\s+-[a-zA-Z]+|\w+=.+|\$(\{|\w))/m.test(s.slice(0, 1200));
  }

  function looksLikeXml(text) {
    const s = sampleText(text, 4000).trimStart();
    if (!s) return false;
    if (s.startsWith('<?xml')) return true;
    return /^<\w[\w\-:.]*[\s>]/.test(s);
  }

  function looksLikeNginx(text) {
    const s = sampleText(text, 6000);
    if (!s) return false;
    if (!/[{}]/.test(s)) return false;
    return /\b(http|events|server|location|upstream|map)\b\s*\{/i.test(s) ||
           /\b(listen|server_name|proxy_pass|root|include)\b/i.test(s);
  }

  function guessMode(name, text) {
    const n = String(name || '').toLowerCase();
    const ext = n.includes('.') ? n.split('.').pop() : '';

    if (ext === 'json') return { name: 'javascript', json: true };
    if (ext === 'jsonc') return { name: 'jsonc', json: true, jsonc: true };
    if (ext === 'js' || ext === 'ts') return 'javascript';
    if (ext === 'yaml' || ext === 'yml') return 'yaml';
    if (ext === 'sh' || ext === 'bash') return 'shell';
    if (ext === 'toml') return 'toml';
    if (ext === 'ini' || ext === 'cfg') return 'properties';
    if (ext === 'xml') return 'xml';
    if (ext === 'nginx') return 'nginx';

    if (ext === 'conf') {
      if (looksLikeNginx(text)) return 'nginx';
      return 'properties';
    }

    if (ext === 'log' || ext === 'txt' || ext === '') {
      if (looksLikeJson(text)) return { name: 'javascript', json: true };
      if (looksLikeYaml(text)) return 'yaml';
      if (looksLikeShell(text)) return 'shell';
      if (looksLikeXml(text)) return 'xml';
      if (looksLikeNginx(text)) return 'nginx';
      return 'text/plain';
    }

    if (ext === 'py') return 'python';
    if (ext === 'css') return 'css';
    if (ext === 'html' || ext === 'htm') return 'htmlmixed';
    if (ext === 'md' || ext === 'markdown') return 'markdown';

    return 'text/plain';
  }

  function currentTheme() {
    try {
      const t = document.documentElement.getAttribute('data-theme');
      return (t === 'light') ? 'default' : 'material-darker';
    } catch (e) {
      return 'material-darker';
    }
  }

  function isCm6Editor(cm) {
    try { return !!(cm && cm.__xkeenCm6Bridge); } catch (e) {}
    return false;
  }

  function normalizedCodeMirrorMode(mode) {
    if (mode && typeof mode === 'object') {
      if (mode.jsonc) return 'jsonc';
      if (mode.json) return 'application/json';
      if (mode.name) return normalizedCodeMirrorMode(mode.name);
    }
    const raw = String(mode || '').toLowerCase();
    if (!raw) return 'text/plain';
    if (raw === 'yaml' || raw === 'yml') return 'text/yaml';
    if (raw === 'javascript' || raw === 'js' || raw === 'application/javascript') return 'application/javascript';
    if (raw === 'application/json' || raw === 'json') return 'application/json';
    if (raw === 'jsonc') return 'jsonc';
    return 'text/plain';
  }

  function validationModeForFile(name, text) {
    const mode = guessMode(name, text);
    if (mode && typeof mode === 'object') {
      if (mode.jsonc) return 'jsonc';
      if (mode.json) return 'application/json';
      return '';
    }
    return '';
  }

  function getCodeMirrorValidationRuntime() {
    const runtime = getEditorRuntime('codemirror');
    if (runtime && typeof runtime.validateText === 'function') return runtime;
    return null;
  }

  function refreshEditorValidation(ui, opts = {}) {
    const cm = STATE.cm;
    const runtime = getCodeMirrorValidationRuntime();
    const ctx = opts.ctx || STATE.ctx;
    const text = String(typeof opts.text === 'string' ? opts.text : activeText(ui));
    const mode = validationModeForFile(ctx && ctx.name, text);

    if (!cm || STATE.activeKind !== 'codemirror') return { ok: true, diagnostics: [], summary: '' };

    if (mode && runtime && typeof runtime.applyValidation === 'function' && typeof cm.setDiagnostics === 'function') {
      const result = runtime.applyValidation(cm, {
        text,
        mode,
        allowComments: mode === 'jsonc',
      }) || { ok: true, diagnostics: [], summary: '' };
      setInfo({ err: result.ok ? '' : (result.summary || 'JSON содержит ошибку.') });
      return result;
    }

    if (typeof cm.clearDiagnostics === 'function') {
      try { cm.clearDiagnostics(); } catch (e) {}
    }

    if (mode && !isCm6Editor(cm)) {
      try { cm.setOption('lint', mode === 'application/json' && !hasJsonComments(text)); } catch (e) {}
    }

    setInfo({ err: '' });
    return { ok: true, diagnostics: [], summary: '' };
  }

  // -------------------------- engine helpers --------------------------
  function getEditorEngineHelper() {
    try { if (C && typeof C.getEditorEngine === 'function') return C.getEditorEngine(); } catch (e) {}
    return null;
  }

  function normalizeEngine(v) {
    const s = String(v || '').toLowerCase();
    return (s === 'monaco' || s === 'codemirror') ? s : 'codemirror';
  }

  const CM6_SCOPE = 'file-manager';

  function withCm6Scope(opts) {
    return Object.assign({ cm6Scope: CM6_SCOPE }, opts || {});
  }

  function getEditorRuntime(engine, opts) {
    const helper = getEditorEngineHelper();
    if (!helper || typeof helper.getRuntime !== 'function') return null;
    try { return helper.getRuntime(engine, withCm6Scope(opts)); } catch (e) {}
    return null;
  }

  async function ensureEditorRuntime(engine, opts) {
    const helper = getEditorEngineHelper();
    if (!helper) return null;
    try {
      if (typeof helper.ensureRuntime === 'function') return await helper.ensureRuntime(engine, withCm6Scope(opts));
      if (typeof helper.getRuntime === 'function') return helper.getRuntime(engine, withCm6Scope(opts));
    } catch (e) {}
    return null;
  }

  function setEngineSelectValue(engine) {
    const ui = els();
    if (!ui || !ui.engineSelect) return;
    try { ui.engineSelect.value = normalizeEngine(engine); } catch (e) {}
  }

  function cloneViewState(value) {
    const helper = getEditorEngineHelper();
    if (helper && typeof helper.cloneViewState === 'function') {
      try { return helper.cloneViewState(value); } catch (e) {}
    }
    try {
      if (value == null) return null;
      return JSON.parse(JSON.stringify(value));
    } catch (e) {}
    return value || null;
  }

  function getViewStateStore() {
    if (_viewStateStore) return _viewStateStore;
    const helper = getEditorEngineHelper();
    if (!helper || typeof helper.createViewStateStore !== 'function') return null;
    try {
      _viewStateStore = helper.createViewStateStore({
        buildKey: (ctx) => viewStateKey(ctx),
      });
    } catch (e) {
      _viewStateStore = null;
    }
    return _viewStateStore;
  }

  function viewStateKey(ctx) {
    try {
      if (!ctx) return '';
      const target = String(ctx.target || 'local').trim() || 'local';
      const sid = target === 'remote' ? String(ctx.sid || '').trim() : '';
      const path = String(ctx.path || '').trim();
      if (!path) return '';
      return VIEW_STATE_LS_PREFIX + [target, sid, path].map((part) => encodeURIComponent(String(part || ''))).join('::');
    } catch (e) {}
    return '';
  }

  function viewStateEngine(engine, fallback) {
    const normalized = normalizeEngine(engine);
    if (normalized) return normalized;
    return normalizeEngine(fallback) || 'codemirror';
  }

  function emptyViewStateBundle() {
    return {
      version: 1,
      updatedAt: 0,
      lastEngine: 'codemirror',
      last: null,
      views: {},
    };
  }

  function normalizeStoredViewBundle(raw) {
    const base = emptyViewStateBundle();
    try {
      if (raw && raw.version === 1 && raw.views && typeof raw.views === 'object') {
        base.updatedAt = Number(raw.updatedAt || 0);
        base.lastEngine = viewStateEngine(raw.lastEngine, raw.last && raw.last.kind);
        base.last = cloneViewState(raw.last);
        base.views = {
          codemirror: cloneViewState(raw.views.codemirror),
          monaco: cloneViewState(raw.views.monaco),
        };
        return base;
      }
      if (raw && typeof raw === 'object' && (raw.kind || raw.state || raw.cursor || raw.pos || typeof raw.selectionStart === 'number')) {
        const engine = viewStateEngine(raw.kind, 'codemirror');
        base.lastEngine = engine;
        base.last = cloneViewState(raw);
        base.views[engine] = cloneViewState(raw);
      }
    } catch (e) {}
    return base;
  }

  function readStoredViewBundle(key) {
    const storageKey = String(key || '').trim();
    if (!storageKey) return emptyViewStateBundle();
    try {
      if (STATE.viewStateCache.key === storageKey && STATE.viewStateCache.value) {
        return normalizeStoredViewBundle(cloneViewState(STATE.viewStateCache.value));
      }
    } catch (e) {}
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return emptyViewStateBundle();
      const parsed = JSON.parse(raw);
      const normalized = normalizeStoredViewBundle(parsed);
      STATE.viewStateCache = { key: storageKey, value: cloneViewState(normalized) };
      return normalized;
    } catch (e) {}
    return emptyViewStateBundle();
  }

  function writeStoredViewBundle(key, bundle) {
    const storageKey = String(key || '').trim();
    if (!storageKey) return;
    const normalized = normalizeStoredViewBundle(bundle);
    STATE.viewStateCache = { key: storageKey, value: cloneViewState(normalized) };
    try {
      localStorage.setItem(storageKey, JSON.stringify(normalized));
    } catch (e) {}
  }

  function loadSavedViewState(ctx, engine) {
    const store = getViewStateStore();
    if (store && typeof store.load === 'function') {
      return store.load({
        ctx,
        engine,
      });
    }
    const storageKey = viewStateKey(ctx);
    if (!storageKey) return null;
    const bundle = readStoredViewBundle(storageKey);
    const target = viewStateEngine(engine, bundle.lastEngine);
    const exact = bundle && bundle.views ? bundle.views[target] : null;
    if (exact) return cloneViewState(exact);
    return cloneViewState(bundle.last);
  }

  function persistViewForContext(ctx, engine, view) {
    const store = getViewStateStore();
    if (store && typeof store.save === 'function') {
      return store.save({
        ctx,
        engine,
        view,
      });
    }
    const storageKey = viewStateKey(ctx);
    const nextView = cloneViewState(view);
    if (!storageKey || !nextView) return null;
    const bundle = readStoredViewBundle(storageKey);
    const slot = viewStateEngine(engine, nextView && nextView.kind);
    bundle.updatedAt = Date.now();
    bundle.lastEngine = slot;
    bundle.last = nextView;
    bundle.views = bundle.views || {};
    bundle.views[slot] = cloneViewState(nextView);
    writeStoredViewBundle(storageKey, bundle);
    return nextView;
  }

  function clearViewStateTimer() {
    const store = getViewStateStore();
    if (store && typeof store.clearTimer === 'function') {
      store.clearTimer();
      return;
    }
    try {
      if (STATE.viewStateTimer) clearTimeout(STATE.viewStateTimer);
    } catch (e) {}
    STATE.viewStateTimer = null;
  }

  function clearViewStateBindings() {
    const store = getViewStateStore();
    if (store && typeof store.clearBindings === 'function') {
      store.clearBindings();
      return;
    }
    const unsubs = Array.isArray(STATE.viewStateUnsubs) ? STATE.viewStateUnsubs.splice(0) : [];
    unsubs.forEach((fn) => {
      try { if (typeof fn === 'function') fn(); } catch (e) {}
    });
  }

  function scheduleViewStateSave(waitMs = VIEW_STATE_SAVE_MS) {
    const store = getViewStateStore();
    if (store && typeof store.schedule === 'function') {
      store.schedule({
        ctx: STATE.ctx,
        engine: STATE.activeKind,
        waitMs,
        capture: () => captureCurrentViewState(),
      });
      return;
    }
    clearViewStateTimer();
    if (!STATE.ctx) return;
    STATE.viewStateTimer = setTimeout(() => {
      STATE.viewStateTimer = null;
      try { saveCurrentViewState(); } catch (e) {}
    }, Math.max(0, Number(waitMs || 0)));
  }

  function monacoFacade(editor) {
    const helper = getEditorEngineHelper();
    if (!editor || !helper || typeof helper.fromMonaco !== 'function') return null;
    try {
      const facade = helper.fromMonaco(editor);
      if (facade) return facade;
    } catch (e) {}
    return null;
  }

  function cmFacade(cm) {
    const helper = getEditorEngineHelper();
    if (!cm || !helper || typeof helper.fromCodeMirror !== 'function') return null;
    try {
      const facade = helper.fromCodeMirror(cm);
      if (facade) return facade;
    } catch (e) {}
    return null;
  }

  function textareaFacade(textarea) {
    const helper = getEditorEngineHelper();
    if (!textarea || !helper || typeof helper.fromTextarea !== 'function') return null;
    try {
      const facade = helper.fromTextarea(textarea, { kind: 'codemirror' });
      if (facade) return facade;
    } catch (e) {}
    return null;
  }

  function captureCurrentViewState() {
    const store = getViewStateStore();
    if (store && typeof store.capture === 'function') {
      const saved = store.capture({
        engine: STATE.activeKind,
        facade: activeFacade(),
        capture: () => {
          const fac = activeFacade();
          if (fac && typeof fac.saveViewState === 'function') {
            return fac.saveViewState({ memoryOnly: true });
          }
          return null;
        },
      });
      if (saved) return saved;
    }
    try {
      const fac = activeFacade();
      if (fac && typeof fac.saveViewState === 'function') {
        return cloneViewState(fac.saveViewState({ memoryOnly: true }));
      }
    } catch (e) {}
    return null;
  }

  function saveCurrentViewState(opts = {}) {
    const ctx = opts.ctx || STATE.ctx;
    const engine = viewStateEngine(opts.engine, STATE.activeKind);
    const view = (typeof opts.view !== 'undefined') ? opts.view : captureCurrentViewState();
    if (!ctx || !view) return null;
    return persistViewForContext(ctx, engine, view);
  }

  function bindActiveViewStateTracking(ui) {
    const store = getViewStateStore();
    if (store && typeof store.bind === 'function') {
      const u = ui || els();
      store.bind({
        ctx: STATE.ctx,
        engine: STATE.activeKind,
        monaco: STATE.activeKind === 'monaco' ? STATE.monaco : null,
        codemirror: STATE.activeKind === 'codemirror' ? STATE.cm : null,
        textarea: u && u.textarea,
        waitMs: VIEW_STATE_SAVE_MS,
        capture: () => captureCurrentViewState(),
      });
      return;
    }
    clearViewStateBindings();

    if (STATE.activeKind === 'monaco' && STATE.monaco) {
      const ed = STATE.monaco;
      const bind = (register) => {
        try {
          const d = register();
          if (d && typeof d.dispose === 'function') {
            STATE.viewStateUnsubs.push(() => {
              try { d.dispose(); } catch (e) {}
            });
          }
        } catch (e) {}
      };
      bind(() => ed.onDidChangeModelContent(() => { scheduleViewStateSave(); }));
      bind(() => ed.onDidChangeCursorSelection(() => { scheduleViewStateSave(); }));
      bind(() => ed.onDidScrollChange(() => { scheduleViewStateSave(); }));
      if (typeof ed.onDidChangeHiddenAreas === 'function') {
        bind(() => ed.onDidChangeHiddenAreas(() => { scheduleViewStateSave(); }));
      }
      return;
    }

    if (STATE.cm) {
      const cm = STATE.cm;
      const bind = (name) => {
        if (!cm || typeof cm.on !== 'function' || typeof cm.off !== 'function') return;
        const handler = () => { scheduleViewStateSave(); };
        try {
          cm.on(name, handler);
          STATE.viewStateUnsubs.push(() => {
            try { cm.off(name, handler); } catch (e) {}
          });
        } catch (e) {}
      };
      bind('change');
      bind('cursorActivity');
      bind('scroll');
      bind('fold');
      bind('unfold');
      return;
    }

    const u = ui || els();
    const textarea = u && u.textarea;
    if (!textarea || typeof textarea.addEventListener !== 'function' || typeof textarea.removeEventListener !== 'function') return;
    ['input', 'change', 'scroll', 'select', 'keyup', 'mouseup'].forEach((name) => {
      const handler = () => { scheduleViewStateSave(); };
      try {
        textarea.addEventListener(name, handler);
        STATE.viewStateUnsubs.push(() => {
          try { textarea.removeEventListener(name, handler); } catch (e) {}
        });
      } catch (e) {}
    });
  }

  // ------------------------ fullscreen (CodeMirror + Monaco) ------------------------

  function _syncToolbarFsClass(isFs) {
    try {
      const cm = STATE.cm;
      if (cm && cm._xkeenToolbarEl) cm._xkeenToolbarEl.classList.toggle('is-fullscreen', !!isFs);
    } catch (e) {}

    // Header fullscreen button (Monaco mode) must stay visible too.
    try {
      if (STATE.fsHeaderBar) STATE.fsHeaderBar.classList.toggle('is-fullscreen', !!isFs);
    } catch (e) {}
  }

  
  function ensureHeaderFs(ui) {
    try {
      const u = ui || els();
      if (!u) return null;

      // Prefer the engine box wrapper.
      const box = (u.engineSelect && u.engineSelect.closest)
        ? u.engineSelect.closest('.xk-editor-engine')
        : el('fm-editor-engine');
      if (!box) return null;

      // Already created
      if (STATE.fsHeaderBar && STATE.fsHeaderBar.parentNode) return STATE.fsHeaderBar;
      const existing = box.querySelector && box.querySelector('.xk-monaco-fsbar');
      if (existing) {
        STATE.fsHeaderBar = existing;
        return existing;
      }

      const bar = document.createElement('div');
      bar.className = 'xkeen-cm-toolbar xk-monaco-fsbar';
      bar.style.margin = '0';
      bar.style.paddingRight = '0';
      bar.style.gap = '6px';

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'xkeen-cm-tool';
      try { btn.dataset.actionId = 'fs_any'; } catch (e) {}
      try { btn.dataset.tip = 'Фулскрин (Esc)'; } catch (e) {}
      const toolbarIcons = getXkeenEditorToolbarIcons();
      btn.innerHTML = toolbarIcons && toolbarIcons.fullscreen ? toolbarIcons.fullscreen : '⛶';
      btn.addEventListener('click', () => {
        try { toggleEditorFullscreen(STATE.cm, els()); } catch (e) {}
      });

      bar.appendChild(btn);
      box.appendChild(bar);

      STATE.fsHeaderBar = bar;
      STATE.fsHeaderBtn = btn;
      return bar;
    } catch (e) {
      return null;
    }
  }

function syncToolbarForEngine(engine) {
    try {
      const cm = STATE.cm;
      const isMonaco = (String(engine || '').toLowerCase() === 'monaco');
      const showHeaderForCm6 = !isMonaco && isCm6Editor(cm);

      let headerBar = null;
      try {
        headerBar = ensureHeaderFs(els());
        if (headerBar) headerBar.style.display = (isMonaco || showHeaderForCm6) ? '' : 'none';
      } catch (e) {}

      if (!cm || !cm._xkeenToolbarEl || !cm._xkeenToolbarEl.querySelectorAll) return;
      const bar = cm._xkeenToolbarEl;

      if (isMonaco || showHeaderForCm6) {
        bar.style.display = 'none';
        return;
      }

      bar.style.display = '';

      const btns = bar.querySelectorAll('button.xkeen-cm-tool');
      (btns || []).forEach((btn) => {
        const id = (btn.dataset && btn.dataset.actionId) ? String(btn.dataset.actionId) : '';
        btn.style.display = (id === 'fs_any') ? 'none' : '';
      });
    } catch (e) {}
  }

  function isCodeMirrorFullscreen(cm) {
    const ed = cm || STATE.cm;
    try {
      const wrapper = ed && typeof ed.getWrapperElement === 'function' ? ed.getWrapperElement() : null;
      return !!(wrapper && wrapper.classList && (wrapper.classList.contains('CodeMirror-fullscreen') || wrapper.classList.contains('is-fullscreen')));
    } catch (e) {}
    return false;
  }

  function setCodeMirrorFullscreen(on, cm) {
    const ed = cm || STATE.cm;
    if (!ed || typeof ed.getWrapperElement !== 'function') return;
    const wrapper = ed.getWrapperElement();
    if (!wrapper) return;

    const enabled = !!on;
    const st = wrapper.__xkFs || (wrapper.__xkFs = { on: false, placeholder: null, parent: null, next: null });

    if (enabled) {
      if (!st.on) {
        st.on = true;
        try {
          st.parent = wrapper.parentNode;
          st.next = wrapper.nextSibling;
          st.placeholder = document.createComment('xk-cm-fs');
          if (st.parent) st.parent.insertBefore(st.placeholder, st.next);
        } catch (e) {}
        try { document.body.appendChild(wrapper); } catch (e) {}
      }
      try { wrapper.classList.add('CodeMirror-fullscreen', 'is-fullscreen'); } catch (e) {}
      try { document.body.classList.add('xk-no-scroll'); } catch (e) {}
    } else {
      try { wrapper.classList.remove('CodeMirror-fullscreen', 'is-fullscreen'); } catch (e) {}
      try { document.body.classList.remove('xk-no-scroll'); } catch (e) {}
      if (st.on) {
        st.on = false;
        try {
          if (st.placeholder && st.placeholder.parentNode) st.placeholder.parentNode.replaceChild(wrapper, st.placeholder);
          else if (st.parent) st.parent.insertBefore(wrapper, st.next || null);
        } catch (e) {}
        st.placeholder = null;
        st.parent = null;
        st.next = null;
      }
    }

    try { _syncToolbarFsClass(enabled); } catch (e) {}
    try { ed.refresh(); } catch (e) {}
    try { setTimeout(() => { try { ed.refresh(); } catch (e2) {} }, 0); } catch (e3) {}
    try { ed.focus(); } catch (e) {}
  }

  function isMonacoFullscreen(ui) {
    try {
      const host = (ui && ui.monacoHost) ? ui.monacoHost : (els() && els().monacoHost);
      return !!(host && host.classList && host.classList.contains('is-fullscreen'));
    } catch (e) {}
    return false;
  }

  function setMonacoFullscreen(on, ui) {
    const u = ui || els();
    if (!u || !u.monacoHost) return;
    const host = u.monacoHost;
    const enabled = !!on;

    // Ensure consistent class for shared CSS.
    try { if (host.classList && !host.classList.contains('xk-monaco-editor')) host.classList.add('xk-monaco-editor'); } catch (e) {}

    // Portal to <body> while fullscreen is active to avoid "fixed inside transformed parent" issues.
    const st = host.__xkFs || (host.__xkFs = { on: false, placeholder: null, parent: null, next: null });

    if (enabled) {
      if (!st.on) {
        st.on = true;
        try {
          st.parent = host.parentNode;
          st.next = host.nextSibling;
          st.placeholder = document.createComment('xk-monaco-fs');
          if (st.parent) st.parent.insertBefore(st.placeholder, st.next);
        } catch (e) {}
        try { document.body.appendChild(host); } catch (e) {}
      }

      try { host.classList.add('is-fullscreen'); } catch (e) {}
      try { document.body.classList.add('xk-no-scroll'); } catch (e) {}
    } else {
      try { host.classList.remove('is-fullscreen'); } catch (e) {}
      try { document.body.classList.remove('xk-no-scroll'); } catch (e) {}

      if (st.on) {
        st.on = false;
        try {
          if (st.placeholder && st.placeholder.parentNode) {
            st.placeholder.parentNode.replaceChild(host, st.placeholder);
          } else if (st.parent) {
            st.parent.insertBefore(host, st.next || null);
          }
        } catch (e) {}
        st.placeholder = null;
        st.parent = null;
        st.next = null;
      }
    }

    // Keep toolbar visible above fullscreen editor.
    try { _syncToolbarFsClass(enabled); } catch (e) {}
    try { setTimeout(() => { try { _syncToolbarFsClass(enabled); } catch (e2) {} }, 0); } catch (e3) {}

    try { if (STATE.monaco && typeof STATE.monaco.layout === 'function') STATE.monaco.layout(); } catch (e) {}
    try { setTimeout(() => { try { if (STATE.monaco && typeof STATE.monaco.layout === 'function') STATE.monaco.layout(); } catch (e2) {} }, 0); } catch (e3) {}
    try { if (STATE.monaco && typeof STATE.monaco.focus === 'function') STATE.monaco.focus(); } catch (e) {}
  }

  function wireMonacoFullscreenOnce() {
    if (STATE.monacoFsWired) return;
    STATE.monacoFsWired = true;

    document.addEventListener('keydown', (e) => {
      try {
        if (!e || e.key !== 'Escape') return;

        const ui = els();
        if (!ui) return;

        // 1) Monaco fullscreen (CSS-driven)
        try {
          if (STATE.activeKind === 'monaco' && isMonacoFullscreen(ui)) {
            try { e.preventDefault(); } catch (e2) {}
            try { e.stopPropagation(); } catch (e2) {}
            try { e.stopImmediatePropagation(); } catch (e2) {}
            setMonacoFullscreen(false, ui);
            return;
          }
        } catch (e2) {}

        // 2) CodeMirror fullscreen (CSS-driven for CM6, addon-like for CM5)
        try {
          const cm = STATE.cm;
          const isFs = !!(STATE.activeKind === 'codemirror' && isCodeMirrorFullscreen(cm));
          if (isFs) {
            try { e.preventDefault(); } catch (e3) {}
            try { e.stopPropagation(); } catch (e3) {}
            try { e.stopImmediatePropagation(); } catch (e3) {}
            setCodeMirrorFullscreen(false, cm);
            return;
          }
        } catch (e3) {}
      } catch (err) {}
    }, true);
  }

  function toggleEditorFullscreen(cm, ui) {
    if (STATE.activeKind === 'monaco') {
      try { wireMonacoFullscreenOnce(); } catch (e) {}
      setMonacoFullscreen(!isMonacoFullscreen(ui || els()), ui || els());
      return;
    }

    const ed = cm || STATE.cm;
    setCodeMirrorFullscreen(!isCodeMirrorFullscreen(ed), ed);
  }

  function isEditorFullscreen(ui) {
    const u = ui || els();
    if (!u) return false;
    try { if (isMonacoFullscreen(u)) return true; } catch (e) {}
    try { if (isCodeMirrorFullscreen(STATE.cm)) return true; } catch (e) {}
    return false;
  }

  function exitFullscreenIfAny(ui) {
    const u = ui || els();
    let did = false;

    // Monaco (CSS-driven)
    try {
      if (u && isMonacoFullscreen(u)) {
        setMonacoFullscreen(false, u);
        did = true;
      }
    } catch (e) {}

    // CodeMirror (CSS-driven wrapper fullscreen)
    try {
      const cm = STATE.cm;
      if (isCodeMirrorFullscreen(cm)) {
        setCodeMirrorFullscreen(false, cm);
        did = true;
      }
    } catch (e) {}

    return did;
  }

  function activeFacade() {
    if (STATE.activeFacade) return STATE.activeFacade;
    if (STATE.activeKind === 'monaco' && STATE.monacoFacade) return STATE.monacoFacade;
    if (STATE.activeKind === 'codemirror' && STATE.cm) return cmFacade(STATE.cm);
    if (STATE.activeKind === 'codemirror') {
      const ui = els();
      if (ui && ui.textarea) return textareaFacade(ui.textarea);
    }
    return null;
  }

  function activeText(ui) {
    const fac = activeFacade();
    if (fac) return String(fac.getValue() || '');
    try {
      const u = ui || els();
      return String((u && u.textarea && u.textarea.value) || '');
    } catch (e) {
      return '';
    }
  }

  function updateDirtyUI() {
    const ctx = STATE.ctx;
    const ui = els();
    if (!ui) return;
    const ro = !!(ctx && ctx.readOnly);
    const v = activeText(ui);
    try {
      STATE.dirty = (ctx && !ro) ? (v !== STATE.lastSaved) : false;
    } catch (e) {
      STATE.dirty = false;
    }
    try { if (ui.saveBtn) ui.saveBtn.disabled = !STATE.dirty || ro; } catch (e) {}
  }

  // -------------------------- CodeMirror lazy assets (modes / JSON lint) --------------------------
  function modeName(mode) {
    try {
      if (!mode) return '';
      if (typeof mode === 'string') {
        if (mode.includes('/')) return '';
        return mode;
      }
      if (typeof mode === 'object' && mode.name) return String(mode.name || '');
    } catch (e) {}
    return '';
  }

  function jsonLintAvailable(runtime) {
    const target = runtime || getCodeMirrorValidationRuntime();
    try {
      return !!(target && typeof target.validateText === 'function');
    } catch (e) {
      return false;
    }
  }

  async function ensureCmAssets({ mode, jsonLint } = {}) {
    const mn = modeName(mode);
    const wantJsonLint = !!jsonLint;
    let ensured = null;
    let runtime = null;

    try {
      runtime = await ensureEditorRuntime('codemirror', { mode, jsonLint: wantJsonLint });
      if (runtime && typeof runtime.ensureAssets === 'function') {
        ensured = await runtime.ensureAssets({ mode, jsonLint: wantJsonLint });
      }
    } catch (e) {}

    const runtimeSupportsMode = !!(runtime && typeof runtime.supportsMode === 'function' && runtime.supportsMode(normalizedCodeMirrorMode(mode)));
    const runtimeSupportsValidation = !!(runtime && typeof runtime.validateText === 'function');

    return {
      modeOk: !mn || !!runtimeSupportsMode || !!(ensured && ensured.modeOk),
      jsonLintOk: !wantJsonLint || !!runtimeSupportsValidation || !!((ensured && ensured.jsonLintOk) || jsonLintAvailable(runtime)),
    };
  }

  function ensureCm() {
    if (STATE.cm) return STATE.cm;
    const ui = els();
    if (!ui || !ui.textarea) return null;

    const runtime = getEditorRuntime('codemirror');
    const canUseRuntime = !!(runtime && typeof runtime.create === 'function');
    if (!canUseRuntime) return null;

    const cm = runtime.create(ui.textarea, {
      lineNumbers: true,
      lineWrapping: true,
      theme: currentTheme(),
      mode: 'text/plain',
      readOnly: false,
      tabSize: 2,
      indentUnit: 2,
      indentWithTabs: false,
      showIndentGuides: true,
      styleActiveLine: true,
      matchBrackets: true,
      autoCloseBrackets: true,
      showTrailingSpace: true,
      foldGutter: true,
      gutters: ['CodeMirror-linenumbers', 'CodeMirror-foldgutter'],
      lint: false,
      highlightSelectionMatches: { showToken: /\w/, minChars: 2 },
      viewportMargin: 50,
      extraKeys: {
        'Ctrl-S': () => { save(); },
        'Cmd-S': () => { save(); },
        'Ctrl-F': 'findPersistent',
        'Cmd-F': 'findPersistent',
        'Ctrl-H': 'replace',
        'Cmd-Alt-F': 'replace',
        'Ctrl-G': 'findNext',
        'Cmd-G': 'findNext',
        'Shift-Ctrl-G': 'findPrev',
        'Shift-Cmd-G': 'findPrev',
        'Esc': () => {
          try {
            if (isCodeMirrorFullscreen(cm)) {
              setCodeMirrorFullscreen(false, cm);
              return;
            }
          } catch (e) {}
          requestClose();
        },
      },
    });

    try {
      window.__xkeenEditors = window.__xkeenEditors || [];
      window.__xkeenEditors.push(cm);
    } catch (e) {}

    try {
      const baseItems = getXkeenEditorToolbarDefaultItems();
      if (Array.isArray(baseItems) && baseItems.length) {
        const items = baseItems.map((it) => {
          if (it && it.id === 'fs') return Object.assign({}, it, { onClick: (cmRef) => toggleEditorFullscreen(cmRef, els()) });
          return it;
        });

        try {
          const toolbarIcons = getXkeenEditorToolbarIcons();
          if (toolbarIcons && toolbarIcons.fullscreen && !items.some((it) => it && it.id === 'fs_any')) {
            items.push({
              id: 'fs_any',
              svg: toolbarIcons.fullscreen,
              label: 'Фулскрин',
              fallbackHint: 'F11 / Esc',
              onClick: () => toggleEditorFullscreen(cm, els()),
            });
          }
        } catch (e) {}

        attachXkeenEditorToolbar(cm, items);
        try { syncToolbarForEngine('codemirror'); } catch (e) {}
      }
    } catch (e) {}

    try {
      if (cm && typeof cm.on === 'function') {
        cm.on('change', () => {
          try { updateDirtyUI(); } catch (e) {}
          try { refreshEditorValidation(els()); } catch (e2) {}
        });
      }
    } catch (e) {}

    STATE.cm = cm;
    return cm;
  }

  function setInfo({ subtitle, warn, err } = {}) {
    const ui = els();
    if (!ui) return;
    try { if (ui.subtitle) ui.subtitle.textContent = String(subtitle || ''); } catch (e) {}
    try {
      if (ui.warn) {
        if (warn) { ui.warn.style.display = ''; ui.warn.textContent = String(warn); }
        else { ui.warn.style.display = 'none'; ui.warn.textContent = ''; }
      }
    } catch (e) {}
    try {
      if (ui.err) {
        if (err) { ui.err.style.display = ''; ui.err.textContent = String(err); }
        else { ui.err.style.display = 'none'; ui.err.textContent = ''; }
      }
    } catch (e) {}
  }

  function kickRefresh(cm, focus = true) {
    if (!cm) return;
    const doRefresh = () => { try { cm.refresh(); } catch (e) {} };

    try { cm.scrollTo(0, 0); } catch (e) {}
    try { cm.setCursor({ line: 0, ch: 0 }); } catch (e) {}

    doRefresh();
    try { requestAnimationFrame(doRefresh); } catch (e) { setTimeout(doRefresh, 0); }
    setTimeout(doRefresh, 0);
    setTimeout(doRefresh, 50);
    setTimeout(doRefresh, 150);
    setTimeout(doRefresh, 300);

    try {
      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(doRefresh).catch(() => {});
      }
    } catch (e) {}

    if (focus) setTimeout(() => { try { cm.focus(); } catch (e) {} }, 0);
  }

  function layoutMonacoSoon(ui, focus = false) {
    const editor = STATE.monaco;
    if (!editor || typeof editor.layout !== 'function') return;

    const host = (ui && ui.monacoHost) ? ui.monacoHost : (els() && els().monacoHost);
    const doLayout = () => {
      try {
        if (host && host.classList && host.classList.contains('hidden')) return;
      } catch (e) {}
      try { editor.layout(); } catch (e2) {}
    };

    doLayout();
    try { requestAnimationFrame(doLayout); } catch (e) { setTimeout(doLayout, 0); }
    setTimeout(doLayout, 0);
    setTimeout(doLayout, 60);
    setTimeout(doLayout, 180);

    if (focus) setTimeout(() => { try { if (editor && typeof editor.focus === 'function') editor.focus(); } catch (e) {} }, 0);
  }

  function wireMonacoModalResizeOnce() {
    if (STATE.modalResizeWired) return;
    STATE.modalResizeWired = true;

    document.addEventListener('xkeen-modal-resize', (event) => {
      const modalId = String(event && event.detail && event.detail.modal || '').trim();
      if (modalId && modalId !== 'fm-editor-modal') return;
      if (!STATE.ctx || STATE.activeKind !== 'monaco') return;
      layoutMonacoSoon(els());
    });
  }

  function showCodeMirror(ui) {
    const cm = STATE.cm;
    try {
      if (cm && typeof cm.getWrapperElement === 'function') {
        const w = cm.getWrapperElement();
        if (w) w.style.display = '';
      }
    } catch (e) {}
    try {
      if (ui && ui.textarea) {
        // If CodeMirror is created, keep the original textarea hidden.
        ui.textarea.style.display = cm ? 'none' : '';
      }
    } catch (e) {}
    try { if (ui && ui.monacoHost) ui.monacoHost.classList.add('hidden'); } catch (e) {}
  }

  function hideCodeMirror(ui) {
    const cm = STATE.cm;
    try {
      if (cm && typeof cm.getWrapperElement === 'function') {
        const w = cm.getWrapperElement();
        if (w) w.style.display = 'none';
      }
    } catch (e) {}
    // If CM not created yet, hide the raw textarea (Monaco will use its own host)
    try { if (ui && ui.textarea) ui.textarea.style.display = 'none'; } catch (e) {}
  }

  function disposeMonaco(ui) {
    try {
      if (STATE.monacoFacade && typeof STATE.monacoFacade.dispose === 'function') STATE.monacoFacade.dispose();
      else if (STATE.monaco && typeof STATE.monaco.dispose === 'function') STATE.monaco.dispose();
    } catch (e) {}
    STATE.monaco = null;
    STATE.monacoFacade = null;
    if (STATE.activeKind === 'monaco') STATE.activeFacade = null;
    try {
      const host = (ui && ui.monacoHost) ? ui.monacoHost : (els() && els().monacoHost);
      if (host) host.innerHTML = '';
    } catch (e) {}
  }

  function monacoLanguage(name, text) {
    const mode = guessMode(name, text);
    try {
      if (mode && typeof mode === 'object') {
        if (mode.jsonc) return 'jsonc';
        if (mode.json) return 'json';
        if (mode.name) return monacoLanguage(mode.name, text);
      }
    } catch (e) {}

    const s = String(mode || '').toLowerCase();
    if (s === 'javascript') return 'javascript';
    if (s === 'yaml') return 'yaml';
    if (s === 'shell') return 'shell';
    if (s === 'xml') return 'xml';
    if (s === 'python') return 'python';
    if (s === 'css') return 'css';
    if (s === 'markdown') return 'markdown';
    if (s === 'htmlmixed' || s === 'html') return 'html';
    if (s === 'properties') return 'ini';
    if (s === 'toml') return 'toml';

    // Nginx / unknown modes: keep plain text.
    return 'plaintext';
  }

  function captureView() {
    const kind = STATE.activeKind;
    const saved = captureCurrentViewState();
    if (saved) return saved;
    return { kind: kind || 'codemirror' };
  }

  function restoreView(targetKind, view) {
    const store = getViewStateStore();
    if (store && typeof store.restore === 'function') {
      try {
        if (store.restore({
          engine: targetKind,
          facade: activeFacade(),
          view,
        })) {
          if (targetKind === 'codemirror' && STATE.cm) kickRefresh(STATE.cm, true);
          else {
            const fac = activeFacade();
            if (fac && typeof fac.focus === 'function') fac.focus();
          }
          return;
        }
      } catch (e) {}
    }
    try {
      const fac = activeFacade();
      if (fac && typeof fac.restoreViewState === 'function' && fac.restoreViewState(view)) {
        if (targetKind === 'codemirror' && STATE.cm) kickRefresh(STATE.cm, true);
        else if (typeof fac.focus === 'function') fac.focus();
        return;
      }

      if (targetKind === 'monaco' && STATE.monaco) {
        const ed = STATE.monaco;
        // Prefer converted CM cursor if present.
        let pos = view && view.pos ? view.pos : null;
        if (!pos && view && view.cursor) {
          pos = { lineNumber: (view.cursor.line || 0) + 1, column: (view.cursor.ch || 0) + 1 };
        }
        if (pos && typeof ed.setPosition === 'function') ed.setPosition(pos);
        if (typeof ed.setScrollTop === 'function' && typeof view.scrollTop === 'number') ed.setScrollTop(Math.max(0, view.scrollTop));
        if (typeof ed.focus === 'function') ed.focus();
        return;
      }

      if (targetKind === 'codemirror' && STATE.cm) {
        const cm = STATE.cm;
        let cur = view && view.cursor ? view.cursor : null;
        if (!cur && view && view.pos) {
          cur = { line: Math.max(0, (view.pos.lineNumber || 1) - 1), ch: Math.max(0, (view.pos.column || 1) - 1) };
        }
        if (cur && typeof cm.setCursor === 'function') cm.setCursor(cur);
        if (typeof cm.scrollTo === 'function' && typeof view.scrollTop === 'number') cm.scrollTo(null, Math.max(0, view.scrollTop));
        kickRefresh(cm, true);
      }
    } catch (e) {}
  }

  async function activateEngine(nextEngine, { ctx, text, preserveView, initialView } = {}) {
    const ui = els();
    if (!ui) return 'codemirror';

    const engine = normalizeEngine(nextEngine);
    const ro = !!(ctx && ctx.readOnly);
    const value = String(text ?? '');
    const view = initialView || (preserveView ? captureView() : null);

    clearViewStateTimer();
    clearViewStateBindings();
    if (preserveView && STATE.ctx && view) {
      try { persistViewForContext(STATE.ctx, STATE.activeKind, view); } catch (e) {}
    }

    // Keep the toggle UI in sync.
    setEngineSelectValue(engine);

    // Dispose Monaco if we're leaving it (helps avoid leaks in long sessions).
    if (engine !== 'monaco') {
      // If Monaco is fullscreen, exit it before disposing/hiding to avoid leaving body scroll locked.
      try { if (isMonacoFullscreen(ui)) setMonacoFullscreen(false, ui); } catch (e0) {}
      try { disposeMonaco(ui); } catch (e) {}
    }

    if (engine === 'monaco') {
      // If CodeMirror was in fullscreen, exit it first to avoid CSS/layout glitches.
      try { if (isCodeMirrorFullscreen(STATE.cm)) setCodeMirrorFullscreen(false, STATE.cm); } catch (e0) {}

      hideCodeMirror(ui);
      try { if (ui.monacoHost) ui.monacoHost.classList.remove('hidden'); } catch (e) {}

      const runtime = await ensureEditorRuntime('monaco');
      if (!runtime || typeof runtime.create !== 'function' || !ui.monacoHost) {
        // No Monaco infra → fallback.
        try { toast('Monaco недоступен — используется CodeMirror', 'warning'); } catch (e) {}
        return activateEngine('codemirror', { ctx, text, preserveView: false, initialView: view });
      }

      // (Re)create Monaco fresh for the current file.
      try { disposeMonaco(ui); } catch (e) {}

      const lang = monacoLanguage(ctx && ctx.name, value);
      const ed = await runtime.create(ui.monacoHost, {
        language: lang,
        readOnly: ro,
        value: value,
        onChange: () => { try { updateDirtyUI(); } catch (e) {} },
      });

      if (!ed) {
        try { toast('Не удалось загрузить Monaco — переключаю на CodeMirror', 'warning'); } catch (e) {}
        try {
          const ee = getEditorEngineHelper();
          if (ee && typeof ee.set === 'function') await ee.set('codemirror');
        } catch (e) {}
        return activateEngine('codemirror', { ctx, text, preserveView: false, initialView: view });
      }

      STATE.monaco = ed;
      try { STATE.monacoFacade = monacoFacade(ed); } catch (e) { STATE.monacoFacade = null; }
      STATE.activeKind = 'monaco';
      STATE.activeFacade = STATE.monacoFacade;

      try { syncToolbarForEngine('monaco'); } catch (e) {}
      try { wireMonacoFullscreenOnce(); } catch (e) {}
      try { wireMonacoModalResizeOnce(); } catch (e) {}

      // Restore view if we are switching while open.
      if (view) restoreView('monaco', view);
      bindActiveViewStateTracking(ui);

      try { setInfo({ err: '' }); } catch (e) {}
      try { layoutMonacoSoon(ui, true); } catch (e) {}
      updateDirtyUI();
      return 'monaco';
    }

    // CodeMirror
    showCodeMirror(ui);
    const cm = ensureCm();

    if (cm) {
      try {
        let mode = guessMode(ctx && ctx.name, value);
        const modeObj = (mode && typeof mode === 'object') ? mode : null;
        const isJson = !!(modeObj && modeObj.json);
        const isJsonc = !!(modeObj && modeObj.jsonc);

        const wantsJsonLint = isJson && !isJsonc && !hasJsonComments(value);
        const ensured = await ensureCmAssets({ mode, jsonLint: wantsJsonLint });
        if (!ensured.modeOk) mode = 'text/plain';

        const canLintJson = wantsJsonLint && ensured.jsonLintOk;
        try {
          const gutters = canLintJson
            ? ['CodeMirror-linenumbers', 'CodeMirror-foldgutter', 'CodeMirror-lint-markers']
            : ['CodeMirror-linenumbers', 'CodeMirror-foldgutter'];
          cm.setOption('gutters', gutters);
        } catch (e) {}

        cm.setOption('mode', normalizedCodeMirrorMode(mode));
        cm.setOption('lint', canLintJson);
        cm.setOption('readOnly', ro ? 'nocursor' : false);
        cm.setValue(value);
        cm.clearHistory();
        try { refreshEditorValidation(ui, { ctx, text: value }); } catch (e) {}
        kickRefresh(cm, true);
      } catch (e) {}
    } else if (ui.textarea) {
      ui.textarea.value = value;
      try { setInfo({ err: '' }); } catch (e) {}
      setTimeout(() => { try { ui.textarea.focus(); } catch (e) {} }, 0);
    }

    STATE.activeKind = 'codemirror';
    STATE.activeFacade = cm ? cmFacade(cm) : textareaFacade(ui.textarea);

    try { syncToolbarForEngine('codemirror'); } catch (e) {}

    if (view) restoreView('codemirror', view);
    bindActiveViewStateTracking(ui);
    try { refreshEditorValidation(ui, { ctx, text: value }); } catch (e) {}
    updateDirtyUI();
    return 'codemirror';
  }

  async function open(ctx, text) {
    const ui = els();
    if (!ui) return false;

    if (STATE.ctx) {
      clearViewStateTimer();
      try { saveCurrentViewState({ ctx: STATE.ctx, engine: STATE.activeKind }); } catch (e) {}
    }

    STATE.ctx = ctx || null;
    STATE.lastSaved = String(text || '');
    STATE.dirty = false;

    try { if (ui.title) ui.title.textContent = String((ctx && ctx.name) || 'Файл'); } catch (e) {}

    const subtitle = [];
    try {
      if (ctx && ctx.path) subtitle.push(String(ctx.path));
      if (ctx && ctx.target === 'remote' && ctx.sid) subtitle.push('remote');
      if (ctx && ctx.target === 'local') subtitle.push('local');
      if (ctx && ctx.truncated) subtitle.push('частично');
    } catch (e) {}

    setInfo({
      subtitle: subtitle.join(' • '),
      warn: (ctx && ctx.truncated) ? 'Файл открыт частично (ограничение размера). Сохранение отключено.' : '',
      err: '',
    });

    modalOpen(ui.modal);

    // Resolve preferred engine (server settings are primary; local fallback is acceptable).
    let engine = 'codemirror';
    try {
      const ee = getEditorEngineHelper();
      if (ee && typeof ee.ensureLoaded === 'function') {
        engine = normalizeEngine(await ee.ensureLoaded());
      } else if (ee && typeof ee.get === 'function') {
        engine = normalizeEngine(ee.get());
      }
    } catch (e) {
      try {
        const ee = getEditorEngineHelper();
        engine = normalizeEngine(ee && ee.get ? ee.get() : 'codemirror');
      } catch (e2) {
        engine = 'codemirror';
      }
    }

    const initialView = loadSavedViewState(ctx, engine);
    setEngineSelectValue(engine);
    STATE.switching = true;
    try {
      await activateEngine(engine, { ctx, text, preserveView: false, initialView });
    } finally {
      STATE.switching = false;
    }
    return true;
  }

  async function requestClose() {
    const ui = els();
    if (!ui) return;
    const has = !!STATE.ctx;

    if (has && STATE.dirty) {
      let ok = true;
      try {
        if (C && typeof C.confirm === 'function') {
          ok = await C.confirm({
            title: 'Несохранённые изменения',
            message: 'Закрыть файл без сохранения?',
            okText: 'Закрыть',
            cancelText: 'Отмена',
            danger: true,
          });
        } else {
          ok = window.confirm('Закрыть файл без сохранения?');
        }
      } catch (e) {
        ok = true;
      }
      if (!ok) return;
    }

    clearViewStateTimer();
    if (has) {
      try { saveCurrentViewState(); } catch (e) {}
    }
    clearViewStateBindings();

    try { STATE.ctx = null; } catch (e) {}
    try { STATE.dirty = false; } catch (e) {}
    try { STATE.lastSaved = ''; } catch (e) {}
    try { STATE.activeFacade = null; } catch (e) {}

    // Exit any fullscreen mode before closing.
    try {
      if (isMonacoFullscreen(ui)) setMonacoFullscreen(false, ui);
    } catch (e) {}
    try { if (isCodeMirrorFullscreen(STATE.cm)) setCodeMirrorFullscreen(false, STATE.cm); } catch (e2) {}

    // Clean up Monaco to avoid leaks; restore default UI visibility.
    try { disposeMonaco(ui); } catch (e) {}
    try { showCodeMirror(ui); } catch (e) {}

    modalClose(ui.modal);
  }

  function download() {
    const ctx = STATE.ctx;
    if (!ctx) return;

    const target = String(ctx.target || 'local');
    const path = String(ctx.path || '');
    const sid = String(ctx.sid || '');
    const name = String(ctx.name || 'download');

    const url = `/api/fs/download?target=${encodeURIComponent(target)}&path=${encodeURIComponent(path)}${target === 'remote' ? `&sid=${encodeURIComponent(sid)}` : ''}`;
    const dl = api().xhrDownloadFile;
    if (typeof dl === 'function') dl({ url, filenameHint: name, titleLabel: 'Download' });
  }

  async function save() {
    const ctx = STATE.ctx;
    const ui = els();
    if (!ctx || !ui) return;
    if (ctx.readOnly) return;

    const text = activeText(ui);
    const validation = refreshEditorValidation(ui, { ctx, text });
    if (validation && validation.ok === false) {
      const msg = validation.summary || 'JSON содержит ошибку. Сохранение отменено.';
      setInfo({ err: msg });
      try { toast(msg, 'error'); } catch (e) {}
      try { const fac = activeFacade(); if (fac && typeof fac.focus === 'function') fac.focus(); } catch (e2) {}
      return;
    }
    try { if (ui.saveBtn) ui.saveBtn.disabled = true; } catch (e) {}

    const payload = { target: ctx.target, path: ctx.path, sid: ctx.sid || '', text };
    const f = api().fetchJson;
    if (typeof f !== 'function') {
      setInfo({ err: 'Не удалось сохранить: fetch_unavailable' });
      try { if (ui.saveBtn) ui.saveBtn.disabled = false; } catch (e2) {}
      return;
    }

    let out = null;
    try {
      const { res, data } = await f('/api/fs/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      out = { res, data };
    } catch (e) {
      out = null;
    }

    if (!out || !out.res || out.res.status < 200 || out.res.status >= 300 || !(out.data && out.data.ok)) {
      const errMsg = (out && out.data && out.data.error) ? String(out.data.error) : 'save_failed';
      setInfo({ err: 'Не удалось сохранить: ' + errMsg });
      try { toast('FM: не удалось сохранить файл', 'error'); } catch (e) {}
      try { if (ui.saveBtn) ui.saveBtn.disabled = false; } catch (e2) {}
      return;
    }

    STATE.lastSaved = text;
    STATE.dirty = false;
    setInfo({ err: '' });
    try { toast('Сохранено: ' + (ctx.name || 'файл'), 'success'); } catch (e) {}

    try { updateDirtyUI(); } catch (e) {}
    try { saveCurrentViewState(); } catch (e) {}

    try {
      const lp = api().listPanel;
      if (ctx.side && typeof lp === 'function') await lp(ctx.side, { fromInput: false });
    } catch (e) {}
  }

  function wire() {
    if (STATE.wired) return;
    const ui = els();
    if (!ui) return;
    STATE.wired = true;

    if (ui.cancelBtn) ui.cancelBtn.addEventListener('click', (e) => { e.preventDefault(); requestClose(); });
    if (ui.closeBtn) ui.closeBtn.addEventListener('click', (e) => { e.preventDefault(); requestClose(); });
    if (ui.downloadBtn) ui.downloadBtn.addEventListener('click', (e) => { e.preventDefault(); download(); });
    if (ui.saveBtn) ui.saveBtn.addEventListener('click', (e) => { e.preventDefault(); save(); });

    // Engine toggle (global setting)
    if (ui.engineSelect) {
      try {
        const ee = getEditorEngineHelper();
        if (ee && typeof ee.get === 'function') ui.engineSelect.value = normalizeEngine(ee.get());
      } catch (e) {}

      ui.engineSelect.addEventListener('change', async () => {
        const next = normalizeEngine(ui.engineSelect.value);
        try {
          const ee = getEditorEngineHelper();
          if (ee && typeof ee.set === 'function') await ee.set(next);
        } catch (e) {}
      });
    }

    try {
      const ee = getEditorEngineHelper();
      if (ee && typeof ee.onChange === 'function') {
        ee.onChange(async (d) => {
          const next = normalizeEngine(d && d.engine);
          setEngineSelectValue(next);

          // Switch live only if modal is open.
          if (!STATE.ctx) return;
          if (STATE.switching) return;
          if (next === STATE.activeKind) return;

          STATE.switching = true;
          try {
            const v = activeText();
            await activateEngine(next, { ctx: STATE.ctx, text: v, preserveView: true });
          } catch (e) {
          } finally {
            STATE.switching = false;
          }
        });
      }
    } catch (e) {}
  }

  FM.editor = {
    wire,
    open,
    requestClose,
    download,
    save,
    isDirty: () => {
      try { return !!(STATE.ctx && STATE.dirty); } catch (e) { return false; }
    },
    // Fullscreen helpers (used by global ESC handlers)
    isFullscreen: () => {
      try { return isEditorFullscreen(); } catch (e) { return false; }
    },
    exitFullscreenIfAny: () => {
      try { return exitFullscreenIfAny(); } catch (e) { return false; }
    },
  };
})();

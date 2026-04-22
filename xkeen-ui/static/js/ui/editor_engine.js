(() => {
  // Global editor engine helper (CodeMirror / Monaco)
  //
  // Goals:
  // - Single place to read/write "preferred editor engine".
  // - Server settings (/api/ui-settings) are the primary source of truth.
  // - localStorage is used only as a fallback when server is unavailable.
  // - Emit a DOM event on change so multiple editors can stay in sync.
  //
  // This module is feature-neutral:
  // - It does not auto-fetch /api/ui-settings by itself.
  // - Consumers may call ensureLoaded() (lazy) when they actually need it.

  window.XKeen = window.XKeen || {};
  const XKeen = window.XKeen;
  XKeen.ui = XKeen.ui || {};

  const VALID = ['codemirror', 'monaco'];
  const DEFAULT_ENGINE = 'codemirror';

  // Fallback-only key. Note: routing.js historically used its own key;
  // this global helper uses a separate key for new editors.
  const LS_KEY = 'xkeen.editor.engine';

  const EVENT_NAME = 'xkeen-editor-engine-change';

  let _engine = null;
  let _ensurePromise = null;
  let _settingsUnsubscribe = null;

  function normalizeEngine(v) {
    const s = String(v || '').toLowerCase();
    return VALID.includes(s) ? s : null;
  }

  function readLocal() {
    try {
      return normalizeEngine(localStorage.getItem(LS_KEY));
    } catch (e) {
      return null;
    }
  }

  function writeLocal(engine) {
    try {
      localStorage.setItem(LS_KEY, String(engine));
    } catch (e) {}
  }

  function removeLocal() {
    try {
      localStorage.removeItem(LS_KEY);
    } catch (e) {}
  }

  function getSettingsApi() {
    try {
      if (XKeen.ui && XKeen.ui.settings) return XKeen.ui.settings;
    } catch (e) {}
    return null;
  }

  function readFromSettingsCache() {
    try {
      const api = getSettingsApi();
      if (!api || typeof api.get !== 'function') return null;
      const st = api.get();
      return normalizeEngine(st && st.editor ? st.editor.engine : null);
    } catch (e) {
      return null;
    }
  }

  function settingsLoadedFromServer() {
    try {
      const api = getSettingsApi();
      if (!api || typeof api.isLoadedFromServer !== 'function') return false;
      return !!api.isLoadedFromServer();
    } catch (e) {
      return false;
    }
  }

  function ensureSettingsBinding() {
    if (_settingsUnsubscribe) return _settingsUnsubscribe;

    const api = getSettingsApi();
    if (!api || typeof api.subscribe !== 'function') return () => {};

    _settingsUnsubscribe = api.subscribe((nextSnapshot, prevSnapshot, meta) => {
      const next = normalizeEngine(nextSnapshot && nextSnapshot.editor ? nextSnapshot.editor.engine : null);
      if (!next) return;

      const prev = _engine;
      _engine = next;

      if (prev && prev !== next) {
        dispatchChange(next, prev, meta && meta.source ? meta.source : 'ui-settings');
      }
    }, { immediate: true });

    return _settingsUnsubscribe;
  }

  function dispatchChange(next, prev, source) {
    try {
      document.dispatchEvent(new CustomEvent(EVENT_NAME, {
        detail: {
          engine: next,
          prev: prev,
          source: source || 'unknown',
        },
      }));
    } catch (e) {}
  }

  function isFn(fn) {
    return typeof fn === 'function';
  }

  function isCodeMirrorLike(target) {
    try {
      return !!(target
        && isFn(target.getValue)
        && isFn(target.setValue)
        && (isFn(target.getWrapperElement) || isFn(target.getTextArea) || isFn(target.refresh)));
    } catch (e) {}
    return false;
  }

  function isMonacoLike(target) {
    try {
      return !!(target
        && isFn(target.getValue)
        && isFn(target.setValue)
        && (isFn(target.getModel) || isFn(target.onDidChangeModelContent) || isFn(target.layout)));
    } catch (e) {}
    return false;
  }

  function isTextareaLike(target) {
    try {
      return !!(target && typeof target.value !== 'undefined' && isFn(target.focus));
    } catch (e) {}
    return false;
  }

  function inferFacadeEngine(target, preferred) {
    const explicit = normalizeEngine(preferred);
    if (explicit) return explicit;
    try {
      const raw = target && (target.raw || target.editor || target.target);
      const hinted = normalizeEngine(target && (target.kind || target.engine || (raw && (raw.kind || raw.engine))));
      if (hinted) return hinted;
    } catch (e) {}
    if (isMonacoLike(target)) return 'monaco';
    if (isCodeMirrorLike(target)) return 'codemirror';
    try {
      const raw = target && (target.raw || target.editor || target.target);
      if (isMonacoLike(raw)) return 'monaco';
      if (isCodeMirrorLike(raw)) return 'codemirror';
    } catch (e) {}
    return DEFAULT_ENGINE;
  }

  function readEditorText(target) {
    try {
      if (target && isFn(target.get)) return String(target.get() || '');
    } catch (e) {}
    try {
      if (target && isFn(target.getValue)) return String(target.getValue() || '');
    } catch (e) {}
    try {
      if (isTextareaLike(target)) return String(target.value || '');
    } catch (e) {}
    return '';
  }

  function writeEditorText(target, value) {
    const next = String(value ?? '');
    try {
      if (target && isFn(target.set)) {
        target.set(next);
        return next;
      }
    } catch (e) {}
    try {
      if (target && isFn(target.setValue)) {
        target.setValue(next);
        return next;
      }
    } catch (e) {}
    try {
      if (isTextareaLike(target)) {
        target.value = next;
        return next;
      }
    } catch (e) {}
    return next;
  }

  function cloneCodeMirrorPos(pos) {
    try {
      if (!pos) return null;
      return {
        line: Math.max(0, Number(pos.line || 0)),
        ch: Math.max(0, Number(pos.ch || 0)),
      };
    } catch (e) {}
    return null;
  }

  function clampCodeMirrorPos(editor, pos) {
    const next = cloneCodeMirrorPos(pos);
    try {
      if (!next || !editor) return next;
      if (isFn(editor.lineCount)) {
        const total = Math.max(1, Number(editor.lineCount() || 1));
        next.line = Math.min(total - 1, Math.max(0, next.line));
      }
      if (isFn(editor.getLine)) {
        const lineText = editor.getLine(next.line);
        const maxCh = String(lineText == null ? '' : lineText).length;
        next.ch = Math.min(maxCh, Math.max(0, next.ch));
      }
    } catch (e) {}
    return next;
  }

  function captureCodeMirrorFolds(editor) {
    const folds = [];
    try {
      if (!editor || !isFn(editor.getAllMarks)) return folds;
      const marks = editor.getAllMarks();
      if (!Array.isArray(marks)) return folds;
      for (let i = 0; i < marks.length; i += 1) {
        const mark = marks[i];
        if (!mark || !mark.__isFold || !isFn(mark.find)) continue;
        const range = mark.find();
        const from = clampCodeMirrorPos(editor, range && range.from);
        const to = clampCodeMirrorPos(editor, range && range.to);
        if (!from || !to) continue;
        folds.push({ from, to });
      }
      folds.sort((a, b) => {
        const aFrom = a && a.from ? a.from : {};
        const bFrom = b && b.from ? b.from : {};
        if (aFrom.line !== bFrom.line) return Number(aFrom.line || 0) - Number(bFrom.line || 0);
        return Number(aFrom.ch || 0) - Number(bFrom.ch || 0);
      });
    } catch (e) {}
    return folds;
  }

  function clearCodeMirrorFolds(editor) {
    try {
      if (!editor || !isFn(editor.getAllMarks)) return false;
      let cleared = false;
      const marks = editor.getAllMarks();
      if (!Array.isArray(marks)) return false;
      for (let i = 0; i < marks.length; i += 1) {
        const mark = marks[i];
        if (!mark || !mark.__isFold || !isFn(mark.clear)) continue;
        try {
          mark.clear();
          cleared = true;
        } catch (e) {}
      }
      return cleared;
    } catch (e) {}
    return false;
  }

  function restoreCodeMirrorFolds(editor, folds) {
    try {
      if (!editor || !Array.isArray(folds)) return false;
      let restored = false;
      clearCodeMirrorFolds(editor);
      const apply = () => {
        for (let i = 0; i < folds.length; i += 1) {
          const item = folds[i];
          const from = clampCodeMirrorPos(editor, item && item.from);
          if (!from || !isFn(editor.foldCode)) continue;
          try {
            editor.foldCode(from, { scanUp: false }, 'fold');
            restored = true;
          } catch (e) {}
        }
      };
      if (isFn(editor.operation)) {
        editor.operation(apply);
      } else {
        apply();
      }
      return restored;
    } catch (e) {}
    return false;
  }

  function captureCodeMirrorViewState(editor) {
    const out = { kind: 'codemirror' };
    try {
      if (!editor) return out;
      if (isFn(editor.getCursor)) out.cursor = editor.getCursor();
      if (isFn(editor.listSelections)) out.selections = editor.listSelections();
      out.folds = captureCodeMirrorFolds(editor);
      if (isFn(editor.getScrollInfo)) {
        const si = editor.getScrollInfo();
        if (si) {
          out.scrollTop = Number(si.top || 0);
          out.scrollLeft = Number(si.left || 0);
        }
      }
    } catch (e) {}
    return out;
  }

  function restoreCodeMirrorViewState(editor, view) {
    try {
      if (!editor || !view) return false;
      let restored = false;
      if (Array.isArray(view.folds)) {
        restored = restoreCodeMirrorFolds(editor, view.folds) || restored;
      }
      if (Array.isArray(view.selections) && view.selections.length && isFn(editor.setSelections)) {
        editor.setSelections(view.selections);
        restored = true;
      } else if (view.cursor && isFn(editor.setCursor)) {
        editor.setCursor(view.cursor);
        restored = true;
      } else if (view.pos && isFn(editor.setCursor)) {
        editor.setCursor({
          line: Math.max(0, Number((view.pos && view.pos.lineNumber) || 1) - 1),
          ch: Math.max(0, Number((view.pos && view.pos.column) || 1) - 1),
        });
        restored = true;
      }
      if ((typeof view.scrollTop === 'number' || typeof view.scrollLeft === 'number') && isFn(editor.scrollTo)) {
        editor.scrollTo(
          typeof view.scrollLeft === 'number' ? Math.max(0, view.scrollLeft) : null,
          typeof view.scrollTop === 'number' ? Math.max(0, view.scrollTop) : null
        );
        restored = true;
      }
      if (restored && isFn(editor.refresh)) editor.refresh();
      return restored;
    } catch (e) {}
    return false;
  }

  function captureMonacoViewState(editor) {
    const out = { kind: 'monaco' };
    try {
      if (!editor) return out;
      if (isFn(editor.saveViewState)) out.state = editor.saveViewState();
      if (isFn(editor.getPosition)) out.pos = editor.getPosition();
      if (isFn(editor.getSelections)) out.selections = editor.getSelections();
      if (isFn(editor.getScrollTop)) out.scrollTop = Number(editor.getScrollTop() || 0);
      if (isFn(editor.getScrollLeft)) out.scrollLeft = Number(editor.getScrollLeft() || 0);
    } catch (e) {}
    return out;
  }

  function restoreMonacoViewState(editor, view) {
    try {
      if (!editor || !view) return false;
      let restored = false;
      if (view.state && isFn(editor.restoreViewState)) {
        editor.restoreViewState(view.state);
        restored = true;
      }
      if (Array.isArray(view.selections) && view.selections.length && isFn(editor.setSelections)) {
        editor.setSelections(view.selections);
        restored = true;
      } else if (view.pos && isFn(editor.setPosition)) {
        editor.setPosition(view.pos);
        restored = true;
      } else if (view.cursor && isFn(editor.setPosition)) {
        editor.setPosition({
          lineNumber: Math.max(1, Number((view.cursor && view.cursor.line) || 0) + 1),
          column: Math.max(1, Number((view.cursor && view.cursor.ch) || 0) + 1),
        });
        restored = true;
      }
      if (typeof view.scrollTop === 'number' && isFn(editor.setScrollTop)) {
        editor.setScrollTop(Math.max(0, view.scrollTop));
        restored = true;
      }
      if (typeof view.scrollLeft === 'number' && isFn(editor.setScrollLeft)) {
        editor.setScrollLeft(Math.max(0, view.scrollLeft));
        restored = true;
      }
      return restored;
    } catch (e) {}
    return false;
  }

  function captureTextareaViewState(textarea, kind) {
    const out = { kind: normalizeEngine(kind) || DEFAULT_ENGINE };
    try {
      if (!textarea) return out;
      out.selectionStart = Number(textarea.selectionStart || 0);
      out.selectionEnd = Number(textarea.selectionEnd || out.selectionStart || 0);
      out.scrollTop = Number(textarea.scrollTop || 0);
      out.scrollLeft = Number(textarea.scrollLeft || 0);
    } catch (e) {}
    return out;
  }

  function restoreTextareaViewState(textarea, view) {
    try {
      if (!textarea || !view) return false;
      let restored = false;
      if (isFn(textarea.setSelectionRange)
        && typeof view.selectionStart === 'number'
        && typeof view.selectionEnd === 'number') {
        textarea.setSelectionRange(
          Math.max(0, view.selectionStart),
          Math.max(0, view.selectionEnd)
        );
        restored = true;
      }
      if (typeof view.scrollTop === 'number') {
        textarea.scrollTop = Math.max(0, view.scrollTop);
        restored = true;
      }
      if (typeof view.scrollLeft === 'number') {
        textarea.scrollLeft = Math.max(0, view.scrollLeft);
        restored = true;
      }
      return restored;
    } catch (e) {}
    return false;
  }

  function persistViewState(state, storageKey, opts) {
    const o = opts || {};
    try {
      if (isFn(o.persist)) {
        o.persist(state, o);
        return state;
      }
    } catch (e) {}
    const key = String(o.key || o.storageKey || storageKey || '').trim();
    if (!key || o.memoryOnly) return state;
    try {
      localStorage.setItem(key, JSON.stringify(state || {}));
    } catch (e) {}
    return state;
  }

  function cloneViewState(value) {
    try {
      if (value == null) return null;
      return JSON.parse(JSON.stringify(value));
    } catch (e) {}
    return value || null;
  }

  function normalizeViewStateEngine(engine, fallback) {
    const normalized = normalizeEngine(engine);
    if (normalized) return normalized;
    return normalizeEngine(fallback) || DEFAULT_ENGINE;
  }

  function emptyViewStateBundle() {
    return {
      version: 1,
      updatedAt: 0,
      lastEngine: DEFAULT_ENGINE,
      last: null,
      views: {},
    };
  }

  function normalizeStoredViewBundle(raw) {
    const base = emptyViewStateBundle();
    try {
      if (raw && raw.version === 1 && raw.views && typeof raw.views === 'object') {
        base.updatedAt = Number(raw.updatedAt || 0);
        base.lastEngine = normalizeViewStateEngine(raw.lastEngine, raw.last && raw.last.kind);
        base.last = cloneViewState(raw.last);
        base.views = {
          codemirror: cloneViewState(raw.views.codemirror),
          monaco: cloneViewState(raw.views.monaco),
        };
        return base;
      }
      if (raw && typeof raw === 'object'
        && (raw.kind || raw.state || raw.cursor || raw.pos || typeof raw.selectionStart === 'number')) {
        const engine = normalizeViewStateEngine(raw.kind, DEFAULT_ENGINE);
        base.lastEngine = engine;
        base.last = cloneViewState(raw);
        base.views[engine] = cloneViewState(raw);
      }
    } catch (e) {}
    return base;
  }

  function createViewStateStore(opts) {
    const o = opts || {};
    const state = {
      timer: null,
      cache: { key: null, value: null },
      unsubs: [],
    };

    function buildKey(input) {
      try {
        if (isFn(o.buildKey)) return String(o.buildKey(input, o) || '').trim();
      } catch (e) {}
      const prefix = String(o.prefix || o.storagePrefix || '').trim();
      if (!prefix) return String(input || '').trim();
      if (input == null || input === '') return prefix;
      return prefix + String(input);
    }

    function resolveKey(spec) {
      const cfg = (spec && typeof spec === 'object') ? spec : {};
      return String(cfg.key || buildKey(cfg.ctx != null ? cfg.ctx : spec) || '').trim();
    }

    function readBundle(key) {
      const storageKey = String(key || '').trim();
      if (!storageKey) return emptyViewStateBundle();
      try {
        if (state.cache.key === storageKey && state.cache.value) {
          return normalizeStoredViewBundle(cloneViewState(state.cache.value));
        }
      } catch (e) {}
      try {
        const raw = localStorage.getItem(storageKey);
        if (!raw) return emptyViewStateBundle();
        const parsed = JSON.parse(raw);
        const normalized = normalizeStoredViewBundle(parsed);
        state.cache = { key: storageKey, value: cloneViewState(normalized) };
        return normalized;
      } catch (e) {}
      return emptyViewStateBundle();
    }

    function writeBundle(key, bundle, spec) {
      const storageKey = String(key || '').trim();
      if (!storageKey) return;
      const cfg = (spec && typeof spec === 'object') ? spec : {};
      const normalized = normalizeStoredViewBundle(bundle);
      state.cache = { key: storageKey, value: cloneViewState(normalized) };
      if (cfg.memoryOnly) return;
      try {
        localStorage.setItem(storageKey, JSON.stringify(normalized));
      } catch (e) {}
    }

    function createFacadeForSpec(spec) {
      const cfg = (spec && typeof spec === 'object') ? spec : {};
      if (isFacade(cfg.facade)) return cfg.facade;

      const target = cfg.target || cfg.editor || cfg.raw || cfg.textarea || null;
      const engine = normalizeViewStateEngine(cfg.engine, cfg.kind);

      try {
        if (engine === 'monaco' && isMonacoLike(target)) return fromMonaco(target, cfg.facadeOpts);
        if (engine === 'codemirror' && isCodeMirrorLike(target)) return fromCodeMirror(target, cfg.facadeOpts);
        if (isTextareaLike(target)) return fromTextarea(target, { ...(cfg.facadeOpts || {}), kind: engine });
      } catch (e) {}
      return null;
    }

    function capture(spec) {
      const cfg = (spec && typeof spec === 'object') ? spec : {};
      try {
        if (isFn(cfg.capture)) return cloneViewState(cfg.capture(cfg));
      } catch (e) {}

      const fac = createFacadeForSpec(cfg);
      try {
        if (fac && typeof fac.saveViewState === 'function') {
          return cloneViewState(fac.saveViewState({ memoryOnly: true }));
        }
      } catch (e) {}
      return null;
    }

    function load(spec) {
      const cfg = (spec && typeof spec === 'object') ? spec : { key: spec };
      const key = resolveKey(cfg);
      if (!key) return null;
      const bundle = readBundle(key);
      const target = normalizeViewStateEngine(cfg.engine, bundle.lastEngine);
      const exact = bundle && bundle.views ? bundle.views[target] : null;
      if (exact) return cloneViewState(exact);
      return cloneViewState(bundle.last);
    }

    function save(spec) {
      const cfg = (spec && typeof spec === 'object') ? spec : {};
      const key = resolveKey(cfg);
      const nextView = cloneViewState(
        typeof cfg.view !== 'undefined' ? cfg.view : capture(cfg)
      );
      if (!key || !nextView) return nextView;

      const bundle = readBundle(key);
      const slot = normalizeViewStateEngine(cfg.engine, nextView && nextView.kind);
      bundle.updatedAt = Date.now();
      bundle.lastEngine = slot;
      bundle.last = nextView;
      bundle.views = bundle.views || {};
      bundle.views[slot] = cloneViewState(nextView);
      writeBundle(key, bundle, cfg);
      return cloneViewState(nextView);
    }

    function restore(spec) {
      const cfg = (spec && typeof spec === 'object') ? spec : {};
      const view = (typeof cfg.view !== 'undefined') ? cfg.view : load(cfg);
      if (!view) return false;
      const fac = createFacadeForSpec(cfg);
      try {
        if (fac && typeof fac.restoreViewState === 'function') {
          return !!fac.restoreViewState(view);
        }
      } catch (e) {}
      return false;
    }

    function clearTimer() {
      try {
        if (state.timer) clearTimeout(state.timer);
      } catch (e) {}
      state.timer = null;
    }

    function clearBindings() {
      const unsubs = Array.isArray(state.unsubs) ? state.unsubs.splice(0) : [];
      for (let i = 0; i < unsubs.length; i += 1) {
        try { if (typeof unsubs[i] === 'function') unsubs[i](); } catch (e) {}
      }
    }

    function schedule(spec) {
      const cfg = (spec && typeof spec === 'object') ? spec : {};
      const wait = Math.max(0, Number(cfg.waitMs != null ? cfg.waitMs : (cfg.wait != null ? cfg.wait : o.waitMs || 0)) || 0);
      clearTimer();
      state.timer = setTimeout(() => {
        state.timer = null;
        try { save(cfg); } catch (e) {}
        try {
          if (isFn(cfg.afterSave)) cfg.afterSave(cfg);
        } catch (e2) {}
      }, wait);
    }

    function bind(spec) {
      clearBindings();

      const cfg = (spec && typeof spec === 'object') ? spec : {};
      const scheduleSave = () => {
        schedule(cfg);
      };

      const monaco = cfg.monaco || (normalizeViewStateEngine(cfg.engine, '') === 'monaco' ? cfg.editor : null);
      if (monaco && isFn(monaco.onDidChangeModelContent)) {
        const bindMonaco = (register) => {
          try {
            const d = register();
            if (d && isFn(d.dispose)) {
              state.unsubs.push(() => {
                try { d.dispose(); } catch (e) {}
              });
            }
          } catch (e) {}
        };
        bindMonaco(() => monaco.onDidChangeModelContent(scheduleSave));
        bindMonaco(() => monaco.onDidChangeCursorSelection(scheduleSave));
        bindMonaco(() => monaco.onDidScrollChange(scheduleSave));
        if (isFn(monaco.onDidChangeHiddenAreas)) {
          bindMonaco(() => monaco.onDidChangeHiddenAreas(scheduleSave));
        }
        return () => clearBindings();
      }

      const cm = cfg.codemirror || (normalizeViewStateEngine(cfg.engine, '') === 'codemirror' ? cfg.editor : null);
      if (cm && isFn(cm.on) && isFn(cm.off)) {
        ['change', 'cursorActivity', 'scroll', 'fold', 'unfold'].forEach((name) => {
          const handler = () => { scheduleSave(); };
          try {
            cm.on(name, handler);
            state.unsubs.push(() => {
              try { cm.off(name, handler); } catch (e) {}
            });
          } catch (e) {}
        });
        return () => clearBindings();
      }

      const textarea = cfg.textarea || cfg.target || cfg.editor || null;
      if (textarea && isTextareaLike(textarea) && isFn(textarea.addEventListener) && isFn(textarea.removeEventListener)) {
        ['input', 'change', 'scroll', 'select', 'keyup', 'mouseup'].forEach((name) => {
          const handler = () => { scheduleSave(); };
          try {
            textarea.addEventListener(name, handler);
            state.unsubs.push(() => {
              try { textarea.removeEventListener(name, handler); } catch (e) {}
            });
          } catch (e) {}
        });
      }

      return () => clearBindings();
    }

    return {
      buildKey,
      load,
      save,
      capture,
      restore,
      schedule,
      bind,
      clearTimer,
      clearBindings,
      dispose: () => {
        clearTimer();
        clearBindings();
        state.cache = { key: null, value: null };
      },
      state,
    };
  }

  function createFacade(opts) {
    const o = opts || {};
    const target = o.target || o.editor || o.raw || null;
    const raw = o.raw || (target && (target.raw || target.editor)) || target;
    const kind = inferFacadeEngine(target || raw, o.kind || o.engine);
    const storageKey = String(o.viewStateKey || '').trim();

    const getImpl = isFn(o.get)
      ? () => o.get()
      : (isFn(o.getValue)
        ? () => o.getValue()
        : () => readEditorText(target || raw));

    const setImpl = isFn(o.set)
      ? (value) => o.set(value)
      : (isFn(o.setValue)
        ? (value) => o.setValue(value)
        : (value) => writeEditorText(target || raw, value));

    const layoutImpl = isFn(o.layout)
      ? () => o.layout()
      : (() => {
          try {
            const obj = target || raw;
            if (obj && isFn(obj.layout)) return obj.layout();
            if (obj && isFn(obj.refresh)) return obj.refresh();
          } catch (e) {}
          return null;
        });

    const focusImpl = isFn(o.focus)
      ? () => o.focus()
      : (() => {
          try {
            const obj = target || raw;
            if (obj && isFn(obj.focus)) return obj.focus();
          } catch (e) {}
          return null;
        });

    const scrollImpl = isFn(o.scrollTo)
      ? (x, y) => o.scrollTo(x, y)
      : ((x, y) => {
          try {
            const obj = target || raw;
            if (!obj) return null;
            if (isFn(obj.scrollTo)) return obj.scrollTo(x, y);
            if (isFn(obj.setScrollLeft) && typeof x === 'number') obj.setScrollLeft(Math.max(0, x));
            if (isFn(obj.setScrollTop) && typeof y === 'number') obj.setScrollTop(Math.max(0, y));
            if (isTextareaLike(obj)) {
              if (typeof x === 'number') obj.scrollLeft = Math.max(0, x);
              if (typeof y === 'number') obj.scrollTop = Math.max(0, y);
            }
          } catch (e) {}
          return null;
        });

    const validateImpl = isFn(o.validate)
      ? (...args) => o.validate.apply(null, args)
      : () => true;

    const saveViewStateImpl = isFn(o.saveViewState)
      ? (viewOpts) => o.saveViewState(viewOpts)
      : ((viewOpts) => {
          let state = { kind };
          try {
            if (kind === 'monaco' && isMonacoLike(raw)) state = captureMonacoViewState(raw);
            else if (kind === 'codemirror' && isCodeMirrorLike(raw)) state = captureCodeMirrorViewState(raw);
            else if (isTextareaLike(target || raw)) state = captureTextareaViewState(target || raw, kind);
          } catch (e) {}
          return persistViewState(state, storageKey, viewOpts);
        });

    const restoreViewStateImpl = isFn(o.restoreViewState)
      ? (view) => o.restoreViewState(view)
      : ((view) => {
          try {
            if (kind === 'monaco' && isMonacoLike(raw)) return restoreMonacoViewState(raw, view);
            if (kind === 'codemirror' && isCodeMirrorLike(raw)) return restoreCodeMirrorViewState(raw, view);
            if (isTextareaLike(target || raw)) return restoreTextareaViewState(target || raw, view);
          } catch (e) {}
          return false;
        });

    const disposeImpl = isFn(o.dispose)
      ? () => o.dispose()
      : (() => {
          try {
            const obj = target || raw;
            if (obj && isFn(obj.dispose)) obj.dispose();
          } catch (e) {}
        });

    const onChangeImpl = isFn(o.onChange)
      ? (cb) => o.onChange(cb)
      : ((cb) => {
          if (!isFn(cb)) return () => {};
          try {
            const obj = target || raw;
            if (obj && isFn(obj.onDidChangeModelContent)) {
              const d = obj.onDidChangeModelContent(() => {
                try { cb(); } catch (e) {}
              });
              return () => {
                try { if (d && isFn(d.dispose)) d.dispose(); } catch (e) {}
              };
            }
            if (obj && isFn(obj.on) && isFn(obj.off)) {
              const handler = () => {
                try { cb(); } catch (e) {}
              };
              obj.on('change', handler);
              return () => {
                try { obj.off('change', handler); } catch (e) {}
              };
            }
            if (isTextareaLike(obj) && isFn(obj.addEventListener) && isFn(obj.removeEventListener)) {
              const handler = () => {
                try { cb(); } catch (e) {}
              };
              obj.addEventListener('input', handler);
              obj.addEventListener('change', handler);
              return () => {
                try { obj.removeEventListener('input', handler); } catch (e) {}
                try { obj.removeEventListener('change', handler); } catch (e2) {}
              };
            }
          } catch (e) {}
          return () => {};
        });

    const api = {
      kind,
      engine: kind,
      target,
      raw,
      editor: raw,
      __xkeenEditorFacade: true,
      get: () => {
        try { return String(getImpl() || ''); } catch (e) { return ''; }
      },
      set: (value) => {
        try { setImpl(String(value ?? '')); } catch (e) {}
        return api.get();
      },
      validate: (...args) => {
        try { return validateImpl.apply(null, args); } catch (e) { return false; }
      },
      layout: () => {
        try { return layoutImpl(); } catch (e) {}
        return null;
      },
      focus: () => {
        try { return focusImpl(); } catch (e) {}
        return null;
      },
      scrollTo: (x, y) => {
        try { return scrollImpl(x, y); } catch (e) {}
        return null;
      },
      saveViewState: (viewOpts) => {
        try { return saveViewStateImpl(viewOpts); } catch (e) { return { kind }; }
      },
      restoreViewState: (view) => {
        try { return !!restoreViewStateImpl(view); } catch (e) { return false; }
      },
      onChange: (cb) => {
        try { return onChangeImpl(cb); } catch (e) {}
        return () => {};
      },
      dispose: () => {
        try { return disposeImpl(); } catch (e) {}
        return null;
      },
    };

    api.getValue = () => api.get();
    api.setValue = (value) => api.set(value);
    api.captureViewState = (viewOpts) => api.saveViewState(viewOpts);
    api.getSchema = () => {
      try {
        const obj = target || raw;
        if (obj && isFn(obj.getSchema)) return obj.getSchema();
      } catch (e) {}
      return null;
    };
    api.setSchema = (schema) => {
      try {
        const obj = target || raw;
        if (obj && isFn(obj.setSchema)) return !!obj.setSchema(schema || null);
      } catch (e) {}
      return false;
    };

    return api;
  }

  function fromCodeMirror(editor, opts) {
    return createFacade({ ...(opts || {}), kind: 'codemirror', target: editor, raw: editor });
  }

  function fromMonaco(editor, opts) {
    return createFacade({ ...(opts || {}), kind: 'monaco', target: editor, raw: editor });
  }

  function fromTextarea(textarea, opts) {
    const o = opts || {};
    return createFacade({
      ...o,
      kind: o.kind || o.engine || DEFAULT_ENGINE,
      target: textarea,
      raw: textarea,
    });
  }

  function isFacade(value) {
    try {
      return !!(value && value.__xkeenEditorFacade && isFn(value.get) && isFn(value.set));
    } catch (e) {}
    return false;
  }

  const RUNTIME_CONTRACT_VERSION = 1;

  function getLazyApi() {
    try {
      return (window.XKeen && XKeen.runtime && XKeen.runtime.lazy) ? XKeen.runtime.lazy : null;
    } catch (e) {}
    return null;
  }


  function getCodeMirror6Runtime() {
    try {
      return (window.XKeen && XKeen.ui && XKeen.ui.cm6Runtime) ? XKeen.ui.cm6Runtime : null;
    } catch (e) {}
    return null;
  }

  const CM6_EXPERIMENTAL_SCOPES = Object.freeze({
    'json-modal': true,
    'file-manager': true,
    'devtools': true,
    'mihomo-generator': true,
    'mihomo-panel': true,
    'routing': true,
    'routing-templates': true,
    'backups': true,
    'mihomo-import': true,
    'xkeen-texts': true,
    'routing-cards': true,
  });

  function resolveCodeMirror6Scope(opts) {
    const source = (opts && typeof opts === 'object') ? opts : null;
    if (!source) return '';
    const raw = source.cm6Scope || source.scope || source.context || source.feature || source.screen || '';
    return String(raw || '').trim().toLowerCase();
  }

  function isExperimentalCodeMirror6Enabled(_opts) {
    return false;
  }

  function shouldUseCodeMirror6(_opts) {
    return !!getCodeMirror6Runtime();
  }

  function getCodeMirrorBackend(_opts) {
    return 'cm6';
  }

  function hasCodeMirror6Api() {
    try {
      const runtime = getCodeMirror6Runtime();
      return !!(runtime && typeof runtime.create === 'function');
    } catch (e) {}
    return false;
  }

  function getMonacoLoader() {
    try {
      return (window.XKeen && XKeen.monacoLoader) ? XKeen.monacoLoader : null;
    } catch (e) {}
    return null;
  }

  function getMonacoSharedApi() {
    try {
      return (window.XKeen && XKeen.ui && XKeen.ui.monacoShared) ? XKeen.ui.monacoShared : null;
    } catch (e) {}
    return null;
  }

  function hasMonacoApi() {
    try {
      return !!(window.monaco && window.monaco.editor && isFn(window.monaco.editor.create));
    } catch (e) {}
    return false;
  }


  function buildSupportStatus(engine, patch, opts) {
    const next = normalizeEngine(engine) || DEFAULT_ENGINE;
    return Object.assign({
      ok: false,
      ready: false,
      engine: next,
      backend: next === 'codemirror' ? 'cm6' : 'monaco',
      experimental: false,
      contractVersion: RUNTIME_CONTRACT_VERSION,
      loader: next === 'monaco' ? getMonacoLoader() : null,
      shared: next === 'monaco' ? getMonacoSharedApi() : null,
      api: next === 'monaco'
        ? (hasMonacoApi() ? window.monaco : null)
        : getCodeMirror6Runtime(),
      runtime: next === 'codemirror' ? getCodeMirror6Runtime() : null,
    }, patch || {});
  }

  async function ensureCodeMirrorSupportStatus(opts) {
    const o = opts || {};
    const cm6Runtime = getCodeMirror6Runtime();
    if (cm6Runtime && typeof cm6Runtime.ensure === 'function') {
      try {
        const st = await cm6Runtime.ensure(o);
        return buildSupportStatus('codemirror', {
          ok: !!(st && st.ok !== false),
          ready: !!(st && st.ready !== false),
          backend: 'cm6',
          loader: null,
          api: cm6Runtime,
          runtime: cm6Runtime,
          source: st && st.source ? st.source : 'local-offline-bundle',
          assets: st && st.assets ? st.assets : null,
        }, o);
      } catch (e) {}
    }

    const api = hasCodeMirror6Api() ? cm6Runtime : null;
    return buildSupportStatus('codemirror', {
      ok: !!api,
      ready: !!api,
      backend: 'cm6',
      loader: null,
      api,
      runtime: api,
    }, o);
  }

  async function ensureMonacoSupportStatus(opts) {
    const o = opts || {};
    let loader = getMonacoLoader();
    let shared = getMonacoSharedApi();
    let api = hasMonacoApi() ? window.monaco : null;

    if ((!shared || !loader) && !api) {
      const lazy = getLazyApi();
      if (lazy && typeof lazy.ensureEditorSupport === 'function') {
        try { await lazy.ensureEditorSupport('monaco', o); } catch (e) {}
        loader = getMonacoLoader();
        shared = getMonacoSharedApi();
        api = hasMonacoApi() ? window.monaco : null;
      }
    }

    if (loader && typeof loader.ensureSupport === 'function') {
      try {
        const st = await loader.ensureSupport(o);
        shared = getMonacoSharedApi();
        api = hasMonacoApi() ? window.monaco : (st && st.api ? st.api : null);
        const ready = !!(st && st.ready) && !!(shared && isFn(shared.createEditor));
        return buildSupportStatus('monaco', {
          ok: ready || (!!api && !!(shared && isFn(shared.createEditor))),
          ready,
          loader,
          shared,
          api,
          paths: st && st.paths ? st.paths : null,
          source: st && st.source ? st.source : null,
        }, o);
      } catch (e) {}
    }

    const fallbackReady = !!(api && shared && isFn(shared.createEditor));
    return buildSupportStatus('monaco', {
      ok: fallbackReady,
      ready: fallbackReady,
      loader,
      shared,
      api,
    }, o);
  }

  async function ensureSupport(engine, opts) {
    const next = normalizeEngine(engine) || DEFAULT_ENGINE;
    if (next === 'monaco') return ensureMonacoSupportStatus(opts);
    return ensureCodeMirrorSupportStatus(opts);
  }

  function buildCodeMirrorRuntime(opts) {
    const cm6Runtime = getCodeMirror6Runtime();
    return {
      ok: hasCodeMirror6Api(),
      ready: hasCodeMirror6Api(),
      engine: 'codemirror',
      backend: 'cm6',
      contractVersion: RUNTIME_CONTRACT_VERSION,
      loader: null,
      shared: null,
      api: cm6Runtime,
      runtime: cm6Runtime,
      ensure: (runtimeOpts) => ensureRuntime('codemirror', runtimeOpts || opts),
      ensureMode: async () => true,
      ensureJsonLint: async () => true,
      ensureAssets: async () => ({ ok: true, modeOk: true, jsonLintOk: true, addonsOk: true }),
      create: (target, createOpts) => {
        try {
          if (!cm6Runtime || !isFn(cm6Runtime.create) || !target) return null;
          return cm6Runtime.create(target, createOpts || {});
        } catch (e) {}
        return null;
      },
      toFacade: (editor, facadeOpts) => {
        try {
          if (cm6Runtime && isFn(cm6Runtime.toFacade)) return cm6Runtime.toFacade(editor, facadeOpts || {});
        } catch (e) {}
        return editor ? createFacade({ ...(facadeOpts || {}), kind: 'codemirror', target: editor, raw: editor }) : null;
      },
      layoutOnVisible: (editor, _host, layoutOpts) => {
        const o = layoutOpts || {};
        try { if (editor && isFn(editor.layout)) editor.layout(); } catch (e) {}
        try {
          const delay = typeof o.delay === 'number' ? o.delay : 0;
          setTimeout(() => {
            try {
              if (editor && isFn(editor.layout)) editor.layout();
              else if (editor && isFn(editor.refresh)) editor.refresh();
            } catch (e2) {}
          }, Math.max(0, delay));
        } catch (e3) {}
        return true;
      },
    };
  }

  function buildMonacoRuntime() {
    const loader = getMonacoLoader();
    const shared = getMonacoSharedApi();
    const api = hasMonacoApi() ? window.monaco : null;
    return {
      ok: !!(api && shared && isFn(shared.createEditor)),
      ready: !!(api && shared && isFn(shared.createEditor)),
      engine: 'monaco',
      contractVersion: RUNTIME_CONTRACT_VERSION,
      loader,
      shared,
      api,
      ensure: (opts) => ensureRuntime('monaco', opts),
      ensureAssets: async (opts) => ensureSupport('monaco', opts),
      create: async (target, opts) => {
        try {
          const currentShared = getMonacoSharedApi();
          if (!currentShared || !isFn(currentShared.createEditor) || !target) return null;
          return await currentShared.createEditor(target, opts || {});
        } catch (e) {}
        return null;
      },
      toFacade: (editor, opts) => editor ? fromMonaco(editor, opts) : null,
      layoutOnVisible: (editor, host, opts) => {
        try {
          const currentShared = getMonacoSharedApi();
          if (currentShared && isFn(currentShared.layoutOnVisible)) {
            return currentShared.layoutOnVisible(editor, host, opts || {});
          }
        } catch (e) {}
        try { if (editor && isFn(editor.layout)) editor.layout(); } catch (e2) {}
        return null;
      },
    };
  }

  function getRuntime(engine, opts) {
    const next = normalizeEngine(engine) || DEFAULT_ENGINE;
    return next === 'monaco' ? buildMonacoRuntime() : buildCodeMirrorRuntime(opts);
  }

  async function ensureRuntime(engine, opts) {
    const next = normalizeEngine(engine) || DEFAULT_ENGINE;
    const support = await ensureSupport(next, opts);
    const runtime = getRuntime(next, opts);
    return Object.assign({}, runtime || {}, support || {});
  }

  // Current preferred engine:
  // - If we already have a resolved value, return it.
  // - If server settings are loaded, use server cache.
  // - Otherwise use localStorage fallback.
  // - Otherwise default.
  function get() {
    if (_engine) return _engine;

    const fromSettings = settingsLoadedFromServer() ? readFromSettingsCache() : null;
    if (fromSettings) {
      _engine = fromSettings;
      return _engine;
    }

    const fromLocal = readLocal();
    if (fromLocal) {
      _engine = fromLocal;
      // Keep settings cache consistent for consumers that read XKeen.ui.settings.get()
      // without doing a server fetch.
      try {
        const settingsApi = getSettingsApi();
        if (settingsApi && typeof settingsApi.patchLocal === 'function') {
          settingsApi.patchLocal({ editor: { engine: _engine } });
        }
      } catch (e) {}
      return _engine;
    }

    _engine = DEFAULT_ENGINE;
    return _engine;
  }

  // Lazy load from server once.
  // - On success: server value wins, fallback localStorage is refreshed.
  // - On failure: localStorage fallback is used (if any).
  async function ensureLoaded() {
    if (_ensurePromise) return _ensurePromise;

    _ensurePromise = (async () => {
      const prev = get();
      ensureSettingsBinding();

      // If settings helper is missing, we can only use fallback.
      const settingsApi = getSettingsApi();
      if (!settingsApi || typeof settingsApi.fetchOnce !== 'function') {
        return get();
      }

      try {
        const st = await settingsApi.fetchOnce();
        const fromServer = normalizeEngine(st && st.editor ? st.editor.engine : null) || DEFAULT_ENGINE;
        const beforeSync = _engine;

        // Server is primary, always adopt it.
        _engine = fromServer;
        writeLocal(_engine);

        if (beforeSync !== fromServer && _engine !== prev) {
          dispatchChange(_engine, prev, 'server');
        }
        return _engine;
      } catch (e) {
        // Server unreachable → fallback.
        const fallback = readLocal() || prev || DEFAULT_ENGINE;
        _engine = fallback;

        try {
          if (settingsApi && typeof settingsApi.patchLocal === 'function') {
            settingsApi.patchLocal({ editor: { engine: _engine } });
          }
        } catch (e2) {}

        if (_engine !== prev) {
          dispatchChange(_engine, prev, 'local-fallback');
        }

        return _engine;
      }
    })().finally(() => {
      _ensurePromise = null;
    });

    return _ensurePromise;
  }

  // Persist preferred engine.
  // - Tries PATCH /api/ui-settings first.
  // - If server patch fails, writes to localStorage fallback.
  async function set(nextEngine) {
    const next = normalizeEngine(nextEngine) || DEFAULT_ENGINE;
    const prev = get();
    if (next === prev) return prev;

    // Update local cache immediately.
    _engine = next;

    // Always write fallback so we can recover if API becomes unavailable later.
    writeLocal(_engine);

    // Keep settings cache coherent for consumers.
    try {
      const settingsApi = getSettingsApi();
      if (settingsApi && typeof settingsApi.patchLocal === 'function') {
        settingsApi.patchLocal({ editor: { engine: _engine } });
      }
    } catch (e) {}

    dispatchChange(_engine, prev, 'user');

    // Best-effort server persistence.
    const settingsApi = getSettingsApi();
    if (settingsApi && typeof settingsApi.patch === 'function') {
      try {
        await settingsApi.patch({ editor: { engine: _engine } });
        return _engine;
      } catch (e) {
        return _engine;
      }
    }

    return _engine;
  }

  function onChange(handler) {
    if (typeof handler !== 'function') return () => {};
    const fn = (ev) => {
      try { handler(ev && ev.detail ? ev.detail : {}); } catch (e) {}
    };
    try { document.addEventListener(EVENT_NAME, fn); } catch (e) {}
    return () => {
      try { document.removeEventListener(EVENT_NAME, fn); } catch (e) {}
    };
  }

  // Useful for debugging / manual resets.
  function resetFallback() {
    removeLocal();
  }

  XKeen.ui.editorEngine = XKeen.ui.editorEngine || {};
  XKeen.ui.editorEngine.EVENT = EVENT_NAME;
  XKeen.ui.editorEngine.VALID = VALID.slice();
  XKeen.ui.editorEngine.DEFAULT = DEFAULT_ENGINE;
  XKeen.ui.editorEngine.get = get;
  XKeen.ui.editorEngine.ensureLoaded = ensureLoaded;
  XKeen.ui.editorEngine.set = set;
  XKeen.ui.editorEngine.createFacade = createFacade;
  XKeen.ui.editorEngine.fromCodeMirror = fromCodeMirror;
  XKeen.ui.editorEngine.fromMonaco = fromMonaco;
  XKeen.ui.editorEngine.fromTextarea = fromTextarea;
  XKeen.ui.editorEngine.isFacade = isFacade;
  XKeen.ui.editorEngine.RUNTIME_CONTRACT_VERSION = RUNTIME_CONTRACT_VERSION;
  XKeen.ui.editorEngine.ensureSupport = ensureSupport;
  XKeen.ui.editorEngine.getRuntime = getRuntime;
  XKeen.ui.editorEngine.ensureRuntime = ensureRuntime;
  XKeen.ui.editorEngine.isExperimentalCodeMirror6Enabled = isExperimentalCodeMirror6Enabled;
  XKeen.ui.editorEngine.getCodeMirrorBackend = getCodeMirrorBackend;
  XKeen.ui.editorEngine.onChange = onChange;
  XKeen.ui.editorEngine.resetFallback = resetFallback;
  XKeen.ui.editorEngine.cloneViewState = cloneViewState;
  XKeen.ui.editorEngine.createViewStateStore = createViewStateStore;

  try { ensureSettingsBinding(); } catch (e) {}
})();

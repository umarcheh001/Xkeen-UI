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
  XKeen.ui = XKeen.ui || {};

  const VALID = ['codemirror', 'monaco'];
  const DEFAULT_ENGINE = 'codemirror';

  // Fallback-only key. Note: routing.js historically used its own key;
  // this global helper uses a separate key for new editors.
  const LS_KEY = 'xkeen.editor.engine';

  const EVENT_NAME = 'xkeen-editor-engine-change';

  let _engine = null;
  let _ensurePromise = null;

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

  function readFromSettingsCache() {
    try {
      if (!XKeen.ui.settings || typeof XKeen.ui.settings.get !== 'function') return null;
      const st = XKeen.ui.settings.get();
      return normalizeEngine(st && st.editor ? st.editor.engine : null);
    } catch (e) {
      return null;
    }
  }

  function settingsLoadedFromServer() {
    try {
      if (!XKeen.ui.settings || typeof XKeen.ui.settings.isLoadedFromServer !== 'function') return false;
      return !!XKeen.ui.settings.isLoadedFromServer();
    } catch (e) {
      return false;
    }
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
        if (XKeen.ui.settings && typeof XKeen.ui.settings.patchLocal === 'function') {
          XKeen.ui.settings.patchLocal({ editor: { engine: _engine } });
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

      // If settings helper is missing, we can only use fallback.
      if (!XKeen.ui.settings || typeof XKeen.ui.settings.fetchOnce !== 'function') {
        return get();
      }

      try {
        const st = await XKeen.ui.settings.fetchOnce();
        const fromServer = normalizeEngine(st && st.editor ? st.editor.engine : null) || DEFAULT_ENGINE;

        // Server is primary, always adopt it.
        _engine = fromServer;
        writeLocal(_engine);

        if (_engine !== prev) {
          dispatchChange(_engine, prev, 'server');
        }
        return _engine;
      } catch (e) {
        // Server unreachable → fallback.
        const fallback = readLocal() || prev || DEFAULT_ENGINE;
        _engine = fallback;

        try {
          if (XKeen.ui.settings && typeof XKeen.ui.settings.patchLocal === 'function') {
            XKeen.ui.settings.patchLocal({ editor: { engine: _engine } });
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
      if (XKeen.ui.settings && typeof XKeen.ui.settings.patchLocal === 'function') {
        XKeen.ui.settings.patchLocal({ editor: { engine: _engine } });
      }
    } catch (e) {}

    dispatchChange(_engine, prev, 'user');

    // Best-effort server persistence.
    if (XKeen.ui.settings && typeof XKeen.ui.settings.patch === 'function') {
      try {
        await XKeen.ui.settings.patch({ editor: { engine: _engine } });
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
  XKeen.ui.editorEngine.onChange = onChange;
  XKeen.ui.editorEngine.resetFallback = resetFallback;
})();

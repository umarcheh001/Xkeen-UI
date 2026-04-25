(() => {
  // Server-side UI settings (GET/PATCH /api/ui-settings)
  //
  // This file is intentionally feature-neutral:
  // - it does NOT auto-fetch anything from the server
  // - it only provides a small helper API for future commits
  //
  // Usage (future):
  //   const s = XKeen.ui.settings.get();
  //   await XKeen.ui.settings.fetch();
  //   await XKeen.ui.settings.patch({ logs: { ansi: true } });

  window.XKeen = window.XKeen || {};
  const XKeen = window.XKeen;
  XKeen.ui = XKeen.ui || {};
  XKeen.core = XKeen.core || {};

  // Keep defaults in sync with services/ui_settings.py
  const DEFAULTS = {
    schemaVersion: 2,
    editor: {
      engine: 'codemirror',
      codemirrorFontScale: 100,
      monacoFontScale: 100,
      schemaHoverEnabled: true,
      beginnerModeEnabled: true,
      expertModeEnabled: false,
    },
    format: {
      preferPrettier: false,
      // Optional Prettier formatting parameters
      tabWidth: 2,
      printWidth: 80,
    },
    logs: {
      ansi: false,
      ws2: false,
      // Xray logs view preferences (migrated from localStorage in Commit 14)
      view: {},
    },
    routing: {
      guiEnabled: false,
      autoApply: false,
    },
  };

  // Simple deep clone for JSON-like values.
  // IMPORTANT: must preserve falsy primitives (false/0/""), otherwise
  // settings toggles will "stick" to true due to {} being truthy.
  function clone(v) {
    // Preserve primitives (including falsy).
    if (v === null || v === undefined) return v;
    const t = typeof v;
    if (t !== 'object') return v;

    try {
      return JSON.parse(JSON.stringify(v));
    } catch (e) {
      // Best-effort fallback.
      return Array.isArray(v) ? [] : {};
    }
  }

  function csrfToken() {
    try {
      const el = document.querySelector('meta[name="csrf-token"]');
      const v = el ? (el.getAttribute('content') || '') : '';
      return v ? String(v) : '';
    } catch (e) {
      return '';
    }
  }

  function getHttpApi() {
    try {
      if (XKeen.core && XKeen.core.http) return XKeen.core.http;
    } catch (e) {}
    return null;
  }

  function getUiSettingsStoreApi() {
    try {
      const api = XKeen.core && XKeen.core.uiSettings;
      if (!api) return null;
      if (typeof api.getState !== 'function' || typeof api.setState !== 'function') return null;
      return api;
    } catch (e) {
      return null;
    }
  }


  function clampEditorFontScale(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return 100;
    return Math.max(75, Math.min(200, Math.round(num)));
  }

  function getEditorFontScale(settings, engine) {
    try {
      const editor = (settings && settings.editor && typeof settings.editor === 'object') ? settings.editor : {};
      const kind = String(engine || '').trim().toLowerCase();
      if (kind === 'monaco' && Object.prototype.hasOwnProperty.call(editor, 'monacoFontScale')) {
        return clampEditorFontScale(editor.monacoFontScale);
      }
      if ((kind === 'codemirror' || kind === 'cm6' || kind === 'cm') && Object.prototype.hasOwnProperty.call(editor, 'codemirrorFontScale')) {
        return clampEditorFontScale(editor.codemirrorFontScale);
      }
      if (Object.prototype.hasOwnProperty.call(editor, 'fontScale')) {
        return clampEditorFontScale(editor.fontScale);
      }
    } catch (e) {}
    return 100;
  }

  function isEditorExpertModeEnabled(settings) {
    try {
      const snapshot = (settings && typeof settings === 'object') ? settings : get();
      const editor = (snapshot && snapshot.editor && typeof snapshot.editor === 'object') ? snapshot.editor : {};
      return editor.expertModeEnabled === true;
    } catch (e) {}
    return false;
  }

  function applyEditorCssVars(settings) {
    try {
      const root = document && document.documentElement;
      if (!root || !root.style) return;
      const scale = getEditorFontScale(settings, 'codemirror');
      const fontSize = Math.max(12, Math.round(15 * (scale / 100)));
      const lineHeight = Math.max(18, Math.round(fontSize * 1.68));
      root.style.setProperty('--xk-editor-font-scale', String(scale / 100));
      root.style.setProperty('--xk-editor-font-size', String(fontSize) + 'px');
      root.style.setProperty('--xk-editor-line-height', String(lineHeight) + 'px');
      root.style.setProperty('--xk-cm-editor-font-scale', String(scale / 100));
      root.style.setProperty('--xk-cm-editor-font-size', String(fontSize) + 'px');
      root.style.setProperty('--xk-cm-editor-line-height', String(lineHeight) + 'px');
    } catch (e) {}
  }

  // Minimal deep-merge for JSON-like objects.
  // Arrays are replaced, not merged.
  function deepMerge(base, patch) {
    const a = (base && typeof base === 'object') ? base : {};
    const b = (patch && typeof patch === 'object') ? patch : {};

    // Arrays: replace
    if (Array.isArray(a) || Array.isArray(b)) {
      return clone(Array.isArray(b) ? b : a);
    }

    const out = Object.assign({}, a);
    for (const k of Object.keys(b)) {
      const av = out[k];
      const bv = b[k];

      if (
        av && bv &&
        typeof av === 'object' && typeof bv === 'object' &&
        !Array.isArray(av) && !Array.isArray(bv)
      ) {
        out[k] = deepMerge(av, bv);
      } else {
        out[k] = clone(bv);
      }
    }
    return out;
  }

  let _cache = null;
  let _loadedFromServer = false;
  let _fetchOncePromise = null;

  function _ensureCache() {
    const store = getUiSettingsStoreApi();
    if (store && typeof store.getSnapshot === 'function') {
      const snapshot = store.getSnapshot();
      return deepMerge(DEFAULTS, (snapshot && typeof snapshot === 'object') ? snapshot : {});
    }

    if (!_cache || typeof _cache !== 'object') {
      _cache = clone(DEFAULTS);
    }
    return _cache;
  }

  function get() {
    return clone(_ensureCache());
  }

  function isLoadedFromServer() {
    const store = getUiSettingsStoreApi();
    if (store && typeof store.isLoadedFromServer === 'function') {
      return !!store.isLoadedFromServer();
    }
    return !!_loadedFromServer;
  }

  function emitSettingsChanged(settings, source) {
    try {
      document.dispatchEvent(new CustomEvent('xkeen:ui-settings-changed', {
        detail: {
          settings: clone(settings),
          source: source || 'settings',
        }
      }));
    } catch (e) {}
  }

  function applySnapshot(cfg, options) {
    const opts = (options && typeof options === 'object') ? options : {};
    const merged = deepMerge(DEFAULTS, (cfg && typeof cfg === 'object') ? cfg : {});
    const loaded = Object.prototype.hasOwnProperty.call(opts, 'loadedFromServer')
      ? !!opts.loadedFromServer
      : isLoadedFromServer();
    const store = getUiSettingsStoreApi();

    if (store) {
      store.setState({
        snapshot: merged,
        loadedFromServer: loaded,
      }, {
        source: opts.source || 'settings',
      });
    } else {
      _cache = merged;
      _loadedFromServer = loaded;
    }

    applyEditorCssVars(merged);
    emitSettingsChanged(merged, opts.source || 'settings');
    return clone(merged);
  }

  // Local-only setter (no server call). Useful for tests or forced overrides.
  function setLocal(cfg) {
    return applySnapshot(cfg, {
      loadedFromServer: isLoadedFromServer(),
      source: 'setLocal',
    });
  }

  // Local-only patch (no server call).
  function patchLocal(patch) {
    const merged = deepMerge(_ensureCache(), (patch && typeof patch === 'object') ? patch : {});
    return applySnapshot(merged, {
      loadedFromServer: isLoadedFromServer(),
      source: 'patchLocal',
    });
  }

  async function fetchFromServer() {
    const http = getHttpApi();
    let data = null;

    if (http && typeof http.fetchJSON === 'function') {
      data = await http.fetchJSON('/api/ui-settings', {
        method: 'GET',
        headers: { Accept: 'application/json' },
        timeoutMs: 8000,
        retry: 1,
      });
    } else {
      const res = await fetch('/api/ui-settings', {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
        },
      });

      if (!res.ok) {
        throw new Error('Failed to load UI settings');
      }
      data = await res.json();
    }

    if (!data || data.ok !== true || !data.settings || typeof data.settings !== 'object') {
      throw new Error('Bad UI settings response');
    }

    return applySnapshot(data.settings, {
      loadedFromServer: true,
      source: 'fetch',
    });
  }

  // One-shot loader: de-duplicates parallel GET calls and caches the result.
  // - If settings were already loaded from server, it resolves immediately.
  // - If a fetch is already in-flight, it returns the same promise.
  // - On failure, the in-flight promise is cleared so the next call can retry.
  function fetchOnceFromServer() {
    if (isLoadedFromServer()) {
      return Promise.resolve(get());
    }
    if (_fetchOncePromise) {
      return _fetchOncePromise;
    }

    _fetchOncePromise = fetchFromServer()
      .finally(() => {
        _fetchOncePromise = null;
      });

    return _fetchOncePromise;
  }

  async function patchToServer(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new Error('Patch must be an object');
    }

    const http = getHttpApi();
    let data = null;

    if (http && typeof http.patchJSON === 'function') {
      data = await http.patchJSON('/api/ui-settings', patch, {
        headers: { Accept: 'application/json' },
        timeoutMs: 8000,
      });
    } else {
      const headers = {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      };
      const tok = csrfToken();
      if (tok) headers['X-CSRF-Token'] = tok;

      const res = await fetch('/api/ui-settings', {
        method: 'PATCH',
        headers,
        body: JSON.stringify(patch),
      });

      if (!res.ok) {
        let msg = 'Failed to patch UI settings';
        try {
          const errData = await res.json();
          if (errData && errData.error) msg = String(errData.error);
        } catch (e) {}
        throw new Error(msg);
      }

      data = await res.json();
    }

    if (!data || data.ok !== true || !data.settings || typeof data.settings !== 'object') {
      throw new Error('Bad UI settings response');
    }

    return applySnapshot(data.settings, {
      loadedFromServer: true,
      source: 'patch',
    });
  }

  function subscribe(listener, options) {
    if (typeof listener !== 'function') return () => {};

    const store = getUiSettingsStoreApi();
    if (store && typeof store.subscribe === 'function') {
      return store.subscribe((nextState, prevState, meta) => {
        try {
          listener(
            clone(nextState && nextState.snapshot ? nextState.snapshot : DEFAULTS),
            clone(prevState && prevState.snapshot ? prevState.snapshot : DEFAULTS),
            Object.assign({}, meta, {
              loadedFromServer: !!(nextState && nextState.loadedFromServer),
            })
          );
        } catch (e) {}
      }, options);
    }

    let previous = get();

    if (options && options.immediate) {
      try {
        listener(previous, previous, {
          immediate: true,
          loadedFromServer: isLoadedFromServer(),
        });
      } catch (e) {}
    }

    const fn = (ev) => {
      const next = ev && ev.detail && ev.detail.settings ? clone(ev.detail.settings) : get();
      const prev = previous;
      previous = next;
      try {
        listener(next, prev, {
          source: ev && ev.detail && ev.detail.source ? ev.detail.source : 'event',
          loadedFromServer: isLoadedFromServer(),
        });
      } catch (e) {}
    };

    try { document.addEventListener('xkeen:ui-settings-changed', fn); } catch (e) {}
    return () => {
      try { document.removeEventListener('xkeen:ui-settings-changed', fn); } catch (e) {}
    };
  }

  try { applyEditorCssVars(_ensureCache()); } catch (e) {}

  XKeen.ui.settings = XKeen.ui.settings || {};
  XKeen.ui.settings.DEFAULTS = clone(DEFAULTS);
  XKeen.ui.settings.get = get;
  XKeen.ui.settings.isLoadedFromServer = isLoadedFromServer;
  XKeen.ui.settings.setLocal = setLocal;
  XKeen.ui.settings.patchLocal = patchLocal;
  XKeen.ui.settings.fetch = fetchFromServer;
  XKeen.ui.settings.fetchOnce = fetchOnceFromServer;
  XKeen.ui.settings.patch = patchToServer;
  XKeen.ui.settings.subscribe = subscribe;
  XKeen.ui.settings.clampEditorFontScale = clampEditorFontScale;
  XKeen.ui.settings.getEditorFontScale = getEditorFontScale;
  XKeen.ui.settings.isEditorExpertModeEnabled = isEditorExpertModeEnabled;
})();

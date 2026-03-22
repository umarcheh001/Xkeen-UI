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
  XKeen.ui = XKeen.ui || {};
  XKeen.core = XKeen.core || {};

  // Keep defaults in sync with services/ui_settings.py
  const DEFAULTS = {
    schemaVersion: 1,
    editor: {
      engine: 'codemirror',
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
    if (!_cache || typeof _cache !== 'object') {
      _cache = clone(DEFAULTS);
    }
    return _cache;
  }

  function get() {
    return clone(_ensureCache());
  }

  function isLoadedFromServer() {
    return !!_loadedFromServer;
  }

  // Local-only setter (no server call). Useful for tests or forced overrides.
  function setLocal(cfg) {
    const merged = deepMerge(DEFAULTS, (cfg && typeof cfg === 'object') ? cfg : {});
    _cache = merged;
    // Notify listeners (e.g. live logs) that effective settings have changed.
    try {
      document.dispatchEvent(new CustomEvent('xkeen:ui-settings-changed', {
        detail: { settings: get(), source: 'setLocal' }
      }));
    } catch (e) {}
    return get();
  }

  // Local-only patch (no server call).
  function patchLocal(patch) {
    const merged = deepMerge(_ensureCache(), (patch && typeof patch === 'object') ? patch : {});
    _cache = merged;
    // Notify listeners (e.g. live logs) that effective settings have changed.
    try {
      document.dispatchEvent(new CustomEvent('xkeen:ui-settings-changed', {
        detail: { settings: get(), source: 'patchLocal' }
      }));
    } catch (e) {}
    return get();
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

    _loadedFromServer = true;
    return setLocal(data.settings);
  }

  // One-shot loader: de-duplicates parallel GET calls and caches the result.
  // - If settings were already loaded from server, it resolves immediately.
  // - If a fetch is already in-flight, it returns the same promise.
  // - On failure, the in-flight promise is cleared so the next call can retry.
  function fetchOnceFromServer() {
    if (_loadedFromServer) {
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

    _loadedFromServer = true;
    return setLocal(data.settings);
  }

  XKeen.ui.settings = XKeen.ui.settings || {};
  XKeen.ui.settings.DEFAULTS = clone(DEFAULTS);
  XKeen.ui.settings.get = get;
  XKeen.ui.settings.isLoadedFromServer = isLoadedFromServer;
  XKeen.ui.settings.setLocal = setLocal;
  XKeen.ui.settings.patchLocal = patchLocal;
  XKeen.ui.settings.fetch = fetchFromServer;
  XKeen.ui.settings.fetchOnce = fetchOnceFromServer;
  XKeen.ui.settings.patch = patchToServer;
})();

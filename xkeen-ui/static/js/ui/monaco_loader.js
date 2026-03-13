(() => {
  'use strict';

  // Lazy Monaco Editor (AMD) loader.
  // Local-only loader; never fetches Monaco from external CDNs.

  window.XKeen = window.XKeen || {};
  const XK = window.XKeen;
  XK.monacoLoader = XK.monacoLoader || {};

  const L = XK.monacoLoader;
  // ------------------------ base paths ------------------------
  // Keep Monaco on a fixed local path. Avoid guessing from <script src> or runtime path
  // mangling, because on some installs that produced broken URLs like /static/monaco--/vs.
  const STATIC_ROOT = '/static/';

  // ------------------------ config ------------------------
  const DEFAULT_VERSION = '0.55.1';

  // You can override at runtime before calling any loader methods:
  // window.XKeenMonacoConfig = { version: '0.55.1', prefer: 'local', localVsPaths: [...] }
  const _cfg = {
    version: DEFAULT_VERSION,
    prefer: 'local', // local-only
    // Local AMD loader candidates (vs/loader.js):
    //   - If later you add a local copy, place it under /static/monaco-editor/...
    localVsPaths: [
      STATIC_ROOT + 'monaco-editor/vs',
    ],
  };

  function applyExternalConfig() {
    try {
      const ext = window.XKeenMonacoConfig;
      if (!ext || typeof ext !== 'object') return;
      if (typeof ext.version === 'string' && ext.version.trim()) _cfg.version = ext.version.trim();
      _cfg.prefer = 'local';
      if (Array.isArray(ext.localVsPaths) && ext.localVsPaths.length) {
        const sane = ext.localVsPaths
          .map((v) => String(v || '').trim().replace(/\/+$/, ''))
          .filter((v) => v === '/static/monaco-editor/vs' || v.endsWith('/static/monaco-editor/vs'));
        if (sane.length) _cfg.localVsPaths = sane;
      }
    } catch (e) {}
  }

  applyExternalConfig();

  L.getConfig = function getConfig() {
    return JSON.parse(JSON.stringify(_cfg));
  };

  L.setConfig = function setConfig(patch) {
    if (!patch || typeof patch !== 'object') return L.getConfig();
    if (typeof patch.version === 'string' && patch.version.trim()) _cfg.version = patch.version.trim();
    _cfg.prefer = 'local';
    if (Array.isArray(patch.localVsPaths) && patch.localVsPaths.length) {
      const sane = patch.localVsPaths
        .map((v) => String(v || '').trim().replace(/\/+$/, ''))
        .filter((v) => v === '/static/monaco-editor/vs' || v.endsWith('/static/monaco-editor/vs'));
      if (sane.length) _cfg.localVsPaths = sane;
    }
    return L.getConfig();
  };

  // ------------------------ loaders (cached) ------------------------
  const _js = new Map();

  function alreadyPresentScript(src) {
    try {
      const abs = new URL(src, window.location.href).toString();
      const nodes = document.querySelectorAll('script[src]');
      for (const n of nodes) {
        try {
          const s = new URL(n.src, window.location.href).toString();
          if (s === abs) return true;
        } catch (e) {}
      }
    } catch (e) {}
    return false;
  }

  function loadScriptOnce(src) {
    const url = String(src || '');
    if (!url) return Promise.resolve(false);

    // Prefer reusing the shared loader if present.
    try {
      if (XK.cmLoader && typeof XK.cmLoader.loadScriptOnce === 'function') {
        return XK.cmLoader.loadScriptOnce(url);
      }
    } catch (e) {}

    if (_js.has(url)) return _js.get(url);
    if (alreadyPresentScript(url)) {
      const p = Promise.resolve(true);
      _js.set(url, p);
      return p;
    }

    // Important: on flaky / blocked networks, <script> can hang for a long time without firing onerror.
    // Add a soft timeout so we can fall back to the next candidate quickly.
    const TIMEOUT_MS = 4500;

    const p = new Promise((resolve) => {
      let done = false;
      let timer = null;
      let s = null;

      const finish = (ok) => {
        if (done) return;
        done = true;
        try { if (timer) clearTimeout(timer); } catch (e) {}
        // If we timed out, remove the script tag to reduce the chance of late onload racing.
        try { if (!ok && s && s.parentNode) s.parentNode.removeChild(s); } catch (e) {}
        resolve(!!ok);
      };

      try {
        s = document.createElement('script');
        s.src = url;
        s.async = true;
        s.onload = () => finish(true);
        s.onerror = () => finish(false);
        document.head.appendChild(s);

        timer = setTimeout(() => finish(false), TIMEOUT_MS);
      } catch (e) {
        finish(false);
      }
    });

    _js.set(url, p);
    return p;
  }

  // ------------------------ URL helpers ------------------------

  function localCandidates() {
    const bases = Array.isArray(_cfg.localVsPaths) ? _cfg.localVsPaths : [];
    const out = [];
    for (const b of bases) {
      const base = String(b || '').replace(/\/+$/, '');
      if (!base) continue;
      out.push({
        loader: base + '/loader.js',
        vsBase: base,
        provider: 'local',
      });
    }
    return out;
  }

  // ------------------------ public API ------------------------
  let _configuredPromise = null;
  let _configured = false;
  let _activeSource = null; // { provider, loader, vsBase }
  let _monacoPromise = null;

  function hasMonacoApi() {
    try {
      return !!(window.monaco && window.monaco.editor && typeof window.monaco.editor.create === 'function');
    } catch (e) {}
    return false;
  }

  L.getPaths = function getPaths() {
    return {
      staticRoot: STATIC_ROOT,
      localVsBases: (Array.isArray(_cfg.localVsPaths) ? _cfg.localVsPaths.slice(0) : []),
    };
  };

  L.getActiveSource = function getActiveSource() {
    return _activeSource ? Object.assign({}, _activeSource) : null;
  };

  // Loads local AMD loader (vs/loader.js) and configures require() paths.
  // Returns { ok, provider, vsBase, loader }.
  L.ensureConfigured = async function ensureConfigured() {
    if (_configured) {
      return { ok: true, ...(L.getActiveSource() || {}) };
    }
    if (_configuredPromise) return _configuredPromise;

    _configuredPromise = (async () => {
      applyExternalConfig();

      // If require is already configured externally, respect it.
      try {
        if (window.require && typeof window.require === 'function' && window.require.config && window.monaco) {
          _configured = true;
          _activeSource = _activeSource || { provider: 'external', loader: '', vsBase: '' };
          return { ok: true, provider: 'external', vsBase: '', loader: '' };
        }
      } catch (e) {}

      const candidates = localCandidates();

      for (const c of candidates) {
        const ok = await loadScriptOnce(c.loader);
        if (!ok) continue;

        // AMD loader defines global require/define.
        try {
          if (window.require && typeof window.require.config === 'function') {
            window.require.config({
              paths: {
                vs: c.vsBase,
              },
              ignoreDuplicateModules: [
                'vs/basic-languages/monaco.contribution',
                'vs/language/json/monaco.contribution',
              ],
            });
            _configured = true;
            _activeSource = { provider: c.provider, loader: c.loader, vsBase: c.vsBase };
            return { ok: true, provider: c.provider, loader: c.loader, vsBase: c.vsBase };
          }
        } catch (e) {
          // If config fails, keep trying other candidates.
        }
      }

      _configured = false;
      _activeSource = null;
      return { ok: false, provider: '', loader: '', vsBase: '' };
    })();

    return _configuredPromise;
  };

  // Ensures Monaco's editor main module is loaded.
  // Returns window.monaco or null.
  L.ensureMonaco = async function ensureMonaco() {
    if (hasMonacoApi()) return window.monaco;
    if (_monacoPromise) return _monacoPromise;

    _monacoPromise = (async () => {
      const st = await L.ensureConfigured();
      if (!st || !st.ok) return null;
      if (hasMonacoApi()) return window.monaco;

      // Monaco main module.
      return await new Promise((resolve) => {
        const TIMEOUT_MS = 4500;
        let done = false;
        let timer = null;
        const finish = (v) => {
          if (done) return;
          done = true;
          try { if (timer) clearTimeout(timer); } catch (e) {}
          resolve(v);
        };

        try {
          if (!window.require) return finish(null);
          timer = setTimeout(() => finish(null), TIMEOUT_MS);
          window.require(['vs/editor/editor.main'], () => {
            finish(window.monaco || null);
          }, () => finish(null));
        } catch (e) {
          finish(null);
        }
      });
    })();

    try {
      return await _monacoPromise;
    } finally {
      if (!hasMonacoApi()) _monacoPromise = null;
    }
  };
})();

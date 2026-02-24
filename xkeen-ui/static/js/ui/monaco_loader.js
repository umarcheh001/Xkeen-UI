(() => {
  'use strict';

  // Lazy Monaco Editor (AMD) loader.
  // CDN-first with safe fallbacks; does nothing unless explicitly called.

  window.XKeen = window.XKeen || {};
  const XK = window.XKeen;
  XK.monacoLoader = XK.monacoLoader || {};

  const L = XK.monacoLoader;

  // ------------------------ base paths ------------------------
  function guessStaticRoot() {
    try {
      const cs = document.currentScript;
      if (cs && cs.src) {
        const u = new URL(cs.src, window.location.href);
        const p = String(u.pathname || '');
        const idx = p.indexOf('/static/');
        if (idx >= 0) return p.slice(0, idx + '/static/'.length);
      }
    } catch (e) {}
    return '/static/';
  }

  const STATIC_ROOT = guessStaticRoot();

  // ------------------------ config ------------------------
  const DEFAULT_VERSION = '0.52.2';

  // You can override at runtime before calling any loader methods:
  // window.XKeenMonacoConfig = { version: '0.52.2', prefer: 'cdn', cdn: ['jsdelivr', 'unpkg'], localVsPaths: [...] }
  const _cfg = {
    version: DEFAULT_VERSION,
    prefer: 'cdn', // 'cdn' | 'local'
    cdn: ['jsdelivr', 'unpkg'],
    // Local AMD loader candidates (vs/loader.min.js):
    //   - If later you add a local copy, place it under /static/monaco-editor/...
    localVsPaths: [
      STATIC_ROOT + 'monaco-editor/vs',
      STATIC_ROOT + 'monaco/vs',
    ],
  };

  function applyExternalConfig() {
    try {
      const ext = window.XKeenMonacoConfig;
      if (!ext || typeof ext !== 'object') return;
      if (typeof ext.version === 'string' && ext.version.trim()) _cfg.version = ext.version.trim();
      if (ext.prefer === 'cdn' || ext.prefer === 'local') _cfg.prefer = ext.prefer;
      if (Array.isArray(ext.cdn) && ext.cdn.length) _cfg.cdn = ext.cdn.slice(0);
      if (Array.isArray(ext.localVsPaths) && ext.localVsPaths.length) _cfg.localVsPaths = ext.localVsPaths.slice(0);
    } catch (e) {}
  }

  applyExternalConfig();

  L.getConfig = function getConfig() {
    return JSON.parse(JSON.stringify(_cfg));
  };

  L.setConfig = function setConfig(patch) {
    if (!patch || typeof patch !== 'object') return L.getConfig();
    if (typeof patch.version === 'string' && patch.version.trim()) _cfg.version = patch.version.trim();
    if (patch.prefer === 'cdn' || patch.prefer === 'local') _cfg.prefer = patch.prefer;
    if (Array.isArray(patch.cdn) && patch.cdn.length) _cfg.cdn = patch.cdn.slice(0);
    if (Array.isArray(patch.localVsPaths) && patch.localVsPaths.length) _cfg.localVsPaths = patch.localVsPaths.slice(0);
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
  function cdnCandidates(version) {
    const v = String(version || DEFAULT_VERSION).trim() || DEFAULT_VERSION;
    const out = [];

    const wanted = Array.isArray(_cfg.cdn) ? _cfg.cdn : [];
    for (const p of wanted) {
      const prov = String(p || '').toLowerCase();
      if (prov === 'jsdelivr') {
        out.push({
          loader: `https://cdn.jsdelivr.net/npm/monaco-editor@${v}/min/vs/loader.min.js`,
          vsBase: `https://cdn.jsdelivr.net/npm/monaco-editor@${v}/min/vs`,
          provider: 'jsdelivr',
        });
      } else if (prov === 'unpkg') {
        out.push({
          loader: `https://unpkg.com/monaco-editor@${v}/min/vs/loader.min.js`,
          vsBase: `https://unpkg.com/monaco-editor@${v}/min/vs`,
          provider: 'unpkg',
        });
      } else if (prov === 'cdnjs') {
        // cdnjs URL patterns can differ by version; keep as an optional provider only.
        out.push({
          loader: `https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/${v}/min/vs/loader.min.js`,
          vsBase: `https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/${v}/min/vs`,
          provider: 'cdnjs',
        });
      }
    }

    return out;
  }

  function localCandidates() {
    const bases = Array.isArray(_cfg.localVsPaths) ? _cfg.localVsPaths : [];
    const out = [];
    for (const b of bases) {
      const base = String(b || '').replace(/\/+$/, '');
      if (!base) continue;
      out.push({
        loader: base + '/loader.min.js',
        vsBase: base,
        provider: 'local',
      });
      // Some builds ship loader.js (unminified)
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

  L.getPaths = function getPaths() {
    return {
      staticRoot: STATIC_ROOT,
      localVsBases: (Array.isArray(_cfg.localVsPaths) ? _cfg.localVsPaths.slice(0) : []),
    };
  };

  L.getActiveSource = function getActiveSource() {
    return _activeSource ? Object.assign({}, _activeSource) : null;
  };

  // Loads AMD loader (vs/loader.min.js) and configures require() paths.
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

      const prefer = _cfg.prefer === 'local' ? 'local' : 'cdn';
      const candidates = [];

      const local = localCandidates();
      const cdn = cdnCandidates(_cfg.version);

      if (prefer === 'local') {
        candidates.push(...local, ...cdn);
      } else {
        candidates.push(...cdn, ...local);
      }

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
    const st = await L.ensureConfigured();
    if (!st || !st.ok) return null;

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
  };
})();

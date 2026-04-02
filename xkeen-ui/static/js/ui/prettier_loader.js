(() => {
  'use strict';

  // Lazy Prettier (standalone) loader.
  // Local-first (offline friendly) with CDN fallbacks.
  // Does nothing unless explicitly called.

  window.XKeen = window.XKeen || {};
  const XK = window.XKeen;
  XK.prettierLoader = XK.prettierLoader || {};

  const L = XK.prettierLoader;

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
  const LOCAL_BASE = STATIC_ROOT + 'vendor/prettier';

  // ------------------------ config ------------------------
  const DEFAULT_VERSION = '3.8.1';

  // You can override at runtime before calling any loader methods:
  // window.XKeenPrettierConfig = { version: '3.8.1', prefer: 'local', cdn: ['jsdelivr','unpkg'], timeoutMs: 8000 }
  const _cfg = {
    version: DEFAULT_VERSION,
    prefer: 'local', // 'local' | 'cdn'
    cdn: ['jsdelivr', 'unpkg'],
    // Routers can be slow; keep this reasonably high.
    timeoutMs: 8000,
  };

  function applyExternalConfig() {
    try {
      const ext = window.XKeenPrettierConfig;
      if (!ext || typeof ext !== 'object') return;
      if (typeof ext.version === 'string' && ext.version.trim()) _cfg.version = ext.version.trim();
      if (ext.prefer === 'local' || ext.prefer === 'cdn') _cfg.prefer = ext.prefer;
      if (Array.isArray(ext.cdn) && ext.cdn.length) _cfg.cdn = ext.cdn.slice(0);
      if (Number.isFinite(ext.timeoutMs) && ext.timeoutMs > 0) _cfg.timeoutMs = Number(ext.timeoutMs);
    } catch (e) {}
  }

  applyExternalConfig();

  L.getConfig = function getConfig() {
    return JSON.parse(JSON.stringify(_cfg));
  };

  L.setConfig = function setConfig(patch) {
    if (!patch || typeof patch !== 'object') return L.getConfig();
    if (typeof patch.version === 'string' && patch.version.trim()) _cfg.version = patch.version.trim();
    if (patch.prefer === 'local' || patch.prefer === 'cdn') _cfg.prefer = patch.prefer;
    if (Array.isArray(patch.cdn) && patch.cdn.length) _cfg.cdn = patch.cdn.slice(0);
    if (Number.isFinite(patch.timeoutMs) && patch.timeoutMs > 0) _cfg.timeoutMs = Number(patch.timeoutMs);
    return L.getConfig();
  };

  // ------------------------ loaders (shared) ------------------------
  // NOTE: Prettier's UMD wrapper prefers AMD/CommonJS if it detects them.
  // Monaco (AMD loader) can introduce `define.amd`, causing Prettier to NOT
  // attach to `window.prettier` / `window.prettierPlugins`.
  // To keep Prettier predictable, we eval local scripts in an isolated scope
  // where `define/module/exports` are undefined.

  const _js = new Map();

  function isSameOrigin(url) {
    try {
      const u = new URL(String(url || ''), window.location.href);
      return u.origin === window.location.origin;
    } catch (e) {
      return false;
    }
  }

  function looksLikeLocalStatic(url) {
    const u = String(url || '');
    if (!u) return false;
    if (!isSameOrigin(u)) return false;
    try {
      const abs = new URL(u, window.location.href).pathname;
      return abs.includes('/static/');
    } catch (e) {
      return u.includes('/static/');
    }
  }

  async function evalAsGlobalNoAMD(url) {
    try {
      const res = await fetch(String(url), { cache: 'force-cache' });
      if (!res || !res.ok) return false;
      const code = await res.text();
      // Shadow AMD/CommonJS globals so Prettier uses globalThis/window path.
      // eslint-disable-next-line no-new-func
      const fn = new Function(
        'exports',
        'module',
        'define',
        'globalThis',
        'self',
        'window',
        code + '\n//# sourceURL=' + String(url).replace(/\s/g, '%20')
      );
      fn(undefined, undefined, undefined, window, window, window);
      return true;
    } catch (e) {
      return false;
    }
  }

  function loadScriptOnce(src) {
    const url = String(src || '');
    if (!url) return Promise.resolve(false);

    if (_js.has(url)) return _js.get(url);

    const p = evalAsGlobalNoAMD(url);

    _js.set(url, p);
    return p;
  }

  function withTimeout(promise, ms) {
    const t = Number(ms) || 0;
    if (!t) return promise;
    return Promise.race([
      promise,
      new Promise((resolve) => setTimeout(() => resolve(false), t)),
    ]);
  }

  // ------------------------ URL helpers ------------------------
  function localSource() {
    return {
      provider: 'local',
      standalone: LOCAL_BASE + '/standalone.js',
      plugins: {
        babel: LOCAL_BASE + '/plugins/babel.js',
        estree: LOCAL_BASE + '/plugins/estree.js',
        yaml: LOCAL_BASE + '/plugins/yaml.js',
      },
    };
  }

  function cdnSources(version) {
    const v = String(version || DEFAULT_VERSION).trim() || DEFAULT_VERSION;
    const out = [];
    const wanted = Array.isArray(_cfg.cdn) ? _cfg.cdn : [];
    for (const p of wanted) {
      const prov = String(p || '').toLowerCase();
      if (prov === 'jsdelivr') {
        out.push({
          provider: 'jsdelivr',
          standalone: `https://cdn.jsdelivr.net/npm/prettier@${v}/standalone.js`,
          plugins: {
            babel: `https://cdn.jsdelivr.net/npm/prettier@${v}/plugins/babel.js`,
            estree: `https://cdn.jsdelivr.net/npm/prettier@${v}/plugins/estree.js`,
            yaml: `https://cdn.jsdelivr.net/npm/prettier@${v}/plugins/yaml.js`,
          },
        });
      } else if (prov === 'unpkg') {
        out.push({
          provider: 'unpkg',
          standalone: `https://unpkg.com/prettier@${v}/standalone.js`,
          plugins: {
            babel: `https://unpkg.com/prettier@${v}/plugins/babel.js`,
            estree: `https://unpkg.com/prettier@${v}/plugins/estree.js`,
            yaml: `https://unpkg.com/prettier@${v}/plugins/yaml.js`,
          },
        });
      }
    }
    return out;
  }

  function isReadyFor(required) {
    try {
      if (!window.prettier || typeof window.prettier.format !== 'function') return false;
      const pp = window.prettierPlugins;
      if (!pp || typeof pp !== 'object') return false;
      const req = Array.isArray(required) ? required : [];
      for (const k of req) {
        if (!pp[k]) return false;
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  // ------------------------ public API ------------------------
  let _activeSource = null;
  let _ensurePromise = null;

  L.getActiveSource = function getActiveSource() {
    return _activeSource ? Object.assign({}, _activeSource) : null;
  };

  // ensurePrettier({ json: true, yaml: false }) -> { prettier, plugins, source } | null
  L.ensurePrettier = async function ensurePrettier(opts) {
    const o = (opts && typeof opts === 'object') ? opts : {};
    const needJson = (o.json !== false);
    const needYaml = !!o.yaml;

    const required = [];
    if (needJson) required.push('babel', 'estree');
    if (needYaml) required.push('yaml');

    if (isReadyFor(required)) {
      return {
        prettier: window.prettier,
        plugins: window.prettierPlugins,
        source: L.getActiveSource(),
      };
    }

    if (_ensurePromise) return _ensurePromise;

    _ensurePromise = (async () => {
      const timeoutMs = Number(_cfg.timeoutMs) || 0;
      const sources = [];

      if (_cfg.prefer === 'local') {
        sources.push(localSource());
        sources.push(...cdnSources(_cfg.version));
      } else {
        sources.push(...cdnSources(_cfg.version));
        sources.push(localSource());
      }

      for (const src of sources) {
        try {
          // 1) standalone
          const okStandalone = await withTimeout(loadScriptOnce(src.standalone), timeoutMs);
          if (!okStandalone || !window.prettier) continue;

          // 2) required plugins
          const pluginKeys = [];
          if (needJson) pluginKeys.push('babel', 'estree');
          if (needYaml) pluginKeys.push('yaml');

          let okPlugins = true;
          for (const k of pluginKeys) {
            const url = (src.plugins && src.plugins[k]) ? src.plugins[k] : '';
            if (!url) { okPlugins = false; break; }
            const ok = await withTimeout(loadScriptOnce(url), timeoutMs);
            if (!ok) { okPlugins = false; break; }
          }

          if (!okPlugins) continue;

          if (!isReadyFor(required)) continue;

          _activeSource = {
            provider: src.provider,
            version: _cfg.version,
            prefer: _cfg.prefer,
          };

          return {
            prettier: window.prettier,
            plugins: window.prettierPlugins,
            source: L.getActiveSource(),
          };
        } catch (e) {
          // try next source
        }
      }

      return null;
    })();

    const res = await _ensurePromise;
    _ensurePromise = null;
    return res;
  };
})();

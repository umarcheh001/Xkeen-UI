(() => {
  'use strict';

  // Lazy Monaco Editor (AMD) loader.
  // Local-only loader; never fetches Monaco from external CDNs.

  window.XKeen = window.XKeen || {};
  const XK = window.XKeen;
  XK.monacoLoader = XK.monacoLoader || {};

  const L = XK.monacoLoader;
  // ------------------------ base paths ------------------------
  function guessStaticRoot() {
    try {
      const configured = (typeof window.XKEEN_STATIC_BASE === 'string' && window.XKEEN_STATIC_BASE)
        ? String(window.XKEEN_STATIC_BASE || '').trim()
        : '';
      if (configured) return configured.endsWith('/') ? configured : (configured + '/');
    } catch (e) {}

    try {
      const cs = document.currentScript;
      if (cs && cs.src) {
        const u = new URL(cs.src, window.location.href);
        const p = String(u.pathname || '');
        const idx = p.indexOf('/static/');
        if (idx >= 0) return p.slice(0, idx + '/static/'.length);
      }
    } catch (e2) {}

    return '/static/';
  }

  const STATIC_ROOT = guessStaticRoot();

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

  const SAFE_MONACO_DUPLICATE_MODULES = [
    'vs/_commonjsHelpers-CT9FvmAN',
    'vs/abap-D-t0cyap',
    'vs/apex-CcIm7xu6',
    'vs/azcli-BA0tQDCg',
    'vs/bat-C397hTD6',
    'vs/bicep-DF5aW17k',
    'vs/cameligo-plsz8qhj',
    'vs/clojure-Y2auQMzK',
    'vs/coffee-Bu45yuWE',
    'vs/cpp-CkKPQIni',
    'vs/csharp-CX28MZyh',
    'vs/csp-D8uWnyxW',
    'vs/css-CaeNmE3S',
    'vs/cssMode-CjiAH6dQ',
    'vs/cypher-DVThT8BS',
    'vs/dart-CmGfCvrO',
    'vs/dockerfile-CZqqYdch',
    'vs/ecl-30fUercY',
    'vs/editor.api-CalNCsUg',
    'vs/elixir-xjPaIfzF',
    'vs/flow9-DqtmStfK',
    'vs/freemarker2-Cz_sV6Md',
    'vs/fsharp-BOMdg4U1',
    'vs/go-D_hbi-Jt',
    'vs/graphql-CKUU4kLG',
    'vs/handlebars-OwglfO-1',
    'vs/hcl-DTaboeZW',
    'vs/html-Pa1xEWsY',
    'vs/htmlMode-Bz67EXwp',
    'vs/ini-CsNwO04R',
    'vs/java-CI4ZMsH9',
    'vs/javascript-PczUCGdz',
    'vs/jsonMode-DULH5oaX',
    'vs/julia-BwzEvaQw',
    'vs/kotlin-IUYPiTV8',
    'vs/less-C0eDYdqa',
    'vs/lexon-iON-Kj97',
    'vs/liquid-DqKjdPGy',
    'vs/lspLanguageFeatures-kM9O9rjY',
    'vs/lua-DtygF91M',
    'vs/m3-CsR4AuFi',
    'vs/markdown-C_rD0bIw',
    'vs/mdx-DEWtB1K5',
    'vs/mips-CiYP61RB',
    'vs/monaco.contribution-D2OdxNBt',
    'vs/monaco.contribution-DO3azKX8',
    'vs/monaco.contribution-EcChJV6a',
    'vs/monaco.contribution-qLAYrEOP',
    'vs/msdax-C38-sJlp',
    'vs/mysql-CdtbpvbG',
    'vs/nls.messages-loader',
    'vs/nls.messages.cs.js',
    'vs/nls.messages.de.js',
    'vs/nls.messages.es.js',
    'vs/nls.messages.fr.js',
    'vs/nls.messages.it.js',
    'vs/nls.messages.ja.js',
    'vs/nls.messages.js',
    'vs/nls.messages.ko.js',
    'vs/nls.messages.pl.js',
    'vs/nls.messages.pt-br.js',
    'vs/nls.messages.ru.js',
    'vs/nls.messages.tr.js',
    'vs/nls.messages.zh-cn.js',
    'vs/nls.messages.zh-tw.js',
    'vs/objective-c-CntZFaHX',
    'vs/pascal-r6kuqfl_',
    'vs/pascaligo-BiXoTmXh',
    'vs/perl-DABw_TcH',
    'vs/pgsql-me_jFXeX',
    'vs/php-D_kh-9LK',
    'vs/pla-VfZjczW0',
    'vs/postiats-BBSzz8Pk',
    'vs/powerquery-Dt-g_2cc',
    'vs/powershell-B-7ap1zc',
    'vs/protobuf-BmtuEB1A',
    'vs/pug-BRpRNeEb',
    'vs/python-Cr0UkIbn',
    'vs/qsharp-BzsFaUU9',
    'vs/r-f8dDdrp4',
    'vs/razor-BYAHOTkz',
    'vs/redis-fvZQY4PI',
    'vs/redshift-45Et0LQi',
    'vs/restructuredtext-C7UUFKFD',
    'vs/ruby-CZO8zYTz',
    'vs/rust-Bfetafyc',
    'vs/sb-3GYllVck',
    'vs/scala-foMgrKo1',
    'vs/scheme-CHdMtr7p',
    'vs/scss-C1cmLt9V',
    'vs/shell-ClXCKCEW',
    'vs/solidity-MZ6ExpPy',
    'vs/sophia-DWkuSsPQ',
    'vs/sparql-AUGFYSyk',
    'vs/sql-32GpJSV2',
    'vs/st-CuDFIVZ_',
    'vs/swift-n-2HociN',
    'vs/systemverilog-Ch4vA8Yt',
    'vs/tcl-D74tq1nH',
    'vs/tsMode-CZz1Umrk',
    'vs/twig-C6taOxMV',
    'vs/typescript-DfOrAzoV',
    'vs/typespec-D-PIh9Xw',
    'vs/vb-Dyb2648j',
    'vs/wgsl-BhLXMOR0',
    'vs/workers-DcJshg-q',
    'vs/xml-CdsdnY8S',
    'vs/yaml-DYGvmE88',
    'vs/basic-languages/monaco.contribution',
    'vs/language/json/monaco.contribution',
    'vs/language/css/monaco.contribution',
    'vs/language/html/monaco.contribution',
    'vs/language/typescript/monaco.contribution',
  ];

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

  const ENGINE = 'monaco';
  const CONTRACT_VERSION = 1;

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

  function buildSourceUrlComment(url) {
    return '\n//# sourceURL=' + String(url || '').replace(/\s/g, '%20');
  }

  function withShadowedGlobals(names, fn) {
    const globalScope = window;
    const restore = [];
    const list = Array.isArray(names) ? names : [];

    try {
      for (const name of list) {
        const key = String(name || '').trim();
        if (!key) continue;
        const hadOwn = Object.prototype.hasOwnProperty.call(globalScope, key);
        restore.push({ key, hadOwn, value: globalScope[key] });
        globalScope[key] = undefined;
      }
      return fn();
    } finally {
      for (let i = restore.length - 1; i >= 0; i -= 1) {
        const entry = restore[i];
        try {
          if (entry.hadOwn) globalScope[entry.key] = entry.value;
          else delete globalScope[entry.key];
        } catch (error) {
          globalScope[entry.key] = entry.value;
        }
      }
    }
  }

  async function fetchClassicScriptSource(url) {
    try {
      const response = await fetch(String(url || ''), { cache: 'force-cache' });
      if (!response || !response.ok) return '';
      return await response.text();
    } catch (error) {
      return '';
    }
  }

  function evalClassicScript(url, code) {
    if (!code) return false;

    try {
      return withShadowedGlobals(['module', 'exports'], () => {
        const globalEval = (0, eval);
        globalEval(String(code) + buildSourceUrlComment(url));
        return true;
      });
    } catch (error) {
      return false;
    }
  }

  function loadClassicScriptOnce(src) {
    const url = String(src || '');
    if (!url) return Promise.resolve(false);

    if (_js.has(url)) return _js.get(url);

    const p = (async () => {
      const code = await fetchClassicScriptSource(url);
      if (!code) return false;
      return evalClassicScript(url, code);
    })().then((ok) => {
      if (!ok) _js.delete(url);
      return ok;
    }).catch(() => {
      _js.delete(url);
      return false;
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

  function getMergedIgnoreDuplicateModules() {
    const seen = new Set();
    const out = [];

    function pushMany(values) {
      if (!Array.isArray(values)) return;
      for (const value of values) {
        const id = String(value || '').trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push(id);
      }
    }

    try {
      if (window.require && typeof window.require.getConfig === 'function') {
        const current = window.require.getConfig();
        pushMany(current && current.ignoreDuplicateModules);
      }
    } catch (e) {}

    pushMany(SAFE_MONACO_DUPLICATE_MODULES);
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
      engine: ENGINE,
      staticRoot: STATIC_ROOT,
      engineRoots: (Array.isArray(_cfg.localVsPaths) ? _cfg.localVsPaths.slice(0) : []),
      engineRoot: (Array.isArray(_cfg.localVsPaths) && _cfg.localVsPaths.length) ? _cfg.localVsPaths[0] : '',
      localVsBases: (Array.isArray(_cfg.localVsPaths) ? _cfg.localVsPaths.slice(0) : []),
    };
  };

  L.getActiveSource = function getActiveSource() {
    return _activeSource ? Object.assign({ engine: ENGINE }, _activeSource) : null;
  };

  L.ENGINE = ENGINE;
  L.CONTRACT_VERSION = CONTRACT_VERSION;

  L.isReady = function isReady(opts) {
    const o = opts || {};
    if (o.configureOnly) return !!_configured;
    return hasMonacoApi();
  };

  L.getStatus = function getStatus(opts) {
    const ready = L.isReady(opts);
    return {
      ok: ready,
      ready,
      engine: ENGINE,
      contractVersion: CONTRACT_VERSION,
      configured: !!_configured,
      source: L.getActiveSource(),
      paths: L.getPaths(),
    };
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
        const ok = await loadClassicScriptOnce(c.loader);
        if (!ok) continue;

        // AMD loader defines global require/define.
        try {
          if (window.require && typeof window.require.config === 'function') {
            window.require.config({
              paths: {
                vs: c.vsBase,
              },
              ignoreDuplicateModules: getMergedIgnoreDuplicateModules(),
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

  L.ensureSupport = async function ensureSupport(opts) {
    const o = opts || {};
    const configured = await L.ensureConfigured();
    if (!configured || !configured.ok) {
      return {
        ok: false,
        ready: false,
        engine: ENGINE,
        contractVersion: CONTRACT_VERSION,
        api: null,
        configured: false,
        source: L.getActiveSource(),
        paths: L.getPaths(),
      };
    }

    if (o.configureOnly) {
      return {
        ok: true,
        ready: true,
        engine: ENGINE,
        contractVersion: CONTRACT_VERSION,
        api: null,
        configured: true,
        source: L.getActiveSource(),
        paths: L.getPaths(),
      };
    }

    const api = await L.ensureMonaco();
    const ready = !!api;
    return {
      ok: ready,
      ready,
      engine: ENGINE,
      contractVersion: CONTRACT_VERSION,
      api: ready ? api : null,
      configured: !!configured.ok,
      source: L.getActiveSource(),
      paths: L.getPaths(),
    };
  };
})();

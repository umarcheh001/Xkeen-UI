(() => {
  'use strict';

  // Lazy CodeMirror assets loader.
  // Goal: avoid loading every mode / linter upfront. Load on demand.

  window.XKeen = window.XKeen || {};
  const XK = window.XKeen;
  XK.cmLoader = XK.cmLoader || {};

  const L = XK.cmLoader;

  // ------------------------ base paths ------------------------
  function guessStaticRoot() {
    try {
      // If the app is mounted under a prefix (e.g. /xkeen/), preserve it.
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
  const CM_ROOT = STATIC_ROOT + 'codemirror/';

  // ------------------------ loaders (cached) ------------------------
  const _js = new Map();
  const _css = new Map();

  function isSameOrigin(url) {
    try {
      const u = new URL(String(url || ''), window.location.href);
      return u.origin === window.location.origin;
    } catch (e) {
      return false;
    }
  }

  function shouldForceGlobalUmd(url) {
    const raw = String(url || '');
    if (!raw || !isSameOrigin(raw)) return false;
    try {
      const path = new URL(raw, window.location.href).pathname;
      return path.includes('/static/codemirror/') || path.includes('/static/jsonlint/');
    } catch (e) {
      return raw.includes('/static/codemirror/') || raw.includes('/static/jsonlint/');
    }
  }

  async function evalAsGlobalNoAMD(url) {
    try {
      const res = await fetch(String(url), { cache: 'force-cache' });
      if (!res || !res.ok) return false;
      const code = await res.text();
      // Keep AMD/CommonJS hooks local to this isolated evaluation so Monaco's
      // live AMD loader on window is never clobbered during CodeMirror/jsonlint
      // lazy loads.
      // jsonlint uses a classic `var jsonlint = ...` export, so we promote it
      // back to window explicitly after evaluation.
      // eslint-disable-next-line no-new-func
      const fn = new Function(
        'window',
        'globalThis',
        'self',
        'define',
        'exports',
        'module',
        code
          + '\n//# sourceURL=' + String(url).replace(/\s/g, '%20')
          + '\n;return {'
          + '\n  CodeMirror: (typeof CodeMirror !== "undefined") ? CodeMirror : undefined,'
          + '\n  jsonlint: (typeof jsonlint !== "undefined") ? jsonlint : undefined'
          + '\n};'
      );
      const exposed = fn.call(window, window, window, window, undefined, undefined, undefined) || {};
      if (exposed.CodeMirror && !window.CodeMirror) window.CodeMirror = exposed.CodeMirror;
      if (exposed.jsonlint && !window.jsonlint) window.jsonlint = exposed.jsonlint;
      return true;
    } catch (e) {
      return false;
    }
  }

  function loadScriptTagNoAMD(url) {
    return new Promise((resolve) => {
      const g = window;
      const hadDefine = Object.prototype.hasOwnProperty.call(g, 'define');
      const hadExports = Object.prototype.hasOwnProperty.call(g, 'exports');
      const hadModule = Object.prototype.hasOwnProperty.call(g, 'module');

      const savedDefine = g.define;
      const savedExports = g.exports;
      const savedModule = g.module;

      const restore = () => {
        try { if (hadDefine) g.define = savedDefine; else delete g.define; } catch (e1) {}
        try { if (hadExports) g.exports = savedExports; else delete g.exports; } catch (e2) {}
        try { if (hadModule) g.module = savedModule; else delete g.module; } catch (e3) {}
      };

      const finish = (ok) => {
        restore();
        resolve(!!ok);
      };

      try {
        g.define = undefined;
        g.exports = undefined;
        g.module = undefined;
      } catch (e) {}

      try {
        const s = document.createElement('script');
        s.src = url;
        s.async = false;
        s.onload = () => finish(true);
        s.onerror = () => finish(false);
        document.head.appendChild(s);
      } catch (e) {
        finish(false);
      }
    });
  }

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

  function alreadyPresentCss(href) {
    try {
      const abs = new URL(href, window.location.href).toString();
      const nodes = document.querySelectorAll('link[rel="stylesheet"][href]');
      for (const n of nodes) {
        try {
          const s = new URL(n.href, window.location.href).toString();
          if (s === abs) return true;
        } catch (e) {}
      }
    } catch (e) {}
    return false;
  }

  function loadScriptOnce(src) {
    const url = String(src || '');
    if (!url) return Promise.resolve(false);

    if (_js.has(url)) return _js.get(url);
    if (alreadyPresentScript(url)) {
      const p = Promise.resolve(true);
      _js.set(url, p);
      return p;
    }

    const p = (async () => {
      if (shouldForceGlobalUmd(url)) {
        const evalOk = await evalAsGlobalNoAMD(url);
        if (evalOk) return true;
        return await loadScriptTagNoAMD(url);
      }

      return await new Promise((resolve) => {
        try {
          const s = document.createElement('script');
          s.src = url;
          s.async = true;
          s.onload = () => resolve(true);
          s.onerror = () => resolve(false);
          document.head.appendChild(s);
        } catch (e) {
          resolve(false);
        }
      });
    })();

    _js.set(url, p);
    return p;
  }

  function loadCssOnce(href) {
    const url = String(href || '');
    if (!url) return Promise.resolve(false);

    if (_css.has(url)) return _css.get(url);
    if (alreadyPresentCss(url)) {
      const p = Promise.resolve(true);
      _css.set(url, p);
      return p;
    }

    const p = new Promise((resolve) => {
      try {
        const l = document.createElement('link');
        l.rel = 'stylesheet';
        l.href = url;
        l.onload = () => resolve(true);
        l.onerror = () => resolve(false);
        document.head.appendChild(l);
      } catch (e) {
        resolve(false);
      }
    });

    _css.set(url, p);
    return p;
  }

  // ------------------------ public API ------------------------
  const MODE_TO_FILE = {
    javascript: 'mode/javascript/javascript.min.js',
    // JSON with comments (JSONC) — implemented as a wrapper around
    // the built-in javascript(json:true) mode.
    // Uses the same underlying mode file.
    jsonc: 'mode/javascript/javascript.min.js',
    yaml: 'mode/yaml/yaml.min.js',
    shell: 'mode/shell/shell.min.js',
    toml: 'mode/toml/toml.min.js',
    properties: 'mode/properties/properties.min.js',
    xml: 'mode/xml/xml.min.js',
    nginx: 'mode/nginx/nginx.min.js',
  };

  const ADDON_GROUPS = {
    search: {
      css: ['addon/dialog/dialog.css'],
      js: [
        'addon/dialog/dialog.js',
        'addon/search/searchcursor.js',
        'addon/search/search.js',
        'addon/mode/overlay.js',
        'addon/search/match-highlighter.js',
      ],
    },
    fold: {
      css: ['addon/fold/foldgutter.css'],
      js: [
        'addon/fold/foldcode.js',
        'addon/fold/brace-fold.js',
        'addon/fold/indent-fold.js',
        'addon/fold/comment-fold.js',
        'addon/fold/foldgutter.js',
      ],
    },
    editing: {
      js: [
        'addon/edit/closebrackets.js',
        'addon/edit/trailingspace.js',
        'addon/comment/comment.js',
        'addon/comment/continuecomment.js',
      ],
    },
    fullscreen: {
      css: ['addon/display/fullscreen.css'],
      js: ['addon/display/fullscreen.js'],
    },
    rulers: {
      js: ['addon/display/rulers.js'],
    },
  };

  // jsonc mode is a tiny wrapper around javascript(json:true), but with
  // comment metadata enabled so toggleComment works.
  function defineJsoncModeIfPossible() {
    try {
      if (!window.CodeMirror) return false;
      if (window.CodeMirror.modes && window.CodeMirror.modes.jsonc) return true;
      if (!(window.CodeMirror.modes && window.CodeMirror.modes.javascript)) return false;

      window.CodeMirror.defineMode('jsonc', function (config, parserConfig) {
        const base = window.CodeMirror.getMode(config, { name: 'javascript', json: true });
        // In CodeMirror's JS mode, json:true nulls out these fields. Restore them.
        const lc = (parserConfig && parserConfig.lineComment) ? parserConfig.lineComment : '//';
        base.lineComment = lc;
        base.blockCommentStart = (parserConfig && parserConfig.blockCommentStart) ? parserConfig.blockCommentStart : '/*';
        base.blockCommentEnd = (parserConfig && parserConfig.blockCommentEnd) ? parserConfig.blockCommentEnd : '*/';
        base.blockCommentContinue = (parserConfig && parserConfig.blockCommentContinue) ? parserConfig.blockCommentContinue : ' * ';
        return base;
      });

      // Optional: MIME alias for editors that use MIME-like values.
      try {
        window.CodeMirror.defineMIME('application/jsonc', { name: 'jsonc' });
      } catch (e) {}

      return !!(window.CodeMirror.modes && window.CodeMirror.modes.jsonc);
    } catch (e) {
      return false;
    }
  }

  function modeLoaded(name) {
    try {
      if (!window.CodeMirror) return false;
      const n = String(name || '');
      if (!n) return false;
      if (n === 'text/plain') return true;
      // For MIME-like values, CodeMirror ships text/plain by default.
      if (n.includes('/') && n !== 'application/json') return true;
      return !!(window.CodeMirror.modes && window.CodeMirror.modes[n]);
    } catch (e) {
      return false;
    }
  }

  L.getPaths = function getPaths() {
    return {
      staticRoot: STATIC_ROOT,
      codemirrorRoot: CM_ROOT,
    };
  };

  L.loadScriptOnce = loadScriptOnce;
  L.loadCssOnce = loadCssOnce;

  L.ensureMode = async function ensureMode(modeName) {
    const n = String(modeName || '').trim();
    if (!n || n === 'text/plain') return true;

    // jsonc is a derived mode; if javascript is already present we can
    // define it without loading anything.
    if (n === 'jsonc') {
      if (defineJsoncModeIfPossible()) return true;
    }

    if (modeLoaded(n)) return true;

    const rel = MODE_TO_FILE[n];
    if (!rel) return false;
    const ok = await loadScriptOnce(CM_ROOT + rel);

    // If we just loaded javascript for jsonc, register the derived mode.
    if (ok && n === 'jsonc') {
      defineJsoncModeIfPossible();
    }

    return ok && modeLoaded(n);
  };

  L.ensureAddonGroup = async function ensureAddonGroup(groupName) {
    const key = String(groupName || '').trim();
    const spec = ADDON_GROUPS[key];
    if (!spec) return false;

    let ok = true;

    const css = Array.isArray(spec.css) ? spec.css : [];
    for (let i = 0; i < css.length; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      ok = (await loadCssOnce(CM_ROOT + css[i])) && ok;
    }

    const js = Array.isArray(spec.js) ? spec.js : [];
    for (let i = 0; i < js.length; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      ok = (await loadScriptOnce(CM_ROOT + js[i])) && ok;
    }

    return ok;
  };

  L.ensureAddonGroups = async function ensureAddonGroups(groupNames) {
    const names = Array.isArray(groupNames) ? groupNames : [];
    const seen = new Set();
    let ok = true;

    for (let i = 0; i < names.length; i += 1) {
      const key = String(names[i] || '').trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      // eslint-disable-next-line no-await-in-loop
      ok = (await L.ensureAddonGroup(key)) && ok;
    }

    return ok;
  };

  // JSON lint dependencies:
  //  - CodeMirror addon/lint/lint.min.js (loaded globally by panel.html)
  //  - window.jsonlint (jsonlint.min.js)
  //  - addon/lint/json-lint.min.js
  function jsonLintHelperLoaded() {
    try {
      if (!window.CodeMirror) return false;
      const h = window.CodeMirror.helpers;
      return !!(h && h.lint && h.lint.json);
    } catch (e) {
      return false;
    }
  }

  L.ensureJsonLint = async function ensureJsonLint() {
    // If helper is already registered, we are done.
    if (jsonLintHelperLoaded() && window.jsonlint) return true;

    // Load parser first, then the helper.
    const ok1 = window.jsonlint ? true : await loadScriptOnce(STATIC_ROOT + 'jsonlint/jsonlint.min.js');
    const ok2 = jsonLintHelperLoaded() ? true : await loadScriptOnce(CM_ROOT + 'addon/lint/json-lint.min.js');
    return !!(ok1 && ok2 && window.jsonlint && jsonLintHelperLoaded());
  };

  // Convenience helper: ensures a CodeMirror mode and optional JSON lint.
  L.ensureFor = async function ensureFor(opts) {
    const o = opts || {};
    const mode = String(o.mode || '').trim();
    const wantJsonLint = !!o.jsonLint;
    const out = { modeOk: true, jsonLintOk: true };
    if (mode) out.modeOk = await L.ensureMode(mode);
    if (wantJsonLint) out.jsonLintOk = await L.ensureJsonLint();
    return out;
  };

  // Higher-level helper for editor creation on demand.
  // Keeps panel templates lighter by shifting optional addons out of <head>.
  L.ensureEditorAssets = async function ensureEditorAssets(opts) {
    const o = opts || {};
    const out = {
      modeOk: true,
      jsonLintOk: true,
      addonsOk: true,
    };

    const mode = String(o.mode || '').trim();
    if (mode) {
      out.modeOk = await L.ensureMode(mode);
    }

    if (o.jsonLint) {
      out.jsonLintOk = await L.ensureJsonLint();
    }

    const groups = [];
    if (o.search) groups.push('search');
    if (o.fold) groups.push('fold');
    if (o.fullscreen) groups.push('fullscreen');
    if (o.rulers) groups.push('rulers');
    if (o.autoCloseBrackets || o.trailingSpace || o.comments) groups.push('editing');

    if (groups.length) {
      out.addonsOk = await L.ensureAddonGroups(groups);
    }

    return out;
  };

  // ------------------------ editor engine preference ------------------------
  // This is used by future Monaco integration.
  // IMPORTANT: no auto-fetch on page load. fetchPreferredEngine() is only called
  // by code that actually needs to decide which editor to initialize.
  function normalizeEngine(v) {
    const s = String(v || '').toLowerCase();
    return (s === 'monaco' || s === 'codemirror') ? s : '';
  }

  L.getPreferredEngine = function getPreferredEngine() {
    try {
      if (XK && XK.ui && XK.ui.settings && typeof XK.ui.settings.get === 'function') {
        const st = XK.ui.settings.get();
        const eng = normalizeEngine(st && st.editor && st.editor.engine);
        if (eng) return eng;
      }
    } catch (e) {}
    return 'codemirror';
  };

  L.fetchPreferredEngine = async function fetchPreferredEngine() {
    try {
      if (XK && XK.ui && XK.ui.settings && typeof XK.ui.settings.fetchOnce === 'function') {
        const st = await XK.ui.settings.fetchOnce();
        const eng = normalizeEngine(st && st.editor && st.editor.engine);
        if (eng) return eng;
      }
    } catch (e) {}
    return L.getPreferredEngine();
  };

  // Best-effort: if panel templates already loaded javascript mode,
  // define jsonc immediately so editors can use it synchronously.
  try { defineJsoncModeIfPossible(); } catch (e) {}
})();

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

    const p = new Promise((resolve) => {
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

  // Best-effort: if panel templates already loaded javascript mode,
  // define jsonc immediately so editors can use it synchronously.
  try { defineJsoncModeIfPossible(); } catch (e) {}
})();

// Terminal core: xterm_manager
//
// Stage 2 goal:
// - Centralize ALL xterm.js creation + addon wiring in one place.
// - Provide a small facade API (create/dispose/write/writeln/clear/focus/fit).
// - Proxy xterm subscriptions (onData/onKey/onResize) through ctx.events.
//
// Legacy compatibility:
// - Keeps window.XKeen.terminal.xterm_manager.* API used by existing code.

(function () {
  'use strict';

  window.XKeen = window.XKeen || {};
  window.XKeen.terminal = window.XKeen.terminal || {};
  window.XKeen.terminal.core = window.XKeen.terminal.core || {};

  const PREF_FONT_SIZE_KEY = 'xkeen_term_font_size_v1';
  const PREF_CURSOR_BLINK_KEY = 'xkeen_term_cursor_blink_v1';

  function readPrefs(ctx) {
    let fontSize = 12;
    let cursorBlink = false;

    // Prefer ctx.config if available (Stage 1)
    try {
      if (ctx && ctx.config && typeof ctx.config.get === 'function') {
        fontSize = Number(ctx.config.get('fontSize', fontSize) || fontSize);
        fontSize = Math.max(8, Math.min(32, parseInt(String(fontSize), 10) || 12));
        cursorBlink = !!ctx.config.get('cursorBlink', cursorBlink);
        return { fontSize, cursorBlink };
      }
    } catch (e) {}

    try {
      const rawF = localStorage.getItem(PREF_FONT_SIZE_KEY);
      if (rawF != null) {
        const v = parseInt(rawF, 10);
        if (!isNaN(v)) fontSize = Math.max(8, Math.min(32, v));
      }
    } catch (e2) {}

    try {
      const rawB = localStorage.getItem(PREF_CURSOR_BLINK_KEY);
      if (rawB != null) cursorBlink = (rawB === '1' || rawB === 'true');
    } catch (e3) {}

    return { fontSize, cursorBlink };
  }

  function safeToast(ctx, msg, kind) {
    try {
      if (ctx && ctx.ui && typeof ctx.ui.toast === 'function') return ctx.ui.toast(msg, kind);
    } catch (e) {}
    try {
      if (typeof window.showToast === 'function') return window.showToast(String(msg || ''), kind || 'info');
    } catch (e2) {}
  }

  function getCore(ctx) {
    try {
      if (ctx && ctx.core) return ctx.core;
    } catch (e) {}
    try {
      return window.XKeen.terminal._core || null;
    } catch (e2) {}
    return null;
  }

  function pickHostElements(ctx) {
    const core = getCore(ctx);

    let xhost = null;
    let pre = null;

    // Prefer ctx.dom cache (Stage 1)
    try {
      if (ctx && ctx.dom) {
        xhost = ctx.dom.xtermHost || null;
        pre = (ctx.dom.outputPre || ctx.dom.output) || null;
      }
    } catch (e) {}

    // UI adapter fallback
    try {
      if (!xhost && ctx && ctx.ui && ctx.ui.get && typeof ctx.ui.get.xtermHost === 'function') {
        xhost = ctx.ui.get.xtermHost();
      }
    } catch (e2) {}
    try {
      if (!pre && ctx && ctx.ui && ctx.ui.get) {
        if (typeof ctx.ui.get.outputPre === 'function') pre = ctx.ui.get.outputPre();
        else if (typeof ctx.ui.get.output === 'function') pre = ctx.ui.get.output();
      }
    } catch (e3) {}

    // Last resort: direct byId via core
    try {
      if (!xhost && core && typeof core.byId === 'function') xhost = core.byId('terminal-xterm');
    } catch (e4) {}
    try {
      if (!pre && core && typeof core.byId === 'function') pre = core.byId('terminal-output');
    } catch (e5) {}

    return { xhost, pre, container: xhost || pre };
  }

  function showXtermHost(ctx, on) {
    const { xhost, pre } = pickHostElements(ctx);
    try {
      if (xhost) {
        if (on) xhost.classList.remove('hidden');
        else xhost.classList.add('hidden');
      }
    } catch (e) {}

    // If dedicated xterm host exists, hide <pre> fallback while xterm is active.
    try {
      if (pre && xhost) pre.style.display = on ? 'none' : '';
    } catch (e2) {}
  }

  function createManager(ctx) {
    const core = getCore(ctx);
    const events = (ctx && ctx.events) ? ctx.events : null;

    let term = null;
    let opened = false;
    let hostEl = null;
    let resizeObserver = null;

    // Addons
    let fitAddon = null;
    let searchAddon = null;
    let webLinksAddon = null;
    let webglAddon = null;
    let unicode11Addon = null;
    let serializeAddon = null;
    let clipboardAddon = null;
    let ligaturesAddon = null;

    // XTerm event disposables
    let termDisposables = [];

    // Resize dedupe
    let lastCols = 0;
    let lastRows = 0;

    function emit(name, payload) {
      try {
        if (events && typeof events.emit === 'function') events.emit(name, payload);
      } catch (e) {}
    }

    function syncCoreRefs() {
      try {
        if (core && typeof core.setXtermRefs === 'function') {
          core.setXtermRefs({
            term,
            xterm: term,
            fitAddon,
            searchAddon,
            webLinksAddon,
            webglAddon,
            unicode11Addon,
            serializeAddon,
            clipboardAddon,
            ligaturesAddon,
            resizeObserver,
          });
        }
      } catch (e) {}
    }

    function getRefs() {
      return {
        term,
        xterm: term,
        fitAddon,
        searchAddon,
        webLinksAddon,
        webglAddon,
        unicode11Addon,
        serializeAddon,
        clipboardAddon,
        ligaturesAddon,
        resizeObserver,
      };
    }

    function disposeTermDisposables() {
      try {
        (termDisposables || []).forEach((d) => {
          try {
            if (d && typeof d.dispose === 'function') d.dispose();
            else if (typeof d === 'function') d();
          } catch (e) {}
        });
      } catch (e2) {}
      termDisposables = [];
    }

    function emitResize(cols, rows, reason) {
      const c = Number(cols || 0);
      const r = Number(rows || 0);
      // No change; don't spam.
      if (c > 0 && r > 0 && c === lastCols && r === lastRows) return;

      if (c > 0) lastCols = c;
      if (r > 0) lastRows = r;

      const payload = {
        cols: (c > 0 ? c : (term && term.cols ? term.cols : 0)),
        rows: (r > 0 ? r : (term && term.rows ? term.rows : 0)),
        reason: String(reason || 'resize'),
        ts: Date.now(),
      };

      try { emit('xterm:resize', payload); } catch (e) {}
      // Backward-compatible name used elsewhere in the refactor.
      try { emit('ui:resize', payload); } catch (e2) {}
    }

    function attachEventProxies() {
      disposeTermDisposables();
      if (!term) return;

      try {
        if (typeof term.onData === 'function') {
          const d = term.onData((data) => {
            try {
              emit('xterm:data', { data: String(data == null ? '' : data), ts: Date.now() });
            } catch (e) {}
          });
          if (d) termDisposables.push(d);
        }
      } catch (e) {}

      try {
        if (typeof term.onKey === 'function') {
          const d = term.onKey((ev) => {
            try {
              emit('xterm:key', {
                key: (ev && ev.key != null) ? String(ev.key) : '',
                domEvent: (ev && ev.domEvent) ? ev.domEvent : null,
                ts: Date.now(),
              });
            } catch (e) {}
          });
          if (d) termDisposables.push(d);
        }
      } catch (e) {}

      try {
        if (typeof term.onResize === 'function') {
          const d = term.onResize((size) => {
            try {
              emitResize(size && size.cols, size && size.rows, 'xterm');
            } catch (e) {}
          });
          if (d) termDisposables.push(d);
        }
      } catch (e) {}

      syncCoreRefs();
    }

    function loadAddons(t) {
      if (!t) return;

      // Fit addon
      try {
        if (!fitAddon && typeof FitAddon !== 'undefined' && FitAddon && typeof FitAddon.FitAddon === 'function') {
          fitAddon = new FitAddon.FitAddon();
          t.loadAddon(fitAddon);
        }
      } catch (e) { fitAddon = null; }

      // Search addon
      try {
        if (!searchAddon && typeof SearchAddon !== 'undefined' && SearchAddon && typeof SearchAddon.SearchAddon === 'function') {
          searchAddon = new SearchAddon.SearchAddon({ highlightLimit: 2000 });
          t.loadAddon(searchAddon);
        }
      } catch (e2) { searchAddon = null; }

      // Web links addon
      try {
        if (!webLinksAddon && typeof WebLinksAddon !== 'undefined' && WebLinksAddon && typeof WebLinksAddon.WebLinksAddon === 'function') {
          webLinksAddon = new WebLinksAddon.WebLinksAddon((event, uri) => {
            try {
              const w = window.open(uri, '_blank', 'noopener,noreferrer');
              if (w) {
                try { w.opener = null; } catch (e3) {}
              }
            } catch (e4) {}
          }, {});
          t.loadAddon(webLinksAddon);
        }
      } catch (e5) { webLinksAddon = null; }

      // Unicode11 addon
      try {
        if (!unicode11Addon && typeof Unicode11Addon !== 'undefined' && Unicode11Addon && typeof Unicode11Addon.Unicode11Addon === 'function') {
          unicode11Addon = new Unicode11Addon.Unicode11Addon();
          t.loadAddon(unicode11Addon);
          try { if (t.unicode) t.unicode.activeVersion = '11'; } catch (e6) {}
        }
      } catch (e7) { unicode11Addon = null; }

      // Ligatures addon
      try {
        if (!ligaturesAddon && typeof LigaturesAddon !== 'undefined' && LigaturesAddon && typeof LigaturesAddon.LigaturesAddon === 'function') {
          ligaturesAddon = new LigaturesAddon.LigaturesAddon();
          t.loadAddon(ligaturesAddon);
        }
      } catch (e8) { ligaturesAddon = null; }

      // Clipboard addon
      try {
        if (!clipboardAddon && typeof ClipboardAddon !== 'undefined' && ClipboardAddon && typeof ClipboardAddon.ClipboardAddon === 'function') {
          clipboardAddon = new ClipboardAddon.ClipboardAddon();
          t.loadAddon(clipboardAddon);
        }
      } catch (e9) { clipboardAddon = null; }

      // Serialize addon
      try {
        if (!serializeAddon && typeof SerializeAddon !== 'undefined' && SerializeAddon && typeof SerializeAddon.SerializeAddon === 'function') {
          serializeAddon = new SerializeAddon.SerializeAddon();
          t.loadAddon(serializeAddon);
        }
      } catch (e10) { serializeAddon = null; }

      // WebGL renderer addon
      try {
        if (!webglAddon && typeof WebglAddon !== 'undefined' && WebglAddon && typeof WebglAddon.WebglAddon === 'function') {
          webglAddon = new WebglAddon.WebglAddon();
          t.loadAddon(webglAddon);
          try {
            if (webglAddon && typeof webglAddon.onContextLoss === 'function') {
              webglAddon.onContextLoss(() => {
                try { webglAddon.dispose?.(); } catch (e11) {}
                webglAddon = null;
                syncCoreRefs();
                safeToast(ctx, 'WebGL-рендер терминала отключён (context loss)', 'info');
              });
            }
          } catch (e12) {}
        }
      } catch (e13) { webglAddon = null; }

      syncCoreRefs();
    }

    function createTerminal(opts = {}) {
      if (term) return term;
      if (typeof Terminal === 'undefined') return null;

      const prefs = (opts && opts.prefs) ? opts.prefs : readPrefs(ctx);

      try {
        term = new Terminal({
          allowProposedApi: true,
          convertEol: true,
          cursorBlink: !!prefs.cursorBlink,
          scrollback: 2000,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
          fontSize: (prefs.fontSize || 12),
        });
      } catch (e) {
        term = null;
        return null;
      }

      try { loadAddons(term); } catch (e2) {}
      try { attachEventProxies(); } catch (e3) {}
      syncCoreRefs();
      return term;
    }

    function applyPrefs(prefs) {
      if (!term || !prefs) return;
      try {
        const fz = (prefs.fontSize != null) ? Math.max(8, Math.min(32, Number(prefs.fontSize) || 12)) : null;
        const cb = (prefs.cursorBlink != null) ? !!prefs.cursorBlink : null;
        if (typeof term.setOption === 'function') {
          if (fz != null) term.setOption('fontSize', fz);
          if (cb != null) term.setOption('cursorBlink', cb);
        } else if (term.options) {
          if (fz != null) term.options.fontSize = fz;
          if (cb != null) term.options.cursorBlink = cb;
        }
      } catch (e) {}
      try { fit(); } catch (e2) {}
    }

    function detach() {
      try {
        if (resizeObserver && hostEl && typeof resizeObserver.unobserve === 'function') {
          resizeObserver.unobserve(hostEl);
        }
      } catch (e) {}
      hostEl = null;
    }

    function attachToHost(el) {
      if (!term) return false;

      const { container, xhost } = pickHostElements(ctx);
      const host = el || container;
      if (!host) return false;

      try { showXtermHost(ctx, !!xhost); } catch (e) {}

      if (!opened) {
        try {
          term.open(host);
          opened = true;
          hostEl = host;
        } catch (e) {
          try { showXtermHost(ctx, false); } catch (e2) {}
          safeToast(ctx, 'Не удалось инициализировать xterm.js (fallback на <pre>)', 'error');
          return false;
        }
      } else {
        hostEl = host;
      }

      // Resize observer -> fit
      try {
        if (typeof ResizeObserver !== 'undefined') {
          if (!resizeObserver) {
            resizeObserver = new ResizeObserver(() => {
              try { fit(); } catch (e3) {}
            });
          }
          if (resizeObserver && hostEl && typeof resizeObserver.observe === 'function') {
            resizeObserver.observe(hostEl);
          }
        }
      } catch (e4) {}

      try { fit(); } catch (e5) {}
      syncCoreRefs();
      return true;
    }

    function fit() {
      try {
        if (fitAddon && typeof fitAddon.fit === 'function') fitAddon.fit();
      } catch (e) {}

      try {
        if (term) emitResize(term.cols, term.rows, 'fit');
      } catch (e2) {}

      syncCoreRefs();
    }

    function disposeTerminal() {
      detach();
      try { resizeObserver?.disconnect?.(); } catch (e) {}
      resizeObserver = null;

      try { disposeTermDisposables(); } catch (e2) {}

      try { term?.dispose?.(); } catch (e3) {}
      term = null;
      opened = false;

      fitAddon = null;
      searchAddon = null;
      webLinksAddon = null;
      webglAddon = null;
      unicode11Addon = null;
      serializeAddon = null;
      clipboardAddon = null;
      ligaturesAddon = null;

      lastCols = 0;
      lastRows = 0;

      try { showXtermHost(ctx, false); } catch (e4) {}
      syncCoreRefs();
    }

    function ensureTerminal(opts = {}) {
      const had = !!term;
      const t = createTerminal(opts);
      if (!t) {
        try { showXtermHost(ctx, false); } catch (e) {}
        return { term: null, created: false };
      }

      // Always (re)apply prefs from ctx.config/localStorage on each ensure/open.
      // This guarantees that close → open picks up the latest settings even if the
      // terminal instance is reused.
      try { attachToHost(); } catch (e2) {}
      try {
        const prefs = (opts && opts.prefs) ? opts.prefs : readPrefs(ctx);
        applyPrefs(prefs);
      } catch (e3) {}

      return { term: t, created: !had };
    }

    function write(s) {
      if (!term) return;
      try { term.write(String(s == null ? '' : s)); } catch (e) {}
    }

    function writeln(s) {
      if (!term) return;
      const text = String(s == null ? '' : s);
      try {
        if (typeof term.writeln === 'function') term.writeln(text);
        else term.write(text + '\r\n');
      } catch (e) {}
    }

    function clear() {
      if (!term) return;
      try {
        if (typeof term.clear === 'function') term.clear();
        else term.write('\x1b[2J\x1b[H');
      } catch (e) {}
    }

    function focus() {
      if (!term) return;
      try { term.focus(); } catch (e) {}
    }

    return {
      // Stage 2 API
      create: (opts) => ensureTerminal(opts || {}),
      dispose: disposeTerminal,
      write,
      writeln,
      clear,
      focus,
      fit,

      // Legacy / internal
      ensureTerminal,
      createTerminal,
      disposeTerminal,
      attachToHost,
      detach,
      applyPrefs,
      getRefs,
      get term() { return term; },
    };
  }

  function getOrCreate(ctx) {
    window.XKeen.terminal.__xtermManager = window.XKeen.terminal.__xtermManager || null;
    if (window.XKeen.terminal.__xtermManager) return window.XKeen.terminal.__xtermManager;
    const mgr = createManager(ctx);
    window.XKeen.terminal.__xtermManager = mgr;
    return mgr;
  }

  // Public facade requested by Stage 2.
  function create(ctx, opts) {
    const mgr = getOrCreate(ctx);
    try { mgr.ensureTerminal(opts || {}); } catch (e) {}
    return mgr;
  }

  function dispose() {
    try {
      const mgr = window.XKeen.terminal.__xtermManager || null;
      if (mgr && typeof mgr.disposeTerminal === 'function') mgr.disposeTerminal();
    } catch (e) {}
  }

  // Optional registry plugin wrapper (kept for future stages)
  function createModule(ctx) {
    const mgr = getOrCreate(ctx);
    return {
      init: () => { void mgr; },
    };
  }

  // Export (legacy path + core namespace)
  window.XKeen.terminal.core.xterm_manager = {
    PREF_FONT_SIZE_KEY,
    PREF_CURSOR_BLINK_KEY,
    readPrefs,
    createManager,
    getOrCreate,
    create,
    dispose,
    createModule,
  };

  // Keep legacy global for existing code.
  window.XKeen.terminal.xterm_manager = window.XKeen.terminal.core.xterm_manager;
})();

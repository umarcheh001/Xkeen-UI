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

  const DEFAULT_XTERM_FONT_FAMILY = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';

  function clamp(n, min, max) {
    const x = Number(n);
    if (!Number.isFinite(x)) return min;
    return Math.max(min, Math.min(max, x));
  }

  // Typography prefs (DevTools → Интерфейс) are applied via CSS vars on :root.
  // xterm.js renders via canvas and does NOT inherit CSS font-size/font-family,
  // so we need to propagate those vars into Terminal options.
  function readMonoTypographyFromCss() {
    let monoScale = 1;
    let monoFamily = DEFAULT_XTERM_FONT_FAMILY;

    try {
      const root = document && document.documentElement ? document.documentElement : null;
      if (root && typeof window.getComputedStyle === 'function') {
        const cs = window.getComputedStyle(root);
        const s = String(cs.getPropertyValue('--xk-mono-font-scale') || '').trim();
        const f = String(cs.getPropertyValue('--xk-mono-font-family') || '').trim();
        const n = parseFloat(s);
        if (Number.isFinite(n) && n > 0) monoScale = n;
        if (f) monoFamily = f;
      }
    } catch (e) {}

    return { monoScale, monoFamily };
  }

  // Terminal colors: xterm.js renders to canvas and does NOT inherit most CSS
  // (except its own wrapper). To make global theme variables affect terminal,
  // we derive an xterm theme from :root CSS vars.
  function _readCssVar(root, name) {
    try {
      if (!root || typeof window.getComputedStyle !== 'function') return '';
      const cs = window.getComputedStyle(root);
      return String(cs.getPropertyValue(name) || '').trim();
    } catch (e) {}
    return '';
  }

  function _parseCssColor(s) {
    const v = String(s || '').trim();
    if (!v) return null;

    // #rgb, #rrggbb, #rrggbbaa
    if (/^#[0-9a-fA-F]{3}$/.test(v)) {
      const r = parseInt(v[1] + v[1], 16);
      const g = parseInt(v[2] + v[2], 16);
      const b = parseInt(v[3] + v[3], 16);
      return { r, g, b, a: 1 };
    }
    if (/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(v)) {
      const r = parseInt(v.slice(1, 3), 16);
      const g = parseInt(v.slice(3, 5), 16);
      const b = parseInt(v.slice(5, 7), 16);
      const a = (v.length === 9) ? (parseInt(v.slice(7, 9), 16) / 255) : 1;
      return { r, g, b, a: Number.isFinite(a) ? a : 1 };
    }

    // rgb()/rgba()
    const m = v.match(/^rgba?\(([^)]+)\)$/i);
    if (m) {
      const parts = m[1].split(',').map((x) => x.trim());
      const r = parseFloat(parts[0]);
      const g = parseFloat(parts[1]);
      const b = parseFloat(parts[2]);
      const a = (parts.length >= 4) ? parseFloat(parts[3]) : 1;
      if ([r, g, b].every((n) => Number.isFinite(n))) {
        return {
          r: Math.max(0, Math.min(255, Math.round(r))),
          g: Math.max(0, Math.min(255, Math.round(g))),
          b: Math.max(0, Math.min(255, Math.round(b))),
          a: Number.isFinite(a) ? Math.max(0, Math.min(1, a)) : 1,
        };
      }
    }

    // Named colors are possible; let the browser resolve them.
    try {
      const tmp = document.createElement('span');
      tmp.style.color = v;
      document.body.appendChild(tmp);
      const cs = window.getComputedStyle(tmp);
      const resolved = cs && cs.color ? String(cs.color) : '';
      tmp.remove();
      if (resolved && resolved !== v) return _parseCssColor(resolved);
    } catch (e2) {}

    return null;
  }

  function _rgbToHex(c) {
    const to2 = (n) => {
      const s = Math.max(0, Math.min(255, Math.round(n))).toString(16);
      return (s.length === 1) ? ('0' + s) : s;
    };
    return '#' + to2(c.r) + to2(c.g) + to2(c.b);
  }

  function _mix(a, b, t) {
    const k = Math.max(0, Math.min(1, Number(t)));
    return {
      r: Math.round(a.r * (1 - k) + b.r * k),
      g: Math.round(a.g * (1 - k) + b.g * k),
      b: Math.round(a.b * (1 - k) + b.b * k),
      a: 1,
    };
  }

  function _luma(c) {
    // sRGB relative luminance
    const f = (x) => {
      const v = x / 255;
      return (v <= 0.04045) ? (v / 12.92) : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    const r = f(c.r), g = f(c.g), b = f(c.b);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  
  function readTerminalThemeFromCss(cursorBlinkEnabled) {
    try {
      const root = document && document.documentElement ? document.documentElement : null;
      if (!root) return null;

      // Prefer independent Terminal theme (DevTools → Terminal), if enabled.
      const termEnabledRaw = _readCssVar(root, '--xk-term-enabled');
      const termEnabled = termEnabledRaw != null && String(termEnabledRaw).trim() !== '' && String(termEnabledRaw).trim() !== '0';
      if (termEnabled) {
        const bg = _readCssVar(root, '--xk-term-background') || '#020617';
        const fg = _readCssVar(root, '--xk-term-foreground') || '#e5e7eb';

        const cursor = _readCssVar(root, '--xk-term-cursor') || fg;
        const cursorAccent = _readCssVar(root, '--xk-term-cursor-accent') || bg;

        const cursorBlink = _readCssVar(root, '--xk-term-cursor-blink') || cursor;
        const cursorBlinkAccent = _readCssVar(root, '--xk-term-cursor-blink-accent') || cursorAccent;

        const selectionBg = _readCssVar(root, '--xk-term-selection');
        const selectionFg = _readCssVar(root, '--xk-term-selection-foreground');

        const th = {
          background: bg,
          foreground: fg,
          cursor: cursorBlinkEnabled ? cursorBlink : cursor,
          cursorAccent: cursorBlinkEnabled ? cursorBlinkAccent : cursorAccent,
        };

        if (selectionBg) {
          // New API (xterm v5+)
          th.selectionBackground = selectionBg;
          // Back-compat for older xterm builds
          th.selection = selectionBg;
        }
        if (selectionFg) th.selectionForeground = selectionFg;

        const add = (cssName, keyName) => {
          const v = _readCssVar(root, '--xk-term-' + cssName);
          if (v) th[keyName] = v;
        };

        // ANSI palette 0..15
        add('black', 'black');
        add('red', 'red');
        add('green', 'green');
        add('yellow', 'yellow');
        add('blue', 'blue');
        add('magenta', 'magenta');
        add('cyan', 'cyan');
        add('white', 'white');
        add('bright-black', 'brightBlack');
        add('bright-red', 'brightRed');
        add('bright-green', 'brightGreen');
        add('bright-yellow', 'brightYellow');
        add('bright-blue', 'brightBlue');
        add('bright-magenta', 'brightMagenta');
        add('bright-cyan', 'brightCyan');
        add('bright-white', 'brightWhite');

        return th;
      }

      // Fallback: derive palette from global UI theme variables.
      const bgRaw = _readCssVar(root, '--card-bg') || _readCssVar(root, '--bg');
      const fgRaw = _readCssVar(root, '--text');
      const mutedRaw = _readCssVar(root, '--muted');
      const accentRaw = _readCssVar(root, '--accent');

      const succRaw = _readCssVar(root, '--sem-success');
      const infoRaw = _readCssVar(root, '--sem-info');
      const warnRaw = _readCssVar(root, '--sem-warning');
      const errRaw = _readCssVar(root, '--sem-error');

      const bgC = _parseCssColor(bgRaw) || { r: 2, g: 6, b: 23, a: 1 };
      const fgC = _parseCssColor(fgRaw) || { r: 229, g: 231, b: 235, a: 1 };
      const muted = _parseCssColor(mutedRaw) || _parseCssColor('#9ca3af') || fgC;
      const accent = _parseCssColor(accentRaw) || _parseCssColor('#60a5fa') || fgC;
      const succ = _parseCssColor(succRaw) || _parseCssColor('#22c55e') || fgC;
      const info = _parseCssColor(infoRaw) || _parseCssColor('#93c5fd') || fgC;
      const warn = _parseCssColor(warnRaw) || _parseCssColor('#fbbf24') || fgC;
      const err = _parseCssColor(errRaw) || _parseCssColor('#f87171') || fgC;

      const isDark = _luma(bgC) < 0.5;
      const WHITE = { r: 255, g: 255, b: 255, a: 1 };
      const BLACK = { r: 0, g: 0, b: 0, a: 1 };

      // Base 0..7
      const black = _mix(bgC, fgC, isDark ? 0.12 : 0.88);
      const white = _mix(bgC, fgC, isDark ? 0.92 : 0.18);
      const blue = accent;
      const magenta = _mix(accent, err, 0.5);
      const cyan = _mix(info, succ, 0.35);

      const base = [
        black,           // 0
        err,             // 1
        succ,            // 2
        warn,            // 3
        blue,            // 4
        magenta,         // 5
        cyan,            // 6
        white,           // 7
      ];

      const brighten = (c) => (isDark ? _mix(c, WHITE, 0.35) : _mix(c, BLACK, 0.22));
      const brightBlack = isDark ? brighten(black) : _mix(black, bgC, 0.45);
      const brightWhite = isDark ? brighten(white) : _mix(white, fgC, 0.20);

      const bright = [
        brightBlack,
        brighten(err),
        brighten(succ),
        brighten(warn),
        brighten(blue),
        brighten(magenta),
        brighten(cyan),
        brightWhite,
      ];

      const selectionAlpha = isDark ? 0.32 : 0.22;
      const selectionBg = `rgba(${accent.r}, ${accent.g}, ${accent.b}, ${selectionAlpha})`;

      return {
        background: _rgbToHex(bgC),
        foreground: _rgbToHex(fgC),
        cursor: _rgbToHex(accent),
        cursorAccent: _rgbToHex(bgC),
        selectionBackground: selectionBg,
        selection: selectionBg,
        // ANSI palette
        black: _rgbToHex(base[0]),
        red: _rgbToHex(base[1]),
        green: _rgbToHex(base[2]),
        yellow: _rgbToHex(base[3]),
        blue: _rgbToHex(base[4]),
        magenta: _rgbToHex(base[5]),
        cyan: _rgbToHex(base[6]),
        white: _rgbToHex(base[7]),
        brightBlack: _rgbToHex(bright[0]),
        brightRed: _rgbToHex(bright[1]),
        brightGreen: _rgbToHex(bright[2]),
        brightYellow: _rgbToHex(bright[3]),
        brightBlue: _rgbToHex(bright[4]),
        brightMagenta: _rgbToHex(bright[5]),
        brightCyan: _rgbToHex(bright[6]),
        brightWhite: _rgbToHex(bright[7]),
      };
    } catch (e) {}
    return null;
  }

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

    // Base (user) prefs for xterm fontSize. Typography monoScale is applied on top.
    let baseFontSize = 12;
    let typographyListener = null;

    // Theme listener: update xterm palette when UI theme / CSS vars change.
    let themeListener = null;

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

    function applyThemeFromCss() {
      if (!term) return;
      try {
        let cb = false;
        try {
          cb = (typeof term.getOption === 'function') ? !!term.getOption('cursorBlink') : !!(term.options && term.options.cursorBlink);
        } catch (e0) {}
        const th = readTerminalThemeFromCss(cb);
        if (!th) return;
        if (typeof term.setOption === 'function') term.setOption('theme', th);
        else if (term.options) term.options.theme = th;
      } catch (e) {}
      try { term?.refresh?.(0, term.rows ? (term.rows - 1) : 0); } catch (e2) {}
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

      // Store base preference so we can re-apply typography changes without compounding.
      baseFontSize = clamp(parseInt(String(prefs.fontSize || 12), 10) || 12, 8, 32);
      const { monoScale, monoFamily } = readMonoTypographyFromCss();
      const effectiveFontSize = clamp(Math.round(baseFontSize * monoScale), 8, 32);

      try {
        term = new Terminal({
          allowProposedApi: true,
          convertEol: true,
          cursorBlink: !!prefs.cursorBlink,
          scrollback: 2000,
          fontFamily: monoFamily || DEFAULT_XTERM_FONT_FAMILY,
          fontSize: effectiveFontSize,
          theme: readTerminalThemeFromCss(!!prefs.cursorBlink) || undefined,
        });
      } catch (e) {
        term = null;
        return null;
      }

      try { loadAddons(term); } catch (e2) {}
      try { attachEventProxies(); } catch (e3) {}

      // Live-sync with DevTools typography controls.
      try {
        if (!typographyListener && typeof document !== 'undefined' && document && typeof document.addEventListener === 'function') {
          typographyListener = () => {
            try { applyTypography(); } catch (e4) {}
          };
          document.addEventListener('xkeen-typography-change', typographyListener);
        }
      } catch (e5) {}

      // Live-sync with theme toggle and Theme editor (CSS vars).
      try {
        if (!themeListener && typeof document !== 'undefined' && document && typeof document.addEventListener === 'function') {
          themeListener = () => {
            try { applyThemeFromCss(); } catch (e6) {}
          };
          document.addEventListener('xkeen-theme-change', themeListener);
        }
      } catch (e7) {}

      try { applyThemeFromCss(); } catch (e8) {}

      syncCoreRefs();
      return term;
    }

    function applyTypography() {
      if (!term) return;
      const { monoScale, monoFamily } = readMonoTypographyFromCss();
      const effectiveFontSize = clamp(Math.round(clamp(baseFontSize, 8, 32) * monoScale), 8, 32);

      try {
        if (typeof term.setOption === 'function') {
          if (monoFamily) term.setOption('fontFamily', monoFamily);
          term.setOption('fontSize', effectiveFontSize);
        } else if (term.options) {
          if (monoFamily) term.options.fontFamily = monoFamily;
          term.options.fontSize = effectiveFontSize;
        }
      } catch (e) {}

      try { fit(); } catch (e2) {}
    }

    function applyPrefs(prefs) {
      if (!term || !prefs) return;
      try {
        // Base pref for xterm is stored separately; typography monoScale is applied on top.
        const base = (prefs.fontSize != null) ? clamp(Number(prefs.fontSize) || 12, 8, 32) : null;
        const cb = (prefs.cursorBlink != null) ? !!prefs.cursorBlink : null;
        if (base != null) baseFontSize = base;
        const { monoScale, monoFamily } = readMonoTypographyFromCss();
        const fz = (base != null) ? clamp(Math.round(base * monoScale), 8, 32) : null;
        if (typeof term.setOption === 'function') {
          if (fz != null) term.setOption('fontSize', fz);
          if (monoFamily) term.setOption('fontFamily', monoFamily);
          if (cb != null) term.setOption('cursorBlink', cb);
        } else if (term.options) {
          if (fz != null) term.options.fontSize = fz;
          if (monoFamily) term.options.fontFamily = monoFamily;
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

      try {
        if (typographyListener && typeof document !== 'undefined' && document && typeof document.removeEventListener === 'function') {
          document.removeEventListener('xkeen-typography-change', typographyListener);
        }
      } catch (e0) {}
      typographyListener = null;

      try {
        if (themeListener && typeof document !== 'undefined' && document && typeof document.removeEventListener === 'function') {
          document.removeEventListener('xkeen-theme-change', themeListener);
        }
      } catch (e01) {}
      themeListener = null;

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

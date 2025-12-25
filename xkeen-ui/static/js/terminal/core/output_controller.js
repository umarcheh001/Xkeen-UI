// Terminal core: output controller
//
// Stage 5:
//   - Subscribe to ctx.transport.onMessage
//   - Apply optional post-processing for plain-text streams
//   - Render to xterm and keep follow-to-bottom
//   - Emit `term:output:raw` and `term:output` events for other modules

(function () {
  'use strict';

  window.XKeen = window.XKeen || {};
  window.XKeen.terminal = window.XKeen.terminal || {};
  window.XKeen.terminal.core = window.XKeen.terminal.core || {};
  function getPrefs(ctx) {
    // Stage 8.3.2: one source of truth lives in modules/output_prefs + core/config.
    try {
      if (ctx && ctx.outputPrefs && typeof ctx.outputPrefs.getPrefs === 'function') {
        const p = ctx.outputPrefs.getPrefs();
        if (p && typeof p === 'object') {
          return {
            ansiFilter: !!p.ansiFilter,
            logHl: !!p.logHl,
            follow: !!p.follow,
          };
        }
      }
    } catch (e) {}

    // Fallback: read from ctx.config (still centralized; no localStorage here).
    let ansiFilter = false;
    let logHl = true;
    let follow = true;
    try {
      if (ctx && ctx.config && typeof ctx.config.get === 'function') {
        ansiFilter = !!ctx.config.get('ansiFilter', ansiFilter);
        logHl = !!ctx.config.get('logHl', logHl);
        follow = !!ctx.config.get('follow', follow);
      }
    } catch (e2) {}
    return { ansiFilter, logHl, follow };
  }

// In PTY mode we normally must not touch the byte stream (interactive TUIs rely on escape codes).
  // Post-processing is allowed only for "plain text" chunks:
  //  - no ESC/CSI
  //  - no control chars except TAB/LF/CR/BS
  function canProcessPtyChunk(chunk) {
    if (!chunk) return false;
    const s = String(chunk);
    if (s.indexOf('\x1b') !== -1 || s.indexOf('\x9b') !== -1) return false;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c < 32) {
        if (c !== 9 && c !== 10 && c !== 13 && c !== 8) return false;
      }
    }
    return true;
  }

  // Basic ANSI stripper (CSI + OSC)
  function stripAnsi(text) {
    if (!text) return '';
    const s = String(text);
    const noOsc = s.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '');
    return noOsc.replace(/\x1b\[[0-9;?]*[@-~]/g, '');
  }

  function highlightLogs(text) {
    if (!text) return '';
    let s = String(text);

    const RESET = '\x1b[0m';
    const DIM = '\x1b[90m';
    const BOLD = '\x1b[1m';

    const RED = '\x1b[31m';
    const YELLOW = '\x1b[33m';
    const GREEN = '\x1b[32m';
    const BLUE = '\x1b[34m';
    const MAGENTA = '\x1b[35m';
    const CYAN = '\x1b[36m';

    const wrap = (color, str, bold) => `${bold ? BOLD : ''}${color}${str}${RESET}`;

    // 1) Timestamps (dim)
    s = s.replace(
      /(\b\d{4}[-\/]\d{2}[-\/]\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:[\.,]\d+)?Z?\b)/g,
      (m) => wrap(DIM, m)
    );

    // 2) Bracket-style levels
    s = s.replace(/\[(Warning|Warn|Info|Debug|Error)\]/gi, (m, lvl) => {
      const L = String(lvl || '').toLowerCase();
      if (L === 'error') return '[' + wrap(RED, 'Error', true) + ']';
      if (L === 'warning' || L === 'warn') return '[' + wrap(YELLOW, 'Warning', true) + ']';
      if (L === 'debug') return '[' + wrap(MAGENTA, 'Debug', true) + ']';
      return '[' + wrap(CYAN, 'Info', true) + ']';
    });

    // 3) JSON level field
    s = s.replace(/("level"\s*:\s*")([a-zA-Z]+)(")/g, (m, p1, lvl, p3) => {
      const L = String(lvl || '').toLowerCase();
      let colored = lvl;
      if (L === 'error' || L === 'fatal' || L === 'critical') colored = wrap(RED, lvl, true);
      else if (L === 'warn' || L === 'warning') colored = wrap(YELLOW, lvl, true);
      else if (L === 'debug' || L === 'trace') colored = wrap(MAGENTA, lvl, true);
      else if (L === 'info') colored = wrap(CYAN, lvl, true);
      return String(p1) + colored + String(p3);
    });

    // 4) Standalone level tokens
    s = s
      .replace(/\b(ERR|ERROR|FATAL|CRIT(?:ICAL)?|PANIC)\b/gi, (m) => wrap(RED, m, true))
      .replace(/\b(WARN(?:ING)?)\b/gi, (m) => wrap(YELLOW, m, true))
      .replace(/\b(INFO)\b/gi, (m) => wrap(CYAN, m, true))
      .replace(/\b(DEBUG|TRACE)\b/gi, (m) => wrap(MAGENTA, m, true));

    // 5) Common components
    s = s.replace(/\b(inbound|outbound|proxy|routing|dns|sniffing|tls|http|https|socks|vmess|vless|trojan|grpc|ws|tcp|udp)\b/gi, (m) => wrap(BLUE, m));

    // 6) IP(:port)
    s = s.replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/g, (m) => wrap(CYAN, m));

    // 7) Domains
    s = s.replace(/\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,}|xn--[a-z0-9-]{2,})\b/gi, (m) => wrap(GREEN, m));

    // 8) Failure-ish verbs
    s = s.replace(/\b(failed|failure|denied|reject(?:ed)?|blocked|timeout|timed\s*out|refused|unreachable)\b/gi, (m) => wrap(RED, m));

    return s;
  }

  function safeWrite(term, s) {
    if (!term) return;
    try {
      if (typeof term.write === 'function') term.write(String(s));
      else if (typeof term.writeln === 'function') term.writeln(String(s));
    } catch (e) {}
  }

  function resolveTerm(ctx) {
    // Prefer xterm manager
    try {
      if (ctx && ctx.xterm && typeof ctx.xterm.getRefs === 'function') {
        const r = ctx.xterm.getRefs();
        if (r && r.term) return r.term;
      }
    } catch (e) {}
    // Fallback to core/state refs
    try {
      const st = (ctx && ctx.core && ctx.core.state) ? ctx.core.state : (ctx && ctx.state ? ctx.state : null);
      if (st && (st.term || st.xterm)) return st.term || st.xterm;
    } catch (e2) {}
    return null;
  }

  function autoFollow(ctx, term) {
    const prefs = getPrefs(ctx);
    if (!prefs.follow) return;
    try {
      if (term && typeof term.scrollToBottom === 'function') {
        term.scrollToBottom();
        return;
      }
    } catch (e) {}
    try {
      const out = (ctx && ctx.ui && ctx.ui.get && typeof ctx.ui.get.outputPre === 'function') ? ctx.ui.get.outputPre() : null;
      if (out) out.scrollTop = out.scrollHeight;
    } catch (e2) {}
  }

  function createOutputController(ctx) {
    const events = (ctx && ctx.events) ? ctx.events : { emit: () => {}, on: () => () => {} };
    const transport = (ctx && ctx.transport) ? ctx.transport : null;

    let offMsg = null;
    let offPrint = null;
    let seq = 0;

    function markSensitiveFromOutput(chunk) {
      try {
        const H = (window.XKeen && window.XKeen.terminal) ? window.XKeen.terminal.history : null;
        if (H && typeof H.markSensitiveFromOutput === 'function') {
          H.markSensitiveFromOutput(chunk);
        }
      } catch (e) {}
    }

    function handleMessage(chunk, meta) {
      const raw = (typeof chunk === 'string') ? chunk : String(chunk == null ? '' : chunk);
      const m = (meta && typeof meta === 'object') ? meta : {};
      const source = m.source ? String(m.source) : 'unknown';

      const msgSeq = (m.seq != null) ? m.seq : (++seq);

      // Keep other modules compatible: raw output event
      try {
        events.emit('term:output:raw', {
          chunk: raw,
          source: source,
          seq: msgSeq,
          ts: m.ts || Date.now(),
        });
      } catch (e) {}

      try { markSensitiveFromOutput(raw); } catch (e2) {}

      let out = raw;

      try {
        const prefs = getPrefs(ctx);
        const allowProcess = (source !== 'pty') || canProcessPtyChunk(raw);
        if (prefs && allowProcess) {
          try { out = out.replace(/\r\n/g, '\n'); } catch (e0) {}
          if (prefs.ansiFilter) out = stripAnsi(out);
          if (prefs.logHl) out = highlightLogs(out);
        }
      } catch (e4) {
        out = raw;
      }

      try {
        events.emit('output:chunk', {
          chunk: out,
          raw: raw,
          source: source,
          seq: msgSeq,
          ts: m.ts || Date.now(),
        });
      } catch (e5a) {}

      try {
        events.emit('term:output', {
          chunk: out,
          raw: raw,
          source: source,
          seq: msgSeq,
          ts: m.ts || Date.now(),
        });
      } catch (e5) {}

      // Render
      const term = resolveTerm(ctx);
      try { safeWrite(term, out); } catch (e6) {}
      try { autoFollow(ctx, term); } catch (e7) {}
    }

    function init() {
      if (!transport || typeof transport.onMessage !== 'function') return;
      if (offMsg) return;
      try {
        offMsg = transport.onMessage((chunk, meta) => {
          try { handleMessage(chunk, meta); } catch (e) {}
        });
      } catch (e) {
        offMsg = null;
      }

      // Stage 7: allow "clean" commands to print via events (no DOM/xterm access).
      try {
        if (!offPrint && events && typeof events.on === 'function') {
          offPrint = events.on('term:print', (payload) => {
            try {
              if (payload && typeof payload === 'object' && Object.prototype.hasOwnProperty.call(payload, 'chunk')) {
                return handleMessage(payload.chunk, { source: payload.source || 'builtin', ts: payload.ts || Date.now() });
              }
              return handleMessage(payload, { source: 'builtin', ts: Date.now() });
            } catch (e2) {}
          });
        }
      } catch (e3) {}
    }

    function dispose() {
      try { if (offMsg) offMsg(); } catch (e) {}
      offMsg = null;
      try { if (offPrint) offPrint(); } catch (e2) {}
      offPrint = null;
    }

    return { init, dispose, handleMessage };
  }

  // Export factory
  window.XKeen.terminal.core.createOutputController = createOutputController;

  // Registry plugin wrapper (Stage D)
  window.XKeen.terminal.output_controller = {
    createModule: (ctx) => {
      const ctl = createOutputController(ctx);
      try { ctx.output = ctl; } catch (e) {}
      return {
        id: 'output_controller',
        priority: 20,
        init: () => { try { ctl.init(); } catch (e) {} },
        onOpen: () => { try { ctl.init(); } catch (e) {} },
        onClose: () => { try { ctl.dispose(); } catch (e) {} },
      };
    },
  };
})();

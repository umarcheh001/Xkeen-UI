// Terminal public API (Stage 8.2)
//
// One stable surface for external/legacy code:
//   - XKeen.terminal.api.*
//   - ctx.events (XKeen.terminal.core.getCtx().events)
//
// This file is safe to load early: all dependencies are resolved lazily.
(function () {
  'use strict';

  window.XKeen = window.XKeen || {};
  window.XKeen.terminal = window.XKeen.terminal || {};
  window.XKeen.terminal.core = window.XKeen.terminal.core || {};

  const KNOWN_MODES = { shell: true, xkeen: true, pty: true };

  function getCtx() {
    try {
      const core = window.XKeen && window.XKeen.terminal && window.XKeen.terminal.core;
      if (core && typeof core.getCtx === 'function') return core.getCtx();
    } catch (e) {}
    return null;
  }

  function getActions() {
    try {
      const T = window.XKeen && window.XKeen.terminal;
      if (T && T.ui_actions) return T.ui_actions;
    } catch (e) {}
    return {};
  }

  function emit(name, payload) {
    try {
      const ctx = getCtx();
      if (ctx && ctx.events && typeof ctx.events.emit === 'function') {
        ctx.events.emit(name, payload || {});
      }
    } catch (e) {}
  }

  function normalizeOpenArgs(a, b) {
    // Supported:
    //   open({cmd, mode})
    //   open(cmd, mode)
    //   open(mode)  // when mode is known and cmd omitted
    let cmd = '';
    let mode = '';

    if (a && typeof a === 'object') {
      cmd = (typeof a.cmd === 'string') ? a.cmd : '';
      mode = (typeof a.mode === 'string') ? a.mode : '';
      return { cmd, mode };
    }

    if (typeof a === 'string' && typeof b === 'string') {
      return { cmd: a, mode: b };
    }

    if (typeof a === 'string' && b == null) {
      const s = a.trim();
      // If it looks like a mode (and not a command), treat it as a mode.
      if (KNOWN_MODES[s] && s.indexOf(' ') === -1 && s.indexOf('\t') === -1) {
        return { cmd: '', mode: s };
      }
      return { cmd: a, mode: '' };
    }

    return { cmd: '', mode: '' };
  }

  function isOverlayOpen(el) {
    if (!el) return false;
    try {
      if (!el.isConnected) return false;
      const cs = window.getComputedStyle(el);
      if (!cs) return false;
      if (cs.display === 'none') return false;
      if (cs.visibility === 'hidden') return false;
      return true;
    } catch (e) {}
    try {
      return el.style.display !== 'none';
    } catch (e2) {}
    return false;
  }

  // Create once; methods are lazy so it is safe to keep a singleton.
  function createPublicApi() {
    async function open(a, b) {
      const { cmd, mode } = normalizeOpenArgs(a, b);
      emit('terminal:open:before', { cmd, mode });

      const actions = getActions();
      if (typeof actions.openTerminal === 'function') {
        const r = actions.openTerminal(cmd, mode || 'shell');
        emit('terminal:open', { cmd, mode: mode || 'shell' });
        return r;
      }

      // Last-resort fallback: use legacy internal implementations if present.
      try {
        const T = window.XKeen && window.XKeen.terminal;
        const legacy = T && T._legacy;
        if (legacy && typeof legacy.openTerminal === 'function') {
          const r2 = legacy.openTerminal(cmd, mode || 'shell');
          emit('terminal:open', { cmd, mode: mode || 'shell' });
          return r2;
        }
      } catch (e) {}

      emit('terminal:open:error', { cmd, mode, error: 'openTerminal unavailable' });
      return false;
    }

    function close() {
      emit('terminal:close:before', {});
      const actions = getActions();
      if (typeof actions.hideTerminal === 'function') {
        const r = actions.hideTerminal();
        emit('terminal:close', {});
        return r;
      }
      try {
        const T = window.XKeen && window.XKeen.terminal;
        const legacy = T && T._legacy;
        if (legacy && typeof legacy.hideTerminal === 'function') {
          const r2 = legacy.hideTerminal();
          emit('terminal:close', {});
          return r2;
        }
      } catch (e) {}
      // Minimal fallback: hide overlay.
      try {
        const el = document.getElementById('terminal-overlay');
        if (el) el.style.display = 'none';
      } catch (e2) {}
      emit('terminal:close', { fallback: true });
      return true;
    }

    async function toggle() {
      return isOpen() ? close() : open();
    }

    function setMode(mode) {
      const m = String(mode || 'shell').toLowerCase();
      const ctx = getCtx();
      try {
        if (ctx && ctx.session && typeof ctx.session.setMode === 'function') {
          ctx.session.setMode(m);
          return true;
        }
      } catch (e) {}
      try {
        if (ctx && ctx.core && typeof ctx.core.setMode === 'function') {
          ctx.core.setMode(m);
          return true;
        }
      } catch (e2) {}
      return false;
    }

    function getMode() {
      const ctx = getCtx();
      try {
        if (ctx && ctx.session && typeof ctx.session.getMode === 'function') return ctx.session.getMode() || 'shell';
      } catch (e) {}
      try {
        if (ctx && ctx.core && typeof ctx.core.getMode === 'function') return ctx.core.getMode() || 'shell';
      } catch (e2) {}
      try {
        if (ctx && ctx.state) {
          if (typeof ctx.state.get === 'function') return ctx.state.get('mode') || 'shell';
          if (typeof ctx.state.mode === 'string') return ctx.state.mode;
        }
      } catch (e3) {}
      return 'shell';
    }

    async function send(text, opts) {
      const ctx = getCtx();
      const payload = String(text == null ? '' : text);
      const o = opts || {};

      // raw -> transport only (no routing).
      if (o && o.raw) {
        try {
          if (ctx && ctx.transport && typeof ctx.transport.send === 'function') {
            const ok = ctx.transport.send(payload, o);
            return { handled: !!ok, result: { ok: !!ok, via: 'transport.send', raw: true } };
          }
        } catch (e) {}
        return { handled: false, result: { ok: false, error: 'no transport' } };
      }

      // default: route builtins then send to transport.
      try {
        if (ctx && ctx.router && typeof ctx.router.execute === 'function') {
          return await ctx.router.execute(payload, o);
        }
      } catch (e2) {}

      // Fallback: direct transport send.
      try {
        if (ctx && ctx.transport && typeof ctx.transport.send === 'function') {
          const hasNl = /\r|\n/.test(payload);
          const ok2 = ctx.transport.send(hasNl ? payload : (payload + '\n'), o);
          return { handled: !!ok2, result: { ok: !!ok2, via: 'transport.send' } };
        }
      } catch (e3) {}

      return { handled: false, result: { ok: false, error: 'no router/transport' } };
    }

    function isOpen() {
      try {
        const ctx = getCtx();
        const el = (ctx && ctx.dom && ctx.dom.overlay) ? ctx.dom.overlay : document.getElementById('terminal-overlay');
        return isOverlayOpen(el);
      } catch (e) {}
      return false;
    }

    function isConnected() {
      const ctx = getCtx();
      try {
        if (ctx && ctx.session && typeof ctx.session.isConnected === 'function') return !!ctx.session.isConnected();
      } catch (e) {}
      try {
        if (ctx && ctx.transport && typeof ctx.transport.isConnected === 'function') return !!ctx.transport.isConnected();
      } catch (e2) {}
      return false;
    }

    function selfTest() {
      const ctx = getCtx();
      const actions = getActions();
      const report = {
        ok: true,
        hasCtx: !!ctx,
        hasEvents: !!(ctx && ctx.events && typeof ctx.events.emit === 'function'),
        hasSession: !!(ctx && ctx.session),
        hasRouter: !!(ctx && ctx.router && typeof ctx.router.execute === 'function'),
        hasTransport: !!(ctx && ctx.transport && typeof ctx.transport.send === 'function'),
        hasXtermManager: !!(ctx && ctx.xterm && typeof ctx.xterm.getManager === 'function'),
        hasUiActions: !!(actions && (typeof actions.openTerminal === 'function') && (typeof actions.hideTerminal === 'function')),
        mode: (function () { try { return getMode(); } catch (e) { return 'shell'; } })(),
        open: (function () { try { return isOpen(); } catch (e) { return false; } })(),
        connected: (function () { try { return isConnected(); } catch (e) { return false; } })(),
      };
      report.ok = !!(report.hasCtx && report.hasEvents && report.hasSession && report.hasTransport);
      return report;
    }

    return {
      open,
      close,
      toggle,
      setMode,
      getMode,
      send,
      isOpen,
      isConnected,
      selfTest,
    };
  }

  // Install a singleton if not present yet.
  if (!window.XKeen.terminal.api) {
    window.XKeen.terminal.api = createPublicApi();
  }

  // Expose factory for tests / advanced use.
  window.XKeen.terminal.core.createPublicApi = createPublicApi;
})();

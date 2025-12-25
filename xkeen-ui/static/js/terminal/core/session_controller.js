// Terminal core: session controller (connect/reconnect/switchMode)
// Stage 3: move connect/reconnect logic out of terminal.js
(function () {
  'use strict';

  window.XKeen = window.XKeen || {};
  window.XKeen.terminal = window.XKeen.terminal || {};
  window.XKeen.terminal.core = window.XKeen.terminal.core || {};

  function createSessionController(ctx) {
    const core = (ctx && ctx.core) ? ctx.core : (window.XKeen.terminal._core || null);
    const events = (ctx && ctx.events) ? ctx.events : { on: () => () => {}, off: () => {}, emit: () => {} };
    const log = (ctx && ctx.log) ? ctx.log : { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

    function emit(name, payload) {
      try { events.emit(String(name || ''), payload); } catch (e) {}
    }

    function getMode() {
      try {
        if (core && typeof core.getMode === 'function') return core.getMode() || 'shell';
      } catch (e) {}
      try {
        if (ctx && ctx.state) {
          if (typeof ctx.state.get === 'function') return ctx.state.get('mode') || 'shell';
          return ctx.state.mode || 'shell';
        }
      } catch (e2) {}
      return 'shell';
    }

    function setMode(mode) {
      const m = String(mode || 'shell');
      try { if (core && typeof core.setMode === 'function') core.setMode(m); } catch (e) {}
      try {
        if (ctx && ctx.state) {
          if (typeof ctx.state.set === 'function') ctx.state.set('mode', m);
          else ctx.state.mode = m;
        }
      } catch (e2) {}
      emit('session:modeChanged', { mode: m });
    }


    function pty() {
      try {
        const P = window.XKeen && window.XKeen.terminal ? window.XKeen.terminal.pty : null;
        return P || null;
      } catch (e) {}
      return null;
    }

    function closePtyWsFallback(sendClose) {
      try {
        const st = (core && core.state) ? core.state : (ctx && ctx.state ? ctx.state : null);
        const ws = st ? st.ptyWs : null;
        if (!ws) return;
        try {
          if (sendClose && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'close' }));
          }
        } catch (e2) {}
        try { ws.__xkeen_manual_close = true; } catch (e3) {}
        try { ws.close(); } catch (e4) {}
        if (st) st.ptyWs = null;
      } catch (e) {}
    }

    function resolveTerm(opts) {
      const o = opts || {};
      if (o.term) return o.term;
      // Prefer xterm facade when available
      try {
        if (ctx && ctx.xterm && typeof ctx.xterm.ensureTerminal === 'function') {
          const r = ctx.xterm.ensureTerminal({});
          if (r && r.term) return r.term;
        }
      } catch (e) {}
      // Fallback to stored refs
      try {
        const st = (core && core.state) ? core.state : (ctx && ctx.state ? ctx.state : null);
        if (st && (st.term || st.xterm)) return st.term || st.xterm;
      } catch (e2) {}
      return null;
    }

    function getRetryState() {
      try {
        const P = pty();
        if (P && typeof P.getRetryState === 'function') return P.getRetryState();
      } catch (e) {}
      return { active: false, attempt: 0, nextAt: 0 };
    }

    function resetRetry(opts) {
      try {
        const P = pty();
        if (P && typeof P.resetRetry === 'function') return P.resetRetry(opts || {});
      } catch (e) {}
    }

    function stopRetry(opts) {
      try {
        const P = pty();
        if (P && typeof P.stopRetry === 'function') return P.stopRetry(opts || {});
      } catch (e) {}
    }

    function retryNow() {
      try {
        const P = pty();
        if (P && typeof P.retryNow === 'function') return P.retryNow();
      } catch (e) {}
    }

    function isConnected() {
      try {
        if (ctx && ctx.transport && typeof ctx.transport.isConnected === 'function') {
          return !!ctx.transport.isConnected();
        }
      } catch (e) {}
      try {
        const st = (core && core.state) ? core.state : (ctx && ctx.state ? ctx.state : null);
        const ws = st ? st.ptyWs : null;
        return !!(ws && ws.readyState === WebSocket.OPEN);
      } catch (e2) {}
      return false;
    }

    function connect(opts) {
      const o = opts || {};
      if (o.mode) setMode(o.mode);
      const mode = getMode();

      emit('session:connecting', { mode: mode });

      if (mode !== 'pty') {
        // Lite modes don't keep a persistent connection.
        emit('session:disconnected', { mode: mode, reason: 'lite' });
        return;
      }

      const term = resolveTerm(o);
      if (!term) {
        emit('session:error', { mode: 'pty', message: 'xterm missing' });
        return;
      }

      const P = pty();
      if (!P || typeof P.connect !== 'function') {
        emit('session:error', { mode: 'pty', message: 'pty.js missing' });
        return;
      }

      try {
        P.connect(term, { preserveScreen: !!o.preserveScreen });
      } catch (e) {
        log.error('PTY connect failed', e);
        emit('session:error', { mode: 'pty', message: 'connect failed', detail: String(e && e.message ? e.message : e) });
      }
    }

    function disconnect(opts) {
      const o = opts || {};
      const mode = getMode();
      if (mode !== 'pty') {
        emit('session:disconnected', { mode: mode, reason: 'disconnect' });
        return;
      }

      const P = pty();
      if (P && typeof P.disconnect === 'function') {
        try {
          P.disconnect({
            sendClose: (o.sendClose !== false),
            clearSession: !!o.clearSession,
            reason: o.reason,
          });
          return;
        } catch (e) {}
      }

      // Fallback: close WS directly
      closePtyWsFallback(o.sendClose !== false);
      emit('session:disconnected', { mode: 'pty', reason: 'disconnect_fallback' });
    }

    function reconnect(opts) {
      const o = opts || {};
      // Always reconnect in PTY
      setMode('pty');
      try { resetRetry({ unblock: true }); } catch (e) {}
      connect({ mode: 'pty', term: o.term || null, preserveScreen: true });
    }

    function switchMode(mode, opts) {
      const next = String(mode || 'shell');
      const prev = getMode();
      const o = opts || {};

      if (prev === next) {
        if (o.reconnect && next === 'pty') return reconnect(o);
        if (o.autoConnect && next === 'pty') return connect({ mode: 'pty', term: o.term || null, preserveScreen: !!o.preserveScreen });
        return;
      }

      // Leaving PTY -> close session by default.
      if (prev === 'pty' && next !== 'pty') {
        try { stopRetry({ silent: true }); } catch (e) {}
        try { disconnect({ sendClose: true, reason: 'modeChange' }); } catch (e2) {}
      }

      setMode(next);
      emit('session:modeChanged', { from: prev, to: next, mode: next });

      if (next === 'pty') {
        if (o.autoConnect === false) return;
        return connect({ mode: 'pty', term: o.term || null, preserveScreen: !!o.preserveScreen });
      }

      // In lite modes keep lamp in a known state.
      emit('session:disconnected', { mode: next, reason: 'lite' });
    }

    return {
      getMode,
      setMode,
      connect,
      disconnect,
      reconnect,
      switchMode,
      isConnected,
      // retry helpers (PTY)
      getRetryState,
      resetRetry,
      stopRetry,
      retryNow,
    };
  }

  window.XKeen.terminal.core.createSessionController = createSessionController;
})();

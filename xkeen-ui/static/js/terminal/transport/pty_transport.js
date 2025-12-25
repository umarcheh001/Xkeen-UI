// Transport adapter: PTY (WebSocket) — wraps terminal/pty.js
//
// Stage 4 contract:
//   connect() / disconnect() / send(data, opts?)
//   onMessage(cb) / onClose(cb) / onError(cb)
//
// Notes:
// - No DOM access.
// - Output is delivered via ctx.events (`transport:message`) emitted by pty.js.
(function () {
  'use strict';

  window.XKeen = window.XKeen || {};
  window.XKeen.terminal = window.XKeen.terminal || {};
  window.XKeen.terminal.transport = window.XKeen.terminal.transport || {};

  function createPtyTransport(ctx) {
    const core = (ctx && ctx.core) ? ctx.core : (window.XKeen.terminal._core || null);
    const events = (ctx && ctx.events) ? ctx.events : { on: () => () => {}, off: () => {}, emit: () => {} };

    const onMsgCbs = new Set();
    const onCloseCbs = new Set();
    const onErrCbs = new Set();

    let offRaw = null;
    let offClose = null;
    let offErr = null;

    function ensureSubscriptions() {
      if (!events || typeof events.on !== 'function') return;
      if (!offRaw) {
        // Stage 5: PTY output enters the system via `transport:message` events from pty.js.
        offRaw = events.on('transport:message', (payload) => {
          try {
            if (!payload || payload.source !== 'pty') return;
            const chunk = (typeof payload.chunk === 'string') ? payload.chunk : String(payload.chunk == null ? '' : payload.chunk);
            onMsgCbs.forEach((cb) => {
              try { cb(chunk, payload); } catch (e) {}
            });
          } catch (e) {}
        });
      }
      if (!offClose) {
        offClose = events.on('pty:disconnected', (payload) => {
          onCloseCbs.forEach((cb) => {
            try { cb(payload || {}); } catch (e) {}
          });
        });
      }
      if (!offErr) {
        offErr = events.on('pty:error', (payload) => {
          onErrCbs.forEach((cb) => {
            try { cb(payload || {}); } catch (e) {}
          });
        });
      }
    }

    function pty() {
      return (window.XKeen && window.XKeen.terminal && window.XKeen.terminal.pty) ? window.XKeen.terminal.pty : null;
    }

    function resolveTerm() {
      // No xterm manager calls here (transport must stay UI-agnostic).
      try {
        const st = (core && core.state) ? core.state : (ctx && ctx.state ? ctx.state : null);
        return st ? (st.term || st.xterm) : null;
      } catch (e2) {}
      return null;
    }

    function connect(opts) {
      ensureSubscriptions();
      const P = pty();
      if (!P || typeof P.connect !== 'function') return;
      const term = resolveTerm();
      if (!term) return;
      try { return P.connect(term, opts || {}); } catch (e) {}
    }

    function disconnect(opts) {
      const P = pty();
      if (P && typeof P.disconnect === 'function') return P.disconnect(opts || {});
    }

    function isConnected() {
      try {
        const st = (core && core.state) ? core.state : null;
        const ws = st ? st.ptyWs : null;
        return !!(ws && ws.readyState === WebSocket.OPEN);
      } catch (e) {}
      return false;
    }

    function send(data, opts) {
      const payload = String(data == null ? '' : data);

      const P = pty();
      if (P && typeof P.sendRaw === 'function') {
        try { P.sendRaw(payload); return true; } catch (e) {}
      }
      return false;
    }

    function resize(cols, rows) {
      try {
        const st = (core && core.state) ? core.state : null;
        const ws = st ? st.ptyWs : null;
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        const c = Number(cols || 0);
        const r = Number(rows || 0);
        if (!c || !r) return;
        ws.send(JSON.stringify({ type: 'resize', cols: c, rows: r }));
      } catch (e) {}
    }

    function onMessage(cb) {
      if (typeof cb !== 'function') return () => {};
      ensureSubscriptions();
      onMsgCbs.add(cb);
      return () => { try { onMsgCbs.delete(cb); } catch (e) {} };
    }
    function onClose(cb) {
      if (typeof cb !== 'function') return () => {};
      ensureSubscriptions();
      onCloseCbs.add(cb);
      return () => { try { onCloseCbs.delete(cb); } catch (e) {} };
    }
    function onError(cb) {
      if (typeof cb !== 'function') return () => {};
      ensureSubscriptions();
      onErrCbs.add(cb);
      return () => { try { onErrCbs.delete(cb); } catch (e) {} };
    }

    return { kind: 'pty', connect, disconnect, isConnected, send, resize, onMessage, onClose, onError };
  }

  window.XKeen.terminal.transport.createPtyTransport = createPtyTransport;
})();

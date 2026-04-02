import {
  getTerminalCompatApi,
  getTerminalPtyApi,
  publishTerminalTransportCompatApi,
} from '../runtime.js';

// Transport adapter: PTY (WebSocket) вЂ” wraps terminal/pty.js
(function () {
  'use strict';

  function createPtyTransport(ctx) {
    const core = (ctx && ctx.core) ? ctx.core : getTerminalCompatApi('_core');
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
      return getTerminalPtyApi();
    }

    function resolveTerm() {
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

    function send(data) {
      const payload = String(data == null ? '' : data);
      const P = pty();
      if (P && typeof P.sendRaw === 'function') {
        try { return !!P.sendRaw(payload); } catch (e) {}
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

  publishTerminalTransportCompatApi('createPtyTransport', createPtyTransport);
})();

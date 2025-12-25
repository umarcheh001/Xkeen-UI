// Transport manager: chooses PTY or Lite based on current terminal mode
(function () {
  'use strict';

  window.XKeen = window.XKeen || {};
  window.XKeen.terminal = window.XKeen.terminal || {};
  window.XKeen.terminal.transport = window.XKeen.terminal.transport || {};

  function createTransportManager(ctx) {
    const core = (ctx && ctx.core) ? ctx.core : (window.XKeen.terminal._core || null);

    function getMode() {
      try { if (ctx && ctx.session && typeof ctx.session.getMode === 'function') return ctx.session.getMode() || 'shell'; } catch (e) {}
      try { if (core && typeof core.getMode === 'function') return core.getMode() || 'shell'; } catch (e2) {}
      try {
        if (ctx && ctx.state) {
          if (typeof ctx.state.get === 'function') return ctx.state.get('mode') || 'shell';
          return ctx.state.mode || 'shell';
        }
      } catch (e3) {}
      return 'shell';
    }

    const ptyT = (window.XKeen.terminal.transport.createPtyTransport)
      ? window.XKeen.terminal.transport.createPtyTransport(ctx)
      : null;
    const liteT = (window.XKeen.terminal.transport.createLiteTransport)
      ? window.XKeen.terminal.transport.createLiteTransport(ctx)
      : null;

    function active() {
      const mode = getMode();
      if (mode === 'pty') return ptyT || liteT;
      return liteT || ptyT;
    }

    function kind() {
      const t = active();
      return t && t.kind ? t.kind : 'unknown';
    }

    return {
      get kind() { return kind(); },
      connect: () => { const t = active(); return t && t.connect ? t.connect() : undefined; },
      disconnect: () => { const t = active(); return t && t.disconnect ? t.disconnect() : undefined; },
      isConnected: () => { const t = active(); return t && t.isConnected ? t.isConnected() : false; },
      send: (data, opts) => { const t = active(); return t && t.send ? t.send(data, opts) : false; },
      resize: (c, r) => { const t = active(); return t && t.resize ? t.resize(c, r) : undefined; },

      // Stage 4 unified transport callbacks.
      // We attach listeners to both transports so callers don't have to re-subscribe on mode switches.
      onMessage: (cb) => {
        const off1 = (ptyT && typeof ptyT.onMessage === 'function') ? ptyT.onMessage(cb) : (() => {});
        const off2 = (liteT && typeof liteT.onMessage === 'function') ? liteT.onMessage(cb) : (() => {});
        return () => { try { off1(); } catch (e) {} try { off2(); } catch (e2) {} };
      },
      onClose: (cb) => {
        const off1 = (ptyT && typeof ptyT.onClose === 'function') ? ptyT.onClose(cb) : (() => {});
        const off2 = (liteT && typeof liteT.onClose === 'function') ? liteT.onClose(cb) : (() => {});
        return () => { try { off1(); } catch (e) {} try { off2(); } catch (e2) {} };
      },
      onError: (cb) => {
        const off1 = (ptyT && typeof ptyT.onError === 'function') ? ptyT.onError(cb) : (() => {});
        const off2 = (liteT && typeof liteT.onError === 'function') ? liteT.onError(cb) : (() => {});
        return () => { try { off1(); } catch (e) {} try { off2(); } catch (e2) {} };
      },
    };
  }

  window.XKeen.terminal.transport.createTransportManager = createTransportManager;
})();

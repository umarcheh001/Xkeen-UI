import {
  getTerminalMode,
  getTerminalTransportCompatApi,
  publishTerminalTransportCompatApi,
} from '../runtime.js';

// Transport manager: chooses PTY or Lite based on current terminal mode
(function () {
  'use strict';

  function createTransportManager(ctx) {
    const createPtyTransport = getTerminalTransportCompatApi('createPtyTransport');
    const createLiteTransport = getTerminalTransportCompatApi('createLiteTransport');

    const ptyT = (typeof createPtyTransport === 'function') ? createPtyTransport(ctx) : null;
    const liteT = (typeof createLiteTransport === 'function') ? createLiteTransport(ctx) : null;

    function active() {
      const mode = getTerminalMode(ctx);
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

  publishTerminalTransportCompatApi('createTransportManager', createTransportManager);
})();

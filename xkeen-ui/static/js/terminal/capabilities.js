import {
  getTerminalById,
  getTerminalCompatApi,
  getTerminalContext,
  getTerminalCoreHttpApi,
  publishTerminalCompatApi,
  publishXkeenCompatValue,
  setTerminalCapabilityState,
} from './runtime.js';

// Terminal capabilities: detect backend features (/api/capabilities)
(function () {
  'use strict';

  const core = getTerminalCompatApi('_core');

  let HAS_WS = false;
  let HAS_PTY = false;
  let INIT_PROMISE = null;

  function getCtx() {
    return getTerminalContext();
  }

  function byId(id) {
    return getTerminalById(id, (key) => {
      try {
        return (core && typeof core.byId === 'function') ? core.byId(key) : null;
      } catch (error) {
        return null;
      }
    });
  }

  function setVisible(el, on) {
    try {
      const ctx = getCtx();
      if (ctx && ctx.ui && ctx.ui.set && typeof ctx.ui.set.visible === 'function') return ctx.ui.set.visible(el, !!on);
    } catch (e) {}
    if (!el) return;
    try { el.style.display = on ? '' : 'none'; } catch (e2) {}
  }

  function setEnabled(el, on) {
    try {
      const ctx = getCtx();
      if (ctx && ctx.ui && ctx.ui.set && typeof ctx.ui.set.enabled === 'function') return ctx.ui.set.enabled(el, !!on);
    } catch (e) {}
    if (!el) return;
    try { el.disabled = !on; } catch (e2) {}
  }

  function pickPtyCapability(data) {
    if (data && data.terminal && typeof data.terminal === 'object' && 'pty' in data.terminal) {
      return !!data.terminal.pty;
    }
    return !!(data && data.websocket);
  }

  function initCapabilities() {
    if (INIT_PROMISE) return INIT_PROMISE;
    INIT_PROMISE = (async () => {
      try {
        const http = getTerminalCoreHttpApi();
        let data = null;
        if (http && typeof http.fetchJSON === 'function') {
          data = await http.fetchJSON('/api/capabilities', {
            method: 'GET',
            timeoutMs: 6000,
            retry: 1,
          });
        } else {
          const resp = await fetch('/api/capabilities', { cache: 'no-store' });
          if (!resp.ok) throw new Error('http ' + resp.status);
          data = await resp.json().catch(() => ({}));
        }
        HAS_WS = !!(data && data.websocket);
        HAS_PTY = pickPtyCapability(data);
      } catch (e) {
        // On error we assume WS/PTy are not available and fall back to HTTP mode.
        HAS_WS = false;
        HAS_PTY = false;
      }

      try {
        if (core && core.state) core.state.hasWs = HAS_WS;
      } catch (e) {}
      try {
        if (core && core.state) core.state.hasPty = HAS_PTY;
      } catch (e2) {}
      try { setTerminalCapabilityState(HAS_WS, HAS_PTY); } catch (e3) {}

      try { applyWsCapabilityUi(); } catch (e) {}
      return HAS_WS;
    })();
    return INIT_PROMISE;
  }

  // Apply capability-dependent UI.
  // Desired behavior:
  // - If PTY is available: show ONLY the full Interactive PTY shell button.
  // - If PTY is NOT available: show ONLY the lite HTTP terminal button.
  function applyWsCapabilityUi() {
    // Buttons in "Команды" header
    const shellBtn = byId('terminal-open-shell-btn');
    const ptyBtn = byId('terminal-open-pty-btn');

    // If markup changed, best-effort: do nothing.
    if (!shellBtn && !ptyBtn) return;

    if (HAS_PTY) {
      // Powerful routers: keep only PTY (Interactive Shell)
      if (ptyBtn) {
        setVisible(ptyBtn, true);
        setEnabled(ptyBtn, true);
      }
      if (shellBtn) {
        setVisible(shellBtn, false);
        setEnabled(shellBtn, false);
      }
    } else {
      // Weak routers: keep only lite terminal
      if (ptyBtn) {
        setVisible(ptyBtn, false);
        setEnabled(ptyBtn, false);
      }
      if (shellBtn) {
        setVisible(shellBtn, true);
        setEnabled(shellBtn, true);
      }
    }
  }

  function hasWs() { return !!HAS_WS; }
  function hasPty() { return !!HAS_PTY; }

  // Backward compatible aliases (some legacy code used these names)
  publishXkeenCompatValue('terminalApplyWsCapabilityUi', applyWsCapabilityUi);
  publishXkeenCompatValue('terminalApplyCapabilityUi', applyWsCapabilityUi);

  publishTerminalCompatApi('capabilities', {
    initCapabilities,
    applyWsCapabilityUi,
    hasWs,
    hasPty,
  });
})();

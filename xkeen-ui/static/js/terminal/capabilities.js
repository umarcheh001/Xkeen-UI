// Terminal capabilities: detect backend features (/api/capabilities)
(function () {
  'use strict';

  window.XKeen = window.XKeen || {};
  window.XKeen.terminal = window.XKeen.terminal || {};
  const core = (window.XKeen.terminal && window.XKeen.terminal._core) ? window.XKeen.terminal._core : null;

  let HAS_WS = false;
  let INIT_PROMISE = null;

  function getCtx() {
    try {
      const C = window.XKeen && window.XKeen.terminal && window.XKeen.terminal.core ? window.XKeen.terminal.core : null;
      if (C && typeof C.getCtx === 'function') return C.getCtx();
    } catch (e) {}
    return null;
  }

  function byId(id) {
    try {
      const ctx = getCtx();
      if (ctx && ctx.ui && typeof ctx.ui.byId === 'function') return ctx.ui.byId(id);
    } catch (e) {}
    try {
      if (core && typeof core.byId === 'function') return core.byId(id);
    } catch (e2) {}
    return null;
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

  function initCapabilities() {
    if (INIT_PROMISE) return INIT_PROMISE;
    INIT_PROMISE = (async () => {
      try {
        const resp = await fetch('/api/capabilities', { cache: 'no-store' });
        if (!resp.ok) throw new Error('http ' + resp.status);
        const data = await resp.json().catch(() => ({}));
        HAS_WS = !!(data && data.websocket);
      } catch (e) {
        // On error we assume WS is not available and fall back to HTTP mode.
        HAS_WS = false;
      }

      try {
        if (core && core.state) core.state.hasWs = HAS_WS;
      } catch (e) {}

      try { applyWsCapabilityUi(); } catch (e) {}
      return HAS_WS;
    })();
    return INIT_PROMISE;
  }

  // Apply capability-dependent UI.
  // Desired behavior:
  // - If WS (gevent-websocket) is available: show ONLY the full Interactive PTY shell button.
  // - If WS is NOT available: show ONLY the lite HTTP terminal button.
  function applyWsCapabilityUi() {
    // Buttons in "Команды" header
    const shellBtn = byId('terminal-open-shell-btn');
    const ptyBtn = byId('terminal-open-pty-btn');

    // If markup changed, best-effort: do nothing.
    if (!shellBtn && !ptyBtn) return;

    if (HAS_WS) {
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

  // Backward compatible aliases (some legacy code used these names)
  window.XKeen.terminalApplyWsCapabilityUi = applyWsCapabilityUi;

  window.XKeen.terminal.capabilities = {
    initCapabilities,
    applyWsCapabilityUi,
    hasWs,
  };
})();

// Terminal capabilities: detect backend features (/api/capabilities)
(function () {
  'use strict';

  window.XKeen = window.XKeen || {};
  window.XKeen.terminal = window.XKeen.terminal || {};
  const core = (window.XKeen.terminal && window.XKeen.terminal._core) ? window.XKeen.terminal._core : null;

  let HAS_WS = false;

  async function initCapabilities() {
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
  }

  // Apply capability-dependent UI.
  // Desired behavior:
  // - If WS (gevent-websocket) is available: show ONLY the full Interactive PTY shell button.
  // - If WS is NOT available: show ONLY the lite HTTP terminal button.
  function applyWsCapabilityUi() {
    // Buttons in "Команды" header
    const shellBtn = document.getElementById('terminal-open-shell-btn');
    const ptyBtn = document.getElementById('terminal-open-pty-btn');

    // If markup changed, best-effort: do nothing.
    if (!shellBtn && !ptyBtn) return;

    if (HAS_WS) {
      // Powerful routers: keep only PTY (Interactive Shell)
      if (ptyBtn) {
        ptyBtn.style.display = '';
        ptyBtn.disabled = false;
      }
      if (shellBtn) {
        shellBtn.style.display = 'none';
        shellBtn.disabled = true;
      }
    } else {
      // Weak routers: keep only lite terminal
      if (ptyBtn) {
        ptyBtn.style.display = 'none';
        ptyBtn.disabled = true;
      }
      if (shellBtn) {
        shellBtn.style.display = '';
        shellBtn.disabled = false;
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

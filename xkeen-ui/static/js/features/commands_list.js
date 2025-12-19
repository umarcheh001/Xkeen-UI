(() => {
  'use strict';

  window.XKeen = window.XKeen || {};
  XKeen.features = XKeen.features || {};
  XKeen.features.commandsList = XKeen.features.commandsList || {};

  const CL = XKeen.features.commandsList;

  function hasTerminalApi() {
    return !!(XKeen.terminal && typeof XKeen.terminal.open === 'function');
  }

  function hasWs() {
    try {
      return !!(
        XKeen.terminal &&
        XKeen.terminal.capabilities &&
        typeof XKeen.terminal.capabilities.hasWs === 'function' &&
        XKeen.terminal.capabilities.hasWs()
      );
    } catch (e) {
      return false;
    }
  }

  function isPtyConnected() {
    try {
      const leg = XKeen.terminal && XKeen.terminal._legacy;
      if (leg && typeof leg.isPtyConnected === 'function') return !!leg.isPtyConnected();
    } catch (e) {}
    return false;
  }

  function sendPtyRaw(payload) {
    try {
      const leg = XKeen.terminal && XKeen.terminal._legacy;
      if (leg && typeof leg.sendPtyRaw === 'function') return leg.sendPtyRaw(String(payload || ''));
    } catch (e) {}
  }

  function focusTerminal() {
    try {
      const leg = XKeen.terminal && XKeen.terminal._legacy;
      if (leg && typeof leg.focus === 'function') return leg.focus();
    } catch (e) {}
  }


  function waitForPtyConnected(timeoutMs = 6000, intervalMs = 150) {
    const deadline = Date.now() + Math.max(500, timeoutMs);
    return new Promise((resolve) => {
      const tick = () => {
        if (isPtyConnected()) return resolve(true);
        if (Date.now() > deadline) return resolve(false);
        setTimeout(tick, intervalMs);
      };
      tick();
    });
  }

  async function openPtyAndRun(cmd) {
    // Open full Interactive Shell (PTY) and execute the command inside PTY.
    try {
      if (hasTerminalApi()) {
        XKeen.terminal.open(null, { cmd: '', mode: 'pty' });
      } else if (typeof window.openTerminal === 'function') {
        window.openTerminal('', 'pty');
      }
    } catch (e) {}

    const ok = await waitForPtyConnected();
    if (!ok) {
      toast('PTY не подключён (WebSocket недоступен или не успел подключиться)', 'info');
      return false;
    }

    try {
      // Use \r to match Enter for PTY.
      sendPtyRaw(String(cmd || '') + '\r');
      focusTerminal();
      return true;
    } catch (e) {
      toast('Не удалось отправить команду в PTY', 'error');
      return false;
    }
  }

  // Command list wiring:
  // - On devices with WS (gevent-websocket): open ONLY PTY terminal and run the command there.
  // - On devices without WS: fallback to lite terminal with a prefilled line (previous behavior).
  CL.init = function init() {
    const items = document.querySelectorAll('.command-item');
    if (!items || !items.length) return;

    items.forEach((el) => {
      el.addEventListener('click', async () => {
        const flag = el.getAttribute('data-flag');
        const label = el.getAttribute('data-label') || ('xkeen ' + flag);
        if (!flag) return;

        if (hasWs()) {
          await openPtyAndRun(label);
          return;
        }

        // No WS => keep old: open terminal with suggested command (does not auto-execute).
        if (hasTerminalApi()) {
          try {
            XKeen.terminal.open(null, { cmd: label, mode: 'xkeen' });
            return;
          } catch (e) {}
        }

        // Very old fallback: global openTerminal.
        try {
          if (typeof window.openTerminal === 'function') window.openTerminal(label, 'xkeen');
        } catch (e) {}
      });
    });
  };
})();

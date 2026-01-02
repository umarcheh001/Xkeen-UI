(() => {
  'use strict';

  window.XKeen = window.XKeen || {};
  XKeen.features = XKeen.features || {};
  XKeen.features.commandsList = XKeen.features.commandsList || {};

  const CL = XKeen.features.commandsList;

  function hasTerminalApi() {
    // Stage 8.2: prefer the stable public API.
    if (XKeen.terminal && XKeen.terminal.api && typeof XKeen.terminal.api.open === 'function') return true;
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
    // New API: ctx/transport
    try {
      const ctx = (XKeen.terminal && XKeen.terminal.core && typeof XKeen.terminal.core.getCtx === 'function')
        ? XKeen.terminal.core.getCtx()
        : null;
      if (ctx && ctx.transport && ctx.transport.kind === 'pty' && typeof ctx.transport.isConnected === 'function') {
        return !!ctx.transport.isConnected();
      }
      const st = ctx && ctx.core && ctx.core.state ? ctx.core.state : null;
      const ws = st ? st.ptyWs : null;
      return !!(ws && ws.readyState === WebSocket.OPEN);
    } catch (e) {}
    return false;
  }

  function sendPtyRaw(payload) {
    const data = String(payload == null ? '' : payload);

    // New API: ctx.transport
    try {
      const ctx = (XKeen.terminal && XKeen.terminal.core && typeof XKeen.terminal.core.getCtx === 'function')
        ? XKeen.terminal.core.getCtx()
        : null;
      if (ctx && ctx.transport && typeof ctx.transport.send === 'function') {
        if (ctx.transport.kind === 'pty') return !!ctx.transport.send(data, { prefer: 'pty', allowWhenDisconnected: false, source: 'commands_list' });
      }
    } catch (e0) {}
    // Backward compatibility fallback: send via modular PTY if present.
    try {
      const pty = window.XKeen && window.XKeen.terminal ? window.XKeen.terminal.pty : null;
      if (pty && typeof pty.sendRaw === 'function') { pty.sendRaw(data); return true; }
    } catch (e2) {}
    return false;
  }

  function focusTerminal() {
    try {
      const ctx = (XKeen.terminal && XKeen.terminal.core && typeof XKeen.terminal.core.getCtx === 'function')
        ? XKeen.terminal.core.getCtx()
        : null;
      const st = ctx && ctx.core && ctx.core.state ? ctx.core.state : null;
      const t = st ? (st.term || st.xterm) : null;
      if (t && typeof t.focus === 'function') return t.focus();
    } catch (e) {}
  }

  // Best-effort fix for rare cases when the terminal window opens slightly
  // outside of the viewport (e.g. header ends up above the top edge).
  function clampTerminalViewportSoon() {
    const run = () => {
      try {
        const ch = window.XKeen && window.XKeen.terminal && window.XKeen.terminal.chrome;
        if (ch && typeof ch.ensureInViewport === 'function') return ch.ensureInViewport();
        if (ch && typeof ch.onOpen === 'function') return ch.onOpen();
      } catch (e) {}
    };
    try { setTimeout(run, 0); } catch (e0) {}
    try { setTimeout(run, 120); } catch (e1) {}
    try { setTimeout(run, 360); } catch (e2) {}
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
      if (XKeen.terminal && XKeen.terminal.api && typeof XKeen.terminal.api.open === 'function') {
        XKeen.terminal.api.open('pty');
      } else if (hasTerminalApi()) {
        XKeen.terminal.open(null, { cmd: '', mode: 'pty' });
      } else if (typeof window.openTerminal === 'function') {
        window.openTerminal('', 'pty');
      }
    } catch (e) {}

    // Safety: ensure the window is visible even if it opened with a stale/buggy geometry.
    clampTerminalViewportSoon();

    const ok = await waitForPtyConnected();
    if (!ok) {
      toast('PTY не подключён (WebSocket недоступен или не успел подключиться)', 'info');
      return false;
    }

    try {
      // Use \r to match Enter for PTY.
      sendPtyRaw(String(cmd || '') + '\r');
      focusTerminal();
      clampTerminalViewportSoon();
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
            if (XKeen.terminal && XKeen.terminal.api && typeof XKeen.terminal.api.open === 'function') {
              XKeen.terminal.api.open({ cmd: label, mode: 'xkeen' });
              clampTerminalViewportSoon();
              return;
            }
            XKeen.terminal.open(null, { cmd: label, mode: 'xkeen' });
            clampTerminalViewportSoon();
            return;
          } catch (e) {}
        }

        // Very old fallback: global openTerminal.
        try {
          if (typeof window.openTerminal === 'function') {
            window.openTerminal(label, 'xkeen');
            clampTerminalViewportSoon();
          }
        } catch (e) {}
      });
    });
  };
})();

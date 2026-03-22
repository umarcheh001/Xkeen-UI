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

  function hasPty() {
    try {
      return !!(
        XKeen.terminal &&
        XKeen.terminal.capabilities &&
        typeof XKeen.terminal.capabilities.hasPty === 'function' &&
        XKeen.terminal.capabilities.hasPty()
      );
    } catch (e) {
      return false;
    }
  }

  // Terminal is now lazy-loaded; on a fresh tab capabilities may not be ready yet.
  // We use a lightweight direct probe as a fallback, so command buttons can still
  // choose PTY on supported devices without requiring an extra click.
  let _ptyProbePromise = null;
  async function detectPtyCapability() {
    try {
      if (hasPty()) return true;
    } catch (e0) {}
    if (_ptyProbePromise) return _ptyProbePromise;
    _ptyProbePromise = (async () => {
      try {
        const r = await fetch('/api/capabilities', { cache: 'no-store', credentials: 'same-origin' });
        if (!r.ok) return false;
        const data = await r.json().catch(() => ({}));
        if (data && data.terminal && typeof data.terminal === 'object' && 'pty' in data.terminal) {
          return !!data.terminal.pty;
        }
        return !!(data && data.websocket);
      } catch (e) {
        return false;
      }
    })();
    return _ptyProbePromise;
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
      if (pty && typeof pty.sendRaw === 'function') return !!pty.sendRaw(data);
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
    // Terminal is lazy-loaded on first use; wait for it to be ready to avoid
    // timing races on slow devices (where the PTY WS may come up after our timeout).
    try {
      const lazy = (window.XKeen && XKeen.lazy && typeof XKeen.lazy.ensureTerminalReady === 'function')
        ? XKeen.lazy.ensureTerminalReady
        : null;
      if (lazy) {
        await Promise.resolve(lazy());
      }
    } catch (e0) {}

    try {
      if (XKeen.terminal && XKeen.terminal.api && typeof XKeen.terminal.api.open === 'function') {
        // Prefer object-form to be compatible with lazy stub API.
        await Promise.resolve(XKeen.terminal.api.open({ mode: 'pty', cmd: '' }));
      } else if (hasTerminalApi()) {
        XKeen.terminal.open(null, { cmd: '', mode: 'pty' });
      } else if (typeof window.openTerminal === 'function') {
        window.openTerminal('', 'pty');
      }
    } catch (e) {}

    // Safety: ensure the window is visible even if it opened with a stale/buggy geometry.
    clampTerminalViewportSoon();

    const ok = await waitForPtyConnected(12000);
    if (!ok) {
      toast('PTY не подключён (WebSocket недоступен или не успел подключиться)', 'info');
      return false;
    }

    try {
      const api = (window.XKeen && XKeen.terminal && XKeen.terminal.api) ? XKeen.terminal.api : null;
      if (api && typeof api.send === 'function') {
        // Use raw to avoid routing and match Enter for PTY.
        const sendRes = await Promise.resolve(api.send(String(cmd || '') + '\r', { raw: true, prefer: 'pty', allowWhenDisconnected: false, source: 'commands_list' }));
        const delivered = !!(
          sendRes &&
          ((sendRes.handled === true) || (sendRes.result && sendRes.result.ok === true))
        );
        if (!delivered) {
          toast('PTY подключён, но команда не отправилась', 'error');
          return false;
        }
      } else {
        // Legacy fallback.
        if (!sendPtyRaw(String(cmd || '') + '\r')) {
          toast('PTY подключён, но команда не отправилась', 'error');
          return false;
        }
      }
      focusTerminal();
      clampTerminalViewportSoon();
      return true;
    } catch (e) {
      toast('Не удалось отправить команду в PTY', 'error');
      return false;
    }
  }

  // Command list wiring:
  // - On devices with PTY support: open ONLY PTY terminal and run the command there.
  // - On devices without PTY: fallback to lite terminal with a prefilled line (previous behavior).
  CL.init = function init() {
    const items = document.querySelectorAll('.command-item');
    if (!items || !items.length) return;

    items.forEach((el) => {
      el.addEventListener('click', async () => {
        const flag = el.getAttribute('data-flag');
        const label = el.getAttribute('data-label') || ('xkeen ' + flag);
        if (!flag) return;

        // Prefer PTY only on devices that explicitly support it.
        try {
          const ptyOk = await detectPtyCapability();
          if (ptyOk) {
            await openPtyAndRun(label);
            return;
          }
        } catch (e0) {}

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

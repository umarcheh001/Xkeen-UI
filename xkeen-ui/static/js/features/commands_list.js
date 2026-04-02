import {
  ensureXkeenTerminalInViewport,
  focusXkeenTerminal,
  getXkeenLazyRuntimeApi,
  hasXkeenTerminalApi,
  hasXkeenTerminalPtyCapability,
  isXkeenTerminalPtyConnected,
  openXkeenTerminal,
  sendXkeenTerminal,
  toastXkeen,
} from './xkeen_runtime.js';

let commandsListModuleApi = null;

(() => {
  'use strict';

  const CL = {};
  commandsListModuleApi = CL;

  function getLazyRuntimeApi() {
    return getXkeenLazyRuntimeApi();
  }

  function hasTerminalApi() {
    return hasXkeenTerminalApi();
  }

  function hasPty() {
    return hasXkeenTerminalPtyCapability();
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
    return isXkeenTerminalPtyConnected();
  }

  function sendPtyRaw(payload) {
    try {
      return !!sendXkeenTerminal(String(payload == null ? '' : payload), {
        prefer: 'pty',
        allowWhenDisconnected: false,
        source: 'commands_list',
      });
    } catch (e) {
      return false;
    }
  }

  function focusTerminal() {
    focusXkeenTerminal();
  }

  // Best-effort fix for rare cases when the terminal window opens slightly
  // outside of the viewport (e.g. header ends up above the top edge).
  function clampTerminalViewportSoon() {
    const run = () => {
      try { ensureXkeenTerminalInViewport(); } catch (e) {}
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
      const lazyRuntime = getLazyRuntimeApi();
      const lazy = (lazyRuntime && typeof lazyRuntime.ensureTerminalReady === 'function')
        ? lazyRuntime.ensureTerminalReady
        : null;
      if (lazy) {
        await Promise.resolve(lazy());
      }
    } catch (e0) {}

    try {
      await Promise.resolve(openXkeenTerminal({ mode: 'pty', cmd: '' }));
    } catch (e) {}

    // Safety: ensure the window is visible even if it opened with a stale/buggy geometry.
    clampTerminalViewportSoon();

    const ok = await waitForPtyConnected(12000);
    if (!ok) {
      toastXkeen('PTY не подключён (WebSocket недоступен или не успел подключиться)', 'info');
      return false;
    }

    try {
      const sendRes = await Promise.resolve(sendXkeenTerminal(String(cmd || '') + '\r', {
        raw: true,
        prefer: 'pty',
        allowWhenDisconnected: false,
        source: 'commands_list',
      }));
      const delivered = !!(
        sendRes === true ||
        (sendRes && sendRes.ok === true) ||
        (sendRes && sendRes.handled === true) ||
        (sendRes && sendRes.result && sendRes.result.ok === true)
      );
      if (!delivered && !sendPtyRaw(String(cmd || '') + '\r')) {
        toastXkeen('PTY подключён, но команда не отправилась', 'error');
        return false;
      }
      focusTerminal();
      clampTerminalViewportSoon();
      return true;
    } catch (e) {
      toastXkeen('Не удалось отправить команду в PTY', 'error');
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
            await Promise.resolve(openXkeenTerminal({ cmd: label, mode: 'xkeen' }));
            clampTerminalViewportSoon();
            return;
          } catch (e) {}
        }

        try { toastXkeen('Терминал недоступен.', 'error'); } catch (e) {}
      });
    });
  };
})();
export function getCommandsListApi() {
  try {
    return commandsListModuleApi && typeof commandsListModuleApi.init === 'function' ? commandsListModuleApi : null;
  } catch (error) {
    return null;
  }
}

export function initCommandsList(...args) {
  const api = getCommandsListApi();
  if (!api || typeof api.init !== 'function') return null;
  return api.init(...args);
}

export const commandsListApi = Object.freeze({
  get: getCommandsListApi,
  init: initCommandsList,
});

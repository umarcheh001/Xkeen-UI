import {
  getTerminalById,
  getTerminalCompatApi,
  getTerminalContext,
  getTerminalCoreHttpApi,
  publishTerminalCompatApi,
  publishXkeenCompatValue,
  setTerminalCapabilityState,
} from './runtime.js';
import { appendTerminalDebug } from '../features/terminal_debug.js';

// Terminal capabilities: detect backend features (/api/capabilities)
(function () {
  'use strict';

  const core = getTerminalCompatApi('_core');

  let HAS_WS = false;
  let HAS_PTY = false;
  let INIT_PROMISE = null;
  let INIT_DONE = false;

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

  function readStateCapabilityKnown() {
    try {
      if (core && core.state && typeof core.state.capabilitiesKnown === 'boolean') return core.state.capabilitiesKnown;
    } catch (e) {}
    try {
      const ctx = getCtx();
      const st = ctx && ctx.core ? ctx.core.state : null;
      if (st && typeof st.capabilitiesKnown === 'boolean') return st.capabilitiesKnown;
    } catch (e2) {}
    return null;
  }

  function readStateCapability(key) {
    try {
      if (core && core.state && typeof core.state[key] === 'boolean') return core.state[key];
    } catch (e) {}
    try {
      const ctx = getCtx();
      const st = ctx && ctx.core ? ctx.core.state : null;
      if (st && typeof st[key] === 'boolean') return st[key];
    } catch (e2) {}
    return null;
  }

  function seedFromState() {
    const known = readStateCapabilityKnown();
    const ws = readStateCapability('hasWs');
    const pty = readStateCapability('hasPty');
    if (known === true) {
      if (typeof ws === 'boolean') HAS_WS = ws;
      if (typeof pty === 'boolean') HAS_PTY = pty;
      INIT_DONE = true;
      return { known, ws, pty };
    }
    return { known: false, ws: null, pty: null };
  }

  function pickPtyCapability(data) {
    if (data && data.terminal && typeof data.terminal === 'object' && 'pty' in data.terminal) {
      return !!data.terminal.pty;
    }
    return !!(data && data.websocket);
  }

  function initCapabilities() {
    if (INIT_PROMISE) {
      appendTerminalDebug('terminal:capabilities:init-reuse', {});
      return INIT_PROMISE;
    }
    const seeded = seedFromState();
    appendTerminalDebug('terminal:capabilities:init-start', { seededWs: seeded.ws, seededPty: seeded.pty });
    INIT_PROMISE = (async () => {
      try {
        const http = getTerminalCoreHttpApi();
        let data = null;
        appendTerminalDebug('terminal:capabilities:request-begin', { viaCoreHttp: !!(http && typeof http.fetchJSON === 'function') });
        if (http && typeof http.fetchJSON === 'function') {
          data = await http.fetchJSON('/api/capabilities', {
            method: 'GET',
            timeoutMs: 2500,
            retry: 0,
          });
        } else {
          const resp = await fetch('/api/capabilities', { cache: 'no-store' });
          if (!resp.ok) throw new Error('http ' + resp.status);
          data = await resp.json().catch(() => ({}));
        }
        HAS_WS = !!(data && data.websocket);
        HAS_PTY = pickPtyCapability(data);
        appendTerminalDebug('terminal:capabilities:request-done', { websocket: HAS_WS, pty: HAS_PTY });
      } catch (e) {
        const msg = e ? String(e.message || e) : 'unknown error';
        appendTerminalDebug('terminal:capabilities:request-error', { error: msg, keepSeeded: true });
        const fallback = seedFromState();
        HAS_WS = (typeof fallback.ws === 'boolean') ? fallback.ws : false;
        HAS_PTY = (typeof fallback.pty === 'boolean') ? fallback.pty : false;
      }

      try {
        if (core && core.state) {
          core.state.hasWs = HAS_WS;
          core.state.hasPty = HAS_PTY;
          core.state.capabilitiesKnown = true;
        }
      } catch (e) {}
      try {
        const ctx = getCtx();
        const st = ctx && ctx.core ? ctx.core.state : null;
        if (st) {
          st.hasWs = HAS_WS;
          st.hasPty = HAS_PTY;
          st.capabilitiesKnown = true;
        }
      } catch (e2) {}
      try { setTerminalCapabilityState(HAS_WS, HAS_PTY); } catch (e3) {}
      INIT_DONE = true;

      try { applyWsCapabilityUi(); } catch (e) {}
      appendTerminalDebug('terminal:capabilities:apply', { websocket: HAS_WS, pty: HAS_PTY, known: true });
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

  function hasWs() { const v = readStateCapability('hasWs'); return (typeof v === 'boolean') ? v : !!HAS_WS; }
  function hasPty() { const v = readStateCapability('hasPty'); return (typeof v === 'boolean') ? v : !!HAS_PTY; }
  function isReady() {
    const known = readStateCapabilityKnown();
    return known === true || INIT_DONE === true;
  }

  // Backward compatible aliases (some legacy code used these names)
  publishXkeenCompatValue('terminalApplyWsCapabilityUi', applyWsCapabilityUi);
  publishXkeenCompatValue('terminalApplyCapabilityUi', applyWsCapabilityUi);

  publishTerminalCompatApi('capabilities', {
    initCapabilities,
    applyWsCapabilityUi,
    hasWs,
    hasPty,
    isReady,
  });
})();

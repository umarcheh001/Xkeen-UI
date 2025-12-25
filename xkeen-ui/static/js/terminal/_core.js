// Terminal core: state + basic UI helpers (no fetch/ws business logic)
(function () {
  'use strict';

  // Namespace
  window.XKeen = window.XKeen || {};
  window.XKeen.state = window.XKeen.state || {};
  window.XKeen.terminal = window.XKeen.terminal || {};

  // --------------------
  // Per-tab identity
  // --------------------
  function computeTabId() {
    try {
      if (window.XKeen && XKeen.util && typeof XKeen.util.getTabId === 'function') {
        return XKeen.util.getTabId();
      }
    } catch (e) {}
    // Emergency fallback: non-persistent id (still prevents crashes).
    return 'xkeen_tab_id_v1:' + (String(Math.random()).slice(2) + '-' + String(Date.now()));
  }

  const state = window.XKeen.terminalState = window.XKeen.terminalState || {
    tabId: computeTabId(),
    // 'shell' | 'xkeen' | 'pty' (owner module may update)
    mode: 'shell',
    // xterm refs (owner module may update)
    term: null,
    fitAddon: null,
    searchAddon: null,
    // connection ui
    connState: 'disconnected',
    // capabilities (filled by capabilities.js)
    hasWs: false,
  };

  // --------------------
  // Basic DOM getters
  // --------------------
  function byId(id) { return document.getElementById(id); }
  function getOverlay() { return byId('terminal-overlay'); }
  function getPtyOpenButton() { return byId('terminal-open-pty-btn'); }

  // --------------------
  // Overlay visible?
  // --------------------
  function getOverlayController() {
    try {
      const C = window.XKeen && window.XKeen.terminal ? window.XKeen.terminal.core : null;
      const ctx = (C && typeof C.getCtx === 'function') ? C.getCtx() : null;
      const oc = ctx ? (ctx.overlay || ctx.overlayCtrl) : null;
      if (oc) return oc;
    } catch (e) {}
    try {
      return (window.XKeen && window.XKeen.terminal) ? (window.XKeen.terminal.overlay || null) : null;
    } catch (e2) {}
    return null;
  }

  function terminalIsOverlayOpen() {
    // Stage 8.3.4: moved to modules/overlay_controller.js
    try {
      const oc = getOverlayController();
      if (oc && typeof oc.isOpen === 'function') return !!oc.isOpen();
    } catch (e) {}
    // Minimal fallback.
    const overlay = getOverlay();
    if (!overlay) return false;
    try { return overlay.style.display !== 'none'; } catch (e2) {}
    return true;
  }

  // Prevent background page scrolling when any modal/overlay is open.
  // Uses the existing CSS rule: body.modal-open { overflow: hidden; }
  function syncBodyScrollLock() {
    // Stage 8.3.4: moved to modules/overlay_controller.js
    try {
      const oc = getOverlayController();
      if (oc && typeof oc.syncBodyScrollLock === 'function') return oc.syncBodyScrollLock();
    } catch (e) {}
    // fallback: global modal helper
    try {
      if (window.XKeen && XKeen.ui && XKeen.ui.modal && typeof XKeen.ui.modal.syncBodyScrollLock === 'function') {
        return XKeen.ui.modal.syncBodyScrollLock();
      }
    } catch (e) {}
  }

  // ---------------- Terminal connection status lamp + uptime ----------------
  let uptimeStartMs = null;
  let uptimeTimer = null;

  function formatUptime(ms) {
    const total = Math.max(0, Math.floor((ms || 0) / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n) => String(n).padStart(2, '0');
    if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
    return `${pad(m)}:${pad(s)}`;
  }

  function updateUptimeUi() {
    const el = byId('terminal-uptime');
    if (!el) return;
    if (!uptimeStartMs) {
      el.textContent = '00:00';
      return;
    }
    const ms = Date.now() - uptimeStartMs;
    el.textContent = formatUptime(ms);
  }

  function stopUptimeTimer() {
    if (uptimeTimer) {
      try { clearInterval(uptimeTimer); } catch (e) {}
      uptimeTimer = null;
    }
    uptimeStartMs = null;
    updateUptimeUi();
  }

  function startUptimeTimer() {
    uptimeStartMs = Date.now();
    updateUptimeUi();
    if (uptimeTimer) {
      try { clearInterval(uptimeTimer); } catch (e) {}
    }
    uptimeTimer = setInterval(updateUptimeUi, 1000);
  }

  function setConnState(connState, detail) {
    state.connState = connState || 'error';

    // Stage 8.3.5: prefer the status controller (single source of truth for lamp + uptime).
    try {
      const T = (window.XKeen && window.XKeen.terminal) ? window.XKeen.terminal : null;
      const sc = T ? (T.status || null) : null;
      if (sc && typeof sc.setConnState === 'function' && sc !== window.XKeen.terminal._core) {
        sc.setConnState(String(state.connState || 'error'), detail);
        return;
      }
    } catch (e0) {}

    // New lamp (preferred): uses same visuals as xkeen service lamp.
    const lamp = byId('terminal-conn-lamp');
    if (lamp) {
      const map = {
        connected: 'running',
        connecting: 'pending',
        disconnected: 'stopped',
        error: 'error',
      };
      const mapped = map[state.connState] || 'error';
      lamp.setAttribute('data-state', mapped);

      const stateRu = {
        connected: 'подключено',
        connecting: 'подключение...',
        disconnected: 'отключено',
        error: 'ошибка',
      };
      lamp.title = detail || ('Терминал: ' + (stateRu[state.connState] || state.connState));
    }

    // Uptime: only for connected state
    if (state.connState === 'connected') {
      if (!uptimeStartMs) startUptimeTimer();
    } else {
      stopUptimeTimer();
    }
  }

  function setMode(mode) { state.mode = mode || 'shell'; }
  function getMode() { return state.mode || 'shell'; }
  function getTabId() { return state.tabId; }

  function init() {
    // idempotent init for future submodules
    try { window.XKeen.state.tabId = state.tabId; } catch (e) {}
    return true;
  }

  // --------------------
  // XTerm refs setters (UI should not poke into state directly) (UI should not poke into state directly)
  // --------------------
  function setXtermRefs(refs) {
    if (!refs) return;
    try {
      const allowed = {
        term: 1,
        xterm: 1,
        fitAddon: 1,
        searchAddon: 1,
        webLinksAddon: 1,
        webglAddon: 1,
        serializeAddon: 1,
        unicode11Addon: 1,
        clipboardAddon: 1,
        ligaturesAddon: 1,
      };
      Object.keys(refs).forEach((k) => {
        if (!allowed[k]) return;
        state[k] = refs[k];
      });
    } catch (e) {}
  }

  function getXtermRef(name) {
    try { return state ? state[name] : null; } catch (e) {}
    return null;
  }


  window.XKeen.terminal._core = {
    state,
    setXtermRefs,
    getXtermRef,
    init,
    byId,
    getOverlay,
    getPtyOpenButton,
    terminalIsOverlayOpen,
    syncBodyScrollLock,
    setConnState,
    setMode,
    getMode,
    getTabId,
  };
})();

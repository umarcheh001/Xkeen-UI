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
  function terminalIsOverlayOpen() {
    const overlay = getOverlay();
    if (!overlay) return false;

    // Robust cross-browser visibility check.
    // NOTE: using `offsetParent !== null` breaks for `position: fixed` elements
    // (e.g. Chrome returns null even when visible).
    try {
      if (!overlay.isConnected) return false;
      const cs = window.getComputedStyle(overlay);
      if (!cs) return false;
      if (cs.display === 'none') return false;
      if (cs.visibility === 'hidden') return false;

      // If element is rendered it should have client rects; keep a safe fallback.
      const rects = overlay.getClientRects ? overlay.getClientRects() : null;
      if (rects && rects.length === 0) {
        const w = overlay.offsetWidth || 0;
        const h = overlay.offsetHeight || 0;
        if (w === 0 && h === 0) return false;
      }
      return true;
    } catch (e) {
      // Best-effort fallback: rely on computed display.
      return overlay.style.display !== 'none';
    }
  }

  // Prevent background page scrolling when any modal/overlay is open.
  // Uses the existing CSS rule: body.modal-open { overflow: hidden; }
  function syncBodyScrollLock() {
    // moved to ui/modal.js (XKeen.ui.modal.syncBodyScrollLock)
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

    // Backward compatibility: old badge if still present.
    const badge = byId('terminal-conn-badge');
    if (badge) {
      badge.setAttribute('data-state', state.connState);
      badge.textContent = (state.connState === 'connected') ? 'Подключено'
                      : (state.connState === 'connecting') ? 'Подключение…'
                      : (state.connState === 'disconnected') ? 'Отключено'
                      : 'Ошибка';
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

  window.XKeen.terminal._core = {
    state,
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

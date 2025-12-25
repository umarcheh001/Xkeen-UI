// Terminal PTY subsystem: WebSocket transport + session + retry/backoff + signals
(function () {
  'use strict';

  window.XKeen = window.XKeen || {};
  window.XKeen.terminal = window.XKeen.terminal || {};

  const core = window.XKeen.terminal._core || null;
  const caps = window.XKeen.terminal.capabilities || null;

  // Milestone A: PTY communicates with the rest of the terminal via ctx.events
  // (instead of pushing hook functions into core.*).
  function getCtx() {
    try {
      const C = window.XKeen && window.XKeen.terminal && window.XKeen.terminal.core
        ? window.XKeen.terminal.core
        : null;
      if (C && typeof C.getCtx === 'function') return C.getCtx();
    } catch (e) {}
    return null;
  }

  function getEvents() {
    try {
      const ctx = getCtx();
      if (ctx && ctx.events && typeof ctx.events.emit === 'function') return ctx.events;
    } catch (e) {}
    return { on: () => () => {}, off: () => {}, emit: () => {} };
  }

  function getUi() {
    try {
      const ctx = getCtx();
      if (ctx && ctx.ui) return ctx.ui;
    } catch (e) {}
    return null;
  }

  function emit(eventName, payload) {
    try { getEvents().emit(eventName, payload); } catch (e) {}
  }

  const state = (core && core.state) ? core.state : (window.XKeen.terminal.__pty_state = window.XKeen.terminal.__pty_state || {});

  // --------------------
  // Session persistence (per-tab)
  // --------------------
  const KEY_BASE_SID = 'xkeen_pty_session_id_v1';
  const KEY_BASE_SEQ = 'xkeen_pty_last_seq_v1';

  function tabId() {
    try {
      if (core && typeof core.getTabId === 'function') return core.getTabId();
    } catch (e) {}
    try { if (window.XKeen && window.XKeen.state && window.XKeen.state.tabId) return window.XKeen.state.tabId; } catch (e) {}
    try { return (window.name || 'tab'); } catch (e) {}
    return 'tab';
  }

  function ptyStorageKey(base) {
    return base + '__' + tabId();
  }


// Legacy sessionStorage formats (older terminal.js used ':' suffix, oldest used plain key).
// To avoid migrating cloned sessionStorage into a newly opened tab, we only migrate on reload/back-forward.
function ptyLegacyKeyColon(base) {
  return base + ':' + tabId();
}
function ptyLegacyKeyPlain(base) {
  return String(base);
}
function isReloadLikeNavigation() {
  try {
    if (window.performance && typeof window.performance.getEntriesByType === 'function') {
      const nav = window.performance.getEntriesByType('navigation')[0];
      const t = nav && nav.type;
      if (t) return (t === 'reload' || t === 'back_forward');
    }
  } catch (e) {}
  try {
    // Legacy API: 0=navigate,1=reload,2=back_forward
    const pn = window.performance && window.performance.navigation;
    if (pn && typeof pn.type === 'number') {
      return (pn.type === 1 || pn.type === 2);
    }
  } catch (e) {}
  return false;
}
function tryMigrateLegacyKey(base) {
  if (!isReloadLikeNavigation()) return null;
  try {
    // 1) Namespaced old format: base:tabId
    const colonKey = ptyLegacyKeyColon(base);
    let v = null;
    try { v = sessionStorage.getItem(colonKey); } catch (e) { v = null; }
    if (v != null && v !== '') {
      // Only migrate if new key is empty
      const nk = ptyStorageKey(base);
      const existing = sessionStorage.getItem(nk);
      if (existing == null || existing === '') {
        sessionStorage.setItem(nk, String(v));
      }
      try { sessionStorage.removeItem(colonKey); } catch (e) {}
      return v;
    }

    // 2) Oldest global format: base
    const plainKey = ptyLegacyKeyPlain(base);
    try { v = sessionStorage.getItem(plainKey); } catch (e) { v = null; }
    if (v != null && v !== '') {
      const nk = ptyStorageKey(base);
      const existing = sessionStorage.getItem(nk);
      if (existing == null || existing === '') {
        sessionStorage.setItem(nk, String(v));
      }
      try { sessionStorage.removeItem(plainKey); } catch (e) {}
      return v;
    }
  } catch (e) {}
  return null;
}


  function loadSessionState() {
    try {
      let sid = sessionStorage.getItem(ptyStorageKey(KEY_BASE_SID));
      if ((sid == null || sid === '') && typeof tryMigrateLegacyKey === 'function') sid = tryMigrateLegacyKey(KEY_BASE_SID);
      if (sid) state.ptySessionId = String(sid);
    } catch (e) {}
    try {
      let ls = sessionStorage.getItem(ptyStorageKey(KEY_BASE_SEQ));
      if ((ls == null || ls === '') && typeof tryMigrateLegacyKey === 'function') ls = tryMigrateLegacyKey(KEY_BASE_SEQ);
      if (ls != null) state.ptyLastSeq = Math.max(0, parseInt(ls, 10) || 0);
    } catch (e) {}
  }

  function saveSessionState() {
    try { if (state.ptySessionId) sessionStorage.setItem(ptyStorageKey(KEY_BASE_SID), String(state.ptySessionId)); } catch (e) {}
    try { sessionStorage.setItem(ptyStorageKey(KEY_BASE_SEQ), String(state.ptyLastSeq || 0)); } catch (e) {}
  }

  function clearSessionState() {
  state.ptySessionId = null;
  state.ptyLastSeq = 0;
  try { sessionStorage.removeItem(ptyStorageKey(KEY_BASE_SID)); } catch (e) {}
  try { sessionStorage.removeItem(ptyStorageKey(KEY_BASE_SEQ)); } catch (e) {}
  // Also drop legacy keys (best effort)
  try { sessionStorage.removeItem(ptyLegacyKeyColon(KEY_BASE_SID)); } catch (e) {}
  try { sessionStorage.removeItem(ptyLegacyKeyColon(KEY_BASE_SEQ)); } catch (e) {}
  try { sessionStorage.removeItem(ptyLegacyKeyPlain(KEY_BASE_SID)); } catch (e) {}
  try { sessionStorage.removeItem(ptyLegacyKeyPlain(KEY_BASE_SEQ)); } catch (e) {}
}

  // --------------------
  // UI helpers
  // --------------------
  function overlayOpen() {
    try { return core && typeof core.terminalIsOverlayOpen === 'function' ? core.terminalIsOverlayOpen() : true; } catch (e) {}
    return true;
  }

  function safeWrite(term, s) {
    if (!term) return;
    try {
      if (typeof term.write === 'function') term.write(String(s));
      else if (typeof term.writeln === 'function') term.writeln(String(s));
    } catch (e) {}
  }

  function safeWriteln(term, s) {
    if (!term) return;
    const text = String(s == null ? '' : s);
    try {
      if (typeof term.writeln === 'function') return term.writeln(text);
    } catch (e) {}
    // fallback for older xterm wrappers
    safeWrite(term, text + '\r\n');
  }

  // --------------------
  // Keepalive
  // --------------------
  function stopKeepalive() {
    if (state.ptyKeepaliveTimer) {
      try { clearInterval(state.ptyKeepaliveTimer); } catch (e) {}
      state.ptyKeepaliveTimer = null;
    }
  }

  function startKeepalive() {
    stopKeepalive();
    // Keepalive helps keep reverse proxies from closing idle WS.
    // We send a dedicated ping message that should be ignored by the backend if unsupported.
    state.ptyKeepaliveTimer = setInterval(() => {
      try {
        const ws = state.ptyWs;
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
      } catch (e) {}
    }, 25000);
  }

  // --------------------
  // Retry/backoff (delegated to modules/reconnect_controller.js)
  // --------------------
  function getReconnectController() {
    try {
      const ctx = getCtx();
      if (ctx && ctx.reconnect && typeof ctx.reconnect.getRetryState === 'function') return ctx.reconnect;
    } catch (e) {}
    try {
      const mod = window.XKeen && window.XKeen.terminal ? window.XKeen.terminal.reconnect_controller : null;
      const ctx2 = getCtx();
      if (mod && typeof mod.createController === 'function' && ctx2) {
        // Ensure a singleton controller even if registry did not run yet.
        ctx2.reconnect = ctx2.reconnect || mod.createController(ctx2);
        return ctx2.reconnect;
      }
    } catch (e2) {}
    return null;
  }

  function getRetryState() {
    const rc = getReconnectController();
    if (rc && typeof rc.getRetryState === 'function') return rc.getRetryState();
    return { active: false, blocked: false, attempt: 0, nextAt: 0 };
  }

  function resetRetry(opts = {}) {
    const rc = getReconnectController();
    if (rc && typeof rc.resetRetry === 'function') return rc.resetRetry(opts || {});
  }

  function stopRetry(opts = {}) {
    const rc = getReconnectController();
    if (rc && typeof rc.stopRetry === 'function') return rc.stopRetry(opts || {});
  }

  function scheduleRetry(reason, opts = {}) {
    const rc = getReconnectController();
    if (rc && typeof rc.scheduleRetry === 'function') return rc.scheduleRetry(reason, opts || {});
  }

  function retryNow() {
    const rc = getReconnectController();
    if (rc && typeof rc.retryNow === 'function') return rc.retryNow();
  }

// --------------------
  // WS connect / disconnect
  // --------------------
  function disconnect(opts = {}) {
    stopKeepalive();

    const ws = state.ptyWs;
    const sendClose = (opts && opts.sendClose !== false);

    // Ask backend to terminate PTY session when this is an explicit user disconnect.
    try {
      if (ws && sendClose && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'close' }));
      }
    } catch (e) {}

    if (ws) {
      try { ws.__xkeen_manual_close = true; } catch (e) {}
      try { ws.close(); } catch (e) {}
    }
    state.ptyWs = null;

    // dispose subscriptions if any
    try {
      const arr = state.ptyDisposables || [];
      arr.forEach((d) => {
        try {
          if (!d) return;
          if (typeof d === 'function') return d();
          if (d && typeof d.dispose === 'function') return d.dispose();
        } catch (e) {}
      });
    } catch (e) {}
    state.ptyDisposables = [];

    if (opts && opts.clearSession) {
      clearSessionState();
    }
    try { emit('pty:disconnected', { reason: (opts && opts.reason) ? String(opts.reason) : 'disconnect' }); } catch (e) {}
  }

  async function fetchWsToken() {
    const r = await fetch('/api/ws-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j || !j.ok) {
      throw new Error((j && j.error) ? j.error : ('HTTP ' + r.status));
    }
    return String(j.token || '');
  }

  async function connect(term, opts = {}) {
    if (!term) return;

    // store reference for other modules
    state.xterm = term;

    // Capability gate
    // NOTE: capabilities are fetched asynchronously on page load.
    // A new session tab may try to connect before /api/capabilities finishes.
    // If so, wait for initCapabilities() once and re-check.
    try {
      if (caps && typeof caps.hasWs === 'function' && !caps.hasWs()) {
        if (typeof caps.initCapabilities === 'function') {
          try { await caps.initCapabilities(); } catch (e0) {}
        }
        if (caps && typeof caps.hasWs === 'function' && !caps.hasWs()) {
          safeWriteln(term, '[PTY] WebSocket не поддерживается на этом устройстве.');
          try { emit('pty:error', { message: 'ws unsupported' }); } catch (e2) {}
          return;
        }
      }
    } catch (e) {}

    const preserveScreen = !!opts.preserveScreen;

    disconnect({ sendClose: false });

    if (!preserveScreen) {
      try { if (typeof term.clear === 'function') term.clear(); } catch (e) {}
    }
    safeWriteln(term, '[PTY] Подключение...');
    try { emit('pty:connecting', { reason: 'connect' }); } catch (e2) {}

    loadSessionState();

    // token
    let token = '';
    try {
      token = await fetchWsToken();
    } catch (e) {
      safeWriteln(term, '[PTY] Ошибка получения токена: ' + (e && e.message ? e.message : String(e)));
      try { emit('pty:error', { message: 'token', detail: (e && e.message ? e.message : String(e || '')) }); } catch (e2) {}
      return;
    }

    const proto = (location.protocol === 'https:') ? 'wss:' : 'ws:';

    const qs = new URLSearchParams();
    qs.set('token', token);
    try {
      qs.set('cols', String(term && term.cols ? term.cols : 0));
      qs.set('rows', String(term && term.rows ? term.rows : 0));
    } catch (e) {}

    if (state.ptySessionId) qs.set('session_id', String(state.ptySessionId));

    // If we preserve screen, request only missed output; otherwise request buffered output from the beginning.
    const resumeFrom = preserveScreen ? (state.ptyLastSeq || 0) : 0;
    qs.set('last_seq', String(resumeFrom));
    try {
      if (!preserveScreen) {
        state.ptyLastSeq = 0;
        saveSessionState();
      }
    } catch (e) {}

    const url = `${proto}//${location.host}/ws/pty?${qs.toString()}`;

    let ws = null;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      safeWriteln(term, '[PTY] WebSocket недоступен: ' + (e && e.message ? e.message : String(e)));
      try { emit('pty:error', { message: 'ws ctor', detail: (e && e.message ? e.message : String(e || '')) }); } catch (e2) {}
      return;
    }

    state.ptyWs = ws;
    state.ptyDisposables = state.ptyDisposables || [];

    const sendResize = (colsOverride, rowsOverride) => {
      try {
        if (!state.ptyWs || state.ptyWs.readyState !== WebSocket.OPEN) return;
        const cols = Number(colsOverride || (term && term.cols) || 0);
        const rows = Number(rowsOverride || (term && term.rows) || 0);
        if (!cols || !rows) return;
        state.ptyWs.send(JSON.stringify({ type: 'resize', cols: cols, rows: rows }));
      } catch (e) {}
    };

    ws.onopen = () => {
      resetRetry({ unblock: true });
      safeWriteln(term, '[PTY] Соединение установлено.');
      try { if (state.fitAddon && state.fitAddon.fit) state.fitAddon.fit(); } catch (e) {}
      sendResize();
      startKeepalive();

      try { emit('pty:connected', { ws: ws, sessionId: state.ptySessionId || null }); } catch (e) {}
    };

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (!msg) return;

      if (msg.type === 'output' && typeof msg.data === 'string') {
        // De-dup by seq to survive reconnect+replay races.
        // If backend replays chunks that were already delivered live, ignore them here.
        try {
          if (msg.seq != null) {
            const s0 = parseInt(msg.seq, 10);
            const last0 = parseInt(state.ptyLastSeq || 0, 10) || 0;
            if (!isNaN(s0) && s0 > 0 && s0 <= last0) return;
          }
        } catch (e) {}

        const rawOut = msg.data;

        // Stage 5: output is delivered through the transport bus.
        // The output controller decides whether/how to post-process and render it.
        try {
          emit('transport:message', {
            chunk: rawOut,
            source: 'pty',
            seq: (msg.seq != null) ? msg.seq : null,
            ts: Date.now(),
          });
        } catch (e) {}

        // Track seq for lossless reconnect
        try {
          if (msg.seq != null) {
            const s = parseInt(msg.seq, 10);
            if (!isNaN(s) && s > (state.ptyLastSeq || 0)) {
              state.ptyLastSeq = s;
              saveSessionState();
            }
          }
        } catch (e) {}
      } else if (msg.type === 'init') {
        // Server returns session_id (store for reconnect)
        try {
          if (msg.session_id) {
            state.ptySessionId = String(msg.session_id);
            saveSessionState();
          }
        } catch (e) {}
        if (msg.shell) safeWriteln(term, '[PTY] Shell: ' + msg.shell);
        if (msg.reused) safeWriteln(term, '[PTY] Reattached to existing session.');
      } else if (msg.type === 'exit') {
        stopRetry({ silent: true });
        safeWriteln(term, '\r\n[PTY] Завершено (code=' + msg.code + ').');
        clearSessionState();
        stopKeepalive();

        try { emit('pty:disconnected', { reason: 'exit', code: msg.code }); } catch (e) {}
      } else if (msg.type === 'error') {
        safeWriteln(term, '[PTY] Ошибка: ' + (msg.message || 'unknown'));
        try { emit('pty:error', { message: msg.message || 'unknown' }); } catch (e) {}
      }
    };

    ws.onerror = () => {
      try { safeWriteln(term, '\r\n[PTY] Ошибка WebSocket.'); } catch (e) {}
      try { emit('pty:error', { message: 'websocket error' }); } catch (e) {}
    };

    ws.onclose = (ev) => {
      stopKeepalive();
      try { if (ev && ev.target && ev.target.__xkeen_manual_close) return; } catch (e) {}
      safeWriteln(term, '\r\n[PTY] Соединение закрыто.');
      try { emit('pty:disconnected', { reason: 'onclose', code: (ev && typeof ev.code === 'number') ? ev.code : null }); } catch (e) {}
    };

    // Resize is proxied by xterm_manager through ctx.events (Stage 2)
    try {
      const E = getEvents();

      let lastSentCols = 0;
      let lastSentRows = 0;
      const onResize = (payload) => {
        try {
          // Ignore if not in PTY mode.
          try {
            if (core && typeof core.getMode === 'function' && core.getMode() !== 'pty') return;
          } catch (e2) {}

          const cols = payload && payload.cols ? Number(payload.cols) : (term && term.cols ? Number(term.cols) : 0);
          const rows = payload && payload.rows ? Number(payload.rows) : (term && term.rows ? Number(term.rows) : 0);
          if (!cols || !rows) return;
          if (cols === lastSentCols && rows === lastSentRows) return;
          lastSentCols = cols;
          lastSentRows = rows;
          sendResize(cols, rows);
        } catch (e) {}
      };
      const offResize = E.on('xterm:resize', onResize);
      if (offResize) state.ptyDisposables.push({ dispose: offResize });
      // Backward-compatible name (older modules emit ui:resize)
      const offUiResize = E.on('ui:resize', onResize);
      if (offUiResize) state.ptyDisposables.push({ dispose: offUiResize });
    } catch (e) {}
  }

  function sendRaw(data) {
    const ws = state.ptyWs;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: 'input', data: String(data || '') })); } catch (e) {}
    }
  }

  // --------------------
  // Signals (UI menu moved to terminal overflow menu)
  // --------------------
  function hideSignalsMenu() { /* deprecated */ }

  function toggleSignalsMenu(ev) {
    // deprecated
    try { if (ev && ev.stopPropagation) ev.stopPropagation(); } catch (e) {}
  }

  function sendSignal(name) {
    const ws = state.ptyWs;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      try { if (typeof showToast === 'function') showToast('PTY не подключён', 'info'); } catch (e) {}
      return;
    }
    try {
      ws.send(JSON.stringify({ type: 'signal', name: String(name || '').toUpperCase() }));
      try { state.xterm && state.xterm.focus && state.xterm.focus(); } catch (e) {}
    } catch (e) {}
  }

  function initSignalsMenuAutoClose() { /* deprecated */ }

  // Export
  window.XKeen.terminal.pty = {
    connect,
    disconnect,
    sendRaw,

    // accessors (so UI does not touch _core.state)
    getWs: () => {
      try { return state.ptyWs || null; } catch (e) { return null; }
    },
    getRetryState,

    // retry/backoff
    scheduleRetry,
    stopRetry,
    retryNow,
    resetRetry,

    // session
    getSessionId: () => (state.ptySessionId || null),
    clearSession: clearSessionState,

    // signals
    sendSignal,
    hideSignalsMenu,
    toggleSignalsMenu,
    initSignalsMenuAutoClose,
  };
})();

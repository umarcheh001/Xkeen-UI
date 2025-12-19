// Terminal PTY subsystem: WebSocket transport + session + retry/backoff + signals menu
(function () {
  'use strict';

  window.XKeen = window.XKeen || {};
  window.XKeen.terminal = window.XKeen.terminal || {};

  const core = window.XKeen.terminal._core || null;
  const caps = window.XKeen.terminal.capabilities || null;

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

  function loadSessionState() {
    try {
      const sid = sessionStorage.getItem(ptyStorageKey(KEY_BASE_SID));
      if (sid) state.ptySessionId = String(sid);
    } catch (e) {}
    try {
      const ls = sessionStorage.getItem(ptyStorageKey(KEY_BASE_SEQ));
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
  }

  // --------------------
  // UI helpers
  // --------------------
  function overlayOpen() {
    try { return core && typeof core.terminalIsOverlayOpen === 'function' ? core.terminalIsOverlayOpen() : true; } catch (e) {}
    return true;
  }

  function setConnState(cs, detail) {
    try { if (core && typeof core.setConnState === 'function') core.setConnState(cs, detail); } catch (e) {}
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
  // Retry/backoff
  // --------------------
  const RETRY_CFG = {
    baseMs: 800,
    factor: 1.8,
    maxMs: 20000,
    jitter: 0.15,
  };

  function updateRetryUi() {
    // Best effort: toggle button + text if present
    try {
      const btn = document.getElementById('terminal-btn-stop-retry');
      if (btn) btn.classList.toggle('hidden', !state.ptyRetryActive);
    } catch (e) {}
    try {
      const btnNow = document.getElementById('terminal-btn-retry-now');
      if (btnNow) btnNow.classList.toggle('hidden', !state.ptyRetryActive);
    } catch (e) {}
  }

  function resetRetry(opts = {}) {
    if (state.ptyRetryTimer) {
      try { clearTimeout(state.ptyRetryTimer); } catch (e) {}
      state.ptyRetryTimer = null;
    }
    state.ptyRetryAttempt = 0;
    state.ptyRetryNextAt = 0;
    if (opts && opts.unblock) state.ptyRetryBlocked = false;
    state.ptyRetryActive = false;
    updateRetryUi();
  }

  function stopRetry(opts = {}) {
    state.ptyRetryBlocked = true;
    if (state.ptyRetryTimer) {
      try { clearTimeout(state.ptyRetryTimer); } catch (e) {}
      state.ptyRetryTimer = null;
    }
    state.ptyRetryActive = false;
    state.ptyRetryNextAt = 0;
    updateRetryUi();
    if (!opts.silent) {
      try { safeWriteln(state.xterm || null, '\r\n[PTY] Auto-retry stopped.'); } catch (e) {}
    }
  }

  function scheduleRetry(reason, opts = {}) {
    if (state.ptyRetryBlocked) return;
    if (!overlayOpen()) return;
    const term = state.xterm || null;
    if (!term) return;

    // Only retry in PTY mode if we know it; otherwise allow caller to force.
    if (!opts.force) {
      try {
        if (core && typeof core.getMode === 'function' && core.getMode() !== 'pty') return;
      } catch (e) {}
    }

    state.ptyRetryActive = true;
    if (state.ptyRetryTimer) {
      updateRetryUi();
      return;
    }

    const maxAttempts = (opts && typeof opts.maxAttempts === 'number') ? opts.maxAttempts : 0;
    if (maxAttempts > 0 && (state.ptyRetryAttempt || 0) >= maxAttempts) {
      state.ptyRetryActive = false;
      updateRetryUi();
      setConnState('error', 'PTY: retry limit reached');
      try { safeWriteln(term, '\r\n[PTY] Auto-retry stopped (max attempts reached).'); } catch (e) {}
      return;
    }

    state.ptyRetryAttempt = (state.ptyRetryAttempt || 0) + 1;

    const base = Math.max(100, RETRY_CFG.baseMs);
    const factor = Math.max(1.1, RETRY_CFG.factor);
    const cap = Math.max(base, RETRY_CFG.maxMs);
    const jitter = Math.max(0, Math.min(0.5, RETRY_CFG.jitter));

    let delay = Math.floor(base * (factor ** Math.max(0, (state.ptyRetryAttempt || 1) - 1)));
    delay = Math.min(cap, delay);
    if (jitter > 0) {
      const r = (Math.random() * 2 - 1) * jitter;
      delay = Math.max(100, Math.floor(delay * (1 + r)));
    }

    state.ptyRetryNextAt = Date.now() + delay;
    updateRetryUi();

    try {
      const sec = (delay / 1000).toFixed(1);
      safeWriteln(term, `\r\n[PTY] Auto-retry in ${sec}s (attempt ${state.ptyRetryAttempt})${reason ? ' — ' + reason : ''}`);
    } catch (e) {}

    state.ptyRetryTimer = setTimeout(() => {
      state.ptyRetryTimer = null;
      state.ptyRetryNextAt = 0;

      if (state.ptyRetryBlocked) return;
      if (!overlayOpen()) return;
      try {
        if (!opts.force) {
          if (core && typeof core.getMode === 'function' && core.getMode() !== 'pty') return;
        }
      } catch (e) {}

      const t = state.xterm || null;
      if (!t) return;
      connect(t, { preserveScreen: true, isAutoRetry: true });
    }, delay);
  }

  function retryNow() {
    if (state.ptyRetryBlocked) state.ptyRetryBlocked = false;
    if (state.ptyRetryTimer) {
      try { clearTimeout(state.ptyRetryTimer); } catch (e) {}
      state.ptyRetryTimer = null;
    }
    state.ptyRetryNextAt = 0;
    const term = state.xterm || null;
    if (!term) return;
    connect(term, { preserveScreen: true, isManualRetry: true });
  }

  // --------------------
  // WS connect / disconnect
  // --------------------
  function disconnect(opts = {}) {
    stopKeepalive();

    const ws = state.ptyWs;
    if (ws) {
      try { ws.__xkeen_manual_close = true; } catch (e) {}
      try { ws.close(); } catch (e) {}
    }
    state.ptyWs = null;

    // dispose xterm subscriptions if any
    try {
      const arr = state.ptyDisposables || [];
      arr.forEach((d) => { try { d && d.dispose && d.dispose(); } catch (e) {} });
    } catch (e) {}
    state.ptyDisposables = [];

    if (opts && opts.clearSession) {
      clearSessionState();
    }
    setConnState('disconnected', 'PTY: отключено');
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
    try {
      if (caps && typeof caps.hasWs === 'function' && !caps.hasWs()) {
        safeWriteln(term, '[PTY] WebSocket не поддерживается на этом устройстве.');
        setConnState('error', 'PTY: WS не поддерживается');
        return;
      }
    } catch (e) {}

    const preserveScreen = !!opts.preserveScreen;

    disconnect({ sendClose: false });

    if (!preserveScreen) {
      try { if (typeof term.clear === 'function') term.clear(); } catch (e) {}
    }
    safeWriteln(term, '[PTY] Подключение...');
    setConnState('connecting', 'PTY: подключение...');

    loadSessionState();

    // token
    let token = '';
    try {
      token = await fetchWsToken();
    } catch (e) {
      safeWriteln(term, '[PTY] Ошибка получения токена: ' + (e && e.message ? e.message : String(e)));
      setConnState('error', 'PTY: ошибка токена');
      scheduleRetry('token');
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
    if (state.ptyLastSeq) qs.set('last_seq', String(state.ptyLastSeq || 0));

    const url = `${proto}//${location.host}/ws/pty?${qs.toString()}`;

    let ws = null;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      safeWriteln(term, '[PTY] WebSocket недоступен: ' + (e && e.message ? e.message : String(e)));
      setConnState('error', 'PTY: WebSocket недоступен');
      scheduleRetry('ws ctor');
      return;
    }

    state.ptyWs = ws;
    state.ptyDisposables = state.ptyDisposables || [];

    const sendResize = () => {
      try {
        if (!state.ptyWs || state.ptyWs.readyState !== WebSocket.OPEN) return;
        state.ptyWs.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      } catch (e) {}
    };

    ws.onopen = () => {
      resetRetry({ unblock: true });
      safeWriteln(term, '[PTY] Соединение установлено.');
      setConnState('connected', 'PTY: подключено');
      try { if (state.fitAddon && state.fitAddon.fit) state.fitAddon.fit(); } catch (e) {}
      sendResize();
      startKeepalive();
    };

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (!msg) return;

      if (msg.type === 'output' && typeof msg.data === 'string') {
        safeWrite(term, msg.data);

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

        // session id from server
        try {
          if (msg.session_id != null) {
            state.ptySessionId = String(msg.session_id);
            saveSessionState();
          }
        } catch (e) {}

        if (msg.shell) safeWriteln(term, '[PTY] Shell: ' + msg.shell);
        if (msg.reused) safeWriteln(term, '[PTY] Reattached to existing session.');
      } else if (msg.type === 'exit') {
        stopRetry({ silent: true });
        safeWriteln(term, '\r\n[PTY] Завершено (code=' + msg.code + ').');
        setConnState('disconnected', 'PTY: shell завершился');
        clearSessionState();
        stopKeepalive();
      } else if (msg.type === 'error') {
        safeWriteln(term, '[PTY] Ошибка: ' + (msg.message || 'unknown'));
        setConnState('error', 'PTY: ошибка');
      }
    };

    ws.onerror = () => {
      setConnState('error', 'PTY: websocket error');
      try { safeWriteln(term, '\r\n[PTY] Ошибка WebSocket.'); } catch (e) {}
      scheduleRetry('onerror');
    };

    ws.onclose = (ev) => {
      stopKeepalive();
      try { if (ev && ev.target && ev.target.__xkeen_manual_close) return; } catch (e) {}
      safeWriteln(term, '\r\n[PTY] Соединение закрыто.');
      setConnState('disconnected', 'PTY: соединение закрыто');
      scheduleRetry('onclose');
    };

    // User input
    try {
      if (typeof term.onData === 'function') {
        state.ptyDisposables.push(term.onData((data) => {
          if (state.ptyWs && state.ptyWs.readyState === WebSocket.OPEN) {
            try { state.ptyWs.send(JSON.stringify({ type: 'input', data: String(data || '') })); } catch (e) {}
          }
        }));
      }
    } catch (e) {}

    // Resize
    try {
      if (typeof term.onResize === 'function') {
        state.ptyDisposables.push(term.onResize(() => sendResize()));
      }
    } catch (e) {}
  }

  function sendRaw(data) {
    const ws = state.ptyWs;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: 'input', data: String(data || '') })); } catch (e) {}
    }
  }

  // --------------------
  // Signals menu
  // --------------------
  function hideSignalsMenu() {
    const m = document.getElementById('terminal-signals-menu');
    if (!m) return;
    m.classList.add('hidden');
  }

  function toggleSignalsMenu(ev) {
    if (ev && ev.stopPropagation) ev.stopPropagation();
    const m = document.getElementById('terminal-signals-menu');
    if (!m) return;
    m.classList.toggle('hidden');
  }

  function sendSignal(name) {
    hideSignalsMenu();
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

  function initSignalsMenuAutoClose() {
    // click outside closes menu
    document.addEventListener('click', () => {
      try { hideSignalsMenu(); } catch (e) {}
    });
    // stop propagation inside menu
    const m = document.getElementById('terminal-signals-menu');
    if (m) {
      m.addEventListener('click', (e) => {
        try { e.stopPropagation(); } catch (e2) {}
      });
    }
  }

  // Export
  window.XKeen.terminal.pty = {
    connect,
    disconnect,
    sendRaw,

    // retry/backoff
    scheduleRetry,
    stopRetry,
    retryNow,
    resetRetry,

    // session
    getSessionId: () => (state.ptySessionId || null),
    clearSession: clearSessionState,

    // signals menu
    sendSignal,
    hideSignalsMenu,
    toggleSignalsMenu,
    initSignalsMenuAutoClose,
  };
})();

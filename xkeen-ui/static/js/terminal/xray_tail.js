// Terminal add-on: show Xray logs inside the full PTY terminal
//
// UX:
//   - Toolbar button "📜" opens a mini-menu
//   - Select error/access log
//   - Start runs: tail -n 200 -f <logfile>
//   - Stop sends Ctrl+C to PTY
(function () {
  'use strict';

  window.XKeen = window.XKeen || {};
  window.XKeen.terminal = window.XKeen.terminal || {};

  const API_STATUS = '/api/xray-logs/status';
  const API_ENABLE = '/api/xray-logs/enable';
  const API_DISABLE = '/api/xray-logs/disable';
  const FALLBACK_ERROR = '/opt/var/log/xray/error.log';
  const FALLBACK_ACCESS = '/opt/var/log/xray/access.log';

  let inited = false;
  let openBound = false;
  let docClickHandler = null;
  let docKeyHandler = null;
  let isRunning = false;
  let __ctxRef = null;

  let uiDisposers = [];
  let restartTimer = null;

  function setCtx(ctx) { __ctxRef = ctx || null; }

  function $(id) {
    try {
      const ctx = __ctxRef || (window.XKeen && window.XKeen.terminal && window.XKeen.terminal.core && window.XKeen.terminal.core.getCtx ? window.XKeen.terminal.core.getCtx() : null);
      if (ctx && ctx.ui && typeof ctx.ui.byId === 'function') return ctx.ui.byId(id);
    } catch (e0) {}
    try {
      const core = window.XKeen && window.XKeen.terminal && window.XKeen.terminal._core;
      if (core && typeof core.byId === 'function') return core.byId(id);
    } catch (e1) {}
    return null;
  }


  function hideMenu() {
    const m = $('terminal-xraylogs-menu');
    if (m) m.classList.add('hidden');
  }

  function toggleMenu(ev) {
    try { ev && ev.stopPropagation && ev.stopPropagation(); } catch (e) {}

    const m = $('terminal-xraylogs-menu');
    if (!m) return;
    m.classList.toggle('hidden');
  }

  function getSelectedFile() {
    const sel = $('terminal-xraylogs-file');
    const v = (sel && sel.value) ? String(sel.value) : 'error';
    return (v === 'access') ? 'access' : 'error';
  }

  function getSelectedLevel() {
    const sel = $('terminal-xraylogs-level');
    const v = (sel && sel.value) ? String(sel.value).toLowerCase() : 'warning';
    if (v === 'info' || v === 'debug' || v === 'warning') return v;
    return 'warning';
  }

  // NOTE: Intentionally do NOT auto-switch access.log -> error.log.
  // If user wants access.log even at info/debug, respect that.
  function maybeWarnAccessOnVerbose(level) {
    try {
      const lvl = String(level || '').toLowerCase();
      if (lvl !== 'info' && lvl !== 'debug') return;
      const fileSel = $('terminal-xraylogs-file');
      const cur = String((fileSel && fileSel.value) || '').toLowerCase();
      if (cur === 'access') {
        toast('Подсказка: при info/debug обычно полезнее error.log, но оставляю access.log как выбрано.', false);
      }
    } catch (e) {}
  }

  async function resolveLogPath(kind) {
    try {
      const res = await fetch(API_STATUS, { cache: 'no-store' });
      if (!res.ok) throw new Error('http ' + res.status);
      const data = await res.json().catch(() => ({}));
      const access = String(data.access || '').trim();
      const error = String(data.error || '').trim();
      if (kind === 'access') return access || FALLBACK_ACCESS;
      return error || FALLBACK_ERROR;
    } catch (e) {
      return (kind === 'access') ? FALLBACK_ACCESS : FALLBACK_ERROR;
    }
  }

  async function getLogStatus() {
    try {
      const res = await fetch(API_STATUS, { cache: 'no-store' });
      if (!res.ok) throw new Error('http ' + res.status);
      const data = await res.json().catch(() => ({}));
      return data || {};
    } catch (e) {
      return {};
    }
  }

  async function ensureLoggingEnabled(desiredLevel) {
    const want = String(desiredLevel || 'warning').toLowerCase();
    const target = (want === 'info' || want === 'debug' || want === 'warning') ? want : 'warning';

    const st = await getLogStatus();
    const lvl = String((st && st.loglevel) || 'none').toLowerCase();

    // If already enabled with the desired level — do nothing.
    if (lvl && lvl !== 'none' && lvl === target) return { ok: true, loglevel: lvl, changed: false };

    // If enabled but at another level OR disabled — set explicitly.
    try {
      const res = await fetch(API_ENABLE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ loglevel: target }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error('http ' + res.status);
      return { ok: true, loglevel: String(data.loglevel || target).toLowerCase(), changed: true };
    } catch (e) {
      return { ok: false, error: e };
    }
  }

  async function disableLogging() {
    try {
      const res = await fetch(API_DISABLE, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error('http ' + res.status);
      return { ok: true, data };
    } catch (e) {
      return { ok: false, error: e };
    }
  }

  function isPtyConnected() {
    // New API: ctx/core + ptyWs
    try {
      const ctx = (window.XKeen && window.XKeen.terminal && window.XKeen.terminal.core && window.XKeen.terminal.core.getCtx)
        ? window.XKeen.terminal.core.getCtx()
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

  function sendPtyRaw(data) {
    const payload = String(data == null ? '' : data);

    // New API: ctx.transport
    try {
      const ctx = (window.XKeen && window.XKeen.terminal && window.XKeen.terminal.core && window.XKeen.terminal.core.getCtx)
        ? window.XKeen.terminal.core.getCtx()
        : null;
      if (ctx && ctx.transport && typeof ctx.transport.send === 'function') {
        // Force PTY preference.
        if (ctx.transport.kind === 'pty') return !!ctx.transport.send(payload, { prefer: 'pty', allowWhenDisconnected: false, source: 'xray_tail' });
      }
    } catch (e0) {}

    try {
      const pty = window.XKeen && window.XKeen.terminal ? window.XKeen.terminal.pty : null;
      if (pty && typeof pty.sendRaw === 'function') { pty.sendRaw(payload); return true; }
    } catch (e2) {}

    return false;
  }

  function focusTerm() {
    try {
      const ctx = (window.XKeen && window.XKeen.terminal && window.XKeen.terminal.core && window.XKeen.terminal.core.getCtx)
        ? window.XKeen.terminal.core.getCtx()
        : null;
      const st = ctx && ctx.core && ctx.core.state ? ctx.core.state : null;
      const t = st ? (st.term || st.xterm) : null;
      if (t && typeof t.focus === 'function') t.focus();
    } catch (e) {}
  }

  function ensurePtyOpen() {
    try {
      const T = window.XKeen && XKeen.terminal ? XKeen.terminal : null;
      if (!T || typeof T.open !== 'function') return;
      // If not in PTY mode - switch to it.
      let mode = 'shell';
      try {
        const ctx = (window.XKeen && window.XKeen.terminal && window.XKeen.terminal.core && window.XKeen.terminal.core.getCtx)
          ? window.XKeen.terminal.core.getCtx()
          : null;
        const m1 = ctx && ctx.core && typeof ctx.core.getMode === 'function' ? ctx.core.getMode() : null;
        const m2 = ctx && ctx.state ? ctx.state.mode : null;
        mode = String(m1 || m2 || 'shell');
      } catch (e) {}
      if (mode !== 'pty') {
        T.open(null, { mode: 'pty' });
      }
    } catch (e) {}
  }

  function waitPtyConnected(maxMs) {
    const limit = Math.max(500, Number(maxMs) || 6000);
    const started = Date.now();
    return new Promise((resolve) => {
      const t = setInterval(() => {
        if (isPtyConnected()) {
          clearInterval(t);
          resolve(true);
          return;
        }
        if (Date.now() - started > limit) {
          clearInterval(t);
          resolve(false);
        }
      }, 150);
    });
  }

  async function start() {
    hideMenu();

    const desiredLevel = getSelectedLevel();

    // Optional UX hint only.
    maybeWarnAccessOnVerbose(desiredLevel);

    // Ensure Xray logging is actually enabled (01_log.json -> loglevel!=none)
    const en = await ensureLoggingEnabled(desiredLevel);
    if (!en.ok) {
      toast('Не удалось включить логи Xray (01_log.json).', true);
      // Still allow user to run tail (maybe logs already exist), but warn.
    } else {
      /* toast handled globally (spinner_fetch.js) */
    }

    ensurePtyOpen();
    const ok = await waitPtyConnected(7000);
    if (!ok) {
      toast('PTY не подключён — логи в терминале недоступны.', true);
      return;
    }

    // If our viewer is already running, restart it cleanly.
    // This prevents multiple "tail -f" processes and mixed/duplicated output.
    if (isRunning) {
      stopViewer();
      await new Promise((r) => setTimeout(r, 150));
    }
    const kind = getSelectedFile();
    const path = await resolveLogPath(kind);

    // Safer across BusyBox / Entware: use -f (not -F)
    const cmd = `tail -n 200 -f "${String(path).replace(/\"/g, '\\"')}"`;

    // Start on a fresh line + separator so restarts are visible
    sendPtyRaw('\r');
    sendPtyRaw(`echo "----- XRAY ${kind}.log (tail -f) -----"\r`);
    sendPtyRaw(cmd + '\r');
    isRunning = true;
    focusTerm();
  }

  function stopViewer() {
    // Ctrl+C
    sendPtyRaw('\x03');
    isRunning = false;
    focusTerm();
  }

  // Stop only the tail viewer (Ctrl+C). Do NOT change Xray logging settings.
  function stopTail() {
    hideMenu();
    if (!isRunning) return;
    stopViewer();
  }

  // Disable Xray logging (01_log.json -> loglevel=none + restart), and stop tail first.
  async function disableLogs() {
    hideMenu();
    // Stop viewer (tail) first to avoid keeping file handles while Xray restarts.
    if (isRunning) stopViewer();

    const dis = await disableLogging();
    if (!dis.ok) {
      toast('Не удалось отключить логи Xray (01_log.json).', true);
      return;
    }
    /* toast handled globally (spinner_fetch.js) */
  }

  function clearRestartTimer() {
    try { if (restartTimer) clearTimeout(restartTimer); } catch (e) {}
    restartTimer = null;
  }

  function restartSoon() {
    if (!isRunning) return;
    clearRestartTimer();
    // Stop current tail and start again shortly.
    stopViewer();
    restartTimer = setTimeout(() => { try { void start(); } catch (e) {} }, 250);
  }

  function onFileChange() {
    // If user switches log while "running", restart tail.
    restartSoon();
  }

  function on(el, ev, fn, opts) {
    if (!el || !el.addEventListener) return;
    el.addEventListener(ev, fn, opts);
    uiDisposers.push(() => {
      try { el.removeEventListener(ev, fn, opts); } catch (e) {}
    });
  }

  function disposeUi() {
    const ds = uiDisposers.splice(0, uiDisposers.length);
    ds.forEach((d) => { try { if (typeof d === 'function') d(); } catch (e) {} });
    inited = false;
  }

  function init() {
    if (inited) return;
    inited = true;

    const btn = $('terminal-btn-xraylogs');
    const m = $('terminal-xraylogs-menu');
    if (!btn || !m) return;

    on(btn, 'click', toggleMenu);
    on(m, 'click', (e) => { try { e.stopPropagation(); } catch (e2) {} });

    const startBtn = $('terminal-xraylogs-start');
    const stopBtn = $('terminal-xraylogs-stop');
    const disableBtn = $('terminal-xraylogs-disable');
    const sel = $('terminal-xraylogs-file');
    const lvlSel = $('terminal-xraylogs-level');

    if (startBtn) on(startBtn, 'click', () => { void start(); });
    if (stopBtn) on(stopBtn, 'click', () => { stopTail(); });
    if (disableBtn) on(disableBtn, 'click', () => { void disableLogs(); });
    if (sel) on(sel, 'change', onFileChange);

    // Prefill level selector from current status (if already enabled)
    if (lvlSel) {
      void getLogStatus().then((st) => {
        const lvl = String((st && st.loglevel) || '').toLowerCase();
        if (lvl === 'warning' || lvl === 'info' || lvl === 'debug') {
          lvlSel.value = lvl;
        }
      });
      on(lvlSel, 'change', () => {
        // Optional hint only.
        maybeWarnAccessOnVerbose(getSelectedLevel());
        restartSoon();
      });
    }
  }

  function bindWhileOpen() {
    if (openBound) return;
    openBound = true;

    docClickHandler = (ev) => {
      try {
        const menu = $('terminal-xraylogs-menu');
        const btn = $('terminal-btn-xraylogs');
        const t = ev && ev.target ? ev.target : null;
        if (menu && t && menu.contains(t)) return;
        if (btn && t && btn.contains(t)) return;
      } catch (e) {}
      hideMenu();
    };
    document.addEventListener('click', docClickHandler, true);

    docKeyHandler = (e) => {
      try { if (e && e.key === 'Escape') hideMenu(); } catch (e2) {}
    };
    document.addEventListener('keydown', docKeyHandler, true);
  }

  function unbindWhileOpen() {
    if (!openBound) return;
    openBound = false;
    try { if (docClickHandler) document.removeEventListener('click', docClickHandler, true); } catch (e) {}
    try { if (docKeyHandler) document.removeEventListener('keydown', docKeyHandler, true); } catch (e) {}
    docClickHandler = null;
    docKeyHandler = null;
  }

  function setUiEnabled(mode) {
    const enabled = String(mode || '').toLowerCase() === 'pty';
    try {
      const btn = $('terminal-btn-xraylogs');
      if (btn) btn.style.display = enabled ? '' : 'none';
    } catch (e) {}
    if (!enabled) hideMenu();
  }

  // Export (optional)
  // Backward compat: keep "stop" as an alias to disableLogs.
  window.XKeen.terminal.xray_tail = {
    init,
    start,
    stopTail,
    disableLogs,
    stop: disableLogs,
    // Milestone C: registry plugin factory
    createModule: (ctx) => ({
      id: 'xray_tail',
      priority: 85,
      init: () => { try { setCtx(ctx); } catch (e0) {} },
      onOpen: () => {
        try { setCtx(ctx); } catch (e0) {}
        try { init(); } catch (e1) {}
        try { bindWhileOpen(); } catch (e) {}
        try {
          const mode = (ctx && ctx.core && typeof ctx.core.getMode === 'function') ? ctx.core.getMode() : null;
          setUiEnabled(mode);
        } catch (e2) {}
      },
      onClose: () => {
        try { unbindWhileOpen(); } catch (e) {}
        try { hideMenu(); } catch (e2) {}
        try { clearRestartTimer(); } catch (e3) {}
        try { disposeUi(); } catch (e4) {}
        try { setCtx(null); } catch (e5) {}
      },
      onModeChange: (_ctx, mode) => { try { setUiEnabled(mode); } catch (e) {} },
    }),
  };
  window.XKeen.terminal.xrayTail = window.XKeen.terminal.xray_tail;

  // NOTE: No auto-init. This module is initialized via terminal registry (Milestone C).
})();

import {
  ensureTerminalRoot,
  focusTerminalView,
  getTerminalById,
  getTerminalCompatApi,
  getTerminalContext,
  getTerminalMode,
  getTerminalPtyApi,
  isTerminalPtyConnected,
  openTerminalCompat,
  publishTerminalCompatApi,
  toastTerminal,
} from './runtime.js';

// Terminal add-on: show Xray logs inside the full PTY terminal
(function () {
  'use strict';

  const core = getTerminalCompatApi('_core');

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
  let ctxRef = null;

  let uiDisposers = [];
  let restartTimer = null;

  function setCtx(ctx) {
    ctxRef = ctx || null;
  }

  function getCtx() {
    return ctxRef || getTerminalContext();
  }

  function resetRunningState() {
    isRunning = false;
    clearRestartTimer();
  }

  function byId(id) {
    const ctx = getCtx();
    return getTerminalById(id, (key) => {
      try {
        if (ctx && ctx.ui && typeof ctx.ui.byId === 'function') return ctx.ui.byId(key);
      } catch (error) {}
      try {
        if (core && typeof core.byId === 'function') return core.byId(key);
      } catch (error2) {}
      return null;
    });
  }

  function toast(message, isError) {
    const kind = isError ? 'error' : 'info';
    try {
      const ctx = getCtx();
      if (ctx && ctx.ui && typeof ctx.ui.toast === 'function') return ctx.ui.toast(String(message || ''), kind);
    } catch (error) {}
    return toastTerminal(String(message || ''), kind);
  }

  function hideMenu() {
    const menu = byId('terminal-xraylogs-menu');
    if (menu) menu.classList.add('hidden');
  }

  function toggleMenu(ev) {
    try { if (ev && ev.stopPropagation) ev.stopPropagation(); } catch (error) {}
    const menu = byId('terminal-xraylogs-menu');
    if (!menu) return;
    menu.classList.toggle('hidden');
  }

  function getSelectedFile() {
    const select = byId('terminal-xraylogs-file');
    const value = (select && select.value) ? String(select.value) : 'error';
    return value === 'access' ? 'access' : 'error';
  }

  function getSelectedLevel() {
    const select = byId('terminal-xraylogs-level');
    const value = (select && select.value) ? String(select.value).toLowerCase() : 'warning';
    if (value === 'info' || value === 'debug' || value === 'warning') return value;
    return 'warning';
  }

  function maybeWarnAccessOnVerbose(level) {
    try {
      const normalized = String(level || '').toLowerCase();
      if (normalized !== 'info' && normalized !== 'debug') return;
      const fileSel = byId('terminal-xraylogs-file');
      const current = String((fileSel && fileSel.value) || '').toLowerCase();
      if (current === 'access') {
        toast('Подсказка: при info/debug обычно полезнее error.log, но оставляю access.log как выбрано.', false);
      }
    } catch (error) {}
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
    } catch (error) {
      return kind === 'access' ? FALLBACK_ACCESS : FALLBACK_ERROR;
    }
  }

  async function getLogStatus() {
    try {
      const res = await fetch(API_STATUS, { cache: 'no-store' });
      if (!res.ok) throw new Error('http ' + res.status);
      return await res.json().catch(() => ({}));
    } catch (error) {
      return {};
    }
  }

  async function ensureLoggingEnabled(desiredLevel) {
    const want = String(desiredLevel || 'warning').toLowerCase();
    const target = (want === 'info' || want === 'debug' || want === 'warning') ? want : 'warning';

    const status = await getLogStatus();
    const current = String((status && status.loglevel) || 'none').toLowerCase();
    if (current && current !== 'none' && current === target) {
      return { ok: true, loglevel: current, changed: false };
    }

    try {
      const res = await fetch(API_ENABLE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ loglevel: target }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error('http ' + res.status);
      return { ok: true, loglevel: String(data.loglevel || target).toLowerCase(), changed: true };
    } catch (error) {
      return { ok: false, error };
    }
  }

  async function disableLogging() {
    try {
      const res = await fetch(API_DISABLE, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error('http ' + res.status);
      return { ok: true, data };
    } catch (error) {
      return { ok: false, error };
    }
  }

  function isPtyConnected() {
    return isTerminalPtyConnected();
  }

  function sendPtyRaw(data) {
    const payload = String(data == null ? '' : data);

    try {
      const ctx = getCtx();
      if (ctx && ctx.transport && typeof ctx.transport.send === 'function' && ctx.transport.kind === 'pty') {
        return !!ctx.transport.send(payload, { prefer: 'pty', allowWhenDisconnected: false, source: 'xray_tail' });
      }
    } catch (error) {}

    try {
      const pty = getTerminalPtyApi();
      if (pty && typeof pty.sendRaw === 'function') return !!pty.sendRaw(payload);
    } catch (error2) {}

    return false;
  }

  function focusTerm() {
    focusTerminalView();
  }

  function ensurePtyOpen() {
    try {
      if (getTerminalMode(getCtx()) !== 'pty') {
        openTerminalCompat({ mode: 'pty', cmd: '' });
      }
    } catch (error) {}
  }

  function waitPtyConnected(maxMs) {
    const limit = Math.max(500, Number(maxMs) || 6000);
    const started = Date.now();
    return new Promise((resolve) => {
      const timer = setInterval(() => {
        if (isPtyConnected()) {
          clearInterval(timer);
          resolve(true);
          return;
        }
        if (Date.now() - started > limit) {
          clearInterval(timer);
          resolve(false);
        }
      }, 150);
    });
  }

  async function start() {
    hideMenu();

    const desiredLevel = getSelectedLevel();
    maybeWarnAccessOnVerbose(desiredLevel);

    const enabled = await ensureLoggingEnabled(desiredLevel);
    if (!enabled.ok) {
      toast('Не удалось включить логи Xray (01_log.json).', true);
    }

    ensurePtyOpen();
    const ok = await waitPtyConnected(7000);
    if (!ok) {
      toast('PTY не подключён — логи в терминале недоступны.', true);
      return;
    }

    if (isRunning) {
      stopViewer();
      await new Promise((resolve) => setTimeout(resolve, 150));
    }

    const kind = getSelectedFile();
    const path = await resolveLogPath(kind);
    const cmd = `tail -n 200 -f "${String(path).replace(/\"/g, '\\"')}"`;

    sendPtyRaw('\r');
    sendPtyRaw(`echo "----- XRAY ${kind}.log (tail -f) -----"\r`);
    isRunning = !!sendPtyRaw(cmd + '\r');
    if (!isRunning) {
      toast('PTY подключён, но tail не запустился.', true);
      return;
    }
    focusTerm();
  }

  function stopViewer() {
    sendPtyRaw('\x03');
    isRunning = false;
    focusTerm();
  }

  function stopTail() {
    hideMenu();
    if (!isRunning) return;
    stopViewer();
  }

  async function disableLogs() {
    hideMenu();
    if (isRunning) stopViewer();

    const disabled = await disableLogging();
    if (!disabled.ok) {
      toast('Не удалось отключить логи Xray (01_log.json).', true);
    }
  }

  function clearRestartTimer() {
    try { if (restartTimer) clearTimeout(restartTimer); } catch (error) {}
    restartTimer = null;
  }

  function restartSoon() {
    if (!isRunning) return;
    clearRestartTimer();
    stopViewer();
    restartTimer = setTimeout(() => { try { void start(); } catch (error) {} }, 250);
  }

  function onFileChange() {
    restartSoon();
  }

  function on(el, ev, fn, opts) {
    if (!el || !el.addEventListener) return;
    el.addEventListener(ev, fn, opts);
    uiDisposers.push(() => {
      try { el.removeEventListener(ev, fn, opts); } catch (error) {}
    });
  }

  function disposeUi() {
    const disposers = uiDisposers.splice(0, uiDisposers.length);
    disposers.forEach((dispose) => {
      try { if (typeof dispose === 'function') dispose(); } catch (error) {}
    });
    inited = false;
  }

  function init() {
    if (inited) return;
    inited = true;

    const btn = byId('terminal-btn-xraylogs');
    const menu = byId('terminal-xraylogs-menu');
    if (!btn || !menu) return;

    on(btn, 'click', toggleMenu);
    on(menu, 'click', (ev) => { try { ev.stopPropagation(); } catch (error) {} });

    const startBtn = byId('terminal-xraylogs-start');
    const stopBtn = byId('terminal-xraylogs-stop');
    const disableBtn = byId('terminal-xraylogs-disable');
    const fileSel = byId('terminal-xraylogs-file');
    const levelSel = byId('terminal-xraylogs-level');

    if (startBtn) on(startBtn, 'click', () => { void start(); });
    if (stopBtn) on(stopBtn, 'click', () => { stopTail(); });
    if (disableBtn) on(disableBtn, 'click', () => { void disableLogs(); });
    if (fileSel) on(fileSel, 'change', onFileChange);

    if (levelSel) {
      void getLogStatus().then((status) => {
        const level = String((status && status.loglevel) || '').toLowerCase();
        if (level === 'warning' || level === 'info' || level === 'debug') {
          levelSel.value = level;
        }
      });
      on(levelSel, 'change', () => {
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
        const menu = byId('terminal-xraylogs-menu');
        const btn = byId('terminal-btn-xraylogs');
        const target = ev && ev.target ? ev.target : null;
        if (menu && target && menu.contains(target)) return;
        if (btn && target && btn.contains(target)) return;
      } catch (error) {}
      hideMenu();
    };
    document.addEventListener('click', docClickHandler, true);

    docKeyHandler = (ev) => {
      try { if (ev && ev.key === 'Escape') hideMenu(); } catch (error) {}
    };
    document.addEventListener('keydown', docKeyHandler, true);
  }

  function unbindWhileOpen() {
    if (!openBound) return;
    openBound = false;
    try { if (docClickHandler) document.removeEventListener('click', docClickHandler, true); } catch (error) {}
    try { if (docKeyHandler) document.removeEventListener('keydown', docKeyHandler, true); } catch (error2) {}
    docClickHandler = null;
    docKeyHandler = null;
  }

  function setUiEnabled(mode) {
    const enabled = String(mode || '').toLowerCase() === 'pty';
    try {
      const btn = byId('terminal-btn-xraylogs');
      if (btn) btn.style.display = enabled ? '' : 'none';
    } catch (error) {}
    if (!enabled) {
      resetRunningState();
      hideMenu();
    }
  }

  const terminalXrayTailApi = {
    init,
    start,
    stopTail,
    disableLogs,
    stop: disableLogs,
    createModule: (ctx) => ({
      id: 'xray_tail',
      priority: 85,
      init: () => { try { setCtx(ctx); } catch (error) {} },
      onOpen: () => {
        try { setCtx(ctx); } catch (error) {}
        try { init(); } catch (error2) {}
        try { bindWhileOpen(); } catch (error3) {}
        try {
          const mode = (ctx && ctx.core && typeof ctx.core.getMode === 'function') ? ctx.core.getMode() : getTerminalMode(ctx);
          setUiEnabled(mode);
        } catch (error4) {}
      },
      onClose: () => {
        try { unbindWhileOpen(); } catch (error) {}
        try { hideMenu(); } catch (error2) {}
        try { resetRunningState(); } catch (error3) {}
        try { disposeUi(); } catch (error4) {}
        try { setCtx(null); } catch (error5) {}
      },
      onModeChange: (_ctx, mode) => { try { setUiEnabled(mode); } catch (error) {} },
    }),
  };

  try {
    const terminal = ensureTerminalRoot();
    if (terminal) terminal.xrayTail = terminalXrayTailApi;
  } catch (error) {}

  publishTerminalCompatApi('xray_tail', terminalXrayTailApi);
  publishTerminalCompatApi('xrayTail', terminalXrayTailApi);
})();

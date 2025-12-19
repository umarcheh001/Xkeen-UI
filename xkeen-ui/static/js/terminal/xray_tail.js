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
  let isRunning = false;

  function $(id) { return document.getElementById(id); }


  function hideMenu() {
    const m = $('terminal-xraylogs-menu');
    if (m) m.classList.add('hidden');
  }

  function toggleMenu(ev) {
    try { ev && ev.stopPropagation && ev.stopPropagation(); } catch (e) {}

    // Close signals menu if present
    try {
      const pty = window.XKeen && XKeen.terminal ? XKeen.terminal.pty : null;
      if (pty && typeof pty.hideSignalsMenu === 'function') pty.hideSignalsMenu();
    } catch (e) {}

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
    try {
      const T = window.XKeen && XKeen.terminal ? XKeen.terminal : null;
      if (T && T._legacy && typeof T._legacy.isPtyConnected === 'function') {
        return !!T._legacy.isPtyConnected();
      }
    } catch (e) {}
    return false;
  }

  function sendPtyRaw(data) {
    try {
      const T = window.XKeen && XKeen.terminal ? XKeen.terminal : null;
      if (T && T._legacy && typeof T._legacy.sendPtyRaw === 'function') {
        return T._legacy.sendPtyRaw(String(data == null ? '' : data));
      }
    } catch (e) {}
    try {
      const pty = window.XKeen && XKeen.terminal ? XKeen.terminal.pty : null;
      if (pty && typeof pty.sendRaw === 'function') return pty.sendRaw(String(data || ''));
    } catch (e2) {}
  }

  function focusTerm() {
    try {
      const T = window.XKeen && XKeen.terminal ? XKeen.terminal : null;
      if (T && T._legacy && typeof T._legacy.focus === 'function') T._legacy.focus();
    } catch (e) {}
  }

  function ensurePtyOpen() {
    try {
      const T = window.XKeen && XKeen.terminal ? XKeen.terminal : null;
      if (!T || typeof T.open !== 'function') return;
      // If not in PTY mode - switch to it.
      let mode = 'shell';
      try {
        mode = (T._legacy && typeof T._legacy.getMode === 'function') ? String(T._legacy.getMode()) : 'shell';
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

    // If something is already running (tail or anything else), we do NOT kill it automatically.
    // The user can press Stop manually. Still, we keep our own "running" flag for UX.
    const kind = getSelectedFile();
    const path = await resolveLogPath(kind);

    // Safer across BusyBox / Entware: use -f (not -F)
    const cmd = `tail -n 200 -f "${String(path).replace(/\"/g, '\\"')}"`;

    // Start on a fresh line
    sendPtyRaw('\r');
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

  async function stop() {
    hideMenu();
    // Stop viewer (tail) first to avoid keeping file handles while Xray restarts.
    stopViewer();

    // Then disable Xray logging (01_log.json -> loglevel=none)
    const dis = await disableLogging();
    if (!dis.ok) {
      toast('Не удалось выключить логи Xray (01_log.json).', true);
      return;
    }
    /* toast handled globally (spinner_fetch.js) */
  }

  function onFileChange() {
    // If user switches log while "running", restart tail.
    if (!isRunning) return;
    // Stop current tail and start again shortly.
    stopViewer();
    setTimeout(() => { void start(); }, 200);
  }

  function init() {
    if (inited) return;
    inited = true;

    const btn = $('terminal-btn-xraylogs');
    const m = $('terminal-xraylogs-menu');
    if (!btn || !m) return;

    btn.addEventListener('click', toggleMenu);
    document.addEventListener('click', () => hideMenu());
    m.addEventListener('click', (e) => {
      try { e.stopPropagation(); } catch (e2) {}
    });

    const startBtn = $('terminal-xraylogs-start');
    const stopBtn = $('terminal-xraylogs-stop');
    const sel = $('terminal-xraylogs-file');
    const lvlSel = $('terminal-xraylogs-level');

    if (startBtn) startBtn.addEventListener('click', () => { void start(); });
    if (stopBtn) stopBtn.addEventListener('click', () => { void stop(); });
    if (sel) sel.addEventListener('change', onFileChange);

    // Prefill level selector from current status (if already enabled)
    if (lvlSel) {
      void getLogStatus().then((st) => {
        const lvl = String((st && st.loglevel) || '').toLowerCase();
        if (lvl === 'warning' || lvl === 'info' || lvl === 'debug') {
          lvlSel.value = lvl;
        }
      });
      lvlSel.addEventListener('change', () => {
        if (!isRunning) return;
        // Restart tail to keep UX consistent with file switch.
        stopViewer();
        setTimeout(() => { void start(); }, 200);
      });
    }
  }

  // Export (optional)
  window.XKeen.terminal.xrayTail = { init, start, stop };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

// XKeen terminal island: xterm/PTY + lite command runner + UI wiring
// Extracted from legacy static/main.js

(function () {
  'use strict';

  // Namespace
  window.XKeen = window.XKeen || {};
  window.XKeen.state = window.XKeen.state || {};
  window.XKeen.terminal = window.XKeen.terminal || {};

  // --------------------
  // Per-tab identity
  // --------------------
  // Moved to util/tab_id.js (XKeen.util.getTabId). We keep a small fallback
  // here so terminal stays robust if script ordering changes.
  const XKEEN_TAB_ID = (() => {
    try {
      if (window.XKeen && XKeen.util && typeof XKeen.util.getTabId === 'function') {
        return XKeen.util.getTabId();
      }
    } catch (e) {}
    // Emergency fallback: non-persistent id.
    return 'xkeen_tab_id_v1:' + (String(Math.random()).slice(2) + '-' + String(Date.now()));
  })();



// --------------------
// Capabilities (WS support etc.)
// --------------------
function xkeenHasWs() {
  try {
    return !!(window.XKeen && XKeen.terminal && XKeen.terminal.capabilities &&
      typeof XKeen.terminal.capabilities.hasWs === 'function' &&
      XKeen.terminal.capabilities.hasWs());
  } catch (e) {}
  return false;
}

function xkeenInitCapabilities() {
  try {
    if (window.XKeen && XKeen.terminal && XKeen.terminal.capabilities &&
        typeof XKeen.terminal.capabilities.initCapabilities === 'function') {
      // Async; we don't need to await
      void XKeen.terminal.capabilities.initCapabilities();
    }
  } catch (e) {}
}

// Terminal retry controls (PTY auto-reconnect with backoff)
// (PTY auto-reconnect with backoff)
//
// Goal: when PTY WebSocket closes/errors (or initial connect fails), automatically
// retry with exponential backoff. "Stop retry" is shown only while retry is active.
// User can stop retry; it will stay disabled until explicit manual reconnect.
const TERMINAL_PTY_RETRY_CFG = {
  baseMs: 800,      // first delay
  factor: 1.8,      // exponential growth
  maxMs: 20000,     // cap
  jitter: 0.20,     // +-20%
  maxAttempts: 0,   // 0 = unlimited
};

let terminalRetryTimer = null;
let terminalRetryIsActive = false;
let terminalRetryAttempt = 0;
let terminalRetryBlocked = false; // set by Stop retry; cleared by manual reconnect/open
let terminalRetryNextAt = 0;

function terminalIsOverlayOpen() {
  const overlay = document.getElementById('terminal-overlay');
  if (!overlay) return false;
  // Robust cross-browser visibility check.
  // NOTE: using `offsetParent !== null` breaks for `position: fixed` elements
  // (e.g. Chrome returns null even when visible). This caused PTY auto-retry
  // to never schedule in some browsers.
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
function xkeenSyncBodyScrollLock() {
  // moved to ui/modal.js (XKeen.ui.modal.syncBodyScrollLock)
  try {
    if (window.XKeen && XKeen.ui && XKeen.ui.modal && typeof XKeen.ui.modal.syncBodyScrollLock === 'function') {
      return XKeen.ui.modal.syncBodyScrollLock();
    }
  } catch (e) {}
}

// ANSI formatting is a shared util (moved to util/ansi.js).
// Keep a tiny local wrapper for legacy call sites inside this file.
function ansiToHtml(text) {
  try {
    if (window.XKeen && XKeen.util && typeof XKeen.util.ansiToHtml === 'function') {
      return XKeen.util.ansiToHtml(text || '');
    }
  } catch (e) {}
  // Fallback: escape only.
  try {
    if (typeof escapeHtml === 'function') return escapeHtml(text || '');
  } catch (e2) {}
  return String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function terminalUpdateRetryUi() {
  // Stop retry button must only appear when retry is active.
  const btn = document.getElementById('terminal-btn-stop-retry');
  if (!btn) return;

  const isPty = (currentCommandMode === 'pty');
  const show = isPty && terminalRetryIsActive;
  btn.style.display = show ? '' : 'none';

  if (show) {
    // Helpful tooltip: attempt + seconds remaining.
    try {
      const msLeft = Math.max(0, (terminalRetryNextAt || 0) - Date.now());
      const sLeft = Math.ceil(msLeft / 1000);
      btn.title = (sLeft > 0)
        ? `Остановить автоподключение (следующая попытка через ${sLeft}с, попытка ${terminalRetryAttempt || 1})`
        : `Остановить автоподключение (попытка ${terminalRetryAttempt || 1})`;
    } catch (e) {
      btn.title = 'Остановить автоподключение';
    }
  } else {
    btn.title = 'Остановить автоподключение';
  }
}

function terminalClearRetryTimer() {
  if (terminalRetryTimer) {
    try { clearTimeout(terminalRetryTimer); } catch (e) {}
    terminalRetryTimer = null;
  }
  terminalRetryNextAt = 0;
}

function terminalResetRetry(opts = {}) {
  // Clears retry state but does NOT block future retries.
  terminalRetryIsActive = false;
  terminalRetryAttempt = 0;
  terminalClearRetryTimer();
  if (opts && opts.unblock) terminalRetryBlocked = false;
  terminalUpdateRetryUi();
}

function terminalStopRetry(opts = {}) {
  // Stops any pending auto-retry timer and blocks further retries until manual reconnect.
  const hadActive = !!terminalRetryTimer || !!terminalRetryIsActive;

  terminalRetryBlocked = true;
  terminalRetryIsActive = false;
  terminalRetryAttempt = 0;
  terminalClearRetryTimer();
  terminalUpdateRetryUi();

  if (opts && opts.silent) return;

  try {
    if (typeof showToast === 'function') {
      showToast(hadActive ? 'Retry stopped' : 'No retry in progress', 'info');
    }
  } catch (e) {}
}

function terminalScheduleRetry(reason, opts = {}) {
  // Schedules a reconnect attempt for PTY. No-op if user blocked retries or terminal is closed.
  if (terminalRetryBlocked) return;
  if (currentCommandMode !== 'pty') return;
  if (!terminalIsOverlayOpen()) return;
  if (!xkeenTerm) return;

  // Avoid stacking timers.
  if (terminalRetryTimer) {
    terminalRetryIsActive = true;
    terminalUpdateRetryUi();
    return;
  }
  terminalClearRetryTimer();

  terminalRetryIsActive = true;

  const maxAttempts = TERMINAL_PTY_RETRY_CFG.maxAttempts || 0;
  if (maxAttempts > 0 && terminalRetryAttempt >= maxAttempts) {
    terminalRetryIsActive = false;
    terminalUpdateRetryUi();
    try { terminalSetConnState('error', 'PTY: retry limit reached'); } catch (e) {}
    try { xkeenTermWriteln(`
[PTY] Auto-retry stopped (max attempts reached).`); } catch (e) {}
    return;
  }

  terminalRetryAttempt = (terminalRetryAttempt || 0) + 1;

  const base = Math.max(100, TERMINAL_PTY_RETRY_CFG.baseMs || 800);
  const factor = Math.max(1.1, TERMINAL_PTY_RETRY_CFG.factor || 1.8);
  const cap = Math.max(base, TERMINAL_PTY_RETRY_CFG.maxMs || 20000);
  const jitter = Math.max(0, Math.min(0.5, TERMINAL_PTY_RETRY_CFG.jitter || 0));

  let delay = Math.floor(base * (factor ** Math.max(0, terminalRetryAttempt - 1)));
  delay = Math.min(cap, delay);
  if (jitter > 0) {
    const r = (Math.random() * 2 - 1) * jitter; // [-jitter, +jitter]
    delay = Math.max(100, Math.floor(delay * (1 + r)));
  }

  terminalRetryNextAt = Date.now() + delay;
  terminalUpdateRetryUi();

  const sec = (delay / 1000).toFixed(1);
  try {
    xkeenTermWriteln(`
[PTY] Auto-retry in ${sec}s (attempt ${terminalRetryAttempt})${reason ? ' — ' + reason : ''}`);
  } catch (e) {}
  try {
    terminalSetConnState('connecting', `PTY: retry in ${sec}s`);
  } catch (e) {}

  terminalRetryTimer = setTimeout(() => {
    terminalRetryTimer = null;
    terminalRetryNextAt = 0;

    // Re-check conditions at fire time.
    if (terminalRetryBlocked) return;
    if (currentCommandMode !== 'pty') return;
    if (!terminalIsOverlayOpen()) return;
    if (!xkeenTerm) return;

    // Attempt reconnect. Keep screen and resume from last seq.
    xkeenPtyConnect(xkeenTerm, { preserveScreen: true, isAutoRetry: true });
  }, delay);
}

let currentCommandFlag = null;
let currentCommandLabel = null;
let currentCommandMode = 'shell'; // 'shell' | 'xkeen' | 'pty'

// UI: in "урезанном" терминале (shell/xkeen) должны показываться только доступные кнопки.
// Полный интерактивный терминал (PTY) остаётся без изменений.
function terminalApplyModeUi() {
  const isPty = (currentCommandMode === 'pty');

  const show = (id, on) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.style.display = on ? '' : 'none';
  };

  // PTY-only chrome
  show('terminal-conn-lamp', isPty);
  show('terminal-uptime', isPty);
  show('terminal-search-row', isPty);
  show('terminal-btn-reconnect', isPty);
  // Stop retry button is only shown while auto-retry is actually active.
  show('terminal-btn-stop-retry', isPty && terminalRetryIsActive);
  show('terminal-btn-new-session', isPty);
  show('terminal-btn-ctrlc', isPty);
  show('terminal-btn-ctrld', isPty);
  show('terminal-btn-detach', isPty);
  show('terminal-btn-kill', isPty);
  show('terminal-btn-signals', isPty);
  show('terminal-btn-retry-now', isPty);
  show('terminal-btn-ssh', isPty);

  // Requested: in урезанном терминале (shell/xkeen) убрать Follow/bottom/minimize/fullscreen.
  // In полноценном PTY (websocket) keep them.
  show('terminal-btn-minimize', isPty);
  show('terminal-btn-fullscreen', isPty);
  show('terminal-btn-follow', isPty);
  show('terminal-btn-bottom', isPty);

  // History button should be available in PTY (command history drawer can also send to PTY).
  // In lite terminal it is intentionally hidden (не нужно по ТЗ).
  show('terminal-history-btn', isPty);

  // Cursor blink makes sense only for interactive PTY.
  show('terminal-btn-cursorblink', isPty);

  // Footer groups: буфер/команды нужны только в полноценном PTY.
  show('terminal-buffer-group', isPty);
  show('terminal-commands-group', isPty);

  // ANSI filter / W-E highlight сейчас фактически применяются только в "lite" выводе (shell/xkeen),
  // т.к. PTY пишет в xterm напрямую (term.write(msg.data)). Чтобы не путать — скрываем в PTY.
  show('terminal-btn-ansi', !isPty);
  show('terminal-btn-loghl', !isPty);

  // Keep retry UI (button + tooltip) in sync.
  try { terminalUpdateRetryUi(); } catch (e) {}

  // When leaving PTY: clear search UI state (no highlight remains if user opens lite terminal next).
  if (!isPty) {
    try { terminalSearchClear({ silent: true }); } catch (e) {}
  }
}


// Confirmation input ("Текст для подтверждения") is only needed for commands that explicitly ask for it.
// In lite terminal (shell/xkeen) keep it hidden until we detect a confirmation prompt in output.
function terminalConfirmIsVisible() {
  const inputEl = document.getElementById('terminal-input');
  if (!inputEl) return false;
  if (inputEl.style && inputEl.style.display === 'none') return false;
  if (inputEl.offsetParent === null) return false;
  return true;
}

function terminalSetConfirmVisible(visible, opts = {}) {
  const inputEl = document.getElementById('terminal-input');
  if (!inputEl) return;

  const row = inputEl.closest ? inputEl.closest('.terminal-input-row') : null;

  if (visible) {
    inputEl.style.display = '';
    if (row) row.classList.remove('confirm-hidden');
    if (opts && opts.focus) {
      try { inputEl.focus(); } catch (e) {}
    }
  } else {
    inputEl.style.display = 'none';
    if (row) row.classList.add('confirm-hidden');
    if (!opts || opts.clear !== false) {
      inputEl.value = '';
    }
  }
}

function terminalDetectConfirmPrompt(text) {
  const s = String(text || '');
  // Common confirm prompts (RU/EN). Keep patterns reasonably strict to avoid false positives.
  const patterns = [
    /для\s+подтвержден/i,
    /нужно\s+подтверд/i,
    /подтверд(ите|ить)/i,
    /введите\s+(?:yes|y)\b/i,
    /нажмите\s+enter\b/i,
    /type\s+(?:yes|y)\b/i,
    /are\s+you\s+sure/i,
    /\bconfirm\b/i,
    /\b(y\/n|yes\/no)\b/i,
    /\[[yY]\s*\/\s*[nN]\]/,
    /\([yY]\s*\/\s*[nN]\)/,
    /press\s+enter\b/i,
  ];
  return patterns.some((re) => re.test(s));
}

// Reveal the confirm input only when output hints that the command asks for confirmation.
function terminalMaybeRevealConfirm(text, opts = {}) {
  if (currentCommandMode === 'pty') return false;
  if (terminalConfirmIsVisible()) return false;
  if (!terminalDetectConfirmPrompt(text)) return false;
  terminalSetConfirmVisible(true, { focus: !!opts.focus });
  return true;
}

function terminalResetConfirmUi() {
  if (currentCommandMode !== 'pty') {
    terminalSetConfirmVisible(false, { clear: true });
  }
}

let ptyWs = null;
let ptyDisposables = [];
let ptyPrevConvertEol = null;


// PTY reconnect state (tab-scoped via sessionStorage namespacing)
// IMPORTANT: do not store under a fixed key, otherwise sessionStorage cloning can
// make two tabs share one PTY backend session_id and fight each other.
const XKEEN_PTY_SESSION_KEY_BASE = 'xkeen_pty_session_id_v1';
const XKEEN_PTY_LASTSEQ_KEY_BASE = 'xkeen_pty_last_seq_v1';

function ptyStorageKey(base) {
  // Use XKEEN_TAB_ID which is stable per-tab (window.name based).
  return String(base) + ':' + String(XKEEN_TAB_ID);
}

function ptyLegacyKey(base) {
  // Previous versions stored without a suffix.
  return String(base);
}

function xkeenIsReloadLikeNavigation() {
  // We only auto-migrate legacy PTY keys on reload/back-forward of the *same tab*.
  // This avoids migrating cloned sessionStorage state into a newly opened tab.
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

function ptyTryMigrateLegacyKey(base) {
  // Best-effort migration: if legacy value exists in this tab's sessionStorage,
  // move it to the new namespaced key.
  if (!xkeenIsReloadLikeNavigation()) return null;
  try {
    const legacy = sessionStorage.getItem(ptyLegacyKey(base));
    if (legacy == null) return null;
    // Only migrate if the new key is empty.
    const k = ptyStorageKey(base);
    const existing = sessionStorage.getItem(k);
    if (existing == null || existing === '') {
      sessionStorage.setItem(k, String(legacy));
    }
    sessionStorage.removeItem(ptyLegacyKey(base));
    return legacy;
  } catch (e) {
    return null;
  }
}
let ptySessionId = null;
let ptyLastSeq = 0;

function ptyLoadSessionState() {
  try {
    let sid = null;
    try { sid = sessionStorage.getItem(ptyStorageKey(XKEEN_PTY_SESSION_KEY_BASE)); } catch (e) { sid = null; }
    if (sid == null) sid = ptyTryMigrateLegacyKey(XKEEN_PTY_SESSION_KEY_BASE);
    if (sid) ptySessionId = String(sid);
  } catch (e) {}
  try {
    let ls = null;
    try { ls = sessionStorage.getItem(ptyStorageKey(XKEEN_PTY_LASTSEQ_KEY_BASE)); } catch (e) { ls = null; }
    if (ls == null) ls = ptyTryMigrateLegacyKey(XKEEN_PTY_LASTSEQ_KEY_BASE);
    if (ls) ptyLastSeq = Math.max(0, parseInt(ls, 10) || 0);
  } catch (e) {}
}

function ptySaveSessionState() {
  try { if (ptySessionId) sessionStorage.setItem(ptyStorageKey(XKEEN_PTY_SESSION_KEY_BASE), String(ptySessionId)); } catch (e) {}
  try { sessionStorage.setItem(ptyStorageKey(XKEEN_PTY_LASTSEQ_KEY_BASE), String(ptyLastSeq || 0)); } catch (e) {}
}

function ptyClearSessionState() {
  ptySessionId = null;
  ptyLastSeq = 0;
  try { sessionStorage.removeItem(ptyStorageKey(XKEEN_PTY_SESSION_KEY_BASE)); } catch (e) {}
  try { sessionStorage.removeItem(ptyStorageKey(XKEEN_PTY_LASTSEQ_KEY_BASE)); } catch (e) {}
  // Also drop legacy keys in this tab, if present.
  try { sessionStorage.removeItem(ptyLegacyKey(XKEEN_PTY_SESSION_KEY_BASE)); } catch (e) {}
  try { sessionStorage.removeItem(ptyLegacyKey(XKEEN_PTY_LASTSEQ_KEY_BASE)); } catch (e) {}
}

// Load on startup
ptyLoadSessionState();

let xkeenTerm = null;
let xkeenTermFitAddon = null;
let xkeenTermResizeObserver = null;

// XTerm addons (loaded from static/xterm)
let xkeenTermSearchAddon = null;
let xkeenTermSearchResultsDisposable = null;
let xkeenTermWebLinksAddon = null;

// Terminal search UI state
let xkeenTerminalSearchTerm = '';
let xkeenTerminalSearchResultIndex = -1;
let xkeenTerminalSearchResultCount = 0;
let xkeenTerminalSearchDebounce = null;
let xkeenTerminalSearchKeysBound = false;

const XKEEN_TERM_SEARCH_DECORATIONS = {
  matchBackground: 'rgba(255, 255, 0, 0.20)',
  matchBorder: 'rgba(255, 255, 255, 0.30)',
  matchOverviewRuler: 'rgba(255, 255, 0, 0.65)',
  activeMatchBackground: 'rgba(255, 165, 0, 0.28)',
  activeMatchBorder: 'rgba(255, 255, 255, 0.60)',
  activeMatchColorOverviewRuler: 'rgba(255, 165, 0, 0.95)',
};

// ---------------- Terminal output filters (ANSI + log highlighting) ----------------
const XKEEN_TERM_PREF_ANSI_FILTER_KEY = 'xkeen_term_ansi_filter_v1';
const XKEEN_TERM_PREF_LOG_HL_KEY = 'xkeen_term_log_hl_v1';
// ---------------- XTerm runtime prefs (fontSize + cursorBlink) ----------------
// Эти настройки относятся только к xterm.js (UI-рендер), и должны сохраняться между перезагрузками страницы.
const XKEEN_TERM_PREF_FONT_SIZE_KEY = 'xkeen_term_font_size_v1';
const XKEEN_TERM_PREF_CURSOR_BLINK_KEY = 'xkeen_term_cursor_blink_v1';

// ---------------- Terminal scroll follow/lock pref ----------------
const XKEEN_TERM_PREF_FOLLOW_KEY = 'xkeen_term_follow_v1';
let xkeenTerminalFollow = true;


let xkeenTermPrefFontSize = 12;
let xkeenTermPrefCursorBlink = false;

function terminalLoadXtermPrefs() {
  try {
    const rawF = localStorage.getItem(XKEEN_TERM_PREF_FONT_SIZE_KEY);
    if (rawF != null) {
      const v = parseInt(rawF, 10);
      if (!isNaN(v)) xkeenTermPrefFontSize = Math.max(8, Math.min(32, v));
    }
  } catch (e) {}
  try {
    const rawB = localStorage.getItem(XKEEN_TERM_PREF_CURSOR_BLINK_KEY);
    if (rawB != null) xkeenTermPrefCursorBlink = (rawB === '1' || rawB === 'true');
  } catch (e) {}
}

function terminalSaveXtermPrefs() {
  try { localStorage.setItem(XKEEN_TERM_PREF_FONT_SIZE_KEY, String(xkeenTermPrefFontSize || 12)); } catch (e) {}
  try { localStorage.setItem(XKEEN_TERM_PREF_CURSOR_BLINK_KEY, xkeenTermPrefCursorBlink ? '1' : '0'); } catch (e) {}
}

function terminalLoadFollowPref() {
  try {
    const raw = localStorage.getItem(XKEEN_TERM_PREF_FOLLOW_KEY);
    if (raw != null) xkeenTerminalFollow = !(raw === '0' || raw === 'false');
  } catch (e) {}
}

function terminalSaveFollowPref() {
  try { localStorage.setItem(XKEEN_TERM_PREF_FOLLOW_KEY, xkeenTerminalFollow ? '1' : '0'); } catch (e) {}
}

function terminalScrollToBottom() {
  // Works both for xterm.js and for <pre> fallback.
  try {
    const t = xkeenTerm;
    if (t && typeof t.scrollToBottom === 'function') {
      t.scrollToBottom();
      return;
    }
  } catch (e) {}
  try {
    const out = document.getElementById('terminal-output');
    if (out) out.scrollTop = out.scrollHeight;
  } catch (e) {}
}

function terminalApplyFollowUi() {
  const btn = document.getElementById('terminal-btn-follow');
  if (btn) {
    btn.classList.toggle('is-active', !!xkeenTerminalFollow);
    btn.textContent = xkeenTerminalFollow ? '⇣ Следить' : '📌 Фикс';
    btn.title = xkeenTerminalFollow ? 'Автопрокрутка: ВКЛ (авто-переход в конец)' : 'Автопрокрутка: ВЫКЛ (фиксация прокрутки)';
  }
  const btm = document.getElementById('terminal-btn-bottom');
  if (btm) btm.title = 'В конец';
}

function terminalToggleFollow() {
  xkeenTerminalFollow = !xkeenTerminalFollow;
  terminalSaveFollowPref();
  terminalApplyFollowUi();
  if (xkeenTerminalFollow) {
    // When turning follow back on, immediately jump to bottom.
    terminalScrollToBottom();
  }
}

function terminalAutoFollow(term) {
  if (!xkeenTerminalFollow) return;
  try {
    const t = term || xkeenTerm;
    if (t && typeof t.scrollToBottom === 'function') {
      t.scrollToBottom();
      return;
    }
  } catch (e) {}
  // Fallback for <pre> mode
  try {
    const out = document.getElementById('terminal-output');
    if (out) out.scrollTop = out.scrollHeight;
  } catch (e) {}
}


function terminalApplyXtermPrefsToTerm(term) {
  if (!term) return;
  try {
    if (typeof term.setOption === 'function') {
      term.setOption('fontSize', xkeenTermPrefFontSize || 12);
      term.setOption('cursorBlink', !!xkeenTermPrefCursorBlink);
    } else if (term.options) {
      term.options.fontSize = xkeenTermPrefFontSize || 12;
      term.options.cursorBlink = !!xkeenTermPrefCursorBlink;
    }
  } catch (e) {}
}

function terminalApplyXtermPrefUi() {
  const btnBlink = document.getElementById('terminal-btn-cursorblink');
  if (btnBlink) {
    btnBlink.classList.toggle('is-active', !!xkeenTermPrefCursorBlink);
    btnBlink.title = xkeenTermPrefCursorBlink ? 'Мигание курсора: ВКЛ' : 'Мигание курсора: ВЫКЛ';
  }
  // Optional: reflect current font size in A-/A+ tooltips
  const btnDec = document.getElementById('terminal-btn-font-dec');
  const btnInc = document.getElementById('terminal-btn-font-inc');
  if (btnDec) btnDec.title = 'Шрифт − (сейчас ' + (xkeenTermPrefFontSize || 12) + ')';
  if (btnInc) btnInc.title = 'Шрифт + (сейчас ' + (xkeenTermPrefFontSize || 12) + ')';
}

// If true: incoming output is stripped from ANSI escape sequences before rendering
let xkeenTerminalAnsiFilter = false;

// If true: highlight WARN/ERR words in output (works best with ANSI filter ON)
let xkeenTerminalLogHighlight = true;

function terminalLoadOutputPrefs() {
  try {
    const rawA = localStorage.getItem(XKEEN_TERM_PREF_ANSI_FILTER_KEY);
    if (rawA != null) xkeenTerminalAnsiFilter = (rawA === '1' || rawA === 'true');
  } catch (e) {}
  try {
    const rawH = localStorage.getItem(XKEEN_TERM_PREF_LOG_HL_KEY);
    if (rawH != null) xkeenTerminalLogHighlight = !(rawH === '0' || rawH === 'false');
  } catch (e) {}
}

function terminalSaveOutputPrefs() {
  try { localStorage.setItem(XKEEN_TERM_PREF_ANSI_FILTER_KEY, xkeenTerminalAnsiFilter ? '1' : '0'); } catch (e) {}
  try { localStorage.setItem(XKEEN_TERM_PREF_LOG_HL_KEY, xkeenTerminalLogHighlight ? '1' : '0'); } catch (e) {}
}

function terminalApplyOutputPrefUi() {
  const btnAnsi = document.getElementById('terminal-btn-ansi');
  const btnHl = document.getElementById('terminal-btn-loghl');

  if (btnAnsi) {
    btnAnsi.classList.toggle('is-active', !!xkeenTerminalAnsiFilter);
    btnAnsi.title = xkeenTerminalAnsiFilter ? 'ANSI-фильтр: ВКЛ (удалять ANSI-коды из вывода)' : 'ANSI-фильтр: ВЫКЛ (как есть)';
  }
  if (btnHl) {
    btnHl.classList.toggle('is-active', !!xkeenTerminalLogHighlight);
    btnHl.title = xkeenTerminalLogHighlight ? 'Подсветка WARN/ERR: ВКЛ' : 'Подсветка WARN/ERR: ВЫКЛ';
  }
}

function terminalToggleAnsiFilter() {
  xkeenTerminalAnsiFilter = !xkeenTerminalAnsiFilter;
  terminalSaveOutputPrefs();
  terminalApplyOutputPrefUi();
  try { if (typeof showToast === 'function') showToast(xkeenTerminalAnsiFilter ? 'ANSI-фильтр: ВКЛ' : 'ANSI-фильтр: ВЫКЛ', 'info'); } catch (e) {}
}

function terminalToggleLogHighlight() {
  xkeenTerminalLogHighlight = !xkeenTerminalLogHighlight;
  terminalSaveOutputPrefs();
  terminalApplyOutputPrefUi();
  try { if (typeof showToast === 'function') showToast(xkeenTerminalLogHighlight ? 'Подсветка WARN/ERR: ВКЛ' : 'Подсветка WARN/ERR: ВЫКЛ', 'info'); } catch (e) {}
}

// Basic ANSI stripper (CSI + OSC). For log usage it's usually enough.
function terminalStripAnsi(text) {
  if (!text) return '';
  const s = String(text);
  // OSC (ESC ] ... BEL or ESC \\)
  const noOsc = s.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '');
  // CSI (ESC [ ... final)
  return noOsc.replace(/\x1b\[[0-9;?]*[@-~]/g, '');
}

function terminalHighlightWarnErr(text) {
  if (!text) return '';
  const s = String(text);
  const RESET = '\x1b[0m';
  const YELLOW = '\x1b[33;1m';
  const RED = '\x1b[31;1m';

  // Keep it conservative: highlight standalone level tokens.
  return s
    .replace(/\b(WARN(?:ING)?)\b/g, `${YELLOW}$1${RESET}`)
    .replace(/\b(ERR|ERROR|FATAL|CRIT(?:ICAL)?)\b/g, `${RED}$1${RESET}`);
}

function terminalProcessOutputChunk(chunk) {
  let out = String(chunk || '');
  if (!out) return out;

  if (xkeenTerminalAnsiFilter) {
    out = terminalStripAnsi(out);
  }
  if (xkeenTerminalLogHighlight) {
    out = terminalHighlightWarnErr(out);
  }
  return out;
}

// Load persisted output prefs on startup
terminalLoadOutputPrefs();
terminalLoadXtermPrefs();
terminalLoadFollowPref();

let terminalHistory = [];
let terminalHistoryIndex = -1;
const TERMINAL_HISTORY_LIMIT = 50;

// Terminal window chrome state is managed by static/js/terminal/chrome.js

// Keep a flag so toolbar buttons can know whether PTY is active
function isPtyActive() {
  return currentCommandMode === 'pty' && !!xkeenTerm;
}

// ---------------- Terminal connection status lamp + uptime ----------------
let terminalConnState = 'disconnected'; // connected|connecting|disconnected|error
let terminalUptimeStartMs = null;
let terminalUptimeTimer = null;

function terminalFormatUptime(ms) {
  const total = Math.max(0, Math.floor((ms || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${pad(m)}:${pad(s)}`;
}

function terminalUpdateUptimeUi() {
  const el = document.getElementById('terminal-uptime');
  if (!el) return;
  if (!terminalUptimeStartMs) {
    el.textContent = '00:00';
    return;
  }
  const ms = Date.now() - terminalUptimeStartMs;
  el.textContent = terminalFormatUptime(ms);
}

function terminalStopUptimeTimer() {
  if (terminalUptimeTimer) {
    try { clearInterval(terminalUptimeTimer); } catch (e) {}
    terminalUptimeTimer = null;
  }
  terminalUptimeStartMs = null;
  terminalUpdateUptimeUi();
}

function terminalStartUptimeTimer() {
  terminalUptimeStartMs = Date.now();
  terminalUpdateUptimeUi();
  if (terminalUptimeTimer) {
    try { clearInterval(terminalUptimeTimer); } catch (e) {}
  }
  terminalUptimeTimer = setInterval(terminalUpdateUptimeUi, 1000);
}

function terminalSetConnState(state, detail) {
  terminalConnState = state || 'error';

  // New lamp (preferred): uses same visuals as xkeen service lamp.
  const lamp = document.getElementById('terminal-conn-lamp');
  if (lamp) {
    const map = {
      connected: 'running',
      connecting: 'pending',
      disconnected: 'stopped',
      error: 'error',
    };
    const mapped = map[terminalConnState] || 'error';
    lamp.setAttribute('data-state', mapped);
    const stateRu = {
      connected: 'подключено',
      connecting: 'подключение...',
      disconnected: 'отключено',
      error: 'ошибка',
    };
    lamp.title = detail || ('Терминал: ' + (stateRu[terminalConnState] || terminalConnState));
  }

  // Backward compatibility: old badge if still present.
  const badge = document.getElementById('terminal-conn-badge');
  if (badge) {
    badge.setAttribute('data-state', terminalConnState);
    badge.textContent = (terminalConnState === 'connected') ? 'Подключено'
                    : (terminalConnState === 'connecting') ? 'Подключение…'
                    : (terminalConnState === 'disconnected') ? 'Отключено'
                    : 'Ошибка';
  }

  // Uptime: only for connected state
  if (terminalConnState === 'connected') {
    if (!terminalUptimeStartMs) terminalStartUptimeTimer();
  } else {
    terminalStopUptimeTimer();
  }
}

// ---------------- Terminal history (drawer + localStorage) ----------------
// moved to static/js/terminal/history.js
function loadTerminalHistory() {
  try {
    const H = (window.XKeen && XKeen.terminal && XKeen.terminal.history) ? XKeen.terminal.history : null;
    if (H && typeof H.load === 'function') return H.load();
  } catch (e) {}
}

function saveTerminalHistory() {
  try {
    const H = (window.XKeen && XKeen.terminal && XKeen.terminal.history) ? XKeen.terminal.history : null;
    if (H && typeof H.save === 'function') return H.save();
  } catch (e) {}
}

function pushTerminalHistory(cmd) {
  try {
    const H = (window.XKeen && XKeen.terminal && XKeen.terminal.history) ? XKeen.terminal.history : null;
    if (H && typeof H.push === 'function') return H.push(cmd);
  } catch (e) {}
}

function terminalHistoryIsOpen() {
  try {
    const H = (window.XKeen && XKeen.terminal && XKeen.terminal.history) ? XKeen.terminal.history : null;
    if (H && typeof H.isOpen === 'function') return H.isOpen();
  } catch (e) {}
  return false;
}

function terminalHistoryClearAll(opts = {}) {
  try {
    const H = (window.XKeen && XKeen.terminal && XKeen.terminal.history) ? XKeen.terminal.history : null;
    if (H && typeof H.clearAll === 'function') return H.clearAll(opts);
  } catch (e) {}
}

function terminalHistoryOpen() {
  try {
    const H = (window.XKeen && XKeen.terminal && XKeen.terminal.history) ? XKeen.terminal.history : null;
    if (H && typeof H.open === 'function') return H.open();
  } catch (e) {}
}

function terminalHistoryClose() {
  try {
    const H = (window.XKeen && XKeen.terminal && XKeen.terminal.history) ? XKeen.terminal.history : null;
    if (H && typeof H.close === 'function') return H.close();
  } catch (e) {}
}

function terminalHistoryInsertSelected() {
  try {
    const H = (window.XKeen && XKeen.terminal && XKeen.terminal.history) ? XKeen.terminal.history : null;
    if (H && typeof H.insertSelected === 'function') return H.insertSelected();
  } catch (e) {}
}

function terminalHistoryRunSelected() {
  try {
    const H = (window.XKeen && XKeen.terminal && XKeen.terminal.history) ? XKeen.terminal.history : null;
    if (H && typeof H.runSelected === 'function') return H.runSelected();
  } catch (e) {}
}

// PTY history capture hooks (delegated)
function ptyHistoryMarkSensitiveFromOutput(chunk) {
  try {
    const H = (window.XKeen && XKeen.terminal && XKeen.terminal.history) ? XKeen.terminal.history : null;
    if (H && typeof H.markSensitiveFromOutput === 'function') return H.markSensitiveFromOutput(chunk);
  } catch (e) {}
}

function ptyHistoryConsumeInput(data) {
  try {
    const H = (window.XKeen && XKeen.terminal && XKeen.terminal.history) ? XKeen.terminal.history : null;
    if (H && typeof H.consumePtyInput === 'function') return H.consumePtyInput(data);
  } catch (e) {}
}

/**
 * Инициализация XTerm.js для мини-терминала XKeen.
 * Если xterm.js не загружен, возвращает null и код переходит в режим <pre>.
 */
function initXkeenTerm() {
  if (typeof Terminal === 'undefined') {
    // xterm.js не загрузился (например, нет доступа к CDN) — работаем через обычный <pre>.
    return null;
  }

  const outputEl = document.getElementById('terminal-output');

  if (!outputEl) {
    return null;
  }

  if (!xkeenTerm) {
    try {
      xkeenTerm = new Terminal({
        convertEol: true,
        cursorBlink: !!xkeenTermPrefCursorBlink,
        scrollback: 2000,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
        fontSize: (xkeenTermPrefFontSize || 12),
      });

      if (typeof FitAddon !== 'undefined' && FitAddon && typeof FitAddon.FitAddon === 'function') {
        xkeenTermFitAddon = new FitAddon.FitAddon();
        xkeenTerm.loadAddon(xkeenTermFitAddon);
      }

      // XTerm Search addon: highlight all matches + stable next/prev
      if (typeof SearchAddon !== 'undefined' && SearchAddon && typeof SearchAddon.SearchAddon === 'function') {
        try {
          xkeenTermSearchAddon = new SearchAddon.SearchAddon({ highlightLimit: 2000 });
          xkeenTerm.loadAddon(xkeenTermSearchAddon);
try {
  if (window.XKeen && XKeen.terminal && XKeen.terminal._core && XKeen.terminal._core.state) {
    XKeen.terminal._core.state.searchAddon = xkeenTermSearchAddon;
    if (!XKeen.terminal._core.state.term) XKeen.terminal._core.state.term = xkeenTerm;
  }
} catch (e) {}
try {
  if (window.XKeen && XKeen.terminal && XKeen.terminal.search && typeof XKeen.terminal.search.attachTerm === 'function') {
    XKeen.terminal.search.attachTerm(xkeenTerm);
  }
} catch (e) {}

          try { if (xkeenTermSearchResultsDisposable && xkeenTermSearchResultsDisposable.dispose) xkeenTermSearchResultsDisposable.dispose(); } catch (e) {}
          try {
            xkeenTermSearchResultsDisposable = xkeenTermSearchAddon.onDidChangeResults((ev) => {
              xkeenTerminalSearchResultIndex = (ev && typeof ev.resultIndex === 'number') ? ev.resultIndex : -1;
              xkeenTerminalSearchResultCount = (ev && typeof ev.resultCount === 'number') ? ev.resultCount : 0;
              try { terminalSearchUpdateCounter(); } catch (e) {}
            });
          } catch (e) {
            xkeenTermSearchResultsDisposable = null;
          }
        } catch (e) {
          xkeenTermSearchAddon = null;
          xkeenTermSearchResultsDisposable = null;
        }
      }

      // XTerm WebLinks addon: clickable URLs
      if (typeof WebLinksAddon !== 'undefined' && WebLinksAddon && typeof WebLinksAddon.WebLinksAddon === 'function') {
        try {
          xkeenTermWebLinksAddon = new WebLinksAddon.WebLinksAddon((event, uri) => {
            try {
              const w = window.open(uri, '_blank', 'noopener,noreferrer');
              if (w) {
                try { w.opener = null; } catch (e) {}
              }
            } catch (e) {
              // ignore
            }
          }, {});
          xkeenTerm.loadAddon(xkeenTermWebLinksAddon);
        } catch (e) {
          xkeenTermWebLinksAddon = null;
        }
      }

      xkeenTerm.open(outputEl);

      // expose xterm refs to modules
      try {
        if (window.XKeen && XKeen.terminal && XKeen.terminal._core && XKeen.terminal._core.state) {
          XKeen.terminal._core.state.term = xkeenTerm;
          XKeen.terminal._core.state.xterm = xkeenTerm;
          XKeen.terminal._core.state.fitAddon = xkeenTermFitAddon;
        }
      } catch (e) {}
      try {
        if (window.XKeen && XKeen.terminal && XKeen.terminal.history && typeof XKeen.terminal.history.attachTerm === 'function') {
          XKeen.terminal.history.attachTerm(xkeenTerm);
        }
      } catch (e) {}


      // Apply persisted xterm runtime prefs (fontSize/cursorBlink)
      try { terminalApplyXtermPrefsToTerm(xkeenTerm); } catch (e) {}


      // Apply toolbar state (ANSI filter + log highlight)
      try { terminalApplyOutputPrefUi(); } catch (e) {}
      try { terminalApplyXtermPrefUi(); } catch (e) {}

if (xkeenTermFitAddon && typeof xkeenTermFitAddon.fit === 'function') {
        xkeenTermFitAddon.fit();
      }

      if (typeof ResizeObserver !== 'undefined') {
        xkeenTermResizeObserver = new ResizeObserver(() => {
          if (xkeenTermFitAddon && typeof xkeenTermFitAddon.fit === 'function') {
            xkeenTermFitAddon.fit();
          }
        });
        xkeenTermResizeObserver.observe(outputEl);
      }

      xkeenTerm.writeln('XKeen терминал готов.');
    } catch (e) {
      console.error('Не удалось инициализировать xterm.js', e);
      xkeenTerm = null;
      xkeenTermFitAddon = null;
      xkeenTermResizeObserver = null;
      xkeenTermSearchAddon = null;
      xkeenTermSearchResultsDisposable = null;
      xkeenTermWebLinksAddon = null;
      return null;
    }
  } else if (xkeenTerm && typeof xkeenTerm.clear === 'function') {
    xkeenTerm.clear();
    xkeenTerm.writeln('XKeen терминал готов.');
    try { terminalApplyOutputPrefUi(); } catch (e) {}
    try { terminalApplyXtermPrefsToTerm(xkeenTerm); } catch (e) {}
    try { terminalApplyXtermPrefUi(); } catch (e) {}
  }

  return xkeenTerm;
}

/**
 * Безопасная запись текста в терминал XKeen (без переноса строк).
 */
function xkeenTermWrite(text) {
  if (!xkeenTerm) return;
  const t = String(text || '');
  if (!t) return;
  const out = terminalProcessOutputChunk(t);
  // xterm ожидает \r\n для переноса строки
  xkeenTerm.write(out.replace(/\n/g, '\r\n'));
  terminalAutoFollow(xkeenTerm);
}

/**
 * Запись строки с переносом.
 */
function xkeenTermWriteln(text) {
  if (!xkeenTerm) return;
  const t = String(text || '');
  const out = terminalProcessOutputChunk(t);
  xkeenTerm.write(out.replace(/\n/g, '\r\n') + '\r\n');
  terminalAutoFollow(xkeenTerm);
}

// ---------------- Terminal search (xterm-addon-search) ----------------
// moved to static/js/terminal/search.js
function terminalSearchUpdateCounter() {
  try {
    const M = (window.XKeen && XKeen.terminal && XKeen.terminal.search) ? XKeen.terminal.search : null;
    if (M && typeof M.updateCounter === 'function') return M.updateCounter();
  } catch (e) {}
}

function terminalSearchClear(opts = {}) {
  try {
    const M = (window.XKeen && XKeen.terminal && XKeen.terminal.search) ? XKeen.terminal.search : null;
    if (M && typeof M.clear === 'function') return M.clear(opts);
  } catch (e) {}
}

function terminalSearchNext() {
  try {
    const M = (window.XKeen && XKeen.terminal && XKeen.terminal.search) ? XKeen.terminal.search : null;
    if (M && typeof M.next === 'function') return M.next();
  } catch (e) {}
}

function terminalSearchPrev() {
  try {
    const M = (window.XKeen && XKeen.terminal && XKeen.terminal.search) ? XKeen.terminal.search : null;
    if (M && typeof M.prev === 'function') return M.prev();
  } catch (e) {}
}

function terminalSearchFocus(selectAll = true) {
  try {
    const M = (window.XKeen && XKeen.terminal && XKeen.terminal.search) ? XKeen.terminal.search : null;
    if (M && typeof M.focus === 'function') return M.focus(selectAll);
  } catch (e) {}
}

function terminalSearchDebouncedHighlight() {
  try {
    const M = (window.XKeen && XKeen.terminal && XKeen.terminal.search) ? XKeen.terminal.search : null;
    if (M && typeof M.debouncedHighlight === 'function') return M.debouncedHighlight();
  } catch (e) {}
}

// ---------------- Terminal toolbar helpers (fullscreen delegates to terminal/chrome.js) ----------------
function terminalUpdateFullscreenBtn() {
  try {
    const C = (window.XKeen && XKeen.terminal) ? XKeen.terminal.chrome : null;
    if (C && typeof C.updateFullscreenBtn === 'function') return C.updateFullscreenBtn();
  } catch (e) {}
}

function terminalSetFullscreen(on) {
  try {
    const C = (window.XKeen && XKeen.terminal) ? XKeen.terminal.chrome : null;
    if (C && typeof C.setFullscreen === 'function') return C.setFullscreen(!!on);
  } catch (e) {}
}

function terminalToggleFullscreen() {
  try {
    const C = (window.XKeen && XKeen.terminal) ? XKeen.terminal.chrome : null;
    if (C && typeof C.toggleFullscreen === 'function') return C.toggleFullscreen();
  } catch (e) {}
}

// Font size & cursor blink controls (used by toolbar buttons in panel.html)
function terminalFontInc() {
  if (!xkeenTerm) return;
  let cur = 12;
  try {
    cur = (typeof xkeenTerm.getOption === 'function')
      ? (xkeenTerm.getOption('fontSize') || 12)
      : ((xkeenTerm.options && xkeenTerm.options.fontSize) || 12);
  } catch (e) {}
  const next = Math.min(32, cur + 1);
  try {
    if (typeof xkeenTerm.setOption === 'function') xkeenTerm.setOption('fontSize', next);
    else if (xkeenTerm.options) xkeenTerm.options.fontSize = next;
  } catch (e) {}
  // Persist xterm prefs
  xkeenTermPrefFontSize = next;
  terminalSaveXtermPrefs();
  try { terminalApplyXtermPrefUi(); } catch (e) {}
  try { if (xkeenTermFitAddon && xkeenTermFitAddon.fit) xkeenTermFitAddon.fit(); } catch (e) {}
}

function terminalFontDec() {
  if (!xkeenTerm) return;
  let cur = 12;
  try {
    cur = (typeof xkeenTerm.getOption === 'function')
      ? (xkeenTerm.getOption('fontSize') || 12)
      : ((xkeenTerm.options && xkeenTerm.options.fontSize) || 12);
  } catch (e) {}
  const next = Math.max(8, cur - 1);
  try {
    if (typeof xkeenTerm.setOption === 'function') xkeenTerm.setOption('fontSize', next);
    else if (xkeenTerm.options) xkeenTerm.options.fontSize = next;
  } catch (e) {}
  // Persist xterm prefs
  xkeenTermPrefFontSize = next;
  terminalSaveXtermPrefs();
  try { terminalApplyXtermPrefUi(); } catch (e) {}
  try { if (xkeenTermFitAddon && xkeenTermFitAddon.fit) xkeenTermFitAddon.fit(); } catch (e) {}
}

function terminalToggleCursorBlink() {
  if (!xkeenTerm) return;
  let cur = false;
  try {
    cur = (typeof xkeenTerm.getOption === 'function')
      ? !!xkeenTerm.getOption('cursorBlink')
      : !!(xkeenTerm.options && xkeenTerm.options.cursorBlink);
  } catch (e) {}
  const next = !cur;
  try {
    if (typeof xkeenTerm.setOption === 'function') xkeenTerm.setOption('cursorBlink', next);
    else if (xkeenTerm.options) xkeenTerm.options.cursorBlink = next;
  } catch (e) {}
  // Persist xterm prefs
  xkeenTermPrefCursorBlink = next;
  terminalSaveXtermPrefs();
  try { terminalApplyXtermPrefUi(); } catch (e) {}
}


function xkeenPtyDisconnect(opts = {}) {
  const sendClose = (opts.sendClose !== false);
  if (sendClose) {
    // Explicit close: terminate remote PTY session and forget session_id
    try { ptyClearSessionState(); } catch (e) {}
  }
  if (ptyWs) {
    try { if (sendClose) ptyWs.send(JSON.stringify({ type: 'close' })); } catch (e) {}
    try { ptyWs.__xkeen_manual_close = true; } catch (e) {}
    try { ptyWs.close(); } catch (e) {}
    ptyWs = null;
  }
  try { ptyDisposables.forEach(d => d && d.dispose && d.dispose()); } catch (e) {}
  ptyDisposables = [];
}

async function xkeenPtyConnect(term, opts = {}) {
  if (!term) return;
  const preserveScreen = !!opts.preserveScreen;

  try { ptyHistoryResetLine(); ptyHistSensitive = false; } catch (e) {}

  // reset old connection/listeners
  xkeenPtyDisconnect({ sendClose: false });

  if (!preserveScreen) {
    try { if (typeof term.clear === 'function') term.clear(); } catch (e) {}
  }
  xkeenTermWriteln('[PTY] Подключение...');
  try { terminalSetConnState('connecting', 'PTY: подключение...'); } catch (e) {}

  // token
  let token = '';
  try {
    const r = await fetch('/api/ws-token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const j = await r.json();
    if (!r.ok || !j || !j.ok) {
      throw new Error((j && j.error) ? j.error : ('HTTP ' + r.status));
    }
    token = j.token || '';
  } catch (e) {
    xkeenTermWriteln('[PTY] Ошибка получения токена: ' + (e && e.message ? e.message : String(e)));
    try { terminalSetConnState('error', 'PTY: ошибка токена'); } catch (e2) {}
    try { terminalScheduleRetry('token'); } catch (e3) {}
    return;
  }

const proto = (location.protocol === 'https:') ? 'wss:' : 'ws:';

// session_id + last_seq enable true reconnect to the same PTY (server keeps PTY by session_id)
const qs = new URLSearchParams();
qs.set('token', token);
try {
  // Always send current terminal size so server can set PTY winsize early
  qs.set('cols', String(term && term.cols ? term.cols : 0));
  qs.set('rows', String(term && term.rows ? term.rows : 0));
} catch (e) {}

// If we already have a session_id (same tab) — ask server to reattach to it
if (ptySessionId) qs.set('session_id', String(ptySessionId));

// If we preserve screen, request only missed output; otherwise request buffered output from the beginning (best effort)
const resumeFrom = preserveScreen ? (ptyLastSeq || 0) : 0;
qs.set('last_seq', String(resumeFrom));

const url = `${proto}//${location.host}/ws/pty?${qs.toString()}`;

  try {
    ptyWs = new WebSocket(url);
  } catch (e) {
    ptyWs = null;
    xkeenTermWriteln('[PTY] WebSocket недоступен: ' + (e && e.message ? e.message : String(e)));
    try { terminalSetConnState('error', 'PTY: WebSocket недоступен'); } catch (e2) {}
    try { terminalScheduleRetry('ws ctor'); } catch (e3) {}
    return;
  }

  const sendResize = () => {
    try {
      if (!ptyWs || ptyWs.readyState !== WebSocket.OPEN) return;
      ptyWs.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    } catch (e) {}
  };

  ptyWs.onopen = () => {
    try { terminalResetRetry(); } catch (e) {}
    xkeenTermWriteln('[PTY] Соединение установлено.');
    try { terminalSetConnState('connected', 'PTY: подключено'); } catch (e) {}
    try { if (xkeenTermFitAddon && xkeenTermFitAddon.fit) xkeenTermFitAddon.fit(); } catch (e) {}
    sendResize();
  };

  ptyWs.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (!msg) return;

    if (msg.type === 'output' && typeof msg.data === 'string') {
      // PTY output must be passed through without log/ANSI post-processing by default
      try { ptyHistoryMarkSensitiveFromOutput(msg.data); } catch (e) {}
      term.write(msg.data);
      terminalAutoFollow(term);
      // track last seen sequence number (for lossless reconnect)
      try {
        if (msg.seq != null) {
          const s = parseInt(msg.seq, 10);
          if (!isNaN(s) && s > (ptyLastSeq || 0)) {
            ptyLastSeq = s;
            ptySaveSessionState();
          }
        }
      } catch (e) {}
    } else if (msg.type === 'init') {
      // server returns session_id (store for reconnect)
      try {
        if (msg.session_id) {
          ptySessionId = String(msg.session_id);
          ptySaveSessionState();
        }
      } catch (e) {}
      if (msg.shell) xkeenTermWriteln('[PTY] Shell: ' + msg.shell);
      if (msg.reused) xkeenTermWriteln('[PTY] Reattached to existing session.');
    } else if (msg.type === 'exit') {
      try { terminalStopRetry({ silent: true }); } catch (e) {}
      xkeenTermWriteln('\r\n[PTY] Завершено (code=' + msg.code + ').');
      try { terminalSetConnState('disconnected', 'PTY: shell завершился'); } catch (e) {}
      // session ended server-side
      try { ptyClearSessionState(); } catch (e) {}
    } else if (msg.type === 'error') {
      xkeenTermWriteln('[PTY] Ошибка: ' + (msg.message || 'unknown'));
      try { terminalSetConnState('error', 'PTY: ошибка'); } catch (e) {}
    }
  };


  ptyWs.onerror = (ev) => {
    // Network/proxy glitches are common; schedule backoff retry.
    try { terminalSetConnState('error', 'PTY: websocket error'); } catch (e) {}
    try { xkeenTermWriteln('\r\n[PTY] Ошибка WebSocket.'); } catch (e) {}
    try { terminalScheduleRetry('onerror'); } catch (e) {}
  };
  ptyWs.onclose = (ev) => {
    // If we closed it ourselves (during manual reconnect / closing overlay), do nothing.
    try { if (ev && ev.target && ev.target.__xkeen_manual_close) return; } catch (e) {}
    xkeenTermWriteln('\r\n[PTY] Соединение закрыто.');
    try { terminalSetConnState('disconnected', 'PTY: соединение закрыто'); } catch (e) {}
    try { terminalScheduleRetry('onclose'); } catch (e) {}
  };

  // User input
  try {
    ptyDisposables.push(term.onData((data) => {
      try { ptyHistoryConsumeInput(data); } catch (e) {}
      if (ptyWs && ptyWs.readyState === WebSocket.OPEN) {
        ptyWs.send(JSON.stringify({ type: 'input', data }));
      }
    }));
  } catch (e) {}

  // Resize events
  try {
    ptyDisposables.push(term.onResize(() => {
      sendResize();
    }));
  } catch (e) {}
}

function terminalSendRaw(data) {
  if (ptyWs && ptyWs.readyState === WebSocket.OPEN) {
    try { ptyWs.send(JSON.stringify({ type: 'input', data: String(data || '') })); } catch (e) {}
  }
}

function terminalSendCtrlC() { terminalSendRaw('\x03'); try { xkeenTerm && xkeenTerm.focus && xkeenTerm.focus(); } catch (e) {} }
function terminalSendCtrlD() { terminalSendRaw('\x04'); try { xkeenTerm && xkeenTerm.focus && xkeenTerm.focus(); } catch (e) {} }

async function terminalCopy() {
  // Prefer xterm selection; fallback to visible viewport; fallback to <pre> text.
  let text = '';
  try {
    if (xkeenTerm && typeof xkeenTerm.getSelection === 'function') {
      text = xkeenTerm.getSelection() || '';
    }
  } catch (e) {}

  if (!text && xkeenTerm && xkeenTerm.buffer && xkeenTerm.buffer.active) {
    try {
      const buf = xkeenTerm.buffer.active;
      const start = (typeof buf.viewportY === 'number') ? buf.viewportY : (typeof buf.baseY === 'number' ? buf.baseY : 0);
      const end = start + (xkeenTerm.rows || 0);
      const lines = [];
      for (let i = start; i < end; i++) {
        const line = buf.getLine(i);
        if (!line) continue;
        lines.push(line.translateToString(true));
      }
      text = lines.join('\n');
    } catch (e) {}
  }

  if (!text) {
    const pre = document.getElementById('terminal-output');
    if (pre) text = pre.innerText || pre.textContent || '';
  }

  text = String(text || '');
  if (!text.trim()) {
    try { showToast('Нечего копировать', 'info'); } catch (e) {}
    return;
  }

  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      try { showToast('Скопировано в буфер', 'success'); } catch (e) {}
      return;
    }
  } catch (e) {
    // fall through
  }

  // Fallback for older browsers
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    try { showToast('Скопировано в буфер', 'success'); } catch (e) {}
  } catch (e) {
    try { showToast('Не удалось скопировать', 'error'); } catch (e2) {}
  }
}

function terminalGetAllBufferText() {
  // Read full xterm buffer: from line 0 to baseY + rows (includes scrollback + viewport).
  // Fallback to <pre> content if xterm is not available.
  try {
    if (xkeenTerm && xkeenTerm.buffer && xkeenTerm.buffer.active) {
      const buf = xkeenTerm.buffer.active;
      const rows = (xkeenTerm.rows || 0);
      let end = 0;
      if (typeof buf.baseY === 'number') end = buf.baseY + rows;
      else if (typeof buf.length === 'number') end = buf.length;
      if (typeof buf.length === 'number') end = Math.min(Math.max(end, 0), buf.length);
      if (!end && typeof buf.length === 'number') end = buf.length;

      const lines = [];
      for (let i = 0; i < end; i++) {
        const line = buf.getLine(i);
        if (!line) { lines.push(''); continue; }
        lines.push(line.translateToString(true));
      }
      return lines.join('\n');
    }
  } catch (e) {}

  const pre = document.getElementById('terminal-output');
  return pre ? (pre.innerText || pre.textContent || '') : '';
}

async function terminalCopyAll() {
  const text = String(terminalGetAllBufferText() || '');
  if (!text.trim()) {
    try { showToast('Нечего копировать', 'info'); } catch (e) {}
    return;
  }

  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      try { showToast('Скопировано: весь буфер', 'success'); } catch (e) {}
      return;
    }
  } catch (e) {
    // fall through
  }

  // Fallback for older browsers
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    try { showToast('Скопировано: весь буфер', 'success'); } catch (e) {}
  } catch (e) {
    try { showToast('Не удалось скопировать', 'error'); } catch (e2) {}
  }
}

function terminalDownloadOutput() {
  const text = String(terminalGetAllBufferText() || '');
  if (!text.trim()) {
    try { showToast('Нечего скачивать', 'info'); } catch (e) {}
    return;
  }

  try {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const iso = new Date().toISOString().replace(/[:.]/g, '-');
    a.href = url;
    a.download = `xkeen-terminal-${iso}.txt`;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    try { URL.revokeObjectURL(url); } catch (e) {}
    try { showToast('Скачивание начато', 'success'); } catch (e) {}
  } catch (e) {
    try { showToast('Не удалось скачать .txt', 'error'); } catch (e2) {}
  }
}

async function terminalPaste() {
  try {
    if (navigator.clipboard && navigator.clipboard.readText) {
      const text = await navigator.clipboard.readText();
      if (!text) return;
      // PTY: paste into terminal (preferred)
      if (ptyWs && ptyWs.readyState === WebSocket.OPEN) {
        terminalSendRaw(text);
        try { xkeenTerm && xkeenTerm.focus && xkeenTerm.focus(); } catch (e) {}
        return;
      }

      // Non-PTY fallback: paste into command/confirm inputs (useful on mobile)
      const cmdEl = document.getElementById('terminal-command');
      const inputEl = document.getElementById('terminal-input');
      const active = document.activeElement;
      const target = (active && (active === cmdEl || active === inputEl)) ? active : (cmdEl && cmdEl.style.display !== 'none' ? cmdEl : inputEl);
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
        try {
          const start = target.selectionStart ?? target.value.length;
          const end = target.selectionEnd ?? target.value.length;
          const before = target.value.slice(0, start);
          const after = target.value.slice(end);
          target.value = before + text + after;
          const pos = start + text.length;
          target.selectionStart = target.selectionEnd = pos;
          target.focus();
          return;
        } catch (e) {
          // ignore
        }
      }

      // Last resort: show toast
      try { showToast('Нет активной сессии PTY — вставка в терминал недоступна', 'info'); } catch (e) {}
      return;
    }
  } catch (e) {
    // fall through
  }
  try { showToast('Вставка из буфера недоступна в этом браузере', 'info'); } catch (e) {}
}

function terminalClear() {
  // Clear screen without breaking the PTY session.
  try { if (xkeenTerm && typeof xkeenTerm.clear === 'function') xkeenTerm.clear(); } catch (e) {}
  try {
    const pre = document.getElementById('terminal-output');
    if (!xkeenTerm && pre) pre.textContent = '';
  } catch (e) {}

  // Ask the remote shell to clear too (keeps session alive).
  // "clear" is more explicit than Ctrl+L and works in busybox/ash and most shells.
  if (ptyWs && ptyWs.readyState === WebSocket.OPEN) {
    terminalSendRaw('clear\r');
  }
}

function terminalReconnect() {
  if (currentCommandMode !== 'pty') {
    openTerminal('', 'pty');
    return;
  }
  if (!xkeenTerm) return;
  xkeenTermWriteln('\r\n[PTY] Reconnect...');
  try { terminalResetRetry({ unblock: true }); } catch (e) {}
  xkeenPtyConnect(xkeenTerm, { preserveScreen: true });
}

function terminalNewSession() {
  // Open a new browser tab and auto-open PTY terminal there.
  try {
    const url = new URL(window.location.href);
    url.searchParams.set('terminal', 'pty');
    window.open(url.toString(), '_blank');
  } catch (e) {
    // fallback: same tab
    openTerminal('', 'pty');
  }
}



// (moved) Xray live logs state + helpers live in static/js/features/xray_logs.js

function openTerminal(initialCommand, mode = 'shell') {
  const overlay = document.getElementById('terminal-overlay');
  const cmdEl = document.getElementById('terminal-command');
  const inputEl = document.getElementById('terminal-input');
  const outputEl = document.getElementById('terminal-output');


// Restore minimized PTY window without reconnecting / detaching.
// This keeps the WS alive (Minimize != Detach).
try {
  if (mode === 'pty' && overlay && overlay.style.display === 'none' &&
      currentCommandMode === 'pty' && ptyWs && ptyWs.readyState === WebSocket.OPEN && xkeenTerm) {
    overlay.style.display = 'flex';
    try { xkeenSyncBodyScrollLock(); } catch (e) {}
    try { terminalApplyModeUi(); } catch (e) {}
    try { xkeenTerminalUiOnOpen(); } catch (e) {}
    try { if (xkeenTermFitAddon && xkeenTermFitAddon.fit) xkeenTermFitAddon.fit(); } catch (e) {}
    try { terminalApplyFollowUi(); } catch (e) {}
    try { terminalAutoFollow(xkeenTerm); } catch (e) {}
    try { xkeenTerm.focus && xkeenTerm.focus(); } catch (e) {}
    return;
  }
} catch (e) {}

  currentCommandMode = mode;

  if (mode === 'xkeen') {
    const m = (initialCommand || '').match(/^xkeen\s+(.+)$/);
    currentCommandFlag = m ? m[1].trim() : null;
    currentCommandLabel = initialCommand || (currentCommandFlag ? ('xkeen ' + currentCommandFlag) : 'xkeen');
  } else {
    currentCommandFlag = null;
    currentCommandLabel = null;
  }

  if (cmdEl) {
    cmdEl.value = initialCommand || '';
    try {
      cmdEl.focus();
      cmdEl.select();
    } catch (e) {
      // ignore
    }
  }

  if (inputEl) {
    inputEl.value = '';
  }


  // In lite terminal hide confirm input until it is actually needed.
  try { terminalResetConfirmUi(); } catch (e) {}
  // Инициализируем xterm.js (если загружен); иначе останется старый <pre>-режим.
  const term = initXkeenTerm();
  if (!term && outputEl) {
    // Фоллбек: просто очищаем вывод.
    outputEl.textContent = '';
  }

  
  // PTY mode: полноценный интерактивный shell через WebSocket (/ws/pty)
  if (mode === 'pty') {
    // Скрываем поля "команда" и "подтверждение"
    if (cmdEl) cmdEl.style.display = 'none';
    const inputRow = document.querySelector('.terminal-input-row');
    if (inputRow) inputRow.style.display = 'none';

    // Требуется xterm.js
    if (!term) {
      if (outputEl) outputEl.textContent = 'xterm.js недоступен — PTY режим невозможен.';
    } else {
      // Переводим xterm в "сырое" отображение (для escape-seq)
      try {
        if (ptyPrevConvertEol === null && typeof term.getOption === 'function') {
          ptyPrevConvertEol = term.getOption('convertEol');
        }
        if (typeof term.setOption === 'function') {
          term.setOption('convertEol', false);
        }
      } catch (e) {}

	      // Connect (or reconnect) PTY using shared helper
	      terminalUpdateFullscreenBtn();
	      try { terminalResetRetry({ unblock: true }); } catch (e) {}
	      xkeenPtyConnect(term, { preserveScreen: false });
    }
  } else {
    // не PTY: показываем стандартные поля
    try { terminalSetConnState('disconnected', 'Terminal: не в PTY режиме'); } catch (e) {}
    if (cmdEl) cmdEl.style.display = '';
    const inputRow = document.querySelector('.terminal-input-row');
    if (inputRow) inputRow.style.display = '';
  }

  // Toggle chrome for PTY vs "урезанного" терминала.
  try { terminalApplyModeUi(); } catch (e) {}

if (overlay) {
    overlay.style.display = 'flex';
    try { xkeenSyncBodyScrollLock(); } catch (e) {}
  }

  // Restore terminal window geometry (size/position)
  try {
    xkeenTerminalUiOnOpen();
  } catch (e) { /* ignore */ }

  // Если есть предварительная команда (например, клик по "Команды"),
  // покажем её в терминале как подсказку.
  if (term && initialCommand) {
    xkeenTermWriteln('$ ' + initialCommand);
  }
}

function openTerminalForFlag(flag, label) {
  if (!flag) return;
  const initial = label || ('xkeen ' + flag);
  openTerminal(initial, 'xkeen');
}

function terminalMinimize() {
  // Hide the overlay WITHOUT detaching or closing the WebSocket.
  try {
    const C = (window.XKeen && XKeen.terminal) ? XKeen.terminal.chrome : null;
    if (C && typeof C.minimize === 'function') return C.minimize();
  } catch (e) {}

  // Fallback if chrome module isn't available.
  const overlay = document.getElementById('terminal-overlay');
  if (overlay) overlay.style.display = 'none';
  try { xkeenSyncBodyScrollLock(); } catch (e) {}
  try { terminalHideSignalsMenu(); } catch (e) {}
}

function hideTerminal() {
  const overlay = document.getElementById('terminal-overlay');
  if (overlay) overlay.style.display = 'none';
  try { xkeenSyncBodyScrollLock(); } catch (e) {}

  // Clear search highlights/state
  try { terminalSearchClear({ silent: true }); } catch (e) {}

  // Exit fullscreen if it was enabled
  try { terminalSetFullscreen(false); } catch (e) {}

  // cleanup PTY session if active
  try { terminalStopRetry({ silent: true }); } catch (e) {}
  xkeenPtyDisconnect({ sendClose: true });
  try { terminalSetConnState('disconnected', 'PTY: отключено'); } catch (e) {}

  // restore xterm option
  try {
    if (xkeenTerm && ptyPrevConvertEol !== null && typeof xkeenTerm.setOption === 'function') {
      xkeenTerm.setOption('convertEol', ptyPrevConvertEol);
    }
  } catch (e) {}
  ptyPrevConvertEol = null;

  // restore inputs visibility
  const cmdEl = document.getElementById('terminal-command');
  if (cmdEl) cmdEl.style.display = '';
  const inputRow = document.querySelector('.terminal-input-row');
  if (inputRow) inputRow.style.display = '';


  // Always reset confirm input state on close.
  try { terminalSetConfirmVisible(false, { clear: true }); } catch (e) {}

  currentCommandFlag = null;
  currentCommandLabel = null;
  currentCommandMode = 'shell';

  // Reset chrome to "урезанный" state for next open (PTY-only elements hidden).
  try { terminalApplyModeUi(); } catch (e) {}
}

// ---------------- PTY helpers: Detach / Kill / Signals / Retry now ----------------
function terminalDetach() {
  // Close overlay, but keep PTY session alive on the server (detach)
  const overlay = document.getElementById('terminal-overlay');
  if (overlay) overlay.style.display = 'none';
  try { xkeenSyncBodyScrollLock(); } catch (e) {}

  try { terminalHideSignalsMenu(); } catch (e) {}
  try { terminalSearchClear({ silent: true }); } catch (e) {}
  try { terminalSetFullscreen(false); } catch (e) {}
  try { terminalStopRetry({ silent: true }); } catch (e) {}

  // Disconnect WS without sending {type:"close"} so session_id remains valid
  try { xkeenPtyDisconnect({ sendClose: false }); } catch (e) {}
  try { terminalSetConnState('disconnected', 'PTY: detached'); } catch (e) {}

  // Restore xterm option so "lite" terminal won't be broken if user opens it later
  try {
    if (xkeenTerm && ptyPrevConvertEol !== null && typeof xkeenTerm.setOption === 'function') {
      xkeenTerm.setOption('convertEol', ptyPrevConvertEol);
    }
  } catch (e) {}
  ptyPrevConvertEol = null;

  // Restore inputs visibility for next open (mode will re-hide as needed)
  const cmdEl = document.getElementById('terminal-command');
  if (cmdEl) cmdEl.style.display = '';
  const inputRow = document.querySelector('.terminal-input-row');
  if (inputRow) inputRow.style.display = '';

  // Always reset confirm input state on close/detach.
  try { terminalSetConfirmVisible(false, { clear: true }); } catch (e) {}

  // Reset chrome for next open
  currentCommandFlag = null;
  currentCommandLabel = null;
  currentCommandMode = 'shell';
  try { terminalApplyModeUi(); } catch (e) {}
}

function terminalKillSession() {
  if (currentCommandMode !== 'pty') return;
  try { terminalHideSignalsMenu(); } catch (e) {}
  try { terminalStopRetry({ silent: true }); } catch (e) {}
  try { xkeenTermWriteln('\r\n[PTY] Killing session...'); } catch (e) {}
  try { xkeenPtyDisconnect({ sendClose: true }); } catch (e) {}
  try { terminalSetConnState('disconnected', 'PTY: killed'); } catch (e) {}
}

function terminalToggleSignalsMenu(ev) {
  if (ev && ev.stopPropagation) ev.stopPropagation();
  const m = document.getElementById('terminal-signals-menu');
  if (!m) return;
  m.classList.toggle('hidden');
}

function terminalHideSignalsMenu() {
  const m = document.getElementById('terminal-signals-menu');
  if (!m) return;
  m.classList.add('hidden');
}

function terminalSendSignal(name) {
  terminalHideSignalsMenu();
  if (!ptyWs || ptyWs.readyState !== WebSocket.OPEN) {
    try { showToast('PTY не подключён', 'info'); } catch (e) {}
    return;
  }
  try {
    ptyWs.send(JSON.stringify({ type: 'signal', name: String(name || '').toUpperCase() }));
    try { xkeenTerm && xkeenTerm.focus && xkeenTerm.focus(); } catch (e) {}
  } catch (e) {}
}

let terminalSignalsMenuInited = false;
function terminalInitSignalsMenuAutoClose() {
  if (terminalSignalsMenuInited) return;
  terminalSignalsMenuInited = true;

  document.addEventListener('click', () => terminalHideSignalsMenu(), true);
  document.addEventListener('keydown', (e) => {
    if (e && e.key === 'Escape') terminalHideSignalsMenu();
  }, true);
}
terminalInitSignalsMenuAutoClose();

// Quick Commands menu moved to terminal/quick_commands.js


function terminalRetryNow() {
  // If not in PTY mode, just open PTY terminal
  if (currentCommandMode !== 'pty') {
    try { openTerminal('', 'pty'); } catch (e) {}
    return;
  }
  if (!xkeenTerm) return;

  // Unblock retries and connect immediately
  try { terminalResetRetry({ unblock: true }); } catch (e) {}
  try { terminalClearRetryTimer(); } catch (e) {}
  try { xkeenTermWriteln('\r\n[PTY] Retry now...'); } catch (e) {}
  xkeenPtyConnect(xkeenTerm, { preserveScreen: true });
}


// ---------------- PTY helper: SSH profiles (client-side only) ----------------
const XKEEN_SSH_PROFILES_KEY = 'xkeen_ssh_profiles_v1';
let sshSelectedIndex = -1;
let sshEditState = null;      // { mode: 'add'|'edit', idx: number, original: object }
let sshConfirmState = null;   // { onOk: function }

function sshLoadProfiles() {
  try {
    const s = localStorage.getItem(XKEEN_SSH_PROFILES_KEY);
    const j = s ? JSON.parse(s) : [];
    return Array.isArray(j) ? j : [];
  } catch (e) { return []; }
}

function sshSaveProfiles(list) {
  try { localStorage.setItem(XKEEN_SSH_PROFILES_KEY, JSON.stringify(list || [])); } catch (e) {}
}

function sshBuildCmd(p) {
  const host = (p.host || '').trim();
  const user = (p.user || '').trim();
  const port = String(p.port || '').trim();
  const key  = (p.key || '').trim();
  const jump = (p.jump || '').trim();

  if (!host) return '';
  const target = user ? `${user}@${host}` : host;

  let cmd = `ssh ${target}`;
  if (port) cmd += ` -p ${port}`;
  if (key)  cmd += ` -i ${key}`;
  if (jump) cmd += ` -J ${jump}`;
  return cmd;
}

function sshOpenModal() {
  const m = document.getElementById('ssh-modal');
  if (!m) return;
  m.classList.remove('hidden');
  document.body.classList.add('modal-open');
  sshRenderProfiles();
}

function sshCloseModal() {
  const m = document.getElementById('ssh-modal');
  if (!m) return;
  m.classList.add('hidden');
  document.body.classList.remove('modal-open');
}

function sshRenderProfiles() {
  const listEl = document.getElementById('ssh-profiles-list');
  const preview = document.getElementById('ssh-command-preview');
  const delBtn = document.getElementById('ssh-delete-selected-btn');
  if (!listEl) return;

  const profiles = sshLoadProfiles();
  if (sshSelectedIndex >= profiles.length) sshSelectedIndex = profiles.length - 1;
  if (sshSelectedIndex < 0 && profiles.length) sshSelectedIndex = 0;
  listEl.innerHTML = '';

  if (!profiles.length) {
    const empty = document.createElement('div');
    empty.style.opacity = '.8';
    empty.textContent = 'Профилей нет. Нажми “Добавить”.';
    listEl.appendChild(empty);
  }

  profiles.forEach((p, idx) => {
    const row = document.createElement('div');
    row.className = 'github-config-row';
    row.style.alignItems = 'stretch';
    if (idx === sshSelectedIndex) row.classList.add('is-selected');
    row.onclick = (ev) => {
      // Don't steal clicks from buttons.
      const t = ev && ev.target ? ev.target : null;
      if (t && (t.tagName === 'BUTTON' || t.closest('button'))) return;
      sshSelectProfile(idx);
    };

    const left = document.createElement('div');
    left.style.display = 'flex';
    left.style.flexDirection = 'column';
    left.style.gap = '4px';

    const title = document.createElement('div');
    title.style.fontWeight = '700';
    title.textContent = p.name || `${p.user || ''}@${p.host || ''}`.replace(/^@/, '');
    left.appendChild(title);

    const meta = document.createElement('div');
    meta.style.opacity = '.8';
    meta.style.fontSize = '12px';
    meta.textContent = sshBuildCmd(p);
    left.appendChild(meta);

    const right = document.createElement('div');
    right.style.display = 'flex';
    right.style.gap = '6px';
    right.style.alignItems = 'center';

    const btnUse = document.createElement('button');
    btnUse.type = 'button';
    btnUse.textContent = 'Use';
    btnUse.onclick = () => {
      sshSelectProfile(idx);
    };

    const btnEdit = document.createElement('button');
    btnEdit.type = 'button';
    btnEdit.textContent = 'Edit';
    btnEdit.onclick = () => sshEditOpen('edit', idx);

    const btnDel = document.createElement('button');
    btnDel.type = 'button';
    btnDel.textContent = 'Del';
    btnDel.onclick = () => sshDeleteProfile(idx);

    right.appendChild(btnUse);
    right.appendChild(btnEdit);
    right.appendChild(btnDel);

    row.appendChild(left);
    row.appendChild(right);
    listEl.appendChild(row);
  });

  if (delBtn) delBtn.disabled = !(profiles.length && sshSelectedIndex >= 0);
  if (preview) {
    const sel = profiles[sshSelectedIndex];
    preview.value = sel ? sshBuildCmd(sel) : '';
  }
}

function sshAddProfile() {
  sshEditOpen('add', -1);
}

function sshSelectProfile(idx) {
  const profiles = sshLoadProfiles();
  if (!profiles.length) {
    sshSelectedIndex = -1;
    sshRenderProfiles();
    return;
  }
  const clamped = Math.max(0, Math.min(idx, profiles.length - 1));
  sshSelectedIndex = clamped;
  const preview = document.getElementById('ssh-command-preview');
  if (preview) preview.value = sshBuildCmd(profiles[sshSelectedIndex]);
  sshRenderProfiles();
}

function sshEditOpen(mode, idx) {
  const modal = document.getElementById('ssh-edit-modal');
  if (!modal) return;

  const profiles = sshLoadProfiles();
  const original = (mode === 'edit' && profiles[idx]) ? profiles[idx] : { name:'', host:'', user:'', port:'22', key:'', jump:'' };

  sshEditState = { mode, idx, original: JSON.parse(JSON.stringify(original)) };

  const title = document.getElementById('ssh-edit-title');
  if (title) title.textContent = (mode === 'add') ? 'Добавить SSH профиль' : 'Редактировать SSH профиль';

  const del = document.getElementById('ssh-edit-delete-btn');
  if (del) del.style.display = (mode === 'edit') ? '' : 'none';

  const err = document.getElementById('ssh-edit-error');
  if (err) err.textContent = '';

  // Fill form
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = (v ?? ''); };
  set('ssh-edit-name', original.name || '');
  set('ssh-edit-host', original.host || '');
  set('ssh-edit-user', original.user || '');
  set('ssh-edit-port', String(original.port || '22'));
  set('ssh-edit-key',  original.key  || '');
  set('ssh-edit-jump', original.jump || '');

  modal.classList.remove('hidden');
  document.body.classList.add('modal-open');
  // Focus first meaningful input
  try { const host = document.getElementById('ssh-edit-host'); host && host.focus && host.focus(); } catch (e) {}
}

function sshEditClose() {
  const modal = document.getElementById('ssh-edit-modal');
  if (!modal) return;
  modal.classList.add('hidden');
  sshEditState = null;
  // Keep parent modal open; do not remove modal-open if ssh modal is still visible
  const parent = document.getElementById('ssh-modal');
  const sshVisible = parent && !parent.classList.contains('hidden');
  if (!sshVisible) document.body.classList.remove('modal-open');
}

function sshEditGetDraft() {
  const get = (id) => {
    const el = document.getElementById(id);
    return el ? String(el.value || '') : '';
  };
  return {
    name: get('ssh-edit-name').trim(),
    host: get('ssh-edit-host').trim(),
    user: get('ssh-edit-user').trim(),
    port: get('ssh-edit-port').trim(),
    key:  get('ssh-edit-key').trim(),
    jump: get('ssh-edit-jump').trim(),
  };
}

function sshEditValidate(d) {
  if (!d.host) return { ok: false, error: 'Поле Host обязательно.' };
  // Port validation (optional, but must be numeric and in range)
  const portStr = d.port || '22';
  if (portStr) {
    const portNum = Number(portStr);
    if (!Number.isFinite(portNum) || !/^[0-9]+$/.test(portStr) || portNum < 1 || portNum > 65535) {
      return { ok: false, error: 'Port должен быть числом от 1 до 65535.' };
    }
  }
  // Normalize
  const cleaned = {
    name: d.name,
    host: d.host,
    user: d.user,
    port: portStr || '22',
    key: d.key,
    jump: d.jump,
  };
  return { ok: true, cleaned };
}

function sshEditSave() {
  if (!sshEditState) return;
  const err = document.getElementById('ssh-edit-error');

  const draft = sshEditGetDraft();
  const v = sshEditValidate(draft);
  if (!v.ok) {
    if (err) err.textContent = v.error || 'Проверь данные профиля.';
    return;
  }

  const profiles = sshLoadProfiles();
  if (sshEditState.mode === 'add') {
    profiles.unshift(v.cleaned);
    sshSaveProfiles(profiles);
    sshSelectedIndex = 0;
  } else {
    const idx = sshEditState.idx;
    if (idx >= 0 && idx < profiles.length) {
      profiles[idx] = v.cleaned;
      sshSaveProfiles(profiles);
      sshSelectedIndex = idx;
    }
  }

  sshEditClose();
  sshRenderProfiles();
}

function sshDeleteSelectedProfile() {
  if (sshSelectedIndex < 0) return;
  sshDeleteProfile(sshSelectedIndex);
}

function sshDeleteProfileNow(idx) {
  const profiles2 = sshLoadProfiles();
  if (idx < 0 || idx >= profiles2.length) return;
  profiles2.splice(idx, 1);
  sshSaveProfiles(profiles2);
  if (sshSelectedIndex === idx) sshSelectedIndex = Math.min(idx, profiles2.length - 1);
  if (sshSelectedIndex > idx) sshSelectedIndex -= 1;
  sshRenderProfiles();
}

function sshDeleteProfile(idx) {
  const profiles = sshLoadProfiles();
  const p = profiles[idx];
  if (!p) return;
  const name = p.name || `${p.user || ''}@${p.host || ''}`.replace(/^@/, '');
  sshConfirmOpen(`Удалить профиль “${name}”?`, () => {
    sshDeleteProfileNow(idx);
  });
}

function sshEditDelete() {
  if (!sshEditState || sshEditState.mode !== 'edit') return;
  const idx = sshEditState.idx;
  sshConfirmOpen('Удалить этот профиль?', () => {
    sshEditClose();
    sshDeleteProfileNow(idx);
  });
}

function sshConfirmOpen(text, onOk) {
  const modal = document.getElementById('ssh-confirm-modal');
  const txt = document.getElementById('ssh-confirm-text');
  const ok = document.getElementById('ssh-confirm-ok');
  if (!modal || !txt || !ok) {
    // Fallback without ugly browser dialogs: just do nothing
    return;
  }
  sshConfirmState = { onOk };
  txt.textContent = String(text || '');
  ok.onclick = () => {
    const fn = sshConfirmState && sshConfirmState.onOk;
    sshConfirmClose();
    try { fn && fn(); } catch (e) {}
  };
  modal.classList.remove('hidden');
  document.body.classList.add('modal-open');
}

function sshConfirmClose() {
  const modal = document.getElementById('ssh-confirm-modal');
  if (!modal) return;
  modal.classList.add('hidden');
  sshConfirmState = null;
  // Keep modal-open if parent SSH modal or editor is visible
  const sshVisible = (document.getElementById('ssh-modal') && !document.getElementById('ssh-modal').classList.contains('hidden'));
  const editorVisible = (document.getElementById('ssh-edit-modal') && !document.getElementById('ssh-edit-modal').classList.contains('hidden'));
  if (!sshVisible && !editorVisible) document.body.classList.remove('modal-open');
}

function sshCopyPreview() {
  const preview = document.getElementById('ssh-command-preview');
  if (!preview) return;
  const text = (preview.value || '').trim();
  if (!text) return;

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => {
      try { showToast('SSH команда скопирована', 'success'); } catch (e) {}
    }).catch(()=>{});
  } else {
    // fallback: select input and let user copy
    try { preview.focus(); preview.select(); } catch (e) {}
  }
}

function sshRunPreview() {
  const preview = document.getElementById('ssh-command-preview');
  const cmd = (preview && preview.value ? preview.value : '').trim();
  if (!cmd) return;

  if (!ptyWs || ptyWs.readyState !== WebSocket.OPEN) {
    try { showToast('PTY не подключён', 'info'); } catch (e) {}
    return;
  }

  terminalSendRaw(cmd + '\r');
  sshCloseModal();
  try { xkeenTerm && xkeenTerm.focus && xkeenTerm.focus(); } catch (e) {}
}

function sshExportProfiles() {
  const s = JSON.stringify(sshLoadProfiles(), null, 2);
  prompt('Скопируй JSON профилей:', s);
}

function sshImportProfiles() {
  const s = prompt('Вставь JSON профилей:');
  if (!s) return;
  try {
    const j = JSON.parse(s);
    if (!Array.isArray(j)) throw new Error('not array');
    sshSaveProfiles(j);
    sshRenderProfiles();
  } catch (e) {
    try { showToast('Импорт не удался: неверный JSON', 'error'); } catch (e2) {}
  }
}



// ---------------- Terminal window chrome (delegates to terminal/chrome.js) ----------------
function xkeenTerminalUiOnOpen() {
  try {
    const C = (window.XKeen && XKeen.terminal) ? XKeen.terminal.chrome : null;
    if (C && typeof C.onOpen === 'function') return C.onOpen();
  } catch (e) {}
}

function isXkeenRestartCommand(cmdText) {
  const txt = (cmdText || '').trim();

  if (currentCommandMode === 'xkeen' && currentCommandFlag === '-restart') {
    return true;
  }

  return /^xkeen\s+-restart(\s|$)/.test(txt);
}

async function sendTerminalInput() {
  if (currentCommandMode === 'pty') {
    // В PTY режиме ввод идёт напрямую в xterm (onData)
    return;
  }

  const cmdEl = document.getElementById('terminal-command');
  const inputEl = document.getElementById('terminal-input');
  const outputEl = document.getElementById('terminal-output');

  const cmdText = cmdEl ? cmdEl.value.trim() : '';
  if (!cmdText) {
    if (typeof Terminal !== 'undefined') {
      const term = initXkeenTerm();
      if (term) {
        xkeenTermWriteln('[Ошибка] Введите команду.');
        return;
      }
    }
    if (outputEl) {
      outputEl.textContent = 'Введите команду.';
    }
    return;
  }

  // Добавляем команду в локальную историю
  pushTerminalHistory(cmdText);

  // Если запрошен специальный режим перезапуска xkeen — обрабатываем отдельно.
  if (isXkeenRestartCommand(cmdText)) {
    if (typeof Terminal !== 'undefined') {
      const term = initXkeenTerm();
      if (term) {
        xkeenTermWriteln('');
        xkeenTermWriteln('[xkeen] Выполняем перезапуск (xkeen -restart)...');
      }
    } else if (outputEl) {
      outputEl.textContent = 'Отправляем xkeen -restart...';
    }

    try {
      await controlXkeen('restart');

      let logText = '';
      try {
        const logRes = await fetch('/api/restart-log');
        const logData = await logRes.json().catch(() => ({}));
        const lines = (logData && logData.lines) || [];
        if (!lines.length) {
          logText = 'Журнал пуст.';
        } else {
          logText = lines.join('');
        }
      } catch (e) {
        console.error(e);
        logText = 'Не удалось загрузить журнал перезапуска.';
      }

      if (typeof Terminal !== 'undefined') {
        const term = initXkeenTerm();
        if (term) {
          xkeenTermWriteln('');
          xkeenTermWriteln(logText || '(нет вывода)');
        }
      } else if (outputEl) {
        const html = ansiToHtml(logText || '(нет вывода)').replace(/\n/g, '<br>');
        outputEl.innerHTML = html;
        outputEl.scrollTop = outputEl.scrollHeight;
      }

      appendToLog('[terminal] xkeen -restart\n' + (logText || '(нет вывода)') + '\n');
    } catch (e) {
      console.error(e);
      const msg = 'Ошибка при перезапуске xkeen.';
      if (typeof Terminal !== 'undefined') {
        const term = initXkeenTerm();
        if (term) {
          xkeenTermWriteln('');
          xkeenTermWriteln('[Ошибка] ' + msg);
        }
      } else if (outputEl) {
        outputEl.textContent = msg;
      }
      appendToLog('[terminal] xkeen -restart: ' + String(e) + '\n');
    }

    return;
  }

  // Обычный режим выполнения команды
  let raw = inputEl ? inputEl.value : '';
  const stdinValue = (raw === '' ? '\n' : raw + '\n');

  let buffer = '';

  let needConfirm = false;

  let useXterm = false;
  if (typeof Terminal !== 'undefined') {
    const term = initXkeenTerm();
    if (term) {
      useXterm = true;
      xkeenTermWriteln('');
      xkeenTermWriteln('$ ' + cmdText);
    }
  }

  if (!useXterm && outputEl) {
    outputEl.textContent = 'Выполнение команды...';
  }

  try {
    const onChunk = (chunk) => {
      buffer += chunk;
      if (!needConfirm && terminalDetectConfirmPrompt(buffer)) {
        needConfirm = true;
        try { terminalMaybeRevealConfirm(buffer); } catch (e) {}
      }
      if (useXterm && xkeenTerm) {
        xkeenTermWrite(chunk);
      } else if (outputEl) {
        const html = ansiToHtml(buffer || '(нет вывода)').replace(/\n/g, '<br>');
        outputEl.innerHTML = html;
        outputEl.scrollTop = outputEl.scrollHeight;
      }
    };

    let runner;
    if (currentCommandMode === 'xkeen' && currentCommandFlag) {
      runner = runXkeenFlag(currentCommandFlag, stdinValue, { onChunk });
    } else {
      runner = runShellCommand(cmdText, stdinValue, { onChunk });
    }

    const { res, data } = await runner;

    if (!res.ok || !data.ok) {
      const msg = (data && data.error) ? data.error : ('HTTP ' + res.status);
      if (useXterm && xkeenTerm) {
        xkeenTermWriteln('');
        xkeenTermWriteln('[Ошибка] ' + msg);
      } else if (outputEl) {
        outputEl.textContent = 'Ошибка: ' + msg;
      }
      appendToLog('Ошибка: ' + msg + '\n');
      return;
    }

    const rawOut = data.output || buffer || '';

    if (!needConfirm && terminalDetectConfirmPrompt(rawOut)) {
      needConfirm = true;
    }

    if (useXterm && xkeenTerm) {
      if (!buffer && rawOut) {
        xkeenTermWrite(rawOut);
      }
      xkeenTermWriteln('');
      xkeenTermWriteln('[exit_code=' + (data.exit_code != null ? data.exit_code : 0) + ']');
    } else if (outputEl) {
      const html = ansiToHtml(rawOut || '(нет вывода)').replace(/\n/g, '<br>');
      outputEl.innerHTML = html;
      outputEl.scrollTop = outputEl.scrollHeight;
    }

    appendToLog(
      '[terminal] ' +
      (currentCommandLabel || cmdText) +
      '\n' +
      (rawOut || '(нет вывода)') +
      '\n'
    );

    // Hide confirm input in lite terminal unless output indicates it's needed.
    try {
      if (currentCommandMode !== 'pty') {
        if (needConfirm) {
          terminalSetConfirmVisible(true, { focus: true, clear: false });
        } else {
          terminalSetConfirmVisible(false, { clear: true });
        }
      }
    } catch (e) {}
  } catch (e) {
    console.error(e);
    const msg = 'Ошибка: ' + String(e && e.message ? e.message : e);
    if (useXterm && xkeenTerm) {
      xkeenTermWriteln('');
      xkeenTermWriteln('[Ошибка] ' + msg);
    } else if (outputEl) {
      outputEl.textContent = msg;
    }
    appendToLog('[terminal] ' + msg + '\n');
  }
}






async function runShellCommand(cmd, stdinValue, options = {}) {
  try {
    const CJ = (window.XKeen && XKeen.util && XKeen.util.commandJob) ? XKeen.util.commandJob : null;
    if (CJ && typeof CJ.runShellCommand === 'function') {
      const opts = Object.assign({}, (options || {}), { hasWs: xkeenHasWs() });
      return await CJ.runShellCommand(cmd, stdinValue, opts);
    }
  } catch (e) {}
  return { res: { ok: false, status: 0 }, data: { ok: false, error: 'command_job util is not available' } };
}

async function runXkeenFlag(flag, stdinValue, options = {}) {
  try {
    const CJ = (window.XKeen && XKeen.util && XKeen.util.commandJob) ? XKeen.util.commandJob : null;
    if (CJ && typeof CJ.runXkeenFlag === 'function') {
      const opts = Object.assign({}, (options || {}), { hasWs: xkeenHasWs() });
      return await CJ.runXkeenFlag(flag, stdinValue, opts);
    }
  } catch (e) {}
  return { res: { ok: false, status: 0 }, data: { ok: false, error: 'command_job util is not available' } };
}

async function runInstantXkeenFlag(flag, label) {
  appendToLog(`$ xkeen ${flag}\n`);

  // Буфер для случая, если нужно будет показать вывод после завершения
  let liveBuffer = '';

  try {
    const { res, data } = await runXkeenFlag(flag, '\n', {
      onChunk(chunk) {
        liveBuffer += chunk;
        // Показываем стриминговый вывод сразу в лог
        appendToLog(chunk);
      }
    });

    if (!res.ok) {
      const msg = data.error || ('HTTP ' + res.status);
      appendToLog('Ошибка: ' + msg + '\n');
      if (typeof showToast === 'function') {
        showToast(msg, true);
      }
      return;
    }

    // Если стриминга не было (onChunk не вызывался), показываем финальный вывод как раньше
    if (!liveBuffer) {
      const out = (data.output || '').trim();
      if (out) {
        appendToLog(out + '\n');
      } else {
        appendToLog('(нет вывода)\n');
      }
    } else {
      // Стриминг уже напечатал весь текст, просто завершим переносом строки, если нужно
      if (!liveBuffer.endsWith('\n')) {
        appendToLog('\n');
      }
    }

    if (typeof data.exit_code === 'number') {
      appendToLog('(код завершения: ' + data.exit_code + ')\n');
    }
  } catch (e) {
    console.error(e);
    const msg = 'Ошибка выполнения команды: ' + String(e);
    appendToLog(msg + '\n');
    if (typeof showToast === 'function') {
      showToast(msg, true);
    }
  }
}
// Restart log view was historically implemented here.
// It is now extracted to static/js/features/restart_log.js.
function appendToLog(text) {
  try {
    if (window.XKeen && XKeen.features && XKeen.features.restartLog && typeof XKeen.features.restartLog.append === 'function') {
      return XKeen.features.restartLog.append(text);
    }
  } catch (e) {}
}

// ---------- ini



  // --------------------
  // Public interface
  // --------------------

  let _terminalInitDone = false;

  function hasAnyTerminalUi() {
    return !!(
      document.getElementById('terminal-overlay') ||
      document.getElementById('terminal-output') ||
      document.getElementById('terminal-open-pty-btn') ||
      document.querySelector('.command-item')
    );
  }


  function bindClickById(id, handler) {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('click', (e) => {
      try { e.preventDefault(); } catch (e2) {}
      try { handler(e); } catch (e3) {}
    });
  }

  // Replaces legacy inline onclick wiring for the terminal island.
  function terminalBindUiButtons() {
    // Open terminal from Commands view
    bindClickById('terminal-open-shell-btn', () => { openTerminal('', 'shell'); });
    bindClickById('terminal-open-pty-btn', () => { openTerminal('', 'pty'); });

    // Overlay chrome
    bindClickById('terminal-btn-close', () => { hideTerminal(); });

    // Toolbar (PTY + window controls)
    bindClickById('terminal-btn-fullscreen', () => { terminalToggleFullscreen(); });
    bindClickById('terminal-btn-reconnect', () => { terminalReconnect(); });
    bindClickById('terminal-btn-stop-retry', () => { terminalStopRetry(); });
    bindClickById('terminal-btn-new-session', () => { terminalNewSession(); });
    bindClickById('terminal-btn-ctrlc', () => { terminalSendCtrlC(); });
    bindClickById('terminal-btn-ctrld', () => { terminalSendCtrlD(); });
    bindClickById('terminal-btn-minimize', () => { terminalMinimize(); });
    bindClickById('terminal-btn-detach', () => { terminalDetach(); });
    bindClickById('terminal-btn-kill', () => { terminalKillSession(); });
    bindClickById('terminal-btn-signals', (e) => { terminalToggleSignalsMenu(e); });
    bindClickById('terminal-btn-retry-now', () => { terminalRetryNow(); });

    // SSH profiles entry (still implemented in this module for now)
    bindClickById('terminal-btn-ssh', () => { sshOpenModal(); });

    // Signals menu items
    try {
      const menu = document.getElementById('terminal-signals-menu');
      if (menu) {
        menu.querySelectorAll('[data-terminal-signal]').forEach((btn) => {
          btn.addEventListener('click', (e) => {
            try { e.preventDefault(); } catch (e2) {}
            const sig = btn.getAttribute('data-terminal-signal');
            if (!sig) return;
            terminalSendSignal(sig);
          });
        });
      }
    } catch (e) {}

    // Search controls are bound in terminal/search.js

    // View settings
    bindClickById('terminal-btn-font-dec', () => { terminalFontDec(); });
    bindClickById('terminal-btn-font-inc', () => { terminalFontInc(); });
    bindClickById('terminal-btn-cursorblink', () => { terminalToggleCursorBlink(); });
    bindClickById('terminal-btn-ansi', () => { terminalToggleAnsiFilter(); });
    bindClickById('terminal-btn-loghl', () => { terminalToggleLogHighlight(); });
    bindClickById('terminal-btn-follow', () => { terminalToggleFollow(); });
    bindClickById('terminal-btn-bottom', () => { terminalScrollToBottom(); });

    // Buffer actions
    bindClickById('terminal-btn-copy', () => { terminalCopy(); });
    bindClickById('terminal-btn-copyall', () => { terminalCopyAll(); });
    bindClickById('terminal-btn-download', () => { terminalDownloadOutput(); });
    bindClickById('terminal-btn-paste', () => { terminalPaste(); });
    bindClickById('terminal-btn-clear', () => { terminalClear(); });

    // Quick commands menu (terminal/quick_commands.js)
    // QC binds its own UI so we only init it here.
    try {
      if (window.XKeen && window.XKeen.terminal && window.XKeen.terminal.quick_commands &&
          typeof window.XKeen.terminal.quick_commands.init === 'function') {
        window.XKeen.terminal.quick_commands.init();
      }
    } catch (e) {}

    // Confirmation send
    bindClickById('terminal-send-btn', () => { void sendTerminalInput(); });

    // SSH modals wiring (remove inline onclick; keep same behavior)
    try {
      const modal = document.getElementById('ssh-modal');
      if (modal) {
        modal.addEventListener('mousedown', (e) => {
          try { if (e.target === modal) sshCloseModal(); } catch (e2) {}
        });
      }
      bindClickById('ssh-modal-close-btn', () => { sshCloseModal(); });
      bindClickById('ssh-add-btn', () => { sshAddProfile(); });
      bindClickById('ssh-delete-selected-btn', () => { sshDeleteSelectedProfile(); });
      bindClickById('ssh-export-btn', () => { sshExportProfiles(); });
      bindClickById('ssh-import-btn', () => { sshImportProfiles(); });
      bindClickById('ssh-copy-preview-btn', () => { sshCopyPreview(); });
      bindClickById('ssh-run-preview-btn', () => { sshRunPreview(); });

      const em = document.getElementById('ssh-edit-modal');
      if (em) {
        em.addEventListener('mousedown', (e) => {
          try { if (e.target === em) sshEditClose(); } catch (e2) {}
        });
      }
      bindClickById('ssh-edit-close-btn', () => { sshEditClose(); });
      bindClickById('ssh-edit-cancel-btn', () => { sshEditClose(); });
      bindClickById('ssh-edit-delete-btn', () => { sshEditDelete(); });
      bindClickById('ssh-edit-save-btn', () => { sshEditSave(); });

      const cm = document.getElementById('ssh-confirm-modal');
      if (cm) {
        cm.addEventListener('mousedown', (e) => {
          try { if (e.target === cm) sshConfirmClose(); } catch (e2) {}
        });
      }
      bindClickById('ssh-confirm-close-btn', () => { sshConfirmClose(); });
      bindClickById('ssh-confirm-cancel-btn', () => { sshConfirmClose(); });
    } catch (e) {}
  }


  function terminalInit() {
    if (_terminalInitDone) return;
    _terminalInitDone = true;

    // If page has no terminal UI at all, keep this module inert.
    if (!hasAnyTerminalUi()) return;

    // Terminal core (state + basic helpers)
    try {
      if (window.XKeen && XKeen.terminal && XKeen.terminal._core && typeof XKeen.terminal._core.init === 'function') {
        XKeen.terminal._core.init();
      }
    } catch (e) {}

    // Make tab id visible (for debug / other features).
    try { window.XKeen.state.tabId = XKEEN_TAB_ID; } catch (e) {}

    // Initialize backend capabilities (WS support). Async but we don't need to await.
    try { xkeenInitCapabilities(); } catch (e) {}

    // Wire terminal/SSH UI buttons (replaces inline onclick)
    try { terminalBindUiButtons(); } catch (e) {}

    // Confirmation input: Enter sends stdin value.
    const terminalInput = document.getElementById('terminal-input');
    if (terminalInput) {
      terminalInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          void sendTerminalInput();
        }
      });
    }

    // Terminal main command line (lite mode)
    const cmdEl = document.getElementById('terminal-command');

    try { loadTerminalHistory(); } catch (e) {}
    try { terminalApplyFollowUi(); } catch (e) {}

    // Search + history submodules (bind UI / hotkeys)
    try { if (window.XKeen && XKeen.terminal && XKeen.terminal.search && typeof XKeen.terminal.search.init === 'function') XKeen.terminal.search.init(); } catch (e) {}
    try { if (window.XKeen && XKeen.terminal && XKeen.terminal.history && typeof XKeen.terminal.history.init === 'function') XKeen.terminal.history.init(); } catch (e) {}

    if (cmdEl) {
      cmdEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          void sendTerminalInput();
          return;
        }

        if (e.key === 'Escape') {
          e.preventDefault();
          hideTerminal();
          return;
        }

        if ((e.ctrlKey || e.metaKey) && (e.key === 'l' || e.key === 'L')) {
          e.preventDefault();
          // Clear terminal (Ctrl+L)
          try {
            if (typeof Terminal !== 'undefined') {
              const term = initXkeenTerm();
              if (term && typeof term.clear === 'function') term.clear();
            }
          } catch (e2) {}
          const out = document.getElementById('terminal-output');
          if (out && !out.querySelector('.xterm')) out.textContent = '';
          return;
        }
      });
    }

    // Auto-open terminal from URL query: ?terminal=pty|shell
    try {
      const url = new URL(window.location.href);
      const mode = String(url.searchParams.get('terminal') || '').toLowerCase();
      if (mode === 'pty' || mode === 'shell') {
        // Let the rest of the UI initialize first.
        setTimeout(() => {
          try {
            if (mode === 'pty') {
              openTerminal('', 'pty');
            } else {
              openTerminal('', 'shell');
            }
          } catch (e) {}
        }, 50);
      }
    } catch (e) {}
  }

  function terminalOpen(tabId, opts) {
    // Back-compat: allow signature open(tabId) and ignore tabId since it is tab-scoped here.
    try { void tabId; } catch (e) {}

    // opts can optionally specify { cmd, mode }
    const o = opts || {};
    const cmd = typeof o.cmd === 'string' ? o.cmd : '';
    const mode = typeof o.mode === 'string' ? o.mode : '';

    if (mode) {
      return openTerminal(cmd, mode);
    }
    return openTerminal(cmd);
  }

  function terminalClose() {
    return hideTerminal();
  }
  // Export (public API)
  const T = window.XKeen.terminal;

  // единственный обязательный entrypoint
  T.init = terminalInit;

  // optional public methods (keep minimal)
  T.open = terminalOpen;
  T.close = terminalClose;

  // PTY helpers (used by external modules/tests)
  T.connect = function connect() {
    try { terminalResetRetry({ unblock: true }); } catch (e) {}
    try { if (currentCommandMode !== 'pty') return openTerminal('', 'pty'); } catch (e) {}
    try { return terminalReconnect(); } catch (e) {}
  };

  T.disconnect = function disconnect(opts) {
    try { xkeenPtyDisconnect(opts || {}); } catch (e) {}
  };

  // Legacy bridge for split terminal submodules (quick_commands.js etc.)
  // Allows new modules to call into terminal.js while refactor is in progress.
  T._legacy = T._legacy || {};
  T._legacy.getMode = function () {
    try { return currentCommandMode || 'shell'; } catch (e) { return 'shell'; }
  };
  T._legacy.isPtyConnected = function () {
    try { return !!(ptyWs && ptyWs.readyState === WebSocket.OPEN); } catch (e) { return false; }
  };
  T._legacy.sendPtyRaw = function (data) {
    try { terminalSendRaw(String(data == null ? '' : data)); } catch (e) {}
  };
  T._legacy.runLite = function () {
    try { return sendTerminalInput(); } catch (e) {}
  };
  T._legacy.focus = function () {
    try { if (xkeenTerm && typeof xkeenTerm.focus === 'function') xkeenTerm.focus(); } catch (e) {}
  };


})();

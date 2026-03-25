(() => {
  // panel.html wiring (Milestones 1-2): init modules + remove inline onclick dependencies.

  function isPanelPage() {
    return !!(document.getElementById('view-routing') || document.querySelector('.top-tab-btn[data-view]'));
  }

  function safe(fn) {
    try { fn(); } catch (e) { console.error(e); }
  }

  function getCoreHttp() {
    try {
      if (window.XKeen && XKeen.core && XKeen.core.http) return XKeen.core.http;
    } catch (e) {}
    return null;
  }


  function getSharedPanelShell() {
    try {
      const api = window.XKeen && XKeen.pages ? XKeen.pages.panelShell : null;
      return api && typeof api.showView === 'function' ? api : null;
    } catch (e) {}
    return null;
  }

  function getSharedLogsShell() {
    try {
      const api = window.XKeen && XKeen.pages ? XKeen.pages.logsShell : null;
      return api && typeof api.ensureReady === 'function' ? api : null;
    } catch (e) {}
    return null;
  }

  function getSharedConfigShell() {
    try {
      const api = window.XKeen && XKeen.pages ? XKeen.pages.configShell : null;
      return api && typeof api.ensureReady === 'function' ? api : null;
    } catch (e) {}
    return null;
  }

  // Per-view one-time init (reduces unnecessary work + avoids API calls on tabs the user never opens).
  const _viewInitFlags = Object.create(null);
  function initViewOnce(name, fn) {
    const key = String(name || '');
    if (!key) return Promise.resolve(false);
    const state = _viewInitFlags[key];
    if (state === true) return Promise.resolve(true);
    if (state && typeof state.then === 'function') return state;

    const run = Promise.resolve()
      .then(() => fn())
      .then((result) => {
        _viewInitFlags[key] = true;
        return result;
      })
      .catch((err) => {
        try { delete _viewInitFlags[key]; } catch (e) {}
        throw err;
      });

    _viewInitFlags[key] = run;
    return run;
  }


// Lazy-loading runtime lives in static/js/runtime/lazy_runtime.js.
// panel.init.js keeps only page wiring and delegates shared orchestration there.
function getLazyRuntimeApi() {
  try {
    const api = window.XKeen && XKeen.runtime && XKeen.runtime.lazy;
    return api || null;
  } catch (e) {}
  return null;
}

function ensureTerminalReady() {
  const api = getLazyRuntimeApi();
  return (api && typeof api.ensureTerminalReady === 'function')
    ? api.ensureTerminalReady()
    : Promise.resolve(false);
}

function isTerminalReady() {
  const api = getLazyRuntimeApi();
  return !!(api && typeof api.isTerminalReady === 'function' && api.isTerminalReady());
}

function ensureFileManagerReady() {
  const api = getLazyRuntimeApi();
  return (api && typeof api.ensureFileManagerReady === 'function')
    ? api.ensureFileManagerReady()
    : Promise.resolve(false);
}

function ensureEditorSupport(engine, opts) {
  const api = getLazyRuntimeApi();
  return (api && typeof api.ensureEditorSupport === 'function')
    ? api.ensureEditorSupport(engine, opts)
    : Promise.resolve(false);
}

function ensureMonacoSupport(opts) {
  return ensureEditorSupport('monaco', opts);
}

function ensureCodeMirrorSupport(opts) {
  return ensureEditorSupport('codemirror', opts);
}

function openTerminal(mode) {
  const m = String(mode || 'shell').toLowerCase();
  safe(() => {
    const T = window.XKeen && window.XKeen.terminal ? window.XKeen.terminal : null;
    if (!T) return;
    if (T.api && typeof T.api.open === 'function') {
      void T.api.open({ cmd: '', mode: m });
      return;
    }
    if (T.ui_actions && typeof T.ui_actions.openTerminal === 'function') {
      T.ui_actions.openTerminal('', m);
    }
  });
}

function wireTerminalLazyOpen() {
  const shellBtn = document.getElementById('terminal-open-shell-btn');
  const ptyBtn = document.getElementById('terminal-open-pty-btn');

  function wire(btn, mode) {
    if (!btn) return;
    if (btn.dataset && btn.dataset.xkLazyTerminal === '1') return;
    btn.addEventListener('click', (e) => {
      if (isTerminalReady()) return; // terminal scripts will handle further clicks
      e.preventDefault();
      e.stopImmediatePropagation();
      ensureTerminalReady().then((ready) => {
        if (ready) openTerminal(mode);
      });
    }, true);
    if (btn.dataset) btn.dataset.xkLazyTerminal = '1';
  }

  wire(shellBtn, 'shell');
  wire(ptyBtn, 'pty');
}

// Decide which terminal open button to show on initial page load.
// Before terminal scripts are lazy-loaded, both buttons exist in markup.
// We hide one of them based on PTY availability from /api/capabilities.
let _terminalCapsInit = false;
function initTerminalCapabilityButtons() {
  if (_terminalCapsInit) return;
  _terminalCapsInit = true;

  const shellBtn = document.getElementById('terminal-open-shell-btn');
  const ptyBtn = document.getElementById('terminal-open-pty-btn');
  if (!shellBtn && !ptyBtn) return;

  function apply(data) {
    const ws = !!(data && data.websocket);
    const hasPty = !!(
      data &&
      data.terminal &&
      typeof data.terminal === 'object' &&
      'pty' in data.terminal
        ? data.terminal.pty
        : ws
    );
    try {
      window.XKeen = window.XKeen || {};
      window.XKeen.state = window.XKeen.state || {};
      window.XKeen.state.hasWs = ws;
      window.XKeen.state.hasPty = hasPty;
    } catch (e) {}

    if (hasPty) {
      if (ptyBtn) { try { ptyBtn.style.display = ''; ptyBtn.disabled = false; } catch (e) {} }
      if (shellBtn) { try { shellBtn.style.display = 'none'; shellBtn.disabled = true; } catch (e) {} }
    } else {
      if (shellBtn) { try { shellBtn.style.display = ''; shellBtn.disabled = false; } catch (e) {} }
      if (ptyBtn) { try { ptyBtn.style.display = 'none'; ptyBtn.disabled = true; } catch (e) {} }
    }
  }

  // Keep server-side default (based on PTY support) until we know live capabilities.
  // This removes the "two buttons" glitch on initial load.
  Promise.resolve().then(() => {
    const http = getCoreHttp();
    if (http && typeof http.fetchJSON === 'function') {
      return http.fetchJSON('/api/capabilities', {
        method: 'GET',
        timeoutMs: 6000,
        retry: 1,
      }).catch(() => null);
    }
    return fetch('/api/capabilities', { cache: 'no-store' })
      .then((r) => (r && r.ok) ? r.json() : null)
      .catch(() => null);
  })
    .then((data) => apply(data))
    .catch(() => {
      // On error: keep current default button.
    });
}


function isMipsTarget() {
  try {
    if (typeof window.XKEEN_IS_MIPS === 'boolean') return !!window.XKEEN_IS_MIPS;
    const v = String(window.XKEEN_IS_MIPS || '').toLowerCase();
    return v === '1' || v === 'true' || v === 'yes' || v === 'on';
  } catch (e) {}
  return false;
}

function hasXrayCore() {
  try {
    if (typeof window.XKEEN_HAS_XRAY === 'boolean') return !!window.XKEEN_HAS_XRAY;
    const v = String(window.XKEEN_HAS_XRAY || '').toLowerCase();
    if (v) return v === '1' || v === 'true' || v === 'yes' || v === 'on';
  } catch (e) {}
  return true;
}

const LIGHT_XRAY_BADGE_POLL_MS = 10000;
let _lightXrayBadgeTimer = null;
let _lightXrayBadgeVisibilityBound = false;
const LIGHT_XKEEN_STATUS_POLL_MS = 15000;
let _lightXkeenStatusTimer = null;
let _lightXkeenStatusVisibilityBound = false;
let _lightXkeenShellUnsubscribe = null;
let _headerShellLoadingUnsubscribe = null;
const LIGHT_DONATE_HIDE_KEY = 'xkeen_ui_hide_donate';

function getUiShellApi() {
  try {
    const api = window.XKeen && XKeen.core && XKeen.core.uiShell;
    if (api && typeof api.getState === 'function' && typeof api.patchState === 'function') return api;
  } catch (e) {}
  return null;
}

function readUiShellState() {
  const api = getUiShellApi();
  if (!api) {
    return {
      serviceStatus: '',
      currentCore: '',
      version: {
        currentLabel: '',
        currentCommit: '',
        currentBuiltAt: '',
        latestLabel: '',
        latestPublishedAt: '',
        channel: '',
      },
      loading: {
        serviceStatus: false,
        currentCore: true,
        update: true,
      },
      update: { visible: false, hasUpdate: false, label: '', title: '' },
    };
  }
  return api.getState();
}

function patchUiShellState(patch, meta) {
  const api = getUiShellApi();
  if (!api) return readUiShellState();
  return api.patchState(patch, meta);
}

function readUiShellLoadingState(snapshot) {
  const shell = snapshot || readUiShellState();
  const loading = shell && shell.loading && typeof shell.loading === 'object' ? shell.loading : {};
  return {
    serviceStatus: !!loading.serviceStatus,
    currentCore: !!loading.currentCore,
    update: !!loading.update,
  };
}

function setHeaderAsyncChipLoading(el, isLoading) {
  if (!el) return;

  if (isLoading) {
    el.dataset.loading = 'true';
    el.setAttribute('aria-busy', 'true');
    if (el.id === 'xkeen-core-text') {
      el.disabled = true;
      if (!String(el.textContent || '').trim()) el.textContent = 'Ядро';
    }
    return;
  }

  try { delete el.dataset.loading; } catch (e) { el.removeAttribute('data-loading'); }
  el.removeAttribute('aria-busy');
}

function renderHeaderAsyncShell(snapshot) {
  const loading = readUiShellLoadingState(snapshot);
  setHeaderAsyncChipLoading(document.getElementById('xkeen-core-text'), loading.currentCore);
  setHeaderAsyncChipLoading(document.getElementById('xk-update-link'), loading.update);
}

function ensureHeaderAsyncShellBinding() {
  if (_headerShellLoadingUnsubscribe) return;

  const api = getUiShellApi();
  if (!api || typeof api.subscribe !== 'function') {
    renderHeaderAsyncShell(readUiShellState());
    return;
  }

  _headerShellLoadingUnsubscribe = api.subscribe((next) => {
    renderHeaderAsyncShell(next);
  }, { immediate: true });
}

function getLightweightDonateHidePref() {
  try {
    const raw = localStorage.getItem(LIGHT_DONATE_HIDE_KEY);
    return raw === '1' || raw === 'true' || raw === 'yes';
  } catch (e) {
    return false;
  }
}

function syncLightweightDonateButtonVisibility() {
  const btn = document.getElementById('top-tab-donate');
  if (!btn) return;
  btn.classList.toggle('hidden', getLightweightDonateHidePref());
}

function setLightweightXrayHeaderBadgeState(state, level) {
  const badge = document.getElementById('xray-logs-badge');
  if (!badge) return;

  const st = String(state || '').toLowerCase() === 'on' ? 'on' : 'off';
  badge.dataset.state = st;

  if (st === 'on') {
    const lvl = String(level || '').trim().toLowerCase();
    badge.title = (lvl && lvl !== 'none')
      ? ('Логи Xray включены (loglevel=' + lvl + ').')
      : 'Логи Xray включены.';
    return;
  }

  badge.title = 'Логи Xray выключены.';
}

function hasLoadedXrayLogsFeature() {
  try {
    const api = (window.XKeen && XKeen.features) ? XKeen.features.xrayLogs : null;
    return !!(api && typeof api.init === 'function' && typeof api.refreshStatus === 'function');
  } catch (e) {
    return false;
  }
}

function stopLightweightXrayBadgePolling() {
  if (_lightXrayBadgeTimer) {
    try { clearInterval(_lightXrayBadgeTimer); } catch (e) {}
    _lightXrayBadgeTimer = null;
  }
}

async function refreshLightweightXrayHeaderBadge() {
  if (!hasXrayCore()) return false;
  if (hasLoadedXrayLogsFeature()) {
    stopLightweightXrayBadgePolling();
    return true;
  }

  try {
    let data = null;
    const http = getCoreHttp();
    if (http && typeof http.fetchJSON === 'function') {
      data = await http.fetchJSON('/api/xray-logs/status', {
        method: 'GET',
        timeoutMs: 6000,
        retry: 1,
      }).catch(() => null);
    } else {
      const res = await fetch('/api/xray-logs/status', { cache: 'no-store' });
      data = await res.json().catch(() => null);
      if (!res.ok) data = null;
    }

    const level = String((data && data.loglevel) ? data.loglevel : 'none').toLowerCase();
    setLightweightXrayHeaderBadgeState(level === 'none' ? 'off' : 'on', level);
    return true;
  } catch (e) {
    setLightweightXrayHeaderBadgeState('off', 'none');
    return false;
  }
}

function startLightweightXrayBadgePolling() {
  if (!hasXrayCore()) return;
  if (_lightXrayBadgeTimer || hasLoadedXrayLogsFeature()) return;

  void refreshLightweightXrayHeaderBadge();

  _lightXrayBadgeTimer = setInterval(() => {
    if (hasLoadedXrayLogsFeature()) {
      stopLightweightXrayBadgePolling();
      return;
    }
    try {
      if (document.visibilityState === 'hidden') return;
    } catch (e) {}
    void refreshLightweightXrayHeaderBadge();
  }, LIGHT_XRAY_BADGE_POLL_MS);

  if (_lightXrayBadgeVisibilityBound) return;
  _lightXrayBadgeVisibilityBound = true;

  document.addEventListener('visibilitychange', () => {
    if (!_lightXrayBadgeTimer || hasLoadedXrayLogsFeature()) return;
    try {
      if (document.visibilityState === 'visible') void refreshLightweightXrayHeaderBadge();
    } catch (e) {}
  });
}

function getGlobalAutorestartCheckbox() {
  return document.getElementById('global-autorestart-xkeen');
}

function lightweightShouldAutoRestartAfterSave() {
  const cb = getGlobalAutorestartCheckbox();
  return !!(cb && cb.checked);
}

function bindLightweightAutorestartCheckbox() {
  const cb = getGlobalAutorestartCheckbox();
  if (!cb) return;

  try {
    if (window.localStorage) {
      const stored = localStorage.getItem('xkeen_global_autorestart');
      if (stored === '1') cb.checked = true;
      else if (stored === '0') cb.checked = false;
    }
  } catch (e) {}

  if (cb.dataset && cb.dataset.xkeenBound === '1') return;

  cb.addEventListener('change', () => {
    try {
      if (!window.localStorage) return;
      localStorage.setItem('xkeen_global_autorestart', cb.checked ? '1' : '0');
    } catch (e) {}
  });

  if (cb.dataset) cb.dataset.xkeenBound = '1';
}

if (typeof window.shouldAutoRestartAfterSave !== 'function') {
  window.shouldAutoRestartAfterSave = lightweightShouldAutoRestartAfterSave;
}

function setLightweightXkeenHeaderState(state, core) {
  const lamp = document.getElementById('xkeen-service-lamp');
  const textEl = document.getElementById('xkeen-service-text');
  const coreEl = document.getElementById('xkeen-core-text');
  const startBtn = document.getElementById('xkeen-start-btn');

  if (startBtn) {
    const showStart = String(state || '').toLowerCase() === 'stopped';
    startBtn.hidden = !showStart;
    startBtn.setAttribute('aria-hidden', showStart ? 'false' : 'true');
  }

  if (!lamp || !textEl || !coreEl) return;

  const st = String(state || '');
  lamp.dataset.state = st;

  let text = 'Статус неизвестен';
  switch (st) {
    case 'running':
      text = 'Сервис запущен';
      break;
    case 'stopped':
      text = 'Сервис остановлен';
      break;
    case 'pending':
      text = 'Проверка статуса...';
      break;
    case 'error':
      text = 'Ошибка статуса';
      break;
    default:
      break;
  }

  textEl.textContent = text;

  if (core) {
    const label = String(core || '').toLowerCase() === 'mihomo' ? 'mihomo' : 'xray';
    coreEl.textContent = 'Ядро: ' + label;
    coreEl.dataset.core = label;
    coreEl.classList.add('has-core');
    coreEl.disabled = false;
    lamp.title = text + ' (ядро: ' + label + ')';
    return;
  }

  coreEl.textContent = 'Ядро';
  coreEl.dataset.core = '';
  coreEl.classList.remove('has-core');
  coreEl.disabled = false;
  lamp.title = text;
}

function ensureLightweightXkeenShellBinding() {
  if (_lightXkeenShellUnsubscribe) return;

  const api = getUiShellApi();
  if (!api || typeof api.subscribe !== 'function') {
    const current = readUiShellState();
    if (current.serviceStatus || current.currentCore) {
      setLightweightXkeenHeaderState(current.serviceStatus, current.currentCore);
    }
    return;
  }

  _lightXkeenShellUnsubscribe = api.subscribe((next) => {
    if (!next.serviceStatus && !next.currentCore) return;
    setLightweightXkeenHeaderState(next.serviceStatus, next.currentCore);
  }, { immediate: true });
}

function syncLightweightXkeenHeaderState(state, core, meta) {
  const o = meta && typeof meta === 'object' ? Object.assign({}, meta) : {};
  const normalizedState = String(state || '');
  const normalizedCore = core
    ? (String(core || '').toLowerCase() === 'mihomo' ? 'mihomo' : 'xray')
    : '';
  const patch = {
    serviceStatus: normalizedState,
    currentCore: normalizedCore,
  };

  if (o.loading && typeof o.loading === 'object') {
    patch.loading = o.loading;
  }

  try { delete o.loading; } catch (e) {}

  const snapshot = patchUiShellState(patch, Object.assign({ source: 'panel.init.lightweight' }, o));

  if (!_lightXkeenShellUnsubscribe) {
    setLightweightXkeenHeaderState(snapshot.serviceStatus, snapshot.currentCore);
  }
}

function hasLoadedServiceStatusFeature() {
  try {
    const api = (window.XKeen && XKeen.features) ? XKeen.features.serviceStatus : null;
    if (!(api && typeof api.init === 'function' && typeof api.refresh === 'function')) return false;
    if (typeof api.isInitialized === 'function') return !!api.isInitialized();
    return true;
  } catch (e) {
    return false;
  }
}

function stopLightweightXkeenStatusPolling() {
  if (_lightXkeenStatusTimer) {
    try { clearInterval(_lightXkeenStatusTimer); } catch (e) {}
    _lightXkeenStatusTimer = null;
  }
}

async function refreshLightweightXkeenHeaderStatus(opts) {
  const o = opts || {};
  const lamp = document.getElementById('xkeen-service-lamp');
  if (!lamp) return false;

  if (hasLoadedServiceStatusFeature()) {
    stopLightweightXkeenStatusPolling();
    return true;
  }

  const curState = String(lamp.dataset.state || '');
  if (!o.silent && (!curState || curState === 'pending')) {
    syncLightweightXkeenHeaderState('pending', '', {
      loading: { currentCore: true },
    });
  }

  try {
    let data = null;
    const http = getCoreHttp();
    if (http && typeof http.fetchJSON === 'function') {
      data = await http.fetchJSON('/api/xkeen/status', {
        method: 'GET',
        timeoutMs: 6000,
        retry: 1,
      }).catch(() => null);
    } else {
      const res = await fetch('/api/xkeen/status', { cache: 'no-store' });
      data = await res.json().catch(() => null);
      if (!res.ok) data = null;
    }

    if (!data) throw new Error('empty status payload');

    syncLightweightXkeenHeaderState(data.running ? 'running' : 'stopped', data.core || null, {
      loading: { currentCore: false },
    });
    return true;
  } catch (e) {
    syncLightweightXkeenHeaderState('error', '', {
      loading: { currentCore: false },
    });
    return false;
  }
}

function startLightweightXkeenStatusPolling() {
  bindLightweightAutorestartCheckbox();
  ensureLightweightXkeenShellBinding();

  if (_lightXkeenStatusTimer || hasLoadedServiceStatusFeature()) return;

  void refreshLightweightXkeenHeaderStatus({ silent: false });

  _lightXkeenStatusTimer = setInterval(() => {
    if (hasLoadedServiceStatusFeature()) {
      stopLightweightXkeenStatusPolling();
      return;
    }
    try {
      if (document.visibilityState === 'hidden') return;
    } catch (e) {}
    void refreshLightweightXkeenHeaderStatus({ silent: true });
  }, LIGHT_XKEEN_STATUS_POLL_MS);

  if (_lightXkeenStatusVisibilityBound) return;
  _lightXkeenStatusVisibilityBound = true;

  document.addEventListener('visibilitychange', () => {
    if (!_lightXkeenStatusTimer || hasLoadedServiceStatusFeature()) return;
    try {
      if (document.visibilityState === 'visible') void refreshLightweightXkeenHeaderStatus({ silent: true });
    } catch (e) {}
  });
}

const CORE_UI_WATCH_INITIAL_DELAY_MS = 8000;
const CORE_UI_WATCH_POLL_MS = 15000;
const CORE_UI_WATCH_HIDDEN_POLL_MS = 60000;
const CORE_UI_WATCH_ERROR_BACKOFF_MS = 60000;
const CORE_UI_WATCH_FOCUS_COOLDOWN_MS = 2500;

function normalizeCoreList(list) {
  const raw = Array.isArray(list) ? list : [];
  const seen = Object.create(null);
  const out = [];
  for (let i = 0; i < raw.length; i += 1) {
    const name = String(raw[i] || '').trim().toLowerCase();
    if (!name || (name !== 'xray' && name !== 'mihomo')) continue;
    if (seen[name]) continue;
    seen[name] = true;
    out.push(name);
  }
  out.sort();
  return out;
}

function coreListSignature(list) {
  return normalizeCoreList(list).join(',');
}

function getInitialDetectedCores() {
  try {
    if (Array.isArray(window.XKEEN_DETECTED_CORES)) {
      return normalizeCoreList(window.XKEEN_DETECTED_CORES);
    }
  } catch (e) {}
  try {
    if (window.XKEEN_CORE_UI_FALLBACK === true) return [];
  } catch (e2) {}
  try {
    return normalizeCoreList(window.XKEEN_AVAILABLE_CORES);
  } catch (e3) {}
  return [];
}

function formatCoreName(name) {
  const key = String(name || '').toLowerCase();
  if (key === 'xray') return 'Xray';
  if (key === 'mihomo') return 'Mihomo';
  return String(name || '');
}

function describeCoreUiTopologyChange(prevCores, nextCores) {
  const prev = normalizeCoreList(prevCores);
  const next = normalizeCoreList(nextCores);
  const added = next.filter((name) => prev.indexOf(name) === -1);
  const removed = prev.filter((name) => next.indexOf(name) === -1);

  if (added.length && !removed.length) {
    if (added.length === 1) {
      return 'Найдено ядро ' + formatCoreName(added[0]) + '. На панели появились новые разделы.';
    }
    return 'Найдены новые ядра: ' + added.map(formatCoreName).join(', ') + '. Панель покажет дополнительные разделы.';
  }

  if (removed.length && !added.length) {
    if (removed.length === 1) {
      return 'Ядро ' + formatCoreName(removed[0]) + ' больше не найдено. Лишние разделы будут скрыты.';
    }
    return 'Часть ядер больше не найдена: ' + removed.map(formatCoreName).join(', ') + '. Панель скроет лишние разделы.';
  }

  if (!prev.length && next.length) {
    return 'Найдены установленные ядра: ' + next.map(formatCoreName).join(', ') + '. Панель перестроится под доступные разделы.';
  }

  if (prev.length && !next.length) {
    return 'Установленные ядра больше не обнаружены. Панель вернётся к безопасному режиму отображения.';
  }

  return 'Конфигурация ядер изменилась. Панель нужно обновить.';
}

let _coreUiKnownDetectedCores = getInitialDetectedCores();
let _coreUiKnownSignature = coreListSignature(_coreUiKnownDetectedCores);
let _coreUiWatchTimer = null;
let _coreUiWatchInFlight = false;
let _coreUiReloadScheduled = false;
let _coreUiPendingSignature = '';
let _coreUiPendingMessage = '';
let _coreUiLastCheckAt = 0;
let _coreUiWatchInited = false;

function notifyPanelInfo(message) {
  const text = String(message || '').trim();
  if (!text) return;
  try {
    if (typeof window.toast === 'function') {
      window.toast(text, 'info');
      return;
    }
  } catch (e) {}
}

function hasUnsavedPanelChanges() {
  try {
    const dirtyApi = (window.XKeen && XKeen.ui) ? XKeen.ui.configDirty : null;
    if (dirtyApi && typeof dirtyApi.anyDirty === 'function' && dirtyApi.anyDirty(['routing', 'inbounds', 'outbounds'])) {
      return true;
    }
  } catch (e) {}

  try {
    const routingShell = (window.XKeen && XKeen.features) ? XKeen.features.routingShell : null;
    if (routingShell && typeof routingShell.isDirty === 'function') {
      if (routingShell.isDirty()) return true;
    }
  } catch (e) {}

  try {
    const mihomoPanel = window.XKeen && XKeen.features ? XKeen.features.mihomoPanel : null;
    if (mihomoPanel && typeof mihomoPanel.isEditorDirty === 'function' && mihomoPanel.isEditorDirty()) {
      return true;
    }
  } catch (e) {}

  try {
    const jsonEditor = window.XKeen ? XKeen.jsonEditor : null;
    if (jsonEditor && typeof jsonEditor.isDirty === 'function' && jsonEditor.isDirty()) {
      return true;
    }
  } catch (e) {}

  try {
    const fileManager = (window.XKeen && XKeen.features) ? XKeen.features.fileManager : null;
    const editor = fileManager ? fileManager.editor : null;
    if (editor && typeof editor.isDirty === 'function' && editor.isDirty()) {
      return true;
    }
  } catch (e) {}

  return false;
}

function getCoreUiRefreshButton() {
  return document.getElementById('panel-core-ui-refresh-btn');
}

async function confirmCoreUiManualReload() {
  if (!hasUnsavedPanelChanges()) return true;

  const title = 'Обновить панель?';
  const message = 'Панель перестроится под новый набор ядер, несохранённые изменения будут потеряны.';

  try {
    if (window.XKeen && XKeen.ui && typeof XKeen.ui.confirm === 'function') {
      return await XKeen.ui.confirm({
        title,
        message,
        okText: 'Обновить',
        cancelText: 'Отмена',
        danger: true,
      });
    }
  } catch (e) {}

  try {
    return window.confirm(message);
  } catch (e2) {
    return false;
  }
}

function revealCoreUiRefreshButton(message) {
  const btn = getCoreUiRefreshButton();
  if (!btn) return;
  try { btn.classList.remove('hidden'); } catch (e) {}
  try { btn.disabled = false; } catch (e2) {}
  try { btn.title = String(message || btn.title || ''); } catch (e3) {}
}

function reloadPanelForCoreUiChange(message) {
  if (_coreUiReloadScheduled) return;
  _coreUiReloadScheduled = true;

  const text = String(message || 'Найдено изменение в наборе ядер.');
  notifyPanelInfo(text + ' Перезагружаем панель...');

  try {
    if (_coreUiWatchTimer) clearTimeout(_coreUiWatchTimer);
  } catch (e) {}
  _coreUiWatchTimer = null;

  setTimeout(() => {
    try {
      window.location.reload();
    } catch (e) {
      try { window.location.href = window.location.href; } catch (e2) {}
    }
  }, 900);
}

function deferCoreUiReload(message, nextCores) {
  const nextSig = coreListSignature(nextCores);
  if (_coreUiPendingSignature === nextSig) return;

  _coreUiPendingSignature = nextSig;
  _coreUiPendingMessage = String(message || 'Конфигурация ядер изменилась.');
  revealCoreUiRefreshButton(_coreUiPendingMessage);
  notifyPanelInfo(_coreUiPendingMessage + ' Сохраните изменения и нажмите "Обновить панель".');

  try {
    if (_coreUiWatchTimer) clearTimeout(_coreUiWatchTimer);
  } catch (e) {}
  _coreUiWatchTimer = null;
}

function parseDetectedCoresFromPayload(data) {
  if (!data || typeof data !== 'object') return null;

  if (Array.isArray(data.cores)) {
    return normalizeCoreList(data.cores);
  }

  if (data.cores && typeof data.cores === 'object') {
    const out = [];
    if (data.cores.xray && data.cores.xray.installed) out.push('xray');
    if (data.cores.mihomo && data.cores.mihomo.installed) out.push('mihomo');
    return normalizeCoreList(out);
  }

  return null;
}

async function fetchDetectedCores() {
  const http = getCoreHttp();
  if (http && typeof http.fetchJSON === 'function') {
    try {
      const data = await http.fetchJSON('/api/xkeen/core', {
        method: 'GET',
        timeoutMs: 6000,
        retry: 1,
      });
      if (!data || data.ok !== true) return null;
      return parseDetectedCoresFromPayload(data);
    } catch (e) {
      return null;
    }
  }

  try {
    const res = await fetch('/api/xkeen/core', { cache: 'no-store' });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || data.ok !== true) return null;
    return parseDetectedCoresFromPayload(data);
  } catch (e) {
    return null;
  }
}

function scheduleCoreUiWatch(delayMs) {
  if (_coreUiReloadScheduled || _coreUiPendingSignature) return;

  const wait = (typeof delayMs === 'number' && delayMs >= 0) ? delayMs : CORE_UI_WATCH_POLL_MS;
  try {
    if (_coreUiWatchTimer) clearTimeout(_coreUiWatchTimer);
  } catch (e) {}
  _coreUiWatchTimer = setTimeout(() => {
    _coreUiWatchTimer = null;
    void checkCoreUiTopology('timer');
  }, wait);
}

async function handleCoreUiTopologyChange(prevCores, nextCores) {
  const message = describeCoreUiTopologyChange(prevCores, nextCores);
  if (hasUnsavedPanelChanges()) {
    deferCoreUiReload(message, nextCores);
    return;
  }
  reloadPanelForCoreUiChange(message);
}

async function checkCoreUiTopology(reason) {
  if (_coreUiReloadScheduled || _coreUiPendingSignature || _coreUiWatchInFlight) return;

  try {
    if (document.visibilityState === 'hidden') {
      scheduleCoreUiWatch(CORE_UI_WATCH_HIDDEN_POLL_MS);
      return;
    }
  } catch (e) {}

  const now = Date.now();
  if (reason === 'focus' && (now - _coreUiLastCheckAt) < CORE_UI_WATCH_FOCUS_COOLDOWN_MS) {
    scheduleCoreUiWatch(CORE_UI_WATCH_POLL_MS);
    return;
  }

  _coreUiWatchInFlight = true;
  _coreUiLastCheckAt = now;

  let nextDelay = CORE_UI_WATCH_POLL_MS;
  try {
    const nextCores = await fetchDetectedCores();
    if (!nextCores) {
      nextDelay = CORE_UI_WATCH_ERROR_BACKOFF_MS;
      return;
    }

    const prevCores = _coreUiKnownDetectedCores.slice();
    const nextSig = coreListSignature(nextCores);
    if (nextSig !== _coreUiKnownSignature) {
      _coreUiKnownDetectedCores = nextCores.slice();
      _coreUiKnownSignature = nextSig;
      void handleCoreUiTopologyChange(prevCores, nextCores);
      return;
    }
  } finally {
    _coreUiWatchInFlight = false;
  }

  scheduleCoreUiWatch(nextDelay);
}

function wireCoreUiRefreshButton() {
  const btn = getCoreUiRefreshButton();
  if (!btn) return;
  if (btn.dataset && btn.dataset.xkCoreRefreshWired === '1') return;

  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    const ok = await confirmCoreUiManualReload();
    if (!ok) return;
    reloadPanelForCoreUiChange(_coreUiPendingMessage || 'Перестраиваем панель под доступные ядра.');
  });

  if (btn.dataset) btn.dataset.xkCoreRefreshWired = '1';
}

function initCoreUiAutoDetect() {
  if (_coreUiWatchInited) return;
  _coreUiWatchInited = true;

  wireCoreUiRefreshButton();

  document.addEventListener('visibilitychange', () => {
    try {
      if (document.visibilityState === 'visible') {
        void checkCoreUiTopology('visibility');
      }
    } catch (e) {}
  });

  window.addEventListener('focus', () => {
    void checkCoreUiTopology('focus');
  });

  scheduleCoreUiWatch(CORE_UI_WATCH_INITIAL_DELAY_MS);
}

function getLazyFeatureApi(name) {
  const api = getLazyRuntimeApi();
  return (api && typeof api.getFeatureApi === 'function')
    ? api.getFeatureApi(name)
    : null;
}

function isLazyFeatureStub(feature) {
  const api = getLazyRuntimeApi();
  return !!(api && typeof api.isFeatureStub === 'function' && api.isFeatureStub(feature));
}

function isLazyFeatureReady(name) {
  const api = getLazyRuntimeApi();
  return !!(api && typeof api.isFeatureReady === 'function' && api.isFeatureReady(name));
}

function ensureLazyFeature(name) {
  const api = getLazyRuntimeApi();
  return (api && typeof api.ensureFeature === 'function')
    ? api.ensureFeature(name)
    : Promise.resolve(false);
}

function replayDeferredClick(el) {
  if (!el) return;
  try {
    if (el.dataset) el.dataset.xkLazyReplay = '1';
  } catch (e) {}
  fireDeferredClick(el);
}

function fireDeferredClick(el) {
  if (!el) return;
  try {
    el.click();
  } catch (e) {
    try {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    } catch (e2) {}
  }
}

function replayDeferredEvent(el, type) {
  if (!el || !type) return;
  if (String(type) === 'click') {
    replayDeferredClick(el);
    return;
  }
  try {
    el.dispatchEvent(new Event(String(type), { bubbles: true, cancelable: true }));
  } catch (e) {}
}

function consumeReplayFlag(el) {
  try {
    if (!el || !el.dataset || el.dataset.xkLazyReplay !== '1') return false;
    delete el.dataset.xkLazyReplay;
    return true;
  } catch (e) {
    return false;
  }
}

function wireLazyFeatureClicks() {
  if (document.body && document.body.dataset && document.body.dataset.xkLazyFeatureClicks === '1') return;

  document.addEventListener('click', (e) => {
    const raw = e && e.target && typeof e.target.closest === 'function' ? e.target : null;
    if (!raw) return;

    const serviceTrigger = raw.closest('#xkeen-start-btn, #xkeen-stop-btn, #xkeen-restart-btn, #xkeen-core-text');
    if (serviceTrigger && !isLazyFeatureReady('serviceStatus')) {
      e.preventDefault();
      e.stopImmediatePropagation();
      ensureLazyFeature('serviceStatus').then((ready) => {
        if (!ready) return;
        fireDeferredClick(serviceTrigger);
      });
      return;
    }

    const xrayActionBtn = raw.closest('#view-xray-logs button');
    if (xrayActionBtn && !isLazyFeatureReady('xrayLogs')) {
      e.preventDefault();
      e.stopImmediatePropagation();
      ensureLazyFeature('xrayLogs').then((ready) => {
        if (!ready) return;
        fireDeferredClick(xrayActionBtn);
      });
      return;
    }

    const templateBtn = raw.closest('#routing-import-template-btn');
    if (templateBtn) {
      if (consumeReplayFlag(templateBtn)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      ensureLazyFeature('routingTemplates').then((ready) => {
        if (!ready) return;
        try {
          const api = getLazyFeatureApi('routingTemplates');
          if (api && typeof api.open === 'function') api.open();
          else replayDeferredClick(templateBtn);
        } catch (err) {}
      });
      return;
    }

    const githubExportBtn = raw.closest('#github-export-btn');
    if (githubExportBtn) {
      if (consumeReplayFlag(githubExportBtn)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      ensureLazyFeature('github').then((ready) => {
        if (!ready) return;
        try {
          const api = getLazyFeatureApi('github');
          if (api && typeof api.openExportModal === 'function') api.openExportModal();
          else replayDeferredClick(githubExportBtn);
        } catch (err) {}
      });
      return;
    }

    const githubCatalogBtn = raw.closest('#github-open-catalog-btn');
    if (githubCatalogBtn) {
      if (consumeReplayFlag(githubCatalogBtn)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      ensureLazyFeature('github').then((ready) => {
        if (!ready) return;
        try {
          const api = getLazyFeatureApi('github');
          if (api && typeof api.openCatalogModal === 'function') api.openCatalogModal();
          else replayDeferredClick(githubCatalogBtn);
        } catch (err) {}
      });
      return;
    }

    const donateBtn = raw.closest('#top-tab-donate');
    if (donateBtn) {
      if (consumeReplayFlag(donateBtn)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      ensureLazyFeature('donate').then((ready) => {
        if (!ready) return;
        try {
          const api = getLazyFeatureApi('donate');
          if (api && typeof api.open === 'function') {
            api.open();
            return;
          }
        } catch (err) {}
        replayDeferredClick(donateBtn);
      });
      return;
    }

    const settingsBtn = raw.closest('#ui-settings-open-btn');
    if (settingsBtn && !isLazyFeatureReady('uiSettingsPanel')) {
      e.preventDefault();
      e.stopImmediatePropagation();
      ensureLazyFeature('uiSettingsPanel').then((ready) => {
        if (!ready) return;
        fireDeferredClick(settingsBtn);
      });
      return;
    }

    const mihomoImportBtn = raw.closest('#mihomo-import-node-btn');
    if (mihomoImportBtn && !isLazyFeatureReady('mihomoImport')) {
      e.preventDefault();
      e.stopImmediatePropagation();
      ensureLazyFeature('mihomoImport').then((ready) => {
        if (!ready) return;
        fireDeferredClick(mihomoImportBtn);
      });
      return;
    }

    const mihomoProxyToolsBtn = raw.closest('#mihomo-proxy-tools-btn');
    if (mihomoProxyToolsBtn && !isLazyFeatureReady('mihomoProxyTools')) {
      e.preventDefault();
      e.stopImmediatePropagation();
      ensureLazyFeature('mihomoProxyTools').then((ready) => {
        if (!ready) return;
        fireDeferredClick(mihomoProxyToolsBtn);
      });
      return;
    }

    const mihomoHwidBtn = raw.closest('#mihomo-hwid-sub-btn');
    if (mihomoHwidBtn && !isLazyFeatureReady('mihomoHwidSub')) {
      e.preventDefault();
      e.stopImmediatePropagation();
      ensureLazyFeature('mihomoHwidSub').then((ready) => {
        if (!ready) return;
        fireDeferredClick(mihomoHwidBtn);
      });
      return;
    }

    const xkeenAction = raw.closest('#port-proxying-save-btn, #port-exclude-save-btn, #ip-exclude-save-btn, #xkeen-config-save-btn');
    if (xkeenAction && !isLazyFeatureReady('xkeenTexts')) {
      e.preventDefault();
      e.stopImmediatePropagation();
      ensureLazyFeature('xkeenTexts').then((ready) => {
        if (!ready) return;
        fireDeferredClick(xkeenAction);
      });
      return;
    }

    const commandsAction = raw.closest('.command-item, #cores-check-btn, #core-xray-update-btn, #core-mihomo-update-btn');
    if (commandsAction && (!isLazyFeatureReady('commandsList') || !isLazyFeatureReady('coresStatus'))) {
      e.preventDefault();
      e.stopImmediatePropagation();
      Promise.all([
        ensureLazyFeature('commandsList'),
        ensureLazyFeature('coresStatus'),
      ]).then((results) => {
        if (results.every(Boolean)) fireDeferredClick(commandsAction);
      });
      return;
    }

    const backupsHeader = raw.closest('#routing-backups-header');
    if (backupsHeader && !isLazyFeatureReady('backups')) {
      if (consumeReplayFlag(backupsHeader)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      ensureLazyFeature('backups').then((ready) => {
        if (!ready) return;
        try {
          const api = getLazyFeatureApi('backups');
          if (api && typeof api.load === 'function') api.load();
        } catch (err) {}
        replayDeferredClick(backupsHeader);
      });
      return;
    }

    const inboundsTrigger = raw.closest('#inbounds-header, [id^="inbounds-"], [name="inbounds_mode"]');
    if (inboundsTrigger && !isLazyFeatureReady('inbounds')) {
      if (consumeReplayFlag(inboundsTrigger)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const configShell = getSharedConfigShell();
      if (!configShell || typeof configShell.activateInboundsView !== 'function') return;
      Promise.resolve(configShell.activateInboundsView({ reason: 'interaction' })).then((ready) => {
        if (!ready) return;
        replayDeferredClick(inboundsTrigger);
      });
      return;
    }

    const outboundsTrigger = raw.closest('#outbounds-header, [id^="outbounds-"]');
    if (outboundsTrigger && !isLazyFeatureReady('outbounds')) {
      if (consumeReplayFlag(outboundsTrigger)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const configShell = getSharedConfigShell();
      if (!configShell || typeof configShell.activateOutboundsView !== 'function') return;
      Promise.resolve(configShell.activateOutboundsView({ reason: 'interaction' })).then((ready) => {
        if (!ready) return;
        replayDeferredClick(outboundsTrigger);
      });
      return;
    }
  }, true);

  document.addEventListener('change', (e) => {
    const raw = e && e.target && typeof e.target.closest === 'function' ? e.target : null;
    if (!raw) return;

    const xrayControl = raw.closest('#view-xray-logs select, #view-xray-logs input, #view-xray-logs textarea');
    if (xrayControl && !isLazyFeatureReady('xrayLogs')) {
      e.preventDefault();
      e.stopImmediatePropagation();
      ensureLazyFeature('xrayLogs').then((ready) => {
        if (!ready) return;
        replayDeferredEvent(xrayControl, 'change');
      });
    }
  }, true);

  document.addEventListener('input', (e) => {
    const raw = e && e.target && typeof e.target.closest === 'function' ? e.target : null;
    if (!raw) return;

    const xrayInput = raw.closest('#view-xray-logs input, #view-xray-logs textarea');
    if (xrayInput && !isLazyFeatureReady('xrayLogs')) {
      e.preventDefault();
      e.stopImmediatePropagation();
      ensureLazyFeature('xrayLogs').then((ready) => {
        if (!ready) return;
        replayDeferredEvent(xrayInput, 'input');
      });
    }
  }, true);

  if (document.body && document.body.dataset) document.body.dataset.xkLazyFeatureClicks = '1';
}
  // Legacy initializers from main.js were removed. If you add a new module,
  // just extend initModules() below.

  function getEditor(name) {
    try {
      if (window.XKeen && XKeen.state && XKeen.state[name]) return XKeen.state[name];
    } catch (e) {}
    try {
      return window[name];
    } catch (e) {}
    return null;
  }

  const LAST_VIEW_KEY = 'xkeen.panel.last_view.v1';

  function _rememberView(name) {
    try { localStorage.setItem(LAST_VIEW_KEY, String(name || 'routing')); } catch (e) {}
  }

  function _restoreView() {
    try {
      const v = localStorage.getItem(LAST_VIEW_KEY);
      return v ? String(v) : '';
    } catch (e) {
      return '';
    }
  }


  function applyViewRuntime(name) {
    // View-scoped init for heavier modules to avoid doing work (and API calls)
    // on tabs the user never opens.
    if (name === 'mihomo') {
      initViewOnce('mihomo', () => {
        if (window.XKeen && XKeen.features && XKeen.features.mihomoPanel && typeof XKeen.features.mihomoPanel.init === 'function') {
          XKeen.features.mihomoPanel.init();
        }
      }).catch((err) => {
        try { console.error('[XKeen] view init failed:', name, err); } catch (e) {}
      });
    }
    if (name === 'xkeen') {
      initViewOnce('xkeen', async () => {
        const ready = await ensureLazyFeature('xkeenTexts');
        if (!ready) throw new Error('xkeen texts not ready');
      }).catch((err) => {
        try { console.error('[XKeen] view init failed:', name, err); } catch (e) {}
      });
    }
    if (name === 'commands') {
      initViewOnce('commands', async () => {
        const results = await Promise.all([
          ensureLazyFeature('commandsList'),
          ensureLazyFeature('coresStatus'),
        ]);
        if (!results.every(Boolean)) throw new Error('commands view features not ready');
      }).catch((err) => {
        try { console.error('[XKeen] view init failed:', name, err); } catch (e) {}
      });
    }

    if (name === 'routing') {
      initViewOnce('routing', async () => {
        if (!hasXrayCore()) return;
        const configShell = (window.XKeen && XKeen.pages) ? XKeen.pages.configShell : null;
        if (!configShell || typeof configShell.activateRoutingView !== 'function') {
          throw new Error('routing config shell unavailable');
        }
        const ready = await configShell.activateRoutingView({ reason: 'init' });
        if (!ready) throw new Error('routing config shell not ready');
      }).catch((err) => {
        try { console.error('[XKeen] view init failed:', name, err); } catch (e) {}
      });
    }

    // refresh editors when tab becomes visible
    if (name === 'routing') {
      // Monaco can be initialized while hidden (0px) or get a broken layout
      // after switching tabs/pages in some browsers. Give the routing module a
      // chance to relayout/recreate the active engine.
      try {
        const configShell = (window.XKeen && XKeen.pages) ? XKeen.pages.configShell : null;
        if (configShell && typeof configShell.activateRoutingView === 'function') {
          safe(() => configShell.activateRoutingView({ reason: 'tab' }));
        }
      } catch (e) {}
    }

    if (name === 'mihomo') {
      const ed = getEditor('mihomoEditor');
      if (ed && ed.refresh) safe(() => ed.refresh());
    }
    if (name === 'xkeen') {
      ['portProxyingEditor', 'portExcludeEditor', 'ipExcludeEditor'].forEach((k) => {
        const ed = getEditor(k);
        if (ed && ed.refresh) safe(() => ed.refresh());
      });
    }

    // Xray logs are now orchestrated through the shared build-managed logs shell.
    if (name === 'xray-logs') {
      const logsShell = getSharedLogsShell();
      if (logsShell && typeof logsShell.activateView === 'function') {
        Promise.resolve(logsShell.activateView({ reason: 'tab' })).catch((err) => {
          try { console.error('[XKeen] logs shell activate failed', err); } catch (e) {}
        });
      }
    } else {
      const logsShell = getSharedLogsShell();
      if (logsShell && typeof logsShell.deactivateView === 'function') {
        safe(() => logsShell.deactivateView());
      }
    }

    // file manager: lazy-load + init + refresh when tab becomes visible
    if (name === 'files') {
      ensureFileManagerReady().then((ready) => {
        if (!ready) return;
        try {
          const FM = (window.XKeen && XKeen.features && XKeen.features.fileManager) ? XKeen.features.fileManager : null;
          // init.js is the entrypoint and calls FM.init() once.
          if (FM && typeof FM.onShow === 'function') safe(() => FM.onShow());
        } catch (e) {}
      });
    }

    // Ensure body scroll-lock state stays correct when switching tabs.
    // (e.g. when leaving a fullscreen card view).
    try {
      if (window.XKeen && XKeen.ui && XKeen.ui.modal && typeof XKeen.ui.modal.syncBodyScrollLock === 'function') {
        XKeen.ui.modal.syncBodyScrollLock();
      }
    } catch (e) {}
  }

  let _sharedShellViewLifecycleBound = false;
  function bindSharedShellViewLifecycle(sharedShell) {
    if (_sharedShellViewLifecycleBound) return;
    _sharedShellViewLifecycleBound = true;

    document.addEventListener('xkeen:panel-view-changed', (event) => {
      const detail = event && event.detail ? event.detail : {};
      const view = String(detail.view || '');
      if (!view) return;
      applyViewRuntime(view);
    });

    try {
      const current = sharedShell && typeof sharedShell.getCurrentView === 'function'
        ? String(sharedShell.getCurrentView() || '')
        : '';
      if (current) applyViewRuntime(current);
    } catch (e) {}
  }

  function showView(viewName) {
    let name = String(viewName || 'routing');

    const sections = {
      routing: document.getElementById('view-routing'),
      mihomo: document.getElementById('view-mihomo'),
      xkeen: document.getElementById('view-xkeen'),
      'xray-logs': document.getElementById('view-xray-logs'),
      commands: document.getElementById('view-commands'),
      files: document.getElementById('view-files'),
    };

    function isForceHidden(el) {
      try {
        return !!(el && el.dataset && (
          el.dataset.xkForceHidden === '1' ||
          el.dataset.xkHideUnusedHidden === '1'
        ));
      } catch (e) { return false; }
    }

    // If the requested view is not available (e.g. hidden by env whitelist),
    // fall back to the first available one.
    try {
      const requestedEl = sections[name];
      if (!requestedEl || isForceHidden(requestedEl)) {
        const first = Object.keys(sections).find((k) => {
          const el = sections[k];
          return !!(el && !isForceHidden(el));
        });
        name = first || 'routing';
      }
    } catch (e) {}

    // hide/show sections
    Object.entries(sections).forEach(([key, el]) => {
      if (!el) return;
      if (isForceHidden(el)) {
        el.style.display = 'none';
        return;
      }
      el.style.display = key === name ? 'block' : 'none';
    });

    // active tab state (ignore hidden tabs)
    document.querySelectorAll('.top-tab-btn[data-view]').forEach((btn) => {
      const hidden = (btn.style.display === 'none') || isForceHidden(btn);
      btn.classList.toggle('active', !hidden && btn.dataset.view === name);
    });

    // Show the RAW/GUI quick-focus block only on the Xray routing tab.
    try {
      const routingFocusGroup = document.querySelector('.xkeen-ctrl-group-routing-focus');
      if (routingFocusGroup) {
        const isRoutingView = name === 'routing';
        routingFocusGroup.style.display = isRoutingView ? '' : 'none';
        routingFocusGroup.setAttribute('aria-hidden', isRoutingView ? 'false' : 'true');
      }
    } catch (e) {}

    try { _rememberView(name); } catch (e) {}
    applyViewRuntime(name);
  }

  function wireTabs() {
    const buttons = document.querySelectorAll('.top-tab-btn[data-view]');
    buttons.forEach((btn) => {
      if (btn.dataset && btn.dataset.xkeenWiredTabs === '1') return;
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        showView(btn.dataset.view);
      });
      if (btn.dataset) btn.dataset.xkeenWiredTabs = '1';
    });
  }

  function wireExplicitNavigation() {
    const buttons = document.querySelectorAll('[data-nav-href]');
    buttons.forEach((btn) => {
      if (!btn || (btn.dataset && btn.dataset.xkNavWired === '1')) return;
      btn.addEventListener('click', (e) => {
        const href = String((btn.dataset && btn.dataset.navHref) || '').trim();
        if (!href) return;
        e.preventDefault();
        window.location.href = href;
      });
      if (btn.dataset) btn.dataset.xkNavWired = '1';
    });
  }

  function initModules() {
    // The list mirrors README milestones (safe to call even if module absent)
	  // routing/mihomoPanel are initialized lazily when their tabs are opened (see showView).
    safe(() => {
      if (hasXrayCore() && window.XKeen && XKeen.localIO && typeof XKeen.localIO.init === 'function') XKeen.localIO.init();
    });
    safe(() => {
      const hasRestartLogBlock =
        !!document.querySelector('[data-xk-restart-log="1"]') ||
        !!document.getElementById('restart-log');
      if (!hasRestartLogBlock) return;
      ensureLazyFeature('restartLog').catch((err) => {
        try { console.error('[XKeen] restart log feature failed:', err); } catch (e) {}
      });
    });
	  // xkeenTexts/commandsList are initialized lazily when their tabs are opened (see showView).
  }

  function init() {
    if (!isPanelPage()) return;

    // Initialize all modular features
    initModules();

    const sharedShell = getSharedPanelShell();
    if (sharedShell && typeof sharedShell.isInitialized === 'function' && sharedShell.isInitialized()) {
      bindSharedShellViewLifecycle(sharedShell);
      return;
    }

    syncLightweightDonateButtonVisibility();
    ensureHeaderAsyncShellBinding();

    // Tabs (replaces inline onclick="showView(...)")
    wireTabs();
    wireExplicitNavigation();
    wireLazyFeatureClicks();
    startLightweightXkeenStatusPolling();
    startLightweightXrayBadgePolling();

    // Terminal: load heavy xterm+modules only when user opens it
    wireTerminalLazyOpen();

    // Hide the extra terminal button immediately (capabilities-based)
    initTerminalCapabilityButtons();

    // Auto-open terminal from URL (?terminal=pty|shell) without loading terminal scripts on every page load.
    try {
      const url = new URL(window.location.href);
      const mode = String(url.searchParams.get('terminal') || '').toLowerCase();
      if (mode === 'pty' || mode === 'shell') {
        ensureTerminalReady();
      }
    } catch (e) {}

    // Expose the new API + legacy alias (for compatibility)
    window.XKeen = window.XKeen || {};
    XKeen.ui = XKeen.ui || {};
    XKeen.ui.tabs = XKeen.ui.tabs || {};
    XKeen.ui.tabs.show = showView;
    window.showView = showView;

    // Initial view: remember the last opened tab when possible.
    const activeBtn = document.querySelector('.top-tab-btn.active[data-view]') || document.querySelector('.top-tab-btn[data-view]');
    const remembered = _restoreView();
    const initial = remembered || (activeBtn && activeBtn.dataset && activeBtn.dataset.view ? activeBtn.dataset.view : 'routing');
    showView(initial);
    initCoreUiAutoDetect();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

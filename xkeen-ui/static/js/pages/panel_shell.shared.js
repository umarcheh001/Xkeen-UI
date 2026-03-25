// Shared/build panel shell runtime.
//
// Owns the main screen shell lifecycle (header chips, tabs, lightweight status
// polling, lazy click delegation, terminal bootstrapping and view switching)
// while feature-local view activation stays in legacy panel.init.js for gradual
// migration.

import '../ui/sections.js';
import '../ui/last_activity.js';
import '../ui/xk_brand.js';

(() => {
  'use strict';

  window.XKeen = window.XKeen || {};
  const XK = window.XKeen;
  XK.pages = XK.pages || {};

  function isPanelPage() {
    return !!(document.getElementById('view-routing') || document.querySelector('.top-tab-btn[data-view]'));
  }

  function safe(fn) {
    try { return fn(); } catch (e) {
      try { console.error(e); } catch (e2) {}
      return undefined;
    }
  }

  function getCoreHttp() {
    try {
      if (window.XKeen && XKeen.core && XKeen.core.http) return XKeen.core.http;
    } catch (e) {}
    return null;
  }

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
        if (isTerminalReady()) return;
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
        // Keep server-side default button on error.
      });
  }

  function hasXrayCore() {
    try {
      if (typeof window.XKEEN_HAS_XRAY === 'boolean') return !!window.XKEEN_HAS_XRAY;
      const v = String(window.XKEEN_HAS_XRAY || '').toLowerCase();
      if (v) return v === '1' || v === 'true' || v === 'yes' || v === 'on';
    } catch (e) {}
    return true;
  }

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

  let _headerShellLoadingUnsubscribe = null;
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

  const LIGHT_DONATE_HIDE_KEY = 'xkeen_ui_hide_donate';
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

  const LIGHT_XRAY_BADGE_POLL_MS = 10000;
  let _lightXrayBadgeTimer = null;
  let _lightXrayBadgeVisibilityBound = false;

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

  let _lightXkeenShellUnsubscribe = null;
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

    const snapshot = patchUiShellState(patch, Object.assign({ source: 'panel.shell.shared' }, o));

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

  const LIGHT_XKEEN_STATUS_POLL_MS = 15000;
  let _lightXkeenStatusTimer = null;
  let _lightXkeenStatusVisibilityBound = false;

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
    if (!Array.isArray(list)) return [];
    const seen = new Set();
    const out = [];
    list.forEach((item) => {
      const name = String(item || '').trim().toLowerCase();
      if (!name || seen.has(name)) return;
      seen.add(name);
      out.push(name);
    });
    out.sort();
    return out;
  }

  function coreListSignature(list) {
    return normalizeCoreList(list).join(',');
  }

  function getInitialDetectedCores() {
    const raw = Array.isArray(window.XKEEN_DETECTED_CORES) && window.XKEEN_DETECTED_CORES.length
      ? window.XKEEN_DETECTED_CORES
      : window.XKEEN_AVAILABLE_CORES;
    return normalizeCoreList(raw);
  }

  function formatCoreName(name) {
    const value = String(name || '').trim().toLowerCase();
    if (!value) return '';
    if (value === 'mihomo') return 'Mihomo';
    if (value === 'xray') return 'Xray';
    return value;
  }

  function describeCoreUiTopologyChange(prevCores, nextCores) {
    const prev = normalizeCoreList(prevCores);
    const next = normalizeCoreList(nextCores);
    const added = next.filter((name) => prev.indexOf(name) === -1);
    const removed = prev.filter((name) => next.indexOf(name) === -1);

    const parts = [];
    if (added.length) {
      parts.push('добавлены ядра: ' + added.map(formatCoreName).join(', '));
    }
    if (removed.length) {
      parts.push('убраны ядра: ' + removed.map(formatCoreName).join(', '));
    }
    if (!parts.length) {
      return 'Набор доступных ядер изменился.';
    }
    return 'Набор доступных ядер изменился: ' + parts.join('; ') + '.';
  }

  function notifyPanelInfo(message) {
    try {
      if (typeof window.toast === 'function') {
        window.toast({ kind: 'info', message, duration: 6000 });
        return;
      }
    } catch (e) {}
    try {
      console.info('[XKeen]', message);
    } catch (e) {}
  }

  function hasUnsavedPanelChanges() {
    try {
      if (window.XKeen && XKeen.routing && typeof XKeen.routing.hasUnsavedChanges === 'function' && XKeen.routing.hasUnsavedChanges()) {
        return true;
      }
    } catch (e) {}
    try {
      const inbounds = window.XKeen && XKeen.features ? XKeen.features.inbounds : null;
      if (inbounds && typeof inbounds.hasUnsavedChanges === 'function' && inbounds.hasUnsavedChanges()) {
        return true;
      }
    } catch (e) {}
    try {
      const outbounds = window.XKeen && XKeen.features ? XKeen.features.outbounds : null;
      if (outbounds && typeof outbounds.hasUnsavedChanges === 'function' && outbounds.hasUnsavedChanges()) {
        return true;
      }
    } catch (e) {}
    return false;
  }

  let _coreUiTopology = getInitialDetectedCores();
  let _coreUiWatchTimer = null;
  let _coreUiWatchBackoffTimer = null;
  let _coreUiWatchLastFocusTs = 0;

  function getCoreUiRefreshButton() {
    return document.getElementById('panel-core-ui-refresh-btn');
  }

  async function confirmCoreUiManualReload() {
    const message = 'Набор ядер изменился. Обновить панель сейчас?';
    try {
      if (window.XKeen && XKeen.ui && XKeen.ui.confirm && typeof XKeen.ui.confirm.open === 'function') {
        return !!(await XKeen.ui.confirm.open({
          title: 'Обновить панель',
          message,
          confirmText: 'Обновить',
          cancelText: 'Позже',
          kind: 'warning',
        }));
      }
    } catch (e) {}
    return window.confirm(message);
  }

  function revealCoreUiRefreshButton(message) {
    const btn = getCoreUiRefreshButton();
    if (!btn) return;
    btn.classList.remove('hidden');
    btn.title = String(message || 'Обновить панель после изменения набора ядер.');
  }

  function reloadPanelForCoreUiChange(message) {
    if (message) notifyPanelInfo(message);
    try {
      window.location.reload();
    } catch (e) {}
  }

  function deferCoreUiReload(message, nextCores) {
    _coreUiTopology = normalizeCoreList(nextCores);
    revealCoreUiRefreshButton(message);
    if (message) notifyPanelInfo(message + ' Сначала сохраните изменения, затем обновите панель.');
  }

  function parseDetectedCoresFromPayload(data) {
    if (!data || typeof data !== 'object') return [];
    if (Array.isArray(data.detected_cores)) return normalizeCoreList(data.detected_cores);
    if (Array.isArray(data.available_cores)) return normalizeCoreList(data.available_cores);
    if (Array.isArray(data.cores)) return normalizeCoreList(data.cores);
    return [];
  }

  async function fetchDetectedCores() {
    try {
      const http = getCoreHttp();
      if (http && typeof http.fetchJSON === 'function') {
        const data = await http.fetchJSON('/api/xkeen/core', {
          method: 'GET',
          timeoutMs: 6000,
          retry: 1,
        }).catch(() => null);
        return parseDetectedCoresFromPayload(data);
      }
    } catch (e) {}

    const res = await fetch('/api/xkeen/core', { cache: 'no-store' });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error('cores status http error: ' + res.status);
    }
    return parseDetectedCoresFromPayload(data);
  }

  function scheduleCoreUiWatch(delayMs) {
    const timeout = Math.max(0, Number(delayMs) || 0);
    if (_coreUiWatchTimer) {
      try { clearTimeout(_coreUiWatchTimer); } catch (e) {}
    }
    _coreUiWatchTimer = setTimeout(() => {
      _coreUiWatchTimer = null;
      void checkCoreUiTopology('timer');
    }, timeout);
  }

  async function handleCoreUiTopologyChange(prevCores, nextCores) {
    const message = describeCoreUiTopologyChange(prevCores, nextCores);
    if (hasUnsavedPanelChanges()) {
      deferCoreUiReload(message, nextCores);
      return;
    }

    const shouldReload = await confirmCoreUiManualReload().catch(() => false);
    if (shouldReload) {
      reloadPanelForCoreUiChange(message);
      return;
    }

    deferCoreUiReload(message, nextCores);
  }

  async function checkCoreUiTopology(reason) {
    try {
      if (document.visibilityState === 'hidden') {
        scheduleCoreUiWatch(CORE_UI_WATCH_HIDDEN_POLL_MS);
        return;
      }
    } catch (e) {}

    try {
      const nextCores = await fetchDetectedCores();
      const prevSig = coreListSignature(_coreUiTopology);
      const nextSig = coreListSignature(nextCores);
      if (nextSig && prevSig && nextSig !== prevSig) {
        await handleCoreUiTopologyChange(_coreUiTopology, nextCores);
      } else if (nextSig) {
        _coreUiTopology = normalizeCoreList(nextCores);
      }
      scheduleCoreUiWatch(CORE_UI_WATCH_POLL_MS);
    } catch (e) {
      scheduleCoreUiWatch(CORE_UI_WATCH_ERROR_BACKOFF_MS);
    }

    try {
      _coreUiWatchLastFocusTs = Date.now();
    } catch (e) {}
  }

  function wireCoreUiRefreshButton() {
    const btn = getCoreUiRefreshButton();
    if (!btn || (btn.dataset && btn.dataset.xkCoreUiReloadWired === '1')) return;
    btn.addEventListener('click', () => {
      const title = String(btn.title || '').trim();
      reloadPanelForCoreUiChange(title || 'Обновляем панель после изменения набора ядер.');
    });
    if (btn.dataset) btn.dataset.xkCoreUiReloadWired = '1';
  }

  function initCoreUiAutoDetect() {
    wireCoreUiRefreshButton();
    scheduleCoreUiWatch(CORE_UI_WATCH_INITIAL_DELAY_MS);
    document.addEventListener('visibilitychange', () => {
      try {
        if (document.visibilityState !== 'visible') return;
        const now = Date.now();
        if (now - _coreUiWatchLastFocusTs < CORE_UI_WATCH_FOCUS_COOLDOWN_MS) return;
      } catch (e) {}
      scheduleCoreUiWatch(0);
    });
  }

  function getLazyFeatureApi(name) {
    const api = getLazyRuntimeApi();
    return (api && typeof api.getFeatureApi === 'function')
      ? api.getFeatureApi(name)
      : null;
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
        ensureLazyFeature('inbounds').then((ready) => {
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
        ensureLazyFeature('outbounds').then((ready) => {
          if (!ready) return;
          replayDeferredClick(outboundsTrigger);
        });
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

  const LAST_VIEW_KEY = 'xkeen.panel.last_view.v1';
  let _currentView = '';
  let _initialized = false;

  function rememberView(name) {
    try { localStorage.setItem(LAST_VIEW_KEY, String(name || 'routing')); } catch (e) {}
  }

  function restoreView() {
    try {
      const v = localStorage.getItem(LAST_VIEW_KEY);
      return v ? String(v) : '';
    } catch (e) {
      return '';
    }
  }

  function getSections() {
    return {
      routing: document.getElementById('view-routing'),
      mihomo: document.getElementById('view-mihomo'),
      xkeen: document.getElementById('view-xkeen'),
      'xray-logs': document.getElementById('view-xray-logs'),
      commands: document.getElementById('view-commands'),
      files: document.getElementById('view-files'),
    };
  }

  function isForceHidden(el) {
    try {
      return !!(el && el.dataset && (
        el.dataset.xkForceHidden === '1' ||
        el.dataset.xkHideUnusedHidden === '1'
      ));
    } catch (e) {
      return false;
    }
  }

  function normalizeRequestedView(viewName) {
    let name = String(viewName || 'routing');
    const sections = getSections();
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
    return name;
  }

  function applyShellView(name) {
    const sections = getSections();

    Object.entries(sections).forEach(([key, el]) => {
      if (!el) return;
      if (isForceHidden(el)) {
        el.style.display = 'none';
        return;
      }
      el.style.display = key === name ? 'block' : 'none';
    });

    document.querySelectorAll('.top-tab-btn[data-view]').forEach((btn) => {
      const hidden = (btn.style.display === 'none') || isForceHidden(btn);
      btn.classList.toggle('active', !hidden && btn.dataset.view === name);
    });

    try {
      const routingFocusGroup = document.querySelector('.xkeen-ctrl-group-routing-focus');
      if (routingFocusGroup) {
        const isRoutingView = name === 'routing';
        routingFocusGroup.style.display = isRoutingView ? '' : 'none';
        routingFocusGroup.setAttribute('aria-hidden', isRoutingView ? 'false' : 'true');
      }
    } catch (e) {}

    try { rememberView(name); } catch (e) {}
  }

  function emitViewChanged(nextView, prevView) {
    try {
      document.dispatchEvent(new CustomEvent('xkeen:panel-view-changed', {
        detail: {
          view: String(nextView || ''),
          previousView: String(prevView || ''),
          source: 'panel_shell.shared',
        },
      }));
    } catch (e) {}
  }

  function showView(viewName) {
    const nextView = normalizeRequestedView(viewName);
    const prevView = _currentView;
    applyShellView(nextView);
    _currentView = nextView;
    emitViewChanged(nextView, prevView);
    return nextView;
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

  function init() {
    if (_initialized || !isPanelPage()) return false;
    _initialized = true;

    syncLightweightDonateButtonVisibility();
    ensureHeaderAsyncShellBinding();
    wireTabs();
    wireExplicitNavigation();
    wireLazyFeatureClicks();
    startLightweightXkeenStatusPolling();
    startLightweightXrayBadgePolling();
    wireTerminalLazyOpen();
    initTerminalCapabilityButtons();

    try {
      const url = new URL(window.location.href);
      const mode = String(url.searchParams.get('terminal') || '').toLowerCase();
      if (mode === 'pty' || mode === 'shell') {
        ensureTerminalReady();
      }
    } catch (e) {}

    XK.ui = XK.ui || {};
    XK.ui.tabs = XK.ui.tabs || {};
    XK.ui.tabs.show = showView;
    window.showView = showView;

    const activeBtn = document.querySelector('.top-tab-btn.active[data-view]') || document.querySelector('.top-tab-btn[data-view]');
    const remembered = restoreView();
    const initial = remembered || (activeBtn && activeBtn.dataset && activeBtn.dataset.view ? activeBtn.dataset.view : 'routing');
    showView(initial);
    initCoreUiAutoDetect();
    return true;
  }

  function getCurrentView() {
    if (_currentView) return _currentView;
    const active = document.querySelector('.top-tab-btn.active[data-view]');
    return active && active.dataset ? String(active.dataset.view || '') : '';
  }

  const api = {
    init,
    showView,
    getCurrentView,
    isInitialized() {
      return _initialized;
    },
  };

  XK.pages.panelShell = api;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      api.init();
    }, { once: true });
  } else {
    api.init();
  }
})();

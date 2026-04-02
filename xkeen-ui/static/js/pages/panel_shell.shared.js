// Shared/build panel shell runtime.
//
// Owns the main screen shell lifecycle (header chips, tabs, lightweight status
// polling, lazy click delegation, terminal bootstrapping and view switching)
// while feature-local view activation stays in legacy panel.init.js for gradual
// migration.

import '../ui/sections.js';
import '../ui/last_activity.js';
import '../ui/xk_brand.js';
import {
  ensurePanelTerminalReady,
  wirePanelTerminalLazyOpen,
  initPanelTerminalCapabilityButtons,
  wirePanelLazyFeatureClicks,
} from './panel.lazy_bindings.runtime.js';
import { getLogsShellApi } from './logs_shell.shared.js';
import { initPanelCoreUiAutoDetect } from './panel.core_ui_watch.runtime.js';
import { getServiceStatusApi } from '../features/service_status.js';
import {
  ensureXkeenUiBucket,
  getXkeenCoreHttpApi,
  getXkeenPageApi,
  getXkeenUiShellApi,
  hasXkeenXrayCore,
  publishXkeenPageApi,
} from '../features/xkeen_runtime.js';

(() => {
  'use strict';

  function isPanelPage() {
    return !!(document.getElementById('view-routing') || document.querySelector('.top-tab-btn[data-view]'));
  }

  function getCoreHttp() {
    return getXkeenCoreHttpApi();
  }

  function hasXrayCore() {
    return hasXkeenXrayCore();
  }

  function getUiShellApi() {
    return getXkeenUiShellApi();
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
    const lvl = String(level || '').trim().toLowerCase();
    const title = (st === 'on')
      ? ((lvl && lvl !== 'none')
        ? ('Логи Xray включены (loglevel=' + lvl + ').')
        : 'Логи Xray включены.')
      : 'Логи Xray выключены.';

    badge.dataset.state = st;
    badge.dataset.level = lvl || 'none';
    badge.dataset.live = 'off';
    badge.title = title;
    try { badge.setAttribute('aria-label', title); } catch (e) {}
  }

  function hasLoadedXrayLogsFeature() {
    try {
      const api = getLogsShellApi();
      return !!(api && typeof api.isReady === 'function' && api.isReady());
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
      const api = getServiceStatusApi();
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
    wirePanelLazyFeatureClicks();
    startLightweightXkeenStatusPolling();
    startLightweightXrayBadgePolling();
    wirePanelTerminalLazyOpen();
    initPanelTerminalCapabilityButtons();

    try {
      const url = new URL(window.location.href);
      const mode = String(url.searchParams.get('terminal') || '').toLowerCase();
      if (mode === 'pty' || mode === 'shell') {
        ensurePanelTerminalReady();
      }
    } catch (e) {}

    const tabsApi = ensureXkeenUiBucket('tabs');
    if (tabsApi) tabsApi.show = showView;
    window.showView = showView;

    const activeBtn = document.querySelector('.top-tab-btn.active[data-view]') || document.querySelector('.top-tab-btn[data-view]');
    const remembered = restoreView();
    const initial = remembered || (activeBtn && activeBtn.dataset && activeBtn.dataset.view ? activeBtn.dataset.view : 'routing');
    showView(initial);
    initPanelCoreUiAutoDetect();
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

  publishXkeenPageApi('panelShell', api);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      api.init();
    }, { once: true });
  } else {
    api.init();
  }
})();


export function getPanelShellApi() {
  try {
    const api = getXkeenPageApi('panelShell');
    return api && typeof api.showView === 'function' ? api : null;
  } catch (error) {
    console.error(error);
    return null;
  }
}

function callPanelShellApi(method, ...args) {
  const api = getPanelShellApi();
  if (!api || typeof api[method] !== 'function') return null;
  return api[method](...args);
}

export function initPanelShell(...args) {
  return callPanelShellApi('init', ...args);
}

export function showPanelShellView(...args) {
  return callPanelShellApi('showView', ...args);
}

export function getCurrentPanelShellView(...args) {
  return callPanelShellApi('getCurrentView', ...args);
}

export function isPanelShellInitialized(...args) {
  return !!callPanelShellApi('isInitialized', ...args);
}

export const panelShellApi = Object.freeze({
  get: getPanelShellApi,
  init: initPanelShell,
  showView: showPanelShellView,
  getCurrentView: getCurrentPanelShellView,
  isInitialized: isPanelShellInitialized,
});

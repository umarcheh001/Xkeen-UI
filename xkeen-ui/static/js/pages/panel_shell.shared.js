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
  ensurePanelLazyFeature,
  getPanelLazyFeatureApi,
  ensurePanelTerminalReady,
  wirePanelTerminalLazyOpen,
  initPanelTerminalCapabilityButtons,
  wirePanelLazyFeatureClicks,
} from './panel.lazy_bindings.runtime.js';
import { appendTerminalDebug } from '../features/terminal_debug.js';
import { getLogsShellApi } from './logs_shell.shared.js';
import { initPanelCoreUiAutoDetect } from './panel.core_ui_watch.runtime.js';
import { getServiceStatusApi } from '../features/service_status.js';
import { getRoutingCardsNamespace } from '../features/routing_cards_namespace.js';
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

  function getRoutingCardsNamespaceApi() {
    try {
      return getRoutingCardsNamespace();
    } catch (error) {}
    return null;
  }

  function getRoutingCardsFeatureApi() {
    const namespaceApi = getRoutingCardsNamespaceApi();
    return namespaceApi && typeof namespaceApi === 'object' ? namespaceApi : null;
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
    if (nextView === 'routing') {
      try { scheduleRoutingInteractionRecovery(); } catch (e) {}
    }
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

  function runRoutingCardOpenCallback(kind) {
    const key = String(kind || '').trim();
    if (!key) return;

    try {
      const routingCards = getRoutingCardsFeatureApi();

      if (key === 'dat') {
        try { initRoutingDatActionsFallback(); } catch (error) {}
        const refreshDat = routingCards && routingCards.dat && routingCards.dat.card && typeof routingCards.dat.card.refreshDatMeta === 'function'
          ? routingCards.dat.card.refreshDatMeta
          : null;
        if (refreshDat) refreshDat();
        else refreshRoutingDatFallback();
        return;
      }

      if (key === 'rules') {
        const renderRules = routingCards && routingCards.rules && routingCards.rules.controls && typeof routingCards.rules.controls.renderFromEditor === 'function'
          ? routingCards.rules.controls.renderFromEditor
          : null;
        if (renderRules) renderRules({ setError: false });
        return;
      }

      if (key === 'backups') {
        const backups = getPanelLazyFeatureApi('backups');
        if (backups && typeof backups.load === 'function') {
          backups.load();
          return;
        }
        ensurePanelLazyFeature('backups').then((ready) => {
          if (!ready) return;
          const lazyBackups = getPanelLazyFeatureApi('backups');
          if (lazyBackups && typeof lazyBackups.load === 'function') lazyBackups.load();
        }).catch(() => {});
      }
    } catch (error) {}
  }

  function ensureRoutingCollapseFallback(headerId, bodyId, arrowId, storageKey, defaultOpen, onOpenKind) {
    const header = document.getElementById(headerId);
    const body = document.getElementById(bodyId);
    const arrow = document.getElementById(arrowId);
    if (!header || !body || !arrow) return;

    try {
      if (header.dataset && header.dataset.xkCollapseWired === '1') return;
    } catch (error) {}

    const prefKey = String(storageKey || '').trim();
    let open = !!defaultOpen;
    if (prefKey) {
      try {
        const raw = localStorage.getItem(prefKey);
        if (raw === '1') open = true;
        if (raw === '0') open = false;
      } catch (error) {}
    }

    function apply() {
      try { body.style.display = open ? '' : 'none'; } catch (error) {}
      try { arrow.textContent = open ? '▲' : '▼'; } catch (error) {}
      try { header.setAttribute('role', 'button'); } catch (error) {}
      try { header.setAttribute('tabindex', header.getAttribute('tabindex') || '0'); } catch (error) {}
      try { header.setAttribute('aria-controls', bodyId); } catch (error) {}
      try { header.setAttribute('aria-expanded', open ? 'true' : 'false'); } catch (error) {}
      try {
        if (header.dataset) {
          header.dataset.xkCollapseWired = '1';
          header.dataset.xkCollapseOpen = open ? '1' : '0';
          header.dataset.xkCollapseBody = bodyId;
          header.dataset.xkCollapseArrow = arrowId;
          header.dataset.xkCollapseStorage = prefKey;
        }
      } catch (error) {}
    }

    function sync(openReason) {
      apply();
      if (open) runRoutingCardOpenCallback(onOpenKind || openReason || '');
    }

    function toggle() {
      open = !open;
      if (prefKey) {
        try { localStorage.setItem(prefKey, open ? '1' : '0'); } catch (error) {}
      }
      sync('toggle');
    }

    const onKeyToggle = (event) => {
      const key = String(event && event.key || '');
      if (key !== 'Enter' && key !== ' ') return;
      try { event.preventDefault(); } catch (error) {}
      toggle();
    };

    header.addEventListener('click', toggle);
    header.addEventListener('keydown', onKeyToggle);
    sync('initial');
  }

  function toastPanelShell(message, kind) {
    const msg = String(message || '').trim();
    if (!msg) return;
    try {
      if (typeof window.toast === 'function') {
        window.toast(msg, kind === 'error' ? 'error' : 'info');
        return;
      }
    } catch (error) {}
    try {
      if (kind === 'error') console.error('[XKeen]', msg);
      else console.log('[XKeen]', msg);
    } catch (error) {}
  }

  function datFallbackMatch(kind, name) {
    const k = String(kind || '').toLowerCase();
    const n = String(name || '').toLowerCase();
    if (!n || !n.endsWith('.dat')) return false;
    if (k === 'geosite') return n.startsWith('geosite') || n === 'zkeen.dat' || n === 'geosite_zkeen.dat';
    if (k === 'geoip') return n.startsWith('geoip') || n === 'zkeenip.dat' || n === 'geoip_zkeenip.dat';
    return false;
  }

  function getRoutingDatRefs(kind) {
    const k = String(kind || '').toLowerCase() === 'geoip' ? 'geoip' : 'geosite';
    const prefix = 'routing-dat-' + k;
    return {
      kind: k,
      dir: document.getElementById(prefix + '-dir'),
      name: document.getElementById(prefix + '-name'),
      url: document.getElementById(prefix + '-url'),
      file: document.getElementById(prefix + '-file'),
      meta: document.getElementById(prefix + '-meta'),
      browse: document.getElementById(prefix + '-browse'),
      found: document.getElementById(prefix + '-found'),
      upload: document.getElementById(prefix + '-upload-btn'),
      update: document.getElementById(prefix + '-update-btn'),
      download: document.getElementById(prefix + '-download-btn'),
      content: document.getElementById(prefix + '-content-btn'),
    };
  }

  function getRoutingDatPath(refs) {
    const dir = String(refs && refs.dir && refs.dir.value || '').trim().replace(/\/+$/g, '');
    const name = String(refs && refs.name && refs.name.value || '').trim().replace(/^\/+/, '');
    if (!dir) return name ? ('/' + name) : '';
    if (!name) return dir;
    return dir + '/' + name;
  }


  function hasModernRoutingDatFeature() {
    try {
      const routingCards = getRoutingCardsFeatureApi();
      return !!(
        routingCards &&
        routingCards.dat &&
        routingCards.dat.card &&
        typeof routingCards.dat.card.initDatCard === 'function' &&
        typeof routingCards.dat.card.refreshDatMeta === 'function'
      );
    } catch (error) {
      return false;
    }
  }

  function isCurrentRoutingDatCardWired() {
    try {
      const datBody = document.getElementById('routing-dat-body');
      return !!(datBody && datBody.dataset && datBody.dataset.xkDatCardWired === '1');
    } catch (error) {
      return false;
    }
  }

  function ensureModernRoutingDatCardReady() {
    if (!hasModernRoutingDatFeature()) return false;
    if (isCurrentRoutingDatCardWired()) return true;

    try {
      const routingCards = getRoutingCardsFeatureApi();
      const initDatCard = routingCards && routingCards.dat && routingCards.dat.card && typeof routingCards.dat.card.initDatCard === 'function'
        ? routingCards.dat.card.initDatCard
        : null;
      if (initDatCard) initDatCard();
    } catch (error) {}

    return isCurrentRoutingDatCardWired();
  }

  async function confirmPanelShell(opts) {
    const o = opts || {};
    try {
      if (typeof window.confirmModal === 'function') {
        return !!(await window.confirmModal(o));
      }
    } catch (error) {}
    return !!window.confirm(String(o.message || o.title || 'Подтвердите действие'));
  }

  async function listRoutingDatEntries(kind, dir) {
    const path = String(dir || '').trim();
    if (!path) return [];
    try {
      const response = await fetch('/api/fs/list?target=local&path=' + encodeURIComponent(path), { cache: 'no-store' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data || data.ok === false) return [];
      const items = Array.isArray(data.items) ? data.items : [];
      return items.filter((item) => {
        const type = String(item && item.type || '');
        const name = String(item && item.name || '');
        if (type !== 'file' && type !== 'link') return false;
        return datFallbackMatch(kind, name);
      });
    } catch (error) {
      return [];
    }
  }

  function renderRoutingDatFallbackList(kind, refs, entries) {
    const found = refs && refs.found ? refs.found : null;
    if (!found) return;
    const list = Array.isArray(entries) ? entries.slice() : [];
    try {
      found.innerHTML = '';
      if (!list.length) {
        found.textContent = '— нет .dat';
        return;
      }
      const current = String(refs && refs.name && refs.name.value || '').trim().toLowerCase();
      list.sort((a, b) => String(a && a.name || '').localeCompare(String(b && b.name || '')));
      list.forEach((item) => {
        const name = String(item && item.name || '').trim();
        if (!name) return;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'routing-dat-found-item' + (name.toLowerCase() === current ? ' is-current' : '');
        const nameSpan = document.createElement('span');
        nameSpan.className = 'routing-dat-found-name';
        nameSpan.textContent = name;
        const metaSpan = document.createElement('span');
        metaSpan.className = 'routing-dat-found-meta';
        const size = Number(item && item.size || 0);
        const bits = [];
        if (size > 0) bits.push(size >= 1024 ? (size / 1024 / 1024 >= 1 ? (size / 1024 / 1024).toFixed(1) + ' MB' : (size / 1024).toFixed(1) + ' KB') : (size + ' B'));
        if (item && item.mtime) {
          try { bits.push(new Date(Number(item.mtime) * 1000).toLocaleString()); } catch (error) {}
        }
        metaSpan.textContent = bits.join(' • ');
        btn.appendChild(nameSpan);
        btn.appendChild(metaSpan);
        btn.addEventListener('click', () => {
          try {
            if (refs && refs.name) {
              refs.name.value = name;
              refs.name.dispatchEvent(new Event('input', { bubbles: true }));
              refs.name.dispatchEvent(new Event('change', { bubbles: true }));
            }
          } catch (error) {}
          try { found.parentElement && found.parentElement.classList.remove('is-open'); } catch (error) {}
          try { refreshRoutingDatFallback(); } catch (error) {}
        });
        found.appendChild(btn);
      });
    } catch (error) {}
  }

  async function refreshRoutingDatFallback() {
    try {
      const routingCards = getRoutingCardsFeatureApi();
      const refreshDat = routingCards && routingCards.dat && routingCards.dat.card && typeof routingCards.dat.card.refreshDatMeta === 'function'
        ? routingCards.dat.card.refreshDatMeta
        : null;
      if (refreshDat) {
        const result = refreshDat();
        if (result && typeof result.then === 'function') await result;
        return true;
      }
    } catch (error) {}

    const status = document.getElementById('routing-dat-status');
    const refsList = [getRoutingDatRefs('geosite'), getRoutingDatRefs('geoip')];
    try {
      if (status) status.textContent = 'Проверка…';
      for (const refs of refsList) {
        const path = getRoutingDatPath(refs);
        if (!refs || !refs.meta) continue;
        if (!path) {
          refs.meta.textContent = '—';
          continue;
        }
        try {
          const response = await fetch('/api/fs/stat-batch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ target: 'local', paths: [path] }),
          });
          const data = await response.json().catch(() => ({}));
          const item = data && data.results && data.results[path] ? data.results[path] : null;
          if (!response.ok || !item || item.ok === false || item.exists === false) {
            refs.meta.textContent = 'не найден';
          } else {
            const bits = [];
            if (Number(item.size || 0) > 0) bits.push(Number(item.size) >= 1024 ? (Number(item.size) / 1024 / 1024 >= 1 ? (Number(item.size) / 1024 / 1024).toFixed(1) + ' MB' : (Number(item.size) / 1024).toFixed(1) + ' KB') : (String(item.size) + ' B'));
            if (item.mtime) {
              try { bits.push(new Date(Number(item.mtime) * 1000).toLocaleString()); } catch (error) {}
            }
            refs.meta.textContent = bits.join(' • ') || 'OK';
          }
        } catch (error) {
          refs.meta.textContent = '—';
        }
      }

      try {
        const response = await fetch('/api/routing/geodat/status', { cache: 'no-store' });
        const data = await response.json().catch(() => ({}));
        if (status) {
          const installed = !!(data && (data.installed === true || (data.ok === true && data.installed)));
          status.textContent = installed ? 'OK • xk-geodat: ✓' : 'OK • xk-geodat: ✕';
        }
      } catch (error) {
        if (status) status.textContent = 'OK';
      }
      return true;
    } catch (error) {
      if (status) status.textContent = 'Ошибка';
      return false;
    }
  }

  async function openRoutingDatContentsFallback(kind) {
    try {
      const lazy = window.XKeen && window.XKeen.runtime ? window.XKeen.runtime.lazy : null;
      if (lazy && typeof lazy.ensureFeature === 'function') {
        await lazy.ensureFeature('datContents');
      }
    } catch (error) {}

    try {
      if (window.XKeen && window.XKeen.ui && window.XKeen.ui.datContents && typeof window.XKeen.ui.datContents.open === 'function') {
        window.XKeen.ui.datContents.open(String(kind || 'geosite'));
        return true;
      }
    } catch (error) {}

    toastPanelShell('Модуль просмотра содержимого DAT не загрузился.', 'error');
    return false;
  }

  function bindRoutingDatFallbackButton(button, key, handler) {
    if (!button) return;
    try {
      const dataKey = 'xkDatFallback' + String(key || 'Bound');
      if (button.dataset && button.dataset[dataKey] === '1') return;
      button.addEventListener('click', (event) => {
        if (ensureModernRoutingDatCardReady()) return;
        try { event.preventDefault(); } catch (error) {}
        try { handler(event); } catch (error) { toastPanelShell(String(error && error.message || error || 'DAT action failed'), 'error'); }
      });
      if (button.dataset) button.dataset[dataKey] = '1';
    } catch (error) {}
  }

  function initRoutingDatActionsFallback() {
    const datBody = document.getElementById('routing-dat-body');
    if (!datBody) return;
    if (ensureModernRoutingDatCardReady()) return;

    const refreshBtn = document.getElementById('routing-dat-refresh-btn');
    bindRoutingDatFallbackButton(refreshBtn, 'RefreshBound', () => { void refreshRoutingDatFallback(); });

    const installBtn = document.getElementById('routing-dat-geodat-install-btn');
    bindRoutingDatFallbackButton(installBtn, 'InstallBound', async () => {
      const ok = await confirmPanelShell({
        title: 'Установка xk-geodat',
        message: 'Установить/обновить xk-geodat? Это включит просмотр содержимого DAT.',
        okText: 'Установить',
        cancelText: 'Отмена',
      });
      if (!ok) return;
      const response = await fetch('/api/routing/geodat/install', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data || data.ok === false) throw new Error(String((data && (data.hint || data.error || data.message)) || 'install_failed'));
      toastPanelShell(data && data.installed ? 'xk-geodat установлен.' : 'xk-geodat: команда выполнена.');
      await refreshRoutingDatFallback();
    });

    const installFileBtn = document.getElementById('routing-dat-geodat-install-file-btn');
    const installFileInput = document.getElementById('routing-dat-geodat-install-file');
    bindRoutingDatFallbackButton(installFileBtn, 'InstallFileBound', () => {
      if (!installFileInput) return;
      try { installFileInput.value = ''; } catch (error) {}
      installFileInput.click();
    });
    if (installFileInput && !(installFileInput.dataset && installFileInput.dataset.xkDatFallbackChange === '1')) {
      installFileInput.addEventListener('change', async () => {
        if (ensureModernRoutingDatCardReady()) return;
        try {
          const file = installFileInput.files && installFileInput.files[0];
          if (!file) return;
          const ok = await confirmPanelShell({ title: 'Установка xk-geodat', message: 'Установить xk-geodat из файла ' + String(file.name || '') + '?' });
          if (!ok) return;
          const fd = new FormData();
          fd.append('file', file);
          const response = await fetch('/api/routing/geodat/install', { method: 'POST', body: fd });
          const data = await response.json().catch(() => ({}));
          if (!response.ok || !data || data.ok === false) throw new Error(String((data && (data.hint || data.error || data.message)) || 'install_failed'));
          toastPanelShell(data && data.installed ? 'xk-geodat установлен.' : 'xk-geodat: команда выполнена.');
          await refreshRoutingDatFallback();
        } catch (error) {
          toastPanelShell(String(error && error.message || error || 'install_failed'), 'error');
        }
      });
      if (installFileInput.dataset) installFileInput.dataset.xkDatFallbackChange = '1';
    }

    ['geosite', 'geoip'].forEach((kind) => {
      const refs = getRoutingDatRefs(kind);
      if (!refs) return;

      bindRoutingDatFallbackButton(refs.download, 'Download' + kind, () => {
        const path = getRoutingDatPath(refs);
        if (!path) {
          toastPanelShell('Не указан путь к DAT-файлу.', 'error');
          return;
        }
        window.open('/api/fs/download?target=local&path=' + encodeURIComponent(path), '_blank');
      });

      bindRoutingDatFallbackButton(refs.update, 'Update' + kind, async () => {
        const path = getRoutingDatPath(refs);
        const url = String(refs.url && refs.url.value || '').trim();
        if (!path) throw new Error('Не указан путь к DAT-файлу.');
        if (!/^https?:\/\//i.test(url)) throw new Error('Укажите корректный URL (http/https).');
        const ok = await confirmPanelShell({ title: 'Update DAT by URL', message: 'Скачать ' + kind + ' из URL и заменить файл?\n\n' + url + '\n→ ' + path, danger: true });
        if (!ok) return;
        const response = await fetch('/api/routing/dat/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind, url, path }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data || data.ok === false) throw new Error(String((data && (data.error || data.message)) || 'update_failed'));
        toastPanelShell('DAT обновлён: ' + path);
        await refreshRoutingDatFallback();
      });

      bindRoutingDatFallbackButton(refs.content, 'Content' + kind, () => { void openRoutingDatContentsFallback(kind); });

      bindRoutingDatFallbackButton(refs.upload, 'Upload' + kind, () => {
        if (!refs.file) return;
        try { refs.file.value = ''; } catch (error) {}
        refs.file.click();
      });
      if (refs.file && !(refs.file.dataset && refs.file.dataset.xkDatFallbackChange === '1')) {
        refs.file.addEventListener('change', async () => {
          if (ensureModernRoutingDatCardReady()) return;
          try {
            const file = refs.file.files && refs.file.files[0];
            const path = getRoutingDatPath(refs);
            if (!file || !path) return;
            const ok = await confirmPanelShell({ title: 'Upload DAT', message: 'Загрузить файл ' + String(file.name || '') + ' в ' + path + '?' });
            if (!ok) return;
            let response = await fetch('/api/fs/upload?target=local&path=' + encodeURIComponent(path), { method: 'POST', body: (() => { const fd = new FormData(); fd.append('file', file); return fd; })() });
            let data = await response.json().catch(() => ({}));
            if (response && response.status === 409) {
              const overwrite = await confirmPanelShell({ title: 'Файл уже существует', message: 'Файл ' + path + ' уже существует. Перезаписать?', danger: true });
              if (!overwrite) return;
              response = await fetch('/api/fs/upload?target=local&path=' + encodeURIComponent(path) + '&overwrite=1', { method: 'POST', body: (() => { const fd = new FormData(); fd.append('file', file); return fd; })() });
              data = await response.json().catch(() => ({}));
            }
            if (!response.ok || !data || data.ok === false) throw new Error(String((data && (data.error || data.message)) || 'upload_failed'));
            toastPanelShell('DAT загружен: ' + path);
            await refreshRoutingDatFallback();
          } catch (error) {
            toastPanelShell(String(error && error.message || error || 'upload_failed'), 'error');
          }
        });
        if (refs.file.dataset) refs.file.dataset.xkDatFallbackChange = '1';
      }

      bindRoutingDatFallbackButton(refs.browse, 'Browse' + kind, async (event) => {
        try { event.stopPropagation(); } catch (error) {}
        const entries = await listRoutingDatEntries(kind, refs.dir && refs.dir.value);
        renderRoutingDatFallbackList(kind, refs, entries);
        try {
          const root = refs.browse && typeof refs.browse.closest === 'function' ? refs.browse.closest('.routing-dat-combo') : null;
          if (root) root.classList.toggle('is-open');
        } catch (error) {}
      });
    });
  }

  function initRoutingCollapseFallbacks() {
    if (!document.getElementById('view-routing')) return;

    ensureRoutingCollapseFallback('routing-dat-header', 'routing-dat-body', 'routing-dat-arrow', 'xk.routing.dat.open.v3', false, 'dat');
    ensureRoutingCollapseFallback('routing-backups-header', 'routing-backups-body', 'routing-backups-arrow', 'xk.routing.backups.open.v1', false, 'backups');
    ensureRoutingCollapseFallback('routing-help-header', 'routing-help-body', 'routing-help-arrow', 'xk.routing.help.open.v1', false, 'help');
    ensureRoutingCollapseFallback('routing-rules-header', 'routing-rules-body', 'routing-rules-arrow', 'xk.routing.rules.open.v2', false, 'rules');
  }

  function refreshOpenRoutingCards() {
    const items = [
      { headerId: 'routing-dat-header', kind: 'dat' },
      { headerId: 'routing-backups-header', kind: 'backups' },
      { headerId: 'routing-rules-header', kind: 'rules' },
    ];

    items.forEach(({ headerId, kind }) => {
      const header = document.getElementById(headerId);
      if (!header) return;
      let isOpen = false;
      try {
        isOpen = !!(header.dataset && header.dataset.xkCollapseOpen === '1');
      } catch (error) {}
      if (!isOpen) return;
      runRoutingCardOpenCallback(kind);
    });
  }

  function scheduleRoutingInteractionRecovery() {
    if (!document.getElementById('view-routing')) return;

    const run = () => {
      try { initRoutingCollapseFallbacks(); } catch (error) {}
      try { initRoutingDatActionsFallback(); } catch (error) {}
      try { refreshOpenRoutingCards(); } catch (error) {}
    };

    run();
    try { setTimeout(run, 0); } catch (error) {}
    try { setTimeout(run, 160); } catch (error) {}
    try { setTimeout(run, 420); } catch (error) {}
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
    scheduleRoutingInteractionRecovery();
    wirePanelTerminalLazyOpen();
    initPanelTerminalCapabilityButtons();

    try {
      const url = new URL(window.location.href);
      const mode = String(url.searchParams.get('terminal') || '').toLowerCase();
      if (mode === 'pty' || mode === 'shell') {
        appendTerminalDebug('panel:auto-open-request', { mode: mode });
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

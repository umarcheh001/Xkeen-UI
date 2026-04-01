/*
  routing_cards.js — facade / entrypoint

  RC-12
  Keep only:
  - RC.init()
  - re-exports of public methods used by other UI parts (DAT modal, etc.)
  - DOMContentLoaded auto-start
*/
import { getRoutingCardsNamespace } from './routing_cards_namespace.js';
import {
  getXkeenEditorEngineApi,
  getXkeenPanelShellApi,
  getXkeenSettingsApi,
  isXkeenDebugRuntime,
  toastXkeen,
} from './xkeen_runtime.js';

let routingCardsModuleApi = null;

(function () {
  'use strict';

  // Namespace container for internal routing-cards submodules.
  // Public API publication is handled by features/compat/routing_cards.js.
  const RC = getRoutingCardsNamespace();

  // Optional debug flag (?debug=1 or runtime compat flag)
  let IS_DEBUG = false;
  try {
    IS_DEBUG = isXkeenDebugRuntime();
  } catch (e) {}

  // --- Public API re-exports ---
  function getDatRoutingTargets() {
    try {
      const DB = RC.rules && RC.rules.datBridge;
      if (DB && typeof DB.getDatRoutingTargets === 'function') return DB.getDatRoutingTargets();
    } catch (e) {}
    return { rules: [], outbounds: ['direct', 'proxy', 'block'] };
  }

  function applyDatSelector(opts) {
    try {
      const DB = RC.rules && RC.rules.datBridge;
      if (DB && typeof DB.applyDatSelector === 'function') return DB.applyDatSelector(opts);
    } catch (e) {}
    return { ok: false, error: 'dat_bridge_missing' };
  }

  function getUsedDatTags(kind, datFileOrPath) {
    try {
      const D = RC.rules && RC.rules.detect;
      if (D && typeof D.getUsedDatTags === 'function') return D.getUsedDatTags(kind, datFileOrPath);
    } catch (e) {}
    return { ok: false, kind: (kind === 'geoip') ? 'geoip' : 'geosite', file: null, tags: [] };
  }

  // installGeodat/getGeodatStatus stay exposed through routing_cards/dat/api.js.

  // --- Lazy helpers (help/docs + heavy wizards) ---

  const LAZY_HELPER_LOADERS = {
    fieldHelp: [
      { key: 'fieldHelp:docs', load: () => import('./routing_cards/help_docs.js') },
      { key: 'fieldHelp:modal', load: () => import('./routing_cards/help_modal.js') },
    ],
    quickBalancer: [
      { key: 'quickBalancer:wizard', load: () => import('./routing_cards/rules/quick_balancer.js') },
      { key: 'quickBalancer:help', load: () => import('./routing_cards/rules/balancer_help.js') },
    ],
    balancerHelp: [
      { key: 'balancerHelp:help', load: () => import('./routing_cards/rules/balancer_help.js') },
    ],
    forcedRulesWizard: [
      { key: 'forcedRulesWizard:wizard', load: () => import('./routing_cards/rules/forced_rules_wizard.js') },
    ],
  };

  const _lazyHelperReady = Object.create(null);
  const _lazyHelperLoading = Object.create(null);
  const _lazyScriptLoads = Object.create(null);

  function _getEditorEngineHelper() {
    return getXkeenEditorEngineApi();
  }



  const CM6_SCOPE = 'routing-cards';

  function _withCm6Scope(opts) {
    return Object.assign({ cm6Scope: CM6_SCOPE, scope: CM6_SCOPE }, opts || {});
  }

  function _getEditorRuntime(engine, opts) {
    const helper = _getEditorEngineHelper();
    if (!helper || typeof helper.getRuntime !== 'function') return null;
    try { return helper.getRuntime(engine, _withCm6Scope(opts)); } catch (e) {}
    return null;
  }


  function _loadHelperModuleOnce(entry) {
    const meta = entry && typeof entry === 'object' ? entry : null;
    const key = meta && meta.key ? String(meta.key) : '';
    const load = meta && typeof meta.load === 'function' ? meta.load : null;
    if (!key || !load) return Promise.resolve(false);
    if (_lazyScriptLoads[key]) return _lazyScriptLoads[key];

    _lazyScriptLoads[key] = Promise.resolve()
      .then(() => load())
      .then(() => true)
      .catch(() => {
        try { delete _lazyScriptLoads[key]; } catch (e) {}
        return false;
      });

    return _lazyScriptLoads[key];
  }

  async function _loadHelperModulesInOrder(list) {
    const items = Array.isArray(list) ? list : [];
    for (let i = 0; i < items.length; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const ok = await _loadHelperModuleOnce(items[i]);
      if (!ok) return false;
    }
    return true;
  }


  function _helperDisplayName(name) {
    switch (String(name || '')) {
      case 'fieldHelp':
        return 'routing field help';
      case 'quickBalancer':
        return 'quick balancer wizard';
      case 'balancerHelp':
        return 'balancer help';
      case 'forcedRulesWizard':
        return 'forced rules wizard';
      default:
        return 'routing helper';
    }
  }

  function _hasLazyHelperApi(name) {
    try {
      switch (String(name || '')) {
        case 'fieldHelp':
          return !!(RC.helpModal && typeof RC.helpModal.openFieldHelp === 'function' && RC.ROUTING_FIELD_DOCS);
        case 'quickBalancer':
          return !!(RC.rules && RC.rules.quickBalancer && typeof RC.rules.quickBalancer.init === 'function');
        case 'balancerHelp':
          return !!(RC.rules && RC.rules.balancerHelp && typeof RC.rules.balancerHelp.init === 'function');
        case 'forcedRulesWizard':
          return !!(RC.rules && RC.rules.forcedRulesWizard && typeof RC.rules.forcedRulesWizard.init === 'function');
        default:
          return false;
      }
    } catch (e) {
      return false;
    }
  }

  function _isLazyHelperReady(name) {
    const key = String(name || '');
    if (!key) return false;
    if (_lazyHelperReady[key]) return true;
    const ready = _hasLazyHelperApi(key);
    if (ready) _lazyHelperReady[key] = true;
    return ready;
  }

  function _toastLazyHelperFailure(name, err) {
    const msg = 'Не удалось загрузить ' + _helperDisplayName(name) + '.';
    try {
      toastXkeen(msg, true);
      return;
    } catch (e) {}
    try {
      // eslint-disable-next-line no-console
      console.error(msg, err || null);
    } catch (e2) {}
  }


  function _waitNextTask() {
    return new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }

  function ensureLazyHelper(name) {
    const key = String(name || '');
    if (!key) return Promise.resolve(false);
    if (_isLazyHelperReady(key)) return Promise.resolve(true);
    if (_lazyHelperLoading[key]) return _lazyHelperLoading[key];

    const loaders = Array.isArray(LAZY_HELPER_LOADERS[key]) ? LAZY_HELPER_LOADERS[key] : [];
    _lazyHelperLoading[key] = (async () => {
      if (!loaders.length) return false;
      const ok = await _loadHelperModulesInOrder(loaders);
      if (!ok) throw new Error('failed to load helper: ' + key);
      await _waitNextTask();
      _lazyHelperReady[key] = _hasLazyHelperApi(key);
      return _lazyHelperReady[key];
    })().catch((err) => {
      _lazyHelperReady[key] = false;
      _toastLazyHelperFailure(key, err);
      return false;
    }).finally(() => {
      _lazyHelperLoading[key] = null;
    });

    return _lazyHelperLoading[key];
  }

  function _fireDeferredClick(el) {
    if (!el) return;
    try {
      el.click();
      return;
    } catch (e) {}
    try {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    } catch (e2) {}
  }

  function openFieldHelpLazy(docKey) {
    const key = String(docKey || '').trim();
    if (!key) return Promise.resolve(false);

    try {
      const HM = RC.helpModal || {};
      if (typeof HM.openFieldHelp === 'function') {
        HM.openFieldHelp(key);
        return Promise.resolve(true);
      }
    } catch (e) {}

    return ensureLazyHelper('fieldHelp').then((ready) => {
      if (!ready) return false;
      try {
        const HM = RC.helpModal || {};
        if (typeof HM.openFieldHelp === 'function') {
          HM.openFieldHelp(key);
          return true;
        }
      } catch (e) {}
      return false;
    });
  }

  function wireLazyHelperClicks() {
    if (document.body && document.body.dataset && document.body.dataset.xkRoutingHelperLazy === '1') return;

    document.addEventListener('click', (e) => {
      const raw = e && e.target && typeof e.target.closest === 'function' ? e.target : null;
      if (!raw) return;

      const helpBtn = raw.closest('.routing-help-btn');
      if (helpBtn && !_isLazyHelperReady('fieldHelp')) {
        e.preventDefault();
        e.stopImmediatePropagation();
        void openFieldHelpLazy(helpBtn.dataset ? helpBtn.dataset.doc : '');
        return;
      }

      const helperBtn = raw.closest('#routing-balancer-quick-btn, #routing-balancer-help-btn, #routing-forced-rules-btn');
      if (!helperBtn) return;

      const helperName = helperBtn.id === 'routing-balancer-quick-btn'
        ? 'quickBalancer'
        : (helperBtn.id === 'routing-balancer-help-btn' ? 'balancerHelp' : 'forcedRulesWizard');

      if (_isLazyHelperReady(helperName)) return;

      e.preventDefault();
      e.stopImmediatePropagation();
      ensureLazyHelper(helperName).then((ready) => {
        if (!ready) return;
        setTimeout(() => { _fireDeferredClick(helperBtn); }, 0);
      });
    }, true);

    document.addEventListener('keydown', (e) => {
      const raw = e && e.target && typeof e.target.closest === 'function' ? e.target : null;
      if (!raw) return;
      if (e.key !== 'Enter' && e.key !== ' ') return;

      const helpBtn = raw.closest('.routing-help-btn');
      if (!helpBtn || _isLazyHelperReady('fieldHelp')) return;

      e.preventDefault();
      e.stopImmediatePropagation();
      void openFieldHelpLazy(helpBtn.dataset ? helpBtn.dataset.doc : '');
    }, true);

    if (document.body && document.body.dataset) document.body.dataset.xkRoutingHelperLazy = '1';
  }

  RC.lazy = RC.lazy || {};
  RC.lazy.ensureHelper = ensureLazyHelper;
  RC.lazy.openFieldHelp = openFieldHelpLazy;

  // --- Init ---

  function _routingGuiEnabled() {
    try {
      const settings = getXkeenSettingsApi();
      const st = settings && typeof settings.get === 'function' ? settings.get() : null;
      return !(st && st.routing && st.routing.guiEnabled === false);
    } catch (e) {}
    return false;
  }

  function _currentPanelView() {
    try {
      const shell = getXkeenPanelShellApi();
      if (shell && typeof shell.getCurrentView === 'function') {
        const name = String(shell.getCurrentView() || '').trim();
        if (name) return name;
      }
    } catch (e) {}
    try {
      const activeBtn = document.querySelector('.top-tab-btn.active[data-view]');
      const name = activeBtn && activeBtn.dataset ? String(activeBtn.dataset.view || '').trim() : '';
      if (name) return name;
    } catch (e) {}
    try {
      const sections = {
        routing: document.getElementById('view-routing'),
        mihomo: document.getElementById('view-mihomo'),
        xkeen: document.getElementById('view-xkeen'),
        'xray-logs': document.getElementById('view-xray-logs'),
        commands: document.getElementById('view-commands'),
        files: document.getElementById('view-files'),
      };
      for (const [name, el] of Object.entries(sections)) {
        if (!el) continue;
        const style = window.getComputedStyle ? window.getComputedStyle(el) : null;
        const visible = style ? (style.display !== 'none' && style.visibility !== 'hidden') : (el.style.display !== 'none');
        if (visible) return name;
      }
    } catch (e) {}
    return '';
  }

  function _syncFocusGroupVisibility(guiEnabled) {
    try {
      const focusGroup = document.querySelector('.xkeen-ctrl-group-routing-focus');
      if (!focusGroup) return;
      const isRoutingView = _currentPanelView() === 'routing';
      const shouldShow = !!guiEnabled && isRoutingView;
      focusGroup.style.display = shouldShow ? '' : 'none';
      focusGroup.setAttribute('aria-hidden', shouldShow ? 'false' : 'true');
    } catch (e) {}
  }

  const FOCUS_LS_KEY = 'xk.routing.focus-mode.v1';

  function _getPreferredFocusMode() {
    try {
      const v = String((localStorage && localStorage.getItem && localStorage.getItem(FOCUS_LS_KEY)) || '').toLowerCase();
      return v === 'gui' ? 'gui' : 'raw';
    } catch (e) {}
    return 'raw';
  }

  function _setPreferredFocusMode(mode) {
    try { localStorage.setItem(FOCUS_LS_KEY, String(mode || 'raw')); } catch (e) {}
  }

  function _setSectionOpen(bodyId, arrowId, open) {
    try {
      const body = document.getElementById(bodyId);
      const arrow = document.getElementById(arrowId);
      if (!body || !arrow) return;
      body.style.display = open ? '' : 'none';
        arrow.textContent = open ? '▲' : '▼';
    } catch (e) {}
  }

  function applyFocusMode(mode, opts) {
    const o = opts || {};
    const guiEnabled = _routingGuiEnabled();
    let next = String(mode || '').toLowerCase() === 'gui' ? 'gui' : 'raw';
    if (next === 'gui' && !guiEnabled) next = 'raw';

    try { _setPreferredFocusMode(next); } catch (e) {}

    try {
      const view = document.getElementById('view-routing');
      if (view) view.setAttribute('data-routing-focus', next);
    } catch (e) {}

    try {
      const rulesCard = document.getElementById('routing-rules-card');
      const editorCard = document.getElementById('routing-editor-card');
      if (rulesCard) {
        rulesCard.classList.toggle('is-focus-active', next === 'gui');
        rulesCard.classList.toggle('is-focus-muted', next !== 'gui');
      }
      if (editorCard) {
        editorCard.classList.toggle('is-focus-active', next === 'raw');
        editorCard.classList.toggle('is-focus-muted', next !== 'raw');
      }
    } catch (e) {}

    try {
      const guiBtn = document.getElementById('routing-focus-gui-btn');
      const rawBtn = document.getElementById('routing-focus-raw-btn');
      const note = document.getElementById('routing-focus-note');
      if (guiBtn) {
        guiBtn.classList.toggle('is-active', next === 'gui');
        guiBtn.setAttribute('aria-pressed', next === 'gui' ? 'true' : 'false');
        guiBtn.disabled = !guiEnabled;
      }
      if (rawBtn) {
        rawBtn.classList.toggle('is-active', next === 'raw');
        rawBtn.setAttribute('aria-pressed', next === 'raw' ? 'true' : 'false');
      }
      if (note) {
        const shortText = !guiEnabled
          ? 'Только RAW'
          : (next === 'gui' ? 'GUI: карточки' : 'RAW: JSON/JSONC');
        const fullText = !guiEnabled
          ? 'GUI-карточка выключена в UI Settings — доступен только RAW.'
          : (next === 'gui'
              ? 'GUI focus: быстрые карточки на первом плане, raw-редактор остаётся рядом.'
              : 'RAW focus: точный JSON/JSONC на первом плане, GUI остаётся как безопасный помощник.');
        note.textContent = shortText;
        note.title = fullText;
      }
    } catch (e) {}

    if (next === 'gui') {
      try { _setSectionOpen('routing-rules-body', 'routing-rules-arrow', true); } catch (e) {}
      if (o.scroll) {
        try { const card = document.getElementById('routing-rules-card'); if (card && card.scrollIntoView) card.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) {}
      }
    } else {
      try {
        const body = document.getElementById('routing-body');
        const arrow = document.getElementById('routing-arrow');
        if (body) body.style.display = 'block';
        if (arrow) arrow.textContent = '▼';
      } catch (e) {}
      if (o.scroll) {
        try { const card = document.getElementById('routing-editor-card'); if (card && card.scrollIntoView) card.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) {}
      }
    }

    try {
      document.dispatchEvent(new CustomEvent('xkeen:routing-focus-mode', { detail: { mode: next, guiEnabled } }));
    } catch (e) {}
    return next;
  }

  function wireFocusToggle() {
    try {
      const guiBtn = document.getElementById('routing-focus-gui-btn');
      const rawBtn = document.getElementById('routing-focus-raw-btn');
      if (guiBtn && guiBtn.dataset.xkWired !== '1') {
        guiBtn.addEventListener('click', (e) => { try { e.preventDefault(); } catch (e2) {} applyFocusMode('gui', { scroll: true }); });
        guiBtn.dataset.xkWired = '1';
      }
      if (rawBtn && rawBtn.dataset.xkWired !== '1') {
        rawBtn.addEventListener('click', (e) => { try { e.preventDefault(); } catch (e2) {} applyFocusMode('raw', { scroll: true }); });
        rawBtn.dataset.xkWired = '1';
      }
    } catch (e) {}
    applyFocusMode(_getPreferredFocusMode(), { scroll: false });
  }

  function applyUiSettings() {
    const guiEnabled = _routingGuiEnabled();
    try {
      const card = document.getElementById('routing-rules-card');
      if (card) card.style.display = guiEnabled ? '' : 'none';
    } catch (e) {}
    try { _syncFocusGroupVisibility(guiEnabled); } catch (e) {}
    try { wireFocusToggle(); } catch (e) {}
  }

  function onShow(opts) {
    const reason = (opts && opts.reason) ? String(opts.reason) : '';

    const refreshVisibleCards = () => {
      try {
        const view = document.getElementById('view-routing');
        if (!view) return;
        const st = window.getComputedStyle(view);
        if (!st || st.display === 'none' || st.visibility === 'hidden') return;
      } catch (e) {}

      try { applyUiSettings(); } catch (e) {}

      try {
        const rulesBody = document.getElementById('routing-rules-body');
        const isRulesOpen = !!(rulesBody && rulesBody.style.display !== 'none');
        const controls = RC.rules && RC.rules.controls;
        const model = RC.rules && RC.rules.model;

        if (isRulesOpen && controls && typeof controls.renderFromEditor === 'function') {
          controls.renderFromEditor({ setError: false });
        } else if (model && typeof model.loadFromEditor === 'function') {
          const r = model.loadFromEditor({ setError: false });
          if (r && r.ok && controls && typeof controls.syncDomainStrategySelect === 'function') {
            controls.syncDomainStrategySelect();
          }
        }
      } catch (e) {}

      try {
        const datBody = document.getElementById('routing-dat-body');
        const isDatOpen = !!(datBody && datBody.style.display !== 'none');
        const refreshDat = RC.dat && RC.dat.card && typeof RC.dat.card.refreshDatMeta === 'function'
          ? RC.dat.card.refreshDatMeta
          : null;
        if (isDatOpen && refreshDat) refreshDat();
      } catch (e) {}
    };

    try {
      requestAnimationFrame(() => {
        refreshVisibleCards();
        try { setTimeout(refreshVisibleCards, 0); } catch (e) {}
        try { setTimeout(refreshVisibleCards, 120); } catch (e) {}
        try { setTimeout(refreshVisibleCards, 260); } catch (e) {}
      });
    } catch (e) {
      refreshVisibleCards();
    }

    if (IS_DEBUG) {
      try {
        // eslint-disable-next-line no-console
        console.debug('[RC] onShow', { reason });
      } catch (e) {}
    }
  }

  let _inited = false;
  function init() {
    if (_inited) return;
    _inited = true;

    try { wireLazyHelperClicks(); } catch (e) {}

    // Order is explicit, each module is responsible for its own guards.
    try {
      if (RC.helpModal && typeof RC.helpModal.wireRoutingHelpButtons === 'function') {
        RC.helpModal.wireRoutingHelpButtons();
      }
    } catch (e) {}

    try {
      if (RC.collapse && typeof RC.collapse.initSidebarCards === 'function') {
        RC.collapse.initSidebarCards();
      }
    } catch (e) {}

    try {
      if (RC.dat && RC.dat.card && typeof RC.dat.card.initDatCard === 'function') {
        RC.dat.card.initDatCard();
      }
    } catch (e) {}

    try {
      if (RC.rules && RC.rules.controls && typeof RC.rules.controls.initRulesCard === 'function') {
        RC.rules.controls.initRulesCard();
      }
    } catch (e) {}

    try { wireFocusToggle(); } catch (e) {}
    try { applyUiSettings(); } catch (e) {}
    try {
      document.addEventListener('xkeen:ui-settings-changed', () => {
        try { applyUiSettings(); } catch (e2) {}
      });
    } catch (e) {}
    try {
      document.addEventListener('xkeen:panel-view-changed', () => {
        try { applyUiSettings(); } catch (e2) {}
      });
    } catch (e) {}

    if (IS_DEBUG) {
      try {
        // eslint-disable-next-line no-console
        console.log('[RC] init (facade)', {
          hasDat: !!(RC.dat && RC.dat.card),
          hasRules: !!(RC.rules && RC.rules.controls),
          hasBridge: !!(RC.rules && RC.rules.datBridge),
          hasDetect: !!(RC.rules && RC.rules.detect),
        });
      } catch (e) {}
    }
  }

  routingCardsModuleApi = {
    init,
    onShow,
    applyUiSettings,
    applyFocusMode,
    getPreferredFocusMode: _getPreferredFocusMode,
    getDatRoutingTargets,
    applyDatSelector,
    getUsedDatTags,
    dispose(...args) {
      if (RC && typeof RC.dispose === 'function') return RC.dispose(...args);
      return null;
    },
  };

  // Auto-init
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

export function getRoutingCardsApi() {
  try {
    if (routingCardsModuleApi && typeof routingCardsModuleApi.init === 'function') return routingCardsModuleApi;
  } catch (error) {
    console.error(error);
  }
  return null;
}

function callRoutingCardsApi(method, ...args) {
  const api = getRoutingCardsApi();
  if (!api || typeof api[method] !== 'function') return null;
  return api[method](...args);
}

export function initRoutingCards(...args) {
  return callRoutingCardsApi('init', ...args);
}

export function loadRoutingCards() {
  return null;
}

export function onShowRoutingCards(...args) {
  return callRoutingCardsApi('onShow', ...args);
}

export function applyRoutingCardsUiSettings(...args) {
  return callRoutingCardsApi('applyUiSettings', ...args);
}

export function applyRoutingCardsFocusMode(...args) {
  return callRoutingCardsApi('applyFocusMode', ...args);
}

export function getPreferredRoutingCardsFocusMode(...args) {
  return callRoutingCardsApi('getPreferredFocusMode', ...args);
}

export function getRoutingCardsDatTargets(...args) {
  return callRoutingCardsApi('getDatRoutingTargets', ...args);
}

export function applyRoutingCardsDatSelector(...args) {
  return callRoutingCardsApi('applyDatSelector', ...args);
}

export function getRoutingCardsUsedDatTags(...args) {
  return callRoutingCardsApi('getUsedDatTags', ...args);
}

export function disposeRoutingCards(...args) {
  return callRoutingCardsApi('dispose', ...args);
}

export const routingCardsApi = Object.freeze({
  get: getRoutingCardsApi,
  init: initRoutingCards,
  load: loadRoutingCards,
  onShow: onShowRoutingCards,
  applyUiSettings: applyRoutingCardsUiSettings,
  applyFocusMode: applyRoutingCardsFocusMode,
  getPreferredFocusMode: getPreferredRoutingCardsFocusMode,
  getDatRoutingTargets: getRoutingCardsDatTargets,
  applyDatSelector: applyRoutingCardsDatSelector,
  getUsedDatTags: getRoutingCardsUsedDatTags,
  dispose: disposeRoutingCards,
});

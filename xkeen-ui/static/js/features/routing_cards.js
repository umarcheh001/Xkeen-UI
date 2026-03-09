/*
  routing_cards.js — facade / entrypoint

  RC-12
  Keep only:
  - RC.init()
  - re-exports of public methods used by other UI parts (DAT modal, etc.)
  - DOMContentLoaded auto-start
*/
(function () {
  'use strict';

  // Namespace (must exist even if script order is wrong)
  window.XKeen = window.XKeen || {};
  const XK = window.XKeen;
  XK.features = XK.features || {};
  const RC = XK.features.routingCards = XK.features.routingCards || {};

  // Optional debug flag (?debug=1 or window.XKEEN_DEV=true)
  let IS_DEBUG = false;
  try {
    const q = (window.location && typeof window.location.search === 'string') ? window.location.search : '';
    IS_DEBUG = !!window.XKEEN_DEV || /(?:^|[?&])debug=1(?:&|$)/.test(q);
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

  RC.getDatRoutingTargets = getDatRoutingTargets;
  RC.applyDatSelector = applyDatSelector;
  RC.getUsedDatTags = getUsedDatTags;
  // installGeodat/getGeodatStatus are exported by routing_cards/dat/api.js

  // --- Init ---

  function _routingGuiEnabled() {
    try {
      const st = (XK.ui && XK.ui.settings && typeof XK.ui.settings.get === 'function') ? XK.ui.settings.get() : null;
      return !(st && st.routing && st.routing.guiEnabled === false);
    } catch (e) {}
    return true;
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
      arrow.textContent = open ? '▼' : '►';
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
    try {
      const card = document.getElementById('routing-rules-card');
      if (card) card.style.display = _routingGuiEnabled() ? '' : 'none';
    } catch (e) {}
    try { wireFocusToggle(); } catch (e) {}
  }

  let _inited = false;
  function init() {
    if (_inited) return;
    _inited = true;

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

  RC.applyUiSettings = applyUiSettings;
  RC.applyFocusMode = applyFocusMode;
  RC.getPreferredFocusMode = _getPreferredFocusMode;
  RC.init = init;

  // Auto-init
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

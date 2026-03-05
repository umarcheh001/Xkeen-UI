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

  RC.init = init;

  // Auto-init
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

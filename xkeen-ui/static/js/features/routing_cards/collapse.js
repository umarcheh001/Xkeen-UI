/*
  routing_cards/collapse.js
  RC-04: Collapse + sidebar wiring extracted from routing_cards.js.
*/
(function () {
  'use strict';

  // Namespace
  window.XKeen = window.XKeen || {};
  const XK = window.XKeen;
  XK.features = XK.features || {};
  const RC = XK.features.routingCards = XK.features.routingCards || {};
  RC.state = RC.state || {};

  const IDS = RC.IDS || {};
  const LS_KEYS = RC.LS_KEYS || {};

  const C = RC.common || {};
  const $ = (typeof C.$ === 'function') ? C.$ : function (id) { return document.getElementById(id); };

  function wireCollapse(headerId, bodyId, arrowId, key, onOpen, defaultOpen) {
    const h = $(headerId);
    const b = $(bodyId);
    const a = $(arrowId);
    if (!h || !b || !a) return;

    const prefKey = key || null;
    let open = (typeof defaultOpen === 'boolean') ? defaultOpen : true;
    if (prefKey) {
      try {
        const v = localStorage.getItem(prefKey);
        if (v === '0') open = false;
        if (v === '1') open = true;
      } catch (e) {}
    }

    function applyState() {
      b.style.display = open ? '' : 'none';
      a.textContent = open ? '▼' : '►';
    }
    applyState();

    h.addEventListener('click', () => {
      open = !open;
      if (prefKey) {
        try { localStorage.setItem(prefKey, open ? '1' : '0'); } catch (e) {}
      }
      applyState();
      if (open && typeof onOpen === 'function') {
        try { onOpen(); } catch (e) {}
      }
    });
  }

  // Sidebar-only collapses (these cards do not have their own feature modules)
  function initSidebarCards() {
    // Backups card
    try {
      wireCollapse(
        IDS.backupsHeader,
        IDS.backupsBody,
        IDS.backupsArrow,
        (LS_KEYS.sidebarBackupsOpen || 'xk.routing.backups.open.v1'),
        null,
        false
      );
    } catch (e) {}

    // Help/links card
    try {
      wireCollapse(
        IDS.helpHeader,
        IDS.helpBody,
        IDS.helpArrow,
        (LS_KEYS.sidebarHelpOpen || 'xk.routing.help.open.v1'),
        null,
        false
      );
    } catch (e) {}
  }

  // Export
  RC.collapse = RC.collapse || {};
  RC.collapse.wireCollapse = wireCollapse;
  RC.collapse.initSidebarCards = initSidebarCards;
})();

import { getRoutingCardsNamespace } from '../routing_cards_namespace.js';

/*
  routing_cards/collapse.js
  RC-04: Collapse + sidebar wiring extracted from routing_cards.js.
*/
(function () {
  'use strict';

  // Namespace
  window.XKeen = window.XKeen || {};
  const XK = window.XKeen;
  const RC = getRoutingCardsNamespace();
  RC.state = RC.state || {};

  const IDS = RC.IDS || {};
  const LS_KEYS = RC.LS_KEYS || {};

  const C = RC.common || {};
  const $ = (typeof C.$ === 'function') ? C.$ : function (id) { return document.getElementById(id); };

  function triggerOpen(onOpen, reason) {
    if (typeof onOpen !== 'function') return;
    const run = () => {
      try { onOpen({ reason: reason || 'open' }); } catch (e) {}
    };
    try {
      requestAnimationFrame(run);
    } catch (e) {
      try { setTimeout(run, 0); } catch (e2) {}
    }
  }

  function wireCollapse(headerId, bodyId, arrowId, key, onOpen, defaultOpen) {
    const h = $(headerId);
    const b = $(bodyId);
    const a = $(arrowId);
    if (!h || !b || !a) return;
    try {
      if (h.dataset && h.dataset.xkCollapseWired === '1') return;
    } catch (e) {}

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
      a.textContent = open ? '▲' : '▼';
      try { h.setAttribute('aria-expanded', open ? 'true' : 'false'); } catch (e) {}
      try {
        if (h.dataset) h.dataset.xkCollapseOpen = open ? '1' : '0';
      } catch (e2) {}
    }

    try {
      h.setAttribute('role', 'button');
      h.setAttribute('tabindex', h.getAttribute('tabindex') || '0');
      h.setAttribute('aria-controls', String(bodyId || ''));
    } catch (e) {}
    applyState();
    if (open) triggerOpen(onOpen, 'initial-open');

    function toggle() {
      open = !open;
      if (prefKey) {
        try { localStorage.setItem(prefKey, open ? '1' : '0'); } catch (e) {}
      }
      applyState();
      if (open) triggerOpen(onOpen, 'toggle-open');
    }

    h.addEventListener('click', () => {
      toggle();
    });

    h.addEventListener('keydown', (event) => {
      const keyName = String(event && event.key || '');
      if (keyName !== 'Enter' && keyName !== ' ') return;
      try { event.preventDefault(); } catch (e) {}
      toggle();
    });

    try {
      if (h.dataset) {
        h.dataset.xkCollapseWired = '1';
        h.dataset.xkCollapseBody = String(bodyId || '');
        h.dataset.xkCollapseArrow = String(arrowId || '');
        h.dataset.xkCollapseStorage = String(prefKey || '');
      }
    } catch (e) {}
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
        () => {
          try {
            const api = window.XKeen && XK.backups ? XK.backups : null;
            if (!api || typeof api.load !== 'function') return;
            const result = api.load();
            if (result && typeof result.catch === 'function') {
              result.catch((error) => {
                try { console.error('[XKeen] backups card load failed', error); } catch (e2) {}
              });
            }
          } catch (e) {}
        },
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

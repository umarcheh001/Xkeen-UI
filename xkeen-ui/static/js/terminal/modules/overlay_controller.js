// Terminal module: overlay controller (Stage 8.3.4)
//
// Centralizes small overlay-related helpers that used to live in terminal.js/_core.js.
//
// Provides:
//  - isOpen(): robust overlay visibility check
//  - show()/hide(): overlay display toggles (best-effort)
//  - syncBodyScrollLock(): delegates to XKeen.ui.modal.syncBodyScrollLock when available
//
// Emits:
//  - overlay:show
//  - overlay:hide
(function () {
  'use strict';

  window.XKeen = window.XKeen || {};
  window.XKeen.terminal = window.XKeen.terminal || {};

  function safeEmit(events, name, payload) {
    try { if (events && typeof events.emit === 'function') events.emit(String(name || ''), payload); } catch (e) {}
  }

  // Robust cross-browser overlay visibility check.
  // NOTE: offsetParent is unreliable for fixed-position overlays.
  function computeIsOpen(overlay) {
    if (!overlay) return false;
    try {
      if (!overlay.isConnected) return false;
      const cs = window.getComputedStyle ? window.getComputedStyle(overlay) : null;
      if (!cs) return true;
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
      // Best-effort fallback.
      try { return overlay.style.display !== 'none'; } catch (e2) {}
      return true;
    }
  }

  function fallbackAnyModalVisible() {
    try {
      // Common convention in this project: .modal.hidden means closed.
      const list = document.querySelectorAll('.modal');
      for (const el of list) {
        if (!el) continue;
        if (el.classList && el.classList.contains('hidden')) continue;
        const cs = window.getComputedStyle ? window.getComputedStyle(el) : null;
        if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) continue;
        return true;
      }
    } catch (e) {}
    return false;
  }

  function createController(ctx) {
    const events = (ctx && ctx.events) ? ctx.events : { emit: () => {} };
    const ui = (ctx && ctx.ui) ? ctx.ui : null;
    const dom = (ctx && ctx.dom) ? ctx.dom : null;

    let overlayEl = null;
    let mo = null;
    let lastOpen = null;

    function getOverlay() {
      try {
        if (dom && dom.overlay) return dom.overlay;
      } catch (e) {}
      try {
        if (ui && ui.get && typeof ui.get.overlay === 'function') return ui.get.overlay();
      } catch (e2) {}
      try {
        if (ui && typeof ui.byId === 'function') return ui.byId('terminal-overlay');
      } catch (e3) {}
      try { return document.getElementById('terminal-overlay'); } catch (e4) {}
      return null;
    }

    function isOpen() {
      const el = getOverlay();
      return computeIsOpen(el);
    }

    function syncBodyScrollLock() {
      // Preferred: global modal helper (shared across the whole UI).
      try {
        if (window.XKeen && window.XKeen.ui && window.XKeen.ui.modal && typeof window.XKeen.ui.modal.syncBodyScrollLock === 'function') {
          return window.XKeen.ui.modal.syncBodyScrollLock();
        }
      } catch (e) {}

      // Fallback: keep body.modal-open in sync with other visible modals.
      // The terminal overlay should *not* lock page scrolling.
      try {
        const open = fallbackAnyModalVisible();
        if (document && document.body && document.body.classList) {
          document.body.classList.toggle('modal-open', !!open);
        }
      } catch (e2) {}
    }

    function show(opts) {
      const o = opts || {};
      const el = getOverlay();
      if (!el) return;
      try { el.style.display = String(o.display || 'flex'); } catch (e) {}
      syncBodyScrollLock();
      safeEmit(events, 'overlay:show', { ts: Date.now() });
    }

    function hide() {
      const el = getOverlay();
      if (!el) return;
      try { el.style.display = 'none'; } catch (e) {}
      syncBodyScrollLock();
      safeEmit(events, 'overlay:hide', { ts: Date.now() });
    }

    function ensureObserver() {
      if (mo) return;
      if (typeof MutationObserver === 'undefined') return;
      const el = getOverlay();
      overlayEl = el;
      if (!overlayEl) return;

      lastOpen = computeIsOpen(overlayEl);
      mo = new MutationObserver(() => {
        try {
          const cur = computeIsOpen(overlayEl);
          if (lastOpen !== cur) {
            lastOpen = cur;
            syncBodyScrollLock();
            safeEmit(events, cur ? 'overlay:show' : 'overlay:hide', { ts: Date.now(), via: 'mutation' });
          } else {
            // Even if open-state didn't change, we may still need to re-sync (e.g. other modals).
            syncBodyScrollLock();
          }
        } catch (e) {}
      });

      try { mo.observe(overlayEl, { attributes: true, attributeFilter: ['style', 'class'] }); } catch (e2) {}
    }

    function init() {
      // Cache overlay ref (dom.refresh may update it later; getOverlay() stays dynamic).
      overlayEl = getOverlay();
      ensureObserver();
      try { syncBodyScrollLock(); } catch (e) {}
    }

    const api = { isOpen, show, hide, syncBodyScrollLock };

    // Expose instance on ctx + global for legacy wrappers.
    try { if (ctx) ctx.overlay = api; } catch (e) {}
    try { if (ctx) ctx.overlayCtrl = api; } catch (e2) {}
    try { window.XKeen.terminal.overlay = api; } catch (e3) {}

    return {
      id: 'overlay_controller',
      priority: 15,
      init: () => { try { init(); } catch (e) {} },
      onOpen: () => { try { init(); } catch (e) {} },
      onClose: () => { try { syncBodyScrollLock(); } catch (e) {} },
      // expose helper for other modules (optional)
      isOpen,
      show,
      hide,
      syncBodyScrollLock,
    };
  }

  window.XKeen.terminal.overlay_controller = {
    createModule: (ctx) => createController(ctx),
    // For non-registry usage (best-effort singleton)
    createController,
  };
})();

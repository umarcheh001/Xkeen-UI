/*
  routing_cards/rules/balancer_help.js
  Help button near quick balancer (⚡): shows detailed how-to about balancers, pool proxies and quick start.

  Public API (optional):
    RC.rules.balancerHelp.init()
*/
(function () {
  'use strict';

  window.XKeen = window.XKeen || {};
  const XK = window.XKeen;
  XK.features = XK.features || {};

  const RC = XK.features.routingCards = XK.features.routingCards || {};
  RC.rules = RC.rules || {};

  RC.rules.balancerHelp = RC.rules.balancerHelp || {};
  const BH = RC.rules.balancerHelp;

  const MODAL_ID = 'routing-balancer-help-modal';
  const BTN_ID = 'routing-balancer-help-btn';
  const IDS = {
    close: 'routing-balancer-help-close-btn',
    ok: 'routing-balancer-help-ok-btn',
  };

  let _wired = false;

  function $(id) {
    try { return document.getElementById(id); } catch (e) { return null; }
  }

  function _syncBodyScroll() {
    try {
      if (window.XKeen && XKeen.ui && XKeen.ui.modal && typeof XKeen.ui.modal.syncBodyScrollLock === 'function') {
        XKeen.ui.modal.syncBodyScrollLock();
      }
    } catch (e) {}
  }

  function openModal() {
    const m = $(MODAL_ID);
    if (!m) return;
    try { m.classList.remove('hidden'); } catch (e) {}
    _syncBodyScroll();

    // Focus close button for accessibility
    try {
      const c = $(IDS.close) || $(IDS.ok);
      if (c) c.focus();
    } catch (e2) {}
  }

  function closeModal() {
    const m = $(MODAL_ID);
    if (!m) return;
    try { m.classList.add('hidden'); } catch (e) {}
    _syncBodyScroll();
  }

  function scrollToTarget(targetId) {
    const m = $(MODAL_ID);
    if (!m) return;
    const el = document.getElementById(String(targetId || ''));
    if (!el) return;
    try {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
      try { el.scrollIntoView(true); } catch (e2) {}
    }
  }

  function wireOnce() {
    if (_wired) return;
    const modal = $(MODAL_ID);
    const btn = $(BTN_ID);
    if (!modal || !btn) return;

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      openModal();
    });

    const closeBtn = $(IDS.close);
    if (closeBtn) closeBtn.addEventListener('click', (e) => { e.preventDefault(); closeModal(); });

    const okBtn = $(IDS.ok);
    if (okBtn) okBtn.addEventListener('click', (e) => { e.preventDefault(); closeModal(); });

    // Overlay click closes
    modal.addEventListener('click', (e) => {
      try {
        if (e && e.target === modal) closeModal();
      } catch (e2) {}
    });

    // ESC closes
    document.addEventListener('keydown', (e) => {
      try {
        if (e.key !== 'Escape') return;
        const m = $(MODAL_ID);
        if (!m || m.classList.contains('hidden')) return;
        closeModal();
      } catch (e2) {}
    });

    // In-modal TOC navigation
    modal.addEventListener('click', (e) => {
      const a = e.target && e.target.closest ? e.target.closest('a[data-help-target]') : null;
      if (!a) return;
      e.preventDefault();
      const target = (a.dataset && a.dataset.helpTarget) ? a.dataset.helpTarget : '';
      if (!target) return;
      scrollToTarget(target);
    });

    _wired = true;
  }

  BH.init = function init() {
    setTimeout(() => {
      try { wireOnce(); } catch (e) {}
    }, 0);
  };

  // Auto-init
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => BH.init());
  } else {
    BH.init();
  }
})();

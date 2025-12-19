(() => {
  'use strict';

  window.XKeen = window.XKeen || {};
  XKeen.ui = XKeen.ui || {};
  XKeen.ui.modal = XKeen.ui.modal || {};

  // Prevent background page scrolling when any modal/overlay is open.
  // Uses the existing CSS rule: body.modal-open { overflow: hidden; }
  //
  // Kept intentionally tiny: this is a shared UI utility (not a terminal concern).
  XKeen.ui.modal.syncBodyScrollLock = function syncBodyScrollLock() {
    try {
      const termOverlay = document.getElementById('terminal-overlay');
      const termOpen = (() => {
        if (!termOverlay) return false;
        if (!termOverlay.isConnected) return false;
        const cs = window.getComputedStyle(termOverlay);
        if (!cs) return false;
        if (cs.display === 'none') return false;
        if (cs.visibility === 'hidden') return false;
        return true;
      })();

      const anyModal = !!document.querySelector('.modal:not(.hidden)');
      if (termOpen || anyModal) {
        document.body.classList.add('modal-open');
      } else {
        document.body.classList.remove('modal-open');
      }
    } catch (e) {
      // ignore
    }
  };
})();

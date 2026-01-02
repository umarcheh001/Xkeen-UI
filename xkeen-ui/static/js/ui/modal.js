(() => {
  'use strict';

  window.XKeen = window.XKeen || {};
  XKeen.ui = XKeen.ui || {};
  XKeen.ui.modal = XKeen.ui.modal || {};

  const Modal = XKeen.ui.modal;

  // ---------------------------------------------------------------------------
  // Body scroll lock (shared)
  // ---------------------------------------------------------------------------
  // Prevent background page scrolling when any modal/overlay is open.
  // Uses the existing CSS rule: body.modal-open { overflow: hidden; }
  Modal.syncBodyScrollLock = function syncBodyScrollLock() {
    try {
      const anyModal = !!document.querySelector('.modal:not(.hidden)');
      const fmFsOpen = (() => {
        try {
          const card = document.querySelector('.fm-card.is-fullscreen');
          if (!card || !card.isConnected) return false;
          const cs = window.getComputedStyle(card);
          if (!cs) return false;
          if (cs.display === 'none') return false;
          if (cs.visibility === 'hidden') return false;
          return true;
        } catch (e) {
          return false;
        }
      })();

      // NOTE: Terminal overlay (#terminal-overlay) is *not* treated as a modal for scroll-lock.
      // We intentionally keep the page scrollable while the terminal window is open.
      if (anyModal || fmFsOpen) {
        document.body.classList.add('modal-open');
      } else {
        document.body.classList.remove('modal-open');
      }
    } catch (e) {
      // ignore
    }
  };

  // ---------------------------------------------------------------------------
  // Modal positioning + drag
  // ---------------------------------------------------------------------------
  const PAD = 8;
  // Put dragged/opened modals above toasts (#toast-container is z-index:80),
  // while keeping the confirm dialog on top (#confirm-modal is higher in CSS).
  const Z_BASE = 90; // keep above .modal (60)
  let _z = Z_BASE;

  function isVisibleModal(modalEl) {
    if (!modalEl) return false;
    try {
      if (!modalEl.isConnected) return false;
      if (modalEl.classList && modalEl.classList.contains('hidden')) return false;
      const cs = window.getComputedStyle ? window.getComputedStyle(modalEl) : null;
      if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) return false;
      return true;
    } catch (e) {
      return false;
    }
  }

  function getContent(modalEl) {
    try { return modalEl ? modalEl.querySelector('.modal-content') : null; } catch (e) {}
    return null;
  }

  function clampPos(x, y, w, h, pad = PAD) {
    const maxX = Math.max(pad, window.innerWidth - w - pad);
    const maxY = Math.max(pad, window.innerHeight - h - pad);
    return {
      x: Math.min(Math.max(pad, x), maxX),
      y: Math.min(Math.max(pad, y), maxY),
    };
  }

  function resetContentPosition(contentEl) {
    if (!contentEl) return;
    // Only reset properties that we set for draggable/fixed positioning.
    try {
      contentEl.style.position = '';
      contentEl.style.left = '';
      contentEl.style.top = '';
      contentEl.style.width = '';
      contentEl.style.height = '';
      contentEl.style.transform = '';
    } catch (e) {}
    try { delete contentEl.dataset.xkDragged; } catch (e2) {}
  }

  function ensureContentInViewport(modalEl) {
    if (!isVisibleModal(modalEl)) return;
    if (modalEl.classList && modalEl.classList.contains('modal-drawer')) return;
    if (modalEl.dataset && modalEl.dataset.modalNopos === '1') return;

    const content = getContent(modalEl);
    if (!content) return;

    let r;
    try { r = content.getBoundingClientRect(); } catch (e) { r = null; }
    if (!r) return;

    // If it's already within bounds, do nothing.
    const outTop = r.top < PAD;
    const outLeft = r.left < PAD;
    const outRight = r.right > (window.innerWidth - PAD);
    const outBottom = r.bottom > (window.innerHeight - PAD);
    if (!(outTop || outLeft || outRight || outBottom)) return;

    // Freeze current geometry to fixed positioning, then clamp.
    const w = Math.max(200, r.width || 520);
    const h = Math.max(150, r.height || 320);
    const p = clampPos(r.left, r.top, w, h, PAD);

    try {
      content.style.position = 'fixed';
      content.style.left = Math.round(p.x) + 'px';
      content.style.top = Math.round(p.y) + 'px';
      content.style.width = Math.round(w) + 'px';
      content.style.height = Math.round(h) + 'px';
      content.style.transform = 'none';
      content.dataset.xkDragged = '1';
    } catch (e2) {}
  }

  function bringModalToFront(modalEl) {
    if (!modalEl) return;
    // Confirm modal uses z-index:70 in CSS; keep it above others.
    const isConfirm = (modalEl.id === 'confirm-modal');
    if (isConfirm) return;
    try {
      _z = Math.max(_z + 1, Z_BASE);
      modalEl.style.zIndex = String(_z);
    } catch (e) {}
  }

  function onModalOpen(modalEl) {
    const content = getContent(modalEl);
    if (!content) return;

    // Reset any previous dragged position so the default flex centering works.
    // (This also fixes cases where a modal got stuck off-screen.)
    if (!(modalEl.classList && modalEl.classList.contains('modal-drawer'))) {
      resetContentPosition(content);
    }

    bringModalToFront(modalEl);

    // After layout, ensure it's on-screen (best effort).
    try {
      requestAnimationFrame(() => {
        ensureContentInViewport(modalEl);
      });
    } catch (e) {
      // Fallback
      try { ensureContentInViewport(modalEl); } catch (e2) {}
    }

    // Keep body scroll lock correct.
    try { Modal.syncBodyScrollLock(); } catch (e3) {}
  }

  function onModalClose() {
    try { Modal.syncBodyScrollLock(); } catch (e) {}
  }

  // ---------------- Drag handling (delegated) ----------------
  let drag = null;

  function isInteractiveTarget(t) {
    if (!t || !t.closest) return false;
    // Don't start dragging when interacting with controls.
    return !!t.closest('button, a, input, textarea, select, label, .cm-toolbar, .CodeMirror');
  }

  function startDrag(e, modalEl, contentEl) {
    if (!contentEl) return;
    let r;
    try { r = contentEl.getBoundingClientRect(); } catch (err) { r = null; }
    if (!r) return;

    const w = Math.max(200, r.width || 520);
    const h = Math.max(150, r.height || 320);

    // Freeze current position into fixed coordinates.
    try {
      contentEl.style.position = 'fixed';
      contentEl.style.left = Math.round(r.left) + 'px';
      contentEl.style.top = Math.round(r.top) + 'px';
      contentEl.style.width = Math.round(w) + 'px';
      contentEl.style.height = Math.round(h) + 'px';
      contentEl.style.transform = 'none';
      contentEl.dataset.xkDragged = '1';
    } catch (err2) {}

    bringModalToFront(modalEl);

    const clientX = (e && typeof e.clientX === 'number') ? e.clientX : 0;
    const clientY = (e && typeof e.clientY === 'number') ? e.clientY : 0;

    drag = {
      modal: modalEl,
      content: contentEl,
      pointerId: (e && typeof e.pointerId === 'number') ? e.pointerId : null,
      offX: clientX - r.left,
      offY: clientY - r.top,
      w,
      h,
    };

    try {
      document.documentElement.style.userSelect = 'none';
      document.documentElement.style.cursor = 'move';
    } catch (err3) {}

    try {
      if (contentEl.setPointerCapture && drag.pointerId != null) {
        contentEl.setPointerCapture(drag.pointerId);
      }
    } catch (err4) {}

    try { e.preventDefault(); } catch (err5) {}
  }

  function moveDrag(e) {
    if (!drag || !drag.content) return;
    const clientX = (e && typeof e.clientX === 'number') ? e.clientX : 0;
    const clientY = (e && typeof e.clientY === 'number') ? e.clientY : 0;
    let x = clientX - drag.offX;
    let y = clientY - drag.offY;
    const p = clampPos(x, y, drag.w, drag.h, PAD);
    try {
      drag.content.style.left = Math.round(p.x) + 'px';
      drag.content.style.top = Math.round(p.y) + 'px';
    } catch (err) {}
  }

  function endDrag() {
    if (!drag) return;
    try {
      document.documentElement.style.userSelect = '';
      document.documentElement.style.cursor = '';
    } catch (e) {}
    try {
      if (drag.content && drag.content.releasePointerCapture && drag.pointerId != null) {
        drag.content.releasePointerCapture(drag.pointerId);
      }
    } catch (e2) {}
    drag = null;
  }

  function bindDelegatedDrag() {
    // Use Pointer Events when available (works for mouse + touch).
    const downEv = (window.PointerEvent ? 'pointerdown' : 'mousedown');
    const moveEv = (window.PointerEvent ? 'pointermove' : 'mousemove');
    const upEv = (window.PointerEvent ? 'pointerup' : 'mouseup');
    const cancelEv = (window.PointerEvent ? 'pointercancel' : 'mouseleave');

    document.addEventListener(downEv, (e) => {
      // Left mouse button only (touch has button==0 too in pointer events).
      if (e && typeof e.button === 'number' && e.button !== 0) return;

      const header = e.target && e.target.closest ? e.target.closest('.modal-header') : null;
      if (!header) return;
      if (isInteractiveTarget(e.target)) return;

      const modalEl = header.closest('.modal');
      if (!isVisibleModal(modalEl)) return;
      if (modalEl.classList && modalEl.classList.contains('modal-drawer')) return;
      if (modalEl.dataset && modalEl.dataset.modalNodrag === '1') return;

      const contentEl = getContent(modalEl);
      if (!contentEl) return;

      startDrag(e, modalEl, contentEl);
    }, { passive: false, capture: true });

    document.addEventListener(moveEv, (e) => {
      if (!drag) return;
      moveDrag(e);
    }, { passive: true });

    document.addEventListener(upEv, () => {
      if (!drag) return;
      endDrag();
    }, { passive: true });

    document.addEventListener(cancelEv, () => {
      if (!drag) return;
      endDrag();
    }, { passive: true });

    // Keep open modals inside viewport when window resizes.
    window.addEventListener('resize', () => {
      try {
        const open = document.querySelectorAll('.modal:not(.hidden)');
        open.forEach((m) => ensureContentInViewport(m));
      } catch (e) {}
    }, { passive: true });
  }

  // ---------------- Open/close observer ----------------
  const _openState = new WeakMap();

  function checkModalState(modalEl) {
    if (!modalEl || !(modalEl.classList && modalEl.classList.contains('modal'))) return;
    const cur = isVisibleModal(modalEl);
    const prev = _openState.get(modalEl);
    if (prev === cur) return;
    _openState.set(modalEl, cur);
    if (cur) onModalOpen(modalEl);
    else onModalClose(modalEl);
  }

  function observeModals() {
    // Prime existing modals.
    try {
      document.querySelectorAll('.modal').forEach((m) => {
        _openState.set(m, isVisibleModal(m));
        if (isVisibleModal(m)) onModalOpen(m);
      });
    } catch (e) {}

    if (typeof MutationObserver === 'undefined') return;
    try {
      const mo = new MutationObserver((mutations) => {
        for (const mu of mutations) {
          if (!mu) continue;
          if (mu.type === 'attributes' && mu.target) {
            if (mu.target.classList && mu.target.classList.contains('modal')) {
              checkModalState(mu.target);
            }
          }
          if (mu.type === 'childList') {
            try {
              (mu.addedNodes || []).forEach((n) => {
                if (!n || !n.querySelectorAll) return;
                if (n.classList && n.classList.contains('modal')) checkModalState(n);
                n.querySelectorAll('.modal').forEach((m) => checkModalState(m));
              });
            } catch (e2) {}
          }
        }
      });
      mo.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style'] });
    } catch (e3) {}
  }

  // Public helpers (optional)
  Modal.ensureInViewport = function (modalEl) { try { ensureContentInViewport(modalEl); } catch (e) {} };
  Modal.resetPosition = function (modalEl) { try { resetContentPosition(getContent(modalEl)); } catch (e) {} };

  // Init
  try {
    bindDelegatedDrag();
    observeModals();
  } catch (e) {}
})();

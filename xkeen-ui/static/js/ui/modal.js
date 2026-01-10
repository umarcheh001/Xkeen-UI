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

      const xrayFsOpen = (() => {
        try {
          const card = document.querySelector('.log-card.is-fullscreen');
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
      if (anyModal || fmFsOpen || xrayFsOpen) {
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
  
  // Persisted geometry (position + size)
  const STORAGE_PREFIX = 'xk.modal.state.v1.';
  const MIN_W = 260;
  const MIN_H = 160;

  function modalKey(modalEl) {
    if (!modalEl) return '';
    try {
      if (modalEl.dataset && modalEl.dataset.modalKey) return STORAGE_PREFIX + String(modalEl.dataset.modalKey);
    } catch (e) {}
    try {
      if (modalEl.id) return STORAGE_PREFIX + String(modalEl.id);
    } catch (e2) {}
    return '';
  }

  function canRemember(modalEl) {
    if (!modalEl) return false;
    try {
      if (modalEl.id === 'confirm-modal') return false;
      if (modalEl.classList && modalEl.classList.contains('modal-drawer')) return false;
      if (modalEl.dataset && modalEl.dataset.modalNopos === '1') return false;
      if (modalEl.dataset && modalEl.dataset.modalRemember === '0') return false;
    } catch (e) {}
    return !!modalKey(modalEl);
  }

  function canResize(modalEl) {
    if (!modalEl) return false;
    try {
      if (modalEl.id === 'confirm-modal') return false;
      if (modalEl.classList && modalEl.classList.contains('modal-drawer')) return false;
      if (modalEl.dataset && modalEl.dataset.modalNoresize === '1') return false;
    } catch (e) {}
    return true;
  }

  function loadState(modalEl) {
    if (!canRemember(modalEl)) return null;
    const key = modalKey(modalEl);
    if (!key) return null;

    let raw = null;
    try { raw = localStorage.getItem(key); } catch (e) {}
    if (!raw) return null;
    try {
      const obj = JSON.parse(raw);
      if (!obj || obj.v !== 1) return null;
      const x = Number(obj.x), y = Number(obj.y), w = Number(obj.w), h = Number(obj.h);
      if (![x, y, w, h].every((n) => Number.isFinite(n))) return null;
      return { v: 1, x, y, w, h };
    } catch (e2) {
      return null;
    }
  }

  function saveState(modalEl, contentEl) {
    if (!canRemember(modalEl) || !contentEl) return;
    let r = null;
    try { r = contentEl.getBoundingClientRect(); } catch (e) { r = null; }
    if (!r) return;

    const w = Math.max(MIN_W, r.width || MIN_W);
    const h = Math.max(MIN_H, r.height || MIN_H);
    const p = clampPos(r.left, r.top, w, h, PAD);

    const key = modalKey(modalEl);
    if (!key) return;
    const payload = { v: 1, x: Math.round(p.x), y: Math.round(p.y), w: Math.round(w), h: Math.round(h) };
    try { localStorage.setItem(key, JSON.stringify(payload)); } catch (e2) {}
  }

  function applyState(modalEl, contentEl, state) {
    if (!modalEl || !contentEl || !state) return false;
    if (!canRemember(modalEl)) return false;

    const viewMaxW = Math.max(200, window.innerWidth - PAD * 2);
    const viewMaxH = Math.max(150, window.innerHeight - PAD * 2);

    const w = Math.min(viewMaxW, Math.max(MIN_W, Number(state.w) || MIN_W));
    const h = Math.min(viewMaxH, Math.max(MIN_H, Number(state.h) || MIN_H));
    const p = clampPos(Number(state.x) || PAD, Number(state.y) || PAD, w, h, PAD);

    try {
      contentEl.style.position = 'fixed';
      contentEl.style.left = Math.round(p.x) + 'px';
      contentEl.style.top = Math.round(p.y) + 'px';
      contentEl.style.width = Math.round(w) + 'px';
      contentEl.style.height = Math.round(h) + 'px';
      contentEl.style.maxWidth = 'none';
      contentEl.style.maxHeight = 'none';
      contentEl.style.transform = 'none';
      contentEl.dataset.xkDragged = '1';
    } catch (e) {
      return false;
    }
    return true;
  }

  function refreshEmbeds(contentEl) {
    if (!contentEl) return;

    // CodeMirror refresh for editors in modals.
    try {
      contentEl.querySelectorAll('.CodeMirror').forEach((cmEl) => {
        try {
          const inst = cmEl && cmEl.CodeMirror;
          if (inst && typeof inst.refresh === 'function') inst.refresh();
        } catch (e2) {}
      });
    } catch (e) {}

    // Notify others.
    try {
      document.dispatchEvent(new CustomEvent('xkeen-modal-resize', { detail: { modal: modalElId(contentEl) } }));
    } catch (e3) {}
  }

  function modalElId(contentEl) {
    try {
      const m = contentEl.closest('.modal');
      if (m && m.id) return String(m.id);
    } catch (e) {}
    return '';
  }

  function ensureResizer(modalEl) {
    if (!modalEl) return;
    if (!canResize(modalEl)) return;
    const content = getContent(modalEl);
    if (!content) return;
    try {
      if (content.querySelector('.modal-resizer')) return;
    } catch (e) {}
    try {
      const h = document.createElement('div');
      h.className = 'modal-resizer';
      h.setAttribute('role', 'button');
      h.setAttribute('aria-label', 'Resize');
      h.tabIndex = 0;
      content.appendChild(h);
    } catch (e2) {}
  }

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
      contentEl.style.maxWidth = '';
      contentEl.style.maxHeight = '';
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
    const viewMaxW = Math.max(200, window.innerWidth - PAD * 2);
    const viewMaxH = Math.max(150, window.innerHeight - PAD * 2);
    const w = Math.min(viewMaxW, Math.max(200, r.width || 520));
    const h = Math.min(viewMaxH, Math.max(150, r.height || 320));
    const p = clampPos(r.left, r.top, w, h, PAD);

    try {
      content.style.position = 'fixed';
      content.style.left = Math.round(p.x) + 'px';
      content.style.top = Math.round(p.y) + 'px';
      content.style.width = Math.round(w) + 'px';
      content.style.height = Math.round(h) + 'px';
      content.style.maxWidth = 'none';
      content.style.maxHeight = 'none';
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

    // Restore user geometry if saved.
    let applied = false;
    try {
      const st = loadState(modalEl);
      if (st) applied = applyState(modalEl, content, st);
    } catch (e0) {}

    // If nothing saved, reset any previous dragged/resized position so default flex centering works.
    // (Also fixes cases where a modal got stuck off-screen.)
    if (!applied) {
      if (!(modalEl.classList && modalEl.classList.contains('modal-drawer'))) {
        resetContentPosition(content);
      }
    }

    // Add resize handle (if enabled for this modal).
    try { ensureResizer(modalEl); } catch (e1) {}

    bringModalToFront(modalEl);

    // After layout, ensure it's on-screen (best effort).
    try {
      requestAnimationFrame(() => {
        ensureContentInViewport(modalEl);
        if (applied) refreshEmbeds(content);
      });
    } catch (e) {
      try { ensureContentInViewport(modalEl); } catch (e2) {}
      if (applied) { try { refreshEmbeds(content); } catch (e3) {} }
    }

    // Keep body scroll lock correct.
    try { Modal.syncBodyScrollLock(); } catch (e3) {}
  }

  function onModalClose() {
    try { Modal.syncBodyScrollLock(); } catch (e) {}
  }

  // ---------------- Drag handling (delegated) ----------------
  let drag = null;
  let resize = null;

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
      contentEl.style.maxWidth = 'none';
      contentEl.style.maxHeight = 'none';
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

    try { saveState(drag.modal, drag.content); } catch (e0) {}
    try { refreshEmbeds(drag.content); } catch (e1) {}

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



  // ---------------- Resize handling (bottom-right handle) ----------------
  let _resizeRaf = 0;

  function scheduleRefresh(contentEl) {
    if (!contentEl) return;
    try {
      if (_resizeRaf) return;
      _resizeRaf = requestAnimationFrame(() => {
        _resizeRaf = 0;
        refreshEmbeds(contentEl);
      });
    } catch (e) {
      try { refreshEmbeds(contentEl); } catch (e2) {}
    }
  }

  function startResize(e, modalEl, contentEl) {
    if (!contentEl) return;
    let r;
    try { r = contentEl.getBoundingClientRect(); } catch (err) { r = null; }
    if (!r) return;

    const w = Math.max(MIN_W, r.width || MIN_W);
    const h = Math.max(MIN_H, r.height || MIN_H);

    try {
      contentEl.style.position = 'fixed';
      contentEl.style.left = Math.round(r.left) + 'px';
      contentEl.style.top = Math.round(r.top) + 'px';
      contentEl.style.width = Math.round(w) + 'px';
      contentEl.style.height = Math.round(h) + 'px';
      contentEl.style.maxWidth = 'none';
      contentEl.style.maxHeight = 'none';
      contentEl.style.transform = 'none';
      contentEl.dataset.xkDragged = '1';
    } catch (err2) {}

    bringModalToFront(modalEl);

    const clientX = (e && typeof e.clientX === 'number') ? e.clientX : 0;
    const clientY = (e && typeof e.clientY === 'number') ? e.clientY : 0;

    resize = {
      modal: modalEl,
      content: contentEl,
      pointerId: (e && typeof e.pointerId === 'number') ? e.pointerId : null,
      startX: clientX,
      startY: clientY,
      left: r.left,
      top: r.top,
      startW: w,
      startH: h,
    };

    try {
      document.documentElement.style.userSelect = 'none';
      document.documentElement.style.cursor = 'se-resize';
    } catch (err3) {}

    try {
      if (contentEl.setPointerCapture && resize.pointerId != null) {
        contentEl.setPointerCapture(resize.pointerId);
      }
    } catch (err4) {}

    try { e.preventDefault(); } catch (err5) {}
  }

  function moveResize(e) {
    if (!resize || !resize.content) return;

    const clientX = (e && typeof e.clientX === 'number') ? e.clientX : 0;
    const clientY = (e && typeof e.clientY === 'number') ? e.clientY : 0;

    const dx = clientX - resize.startX;
    const dy = clientY - resize.startY;

    const left = Number.parseFloat(resize.content.style.left) || resize.left || PAD;
    const top = Number.parseFloat(resize.content.style.top) || resize.top || PAD;

    const maxW = Math.max(MIN_W, window.innerWidth - left - PAD);
    const maxH = Math.max(MIN_H, window.innerHeight - top - PAD);

    const w = Math.max(MIN_W, Math.min(maxW, resize.startW + dx));
    const h = Math.max(MIN_H, Math.min(maxH, resize.startH + dy));

    try {
      resize.content.style.width = Math.round(w) + 'px';
      resize.content.style.height = Math.round(h) + 'px';
    } catch (err) {}

    scheduleRefresh(resize.content);
  }

  function endResize() {
    if (!resize) return;

    try { saveState(resize.modal, resize.content); } catch (e0) {}
    try { refreshEmbeds(resize.content); } catch (e1) {}

    try {
      document.documentElement.style.userSelect = '';
      document.documentElement.style.cursor = '';
    } catch (e) {}

    try {
      if (resize.content && resize.content.releasePointerCapture && resize.pointerId != null) {
        resize.content.releasePointerCapture(resize.pointerId);
      }
    } catch (e2) {}

    resize = null;
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

      // Resize handle (bottom-right corner)
      const rz = e.target && e.target.closest ? e.target.closest('.modal-resizer') : null;
      if (rz) {
        const modalEl = rz.closest('.modal');
        if (!isVisibleModal(modalEl)) return;
        if (modalEl.classList && modalEl.classList.contains('modal-drawer')) return;
        if (modalEl.dataset && modalEl.dataset.modalNoresize === '1') return;

        const contentEl = getContent(modalEl);
        if (!contentEl) return;

        // Cancel any active drag.
        if (drag) endDrag();

        startResize(e, modalEl, contentEl);
        return;
      }

      const header = e.target && e.target.closest ? e.target.closest('.modal-header') : null;
      if (!header) return;
      if (isInteractiveTarget(e.target)) return;

      const modalEl = header.closest('.modal');
      if (!isVisibleModal(modalEl)) return;
      if (modalEl.classList && modalEl.classList.contains('modal-drawer')) return;
      if (modalEl.dataset && modalEl.dataset.modalNodrag === '1') return;

      const contentEl = getContent(modalEl);
      if (!contentEl) return;

      // Cancel any active resize.
      if (resize) endResize();

      startDrag(e, modalEl, contentEl);
    }, { passive: false, capture: true });

    document.addEventListener(moveEv, (e) => {
      if (resize) {
        moveResize(e);
        return;
      }
      if (drag) moveDrag(e);
    }, { passive: true });

    document.addEventListener(upEv, () => {
      if (resize) endResize();
      if (drag) endDrag();
    }, { passive: true });

    document.addEventListener(cancelEv, () => {
      if (resize) endResize();
      if (drag) endDrag();
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

  Modal.saveState = function (modalEl) { try { saveState(modalEl, getContent(modalEl)); } catch (e) {} };
  Modal.forgetState = function (modalElOrId) {
    try {
      const id = (typeof modalElOrId === 'string') ? modalElOrId : (modalElOrId && modalElOrId.id ? modalElOrId.id : '');
      if (!id) return;
      localStorage.removeItem(STORAGE_PREFIX + id);
    } catch (e) {}
  };

  // Init
  try {
    bindDelegatedDrag();
    observeModals();
  } catch (e) {}
})();

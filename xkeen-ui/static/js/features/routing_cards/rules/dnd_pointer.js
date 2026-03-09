/*
  routing_cards/rules/dnd_pointer.js
  Pointer-based Drag & Drop (preferred) + native HTML5 fallback for Rules reorder.

  RC-09a
*/
(function () {
  'use strict';

  window.XKeen = window.XKeen || {};
  const XK = window.XKeen;
  XK.features = XK.features || {};

  const RC = XK.features.routingCards = XK.features.routingCards || {};
  RC.rules = RC.rules || {};

  // Public namespace: RC.rules.dnd
  const D = RC.rules.dnd = RC.rules.dnd || {};

  const S = RC.rules.state = RC.rules.state || {};
  const RM = RC.rules.model = RC.rules.model || {};
  const IDS = RC.IDS || {};
  const C = RC.common || {};

  const $ = (typeof C.$ === 'function') ? C.$ : function (id) { return document.getElementById(id); };

  const ensureModel = (typeof RM.ensureModel === 'function') ? RM.ensureModel : function () {
    if (!S._model) S._model = { domainStrategy: '', rules: [], balancers: [] };
    if (!S._model.rules) S._model.rules = [];
    if (!S._model.balancers) S._model.balancers = [];
    return S._model;
  };

  function supportsPointerDnD() {
    try { return typeof window !== 'undefined' && typeof window.PointerEvent !== 'undefined'; } catch (e) { return false; }
  }

  function ensureStateDefaults() {
    // Drag & drop reorder state
    if (!('_dragRuleIdx' in S)) S._dragRuleIdx = null;
    if (!('_dropInsertIdx' in S)) S._dropInsertIdx = null;
    if (!('_placeholderEl' in S)) S._placeholderEl = null;

    // Pointer-based DnD state
    if (!('_pDndActive' in S)) S._pDndActive = false;
    if (!('_pDndStarted' in S)) S._pDndStarted = false;
    if (!('_pDndPointerId' in S)) S._pDndPointerId = null;
    if (!('_pDndFromIdx' in S)) S._pDndFromIdx = null;
    if (!('_pDndCardEl' in S)) S._pDndCardEl = null;
    if (!('_pDndGhostEl' in S)) S._pDndGhostEl = null;
    if (!('_pDndBaseLeft' in S)) S._pDndBaseLeft = 0;
    if (!('_pDndBaseTop' in S)) S._pDndBaseTop = 0;
    if (!('_pDndShiftX' in S)) S._pDndShiftX = 0;
    if (!('_pDndShiftY' in S)) S._pDndShiftY = 0;
    if (!('_pDndStartX' in S)) S._pDndStartX = 0;
    if (!('_pDndStartY' in S)) S._pDndStartY = 0;
  }

  function attach(listEl, opts) {
    ensureStateDefaults();
    if (!listEl) return function () {};

    const cfg = opts || {};
    const onReorder = (typeof cfg.onReorder === 'function') ? cfg.onReorder : function () {};
    const isEnabled = (typeof cfg.isEnabled === 'function') ? cfg.isEnabled : function () { return true; };

    // Reuse existing wiring if already attached.
    if (listEl.__xkRulesDnD && typeof listEl.__xkRulesDnD.update === 'function') {
      listEl.__xkRulesDnD.update({ onReorder, isEnabled });
      return listEl.__xkRulesDnD.cleanup;
    }

    const ctx = {
      onReorder,
      isEnabled,
      cleanup: null,
      update(next) {
        if (next && typeof next.onReorder === 'function') ctx.onReorder = next.onReorder;
        if (next && typeof next.isEnabled === 'function') ctx.isEnabled = next.isEnabled;
        syncEnabled();
      },
    };
    listEl.__xkRulesDnD = ctx;

    function enabledNow() {
      try { return !!ctx.isEnabled(); } catch (e) { return true; }
    }

    function setDragLive(on, mode) {
      try {
        listEl.classList.toggle('is-dnd-live', !!on);
        if (on && mode) listEl.setAttribute('data-dnd-active', String(mode));
        else listEl.removeAttribute('data-dnd-active');
      } catch (e) {}
      try { document.body.classList.toggle('xk-rules-dnd-live', !!on); } catch (e) {}
    }

    function clearDropMarkers() {
      try {
        listEl.querySelectorAll('.routing-rule-card.is-drop-before,.routing-rule-card.is-drop-after').forEach((el) => {
          el.classList.remove('is-drop-before');
          el.classList.remove('is-drop-after');
        });
      } catch (e) {}
    }

    function ensurePlaceholder() {
      if (S._placeholderEl) return S._placeholderEl;
      const ph = document.createElement('div');
      ph.className = 'routing-rule-placeholder';
      ph.textContent = 'Переместить сюда';
      S._placeholderEl = ph;
      return S._placeholderEl;
    }

    function removePlaceholder() {
      if (S._placeholderEl && S._placeholderEl.parentNode) {
        try { S._placeholderEl.parentNode.removeChild(S._placeholderEl); } catch (e) {}
      }
      S._placeholderEl = null;
    }

    function computeInsertIndex(targetIdx, before) {
      if (targetIdx == null || S._dragRuleIdx == null) return null;
      let insertIdx = Number(targetIdx) + (before ? 0 : 1);
      // Adjust for removal of the dragged element.
      if (Number(S._dragRuleIdx) < insertIdx) insertIdx -= 1;
      if (insertIdx < 0) insertIdx = 0;

      const m = ensureModel();
      const n = (m && m.rules) ? m.rules.length : 0;
      if (n <= 0) return 0;
      if (insertIdx > n - 1) insertIdx = n - 1;
      return insertIdx;
    }

    function cleanupNativeDom() {
      S._dragRuleIdx = null;
      S._dropInsertIdx = null;
      removePlaceholder();
      try {
        const dragging = listEl.querySelector('.routing-rule-card.is-dragging');
        if (dragging) dragging.classList.remove('is-dragging');
      } catch (e) {}
      clearDropMarkers();
    }

    // ===================== Pointer-based DnD (preferred) =====================

    function pointerResetState() {
      S._pDndActive = false;
      S._pDndStarted = false;
      S._pDndPointerId = null;
      S._pDndFromIdx = null;
      S._pDndCardEl = null;
      S._pDndShiftX = 0;
      S._pDndShiftY = 0;
      S._pDndStartX = 0;
      S._pDndStartY = 0;
      S._pDndBaseLeft = 0;
      S._pDndBaseTop = 0;
      try { document.body.classList.remove('xk-pointer-dnd-active'); } catch (e) {}
    }

    function pointerRemoveGhost() {
      if (S._pDndGhostEl && S._pDndGhostEl.parentNode) {
        try { S._pDndGhostEl.parentNode.removeChild(S._pDndGhostEl); } catch (e) {}
      }
      S._pDndGhostEl = null;
    }

    function pointerCleanupDom() {
      clearDropMarkers();
      removePlaceholder();
      pointerRemoveGhost();
      S._dragRuleIdx = null;
      S._dropInsertIdx = null;
    }

    function pointerStartDragging() {
      if (S._pDndStarted) return;
      const card = S._pDndCardEl;
      if (!card || !card.parentNode) return;

      const rect = card.getBoundingClientRect();
      const ph = ensurePlaceholder();
      ph.style.minHeight = Math.max(48, rect.height) + 'px';
      ph.style.height = Math.max(48, rect.height) + 'px';
      ph.style.width = rect.width + 'px';

      try { card.parentNode.replaceChild(ph, card); } catch (e) {}

      // Turn the actual card into a fixed-position ghost.
      S._pDndGhostEl = card;
      S._pDndBaseLeft = rect.left;
      S._pDndBaseTop = rect.top;
      S._pDndShiftX = S._pDndStartX - rect.left;
      S._pDndShiftY = S._pDndStartY - rect.top;

      try {
        card.classList.add('is-pointer-ghost');
        card.classList.add('is-dragging');
        card.style.position = 'fixed';
        card.style.left = rect.left + 'px';
        card.style.top = rect.top + 'px';
        card.style.width = rect.width + 'px';
        card.style.height = rect.height + 'px';
        card.style.margin = '0';
        card.style.zIndex = '9999';
        card.style.pointerEvents = 'none';
        card.style.willChange = 'transform';
        card.style.transform = 'translate3d(0,0,0)';
        document.body.appendChild(card);
      } catch (e) {}

      S._pDndStarted = true;
      setDragLive(true, 'pointer');
      try { document.body.classList.add('xk-pointer-dnd-active'); } catch (e) {}
    }

    function pointerUpdateGhost(x, y) {
      if (!S._pDndGhostEl) return;
      const left = x - S._pDndShiftX;
      const top = y - S._pDndShiftY;
      const dx = left - S._pDndBaseLeft;
      const dy = top - S._pDndBaseTop;
      try { S._pDndGhostEl.style.transform = `translate3d(${dx}px, ${dy}px, 0)`; } catch (e) {}
    }

    function pointerAutoScroll(y) {
      try {
        const margin = 70;
        if (y < margin) window.scrollBy(0, -18);
        else if (y > window.innerHeight - margin) window.scrollBy(0, 18);
      } catch (e) {}
    }

    function pointerMovePlaceholder(x, y) {
      if (!S._pDndStarted) return;

      const ph = S._placeholderEl || ensurePlaceholder();
      const listRect = listEl.getBoundingClientRect();

      clearDropMarkers();

      // Find a card under pointer (ghost has pointer-events:none).
      let el = null;
      try { el = document.elementFromPoint(x, y); } catch (e) {}
      let card = el && el.closest ? el.closest('.routing-rule-card') : null;

      // Ignore ghost / invalid cards.
      if (card && (!listEl.contains(card) || !card.dataset || card.classList.contains('is-dragging'))) {
        card = null;
      }

      const m = ensureModel();
      const n = (m && m.rules) ? m.rules.length : 0;

      // If pointer is above/below list, snap placeholder to start/end.
      if (!card) {
        if (y < listRect.top + 8) {
          const first = listEl.firstElementChild;
          if (first) {
            try { listEl.insertBefore(ph, first); } catch (e) {}
          } else {
            try { listEl.appendChild(ph); } catch (e) {}
          }
          S._dropInsertIdx = 0;
        } else if (y > listRect.bottom - 8) {
          try { listEl.appendChild(ph); } catch (e) {}
          S._dropInsertIdx = Math.max(0, n - 1);
        }
        return;
      }

      const rect = card.getBoundingClientRect();
      let before = y < (rect.top + rect.height / 2);
      // Near midline, use X as tie-breaker (helps in 2-column grid).
      try {
        const midY = rect.top + rect.height / 2;
        if (Math.abs(y - midY) < 14) before = x < (rect.left + rect.width / 2);
      } catch (e) {}

      card.classList.add(before ? 'is-drop-before' : 'is-drop-after');

      const targetIdx = Number(card.dataset.idx);
      const insertIdx = computeInsertIndex(targetIdx, before);
      if (insertIdx == null) return;
      S._dropInsertIdx = insertIdx;

      try {
        if (before) card.parentNode.insertBefore(ph, card);
        else card.parentNode.insertBefore(ph, card.nextSibling);
      } catch (e) {}
    }

    function pointerEnd(commit) {
      if (!S._pDndActive) return;

      const started = !!S._pDndStarted;
      const fromIdx = Number(S._pDndFromIdx);
      const toIdx = S._dropInsertIdx;

      pointerCleanupDom();
      setDragLive(false);
      pointerResetState();

      // If we never started (small tap), do nothing.
      if (!started) return;

      // Always re-render to restore list UI after ghost drag.
      let target = fromIdx;
      if (commit && toIdx != null && Number.isFinite(Number(toIdx))) target = Number(toIdx);
      try { ctx.onReorder(fromIdx, target); } catch (e) {}
    }

    // Pointer handlers (hooked only when pointer events are supported).
    const onPointerDown = function (ev) {
      if (!enabledNow()) return;
      if (ev.button != null && ev.button !== 0) return; // left click only
      const handle = ev.target && ev.target.closest ? ev.target.closest('.routing-rule-handle') : null;
      if (!handle) return;

      const card = handle.closest ? handle.closest('.routing-rule-card') : null;
      if (!card || !card.dataset) return;

      S._pDndActive = true;
      S._pDndStarted = false;
      S._pDndPointerId = ev.pointerId;
      S._pDndFromIdx = Number(card.dataset.idx);
      S._pDndCardEl = card;
      S._pDndStartX = ev.clientX;
      S._pDndStartY = ev.clientY;
      S._dragRuleIdx = S._pDndFromIdx;
      S._dropInsertIdx = S._pDndFromIdx;

      try { handle.setPointerCapture(ev.pointerId); } catch (e) {}
      try { ev.preventDefault(); } catch (e) {}
    };

    const onPointerMove = function (ev) {
      if (!S._pDndActive) return;
      if (S._pDndPointerId != null && ev.pointerId !== S._pDndPointerId) return;
      if (!enabledNow()) { pointerEnd(false); return; }

      const x = ev.clientX;
      const y = ev.clientY;

      // Start after a small threshold.
      if (!S._pDndStarted) {
        const dx = x - S._pDndStartX;
        const dy = y - S._pDndStartY;
        if ((dx * dx + dy * dy) < 36) return; // 6px
        pointerStartDragging();
      }

      pointerUpdateGhost(x, y);
      pointerMovePlaceholder(x, y);
      pointerAutoScroll(y);

      try { ev.preventDefault(); } catch (e) {}
    };

    const onPointerUp = function (ev) {
      if (!S._pDndActive) return;
      if (S._pDndPointerId != null && ev.pointerId !== S._pDndPointerId) return;
      pointerEnd(true);
    };

    const onPointerCancel = function (ev) {
      if (!S._pDndActive) return;
      if (S._pDndPointerId != null && ev.pointerId !== S._pDndPointerId) return;
      pointerEnd(false);
    };

    const onKeyDown = function (ev) {
      if (!S._pDndActive) return;
      if (ev.key === 'Escape') {
        try { ev.preventDefault(); } catch (e) {}
        pointerEnd(false);
      }
    };

    // ===================== Native HTML5 DnD fallback =====================

    const onDragStart = function (ev) {
      if (!enabledNow()) return;
      const card = ev.target && ev.target.closest ? ev.target.closest('.routing-rule-card') : null;
      if (!card || !card.dataset) return;

      const idx = Number(card.dataset.idx);
      if (!Number.isFinite(idx)) return;

      S._dragRuleIdx = idx;
      S._dropInsertIdx = null;
      setDragLive(true, 'native');
      try { card.classList.add('is-dragging'); } catch (e) {}
      try {
        ev.dataTransfer.effectAllowed = 'move';
        ev.dataTransfer.setData('text/plain', String(idx));
      } catch (e) {}
    };

    const onDragEnd = function () {
      setDragLive(false);
      cleanupNativeDom();
    };

    const onDragOver = function (ev) {
      if (!enabledNow()) return;
      if (S._dragRuleIdx == null) return;
      try { ev.preventDefault(); } catch (e) {}
      try { ev.dataTransfer.dropEffect = 'move'; } catch (e) {}

      const card = ev.target && ev.target.closest ? ev.target.closest('.routing-rule-card') : null;
      if (!card || !card.dataset || card.classList.contains('is-dragging')) return;

      clearDropMarkers();

      const rect = card.getBoundingClientRect();
      const before = ev.clientY < (rect.top + rect.height / 2);
      card.classList.add(before ? 'is-drop-before' : 'is-drop-after');

      const targetIdx = Number(card.dataset.idx);
      const insertIdx = computeInsertIndex(targetIdx, before);
      if (insertIdx == null) return;
      S._dropInsertIdx = insertIdx;

      const ph = ensurePlaceholder();
      try {
        if (before) card.parentNode.insertBefore(ph, card);
        else card.parentNode.insertBefore(ph, card.nextSibling);
      } catch (e) {}
    };

    const onDrop = function (ev) {
      if (!enabledNow()) return;
      if (S._dragRuleIdx == null) return;
      try { ev.preventDefault(); } catch (e) {}

      const fromIdx = Number(S._dragRuleIdx);
      const toIdx = S._dropInsertIdx;
      setDragLive(false);
      cleanupNativeDom();

      if (toIdx == null || !Number.isFinite(Number(toIdx))) return;
      if (!Number.isFinite(fromIdx)) return;
      if (fromIdx === Number(toIdx)) return;

      try { ctx.onReorder(fromIdx, Number(toIdx)); } catch (e) {}
    };

    const onDragLeave = function (ev) {
      if (!enabledNow()) return;
      const rel = ev.relatedTarget;
      if (rel && listEl.contains(rel)) return;
      clearDropMarkers();
      removePlaceholder();
    };

    const onWinDragEnd = function () {
      if (!enabledNow()) return;
      setDragLive(false);
      cleanupNativeDom();
    };

    function syncEnabled() {
      if (enabledNow()) return;

      // Cancel active pointer drag (restores via onReorder(from, from) only if started).
      if (S._pDndActive) {
        pointerEnd(false);
      } else {
        setDragLive(false);
        // Still ensure no leftovers.
        pointerCleanupDom();
        pointerResetState();
      }

      cleanupNativeDom();
    }

    // Wire listeners (once).
    if (supportsPointerDnD()) {
      listEl.addEventListener('pointerdown', onPointerDown);
      window.addEventListener('pointermove', onPointerMove, { passive: false });
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('pointercancel', onPointerCancel);
      window.addEventListener('keydown', onKeyDown);
    }

    listEl.addEventListener('dragstart', onDragStart);
    listEl.addEventListener('dragend', onDragEnd);
    listEl.addEventListener('dragover', onDragOver);
    listEl.addEventListener('drop', onDrop);
    listEl.addEventListener('dragleave', onDragLeave);
    window.addEventListener('dragend', onWinDragEnd);

    ctx.cleanup = function cleanup() {
      try { listEl.removeEventListener('dragstart', onDragStart); } catch (e) {}
      try { listEl.removeEventListener('dragend', onDragEnd); } catch (e) {}
      try { listEl.removeEventListener('dragover', onDragOver); } catch (e) {}
      try { listEl.removeEventListener('drop', onDrop); } catch (e) {}
      try { listEl.removeEventListener('dragleave', onDragLeave); } catch (e) {}
      try { window.removeEventListener('dragend', onWinDragEnd); } catch (e) {}

      if (supportsPointerDnD()) {
        try { listEl.removeEventListener('pointerdown', onPointerDown); } catch (e) {}
        try { window.removeEventListener('pointermove', onPointerMove); } catch (e) {}
        try { window.removeEventListener('pointerup', onPointerUp); } catch (e) {}
        try { window.removeEventListener('pointercancel', onPointerCancel); } catch (e) {}
        try { window.removeEventListener('keydown', onKeyDown); } catch (e) {}
      }

      try { syncEnabled(); } catch (e) {}
      try { delete listEl.__xkRulesDnD; } catch (e) {}
    };

    // Initial sync (removes leftovers if currently disabled).
    syncEnabled();

    return ctx.cleanup;
  }

  // Public API
  D.attach = attach;
  D.supportsPointer = supportsPointerDnD;
})();

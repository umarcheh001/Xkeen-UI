import { getFileManagerNamespace } from '../file_manager_namespace.js';
import { iconHtml } from '../../ui/operator_icons.js';

(() => {
  'use strict';

  window.XKeen = window.XKeen || {};
  const XKeen = window.XKeen;
  const FM = getFileManagerNamespace();
  const C = FM.common || {};

  // --- tiny DOM helpers (local to this module)
  function el(id) {
    try { return document.getElementById(id); } catch (e) { return null; }
  }
  function qs(sel, root) {
    try { return (root || document).querySelector(sel); } catch (e) { return null; }
  }

  // LocalStorage key for geometry
  const LS_GEOM = (FM.prefs && FM.prefs.keys && FM.prefs.keys.geom) || 'xkeen.fm.geom_v3';

  function lsGet(key) {
    try {
      if (FM.prefs && typeof FM.prefs.lsGet === 'function') return FM.prefs.lsGet(key);
      return localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }
  function lsSet(key, val) {
    try {
      if (FM.prefs && typeof FM.prefs.lsSet === 'function') return FM.prefs.lsSet(key, val);
      localStorage.setItem(key, String(val));
    } catch (e) {}
  }

  // -------------------------- fullscreen --------------------------
  // Fullscreen is implemented as a CSS class on the file manager card.
  let isFs = false;

  function cardEl() {
    try {
      const view = el('view-files');
      if (!view) return null;
      return qs('.fm-card', view);
    } catch (e) {
      return null;
    }
  }

  function syncScrollLock() {
    try {
      if (C && typeof C.syncBodyScrollLock === 'function') return C.syncBodyScrollLock(isFs);
    } catch (e) {}
    try { document.body.classList.toggle('modal-open', !!isFs); } catch (e2) {}
  }

  function updateFullscreenBtn() {
    const btn = el('fm-fullscreen-btn');
    if (!btn) return;
    if (isFs) {
      btn.innerHTML = iconHtml('fullscreen-exit');
      btn.title = 'Восстановить';
      btn.setAttribute('aria-label', 'Восстановить');
    } else {
      btn.innerHTML = iconHtml('fullscreen');
      btn.title = 'Полный экран';
      btn.setAttribute('aria-label', 'Полный экран');
    }
  }

  function setFullscreen(on) {
    const card = cardEl();
    if (!card) return;
    isFs = !!on;
    try { card.classList.toggle('is-fullscreen', isFs); } catch (e) {}
    updateFullscreenBtn();
    syncScrollLock();
  }

  function toggleFullscreen() {
    setFullscreen(!isFs);
  }

  function isFullscreen() {
    return !!isFs;
  }

  // Called when the card is created/re-rendered and we need to re-sync internal state.
  function syncFromDom() {
    try {
      const card = cardEl();
      isFs = !!(card && card.classList && card.classList.contains('is-fullscreen'));
      updateFullscreenBtn();
      syncScrollLock();
    } catch (e) {}
  }

  // -------------------------- card geometry (persisted resize) --------------------------
  const GEOM = {
    minH: 420,
    // Height may exceed the default clamp on tall screens, but remains bounded
    // by the operator workspace CSS so the footer never leaves the scrollport.
    maxH: 4096,
  };

  let geomTouched = false;
  let geomAppliedOnce = false;
  let geomSaveTimer = null;
  let geomRO = null;
  function canResizeNow() {
    try {
      if (isFs) return false;
      if (window.matchMedia && window.matchMedia('(max-width: 920px)').matches) return false;
      return true;
    } catch (e) {
      return !isFs;
    }
  }

  function readGeom() {
    const raw = lsGet(LS_GEOM);
    if (!raw) return null;
    try {
      const j = JSON.parse(raw);
      if (!j || typeof j !== 'object') return null;
      const h = Number(j.h);
      if (!Number.isFinite(h) || h < GEOM.minH) return null;
      return { h };
    } catch (e) {
      return null;
    }
  }

  function clampGeom(g) {
    if (!g) return null;
    let h = Number(g.h);
    if (!Number.isFinite(h)) return null;

    const maxH = Math.max(GEOM.minH, GEOM.maxH);
    if (h < GEOM.minH) h = GEOM.minH;
    if (Number.isFinite(maxH) && maxH > 0 && h > maxH) h = maxH;
    return { h };
  }

  function applyGeom(g) {
    const card = cardEl();
    if (!card || !g) return;
    if (!canResizeNow()) return;

    const gg = clampGeom(g);
    if (!gg) return;

    try {
      card.style.height = Math.round(gg.h) + 'px';
    } catch (e) {}
  }

  function saveGeomNow() {
    if (!canResizeNow()) return;
    const card = cardEl();
    if (!card) return;

    let r = null;
    try { r = card.getBoundingClientRect(); } catch (e) { r = null; }
    if (!r || !Number.isFinite(r.height)) return;

    const h = Math.round(r.height);
    if (h < GEOM.minH) return;

    const geom = clampGeom({ h });
    if (!geom) return;

    geomTouched = true;
    try { lsSet(LS_GEOM, JSON.stringify(geom)); } catch (e) {}
  }

  function scheduleSaveGeom() {
    if (!geomTouched) return;
    if (geomSaveTimer) {
      try { clearTimeout(geomSaveTimer); } catch (e) {}
    }
    geomSaveTimer = setTimeout(() => {
      geomSaveTimer = null;
      saveGeomNow();
    }, 180);
  }

  function wireGeomPersistence() {
    const card = cardEl();
    if (!card) return;

    // Width follows the responsive workspace.  Remove legacy inline geometry
    // before reading the persisted height so an older left/right resize can no
    // longer leave the card shifted or wider than the viewport.
    try {
      card.style.removeProperty('width');
      card.style.removeProperty('--fm-shift-x');
    } catch (e) {}

    // avoid double-wire
    try {
      if (card.dataset && card.dataset.fmGeomWire === '1') return;
      if (card.dataset) card.dataset.fmGeomWire = '1';
    } catch (e) {}

    const stored = readGeom();
    geomTouched = !!stored;

    if (stored && canResizeNow()) {
      applyGeom(stored);
      geomAppliedOnce = true;
    }

    // Save resize changes (native and custom handles).
    try {
      if (window.ResizeObserver) {
        geomRO = new ResizeObserver(() => {
          if (!canResizeNow()) return;
          if (!geomTouched) {
            try {
              const hasInline = !!(card.style && card.style.height);
              if (!hasInline) return;
              geomTouched = true;
            } catch (e) { return; }
          }
          scheduleSaveGeom();
        });
        geomRO.observe(card);
      }
    } catch (e) {}

    // Apply stored geometry later when viewport becomes wide enough.
    try {
      window.addEventListener('resize', () => {
        if (geomAppliedOnce) return;
        const g = readGeom();
        if (!g) return;
        if (!canResizeNow()) return;
        applyGeom(g);
        geomAppliedOnce = true;
      }, { passive: true });
    } catch (e) {}
  }

  // -------------------------- vertical resize handle --------------------------
  function wireResizeHandles() {
    const card = cardEl();
    if (!card) return;

    // Clean up side handles left by an older runtime/HMR session. Horizontal
    // resize is intentionally disabled: the card always fits its workspace.
    try {
      ['.fm-resize-handle-left', '.fm-resize-handle-right'].forEach((selector) => {
        const handle = qs(selector, card);
        if (handle) handle.remove();
      });
    } catch (e) {}

    const handles = [
      { side: 'bottom', className: 'fm-resize-handle-bottom', cursor: 'ns-resize' },
    ];

    handles.forEach((cfg) => {
      let handle = qs('.' + cfg.className, card);
      if (!handle) {
        try {
          handle = document.createElement('div');
          handle.className = cfg.className;
          handle.setAttribute('aria-hidden', 'true');
          card.appendChild(handle);
        } catch (e) {
          return;
        }
      }

      try {
        if (handle.dataset && handle.dataset.fmWire === '1') return;
        if (handle.dataset) handle.dataset.fmWire = '1';
      } catch (e) {}

      let dragging = false;
      let startY = 0;
      let startH = 0;
      let prevBodyUserSelect = '';
      let prevBodyCursor = '';

      function startDrag(ev) {
        try {
          if (!canResizeNow()) return;
          if (ev && ev.pointerType === 'mouse' && ev.button !== 0) return;
          const r = card.getBoundingClientRect();
          startY = ev.clientY;
          startH = r.height;

          card.style.height = Math.round(startH) + 'px';

          dragging = true;
          geomTouched = true;

          prevBodyUserSelect = document.body.style.userSelect || '';
          prevBodyCursor = document.body.style.cursor || '';
          document.body.style.userSelect = 'none';
          document.body.style.cursor = cfg.cursor;

          try { handle.setPointerCapture(ev.pointerId); } catch (e) {}
          ev.preventDefault();
          ev.stopPropagation();
        } catch (e) {}
      }

      function onMove(ev) {
        if (!dragging) return;
        try {
          const dy = ev.clientY - startY;

          const geom = clampGeom({ h: startH + dy });
          if (!geom) return;

          card.style.height = Math.round(geom.h) + 'px';

          ev.preventDefault();
          ev.stopPropagation();
        } catch (e) {}
      }

      function endDrag(ev) {
        if (!dragging) return;
        dragging = false;
        try {
          document.body.style.userSelect = prevBodyUserSelect;
          document.body.style.cursor = prevBodyCursor;
        } catch (e) {}

        try {
          if (ev) {
            ev.preventDefault();
            ev.stopPropagation();
          }
        } catch (e) {}

        try {
          geomTouched = true;
          scheduleSaveGeom();
        } catch (e) {}
      }

      handle.addEventListener('pointerdown', startDrag, { passive: false });
      handle.addEventListener('pointermove', onMove, { passive: false });
      handle.addEventListener('pointerup', endDrag, { passive: false });
      handle.addEventListener('pointercancel', endDrag, { passive: false });
      handle.addEventListener('lostpointercapture', endDrag, { passive: false });
    });
  }

  FM.chrome = {
    cardEl,
    // fullscreen
    setFullscreen,
    toggleFullscreen,
    isFullscreen,
    syncFromDom,
    // geometry
    wireGeomPersistence,
    wireResizeHandles,
    wireLeftResizeHandle: wireResizeHandles,
  };
})();

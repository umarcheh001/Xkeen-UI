import { getFileManagerNamespace } from '../file_manager_namespace.js';

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
      btn.textContent = '🗗';
      btn.title = 'Восстановить';
      btn.setAttribute('aria-label', 'Восстановить');
    } else {
      btn.textContent = '⛶';
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
    minW: 520,
    minH: 420,
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
      const w = Number(j.w);
      const h = Number(j.h);
      const shiftX = Number.isFinite(Number(j.shiftX)) ? Number(j.shiftX) : 0;
      if (!Number.isFinite(w) || !Number.isFinite(h)) return null;
      if (w < GEOM.minW || h < GEOM.minH) return null;
      return { w, h, shiftX };
    } catch (e) {
      return null;
    }
  }

  function getShiftX(card) {
    if (!card || !card.style || typeof card.style.getPropertyValue !== 'function') return 0;
    try {
      const raw = String(card.style.getPropertyValue('--fm-shift-x') || '').trim();
      const n = Number(raw.replace('px', '').trim());
      return Number.isFinite(n) ? n : 0;
    } catch (e) {
      return 0;
    }
  }

  function getCardMetrics(card) {
    if (!card) return null;
    try {
      const rect = card.getBoundingClientRect();
      const shiftX = getShiftX(card);
      if (!rect || !Number.isFinite(rect.left)) return null;
      return {
        flowLeft: rect.left - shiftX,
      };
    } catch (e) {
      return null;
    }
  }

  function clampGeom(g, metrics) {
    if (!g) return null;
    let w = Number(g.w);
    let h = Number(g.h);
    let shiftX = Number.isFinite(Number(g.shiftX)) ? Number(g.shiftX) : 0;
    if (!Number.isFinite(w) || !Number.isFinite(h)) return null;

    const maxW = Math.max(GEOM.minW, Math.round(window.innerWidth * 0.98));
    const maxH = Math.max(GEOM.minH, Math.round(window.innerHeight * 0.90));
    if (w < GEOM.minW) w = GEOM.minW;
    if (h < GEOM.minH) h = GEOM.minH;
    if (Number.isFinite(maxW) && maxW > 0 && w > maxW) w = maxW;
    if (Number.isFinite(maxH) && maxH > 0 && h > maxH) h = maxH;
    if (metrics && Number.isFinite(metrics.flowLeft)) {
      const minShift = Math.round(8 - metrics.flowLeft);
      const maxShift = Math.round(window.innerWidth - 8 - metrics.flowLeft - w);
      if (shiftX < minShift) shiftX = minShift;
      if (shiftX > maxShift) shiftX = maxShift;
    }
    return { w, h, shiftX };
  }

  function applyGeom(g) {
    const card = cardEl();
    if (!card || !g) return;
    if (!canResizeNow()) return;

    const gg = clampGeom(g, getCardMetrics(card));
    if (!gg) return;

    try {
      card.style.width = Math.round(gg.w) + 'px';
      card.style.height = Math.round(gg.h) + 'px';
      card.style.setProperty('--fm-shift-x', Math.round(gg.shiftX) + 'px');
    } catch (e) {}
  }

  function saveGeomNow() {
    if (!canResizeNow()) return;
    const card = cardEl();
    if (!card) return;

    let r = null;
    try { r = card.getBoundingClientRect(); } catch (e) { r = null; }
    if (!r || !Number.isFinite(r.width) || !Number.isFinite(r.height)) return;

    const w = Math.round(r.width);
    const h = Math.round(r.height);
    if (w < GEOM.minW || h < GEOM.minH) return;

    const geom = clampGeom({ w, h, shiftX: getShiftX(card) }, getCardMetrics(card));
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
              const hasInline = !!(card.style && (card.style.width || card.style.height || card.style.getPropertyValue('--fm-shift-x')));
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

  // -------------------------- bottom corner resize handles --------------------------
  function wireResizeHandles() {
    const card = cardEl();
    if (!card) return;

    const handles = [
      { side: 'left', className: 'fm-resize-handle-left', cursor: 'nesw-resize' },
      { side: 'right', className: 'fm-resize-handle-right', cursor: 'nwse-resize' },
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
      let startX = 0;
      let startY = 0;
      let startW = 0;
      let startH = 0;
      let startShiftX = 0;
      let metrics = null;
      let prevBodyUserSelect = '';
      let prevBodyCursor = '';

      function startDrag(ev) {
        try {
          if (!canResizeNow()) return;
          if (ev && ev.pointerType === 'mouse' && ev.button !== 0) return;
          const r = card.getBoundingClientRect();
          startX = ev.clientX;
          startY = ev.clientY;
          startW = r.width;
          startH = r.height;
          startShiftX = getShiftX(card);
          metrics = getCardMetrics(card);

          card.style.width = Math.round(startW) + 'px';
          card.style.height = Math.round(startH) + 'px';
          card.style.setProperty('--fm-shift-x', Math.round(startShiftX) + 'px');

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
          const dx = ev.clientX - startX;
          const dy = ev.clientY - startY;

          let w = cfg.side === 'left' ? (startW - dx) : (startW + dx);
          let h = startH + dy;
          let shiftX = startShiftX;
          if (cfg.side === 'left') {
            shiftX = startShiftX + (startW - w);
          }

          const geom = clampGeom({ w, h, shiftX }, metrics);
          if (!geom) return;

          card.style.width = Math.round(geom.w) + 'px';
          card.style.height = Math.round(geom.h) + 'px';
          card.style.setProperty('--fm-shift-x', Math.round(geom.shiftX) + 'px');

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

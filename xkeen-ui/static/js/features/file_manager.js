(() => {
  'use strict';

  window.XKeen = window.XKeen || {};
  XKeen.features = XKeen.features || {};
  XKeen.features.fileManager = XKeen.features.fileManager || {};

  const FM = XKeen.features.fileManager;

  // -------------------------- preferences (localStorage) --------------------------
  const FM_LS = {
    sort: 'xkeen.fm.sort',          // JSON: { key: 'name'|'size'|'perm'|'mtime', dir: 'asc'|'desc', dirsFirst: true }
    showHidden: 'xkeen.fm.dotfiles', // '1'|'0'
    mask: 'xkeen.fm.mask',          // last used selection mask (glob)
    // persisted card geometry (user resize)
    // JSON: { w: number(px), h: number(px), shiftX: number(px) }
    geom: 'xkeen.fm.geom_v1'
  };

  function lsGet(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }

  function lsSet(key, val) {
    try { localStorage.setItem(key, String(val)); } catch (e) {}
  }

  function loadSortPref() {
    const raw = lsGet(FM_LS.sort);
    if (!raw) return { key: 'name', dir: 'asc', dirsFirst: true };
    try {
      const o = JSON.parse(raw);
      const key = String(o && o.key || 'name');
      const dir = String(o && o.dir || 'asc');
      const dirsFirst = (o && typeof o.dirsFirst === 'boolean') ? !!o.dirsFirst : true;
      if (!['name', 'size', 'perm', 'mtime'].includes(key)) return { key: 'name', dir: 'asc', dirsFirst: true };
      if (!['asc', 'desc'].includes(dir)) return { key, dir: 'asc', dirsFirst };
      return { key, dir, dirsFirst };
    } catch (e) {
      return { key: 'name', dir: 'asc', dirsFirst: true };
    }
  }

  function saveSortPref(p) {
    const o = {
      key: (p && p.key) || 'name',
      dir: (p && p.dir) || 'asc',
      dirsFirst: (p && typeof p.dirsFirst === 'boolean') ? !!p.dirsFirst : true,
    };
    lsSet(FM_LS.sort, JSON.stringify(o));
  }

  function loadShowHiddenPref() {
    const raw = lsGet(FM_LS.showHidden);
    return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
  }

  function saveShowHiddenPref(on) {
    lsSet(FM_LS.showHidden, on ? '1' : '0');
  }

  function loadMaskPref() {
    const raw = lsGet(FM_LS.mask);
    return raw ? String(raw) : '';
  }

  function saveMaskPref(v) {
    lsSet(FM_LS.mask, String(v || ''));
  }

  // -------------------------- card geometry (persisted resize) --------------------------
  // Like terminal window chrome: remember last user size of the file manager card.
  // We persist only after the user actually resizes (via native bottom-right handle
  // or our custom bottom-left handle).
  const FM_GEOM = {
    minW: 520,
    minH: 420,
  };

  let fmGeomTouched = false;
  let fmGeomAppliedOnce = false;
  let fmGeomSaveTimer = null;
  let fmGeomRO = null;
  let fmNativeResizeActive = false;

  function fmCanResizeNow() {
    try {
      if (fmIsFullscreen) return false;
      // On narrow screens we disable resize entirely (see CSS media query).
      if (window.matchMedia && window.matchMedia('(max-width: 920px)').matches) return false;
      return true;
    } catch (e) {
      return !fmIsFullscreen;
    }
  }

  function fmReadGeom() {
    const raw = lsGet(FM_LS.geom);
    if (!raw) return null;
    try {
      const j = JSON.parse(raw);
      if (!j || typeof j !== 'object') return null;
      const w = Number(j.w);
      const h = Number(j.h);
      const shiftX = Number(j.shiftX || 0);
      if (!Number.isFinite(w) || !Number.isFinite(h)) return null;
      if (w < FM_GEOM.minW || h < FM_GEOM.minH) return null;
      if (!Number.isFinite(shiftX)) return { w, h, shiftX: 0 };
      return { w, h, shiftX };
    } catch (e) {
      return null;
    }
  }

  function fmClampGeom(g) {
    if (!g) return null;
    let w = Number(g.w);
    let h = Number(g.h);
    let shiftX = Number(g.shiftX || 0);
    if (!Number.isFinite(w) || !Number.isFinite(h)) return null;

    // Clamp to viewport so we don't create unusable layouts after a screen change.
    const maxW = Math.max(FM_GEOM.minW, Math.round(window.innerWidth * 0.98));
    const maxH = Math.max(FM_GEOM.minH, Math.round(window.innerHeight * 0.90));
    if (w < FM_GEOM.minW) w = FM_GEOM.minW;
    if (h < FM_GEOM.minH) h = FM_GEOM.minH;
    if (Number.isFinite(maxW) && maxW > 0 && w > maxW) w = maxW;
    if (Number.isFinite(maxH) && maxH > 0 && h > maxH) h = maxH;

    const maxShift = Math.max(0, Math.round(window.innerWidth * 0.55));
    if (!Number.isFinite(shiftX)) shiftX = 0;
    if (shiftX > maxShift) shiftX = maxShift;
    if (shiftX < -maxShift) shiftX = -maxShift;

    return { w, h, shiftX };
  }

  function fmApplyGeom(g) {
    const card = fmCardEl();
    if (!card || !g) return;
    if (!fmCanResizeNow()) return;

    const gg = fmClampGeom(g);
    if (!gg) return;

    try {
      card.style.width = Math.round(gg.w) + 'px';
      card.style.height = Math.round(gg.h) + 'px';
      card.style.setProperty('--fm-shift-x', Math.round(gg.shiftX) + 'px');
    } catch (e) {}
  }

  function fmSaveGeomNow() {
    if (!fmCanResizeNow()) return;
    const card = fmCardEl();
    if (!card) return;

    let r = null;
    try { r = card.getBoundingClientRect(); } catch (e) { r = null; }
    if (!r || !Number.isFinite(r.width) || !Number.isFinite(r.height)) return;

    const w = Math.round(r.width);
    const h = Math.round(r.height);
    if (w < FM_GEOM.minW || h < FM_GEOM.minH) return;

    const geom = fmClampGeom({ w, h, shiftX: getFmShiftX(card) });
    if (!geom) return;

    fmGeomTouched = true;
    try {
      lsSet(FM_LS.geom, JSON.stringify(geom));
    } catch (e) {
      // ignore quota / privacy mode
    }
  }

  function fmScheduleSaveGeom() {
    if (!fmGeomTouched) return;
    if (fmGeomSaveTimer) {
      try { clearTimeout(fmGeomSaveTimer); } catch (e) {}
    }
    fmGeomSaveTimer = setTimeout(() => {
      fmGeomSaveTimer = null;
      fmSaveGeomNow();
    }, 180);
  }

  function fmWireGeomPersistence() {
    const card = fmCardEl();
    if (!card) return;

    // avoid double-wire
    try {
      if (card.dataset && card.dataset.fmGeomWire === '1') return;
      if (card.dataset) card.dataset.fmGeomWire = '1';
    } catch (e) {}

    const stored = fmReadGeom();
    fmGeomTouched = !!stored;

    // Apply stored geometry once when resize is available.
    if (stored && fmCanResizeNow()) {
      fmApplyGeom(stored);
      fmGeomAppliedOnce = true;
    }

    // Save future resize changes (native handle and left handle both affect size).
    try {
      if (window.ResizeObserver) {
        fmGeomRO = new ResizeObserver(() => {
          if (!fmCanResizeNow()) return;
          // Start persisting only after the browser (or our handle) actually
          // wrote pixel-based inline sizing. This avoids locking in the default
          // responsive CSS layout before the user interacts.
          if (!fmGeomTouched) {
            try {
              const hasInline = !!(card.style && (card.style.width || card.style.height || card.style.getPropertyValue('--fm-shift-x')));
              if (!hasInline) return;
              fmGeomTouched = true;
            } catch (e) { return; }
          }
          fmScheduleSaveGeom();
        });
        fmGeomRO.observe(card);
      }
    } catch (e) {}

    // Detect native bottom-right resize drag (the browser handle is not a DOM node).
    try {
      card.addEventListener('pointerdown', (ev) => {
        try {
          if (!fmCanResizeNow()) return;
          if (ev && ev.pointerType === 'mouse' && ev.button !== 0) return;
          const r = card.getBoundingClientRect();
          const pad = 28;
          const nearRight = (r.right - ev.clientX) >= 0 && (r.right - ev.clientX) < pad;
          const nearBottom = (r.bottom - ev.clientY) >= 0 && (r.bottom - ev.clientY) < pad;
          if (!nearRight || !nearBottom) return;

          fmGeomTouched = true;
          fmNativeResizeActive = true;
        } catch (e) {}
      }, { passive: true });

      const endNative = () => {
        if (!fmNativeResizeActive) return;
        fmNativeResizeActive = false;
        fmScheduleSaveGeom();
      };
      window.addEventListener('pointerup', endNative, { passive: true });
      window.addEventListener('pointercancel', endNative, { passive: true });
    } catch (e) {}

    // If the page is loaded on a narrow screen, apply stored geometry later
    // when the viewport becomes wide enough again.
    try {
      window.addEventListener('resize', () => {
        if (fmGeomAppliedOnce) return;
        const g = fmReadGeom();
        if (!g) return;
        if (!fmCanResizeNow()) return;
        fmApplyGeom(g);
        fmGeomAppliedOnce = true;
      }, { passive: true });
    } catch (e) {}
  }

  // -------------------------- fullscreen --------------------------
  // File manager fullscreen is implemented the same way as the terminal chrome:
  // we just toggle a CSS class on the card (no browser Fullscreen API).
  let fmIsFullscreen = false;

  function fmCardEl() {
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
      if (XKeen.ui && XKeen.ui.modal && typeof XKeen.ui.modal.syncBodyScrollLock === 'function') {
        XKeen.ui.modal.syncBodyScrollLock();
      } else {
        document.body.classList.toggle('modal-open', !!fmIsFullscreen);
      }
    } catch (e) {}
  }

  function updateFmFullscreenBtn() {
    const btn = el('fm-fullscreen-btn');
    if (!btn) return;
    if (fmIsFullscreen) {
      btn.textContent = '🗗';
      btn.title = 'Восстановить';
      btn.setAttribute('aria-label', 'Восстановить');
    } else {
      btn.textContent = '⛶';
      btn.title = 'Полный экран';
      btn.setAttribute('aria-label', 'Полный экран');
    }
  }

  function fmSetFullscreen(on) {
    const card = fmCardEl();
    if (!card) return;
    fmIsFullscreen = !!on;
    try { card.classList.toggle('is-fullscreen', fmIsFullscreen); } catch (e) {}
    updateFmFullscreenBtn();
    syncScrollLock();
  }

  function fmToggleFullscreen() {
    fmSetFullscreen(!fmIsFullscreen);
  }

  // -------------------------- bottom-left resize handle --------------------------
  // The CSS `resize: both` only gives a browser handle on the bottom-right.
  // We add our own draggable zone on the bottom-left corner so the card can be
  // resized from the left side (keeping the right edge visually fixed).
  function getFmShiftX(card) {
    try {
      const v = window.getComputedStyle(card).getPropertyValue('--fm-shift-x');
      const n = parseFloat(String(v || '').trim());
      return isFinite(n) ? n : 0;
    } catch (e) {
      return 0;
    }
  }

  function wireLeftResizeHandle() {
    const card = fmCardEl();
    if (!card) return;

    let handle = qs('.fm-resize-handle-left', card);
    if (!handle) {
      try {
        handle = document.createElement('div');
        handle.className = 'fm-resize-handle-left';
        handle.setAttribute('aria-hidden', 'true');
        card.appendChild(handle);
      } catch (e) {
        return;
      }
    }

    // avoid double-wire
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
    let prevBodyUserSelect = '';
    let prevBodyCursor = '';

    function canResizeNow() {
      try {
        if (fmIsFullscreen) return false;
        // On narrow screens we disable resize entirely (see CSS media query).
        if (window.matchMedia && window.matchMedia('(max-width: 920px)').matches) return false;
        return true;
      } catch (e) {
        return !fmIsFullscreen;
      }
    }

    function startDrag(ev) {
      try {
        if (!canResizeNow()) return;
        if (ev && ev.pointerType === 'mouse' && ev.button !== 0) return;
        const r = card.getBoundingClientRect();
        startX = ev.clientX;
        startY = ev.clientY;
        startW = r.width;
        startH = r.height;
        startShiftX = getFmShiftX(card);

        // Ensure pixel-based sizing so the drag math stays stable.
        card.style.width = Math.round(startW) + 'px';
        card.style.height = Math.round(startH) + 'px';
        card.style.setProperty('--fm-shift-x', startShiftX + 'px');

        dragging = true;

        // Mark geometry as user-touched so we start persisting changes.
        fmGeomTouched = true;

        // UX: prevent text selection while resizing.
        prevBodyUserSelect = document.body.style.userSelect || '';
        prevBodyCursor = document.body.style.cursor || '';
        document.body.style.userSelect = 'none';
        document.body.style.cursor = 'nesw-resize';

        try { handle.setPointerCapture(ev.pointerId); } catch (e) {}
        ev.preventDefault();
        ev.stopPropagation();
      } catch (e) {}
    }

    function onMove(ev) {
      if (!dragging) return;
      try {
        let dx = ev.clientX - startX;
        let dy = ev.clientY - startY;

        // When dragging the left handle:
        //  - width grows when mouse goes left (dx < 0)
        //  - we shift the card by dx so the right edge stays visually fixed
        let w = startW - dx;
        let h = startH + dy;

        // Clamp to something sane (avoid collapsing the layout too far).
        const minW = 520;
        const minH = 420;
        const maxH = Math.round(window.innerHeight * 0.90);

        if (w < minW) {
          w = minW;
          dx = startW - w;
        }
        if (h < minH) h = minH;
        if (isFinite(maxH) && maxH > 0 && h > maxH) h = maxH;

        const shiftX = startShiftX + dx;
        card.style.width = Math.round(w) + 'px';
        card.style.height = Math.round(h) + 'px';
        card.style.setProperty('--fm-shift-x', Math.round(shiftX) + 'px');

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

      // Persist final geometry after a resize from the left corner.
      try {
        fmGeomTouched = true;
        fmScheduleSaveGeom();
      } catch (e) {}
    }

    // Pointer events cover mouse + touch and are well supported on modern browsers.
    handle.addEventListener('pointerdown', startDrag, { passive: false });
    handle.addEventListener('pointermove', onMove, { passive: false });
    handle.addEventListener('pointerup', endDrag, { passive: false });
    handle.addEventListener('pointercancel', endDrag, { passive: false });
    handle.addEventListener('lostpointercapture', endDrag, { passive: false });
  }

  // -------------------------- small helpers --------------------------
  function el(id) {
    try { return document.getElementById(id); } catch (e) { return null; }
  }

  function qs(sel, root) {
    try { return (root || document).querySelector(sel); } catch (e) { return null; }
  }

  function qsa(sel, root) {
    try { return Array.from((root || document).querySelectorAll(sel) || []); } catch (e) { return []; }
  }

  function show(node) {
    if (!node) return;
    try { node.style.display = ''; } catch (e) {}
  }

  function hide(node) {
    if (!node) return;
    try { node.style.display = 'none'; } catch (e) {}
  }

  function modalOpen(modal) {
    if (!modal) return;
    try { modal.classList.remove('hidden'); } catch (e) {}
    try {
      if (XKeen.ui && XKeen.ui.modal && typeof XKeen.ui.modal.syncBodyScrollLock === 'function') {
        XKeen.ui.modal.syncBodyScrollLock();
      } else {
        document.body.classList.add('modal-open');
      }
    } catch (e) {}
  }

  function modalClose(modal) {
    if (!modal) return;
    try { modal.classList.add('hidden'); } catch (e) {}
    try {
      if (XKeen.ui && XKeen.ui.modal && typeof XKeen.ui.modal.syncBodyScrollLock === 'function') {
        XKeen.ui.modal.syncBodyScrollLock();
      } else {
        document.body.classList.remove('modal-open');
      }
    } catch (e) {}
  }

  function isTextInputActive() {
    const a = document.activeElement;
    if (!a) return false;
    const tag = (a.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (a.isContentEditable) return true;
    return false;
  }

  function isFilesViewVisible() {
    const view = el('view-files');
    if (!view) return false;
    const cs = window.getComputedStyle(view);
    return !!cs && cs.display !== 'none' && cs.visibility !== 'hidden';
  }

  function fmtSize(bytes) {
    // NOTE: 0-byte files are valid and should be shown as "0 B".
    // Keep empty for missing/invalid/negative values.
    if (bytes === null || bytes === undefined || bytes === '') return '';
    const n = Number(bytes);
    if (!isFinite(n) || n < 0) return '';
    if (n === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let v = n;
    let u = 0;
    while (v >= 1024 && u < units.length - 1) {
      v /= 1024;
      u++;
    }
    const s = (u === 0) ? String(Math.round(v)) : (v >= 10 ? v.toFixed(1) : v.toFixed(2));
    return s.replace(/\.0+$/, '').replace(/(\.[1-9])0$/, '$1') + ' ' + units[u];
  }

  function fmtTime(ts) {
    const t = Number(ts || 0);
    if (!isFinite(t) || t <= 0) return '';
    try {
      const d = new Date(t * 1000);
      // Keep compact: YYYY-MM-DD HH:MM
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      const hh = String(d.getHours()).padStart(2, '0');
      const mi = String(d.getMinutes()).padStart(2, '0');
      return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
    } catch (e) {
      return '';
    }
  }

  function safeName(s) {
    return String(s == null ? '' : s);
  }

  function joinLocal(cwd, name) {
    const c = String(cwd || '');
    const n = String(name || '');
    if (!c) return n;
    if (!n) return c;
    const sep = c.endsWith('/') ? '' : '/';
    return c + sep + n;
  }

  function parentLocal(cwd) {
    const p = String(cwd || '').replace(/\/+$/, '');
    if (!p || p === '/') return '/';
    const idx = p.lastIndexOf('/');
    if (idx <= 0) return '/';
    return p.slice(0, idx) || '/';
  }

  
function normRemotePath(p) {
  let s = String(p || '').trim();
  if (!s || s === '~') return '.';
  if (s === '.') return '.';
  s = s.replace(/\/{2,}/g, '/');
  if (s.length > 1) s = s.replace(/\/+$/, '');
  return s || '.';
}

function joinRemote(cwd, name) {
  const c0 = normRemotePath(cwd);
  let n = String(name || '').trim();
  if (!n) return c0 || '.';
  n = n.replace(/\/+$/, '');
  if (n === '') n = '/';
  if (n.startsWith('/')) return normRemotePath(n);
  if (!c0 || c0 === '.') return normRemotePath(n);
  const sep = c0.endsWith('/') ? '' : '/';
  return normRemotePath(c0 + sep + n);
}

function parentRemote(cwd) {
  const p0 = normRemotePath(cwd);
  if (!p0 || p0 === '.') return '.';
  if (p0 === '/') return '/';
  const p = String(p0).replace(/\/+$/, '');
  const idx = p.lastIndexOf('/');
  if (idx < 0) return '.';
  if (idx === 0) return '/';
  const up = p.slice(0, idx);
  return up ? up : '/';
}

  function _trimSlashes(p) {
    return String(p || '').replace(/\/+$/, '') || '/';
  }

  function _isUnderRoot(path, root) {
    const pp = _trimSlashes(path);
    const rr = _trimSlashes(root);
    if (rr === '/') return true;
    return pp === rr || pp.startsWith(rr + '/');
  }

  function isAllowedLocalPath(path, roots) {
    const rr = Array.isArray(roots) ? roots : [];
    if (!rr.length) return true;
    for (const r of rr) {
      if (_isUnderRoot(path, r)) return true;
    }
    return false;
  }


  function getCsrfToken() {
    try {
      const m = document.querySelector('meta[name="csrf-token"]');
      const v = m ? (m.getAttribute('content') || '') : '';
      return String(v || '');
    } catch (e) {
      return '';
    }
  }

  async function fetchJson(url, init) {
    const opts = init ? Object.assign({}, init) : {};
    const method = String(opts.method || 'GET').toUpperCase();

    // Normalize headers
    let headers = opts.headers || {};
    try {
      if (headers instanceof Headers) {
        // ok
      } else if (Array.isArray(headers)) {
        headers = new Headers(headers);
      } else {
        headers = new Headers(headers || {});
      }
    } catch (e) {
      headers = new Headers();
    }

    // CSRF for mutating API calls
    if (method !== 'GET' && method !== 'HEAD') {
      const tok = getCsrfToken();
      if (tok && !headers.get('X-CSRF-Token')) headers.set('X-CSRF-Token', tok);
    }

    opts.headers = headers;

    const res = await fetch(url, opts);
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    return { res, data };
  }

  // -------------------------- XHR transfers (upload/download with progress) --------------------------
  function _nowMs() {
    try { return Date.now(); } catch (e) { return 0; }
  }

  function _parseContentDispositionFilename(headerVal) {
    const v = String(headerVal || '');
    if (!v) return '';
    // RFC5987: filename*=UTF-8''...
    const m5987 = v.match(/filename\*\s*=\s*([^']*)''([^;]+)/i);
    if (m5987 && m5987[2]) {
      try { return decodeURIComponent(m5987[2].trim().replace(/^"|"$/g, '')); } catch (e) {}
    }
    const m = v.match(/filename\s*=\s*"?([^";]+)"?/i);
    if (m && m[1]) return String(m[1]).trim();
    return '';
  }
  // Progress modal: show details only on failure, and auto-close on success
  let _progressAutoCloseTimer = null;

  function _clearProgressAutoClose() {
    try { if (_progressAutoCloseTimer) clearTimeout(_progressAutoCloseTimer); } catch (e) {}
    _progressAutoCloseTimer = null;
  }

  function _scheduleProgressAutoClose(delayMs) {
    _clearProgressAutoClose();
    const d = Math.max(0, Number(delayMs || 0));
    _progressAutoCloseTimer = setTimeout(() => {
      try { modalClose(el('fm-progress-modal')); } catch (e) {}
    }, d);
  }

  function _ensureProgressDetailsToggle() {
    const modal = el('fm-progress-modal');
    if (!modal) return;
    const body = qs('.modal-body', modal);
    const details = el('fm-progress-details');
    if (!body || !details) return;

    // Create toggle UI once (hidden by default).
    if (!el('fm-progress-details-toggle')) {
      // Hide raw JSON by default (can be opened for debugging).
      details.style.display = 'none';
      const wrap = document.createElement('div');
      wrap.id = 'fm-progress-details-wrap';
      wrap.style.display = 'none';
      wrap.style.justifyContent = 'flex-end';
      wrap.style.marginTop = '10px';

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn-secondary';
      btn.id = 'fm-progress-details-toggle';
      btn.textContent = 'Детали';
      btn.onclick = () => {
        const shown = details.style.display !== 'none';
        details.style.display = shown ? 'none' : 'block';
        btn.textContent = shown ? 'Детали' : 'Скрыть детали';
      };
      wrap.appendChild(btn);
      body.insertBefore(wrap, details);
    }
  }

  function _setProgressDetailsAvailable(available) {
    _ensureProgressDetailsToggle();
    const wrap = el('fm-progress-details-wrap');
    const btn = el('fm-progress-details-toggle');
    const details = el('fm-progress-details');
    if (!wrap || !btn || !details) return;

    if (available) {
      wrap.style.display = 'flex';
    } else {
      wrap.style.display = 'none';
      details.style.display = 'none';
      btn.textContent = 'Детали';
    }
  }

  function _setProgressUi({ titleText, pct, metaText, errorText, detailsText }) {
    const title = el('fm-progress-title');
    const bar = el('fm-progress-bar-inner');
    const meta = el('fm-progress-meta');
    const details = el('fm-progress-details');
    const err = el('fm-progress-error');

    if (title && titleText != null) title.textContent = String(titleText);
    if (bar && pct != null && isFinite(Number(pct))) {
      const p = Math.max(0, Math.min(100, Number(pct)));
      bar.style.width = p + '%';
    }
    if (meta && metaText != null) meta.textContent = String(metaText);
    if (err) err.textContent = errorText ? String(errorText) : '';
    if (details && detailsText != null) details.textContent = String(detailsText);
  }

  // -------------------------- progress modal helpers --------------------------
  function _pad2(n) {
    const v = Math.floor(Math.abs(Number(n || 0)));
    return (v < 10 ? '0' : '') + String(v);
  }

  function _fmtTimeFromSec(tsSec) {
    const ts = Number(tsSec || 0);
    if (!isFinite(ts) || ts <= 0) return '';
    const d = new Date(ts * 1000);
    return `${_pad2(d.getHours())}:${_pad2(d.getMinutes())}:${_pad2(d.getSeconds())}`;
  }

  function _fmtDateFromSec(tsSec) {
    const ts = Number(tsSec || 0);
    if (!isFinite(ts) || ts <= 0) return '';
    const d = new Date(ts * 1000);
    return `${d.getFullYear()}-${_pad2(d.getMonth() + 1)}-${_pad2(d.getDate())}`;
  }

  function _isSameLocalDay(tsA, tsB) {
    try {
      const a = new Date(Number(tsA || 0) * 1000);
      const b = new Date(Number(tsB || 0) * 1000);
      return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    } catch (e) {
      return false;
    }
  }

  function _fmtWhenFromSec(tsSec) {
    const ts = Number(tsSec || 0);
    if (!isFinite(ts) || ts <= 0) return '';
    const nowSec = _nowMs() / 1000;
    const time = _fmtTimeFromSec(ts);
    if (_isSameLocalDay(ts, nowSec)) return time;
    return `${_fmtDateFromSec(ts)} ${time}`;
  }

  function _fmtDurationSec(seconds) {
    const s = Math.max(0, Math.round(Number(seconds || 0)));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    if (h > 0) return `${h}h ${m}m ${r}s`;
    if (m > 0) return `${m}m ${r}s`;
    return `${r}s`;
  }

  async function _copyText(text) {
    const v = String(text || '');
    if (!v) return;
    try {
      if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(v);
        toast('Скопировано', 'success');
        return;
      }
    } catch (e) {}
    // Fallback
    try {
      const ta = document.createElement('textarea');
      ta.value = v;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      toast('Скопировано', 'success');
    } catch (e2) {
      // ignore
    }
  }

  function _ensureProgressExtra() {
    const modal = el('fm-progress-modal');
    const meta = el('fm-progress-meta');
    if (!modal || !meta) return;
    if (el('fm-progress-extra')) return;

    const wrap = document.createElement('div');
    wrap.id = 'fm-progress-extra';
    wrap.className = 'fm-progress-extra';
    wrap.innerHTML = `
      <div class="fm-progress-extra-left">
        <span style="opacity:.85;">Job:</span>
        <span id="fm-progress-jobid" class="fm-mono" style="margin-left:6px;"></span>
        <button type="button" class="btn-secondary" id="fm-progress-copyid-btn" style="padding:4px 10px;">Копировать</button>
      </div>
      <div class="fm-progress-extra-right" id="fm-progress-times"></div>
    `;

    // Insert after the meta line.
    meta.parentNode.insertBefore(wrap, meta.nextSibling);

    const copyBtn = el('fm-progress-copyid-btn');
    if (copyBtn) {
      copyBtn.onclick = (e) => {
        try { e.preventDefault(); } catch (e2) {}
        const jid = el('fm-progress-jobid') ? String(el('fm-progress-jobid').textContent || '') : '';
        _copyText(jid);
      };
    }
  }

  function _setProgressExtra(job) {
    _ensureProgressExtra();
    const jidEl = el('fm-progress-jobid');
    const copyBtn = el('fm-progress-copyid-btn');
    const timesEl = el('fm-progress-times');
    const wrap = el('fm-progress-extra');

    const jobId = String(job && job.job_id || '');
    if (jidEl) jidEl.textContent = jobId;
    if (copyBtn) copyBtn.style.display = jobId ? '' : 'none';
    if (wrap) wrap.style.display = jobId ? 'flex' : 'none';

    const created = Number(job && job.created_ts || 0);
    const started = Number(job && job.started_ts || 0);
    const finished = Number(job && job.finished_ts || 0);
    const now = _nowMs() / 1000;

    let dur = 0;
    if (started > 0 && finished > 0) dur = finished - started;
    else if (started > 0 && (!finished || finished <= 0)) dur = now - started;
    else if (created > 0 && finished > 0) dur = finished - created;

    const parts = [];
    if (created) parts.push(`создано ${_fmtWhenFromSec(created)}`);
    if (started) parts.push(`старт ${_fmtWhenFromSec(started)}`);
    if (finished) parts.push(`финиш ${_fmtWhenFromSec(finished)}`);
    if (dur > 0) parts.push(`длительность ${_fmtDurationSec(dur)}`);

    if (timesEl) timesEl.textContent = parts.join('   ');
  }

  function _resetTransferState() {
    S.transfer.xhr = null;
    S.transfer.kind = '';
    S.transfer.startedAtMs = 0;
    S.transfer.lastAtMs = 0;
    S.transfer.lastLoaded = 0;
    S.transfer.speed = 0;
  }

  function _transferSpeedBytesPerSec(loaded) {
    const now = _nowMs();
    if (!S.transfer.startedAtMs) {
      S.transfer.startedAtMs = now;
      S.transfer.lastAtMs = now;
      S.transfer.lastLoaded = Number(loaded || 0);
      S.transfer.speed = 0;
      return 0;
    }
    const dt = Math.max(1, now - (S.transfer.lastAtMs || now));
    const db = Math.max(0, Number(loaded || 0) - Number(S.transfer.lastLoaded || 0));
    const inst = (db * 1000) / dt;
    // EWMA smoothing
    const prev = Number(S.transfer.speed || 0);
    const next = prev ? (prev * 0.75 + inst * 0.25) : inst;
    S.transfer.speed = next;
    S.transfer.lastAtMs = now;
    S.transfer.lastLoaded = Number(loaded || 0);
    return next;
  }

  function _fmtSpeed(bps) {
    const v = Number(bps || 0);
    if (!isFinite(v) || v <= 0) return '';
    return fmtSize(v) + '/s';
  }

  function _fmtEta(seconds) {
    const s = Number(seconds || 0);
    if (!isFinite(s) || s <= 0) return '';
    const sec = Math.round(s);
    const m = Math.floor(sec / 60);
    const r = sec % 60;
    if (m <= 0) return `${r}s`;
    const h = Math.floor(m / 60);
    const mm = m % 60;
    if (h <= 0) return `${m}m ${r}s`;
    return `${h}h ${mm}m`;
  }

  function _openTransferModal(kindLabel, fileLabel) {
    _ensureProgressDetailsToggle();
    _setProgressDetailsAvailable(false);
    _clearProgressAutoClose();

    // Reset progress modal action buttons in case it was previously opened in a "view-only" mode.
    try {
      const cbtn = el('fm-progress-cancel-btn');
      if (cbtn) cbtn.style.display = '';
      const okBtn = el('fm-progress-ok-btn');
      if (okBtn) okBtn.textContent = 'Скрыть';
    } catch (e) {}

    // Hide job metadata block for transfers.
    try {
      _ensureProgressExtra();
      const wrap = el('fm-progress-extra');
      const jid = el('fm-progress-jobid');
      const times = el('fm-progress-times');
      if (jid) jid.textContent = '';
      if (times) times.textContent = '';
      if (wrap) wrap.style.display = 'none';
    } catch (e) {}

    modalOpen(el('fm-progress-modal'));
    _resetTransferState();
    _setProgressUi({
      titleText: `${kindLabel}${fileLabel ? (' — ' + fileLabel) : ''}`,
      pct: 0,
      metaText: '',
      errorText: '',
      detailsText: '',
    });
  }

  function _bindProgressCancel(onCancel) {
    const cancelBtn = el('fm-progress-cancel-btn');
    if (!cancelBtn) return;
    cancelBtn.disabled = false;
    cancelBtn.onclick = (e) => {
      e && e.preventDefault && e.preventDefault();
      try { onCancel && onCancel(); } catch (e2) {}
    };
  }
  function _finishTransferUi({ ok, message, detailsText, showDetails }) {
    _ensureProgressDetailsToggle();
    const cancelBtn = el('fm-progress-cancel-btn');
    if (cancelBtn) {
      cancelBtn.disabled = true;
      cancelBtn.onclick = null;
    }

    if (ok) {
      // On success we auto-close the modal (toast already informs the user).
      _setProgressUi({ errorText: '' });
      _setProgressDetailsAvailable(false);
      _clearProgressAutoClose();
      _scheduleProgressAutoClose(650);
      return;
    }

    const wantDetails = (showDetails === undefined) ? true : !!showDetails;
    _setProgressDetailsAvailable(wantDetails);
    if (detailsText != null) {
      _setProgressUi({ detailsText: String(detailsText) });
    }
    _setProgressUi({ errorText: message || 'transfer_failed' });
  }

  function xhrDownloadFile({ url, filenameHint, titleLabel, method, body, headers, _confirmRetry }) {
  _openTransferModal(titleLabel || 'Download', filenameHint || '');

  const xhr = new XMLHttpRequest();
  S.transfer.xhr = xhr;
  S.transfer.kind = 'download';

  _bindProgressCancel(() => {
    try { xhr.abort(); } catch (e) {}
    _finishTransferUi({ ok: false, message: 'Отменено', showDetails: false, detailsText: 'Отменено пользователем' });
  });

  const m = String(method || 'GET').toUpperCase();
  xhr.open(m, url, true);
  xhr.responseType = 'blob';

  // Headers
  try {
    if (headers && typeof headers === 'object') {
      for (const [k, v] of Object.entries(headers)) {
        if (v == null) continue;
        xhr.setRequestHeader(String(k), String(v));
      }
    }
  } catch (e) {}

  // CSRF for POST/PUT/DELETE
  if (m !== 'GET' && m !== 'HEAD') {
    try {
      const tok = getCsrfToken();
      if (tok) xhr.setRequestHeader('X-CSRF-Token', tok);
    } catch (e) {}
  }

  // Body normalize (object -> JSON)
  let sendBody = body;
  if (sendBody && typeof sendBody === 'object' && !(sendBody instanceof Blob) && !(sendBody instanceof ArrayBuffer)) {
    try {
      sendBody = JSON.stringify(sendBody);
      // Set content type if not already set by headers.
      try { xhr.setRequestHeader('Content-Type', 'application/json'); } catch (e) {}
    } catch (e) {}
  }

  xhr.onprogress = (ev) => {
    const loaded = Number(ev.loaded || 0);
    const total = Number(ev.total || 0);
    const speed = _transferSpeedBytesPerSec(loaded);
    const pct = (ev.lengthComputable && total > 0) ? Math.round((loaded / total) * 100) : 0;
    const eta = (ev.lengthComputable && total > 0 && speed > 1) ? (total - loaded) / speed : 0;
    const metaParts = [];
    if (ev.lengthComputable && total > 0) metaParts.push(`${fmtSize(loaded)} / ${fmtSize(total)} (${pct}%)`);
    else metaParts.push(`${fmtSize(loaded)}`);
    const sp = _fmtSpeed(speed);
    if (sp) metaParts.push(sp);
    const et = _fmtEta(eta);
    if (et) metaParts.push('ETA ' + et);
    _setProgressUi({ pct, metaText: metaParts.join('   ') });
  };

  xhr.onerror = () => {
    _finishTransferUi({ ok: false, message: 'Ошибка сети', detailsText: 'network_error', showDetails: true });
  };

  const _readXhrText = (xhr) => new Promise((resolve) => {
    try {
      const r = xhr && xhr.response;
      if (r && typeof Blob !== 'undefined' && r instanceof Blob) {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result || ''));
        fr.onerror = () => resolve('');
        try { fr.readAsText(r); } catch (e) { resolve(''); }
        return;
      }
    } catch (e) {}
    try { resolve(String((xhr && xhr.responseText) || '')); } catch (e) { resolve(''); }
  });

  const _addConfirmParam = (u) => {
    try {
      const U = new URL(String(u || ''), window.location.origin);
      U.searchParams.set('confirm', '1');
      return U.pathname + U.search;
    } catch (e) {
      // fallback for odd relative URLs
      if (String(u || '').indexOf('?') >= 0) return String(u) + '&confirm=1';
      return String(u) + '?confirm=1';
    }
  };

  xhr.onload = async () => {
    if (xhr.status >= 200 && xhr.status < 300) {
      const cd = xhr.getResponseHeader('Content-Disposition');
      const name = _parseContentDispositionFilename(cd) || filenameHint || 'download';
      try {
        const blob = xhr.response;
        const a = document.createElement('a');
        const u = URL.createObjectURL(blob);
        a.href = u;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          try { URL.revokeObjectURL(u); } catch (e) {}
          try { a.remove(); } catch (e) {}
        }, 500);
      } catch (e) {}
      _setProgressUi({ pct: 100 });
      _finishTransferUi({ ok: true });
      try { toast('Скачано: ' + name, 'success'); } catch (e) {}
      return;
    }

    const raw = await _readXhrText(xhr);
    let j = null;
    try { j = JSON.parse(String(raw || '')); } catch (e) { j = null; }

    // Confirm-required flow (server-side size estimation is truncated/unknown).
    if (xhr.status === 409 && j && String(j.error || '') === 'confirm_required' && !_confirmRetry) {
      let ok = true;
      const msgText = String(j.message || 'Размер архива не удалось оценить точно. Продолжить?');
      try {
        if (window.XKeen && XKeen.ui && typeof XKeen.ui.confirm === 'function') {
          ok = await XKeen.ui.confirm({
            title: 'Подтверждение',
            message: msgText,
            okText: 'Продолжить',
            cancelText: 'Отмена',
            danger: true,
          });
        } else {
          ok = window.confirm(msgText);
        }
      } catch (e) { ok = true; }

      if (!ok) {
        _finishTransferUi({ ok: false, message: 'Отменено', showDetails: false, detailsText: 'Отменено пользователем' });
        return;
      }

      // Retry same request with confirm=1
      try { modalClose(el('fm-progress-modal')); } catch (e) {}
      const newUrl = _addConfirmParam(url);
      xhrDownloadFile({ url: newUrl, filenameHint, titleLabel, method, body, headers, _confirmRetry: true });
      return;
    }

    let msg = `HTTP ${xhr.status}`;
    if (j) {
      msg = String(j.message || j.error || msg);
      if (String(j.error || '') === 'zip_too_large' && j.estimated_bytes != null && j.max_bytes != null) {
        try { msg = `Архив слишком большой: ${fmtSize(Number(j.estimated_bytes))} > лимит ${fmtSize(Number(j.max_bytes))}`; } catch (e) {}
      } else if (String(j.error || '') === 'tmp_no_space' && j.free_bytes != null && j.required_bytes != null) {
        try { msg = `Недостаточно места в /tmp: нужно ${fmtSize(Number(j.required_bytes))}, доступно ${fmtSize(Number(j.free_bytes))}`; } catch (e) {}
      } else if (String(j.error || '') === 'tmp_limit_exceeded') {
        msg = String(j.message || 'Превышен лимит использования /tmp при создании архива');
      }
    }
    _finishTransferUi({ ok: false, message: msg, detailsText: raw || '', showDetails: true });
  };

  try {
    xhr.send(sendBody || null);
  } catch (e) {
    try { xhr.send(); } catch (e2) {}
  }
}

  // -------------------------- upload conflicts (same-name) --------------------------
  // Upload now refuses to overwrite by default (server returns 409 exists).
  // We resolve the conflict client-side via a small modal.
  let _uploadConflictBound = false;
  let _uploadConflictResolver = null;
  let _uploadConflictEscHandler = null;

  function _ensureUploadConflictModal() {
    const modal = el('fm-upload-conflict-modal');
    const title = el('fm-upload-conflict-title');
    const message = el('fm-upload-conflict-message');
    const overwriteBtn = el('fm-upload-conflict-overwrite-btn');
    const renameBtn = el('fm-upload-conflict-rename-btn');
    const skipBtn = el('fm-upload-conflict-skip-btn');
    const closeBtn = el('fm-upload-conflict-close-btn');

    if (!modal || !title || !message || !overwriteBtn || !renameBtn || !skipBtn || !closeBtn) return null;

    function closeWith(choice) {
      try { modalClose(modal); } catch (e) {}
      if (_uploadConflictEscHandler) {
        try { document.removeEventListener('keydown', _uploadConflictEscHandler); } catch (e) {}
        _uploadConflictEscHandler = null;
      }
      const r = _uploadConflictResolver;
      _uploadConflictResolver = null;
      if (typeof r === 'function') {
        try { r(String(choice || 'skip')); } catch (e) {}
      }
    }

    if (!_uploadConflictBound) {
      _uploadConflictBound = true;

      overwriteBtn.addEventListener('click', (e) => { e.preventDefault(); closeWith('overwrite'); });
      renameBtn.addEventListener('click', (e) => { e.preventDefault(); closeWith('rename'); });
      skipBtn.addEventListener('click', (e) => { e.preventDefault(); closeWith('skip'); });
      closeBtn.addEventListener('click', (e) => { e.preventDefault(); closeWith('skip'); });

      modal.addEventListener('click', (e) => {
        // Click on backdrop closes.
        if (e.target === modal) closeWith('skip');
      });
    }

    // ESC closes as skip.
    _uploadConflictEscHandler = (e) => {
      if (e && (e.key === 'Escape' || e.key === 'Esc')) closeWith('skip');
    };

    return { modal, title, message, overwriteBtn, renameBtn, skipBtn };
  }

  function _sanitizeUploadName(name) {
    let s = String(name || '').trim();
    if (!s) s = 'upload.bin';
    // Prevent path traversal / odd separators.
    s = s.replace(/[\\/]+/g, '_');
    s = s.replace(/\s+/g, ' ').trim();
    if (s === '.' || s === '..') s = 'upload.bin';
    if (!s) s = 'upload.bin';
    return s;
  }

  function _splitNameExt(name) {
    const s = _sanitizeUploadName(name);
    const lastDot = s.lastIndexOf('.');
    // Treat dotfiles like ".env" as "no extension".
    if (lastDot > 0 && lastDot < s.length - 1) {
      return { base: s.slice(0, lastDot), ext: s.slice(lastDot) };
    }
    return { base: s, ext: '' };
  }

  function _buildRenameCandidates(name, maxN) {
    const { base, ext } = _splitNameExt(name);
    const out = [];
    const nmax = Math.max(1, Math.min(200, Number(maxN || 40)));
    for (let i = 1; i <= nmax; i++) {
      out.push(`${base} (${i})${ext}`);
    }
    return out;
  }

  async function _pickFirstFreeName(side, desiredName) {
    const p = S.panels[side];
    if (!p) return _sanitizeUploadName(desiredName);
    const candidates = _buildRenameCandidates(desiredName, 60);
    const fullPaths = candidates.map((nm) => (p.target === 'remote' ? joinRemote(p.cwd, nm) : joinLocal(p.cwd, nm)));

    // Try an accurate check via /api/fs/stat-batch (best effort).
    try {
      const payload = { target: p.target, paths: fullPaths };
      if (p.target === 'remote') payload.sid = p.sid;
      const { res, data } = await fetchJson('/api/fs/stat-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res && res.ok && data && data.ok && Array.isArray(data.items) && data.items.length === fullPaths.length) {
        for (let i = 0; i < data.items.length; i++) {
          const it = data.items[i];
          if (!it || !it.exists) return candidates[i];
        }
      }
    } catch (e) {}

    // Fallback to current panel listing.
    try {
      const existing = new Set((p.items || []).map((it) => safeName(it && it.name)));
      for (const nm of candidates) {
        if (!existing.has(nm)) return nm;
      }
    } catch (e) {}

    return candidates[candidates.length - 1] || (_sanitizeUploadName(desiredName) + ' (1)');
  }

  async function _askUploadConflict({ name, cwd, target, existingType }) {
    const ui = _ensureUploadConflictModal();
    const nm = _sanitizeUploadName(name);
    const dir = (String(target || '').toLowerCase() === 'remote')
      ? (normRemotePath(cwd) || '.')
      : (String(cwd || '').trim() || '/');
    const kind = (existingType === 'dir') ? 'папка' : 'файл';

    if (!ui) {
      // Fallback: simple confirm => overwrite? Cancel => skip.
      const ok = window.confirm(`В папке ${dir} уже есть ${kind} «${nm}». Перезаписать?`);
      return ok ? 'overwrite' : 'skip';
    }

    // Close previous if any.
    if (typeof _uploadConflictResolver === 'function') {
      try { _uploadConflictResolver('skip'); } catch (e) {}
      _uploadConflictResolver = null;
    }

    ui.title.textContent = (existingType === 'dir') ? 'Папка уже существует' : 'Файл уже существует';
    ui.message.textContent = `В папке ${dir} уже есть ${kind} «${nm}». Что сделать с загружаемым файлом?`;
    try { ui.overwriteBtn.disabled = (existingType === 'dir'); } catch (e) {}

    modalOpen(ui.modal);
    try { document.addEventListener('keydown', _uploadConflictEscHandler); } catch (e) {}
    setTimeout(() => {
      try { ui.skipBtn.focus(); } catch (e) {}
    }, 0);

    return new Promise((resolve) => { _uploadConflictResolver = resolve; });
  }

async function xhrUploadFiles({ side, files }) {
    const p = S.panels[side];
    if (!p) return;
    if (!files || !files.length) return;
    if (p.target === 'remote' && !p.sid) {
      toast('Upload: remote без сессии', 'info');
      return false;
    }

    // Upload sequentially for predictable UI.
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const originalName = _sanitizeUploadName(file && file.name);
      if (!originalName) continue;

      const nameToType = new Map();
      try { (p.items || []).forEach((it) => { if (it && it.name) nameToType.set(safeName(it.name), String(it.type || 'file')); }); } catch (e) {}
      const existingSet = new Set(Array.from(nameToType.keys()));

      let finalName = originalName;
      let overwrite = false;

      // Preflight conflict resolution using current listing.
      while (existingSet.has(finalName) && !overwrite) {
        const choice = await _askUploadConflict({ name: finalName, cwd: p.cwd, target: p.target, existingType: nameToType.get(finalName) || 'file' });
        if (choice === 'skip') {
          try { toast('Пропущено: ' + originalName, 'info'); } catch (e) {}
          finalName = '';
          break;
        }
        if (choice === 'overwrite') {
          overwrite = true;
          break;
        }
        // rename
        finalName = await _pickFirstFreeName(side, finalName);
        overwrite = false;
      }

      if (!finalName) continue;

      let attempt = 0;
      let uploadedOk = false;
      let skipped = false;
      let hardFail = false;
      while (attempt < 3) {
        attempt++;

        const destPath = (p.target === 'remote') ? joinRemote(p.cwd, finalName) : joinLocal(p.cwd, finalName);
        const label = (finalName === originalName)
          ? `${finalName} (${i + 1}/${files.length})`
          : `${originalName} → ${finalName} (${i + 1}/${files.length})`;

        _openTransferModal('Upload', label);

        const url = (() => {
          let u = `/api/fs/upload?target=${encodeURIComponent(p.target)}&path=${encodeURIComponent(destPath)}`;
          if (p.target === 'remote') u += `&sid=${encodeURIComponent(p.sid)}`;
          if (overwrite) u += '&overwrite=1';
          return u;
        })();

        const xhr = new XMLHttpRequest();
        S.transfer.xhr = xhr;
        S.transfer.kind = 'upload';

        _bindProgressCancel(() => {
          try { xhr.abort(); } catch (e) {}
          _finishTransferUi({ ok: false, message: 'Отменено', showDetails: false, detailsText: 'Отменено пользователем' });
        });

        xhr.open('POST', url, true);
        // CSRF
        try {
          const tok = getCsrfToken();
          if (tok) xhr.setRequestHeader('X-CSRF-Token', tok);
        } catch (e) {}

        xhr.upload.onprogress = (ev) => {
          const loaded = Number(ev.loaded || 0);
          const total = Number(ev.total || 0);
          const speed = _transferSpeedBytesPerSec(loaded);
          const pct = (ev.lengthComputable && total > 0) ? Math.round((loaded / total) * 100) : 0;
          const eta = (ev.lengthComputable && total > 0 && speed > 1) ? (total - loaded) / speed : 0;
          const metaParts = [];
          if (ev.lengthComputable && total > 0) metaParts.push(`${fmtSize(loaded)} / ${fmtSize(total)} (${pct}%)`);
          else metaParts.push(`${fmtSize(loaded)}`);
          const sp = _fmtSpeed(speed);
          if (sp) metaParts.push(sp);
          const et = _fmtEta(eta);
          if (et) metaParts.push('ETA ' + et);
          _setProgressUi({ pct, metaText: metaParts.join('   ') });
        };

        xhr.upload.onloadend = () => {
          try { _setProgressUi({ pct: 100, metaText: 'Передано, завершаю на роутере…' }); } catch (e) {}
        };

        const form = new FormData();
        form.append('file', file, finalName);

        const result = await new Promise((resolve) => {
          xhr.onerror = () => resolve({ ok: false, status: xhr.status || 0, text: '' });
          xhr.onabort = () => resolve({ ok: false, status: xhr.status || 0, text: '' });
          xhr.onload = () => {
            const text = String(xhr.responseText || '');
            if (xhr.status >= 200 && xhr.status < 300) {
              try {
                const j = JSON.parse(text || '{}');
                if (j && j.ok) return resolve({ ok: true, status: xhr.status, text, json: j });
              } catch (e) {}
              return resolve({ ok: true, status: xhr.status, text });
            }
            let j = null;
            try { j = JSON.parse(text || '{}'); } catch (e) { j = null; }
            return resolve({ ok: false, status: xhr.status, text, json: j });
          };
          xhr.send(form);
        });

        if (result && result.ok) {
          _setProgressUi({ pct: 100, metaText: 'Завершено' });
          _finishTransferUi({ ok: true });
          try { toast('Загружено: ' + finalName, 'success'); } catch (e) {}
          uploadedOk = true;
          break;
        }

        // Conflict returned by server (race / stale listing): ask and retry.
        const err = String((result && result.json && (result.json.error || result.json.message)) || '');
        if (result && result.status === 409 && (err === 'exists' || err === 'not_a_file')) {
          try { modalClose(el('fm-progress-modal')); } catch (e) {}
          const exType = String((result.json && result.json.type) || (err === 'not_a_file' ? 'dir' : 'file'));
          const choice = await _askUploadConflict({ name: finalName, cwd: p.cwd, target: p.target, existingType: exType });
          if (choice === 'skip') {
            try { toast('Пропущено: ' + originalName, 'info'); } catch (e) {}
            skipped = true;
            break;
          }
          if (choice === 'overwrite') {
            overwrite = true;
            continue;
          }
          // rename
          overwrite = false;
          finalName = await _pickFirstFreeName(side, finalName);
          continue;
        }

        // Real error.
        let msg = 'upload_failed';
        try {
          const j = result && result.json;
          msg = String((j && (j.error || j.message)) || msg);
        } catch (e) {}
        _finishTransferUi({ ok: false, message: msg, detailsText: (result && result.text) || '' });
        hardFail = true;
        break;
      }

      if (uploadedOk) {
        await listPanel(side, { fromInput: false });
        continue;
      }

      // No success.
      if (skipped) {
        continue;
      }

      // If we hit a real error OR retried conflicts too many times, stop the batch.
      if (hardFail || attempt >= 3) {
        break;
      }
    }
  }

  // -------------------------- state --------------------------
  const S = {
    enabled: false,
    caps: null,
    remoteCaps: null,
    prefs: {
      sort: loadSortPref(),
      showHidden: loadShowHiddenPref(),
    },
    activeSide: 'left',
    create: { kind: '', side: 'left' },
    rename: { side: 'left', oldName: '' },
    ctxMenu: { shown: false, side: 'left', name: '', isDir: false },
    dropOp: { resolve: null }, // drag&drop move/copy choice modal
    panels: {
      left: { target: 'local', sid: '', cwd: '/opt/var', roots: [], items: [], selected: new Set(), focusName: '', anchorName: '', filter: '' },
      // Keenetic-friendly default: right panel opens at disk list (/tmp/mnt)
      right: { target: 'local', sid: '', cwd: '/tmp/mnt', roots: [], items: [], selected: new Set(), focusName: '', anchorName: '', filter: '' },
    },
    connectForSide: 'left',
    pending: null, // { op, payload, conflicts }
    ws: { socket: null, jobId: '', token: '', pollTimer: null },
    jobStats: {}, // job_id -> { lastTsMs, lastBytes, speed }
    transfer: { xhr: null, kind: '', startedAtMs: 0, lastAtMs: 0, lastLoaded: 0, speed: 0 },
    renderToken: { left: 0, right: 0 },
    autoDiskDone: false,
    opsUi: {
      filter: 'all',
      hiddenIds: null, // Set<string>
      lastJobs: [],
    },
    trashUi: { lastLevel: '', lastTsMs: 0, lastNotice: '' },
  };

  function panelEl(side) {
    return qs(`.fm-panel[data-side="${side}"]`, el('fm-root'));
  }

  function panelDom(side) {
    const root = panelEl(side);
    if (!root) return null;
    return {
      root,
      targetSelect: qs('.fm-target-select', root),
      connectBtn: qs('.fm-connect-btn', root),
      disconnectBtn: qs('.fm-disconnect-btn', root),
      pathInput: qs('.fm-path-input', root),
      upBtn: qs('.fm-up-btn', root),
      refreshBtn: qs('.fm-refresh-btn', root),
      clearTrashBtn: qs('.fm-clear-trash-btn', root),
      filterInput: qs('.fm-filter-input', root),
      filterClearBtn: qs('.fm-filter-clear-btn', root),
      list: qs('.fm-list', root),
    };
  }

  function setActiveSide(side) {
    if (side !== 'left' && side !== 'right') return;
    S.activeSide = side;
    ['left', 'right'].forEach((s) => {
      const d = panelDom(s);
      if (!d) return;
      try { d.root.classList.toggle('fm-panel-active', s === side); } catch (e) {}
    });

    // Keep footer navigation button ("Очистить корзину") in sync
    // with the currently active panel.
    try { updateFmFooterNavButtons(); } catch (e) {}
  }

  function updateFmFooterNavButtons() {
    const clearTrashBtn = el('fm-clear-trash-active-btn');
    if (!clearTrashBtn) return;

    // "Очистить корзину" is only relevant for the local trash root.
    let isTrash = false;
    try {
      const p = S && S.panels ? S.panels[S.activeSide] : null;
      isTrash = isTrashPanel(p);
    } catch (e) { isTrash = false; }

    try {
      if (clearTrashBtn) clearTrashBtn.classList.toggle('hidden', !isTrash);
    } catch (e) {}
  }

  function otherSide(side) {
    return side === 'left' ? 'right' : 'left';
  }

  function isDirLike(it) {
    try {
      const t = String(it && it.type || '');
      return (t === 'dir') || (t === 'link' && !!(it && it.link_dir));
    } catch (e) {
      return false;
    }
  }

  function isHiddenName(name) {
    const n = String(name || '');
    // keep '.' and '..' (even if they ever appear) as not-hidden
    if (n === '.' || n === '..') return false;
    return n.startsWith('.');
  }

  function cmpStr(a, b) {
    const aa = String(a || '').toLowerCase();
    const bb = String(b || '').toLowerCase();
    return aa.localeCompare(bb);
  }

  function sortItems(items, sortPref) {
    const arr = Array.from(items || []);
    const pref = sortPref || (S && S.prefs && S.prefs.sort) || { key: 'name', dir: 'asc', dirsFirst: true };
    const key = String(pref.key || 'name');
    const dir = String(pref.dir || 'asc');
    const mul = (dir === 'desc') ? -1 : 1;
    const dirsFirst = (pref && typeof pref.dirsFirst === 'boolean') ? !!pref.dirsFirst : true;

    const keyFn = (it) => {
      if (!it) return null;
      if (key === 'size') {
        if (isDirLike(it)) return null; // sort dirs by name fallback
        const n = Number(it.size);
        return isFinite(n) ? n : 0;
      }
      if (key === 'mtime') {
        const n = Number(it.mtime);
        return isFinite(n) ? n : 0;
      }
      if (key === 'perm') {
        return String(it.perm || '');
      }
      // name
      return String(it.name || '');
    };

    arr.sort((a, b) => {
      const ad = isDirLike(a);
      const bd = isDirLike(b);
      if (dirsFirst) {
        if (ad && !bd) return -1;
        if (!ad && bd) return 1;
      }

      // For size sorting, directories don't have a meaningful size – sort them by name
      // but still respect the current direction.
      if (key === 'size' && ad && bd) {
        const c = cmpStr(a && a.name, b && b.name);
        if (c) return c * mul;
      }

      const av = keyFn(a);
      const bv = keyFn(b);

      // number compare
      if (typeof av === 'number' || typeof bv === 'number') {
        const an = (typeof av === 'number') ? av : 0;
        const bn = (typeof bv === 'number') ? bv : 0;
        if (an !== bn) return (an < bn ? -1 : 1) * mul;
      } else {
        const c = cmpStr(av, bv);
        if (c) return c * mul;
      }

      // deterministic fallback: name asc, then type
      const cn = cmpStr(a && a.name, b && b.name);
      if (cn) return cn;
      return cmpStr(a && a.type, b && b.type);
    });

    return arr;
  }

  function visibleSortedItems(side) {
    const p = S.panels[side];
    if (!p) return [];
    const sorted = sortItems(p.items || [], S.prefs.sort);

    // Hidden files toggle
    let out = S.prefs.showHidden ? sorted : sorted.filter((it) => !isHiddenName(it && it.name));

    // Quick filter for current folder (substring match, supports multiple terms separated by spaces)
    const q = String(p.filter || '').trim().toLowerCase();
    if (q) {
      const terms = q.split(/\s+/).map((x) => x.trim()).filter(Boolean);
      if (terms.length) {
        out = out.filter((it) => {
          const nm = String(it && it.name || '').toLowerCase();
          return terms.every((t) => nm.includes(t));
        });
      }
    }

    return out;
  }

  function setShowHidden(on) {
    const v = !!on;
    S.prefs.showHidden = v;
    saveShowHiddenPref(v);

    // If we hide dotfiles, drop them from selection/focus to avoid acting on invisible items.
    if (!v) {
      ['left', 'right'].forEach((side) => {
        const p = S.panels[side];
        if (!p) return;
        let changed = false;
        try {
          for (const nm of Array.from(p.selected || [])) {
            if (isHiddenName(nm)) { p.selected.delete(nm); changed = true; }
          }
        } catch (e) {}

        try {
          if (p.focusName && isHiddenName(p.focusName)) {
            const vis = visibleSortedItems(side);
            p.focusName = vis.length ? safeName(vis[0] && vis[0].name) : '';
            changed = true;
          }
        } catch (e) {}

        if (changed) {
          try { p.anchorName = p.focusName || ''; } catch (e) {}
        }
      });
    }

    try { renderPanel('left'); } catch (e) {}
    try { renderPanel('right'); } catch (e) {}
  }

  // -------------------------- selection helpers --------------------------
  function _visibleNames(side) {
    try {
      return visibleSortedItems(side).map((it) => safeName(it && it.name)).filter(Boolean);
    } catch (e) {
      return [];
    }
  }

  function selectAllVisible(side) {
    const p = S.panels[side];
    if (!p) return;
    const names = _visibleNames(side);
    p.selected.clear();
    names.forEach((n) => p.selected.add(n));
    if (!p.focusName && names.length) p.focusName = names[0];
    p.anchorName = p.focusName || '';
    renderPanel(side);
    try { toast(`Выбрано: ${names.length}`, 'info'); } catch (e) {}
  }

  function invertSelectionVisible(side) {
    const p = S.panels[side];
    if (!p) return;
    const names = _visibleNames(side);
    if (!names.length) return;
    const next = new Set(p.selected || []);
    names.forEach((n) => {
      if (next.has(n)) next.delete(n);
      else next.add(n);
    });
    p.selected = next;
    if (!p.focusName && names.length) p.focusName = names[0];
    p.anchorName = p.focusName || '';
    renderPanel(side);
  }

  function _globToRegExp(glob) {
    // Simple glob -> RegExp (supports *, ?). No path separators expected (names only).
    const g = String(glob || '').trim();
    if (!g) return null;
    const esc = (s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    let rx = '';
    for (const ch of g) {
      if (ch === '*') rx += '.*';
      else if (ch === '?') rx += '.';
      else rx += esc(ch);
    }
    try { return new RegExp('^' + rx + '$', 'i'); } catch (e) { return null; }
  }

  function _splitMasks(text) {
    const s = String(text || '').trim();
    if (!s) return [];
    // Accept comma/semicolon/space separated masks (e.g. *.log,*.json)
    return s.split(/[\s,;]+/).map(x => x.trim()).filter(Boolean);
  }

  function applySelectByMask(side, maskText) {
    const p = S.panels[side];
    if (!p) return;
    const masks = _splitMasks(maskText);
    if (!masks.length) {
      try { toast('Введите маску (например: *.log)', 'info'); } catch (e) {}
      return;
    }
    saveMaskPref(masks.join(' '));

    const regs = masks.map(_globToRegExp).filter(Boolean);
    if (!regs.length) {
      try { toast('Неверная маска', 'error'); } catch (e) {}
      return;
    }

    const names = _visibleNames(side);
    const matched = names.filter((n) => regs.some((r) => r.test(String(n))));
    p.selected.clear();
    matched.forEach((n) => p.selected.add(n));
    if (matched.length) {
      // Keep focus on the first matched item for fast next actions.
      p.focusName = matched[0];
      p.anchorName = p.focusName || '';
      renderPanel(side);
      try { toast(`Выбрано по маске: ${matched.length}`, 'success'); } catch (e) {}
    } else {
      renderPanel(side);
      try { toast('По маске ничего не найдено', 'info'); } catch (e) {}
    }
  }

  function openMaskModal() {
    const modal = el('fm-mask-modal');
    const inp = el('fm-mask-pattern');
    const err = el('fm-mask-error');
    const side = S.activeSide || 'left';
    if (!modal || !inp) {
      // Fallback (should rarely happen)
      const v = prompt('Выделить по маске (пример: *.log *.json):', loadMaskPref() || '*.log');
      if (v !== null) applySelectByMask(side, v);
      return;
    }
    try { if (err) err.textContent = ''; } catch (e) {}
    try { inp.value = loadMaskPref() || '*.log'; } catch (e) {}
    try { modalOpen(modal); } catch (e) { modal.classList.remove('hidden'); }
    try { inp.focus(); inp.select(); } catch (e) {}
  }

  function copyFullPaths(side) {
    const p = S.panels[side];
    if (!p) return;
    const names = getSelectionNames(side);
    if (!names.length) {
      _copyText(String(p.cwd || ''));
      return;
    }
    const full = names.map((nm) => (p.target === 'remote' ? joinRemote(p.cwd, nm) : joinLocal(p.cwd, nm)));
    _copyText(full.join('\n'));
  }

  // -------------------------- bookmarks / quick paths --------------------------
  // Trash root is provided by backend (trash_root). Keep a sane default for older builds.
  let FM_TRASH_PATH = '/opt/var/trash';

  function _getTrashRoot() {
    try { return String(FM_TRASH_PATH || '/opt/var/trash').replace(/\/+$/, ''); } catch (e) { return '/opt/var/trash'; }
  }

  function _localBookmarks() {
    const tr = _getTrashRoot();
    return [
      { label: '/opt/var', value: '/opt/var' },
      { label: `🗑 Корзина (${tr})`, value: tr },
      { label: '/opt/etc', value: '/opt/etc' },
      { label: '/tmp/mnt (диски)', value: '/tmp/mnt' },
      { label: '/opt/etc/xray', value: '/opt/etc/xray' },
      { label: '/opt/etc/mihomo', value: '/opt/etc/mihomo' },
    ];
  }

  const FM_BOOKMARKS_REMOTE = [
    { label: '~ (home)', value: '.' },
    { label: '/', value: '/' },
    { label: '/opt', value: '/opt' },
    { label: '/etc', value: '/etc' },
    { label: '/etc/init.d', value: '/etc/init.d' },
    { label: '/var', value: '/var' },
    { label: '/var/log', value: '/var/log' },
    { label: '/tmp', value: '/tmp' },
    { label: '/home', value: '/home' },
    { label: '/root', value: '/root' },
    { label: '/usr', value: '/usr' },
    { label: '/bin', value: '/bin' },
    { label: '/sbin', value: '/sbin' },
    { label: '/proc', value: '/proc' },
    { label: '/sys', value: '/sys' },
  ];



  function isTrashPanel(p) {
    try {
      const cwd = String((p && p.cwd) || '').replace(/\/+$/, '');
      const tr = _getTrashRoot();
      // Show trash UI not only for the root folder itself, but also for any
      // nested folder inside it.
      return !!p
        && String(p.target || 'local') === 'local'
        && (cwd === tr || cwd.startsWith(tr + '/'));
    } catch (e) {
      return false;
    }
  }

  function _bookmarksForPanel(p) {
    const target = String(p && p.target || 'local');
    if (target === 'remote') return FM_BOOKMARKS_REMOTE;
    // Local: filter/disable based on sandbox roots returned by backend.
    const roots = Array.isArray(p && p.roots) ? p.roots : [];
    return _localBookmarks().map((b) => {
      const val = String(b && b.value || '');
      const allowed = !roots.length || isAllowedLocalPath(val, roots);
      return Object.assign({}, b, { _allowed: allowed });
    });
  }

  function ensureBookmarksSelect(side) {
    const pd = panelDom(side);
    const p = S.panels[side];
    if (!pd || !p) return;
    const bar = qs('.fm-panel-bar', pd.root);
    if (!bar) return;

    let sel = qs('.fm-bookmarks-select', bar);
    if (!sel) {
      sel = document.createElement('select');
      sel.className = 'fm-bookmarks-select';
      sel.title = 'Быстрые пути';
      sel.setAttribute('aria-label', 'Быстрые пути');
      sel.addEventListener('change', async () => {
        const v = String(sel.value || '').trim();
        sel.value = '';
        if (!v) return;
        try { setActiveSide(side); } catch (e) {}
        try { pd.pathInput && (pd.pathInput.value = (p.target === 'remote' && v === '.') ? '~' : v); } catch (e) {}
        await listPanel(side, { fromInput: true });
      });

      // Place it after the target selector to avoid stealing width from the path input.
      try {
        if (pd.targetSelect && pd.targetSelect.parentElement === bar) {
          bar.insertBefore(sel, pd.targetSelect.nextSibling);
        } else {
          bar.insertBefore(sel, bar.firstChild);
        }
      } catch (e) {
        try { bar.appendChild(sel); } catch (e2) {}
      }
    }

    // Update options depending on target.
    const opts = _bookmarksForPanel(p);
    const sig = String(p.target) + ':' + String(opts.length) + ':' + String((p.roots || []).join('|'));
    if (sel.dataset.sig !== sig) {
      sel.dataset.sig = sig;
      sel.innerHTML = '';
      const ph = document.createElement('option');
      ph.value = '';
      ph.textContent = '📌';
      sel.appendChild(ph);

      // Remote: plain list. Local: show unavailable in a separate group (disabled).
      if (String(p.target) === 'remote') {
        (opts || []).forEach((o) => {
          const opt = document.createElement('option');
          opt.value = String(o.value || '');
          opt.textContent = String(o.label || o.value || '');
          sel.appendChild(opt);
        });
      } else {
        const allowed = (opts || []).filter((o) => o && o._allowed);
        const denied = (opts || []).filter((o) => o && !o._allowed);

        const g1 = document.createElement('optgroup');
        g1.label = 'Доступно';
        allowed.forEach((o) => {
          const opt = document.createElement('option');
          opt.value = String(o.value || '');
          opt.textContent = String(o.label || o.value || '');
          g1.appendChild(opt);
        });
        sel.appendChild(g1);

        if (denied.length) {
          const g2 = document.createElement('optgroup');
          g2.label = 'Недоступно (sandbox)';
          denied.forEach((o) => {
            const opt = document.createElement('option');
            opt.value = String(o.value || '');
            opt.textContent = '⛔ ' + String(o.label || o.value || '');
            opt.disabled = true;
            g2.appendChild(opt);
          });
          sel.appendChild(g2);
        }
      }
    }
  }

  // Keenetic mounts: /tmp/mnt may contain both UUID-like mount folders and
  // user-friendly label symlinks. The *backend* is responsible for returning
  // a "pretty" list (labels first, UUID folders hidden when labels exist).
  // Frontend only uses this check for UI details (icons, auto-enter).
  function isTmpMntRoot(panel) {
    try {
      return !!panel && panel.target === 'local' && String(panel.cwd || '').replace(/\/+$/, '') === '/tmp/mnt';
    } catch (e) {
      return false;
    }
  }

  function renderPanel(side) {
    const pd = panelDom(side);
    const p = S.panels[side];
    if (!pd || !p) return;

    // Ensure quick paths dropdown exists and is synced with current target.
    try { ensureBookmarksSelect(side); } catch (e) {}

    if (pd.targetSelect && String(pd.targetSelect.value) !== String(p.target)) {
      try { pd.targetSelect.value = p.target; } catch (e) {}
    }

    if (pd.pathInput) {
      // Local: show resolved path. Remote: display '/' for home ('.').
      if (p.target === 'remote') {
        const v = String(p.cwd || '').trim();
        pd.pathInput.value = (!v || v === '.') ? '~' : v;
      } else {
        pd.pathInput.value = String(p.cwd || '');
      }
    }

    // Filter input (client-side filter for current folder)
    try { if (pd.filterInput) pd.filterInput.value = String(p.filter || ''); } catch (e) {}
    try { if (pd.filterClearBtn) pd.filterClearBtn.classList.toggle('hidden', !String(p.filter || '').trim()); } catch (e) {}

    // Trash UI (extra column + "clear" button)
    const isTrash = isTrashPanel(p);
    try { pd.root.classList.toggle('is-trash', !!isTrash); } catch (e) {}
    try { if (pd.clearTrashBtn) pd.clearTrashBtn.classList.toggle('hidden', !isTrash); } catch (e) {}
    // Footer navigation buttons depend on the active panel + current cwd.
    try { updateFmFooterNavButtons(); } catch (e) {}

    // Buttons visibility
    const isRemote = p.target === 'remote';
    if (isRemote) {
      if (p.sid) {
        hide(pd.connectBtn);
        show(pd.disconnectBtn);
      } else {
        show(pd.connectBtn);
        hide(pd.disconnectBtn);
      }
    } else {
      hide(pd.connectBtn);
      hide(pd.disconnectBtn);
    }

    // List
    const list = pd.list;
    if (!list) return;

    // Preserve focus if possible
    const focusName = p.focusName;

    // Cancel any in-flight incremental render for this side
    try { S.renderToken[side] = (Number(S.renderToken[side] || 0) + 1); } catch (e) {}
    const myToken = Number(S.renderToken[side] || 0);

    // header row (sortable columns)
    const header = document.createElement('div');
    header.className = 'fm-row fm-row-header';
    const showTrashFrom = isTrashPanel(p);
    header.innerHTML = [
      '<div class="fm-cell fm-check"></div>',
      '<div class="fm-cell fm-name fm-sort-cell" data-sort="name">Имя <span class="fm-sort-ind" aria-hidden="true"></span></div>',
      ...(showTrashFrom ? ['<div class="fm-cell fm-from" title="Откуда удалено">Откуда удалено</div>'] : []),
      '<div class="fm-cell fm-size fm-sort-cell" data-sort="size">Размер <span class="fm-sort-ind" aria-hidden="true"></span></div>',
      '<div class="fm-cell fm-perm fm-sort-cell" data-sort="perm">Права <span class="fm-sort-ind" aria-hidden="true"></span></div>',
      '<div class="fm-cell fm-mtime fm-sort-cell" data-sort="mtime">Изм. <span class="fm-sort-ind" aria-hidden="true"></span></div>',
    ].join('');

    const updateHeaderSortUi = () => {
      try {
        const pref = S.prefs.sort || { key: 'name', dir: 'asc' };
        const key = String(pref.key || 'name');
        const dir = String(pref.dir || 'asc');
        const ind = (dir === 'desc') ? '▼' : '▲';
        qsa('.fm-sort-cell', header).forEach((c) => {
          const k = String(c.dataset.sort || '');
          const active = (k === key);
          c.classList.toggle('is-sort-active', active);
          const sp = qs('.fm-sort-ind', c);
          if (sp) sp.textContent = active ? ind : '';
        });
      } catch (e) {}
    };

    header.addEventListener('click', (e) => {
      const cell = e && e.target && e.target.closest ? e.target.closest('.fm-sort-cell') : null;
      if (!cell) return;
      const k = String(cell.dataset.sort || '');
      if (!k) return;
      const cur = S.prefs.sort || { key: 'name', dir: 'asc', dirsFirst: true };
      const next = Object.assign({}, cur);
      if (String(cur.key) === k) {
        next.dir = (String(cur.dir) === 'asc') ? 'desc' : 'asc';
      } else {
        next.key = k;
        next.dir = 'asc';
      }
      S.prefs.sort = next;
      saveSortPref(next);
      updateHeaderSortUi();
      // Re-render both panels to reflect the new global sort.
      try { renderPanel('left'); } catch (e2) {}
      try { renderPanel('right'); } catch (e2) {}
    });

    const tmpMntRoot = isTmpMntRoot(p);
    const items = visibleSortedItems(side);
    updateHeaderSortUi();

    const buildRow = (it) => {
      const row = document.createElement('div');
      const name = safeName(it && it.name);
      const type = String((it && it.type) || '');
      const linkDir = !!(it && it.link_dir);
      const isDir = type === 'dir' || (type === 'link' && linkDir);
      row.className = 'fm-row' + (isDir ? ' is-dir' : '');
      row.setAttribute('role', 'option');
      row.tabIndex = -1;
      row.dataset.name = name;
      row.dataset.type = type;
      row.setAttribute('draggable', 'true');

      const selected = p.selected.has(name);
      if (selected) row.classList.add('is-selected');
      if (focusName && focusName === name) row.classList.add('is-focused');

      const size = isDir ? 'DIR' : fmtSize(it && it.size);
      const perm = safeName(it && it.perm);
      const mtime = fmtTime(it && it.mtime);
      const trashFrom = safeName(it && it.trash_from);
      const fromCell = showTrashFrom
        ? '<div class="fm-cell fm-from"><span class="fm-from-text"></span></div>'
        : '';
      const isDiskLabel = tmpMntRoot && type === 'link' && linkDir;
      const ico = (type === 'dir') ? '📁'
        : (type === 'link'
          ? (linkDir ? (isDiskLabel ? '💽' : '📁') : '🔗')
          : '📄');
      row.innerHTML = `
        <div class="fm-cell fm-check"><input type="checkbox" class="fm-check-input" aria-label="Выбрать" /></div>
        <div class="fm-cell fm-name"><span class="fm-ico">${ico}</span><span class="fm-name-text"></span></div>
        ${fromCell}
        <div class="fm-cell fm-size">${size}</div>
        <div class="fm-cell fm-perm">${perm ? perm : ''}</div>
        <div class="fm-cell fm-mtime">${mtime}</div>
      `;
      try {
        const t = qs('.fm-name-text', row);
        if (t) t.textContent = name;
      } catch (e) {}
      if (showTrashFrom) {
        try {
          const ft = qs('.fm-from-text', row);
          if (ft) ft.textContent = trashFrom || '';
          const fc = qs('.fm-cell.fm-from', row);
          if (fc) fc.title = trashFrom || '';
        } catch (e) {}
      }
      try { const cb = qs('.fm-check-input', row); if (cb) cb.checked = !!selected; } catch (e) {}
      return row;
    };

    list.innerHTML = '';
    list.appendChild(header);

    // Large directories: incremental/batched render to avoid freezing the UI.
    const BIG = 1000;
    const BATCH = 250;
    if (!items || items.length <= BIG) {
      const frag = document.createDocumentFragment();
      (items || []).forEach((it) => frag.appendChild(buildRow(it)));
      list.appendChild(frag);
    } else {
      let idx = 0;
      const pump = () => {
        if (Number(S.renderToken[side] || 0) !== myToken) return;
        const frag = document.createDocumentFragment();
        for (let i = 0; i < BATCH && idx < items.length; i += 1, idx += 1) {
          frag.appendChild(buildRow(items[idx]));
        }
        list.appendChild(frag);
        if (idx < items.length) {
          requestAnimationFrame(pump);
        } else {
          // Ensure focus row visible
          try {
            const f = qs('.fm-row.is-focused', list);
            if (f && typeof f.scrollIntoView === 'function') f.scrollIntoView({ block: 'nearest' });
          } catch (e) {}
        }
      };
      requestAnimationFrame(pump);
      return; // focus handling moved into pump()
    }

    // Ensure focus row visible
    try {
      const f = qs('.fm-row.is-focused', list);
      if (f && typeof f.scrollIntoView === 'function') f.scrollIntoView({ block: 'nearest' });
    } catch (e) {}
  }

  // listPanel(side, { fromInput: boolean })
  // fromInput=true means we trust the path input value as user intent.
  // fromInput=false means we use p.cwd (used by navigation like Enter/Backspace).
  async function listPanel(side, opts) {
    const p = S.panels[side];
    if (!p) return;
    const pd = panelDom(side);
    if (!pd) return;

    const fromInput = !!(opts && opts.fromInput);

    // Normalize desired cwd
    // - during navigation we MUST trust p.cwd (input might still show old path)
    // - when user hits Enter in input or clicks Refresh, we take input value
    let desired = p.cwd;
    if (fromInput) {
      try {
        if (pd.pathInput) {
          const v = String(pd.pathInput.value || '').trim();
          if (v) {
            if (p.target === 'remote' && (v === '~' || v === '.')) desired = '.';
            else desired = v;
          }
        }
      } catch (e) {}
    }

    // Normalize remote paths (avoid duplicated segments like /etc/etc/..)
    if (p.target === 'remote') {
      desired = normRemotePath(desired);
    }

    // Remote requires session
    if (p.target === 'remote' && !p.sid) {
      p.items = [];
      p.selected.clear();
      p.focusName = '';
      renderPanel(side);
      return false;
    }

    const url = (() => {
      if (p.target === 'local') {
        return `/api/fs/list?target=local&path=${encodeURIComponent(desired || '')}`;
      }
      // For remote, use '.' for home; do not force '/' which may be invalid on chrooted SFTP.
      return `/api/fs/list?target=remote&sid=${encodeURIComponent(p.sid)}&path=${encodeURIComponent(desired || '.')}`;
    })();

    // Loading state
    try {
      pd.list && pd.list.classList.add('is-loading');
    } catch (e) {}

    const { res, data } = await fetchJson(url, { method: 'GET' });

    try {
      pd.list && pd.list.classList.remove('is-loading');
    } catch (e) {}

    if (!res || !res.ok || !data || !data.ok) {
      const msg = (data && (data.error || data.message)) ? String(data.error || data.message) : 'list_failed';
      const details = data && (data.details || data.hint) ? String(data.details || data.hint) : '';
      if (msg === 'path_not_allowed') {
        // Local sandbox boundary — not an actual error for UX.
        toast('FM: путь вне sandbox (см. XKEEN_LOCALFM_ROOTS)', 'info');
      } else {
        toast('FM: ' + msg + (details ? (' — ' + details) : ''), 'error');
      }
      return false;
    }


    // Trash usage warnings (local only)
    try {
      const t = data && data.trash ? data.trash : null;
      if (t && (t.is_full || t.is_near_full) && (t.percent !== null && t.percent !== undefined)) {
        const now = _nowMs();
        const level = t.is_full ? 'full' : 'near';
        if (!S.trashUi) S.trashUi = { lastLevel: '', lastTsMs: 0, lastNotice: '' };
        // Show at most once per 10 minutes per level.
        if (S.trashUi.lastLevel !== level || (now - (S.trashUi.lastTsMs || 0)) > 10 * 60 * 1000) {
          S.trashUi.lastLevel = level;
          S.trashUi.lastTsMs = now;
          const pct = Number(t.percent || 0);
          if (t.is_full) toast(`Корзина заполнена (${pct}%). Удаляемые файлы будут удаляться сразу — очистите корзину.`, 'error');
          else toast(`Корзина почти заполнена (${pct}%). Рекомендуется очистить корзину.`, 'info');
        }
      }
    } catch (e) {}


    // Update dynamic trash root from backend (local only).
    try {
      if (p.target === 'local' && data && data.trash_root) {
        FM_TRASH_PATH = String(data.trash_root || FM_TRASH_PATH).replace(/\/+$/, '');
      }
    } catch (e) {}
    p.roots = Array.isArray(data.roots) ? data.roots : (p.roots || []);
    if (p.target === 'local') {
      p.cwd = String(data.path || desired || '');
    } else {
      p.cwd = normRemotePath(String(data.path || desired || '.'));

    }

    let nextItems = Array.isArray(data.items) ? data.items : [];

    // Backend is the single source of truth for /tmp/mnt root prettification.

    // If user has exactly one disk label, auto-enter it on first load of the right panel.
    // (Keeps dual-pane UX: left stays /opt/var; right opens the only disk.)
    if (!S.autoDiskDone && side === 'right' && isTmpMntRoot(p)) {
      const disks = nextItems.filter((it) => {
        const t = String(it && it.type);
        return (t === 'dir') || (t === 'link' && !!(it && it.link_dir));
      });
      if (disks.length === 1) {
        S.autoDiskDone = true;
        p.cwd = joinLocal(p.cwd, safeName(disks[0] && disks[0].name));
        p.selected.clear();
        p.focusName = '';
        // Use navigation mode (fromInput=false) so input doesn't override.
        await listPanel(side, { fromInput: false });
        return true;
      }
    }

    p.items = nextItems;

    // keep selection only for existing names
    const existing = new Set(p.items.map((it) => safeName(it && it.name)));
    const nextSel = new Set();
    for (const n of p.selected) {
      if (existing.has(n)) nextSel.add(n);
    }
    p.selected = nextSel;
    if (p.focusName && !existing.has(p.focusName)) p.focusName = '';
    if (p.anchorName && !existing.has(p.anchorName)) p.anchorName = '';
    if (!p.focusName && p.items.length) p.focusName = safeName(p.items[0] && p.items[0].name);

    renderPanel(side);
    return true;
  }

  async function refreshAll() {
    await Promise.all([listPanel('left', { fromInput: true }), listPanel('right', { fromInput: true })]);
  }

  function getFocusedItem(side) {
    const p = S.panels[side];
    if (!p) return null;
    const name = p.focusName;
    if (!name) return null;
    return (p.items || []).find((it) => safeName(it && it.name) === name) || null;
  }

  function getSelectionNames(side) {
    const p = S.panels[side];
    if (!p) return [];
    const arr = Array.from(p.selected || []);
    if (arr.length) return arr;
    const f = getFocusedItem(side);
    if (f && f.name) return [safeName(f.name)];
    return [];
  }

  function clearSelectionExcept(side, keepName) {
    const p = S.panels[side];
    if (!p) return;
    p.selected.clear();
    if (keepName) p.selected.add(keepName);
    p.anchorName = keepName ? safeName(keepName) : '';
  }


  function selectRange(side, fromName, toName, addToExisting) {
    const p = S.panels[side];
    if (!p) return;
    const from = safeName(fromName || '');
    const to = safeName(toName || '');
    if (!from || !to) return;

    const items = visibleSortedItems(side);
    const names = items.map((it) => safeName(it && it.name));
    const a = names.indexOf(from);
    const b = names.indexOf(to);

    if (a < 0 || b < 0) {
      // Fallback: behave as a normal single selection.
      if (!addToExisting) p.selected.clear();
      p.selected.add(to);
      return;
    }

    const i1 = Math.min(a, b);
    const i2 = Math.max(a, b);

    if (!addToExisting) p.selected.clear();
    for (let i = i1; i <= i2; i++) {
      const nm = names[i];
      if (nm) p.selected.add(nm);
    }
  }

  function setFocus(side, name) {
    const p = S.panels[side];
    if (!p) return;
    p.focusName = safeName(name || '');
  }

  function focusNext(side, delta) {
    const p = S.panels[side];
    if (!p || !p.items || !p.items.length) return;
    const items = visibleSortedItems(side);
    let idx = items.findIndex((it) => safeName(it && it.name) === p.focusName);
    if (idx < 0) idx = 0;
    idx = Math.max(0, Math.min(items.length - 1, idx + delta));
    p.focusName = safeName(items[idx] && items[idx].name);
    renderPanel(side);
  }


  // -------------------------- properties (moved to ПКМ menu) --------------------------
  let propsReqId = 0;

  function _kvRow(k, v) {
    const key = _htmlEscape(k);
    const val = (v === null || v === undefined || v === '') ? '—' : _htmlEscape(v);
    return `<div class="fm-props-k">${key}</div><div class="fm-props-v">${val}</div>`;
  }

  async function fmBuildPropsHtml(side, reqId) {
    const p = S.panels[side];
    if (!p) return { metaText: '', html: '<div class="fm-props-empty">Нет данных.</div>' };

    const names = getSelectionNames(side);
    const selCount = (p.selected && p.selected.size) ? p.selected.size : 0;

    const metaText = `${side === 'left' ? 'левая' : 'правая'} панель • ${selCount ? ('выделено: ' + selCount) : (names.length ? 'фокус' : 'нет выбора')}`;

    if (!names.length) {
      return { metaText, html: '<div class="fm-props-empty">Ничего не выбрано.</div>' };
    }

    // Remote target requires an active session.
    if (p.target === 'remote' && !p.sid) {
      return { metaText, html: '<div class="fm-props-empty">Remote: нет соединения.</div>' };
    }

    // NOTE: /api/fs/stat-batch expects full paths. Build them from the panel cwd.
    const fullPaths = names.map((nm) => (p.target === 'remote' ? joinRemote(p.cwd, nm) : joinLocal(p.cwd, nm)));
    const payload = { target: p.target, paths: fullPaths };
    if (p.target === 'remote') payload.sid = p.sid;

    let j = null;
    try {
      const { res, data } = await fetchJson('/api/fs/stat-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (reqId !== propsReqId) return null; // outdated
      if (!res || !res.ok || !data || !data.ok) {
        return { metaText, html: '<div class="fm-props-empty">Не удалось получить свойства.</div>' };
      }
      j = data;
    } catch (e) {
      if (reqId !== propsReqId) return null;
      return { metaText, html: '<div class="fm-props-empty">Ошибка запроса свойств.</div>' };
    }

    const items = Array.from((j && j.items) || []).filter((x) => x && x.exists);
    if (!items.length) {
      return { metaText, html: '<div class="fm-props-empty">Файлы не найдены.</div>' };
    }

    // Aggregation: total size for files/links; directories are unknown.
    let totalBytes = 0;
    let hasUnknownDir = false;
    let countFile = 0, countDir = 0, countLink = 0;
    items.forEach((it) => {
      const t = String(it.type || '');
      if (t === 'dir') { countDir++; hasUnknownDir = true; return; }
      if (t === 'link') countLink++; else countFile++;
      const n = Number(it.size);
      if (isFinite(n) && n >= 0) totalBytes += n;
    });

    const totalLine = (() => {
      const base = fmtSize(totalBytes);
      if (hasUnknownDir) return `${base || '0 B'} + папки (неизвестно)`;
      return base || '0 B';
    })();

    if (items.length === 1) {
      const it = items[0];
      const name = safeName(names[0]);
      const path = safeName(it.path || '');
      const t = safeName(it.type || '');
      const perm = safeName(it.perm || '');
      const mtime = fmtTime(it.mtime);
      const uid = (it.uid === undefined || it.uid === null) ? '' : String(it.uid);
      const gid = (it.gid === undefined || it.gid === null) ? '' : String(it.gid);
      const linkTarget = safeName(it.link_target || '');

      const rows = [
        _kvRow('Имя', name),
        _kvRow('Путь', path),
        _kvRow('Тип', t),
        _kvRow('Размер', `${fmtSize(it.size)} (${Number(it.size) || 0} B)`),
        _kvRow('Изменён', mtime),
        _kvRow('Права', perm),
      ];
      if (uid || gid) rows.push(_kvRow('UID/GID', `${uid || '—'}:${gid || '—'}`));
      if (t === 'link') rows.push(_kvRow('Symlink →', linkTarget || '—'));

      return { metaText, html: `<div class="fm-props-grid">${rows.join('')}</div>` };
    }

    const rows = [
      _kvRow('Выделено', String(items.length)),
      _kvRow('Файлы/Папки/Ссылки', `${countFile}/${countDir}/${countLink}`),
      _kvRow('Сумма размеров', totalLine),
    ];

    return { metaText, html: `<div class="fm-props-grid">${rows.join('')}</div>` };
  }

  async function openPropsModal(side) {
    const s = String(side || S.activeSide || 'left');
    const modal = el('fm-props-modal');
    const metaEl = el('fm-props-modal-meta');
    const bodyEl = el('fm-props-modal-body');

    if (!modal || !metaEl || !bodyEl) {
      toast('FM: модалка "Свойства" не найдена', 'error');
      return;
    }

    const p = S.panels[s];
    if (!p) return;

    const reqId = ++propsReqId;

    // Show early so it feels instant.
    metaEl.textContent = `${s === 'left' ? 'левая' : 'правая'} панель`;
    bodyEl.innerHTML = '<div class="fm-props-empty">Загрузка…</div>';
    modalOpen(modal);

    const out = await fmBuildPropsHtml(s, reqId);
    if (!out || reqId !== propsReqId) return;

    metaEl.textContent = String(out.metaText || '');
    bodyEl.innerHTML = String(out.html || '');
  }

  function closePropsModal() {
    modalClose(el('fm-props-modal'));
  }

  // -------------------------- checksum modal (md5/sha256) --------------------------
  let hashReqId = 0;

  async function openHashModal(side) {
    const s = String(side || S.activeSide || 'left');
    const modal = el('fm-hash-modal');
    const metaEl = el('fm-hash-meta');
    const md5El = el('fm-hash-md5');
    const shaEl = el('fm-hash-sha256');
    const sizeEl = el('fm-hash-size');
    const errEl = el('fm-hash-error');

    if (!modal || !metaEl || !md5El || !shaEl || !sizeEl) {
      toast('FM: модалка "Checksum" не найдена', 'error');
      return;
    }

    const p = S.panels[s];
    if (!p) return;

    const names = getSelectionNames(s);
    if (!names || names.length !== 1) {
      toast('Выберите один файл', 'info');
      return;
    }

    // Remote target requires an active session.
    if (p.target === 'remote' && !p.sid) {
      toast('Remote: нет соединения', 'error');
      return;
    }

    const name = safeName(names[0]);
    const fullPath = (p.target === 'remote') ? joinRemote(p.cwd, name) : joinLocal(p.cwd, name);

    const reqId = ++hashReqId;

    // Reset UI and open early.
    try { if (errEl) errEl.textContent = ''; } catch (e) {}
    metaEl.textContent = `${p.target === 'remote' ? 'remote' : 'local'} • ${fullPath}`;
    md5El.value = '...';
    shaEl.value = '...';
    sizeEl.value = '...';
    modalOpen(modal);

    const qs = new URLSearchParams();
    qs.set('target', String(p.target || 'local'));
    qs.set('path', String(fullPath || ''));
    if (p.target === 'remote') qs.set('sid', String(p.sid || ''));

    let j = null;
    try {
      const { res, data } = await fetchJson('/api/fs/checksum?' + qs.toString(), { method: 'GET' });
      if (reqId !== hashReqId) return;
      if (!res || !res.ok || !data || !data.ok) {
        const emsg = (data && (data.error || data.message)) ? String(data.error || data.message) : 'Не удалось вычислить checksum.';
        if (errEl) errEl.textContent = emsg;
        md5El.value = '';
        shaEl.value = '';
        sizeEl.value = '';
        return;
      }
      j = data;
    } catch (e) {
      if (reqId !== hashReqId) return;
      if (errEl) errEl.textContent = 'Ошибка запроса checksum.';
      md5El.value = '';
      shaEl.value = '';
      sizeEl.value = '';
      return;
    }

    try {
      md5El.value = String(j.md5 || '');
      shaEl.value = String(j.sha256 || '');
      const sz = Number(j.size);
      sizeEl.value = isFinite(sz) && sz >= 0 ? `${fmtSize(sz)} (${sz} B)` : '';
    } catch (e) {
      // ignore
    }
  }

  function closeHashModal() {
    modalClose(el('fm-hash-modal'));
  }

// -------------------------- text file viewer/editor (CodeMirror modal) --------------------------
  const FM_EDITOR = {
    wired: false,
    cm: null,
    ctx: null,          // { target, sid, path, name, side, truncated, readOnly }
    dirty: false,
    lastSaved: '',
  };

  function fmEditorEls() {
    const modal = el('fm-editor-modal');
    if (!modal) return null;
    return {
      modal,
      title: el('fm-editor-title'),
      subtitle: el('fm-editor-subtitle'),
      textarea: el('fm-editor-textarea'),
      saveBtn: el('fm-editor-save-btn'),
      cancelBtn: el('fm-editor-cancel-btn'),
      closeBtn: el('fm-editor-close-btn'),
      downloadBtn: el('fm-editor-download-btn'),
      warn: el('fm-editor-warning'),
      err: el('fm-editor-error'),
    };
  }

  
  function fmSampleText(text, maxLen = 4000) {
    const s = String(text == null ? '' : text);
    if (!s) return '';
    // Keep only the head; enough for heuristics, safe for big logs.
    return s.length > maxLen ? s.slice(0, maxLen) : s;
  }

  function fmLooksLikeJson(text) {
    const s = fmSampleText(text, 5000).trimStart();
    if (!s) return false;
    const c = s[0];
    if (c !== '{' && c !== '[') return false;
    // Avoid obvious non-JSON (nginx blocks etc.)
    if (/\b(server|location|upstream)\b\s*\{/i.test(s.slice(0, 2000))) return false;
    return true;
  }

  function fmLooksLikeYaml(text) {
    const s = fmSampleText(text, 3000);
    if (!s) return false;
    // YAML doc start or "key: value" patterns near top.
    if (/^\s*---\s*(\r?\n|$)/.test(s)) return true;
    return /^\s*[A-Za-z0-9_\-\."']+\s*:\s*[^\n]*$/m.test(s.slice(0, 1200));
  }

  function fmLooksLikeShell(text) {
    const s = fmSampleText(text, 3000);
    if (!s) return false;
    if (/^\s*#!.*\b(sh|bash|ash|zsh)\b/i.test(s)) return true;
    // Common shell-ish patterns in logs/scripts.
    return /^\s*(export\s+\w+|set\s+-[a-zA-Z]+|\w+=.+|\$(\{|\w))/m.test(s.slice(0, 1200));
  }

  function fmLooksLikeXml(text) {
    const s = fmSampleText(text, 4000).trimStart();
    if (!s) return false;
    if (s.startsWith('<?xml')) return true;
    return /^<\w[\w\-:.]*[\s>]/.test(s);
  }

  function fmLooksLikeNginx(text) {
    const s = fmSampleText(text, 6000);
    if (!s) return false;
    // Nginx conf typically has blocks with braces + directives.
    if (!/[{}]/.test(s)) return false;
    return /\b(http|events|server|location|upstream|map)\b\s*\{/i.test(s) ||
           /\b(listen|server_name|proxy_pass|root|include)\b/i.test(s);
  }

  function fmGuessCmMode(name, text) {
    const n = String(name || '').toLowerCase();
    const ext = n.includes('.') ? n.split('.').pop() : '';

    // Extension-first mapping.
    // .json is strict JSON (no editor commenting). .jsonc is JSON-with-comments.
    if (ext === 'json') return { name: 'javascript', json: true };
    if (ext === 'jsonc') return { name: 'jsonc', json: true };
    if (ext === 'js' || ext === 'ts') return 'javascript';
    if (ext === 'yaml' || ext === 'yml') return 'yaml';
    if (ext === 'sh' || ext === 'bash') return 'shell';
    if (ext === 'toml') return 'toml';
    if (ext === 'ini' || ext === 'cfg') return 'properties';
    if (ext === 'xml') return 'xml';
    if (ext === 'nginx') return 'nginx';

    // .conf is ambiguous: try detect nginx, otherwise treat as ini/properties.
    if (ext === 'conf') {
      if (fmLooksLikeNginx(text)) return 'nginx';
      return 'properties';
    }

    // Logs / plain text: try quick heuristics so even *.txt can be highlighted.
    if (ext === 'log' || ext === 'txt' || ext === '') {
      if (fmLooksLikeJson(text)) return { name: 'javascript', json: true };
      if (fmLooksLikeYaml(text)) return 'yaml';
      if (fmLooksLikeShell(text)) return 'shell';
      if (fmLooksLikeXml(text)) return 'xml';
      if (fmLooksLikeNginx(text)) return 'nginx';
      return 'text/plain';
    }

    // Keep compatibility for other extensions (modes may or may not be present).
    if (ext === 'py') return 'python';
    if (ext === 'css') return 'css';
    if (ext === 'html' || ext === 'htm') return 'htmlmixed';
    if (ext === 'md' || ext === 'markdown') return 'markdown';

    return 'text/plain';
  }

  function fmCurrentCmTheme() {
    try {
      const t = document.documentElement.getAttribute('data-theme');
      return (t === 'light') ? 'default' : 'material-darker';
    } catch (e) {
      return 'material-darker';
    }
  }

  // -------------------------- CodeMirror lazy assets (modes / JSON lint) --------------------------
  function fmModeName(mode) {
    try {
      if (!mode) return '';
      if (typeof mode === 'string') {
        // MIME-like values do not map to a mode file.
        if (mode.includes('/')) return '';
        return mode;
      }
      if (typeof mode === 'object' && mode.name) return String(mode.name || '');
    } catch (e) {}
    return '';
  }

  function fmJsonLintAvailable() {
    try {
      if (!window.jsonlint) return false;
      if (!window.CodeMirror) return false;
      const h = window.CodeMirror.helpers;
      return !!(h && h.lint && h.lint.json);
    } catch (e) {
      return false;
    }
  }

  async function fmEnsureCmAssets({ mode, jsonLint } = {}) {
    // Uses XKeen.cmLoader if present (panel.html), otherwise best-effort.
    const modeName = fmModeName(mode);
    const wantJsonLint = !!jsonLint;

    try {
      if (window.XKeen && XKeen.cmLoader) {
        if (modeName && typeof XKeen.cmLoader.ensureMode === 'function') {
          await XKeen.cmLoader.ensureMode(modeName);
        }
        if (wantJsonLint && typeof XKeen.cmLoader.ensureJsonLint === 'function') {
          await XKeen.cmLoader.ensureJsonLint();
        }
      }
    } catch (e) {}

    return {
      modeOk: !modeName || (window.CodeMirror && window.CodeMirror.modes && window.CodeMirror.modes[modeName]),
      jsonLintOk: !wantJsonLint || fmJsonLintAvailable(),
    };
  }

  function fmEnsureEditorCm() {
    if (FM_EDITOR.cm) return FM_EDITOR.cm;
    const ui = fmEditorEls();
    if (!ui || !ui.textarea) return null;
    if (!window.CodeMirror || typeof window.CodeMirror.fromTextArea !== 'function') return null;

    
    const cm = window.CodeMirror.fromTextArea(ui.textarea, {
      lineNumbers: true,
      lineWrapping: true,
      theme: fmCurrentCmTheme(),
      mode: 'text/plain',

      tabSize: 2,
      indentUnit: 2,
      indentWithTabs: false,

      // Addons (loaded globally in panel.html)
      showIndentGuides: true,
      styleActiveLine: true,
      matchBrackets: true,
      autoCloseBrackets: true,
      showTrailingSpace: true,
      foldGutter: true,
      // Lint gutter is enabled only when needed (e.g. JSON).
      gutters: ['CodeMirror-linenumbers', 'CodeMirror-foldgutter'],
      lint: false,
      highlightSelectionMatches: { showToken: /\w/, minChars: 2 },

      // Keep reasonable performance on big logs, but show a bit more context.
      viewportMargin: 50,

      extraKeys: {
        'Ctrl-S': () => { fmEditorSave(); },
        'Cmd-S': () => { fmEditorSave(); },

        'Ctrl-F': 'findPersistent',
        'Cmd-F': 'findPersistent',
        'Ctrl-H': 'replace',
        'Cmd-Alt-F': 'replace',
        'Ctrl-G': 'findNext',
        'Cmd-G': 'findNext',
        'Shift-Ctrl-G': 'findPrev',
        'Shift-Cmd-G': 'findPrev',

        'Esc': () => { fmEditorRequestClose(); },
      },
    });

    // Register for theme sync (theme.js reads window.__xkeenEditors)
    try {
      window.__xkeenEditors = window.__xkeenEditors || [];
      window.__xkeenEditors.push(cm);
    } catch (e) {}

    // Attach toolbar if available
    try {
      if (window.xkeenAttachCmToolbar && window.XKEEN_CM_TOOLBAR_DEFAULT) {
        window.xkeenAttachCmToolbar(cm, window.XKEEN_CM_TOOLBAR_DEFAULT);
      }
    } catch (e) {}

    cm.on('change', () => {
      try {
        const v = cm.getValue();
        FM_EDITOR.dirty = (FM_EDITOR.ctx && !FM_EDITOR.ctx.readOnly) ? (v !== FM_EDITOR.lastSaved) : false;
        const ui2 = fmEditorEls();
        if (ui2 && ui2.saveBtn) ui2.saveBtn.disabled = !FM_EDITOR.dirty || !!(FM_EDITOR.ctx && FM_EDITOR.ctx.readOnly);
      } catch (e) {}
    });

    FM_EDITOR.cm = cm;
    return cm;
  }

  function fmEditorSetInfo({ subtitle, warn, err } = {}) {
    const ui = fmEditorEls();
    if (!ui) return;
    try {
      if (ui.subtitle) ui.subtitle.textContent = String(subtitle || '');
    } catch (e) {}
    try {
      if (ui.warn) {
        if (warn) { ui.warn.style.display = ''; ui.warn.textContent = String(warn); }
        else { ui.warn.style.display = 'none'; ui.warn.textContent = ''; }
      }
    } catch (e) {}
    try {
      if (ui.err) {
        if (err) { ui.err.style.display = ''; ui.err.textContent = String(err); }
        else { ui.err.style.display = 'none'; ui.err.textContent = ''; }
      }
    } catch (e) {}
  }


  function fmEditorKickRefresh(cm, focus = true) {
    if (!cm) return;

    const doRefresh = () => { try { cm.refresh(); } catch (e) {} };

    // Ensure initial position at the top (useful for logs).
    try { cm.scrollTo(0, 0); } catch (e) {}
    try { cm.setCursor({ line: 0, ch: 0 }); } catch (e) {}

    // CodeMirror часто инициализируется в скрытой модалке (display:none),
    // поэтому делаем несколько refresh после открытия (в т.ч. после загрузки шрифтов).
    doRefresh();
    try { requestAnimationFrame(doRefresh); } catch (e) { setTimeout(doRefresh, 0); }
    setTimeout(doRefresh, 0);
    setTimeout(doRefresh, 50);
    setTimeout(doRefresh, 150);
    setTimeout(doRefresh, 300);

    try {
      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(doRefresh).catch(() => {});
      }
    } catch (e) {}

    if (focus) setTimeout(() => { try { cm.focus(); } catch (e) {} }, 0);
  }

  
  async function fmEditorOpen(ctx, text) {
    const ui = fmEditorEls();
    if (!ui) return false;

    FM_EDITOR.ctx = ctx || null;
    FM_EDITOR.lastSaved = String(text || '');
    FM_EDITOR.dirty = false;

    try { if (ui.title) ui.title.textContent = String((ctx && ctx.name) || 'Файл'); } catch (e) {}

    const subtitle = [];
    try {
      if (ctx && ctx.path) subtitle.push(String(ctx.path));
      if (ctx && ctx.target === 'remote' && ctx.sid) subtitle.push('remote');
      if (ctx && ctx.target === 'local') subtitle.push('local');
      if (ctx && ctx.truncated) subtitle.push('частично');
    } catch (e) {}
    fmEditorSetInfo({
      subtitle: subtitle.join(' • '),
      warn: (ctx && ctx.truncated) ? 'Файл открыт частично (ограничение размера). Сохранение отключено.' : '',
      err: '',
    });

    // ВАЖНО: сначала открываем модалку, иначе CodeMirror измерит нулевые размеры и визуально будет "пустым" до клика.
    modalOpen(ui.modal);

    const cm = fmEnsureEditorCm();
    const ro = !!(ctx && ctx.readOnly);

    if (cm) {
      try {
        let mode = fmGuessCmMode(ctx && ctx.name, text);
        const isJson = !!(mode && typeof mode === 'object' && mode.json);

        // Lazy-load mode + JSON linter only when needed.
        const ensured = await fmEnsureCmAssets({ mode, jsonLint: isJson });
        if (!ensured.modeOk) {
          // Fallback to plain text if the requested mode isn't bundled.
          mode = 'text/plain';
        }

        const canLintJson = isJson && ensured.jsonLintOk;

        // Enable / disable lint gutter dynamically.
        try {
          const gutters = canLintJson
            ? ['CodeMirror-linenumbers', 'CodeMirror-foldgutter', 'CodeMirror-lint-markers']
            : ['CodeMirror-linenumbers', 'CodeMirror-foldgutter'];
          cm.setOption('gutters', gutters);
        } catch (e) {}

        cm.setOption('mode', mode);
        cm.setOption('lint', canLintJson);
        cm.setOption('readOnly', ro ? 'nocursor' : false);

        cm.setValue(String(text || ''));
        cm.clearHistory();

        fmEditorKickRefresh(cm, true);
      } catch (e) {}
    } else if (ui.textarea) {
      ui.textarea.value = String(text || '');
      setTimeout(() => { try { ui.textarea.focus(); } catch (e) {} }, 0);
    }

    // Save button starts disabled; it becomes enabled only after edits (handled in cm.on('change')).
    try { if (ui.saveBtn) ui.saveBtn.disabled = true; } catch (e) {}

    return true;
  }

  async function fmEditorRequestClose() {
    const ui = fmEditorEls();
    if (!ui) return;
    const has = !!FM_EDITOR.ctx;

    if (has && FM_EDITOR.dirty) {
      let ok = true;
      try {
        if (window.XKeen && XKeen.ui && typeof XKeen.ui.confirm === 'function') {
          ok = await XKeen.ui.confirm({
            title: 'Несохранённые изменения',
            message: 'Закрыть файл без сохранения?',
            okText: 'Закрыть',
            cancelText: 'Отмена',
            danger: true,
          });
        } else {
          ok = window.confirm('Закрыть файл без сохранения?');
        }
      } catch (e) {
        ok = true;
      }
      if (!ok) return;
    }

    // Reset editor state
    try { FM_EDITOR.ctx = null; } catch (e) {}
    try { FM_EDITOR.dirty = false; } catch (e) {}
    try { FM_EDITOR.lastSaved = ''; } catch (e) {}

    modalClose(ui.modal);
  }

  function fmEditorDownload() {
    const ctx = FM_EDITOR.ctx;
    if (!ctx) return;

    const target = String(ctx.target || 'local');
    const path = String(ctx.path || '');
    const sid = String(ctx.sid || '');
    const name = String(ctx.name || 'download');

    const url = `/api/fs/download?target=${encodeURIComponent(target)}&path=${encodeURIComponent(path)}${target === 'remote' ? `&sid=${encodeURIComponent(sid)}` : ''}`;
    xhrDownloadFile({ url, filenameHint: name, titleLabel: 'Download' });
  }

  async function fmEditorSave() {
    const ctx = FM_EDITOR.ctx;
    const ui = fmEditorEls();
    if (!ctx || !ui) return;
    if (ctx.readOnly) return;

    const cm = FM_EDITOR.cm;
    const text = cm ? String(cm.getValue() || '') : String((ui.textarea && ui.textarea.value) || '');
    try { if (ui.saveBtn) ui.saveBtn.disabled = true; } catch (e) {}

    const payload = { target: ctx.target, path: ctx.path, sid: ctx.sid || '', text };
    let out = null;
    try {
      const { res, data } = await fetchJson('/api/fs/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      out = { res, data };
    } catch (e) {
      out = null;
    }

    if (!out || !out.res || out.res.status < 200 || out.res.status >= 300 || !(out.data && out.data.ok)) {
      const errMsg = (out && out.data && out.data.error) ? String(out.data.error) : 'save_failed';
      fmEditorSetInfo({ err: 'Не удалось сохранить: ' + errMsg });
      try { toast('FM: не удалось сохранить файл', 'error'); } catch (e) {}
      try { if (ui.saveBtn) ui.saveBtn.disabled = false; } catch (e2) {}
      return;
    }

    // Update dirty state + refresh panels
    FM_EDITOR.lastSaved = text;
    FM_EDITOR.dirty = false;
    fmEditorSetInfo({ err: '' });
    try { toast('Сохранено: ' + (ctx.name || 'файл'), 'success'); } catch (e) {}

    try {
      if (ui.saveBtn) ui.saveBtn.disabled = true;
    } catch (e) {}

    try {
      if (ctx.side) await listPanel(ctx.side, { fromInput: true });
    } catch (e) {}
  }

  function wireEditorModal() {
    if (FM_EDITOR.wired) return;
    const ui = fmEditorEls();
    if (!ui) return;
    FM_EDITOR.wired = true;

    if (ui.cancelBtn) ui.cancelBtn.addEventListener('click', (e) => { e.preventDefault(); fmEditorRequestClose(); });
    if (ui.closeBtn) ui.closeBtn.addEventListener('click', (e) => { e.preventDefault(); fmEditorRequestClose(); });
    if (ui.downloadBtn) ui.downloadBtn.addEventListener('click', (e) => { e.preventDefault(); fmEditorDownload(); });
    if (ui.saveBtn) ui.saveBtn.addEventListener('click', (e) => { e.preventDefault(); fmEditorSave(); });

    // Backdrop click: НЕ закрываем редактор по клику вне окна.
    // Закрытие доступно через Esc или кнопки "Закрыть".
  }

  async function tryOpenItemInEditor(side, it, fullPath) {
    const name = safeName(it && it.name);
    if (!name) return false;
    const p = S.panels[side];
    if (!p) return false;
    const target = String(p.target || 'local');
    const sid = String(p.sid || '');

    // Quick extension heuristic (avoid calling read API for obvious binary blobs)
    const lower = name.toLowerCase();
    const ext = lower.includes('.') ? lower.split('.').pop() : '';
    const likelyText = ['txt','log','conf','cfg','ini','json','jsonc','yml','yaml','md','sh','bash','rules','list','lst','csv','tsv','xml','html','htm','js','ts','css','py','go','rs','java','c','h','cpp','hpp','sql','toml'].includes(ext);

    if (!likelyText) {
      // Still allow opening unknown extensions if they look small & harmless (best-effort).
      // We'll attempt read and fall back to download if backend says "not_text".
    }

    const url = `/api/fs/read?target=${encodeURIComponent(target)}&path=${encodeURIComponent(fullPath)}${target === 'remote' ? `&sid=${encodeURIComponent(sid)}` : ''}`;

    let out = null;
    try {
      out = await fetchJson(url, { method: 'GET' });
    } catch (e) {
      out = null;
    }

    if (!out || !out.res) return false;
    if (out.res.status === 415 && out.data && out.data.error === 'not_text') {
      return false;
    }
    if (out.res.status < 200 || out.res.status >= 300 || !(out.data && out.data.ok)) {
      const errMsg = (out.data && out.data.error) ? String(out.data.error) : `HTTP ${out.res.status}`;
      try { toast('FM: не удалось открыть файл: ' + errMsg, 'error'); } catch (e) {}
      return false;
    }

    const text = String(out.data.text || '');
    const truncated = !!out.data.truncated;
    const ctx = {
      target,
      sid: target === 'remote' ? sid : '',
      path: fullPath,
      name,
      side,
      truncated,
      readOnly: truncated, // avoid accidental overwrite of partial content
    };

    wireEditorModal();
    return fmEditorOpen(ctx, text);
  }

  async function openFocused(side) {
    const p = S.panels[side];
    if (!p) return;
    const it = getFocusedItem(side);
    if (!it) return;
    const type = String((it && it.type) || '');
    const linkDir = !!(it && it.link_dir);
    const isDir = type === 'dir' || (type === 'link' && linkDir);

    if (isDir) {
      if (p.target === 'local') {
        p.cwd = joinLocal(p.cwd, it.name);
      } else {
        p.cwd = joinRemote(p.cwd, it.name);
      }
      p.selected.clear();
      p.focusName = '';
      await listPanel(side, { fromInput: false });
      return;
    }

    // Symlink to directory? Some backends don't expose link_dir.
    // Try to open links as directories first; if it fails, fallback to file download.
    if (type === 'link') {
      const prevCwd = p.cwd;
      const prevFocus = p.focusName;
      const prevSel = new Set(p.selected || []);
      const nextCwd = (p.target === 'remote') ? joinRemote(prevCwd, it.name) : joinLocal(prevCwd, it.name);
      p.cwd = nextCwd;
      p.selected.clear();
      p.focusName = '';
      const ok = await listPanel(side, { fromInput: false });
      if (ok) return;
      // restore and continue as file
      p.cwd = prevCwd;
      p.focusName = prevFocus;
      p.selected = prevSel;
    }    // Files: open in built-in CodeMirror editor (for text) or download (binary/unknown).
    if (p.target === 'remote' && !p.sid) {
      toast('Открыть/скачать: remote без сессии', 'info');
      return;
    }

    const fullPath = (p.target === 'remote') ? joinRemote(p.cwd, it.name) : joinLocal(p.cwd, it.name);

    // Try opening as text first (backend will refuse binary with 415 not_text).
    try {
      const opened = await tryOpenItemInEditor(side, it, fullPath);
      if (opened) return;
    } catch (e) {}

    const url = (p.target === 'remote')
      ? `/api/fs/download?target=remote&sid=${encodeURIComponent(p.sid)}&path=${encodeURIComponent(fullPath)}`
      : `/api/fs/download?target=local&path=${encodeURIComponent(fullPath)}`;
    xhrDownloadFile({ url, filenameHint: safeName(it.name), titleLabel: 'Download' });
  }

  async function downloadSelection(side) {
  const p = S.panels[side];
  if (!p) return;
  if (p.target === 'remote' && !p.sid) {
    toast('Download: remote без сессии', 'info');
    return;
  }
  const names = getSelectionNames(side);
  if (!names.length) return;

  // Multiple selection -> ZIP archive of selected files/folders.
  if (names.length > 1) {
    try { toast('ZIP создаётся во временной папке /tmp и может занять много места', 'info'); } catch (e) {}
    const items = [];
    for (const nm of names) {
      const it = (p.items || []).find(x => safeName(x && x.name) === safeName(nm));
      if (!it) continue;
      const type = String((it && it.type) || '');
      const linkDir = !!(it && it.link_dir);
      const isDir = (type === 'dir') || (type === 'link' && linkDir);
      const fullPath = (p.target === 'remote') ? joinRemote(p.cwd, it.name) : joinLocal(p.cwd, it.name);
      items.push({ path: fullPath, name: safeName(it.name), is_dir: !!isDir });
    }
    if (!items.length) return;

    // Name archive based on current directory (nice UX), fallback to "selection".
    const cwd = String(p.cwd || '').trim();
    const base = (() => {
      if (p.target === 'remote') {
        const c = normRemotePath(cwd);
        if (!c || c === '.' || c === '/') return 'selection';
        const parts = c.split('/').filter(Boolean);
        return parts.length ? parts[parts.length - 1] : 'selection';
      }
      const c = cwd.replace(/\/+$/, '');
      if (!c || c === '/') return 'selection';
      const idx = c.lastIndexOf('/');
      return (idx >= 0) ? (c.slice(idx + 1) || 'selection') : (c || 'selection');
    })();

    const zipName = `${base}_selection.zip`;
    const rootName = zipName.replace(/\.zip$/i, '') || 'selection';

    const url = (p.target === 'remote')
      ? `/api/fs/archive?target=remote&sid=${encodeURIComponent(p.sid)}`
      : `/api/fs/archive?target=local`;

    xhrDownloadFile({
      url,
      method: 'POST',
      body: { items, zip_name: zipName, root_name: rootName },
      filenameHint: zipName,
      titleLabel: 'ZIP',
    });
    return;
  }

  // Single selection: directory -> ZIP, file -> direct download.
  const name = names[0];
  const it = (p.items || []).find(x => safeName(x && x.name) === safeName(name));
  if (!it) return;
  const type = String((it && it.type) || '');
  const linkDir = !!(it && it.link_dir);
  const isDir = (type === 'dir') || (type === 'link' && linkDir);

  // Directory: download as ZIP archive
  if (isDir) {
    try { toast('ZIP создаётся во временной папке /tmp и может занять много места', 'info'); } catch (e) {}
    const fullPath = (p.target === 'remote') ? joinRemote(p.cwd, it.name) : joinLocal(p.cwd, it.name);
    const url = (p.target === 'remote')
      ? `/api/fs/download?target=remote&sid=${encodeURIComponent(p.sid)}&path=${encodeURIComponent(fullPath)}&archive=zip`
      : `/api/fs/download?target=local&path=${encodeURIComponent(fullPath)}&archive=zip`;
    xhrDownloadFile({ url, filenameHint: safeName(it.name) + '.zip', titleLabel: 'ZIP' });
    return;
  }

  const fullPath = (p.target === 'remote') ? joinRemote(p.cwd, it.name) : joinLocal(p.cwd, it.name);
  const url = (p.target === 'remote')
    ? `/api/fs/download?target=remote&sid=${encodeURIComponent(p.sid)}&path=${encodeURIComponent(fullPath)}`
    : `/api/fs/download?target=local&path=${encodeURIComponent(fullPath)}`;
  xhrDownloadFile({ url, filenameHint: safeName(it.name), titleLabel: 'Download' });
}

async function goUp(side) {
    const p = S.panels[side];
    if (!p) return;
    const cur = String(p.cwd || '');
    const cand = (p.target === 'local') ? parentLocal(cur) : parentRemote(cur);
    // Local FS is sandboxed by roots; don't navigate above allowed roots.
    if (p.target === 'local' && !isAllowedLocalPath(cand, p.roots)) {
      // At sandbox boundary. If multiple roots exist, cycle to the next root (handy on routers).
      const roots = Array.isArray(p.roots) ? p.roots.slice() : [];
      if (roots.length > 1) {
        // Pick the most specific root we are currently under.
        let curRoot = roots[0];
        for (const r of roots) {
          if (_isUnderRoot(cur, r) && String(r).length >= String(curRoot).length) curRoot = r;
        }
        const idx = roots.indexOf(curRoot);
        const next = roots[(idx + 1) % roots.length];
        if (next && next !== curRoot) {
          p.cwd = next;
          p.selected.clear();
          p.focusName = '';
          await listPanel(side, { fromInput: false });
        }
      }
      return;
    }
    p.cwd = cand;
    p.selected.clear();
    p.focusName = '';
    await listPanel(side, { fromInput: false });
  }

  // -------------------------- connect / disconnect --------------------------
  // Remote connection profiles (localStorage)
  // Store without password: { id, proto, host, port, user, updatedAt }
  const _LS_REMOTE_PROFILES_KEY = 'xkeen.fm.remoteProfiles.v1';
  const _LS_REMOTE_PROFILES_LAST_KEY = 'xkeen.fm.remoteProfiles.last.v1';
  // Remember "remember profile" checkbox state (UX: user doesn't have to re-check every time)
  const _LS_REMOTE_PROFILES_REMEMBER_FLAG_KEY = 'xkeen.fm.remoteProfiles.rememberFlag.v1';

  function _lsGetJson(key, fallback) {
    try {
      const raw = window.localStorage ? window.localStorage.getItem(key) : null;
      if (!raw) return fallback;
      const j = JSON.parse(raw);
      return (j == null) ? fallback : j;
    } catch (e) {
      return fallback;
    }
  }

  function _lsSetJson(key, val) {
    try {
      if (!window.localStorage) return;
      window.localStorage.setItem(key, JSON.stringify(val));
    } catch (e) {}
  }

  function _loadRememberProfileFlag() {
    try {
      return !!_lsGetJson(_LS_REMOTE_PROFILES_REMEMBER_FLAG_KEY, false);
    } catch (e) {
      return false;
    }
  }

  function _saveRememberProfileFlag(v) {
    try { _lsSetJson(_LS_REMOTE_PROFILES_REMEMBER_FLAG_KEY, !!v); } catch (e) {}
  }

  function _profileSig(p) {
    try {
      const proto = String(p && (p.proto || p.protocol) || '').trim().toLowerCase();
      const host = String(p && p.host || '').trim().toLowerCase();
      const port = String(p && (p.port == null ? '' : p.port) || '').trim();
      const user = String(p && (p.user || p.username) || '').trim().toLowerCase();
      return `${proto}://${user}@${host}:${port}`;
    } catch (e) {
      return '';
    }
  }

  function _loadRemoteProfiles() {
    const arr = _lsGetJson(_LS_REMOTE_PROFILES_KEY, []);
    if (!Array.isArray(arr)) return [];
    // sanitize
    const out = [];
    for (const it of arr) {
      if (!it) continue;
      const proto = String(it.proto || it.protocol || '').trim().toLowerCase();
      const host = String(it.host || '').trim();
      const user = String(it.user || it.username || '').trim();
      let port = it.port;
      try { if (port != null && port !== '') port = parseInt(String(port), 10); } catch (e) { port = null; }
      const id = String(it.id || '') || _profileSig({ proto, host, user, port });
      if (!proto || !host || !user) continue;
      out.push({ id, proto, host, user, port: (port && isFinite(port)) ? port : null, updatedAt: Number(it.updatedAt || 0) || 0 });
    }
    // sort by last used
    out.sort((a, b) => (Number(b.updatedAt || 0) - Number(a.updatedAt || 0)));
    return out;
  }

  function _saveRemoteProfiles(list) {
    const arr = Array.isArray(list) ? list.slice(0, 50) : [];
    _lsSetJson(_LS_REMOTE_PROFILES_KEY, arr);
  }

  function _fmtProfileLabel(p) {
    const proto = String(p && p.proto || '').toLowerCase();
    const user = String(p && p.user || '').trim();
    const host = String(p && p.host || '').trim();
    const port = (p && p.port) ? String(p.port) : '';
    const p2 = port ? `:${port}` : '';
    return `${proto}://${user}@${host}${p2}`;
  }

  function _renderRemoteProfilesSelect(selectedId) {
    const sel = el('fm-conn-profile');
    const delBtn = el('fm-conn-profile-del-btn');
    if (!sel) return;

    const profiles = _loadRemoteProfiles();
    const cur = String(selectedId || sel.value || '').trim();

    sel.innerHTML = '';
    const opt0 = document.createElement('option');
    opt0.value = '';
    opt0.textContent = '—';
    sel.appendChild(opt0);

    for (const p of profiles) {
      const opt = document.createElement('option');
      opt.value = String(p.id || '');
      opt.textContent = _fmtProfileLabel(p);
      sel.appendChild(opt);
    }

    // restore selection
    const exists = [...sel.options].some(o => String(o.value) === cur);
    sel.value = exists ? cur : '';

    // enable delete only if something selected
    if (delBtn) delBtn.disabled = !sel.value;
  }

  function _applyProfileToConnectInputs(p) {
    if (!p) return;
    try { if (el('fm-proto')) el('fm-proto').value = String(p.proto || 'sftp'); } catch (e) {}
    try { if (el('fm-host')) el('fm-host').value = String(p.host || ''); } catch (e) {}
    try { if (el('fm-user')) el('fm-user').value = String(p.user || ''); } catch (e) {}
    try {
      const portEl = el('fm-port');
      if (portEl) portEl.value = (p.port != null && p.port !== '') ? String(p.port) : '';
    } catch (e) {}
    try {
      // reset auth UI to sane defaults for the new proto
      if (el('fm-auth-type')) el('fm-auth-type').value = 'password';
      if (el('fm-pass')) el('fm-pass').value = '';
      if (el('fm-passphrase')) el('fm-passphrase').value = '';
      if (el('fm-key-path')) el('fm-key-path').value = '';
      if (el('fm-key-file')) { try { el('fm-key-file').value = ''; } catch (e2) {} }
    } catch (e) {}
    try { updateConnectAuthUi(); } catch (e) {}
    try { updateHostKeyFingerprintPreview(); } catch (e) {}
  }

  function _getConnectProfileFromInputs() {
    const proto = String((el('fm-proto') && el('fm-proto').value) || 'sftp').trim().toLowerCase();
    const host = String((el('fm-host') && el('fm-host').value) || '').trim();
    const user = String((el('fm-user') && el('fm-user').value) || '').trim();
    const portRaw = String((el('fm-port') && el('fm-port').value) || '').trim();
    let port = null;
    try { if (portRaw) port = parseInt(portRaw, 10); } catch (e) { port = null; }
    return { proto, host, user, port: (port && isFinite(port)) ? port : null };
  }

  function _rememberConnectProfileIfNeeded() {
    const cb = el('fm-remember-profile');
    if (!cb || !cb.checked) return;

    const p = _getConnectProfileFromInputs();
    if (!p || !p.proto || !p.host || !p.user) return;

    const id = _profileSig(p);
    const now = Date.now();
    const list = _loadRemoteProfiles();
    const idx = list.findIndex(x => String(x && x.id) === id);
    const isNew = idx < 0;
    const entry = { id, proto: p.proto, host: p.host, user: p.user, port: p.port, updatedAt: now };
    if (idx >= 0) list.splice(idx, 1);
    list.unshift(entry);
    // keep last 20
    _saveRemoteProfiles(list.slice(0, 20));
    _lsSetJson(_LS_REMOTE_PROFILES_LAST_KEY, id);

    try { _renderRemoteProfilesSelect(id); } catch (e) {}
    // Small UX hint: users often miss that this is stored locally in the browser.
    try { if (isNew) toast('Профиль сохранён (в браузере)', 'info'); } catch (e) {}
  }

  function _loadLastProfileId() {
    try {
      const v = _lsGetJson(_LS_REMOTE_PROFILES_LAST_KEY, '');
      return String(v || '').trim();
    } catch (e) {
      return '';
    }
  }

  function _findRemoteProfileById(id) {
    const key = String(id || '').trim();
    if (!key) return null;
    try {
      const list = _loadRemoteProfiles();
      return list.find(p => String(p && p.id) === key) || null;
    } catch (e) {
      return null;
    }
  }

  async function loadRemoteCaps() {
    try {
      const { res, data } = await fetchJson('/api/remotefs/capabilities', { method: 'GET' });
      if (res && res.ok && data && data.ok) {
        S.remoteCaps = data;
      }
    } catch (e) {}
  }

  function applyCapsToConnectModal() {
    const caps = S.remoteCaps;
    if (!caps || !caps.security) return;

    const hk = el('fm-hostkey-policy');
    const tls = el('fm-tls-verify');
    const authType = el('fm-auth-type');

    try {
      const sftp = caps.security.sftp || {};
      if (hk && Array.isArray(sftp.hostkey_policies)) {
        hk.innerHTML = '';
        sftp.hostkey_policies.forEach((p) => {
          const opt = document.createElement('option');
          opt.value = String(p);
          opt.textContent = String(p);
          hk.appendChild(opt);
        });
        hk.value = String(sftp.default_policy || 'accept_new');
      }

      // Auth types (SFTP)
      if (authType && Array.isArray(sftp.auth_types) && sftp.auth_types.length) {
        authType.innerHTML = '';
        sftp.auth_types.forEach((t) => {
          const opt = document.createElement('option');
          opt.value = String(t);
          opt.textContent = String(t);
          authType.appendChild(opt);
        });
        if (![...authType.options].some(o => o.value === authType.value)) {
          authType.value = String(sftp.auth_types.includes('password') ? 'password' : sftp.auth_types[0]);
        }
      }
    } catch (e) {}

    try {
      const ftps = caps.security.ftps || {};
      if (tls && Array.isArray(ftps.tls_verify_modes)) {
        tls.innerHTML = '';
        ftps.tls_verify_modes.forEach((m) => {
          const opt = document.createElement('option');
          opt.value = String(m);
          opt.textContent = String(m);
          tls.appendChild(opt);
        });
        tls.value = String(ftps.default_mode || 'none');
      }
    } catch (e) {}
  }

  // -------------------------- connect modal: auth UI toggles --------------------------
  function _labelForInput(inputId) {
    try { return document.querySelector(`label[for="${inputId}"]`) || el(inputId + '-label'); } catch (e) { return el(inputId + '-label'); }
  }

  function _toggleRow(inputId, showIt) {
    const inp = el(inputId);
    const lbl = _labelForInput(inputId);
    if (lbl) lbl.style.display = showIt ? '' : 'none';
    if (inp) inp.style.display = showIt ? '' : 'none';
  }

  function updateConnectAuthUi() {
    const proto = String((el('fm-proto') && el('fm-proto').value) || 'sftp');
    const authType = String((el('fm-auth-type') && el('fm-auth-type').value) || 'password');

    const isSftp = proto === 'sftp';
    const useKey = isSftp && authType === 'key';

    // Auth type selector itself only makes sense for SFTP
    _toggleRow('fm-auth-type', isSftp);

    // Password row
    _toggleRow('fm-pass', !useKey);

    // Key rows
    _toggleRow('fm-key-file', useKey);
    _toggleRow('fm-key-path', useKey);
    _toggleRow('fm-passphrase', useKey);

    // Host key UI only for SFTP
    try {
      const hkLbl = _labelForInput('fm-hostkey-policy');
      const hk = el('fm-hostkey-policy');
      if (hkLbl) hkLbl.style.display = isSftp ? '' : 'none';
      if (hk) {
        // Note: hostkey-policy control is wrapped in a div in template.
        const wrap = hk.parentElement;
        if (wrap) wrap.style.display = isSftp ? '' : 'none';
      }
    } catch (e) {}

    try {
      const fpLbl = el('fm-hostkey-fp-label');
      const fpRow = el('fm-hostkey-row');
      const fp = el('fm-hostkey-fp');
      const rm = el('fm-hostkey-remove-btn');
      if (fpLbl) fpLbl.style.display = isSftp ? '' : 'none';
      if (fpRow) fpRow.style.display = isSftp ? 'flex' : 'none';
      if (fp) fp.style.display = isSftp ? '' : 'none';
      if (rm) rm.style.display = isSftp ? '' : 'none';
    } catch (e) {}

    // TLS verify only for FTPS
    _toggleRow('fm-tls-verify', proto === 'ftps');
  }

  function _htmlEscape(s) {
    const str = String(s == null ? '' : s);
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }


function _ruPlural(n, one, few, many) {
  // Russian plural forms: 1 строка, 2-4 строки, 5-20 строк, etc.
  try {
    const nn = Math.abs(parseInt(n, 10) || 0);
    const mod100 = nn % 100;
    const mod10 = nn % 10;
    if (mod100 > 10 && mod100 < 20) return many;
    if (mod10 === 1) return one;
    if (mod10 >= 2 && mod10 <= 4) return few;
    return many;
  } catch (e) {
    return many;
  }
}

function _toastHostkeyDeleteResult(deletedCount, prefix) {
  const p = String(prefix || 'Hostkey').trim();
  try {
    if (typeof deletedCount !== 'number') {
      toast(p + ': готово', 'success');
      return;
    }
    if (deletedCount <= 0) {
      toast(p + ': совпадений не найдено', 'info');
      return;
    }
    const w = _ruPlural(deletedCount, 'строка', 'строки', 'строк');
    toast(`${p}: удалено ${deletedCount} ${w}`, 'success');
  } catch (e) {}
}

  async function updateHostKeyFingerprintPreview() {
    const proto = String((el('fm-proto') && el('fm-proto').value) || 'sftp');
    const fpEl = el('fm-hostkey-fp');
    if (!fpEl) return;
    if (proto !== 'sftp') { fpEl.textContent = ''; return; }

    const host = String((el('fm-host') && el('fm-host').value) || '').trim();
    if (!host) { fpEl.textContent = ''; return; }
    const portRaw = String((el('fm-port') && el('fm-port').value) || '').trim();
    const port = portRaw ? portRaw : '22';
    try {
      const { res, data } = await fetchJson(`/api/remotefs/known_hosts/fingerprint?host=${encodeURIComponent(host)}&port=${encodeURIComponent(port)}`, { method: 'GET' });
      if (res && res.ok && data && data.ok) {
        const m = Array.isArray(data.matches) ? data.matches : [];
        if (!m.length) {
          fpEl.textContent = 'Нет записи (ещё не добавлялся)';
        } else {
          // Show first match + count.
          const first = m[0] || {};
          const extra = (m.length > 1) ? ` (+${m.length - 1})` : '';
          fpEl.textContent = `${String(first.key_type || '')}  ${String(first.fingerprint || '')}${extra}`.trim();
        }
      } else {
        fpEl.textContent = '';
      }
    } catch (e) {
      fpEl.textContent = '';
    }
  }

  async function removeHostKeyForCurrentHost() {
    const proto = String((el('fm-proto') && el('fm-proto').value) || 'sftp');
    if (proto !== 'sftp') return;
    const host = String((el('fm-host') && el('fm-host').value) || '').trim();
    if (!host) return;
    const portRaw = String((el('fm-port') && el('fm-port').value) || '').trim();
    let port = 22;
    try { if (portRaw) port = parseInt(portRaw, 10) || 22; } catch (e) {}

    const ok = await (XKeen.ui && typeof XKeen.ui.confirm === 'function'
      ? XKeen.ui.confirm({
        title: 'known_hosts',
        message: `Удалить hostkey для ${host}${(port && port !== 22) ? (':' + port) : ''}?`,
        okText: 'Удалить',
        cancelText: 'Отмена',
        danger: true
      })
      : Promise.resolve(window.confirm('Delete hostkey?')));
    if (!ok) return;

    try {
      const { res, data } = await fetchJson('/api/remotefs/known_hosts/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host: host, port: port })
      });
      const n = (data && typeof data.deleted_count === 'number') ? data.deleted_count : null;
      _toastHostkeyDeleteResult(n, 'Hostkey');
    } catch (e) {
      try { toast('Hostkey: ошибка удаления', 'error'); } catch (e2) {}
    }

    try { await updateHostKeyFingerprintPreview(); } catch (e) {}
    // If known_hosts modal is open, refresh it too
    try {
      const khModal = el('fm-knownhosts-modal');
      if (khModal && !khModal.classList.contains('hidden')) {
        await loadKnownHostsIntoModal();
      }
    } catch (e) {}
  }

  // -------------------------- known_hosts modal --------------------------
  async function loadKnownHostsIntoModal() {
    const body = el('fm-knownhosts-body');
    const pathEl = el('fm-knownhosts-path');
    const errEl = el('fm-knownhosts-error');
    const hintEl = el('fm-knownhosts-hashed-hint');
    if (errEl) errEl.textContent = '';
    if (hintEl) { hintEl.textContent = ''; hintEl.style.display = 'none'; }
    if (body) body.innerHTML = '<div class="fm-empty">Загрузка…</div>';
    try {
      const { res, data } = await fetchJson('/api/remotefs/known_hosts', { method: 'GET' });
      if (!res || !res.ok || !data || !data.ok) {
        if (body) body.innerHTML = '';
        if (errEl) errEl.textContent = (data && (data.error || data.message)) ? String(data.error || data.message) : 'known_hosts_failed';
        return;
      }
      if (pathEl) pathEl.textContent = String(data.path || '');
      const entries = Array.isArray(data.entries) ? data.entries : [];
      if (!entries.length) {
        if (body) body.innerHTML = '<div class="fm-empty">known_hosts пуст</div>';
        if (hintEl) { hintEl.textContent = ''; hintEl.style.display = 'none'; }
        return;
      }

      // hashed entries hide the hostname (OpenSSH feature). Warn the user and suggest deletion by host if they know it.
      try {
        const hasHashed = entries.some((e) => !!e && !!e.hashed);
        if (hintEl && hasHashed) {
          hintEl.textContent = 'Есть hashed записи (|1|…). Имя хоста скрыто. Удалить можно по индексу (кнопка «Запись») или через «Удалить по host», если знаете хост.';
          hintEl.style.display = '';
        }
      } catch (e) {}
      const rows = entries.map((e) => {
        const idx = String(e.idx);
        const rawHosts = String(e.hosts || '');
        const hostsEsc = _htmlEscape(rawHosts);
        const kt = _htmlEscape(e.key_type || '');
        const fp = _htmlEscape(e.fingerprint || '');
        const bad = e.bad ? ' style="opacity:.7;"' : '';
        const isHashed = !!e.hashed;

        // Try to take the first host token for a convenient "delete by host" action.
        let firstTok = '';
        try {
          firstTok = rawHosts.split(',').map((s) => String(s || '').trim()).filter(Boolean)[0] || '';
        } catch (e2) {}
        const canByHost = !!firstTok && !isHashed;

        const hostCell = isHashed
          ? `<span style="display:inline-block; padding:1px 6px; border:1px solid currentColor; border-radius:999px; font-size:12px; opacity:.75; margin-right:6px;" title="hashed entry: имя хоста скрыто">hashed</span><span style="font-family:monospace;">${hostsEsc}</span>`
          : hostsEsc;

        const byHostBtn = canByHost
          ? `<button type="button" class="btn-secondary" data-kh-action="delete_host" data-kh-host="${_htmlEscape(firstTok)}" title="Удалить hostkey для ${_htmlEscape(firstTok)}">Hostkey</button>`
          : `<button type="button" class="btn-secondary" disabled title="Для hashed записи используйте «Удалить по host» сверху">Hostkey</button>`;

        return `<tr${bad}>
          <td style="white-space:nowrap;">${idx}</td>
          <td style="max-width:360px; overflow:hidden; text-overflow:ellipsis;">${hostCell}</td>
          <td style="white-space:nowrap;">${kt}</td>
          <td style="font-family:monospace; max-width:240px; overflow:hidden; text-overflow:ellipsis;">${fp}</td>
          <td style="text-align:right; white-space:nowrap; display:flex; gap:6px; justify-content:flex-end; flex-wrap:wrap;">
            ${byHostBtn}
            <button type="button" class="btn-secondary" data-kh-action="delete" data-kh-idx="${idx}" title="Удалить конкретную строку">Запись</button>
          </td>
        </tr>`;
      }).join('');
      if (body) {
        body.innerHTML = `
          <table class="table" style="width:100%; border-collapse:collapse;">
            <thead>
              <tr>
                <th style="text-align:left;">#</th>
                <th style="text-align:left;">Host</th>
                <th style="text-align:left;">Type</th>
                <th style="text-align:left;">Fingerprint</th>
                <th></th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        `;
      }
    } catch (e) {
      if (body) body.innerHTML = '';
      if (errEl) errEl.textContent = 'known_hosts_failed';
    }
  }

  function openKnownHostsModal() {
    const errEl = el('fm-knownhosts-error');
    if (errEl) errEl.textContent = '';
    modalOpen(el('fm-knownhosts-modal'));
    loadKnownHostsIntoModal();
  }

  async function connectRemoteToSide(side) {
    S.connectForSide = side;

    // reset UI
    const errEl = el('fm-connect-error');
    const warnEl = el('fm-connect-warn');
    if (errEl) errEl.textContent = '';
    if (warnEl) { warnEl.textContent = ''; hide(warnEl); }

    applyCapsToConnectModal();

    // Persisted UX: remember checkbox state across modal openings (stored in browser localStorage).
    try {
      const cb = el('fm-remember-profile');
      if (cb) cb.checked = _loadRememberProfileFlag();
    } catch (e) {}

    // Profiles UI (localStorage)
    try {
      const lastId = _loadLastProfileId();
      _renderRemoteProfilesSelect(lastId);
      // Autofill from last profile only if host/user fields are empty
      const h0 = String((el('fm-host') && el('fm-host').value) || '').trim();
      const u0 = String((el('fm-user') && el('fm-user').value) || '').trim();
      if ((!h0 || !u0) && lastId) {
        const pr = _findRemoteProfileById(lastId);
        if (pr) _applyProfileToConnectInputs(pr);
      }
    } catch (e) {}

    // Ensure correct field visibility (auth / proto dependent)
    try { updateConnectAuthUi(); } catch (e) {}
    try { updateHostKeyFingerprintPreview(); } catch (e) {}
    modalOpen(el('fm-connect-modal'));

    // focus host
    setTimeout(() => {
      try { const h = el('fm-host'); h && h.focus(); } catch (e) {}
    }, 0);
  }

  async function doConnect() {
    const side = S.connectForSide;
    const p = S.panels[side];
    if (!p) return;

    const proto = String((el('fm-proto') && el('fm-proto').value) || 'sftp');
    const host = String((el('fm-host') && el('fm-host').value) || '').trim();
    const portRaw = String((el('fm-port') && el('fm-port').value) || '').trim();
    const user = String((el('fm-user') && el('fm-user').value) || '').trim();
    const pass = String((el('fm-pass') && el('fm-pass').value) || '');
    const authTypeRaw = String((el('fm-auth-type') && el('fm-auth-type').value) || 'password');
    const authType = (proto === 'sftp') ? authTypeRaw : 'password';

    const hkPolicy = String((el('fm-hostkey-policy') && el('fm-hostkey-policy').value) || 'accept_new');
    const tlsVerify = String((el('fm-tls-verify') && el('fm-tls-verify').value) || 'none');

    const errEl = el('fm-connect-error');
    const warnEl = el('fm-connect-warn');
    if (errEl) errEl.textContent = '';
    if (warnEl) { warnEl.textContent = ''; hide(warnEl); }

    if (!host) {
      if (errEl) errEl.textContent = 'Host обязателен';
      return;
    }
    if (!user) {
      if (errEl) errEl.textContent = 'User обязателен';
      return;
    }
    // Auth validation depends on mode
    let auth = null;
    if (authType === 'password') {
      if (!pass) {
        if (errEl) errEl.textContent = 'Password обязателен';
        return;
      }
      auth = { type: 'password', password: pass };
    } else {
      const keyPath = String((el('fm-key-path') && el('fm-key-path').value) || '').trim();
      const passphrase = String((el('fm-passphrase') && el('fm-passphrase').value) || '');
      const f = el('fm-key-file') && el('fm-key-file').files ? el('fm-key-file').files[0] : null;

      let keyData = '';
      if (f) {
        try {
          if (typeof f.text === 'function') {
            keyData = await f.text();
          } else {
            keyData = await new Promise((resolve, reject) => {
              try {
                const r = new FileReader();
                r.onload = () => resolve(String(r.result || ''));
                r.onerror = () => reject(new Error('read_failed'));
                r.readAsText(f);
              } catch (e) { reject(e); }
            });
          }
        } catch (e) {
          if (errEl) errEl.textContent = 'Не удалось прочитать ключ';
          return;
        }
      }

      if (!keyData && !keyPath) {
        if (errEl) errEl.textContent = 'Укажите ключ (upload) или путь к ключу';
        return;
      }
      auth = { type: 'key', key_data: keyData || undefined, key_path: keyData ? undefined : keyPath, passphrase: passphrase || undefined };
    }

    let port = null;
    try {
      if (portRaw) port = parseInt(portRaw, 10);
    } catch (e) { port = null; }

    const options = {};
    if (proto === 'sftp') {
      options.hostkey_policy = hkPolicy;
      // server also accepts legacy sftp:auto-confirm, but we are using new model.
    }
    if (proto === 'ftps') {
      // Keep compatibility with different backend schemas.
      options.tls_verify_mode = tlsVerify;
      options.tls_verify = tlsVerify;
    }

    const payload = {
      protocol: proto,
      host,
      port: port || undefined,
      username: user,
      auth,
      options,
    };

    const { res, data } = await fetchJson('/api/remotefs/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res || !res.ok || !data) {
      if (errEl) errEl.textContent = 'connect_failed';
      return;
    }

    if (!data.ok) {
      const msg = String(data.error || data.message || 'connect_failed');
      if (errEl) errEl.textContent = msg;
      if (data && data.hint && warnEl) {
        warnEl.textContent = String(data.hint);
        show(warnEl);
      }
      return;
    }

    // Warnings (security policy etc.)
    if (Array.isArray(data.warnings) && data.warnings.length && warnEl) {
      warnEl.textContent = data.warnings.map(String).join('\n');
      show(warnEl);
    }

    p.target = 'remote';
    p.sid = String(data.session_id || '');
    p.rproto = String(proto || '');
    // Use '.' as home for maximum compatibility (some SFTP servers/chroots do not expose '/').
    p.cwd = '.';
    p.items = [];
    p.selected.clear();
    p.focusName = '';

    // Save connection profile (without password) if requested.
    try { _rememberConnectProfileIfNeeded(); } catch (e) {}

    modalClose(el('fm-connect-modal'));

    toast('Подключено: ' + user + '@' + host, 'success');
    renderPanel(side);
    await listPanel(side, { fromInput: false });
  }

  // Choose a local directory to show after remote disconnect.
  // Keenetic UX:
  //  - default: /opt
  //  - if multiple disks are attached: /tmp/mnt (disk picker)
  async function pickLocalCwdAfterRemoteDisconnect() {
    // Fallback: /opt (even if disk detection fails).
    const fallback = '/opt';
    try {
      const url = `/api/fs/list?target=local&path=${encodeURIComponent('/tmp/mnt')}`;
      const { res, data } = await fetchJson(url, { method: 'GET' });
      if (!res || !res.ok || !data || !data.ok) return fallback;

      const items = Array.isArray(data.items) ? data.items : [];
      // Disk entries are "dir" or directory-like symlinks returned by the backend.
      const disks = items.filter((it) => {
        const t = String(it && it.type);
        return (t === 'dir') || (t === 'link' && !!(it && it.link_dir));
      });
      if (disks.length > 1) return '/tmp/mnt';
    } catch (e) {}
    return fallback;
  }

  async function disconnectSide(side) {
    const p = S.panels[side];
    if (!p || !p.sid) return;

    const ok = await (XKeen.ui && typeof XKeen.ui.confirm === 'function'
      ? XKeen.ui.confirm({ title: 'Disconnect', message: 'Отключиться от текущего удалённого сервера?', okText: 'Disconnect', cancelText: 'Отмена', danger: false })
      : Promise.resolve(window.confirm('Disconnect?')));

    if (!ok) return;

    const sid = p.sid;
    await fetchJson(`/api/remotefs/sessions/${encodeURIComponent(sid)}`, { method: 'DELETE' });

    // Reset remote session state.
    p.sid = '';
    p.rproto = '';
    p.items = [];
    p.selected.clear();
    p.focusName = '';

    // Switch panel back to local and go to a sensible Keenetic directory.
    p.target = 'local';
    p.cwd = await pickLocalCwdAfterRemoteDisconnect();

    renderPanel(side);
    toast('Отключено', 'info');
    // Load the new local directory immediately.
    await listPanel(side, { fromInput: false });
  }

  // -------------------------- fileops --------------------------
  function buildCopyMovePayload(op, srcSide, dstSide, opts) {
    const src = S.panels[srcSide];
    const dst = S.panels[dstSide];

    const names = getSelectionNames(srcSide);
    const sources = names.map((n) => ({
      path: (src.target === 'remote') ? joinRemote(src.cwd, n) : joinLocal(src.cwd, n),
      name: n,
      is_dir: !!(src.items || []).find((it) => {
        if (safeName(it && it.name) !== n) return false;
        const t = String((it && it.type) || '');
        return t === 'dir' || (t === 'link' && !!(it && it.link_dir));
      }),
    }));

    const payload = {
      op,
      src: {
        target: src.target,
        sid: src.target === 'remote' ? src.sid : undefined,
        cwd: src.cwd,
        paths: names,
      },
      dst: {
        target: dst.target,
        sid: dst.target === 'remote' ? dst.sid : undefined,
        path: dst.cwd,
        is_dir: true,
      },
      sources, // optional, but backend will normalize anyway
      options: Object.assign({ overwrite: 'ask' }, opts || {}),
    };

    return payload;
  }

  function buildDeletePayload(side, opts) {
    const p = S.panels[side];
    const names = getSelectionNames(side);
    return {
      op: 'delete',
      src: {
        target: p.target,
        sid: p.target === 'remote' ? p.sid : undefined,
        cwd: p.cwd,
        paths: names,
      },
      options: Object.assign({}, opts || {}),
    };
  }

  async function requestWsToken() {
    const { res, data } = await fetchJson('/api/fileops/ws-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: 120 }),
    });
    if (!res || !res.ok || !data || !data.ok) return '';
    return String(data.token || '');
  }

  function closeJobWs() {
    try {
      if (S.ws.socket) {
        S.ws.socket.close();
      }
    } catch (e) {}
    try { if (S.ws.pollTimer) clearInterval(S.ws.pollTimer); } catch (e) {}
    S.ws.pollTimer = null;
    S.ws.socket = null;
    S.ws.jobId = '';
    S.ws.token = '';
  }

  // Update the progress modal UI.
  // opts:
  //   - viewOnly: do not auto-close on success (used when user opens a finished job from the Operations list)
  function updateProgressModal(job, opts) {
    opts = opts || {};
    const viewOnly = !!opts.viewOnly;
    const title = el('fm-progress-title');
    const bar = el('fm-progress-bar-inner');
    const meta = el('fm-progress-meta');
    const details = el('fm-progress-details');
    const err = el('fm-progress-error');

    _ensureProgressDetailsToggle();
    if (err) err.textContent = '';

    try {
      const op = String(job.op || 'op');
      const st = String(job.state || '');
      const stLower = st.toLowerCase();
      const finished = (stLower === 'done' || stLower === 'error' || stLower === 'canceled');

      // Job id + timestamps block
      try { _setProgressExtra(job); } catch (e) {}

      // Details button:
      // - errors: always
      // - viewOnly (user opens completed job from Operations): allow inspecting raw JSON even for "done"
      _setProgressDetailsAvailable(stLower === 'error' || !!viewOnly);

      // Action buttons: hide cancel for finished/view-only states; make label explicit.
      try {
        const cbtn = el('fm-progress-cancel-btn');
        if (cbtn) {
          cbtn.disabled = finished;
          cbtn.style.display = (finished || viewOnly) ? 'none' : '';
        }
        const okBtn = el('fm-progress-ok-btn');
        if (okBtn) okBtn.textContent = (finished || viewOnly) ? 'Закрыть' : 'Скрыть';
      } catch (e) {}
      // Auto-close modal after successful completion.
      // When user is just viewing a finished operation from the Operations list, we must NOT auto-close.
      if (stLower === 'done' && !viewOnly) {
        _clearProgressAutoClose();
        _scheduleProgressAutoClose(650);
      } else {
        _clearProgressAutoClose();
      }

      const jobId = String(job.job_id || '');
      const cur = job.progress && job.progress.current ? job.progress.current : null;
      const curName = cur && cur.name ? String(cur.name) : '';
      const curPhase = cur && cur.phase ? String(cur.phase) : '';

      if (title) {
        const t = op.toUpperCase() + ' — ' + st + (curName ? (' — ' + curName) : '');
        title.textContent = t;
      }

      const bytesDone = Number(job.progress && job.progress.bytes_done || 0);
      const bytesTotal = Number(job.progress && job.progress.bytes_total || 0);
      const filesDone = Number(job.progress && job.progress.files_done || 0);
      const filesTotal = Number(job.progress && job.progress.files_total || 0);

      const pct = (bytesTotal > 0) ? Math.max(0, Math.min(100, Math.round((bytesDone / bytesTotal) * 100))) : (filesTotal > 0 ? Math.round((filesDone / filesTotal) * 100) : 0);
      if (bar) bar.style.width = pct + '%';

      if (meta) {
        const parts = [];
        if (curPhase) parts.push('phase: ' + curPhase);
        if (filesTotal > 0) parts.push(`files: ${filesDone}/${filesTotal}`);
        if (bytesTotal > 0) parts.push(`bytes: ${fmtSize(bytesDone)} / ${fmtSize(bytesTotal)} (${pct}%)`);

        // Speed + ETA (best-effort, based on client-side delta between WS updates)
        try {
          if (jobId && bytesTotal > 0 && (st === 'running' || st === 'queued')) {
            const now = _nowMs();
            const prev = S.jobStats[jobId] || { lastTsMs: 0, lastBytes: 0, speed: 0 };
            const dt = Math.max(1, now - (prev.lastTsMs || now));
            const db = Math.max(0, bytesDone - (prev.lastBytes || 0));
            const inst = (db * 1000) / dt;
            const speed = prev.speed ? (prev.speed * 0.75 + inst * 0.25) : inst;
            S.jobStats[jobId] = { lastTsMs: now, lastBytes: bytesDone, speed };
            const sp = _fmtSpeed(speed);
            if (sp) parts.push(sp);
            if (speed > 1 && bytesDone <= bytesTotal) {
              const eta = (bytesTotal - bytesDone) / speed;
              const et = _fmtEta(eta);
              if (et) parts.push('ETA ' + et);
            }
          }
        } catch (e) {}
        meta.textContent = parts.join('   ');
      }

      if (details) {
        // Keep raw JSON available behind the Details toggle.
        details.textContent = JSON.stringify(job, null, 2);
      }

      if (job.state === 'error' && err) {
        let msg = String(job.error || (job.last_error && job.last_error.message) || 'error');
        try {
          if (msg === 'remote_no_space') {
            const chk = job && job.progress && job.progress.check ? job.progress.check : null;
            const need = chk && typeof chk.need_bytes === 'number' ? chk.need_bytes : null;
            const free = chk && typeof chk.free_bytes === 'number' ? chk.free_bytes : null;
            if (need != null && free != null) {
              msg = `Недостаточно места на удалённом диске: нужно ${fmtSize(need)}, свободно ${fmtSize(free)}`;
            } else {
              msg = 'Недостаточно места на удалённом диске';
            }
          }
        } catch (e2) {}
        err.textContent = msg;
      }
    } catch (e) {
      if (details) details.textContent = '';
    }
  }


function _maybeTrashToast(job) {
  try {
    if (!job) return;
    const op = String(job.op || '').toLowerCase();
    if (op !== 'delete') return;
    const pr = job.progress || {};
    const t = pr.trash || null;
    const notice = t && t.notice ? String(t.notice) : '';
    if (!notice) return;

    const now = _nowMs();
    if (!S.trashUi) S.trashUi = { lastLevel: '', lastTsMs: 0, lastNotice: '' };
    // Avoid spamming the same notice frequently.
    if (S.trashUi.lastNotice === notice && (now - (S.trashUi.lastTsMs || 0)) < 60 * 1000) return;

    S.trashUi.lastNotice = notice;
    S.trashUi.lastTsMs = now;

    let level = 'info';
    try {
      const sum = t && t.summary ? t.summary : {};
      if ((sum.trash_full || 0) > 0 || (t.stats && t.stats.is_full)) level = 'error';
    } catch (e) {}
    toast(notice, level);
  } catch (e) {}
}

  async function startJobPolling(jobId) {
    if (!jobId) return;
    try { if (S.ws.pollTimer) clearInterval(S.ws.pollTimer); } catch (e) {}
    let busy = false;
    S.ws.pollTimer = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        const { res, data } = await fetchJson(`/api/fileops/jobs/${encodeURIComponent(jobId)}`, { method: 'GET' });
        if (res && res.ok && data && data.ok && data.job) {
          const job = data.job;
          updateProgressModal(job);
          const st = String(job.state || '').toLowerCase();
          if (st === 'done' || st === 'error' || st === 'canceled') {
            try { clearInterval(S.ws.pollTimer); } catch (e2) {}
            S.ws.pollTimer = null;

            try {
              const op = String(job.op || '').toLowerCase();
              const label = (op === 'copy') ? 'Копирование' : (op === 'move' ? 'Перемещение' : (op === 'delete' ? 'Удаление' : 'Операция'));
              if (st === 'done') toast(label + ': завершено', 'success');
              else if (st === 'canceled') toast(label + ': отменено', 'info');
              else if (st === 'error') toast(label + ': ошибка', 'error');
              try { _maybeTrashToast(job); } catch (e) {}
            } catch (e3) {}

            setTimeout(() => {
              refreshAll();
            }, 300);
          }
        }
      } catch (e) {
        // ignore polling errors
      } finally {
        busy = false;
      }
    }, 500);
  }

  async function watchJob(jobId) {
    closeJobWs();

    const token = await requestWsToken();
    if (!token) {
      toast('WebSocket недоступен — использую HTTP-пулинг', 'info');
      S.ws.jobId = jobId;
      startJobPolling(jobId);
      return;
    }

    const proto = (window.location.protocol === 'https:') ? 'wss:' : 'ws:';
    const wsUrl = `${proto}//${window.location.host}/ws/fileops?token=${encodeURIComponent(token)}&job_id=${encodeURIComponent(jobId)}`;

    S.ws.jobId = jobId;
    S.ws.token = token;

    let opened = false;
    let finished = false;
    let fallbackStarted = false;
    const startFallback = () => {
      if (fallbackStarted) return;
      fallbackStarted = true;
      try { if (S.ws.socket) S.ws.socket.close(); } catch (e) {}
      S.ws.socket = null;
      startJobPolling(jobId);
    };

    const ws = new WebSocket(wsUrl);
    S.ws.socket = ws;

    const fallbackTimer = setTimeout(() => {
      try {
        if (!opened && ws.readyState !== WebSocket.OPEN) startFallback();
      } catch (e) {
        startFallback();
      }
    }, 700);

    ws.onopen = () => { opened = true; try { clearTimeout(fallbackTimer); } catch (e) {} };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data || '{}'));
        if (msg && msg.job) {
          updateProgressModal(msg.job);
          if (msg.type === 'done') {
            finished = true;
            // Toast job result
            try {
              const job = msg.job || {};
              const op = String(job.op || '').toLowerCase();
              const st = String(job.state || '').toLowerCase();
              const label = (op === 'copy') ? 'Копирование' : (op === 'move' ? 'Перемещение' : (op === 'delete' ? 'Удаление' : 'Операция'));
              if (st === 'done') toast(label + ': завершено', 'success');
              else if (st === 'canceled') toast(label + ': отменено', 'info');
              else if (st === 'error') toast(label + ': ошибка', 'error');
              try { _maybeTrashToast(job); } catch (e) {}
            } catch (e) {}
            // refresh panels on finish
            setTimeout(() => {
              refreshAll();
            }, 300);
          }
        }
      } catch (e) {}
    };

    ws.onerror = () => {
      // Keep it quiet.
    };

    ws.onclose = () => {
      try { clearTimeout(fallbackTimer); } catch (e) {}
      if (!finished) {
        // If WS is unavailable (no gevent) or connection dropped, fall back to HTTP polling.
        startFallback();
      }
    };
  }

  async function cancelJob(jobId) {
    if (!jobId) return;
    await fetchJson(`/api/fileops/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' });
  }


function _deepClone(obj) {
  try { return JSON.parse(JSON.stringify(obj)); } catch (e) { return obj; }
}

async function runCopyMoveWithPayload(op, basePayload) {
  if (!basePayload) return;

  // Dry-run first to collect conflicts (same UX as F5/F6).
  const dryPayload = _deepClone(basePayload);
  dryPayload.op = op;
  dryPayload.options = Object.assign({}, dryPayload.options || {}, { overwrite: 'ask', dry_run: true });

  const { res, data } = await fetchJson('/api/fileops/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(dryPayload),
  });

  if (res && res.ok && data && data.ok && data.dry_run) {
    const conflicts = Array.isArray(data.conflicts) ? data.conflicts : [];
    if (conflicts.length) {
      S.pending = { op, basePayload: _deepClone(basePayload), conflicts };
      try { S.pending.basePayload.options = Object.assign({}, S.pending.basePayload.options || {}, { overwrite: 'ask' }); } catch (e) {}
      renderConflicts(conflicts);
      modalOpen(el('fm-conflicts-modal'));
      return;
    }
    const execPayload = _deepClone(basePayload);
    execPayload.op = op;
    execPayload.options = Object.assign({}, execPayload.options || {}, { overwrite: 'replace' });
    try { delete execPayload.options.dry_run; } catch (e) {}
    await executeJob(execPayload);
    return;
  }

  // Conflicts via legacy 409 path
  if (res && res.status === 409 && data && data.error === 'conflicts') {
    const conflicts = Array.isArray(data.conflicts) ? data.conflicts : [];
    S.pending = { op, basePayload: _deepClone(basePayload), conflicts };
    try { S.pending.basePayload.options = Object.assign({}, S.pending.basePayload.options || {}, { overwrite: 'ask' }); } catch (e) {}
    renderConflicts(conflicts);
    modalOpen(el('fm-conflicts-modal'));
    return;
  }

  // Server may not support dry_run -> just execute.
  const execPayload = _deepClone(basePayload);
  execPayload.op = op;
  execPayload.options = Object.assign({}, execPayload.options || {}, { overwrite: 'replace' });
  try { delete execPayload.options.dry_run; } catch (e) {}
  await executeJob(execPayload);
}

  async function runCopyMove(op) {
    const srcSide = S.activeSide;
    const dstSide = otherSide(srcSide);
    const src = S.panels[srcSide];
    const dst = S.panels[dstSide];

    if (!src || !dst) return;

    if (src.target === 'remote' && !src.sid) {
      toast('Источник: remote без сессии', 'info');
      return;
    }
    if (dst.target === 'remote' && !dst.sid) {
      toast('Назначение: remote без сессии', 'info');
      return;
    }

    const names = getSelectionNames(srcSide);
    if (!names.length) return;

    // If both panels point to the same folder, "copy" should mean "duplicate".
    // Old behavior could attempt overwrite of the same path and lead to data loss on replace.
    try {
      const sameLocalDir = (src.target === 'local' && dst.target === 'local'
        && _trimSlashes(String(src.cwd || '')) === _trimSlashes(String(dst.cwd || '')));
      const sameRemoteDir = (src.target === 'remote' && dst.target === 'remote'
        && String(src.sid || '') === String(dst.sid || '')
        && normRemotePath(String(src.cwd || '')) === normRemotePath(String(dst.cwd || '')));

      if ((sameLocalDir || sameRemoteDir) && op === 'move') {
        toast('Источник и назначение совпадают (move — нечего делать)', 'info');
        return;
      }

      if ((sameLocalDir || sameRemoteDir) && op === 'copy') {
        if (names.length !== 1) {
          toast('Обе панели в одном каталоге: для копирования нескольких элементов выберите другой каталог назначения', 'info');
          return;
        }

        const srcName = names[0];
        const existing = new Set((src.items || []).map((it) => safeName(it && it.name)));
        const isDir = !!(src.items || []).find((it) => safeName(it && it.name) === srcName && String(it.type) === 'dir');

        // Propose "name (2).ext", "name (3).ext"…
        const dot = (isDir ? -1 : String(srcName).lastIndexOf('.'));
        const stem = (dot > 0) ? String(srcName).slice(0, dot) : String(srcName);
        const ext = (dot > 0) ? String(srcName).slice(dot) : '';
        let newName = '';
        for (let i = 2; i < 10000; i++) {
          const cand = `${stem} (${i})${ext}`;
          if (!existing.has(cand)) { newName = cand; break; }
        }
        if (!newName) newName = `${stem} (copy)${ext}`;

        const payload = buildCopyMovePayload(op, srcSide, dstSide, { overwrite: 'ask' });
        payload.dst = Object.assign({}, payload.dst || {}, {
          path: (dst.target === 'remote') ? joinRemote(dst.cwd, newName) : joinLocal(dst.cwd, newName),
          is_dir: false,
        });

        await runCopyMoveWithPayload('copy', payload);
        return;
      }
    } catch (e) {}

    const payload = buildCopyMovePayload(op, srcSide, dstSide, { overwrite: 'ask', dry_run: true });

    const { res, data } = await fetchJson('/api/fileops/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (res && res.ok && data && data.ok && data.dry_run) {
      const conflicts = Array.isArray(data.conflicts) ? data.conflicts : [];
      if (conflicts.length) {
        // Show conflicts modal
        S.pending = {
          op,
          basePayload: buildCopyMovePayload(op, srcSide, dstSide, { overwrite: 'ask' }),
          conflicts,
        };
        renderConflicts(conflicts);
        modalOpen(el('fm-conflicts-modal'));
        return;
      }
      // No conflicts -> execute directly
      await executeJob(buildCopyMovePayload(op, srcSide, dstSide, { overwrite: 'replace' }));
      return;
    }

    // If server doesn't support dry_run or returns 409 conflicts
    if (res && res.status === 409 && data && data.error === 'conflicts') {
      const conflicts = Array.isArray(data.conflicts) ? data.conflicts : [];
      S.pending = {
        op,
        basePayload: buildCopyMovePayload(op, srcSide, dstSide, { overwrite: 'ask' }),
        conflicts,
      };
      renderConflicts(conflicts);
      modalOpen(el('fm-conflicts-modal'));
      return;
    }

    toast('copy/move failed', 'error');
  }

  async function executeJob(payload) {
    const { res, data } = await fetchJson('/api/fileops/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res || !data) {
      toast('job_failed', 'error');
      return;
    }

    if (!res.ok || !data.ok) {
      const msg = String(data.error || data.message || 'job_failed');
      toast(msg, 'error');
      return;
    }

    const jobId = String(data.job_id || '');
    if (!jobId) {
      toast('job_id missing', 'error');
      return;
    }

    // Show progress modal
    _ensureProgressDetailsToggle();
    _setProgressDetailsAvailable(false);
    _clearProgressAutoClose();
    modalOpen(el('fm-progress-modal'));
    updateProgressModal(data.job || { op: payload.op, state: 'queued', progress: {} });

    await watchJob(jobId);
  }

  function renderConflicts(conflicts) {
    const box = el('fm-conflicts-list');
    if (!box) return;

    box.innerHTML = '';
    const list = document.createElement('div');
    list.className = 'fm-conflicts-table';

    const head = document.createElement('div');
    head.className = 'fm-conflicts-row fm-conflicts-head';
    head.innerHTML = '<div>Источник</div><div>Назначение</div><div>Действие</div>';
    list.appendChild(head);

    conflicts.forEach((c, idx) => {
      const row = document.createElement('div');
      row.className = 'fm-conflicts-row';
      const src = safeName(c.src_path || c.src_name || '');
      const dst = safeName(c.dst_path || '');
      const sel = document.createElement('select');
      sel.className = 'terminal-input';
      sel.style.maxWidth = '120px';
      sel.innerHTML = '<option value="replace">replace</option><option value="skip">skip</option>';
      sel.value = 'replace';
      sel.dataset.idx = String(idx);
      row.appendChild((() => { const d = document.createElement('div'); d.textContent = src; return d; })());
      row.appendChild((() => { const d = document.createElement('div'); d.textContent = dst; return d; })());
      row.appendChild((() => { const d = document.createElement('div'); d.appendChild(sel); return d; })());
      list.appendChild(row);
    });

    box.appendChild(list);

    const def = el('fm-conflicts-default');
    if (def) {
      def.value = 'replace';
      def.onchange = () => {
        const v = String(def.value || 'replace');
        qsa('#fm-conflicts-list select', document).forEach((s) => {
          try { s.value = v; } catch (e) {}
        });
      };
    }
  }

  async function applyConflictsAndContinue() {
    const errEl = el('fm-conflicts-error');
    if (errEl) errEl.textContent = '';

    const pending = S.pending;
    if (!pending || !pending.basePayload) {
      modalClose(el('fm-conflicts-modal'));
      return;
    }

    const decisions = {};
    const sels = qsa('#fm-conflicts-list select', document);
    sels.forEach((s) => {
      const idx = parseInt(String(s.dataset.idx || '0'), 10);
      const c = pending.conflicts && pending.conflicts[idx] ? pending.conflicts[idx] : null;
      if (!c) return;
      const act = String(s.value || '').trim();
      const k1 = safeName(c.dst_path || '');
      const k2 = safeName(c.src_path || '');
      if (k1) decisions[k1] = act;
      if (k2) decisions[k2] = act;
    });

    const payload = Object.assign({}, pending.basePayload);
    payload.options = Object.assign({}, pending.basePayload.options || {}, {
      overwrite: 'ask',
      decisions,
      default_action: String((el('fm-conflicts-default') && el('fm-conflicts-default').value) || 'replace'),
    });

    S.pending = null;
    modalClose(el('fm-conflicts-modal'));

    await executeJob(payload);
  }

  async function runRestore() {
    const side = S.activeSide;
    const p = S.panels[side];
    if (!p) return;
    if (String(p.target || 'local') !== 'local') {
      toast('Восстановление работает только для local (корзина)', 'info');
      return;
    }
    if (!isTrashPanel(p)) {
      toast(`Восстановление доступно только из ${_getTrashRoot()}`, 'info');
      return;
    }

    const names = getSelectionNames(side);
    if (!names.length) return;

    const ok = await (XKeen.ui && typeof XKeen.ui.confirm === 'function'
      ? XKeen.ui.confirm({
          title: 'Восстановить',
          message: `Восстановить (${names.length})?
${names.slice(0, 6).join('\n')}${names.length > 6 ? '\n…' : ''}`,
          okText: 'Восстановить',
          cancelText: 'Отмена',
        })
      : Promise.resolve(window.confirm('Restore?')));


    if (!ok) return;

    const paths = names.map((nm) => joinLocal(p.cwd, nm));
    try {
      const { res, data } = await fetchJson('/api/fs/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: 'local', paths }),
      });
      if (!res || !res.ok || !data || !data.ok) {
        toast('Ошибка восстановления', 'error');
        return;
      }
      const nOk = Array.isArray(data.restored) ? data.restored.length : 0;
      const nErr = Array.isArray(data.errors) ? data.errors.length : 0;
      if (nOk) toast(`Восстановлено: ${nOk}${nErr ? `, ошибок: ${nErr}` : ''}`, nErr ? 'info' : 'success');
      else toast(nErr ? `Не восстановлено, ошибок: ${nErr}` : 'Нечего восстанавливать', nErr ? 'error' : 'info');

      // Refresh current trash view (items should disappear from here)
      await listPanel(side, { fromInput: true });

      // Optimistic UI: clear selection
      p.selected.clear();
    } catch (e) {
      toast('Ошибка восстановления', 'error');
    }
  }

  async function runClearTrash(side) {
    side = (side === 'left' || side === 'right') ? side : S.activeSide;
    const p = S.panels[side];
    if (!p) return;
    if (String(p.target || 'local') !== 'local') {
      toast('Очистка корзины работает только для local', 'info');
      return;
    }
    if (!isTrashPanel(p)) {
      toast(`Очистка корзины доступна только из ${_getTrashRoot()}`, 'info');
      return;
    }

    const ok = await (XKeen.ui && typeof XKeen.ui.confirm === 'function'
      ? XKeen.ui.confirm({
          title: 'Очистить корзину',
          message: 'Удалить ВСЕ содержимое корзины без возможности восстановления?',
          okText: 'Очистить',
          cancelText: 'Отмена',
          danger: true,
        })
      : Promise.resolve(window.confirm('Clear trash?')));

    if (!ok) return;

    try {
      const { res, data } = await fetchJson('/api/fs/trash/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: 'local' }),
      });
      if (!res || !res.ok || !data || !data.ok) {
        toast('Ошибка очистки корзины', 'error');
        return;
      }
      const n = Number(data.deleted || 0);
      toast(n ? `Корзина очищена: ${n}` : 'Корзина очищена', 'success');

      // Refresh trash view(s)
      await listPanel(side, { fromInput: true });
      try { p.selected.clear(); } catch (e) {}
      try {
        const o = otherSide(side);
        if (o && isTrashPanel(S.panels[o])) await listPanel(o, { fromInput: true });
      } catch (e) {}
    } catch (e) {
      toast('Ошибка очистки корзины', 'error');
    }
  }

  async function runDelete() {
    const side = S.activeSide;
    const p = S.panels[side];
    if (!p) return;
    if (p.target === 'remote' && !p.sid) {
      toast('Удаление: remote без сессии', 'info');
      return;
    }

    const names = getSelectionNames(side);
    if (!names.length) return;

    const inTrash = isTrashPanel(p);
    const title = inTrash ? 'Удалить навсегда' : 'В корзину';
    const okText = inTrash ? 'Удалить' : 'В корзину';
    const msg = inTrash
      ? `Удалить навсегда (${names.length})?
${names.slice(0, 6).join('\n')}${names.length > 6 ? '\n…' : ''}`
      : `Переместить в корзину (${names.length})?
${names.slice(0, 6).join('\n')}${names.length > 6 ? '\n…' : ''}`;

    const ok = await (XKeen.ui && typeof XKeen.ui.confirm === 'function'
      ? XKeen.ui.confirm({ title, message: msg, okText, cancelText: 'Отмена', danger: true })
      : Promise.resolve(window.confirm('Delete?')));

    if (!ok) return;

    const payload = buildDeletePayload(side, {});
    await executeJob(payload);

    // Optimistic UI: clear selection
    p.selected.clear();
  }

  // -------------------------- ops list modal --------------------------

  function _opsHiddenStorageKey() {
    return 'xkeen_fm_ops_hidden_jobs_v1';
  }

  function _opsEnsureHidden() {
    if (S.opsUi.hiddenIds && typeof S.opsUi.hiddenIds.has === 'function') return S.opsUi.hiddenIds;
    const set = new Set();
    try {
      const raw = localStorage.getItem(_opsHiddenStorageKey()) || '';
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) arr.forEach((x) => { if (x) set.add(String(x)); });
      }
    } catch (e) {}
    S.opsUi.hiddenIds = set;
    return set;
  }

  function _opsSaveHidden() {
    try {
      const set = _opsEnsureHidden();
      localStorage.setItem(_opsHiddenStorageKey(), JSON.stringify(Array.from(set).slice(0, 500)));
    } catch (e) {}
  }

  function _opsIsHidden(jobId) {
    try { return _opsEnsureHidden().has(String(jobId || '')); } catch (e) { return false; }
  }

  function _opsHideMany(jobIds) {
    const set = _opsEnsureHidden();
    let n = 0;
    (jobIds || []).forEach((jid) => {
      const k = String(jid || '');
      if (k && !set.has(k)) { set.add(k); n += 1; }
    });
    if (n) _opsSaveHidden();
    return n;
  }

  function _opsApplyUiFilter(jobs) {
    const filter = String((S.opsUi && S.opsUi.filter) || 'all');
    const out = [];
    (jobs || []).forEach((j) => {
      const jid = String(j && (j.job_id || '') || '');
      if (!jid) return;
      if (_opsIsHidden(jid)) return;
      const st = String(j && (j.state || '') || '').toLowerCase();
      const isActive = (st === 'running' || st === 'queued');
      const isErr = (st === 'error');
      const isFinished = (st === 'done' || st === 'canceled');

      if (filter === 'active' && !isActive) return;
      if (filter === 'errors' && !isErr) return;
      if (filter === 'finished' && !isFinished) return;
      out.push(j);
    });
    return out;
  }

  async function clearOpsHistory(scope) {
    scope = String(scope || 'history');
    // Try server-side cleanup first (preferred).
    try {
      const { res, data } = await fetchJson('/api/fileops/jobs/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope }),
      });
      if (res && res.ok && data && data.ok) {
        const n = Number(data.deleted || 0);
        toast(n ? `История очищена: ${n}` : 'История очищена', 'success');
        await refreshOpsList();
        return true;
      }
    } catch (e) {}
    return false;
  }

  function renderOpsList(jobs) {
    const box = el('fm-ops-list');
    if (!box) return;

    box.innerHTML = '';

    // Cache for re-render (filter changes).
    try { S.opsUi.lastJobs = Array.from(jobs || []); } catch (e) { S.opsUi.lastJobs = jobs || []; }

    const total = (jobs || []).length;
    const hiddenCount = (() => {
      try {
        const set = _opsEnsureHidden();
        let n = 0;
        (jobs || []).forEach((j) => { const jid = String(j && (j.job_id || '') || ''); if (jid && set.has(jid)) n += 1; });
        return n;
      } catch (e) { return 0; }
    })();

    const filtered = _opsApplyUiFilter(jobs || []);

    const summary = el('fm-ops-summary');
    if (summary) {
      const shown = filtered.length;
      summary.textContent = hiddenCount
        ? `Показано: ${shown} из ${total}. Скрыто: ${hiddenCount}.`
        : `Показано: ${shown} из ${total}.`;
    }

    const list = document.createElement('div');
    list.className = 'fm-ops-table';

    const head = document.createElement('div');
    head.className = 'fm-ops-row fm-ops-head';
    head.innerHTML = '<div>Job</div><div>Операция</div><div>Статус</div><div>Когда</div><div>Прогресс</div><div></div>';
    list.appendChild(head);

    (filtered || []).forEach((j) => {
      const row = document.createElement('div');
      row.className = 'fm-ops-row';

      const jobId = safeName(j.job_id || '');
      const op = safeName(j.op || '');
      const st = safeName(j.state || '');
      const whenTs = Number(j.started_ts || j.created_ts || 0);
      const whenText = whenTs ? _fmtWhenFromSec(whenTs) : '';
      const pr = j.progress || {};
      const filesDone = Number(pr.files_done || 0);
      const filesTotal = Number(pr.files_total || 0);
      const bytesDone = Number(pr.bytes_done || 0);
      const bytesTotal = Number(pr.bytes_total || 0);
      const pct = (bytesTotal > 0) ? Math.round((bytesDone / bytesTotal) * 100) : (filesTotal > 0 ? Math.round((filesDone / filesTotal) * 100) : 0);
      const progText = `${pct}%`;

      const btns = document.createElement('div');
      btns.style.display = 'flex';
      btns.style.gap = '8px';
      btns.style.justifyContent = 'flex-end';

      const openBtn = document.createElement('button');
      openBtn.type = 'button';
      openBtn.className = 'btn-secondary';
      openBtn.textContent = 'Открыть';
      openBtn.onclick = async () => {
        modalClose(el('fm-ops-modal'));
        modalOpen(el('fm-progress-modal'));
        // If the job is already finished, treat this as a "view" action:
        // do not re-watch the job (otherwise we get an instant toast + auto-close).
        const stLower = String(j.state || '').toLowerCase();
        const finished = (stLower === 'done' || stLower === 'error' || stLower === 'canceled');

        if (finished) {
          // Stop any previous watcher and show the last known state.
          try { closeJobWs(); } catch (e) {}
          try { _clearProgressAutoClose(); } catch (e) {}

          // Best-effort: fetch the latest snapshot from the server (in case the list is stale).
          let snapshot = j;
          try {
            const { res, data } = await fetchJson(`/api/fileops/jobs/${encodeURIComponent(jobId)}`, { method: 'GET' });
            if (res && res.ok && data && data.ok && data.job) snapshot = data.job;
          } catch (e) {}

          updateProgressModal(snapshot, { viewOnly: true });
          return;
        }

        updateProgressModal(j);
        await watchJob(jobId);
      };
      btns.appendChild(openBtn);

      if (st === 'running' || st === 'queued') {
        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'btn-secondary';
        cancelBtn.textContent = 'Отменить';
        cancelBtn.onclick = () => cancelJob(jobId);
        btns.appendChild(cancelBtn);
      }

      row.appendChild((() => { const d = document.createElement('div'); d.textContent = jobId.slice(0, 8) + (jobId.length > 8 ? '…' : ''); d.title = jobId; return d; })());
      row.appendChild((() => { const d = document.createElement('div'); d.textContent = op; return d; })());
      row.appendChild((() => { const d = document.createElement('div'); d.textContent = st; return d; })());
      row.appendChild((() => { const d = document.createElement('div'); d.textContent = whenText; return d; })());
      row.appendChild((() => { const d = document.createElement('div'); d.textContent = progText; return d; })());
      row.appendChild(btns);

      list.appendChild(row);
    });

    box.appendChild(list);
  }

  async function refreshOpsList() {
    const { res, data } = await fetchJson('/api/fileops/jobs?limit=30', { method: 'GET' });
    if (res && res.ok && data && data.ok) {
      renderOpsList(data.jobs || []);
    }
  }

  // -------------------------- init wiring --------------------------
  function wirePanel(side) {
    const pd = panelDom(side);
    const p = S.panels[side];
    if (!pd || !p) return;

    pd.root.addEventListener('click', () => setActiveSide(side));

    if (pd.targetSelect) {
      pd.targetSelect.addEventListener('change', async () => {
        const v = String(pd.targetSelect.value || 'local');
        if (v === 'remote') {
          p.target = 'remote';
          // no session => show connect
          renderPanel(side);
          if (!p.sid) {
            await connectRemoteToSide(side);
          } else {
            await listPanel(side, { fromInput: true });
          }
          return;
        }
        p.target = 'local';
        // keep cwd sane
        p.sid = '';
        if (!p.cwd) p.cwd = '/opt/var';
        await listPanel(side, { fromInput: true });
      });
    }

    if (pd.connectBtn) {
      pd.connectBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        await connectRemoteToSide(side);
      });
    }

    if (pd.disconnectBtn) {
      pd.disconnectBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        await disconnectSide(side);
      });
    }

    if (pd.upBtn) {
      pd.upBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        await goUp(side);
      });
    }

    if (pd.refreshBtn) {
      pd.refreshBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        await listPanel(side, { fromInput: true });
      });
    }

    if (pd.clearTrashBtn) {
      pd.clearTrashBtn.addEventListener('click', async (e) => {
        try { e.preventDefault(); } catch (e2) {}
        await runClearTrash(side);
      });
    }

    if (pd.pathInput) {
      pd.pathInput.addEventListener('keydown', async (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          await listPanel(side, { fromInput: true });
        }
      });
    }
    // Quick filter input (client-side, current folder only)
    let _fltTimer = null;
    const _applyFilter = () => {
      try {
        const v = String((pd.filterInput && pd.filterInput.value) || '');
        p.filter = v;
      } catch (e) {
        p.filter = '';
      }

      // Keep focus on a visible item (avoid acting on hidden-by-filter focus)
      try {
        const vis = visibleSortedItems(side);
        const focus = String(p.focusName || '');
        if (focus && !vis.some((it) => safeName(it && it.name) === focus)) {
          p.focusName = vis.length ? safeName(vis[0] && vis[0].name) : '';
          p.anchorName = p.focusName || '';
        }
      } catch (e) {}

      renderPanel(side);
    };

    if (pd.filterInput) {
      pd.filterInput.addEventListener('input', () => {
        try { if (_fltTimer) clearTimeout(_fltTimer); } catch (e) {}
        _fltTimer = setTimeout(_applyFilter, 60);
      });

      pd.filterInput.addEventListener('keydown', (e) => {
        if (!e) return;
        if (e.key === 'Escape') {
          e.preventDefault();
          try { pd.filterInput.value = ''; } catch (e2) {}
          p.filter = '';
          _applyFilter();
        }
        if (e.key === 'Enter') {
          // jump back to list
          try { e.preventDefault(); } catch (e2) {}
          try { if (pd.list) pd.list.focus(); } catch (e3) {}
        }
      });
    }

    if (pd.filterClearBtn) {
      pd.filterClearBtn.addEventListener('click', (e) => {
        try { e.preventDefault(); } catch (e2) {}
        try { if (pd.filterInput) pd.filterInput.value = ''; } catch (e3) {}
        p.filter = '';
        _applyFilter();
        try { if (pd.filterInput) pd.filterInput.focus(); } catch (e4) {}
      });
    }


    if (pd.list) {
      pd.list.addEventListener('click', async (e) => {
        const row = e.target && e.target.closest ? e.target.closest('.fm-row[data-name]') : null;
        if (!row) return;
        const name = String(row.dataset.name || '');
        setActiveSide(side);

        const p = S.panels[side];
        if (!p) return;

        const clickCheckbox = !!(e.target && e.target.closest && (e.target.closest('input.fm-check-input') || e.target.closest('.fm-cell.fm-check')));
        const isMulti = !!(e.ctrlKey || e.metaKey || clickCheckbox);
        const isShift = !!e.shiftKey;

        if (isShift) {
          if (!p.anchorName) p.anchorName = p.focusName || name;
          const anchor = p.anchorName || name;
          selectRange(side, anchor, name, isMulti);
        } else {
          if (!isMulti) {
            clearSelectionExcept(side, name);
          } else {
            if (p.selected.has(name)) p.selected.delete(name); else p.selected.add(name);
          }
          // Anchor is updated only on non-shift actions
          p.anchorName = name;
        }

        p.focusName = name;
        renderPanel(side);
        try { pd.list && pd.list.focus(); } catch (e2) {}

        // Double-click: open only on a plain row click (no Ctrl/Meta/Shift and not on checkbox).
        if (!isMulti && !isShift && !clickCheckbox && Number(e.detail || 0) >= 2) {
          await openFocused(side);
        }
      });


      // ПКМ (context menu)
      pd.list.addEventListener('contextmenu', (e) => {
        if (!e) return;
        if (!isFilesViewVisible()) return;

        try { wireCtxMenuGlobal(); } catch (e0) {}

        const row = e.target && e.target.closest ? e.target.closest('.fm-row[data-name]') : null;
        const isHeader = !!(row && row.classList && row.classList.contains('fm-row-header'));
        const name = (!row || isHeader) ? '' : String(row.dataset.name || '');
        const isDir = !!(row && row.classList && row.classList.contains('is-dir'));

        setActiveSide(side);

        // When right-clicking an item: focus it; if it's not selected, make it the only selection.
        try {
          if (name) {
            if (!p.selected.has(name)) {
              clearSelectionExcept(side, name);
              p.selected.add(name);
            }
            p.focusName = name;
            p.anchorName = name;
            renderPanel(side);
          }
        } catch (e2) {}

        try { e.preventDefault(); e.stopPropagation(); } catch (e3) {}

        showCtxMenu({
          side,
          hasRow: !!name,
          name,
          isDir,
          x: e.clientX,
          y: e.clientY,
        });
      }, true);

      // NOTE: no native dblclick handler here — see click handler above.

      pd.list.addEventListener('keydown', async (e) => {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          focusNext(side, +1);
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          focusNext(side, -1);
        } else if (e.key === 'Enter') {
          e.preventDefault();
          await openFocused(side);
        }
      });

      // Drag & Drop:
      // - OS file drop -> upload into this panel (XHR progress).
      // - FM row drag between panels -> move (Ctrl -> copy).
      const hasFiles = (dt) => {
        try {
          const types = Array.from((dt && dt.types) || []);
          if (types.includes('Files')) return true;
        } catch (e) {}
        try { return !!(dt && dt.files && dt.files.length); } catch (e) { return false; }
      };

      const hasInternalFm = (dt) => {
        try {
          const types = Array.from((dt && dt.types) || []);
          return types.includes('application/x-xkeen-fm') || types.includes('text/x-xkeen-fm');
        } catch (e) {
          return false;
        }
      };

      const getInternalFm = (dt) => {
        let raw = '';
        try { raw = dt.getData('application/x-xkeen-fm') || ''; } catch (e) {}
        if (!raw) { try { raw = dt.getData('text/x-xkeen-fm') || ''; } catch (e) {} }
        if (!raw) { try { raw = dt.getData('text/plain') || ''; } catch (e) {} }
        raw = String(raw || '');
        if (raw.startsWith('xkeen-fm:')) raw = raw.slice('xkeen-fm:'.length);
        if (!raw) return null;
        try { return JSON.parse(raw); } catch (e) { return null; }
      };

      const clearDropUi = () => {
        try { qsa('.fm-list.is-drop-target', el('fm-root')).forEach((n) => n.classList.remove('is-drop-target')); } catch (e) {}
        try { qsa('.fm-row.is-drop-target', el('fm-root')).forEach((n) => n.classList.remove('is-drop-target')); } catch (e) {}
      };

      const setDropUi = (overRow) => {
        clearDropUi();
        try { pd.list.classList.add('is-drop-target'); } catch (e) {}
        if (overRow && overRow.classList && overRow.classList.contains('is-dir')) {
          try { overRow.classList.add('is-drop-target'); } catch (e) {}
        }
      };

      // Start drag from file rows
      pd.list.addEventListener('dragstart', (e) => {
        const row = e.target && e.target.closest ? e.target.closest('.fm-row[data-name]') : null;
        if (!row || row.classList.contains('fm-row-header')) return;
        const name = String(row.dataset.name || '');
        if (!name) return;
        const p = S.panels[side];
        if (!p) return;

        // Drag selection if dragging a selected item, otherwise drag only the hovered row.
        const sel = Array.from(p.selected || []);
        const names = (sel.length && sel.indexOf(name) >= 0) ? sel : [name];

        const payload = {
          kind: 'xkeen-fm',
          v: 1,
          srcSide: side,
          src: {
            target: p.target,
            sid: (p.target === 'remote') ? (p.sid || '') : '',
            cwd: p.cwd,
          },
          names,
        };

        try { e.dataTransfer.effectAllowed = 'copyMove'; } catch (e2) {}
        try { e.dataTransfer.setData('application/x-xkeen-fm', JSON.stringify(payload)); } catch (e2) {}
        try { e.dataTransfer.setData('text/x-xkeen-fm', JSON.stringify(payload)); } catch (e2) {}
        try { e.dataTransfer.setData('text/plain', 'xkeen-fm:' + JSON.stringify(payload)); } catch (e2) {}
        try { setActiveSide(side); } catch (e2) {}
      });

      pd.list.addEventListener('dragend', () => {
        clearDropUi();
      });

      pd.list.addEventListener('dragover', (e) => {
        if (!e || !e.dataTransfer) return;

        // OS file upload drop
        if (hasFiles(e.dataTransfer)) {
          e.preventDefault();
          return;
        }

        // Internal FM DnD
        if (!hasInternalFm(e.dataTransfer)) return;
        e.preventDefault();
        try { e.dataTransfer.dropEffect = e.ctrlKey ? 'copy' : 'move'; } catch (e2) {}

        const overRow = e.target && e.target.closest ? e.target.closest('.fm-row.is-dir[data-name]') : null;
        setDropUi(overRow);
      });

      pd.list.addEventListener('dragleave', (e) => {
        // Clear highlight when leaving list area
        try {
          const rt = e.relatedTarget;
          if (!rt || (rt !== pd.list && !pd.list.contains(rt))) clearDropUi();
        } catch (e2) {
          clearDropUi();
        }
      });

      pd.list.addEventListener('drop', async (e) => {
        if (!e || !e.dataTransfer) return;

        // Internal FM DnD
        if (hasInternalFm(e.dataTransfer) && !hasFiles(e.dataTransfer)) {
          e.preventDefault();
          clearDropUi();

          const drag = getInternalFm(e.dataTransfer);
          if (!drag || !Array.isArray(drag.names) || !drag.names.length) return;

          const srcSide = String(drag.srcSide || '');
          const dstSide = side;
          if (srcSide !== 'left' && srcSide !== 'right') return;

          const srcPanel = S.panels[srcSide];
          const dstPanel = S.panels[dstSide];
          if (!srcPanel || !dstPanel) return;

          const srcInfo = drag.src || {};
          const srcTarget = String(srcInfo.target || srcPanel.target || '');
          const srcSid = String(srcInfo.sid || (srcPanel.target === 'remote' ? srcPanel.sid : '') || '');
          const srcCwd = (srcInfo.cwd != null) ? String(srcInfo.cwd) : String(srcPanel.cwd || '');

          // Validate remote sessions
          if (srcTarget === 'remote' && !srcSid) {
            toast('Источник: remote без сессии', 'info');
            return;
          }
          if (dstPanel.target === 'remote' && !dstPanel.sid) {
            toast('Назначение: remote без сессии', 'info');
            return;
          }

          // Destination dir: panel cwd; if dropped onto a directory row -> that directory.
          let dstPath = String(dstPanel.cwd || '');
          const dropRow = e.target && e.target.closest ? e.target.closest('.fm-row.is-dir[data-name]') : null;
          if (dropRow) {
            const dn = String(dropRow.dataset.name || '');
            if (dn) {
              dstPath = (dstPanel.target === 'remote') ? joinRemote(dstPanel.cwd, dn) : joinLocal(dstPanel.cwd, dn);
            }
          }

          const names = Array.from(drag.names || []).map((x) => safeName(x)).filter((x) => !!x);

          const srcItems = Array.from((srcPanel.items || []));
          const sources = names.map((n) => {
            const it = srcItems.find((x) => safeName(x && x.name) === n) || null;
            const t = String((it && it.type) || '');
            const isDir = (t === 'dir') || (t === 'link' && !!(it && it.link_dir));
            const abs = (srcTarget === 'remote') ? joinRemote(srcCwd, n) : joinLocal(srcCwd, n);
            return { path: abs, name: n, is_dir: !!isDir };
          });

          const defaultOp = e.ctrlKey ? 'copy' : 'move';

          // Ask user what to do (Move or Copy) — this is more reliable than Ctrl on some browsers/devices.
          const srcLabel = _panelLabel(srcSide, srcTarget, srcSid, srcCwd);
          const dstLabel = _panelLabel(dstSide, dstPanel.target, (dstPanel.target === 'remote') ? dstPanel.sid : '', dstPath);
          const chosenOp = await openDropOpModal({ defaultOp, names, srcLabel, dstLabel });
          if (!chosenOp) return;
          const op = chosenOp;

          // Safety: prevent pointless move/copy into the same folder when dropping onto panel background.
          try {
            const sameLocalDir = (srcTarget === 'local' && dstPanel.target === 'local'
              && _trimSlashes(String(srcCwd || '')) === _trimSlashes(String(dstPath || '')));
            const sameRemoteDir = (srcTarget === 'remote' && dstPanel.target === 'remote'
              && String(srcSid || '') === String(dstPanel.sid || '')
              && normRemotePath(String(srcCwd || '')) === normRemotePath(String(dstPath || '')));
            if (sameLocalDir || sameRemoteDir) {
              if (op === 'move') toast('Источник и назначение совпадают (move — нечего делать)', 'info');
              else toast('Копирование в тот же каталог через Drag&Drop не поддерживается. Выберите другой каталог назначения или используйте F5.', 'info');
              return;
            }
          } catch (e2) {}

          const payload = {
            op,
            src: {
              target: srcTarget,
              sid: (srcTarget === 'remote') ? srcSid : undefined,
              cwd: srcCwd,
              paths: names,
            },
            dst: {
              target: dstPanel.target,
              sid: (dstPanel.target === 'remote') ? dstPanel.sid : undefined,
              path: dstPath,
              is_dir: true,
            },
            sources,
            options: { overwrite: 'ask' },
          };

          await runCopyMoveWithPayload(op, payload);
          return;
        }

        // OS file drop -> upload into this panel (XHR progress).
        if (!hasFiles(e.dataTransfer)) return;
        e.preventDefault();
        const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
        if (!files.length) return;
        xhrUploadFiles({ side, files });
      });

    }
  }

  // -------------------------- create folder / empty file --------------------------
  function _leafName(p) {
    const s = String(p == null ? '' : p).replace(/\\/g, '/').replace(/\/+$/, '');
    if (!s) return '';
    const parts = s.split('/').filter(Boolean);
    return parts.length ? parts[parts.length - 1] : '';
  }

  function _displayCwd(panel) {
    if (!panel) return '';
    if (panel.target === 'remote') {
      const v = String(panel.cwd || '').trim();
      return (!v || v === '.') ? '~' : v;
    }
    return String(panel.cwd || '');
  }

  function _calcCreatePath(panel, name) {
    const nm = String(name || '').trim();
    if (!nm) return '';
    if (panel && panel.target === 'remote') {
      // allow absolute remote paths
      return nm.startsWith('/') ? normRemotePath(nm) : joinRemote(panel.cwd, nm);
    }
    // local
    return nm.startsWith('/') ? nm : joinLocal(panel ? panel.cwd : '', nm);
  }

  function openCreateModal(kind) {
    const modal = el('fm-create-modal');
    if (!modal) return;

    const side = S.activeSide;
    const p = S.panels[side];
    if (!p) return;

    S.create = { kind: String(kind || ''), side };

    const title = el('fm-create-title');
    const ok = el('fm-create-ok-btn');
    const nameInput = el('fm-create-name');
    const dest = el('fm-create-dest');
    const err = el('fm-create-error');
    const parents = el('fm-create-parents');
    const createOnlyRow = el('fm-create-createonly-row');
    const createOnly = el('fm-create-createonly');

    if (err) err.textContent = '';
    if (nameInput) {
      try { nameInput.value = ''; } catch (e) {}
      nameInput.placeholder = (kind === 'dir') ? 'new-folder' : 'example.txt';
    }

    if (title) title.textContent = (kind === 'dir') ? 'Создать папку' : 'Создать файл';
    if (ok) ok.textContent = 'Создать';

    // parents checkbox is helpful for nested paths in both cases.
    if (parents) {
      parents.checked = true;
    }

    // create_only only makes sense for files.
    if (createOnlyRow) {
      if (kind === 'file') show(createOnlyRow); else hide(createOnlyRow);
    }
    if (createOnly) {
      createOnly.checked = true;
    }

    if (dest) {
      const tgt = String(p.target || 'local');
      dest.textContent = `${side.toUpperCase()} • ${tgt} • ${_displayCwd(p)}`;
    }

    modalOpen(modal);
    try { setTimeout(() => { try { nameInput && nameInput.focus(); } catch (e) {} }, 0); } catch (e) {}
  }

  function closeCreateModal() {
    modalClose(el('fm-create-modal'));
  }

  // -------------------------- rename (file / folder) --------------------------
  function _isBadLeafName(n) {
    const s = String(n || '').trim();
    if (!s) return true;
    if (s === '.' || s === '..') return true;
    // For rename we only allow leaf names (no path separators)
    if (s.includes('/') || s.includes('\\')) return true;
    return false;
  }

  function _guessSelectRange(name, isDir) {
    const s = String(name || '');
    if (!s) return [0, 0];
    if (isDir) return [0, s.length];
    const dot = s.lastIndexOf('.');
    if (dot > 0 && dot < s.length - 1) return [0, dot];
    return [0, s.length];
  }

  function openRenameModal() {
    const modal = el('fm-rename-modal');
    if (!modal) return;

    const side = S.activeSide;
    const p = S.panels[side];
    if (!p) return;

    const names = getSelectionNames(side);
    if (names.length !== 1) {
      toast('Для переименования выберите один файл или папку', 'info');
      return;
    }

    const oldName = safeName(names[0]);
    const it = (p.items || []).find((x) => safeName(x && x.name) === oldName) || null;
    const type = String((it && it.type) || '');
    const isDir = (type === 'dir') || (type === 'link' && !!(it && it.link_dir));

    S.rename = { side, oldName };

    const title = el('fm-rename-title');
    const ok = el('fm-rename-ok-btn');
    const input = el('fm-rename-name');
    const srcEl = el('fm-rename-src');
    const err = el('fm-rename-error');

    if (err) err.textContent = '';
    if (title) title.textContent = isDir ? 'Переименовать папку' : 'Переименовать файл';
    if (ok) ok.textContent = 'Переименовать';

    if (input) {
      try { input.value = oldName; } catch (e) {}
      try { input.setAttribute('spellcheck', 'false'); } catch (e) {}
    }

    if (srcEl) {
      const tgt = String(p.target || 'local');
      const full = (tgt === 'remote') ? joinRemote(p.cwd, oldName) : joinLocal(p.cwd, oldName);
      srcEl.textContent = `${side.toUpperCase()} • ${tgt}${(tgt === 'remote' && p.sid) ? ' (' + p.sid + ')' : ''} • ${full}`;
    }

    modalOpen(modal);

    try {
      setTimeout(() => {
        try {
          if (input && input.focus) input.focus();
          const [a, b] = _guessSelectRange(oldName, isDir);
          if (input && input.setSelectionRange) input.setSelectionRange(a, b);
        } catch (e) {}
      }, 0);
    } catch (e) {}
  }

  function closeRenameModal() {
    modalClose(el('fm-rename-modal'));
  }

  async function doRenameFromModal() {
    const modal = el('fm-rename-modal');
    if (!modal) return;

    const err = el('fm-rename-error');
    if (err) err.textContent = '';

    const side = String((S.rename && S.rename.side) || S.activeSide || 'left');
    const oldName = safeName((S.rename && S.rename.oldName) || '');
    const p = S.panels[side];
    if (!p || !oldName) return;

    const input = el('fm-rename-name');
    const newName = String((input && input.value) || '').trim();

    if (_isBadLeafName(newName)) {
      if (err) err.textContent = 'Введите корректное имя (без "/" и "\\").';
      return;
    }

    if (newName === oldName) {
      closeRenameModal();
      return;
    }

    // Basic collision check in current listing (prevents accidental overwrite).
    try {
      const existing = new Set((p.items || []).map((it) => safeName(it && it.name)));
      if (existing.has(newName)) {
        if (err) err.textContent = 'Такое имя уже существует в текущем каталоге.';
        return;
      }
    } catch (e) {}

    if (p.target === 'remote' && !p.sid) {
      toast('Remote: нет активной сессии (Connect…)', 'info');
      return;
    }

    const srcPath = (p.target === 'remote') ? joinRemote(p.cwd, oldName) : joinLocal(p.cwd, oldName);
    const dstPath = (p.target === 'remote') ? joinRemote(p.cwd, newName) : joinLocal(p.cwd, newName);

    const body = { target: p.target, src: srcPath, dst: dstPath };
    if (p.target === 'remote') body.sid = p.sid;

    const { res, data } = await fetchJson('/api/fs/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res || !res.ok || !data || !data.ok) {
      const msg = data && (data.error || data.message) ? String(data.error || data.message) : 'rename_failed';
      if (err) err.textContent = msg;
      toast('FM: ' + msg, 'error');
      return;
    }

    toast('Переименовано: ' + oldName + ' → ' + newName, 'success');

    // Refresh and focus new name
    try {
      p.focusName = newName;
      p.selected.clear();
      p.selected.add(newName);
      p.anchorName = newName;
    } catch (e) {}

    await listPanel(side, { fromInput: false });
    closeRenameModal();
  }

  

  // -------------------------- chmod / chown --------------------------
  function _fsAdminCaps(panel) {
    try {
      const rf = (S.caps && S.caps.remoteFs) ? S.caps.remoteFs : null;
      const fa = (rf && rf.fs_admin) ? rf.fs_admin : null;
      if (!panel) return null;
      return (panel.target === 'remote') ? (fa && fa.remote) : (fa && fa.local);
    } catch (e) {
      return null;
    }
  }

  function _parsePermStringToMode(permStr) {
    // permStr examples: -rw-r--r--, drwxr-xr-x+, lrwxrwxrwx
    let s = String(permStr || '').trim();
    if (!s) return null;
    // drop ACL markers
    s = s.replace(/[@+\.]$/, '');
    if (s.length < 10) return null;
    const p = s.slice(1, 10);
    const tri = [p.slice(0, 3), p.slice(3, 6), p.slice(6, 9)];

    function digit(t) {
      const r = t[0] === 'r' ? 4 : 0;
      const w = t[1] === 'w' ? 2 : 0;
      const xch = t[2];
      const x = (xch === 'x' || xch === 's' || xch === 't') ? 1 : 0;
      return r + w + x;
    }

    const u = digit(tri[0]);
    const g = digit(tri[1]);
    const o = digit(tri[2]);

    const suid = (tri[0][2] === 's' || tri[0][2] === 'S') ? 4 : 0;
    const sgid = (tri[1][2] === 's' || tri[1][2] === 'S') ? 2 : 0;
    const sticky = (tri[2][2] === 't' || tri[2][2] === 'T') ? 1 : 0;
    const sp = suid + sgid + sticky;

    const modeStr = (sp ? String(sp) : '') + String(u) + String(g) + String(o);
    return modeStr;
  }

  function _parseModeInputToParts(modeStr) {
    const raw = String(modeStr || '').trim().toLowerCase();
    if (!raw) return null;
    let s = raw;
    if (s.startsWith('0o')) s = s.slice(2);
    if (s.startsWith('0') && s.length > 1) {
      // keep leading zero only if it makes 4 digits like 0755
      // in practice, 0755 -> 755 (octal)
      while (s.length > 1 && s[0] === '0') s = s.slice(1);
    }
    if (!/^[0-7]{3,4}$/.test(s)) return null;
    const sp = (s.length === 4) ? s[0] : '0';
    const last3 = (s.length === 4) ? s.slice(1) : s;
    return { sp, last3, norm: (sp !== '0' ? sp : '') + last3 };
  }

  function _chmodSetChecksFromLast3(last3) {
    const d = String(last3 || '000');
    if (!/^[0-7]{3}$/.test(d)) return;
    const u = parseInt(d[0], 8);
    const g = parseInt(d[1], 8);
    const o = parseInt(d[2], 8);

    const set = (id, on) => {
      const x = el(id);
      if (x) x.checked = !!on;
    };

    set('fm-perm-ur', !!(u & 4));
    set('fm-perm-uw', !!(u & 2));
    set('fm-perm-ux', !!(u & 1));

    set('fm-perm-gr', !!(g & 4));
    set('fm-perm-gw', !!(g & 2));
    set('fm-perm-gx', !!(g & 1));

    set('fm-perm-or', !!(o & 4));
    set('fm-perm-ow', !!(o & 2));
    set('fm-perm-ox', !!(o & 1));
  }

  function _chmodGetLast3FromChecks() {
    const get = (id) => {
      const x = el(id);
      return !!(x && x.checked);
    };

    const u = (get('fm-perm-ur') ? 4 : 0) + (get('fm-perm-uw') ? 2 : 0) + (get('fm-perm-ux') ? 1 : 0);
    const g = (get('fm-perm-gr') ? 4 : 0) + (get('fm-perm-gw') ? 2 : 0) + (get('fm-perm-gx') ? 1 : 0);
    const o = (get('fm-perm-or') ? 4 : 0) + (get('fm-perm-ow') ? 2 : 0) + (get('fm-perm-ox') ? 1 : 0);

    return '' + u + g + o;
  }

  function _chmodSyncFromModeInput() {
    const inp = el('fm-chmod-mode');
    if (!inp) return;
    const parts = _parseModeInputToParts(inp.value);
    if (!parts) return;
    try { if (!S.chmod) S.chmod = {}; } catch (e) {}
    try { S.chmod.sp = parts.sp; } catch (e) {}
    _chmodSetChecksFromLast3(parts.last3);
  }

  function _chmodSyncToModeInput() {
    const inp = el('fm-chmod-mode');
    if (!inp) return;
    const last3 = _chmodGetLast3FromChecks();
    let sp = '0';
    try { sp = String((S.chmod && S.chmod.sp) || '0'); } catch (e) { sp = '0'; }
    if (!/^[0-7]$/.test(sp)) sp = '0';
    const val = (sp !== '0' ? (sp + last3) : last3);
    try { inp.value = val; } catch (e) {}
  }

  function _fmtPanelLabel(side) {
    const p = S.panels[side];
    const tgt = String(p.target || 'local');
    const sid = (tgt === 'remote' && p.sid) ? ` (${p.sid})` : '';
    const cwd = (tgt === 'remote') ? (String(p.cwd || '').trim() || '.') : String(p.cwd || '');
    return `${side.toUpperCase()} • ${tgt}${sid} • ${cwd}`;
  }

  function openChmodModal() {
    const modal = el('fm-chmod-modal');
    if (!modal) return;
    const side = S.activeSide;
    const p = S.panels[side];
    if (!p) return;

    const caps = _fsAdminCaps(p) || {};
    if (caps && caps.chmod === false) {
      toast('chmod недоступен', 'info');
      return;
    }

    const names = getSelectionNames(side);
    if (!names.length) {
      toast('Выберите файл/папку', 'info');
      return;
    }
    if (p.target === 'remote' && !p.sid) {
      toast('Remote: нет активной сессии (Connect…)', 'info');
      return;
    }

    // store context
    try {
      S.chmod = { side, names: Array.from(names), sp: '0' };
    } catch (e) {
      S.chmod = { side, names: Array.from(names) };
    }

    // title/source
    const src = el('fm-chmod-src');
    if (src) src.textContent = _fmtPanelLabel(side);

    const listEl = el('fm-chmod-list');
    if (listEl) {
      const shown = names.slice(0, 20);
      listEl.textContent = shown.join('\n') + (names.length > 20 ? '\n…' : '');
    }

    const err = el('fm-chmod-error');
    if (err) err.textContent = '';

    // Try prefill mode from permissions if all selected have same perm.
    let preMode = '';
    try {
      const items = Array.from(p.items || []);
      const perms = names.map((n) => {
        const it = items.find((x) => safeName(x && x.name) === n);
        return safeName(it && it.perm);
      }).filter((x) => !!x);
      if (perms.length === names.length) {
        const first = perms[0];
        if (perms.every((x) => x === first)) {
          const parsed = _parsePermStringToMode(first);
          if (parsed) preMode = parsed;
        }
      }
    } catch (e) {}

    const modeInp = el('fm-chmod-mode');
    if (modeInp) {
      try { modeInp.value = preMode || ''; } catch (e) {}
    }

    // sync checkboxes
    try {
      const parts = _parseModeInputToParts(preMode || '');
      if (parts) {
        try { S.chmod.sp = parts.sp; } catch (e) {}
        _chmodSetChecksFromLast3(parts.last3);
      } else {
        try { S.chmod.sp = '0'; } catch (e) {}
        _chmodSetChecksFromLast3('000');
      }
    } catch (e) {}

    modalOpen(modal);
    try { setTimeout(() => { try { modeInp && modeInp.focus(); } catch (e) {} }, 0); } catch (e) {}
  }

  function closeChmodModal() {
    modalClose(el('fm-chmod-modal'));
  }

  async function doChmodFromModal() {
    const modal = el('fm-chmod-modal');
    if (!modal) return;

    const errEl = el('fm-chmod-error');
    if (errEl) errEl.textContent = '';

    const side = String((S.chmod && S.chmod.side) || S.activeSide || 'left');
    const p = S.panels[side];
    if (!p) return;
    const names = Array.isArray(S.chmod && S.chmod.names) ? S.chmod.names : getSelectionNames(side);

    const modeInp = el('fm-chmod-mode');
    const modeRaw = String((modeInp && modeInp.value) || '').trim();
    const parts = _parseModeInputToParts(modeRaw);
    if (!parts) {
      if (errEl) errEl.textContent = 'Введите mode (например 755).';
      return;
    }

    // Optional confirm for big batches
    if (names.length >= 8) {
      const ok = await (XKeen.ui && typeof XKeen.ui.confirm === 'function'
        ? XKeen.ui.confirm({
          title: 'chmod',
          message: `Применить chmod ${parts.norm} к ${names.length} элементам?`,
          okText: 'Применить',
          cancelText: 'Отмена',
          danger: false,
        })
        : Promise.resolve(window.confirm(`chmod ${parts.norm} для ${names.length} элементов?`)));
      if (!ok) return;
    }

    if (p.target === 'remote' && !p.sid) {
      toast('Remote: нет активной сессии (Connect…)', 'info');
      return;
    }

    for (const n of names) {
      const path = (p.target === 'remote') ? joinRemote(p.cwd, n) : joinLocal(p.cwd, n);
      const body = { target: p.target, path, mode: parts.norm };
      if (p.target === 'remote') body.sid = p.sid;
      const { res, data } = await fetchJson('/api/fs/chmod', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res || !res.ok || !data || !data.ok) {
        const msg = data && (data.error || data.message) ? String(data.error || data.message) : 'chmod_failed';
        const details = data && data.details ? String(data.details) : '';
        if (errEl) errEl.textContent = details ? (msg + ': ' + details) : msg;
        toast('FM: ' + msg, 'error');
        return;
      }
    }

    toast('chmod применён', 'success');
    await listPanel(side, { fromInput: false });
    closeChmodModal();
  }

  function openChownModal() {
    const modal = el('fm-chown-modal');
    if (!modal) return;
    const side = S.activeSide;
    const p = S.panels[side];
    if (!p) return;

    const caps = _fsAdminCaps(p) || {};
    if (caps && caps.chown === false) {
      toast('chown недоступен', 'info');
      return;
    }
    // Remote: only SFTP
    if (p.target === 'remote') {
      const protos = Array.isArray(caps.chown_protocols) ? caps.chown_protocols.map((x) => String(x).trim().toLowerCase()) : ['sftp'];
      const rproto = String((p.rproto || '')).toLowerCase();
      if (rproto && !protos.includes(rproto)) {
        toast('chown доступен только для SFTP', 'info');
        return;
      }
    }

    const names = getSelectionNames(side);
    if (!names.length) {
      toast('Выберите файл/папку', 'info');
      return;
    }
    if (p.target === 'remote' && !p.sid) {
      toast('Remote: нет активной сессии (Connect…)', 'info');
      return;
    }

    try { S.chown = { side, names: Array.from(names) }; } catch (e) { S.chown = { side, names: Array.from(names) }; }

    const src = el('fm-chown-src');
    if (src) src.textContent = _fmtPanelLabel(side);

    const listEl = el('fm-chown-list');
    if (listEl) {
      const shown = names.slice(0, 20);
      listEl.textContent = shown.join('\n') + (names.length > 20 ? '\n…' : '');
    }

    const err = el('fm-chown-error');
    if (err) err.textContent = '';

    const uidInp = el('fm-chown-uid');
    const gidInp = el('fm-chown-gid');
    if (uidInp) { try { uidInp.value = ''; } catch (e) {} }
    if (gidInp) { try { gidInp.value = ''; } catch (e) {} }

    modalOpen(modal);
    try { setTimeout(() => { try { uidInp && uidInp.focus(); } catch (e) {} }, 0); } catch (e) {}
  }

  function closeChownModal() {
    modalClose(el('fm-chown-modal'));
  }

  async function doChownFromModal() {
    const modal = el('fm-chown-modal');
    if (!modal) return;

    const errEl = el('fm-chown-error');
    if (errEl) errEl.textContent = '';

    const side = String((S.chown && S.chown.side) || S.activeSide || 'left');
    const p = S.panels[side];
    if (!p) return;

    const names = Array.isArray(S.chown && S.chown.names) ? S.chown.names : getSelectionNames(side);

    const uidRaw = String((el('fm-chown-uid') && el('fm-chown-uid').value) || '').trim();
    const gidRaw = String((el('fm-chown-gid') && el('fm-chown-gid').value) || '').trim();

    if (!uidRaw || !/^\d+$/.test(uidRaw)) {
      if (errEl) errEl.textContent = 'Введите UID (число).';
      return;
    }
    if (gidRaw && !/^\d+$/.test(gidRaw)) {
      if (errEl) errEl.textContent = 'GID должен быть числом или пустым.';
      return;
    }

    // Remote support check
    if (p.target === 'remote') {
      const rproto = String((p.rproto || '')).toLowerCase();
      if (rproto && rproto !== 'sftp') {
        if (errEl) errEl.textContent = 'Remote chown поддерживается только для SFTP.';
        return;
      }
      if (!p.sid) {
        toast('Remote: нет активной сессии (Connect…)', 'info');
        return;
      }
    }

    if (names.length >= 8) {
      const ok = await (XKeen.ui && typeof XKeen.ui.confirm === 'function'
        ? XKeen.ui.confirm({
          title: 'chown',
          message: `Применить chown ${uidRaw}${gidRaw ? ':' + gidRaw : ''} к ${names.length} элементам?`,
          okText: 'Применить',
          cancelText: 'Отмена',
          danger: true,
        })
        : Promise.resolve(window.confirm(`chown ${uidRaw}${gidRaw ? ':' + gidRaw : ''} для ${names.length} элементов?`)));
      if (!ok) return;
    }

    for (const n of names) {
      const path = (p.target === 'remote') ? joinRemote(p.cwd, n) : joinLocal(p.cwd, n);
      const body = { target: p.target, path, uid: parseInt(uidRaw, 10) };
      if (gidRaw) body.gid = parseInt(gidRaw, 10);
      else body.gid = null; // do not change
      if (p.target === 'remote') body.sid = p.sid;

      const { res, data } = await fetchJson('/api/fs/chown', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res || !res.ok || !data || !data.ok) {
        const msg = data && (data.error || data.message) ? String(data.error || data.message) : 'chown_failed';
        const details = data && data.details ? String(data.details) : '';
        if (errEl) errEl.textContent = details ? (msg + ': ' + details) : msg;
        toast('FM: ' + msg, 'error');
        return;
      }
    }

    toast('chown применён', 'success');
    await listPanel(side, { fromInput: false });
    closeChownModal();
  }
// -------------------------- Drag&Drop: choose Move or Copy --------------------------
  function _panelLabel(side, target, sid, path) {
    const s = String(side || '').toUpperCase();
    const t = String(target || 'local');
    const r = (t === 'remote' && sid) ? ` (${sid})` : '';
    const p = String(path || '');
    return `${s} • ${t}${r} • ${p}`;
  }

  function _setDropOpButtonsDefault(defaultOp) {
    const copyBtn = el('fm-dropop-copy-btn');
    const moveBtn = el('fm-dropop-move-btn');
    if (!copyBtn || !moveBtn) return;
    const op = String(defaultOp || 'move').toLowerCase();
    if (op === 'copy') {
      try { copyBtn.classList.add('btn-primary'); copyBtn.classList.remove('btn-secondary'); } catch (e) {}
      try { moveBtn.classList.add('btn-secondary'); moveBtn.classList.remove('btn-primary'); } catch (e) {}
    } else {
      try { moveBtn.classList.add('btn-primary'); moveBtn.classList.remove('btn-secondary'); } catch (e) {}
      try { copyBtn.classList.add('btn-secondary'); copyBtn.classList.remove('btn-primary'); } catch (e) {}
    }
  }

  function closeDropOpModal(result) {
    const modal = el('fm-dropop-modal');
    try { modalClose(modal); } catch (e) {}
    const r = S.dropOp && S.dropOp.resolve;
    try { if (S.dropOp) S.dropOp.resolve = null; } catch (e) {}
    if (typeof r === 'function') {
      try { r(result); } catch (e) {}
    }
  }

  function openDropOpModal(opts) {
    const o = opts || {};
    const modal = el('fm-dropop-modal');
    const defaultOp = String(o.defaultOp || 'move').toLowerCase() === 'copy' ? 'copy' : 'move';
    if (!modal) return Promise.resolve(defaultOp);

    // Cancel previous pending choice (if any)
    try { if (S.dropOp && typeof S.dropOp.resolve === 'function') S.dropOp.resolve(null); } catch (e) {}

    const names = Array.isArray(o.names) ? o.names : [];
    const srcLabel = String(o.srcLabel || '');
    const dstLabel = String(o.dstLabel || '');

    const textEl = el('fm-dropop-text');
    const listEl = el('fm-dropop-list');

    if (textEl) {
      try { textEl.style.whiteSpace = 'pre-wrap'; } catch (e) {}
      const n = names.length;
      const head = n === 1 ? '1 элемент' : `${n} элементов`;
      textEl.textContent = `Источник: ${srcLabel}
Назначение: ${dstLabel}
Действие для ${head}?`;
    }

    if (listEl) {
      const showN = 12;
      const shown = names.slice(0, showN);
      listEl.textContent = shown.join('\n') + (names.length > showN ? '\n…' : '');
    }

    _setDropOpButtonsDefault(defaultOp);

    return new Promise((resolve) => {
      try { if (S.dropOp) S.dropOp.resolve = resolve; } catch (e) {}
      modalOpen(modal);
      // Focus default button
      try {
        setTimeout(() => {
          const b = (defaultOp === 'copy') ? el('fm-dropop-copy-btn') : el('fm-dropop-move-btn');
          b && b.focus && b.focus();
        }, 0);
      } catch (e) {}
    });
  }

  async function doCreateFromModal() {
    const modal = el('fm-create-modal');
    if (!modal) return;
    const err = el('fm-create-error');
    if (err) err.textContent = '';

    const kind = String((S.create && S.create.kind) || '');
    const side = String((S.create && S.create.side) || S.activeSide);
    const p = S.panels[side];
    if (!p) return;

    const name = String((el('fm-create-name') && el('fm-create-name').value) || '').trim();
    if (!name || name === '.' || name === '..') {
      if (err) err.textContent = 'Введите корректное имя.';
      return;
    }
    if (kind === 'file' && /\/$/.test(name)) {
      if (err) err.textContent = 'Для файла не используйте завершающий "/".';
      return;
    }

    // Remote requires session.
    if (p.target === 'remote' && !p.sid) {
      toast('Remote: нет активной сессии (Connect…) ', 'info');
      return;
    }

    const parents = !!(el('fm-create-parents') && el('fm-create-parents').checked);
    const createOnly = !!(el('fm-create-createonly') && el('fm-create-createonly').checked);
    const fullPath = _calcCreatePath(p, name);
    if (!fullPath) {
      if (err) err.textContent = 'Не удалось построить путь.';
      return;
    }

    if (kind === 'dir') {
      const body = { target: p.target, path: fullPath, parents };
      if (p.target === 'remote') body.sid = p.sid;
      const { res, data } = await fetchJson('/api/fs/mkdir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res || !res.ok || !data || !data.ok) {
        const msg = data && (data.error || data.message) ? String(data.error || data.message) : 'mkdir_failed';
        if (err) err.textContent = msg;
        toast('FM: ' + msg, 'error');
        return;
      }
      toast('Папка создана: ' + _leafName(name), 'success');
      // Refresh and focus
      p.focusName = _leafName(name);
      await listPanel(side, { fromInput: false });
      closeCreateModal();
      return;
    }

    // file
    const body = { target: p.target, path: fullPath, parents, create_only: createOnly };
    if (p.target === 'remote') body.sid = p.sid;
    const { res, data } = await fetchJson('/api/fs/touch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res || !res.ok || !data || !data.ok) {
      const msg = data && (data.error || data.message) ? String(data.error || data.message) : 'touch_failed';
      if (err) err.textContent = msg;
      toast('FM: ' + msg, 'error');
      return;
    }
    if (data && data.skipped) {
      toast('Файл уже существует: ' + _leafName(name), 'info');
    } else {
      toast('Файл создан: ' + _leafName(name), 'success');
    }
    p.focusName = _leafName(name);
    await listPanel(side, { fromInput: false });
    closeCreateModal();
  }

  function wireModals() {
    // editor modal buttons
    wireEditorModal();

    // connect modal buttons
    const connectOk = el('fm-connect-ok-btn');
    const connectCancel = el('fm-connect-cancel-btn');
    const connectClose = el('fm-connect-close-btn');
    const profileSel = el('fm-conn-profile');
    const profileDelBtn = el('fm-conn-profile-del-btn');
    const protoSel = el('fm-proto');
    const authTypeSel = el('fm-auth-type');
    const hostInp = el('fm-host');
    const portInp = el('fm-port');
    const khBtn = el('fm-knownhosts-btn');
    const hkRemoveBtn = el('fm-hostkey-remove-btn');
    const rememberCb = el('fm-remember-profile');

    const closeConnect = () => {
      modalClose(el('fm-connect-modal'));

      // UX fix:
      // When a user switches a panel to "remote", we open the connect dialog.
      // If they cancel/close it (changed their mind), roll the panel back to "local"
      // so the target selector doesn't get stuck on "remote".
      try {
        const side = String(S && S.connectForSide ? S.connectForSide : '');
        const p = (S && S.panels) ? S.panels[side] : null;
        if (p && String(p.target || '') === 'remote' && !String(p.sid || '')) {
          p.target = 'local';
          p.sid = '';
          // Keep current local cwd; if missing, choose a sensible default per side.
          if (!p.cwd) p.cwd = (side === 'right') ? '/tmp/mnt' : '/opt/var';
          try { renderPanel(side); } catch (e) {}
          // Best-effort refresh to restore local listing if remote mode cleared it.
          setTimeout(() => {
            try { listPanel(side, { fromInput: false }); } catch (e) {}
          }, 0);
        }
      } catch (e) {}
    };

    if (connectOk) connectOk.addEventListener('click', (e) => { e.preventDefault(); doConnect(); });
    if (connectCancel) connectCancel.addEventListener('click', (e) => { e.preventDefault(); closeConnect(); });
    if (connectClose) connectClose.addEventListener('click', (e) => { e.preventDefault(); closeConnect(); });

    const modal = el('fm-connect-modal');
    if (modal) {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) closeConnect();
      });
    }

    // Dynamic connect UI toggles
    const scheduleFp = (() => {
      let t = null;
      return () => {
        try { if (t) clearTimeout(t); } catch (e) {}
        t = setTimeout(() => { try { updateHostKeyFingerprintPreview(); } catch (e2) {} }, 250);
      };
    })();

    if (protoSel) protoSel.addEventListener('change', () => { try { updateConnectAuthUi(); } catch (e) {} scheduleFp(); });
    if (authTypeSel) authTypeSel.addEventListener('change', () => { try { updateConnectAuthUi(); } catch (e) {} });
    if (hostInp) hostInp.addEventListener('input', () => scheduleFp());
    if (portInp) portInp.addEventListener('input', () => scheduleFp());
    if (khBtn) khBtn.addEventListener('click', (e) => { e.preventDefault(); openKnownHostsModal(); });
    if (hkRemoveBtn) hkRemoveBtn.addEventListener('click', (e) => { e.preventDefault(); removeHostKeyForCurrentHost(); });
    if (rememberCb) rememberCb.addEventListener('change', () => {
      try { _saveRememberProfileFlag(!!rememberCb.checked); } catch (e) {}
    });

    // Connection profiles
    if (profileSel) profileSel.addEventListener('change', () => {
      const id = String(profileSel.value || '').trim();
      try { if (profileDelBtn) profileDelBtn.disabled = !id; } catch (e) {}
      if (!id) return;
      try {
        const pr = _findRemoteProfileById(id);
        if (pr) {
          _applyProfileToConnectInputs(pr);
          _lsSetJson(_LS_REMOTE_PROFILES_LAST_KEY, id);
        }
      } catch (e) {}
    });
    if (profileDelBtn) profileDelBtn.addEventListener('click', (e) => {
      e.preventDefault();
      const sel = el('fm-conn-profile');
      const id = sel ? String(sel.value || '').trim() : '';
      if (!id) return;
      try {
        const list = _loadRemoteProfiles();
        const next = list.filter(p => String(p && p.id) !== id);
        _saveRemoteProfiles(next);
        // if deleting last-used profile, clear last marker
        const lastId = _loadLastProfileId();
        if (String(lastId || '') === id) _lsSetJson(_LS_REMOTE_PROFILES_LAST_KEY, '');
        _renderRemoteProfilesSelect('');
      } catch (e2) {
        try { _renderRemoteProfilesSelect(''); } catch (e3) {}
      }
    });

    // known_hosts modal buttons
    const khModal = el('fm-knownhosts-modal');
    const khClose = el('fm-knownhosts-close-btn');
    const khOk = el('fm-knownhosts-ok-btn');
    const khRefresh = el('fm-knownhosts-refresh-btn');
    const khClear = el('fm-knownhosts-clear-btn');
    const khRemoveHost = el('fm-knownhosts-remove-host');
    const khRemoveHostBtn = el('fm-knownhosts-remove-host-btn');
    const khBody = el('fm-knownhosts-body');
    const closeKh = () => modalClose(el('fm-knownhosts-modal'));
    if (khClose) khClose.addEventListener('click', (e) => { e.preventDefault(); closeKh(); });
    if (khOk) khOk.addEventListener('click', (e) => { e.preventDefault(); closeKh(); });
    if (khModal) khModal.addEventListener('click', (e) => { if (e.target === khModal) closeKh(); });
    if (khRefresh) khRefresh.addEventListener('click', (e) => { e.preventDefault(); loadKnownHostsIntoModal(); });
    if (khClear) khClear.addEventListener('click', async (e) => {
      e.preventDefault();
      const ok = await (XKeen.ui && typeof XKeen.ui.confirm === 'function'
        ? XKeen.ui.confirm({ title: 'known_hosts', message: 'Очистить known_hosts? Это удалит все запомненные host key.', okText: 'Очистить', cancelText: 'Отмена', danger: true })
        : Promise.resolve(window.confirm('Clear known_hosts?')));
      if (!ok) return;
      try {
        await fetchJson('/api/remotefs/known_hosts/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        await loadKnownHostsIntoModal();
        scheduleFp();
      } catch (e2) {}
    });

    async function deleteKnownHostByInput() {
      const raw = String((khRemoveHost && khRemoveHost.value) || '').trim();
      if (!raw) return;

      // Parse host[:port] with IPv6-safe bracket notation support.
      let payload = null;
      try {
        const m = raw.match(/^\[([^\]]+)\]:(\d{1,5})$/);
        if (m) {
          payload = { host: String(m[1] || '').trim(), port: parseInt(m[2], 10) };
        } else {
          const m2 = raw.match(/^([^:]+):(\d{1,5})$/);
          if (m2) payload = { host: String(m2[1] || '').trim(), port: parseInt(m2[2], 10) };
          else payload = { host: raw };
        }
      } catch (e) {
        payload = { host: raw };
      }
      if (!payload || !payload.host) return;

      const label = payload.port ? `${payload.host}:${payload.port}` : String(payload.host);
      const ok = await (XKeen.ui && typeof XKeen.ui.confirm === 'function'
        ? XKeen.ui.confirm({ title: 'known_hosts', message: `Удалить hostkey для ${label}?`, okText: 'Удалить', cancelText: 'Отмена', danger: true })
        : Promise.resolve(window.confirm('Delete hostkey?')));
      if (!ok) return;

      try {
        const { res, data } = await fetchJson('/api/remotefs/known_hosts/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        const n = (data && typeof data.deleted_count === 'number') ? data.deleted_count : null;
        _toastHostkeyDeleteResult(n, 'Hostkey');
        if (khRemoveHost) khRemoveHost.value = '';
        await loadKnownHostsIntoModal();
        scheduleFp();
      } catch (e) {}
    }

    if (khRemoveHostBtn) khRemoveHostBtn.addEventListener('click', (e) => { e.preventDefault(); deleteKnownHostByInput(); });
    if (khRemoveHost) khRemoveHost.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); deleteKnownHostByInput(); }
    });
    if (khBody) khBody.addEventListener('click', async (e) => {
      const btn = e.target && e.target.closest ? e.target.closest('button[data-kh-action]') : null;
      if (!btn) return;
      const act = String(btn.getAttribute('data-kh-action') || '');
      const idx = String(btn.getAttribute('data-kh-idx') || '');

      if (act === 'delete' && idx !== '') {
        e.preventDefault();
        const ok = await (XKeen.ui && typeof XKeen.ui.confirm === 'function'
          ? XKeen.ui.confirm({ title: 'known_hosts', message: `Удалить запись #${idx}?`, okText: 'Удалить', cancelText: 'Отмена', danger: true })
          : Promise.resolve(window.confirm('Delete entry?')));
        if (!ok) return;
        try {
          await fetchJson('/api/remotefs/known_hosts/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idx: parseInt(idx, 10) }) });
          await loadKnownHostsIntoModal();
          scheduleFp();
        } catch (e2) {}
        return;
      }

      if (act === 'delete_host') {
        const hostTok = String(btn.getAttribute('data-kh-host') || '').trim();
        if (!hostTok) return;
        e.preventDefault();
        const ok = await (XKeen.ui && typeof XKeen.ui.confirm === 'function'
          ? XKeen.ui.confirm({ title: 'known_hosts', message: `Удалить hostkey для ${hostTok}?`, okText: 'Удалить', cancelText: 'Отмена', danger: true })
          : Promise.resolve(window.confirm('Delete hostkey?')));
        if (!ok) return;
        try {
          const { res, data } = await fetchJson('/api/remotefs/known_hosts/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ host: hostTok }) });
          const n = (data && typeof data.deleted_count === 'number') ? data.deleted_count : null;
          _toastHostkeyDeleteResult(n, 'Hostkey');
          await loadKnownHostsIntoModal();
          scheduleFp();
        } catch (e2) {}
      }
    });

    // create modal buttons
    const createOk = el('fm-create-ok-btn');
    const createCancel = el('fm-create-cancel-btn');
    const createClose = el('fm-create-close-btn');
    const createName = el('fm-create-name');
    const closeCreate = () => closeCreateModal();

    if (createOk) createOk.addEventListener('click', (e) => { e.preventDefault(); doCreateFromModal(); });
    if (createCancel) createCancel.addEventListener('click', (e) => { e.preventDefault(); closeCreate(); });
    if (createClose) createClose.addEventListener('click', (e) => { e.preventDefault(); closeCreate(); });
    if (createName) createName.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        doCreateFromModal();
      }
    });

    const crm = el('fm-create-modal');
    if (crm) crm.addEventListener('click', (e) => { if (e.target === crm) closeCreate(); });

    // rename modal buttons
    const renameOk = el('fm-rename-ok-btn');
    const renameCancel = el('fm-rename-cancel-btn');
    const renameClose = el('fm-rename-close-btn');
    const renameName = el('fm-rename-name');
    const closeRename = () => closeRenameModal();

    if (renameOk) renameOk.addEventListener('click', (e) => { e.preventDefault(); doRenameFromModal(); });
    if (renameCancel) renameCancel.addEventListener('click', (e) => { e.preventDefault(); closeRename(); });
    if (renameClose) renameClose.addEventListener('click', (e) => { e.preventDefault(); closeRename(); });
    if (renameName) renameName.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        doRenameFromModal();
      }
    });

    const rnm = el('fm-rename-modal');
    if (rnm) rnm.addEventListener('click', (e) => { if (e.target === rnm) closeRename(); });

    // select by mask modal
    const maskOk = el('fm-mask-ok-btn');
    const maskCancel = el('fm-mask-cancel-btn');
    const maskClose = el('fm-mask-close-btn');
    const maskInp = el('fm-mask-pattern');
    const closeMask = () => { try { modalClose(el('fm-mask-modal')); } catch (e) { try { el('fm-mask-modal') && el('fm-mask-modal').classList.add('hidden'); } catch (e2) {} } };
    const doMask = () => {
      const side = S.activeSide || 'left';
      const v = String((maskInp && maskInp.value) || '').trim();
      if (!v) { try { const err = el('fm-mask-error'); if (err) err.textContent = 'Введите маску (например: *.log)'; } catch (e) {} return; }
      try { applySelectByMask(side, v); } catch (e) {}
      closeMask();
    };
    if (maskOk) maskOk.addEventListener('click', (e) => { e.preventDefault(); doMask(); });
    if (maskCancel) maskCancel.addEventListener('click', (e) => { e.preventDefault(); closeMask(); });
    if (maskClose) maskClose.addEventListener('click', (e) => { e.preventDefault(); closeMask(); });
    if (maskInp) maskInp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doMask(); } });
    const msm = el('fm-mask-modal');
    if (msm) msm.addEventListener('click', (e) => { if (e.target === msm) closeMask(); });

    // properties modal
    const propsClose = el('fm-props-close-btn');
    const propsClose2 = el('fm-props-close-btn2');
    const closeProps = () => closePropsModal();

    if (propsClose) propsClose.addEventListener('click', (e) => { e.preventDefault(); closeProps(); });
    if (propsClose2) propsClose2.addEventListener('click', (e) => { e.preventDefault(); closeProps(); });

    const prm = el('fm-props-modal');
    if (prm) prm.addEventListener('click', (e) => { if (e.target === prm) closeProps(); });

    // checksum modal
    const hashClose = el('fm-hash-close-btn');
    const hashClose2 = el('fm-hash-close-btn2');
    const hashCopyMd5 = el('fm-hash-copy-md5');
    const hashCopySha = el('fm-hash-copy-sha256');
    const hashCopyAll = el('fm-hash-copy-all');
    const closeHash = () => closeHashModal();
    if (hashClose) hashClose.addEventListener('click', (e) => { e.preventDefault(); closeHash(); });
    if (hashClose2) hashClose2.addEventListener('click', (e) => { e.preventDefault(); closeHash(); });
    const hashm = el('fm-hash-modal');
    if (hashm) hashm.addEventListener('click', (e) => { if (e.target === hashm) closeHash(); });
    if (hashCopyMd5) hashCopyMd5.addEventListener('click', (e) => {
      e.preventDefault();
      const v = String((el('fm-hash-md5') && el('fm-hash-md5').value) || '').trim();
      if (v) _copyText(v);
      toast(v ? 'MD5 скопирован' : 'Нет данных', v ? 'success' : 'info');
    });
    if (hashCopySha) hashCopySha.addEventListener('click', (e) => {
      e.preventDefault();
      const v = String((el('fm-hash-sha256') && el('fm-hash-sha256').value) || '').trim();
      if (v) _copyText(v);
      toast(v ? 'SHA256 скопирован' : 'Нет данных', v ? 'success' : 'info');
    });
    if (hashCopyAll) hashCopyAll.addEventListener('click', (e) => {
      e.preventDefault();
      const meta = String((el('fm-hash-meta') && el('fm-hash-meta').textContent) || '').trim();
      const md5 = String((el('fm-hash-md5') && el('fm-hash-md5').value) || '').trim();
      const sha = String((el('fm-hash-sha256') && el('fm-hash-sha256').value) || '').trim();
      const size = String((el('fm-hash-size') && el('fm-hash-size').value) || '').trim();
      const out = [meta, md5 && ('MD5: ' + md5), sha && ('SHA256: ' + sha), size && ('Size: ' + size)].filter(Boolean).join('\n');
      if (out) _copyText(out);
      toast(out ? 'Checksum скопирован' : 'Нет данных', out ? 'success' : 'info');
    });

    // chmod modal
    const chmodOk = el('fm-chmod-ok-btn');
    const chmodCancel = el('fm-chmod-cancel-btn');
    const chmodClose = el('fm-chmod-close-btn');
    const chmodMode = el('fm-chmod-mode');
    const closeChmod = () => closeChmodModal();

    if (chmodOk) chmodOk.addEventListener('click', (e) => { e.preventDefault(); doChmodFromModal(); });
    if (chmodCancel) chmodCancel.addEventListener('click', (e) => { e.preventDefault(); closeChmod(); });
    if (chmodClose) chmodClose.addEventListener('click', (e) => { e.preventDefault(); closeChmod(); });
    if (chmodMode) chmodMode.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); doChmodFromModal(); }
    });
    if (chmodMode) chmodMode.addEventListener('input', () => { try { _chmodSyncFromModeInput(); } catch (e) {} });

    // checkbox sync
    ['fm-perm-ur','fm-perm-uw','fm-perm-ux','fm-perm-gr','fm-perm-gw','fm-perm-gx','fm-perm-or','fm-perm-ow','fm-perm-ox'].forEach((id) => {
      const cb = el(id);
      if (cb) cb.addEventListener('change', () => { try { _chmodSyncToModeInput(); } catch (e) {} });
    });

    const chm = el('fm-chmod-modal');
    if (chm) chm.addEventListener('click', (e) => { if (e.target === chm) closeChmod(); });

    // chown modal
    const chownOk = el('fm-chown-ok-btn');
    const chownCancel = el('fm-chown-cancel-btn');
    const chownClose = el('fm-chown-close-btn');
    const chownUid = el('fm-chown-uid');
    const chownGid = el('fm-chown-gid');
    const closeChown = () => closeChownModal();

    if (chownOk) chownOk.addEventListener('click', (e) => { e.preventDefault(); doChownFromModal(); });
    if (chownCancel) chownCancel.addEventListener('click', (e) => { e.preventDefault(); closeChown(); });
    if (chownClose) chownClose.addEventListener('click', (e) => { e.preventDefault(); closeChown(); });
    if (chownUid) chownUid.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); doChownFromModal(); }
    });
    if (chownGid) chownGid.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); doChownFromModal(); }
    });

    const cho = el('fm-chown-modal');
    if (cho) cho.addEventListener('click', (e) => { if (e.target === cho) closeChown(); });


    // drag&drop move/copy modal
    const dropMove = el('fm-dropop-move-btn');
    const dropCopy = el('fm-dropop-copy-btn');
    const dropCancel = el('fm-dropop-cancel-btn');
    const dropClose = el('fm-dropop-close-btn');

    if (dropMove) dropMove.addEventListener('click', (e) => { e.preventDefault(); closeDropOpModal('move'); });
    if (dropCopy) dropCopy.addEventListener('click', (e) => { e.preventDefault(); closeDropOpModal('copy'); });
    if (dropCancel) dropCancel.addEventListener('click', (e) => { e.preventDefault(); closeDropOpModal(null); });
    if (dropClose) dropClose.addEventListener('click', (e) => { e.preventDefault(); closeDropOpModal(null); });

    const dom = el('fm-dropop-modal');
    if (dom) dom.addEventListener('click', (e) => { if (e.target === dom) closeDropOpModal(null); });

    // conflicts modal
    const cOk = el('fm-conflicts-ok-btn');
    const cCancel = el('fm-conflicts-cancel-btn');
    const cClose = el('fm-conflicts-close-btn');
    const closeConflicts = () => { S.pending = null; modalClose(el('fm-conflicts-modal')); };

    if (cOk) cOk.addEventListener('click', (e) => { e.preventDefault(); applyConflictsAndContinue(); });
    if (cCancel) cCancel.addEventListener('click', (e) => { e.preventDefault(); closeConflicts(); });
    if (cClose) cClose.addEventListener('click', (e) => { e.preventDefault(); closeConflicts(); });

    const cm = el('fm-conflicts-modal');
    if (cm) cm.addEventListener('click', (e) => { if (e.target === cm) closeConflicts(); });

    // progress modal
    const pOk = el('fm-progress-ok-btn');
    const pCancel = el('fm-progress-cancel-btn');
    const pClose = el('fm-progress-close-btn');
    const closeProgress = () => { _clearProgressAutoClose(); modalClose(el('fm-progress-modal')); };

    if (pOk) pOk.addEventListener('click', (e) => { e.preventDefault(); closeProgress(); });
    if (pClose) pClose.addEventListener('click', (e) => { e.preventDefault(); closeProgress(); });
    if (pCancel) pCancel.addEventListener('click', async (e) => {
      e.preventDefault();
      // If an XHR transfer is active, abort it first.
      try {
        if (S.transfer && S.transfer.xhr) {
          S.transfer.xhr.abort();
          try { _finishTransferUi({ ok: false, message: 'Отменено', showDetails: false, detailsText: 'Отменено пользователем' }); } catch (e3) {}
          return;
        }
      } catch (e2) {}
      const jobId = S.ws.jobId;
      if (jobId) await cancelJob(jobId);
    });

    const pm = el('fm-progress-modal');
    if (pm) pm.addEventListener('click', (e) => { if (e.target === pm) closeProgress(); });

    // ops modal
    const opsBtn = el('fm-ops-btn');
    const opsClose = el('fm-ops-close-btn');
    const opsRefresh = el('fm-ops-refresh-btn');
    const opsFilter = el('fm-ops-filter');
    const opsClear = el('fm-ops-clear-btn');

    if (opsBtn) opsBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      // Sync UI controls with in-memory state.
      try { if (opsFilter) opsFilter.value = String(S.opsUi.filter || 'all'); } catch (e0) {}
      await refreshOpsList();
      modalOpen(el('fm-ops-modal'));
    });
    if (opsClose) opsClose.addEventListener('click', (e) => { e.preventDefault(); modalClose(el('fm-ops-modal')); });
    if (opsRefresh) opsRefresh.addEventListener('click', (e) => { e.preventDefault(); refreshOpsList(); });

    if (opsFilter) opsFilter.addEventListener('change', () => {
      try { S.opsUi.filter = String(opsFilter.value || 'all'); } catch (e) { S.opsUi.filter = 'all'; }
      renderOpsList(S.opsUi.lastJobs || []);
    });

    if (opsClear) opsClear.addEventListener('click', async (e) => {
      e.preventDefault();
      const ok = await (XKeen.ui && typeof XKeen.ui.confirm === 'function'
        ? XKeen.ui.confirm({
          title: 'Очистить историю',
          message: 'Удалить завершённые и неудачные операции из списка?\n(Активные операции останутся.)',
          okText: 'Очистить',
          cancelText: 'Отмена',
          danger: true,
        })
        : Promise.resolve(window.confirm('Очистить историю операций?')));
      if (!ok) return;

      const serverOk = await clearOpsHistory('history');
      if (serverOk) return;

      // Fallback: hide locally (persisted in localStorage).
      const jobs = S.opsUi.lastJobs || [];
      const idsToHide = [];
      (jobs || []).forEach((j) => {
        const jid = String(j && (j.job_id || '') || '');
        if (!jid) return;
        const st = String(j && (j.state || '') || '').toLowerCase();
        if (st === 'done' || st === 'error' || st === 'canceled') idsToHide.push(jid);
      });
      const n = _opsHideMany(idsToHide);
      toast(n ? `Скрыто: ${n}` : 'Нечего очищать', n ? 'success' : 'info');
      renderOpsList(jobs);
    });

    const om = el('fm-ops-modal');
    if (om) om.addEventListener('click', (e) => { if (e.target === om) modalClose(om); });

    // refresh all
    const refreshAllBtn = el('fm-refresh-all-btn');
    if (refreshAllBtn) refreshAllBtn.addEventListener('click', (e) => { e.preventDefault(); refreshAll(); });



    // help
    const helpBtn = el('fm-help-btn');
    const helpClose = el('fm-help-close-btn');
    const helpOk = el('fm-help-ok-btn');
    if (helpBtn) helpBtn.addEventListener('click', (e) => {
      try { e.preventDefault(); } catch (e2) {}
      modalOpen(el('fm-help-modal'));
    });
    if (helpClose) helpClose.addEventListener('click', (e) => { e.preventDefault(); modalClose(el('fm-help-modal')); });
    if (helpOk) helpOk.addEventListener('click', (e) => { e.preventDefault(); modalClose(el('fm-help-modal')); });

    const hm = el('fm-help-modal');
    if (hm) hm.addEventListener('click', (e) => { if (e.target === hm) modalClose(hm); });
    // ESC closes our modals (best-effort)
    document.addEventListener('keydown', (e) => {
      if (!e || e.key !== 'Escape') return;
      // Close top-most opened FM modal
      let closedAny = false;

      // Editor modal has its own unsaved-changes logic.
      const em = el('fm-editor-modal');
      if (em && !em.classList.contains('hidden')) {
        try { fmEditorRequestClose(); } catch (e0) {}
        closedAny = true;
      }

      // Drop operation modal must resolve the pending promise.
      const dm = el('fm-dropop-modal');
      if (dm && !dm.classList.contains('hidden')) {
        closeDropOpModal(null);
        closedAny = true;
      }

      ['fm-help-modal', 'fm-ops-modal', 'fm-progress-modal', 'fm-conflicts-modal', 'fm-props-modal', 'fm-hash-modal', 'fm-rename-modal', 'fm-create-modal', 'fm-connect-modal', 'fm-chmod-modal', 'fm-chown-modal'].forEach((id) => {
        const m = el(id);
        if (m && !m.classList.contains('hidden')) {
          modalClose(m);
          closedAny = true;
        }
      });

      // If no modal was closed, treat ESC as "exit fullscreen".
      try {
        if (!closedAny && fmIsFullscreen && isFilesViewVisible() && !isTextInputActive() && !document.querySelector('.modal:not(.hidden)')) {
          fmSetFullscreen(false);
        }
      } catch (e2) {}
    });
  }

  function wireHeaderActions() {
    const view = el('view-files');
    const actions = view ? qs('.fm-header-actions', view) : null;
    if (!actions) return;

    // Buttons for file operations should be located at the bottom-right of the
    // file manager card ("+Папка", "+Файл", Download, Upload). If the footer
    // container is not present (older markup), fall back to the header actions.
    const footerActions = view ? qs('.fm-footer-actions', view) : null;
    const fileActions = footerActions || actions;

    // Fullscreen toggle (similar UX to terminal)
    if (!el('fm-fullscreen-btn')) {
      const fsBtn = document.createElement('button');
      fsBtn.type = 'button';
      fsBtn.className = 'btn-secondary';
      fsBtn.id = 'fm-fullscreen-btn';
      fsBtn.textContent = '⛶';
      fsBtn.title = 'Полный экран';
      fsBtn.setAttribute('aria-label', 'Полный экран');
      fsBtn.addEventListener('click', (e) => {
        try { e.preventDefault(); } catch (e2) {}
        fmToggleFullscreen();
      });
      try {
        actions.insertBefore(fsBtn, actions.firstChild);
      } catch (e) {
        try { actions.appendChild(fsBtn); } catch (e2) {}
      }
    }

    // "Show hidden files" (dotfiles) toggle
    if (!el('fm-dotfiles-toggle')) {
      const wrap = document.createElement('label');
      wrap.className = 'fm-toggle';
      wrap.id = 'fm-dotfiles-wrap';
      wrap.title = 'Показать/скрыть файлы, начинающиеся с точки (.)';
      wrap.innerHTML = [
        '<input type="checkbox" id="fm-dotfiles-toggle" />',
        '<span class="fm-toggle-slider" aria-hidden="true"></span>',
        '<span class="fm-toggle-label">Скрытые</span>',
      ].join('');

      try {
        const cb = qs('#fm-dotfiles-toggle', wrap);
        if (cb) {
          cb.checked = !!(S && S.prefs && S.prefs.showHidden);
          cb.addEventListener('change', () => setShowHidden(!!cb.checked));
        }
      } catch (e) {}

      try {
        // Place right after fullscreen button (near the rest of view options).
        const fsBtn = el('fm-fullscreen-btn');
        if (fsBtn && fsBtn.parentElement) {
          fsBtn.parentElement.insertBefore(wrap, fsBtn.nextSibling);
        } else {
          actions.insertBefore(wrap, actions.firstChild);
        }
      } catch (e) {
        try { actions.appendChild(wrap); } catch (e2) {}
      }
    } else {
      // keep in sync if pref changed programmatically
      try {
        const cb = el('fm-dotfiles-toggle');
        if (cb) cb.checked = !!(S && S.prefs && S.prefs.showHidden);
      } catch (e) {}
    }

    // Ensure button state matches current DOM state.
    try {
      const card = fmCardEl();
      fmIsFullscreen = !!(card && card.classList && card.classList.contains('is-fullscreen'));
      updateFmFullscreenBtn();
    } catch (e) {}

    // Create folder / file buttons
    // "Вверх" is now located in the top panel bars (next to "Обновить").
    // In the footer we keep only "Очистить корзину" (active panel).

    if (!el('fm-clear-trash-active-btn')) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn-secondary hidden';
      b.id = 'fm-clear-trash-active-btn';
      b.textContent = '🧹 Очистить корзину';
      b.title = 'Очистить корзину (активная панель)';
      b.setAttribute('aria-label', 'Очистить корзину');
      b.addEventListener('click', async (e) => {
        try { e.preventDefault(); } catch (e2) {}
        await runClearTrash(S.activeSide);
      });
      try {
        fileActions.insertBefore(b, fileActions.firstChild);
      } catch (e) {
        try { fileActions.appendChild(b); } catch (e2) {}
      }
    }

    // Initial state
    try { updateFmFooterNavButtons(); } catch (e) {}

    if (!el('fm-mkdir-btn')) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn-secondary';
      b.id = 'fm-mkdir-btn';
      b.textContent = '➕ Папка';
      b.title = 'Создать папку в активной панели';
      b.addEventListener('click', (e) => {
        try { e.preventDefault(); } catch (e2) {}
        openCreateModal('dir');
      });
      try { fileActions.appendChild(b); } catch (e2) {}
    }

    if (!el('fm-touch-btn')) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn-secondary';
      b.id = 'fm-touch-btn';
      b.textContent = '➕ Файл';
      b.title = 'Создать пустой файл в активной панели';
      b.addEventListener('click', (e) => {
        try { e.preventDefault(); } catch (e2) {}
        openCreateModal('file');
      });
      try { fileActions.appendChild(b); } catch (e2) {}
    }

    // Upload / download buttons are injected at runtime.
    if (el('fm-upload-btn')) return; // already wired

    const upBtn = document.createElement('button');
    upBtn.type = 'button';
    upBtn.className = 'btn-secondary';
    upBtn.id = 'fm-upload-btn';
    upBtn.textContent = '⬆ Upload';

    const downBtn = document.createElement('button');
    downBtn.type = 'button';
    downBtn.className = 'btn-secondary';
    downBtn.id = 'fm-download-btn';
    downBtn.textContent = '⬇ Download';

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.multiple = true;
    fileInput.style.display = 'none';
    fileInput.id = 'fm-upload-input';

    upBtn.onclick = () => {
      try { fileInput.value = ''; } catch (e) {}
      fileInput.click();
    };
    fileInput.onchange = () => {
      const files = Array.from(fileInput.files || []);
      if (!files.length) return;
      xhrUploadFiles({ side: S.activeSide, files });
    };

    downBtn.onclick = () => {
      downloadSelection(S.activeSide);
    };

    fileActions.appendChild(downBtn);
    fileActions.appendChild(upBtn);
    fileActions.appendChild(fileInput);

    // Place navigation buttons at the far right of the footer actions.
    // Re-appending moves existing nodes without duplicating them.
    try {
      const trashNav = el('fm-clear-trash-active-btn');
      if (trashNav && trashNav.parentElement === fileActions) fileActions.appendChild(trashNav);
    } catch (e) {}
  }


  // -------------------------- context menu (ПКМ) --------------------------
  function ensureCtxMenuEl() {
    let m = el('fm-context-menu');
    if (m) return m;
    try {
      m = document.createElement('div');
      m.id = 'fm-context-menu';
      m.className = 'fm-context-menu hidden';
      m.setAttribute('role', 'menu');
      m.setAttribute('aria-label', 'Файловое меню');
      document.body.appendChild(m);
    } catch (e) {
      return null;
    }
    return m;
  }

  function hideCtxMenu() {
    const m = ensureCtxMenuEl();
    if (!m) return;
    try { m.classList.add('hidden'); } catch (e) {}
    try { m.innerHTML = ''; } catch (e) {}
    try { S.ctxMenu.shown = false; } catch (e) {}
  }

  function _ctxSep() {
    const d = document.createElement('div');
    d.className = 'fm-context-sep';
    d.setAttribute('role', 'separator');
    return d;
  }

  function _ctxBtn(label, action, kbd) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'fm-context-item';
    b.dataset.action = String(action || '');
    const left = document.createElement('span');
    left.className = 'fm-context-label';
    left.textContent = String(label || '');
    b.appendChild(left);
    if (kbd) {
      const right = document.createElement('span');
      right.className = 'fm-context-kbd';
      right.textContent = String(kbd || '');
      b.appendChild(right);
    }
    return b;
  }

  function buildCtxMenu(menu, opts) {
    if (!menu) return;
    const o = opts || {};
    const side = String((o.side) || S.activeSide || 'left');
    const p = (S.panels && S.panels[side]) ? S.panels[side] : null;
    const hasRow = !!o.hasRow;
    const isDir = !!o.isDir;
    const hasSelection = !!(p && getSelectionNames(side).length);
    const inTrash = !!(p && isTrashPanel(p));

    // Capabilities (best-effort; default allow)
    let canChmod = true;
    let canChown = true;
    try {
      const rf = (S.caps && S.caps.remoteFs) ? S.caps.remoteFs : null;
      const fa = (rf && rf.fs_admin) ? rf.fs_admin : null;
      const local = (fa && fa.local) ? fa.local : {};
      const remote = (fa && fa.remote) ? fa.remote : {};
      const isRemote = !!p && String(p.target) === 'remote';
      canChmod = isRemote ? !!remote.chmod : !!local.chmod;
      canChown = isRemote ? !!remote.chown : !!local.chown;
      const protos = Array.isArray(remote.chown_protocols) ? remote.chown_protocols.map(String) : [];
      if (isRemote && protos.length) {
        const rproto = String((p && p.rproto) || '').trim().toLowerCase();
        if (rproto) {
          canChown = canChown && protos.includes(rproto);
        } else {
          // If protocol is unknown on the UI side, keep menu visible only if SFTP is allowed.
          canChown = canChown && protos.includes('sftp');
        }
      }
      // Remote requires active session.
      if (isRemote && (!p || !p.sid)) {
        canChmod = false;
        canChown = false;
      }
    } catch (e) {
      // keep defaults
    }

    menu.innerHTML = '';

    if (!hasRow && hasSelection) {
      menu.appendChild(_ctxBtn('Свойства…', 'props', ''));
      menu.appendChild(_ctxSep());
    }

    if (hasRow) {
      menu.appendChild(_ctxBtn(isDir ? 'Открыть папку' : 'Открыть', 'open', 'Enter'));
      menu.appendChild(_ctxBtn('Скачать', 'download', ''));
      menu.appendChild(_ctxBtn('Копировать полный путь', 'copy_path', 'Ctrl+Shift+C'));
      menu.appendChild(_ctxSep());
      menu.appendChild(_ctxBtn('Копировать', 'copy', 'F5'));
      menu.appendChild(_ctxBtn('Переместить', 'move', 'F6'));
      menu.appendChild(_ctxBtn('Переименовать', 'rename', 'F2'));
      menu.appendChild(_ctxBtn('Свойства…', 'props', ''));
      if (!isDir) menu.appendChild(_ctxBtn('Checksum (MD5/SHA256)…', 'checksum', ''));
      if (canChmod) menu.appendChild(_ctxBtn('Права (chmod)…', 'chmod', ''));
      if (canChown) menu.appendChild(_ctxBtn('Владелец (chown)…', 'chown', ''));
      if (inTrash) menu.appendChild(_ctxBtn('Восстановить', 'restore', ''));
      menu.appendChild(_ctxBtn(inTrash ? 'Удалить навсегда' : 'В корзину', 'delete', 'F8'));
      menu.appendChild(_ctxSep());
    }

    menu.appendChild(_ctxBtn('Создать папку', 'mkdir', 'F7'));
    menu.appendChild(_ctxBtn('Создать файл', 'touch', 'Shift+F7'));
    menu.appendChild(_ctxSep());
    menu.appendChild(_ctxBtn('Выделить всё', 'select_all', 'Ctrl+A'));
    menu.appendChild(_ctxBtn('Инвертировать выделение', 'invert_sel', 'Ctrl+I'));
    menu.appendChild(_ctxBtn('Выделить по маске…', 'mask_sel', 'Ctrl+M'));
    if (!hasRow) {
      // For an empty-area menu, provide path copy (cwd/selection).
      menu.appendChild(_ctxBtn('Копировать полный путь', 'copy_path', 'Ctrl+Shift+C'));
    }
    menu.appendChild(_ctxSep());
    menu.appendChild(_ctxBtn('Загрузить (Upload)…', 'upload', ''));
    menu.appendChild(_ctxBtn('Вверх', 'up', 'Backspace'));
    menu.appendChild(_ctxBtn('Обновить', 'refresh', '⟳'));
  }

  function showCtxMenu(opts) {
    const m = ensureCtxMenuEl();
    if (!m) return;

    const side = String((opts && opts.side) || S.activeSide || 'left');
    const name = safeName((opts && opts.name) || '');
    const isDir = !!(opts && opts.isDir);
    const hasRow = !!(opts && opts.hasRow);

    // store context for actions
    try { S.ctxMenu = { shown: true, side, name, isDir, hasRow }; } catch (e) {}

    buildCtxMenu(m, { side, hasRow, isDir });

    // Position (fixed to viewport)
    try {
      m.style.position = 'fixed';
      m.style.left = '0px';
      m.style.top = '0px';
      m.style.maxWidth = 'calc(100vw - 16px)';
      m.style.maxHeight = 'calc(100vh - 16px)';
    } catch (e) {}

    try { m.classList.remove('hidden'); } catch (e) {}

    const x0 = Number((opts && opts.x) || 0);
    const y0 = Number((opts && opts.y) || 0);

    // Clamp into viewport after measuring
    try {
      const pad = 8;
      const w = m.offsetWidth || 240;
      const h = m.offsetHeight || 200;
      const vw = window.innerWidth || (w + pad * 2);
      const vh = window.innerHeight || (h + pad * 2);
      const x = Math.max(pad, Math.min(vw - w - pad, x0));
      const y = Math.max(pad, Math.min(vh - h - pad, y0));
      m.style.left = x + 'px';
      m.style.top = y + 'px';
    } catch (e) {}
  }

  function wireCtxMenuGlobal() {
    // only once
    try {
      if (document.body && document.body.dataset && document.body.dataset.fmCtxInit === '1') return;
      if (document.body && document.body.dataset) document.body.dataset.fmCtxInit = '1';
    } catch (e) {}

    const m = ensureCtxMenuEl();
    if (!m) return;

    // Menu action dispatcher
    m.addEventListener('click', async (e) => {
      const b = e.target && e.target.closest ? e.target.closest('button.fm-context-item[data-action]') : null;
      const act = b ? String(b.dataset.action || '') : '';
      if (!act) return;
      try { e.preventDefault(); e.stopPropagation(); } catch (e2) {}

      const ctx = S.ctxMenu || {};
      const side = String(ctx.side || S.activeSide || 'left');

      // Close menu first (so UI feels snappy)
      hideCtxMenu();

      // Ensure side active for actions relying on S.activeSide
      try { setActiveSide(side); } catch (e3) {}

      // If menu was opened on a row, ensure focus is on that row
      try {
        const p = S.panels[side];
        if (p && ctx.name) {
          p.focusName = safeName(ctx.name);
        }
      } catch (e4) {}

      try {
        if (act === 'open') {
          await openFocused(side);
        } else if (act === 'download') {
          downloadSelection(side);
        } else if (act === 'copy_path') {
          copyFullPaths(side);
        } else if (act === 'copy') {
          await runCopyMove('copy');
        } else if (act === 'move') {
          await runCopyMove('move');
        } else if (act === 'rename') {
          openRenameModal();
        } else if (act === 'props') {
          await openPropsModal(side);
        } else if (act === 'checksum') {
          await openHashModal(side);
        } else if (act === 'chmod') {
          openChmodModal();
        } else if (act === 'chown') {
          openChownModal();
        } else if (act === 'restore') {
          await runRestore();
        } else if (act === 'delete') {
          await runDelete();
        } else if (act === 'select_all') {
          selectAllVisible(side);
        } else if (act === 'invert_sel') {
          invertSelectionVisible(side);
        } else if (act === 'mask_sel') {
          openMaskModal();
        } else if (act === 'mkdir') {
          openCreateModal('dir');
        } else if (act === 'touch') {
          openCreateModal('file');
        } else if (act === 'upload') {
          const inp = el('fm-upload-input');
          if (inp) {
            try { inp.value = ''; } catch (e5) {}
            inp.click();
          }
        } else if (act === 'up') {
          await goUp(side);
        } else if (act === 'refresh') {
          await listPanel(side, { fromInput: true });
        }
      } catch (err) {
        try { toast('FM: действие не выполнено', 'error'); } catch (e6) {}
      }
    }, true);

    // Close on outside click / scroll / resize / Escape
    document.addEventListener('mousedown', (e) => {
      const mm = el('fm-context-menu');
      if (!mm || mm.classList.contains('hidden')) return;
      if (e && e.target && mm.contains(e.target)) return;
      hideCtxMenu();
    }, true);

    // Do NOT close the menu when user scrolls over it (wheel/trackpad) —
    // it's too easy to dismiss the menu accidentally.
    // Still close it on wheel/scroll happening outside of the menu.
    document.addEventListener('wheel', (e) => {
      const mm = el('fm-context-menu');
      if (!mm || mm.classList.contains('hidden')) return;

      // When the pointer is over the menu, keep it open and prevent the
      // underlying panel/page from scrolling (otherwise a scroll event would
      // fire and close the menu anyway).
      if (e && e.target && mm.contains(e.target)) {
        try { e.preventDefault(); } catch (e2) {}
        try { e.stopPropagation(); } catch (e3) {}
        return;
      }

      hideCtxMenu();
    }, { capture: true, passive: false });

    document.addEventListener('scroll', (e) => {
      const mm = el('fm-context-menu');
      if (!mm || mm.classList.contains('hidden')) return;
      // Allow scrolling inside the context menu without dismissing it.
      if (e && e.target && mm.contains(e.target)) return;
      hideCtxMenu();
    }, true);

    window.addEventListener('resize', () => hideCtxMenu(), true);

    document.addEventListener('keydown', (e) => {
      const mm = el('fm-context-menu');
      if (!mm || mm.classList.contains('hidden')) return;
      if (e && e.key === 'Escape') {
        try { e.preventDefault(); e.stopPropagation(); } catch (e2) {}
        hideCtxMenu();
      }
    }, true);
  }

  function wireHotkeys() {
    document.addEventListener('keydown', async (e) => {
      // Hotkeys should work even if remote backend is disabled (local manager is still useful).
      if (!isFilesViewVisible()) return;
      if (!e) return;

      // Avoid interfering when typing in inputs and when modals are open
      if (isTextInputActive()) return;
      if (document.querySelector('.modal:not(.hidden)')) return;

      const k = e.key;

      // Exit FM fullscreen quickly
      if (k === 'Escape' && fmIsFullscreen) {
        e.preventDefault();
        fmSetFullscreen(false);
        return;
      }

      const ctrl = !!(e.ctrlKey || e.metaKey);

      // Total Commander-ish мелочи
      if (ctrl && (k === 'a' || k === 'A')) {
        e.preventDefault();
        selectAllVisible(S.activeSide);
        return;
      }
      if (ctrl && (k === 'i' || k === 'I')) {
        e.preventDefault();
        invertSelectionVisible(S.activeSide);
        return;
      }
      if (ctrl && (k === 'm' || k === 'M')) {
        e.preventDefault();
        openMaskModal();
        return;
      }
      if (ctrl && e.shiftKey && (k === 'c' || k === 'C')) {
        e.preventDefault();
        copyFullPaths(S.activeSide);
        return;
      }

      if (k === 'F1') {
        e.preventDefault();
        modalOpen(el('fm-help-modal'));
        return;
      }

      if (k === 'Tab') {
        e.preventDefault();
        setActiveSide(otherSide(S.activeSide));
        const d = panelDom(S.activeSide);
        if (d && d.list) {
          try { d.list.focus(); } catch (e2) {}
        }
        return;
      }

      if (k === 'Enter') {
        e.preventDefault();
        await openFocused(S.activeSide);
        return;
      }

      if (k === 'Backspace') {
        e.preventDefault();
        await goUp(S.activeSide);
        return;
      }

      if (k === 'F2') {
        e.preventDefault();
        openRenameModal();
        return;
      }

      if (k === 'F5') {
        e.preventDefault();
        await runCopyMove('copy');
        return;
      }

      if (k === 'F6') {
        e.preventDefault();
        await runCopyMove('move');
        return;
      }

      if (k === 'F7') {
        e.preventDefault();
        openCreateModal(e.shiftKey ? 'file' : 'dir');
        return;
      }

      if (k === 'F8') {
        e.preventDefault();
        await runDelete();
        return;
      }
    }, true);
  }

  async function detectCapabilities() {
    const tabBtn = el('top-tab-files');
    const note = el('fm-disabled-note');

    // Default: keep server-side visibility (panel.html hides the tab on MIPS).

    try {
      const { res, data } = await fetchJson('/api/capabilities', { method: 'GET' });
      if (!res || !res.ok || !data) return;
      S.caps = data;

      const rf = data.remoteFs || {};
      const arch = String(rf.arch || '').toLowerCase();
      const isMips = arch.startsWith('mips') || String(rf.reason || '') === 'arch_mips_disabled';

      // Show the "Files" tab on non-MIPS even if remote is disabled (local manager is still useful).
      if (!isMips) {
        if (tabBtn) show(tabBtn);
      } else {
        if (tabBtn) hide(tabBtn);
      }

      const enabled = !!rf.enabled;
      const supported = !!rf.supported;
      S.enabled = enabled;

      // Disable remote target option if remote backend isn't supported.
      try {
        const allowRemote = !!supported && !isMips;
        ['left', 'right'].forEach((side) => {
          const pd = panelDom(side);
          const p = S.panels[side];
          if (!pd || !pd.targetSelect) return;
          const opt = Array.from(pd.targetSelect.options || []).find(o => String(o.value) === 'remote');
          if (opt) opt.disabled = !allowRemote;
          if (!allowRemote && p && p.target === 'remote') {
            p.target = 'local';
            p.sid = '';
          }
        });
      } catch (e) {}

      // Fill modal selects from server capabilities (optional).
      try {
        await loadRemoteCaps();
        applyCapsToConnectModal();
      } catch (e) {}

      // If remote isn't enabled, show a hint inside the view.
      if (note) {
        if (isMips) {
          note.textContent = 'Файловый менеджер недоступен на MIPS-архитектуре.';
          show(note);
        } else if (!enabled) {
          const reason = rf.reason ? String(rf.reason) : 'disabled';
          let msg = 'Remote файловый менеджер недоступен: ' + reason + '.';
          if (reason === 'lftp_missing') {
            msg += ' Установите lftp через Entware: opkg install lftp.';
          } else if (reason === 'disabled') {
            msg += ' Включите XKEEN_REMOTEFM_ENABLE=1.';
          }
          note.textContent = msg;
          show(note);
        } else {
          hide(note);
        }
      }
    } catch (e) {
      // ignore
    }
  }

  FM.onShow = function onShow() {
    // lazy refresh when tab is opened
    try {
      // Render and refresh if empty.
      ['left', 'right'].forEach((s) => renderPanel(s));
      if (!S.panels.left.items.length && !S.panels.right.items.length) {
        refreshAll();
      }
    } catch (e) {}
  };

  FM.init = function init() {
    const root = el('fm-root');
    if (!root) return;

    // avoid double init
    if (root.dataset && root.dataset.fmInit === '1') return;
    if (root.dataset) root.dataset.fmInit = '1';

    // init default paths
    ['left', 'right'].forEach((side) => {
      const p = S.panels[side];
      if (!p.cwd) p.cwd = '/opt/var';
    });

    setActiveSide('left');

    // Adds the bottom-left resize handle (so the card can be resized to the left).
    wireLeftResizeHandle();

    // Persist card geometry (user resize) similarly to the terminal window.
    fmWireGeomPersistence();

    wirePanel('left');
    wirePanel('right');
    wireHeaderActions();
    wireModals();
    wireHotkeys();

    detectCapabilities().then(() => {
      // Render initial local panels immediately
      renderPanel('left');
      renderPanel('right');
      // Preload local lists even before switching tab (fast and avoids empty view).
      refreshAll();
    });
  };
})();

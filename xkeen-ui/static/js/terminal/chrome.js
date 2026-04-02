import {
  ensureTerminalNamespaceBucket,
  getTerminalById,
  getTerminalCompatApi,
  getTerminalContext,
  getTerminalPtyApi,
  publishTerminalCompatApi,
  syncTerminalBodyScrollLock,
} from './runtime.js';
import { appendTerminalDebug, markTerminalDebugState } from '../features/terminal_debug.js';

// Terminal window chrome: drag/resize/persist geometry + fullscreen/minimize
// Pure UI module (no fetch/ws business logic)
(function () {
  'use strict';

  function getCtx() {
    return getTerminalContext();
  }

  const core = getTerminalCompatApi('_core');
  const state = (core && core.state) ? core.state : ensureTerminalNamespaceBucket('__chrome_state');

  const GEOM_KEY = 'xkeen_terminal_geom_v1';

  let openBound = false;
  let openDisposers = [];
  let resizeObserver = null;
  let saveTimer = null;
  let roWindowStartedAt = 0;
  let roWindowCount = 0;
  let roMutedUntil = 0;

  let dragging = false;
  let dragOffsetX = 0;
  let dragOffsetY = 0;
  let dragWidth = 0;
  let dragHeight = 0;

  // Fullscreen state
  let isFullscreen = false;
  let geomBeforeFullscreen = null;

  function byId(id, ctx) {
    const current = ctx || getCtx();
    return getTerminalById(id, (key) => {
      try {
        if (current && current.ui && typeof current.ui.byId === 'function') return current.ui.byId(key);
      } catch (e0) {}
      try {
        if (core && typeof core.byId === 'function') return core.byId(key);
      } catch (e) {}
      return null;
    });
  }

  function syncBodyScrollLock() {
    try {
      if (core && typeof core.syncBodyScrollLock === 'function') return core.syncBodyScrollLock();
    } catch (e) {}
    return syncTerminalBodyScrollLock();
  }

  function fitXterm() {
    appendTerminalDebug('chrome:fit-xterm', { hasFitAddon: !!(state && state.fitAddon) });
    try {
      const fa = state.fitAddon || null;
      if (fa && typeof fa.fit === 'function') fa.fit();
    } catch (e) {}
  }

  function getEls() {
    const overlay = byId('terminal-overlay');
    const win = overlay ? overlay.querySelector('.terminal-window') : null;
    const header = win ? win.querySelector('.terminal-header') : null;
    return { overlay, win, header };
  }

  function clampPos(x, y, w, h) {
    const pad = 8;
    const maxX = Math.max(pad, window.innerWidth - w - pad);
    const maxY = Math.max(pad, window.innerHeight - h - pad);
    return {
      x: Math.min(Math.max(pad, x), maxX),
      y: Math.min(Math.max(pad, y), maxY),
    };
  }

  function readGeom() {
    try {
      const raw = localStorage.getItem(GEOM_KEY);
      if (!raw) return null;
      const j = JSON.parse(raw);
      if (!j || typeof j !== 'object') return null;

      const w = Number(j.w);
      const h = Number(j.h);
      const x = Number(j.x);
      const y = Number(j.y);

      if (!Number.isFinite(w) || !Number.isFinite(h) || w < 200 || h < 150) return null;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return { w, h, x: null, y: null };
      return { w, h, x, y };
    } catch (e) {
      return null;
    }
  }

  function applyGeom(geom) {
    if (isFullscreen) return;
    const { win } = getEls();
    if (!win || !geom) return;

    win.style.position = 'fixed';

    if (Number.isFinite(geom.w)) win.style.width = Math.round(geom.w) + 'px';
    if (Number.isFinite(geom.h)) win.style.height = Math.round(geom.h) + 'px';

    const rect = win.getBoundingClientRect();
    const w = rect.width || geom.w || 520;
    const h = rect.height || geom.h || 360;

    let x = geom.x;
    let y = geom.y;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      x = Math.round((window.innerWidth - w) / 2);
      y = Math.round((window.innerHeight - h) / 2);
    }

    const p = clampPos(x, y, w, h);
    win.style.left = Math.round(p.x) + 'px';
    win.style.top = Math.round(p.y) + 'px';
  }

  // Extra safety: some browsers/layouts can yield transient geometry during open
  // (e.g. when max-height clamps after we set explicit height). Re-clamp using
  // the *actual* rendered rect, ensuring the header stays reachable.
  function ensureInViewportNow() {
    if (isFullscreen) return;
    const { win } = getEls();
    if (!win) return;
    try {
      const r = win.getBoundingClientRect();
      const w = r.width || 520;
      const h = r.height || 360;
      const p = clampPos(r.left, r.top, w, h);
      // Only write styles if we actually need to move.
      if (Math.abs(p.x - r.left) > 1 || Math.abs(p.y - r.top) > 1) {
        win.style.position = 'fixed';
        win.style.left = Math.round(p.x) + 'px';
        win.style.top = Math.round(p.y) + 'px';
      }
    } catch (e) {}
  }

  function saveGeomNow() {
    if (isFullscreen) return;
    const { win } = getEls();
    if (!win) return;
    const rect = win.getBoundingClientRect();
    if (!rect || !Number.isFinite(rect.width) || !Number.isFinite(rect.height)) return;

    const geom = {
      w: Math.round(rect.width),
      h: Math.round(rect.height),
      x: Math.round(rect.left),
      y: Math.round(rect.top),
    };

    try {
      localStorage.setItem(GEOM_KEY, JSON.stringify(geom));
    } catch (e) {
      // ignore quota / privacy mode
    }
  }

  function scheduleSave() {
    if (saveTimer) {
      try { clearTimeout(saveTimer); } catch (e) {}
    }
    saveTimer = setTimeout(() => {
      saveTimer = null;
      saveGeomNow();
    }, 150);
  }

  function updateFullscreenBtn() {
    const btn = byId('terminal-btn-fullscreen');
    if (!btn) return;
    if (isFullscreen) {
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
    const { win } = getEls();
    if (!win) return;

    if (on && !isFullscreen) {
      try {
        const r = win.getBoundingClientRect();
        geomBeforeFullscreen = { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left), y: Math.round(r.top) };
      } catch (e) {
        geomBeforeFullscreen = null;
      }

      isFullscreen = true;
      win.classList.add('is-fullscreen');
      try { win.style.position = 'fixed'; } catch (e) {}
      updateFullscreenBtn();
      fitXterm();
      return;
    }

    if (!on && isFullscreen) {
      isFullscreen = false;
      win.classList.remove('is-fullscreen');
      try {
        if (geomBeforeFullscreen) {
          applyGeom(geomBeforeFullscreen);
          scheduleSave();
        }
      } catch (e) {}
      updateFullscreenBtn();
      fitXterm();
    }
  }

  function toggleFullscreen() {
    setFullscreen(!isFullscreen);
  }

  function minimize() {
    const { overlay } = getEls();
    let usedController = false;
    try {
      const ctx = getCtx();
      const oc = ctx ? (ctx.overlay || ctx.overlayCtrl) : null;
      if (oc && typeof oc.hide === 'function') {
        usedController = true;
        oc.hide();
      }
    } catch (e) {}
    if (!usedController) {
      if (overlay) overlay.style.display = 'none';
      syncBodyScrollLock();
    }
    try {
      const pty = getTerminalPtyApi();
      if (pty && typeof pty.hideSignalsMenu === 'function') pty.hideSignalsMenu();
    } catch (e) {}
  }

  function addOpenListener(el, ev, fn, opts) {
    if (!el || typeof el.addEventListener !== 'function') return;
    el.addEventListener(ev, fn, opts);
    openDisposers.push(() => {
      try { el.removeEventListener(ev, fn, opts); } catch (e) {}
    });
  }

  function bindWhileOpen() {
    if (openBound) return;
    openBound = true;
    openDisposers = [];

    const { win, header } = getEls();
    if (!win || !header) return;

    const onHeaderDown = (e) => {
      if (e.button !== 0) return;
      if (isFullscreen) return;
      if (e.target && e.target.closest && e.target.closest('.terminal-toolbar')) return;

      const rect = win.getBoundingClientRect();
      win.style.position = 'fixed';
      win.style.left = Math.round(rect.left) + 'px';
      win.style.top = Math.round(rect.top) + 'px';
      win.style.width = Math.round(rect.width) + 'px';
      win.style.height = Math.round(rect.height) + 'px';

      dragging = true;
      dragOffsetX = e.clientX - rect.left;
      dragOffsetY = e.clientY - rect.top;
      dragWidth = rect.width;
      dragHeight = rect.height;

      document.documentElement.style.userSelect = 'none';
      document.documentElement.style.cursor = 'move';
      try { e.preventDefault(); } catch (e2) {}
    };
    addOpenListener(header, 'mousedown', onHeaderDown);

    const onDocMove = (e) => {
      if (!dragging) return;
      let newX = e.clientX - dragOffsetX;
      let newY = e.clientY - dragOffsetY;
      const p = clampPos(newX, newY, dragWidth, dragHeight);
      win.style.left = Math.round(p.x) + 'px';
      win.style.top = Math.round(p.y) + 'px';
    };
    addOpenListener(document, 'mousemove', onDocMove);

    const onDocUp = () => {
      if (!dragging) return;
      dragging = false;
      document.documentElement.style.userSelect = '';
      document.documentElement.style.cursor = '';
      scheduleSave();
    };
    addOpenListener(document, 'mouseup', onDocUp);

    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        const now = Date.now();
        if (!roWindowStartedAt || (now - roWindowStartedAt) > 2000) {
          roWindowStartedAt = now;
          roWindowCount = 0;
        }
        roWindowCount += 1;
        if (roWindowCount === 1 || roWindowCount === 10 || roWindowCount === 25 || roWindowCount === 50) {
          appendTerminalDebug('chrome:resize-observer-count', { count: roWindowCount });
        }
        if (roWindowCount > 80) {
          roMutedUntil = now + 3000;
          appendTerminalDebug('chrome:resize-observer-storm', { count: roWindowCount, mutedUntil: roMutedUntil });
          markTerminalDebugState({ status: 'chrome-resize-storm', lastStage: 'chrome:resize-observer-storm', resizeCount: roWindowCount });
          return;
        }
        if (roMutedUntil && now < roMutedUntil) return;
        if (isFullscreen) return;
        try {
          const r = win.getBoundingClientRect();
          const p = clampPos(r.left, r.top, r.width, r.height);
          win.style.position = 'fixed';
          win.style.left = Math.round(p.x) + 'px';
          win.style.top = Math.round(p.y) + 'px';
        } catch (e) {}
        scheduleSave();
        // Resizing affects xterm rows/cols; best effort fit.
        fitXterm();
      });
      try { resizeObserver.observe(win); } catch (e) {}
      openDisposers.push(() => {
        try { if (resizeObserver) resizeObserver.disconnect(); } catch (e) {}
        resizeObserver = null;
      });
    }

    const onWinResize = () => {
      if (isFullscreen) return;
      try {
        const r = win.getBoundingClientRect();
        const p = clampPos(r.left, r.top, r.width, r.height);
        win.style.position = 'fixed';
        win.style.left = Math.round(p.x) + 'px';
        win.style.top = Math.round(p.y) + 'px';
      } catch (e) {}
      scheduleSave();
    };
    addOpenListener(window, 'resize', onWinResize);
  }

  function unbindWhileOpen() {
    if (!openBound) return;
    openBound = false;
    dragging = false;
    try {
      document.documentElement.style.userSelect = '';
      document.documentElement.style.cursor = '';
    } catch (e) {}
    try {
      (openDisposers || []).forEach((fn) => { try { fn(); } catch (e) {} });
    } catch (e2) {}
    openDisposers = [];
  }

  // Call when overlay becomes visible
  function onOpen() {
    bindWhileOpen();
    updateFullscreenBtn();

    requestAnimationFrame(() => {
      const { win } = getEls();
      if (!win) return;
      const saved = readGeom();
      if (saved) {
        applyGeom(saved);
      } else {
        const rect = win.getBoundingClientRect();
        const x = Math.round((window.innerWidth - rect.width) / 2);
        const y = Math.round((window.innerHeight - rect.height) / 2);
        applyGeom({ w: rect.width, h: rect.height, x, y });
        scheduleSave();
      }

      // Clamp once more after layout settles (fixes rare "window jumped off-screen" cases).
      try { ensureInViewportNow(); } catch (e) {}
      try { setTimeout(() => { try { ensureInViewportNow(); } catch (e2) {} }, 60); } catch (e3) {}
    });
  }

  // Public helper: clamp the terminal window into the current viewport.
  // Some call sites open the terminal indirectly (e.g. command chips) and in
  // rare cases late layout changes can still end up slightly off-screen.
  function ensureInViewport() {
    try { ensureInViewportNow(); } catch (e) {}
    try { setTimeout(() => { try { ensureInViewportNow(); } catch (e2) {} }, 0); } catch (e3) {}
  }

  const terminalChromeApi = {
    init: () => {},
    onOpen,
    onClose: unbindWhileOpen,
    ensureInViewport,
    minimize,
    setFullscreen,
    toggleFullscreen,
    updateFullscreenBtn,
    isFullscreen: () => !!isFullscreen,
    saveGeomNow,
    // Stage E: registry plugin factory
    createModule: (ctx) => ({
      id: 'chrome',
      priority: 55,
      init: () => {},
      onOpen: () => { try { onOpen(ctx); } catch (e) {} },
      onClose: () => { try { unbindWhileOpen(); } catch (e) {} },
    }),
  };
  publishTerminalCompatApi('chrome', terminalChromeApi);
})();

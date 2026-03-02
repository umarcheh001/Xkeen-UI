(() => {
  'use strict';

  // File Manager shared helpers (no ES modules / bundler):
  // attach to window.XKeen.features.fileManager.common.

  window.XKeen = window.XKeen || {};
  XKeen.features = XKeen.features || {};
  XKeen.features.fileManager = XKeen.features.fileManager || {};

  const FM = XKeen.features.fileManager;

  const CORE_DOM = (window.XKeen && window.XKeen.core && window.XKeen.core.dom) ? window.XKeen.core.dom : null;
  const CORE_STORAGE = (window.XKeen && window.XKeen.core && window.XKeen.core.storage) ? window.XKeen.core.storage : null;

  FM.common = FM.common || {};
  const C = FM.common;

  // -------------------------- DOM helpers --------------------------
  C.el = function el(id) {
    try {
      if (CORE_DOM && typeof CORE_DOM.byId === 'function') return CORE_DOM.byId(id);
    } catch (e) {}
    try { return document.getElementById(id); } catch (e2) { return null; }
  };

  C.qs = function qs(sel, root) {
    try {
      if (CORE_DOM && typeof CORE_DOM.q === 'function') return CORE_DOM.q(sel, root);
    } catch (e) {}
    try { return (root || document).querySelector(sel); } catch (e2) { return null; }
  };

  C.qsa = function qsa(sel, root) {
    try {
      if (CORE_DOM && typeof CORE_DOM.qa === 'function') return CORE_DOM.qa(sel, root);
    } catch (e) {}
    try { return Array.from((root || document).querySelectorAll(sel) || []); } catch (e2) { return []; }
  };

  // -------------------------- storage (localStorage wrapper, keys stay the same) --------------------------
  C.storageGet = function storageGet(key) {
    try { if (CORE_STORAGE && typeof CORE_STORAGE.get === 'function') return CORE_STORAGE.get(key); } catch (e) {}
    try { return window.localStorage ? window.localStorage.getItem(String(key)) : null; } catch (e2) { return null; }
  };

  C.storageSet = function storageSet(key, val) {
    try { if (CORE_STORAGE && typeof CORE_STORAGE.set === 'function') return CORE_STORAGE.set(key, val); } catch (e) {}
    try { if (window.localStorage) window.localStorage.setItem(String(key), String(val)); } catch (e2) {}
  };

  C.storageRemove = function storageRemove(key) {
    try { if (CORE_STORAGE && typeof CORE_STORAGE.remove === 'function') return CORE_STORAGE.remove(key); } catch (e) {}
    try { if (window.localStorage) window.localStorage.removeItem(String(key)); } catch (e2) {}
  };

  C.storageGetJSON = function storageGetJSON(key, fallback) {
    try { if (CORE_STORAGE && typeof CORE_STORAGE.getJSON === 'function') return CORE_STORAGE.getJSON(key, fallback); } catch (e) {}
    try {
      const raw = C.storageGet(key);
      if (!raw) return fallback;
      const j = JSON.parse(raw);
      return (j == null) ? fallback : j;
    } catch (e2) {
      return fallback;
    }
  };

  C.storageSetJSON = function storageSetJSON(key, val) {
    try { if (CORE_STORAGE && typeof CORE_STORAGE.setJSON === 'function') return CORE_STORAGE.setJSON(key, val); } catch (e) {}
    try { C.storageSet(key, JSON.stringify(val)); } catch (e2) {}
  };

  // -------------------------- modal helpers --------------------------
  C.modalOpen = function modalOpen(modal) {
    if (!modal) return;
    try { modal.classList.remove('hidden'); } catch (e) {}
    try {
      if (XKeen.ui && XKeen.ui.modal && typeof XKeen.ui.modal.syncBodyScrollLock === 'function') {
        XKeen.ui.modal.syncBodyScrollLock();
      } else {
        document.body.classList.add('modal-open');
      }
    } catch (e) {}
  };

  C.modalClose = function modalClose(modal) {
    if (!modal) return;
    try { modal.classList.add('hidden'); } catch (e) {}
    try {
      if (XKeen.ui && XKeen.ui.modal && typeof XKeen.ui.modal.syncBodyScrollLock === 'function') {
        XKeen.ui.modal.syncBodyScrollLock();
      } else {
        document.body.classList.remove('modal-open');
      }
    } catch (e) {}

  // -------------------------- toast helpers (centralized) --------------------------
  C.toast = function toast(msg, level) {
    const m = (msg == null) ? '' : String(msg);
    const lvl = String(level || 'info');
    try {
      if (window.XKeen && window.XKeen.ui && typeof window.XKeen.ui.toast === 'function') return window.XKeen.ui.toast(m, lvl);
    } catch (e) {}
    try {
      if (typeof window.toast === 'function') return window.toast(m, lvl);
    } catch (e) {}
    try {
      // last resort: console
      const fn = (lvl === 'error' || lvl === 'danger') ? 'error' : 'log';
      console[fn]('[toast]', m);
    } catch (e) {}
  };

  // -------------------------- misc helpers --------------------------
  C.debounce = function debounce(fn, ms) {
    const delay = Math.max(0, Number(ms || 0));
    let t = null;
    return function debounced() {
      const ctx = this;
      const args = arguments;
      try { if (t) clearTimeout(t); } catch (e) {}
      t = setTimeout(() => {
        try { fn.apply(ctx, args); } catch (e) {}
      }, delay);
    };
  };

  };

  // -------------------------- format helpers --------------------------
  C.fmtSize = function fmtSize(bytes) {
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

  // Alias used by some modules
  C.fmtBytes = C.fmtBytes || C.fmtSize;
  };

  C.fmtTime = function fmtTime(ts) {
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
  };

  C.safeName = function safeName(name, fallback) {
    const s = (name == null) ? '' : String(name);
    if (s) return s;
    return (fallback == null) ? '' : String(fallback);
  };

  // -------------------------- path helpers --------------------------
  C.joinLocal = function joinLocal(cwd, name) {
    const c = String(cwd || '');
    const n = String(name || '');
    if (!c) return n;
    if (!n) return c;
    const sep = c.endsWith('/') ? '' : '/';
    return c + sep + n;
  };

  C.parentLocal = function parentLocal(cwd) {
    const p = String(cwd || '').replace(/\/+$/, '');
    if (!p || p === '/') return '/';
    const idx = p.lastIndexOf('/');
    if (idx <= 0) return '/';
    return p.slice(0, idx) || '/';
  };

  C.normRemotePath = function normRemotePath(p) {
    let s = String(p || '').trim();
    if (!s || s === '~') return '.';
    if (s === '.') return '.';
    s = s.replace(/\/{2,}/g, '/');
    if (s.length > 1) s = s.replace(/\/+$/, '');
    return s || '.';
  };

  C.joinRemote = function joinRemote(cwd, name) {
    const c0 = C.normRemotePath(cwd);
    let n = String(name || '').trim();
    if (!n) return c0 || '.';
    n = n.replace(/\/+$/, '');
    if (n === '') n = '/';
    if (n.startsWith('/')) return C.normRemotePath(n);
    if (!c0 || c0 === '.') return C.normRemotePath(n);
    const sep = c0.endsWith('/') ? '' : '/';
    return C.normRemotePath(c0 + sep + n);
  };

  C.parentRemote = function parentRemote(cwd) {
    const p0 = C.normRemotePath(cwd);
    if (!p0 || p0 === '.') return '.';
    if (p0 === '/') return '/';
    const p = String(p0).replace(/\/+$/, '');
    const idx = p.lastIndexOf('/');
    if (idx < 0) return '.';
    if (idx === 0) return '/';
    const up = p.slice(0, idx);
    return up ? up : '/';
  };

  // -------------------------- local root guards --------------------------
  C._trimSlashes = function _trimSlashes(p) {
    return String(p || '').replace(/\/+$/, '') || '/';
  };

  C._isUnderRoot = function _isUnderRoot(path, root) {
    const pp = C._trimSlashes(path);
    const rr = C._trimSlashes(root);
    if (rr === '/') return true;
    return pp === rr || pp.startsWith(rr + '/');
  };

  C.isAllowedLocalPath = function isAllowedLocalPath(path, roots) {
    const rr = Array.isArray(roots) ? roots : [];
    if (!rr.length) return true;
    for (const r of rr) {
      if (C._isUnderRoot(path, r)) return true;
    }
    return false;
  };
})();

import { isXkeenMipsRuntime } from '../xkeen_runtime.js';
import { getFileManagerNamespace } from '../file_manager_namespace.js';

(() => {
  'use strict';

  // File Manager shared helpers (no ES modules / bundler):
  // attach to the shared file manager namespace.common.

  const FM = getFileManagerNamespace();

  function getWindowXKeen() {
    try { return window && window.XKeen ? window.XKeen : null; } catch (e) { return null; }
  }

  function getCoreDomApi() {
    try {
      const xk = getWindowXKeen();
      return xk && xk.core ? (xk.core.dom || null) : null;
    } catch (e) {
      return null;
    }
  }

  function getCoreStorageApi() {
    try {
      const xk = getWindowXKeen();
      return xk && xk.core ? (xk.core.storage || null) : null;
    } catch (e) {
      return null;
    }
  }

  FM.common = FM.common || {};
  const C = FM.common;

  C.getXKeen = function getXKeen() {
    return getWindowXKeen();
  };

  C.getUiApi = function getUiApi() {
    try {
      const xk = getWindowXKeen();
      return xk ? (xk.ui || null) : null;
    } catch (e) {
      return null;
    }
  };

  C.getModalApi = function getModalApi() {
    try {
      const ui = C.getUiApi();
      return ui ? (ui.modal || null) : null;
    } catch (e) {
      return null;
    }
  };

  C.getLayoutApi = function getLayoutApi() {
    try {
      const ui = C.getUiApi();
      return ui ? (ui.layout || null) : null;
    } catch (e) {
      return null;
    }
  };

  C.getCoreHttp = function getCoreHttp() {
    try {
      const xk = getWindowXKeen();
      return xk && xk.core ? (xk.core.http || null) : null;
    } catch (e) {
      return null;
    }
  };

  C.getEditorEngine = function getEditorEngine() {
    try {
      const ui = C.getUiApi();
      return ui ? (ui.editorEngine || null) : null;
    } catch (e) {
      return null;
    }
  };

  C.getLazyRuntime = function getLazyRuntime() {
    try {
      const xk = getWindowXKeen();
      return xk && xk.runtime ? (xk.runtime.lazy || null) : null;
    } catch (e) {
      return null;
    }
  };

  C.getTerminal = function getTerminal() {
    try {
      const xk = getWindowXKeen();
      return xk ? (xk.terminal || null) : null;
    } catch (e) {
      return null;
    }
  };

  // -------------------------- DOM helpers --------------------------
  C.el = function el(id) {
    try {
      const coreDom = getCoreDomApi();
      if (coreDom && typeof coreDom.byId === 'function') return coreDom.byId(id);
    } catch (e) {}
    try { return document.getElementById(id); } catch (e2) { return null; }
  };

  C.qs = function qs(sel, root) {
    try {
      const coreDom = getCoreDomApi();
      if (coreDom && typeof coreDom.q === 'function') return coreDom.q(sel, root);
    } catch (e) {}
    try { return (root || document).querySelector(sel); } catch (e2) { return null; }
  };

  C.qsa = function qsa(sel, root) {
    try {
      const coreDom = getCoreDomApi();
      if (coreDom && typeof coreDom.qa === 'function') return coreDom.qa(sel, root);
    } catch (e) {}
    try { return Array.from((root || document).querySelectorAll(sel) || []); } catch (e2) { return []; }
  };

  // -------------------------- storage --------------------------
  C.storageGet = function storageGet(key) {
    try {
      const coreStorage = getCoreStorageApi();
      if (coreStorage && typeof coreStorage.get === 'function') return coreStorage.get(key);
    } catch (e) {}
    try { return window.localStorage ? window.localStorage.getItem(String(key)) : null; } catch (e2) { return null; }
  };

  C.storageSet = function storageSet(key, val) {
    try {
      const coreStorage = getCoreStorageApi();
      if (coreStorage && typeof coreStorage.set === 'function') return coreStorage.set(key, val);
    } catch (e) {}
    try { if (window.localStorage) window.localStorage.setItem(String(key), String(val)); } catch (e2) {}
  };

  C.storageRemove = function storageRemove(key) {
    try {
      const coreStorage = getCoreStorageApi();
      if (coreStorage && typeof coreStorage.remove === 'function') return coreStorage.remove(key);
    } catch (e) {}
    try { if (window.localStorage) window.localStorage.removeItem(String(key)); } catch (e2) {}
  };

  C.storageGetJSON = function storageGetJSON(key, fallback) {
    try {
      const coreStorage = getCoreStorageApi();
      if (coreStorage && typeof coreStorage.getJSON === 'function') return coreStorage.getJSON(key, fallback);
    } catch (e) {}
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
    try {
      const coreStorage = getCoreStorageApi();
      if (coreStorage && typeof coreStorage.setJSON === 'function') return coreStorage.setJSON(key, val);
    } catch (e) {}
    try { C.storageSet(key, JSON.stringify(val)); } catch (e2) {}
  };

  // -------------------------- modal / ui helpers --------------------------
  C.syncBodyScrollLock = function syncBodyScrollLock(locked) {
    try {
      const modalApi = C.getModalApi();
      if (modalApi && typeof modalApi.syncBodyScrollLock === 'function') {
        modalApi.syncBodyScrollLock();
        return;
      }
    } catch (e) {}
    try {
      if (typeof locked === 'boolean') document.body.classList.toggle('modal-open', !!locked);
    } catch (e2) {}
  };

  C.modalOpen = function modalOpen(modal) {
    if (!modal) return;
    try { modal.classList.remove('hidden'); } catch (e) {}
    try { C.syncBodyScrollLock(true); } catch (e2) {}
  };

  C.modalClose = function modalClose(modal) {
    if (!modal) return;
    try { modal.classList.add('hidden'); } catch (e) {}
    try { C.syncBodyScrollLock(false); } catch (e2) {}
  };

  C.toast = function toast(msg, level) {
    const m = (msg == null) ? '' : String(msg);
    const lvl = String(level || 'info');
    try {
      const ui = C.getUiApi();
      if (ui && typeof ui.toast === 'function') return ui.toast(m, lvl);
    } catch (e) {}
    try {
      if (typeof window.toast === 'function') return window.toast(m, lvl);
    } catch (e2) {}
    try {
      const fn = (lvl === 'error' || lvl === 'danger') ? 'error' : 'log';
      console[fn]('[toast]', m);
    } catch (e3) {}
    return undefined;
  };

  C.confirm = async function confirm(opts, fallbackText) {
    const cfg = opts || {};
    try {
      const ui = C.getUiApi();
      if (ui && typeof ui.confirm === 'function') return !!(await ui.confirm(cfg));
    } catch (e) {}
    try {
      const text = fallbackText || cfg.message || cfg.text || cfg.title || 'Continue?';
      return !!window.confirm(String(text));
    } catch (e2) {
      return false;
    }
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

  // -------------------------- format helpers --------------------------
  C.fmtSize = function fmtSize(bytes) {
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
  };

  C.fmtBytes = C.fmtBytes || C.fmtSize;

  C.fmtTime = function fmtTime(ts) {
    const t = Number(ts || 0);
    if (!isFinite(t) || t <= 0) return '';
    try {
      const d = new Date(t * 1000);
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

  C.isLiteMode = function isLiteMode() {
    try {
      const s = (FM && FM.state && FM.state.S) ? FM.state.S : null;
      if (s && typeof s.liteMode === 'boolean') return !!s.liteMode;
    } catch (e) {}
    return isXkeenMipsRuntime();
  };

  C.toggleHidden = function toggleHidden(node, hidden) {
    if (!node) return;
    const on = !!hidden;
    try { node.hidden = on; } catch (e) {}
    try {
      const tag = String(node.tagName || '').toUpperCase();
      if (tag === 'OPTION') {
        node.removeAttribute('aria-hidden');
      } else if (on) {
        node.setAttribute('aria-hidden', 'true');
      } else {
        node.removeAttribute('aria-hidden');
      }
    } catch (e2) {}
  };
})();

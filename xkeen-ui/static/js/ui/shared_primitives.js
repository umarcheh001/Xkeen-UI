(() => {
  'use strict';

  window.XKeen = window.XKeen || {};
  const XK = window.XKeen;
  XK.ui = XK.ui || {};

  const CORE_DOM = (XK.core && XK.core.dom) ? XK.core.dom : null;
  const CORE_HTTP = (XK.core && XK.core.http) ? XK.core.http : null;
  const CORE_STORAGE = (XK.core && XK.core.storage) ? XK.core.storage : null;

  function byId(id) {
    try {
      if (CORE_DOM && typeof CORE_DOM.byId === 'function') return CORE_DOM.byId(id);
    } catch (e) {}
    try { return document.getElementById(id); } catch (e2) { return null; }
  }

  function normalizeKind(value, fallback) {
    if (typeof value === 'boolean') return value ? 'error' : (fallback || 'success');
    const kind = String(value || fallback || 'info').trim().toLowerCase();
    if (kind === 'danger' || kind === 'fail' || kind === 'failed') return 'error';
    if (kind === 'warn') return 'warning';
    if (kind === 'ok') return 'success';
    if (kind === 'error' || kind === 'warning' || kind === 'success' || kind === 'info') return kind;
    return String(fallback || 'info');
  }

  function toast(message, kindOrOptions) {
    const text = String(message ?? '').trim();
    if (!text) return null;
    try {
      if (typeof window.toast === 'function') return window.toast(text, kindOrOptions);
    } catch (e) {}
    try {
      if (typeof window.showToast === 'function') return window.showToast(text, kindOrOptions);
    } catch (e2) {}
    try {
      if (XK.ui && typeof XK.ui.toast === 'function') return XK.ui.toast(text, kindOrOptions);
    } catch (e3) {}
    try { console.log('[xkeen]', text); } catch (e4) {}
    return null;
  }

  function writeStatus(statusEl, message, kindOrOptions) {
    if (!statusEl) return '';
    const text = String(message ?? '');
    const kind = normalizeKind(kindOrOptions, text ? 'info' : 'info');
    try { statusEl.textContent = text; } catch (e) {}
    try { statusEl.classList.toggle('error', kind === 'error'); } catch (e2) {}
    return text;
  }

  function buildConfirmText(options) {
    const opts = (options && typeof options === 'object') ? options : {};
    const primary = String(opts.message || opts.text || opts.body || 'Продолжить?').trim() || 'Продолжить?';
    const details = Array.isArray(opts.details)
      ? opts.details.map((item) => String(item || '').trim()).filter(Boolean).join('\n')
      : String(opts.details || '').trim();
    return details ? (primary + '\n\n' + details) : primary;
  }

  async function confirmAction(options) {
    const opts = (options && typeof options === 'object') ? options : {};
    try {
      if (XK.ui && typeof XK.ui.confirm === 'function') return !!(await XK.ui.confirm(opts));
    } catch (e) {}

    const ok = window.confirm(buildConfirmText(opts));
    if (!ok && opts.cancelMessage) {
      toast(String(opts.cancelMessage), normalizeKind(opts.cancelKind, 'info'));
    }
    return !!ok;
  }

  function getModalApi() {
    try {
      if (XK.ui && XK.ui.modal) return XK.ui.modal;
    } catch (e) {}
    return null;
  }

  function syncModalFallback() {
    try {
      const anyModal = !!document.querySelector('.modal:not(.hidden), .modal-drawer:not(.hidden), .modal-overlay:not(.hidden)');
      document.body.classList.toggle('modal-open', anyModal);
    } catch (e) {}
  }

  function openModal(modal, options) {
    if (!modal) return false;
    const api = getModalApi();
    const opts = (options && typeof options === 'object') ? options : {};
    try {
      if (api && typeof api.open === 'function') return api.open(modal, opts);
    } catch (e) {}
    try { modal.classList.remove('hidden'); } catch (e2) {}
    try {
      if (api && typeof api.syncBodyScrollLock === 'function') api.syncBodyScrollLock();
      else syncModalFallback();
    } catch (e3) {}
    return true;
  }

  function closeModal(modal, options) {
    if (!modal) return false;
    const api = getModalApi();
    const opts = (options && typeof options === 'object') ? options : {};
    try {
      if (api && typeof api.close === 'function') return api.close(modal, opts);
    } catch (e) {}
    try { modal.classList.add('hidden'); } catch (e2) {}
    try {
      if (api && typeof api.syncBodyScrollLock === 'function') api.syncBodyScrollLock();
      else syncModalFallback();
    } catch (e3) {}
    return true;
  }

  async function getJSON(url, options) {
    const opts = (options && typeof options === 'object') ? Object.assign({}, options) : {};
    try {
      if (CORE_HTTP && typeof CORE_HTTP.fetchJSON === 'function') {
        if (!Object.prototype.hasOwnProperty.call(opts, 'cache')) opts.cache = 'no-store';
        return await CORE_HTTP.fetchJSON(url, opts);
      }
    } catch (e) {}

    const fetchOpts = Object.assign({ cache: 'no-store' }, opts);
    const res = await fetch(url, fetchOpts);
    let data = null;
    try { data = await res.json(); } catch (e2) {}
    if (!res.ok) {
      const err = (data && data.error) ? String(data.error) : ('HTTP ' + res.status);
      throw new Error(err);
    }
    return data;
  }

  async function postJSON(url, body, options) {
    const opts = (options && typeof options === 'object') ? Object.assign({}, options) : {};
    try {
      if (CORE_HTTP && typeof CORE_HTTP.postJSON === 'function') {
        if (!Object.prototype.hasOwnProperty.call(opts, 'cache')) opts.cache = 'no-store';
        return await CORE_HTTP.postJSON(url, body || {}, opts);
      }
      if (CORE_HTTP && typeof CORE_HTTP.fetchJSON === 'function') {
        return await CORE_HTTP.fetchJSON(url, Object.assign({
          cache: 'no-store',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body || {}),
        }, opts));
      }
    } catch (e) {}

    const res = await fetch(url, Object.assign({
      cache: 'no-store',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    }, opts));
    let data = null;
    try { data = await res.json(); } catch (e2) {}
    if (!res.ok) {
      const err = (data && data.error) ? String(data.error) : ('HTTP ' + res.status);
      throw new Error(err);
    }
    return data;
  }

  function wireCollapsibleState(options) {
    const opts = (options && typeof options === 'object') ? options : {};
    const selector = String(opts.selector || 'details[id]').trim() || 'details[id]';
    const prefix = String(opts.storagePrefix || 'xk.details.').trim() || 'xk.details.';
    const root = opts.root && typeof opts.root.querySelectorAll === 'function' ? opts.root : document;
    let nodes = [];
    try { nodes = Array.from(root.querySelectorAll(selector)); } catch (e) { nodes = []; }
    if (!nodes.length) return 0;

    const store = (CORE_STORAGE && typeof CORE_STORAGE.ns === 'function') ? CORE_STORAGE.ns(prefix) : null;
    let wired = 0;
    nodes.forEach((node) => {
      const id = String(node && node.id ? node.id : '').trim();
      if (!id) return;
      if (node.dataset && node.dataset.xkCollapsibleWired === '1') return;
      const key = id + '.open';
      try {
        const saved = store ? store.get(key, null) : localStorage.getItem(prefix + key);
        if (saved === '0') node.open = false;
        if (saved === '1') node.open = true;
      } catch (e) {}
      try {
        node.addEventListener('toggle', () => {
          try {
            if (store) store.set(key, node.open ? '1' : '0');
            else localStorage.setItem(prefix + key, node.open ? '1' : '0');
          } catch (err) {}
        });
        if (node.dataset) node.dataset.xkCollapsibleWired = '1';
      } catch (e2) {}
      wired += 1;
    });
    return wired;
  }

  XK.ui.sharedPrimitives = {
    byId,
    toast,
    writeStatus,
    buildConfirmText,
    confirmAction,
    openModal,
    closeModal,
    getJSON,
    postJSON,
    wireCollapsibleState,
    normalizeKind,
  };
})();

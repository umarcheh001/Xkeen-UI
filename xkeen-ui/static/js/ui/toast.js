(() => {
  'use strict';

  window.XKeen = window.XKeen || {};
  const XK = window.XKeen;
  XK.ui = XK.ui || {};

  const DEFAULT_DURATION = {
    success: 3200,
    info: 3200,
    warning: 4200,
    error: 4200,
  };

  const RENDERED = new Map();
  const LOCAL_ACTIVE = new Map();
  const LOCAL_ACTIVE_BY_KEY = new Map();
  const LOCAL_RECENT = new Map();
  let storeBindingReady = false;

  function ensureContainer() {
    let container = document.getElementById('toast-container');
    if (container) return container;

    try {
      container = document.createElement('div');
      container.id = 'toast-container';
      document.body.appendChild(container);
    } catch (error) {
      return null;
    }

    return container;
  }

  function normalizeKind(kind) {
    if (typeof kind === 'boolean') return kind ? 'error' : 'success';
    if (typeof kind !== 'string') return 'success';

    const value = String(kind || '').trim().toLowerCase();
    if (!value) return 'success';
    if (value === 'danger' || value === 'fail' || value === 'failed') return 'error';
    if (value === 'warn') return 'warning';
    if (value === 'ok') return 'success';
    if (value === 'success' || value === 'info' || value === 'warning' || value === 'error') return value;
    return 'success';
  }

  function iconForKind(kind) {
    switch (normalizeKind(kind)) {
      case 'error':
        return '\u26A0';
      case 'info':
        return '\u2139';
      case 'warning':
        return '\u26A0';
      default:
        return '\u2713';
    }
  }

  function normalizeOptions(message, kindOrOptions) {
    let opts = {};
    let msg = message;

    if (message && typeof message === 'object' && !Array.isArray(message)) {
      opts = Object.assign({}, message);
      msg = Object.prototype.hasOwnProperty.call(opts, 'message') ? opts.message : '';
    } else if (kindOrOptions && typeof kindOrOptions === 'object' && !Array.isArray(kindOrOptions)) {
      opts = Object.assign({}, kindOrOptions);
    } else {
      opts.kind = kindOrOptions;
    }

    const kind = normalizeKind(Object.prototype.hasOwnProperty.call(opts, 'kind') ? opts.kind : kindOrOptions);
    const duration = Number.isFinite(Number(opts.durationMs))
      ? Math.max(0, Number(opts.durationMs))
      : (Number.isFinite(Number(opts.duration))
        ? Math.max(0, Number(opts.duration))
        : DEFAULT_DURATION[kind]);

    return {
      message: String(msg ?? ''),
      kind,
      duration,
      sticky: !!(opts.sticky || opts.persist || opts.persistent),
      id: opts.id ? String(opts.id) : '',
      dedupeKey: opts.dedupeKey ? String(opts.dedupeKey) : '',
      dedupeWindowMs: Number.isFinite(Number(opts.dedupeWindowMs)) ? Math.max(0, Number(opts.dedupeWindowMs)) : 600,
      replace: opts.replace !== false,
    };
  }

  function resolveDedupeKey(opts) {
    if (!opts) return '';
    if (opts.id) return String(opts.id);
    if (opts.dedupeKey) return String(opts.dedupeKey);
    return String(opts.kind || 'success') + '|' + String(opts.message || '');
  }

  function getUiToastApi() {
    const api = (XK.core && XK.core.uiToast) || XK.uiToast || null;
    if (!api) return null;
    if (typeof api.enqueue !== 'function') return null;
    if (typeof api.dismiss !== 'function') return null;
    if (typeof api.clear !== 'function') return null;
    if (typeof api.isActive !== 'function') return null;
    if (typeof api.subscribe !== 'function') return null;
    return api;
  }

  function clearRenderedTimer(entry) {
    if (!entry) return;
    try {
      if (entry.timer) clearTimeout(entry.timer);
    } catch (error) {}
    entry.timer = null;
  }

  function removeRenderedEntry(entry) {
    if (!entry || !entry.el || entry.removing) return;
    entry.removing = true;
    clearRenderedTimer(entry);

    try {
      entry.el.style.opacity = '0';
      entry.el.style.transform = 'translateY(4px)';
    } catch (error) {}

    entry.removeTimer = setTimeout(() => {
      try { entry.el.remove(); } catch (error) {}
    }, 200);
  }

  function createRenderedEntry(container) {
    const toast = document.createElement('div');
    toast.className = 'toast toast-success';
    toast.dataset.kind = 'success';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');

    const icon = document.createElement('div');
    icon.className = 'toast-icon';

    const text = document.createElement('div');
    text.className = 'toast-message';

    toast.appendChild(icon);
    toast.appendChild(text);
    container.appendChild(toast);

    return {
      uid: '',
      el: toast,
      icon,
      text,
      timer: null,
      removeTimer: null,
      renderToken: '',
      removing: false,
    };
  }

  function syncRenderedEntry(entry, toastState, api) {
    if (!entry || !toastState) return;

    if (entry.removeTimer) {
      try { clearTimeout(entry.removeTimer); } catch (error) {}
      entry.removeTimer = null;
    }

    entry.uid = String(toastState.uid || '');
    entry.removing = false;
    entry.icon.textContent = iconForKind(toastState.kind);
    entry.text.textContent = String(toastState.message || '');
    entry.el.className = 'toast toast-' + normalizeKind(toastState.kind);
    entry.el.dataset.kind = normalizeKind(toastState.kind);
    entry.el.style.opacity = '';
    entry.el.style.transform = '';
    entry.el.setAttribute('role', normalizeKind(toastState.kind) === 'error' ? 'alert' : 'status');
    entry.el.setAttribute('aria-live', normalizeKind(toastState.kind) === 'error' ? 'assertive' : 'polite');

    const renderToken = [
      toastState.updatedAt,
      toastState.kind,
      toastState.message,
      toastState.duration,
      toastState.sticky,
    ].join('|');

    if (entry.renderToken === renderToken) return;
    entry.renderToken = renderToken;
    clearRenderedTimer(entry);

    if (toastState.sticky || Number(toastState.duration || 0) <= 0) return;

    entry.timer = setTimeout(() => {
      try {
        api.dismiss(entry.uid, { source: 'toast_timer' });
      } catch (error) {}
    }, Math.max(0, Number(toastState.duration || 0)));
  }

  function renderToastQueue(queue) {
    const list = Array.isArray(queue) ? queue : [];
    const nextUids = new Set();
    const container = list.length ? ensureContainer() : document.getElementById('toast-container');

    list.forEach((toastState) => {
      if (!toastState || !toastState.uid || !toastState.message || !container) return;

      const uid = String(toastState.uid);
      nextUids.add(uid);

      let entry = RENDERED.get(uid);
      if (!entry) {
        entry = createRenderedEntry(container);
        RENDERED.set(uid, entry);
      }

      syncRenderedEntry(entry, toastState, getUiToastApi());
      try { container.appendChild(entry.el); } catch (error) {}
    });

    Array.from(RENDERED.entries()).forEach(([uid, entry]) => {
      if (nextUids.has(uid)) return;
      RENDERED.delete(uid);
      removeRenderedEntry(entry);
    });
  }

  function ensureStoreBinding() {
    if (storeBindingReady) return true;

    const api = getUiToastApi();
    if (!api) return false;

    api.subscribe((nextState) => {
      renderToastQueue(nextState && nextState.queue);
    }, { immediate: true });

    storeBindingReady = true;
    return true;
  }

  function clearLocalEntryBinding(entry) {
    if (!entry) return;

    try {
      if (entry.id && LOCAL_ACTIVE.get(entry.id) === entry) LOCAL_ACTIVE.delete(entry.id);
    } catch (error) {}

    try {
      if (entry.dedupeKey && LOCAL_ACTIVE_BY_KEY.get(entry.dedupeKey) === entry) {
        LOCAL_ACTIVE_BY_KEY.delete(entry.dedupeKey);
      }
    } catch (error) {}
  }

  function closeLocalToast(entry) {
    if (!entry || !entry.el || entry.closed) return;
    entry.closed = true;

    try {
      if (entry.timer) clearTimeout(entry.timer);
    } catch (error) {}

    try {
      entry.el.style.opacity = '0';
      entry.el.style.transform = 'translateY(4px)';
    } catch (error) {}

    setTimeout(() => {
      try { entry.el.remove(); } catch (error) {}
    }, 200);

    clearLocalEntryBinding(entry);
  }

  function armLocalTimer(entry, duration, sticky) {
    try {
      if (entry.timer) clearTimeout(entry.timer);
    } catch (error) {}

    if (sticky || duration <= 0) {
      entry.timer = null;
      return;
    }

    entry.timer = setTimeout(() => closeLocalToast(entry), duration);
  }

  function rememberLocalRecent(key) {
    if (!key) return;
    try { LOCAL_RECENT.set(key, Date.now()); } catch (error) {}
  }

  function isLocalRecentDuplicate(key, windowMs) {
    if (!key) return false;

    try {
      const prev = Number(LOCAL_RECENT.get(key) || 0);
      if (!prev) return false;
      return (Date.now() - prev) < Math.max(0, Number(windowMs || 0));
    } catch (error) {
      return false;
    }
  }

  function createLocalEntry(container) {
    const entry = createRenderedEntry(container);
    entry.id = '';
    entry.dedupeKey = '';
    entry.closed = false;
    return entry;
  }

  function bindLocalEntry(entry, opts) {
    if (!entry || !opts) return;

    const nextId = opts.id ? String(opts.id) : '';
    const nextKey = resolveDedupeKey(opts);

    if (entry.id !== nextId || entry.dedupeKey !== nextKey) {
      clearLocalEntryBinding(entry);
    }

    entry.id = nextId;
    entry.dedupeKey = nextKey;
    entry.closed = false;
    entry.removing = false;
    entry.icon.textContent = iconForKind(opts.kind);
    entry.text.textContent = opts.message;
    entry.el.className = 'toast toast-' + opts.kind;
    entry.el.dataset.kind = opts.kind;
    entry.el.style.opacity = '';
    entry.el.style.transform = '';
    entry.el.setAttribute('role', opts.kind === 'error' ? 'alert' : 'status');
    entry.el.setAttribute('aria-live', opts.kind === 'error' ? 'assertive' : 'polite');

    if (entry.id) LOCAL_ACTIVE.set(entry.id, entry);
    if (entry.dedupeKey) LOCAL_ACTIVE_BY_KEY.set(entry.dedupeKey, entry);
  }

  function showLocalToast(opts) {
    const container = ensureContainer();
    if (!container || !opts || !opts.message) return null;

    const dedupeKey = resolveDedupeKey(opts);
    let entry = null;

    if (opts.id) {
      entry = LOCAL_ACTIVE.get(opts.id) || null;
      if (entry && opts.replace === false) {
        closeLocalToast(entry);
        entry = null;
      }
    } else {
      entry = LOCAL_ACTIVE_BY_KEY.get(dedupeKey) || null;
    }

    if (!entry && !opts.id && isLocalRecentDuplicate(dedupeKey, opts.dedupeWindowMs)) {
      return null;
    }

    if (!entry) entry = createLocalEntry(container);

    bindLocalEntry(entry, Object.assign({}, opts, { dedupeKey }));
    rememberLocalRecent(dedupeKey);
    armLocalTimer(entry, opts.duration, opts.sticky);
    return entry.el;
  }

  function dismissLocalToast(idOrKey) {
    if (!idOrKey) return false;
    const key = String(idOrKey);
    const entry = LOCAL_ACTIVE.get(key) || LOCAL_ACTIVE_BY_KEY.get(key);
    if (!entry) return false;
    closeLocalToast(entry);
    return true;
  }

  function isLocalToastActive(idOrKey) {
    if (!idOrKey) return false;
    const key = String(idOrKey);
    return !!(LOCAL_ACTIVE.get(key) || LOCAL_ACTIVE_BY_KEY.get(key));
  }

  function clearLocalToasts() {
    const values = Array.from(new Set([].concat(Array.from(LOCAL_ACTIVE.values()), Array.from(LOCAL_ACTIVE_BY_KEY.values()))));
    values.forEach((entry) => closeLocalToast(entry));

    try {
      const container = document.getElementById('toast-container');
      if (container) {
        Array.from(container.children).forEach((node) => {
          try { node.remove(); } catch (error) {}
        });
      }
    } catch (error) {}

    try { LOCAL_ACTIVE.clear(); } catch (error) {}
    try { LOCAL_ACTIVE_BY_KEY.clear(); } catch (error) {}
    try { LOCAL_RECENT.clear(); } catch (error) {}
  }

  function showToast(message, kindOrOptions = false) {
    const opts = normalizeOptions(message, kindOrOptions);
    if (!opts.message) return null;

    if (ensureStoreBinding()) {
      const api = getUiToastApi();
      if (!api) return null;
      const entry = api.enqueue(opts, { source: 'toast' });
      if (!entry || !entry.uid) return null;
      const rendered = RENDERED.get(entry.uid);
      return rendered && rendered.el ? rendered.el : null;
    }

    return showLocalToast(opts);
  }

  function dismissToast(idOrKey) {
    if (!idOrKey) return false;

    if (ensureStoreBinding()) {
      const api = getUiToastApi();
      if (!api) return false;
      return !!api.dismiss(String(idOrKey), { source: 'toast' });
    }

    return dismissLocalToast(idOrKey);
  }

  function isToastActive(idOrKey) {
    if (!idOrKey) return false;

    if (ensureStoreBinding()) {
      const api = getUiToastApi();
      if (!api) return false;
      return !!api.isActive(String(idOrKey));
    }

    return isLocalToastActive(idOrKey);
  }

  function clearToasts() {
    if (ensureStoreBinding()) {
      const api = getUiToastApi();
      if (!api) return;
      api.clear({ source: 'toast' });
      renderToastQueue([]);
      return;
    }

    clearLocalToasts();
  }

  showToast.dismiss = dismissToast;
  showToast.clear = clearToasts;
  showToast.isActive = isToastActive;
  showToast.normalizeKind = normalizeKind;

  XK.ui.showToast = showToast;
  XK.ui.toast = showToast;
  XK.ui.notify = showToast;
  XK.ui.dismissToast = dismissToast;
  XK.ui.clearToasts = clearToasts;
  XK.ui.isToastActive = isToastActive;
  window.showToast = showToast;
  window.toast = showToast;

  ensureStoreBinding();
})();

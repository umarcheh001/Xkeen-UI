(() => {
  'use strict';

  window.XKeen = window.XKeen || {};
  XKeen.ui = XKeen.ui || {};

  const ACTIVE = new Map();
  const RECENT = new Map();
  const DEFAULT_DURATION = {
    success: 3200,
    info: 3200,
    warning: 4200,
    error: 4200,
  };

  function ensureContainer() {
    let container = document.getElementById('toast-container');
    if (container) return container;

    try {
      container = document.createElement('div');
      container.id = 'toast-container';
      document.body.appendChild(container);
    } catch (e) {
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
        return '⚠️';
      case 'info':
        return 'ℹ️';
      case 'warning':
        return '⚠️';
      default:
        return '✅';
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
      sticky: !!opts.sticky,
      id: opts.id ? String(opts.id) : '',
      dedupeWindowMs: Number.isFinite(Number(opts.dedupeWindowMs)) ? Math.max(0, Number(opts.dedupeWindowMs)) : 600,
      replace: opts.replace !== false,
    };
  }

  function closeToast(entry) {
    if (!entry || !entry.el) return;

    try {
      if (entry.timer) clearTimeout(entry.timer);
    } catch (e) {}

    try {
      entry.el.style.opacity = '0';
      entry.el.style.transform = 'translateY(4px)';
    } catch (e2) {}

    setTimeout(() => {
      try { entry.el.remove(); } catch (e3) {}
    }, 200);

    try {
      if (entry.id) ACTIVE.delete(entry.id);
    } catch (e4) {}
  }

  function armTimer(entry, duration, sticky) {
    try {
      if (entry.timer) clearTimeout(entry.timer);
    } catch (e) {}

    if (sticky || duration <= 0) {
      entry.timer = null;
      return;
    }

    entry.timer = setTimeout(() => closeToast(entry), duration);
  }

  function rememberRecent(key) {
    if (!key) return;
    try { RECENT.set(key, Date.now()); } catch (e) {}
  }

  function recentDuplicate(key, windowMs) {
    if (!key) return false;
    try {
      const prev = Number(RECENT.get(key) || 0);
      if (!prev) return false;
      return (Date.now() - prev) < Math.max(0, Number(windowMs || 0));
    } catch (e) {
      return false;
    }
  }

  // Back-compat:
  // - legacy code often calls showToast(msg, true/false)
  // - some newer code calls showToast(msg, 'info'|'success'|'error')
  // - new code may pass an options object
  function showToast(message, kindOrOptions = false) {
    const container = ensureContainer();
    if (!container) return null;

    const opts = normalizeOptions(message, kindOrOptions);
    if (!opts.message) return null;

    const dedupeKey = opts.id || (opts.kind + '|' + opts.message);
    if (!opts.id && recentDuplicate(dedupeKey, opts.dedupeWindowMs)) {
      return null;
    }
    rememberRecent(dedupeKey);

    let entry = opts.id ? ACTIVE.get(opts.id) : null;
    const isReplace = !!(entry && opts.replace);

    if (!entry || !isReplace) {
      const toast = document.createElement('div');
      toast.className = 'toast toast-' + opts.kind;
      toast.dataset.kind = opts.kind;
      toast.setAttribute('role', opts.kind === 'error' ? 'alert' : 'status');
      toast.setAttribute('aria-live', opts.kind === 'error' ? 'assertive' : 'polite');

      const icon = document.createElement('div');
      icon.className = 'toast-icon';

      const text = document.createElement('div');
      text.className = 'toast-message';

      toast.appendChild(icon);
      toast.appendChild(text);
      container.appendChild(toast);

      entry = {
        id: opts.id,
        el: toast,
        icon,
        text,
        timer: null,
      };
    }

    entry.icon.textContent = iconForKind(opts.kind);
    entry.text.textContent = opts.message;
    entry.el.className = 'toast toast-' + opts.kind;
    entry.el.dataset.kind = opts.kind;
    entry.el.style.opacity = '';
    entry.el.style.transform = '';

    if (opts.id) ACTIVE.set(opts.id, entry);
    armTimer(entry, opts.duration, opts.sticky);
    return entry.el;
  }

  function dismissToast(id) {
    if (!id) return false;
    const entry = ACTIVE.get(String(id));
    if (!entry) return false;
    closeToast(entry);
    return true;
  }

  function clearToasts() {
    const values = Array.from(ACTIVE.values());
    values.forEach((entry) => closeToast(entry));

    try {
      const container = document.getElementById('toast-container');
      if (container) {
        Array.from(container.children).forEach((node) => {
          try { node.remove(); } catch (e) {}
        });
      }
    } catch (e) {}

    try { ACTIVE.clear(); } catch (e2) {}
    try { RECENT.clear(); } catch (e3) {}
  }

  showToast.dismiss = dismissToast;
  showToast.clear = clearToasts;
  showToast.normalizeKind = normalizeKind;

  XKeen.ui.showToast = showToast;
  XKeen.ui.toast = showToast;
  XKeen.ui.notify = showToast;
  window.showToast = showToast;
  window.toast = showToast;
})();

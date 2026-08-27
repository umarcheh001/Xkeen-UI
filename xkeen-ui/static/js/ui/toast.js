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
    try {
      if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
      }
      // The panel template historically placed the toast portal inside
      // .container-wide, which owns a z-index stacking context. Most static
      // modals share that context, but runtime workbenches (notably Xray
      // subscriptions) are appended directly to body and therefore cover the
      // whole container, regardless of the toast's near-maximum z-index.
      // Keep the portal at the document root so its global layer is real.
      if (container.parentElement !== document.body) {
        document.body.appendChild(container);
      }
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

  // Sprite icon names mirror the operator console vocabulary: a toast icon and
  // a button icon must be the same Tabler glyph at the same weight.
  const SPRITE_URL = '/static/icons/operator.svg?v=20260822a';

  const ICON_NAME_BY_KIND = {
    success: 'check',
    info: 'info',
    warning: 'alert',
    error: 'alert',
  };

  function iconNameForKind(kind) {
    return ICON_NAME_BY_KIND[normalizeKind(kind)] || 'info';
  }

  function iconHrefForKind(kind) {
    const name = iconNameForKind(kind);
    try {
      const icons = XK.ui && XK.ui.operatorIcons;
      if (icons && typeof icons.href === 'function') return icons.href(name);
    } catch (error) {}
    return SPRITE_URL + '#xk-' + name;
  }

  function setEntryIcon(entry, kind) {
    if (!entry || !entry.iconUse) return;
    const href = iconHrefForKind(kind);
    if (entry.iconHref === href) return;
    entry.iconHref = href;
    try {
      entry.iconUse.setAttribute('href', href);
      entry.iconUse.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', href);
    } catch (error) {}
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

    // Errors stay until the reader dismisses them: they usually carry the only
    // explanation for a failed action, and a 4-second window is not enough to
    // read a router CLI dump. Callers can still pass an explicit duration.
    const explicitDuration = Number.isFinite(Number(opts.durationMs)) || Number.isFinite(Number(opts.duration));
    const sticky = !!(opts.sticky || opts.persist || opts.persistent) || (kind === 'error' && !explicitDuration);

    return {
      message: String(msg ?? ''),
      detail: String(opts.detail ?? opts.details ?? ''),
      kind,
      duration,
      sticky,
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

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const COPY_LABEL = 'Копировать';
  const COPIED_LABEL = 'Скопировано';

  function makeSpriteIcon(className, href) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', className);
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');

    const use = document.createElementNS(SVG_NS, 'use');
    if (href) {
      use.setAttribute('href', href);
      try { use.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', href); } catch (error) {}
    }
    svg.appendChild(use);
    return { svg, use };
  }

  function playEntrance(el) {
    if (!el) return;
    try {
      el.dataset.entering = '1';
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          try { delete el.dataset.entering; } catch (error) {}
        });
      });
    } catch (error) {
      try { delete el.dataset.entering; } catch (inner) {}
    }
  }

  // The life bar is the only moving part of a toast: it shows the reader that
  // the message leaves on its own, so an auto-dismiss never looks like a
  // glitch. Sticky toasts (every error) render no bar.
  function startLife(entry, duration) {
    if (!entry || !entry.life) return;
    const ms = Math.max(0, Number(duration || 0));

    if (!ms) {
      entry.life.hidden = true;
      entry.life.style.transition = 'none';
      entry.life.style.width = '100%';
      return;
    }

    entry.life.hidden = false;
    entry.life.style.transition = 'none';
    entry.life.style.width = '100%';

    try {
      void entry.life.offsetWidth;
      entry.life.style.transition = 'width ' + ms + 'ms linear';
      entry.life.style.width = '0%';
    } catch (error) {}
  }

  function resetCopyLabel(entry) {
    if (!entry || !entry.copyBtn) return;
    try {
      if (entry.copyResetTimer) clearTimeout(entry.copyResetTimer);
    } catch (error) {}
    entry.copyResetTimer = null;
    entry.copyBtn.textContent = COPY_LABEL;
  }

  function copyEntryText(entry) {
    if (!entry || !entry.copyBtn) return;
    const payload = String(entry.copyText || '');
    if (!payload) return;

    const markCopied = () => {
      try {
        entry.copyBtn.textContent = COPIED_LABEL;
        if (entry.copyResetTimer) clearTimeout(entry.copyResetTimer);
        entry.copyResetTimer = setTimeout(() => resetCopyLabel(entry), 1600);
      } catch (error) {}
    };

    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        navigator.clipboard.writeText(payload).then(markCopied, () => legacyCopy(payload, markCopied));
        return;
      }
    } catch (error) {}

    legacyCopy(payload, markCopied);
  }

  function legacyCopy(payload, onDone) {
    try {
      const area = document.createElement('textarea');
      area.value = payload;
      area.setAttribute('readonly', 'readonly');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
      if (typeof onDone === 'function') onDone();
    } catch (error) {}
  }

  // One dismiss path for both render modes: store-backed toasts go through the
  // store so its queue stays authoritative, local ones close directly.
  function dismissEntry(entry) {
    if (!entry) return;

    if (entry.uid) {
      const api = getUiToastApi();
      if (api) {
        try {
          api.dismiss(entry.uid, { source: 'toast_close' });
          return;
        } catch (error) {}
      }
    }

    closeLocalToast(entry);
  }

  function applyEntryContent(entry, data) {
    if (!entry || !data) return;

    const kind = normalizeKind(data.kind);
    const message = String(data.message || '');
    const detail = String(data.detail || '').trim();
    const sticky = !!data.sticky || Math.max(0, Number(data.duration || 0)) <= 0;

    entry.el.className = 'toast toast-' + kind;
    entry.el.dataset.kind = kind;
    setEntryIcon(entry, kind);

    entry.text.textContent = message;
    entry.detail.textContent = detail;
    entry.detail.hidden = !detail;
    entry.actions.hidden = !detail;
    entry.copyText = detail ? message + '\n' + detail : message;
    resetCopyLabel(entry);

    // A toast that never expires must be closable, and an error is always
    // worth a close affordance even while its timer runs.
    entry.close.hidden = !(sticky || kind === 'error');

    entry.el.style.opacity = '';
    entry.el.style.transform = '';
    entry.el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    entry.el.setAttribute('aria-live', kind === 'error' ? 'assertive' : 'polite');
  }

  function createRenderedEntry(container) {
    const toast = document.createElement('div');
    toast.className = 'toast toast-success';
    toast.dataset.kind = 'success';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');

    const iconParts = makeSpriteIcon('toast-icon', iconHrefForKind('success'));

    const body = document.createElement('div');
    body.className = 'toast-body';

    const text = document.createElement('div');
    text.className = 'toast-message';

    const detail = document.createElement('div');
    detail.className = 'toast-detail';
    detail.hidden = true;

    const actions = document.createElement('div');
    actions.className = 'toast-actions';
    actions.hidden = true;

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'toast-copy';
    copyBtn.textContent = COPY_LABEL;
    actions.appendChild(copyBtn);

    body.appendChild(text);
    body.appendChild(detail);
    body.appendChild(actions);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'toast-close';
    close.hidden = true;
    close.setAttribute('aria-label', 'Закрыть');
    close.appendChild(makeSpriteIcon('', SPRITE_URL + '#xk-close').svg);

    const life = document.createElement('span');
    life.className = 'toast-life';
    life.hidden = true;

    toast.appendChild(iconParts.svg);
    toast.appendChild(body);
    toast.appendChild(close);
    toast.appendChild(life);
    container.appendChild(toast);

    const entry = {
      uid: '',
      el: toast,
      icon: iconParts.svg,
      iconUse: iconParts.use,
      iconHref: iconHrefForKind('success'),
      text,
      detail,
      actions,
      copyBtn,
      copyText: '',
      copyResetTimer: null,
      close,
      life,
      timer: null,
      removeTimer: null,
      renderToken: '',
      removing: false,
    };

    copyBtn.addEventListener('click', () => copyEntryText(entry));
    close.addEventListener('click', () => dismissEntry(entry));
    playEntrance(toast);

    return entry;
  }

  function syncRenderedEntry(entry, toastState, api) {
    if (!entry || !toastState) return;

    if (entry.removeTimer) {
      try { clearTimeout(entry.removeTimer); } catch (error) {}
      entry.removeTimer = null;
    }

    entry.uid = String(toastState.uid || '');
    entry.removing = false;
    applyEntryContent(entry, toastState);

    const renderToken = [
      toastState.updatedAt,
      toastState.kind,
      toastState.message,
      toastState.detail,
      toastState.duration,
      toastState.sticky,
    ].join('|');

    if (entry.renderToken === renderToken) return;
    entry.renderToken = renderToken;
    clearRenderedTimer(entry);

    if (toastState.sticky || Number(toastState.duration || 0) <= 0) {
      startLife(entry, 0);
      return;
    }

    startLife(entry, toastState.duration);

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
      if (entry.copyResetTimer) clearTimeout(entry.copyResetTimer);
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
      startLife(entry, 0);
      return;
    }

    startLife(entry, duration);
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
    applyEntryContent(entry, opts);

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

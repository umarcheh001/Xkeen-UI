// Branding preferences (header title, logo, favicon, tab renaming)
// Stored globally on the router (UI_STATE_DIR/branding.json) and cached in localStorage.
(() => {
  'use strict';

  window.XKeen = window.XKeen || {};
  const XK = window.XKeen;
  XK.ui = XK.ui || {};

  // Cache key (populated from /ui/branding.json)
  const KEY = 'xkeen-branding-cache-v1';
  // Legacy key (older builds stored branding locally)
  const LEGACY_KEY = 'xkeen-branding-v1';

  const REMOTE_URL = '/ui/branding.json';
  const API_SET = '/api/devtools/branding';
  const API_RESET = '/api/devtools/branding/reset';

  const DEFAULTS = Object.freeze({
    title: '',
    logoSrc: '',    // URL or data: URI
    faviconSrc: '', // URL or data: URI
    tabRename: {},  // { 'view:mihomo': 'Proxy', ... }
  });

  function _str(v, defVal) {
    return (typeof v === 'string') ? v : (defVal || '');
  }

  function _trim(v) {
    return String(v || '').trim();
  }

  function _obj(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    return v;
  }

  function normalize(rawObj) {
    const o = _obj(rawObj);
    const tab = _obj(o.tabRename);

    const tabRename = {};
    try {
      for (const k of Object.keys(tab)) {
        const key = _trim(k);
        const val = _trim(tab[k]);
        if (!key) continue;
        if (!val) continue;
        tabRename[key] = val;
      }
    } catch (e) {}

    return {
      title: _trim(_str(o.title, DEFAULTS.title)),
      logoSrc: _trim(_str(o.logoSrc, DEFAULTS.logoSrc)),
      faviconSrc: _trim(_str(o.faviconSrc, DEFAULTS.faviconSrc)),
      tabRename,
    };
  }

  function load() {
    // Sync load from cache for immediate UI (then we refresh from router asynchronously).
    let raw = null;
    try { raw = localStorage.getItem(KEY); } catch (e) {}
    if (!raw) {
      // Backward compat
      try { raw = localStorage.getItem(LEGACY_KEY); } catch (e) {}
    }
    if (!raw) return normalize(DEFAULTS);
    try {
      return normalize(JSON.parse(raw));
    } catch (e) {
      return normalize(DEFAULTS);
    }
  }

  function _saveCache(prefs) {
    try { localStorage.setItem(KEY, JSON.stringify(normalize(prefs || {}))); } catch (e) {}
    // Best-effort cleanup (legacy)
    try { localStorage.removeItem(LEGACY_KEY); } catch (e) {}
  }

  async function fetchRemote() {
    if (!window.fetch) return null;
    try {
      const url = REMOTE_URL + (REMOTE_URL.includes('?') ? '&' : '?') + 'ts=' + Date.now();
      const r = await fetch(url, { method: 'GET', cache: 'no-store' });
      if (!r || !r.ok) return null;
      const j = await r.json();
      if (!j || typeof j !== 'object') return null;
      const cfg = j.config || j;
      return normalize(cfg);
    } catch (e) {
      return null;
    }
  }

  async function refreshFromRouter() {
    const cfg = await fetchRemote();
    if (!cfg) return null;
    _saveCache(cfg);
    apply(cfg);
    return cfg;
  }

  async function save(prefs) {
    // Persist on router (requires auth + CSRF), then update cache.
    const cfg = normalize(prefs || {});

    if (!window.fetch) {
      _saveCache(cfg);
      apply(cfg);
      return { ok: true, config: cfg, mode: 'cache_only' };
    }

    try {
      const r = await fetch(API_SET, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: cfg }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j || j.ok === false) {
        throw new Error((j && j.error) ? String(j.error) : 'save_failed');
      }
      const saved = normalize((j && j.config) ? j.config : cfg);
      _saveCache(saved);
      apply(saved);
      return { ok: true, config: saved, version: j.version || 0, mode: 'router' };
    } catch (e) {
      // Fall back to cache so the user still sees the change in the current browser.
      _saveCache(cfg);
      apply(cfg);
      return { ok: false, error: (e && e.message) ? e.message : String(e), config: cfg, mode: 'cache_fallback' };
    }
  }

  async function reset() {
    if (!window.fetch) {
      try { localStorage.removeItem(KEY); } catch (e) {}
      try { localStorage.removeItem(LEGACY_KEY); } catch (e) {}
      apply(normalize(DEFAULTS));
      return { ok: true, mode: 'cache_only' };
    }

    try {
      const r = await fetch(API_RESET, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j || j.ok === false) {
        throw new Error((j && j.error) ? String(j.error) : 'reset_failed');
      }
      const cfg = normalize((j && j.config) ? j.config : DEFAULTS);
      try { localStorage.removeItem(KEY); } catch (e) {}
      try { localStorage.removeItem(LEGACY_KEY); } catch (e) {}
      _saveCache(cfg);
      apply(cfg);
      return { ok: true, config: cfg, mode: 'router' };
    } catch (e) {
      try { localStorage.removeItem(KEY); } catch (e2) {}
      try { localStorage.removeItem(LEGACY_KEY); } catch (e2) {}
      apply(normalize(DEFAULTS));
      return { ok: false, error: (e && e.message) ? e.message : String(e), mode: 'cache_fallback' };
    }
  }

  function applyFavicon(src) {
    const href = _trim(src);
    if (!href) return;

    try {
      const head = document.head || document.getElementsByTagName('head')[0];
      if (!head) return;

      // Update existing icons
      const links = Array.from(document.querySelectorAll(
        'link[rel="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]'
      ));
      links.forEach((l) => {
        try { l.href = href; } catch (e) {}
      });

      // Ensure at least one icon link exists (some pages may lack it)
      let el = document.getElementById('xk-brand-favicon');
      if (!el) {
        el = document.createElement('link');
        el.id = 'xk-brand-favicon';
        el.rel = 'icon';
        head.appendChild(el);
      }
      try { el.href = href; } catch (e) {}
    } catch (e) {}
  }

  function applyDocumentTitle(brandTitle) {
    const t = _trim(brandTitle);
    if (!t) return;
    try {
      const cur = String(document.title || '');
      if (!cur) {
        document.title = t;
        return;
      }

      if (cur.includes('Xkeen UI')) {
        document.title = cur.replace('Xkeen UI', t);
        return;
      }

      // fallback: prefix
      document.title = t + ' — ' + cur;
    } catch (e) {}
  }

  function applyHeaderTitle(brandTitle) {
    const t = _trim(brandTitle);
    if (!t) return;

    const els = [];
    try {
      const idEl = document.getElementById('xk-brand-title');
      if (idEl) els.push(idEl);
    } catch (e) {}

    try {
      document.querySelectorAll('[data-xk-brand-title]').forEach((el) => els.push(el));
    } catch (e) {}

    els.forEach((el) => {
      try { el.textContent = t; } catch (e) {}
    });
  }

  function applyLogo(src) {
    const href = _trim(src);

    const els = [];
    try {
      const idEl = document.getElementById('xk-brand-logo');
      if (idEl) els.push(idEl);
    } catch (e) {}

    try {
      document.querySelectorAll('[data-xk-brand-logo]').forEach((el) => els.push(el));
    } catch (e) {}

    els.forEach((el) => {
      if (!el) return;
      try {
        if (href) {
          el.src = href;
          el.alt = el.alt || 'Logo';
          el.classList.remove('hidden');
          el.style.display = 'inline-block';
        } else {
          el.src = '';
          el.classList.add('hidden');
          el.style.display = 'none';
        }
      } catch (e) {}
    });
  }

  function tabKey(btn) {
    try {
      if (XK.ui && XK.ui.layout && typeof XK.ui.layout.tabKey === 'function') {
        return XK.ui.layout.tabKey(btn);
      }
    } catch (e) {}

    try {
      if (btn && btn.dataset && btn.dataset.view) return 'view:' + String(btn.dataset.view);
    } catch (e) {}

    try {
      if (btn && btn.id) return 'id:' + String(btn.id);
    } catch (e) {}

    return '';
  }

  function applyTabRename(map) {
    const mp = _obj(map);
    const container = document.querySelector('.top-tabs.header-tabs');
    if (!container) return;

    const btns = Array.from(container.querySelectorAll('.top-tab-btn'));
    btns.forEach((btn) => {
      const k = tabKey(btn);
      if (!k) return;
      const raw = mp[k];
      if (typeof raw !== 'string') return;
      const next = _trim(raw);
      if (!next) return;

      try {
        if (btn.dataset && !btn.dataset.xkDefaultLabel) {
          btn.dataset.xkDefaultLabel = _trim(btn.textContent || '');
        }
      } catch (e) {}

      try { btn.textContent = next; } catch (e) {}
    });
  }

  function labelForTabKey(key, fallbackLabel) {
    const p = load();
    const mp = p && p.tabRename ? p.tabRename : {};
    const v = (mp && mp[key]) ? _trim(mp[key]) : '';
    return v || String(fallbackLabel || '');
  }

  function apply(prefs) {
    const p = normalize(prefs || load());

    // Apply things that affect the page head ASAP.
    try { applyFavicon(p.faviconSrc || ''); } catch (e) {}
    try { applyDocumentTitle(p.title || ''); } catch (e) {}

    const domApply = () => {
      try { applyHeaderTitle(p.title || ''); } catch (e) {}
      try { applyLogo(p.logoSrc || ''); } catch (e) {}
      try { applyTabRename(p.tabRename || {}); } catch (e) {}
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', domApply, { once: true });
    } else {
      domApply();
    }
  }

  function init() {
    // Apply cached values immediately, then refresh from router.
    apply(load());
    try { refreshFromRouter(); } catch (e) {}

    // Sync across tabs/windows
    try {
      window.addEventListener('storage', (ev) => {
        if (!ev) return;
        if (ev.key !== KEY) return;
        apply(load());
      });
    } catch (e) {}
  }

  XK.ui.branding = {
    KEY,
    LEGACY_KEY,
    DEFAULTS,
    load,
    save,
    reset,
    apply,
    fetchRemote,
    refreshFromRouter,
    applyFavicon,
    applyDocumentTitle,
    labelForTabKey,
  };

  // Apply ASAP (head scripts run before DOMContentLoaded)
  try { init(); } catch (e) {}
})();

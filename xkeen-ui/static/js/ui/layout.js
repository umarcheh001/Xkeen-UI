// Layout preferences (compact spacing, hints visibility, container width, tab ordering)
// Applies settings via <html data-*> attributes + CSS variables.
// Also wires drag&drop reordering for main panel top tabs.
(() => {
  'use strict';

  window.XKeen = window.XKeen || {};
  const XK = window.XKeen;
  XK.ui = XK.ui || {};

  const KEY = 'xkeen-layout-v1';

  const DEFAULTS = Object.freeze({
    compact: false,
    hideHints: false,
    // Hide helper/description texts inside cards (e.g. inbounds mode explanations).
    hideCardDesc: false,
    // Hide File Manager bottom hotkeys hints bar.
    hideFmHotkeys: false,
    // Scale for card description texts (multiplier, 1 = default)
    cardDescScale: 1,
    hideUnused: false,
    // fixed | fluid | max
    container: 'fluid',
    // Tab ordering is persisted as stable keys (see tabKey())
    tabOrder: [],
    tabFav: [],
  });

  function _num(v, def) {
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
  }

  function _clamp(n, lo, hi) {
    const x = _num(n, lo);
    return Math.max(lo, Math.min(hi, x));
  }

  function _bool(v, def) {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'string') {
      const s = v.trim().toLowerCase();
      if (['1', 'true', 'yes', 'on'].includes(s)) return true;
      if (['0', 'false', 'no', 'off'].includes(s)) return false;
    }
    if (typeof v === 'number') return !!v;
    return !!def;
  }

  function _str(v, def) {
    return (typeof v === 'string' && v.trim()) ? v.trim() : def;
  }

  function _arr(v) {
    return Array.isArray(v) ? v.filter(Boolean).map(String) : [];
  }

  function load() {
    let raw = null;
    try { raw = localStorage.getItem(KEY); } catch (e) {}
    if (!raw) return { ...DEFAULTS };
    try {
      const obj = JSON.parse(raw);
      const container = _str(obj.container, DEFAULTS.container);
      const safeContainer = ['fixed', 'fluid', 'max'].includes(container) ? container : DEFAULTS.container;
      const descScale = _clamp(obj.cardDescScale, 0.7, 1.6);
      return {
        compact: _bool(obj.compact, DEFAULTS.compact),
        hideHints: _bool(obj.hideHints, DEFAULTS.hideHints),
        hideCardDesc: _bool(obj.hideCardDesc, DEFAULTS.hideCardDesc),
        hideFmHotkeys: _bool(obj.hideFmHotkeys, DEFAULTS.hideFmHotkeys),
        cardDescScale: descScale,
        hideUnused: _bool(obj.hideUnused, DEFAULTS.hideUnused),
        container: safeContainer,
        tabOrder: _arr(obj.tabOrder),
        tabFav: _arr(obj.tabFav),
      };
    } catch (e) {
      return { ...DEFAULTS };
    }
  }

  function save(prefs) {
    try { localStorage.setItem(KEY, JSON.stringify(prefs || {})); } catch (e) {}
  }

  function reset() {
    try { localStorage.removeItem(KEY); } catch (e) {}
    apply({ ...DEFAULTS });
  }

  function apply(prefs) {
    const p = prefs || load();
    const root = document.documentElement;

    try {
      root.dataset.xkCompact = p.compact ? '1' : '0';
      root.dataset.xkHideHints = p.hideHints ? '1' : '0';
      root.dataset.xkHideCardDesc = p.hideCardDesc ? '1' : '0';
      root.dataset.xkHideFmHotkeys = p.hideFmHotkeys ? '1' : '0';
      root.dataset.xkHideUnused = p.hideUnused ? '1' : '0';
      root.dataset.xkContainer = String(p.container || DEFAULTS.container);
    } catch (e) {}

    // Card description scale
    try {
      const s = _clamp(p.cardDescScale, 0.7, 1.6);
      root.style.setProperty('--xk-card-desc-scale', String(s));
    } catch (e) {}

    // CSS variables (for container widths)
    try {
      let mw = 'min(1600px, 96vw)';
      if (p.container === 'fixed') mw = '960px';
      else if (p.container === 'max') mw = '98vw';
      root.style.setProperty('--xk-container-max-width', mw);
    } catch (e) {}

    try {
      document.dispatchEvent(new CustomEvent('xkeen-layout-change', { detail: { ...p } }));
    } catch (e) {}
  }

  function tabKey(btn) {
    if (!btn) return '';
    try {
      if (btn.dataset && btn.dataset.xkTabKey) return String(btn.dataset.xkTabKey);
    } catch (e) {}
    try {
      if (btn.dataset && btn.dataset.view) return 'view:' + String(btn.dataset.view);
    } catch (e) {}
    try {
      if (btn.id) return 'id:' + String(btn.id);
    } catch (e) {}
    try {
      const t = (btn.textContent || '').trim();
      if (t) return 'text:' + t;
    } catch (e) {}
    return '';
  }

  function _uniq(list) {
    const out = [];
    const seen = new Set();
    (list || []).forEach((k) => {
      const key = String(k || '');
      if (!key || seen.has(key)) return;
      seen.add(key);
      out.push(key);
    });
    return out;
  }

  function normalizeTabs(prefs, allKeys) {
    const p = prefs || load();
    const keys = Array.isArray(allKeys) ? allKeys : [];
    const have = new Set(keys);

    const order = _uniq(_arr(p.tabOrder)).filter(k => have.has(k));
    const fav = _uniq(_arr(p.tabFav)).filter(k => have.has(k));

    // Ensure every existing key is in order.
    keys.forEach((k) => { if (!order.includes(k)) order.push(k); });

    // Ensure fav keys are also present in order.
    fav.forEach((k) => { if (!order.includes(k)) order.unshift(k); });

    return { ...p, tabOrder: order, tabFav: fav };
  }

  function applyTabsNow() {
    const container = document.querySelector('.top-tabs.header-tabs');
    if (!container) return;

    const buttons = Array.from(container.querySelectorAll('.top-tab-btn'));
    if (!buttons.length) return;

    const keys = buttons.map(tabKey).filter(Boolean);
    const prefs = normalizeTabs(load(), keys);

    // Save normalized state (keeps new tabs stable)
    try { save(prefs); } catch (e) {}

    const byKey = new Map();
    buttons.forEach((b) => {
      const k = tabKey(b);
      if (k) byKey.set(k, b);
    });

    // Build final order: favorites first, then the rest.
    const favSet = new Set(prefs.tabFav || []);
    const favInOrder = (prefs.tabOrder || []).filter(k => favSet.has(k));
    const nonFavInOrder = (prefs.tabOrder || []).filter(k => !favSet.has(k));
    const finalKeys = [...favInOrder, ...nonFavInOrder];

    // Apply DOM order
    finalKeys.forEach((k) => {
      const el = byKey.get(k);
      if (el) container.appendChild(el);
    });

    // Visual marker for favorites
    buttons.forEach((b) => {
      const k = tabKey(b);
      b.classList.toggle('xk-tab-fav', !!(k && favSet.has(k)));
      // Drag affordance
      try { b.setAttribute('draggable', 'true'); } catch (e) {}
    });
  }

  function persistDomTabOrder(container) {
    if (!container) return;
    const btns = Array.from(container.querySelectorAll('.top-tab-btn'));
    const order = btns.map(tabKey).filter(Boolean);
    const prefs = load();
    const next = { ...prefs, tabOrder: _uniq(order) };
    save(next);
    apply(next);
  }

  function wireTabsDnD() {
    const container = document.querySelector('.top-tabs.header-tabs');
    if (!container) return;
    if (container.dataset && container.dataset.xkTabsDnd === '1') return;
    if (container.dataset) container.dataset.xkTabsDnd = '1';

    let dragKey = '';

    function closestBtn(target) {
      try {
        return target ? target.closest('.top-tab-btn') : null;
      } catch (e) {
        return null;
      }
    }

    container.addEventListener('dragstart', (e) => {
      const btn = closestBtn(e.target);
      if (!btn) return;
      dragKey = tabKey(btn);
      try {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', dragKey);
      } catch (err) {}
      btn.classList.add('xk-tab-dragging');
    });

    container.addEventListener('dragend', () => {
      dragKey = '';
      container.querySelectorAll('.top-tab-btn.xk-tab-dragging').forEach((b) => b.classList.remove('xk-tab-dragging'));
      container.querySelectorAll('.top-tab-btn.xk-tab-drop').forEach((b) => b.classList.remove('xk-tab-drop'));
    });

    container.addEventListener('dragover', (e) => {
      if (!dragKey) return;
      const over = closestBtn(e.target);
      if (!over) return;
      e.preventDefault();
      container.querySelectorAll('.top-tab-btn.xk-tab-drop').forEach((b) => {
        if (b !== over) b.classList.remove('xk-tab-drop');
      });
      over.classList.add('xk-tab-drop');
      try { e.dataTransfer.dropEffect = 'move'; } catch (err) {}
    });

    container.addEventListener('dragleave', (e) => {
      const over = closestBtn(e.target);
      if (over) over.classList.remove('xk-tab-drop');
    });

    container.addEventListener('drop', (e) => {
      const targetBtn = closestBtn(e.target);
      if (!targetBtn) return;
      e.preventDefault();
      const srcKey = (() => {
        try {
          const k = e.dataTransfer.getData('text/plain');
          return k || dragKey;
        } catch (err) {
          return dragKey;
        }
      })();
      if (!srcKey) return;

      const btns = Array.from(container.querySelectorAll('.top-tab-btn'));
      const srcBtn = btns.find((b) => tabKey(b) === srcKey);
      if (!srcBtn || srcBtn === targetBtn) return;

      const rect = targetBtn.getBoundingClientRect();
      const before = (e.clientX - rect.left) < rect.width / 2;
      if (before) container.insertBefore(srcBtn, targetBtn);
      else container.insertBefore(srcBtn, targetBtn.nextSibling);

      persistDomTabOrder(container);
    });
  }

  // Best-effort “hide unused tabs/cards” based on backend feature flags.
  // Currently: hide Files tab if RemoteFS is disabled (XKEEN_REMOTEFM_ENABLE=0)
  // or unsupported (e.g., missing lftp), when the user enabled the toggle.
  async function applyHideUnusedNow() {
    const prefs = load();
    if (!prefs.hideUnused) return;

    const filesTab = document.getElementById('top-tab-files');
    const filesView = document.getElementById('view-files');
    if (!filesTab && !filesView) return;

    try {
      const resp = await fetch('/api/capabilities', { cache: 'no-store' });
      if (!resp.ok) return;
      const data = await resp.json().catch(() => ({}));
      const rf = (data && data.remoteFs) ? data.remoteFs : {};
      const enabled = !!rf.enabled;
      const supported = !!rf.supported;
      const hideFiles = !(enabled && supported);

      if (filesTab) {
        // Hide with a hard style to avoid other modules re-showing it.
        filesTab.style.display = hideFiles ? 'none' : '';
        filesTab.dataset.xkForceHidden = hideFiles ? '1' : '0';
      }
      if (filesView) {
        filesView.dataset.xkForceHidden = hideFiles ? '1' : '0';
        if (hideFiles) filesView.style.display = 'none';
      }

      if (hideFiles) {
        // If Files was active, switch away.
        const active = document.querySelector('.top-tab-btn.active[data-view]');
        const activeView = active && active.dataset ? active.dataset.view : '';
        if (activeView === 'files') {
          try {
            if (XK && XK.ui && XK.ui.tabs && typeof XK.ui.tabs.show === 'function') {
              XK.ui.tabs.show('routing');
            } else if (typeof window.showView === 'function') {
              window.showView('routing');
            }
          } catch (e) {}
        }
      }
    } catch (e) {
      // ignore
    }
  }

  function init() {
    apply(load());

    // Sync across tabs/windows
    try {
      window.addEventListener('storage', (ev) => {
        if (!ev || ev.key !== KEY) return;
        try {
          apply(load());
          // Re-apply tabs on the panel page.
          applyTabsNow();
        } catch (e) {}
      });
    } catch (e) {}

    // DOM-dependent wiring
    try {
      document.addEventListener('DOMContentLoaded', () => {
        try { applyTabsNow(); } catch (e) {}
        try { wireTabsDnD(); } catch (e) {}
        try { applyHideUnusedNow(); } catch (e) {}
      });
    } catch (e) {}
  }

  XK.ui.layout = {
    KEY,
    DEFAULTS,
    load,
    save,
    apply,
    reset,
    tabKey,
    applyTabsNow,
    applyHideUnusedNow,
  };

  // Apply ASAP (head scripts run before DOMContentLoaded)
  try { init(); } catch (e) {}
})();

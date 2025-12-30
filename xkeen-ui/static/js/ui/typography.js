// Typography preferences (font family + scaling)
// Applies settings via CSS variables on :root.
(() => {
  'use strict';

  window.XKeen = window.XKeen || {};
  const XK = window.XKeen;
  XK.ui = XK.ui || {};

  const KEY = 'xkeen-typography-v1';

  const DEFAULTS = Object.freeze({
    scale: 1,
    fontFamily: '',
    monoScale: null, // null => follow scale
    monoFamily: '',
  });

  function _num(v, def) {
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
  }

  function load() {
    let raw = null;
    try { raw = localStorage.getItem(KEY); } catch (e) {}
    if (!raw) return { ...DEFAULTS };
    try {
      const obj = JSON.parse(raw);
      const scale = _num(obj.scale, DEFAULTS.scale);
      const monoScale = (obj.monoScale === null || typeof obj.monoScale === 'undefined')
        ? null
        : _num(obj.monoScale, null);
      return {
        scale,
        fontFamily: (typeof obj.fontFamily === 'string') ? obj.fontFamily : DEFAULTS.fontFamily,
        monoScale,
        monoFamily: (typeof obj.monoFamily === 'string') ? obj.monoFamily : DEFAULTS.monoFamily,
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
    const scale = _num(p.scale, 1);
    const monoScale = (p.monoScale === null || typeof p.monoScale === 'undefined')
      ? scale
      : _num(p.monoScale, scale);

    const root = document.documentElement;
    try {
      root.style.setProperty('--xk-font-scale', String(scale));
      root.style.setProperty('--xk-mono-font-scale', String(monoScale));
      if (p.fontFamily) root.style.setProperty('--xk-font-family', String(p.fontFamily));
      if (p.monoFamily) root.style.setProperty('--xk-mono-font-family', String(p.monoFamily));
    } catch (e) {}

    try {
      document.dispatchEvent(new CustomEvent('xkeen-typography-change', {
        detail: { scale, monoScale, fontFamily: p.fontFamily || '', monoFamily: p.monoFamily || '' },
      }));
    } catch (e) {}
  }

  function init() {
    apply(load());

    // Sync across tabs/windows
    try {
      window.addEventListener('storage', (ev) => {
        if (!ev) return;
        if (ev.key !== KEY) return;
        try { apply(load()); } catch (e) {}
      });
    } catch (e) {}
  }

  XK.ui.typography = {
    KEY,
    DEFAULTS,
    load,
    save,
    apply,
    reset,
    init,
  };

  // Apply ASAP (head scripts run before DOMContentLoaded)
  try { init(); } catch (e) {}
})();

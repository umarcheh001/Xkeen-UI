(() => {
  'use strict';

  window.XKeen = window.XKeen || {};
  const XK = window.XKeen;
  XK.features = XK.features || {};
  XK.features.typography = XK.features.typography || {};

  const Typo = XK.features.typography;

  function toast(msg, isError) {
    try {
      if (typeof window.showToast === 'function') return window.showToast(String(msg || ''), isError ? 'error' : 'info');
      if (XK.ui && typeof XK.ui.showToast === 'function') return XK.ui.showToast(String(msg || ''), !!isError);
      console.log(msg);
    } catch (e) {}
  }

  function byId(id) {
    try { return document.getElementById(id); } catch (e) { return null; }
  }

  function _num(v, def) {
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
  }

  function readPrefsFallback() {
    try {
      const raw = localStorage.getItem('xkeen-typography-v1');
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      return {};
    }
  }

  function initDevtoolsControls() {
    const elScale = byId('dt-typo-scale');
    const elFamily = byId('dt-typo-family');
    const elMonoScale = byId('dt-typo-mono-scale');
    const elMonoFamily = byId('dt-typo-mono-family');
    const elReset = byId('dt-typo-reset');

    if (!elScale && !elFamily && !elMonoScale && !elMonoFamily) return;

    const core = (XK.ui && XK.ui.typography) ? XK.ui.typography : null;
    const load = () => (core && core.load) ? core.load() : readPrefsFallback();
    const apply = (p) => {
      try {
        if (core && core.apply) return core.apply(p);
        // best-effort fallback
        const root = document.documentElement;
        const scale = _num(p.scale, 1);
        const monoScale = (p.monoScale === null || typeof p.monoScale === 'undefined') ? scale : _num(p.monoScale, scale);
        root.style.setProperty('--xk-font-scale', String(scale));
        root.style.setProperty('--xk-mono-font-scale', String(monoScale));
        if (p.fontFamily) root.style.setProperty('--xk-font-family', String(p.fontFamily));
        if (p.monoFamily) root.style.setProperty('--xk-mono-font-family', String(p.monoFamily));
      } catch (e) {}
    };
    const save = (p) => {
      try {
        if (core && core.save) return core.save(p);
        localStorage.setItem('xkeen-typography-v1', JSON.stringify(p || {}));
      } catch (e) {}
    };

    function syncControls(p) {
      const scale = _num(p.scale, 1);
      const monoScale = (p.monoScale === null || typeof p.monoScale === 'undefined') ? null : _num(p.monoScale, null);

      try {
        if (elScale) elScale.value = String(scale);
        if (elFamily) elFamily.value = String(p.fontFamily || '');
        if (elMonoScale) elMonoScale.value = (monoScale === null) ? 'auto' : String(monoScale);
        if (elMonoFamily) elMonoFamily.value = String(p.monoFamily || '');
      } catch (e) {}
    }

    let prefs = load();
    syncControls(prefs);

    const onChange = () => {
      prefs = prefs || {};

      const next = {
        scale: elScale ? _num(elScale.value, 1) : _num(prefs.scale, 1),
        fontFamily: elFamily ? String(elFamily.value || '') : String(prefs.fontFamily || ''),
        monoScale: prefs.monoScale,
        monoFamily: elMonoFamily ? String(elMonoFamily.value || '') : String(prefs.monoFamily || ''),
      };

      if (elMonoScale) {
        const v = String(elMonoScale.value || 'auto');
        next.monoScale = (v === 'auto') ? null : _num(v, null);
      }

      save(next);
      apply(next);
      toast('Типографика: применено');
    };

    [elScale, elFamily, elMonoScale, elMonoFamily].forEach((el) => {
      if (!el) return;
      if (el.dataset && el.dataset.xkeenWired === '1') return;
      el.addEventListener('change', onChange);
      if (el.dataset) el.dataset.xkeenWired = '1';
    });

    if (elReset && (!elReset.dataset || elReset.dataset.xkeenWired !== '1')) {
      elReset.addEventListener('click', () => {
        try {
          if (core && core.reset) core.reset();
          else localStorage.removeItem('xkeen-typography-v1');
        } catch (e) {}
        prefs = load();
        syncControls(prefs);
        toast('Типографика: сброшено');
      });
      if (elReset.dataset) elReset.dataset.xkeenWired = '1';
    }

    // Sync UI if prefs were changed in another tab
    try {
      window.addEventListener('storage', (ev) => {
        if (!ev) return;
        if (ev.key !== 'xkeen-typography-v1') return;
        prefs = load();
        syncControls(prefs);
      });
    } catch (e) {}
  }

  Typo.init = function init() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initDevtoolsControls);
    } else {
      initDevtoolsControls();
    }
  };

  // Auto-init
  try { Typo.init(); } catch (e) {}
})();

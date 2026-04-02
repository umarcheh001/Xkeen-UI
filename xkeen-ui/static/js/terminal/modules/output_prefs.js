import {
  publishTerminalCompatApi,
  toastTerminal,
} from '../runtime.js';

// Terminal output prefs module (Stage 8.3.2)
// Owns persistent prefs for output pipeline: ANSI filter, log highlight, follow.
// Emits: prefs:changed
(function () {
  'use strict';

  function createOutputPrefs(ctx) {
    const config = (ctx && ctx.config) ? ctx.config : null;
    const events = (ctx && ctx.events) ? ctx.events : { on: () => () => {}, emit: () => {} };
    const ui = (ctx && ctx.ui) ? ctx.ui : null;
    const dom = (ctx && ctx.dom) ? ctx.dom : null;
    const xterm = (ctx && ctx.xterm) ? ctx.xterm : null;

    function byId(id) {
      try { return (ui && typeof ui.byId === 'function') ? ui.byId(id) : document.getElementById(id); } catch (e) {}
      return null;
    }

    function toast(msg, kind) {
      const m = String(msg || '');
      const k = kind || 'info';
      try {
        if (ui && typeof ui.toast === 'function') { ui.toast(m, k); return; }
      } catch (e) {}
      toastTerminal(m, k);
    }

    function getBool(key, fallback) {
      let v;
      try {
        if (config && typeof config.get === 'function') v = config.get(key);
      } catch (e) {}
      if (typeof v === 'boolean') return v;
      if (v === 1 || v === '1' || v === 'true') return true;
      if (v === 0 || v === '0' || v === 'false') return false;
      return fallback;
    }

    function setBool(key, val) {
      const b = !!val;
      try {
        if (config && typeof config.set === 'function') { config.set(key, b); return true; }
      } catch (e) {}
      // ultra-fallback (should not be used when ctx.config is present)
      try {
        localStorage.setItem('xkeen_term_pref_' + key, b ? '1' : '0');
        return true;
      } catch (e2) {}
      return false;
    }

    function getPrefs() {
      return {
        ansiFilter: getBool('ansiFilter', false),
        logHl: getBool('logHl', true),
        follow: getBool('follow', true),
      };
    }

    function applyUi() {
      const p = getPrefs();
      const btnAnsi = (dom && typeof dom.byId === 'function') ? dom.byId('terminal-btn-ansi') : byId('terminal-btn-ansi');
      const btnHl = (dom && typeof dom.byId === 'function') ? dom.byId('terminal-btn-loghl') : byId('terminal-btn-loghl');
      const btnFollow = (dom && dom.followBtn) ? dom.followBtn : ((dom && typeof dom.byId === 'function') ? dom.byId('terminal-btn-follow') : byId('terminal-btn-follow'));

      if (btnAnsi) {
        try { btnAnsi.classList.toggle('is-active', !!p.ansiFilter); } catch (e) {}
        try { btnAnsi.title = p.ansiFilter ? 'ANSI-фильтр: ВКЛ (удалять ANSI-коды из вывода)' : 'ANSI-фильтр: ВЫКЛ (как есть)'; } catch (e2) {}
      }

      if (btnHl) {
        try { btnHl.classList.toggle('is-active', !!p.logHl); } catch (e) {}
        try { btnHl.title = p.logHl ? 'Подсветка логов: ВКЛ' : 'Подсветка логов: ВЫКЛ'; } catch (e2) {}
      }

      if (btnFollow) {
        try { btnFollow.classList.toggle('is-active', !!p.follow); } catch (e) {}
        try { btnFollow.textContent = p.follow ? '⇣ Следить' : '📌 Фикс'; } catch (e2) {}
        try { btnFollow.title = p.follow ? 'Автопрокрутка: ВКЛ (авто-переход в конец)' : 'Автопрокрутка: ВЫКЛ (фиксация прокрутки)'; } catch (e3) {}
      }
    }

    function emitChanged(changedKey) {
      try { events.emit('prefs:changed', { prefs: getPrefs(), changed: changedKey || null, ts: Date.now() }); } catch (e) {}
    }

    function toggleAnsiFilter() {
      const next = !getPrefs().ansiFilter;
      setBool('ansiFilter', next);
      applyUi();
      toast(next ? 'ANSI-фильтр: ВКЛ' : 'ANSI-фильтр: ВЫКЛ', 'info');
      emitChanged('ansiFilter');
      return next;
    }

    function toggleLogHighlight() {
      const next = !getPrefs().logHl;
      setBool('logHl', next);
      applyUi();
      toast(next ? 'Подсветка логов: ВКЛ' : 'Подсветка логов: ВЫКЛ', 'info');
      emitChanged('logHl');
      return next;
    }

    function toggleFollow() {
      const next = !getPrefs().follow;
      setBool('follow', next);
      applyUi();
      toast(next ? 'Автопрокрутка: ВКЛ' : 'Автопрокрутка: ВЫКЛ', 'info');
      emitChanged('follow');

      if (next) {
        try {
          const refs = (xterm && typeof xterm.getRefs === 'function') ? xterm.getRefs() : null;
          const term = refs ? refs.term : null;
          if (term && typeof term.scrollToBottom === 'function') term.scrollToBottom();
        } catch (e) {}
      }
      return next;
    }

    return {
      getPrefs,
      applyUi,
      toggleAnsiFilter,
      toggleLogHighlight,
      toggleFollow,
    };
  }

  // Registry plugin wrapper (Stage D)
  const terminalOutputPrefsCompat = {
    createModule: (ctx) => {
      const prefs = createOutputPrefs(ctx);
      try { ctx.outputPrefs = prefs; } catch (e) {}
      try { publishTerminalCompatApi('outputPrefs', prefs); } catch (e2) {}

      return {
        id: 'output_prefs',
        priority: 21,
        init: () => { try { prefs.applyUi(); } catch (e) {} },
        onOpen: () => { try { prefs.applyUi(); } catch (e) {} },
        onClose: () => {},
      };
    },
  };

  publishTerminalCompatApi('output_prefs', terminalOutputPrefsCompat);
})();

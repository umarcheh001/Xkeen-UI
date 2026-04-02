import {
  ensureTerminalNamespaceBucket,
  focusTerminalView,
  getTerminalById,
  getTerminalCompatApi,
  getTerminalContext,
  publishTerminalCompatApi,
  toastTerminal,
} from './runtime.js';

// Terminal search (xterm-addon-search): UI, hotkeys, counters
(function () {
  'use strict';

  const core = getTerminalCompatApi('_core');
  const state = (core && core.state) ? core.state : ensureTerminalNamespaceBucket('__searchState');

  function getCtx() {
    return getTerminalContext();
  }

  const S = state.search = state.search || {
    term: '',
    resultIndex: -1,
    resultCount: 0,
    debounce: null,
    keysBound: false,
    keysHandler: null,
    uiDisposers: null,
    resultsDisposable: null,
  };

  const DECOR = {
    matchBackground: 'rgba(120, 160, 210, 0.18)',
    matchBorder: 'rgba(140, 200, 255, 0.25)',
    matchOverviewRuler: 'rgba(120, 190, 255, 0.70)',
    activeMatchBackground: 'rgba(0, 170, 255, 0.45)',
    activeMatchBorder: 'rgba(255, 255, 255, 0.85)',
    activeMatchColorOverviewRuler: 'rgba(0, 170, 255, 1.00)',
  };

  function getTerm(ctx) {
    try {
      if (ctx && ctx.xterm && typeof ctx.xterm.getRefs === 'function') {
        const refs = ctx.xterm.getRefs();
        const term = refs && (refs.term || refs.xterm) ? (refs.term || refs.xterm) : null;
        if (term) return term;
      }
    } catch (error) {}
    try {
      return state.xterm || state.term || null;
    } catch (error2) {
      return null;
    }
  }

  function getAddon() {
    return state.searchAddon || null;
  }

  function byId(id, ctx) {
    const current = ctx || getCtx();
    return getTerminalById(id, (key) => {
      try { if (current && current.ui && typeof current.ui.byId === 'function') return current.ui.byId(key); } catch (error) {}
      try { return document.getElementById(key); } catch (error2) {}
      return null;
    });
  }

  function getEls(ctx) {
    const current = ctx || getCtx();
    return {
      row: byId('terminal-search-row', current),
      input: byId('terminal-search-input', current),
      counter: byId('terminal-search-counter', current),
      prev: byId('terminal-search-prev', current),
      next: byId('terminal-search-next', current),
      clearBtn: byId('terminal-search-clear', current),
    };
  }

  function toast(msg, kind) {
    try {
      const ctx = getCtx();
      if (ctx && ctx.ui && typeof ctx.ui.toast === 'function') return ctx.ui.toast(String(msg || ''), kind || 'info');
    } catch (error) {}
    return toastTerminal(String(msg || ''), kind || 'info');
  }

  function isOverlayOpen() {
    try {
      if (core && typeof core.terminalIsOverlayOpen === 'function') return core.terminalIsOverlayOpen();
    } catch (error) {}
    const overlay = document.getElementById('terminal-overlay');
    if (!overlay) return false;
    return overlay.style.display !== 'none';
  }

  function updateCounter(ctx) {
    const { counter } = getEls(ctx);
    if (!counter) return;

    const total = Number(S.resultCount || 0);
    const idx0 = Number(S.resultIndex != null ? S.resultIndex : -1);
    const cur = (total > 0 && idx0 >= 0) ? Math.min(total, idx0 + 1) : 0;
    counter.textContent = `${cur}/${total}`;
  }

  function focusTerm(ctx) {
    const term = getTerm(ctx || getCtx());
    try {
      if (term && typeof term.focus === 'function') {
        term.focus();
        return true;
      }
    } catch (error) {}
    return focusTerminalView();
  }

  function clear(opts = {}, ctx) {
    const silent = !!(opts && opts.silent);

    S.term = '';
    S.resultIndex = -1;
    S.resultCount = 0;

    try {
      const { input } = getEls(ctx);
      if (input) input.value = '';
    } catch (error) {}

    const term = getTerm(ctx);
    try { if (term && typeof term.clearSelection === 'function') term.clearSelection(); } catch (error2) {}

    const addon = getAddon();
    try { if (addon && typeof addon.clearDecorations === 'function') addon.clearDecorations(); } catch (error3) {}

    try { updateCounter(ctx); } catch (error4) {}
    if (!silent) toast('Поиск очищен', 'info');
  }

  function ensureAddon(term) {
    if (!term) return null;
    if (state.searchAddon) return state.searchAddon;

    try {
      if (typeof SearchAddon !== 'undefined' && SearchAddon && typeof SearchAddon.SearchAddon === 'function') {
        const addon = new SearchAddon.SearchAddon({ highlightLimit: 2000 });
        if (typeof term.loadAddon === 'function') term.loadAddon(addon);
        state.searchAddon = addon;
        return addon;
      }
    } catch (error) {}
    return null;
  }

  function bindResults(addon) {
    if (!addon) return;

    try { if (S.resultsDisposable && typeof S.resultsDisposable.dispose === 'function') S.resultsDisposable.dispose(); } catch (error) {}
    S.resultsDisposable = null;

    try {
      if (typeof addon.onDidChangeResults === 'function') {
        S.resultsDisposable = addon.onDidChangeResults((ev) => {
          S.resultIndex = (ev && typeof ev.resultIndex === 'number') ? ev.resultIndex : -1;
          S.resultCount = (ev && typeof ev.resultCount === 'number') ? ev.resultCount : 0;
          try { updateCounter(); } catch (error2) {}
        });
      }
    } catch (error3) {
      S.resultsDisposable = null;
    }
  }

  function attachTerm(term, ctx) {
    const target = term || getTerm(ctx);
    if (!target) return;

    try {
      state.term = target;
      state.xterm = target;
    } catch (error) {}

    const addon = state.searchAddon || ensureAddon(target);
    if (addon) {
      state.searchAddon = addon;
      bindResults(addon);
      try { updateCounter(ctx); } catch (error2) {}
    }
  }

  function run(direction, ctx) {
    const { input } = getEls(ctx);
    const termStr = input ? String(input.value || '').trim() : String(S.term || '').trim();
    S.term = termStr;

    if (!termStr) {
      clear({ silent: true }, ctx);
      return;
    }

    const term = getTerm(ctx);
    const addon = getAddon();
    if (!term || !addon) {
      toast('Поиск недоступен: xterm-addon-search не загружен', 'error');
      return;
    }

    const opts = {
      caseSensitive: false,
      regex: false,
      wholeWord: false,
      decorations: DECOR,
    };

    let ok = false;
    try {
      ok = (direction === 'prev') ? addon.findPrevious(termStr, opts) : addon.findNext(termStr, opts);
    } catch (error) {
      ok = false;
    }

    if (!ok) {
      S.resultIndex = -1;
      S.resultCount = 0;
      try { updateCounter(ctx); } catch (error2) {}
      toast('Совпадений не найдено', 'info');
    }

    try { if (term && typeof term.focus === 'function') term.focus(); } catch (error3) {}
  }

  function next(ctx) { run('next', ctx); }
  function prev(ctx) { run('prev', ctx); }

  function focus(selectAll = true, ctx) {
    const { input } = getEls(ctx);
    if (!input) return;
    try {
      input.focus();
      if (selectAll) input.select();
    } catch (error) {}
  }

  function debouncedHighlight(ctx) {
    const { input } = getEls(ctx);
    if (!input) return;

    const termStr = String(input.value || '').trim();
    S.term = termStr;

    if (S.debounce) {
      try { clearTimeout(S.debounce); } catch (error) {}
      S.debounce = null;
    }

    if (!termStr) {
      clear({ silent: true }, ctx);
      return;
    }

    S.debounce = setTimeout(() => {
      const term = getTerm(ctx);
      const addon = getAddon();
      if (!term || !addon) return;
      try {
        addon.findNext(termStr, {
          caseSensitive: false,
          regex: false,
          wholeWord: false,
          noScroll: true,
          decorations: DECOR,
        });
      } catch (error2) {}
    }, 150);
  }

  function bindUi(ctx) {
    if (S.uiDisposers && S.uiDisposers.length) return;

    const { input, prev: prevBtn, next: nextBtn, clearBtn } = getEls(ctx);
    const disposers = [];

    function on(el, ev, fn, opts) {
      if (!el || !el.addEventListener) return;
      el.addEventListener(ev, fn, opts);
      disposers.push(() => {
        try { el.removeEventListener(ev, fn, opts); } catch (error) {}
      });
    }

    if (prevBtn) on(prevBtn, 'click', (ev) => { try { ev.preventDefault(); } catch (error) {} prev(ctx); });
    if (nextBtn) on(nextBtn, 'click', (ev) => { try { ev.preventDefault(); } catch (error) {} next(ctx); });
    if (clearBtn) on(clearBtn, 'click', (ev) => { try { ev.preventDefault(); } catch (error) {} clear({}, ctx); });

    if (input) {
      on(input, 'input', () => { try { debouncedHighlight(ctx); } catch (error) {} });

      on(input, 'keydown', (ev) => {
        if (!ev) return;
        if (ev.key === 'Enter') {
          ev.preventDefault();
          if (ev.shiftKey) prev(ctx);
          else next(ctx);
          return;
        }
        if (ev.key === 'Escape') {
          ev.preventDefault();
          clear({ silent: true }, ctx);
          focusTerm(ctx);
        }
      });
    }

    S.uiDisposers = disposers;
  }

  function unbindUi() {
    const disposers = S.uiDisposers || null;
    S.uiDisposers = null;
    if (!disposers) return;
    disposers.forEach((dispose) => {
      try { if (typeof dispose === 'function') dispose(); } catch (error) {}
    });
  }

  function bindHotkeys(ctx) {
    if (S.keysBound) return;
    S.keysBound = true;
    S.keysHandler = (ev) => {
      try {
        if (!isOverlayOpen()) return;

        if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'f' || ev.key === 'F')) {
          ev.preventDefault();
          focus(true, ctx);
          try { debouncedHighlight(ctx); } catch (error) {}
          return;
        }

        if (ev.key === 'F3') {
          ev.preventDefault();
          if (ev.shiftKey) prev(ctx);
          else next(ctx);
        }
      } catch (error2) {}
    };
    try { document.addEventListener('keydown', S.keysHandler, true); } catch (error3) {}
  }

  function unbindHotkeys() {
    if (!S.keysBound) return;
    S.keysBound = false;
    try {
      if (S.keysHandler) document.removeEventListener('keydown', S.keysHandler, true);
    } catch (error) {}
    S.keysHandler = null;
  }

  function init() {
    try { bindUi(getCtx()); } catch (error) {}
    try { attachTerm(null, getCtx()); } catch (error2) {}
  }

  const terminalSearchApi = {
    init,
    attachTerm: (term) => attachTerm(term, getCtx()),
    updateCounter: () => updateCounter(getCtx()),
    clear: (opts) => clear(opts || {}, getCtx()),
    next: () => next(getCtx()),
    prev: () => prev(getCtx()),
    focus: (selectAll) => focus(selectAll !== false, getCtx()),
    debouncedHighlight: () => debouncedHighlight(getCtx()),
    getEls,
    createModule: (ctx) => ({
      id: 'search',
      priority: 60,
      init: () => { try { attachTerm(null, ctx); } catch (error) {} },
      onOpen: () => {
        try { bindUi(ctx); } catch (error) {}
        try { bindHotkeys(ctx); } catch (error2) {}
      },
      onClose: () => {
        try { unbindHotkeys(); } catch (error) {}
        try { clear({ silent: true }, ctx); } catch (error2) {}
        try { unbindUi(); } catch (error3) {}
      },
      attachTerm: (_ctx, term) => { try { attachTerm(term, ctx); } catch (error) {} },
      detachTerm: () => {
        try { if (S.resultsDisposable && typeof S.resultsDisposable.dispose === 'function') S.resultsDisposable.dispose(); } catch (error) {}
        S.resultsDisposable = null;
        try { state.searchAddon = null; } catch (error2) {}
      },
    }),
  };

  publishTerminalCompatApi('search', terminalSearchApi);
})();

// Terminal search (xterm-addon-search): UI, hotkeys, counters
(function () {
  'use strict';

  window.XKeen = window.XKeen || {};
  window.XKeen.terminal = window.XKeen.terminal || {};

  const core = (window.XKeen.terminal && window.XKeen.terminal._core) ? window.XKeen.terminal._core : null;

  function getCtx() {
    try {
      const C = window.XKeen.terminal.core;
      if (C && typeof C.getCtx === 'function') return C.getCtx();
    } catch (e) {}
    return null;
  }

  const state = (core && core.state) ? core.state : (window.XKeen.terminal.__searchState = (window.XKeen.terminal.__searchState || {}));

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

  // Decorations: keep in this module (pure UI feature)
  const DECOR = {
    // IDE-подсветка:
    // - все совпадения: мягкий серо-синий фон (не "съедает" белый текст)
    // - активное совпадение: ярче + заметная рамка
    matchBackground: 'rgba(120, 160, 210, 0.18)',
    matchBorder: 'rgba(140, 200, 255, 0.25)',
    matchOverviewRuler: 'rgba(120, 190, 255, 0.70)',
    activeMatchBackground: 'rgba(0, 170, 255, 0.45)',
    activeMatchBorder: 'rgba(255, 255, 255, 0.85)',
    activeMatchColorOverviewRuler: 'rgba(0, 170, 255, 1.00)',
  };

  function getTerm(ctx) {
    // Prefer ctx.xterm refs
    try {
      if (ctx && ctx.xterm && typeof ctx.xterm.getRefs === 'function') {
        const r = ctx.xterm.getRefs();
        const t = r && (r.term || r.xterm) ? (r.term || r.xterm) : null;
        if (t) return t;
      }
    } catch (e0) {}
    try {
      return state.xterm || state.term || null;
    } catch (e) {}
    return null;
  }

  function getAddon() {
    return state.searchAddon || null;
  }

  function byId(id, ctx) {
    try { if (ctx && ctx.ui && typeof ctx.ui.byId === 'function') return ctx.ui.byId(id); } catch (e0) {}
    try { return document.getElementById(id); } catch (e1) {}
    return null;
  }

  function getEls(ctx) {
    const c = ctx || getCtx();
    return {
      row: byId('terminal-search-row', c),
      input: byId('terminal-search-input', c),
      counter: byId('terminal-search-counter', c),
      prev: byId('terminal-search-prev', c),
      next: byId('terminal-search-next', c),
      clearBtn: byId('terminal-search-clear', c),
    };
  }

  function toast(msg, kind) {
    try {
      const ctx = getCtx();
      if (ctx && ctx.ui && typeof ctx.ui.toast === 'function') return ctx.ui.toast(String(msg || ''), kind || 'info');
    } catch (e0) {}
    try { if (typeof window.showToast === 'function') window.showToast(String(msg || ''), kind || 'info'); } catch (e) {}
  }

  function isOverlayOpen() {
    try {
      if (core && typeof core.terminalIsOverlayOpen === 'function') return core.terminalIsOverlayOpen();
    } catch (e) {}
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

  function clear(opts = {}, ctx) {
    const silent = !!(opts && opts.silent);

    S.term = '';
    S.resultIndex = -1;
    S.resultCount = 0;

    try {
      const { input } = getEls(ctx);
      if (input) input.value = '';
    } catch (e) {}

    const term = getTerm(ctx);
    try { if (term && typeof term.clearSelection === 'function') term.clearSelection(); } catch (e) {}

    const addon = getAddon();
    try { addon && typeof addon.clearDecorations === 'function' && addon.clearDecorations(); } catch (e) {}

    try { updateCounter(ctx); } catch (e) {}
    if (!silent) toast('Поиск очищен', 'info');
  }

  function ensureAddon(term) {
    if (!term) return null;
    if (state.searchAddon) return state.searchAddon;

    // Create addon if xterm-addon-search is available globally
    try {
      if (typeof SearchAddon !== 'undefined' && SearchAddon && typeof SearchAddon.SearchAddon === 'function') {
        const addon = new SearchAddon.SearchAddon({ highlightLimit: 2000 });
        if (typeof term.loadAddon === 'function') term.loadAddon(addon);
        state.searchAddon = addon;
        return addon;
      }
    } catch (e) {}
    return null;
  }

  function bindResults(addon) {
    if (!addon) return;

    // dispose previous
    try { if (S.resultsDisposable && typeof S.resultsDisposable.dispose === 'function') S.resultsDisposable.dispose(); } catch (e) {}
    S.resultsDisposable = null;

    try {
      if (typeof addon.onDidChangeResults === 'function') {
        S.resultsDisposable = addon.onDidChangeResults((ev) => {
          S.resultIndex = (ev && typeof ev.resultIndex === 'number') ? ev.resultIndex : -1;
          S.resultCount = (ev && typeof ev.resultCount === 'number') ? ev.resultCount : 0;
          try { updateCounter(); } catch (e) {}
        });
      }
    } catch (e) {
      S.resultsDisposable = null;
    }
  }

  function attachTerm(term, ctx) {
    const t = term || getTerm(ctx);
    if (!t) return;

    // Keep reference in core state for other modules (legacy)
    try {
      state.term = t;
      state.xterm = t;
    } catch (e) {}

    const addon = state.searchAddon || ensureAddon(t);
    if (addon) {
      state.searchAddon = addon;
      bindResults(addon);
      // sync counter on attach
      try { updateCounter(ctx); } catch (e) {}
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
    } catch (e) {
      ok = false;
    }

    if (!ok) {
      S.resultIndex = -1;
      S.resultCount = 0;
      try { updateCounter(ctx); } catch (e) {}
      toast('Совпадений не найдено', 'info');
    }

    try { term && typeof term.focus === 'function' && term.focus(); } catch (e) {}
  }

  function next(ctx) { run('next', ctx); }
  function prev(ctx) { run('prev', ctx); }

  function focus(selectAll = true, ctx) {
    const { input } = getEls(ctx);
    if (!input) return;
    try {
      input.focus();
      if (selectAll) input.select();
    } catch (e) {}
  }

  function debouncedHighlight(ctx) {
    const { input } = getEls(ctx);
    if (!input) return;

    const termStr = String(input.value || '').trim();
    S.term = termStr;

    if (S.debounce) {
      try { clearTimeout(S.debounce); } catch (e) {}
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
      } catch (e) {}
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
        try { el.removeEventListener(ev, fn, opts); } catch (e) {}
      });
    }

    // Buttons
    if (prevBtn) on(prevBtn, 'click', (e) => { try { e.preventDefault(); } catch (e2) {} prev(ctx); });
    if (nextBtn) on(nextBtn, 'click', (e) => { try { e.preventDefault(); } catch (e2) {} next(ctx); });
    if (clearBtn) on(clearBtn, 'click', (e) => { try { e.preventDefault(); } catch (e2) {} clear({}, ctx); });

    // Input handlers
    if (input) {
      on(input, 'input', () => { try { debouncedHighlight(ctx); } catch (e) {} });

      on(input, 'keydown', (e) => {
        if (!e) return;
        if (e.key === 'Enter') {
          e.preventDefault();
          if (e.shiftKey) prev(ctx);
          else next(ctx);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          clear({ silent: true }, ctx);
          try { const term = getTerm(ctx); term && term.focus && term.focus(); } catch (e2) {}
          return;
        }
      });
    }

    S.uiDisposers = disposers;
  }

  function unbindUi() {
    const ds = S.uiDisposers || null;
    S.uiDisposers = null;
    if (!ds) return;
    ds.forEach((d) => { try { if (typeof d === 'function') d(); } catch (e) {} });
  }

  function bindHotkeys(ctx) {
    if (S.keysBound) return;
    S.keysBound = true;
    S.keysHandler = (e) => {
      try {
        if (!isOverlayOpen()) return;

        if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
          e.preventDefault();
          // Built-in overlay search row
          focus(true, ctx);
          try { debouncedHighlight(ctx); } catch (e2) {}
          return;
        }

        if (e.key === 'F3') {
          e.preventDefault();
          if (e.shiftKey) prev(ctx);
          else next(ctx);
          return;
        }
      } catch (e2) {}
    };
    try { document.addEventListener('keydown', S.keysHandler, true); } catch (e) {}
  }

  function unbindHotkeys() {
    if (!S.keysBound) return;
    S.keysBound = false;
    try {
      if (S.keysHandler) document.removeEventListener('keydown', S.keysHandler, true);
    } catch (e) {}
    S.keysHandler = null;
  }

  function init() {
    // For backward compatibility: bind search UI once (do not bind global hotkeys here)
    try { bindUi(getCtx()); } catch (e) {}
    try { attachTerm(null, getCtx()); } catch (e2) {}
  }

  // Export
  window.XKeen.terminal.search = {
    init,
    attachTerm: (term) => attachTerm(term, getCtx()),
    updateCounter: () => updateCounter(getCtx()),
    clear: (opts) => clear(opts || {}, getCtx()),
    next: () => next(getCtx()),
    prev: () => prev(getCtx()),
    focus: (selectAll) => focus(selectAll !== false, getCtx()),
    debouncedHighlight: () => debouncedHighlight(getCtx()),
    getEls, // mostly for tests/debug

    // Stage 8.4: registry plugin factory
    createModule: (ctx) => ({
      id: 'search',
      priority: 60,

      init: () => {
        // no DOM subscriptions here; only prepare state and try to attach xterm if already present
        try { attachTerm(null, ctx); } catch (e) {}
      },

      onOpen: () => {
        try { bindUi(ctx); } catch (e) {}
        try { bindHotkeys(ctx); } catch (e2) {}
      },

      onClose: () => {
        try { unbindHotkeys(); } catch (e) {}
        try { clear({ silent: true }, ctx); } catch (e2) {}
        try { unbindUi(); } catch (e3) {}
      },

      attachTerm: (_ctx, term) => { try { attachTerm(term, ctx); } catch (e) {} },

      detachTerm: () => {
        try { if (S.resultsDisposable && typeof S.resultsDisposable.dispose === 'function') S.resultsDisposable.dispose(); } catch (e) {}
        S.resultsDisposable = null;
        try { state.searchAddon = null; } catch (e2) {}
      },
    }),
  };
})();

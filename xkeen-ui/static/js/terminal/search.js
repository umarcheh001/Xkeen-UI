// Terminal search (xterm-addon-search): UI, hotkeys, counters
(function () {
  'use strict';

  window.XKeen = window.XKeen || {};
  window.XKeen.terminal = window.XKeen.terminal || {};
  const core = (window.XKeen.terminal && window.XKeen.terminal._core) ? window.XKeen.terminal._core : null;
  const state = (core && core.state) ? core.state : (window.XKeen.terminal.__searchState = (window.XKeen.terminal.__searchState || {}));

  const S = state.search = state.search || {
    term: '',
    resultIndex: -1,
    resultCount: 0,
    debounce: null,
    keysBound: false,
    uiBound: false,
    resultsDisposable: null,
  };

  // Decorations: keep in this module (pure UI feature)
  const DECOR = {
    matchBackground: 'rgba(255, 255, 0, 0.20)',
    matchBorder: 'rgba(255, 255, 255, 0.30)',
    matchOverviewRuler: 'rgba(255, 255, 0, 0.65)',
    activeMatchBackground: 'rgba(255, 165, 0, 0.28)',
    activeMatchBorder: 'rgba(255, 255, 255, 0.60)',
    activeMatchColorOverviewRuler: 'rgba(255, 165, 0, 0.95)',
  };

  function getTerm() {
    return state.xterm || state.term || null;
  }

  function getAddon() {
    return state.searchAddon || null;
  }

  function getEls() {
    const row = document.getElementById('terminal-search-row');
    const input = document.getElementById('terminal-search-input');
    const counter = document.getElementById('terminal-search-counter');
    const prev = document.getElementById('terminal-search-prev');
    const next = document.getElementById('terminal-search-next');
    const clearBtn = document.getElementById('terminal-search-clear');
    return { row, input, counter, prev, next, clearBtn };
  }

  function isOverlayOpen() {
    try {
      if (core && typeof core.terminalIsOverlayOpen === 'function') return core.terminalIsOverlayOpen();
    } catch (e) {}
    // fallback
    const overlay = document.getElementById('terminal-overlay');
    if (!overlay) return false;
    return overlay.style.display !== 'none';
  }


  function updateCounter() {
    const { counter } = getEls();
    if (!counter) return;

    const total = Number(S.resultCount || 0);
    const idx0 = Number(S.resultIndex != null ? S.resultIndex : -1);
    const cur = (total > 0 && idx0 >= 0) ? Math.min(total, idx0 + 1) : 0;
    counter.textContent = `${cur}/${total}`;
  }

  function clear(opts = {}) {
    const silent = !!(opts && opts.silent);

    S.term = '';
    S.resultIndex = -1;
    S.resultCount = 0;

    try {
      const { input } = getEls();
      if (input) input.value = '';
    } catch (e) {}

    const term = getTerm();
    try { if (term && typeof term.clearSelection === 'function') term.clearSelection(); } catch (e) {}

    const addon = getAddon();
    try { addon && typeof addon.clearDecorations === 'function' && addon.clearDecorations(); } catch (e) {}

    try { updateCounter(); } catch (e) {}
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

  function attachTerm(term) {
    if (!term) term = getTerm();
    if (!term) return;

    // Keep reference in core state for other modules
    try {
      state.term = term;
      state.xterm = term;
    } catch (e) {}

    const addon = state.searchAddon || ensureAddon(term);
    if (addon) {
      state.searchAddon = addon;
      bindResults(addon);
      // sync counter on attach
      try { updateCounter(); } catch (e) {}
    }
  }

  function run(direction) {
    const { input } = getEls();
    const termStr = input ? String(input.value || '').trim() : String(S.term || '').trim();
    S.term = termStr;

    if (!termStr) {
      clear({ silent: true });
      return;
    }

    const term = getTerm();
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
      try { updateCounter(); } catch (e) {}
      toast('Совпадений не найдено', 'info');
    }

    try { term && typeof term.focus === 'function' && term.focus(); } catch (e) {}
  }

  function next() { run('next'); }
  function prev() { run('prev'); }

  function focus(selectAll = true) {
    const { input } = getEls();
    if (!input) return;
    try {
      input.focus();
      if (selectAll) input.select();
    } catch (e) {}
  }

  function debouncedHighlight() {
    const { input } = getEls();
    if (!input) return;

    const termStr = String(input.value || '').trim();
    S.term = termStr;

    if (S.debounce) {
      try { clearTimeout(S.debounce); } catch (e) {}
      S.debounce = null;
    }

    if (!termStr) {
      clear({ silent: true });
      return;
    }

    S.debounce = setTimeout(() => {
      const term = getTerm();
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

  function bindUiOnce() {
    if (S.uiBound) return;
    S.uiBound = true;

    const { input, prev, next, clearBtn } = getEls();

    // Buttons
    if (prev) prev.addEventListener('click', (e) => { try { e.preventDefault(); } catch (e2) {} prev(); });
    if (next) next.addEventListener('click', (e) => { try { e.preventDefault(); } catch (e2) {} next(); });
    if (clearBtn) clearBtn.addEventListener('click', (e) => { try { e.preventDefault(); } catch (e2) {} clear(); });

    // Input handlers
    if (input) {
      input.addEventListener('input', () => { try { debouncedHighlight(); } catch (e) {} });

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (e.shiftKey) prev();
          else next();
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          clear({ silent: true });
          try { const term = getTerm(); term && term.focus && term.focus(); } catch (e2) {}
          return;
        }
      });
    }

    // Global hotkeys while overlay is open
    if (!S.keysBound) {
      S.keysBound = true;
      document.addEventListener('keydown', (e) => {
        try {
          if (!isOverlayOpen()) return;

          if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
            e.preventDefault();
            focus(true);
            try { debouncedHighlight(); } catch (e2) {}
            return;
          }

          if (e.key === 'F3') {
            e.preventDefault();
            if (e.shiftKey) prev();
            else next();
            return;
          }
        } catch (e2) {}
      }, true);
    }
  }

  function init() {
    // UI bindings
    try { bindUiOnce(); } catch (e) {}

    // Try to attach to term if already created
    try { attachTerm(getTerm()); } catch (e) {}
  }

  // Export
  window.XKeen.terminal.search = {
    init,
    attachTerm,
    updateCounter,
    clear,
    next,
    prev,
    focus,
    debouncedHighlight,
    getEls, // mostly for tests/debug
  };
})();

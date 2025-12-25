// Terminal history: drawer + localStorage + PTY typed-lines capture
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
  const state = (core && core.state) ? core.state : (window.XKeen.terminal.__historyState = (window.XKeen.terminal.__historyState || {}));

  const KEY = 'xkeen_terminal_history'; // keep legacy key for backward compatibility
  const LIMIT = 50;

  const H = state.history = state.history || {
    items: [],
    index: 0,
    selected: '',
    uiDisposers: null,
    escHandler: null,
    cmdKeysOff: null,
    // PTY capture state
    ptyLine: '',
    ptyCursor: 0,
    ptyHadPrintable: false,
    ptySensitive: false,
    ptyDisposable: null,
  };


  function syncBodyScrollLock() {
    try {
      if (window.XKeen && XKeen.ui && XKeen.ui.modal && typeof XKeen.ui.modal.syncBodyScrollLock === 'function') {
        return XKeen.ui.modal.syncBodyScrollLock();
      }
    } catch (e) {}
  }

  function byId(id, ctx) {
    if (!ctx) ctx = getCtx();
    try {
      if (ctx && ctx.ui && typeof ctx.ui.byId === 'function') return ctx.ui.byId(id);
    } catch (e0) {}
    try { if (core && typeof core.byId === 'function') return core.byId(id); } catch (e1) {}
    return null;
  }

  function toast(msg, kind, ctx) {
    if (!ctx) ctx = getCtx();
    try {
      if (ctx && ctx.ui && typeof ctx.ui.toast === 'function') return ctx.ui.toast(msg, kind);
    } catch (e0) {}
    try { if (typeof window.showToast === 'function') return window.showToast(String(msg || ''), kind || 'info'); } catch (e) {}
  }

  function getEls(ctx) {
    if (!ctx) ctx = getCtx();
    return {
      modal: byId('terminal-history-modal', ctx),
      closeBtn: byId('terminal-history-close-btn', ctx),
      filter: byId('terminal-history-filter', ctx),
      list: byId('terminal-history-list', ctx),
      insertBtn: byId('terminal-history-insert-btn', ctx),
      runBtn: byId('terminal-history-run-btn', ctx),
      clearBtn: byId('terminal-history-clear-btn', ctx),
      openBtn: byId('terminal-history-btn', ctx),
      cmdEl: byId('terminal-command', ctx),
    };
  }

  function isOpen() {
    try {
      const { modal } = getEls();
      return !!(modal && !modal.classList.contains('hidden'));
    } catch (e) {
      return false;
    }
  }

  function load() {
    try {
      if (!window.localStorage) return;
      const raw = localStorage.getItem(KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        H.items = parsed.slice(-LIMIT).map((x) => String(x || '').trim()).filter(Boolean);
        H.index = H.items.length;
      }
    } catch (e) {}
  }

  function save() {
    try {
      if (!window.localStorage) return;
      const data = (H.items || []).slice(-LIMIT);
      localStorage.setItem(KEY, JSON.stringify(data));
    } catch (e) {}
  }

  function push(cmd) {
    const text = String(cmd || '').trim();
    if (!text) return;

    const items = H.items || [];
    if (items.length && items[items.length - 1] === text) {
      H.index = items.length;
      return;
    }

    items.push(text);
    H.items = items.slice(-LIMIT);
    H.index = H.items.length;
    save();

    // live update if open
    try { if (isOpen()) render(); } catch (e) {}
  }

  function clearAll(opts = {}) {
    try {
      H.items = [];
      H.index = 0;
      H.selected = '';
    } catch (e) {}

    try { if (window.localStorage) localStorage.removeItem(KEY); } catch (e) {}

    try {
      const { cmdEl } = getEls();
      if (cmdEl) cmdEl.value = '';
    } catch (e) {}

    try { if (isOpen()) render(); } catch (e) {}

    if (!opts || !opts.silent) toast('История команд очищена', 'success');
  }

  function select(cmd) {
    H.selected = String(cmd || '');
    try {
      const { cmdEl } = getEls();
      if (cmdEl) cmdEl.value = H.selected;
    } catch (e) {}
  }

  function isPtyActive() {
    try {
      // Source of truth: ctx/core state
      const ctx = (window.XKeen && window.XKeen.terminal && window.XKeen.terminal.core && window.XKeen.terminal.core.getCtx)
        ? window.XKeen.terminal.core.getCtx()
        : null;
      const m1 = ctx && ctx.core && typeof ctx.core.getMode === 'function' ? ctx.core.getMode() : null;
      const m2 = ctx && ctx.state ? ctx.state.mode : null;
      const mode = (m1 || m2 || '').toString();
      return mode === 'pty';
    } catch (e) {}
    // Fallback: existing core adapter
    try { if (core && typeof core.getMode === 'function') return (core.getMode() === 'pty'); } catch (e2) {}
    return false;
  }

  function sendToPty(raw) {
    // New API: ctx.transport is the only supported transport access.
    try {
      const ctx = (window.XKeen && window.XKeen.terminal && window.XKeen.terminal.core && window.XKeen.terminal.core.getCtx)
        ? window.XKeen.terminal.core.getCtx()
        : null;
      if (ctx && ctx.transport) {
        // Force PTY preference — history's "run" must go to PTY when available.
        if (ctx.transport.kind === 'pty') return !!ctx.transport.send(raw, { prefer: 'pty' });
      }
    } catch (e) {}

    // Last resort: modular PTY object (should be removed once terminal.js is fully modular).
    try {
      const P = window.XKeen && window.XKeen.terminal ? window.XKeen.terminal.pty : null;
      if (P && typeof P.sendRaw === 'function') { P.sendRaw(raw); return true; }
    } catch (e2) {}

    return false;
  }

  function runSelected() {
    const cmd = String(H.selected || '').trim();
    if (!cmd) {
      toast('Выберите команду', 'info');
      return;
    }

    // Always push to history
    push(cmd);

    // PTY: send directly
    if (isPtyActive()) {
      const ok = sendToPty(cmd + '\r');
      if (ok) {
        close();
        try { const t = state.xterm || state.term; t && t.focus && t.focus(); } catch (e) {}
        return;
      }
    }

    // Lite: route through unified executor (Stage C) so builtins also work.
    close();
    try {
      const T = window.XKeen && window.XKeen.terminal ? window.XKeen.terminal : null;
      if (T && typeof T.execCommand === 'function') {
        void T.execCommand(cmd, { source: 'history' });
        return;
      }
    } catch (e) {}

    // Fallback to legacy lite_runner flow
    try {
      const { cmdEl } = getEls();
      if (cmdEl) cmdEl.value = cmd;
      const inputEl = byId('terminal-input');
      if (inputEl) inputEl.value = '';
    } catch (e) {}

    try {
      if (window.XKeen && XKeen.terminal && XKeen.terminal.lite_runner && typeof XKeen.terminal.lite_runner.sendTerminalInput === 'function') {
        void XKeen.terminal.lite_runner.sendTerminalInput();
      } else if (typeof window.sendTerminalInput === 'function') {
        void window.sendTerminalInput();
      }
    } catch (e) {}
  }

  function insertSelected() {
    const cmd = String(H.selected || '').trim();
    if (!cmd) {
      toast('Выберите команду', 'info');
      return;
    }
    select(cmd);
    close();
    try { const { cmdEl } = getEls(); cmdEl && cmdEl.focus && cmdEl.focus(); } catch (e) {}
  }

  function render() {
    const { filter, list, runBtn } = getEls();
    if (!list) return;

    // Update run button label depending on mode
    if (runBtn) {
      runBtn.textContent = isPtyActive() ? 'Отправить в PTY' : 'Выполнить';
      runBtn.title = isPtyActive() ? 'Отправить выбранную команду в интерактивный PTY' : 'Выполнить выбранную команду';
    }

    const q = (filter && filter.value) ? String(filter.value).trim().toLowerCase() : '';
    const data = (H.items || []).slice().reverse().filter((c) => {
      if (!q) return true;
      return String(c || '').toLowerCase().includes(q);
    });

    list.textContent = '';

    if (!data.length) {
      const empty = document.createElement('div');
      empty.className = 'terminal-history-hint';
      empty.textContent = q ? 'Ничего не найдено.' : 'История команд пуста.';
      list.appendChild(empty);
      return;
    }

    if (H.selected && !data.includes(H.selected)) H.selected = '';

    data.forEach((cmd) => {
      const item = document.createElement('div');
      item.className = 'terminal-history-item' + (cmd === H.selected ? ' selected' : '');
      item.setAttribute('role', 'listitem');

      const span = document.createElement('div');
      span.className = 'terminal-history-cmd';
      span.textContent = String(cmd || '');
      item.appendChild(span);

      item.addEventListener('click', () => {
        select(cmd);
        try {
          const kids = list.querySelectorAll('.terminal-history-item');
          kids.forEach((k) => k.classList.remove('selected'));
          item.classList.add('selected');
        } catch (e) {}
      });

      item.addEventListener('dblclick', () => {
        select(cmd);
        runSelected();
      });

      list.appendChild(item);
    });
  }

  function open() {
    const { modal, filter } = getEls();
    if (!modal) return;

    modal.classList.remove('hidden');
    syncBodyScrollLock();

    // reset selection on open
    H.selected = '';
    render();

    if (filter) {
      try { filter.value = ''; } catch (e) {}
      try { filter.focus(); } catch (e) {}
    }
  }

  function close() {
    const { modal } = getEls();
    if (!modal) return;
    modal.classList.add('hidden');
    syncBodyScrollLock();
  }

  // ArrowUp/ArrowDown in #terminal-command: browse history items (lite input field)
  function bindCmdHistoryKeys(cmdEl) {
    if (!cmdEl) return null;

    const handler = (e) => {
      try {
        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;

        const items = H.items || [];
        if (!items.length) return;

        e.preventDefault();
        // prevent legacy handler in terminal.js from also running
        if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();

        if (e.key === 'ArrowUp') {
          H.index = Math.max(0, (H.index || items.length) - 1);
        } else {
          if ((H.index || 0) >= items.length - 1) {
            H.index = items.length;
            cmdEl.value = '';
            return;
          }
          H.index = Math.min(items.length, (H.index || 0) + 1);
        }

        if (H.index >= 0 && H.index < items.length) {
          cmdEl.value = items[H.index];
          const len = cmdEl.value.length;
          try { cmdEl.setSelectionRange(len, len); } catch (e2) {}
        }
      } catch (e2) {}
    };

    cmdEl.addEventListener('keydown', handler, true);
    return () => {
      try { cmdEl.removeEventListener('keydown', handler, true); } catch (e) {}
    };
  }

  // ---------------- PTY typed-lines capture ----------------
  function ptyResetLine() {
    H.ptyLine = '';
    H.ptyCursor = 0;
    H.ptyHadPrintable = false;
  }

  function markSensitiveFromOutput(chunk) {
    try {
      const s = String(chunk || '');
      if (!s) return;
      if (/(password|парол[ья])/i.test(s)) {
        H.ptySensitive = true;
      }
    } catch (e) {}
  }

  function ptyCommitLine() {
    try {
      const cmd = String(H.ptyLine || '').trim();
      if (cmd && H.ptyHadPrintable && !H.ptySensitive) {
        push(cmd);
      }
    } catch (e) {}
    H.ptySensitive = false;
    ptyResetLine();
  }

  function consumePtyInput(data) {
    const s = String(data || '');
    if (!s) return;

    let i = 0;
    while (i < s.length) {
      const ch = s[i];

      // ESC sequences
      if (ch === '\x1b') {
        const tri = s.slice(i, i + 3);
        if (tri === '\x1b[A' || tri === '\x1b[B') {
          ptyResetLine();
          i += 3;
          continue;
        }
        if (tri === '\x1b[C') { H.ptyCursor = Math.min((H.ptyLine || '').length, H.ptyCursor + 1); i += 3; continue; }
        if (tri === '\x1b[D') { H.ptyCursor = Math.max(0, H.ptyCursor - 1); i += 3; continue; }

        if (s.slice(i, i + 4) === '\x1b[3~') {
          if (H.ptyCursor < (H.ptyLine || '').length) {
            H.ptyLine = (H.ptyLine || '').slice(0, H.ptyCursor) + (H.ptyLine || '').slice(H.ptyCursor + 1);
            H.ptyHadPrintable = true;
          }
          i += 4;
          continue;
        }

        if (tri === '\x1b[H') { H.ptyCursor = 0; i += 3; continue; }
        if (tri === '\x1b[F') { H.ptyCursor = (H.ptyLine || '').length; i += 3; continue; }

        if (s[i + 1] === '[' || s[i + 1] === 'O') {
          let j = i + 2;
          while (j < s.length) {
            const c = s[j];
            if (c >= '@' && c <= '~') { j++; break; }
            j++;
          }
          i = j;
          continue;
        }

        i++;
        continue;
      }

      // Enter
      if (ch === '\r' || ch === '\n') {
        ptyCommitLine();
        i++;
        continue;
      }

      // Backspace
      if (ch === '\x7f' || ch === '\b') {
        if (H.ptyCursor > 0) {
          H.ptyLine = (H.ptyLine || '').slice(0, H.ptyCursor - 1) + (H.ptyLine || '').slice(H.ptyCursor);
          H.ptyCursor = Math.max(0, H.ptyCursor - 1);
          H.ptyHadPrintable = true;
        }
        i++;
        continue;
      }

      // Ctrl+C / Ctrl+D: cancel capture
      if (ch === '\x03' || ch === '\x04') {
        H.ptySensitive = false;
        ptyResetLine();
        i++;
        continue;
      }

      // Ctrl+U
      if (ch === '\x15') {
        if (H.ptyLine) H.ptyHadPrintable = true;
        ptyResetLine();
        i++;
        continue;
      }

      // Ctrl+W
      if (ch === '\x17') {
        if (H.ptyCursor > 0) {
          let k = H.ptyCursor;
          while (k > 0 && /\s/.test(H.ptyLine[k - 1])) k--;
          while (k > 0 && !/\s/.test(H.ptyLine[k - 1])) k--;
          H.ptyLine = H.ptyLine.slice(0, k) + H.ptyLine.slice(H.ptyCursor);
          H.ptyCursor = k;
          H.ptyHadPrintable = true;
        }
        i++;
        continue;
      }

      // Ctrl+A / Ctrl+E
      if (ch === '\x01') { H.ptyCursor = 0; i++; continue; }
      if (ch === '\x05') { H.ptyCursor = (H.ptyLine || '').length; i++; continue; }

      // Printable (incl tab)
      const code = ch.charCodeAt(0);
      if (code >= 0x20 || ch === '\t') {
        const line = H.ptyLine || '';
        const before = line.slice(0, H.ptyCursor);
        const after = line.slice(H.ptyCursor);
        H.ptyLine = before + ch + after;
        H.ptyCursor += 1;
        H.ptyHadPrintable = true;
      }

      i++;
    }
  }

  function attachTerm(term) {
    // Attach PTY typed-line capture.
    // Stage 2: input events are proxied by xterm_manager through ctx.events.
    if (H.ptyDisposable && typeof H.ptyDisposable.dispose === 'function') return;

    const ctx = getCtx();
    try {
      if (ctx && ctx.events && typeof ctx.events.on === 'function') {
        const off = ctx.events.on('xterm:data', (payload) => {
          try {
            const data = payload && typeof payload.data === 'string' ? payload.data : String(payload || '');
            consumePtyInput(data);
          } catch (e) {}
        });
        H.ptyDisposable = { dispose: () => { try { off(); } catch (e) {} } };
        return;
      }
    } catch (e) {}

    // Fallback: bind directly to xterm instance (older builds)
    try {
      if (!term) term = state.xterm || state.term || null;
      if (!term || typeof term.onData !== 'function') return;
      H.ptyDisposable = term.onData((data) => {
        try { consumePtyInput(data); } catch (e) {}
      });
    } catch (e2) {
      H.ptyDisposable = null;
    }
  }

  function bindUi(ctx) {
    if (H.uiDisposers && H.uiDisposers.length) return;

    const { modal, closeBtn, filter, insertBtn, runBtn, clearBtn, openBtn } = getEls(ctx);

    const disposers = [];
    function on(el, ev, fn, opts) {
      if (!el || !el.addEventListener) return;
      el.addEventListener(ev, fn, opts);
      disposers.push(() => {
        try { el.removeEventListener(ev, fn, opts); } catch (e) {}
      });
    }

    if (openBtn) on(openBtn, 'click', (e) => { try { e.preventDefault(); } catch (e2) {} open(); });
    if (closeBtn) on(closeBtn, 'click', (e) => { try { e.preventDefault(); } catch (e2) {} close(); });
    if (insertBtn) on(insertBtn, 'click', (e) => { try { e.preventDefault(); } catch (e2) {} insertSelected(); });
    if (runBtn) on(runBtn, 'click', (e) => { try { e.preventDefault(); } catch (e2) {} runSelected(); });
    if (clearBtn) on(clearBtn, 'click', (e) => { try { e.preventDefault(); } catch (e2) {} clearAll(); });
    if (filter) on(filter, 'input', () => { try { render(); } catch (e) {} });

    if (modal) {
      on(modal, 'mousedown', (e) => {
        try { if (e && e.target === modal) close(); } catch (e2) {}
      });
    }

    H.uiDisposers = disposers;
  }

  function unbindUi() {
    const ds = H.uiDisposers || null;
    H.uiDisposers = null;
    if (!ds) return;
    ds.forEach((d) => { try { if (typeof d === 'function') d(); } catch (e) {} });
  }

  function init() {
    try { if (!H.items || !H.items.length) load(); } catch (e) {}
    // Backward compatibility: bind UI once if someone calls history.init() directly.
    try { bindUi(getCtx()); } catch (e2) {}
    try { attachTerm(state.xterm || state.term); } catch (e3) {}
  }

  // Export
  window.XKeen.terminal.history = {
    init,
    load,
    save,
    push,
    clearAll,

    open,
    close,
    isOpen,
    render,
    select,
    insertSelected,
    runSelected,

    // PTY capture hooks
    attachTerm,
    consumePtyInput,
    markSensitiveFromOutput,

    // Stage E: registry plugin factory
    createModule: (ctx) => ({
      id: 'history',
      priority: 65,

      init: () => { try { if (!H.items || !H.items.length) load(); } catch (e) {} },

      onOpen: () => {
        try { bindUi(ctx); } catch (e) {}

        // Escape closes the history modal when it is open.
        try {
          if (!H.escHandler) {
            H.escHandler = (e) => {
              try {
                if (!e || e.key !== 'Escape') return;
                const { modal: m } = getEls(ctx);
                if (!m || m.classList.contains('hidden')) return;
                close();
              } catch (e2) {}
            };
            document.addEventListener('keydown', H.escHandler);
          }
        } catch (e) {}

        // command input history keys
        try {
          const { cmdEl } = getEls(ctx);
          if (!H.cmdKeysOff) H.cmdKeysOff = bindCmdHistoryKeys(cmdEl);
        } catch (e) {}
      },

      onClose: () => {
        try { if (isOpen()) close(); } catch (e) {}
        try { unbindUi(); } catch (e0) {}

        try { if (H.escHandler) document.removeEventListener('keydown', H.escHandler); } catch (e2) {}
        H.escHandler = null;

        try { if (H.cmdKeysOff) H.cmdKeysOff(); } catch (e3) {}
        H.cmdKeysOff = null;
      },

      attachTerm: (_ctx, term) => { try { attachTerm(term); } catch (e) {} },

      detachTerm: () => {
        try { if (H.ptyDisposable && typeof H.ptyDisposable.dispose === 'function') H.ptyDisposable.dispose(); } catch (e) {}
        H.ptyDisposable = null;
      },
    }),
  };
})();

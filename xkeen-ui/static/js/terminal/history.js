// Terminal history: drawer + localStorage + PTY typed-lines capture
(function () {
  'use strict';

  window.XKeen = window.XKeen || {};
  window.XKeen.terminal = window.XKeen.terminal || {};
  const core = (window.XKeen.terminal && window.XKeen.terminal._core) ? window.XKeen.terminal._core : null;
  const state = (core && core.state) ? core.state : (window.XKeen.terminal.__historyState = (window.XKeen.terminal.__historyState || {}));

  const KEY = 'xkeen_terminal_history'; // keep legacy key for backward compatibility
  const LIMIT = 50;

  const H = state.history = state.history || {
    items: [],
    index: 0,
    selected: '',
    uiBound: false,
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
    // fallback
    try {
      const anyOpen = document.querySelector('.modal:not(.hidden), .terminal-overlay:not([style*="display:none"])');
      if (anyOpen) document.body.classList.add('modal-open');
      else document.body.classList.remove('modal-open');
    } catch (e) {}
  }

  function getEls() {
    return {
      modal: document.getElementById('terminal-history-modal'),
      closeBtn: document.getElementById('terminal-history-close-btn'),
      filter: document.getElementById('terminal-history-filter'),
      list: document.getElementById('terminal-history-list'),
      insertBtn: document.getElementById('terminal-history-insert-btn'),
      runBtn: document.getElementById('terminal-history-run-btn'),
      clearBtn: document.getElementById('terminal-history-clear-btn'),
      openBtn: document.getElementById('terminal-history-btn'),
      cmdEl: document.getElementById('terminal-command'),
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
      if (core && typeof core.getMode === 'function') return (core.getMode() === 'pty');
    } catch (e) {}
    // fallback to legacy helper
    try {
      if (typeof window.isPtyActive === 'function') return !!window.isPtyActive();
    } catch (e) {}
    return false;
  }

  function sendToPty(raw) {
    // Prefer new module API
    try {
      if (window.XKeen && XKeen.terminal && XKeen.terminal.pty && typeof XKeen.terminal.pty.sendRaw === 'function') {
        XKeen.terminal.pty.sendRaw(raw);
        return true;
      }
    } catch (e) {}
    // Legacy fallback (if still present in terminal.js)
    try {
      if (typeof window.terminalSendRaw === 'function') {
        window.terminalSendRaw(raw);
        return true;
      }
    } catch (e) {}
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

    // Lite: run via lite_runner flow (reads #terminal-command)
    try {
      const { cmdEl } = getEls();
      if (cmdEl) cmdEl.value = cmd;
      const inputEl = document.getElementById('terminal-input');
      if (inputEl) inputEl.value = '';
    } catch (e) {}

    close();
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
    if (!cmdEl) return;

    cmdEl.addEventListener('keydown', (e) => {
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
    }, true);
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
    // Attach PTY input capture to xterm instance (safe to call multiple times)
    if (!term) term = state.xterm || state.term || null;
    if (!term || typeof term.onData !== 'function') return;

    if (H.ptyDisposable && typeof H.ptyDisposable.dispose === 'function') return;

    try {
      H.ptyDisposable = term.onData((data) => {
        try { consumePtyInput(data); } catch (e) {}
      });
    } catch (e) {
      H.ptyDisposable = null;
    }
  }

  function bindUiOnce() {
    if (H.uiBound) return;
    H.uiBound = true;

    const { modal, closeBtn, filter, insertBtn, runBtn, clearBtn, openBtn, cmdEl } = getEls();

    if (openBtn) openBtn.addEventListener('click', (e) => { try { e.preventDefault(); } catch (e2) {} open(); });

    if (closeBtn) closeBtn.addEventListener('click', (e) => { try { e.preventDefault(); } catch (e2) {} close(); });
    if (insertBtn) insertBtn.addEventListener('click', (e) => { try { e.preventDefault(); } catch (e2) {} insertSelected(); });
    if (runBtn) runBtn.addEventListener('click', (e) => { try { e.preventDefault(); } catch (e2) {} runSelected(); });
    if (clearBtn) clearBtn.addEventListener('click', (e) => { try { e.preventDefault(); } catch (e2) {} clearAll(); });
    if (filter) filter.addEventListener('input', () => { try { render(); } catch (e) {} });

    if (modal) {
      modal.addEventListener('mousedown', (e) => {
        try { if (e.target === modal) close(); } catch (e2) {}
      });
    }

    document.addEventListener('keydown', (e) => {
      try {
        if (e.key !== 'Escape') return;
        const { modal: m } = getEls();
        if (!m || m.classList.contains('hidden')) return;
        close();
      } catch (e2) {}
    });

    // command input history keys
    try { bindCmdHistoryKeys(cmdEl); } catch (e) {}
  }

  function init() {
    try { if (!H.items || !H.items.length) load(); } catch (e) {}
    try { bindUiOnce(); } catch (e) {}
    try { attachTerm(state.xterm || state.term); } catch (e) {}
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
  };
})();

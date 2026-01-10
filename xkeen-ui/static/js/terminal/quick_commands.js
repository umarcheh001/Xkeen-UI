// Terminal Quick Commands (QC): "Команды" menu (insert/run) + command list
// Terminal-specific UI feature.
(function () {
  'use strict';

  window.XKeen = window.XKeen || {};
  window.XKeen.terminal = window.XKeen.terminal || {};

  const core = window.XKeen.terminal._core || null;

  function getCtx() {
    try {
      const C = window.XKeen.terminal.core;
      if (C && typeof C.getCtx === 'function') return C.getCtx();
    } catch (e) {}
    return null;
  }

  // --------------------
  // Storage
  // --------------------
  const XKEEN_TERMINAL_QC_MODE_KEY = 'xkeen_terminal_qc_mode_v1';

  // --------------------
  // Command list
  // --------------------
  const TERMINAL_QUICK_COMMANDS = [
    { label: 'ip a', cmd: 'ip a', desc: 'Интерфейсы и адреса' },
    { label: 'ip r', cmd: 'ip r', desc: 'Таблица маршрутизации' },
    { label: 'ip rule', cmd: 'ip rule', desc: 'Policy routing rules' },
    { label: 'iptables -t mangle -S', cmd: 'iptables -t mangle -S', desc: 'Mangle правила (TPROXY/mark)' },
    { label: 'logread -f', cmd: 'logread -f', desc: 'Системный лог (follow)' },
    { label: 'dmesg -w', cmd: 'dmesg -w', desc: 'Kernel log (follow)' },
    { label: 'nslookup …', cmd: 'nslookup example.com', select: 'example.com', desc: 'DNS lookup (замени домен)' },
    { label: 'ping -c 3 …', cmd: 'ping -c 3 8.8.8.8', select: '8.8.8.8', desc: 'Проверка ICMP (замени адрес)' },
    { label: 'sysmon', cmd: 'sysmon', desc: 'Мониторинг роутера (базовый)' },
    { label: 'sysmon --short', cmd: 'sysmon --short', desc: 'Мониторинг (коротко, только главное)' },
    { label: 'sysmon --full', cmd: 'sysmon --full', desc: 'Мониторинг (расширенная диагностика)' },
    { label: 'sysmon --json', cmd: 'sysmon --json', desc: 'Мониторинг (JSON для парсинга/логов)' },
  ];

  // --------------------
  // Small helpers
  // --------------------
  function esc(s) {
    try {
      if (typeof window.escapeHtml === 'function') return window.escapeHtml(String(s == null ? '' : s));
    } catch (e) {}
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function byId(id, ctx) {
    try {
      if (ctx && ctx.ui && typeof ctx.ui.byId === 'function') return ctx.ui.byId(id);
    } catch (e0) {}
    try {
      if (core && typeof core.byId === 'function') return core.byId(id);
    } catch (e) {}
    return null;
  }

  function getMode(ctx) {
    try {
      const m = ctx && ctx.state ? ctx.state.mode : null;
      if (m) return m;
    } catch (e0) {}
    // Prefer core state (single source of truth is ctx/core).
    try {
      if (core && typeof core.getMode === 'function') return core.getMode();
    } catch (e) {}
    return 'shell';
  }

  function isPtyConnected(ctx) {
    // Determine whether there is an actual open PTY WebSocket.
    // Supports both legacy terminal.js PTY (internal ptyWs) and the new pty.js module (core.state.ptyWs).
    try {
      // ctx.transport.isConnected() in lite mode is always true — here we mean *PTY websocket*.
      if (ctx && ctx.transport && typeof ctx.transport.isConnected === 'function') {
        if (ctx.transport.kind === 'pty') return !!ctx.transport.isConnected();
      }
    } catch (e0) {}
    try {
      const st = (core && core.state) ? core.state : null;
      const ws = st ? st.ptyWs : null;
      if (ws && ws.readyState === WebSocket.OPEN) return true;
    } catch (e) {}
    return false;
  }

  function focusTerminal(ctx) {
    const c = ctx || getCtx();
    try {
      if (c && c.xterm && typeof c.xterm.getRefs === 'function') {
        const r = c.xterm.getRefs();
        const t = r && (r.term || r.xterm) ? (r.term || r.xterm) : null;
        if (t && typeof t.focus === 'function') return t.focus();
      }
    } catch (e0) {}
    try {
      const st = c && c.core && c.core.state ? c.core.state : null;
      const t = st ? (st.term || st.xterm) : null;
      if (t && typeof t.focus === 'function') return t.focus();
    } catch (e1) {}
    try {
      const t = (core && core.state) ? (core.state.term || core.state.xterm) : null;
      if (t && typeof t.focus === 'function') t.focus();
    } catch (e2) {}
  }

  // --------------------
  // Mode (insert/run)
  // --------------------
  function qcGetMode() {
    try {
      const v = localStorage.getItem(XKEEN_TERMINAL_QC_MODE_KEY);
      return (v === 'run' || v === 'insert') ? v : 'insert';
    } catch (e) {
      return 'insert';
    }
  }

  function qcSetMode(mode, ctx) {
    const m = (mode === 'run') ? 'run' : 'insert';
    try { localStorage.setItem(XKEEN_TERMINAL_QC_MODE_KEY, m); } catch (e) {}
    try { qcUpdateModeUi(ctx); } catch (e) {}
  }

  function qcUpdateModeUi(ctx) {
    const mode = qcGetMode();
    const bInsert = byId('terminal-qc-mode-insert', ctx);
    const bRun = byId('terminal-qc-mode-run', ctx);
    if (bInsert) bInsert.classList.toggle('is-active', mode === 'insert');
    if (bRun) bRun.classList.toggle('is-active', mode === 'run');
  }

  // --------------------
  // Menu show/hide
  // --------------------
  function hideMenu(ctx) {
    const m = byId('terminal-commands-menu', ctx);
    if (!m) return;
    m.classList.add('hidden');
  }

  function toggleMenu(ev, ctx) {
    if (ev && ev.stopPropagation) ev.stopPropagation();
    // close other menus if the PTY module is in use
    try {
      const pty = window.XKeen && window.XKeen.terminal && window.XKeen.terminal.pty;
      if (pty && typeof pty.hideSignalsMenu === 'function') pty.hideSignalsMenu();
    } catch (e) {}

    const m = byId('terminal-commands-menu', ctx);
    if (!m) return;
    const willShow = m.classList.contains('hidden');
    if (willShow) {
      try { ensureMenuBuilt(ctx); } catch (e) {}
      try { qcUpdateModeUi(ctx); } catch (e) {}
    }
    m.classList.toggle('hidden');
  }

  // --------------------
  // Insert/run actions
  // --------------------
  function insertIntoLite(cmd, selectToken, ctx) {
    const cmdEl = byId('terminal-command', ctx);
    if (!cmdEl) return;

    cmdEl.style.display = '';
    cmdEl.value = String(cmd || '');

    try {
      cmdEl.focus();
      const val = cmdEl.value || '';
      if (selectToken && val.indexOf(selectToken) !== -1 && typeof cmdEl.setSelectionRange === 'function') {
        const start = val.indexOf(selectToken);
        const end = start + String(selectToken).length;
        cmdEl.setSelectionRange(start, end);
      } else if (typeof cmdEl.setSelectionRange === 'function') {
        const pos = val.length;
        cmdEl.setSelectionRange(pos, pos);
      }
    } catch (e) {}
  }

  function sendPtyRaw(payload, ctx) {
    const data = String(payload == null ? '' : payload);

    // Stage B: unified transport
    try {
      if (ctx && ctx.transport && typeof ctx.transport.send === 'function') {
        return !!ctx.transport.send(data, { prefer: 'pty', allowWhenDisconnected: false });
      }
    } catch (e0) {}

    // Backward compatibility fallback (should be removed once terminal.js is fully modular)
    try {
      const st = (core && core.state) ? core.state : null;
      const ws = st ? st.ptyWs : null;
      if (ws && ws.readyState === WebSocket.OPEN) {
        const pty = window.XKeen && window.XKeen.terminal && window.XKeen.terminal.pty;
        if (pty && typeof pty.sendRaw === 'function') { pty.sendRaw(data); return true; }
      }
    } catch (e) {}

    return false;
  }

  function runLite(ctx) {
    // Prefer Stage C unified execCommand (router -> transport). Fallback to lite_runner/legacy.
    try {
      const T = window.XKeen && window.XKeen.terminal ? window.XKeen.terminal : null;
      const cmdEl = byId('terminal-command', ctx);
      const cmd = cmdEl ? String(cmdEl.value || '') : '';
      if (T && typeof T.execCommand === 'function') {
        return T.execCommand(cmd, { source: 'quick_commands' });
      }
    } catch (e0) {}
    try {
      const lr = window.XKeen && window.XKeen.terminal && window.XKeen.terminal.lite_runner;
      if (lr && typeof lr.sendTerminalInput === 'function') return lr.sendTerminalInput();
    } catch (e) {}
  }

  function qcInsert(cmd, selectToken, ctx) {
    hideMenu(ctx);
    if (getMode(ctx) === 'pty') {
      if (!isPtyConnected(ctx)) {
        try {
          if (ctx && ctx.ui && typeof ctx.ui.toast === 'function') ctx.ui.toast('PTY не подключён', 'info');
          else if (typeof window.showToast === 'function') window.showToast('PTY не подключён', 'info');
        } catch (e) {}
        return;
      }
      try { sendPtyRaw(String(cmd || ''), ctx); } catch (e) {}
      focusTerminal(ctx);
      return;
    }
    insertIntoLite(cmd, selectToken, ctx);
  }

  function qcRun(cmd, ctx) {
    hideMenu(ctx);
    if (getMode(ctx) === 'pty') {
      if (!isPtyConnected(ctx)) {
        try {
          if (ctx && ctx.ui && typeof ctx.ui.toast === 'function') ctx.ui.toast('PTY не подключён', 'info');
          else if (typeof window.showToast === 'function') window.showToast('PTY не подключён', 'info');
        } catch (e) {}
        return;
      }
      try { sendPtyRaw(String(cmd || '') + '\r', ctx); } catch (e) {}
      focusTerminal(ctx);
      return;
    }
    // Lite/shell/xkeen: route through unified executor so builtins also work.
    try {
      const T = window.XKeen && window.XKeen.terminal ? window.XKeen.terminal : null;
      if (T && typeof T.execCommand === 'function') {
        void T.execCommand(String(cmd || ''), { source: 'quick_commands' });
        focusTerminal(ctx);
        return;
      }
    } catch (e) {}

    insertIntoLite(cmd, null, ctx);
    try { void runLite(ctx); } catch (e) {}
  }

  function handleItemClick(ev, item, ctx) {
    const cmd = item && item.cmd ? item.cmd : '';
    const selectToken = item && item.select ? item.select : null;

    // Modifiers override default: Ctrl/⌘ => run, Shift => insert
    const forceRun = !!(ev && (ev.ctrlKey || ev.metaKey));
    const forceInsert = !!(ev && ev.shiftKey);

    if (forceRun) return qcRun(cmd, ctx);
    if (forceInsert) return qcInsert(cmd, selectToken, ctx);

    const mode = qcGetMode();
    if (mode === 'run') return qcRun(cmd, ctx);
    return qcInsert(cmd, selectToken, ctx);
  }

  // --------------------
  // Build menu list
  // --------------------
  let menuBuilt = false;
  function ensureMenuBuilt(ctx) {
    if (menuBuilt) return;
    menuBuilt = true;

    const list = byId('terminal-commands-list', ctx);
    if (!list) return;
    list.innerHTML = '';

    TERMINAL_QUICK_COMMANDS.forEach((q) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'terminal-commands-item';

      const label = esc(q.label || q.cmd || '');
      const desc = esc(q.desc || '');
      btn.innerHTML =
        '<span class="terminal-commands-item-label">' + label + '</span>' +
        (desc ? '<span class="terminal-commands-item-desc">' + desc + '</span>' : '');

      btn.addEventListener('click', (ev) => {
        try { ev.stopPropagation(); } catch (e) {}
        handleItemClick(ev, q, ctx);
      });
      list.appendChild(btn);
    });

    qcUpdateModeUi();
  }

  // --------------------
  // Auto-close (bound only while overlay is open)
  // --------------------
  let autoCloseBound = false;
  let autoCloseDocClick = null;
  let autoCloseDocKey = null;
  let menuClickStopBound = false;
  let menuClickStopHandler = null;

  function bindAutoClose(ctx) {
    if (autoCloseBound) return;
    autoCloseBound = true;

    autoCloseDocClick = (ev) => {
      try {
        const menu = byId('terminal-commands-menu', ctx);
        const btn = byId('terminal-btn-commands', ctx);
        const t = ev && ev.target ? ev.target : null;
        if (menu && t && menu.contains(t)) return;
        if (btn && t && btn.contains(t)) return;
      } catch (e) {}
      hideMenu(ctx);
    };
    document.addEventListener('click', autoCloseDocClick, true);

    autoCloseDocKey = (e) => {
      if (e && e.key === 'Escape') hideMenu(ctx);
    };
    document.addEventListener('keydown', autoCloseDocKey, true);

    // Stop propagation inside the menu itself (bind once per open; removed on close)
    try {
      if (!menuClickStopBound) {
        const m = byId('terminal-commands-menu', ctx);
        if (m) {
          menuClickStopHandler = (e) => {
            try { e.stopPropagation(); } catch (e2) {}
          };
          m.addEventListener('click', menuClickStopHandler);
          menuClickStopBound = true;
        }
      }
    } catch (e) {}
  }

  function unbindAutoClose(ctx) {
    if (!autoCloseBound) return;
    autoCloseBound = false;
    try { if (autoCloseDocClick) document.removeEventListener('click', autoCloseDocClick, true); } catch (e) {}
    try { if (autoCloseDocKey) document.removeEventListener('keydown', autoCloseDocKey, true); } catch (e) {}
    autoCloseDocClick = null;
    autoCloseDocKey = null;

    try {
      if (menuClickStopBound) {
        const m = byId('terminal-commands-menu', ctx || getCtx());
        if (m && menuClickStopHandler) m.removeEventListener('click', menuClickStopHandler);
      }
    } catch (e2) {}
    menuClickStopHandler = null;
    menuClickStopBound = false;
  }

  // --------------------
  // Public init (bind UI)
  // --------------------
  let inited = false;
  let uiDisposers = [];

  function on(el, ev, fn, opts) {
    if (!el || !el.addEventListener) return;
    el.addEventListener(ev, fn, opts);
    uiDisposers.push(() => {
      try { el.removeEventListener(ev, fn, opts); } catch (e) {}
    });
  }

  function disposeUi() {
    const ds = uiDisposers.splice(0, uiDisposers.length);
    ds.forEach((d) => { try { if (typeof d === 'function') d(); } catch (e) {} });
    inited = false;
  }

  function init(ctx) {
    if (inited) return true;
    inited = true;

    // Prepare mode UI (buttons may exist even if menu isn't opened yet)
    try { qcUpdateModeUi(ctx); } catch (e) {}

    // Wire buttons (re-bindable; removed on terminal close)
    try {
      const btn = byId('terminal-btn-commands', ctx);
      if (btn) on(btn, 'click', (ev) => toggleMenu(ev, ctx));
    } catch (e) {}
    try {
      const bIns = byId('terminal-qc-mode-insert', ctx);
      if (bIns) on(bIns, 'click', () => qcSetMode('insert', ctx));
      const bRun = byId('terminal-qc-mode-run', ctx);
      if (bRun) on(bRun, 'click', () => qcSetMode('run', ctx));
    } catch (e) {}

    return true;
  }

  // Export
  window.XKeen.terminal.quick_commands = {
    init: () => init(getCtx()),
    // actions
    toggleMenu: (ev) => toggleMenu(ev, getCtx()),
    hideMenu: () => hideMenu(getCtx()),
    insert: (cmd, selectToken) => qcInsert(cmd, selectToken, getCtx()),
    run: (cmd) => qcRun(cmd, getCtx()),
    // mode
    getMode: qcGetMode,
    setMode: (mode) => qcSetMode(mode, getCtx()),
    updateModeUi: () => qcUpdateModeUi(getCtx()),
    // data
    TERMINAL_QUICK_COMMANDS,
    // Stage E: registry plugin factory
    createModule: (ctx) => ({
      id: 'quick_commands',
      priority: 75,
      init: () => { try { init(ctx); } catch (e) {} },
      onOpen: () => {
        try { init(ctx); } catch (e0) {}
        try { bindAutoClose(ctx); } catch (e) {}
      },
      onClose: () => {
        try { hideMenu(ctx); } catch (e2) {}
        try {
          // clear menu DOM to drop per-item listeners
          const list = byId('terminal-commands-list', ctx);
          if (list) list.innerHTML = '';
          menuBuilt = false;
        } catch (e3) {}
        try { unbindAutoClose(ctx); } catch (e) {}
        try { disposeUi(); } catch (e4) {}
      },
      onModeChange: () => { try { qcUpdateModeUi(ctx); } catch (e) {} },
    }),
  };
})();

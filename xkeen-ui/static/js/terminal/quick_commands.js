import {
  ensureTerminalRoot,
  escapeTerminalHtml,
  focusTerminalView,
  getTerminalById,
  getTerminalCompatApi,
  getTerminalContext,
  getTerminalExecCommand,
  getTerminalMode,
  getTerminalPtyApi,
  isTerminalPtyConnected,
  publishTerminalCompatApi,
  toastTerminal,
} from './runtime.js';

// Terminal Quick Commands (QC): "Команды" menu (insert/run) + command list
// Terminal-specific UI feature.
(function () {
  'use strict';

  const core = getTerminalCompatApi('_core');

  function getCtx() {
    return getTerminalContext();
  }

  const XKEEN_TERMINAL_QC_MODE_KEY = 'xkeen_terminal_qc_mode_v1';

  const TERMINAL_QUICK_COMMANDS = [
    { label: 'ip a', cmd: 'ip a', desc: 'Интерфейсы и адреса' },
    { label: 'ip r', cmd: 'ip r', desc: 'Таблица маршрутизации' },
    { label: 'ip rule', cmd: 'ip rule', desc: 'Policy routing rules' },
    { label: 'iptables -t mangle -S', cmd: 'iptables -t mangle -S', desc: 'Mangle правила (TPROXY/mark)' },
    { label: 'nslookup ...', cmd: 'nslookup example.com', select: 'example.com', desc: 'DNS lookup (замени домен)' },
    { label: 'ping -c 3 ...', cmd: 'ping -c 3 8.8.8.8', select: '8.8.8.8', desc: 'Проверка ICMP (замени адрес)' },
    { label: 'sysmon --full', cmd: 'sysmon --full', desc: 'Мониторинг (расширенная диагностика)' },
  ];

  function esc(s) {
    return escapeTerminalHtml(String(s == null ? '' : s));
  }

  function byId(id, ctx) {
    const current = ctx || getCtx();
    return getTerminalById(id, (key) => {
      try {
        if (current && current.ui && typeof current.ui.byId === 'function') return current.ui.byId(key);
      } catch (error) {}
      try {
        if (core && typeof core.byId === 'function') return core.byId(key);
      } catch (error2) {}
      return null;
    });
  }

  function getMode(ctx) {
    return getTerminalMode(ctx);
  }

  function isPtyConnected(ctx) {
    void ctx;
    return isTerminalPtyConnected();
  }

  function focusTerminal(ctx) {
    void ctx;
    if (focusTerminalView()) return;

    const current = ctx || getCtx();
    try {
      if (current && current.xterm && typeof current.xterm.getRefs === 'function') {
        const refs = current.xterm.getRefs();
        const term = refs && (refs.term || refs.xterm) ? (refs.term || refs.xterm) : null;
        if (term && typeof term.focus === 'function') return term.focus();
      }
    } catch (error) {}
    try {
      const state = current && current.core && current.core.state ? current.core.state : null;
      const term = state ? (state.term || state.xterm) : null;
      if (term && typeof term.focus === 'function') return term.focus();
    } catch (error2) {}
    try {
      const state = (core && core.state) ? core.state : null;
      const term = state ? (state.term || state.xterm) : null;
      if (term && typeof term.focus === 'function') term.focus();
    } catch (error3) {}
  }

  function qcGetMode() {
    try {
      const value = localStorage.getItem(XKEEN_TERMINAL_QC_MODE_KEY);
      return (value === 'run' || value === 'insert') ? value : 'insert';
    } catch (error) {
      return 'insert';
    }
  }

  function qcSetMode(mode, ctx) {
    const next = (mode === 'run') ? 'run' : 'insert';
    try { localStorage.setItem(XKEEN_TERMINAL_QC_MODE_KEY, next); } catch (error) {}
    try { qcUpdateModeUi(ctx); } catch (error2) {}
  }

  function qcUpdateModeUi(ctx) {
    const mode = qcGetMode();
    const insertBtn = byId('terminal-qc-mode-insert', ctx);
    const runBtn = byId('terminal-qc-mode-run', ctx);
    if (insertBtn) insertBtn.classList.toggle('is-active', mode === 'insert');
    if (runBtn) runBtn.classList.toggle('is-active', mode === 'run');
  }

  function hideMenu(ctx) {
    const menu = byId('terminal-commands-menu', ctx);
    if (!menu) return;
    menu.classList.add('hidden');
  }

  function toggleMenu(ev, ctx) {
    if (ev && ev.stopPropagation) ev.stopPropagation();
    try {
      const pty = getTerminalPtyApi();
      if (pty && typeof pty.hideSignalsMenu === 'function') pty.hideSignalsMenu();
    } catch (error) {}

    const menu = byId('terminal-commands-menu', ctx);
    if (!menu) return;
    const willShow = menu.classList.contains('hidden');
    if (willShow) {
      try { ensureMenuBuilt(ctx); } catch (error2) {}
      try { qcUpdateModeUi(ctx); } catch (error3) {}
    }
    menu.classList.toggle('hidden');
  }

  function insertIntoLite(cmd, selectToken, ctx) {
    const cmdEl = byId('terminal-command', ctx);
    if (!cmdEl) return;

    cmdEl.style.display = '';
    cmdEl.value = String(cmd || '');

    try {
      cmdEl.focus();
      const value = cmdEl.value || '';
      if (selectToken && value.indexOf(selectToken) !== -1 && typeof cmdEl.setSelectionRange === 'function') {
        const start = value.indexOf(selectToken);
        const end = start + String(selectToken).length;
        cmdEl.setSelectionRange(start, end);
      } else if (typeof cmdEl.setSelectionRange === 'function') {
        const pos = value.length;
        cmdEl.setSelectionRange(pos, pos);
      }
    } catch (error) {}
  }

  function sendPtyRaw(payload, ctx) {
    const data = String(payload == null ? '' : payload);

    try {
      if (ctx && ctx.transport && typeof ctx.transport.send === 'function') {
        return !!ctx.transport.send(data, { prefer: 'pty', allowWhenDisconnected: false });
      }
    } catch (error) {}

    try {
      const state = (core && core.state) ? core.state : null;
      const ws = state ? state.ptyWs : null;
      if (ws && ws.readyState === WebSocket.OPEN) {
        const pty = getTerminalPtyApi();
        if (pty && typeof pty.sendRaw === 'function') return !!pty.sendRaw(data);
      }
    } catch (error2) {}

    return false;
  }

  function runLite(ctx) {
    try {
      const cmdEl = byId('terminal-command', ctx);
      const cmd = cmdEl ? String(cmdEl.value || '') : '';
      const execCommand = getTerminalExecCommand();
      if (execCommand) return execCommand(cmd, { source: 'quick_commands' });
    } catch (error) {}
    try {
      const liteRunner = getTerminalCompatApi('lite_runner');
      if (liteRunner && typeof liteRunner.sendTerminalInput === 'function') return liteRunner.sendTerminalInput();
    } catch (error2) {}
  }

  function notifyPtyMissing(ctx) {
    try {
      if (ctx && ctx.ui && typeof ctx.ui.toast === 'function') {
        ctx.ui.toast('PTY не подключён', 'info');
        return;
      }
    } catch (error) {}
    toastTerminal('PTY не подключён', 'info');
  }

  function qcInsert(cmd, selectToken, ctx) {
    hideMenu(ctx);
    if (getMode(ctx) === 'pty') {
      if (!isPtyConnected(ctx)) {
        notifyPtyMissing(ctx);
        return;
      }
      try { sendPtyRaw(String(cmd || ''), ctx); } catch (error) {}
      focusTerminal(ctx);
      return;
    }
    insertIntoLite(cmd, selectToken, ctx);
  }

  function qcRun(cmd, ctx) {
    hideMenu(ctx);
    if (getMode(ctx) === 'pty') {
      if (!isPtyConnected(ctx)) {
        notifyPtyMissing(ctx);
        return;
      }
      try { sendPtyRaw(String(cmd || '') + '\r', ctx); } catch (error) {}
      focusTerminal(ctx);
      return;
    }

    try {
      const execCommand = getTerminalExecCommand();
      if (execCommand) {
        void execCommand(String(cmd || ''), { source: 'quick_commands' });
        focusTerminal(ctx);
        return;
      }
    } catch (error2) {}

    insertIntoLite(cmd, null, ctx);
    try { void runLite(ctx); } catch (error3) {}
  }

  function handleItemClick(ev, item, ctx) {
    const cmd = item && item.cmd ? item.cmd : '';
    const selectToken = item && item.select ? item.select : null;

    const forceRun = !!(ev && (ev.ctrlKey || ev.metaKey));
    const forceInsert = !!(ev && ev.shiftKey);

    if (forceRun) return qcRun(cmd, ctx);
    if (forceInsert) return qcInsert(cmd, selectToken, ctx);

    const mode = qcGetMode();
    if (mode === 'run') return qcRun(cmd, ctx);
    return qcInsert(cmd, selectToken, ctx);
  }

  let menuBuilt = false;
  function ensureMenuBuilt(ctx) {
    if (menuBuilt) return;
    menuBuilt = true;

    const list = byId('terminal-commands-list', ctx);
    if (!list) return;
    list.innerHTML = '';

    TERMINAL_QUICK_COMMANDS.forEach((item) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'terminal-commands-item';

      const label = esc(item.label || item.cmd || '');
      const desc = esc(item.desc || '');
      btn.innerHTML =
        '<span class="terminal-commands-item-label">' + label + '</span>' +
        (desc ? '<span class="terminal-commands-item-desc">' + desc + '</span>' : '');

      btn.addEventListener('click', (ev) => {
        try { ev.stopPropagation(); } catch (error) {}
        handleItemClick(ev, item, ctx);
      });
      list.appendChild(btn);
    });

    qcUpdateModeUi(ctx);
  }

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
        const target = ev && ev.target ? ev.target : null;
        if (menu && target && menu.contains(target)) return;
        if (btn && target && btn.contains(target)) return;
      } catch (error) {}
      hideMenu(ctx);
    };
    document.addEventListener('click', autoCloseDocClick, true);

    autoCloseDocKey = (ev) => {
      if (ev && ev.key === 'Escape') hideMenu(ctx);
    };
    document.addEventListener('keydown', autoCloseDocKey, true);

    try {
      if (!menuClickStopBound) {
        const menu = byId('terminal-commands-menu', ctx);
        if (menu) {
          menuClickStopHandler = (ev) => {
            try { ev.stopPropagation(); } catch (error2) {}
          };
          menu.addEventListener('click', menuClickStopHandler);
          menuClickStopBound = true;
        }
      }
    } catch (error3) {}
  }

  function unbindAutoClose(ctx) {
    if (!autoCloseBound) return;
    autoCloseBound = false;
    try { if (autoCloseDocClick) document.removeEventListener('click', autoCloseDocClick, true); } catch (error) {}
    try { if (autoCloseDocKey) document.removeEventListener('keydown', autoCloseDocKey, true); } catch (error2) {}
    autoCloseDocClick = null;
    autoCloseDocKey = null;

    try {
      if (menuClickStopBound) {
        const menu = byId('terminal-commands-menu', ctx || getCtx());
        if (menu && menuClickStopHandler) menu.removeEventListener('click', menuClickStopHandler);
      }
    } catch (error3) {}
    menuClickStopHandler = null;
    menuClickStopBound = false;
  }

  let inited = false;
  let uiDisposers = [];

  function on(el, ev, fn, opts) {
    if (!el || !el.addEventListener) return;
    el.addEventListener(ev, fn, opts);
    uiDisposers.push(() => {
      try { el.removeEventListener(ev, fn, opts); } catch (error) {}
    });
  }

  function disposeUi() {
    const disposers = uiDisposers.splice(0, uiDisposers.length);
    disposers.forEach((dispose) => {
      try { if (typeof dispose === 'function') dispose(); } catch (error) {}
    });
    inited = false;
  }

  function init(ctx) {
    if (inited) return true;
    inited = true;

    try { qcUpdateModeUi(ctx); } catch (error) {}

    try {
      const btn = byId('terminal-btn-commands', ctx);
      if (btn) on(btn, 'click', (ev) => toggleMenu(ev, ctx));
    } catch (error2) {}
    try {
      const insertBtn = byId('terminal-qc-mode-insert', ctx);
      if (insertBtn) on(insertBtn, 'click', () => qcSetMode('insert', ctx));
      const runBtn = byId('terminal-qc-mode-run', ctx);
      if (runBtn) on(runBtn, 'click', () => qcSetMode('run', ctx));
    } catch (error3) {}

    return true;
  }

  const terminalQuickCommandsApi = {
    init: () => init(getCtx()),
    toggleMenu: (ev) => toggleMenu(ev, getCtx()),
    hideMenu: () => hideMenu(getCtx()),
    insert: (cmd, selectToken) => qcInsert(cmd, selectToken, getCtx()),
    run: (cmd) => qcRun(cmd, getCtx()),
    getMode: qcGetMode,
    setMode: (mode) => qcSetMode(mode, getCtx()),
    updateModeUi: () => qcUpdateModeUi(getCtx()),
    TERMINAL_QUICK_COMMANDS,
    createModule: (ctx) => ({
      id: 'quick_commands',
      priority: 75,
      init: () => { try { init(ctx); } catch (error) {} },
      onOpen: () => {
        try { init(ctx); } catch (error) {}
        try { bindAutoClose(ctx); } catch (error2) {}
      },
      onClose: () => {
        try { hideMenu(ctx); } catch (error) {}
        try {
          const list = byId('terminal-commands-list', ctx);
          if (list) list.innerHTML = '';
          menuBuilt = false;
        } catch (error2) {}
        try { unbindAutoClose(ctx); } catch (error3) {}
        try { disposeUi(); } catch (error4) {}
      },
      onModeChange: () => { try { qcUpdateModeUi(ctx); } catch (error) {} },
    }),
  };

  try {
    const terminal = ensureTerminalRoot();
    if (terminal) terminal.quickCommands = terminalQuickCommandsApi;
  } catch (error) {}

  publishTerminalCompatApi('quick_commands', terminalQuickCommandsApi);
})();

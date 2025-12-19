// Terminal Quick Commands (QC): "Команды" menu (insert/run) + command list
// Terminal-specific UI feature.
(function () {
  'use strict';

  window.XKeen = window.XKeen || {};
  window.XKeen.terminal = window.XKeen.terminal || {};

  const core = window.XKeen.terminal._core || null;

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

  function byId(id) {
    try {
      if (core && typeof core.byId === 'function') return core.byId(id);
    } catch (e) {}
    return document.getElementById(id);
  }

  function getMode() {
    // Prefer core state (future), fall back to legacy terminal.js bridge.
    try {
      if (core && typeof core.getMode === 'function') return core.getMode();
    } catch (e) {}
    try {
      const leg = window.XKeen && window.XKeen.terminal && window.XKeen.terminal._legacy;
      if (leg && typeof leg.getMode === 'function') return leg.getMode();
    } catch (e) {}
    return 'shell';
  }

  function isPtyConnected() {
    // Prefer new PTY module if used; otherwise consult legacy bridge.
    try {
      const pty = window.XKeen.terminal.pty;
      // no explicit isConnected API in pty.js, but sendRaw will throw if not ready.
      // We'll still try legacy for a clearer check.
      if (pty && typeof pty.sendRaw === 'function') {
        // best effort: if a ws exists in shared state (pty.js keeps it in its closure)
        // so we can't check here. fall through.
      }
    } catch (e) {}
    try {
      const leg = window.XKeen && window.XKeen.terminal && window.XKeen.terminal._legacy;
      if (leg && typeof leg.isPtyConnected === 'function') return !!leg.isPtyConnected();
    } catch (e) {}
    return false;
  }

  function focusTerminal() {
    try {
      const leg = window.XKeen && window.XKeen.terminal && window.XKeen.terminal._legacy;
      if (leg && typeof leg.focus === 'function') return leg.focus();
    } catch (e) {}
    try {
      const t = (core && core.state) ? (core.state.term || core.state.xterm) : null;
      if (t && typeof t.focus === 'function') t.focus();
    } catch (e) {}
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

  function qcSetMode(mode) {
    const m = (mode === 'run') ? 'run' : 'insert';
    try { localStorage.setItem(XKEEN_TERMINAL_QC_MODE_KEY, m); } catch (e) {}
    try { qcUpdateModeUi(); } catch (e) {}
  }

  function qcUpdateModeUi() {
    const mode = qcGetMode();
    const bInsert = byId('terminal-qc-mode-insert');
    const bRun = byId('terminal-qc-mode-run');
    if (bInsert) bInsert.classList.toggle('is-active', mode === 'insert');
    if (bRun) bRun.classList.toggle('is-active', mode === 'run');
  }

  // --------------------
  // Menu show/hide
  // --------------------
  function hideMenu() {
    const m = byId('terminal-commands-menu');
    if (!m) return;
    m.classList.add('hidden');
  }

  function toggleMenu(ev) {
    if (ev && ev.stopPropagation) ev.stopPropagation();
    // close other menus if the PTY module is in use
    try {
      const pty = window.XKeen && window.XKeen.terminal && window.XKeen.terminal.pty;
      if (pty && typeof pty.hideSignalsMenu === 'function') pty.hideSignalsMenu();
    } catch (e) {}

    const m = byId('terminal-commands-menu');
    if (!m) return;
    const willShow = m.classList.contains('hidden');
    if (willShow) {
      try { ensureMenuBuilt(); } catch (e) {}
      try { qcUpdateModeUi(); } catch (e) {}
    }
    m.classList.toggle('hidden');
  }

  // --------------------
  // Insert/run actions
  // --------------------
  function insertIntoLite(cmd, selectToken) {
    const cmdEl = byId('terminal-command');
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

  function sendPtyRaw(payload) {
    // Prefer PTY module when used; otherwise use legacy terminal.js bridge.
    try {
      const pty = window.XKeen && window.XKeen.terminal && window.XKeen.terminal.pty;
      if (pty && typeof pty.sendRaw === 'function') return pty.sendRaw(String(payload || ''));
    } catch (e) {}
    try {
      const leg = window.XKeen && window.XKeen.terminal && window.XKeen.terminal._legacy;
      if (leg && typeof leg.sendPtyRaw === 'function') return leg.sendPtyRaw(String(payload || ''));
    } catch (e) {}
  }

  function runLite() {
    // Prefer lite_runner module (refactor target). Fallback to legacy.
    try {
      const lr = window.XKeen && window.XKeen.terminal && window.XKeen.terminal.lite_runner;
      if (lr && typeof lr.sendTerminalInput === 'function') return lr.sendTerminalInput();
    } catch (e) {}
    try {
      const leg = window.XKeen && window.XKeen.terminal && window.XKeen.terminal._legacy;
      if (leg && typeof leg.runLite === 'function') return leg.runLite();
    } catch (e) {}
  }

  function qcInsert(cmd, selectToken) {
    hideMenu();
    if (getMode() === 'pty') {
      if (!isPtyConnected()) {
        try { if (typeof window.showToast === 'function') window.showToast('PTY не подключён', 'info'); } catch (e) {}
        return;
      }
      try { sendPtyRaw(String(cmd || '')); } catch (e) {}
      focusTerminal();
      return;
    }
    insertIntoLite(cmd, selectToken);
  }

  function qcRun(cmd) {
    hideMenu();
    if (getMode() === 'pty') {
      if (!isPtyConnected()) {
        try { if (typeof window.showToast === 'function') window.showToast('PTY не подключён', 'info'); } catch (e) {}
        return;
      }
      try { sendPtyRaw(String(cmd || '') + '\r'); } catch (e) {}
      focusTerminal();
      return;
    }
    insertIntoLite(cmd, null);
    try { void runLite(); } catch (e) {}
  }

  function handleItemClick(ev, item) {
    const cmd = item && item.cmd ? item.cmd : '';
    const selectToken = item && item.select ? item.select : null;

    // Modifiers override default: Ctrl/⌘ => run, Shift => insert
    const forceRun = !!(ev && (ev.ctrlKey || ev.metaKey));
    const forceInsert = !!(ev && ev.shiftKey);

    if (forceRun) return qcRun(cmd);
    if (forceInsert) return qcInsert(cmd, selectToken);

    const mode = qcGetMode();
    if (mode === 'run') return qcRun(cmd);
    return qcInsert(cmd, selectToken);
  }

  // --------------------
  // Build menu list
  // --------------------
  let menuBuilt = false;
  function ensureMenuBuilt() {
    if (menuBuilt) return;
    menuBuilt = true;

    const list = byId('terminal-commands-list');
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
        handleItemClick(ev, q);
      });
      list.appendChild(btn);
    });

    qcUpdateModeUi();
  }

  // --------------------
  // Auto-close
  // --------------------
  let autoCloseInited = false;
  function initAutoClose() {
    if (autoCloseInited) return;
    autoCloseInited = true;

    document.addEventListener('click', (ev) => {
      try {
        const menu = byId('terminal-commands-menu');
        const btn = byId('terminal-btn-commands');
        const t = ev && ev.target ? ev.target : null;
        if (menu && t && menu.contains(t)) return;
        if (btn && t && btn.contains(t)) return;
      } catch (e) {}
      hideMenu();
    }, true);

    document.addEventListener('keydown', (e) => {
      if (e && e.key === 'Escape') hideMenu();
    }, true);

    // Stop propagation inside the menu itself
    try {
      const m = byId('terminal-commands-menu');
      if (m) {
        m.addEventListener('click', (e) => {
          try { e.stopPropagation(); } catch (e2) {}
        });
      }
    } catch (e) {}
  }

  // --------------------
  // Public init (bind UI)
  // --------------------
  let inited = false;
  function init() {
    if (inited) return true;
    inited = true;

    initAutoClose();
    // Prepare mode UI (buttons may exist even if menu isn't opened yet)
    try { qcUpdateModeUi(); } catch (e) {}

    // Wire buttons (idempotent if init called once by entrypoint)
    try {
      const btn = byId('terminal-btn-commands');
      if (btn) btn.addEventListener('click', toggleMenu);
    } catch (e) {}
    try {
      const bIns = byId('terminal-qc-mode-insert');
      if (bIns) bIns.addEventListener('click', () => qcSetMode('insert'));
      const bRun = byId('terminal-qc-mode-run');
      if (bRun) bRun.addEventListener('click', () => qcSetMode('run'));
    } catch (e) {}

    return true;
  }

  // Export
  window.XKeen.terminal.quick_commands = {
    init,
    // actions
    toggleMenu,
    hideMenu,
    insert: qcInsert,
    run: qcRun,
    // mode
    getMode: qcGetMode,
    setMode: qcSetMode,
    updateModeUi: qcUpdateModeUi,
    // data
    TERMINAL_QUICK_COMMANDS,
  };
})();

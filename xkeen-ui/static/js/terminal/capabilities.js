import {
  getTerminalById,
  getTerminalCompatApi,
  getTerminalContext,
  getTerminalCoreHttpApi,
  publishTerminalCompatApi,
  publishXkeenCompatValue,
  setTerminalCapabilityState,
} from './runtime.js';
import { appendTerminalDebug } from '../features/terminal_debug.js';

// Terminal capabilities: detect backend features (/api/capabilities)
(function () {
  'use strict';

  const core = getTerminalCompatApi('_core');

  let HAS_WS = false;
  let HAS_PTY = false;
  let HAS_SHELL = true;
  let SHELL_POLICY = null;
  let WS_REASON = null;
  let WS_ERROR = null;
  let INIT_PROMISE = null;
  let INIT_DONE = false;

  function getCtx() {
    return getTerminalContext();
  }

  function byId(id) {
    return getTerminalById(id, (key) => {
      try {
        return (core && typeof core.byId === 'function') ? core.byId(key) : null;
      } catch (error) {
        return null;
      }
    });
  }

  function setVisible(el, on) {
    try {
      const ctx = getCtx();
      if (ctx && ctx.ui && ctx.ui.set && typeof ctx.ui.set.visible === 'function') return ctx.ui.set.visible(el, !!on);
    } catch (e) {}
    if (!el) return;
    try { el.style.display = on ? '' : 'none'; } catch (e2) {}
  }

  function setEnabled(el, on) {
    try {
      const ctx = getCtx();
      if (ctx && ctx.ui && ctx.ui.set && typeof ctx.ui.set.enabled === 'function') return ctx.ui.set.enabled(el, !!on);
    } catch (e) {}
    if (!el) return;
    try { el.disabled = !on; } catch (e2) {}
  }

  function readStateCapabilityKnown() {
    try {
      if (core && core.state && typeof core.state.capabilitiesKnown === 'boolean') return core.state.capabilitiesKnown;
    } catch (e) {}
    try {
      const ctx = getCtx();
      const st = ctx && ctx.core ? ctx.core.state : null;
      if (st && typeof st.capabilitiesKnown === 'boolean') return st.capabilitiesKnown;
    } catch (e2) {}
    return null;
  }

  function readStateCapability(key) {
    try {
      if (core && core.state && typeof core.state[key] === 'boolean') return core.state[key];
    } catch (e) {}
    try {
      const ctx = getCtx();
      const st = ctx && ctx.core ? ctx.core.state : null;
      if (st && typeof st[key] === 'boolean') return st[key];
    } catch (e2) {}
    return null;
  }

  function readStateObject(key) {
    try {
      if (core && core.state && core.state[key] && typeof core.state[key] === 'object') return core.state[key];
    } catch (e) {}
    try {
      const ctx = getCtx();
      const st = ctx && ctx.core ? ctx.core.state : null;
      if (st && st[key] && typeof st[key] === 'object') return st[key];
    } catch (e2) {}
    return null;
  }

  function cloneShellPolicy(policy) {
    if (!policy || typeof policy !== 'object') return null;
    return Object.assign({}, policy);
  }

  function normalizeShellPolicy(policy) {
    const next = cloneShellPolicy(policy) || {};
    next.enabled = !!next.enabled;
    next.env = String(next.env || 'XKEEN_ALLOW_SHELL');
    next.default = String(next.default == null ? '1' : next.default);
    next.message = String(next.message || '');
    next.hint = String(next.hint || '');
    next.requires_restart = !!next.requires_restart;
    return next;
  }

  function seedFromState() {
    const known = readStateCapabilityKnown();
    const ws = readStateCapability('hasWs');
    const pty = readStateCapability('hasPty');
    const shell = readStateCapability('hasShell');
    const shellPolicy = readStateObject('shellPolicy');
    if (known === true) {
      if (typeof ws === 'boolean') HAS_WS = ws;
      if (typeof pty === 'boolean') HAS_PTY = pty;
      if (shellPolicy && typeof shellPolicy === 'object') SHELL_POLICY = normalizeShellPolicy(shellPolicy);
      if (typeof shell === 'boolean') HAS_SHELL = shell;
      else HAS_SHELL = !!(SHELL_POLICY && SHELL_POLICY.enabled);
      INIT_DONE = true;
      return { known, ws, pty, shell, shellPolicy: SHELL_POLICY };
    }
    return { known: false, ws: null, pty: null, shell: null, shellPolicy: null };
  }

  function pickPtyCapability(data) {
    if (data && data.terminal && typeof data.terminal === 'object' && 'pty' in data.terminal) {
      return !!data.terminal.pty;
    }
    return !!(data && data.websocket);
  }

  // Why the terminal is stuck in lite mode. Without this the UI just hides the
  // PTY button and the user sees an unexplained half-working terminal.
  function pickWsDiagnostics(data) {
    const terminal = (data && data.terminal && typeof data.terminal === 'object') ? data.terminal : null;
    const reason = terminal && terminal.reason ? String(terminal.reason) : null;
    const error = terminal && terminal.ws_error ? String(terminal.ws_error) : null;
    return { reason, error };
  }

  function pickShellPolicy(data) {
    if (data && data.terminal && data.terminal.shell && typeof data.terminal.shell === 'object') {
      return normalizeShellPolicy(data.terminal.shell);
    }
    return normalizeShellPolicy({
      enabled: true,
      env: 'XKEEN_ALLOW_SHELL',
      default: '1',
      message: '',
      hint: '',
      requires_restart: false,
    });
  }

  function initCapabilities(options) {
    const force = options === true || !!(options && options.force === true);
    if (INIT_PROMISE && !force) {
      appendTerminalDebug('terminal:capabilities:init-reuse', {});
      return INIT_PROMISE;
    }
    if (force) {
      INIT_PROMISE = null;
      INIT_DONE = false;
      appendTerminalDebug('terminal:capabilities:init-force-refresh', {});
    }
    const seeded = seedFromState();
    appendTerminalDebug('terminal:capabilities:init-start', {
      seededWs: seeded.ws,
      seededPty: seeded.pty,
      seededShell: seeded.shell,
    });
    INIT_PROMISE = (async () => {
      try {
        const http = getTerminalCoreHttpApi();
        let data = null;
        appendTerminalDebug('terminal:capabilities:request-begin', { viaCoreHttp: !!(http && typeof http.fetchJSON === 'function') });
        if (http && typeof http.fetchJSON === 'function') {
          data = await http.fetchJSON('/api/capabilities', {
            method: 'GET',
            timeoutMs: 2500,
            retry: 0,
          });
        } else {
          const resp = await fetch('/api/capabilities', { cache: 'no-store' });
          if (!resp.ok) throw new Error('http ' + resp.status);
          data = await resp.json().catch(() => ({}));
        }
        HAS_WS = !!(data && data.websocket);
        HAS_PTY = pickPtyCapability(data);
        SHELL_POLICY = pickShellPolicy(data);
        HAS_SHELL = !!(SHELL_POLICY && SHELL_POLICY.enabled);
        const diagnostics = pickWsDiagnostics(data);
        WS_REASON = diagnostics.reason;
        WS_ERROR = diagnostics.error;
        appendTerminalDebug('terminal:capabilities:request-done', {
          websocket: HAS_WS,
          pty: HAS_PTY,
          shell: HAS_SHELL,
          reason: WS_REASON,
          wsError: WS_ERROR,
        });
      } catch (e) {
        const msg = e ? String(e.message || e) : 'unknown error';
        appendTerminalDebug('terminal:capabilities:request-error', { error: msg, keepSeeded: true });
        const fallback = seedFromState();
        HAS_WS = (typeof fallback.ws === 'boolean') ? fallback.ws : false;
        HAS_PTY = (typeof fallback.pty === 'boolean') ? fallback.pty : false;
        SHELL_POLICY = fallback.shellPolicy ? normalizeShellPolicy(fallback.shellPolicy) : SHELL_POLICY;
        HAS_SHELL = (typeof fallback.shell === 'boolean')
          ? fallback.shell
          : !!(SHELL_POLICY ? SHELL_POLICY.enabled : HAS_SHELL);
      }

      try {
        if (core && core.state) {
          core.state.hasWs = HAS_WS;
          core.state.hasPty = HAS_PTY;
          core.state.hasShell = HAS_SHELL;
          core.state.shellPolicy = cloneShellPolicy(SHELL_POLICY);
          core.state.capabilitiesKnown = true;
        }
      } catch (e) {}
      try {
        const ctx = getCtx();
        const st = ctx && ctx.core ? ctx.core.state : null;
        if (st) {
          st.hasWs = HAS_WS;
          st.hasPty = HAS_PTY;
          st.hasShell = HAS_SHELL;
          st.shellPolicy = cloneShellPolicy(SHELL_POLICY);
          st.capabilitiesKnown = true;
        }
      } catch (e2) {}
      try { setTerminalCapabilityState(HAS_WS, HAS_PTY, SHELL_POLICY); } catch (e3) {}
      INIT_DONE = true;

      try { applyWsCapabilityUi(); } catch (e) {}
      appendTerminalDebug('terminal:capabilities:apply', {
        websocket: HAS_WS,
        pty: HAS_PTY,
        shell: HAS_SHELL,
        known: true,
      });
      return HAS_WS;
    })();
    return INIT_PROMISE;
  }

  function wsNoticeText() {
    if (HAS_PTY) return null;
    if (WS_REASON === 'ws_unavailable') {
      return {
        title: 'WebSocket недоступен — терминал работает в lite-режиме.',
        detail: WS_ERROR
          ? ('Причина: ' + WS_ERROR)
          : 'Панель запущена без gevent/gevent-websocket.',
        hint: 'Проверить пакеты: /opt/bin/python3 /opt/etc/xkeen-ui/scripts/check_pydeps_integrity.py gevent gevent-websocket',
      };
    }
    if (WS_REASON === 'arch_not_arm') {
      return {
        title: 'Полноценный терминал недоступен на этой архитектуре.',
        detail: 'Доступен только lite-режим с построчным выполнением команд.',
        hint: '',
      };
    }
    return null;
  }

  function applyWsNotice() {
    const host = byId('terminal-ws-notice');
    if (!host) return;

    const notice = wsNoticeText();
    if (!notice) {
      setVisible(host, false);
      try { host.classList.add('hidden'); } catch (e) {}
      try { host.textContent = ''; } catch (e2) {}
      return;
    }

    try {
      host.textContent = '';
      const lines = [notice.title, notice.detail, notice.hint].filter(Boolean);
      lines.forEach((line, index) => {
        const row = document.createElement('div');
        row.className = index === 0 ? 'terminal-ws-notice-title' : 'terminal-ws-notice-detail';
        row.textContent = line;
        host.appendChild(row);
      });
      host.classList.remove('hidden');
      setVisible(host, true);
    } catch (e3) {}
  }

  // Apply capability-dependent UI.
  // Desired behavior:
  // - If PTY is available: show ONLY the full Interactive PTY shell button.
  // - If PTY is NOT available: show ONLY the lite HTTP terminal button.
  function applyWsCapabilityUi() {
    // Buttons in "Команды" header
    const shellBtn = byId('terminal-open-shell-btn');
    const ptyBtn = byId('terminal-open-pty-btn');

    try { applyWsNotice(); } catch (e0) {}

    // If markup changed, best-effort: do nothing.
    if (!shellBtn && !ptyBtn) return;

    if (HAS_PTY) {
      // Powerful routers: keep only PTY (Interactive Shell)
      if (ptyBtn) {
        setVisible(ptyBtn, true);
        setEnabled(ptyBtn, true);
      }
      if (shellBtn) {
        setVisible(shellBtn, false);
        setEnabled(shellBtn, false);
      }
    } else {
      // Weak routers: keep only lite terminal
      if (ptyBtn) {
        setVisible(ptyBtn, false);
        setEnabled(ptyBtn, false);
      }
      if (shellBtn) {
        setVisible(shellBtn, true);
        setEnabled(shellBtn, true);
        try {
          const policy = getShellPolicy();
          const msg = policy && policy.message ? String(policy.message) : '';
          const hint = policy && policy.hint ? String(policy.hint) : '';
          shellBtn.title = HAS_SHELL ? 'Lite shell terminal' : [msg, hint].filter(Boolean).join(' ');
        } catch (e3) {}
      }
    }
  }

  function hasWs() {
    const v = readStateCapability('hasWs');
    return (typeof v === 'boolean') ? v : !!HAS_WS;
  }

  function hasPty() {
    const v = readStateCapability('hasPty');
    return (typeof v === 'boolean') ? v : !!HAS_PTY;
  }

  function hasShell() {
    const v = readStateCapability('hasShell');
    if (typeof v === 'boolean') return v;
    const policy = getShellPolicy();
    return !!(policy && policy.enabled);
  }

  function getShellPolicy() {
    const v = readStateObject('shellPolicy');
    if (v && typeof v === 'object') return normalizeShellPolicy(v);
    if (SHELL_POLICY && typeof SHELL_POLICY === 'object') return normalizeShellPolicy(SHELL_POLICY);
    return null;
  }

  function isReady() {
    const known = readStateCapabilityKnown();
    return known === true || INIT_DONE === true;
  }

  // Backward compatible aliases (some legacy code used these names)
  publishXkeenCompatValue('terminalApplyWsCapabilityUi', applyWsCapabilityUi);
  publishXkeenCompatValue('terminalApplyCapabilityUi', applyWsCapabilityUi);

  publishTerminalCompatApi('capabilities', {
    initCapabilities,
    applyWsCapabilityUi,
    hasWs,
    hasPty,
    hasShell,
    getShellPolicy,
    isReady,
  });
})();

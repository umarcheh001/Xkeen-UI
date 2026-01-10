// XKeen terminal island bootstrap (Stage 8.5)
//
// terminal.js is orchestration-only:
//   - create/refresh ctx.dom
//   - register modules via ctx.registry
//   - wire commands router + builtins
//   - expose stable public API + compatibility wrappers
//
// NO business logic, NO event listeners/timers here.

(function () {
  'use strict';

  // Namespace
  window.XKeen = window.XKeen || {};
  window.XKeen.state = window.XKeen.state || {};
  window.XKeen.terminal = window.XKeen.terminal || {};

  const T = window.XKeen.terminal;

  function getCtx() {
    try {
      const core = T.core;
      if (core && typeof core.getCtx === 'function') return core.getCtx();
    } catch (e) {}
    return null;
  }

  // Stage 8.5 / этап 2: DOM registry refresh + stable aliases
  function refreshDom(ctx) {
    const c = ctx || getCtx();
    if (!c) return null;

    try {
      if (c.dom && typeof c.dom.refresh === 'function') c.dom.refresh();
    } catch (e) {}

    // Ensure a minimal alias surface even if markup changes.
    // (No events, no logic: just references)
    try {
      const d = c.dom || (c.dom = {});
      if (!d.panel) d.panel = d.overlay;
      if (!d.window && d.overlay) {
        try { d.window = d.overlay.querySelector('.terminal-window'); } catch (e2) {}
      }
      if (!d.output) d.output = d.outputPre;
      if (!d.cmd) d.cmd = d.commandInput;
      if (!d.stdin) d.stdin = d.stdinInput;
      if (!d.lamp) d.lamp = d.connLamp;
      if (!d.btnOpenShell) d.btnOpenShell = d.openShellBtn;
      if (!d.btnOpenPty) d.btnOpenPty = d.openPtyBtn;
    } catch (e3) {}

    return c.dom || null;
  }

  function hasAnyTerminalUi(ctx) {
    const c = ctx || getCtx();
    if (!c) return false;
    try {
      if (c.ui && typeof c.ui.byId === 'function') {
        return !!(
          c.ui.byId('terminal-overlay') ||
          c.ui.byId('terminal-output') ||
          c.ui.byId('terminal-open-pty-btn') ||
          c.ui.byId('terminal-open-shell-btn')
        );
      }
    } catch (e) {}
    return false;
  }

  // Stage 8.5 / этапы 5-7: registry + commands + API wiring
  let bootstrapped = false;
  function bootstrapTerminal() {
    const ctx = getCtx();
    if (!ctx) return null;

    // If the page has no terminal UI, keep inert (panel.init calls terminal.init unconditionally).
    if (!hasAnyTerminalUi(ctx)) return ctx;

    refreshDom(ctx);

    if (bootstrapped) return ctx;
    bootstrapped = true;

    // (A) registry wiring
    try {
      const reg = ctx.registry;
      if (reg && !reg.__xkeenSetup) {
        reg.__xkeenSetup = true;

        const mods = [];
        const add = (mod) => {
          try {
            if (mod && typeof mod.createModule === 'function') {
              const m = mod.createModule(ctx);
              if (m) mods.push(m);
            }
          } catch (e) {}
        };

        // Core flow
        add(T.terminal_controller);
        add(T.overlay_controller);
        add(T.reconnect_controller);
        add(T.status_controller);
        add(T.output_controller);
        add(T.input_controller);
        add(T.output_prefs);
        add(T.confirm_prompt);
        add(T.buffer_actions);
        add(T.ui_controller);

        // Optional features
        add(T.ssh_profiles);
        add(T.search);
        add(T.history);
        add(T.quick_commands);
        add(T.chrome);
        add(T.lite_runner);
        add(T.xray_tail || T.xrayTail);
        add(T.xterm_manager);

        mods.forEach((m) => {
          try { reg.register(m); } catch (e) {}
        });
        try { if (typeof reg.initAll === 'function') reg.initAll(); } catch (e2) {}
      }
    } catch (e3) {}

    // (B) command router + registry + builtins
    try {
      if (!ctx.__xkeenCommandsSetup) {
        ctx.__xkeenCommandsSetup = true;
        const C = T.commands || null;
        if (C && typeof C.createCommandRouter === 'function') {
          if (!ctx.router) ctx.router = C.createCommandRouter(ctx);
          if (!ctx.commands) ctx.commands = ctx.router;
        }
        if (C && typeof C.createCommandRegistry === 'function') {
          if (!ctx.commandRegistry) ctx.commandRegistry = C.createCommandRegistry(ctx);
        }

        // Builtins are registered into the registry (preferred) then bound to the router.
        try {
          const builtins = C && C.builtins ? C.builtins : null;
          if (builtins && typeof builtins.registerXkeenRestart === 'function') {
            builtins.registerXkeenRestart(ctx.commandRegistry || ctx.router);
          }
          if (builtins && typeof builtins.registerSysmon === 'function') {
            builtins.registerSysmon(ctx.commandRegistry || ctx.router);
          }
        } catch (e0) {}
        try {
          if (ctx.commandRegistry && ctx.router && typeof ctx.commandRegistry.bindToRouter === 'function') {
            ctx.commandRegistry.bindToRouter(ctx.router);
          }
        } catch (e1) {}
      }
    } catch (e4) {}

    // (C) public API singleton is installed by core/public_api.js; keep a safe fallback.
    try {
      if (!T.api && T.core && typeof T.core.createPublicApi === 'function') {
        T.api = T.core.createPublicApi();
      }
    } catch (e5) {}

    // Keep legacy hooks for the public_api fallback (no recursion).
    try {
      T._legacy = T._legacy || {};
      if (!T._legacy.openTerminal) T._legacy.openTerminal = function (cmd, mode) { return uiActions.openTerminal(cmd, mode); };
      if (!T._legacy.hideTerminal) T._legacy.hideTerminal = function () { return uiActions.hideTerminal(); };
    } catch (e6) {}

    return ctx;
  }

  // --------------------
  // UI actions surface (used by ui_controller + public_api)
  // --------------------
  function getCtrl(ctx) {
    const c = ctx || getCtx();
    try {
      return c && c.terminalCtrl ? c.terminalCtrl : null;
    } catch (e) {}
    return null;
  }

  function getBuffer(ctx) {
    const c = ctx || getCtx();
    try {
      return c && c.bufferActions ? c.bufferActions : null;
    } catch (e) {}
    return null;
  }

  function getUiCtrl(ctx) {
    const c = ctx || getCtx();
    try {
      return c && c.uiCtrl ? c.uiCtrl : null;
    } catch (e) {}
    return null;
  }

  function getReconnect(ctx) {
    const c = ctx || getCtx();
    try {
      return c && c.reconnect ? c.reconnect : null;
    } catch (e) {}
    return null;
  }

  function getOutputPrefs(ctx) {
    const c = ctx || getCtx();
    try {
      return c && c.outputPrefs ? c.outputPrefs : null;
    } catch (e) {}
    return null;
  }

  function getChrome() {
    try { return T.chrome || null; } catch (e) {}
    return null;
  }

  const uiActions = {
    // Lifecycle
    openTerminal: (cmd, mode) => {
      const ctx = bootstrapTerminal();
      const ctrl = getCtrl(ctx);
      if (ctrl && typeof ctrl.open === 'function') return ctrl.open(String(cmd || ''), String(mode || 'shell'));
      // Last resort: public API
      try {
        if (T.api && typeof T.api.open === 'function') return T.api.open({ cmd: String(cmd || ''), mode: String(mode || 'shell') });
      } catch (e) {}
      return false;
    },
    hideTerminal: () => {
      const ctx = bootstrapTerminal();
      const ctrl = getCtrl(ctx);
      if (ctrl && typeof ctrl.close === 'function') return ctrl.close();
      try { if (T.api && typeof T.api.close === 'function') return T.api.close(); } catch (e) {}
      return false;
    },

    // Input submit (confirmation is handled by confirm_prompt module)
    sendTerminalInput: () => {
      const ctx = bootstrapTerminal();
      try {
        if (ctx && ctx.confirmPrompt && typeof ctx.confirmPrompt.sendOrSubmit === 'function') {
          return ctx.confirmPrompt.sendOrSubmit();
        }
      } catch (e) {}
      try {
        if (ctx && ctx.input && typeof ctx.input.submitFromUi === 'function') {
          return ctx.input.submitFromUi();
        }
      } catch (e2) {}
      return false;
    },

    // Hotkeys
    hotkeyClear: () => {
      const ctx = bootstrapTerminal();
      const buf = getBuffer(ctx);
      if (buf && typeof buf.clear === 'function') return buf.clear();
      return false;
    },

    // Window / session actions
    terminalToggleFullscreen: () => {
      const ch = getChrome();
      if (ch && typeof ch.toggleFullscreen === 'function') return ch.toggleFullscreen();
      return false;
    },
    terminalMinimize: () => {
      const ch = getChrome();
      if (ch && typeof ch.minimize === 'function') return ch.minimize();
      return false;
    },
    terminalDetach: () => {
      const ctx = bootstrapTerminal();
      const ctrl = getCtrl(ctx);
      if (ctrl && typeof ctrl.detach === 'function') return ctrl.detach();
      return false;
    },
    terminalKillSession: () => {
      const ctx = bootstrapTerminal();
      const ctrl = getCtrl(ctx);
      if (ctrl && typeof ctrl.killSession === 'function') return ctrl.killSession();
      return false;
    },
    terminalReconnect: () => {
      const ctx = bootstrapTerminal();
      const ctrl = getCtrl(ctx);
      if (ctrl && typeof ctrl.reconnect === 'function') return ctrl.reconnect();
      return false;
    },
    terminalNewSession: () => {
      const ctx = bootstrapTerminal();
      const ctrl = getCtrl(ctx);
      if (ctrl && typeof ctrl.newSession === 'function') return ctrl.newSession();
      return false;
    },
    terminalSendCtrlC: () => {
      const ctx = bootstrapTerminal();
      const ctrl = getCtrl(ctx);
      if (ctrl && typeof ctrl.sendCtrlC === 'function') return ctrl.sendCtrlC();
      return false;
    },
    terminalSendCtrlD: () => {
      const ctx = bootstrapTerminal();
      const ctrl = getCtrl(ctx);
      if (ctrl && typeof ctrl.sendCtrlD === 'function') return ctrl.sendCtrlD();
      return false;
    },
    terminalSendSignal: (sig) => {
      const ctx = bootstrapTerminal();
      const ctrl = getCtrl(ctx);
      if (ctrl && typeof ctrl.sendSignal === 'function') return ctrl.sendSignal(sig);
      return false;
    },

    // Retry controls (PTY backoff logic lives in reconnect_controller)
    terminalStopRetry: () => {
      const ctx = bootstrapTerminal();
      const r = getReconnect(ctx);
      if (r && typeof r.stopRetry === 'function') return r.stopRetry();
      return false;
    },
    terminalRetryNow: () => {
      const ctx = bootstrapTerminal();
      const r = getReconnect(ctx);
      if (r && typeof r.retryNow === 'function') return r.retryNow();
      return false;
    },

    // View settings (prefs live in ui_controller / output_prefs)
    terminalFontInc: () => {
      const ctx = bootstrapTerminal();
      const u = getUiCtrl(ctx);
      if (u && typeof u.fontInc === 'function') return u.fontInc();
      return false;
    },
    terminalFontDec: () => {
      const ctx = bootstrapTerminal();
      const u = getUiCtrl(ctx);
      if (u && typeof u.fontDec === 'function') return u.fontDec();
      return false;
    },
    terminalToggleCursorBlink: () => {
      const ctx = bootstrapTerminal();
      const u = getUiCtrl(ctx);
      if (u && typeof u.toggleCursorBlink === 'function') return u.toggleCursorBlink();
      return false;
    },
    terminalToggleAnsiFilter: () => {
      const ctx = bootstrapTerminal();
      const p = getOutputPrefs(ctx);
      if (p && typeof p.toggleAnsiFilter === 'function') return p.toggleAnsiFilter();
      return false;
    },
    terminalToggleLogHighlight: () => {
      const ctx = bootstrapTerminal();
      const p = getOutputPrefs(ctx);
      if (p && typeof p.toggleLogHighlight === 'function') return p.toggleLogHighlight();
      return false;
    },
    terminalToggleFollow: () => {
      const ctx = bootstrapTerminal();
      const p = getOutputPrefs(ctx);
      if (p && typeof p.toggleFollow === 'function') return p.toggleFollow();
      return false;
    },
    terminalScrollToBottom: () => {
      const ctx = bootstrapTerminal();
      const buf = getBuffer(ctx);
      if (buf && typeof buf.scrollToBottom === 'function') return buf.scrollToBottom();
      return false;
    },

    // Buffer actions
    terminalCopy: () => {
      const ctx = bootstrapTerminal();
      const buf = getBuffer(ctx);
      if (buf && typeof buf.copySelection === 'function') return buf.copySelection();
      return false;
    },
    terminalCopyAll: () => {
      const ctx = bootstrapTerminal();
      const buf = getBuffer(ctx);
      if (buf && typeof buf.copyAll === 'function') return buf.copyAll();
      return false;
    },
    terminalPaste: () => {
      const ctx = bootstrapTerminal();
      const buf = getBuffer(ctx);
      if (buf && typeof buf.pasteFromClipboard === 'function') return buf.pasteFromClipboard();
      return false;
    },
    terminalClear: () => {
      const ctx = bootstrapTerminal();
      const buf = getBuffer(ctx);
      if (buf && typeof buf.clear === 'function') return buf.clear();
      return false;
    },
    terminalDownloadOutput: () => {
      const ctx = bootstrapTerminal();
      const buf = getBuffer(ctx);
      if (buf && typeof buf.downloadText === 'function') return buf.downloadText();
      return false;
    },
    terminalDownloadHtml: () => {
      const ctx = bootstrapTerminal();
      const buf = getBuffer(ctx);
      if (buf && typeof buf.downloadHtml === 'function') return buf.downloadHtml();
      return false;
    },
    terminalDownloadVtSnapshot: () => {
      const ctx = bootstrapTerminal();
      const buf = getBuffer(ctx);
      if (buf && typeof buf.downloadVtSnapshot === 'function') return buf.downloadVtSnapshot();
      return false;
    },
  };

  // Expose for ui_controller + public API
  T.ui_actions = uiActions;

  // --------------------
  // Entry point (called by pages/panel.init.js)
  // --------------------
  let initDone = false;
  let capInitPromise = null;
  function initTerminal() {
    if (initDone) return;
    initDone = true;

    const ctx = getCtx();
    if (!ctx) return;
    if (!hasAnyTerminalUi(ctx)) return;

    // Core init (tabId + legacy state bridge)
    try { if (T._core && typeof T._core.init === 'function') T._core.init(); } catch (e) {}

    // Bootstrap (modules/commands/api)
    bootstrapTerminal();

    // Capabilities (WS support) is async; keep a promise so auto-open can wait.
    try {
      if (T.capabilities && typeof T.capabilities.initCapabilities === 'function') {
        capInitPromise = T.capabilities.initCapabilities();
      }
    } catch (e2) {}

    // Auto-open from URL: ?terminal=pty|shell
    try {
      const url = new URL(window.location.href);
      const mode = String(url.searchParams.get('terminal') || '').toLowerCase();
      if (mode === 'pty' || mode === 'shell') {
        const doOpen = () => {
          // If PTY was requested but WS is not supported, fall back to lite shell.
          let finalMode = mode;
          try {
            if (finalMode === 'pty' && T.capabilities && typeof T.capabilities.hasWs === 'function' && !T.capabilities.hasWs()) {
              finalMode = 'shell';
            }
          } catch (e0) {}

          if (T.api && typeof T.api.open === 'function') {
            void T.api.open({ mode: finalMode, cmd: '' });
          } else {
            void uiActions.openTerminal('', finalMode);
          }
        };

        // Wait for capabilities to load before trying to open PTY.
        // This prevents a race where HAS_WS is still false on a freshly opened tab.
        Promise.resolve(capInitPromise).then(doOpen).catch(doOpen);
      }
    } catch (e3) {}
  }

  // единственный обязательный entrypoint
  T.init = initTerminal;

  // --------------------
  // Compatibility wrappers (global functions + XKeen.terminal.*)
  // --------------------
  // These wrappers are intentionally thin and delegate to api/controllers.
  // Keep them idempotent to avoid conflicts with user scripts.

  // XKeen.terminal.open/close/toggle for older callers
  T.open = function (tabId, opts) {
    try { void tabId; } catch (e) {}
    const o = opts || {};
    const cmd = typeof o.cmd === 'string' ? o.cmd : '';
    const mode = typeof o.mode === 'string' ? o.mode : '';
    if (T.api && typeof T.api.open === 'function') return T.api.open({ cmd, mode });
    return uiActions.openTerminal(cmd, mode || 'shell');
  };

  T.close = function () {
    if (T.api && typeof T.api.close === 'function') return T.api.close();
    return uiActions.hideTerminal();
  };

  T.toggle = function () {
    if (T.api && typeof T.api.toggle === 'function') return T.api.toggle();
    try {
      if (T.api && typeof T.api.isOpen === 'function') {
        return T.api.isOpen() ? T.close() : T.open(null, {});
      }
    } catch (e) {}
    return T.open(null, {});
  };

  // Unified command helper (legacy addons)
  T.execCommand = async function (cmdText, meta) {
    const txt = String(cmdText == null ? '' : cmdText).trim();
    if (!txt) return { handled: false };
    try {
      if (T.api && typeof T.api.send === 'function') return await T.api.send(txt, meta || {});
    } catch (e) {}
    const ctx = getCtx();
    try {
      if (ctx && ctx.router && typeof ctx.router.execute === 'function') return await ctx.router.execute(txt, meta || {});
    } catch (e2) {}
    try {
      if (ctx && ctx.transport && typeof ctx.transport.send === 'function') {
        const ok = ctx.transport.send(/\r|\n/.test(txt) ? txt : (txt + '\n'), meta || {});
        return { handled: !!ok, result: { ok: !!ok, via: 'transport.send' } };
      }
    } catch (e3) {}
    return { handled: false, result: { ok: false, error: 'no router/transport' } };
  };

  // Global legacy functions (avoid breaking old inline handlers)
  if (!window.terminalOpen) window.terminalOpen = (a, b) => {
    try {
      if (T.api && typeof T.api.open === 'function') return T.api.open(a, b);
    } catch (e) {}

    // Very small normalization for emergency fallback.
    if (a && typeof a === 'object') {
      const cmd = typeof a.cmd === 'string' ? a.cmd : '';
      const mode = typeof a.mode === 'string' ? a.mode : 'shell';
      return uiActions.openTerminal(cmd, mode);
    }
    if (typeof a === 'string' && typeof b === 'string') return uiActions.openTerminal(a, b);
    if (typeof a === 'string' && (a === 'pty' || a === 'shell')) return uiActions.openTerminal('', a);
    if (typeof a === 'string') return uiActions.openTerminal(a, 'shell');
    return uiActions.openTerminal('', 'shell');
  };
  if (!window.terminalClose) window.terminalClose = () => (T.api && T.api.close ? T.api.close() : uiActions.hideTerminal());
  if (!window.terminalToggle) window.terminalToggle = () => (T.api && T.api.toggle ? T.api.toggle() : T.toggle());
  if (!window.terminalSend) window.terminalSend = (txt, meta) => (T.api && T.api.send ? T.api.send(txt, meta || {}) : T.execCommand(txt, meta || {}));
  if (!window.terminalSetMode) window.terminalSetMode = (mode) => {
    const ctx = getCtx();
    try { if (ctx && ctx.session && typeof ctx.session.setMode === 'function') return ctx.session.setMode(mode); } catch (e) {}
    return (T.api && T.api.setMode) ? T.api.setMode(mode) : false;
  };
  if (!window.terminalGetMode) window.terminalGetMode = () => {
    const ctx = getCtx();
    try { if (ctx && ctx.session && typeof ctx.session.getMode === 'function') return ctx.session.getMode() || 'shell'; } catch (e) {}
    return (T.api && T.api.getMode) ? T.api.getMode() : 'shell';
  };
  if (!window.terminalIsOpen) window.terminalIsOpen = () => (T.api && T.api.isOpen) ? T.api.isOpen() : false;
  if (!window.terminalIsConnected) window.terminalIsConnected = () => (T.api && T.api.isConnected) ? T.api.isConnected() : false;

  // Very old fallbacks used by features/commands_list.js and some custom installs.
  if (!window.openTerminal) window.openTerminal = (cmd, mode) => uiActions.openTerminal(cmd, mode || 'shell');
  if (!window.hideTerminal) window.hideTerminal = () => uiActions.hideTerminal();
  if (!window.sendTerminalInput) window.sendTerminalInput = () => uiActions.sendTerminalInput();

  // Convenience toggles (output prefs)
  if (!window.terminalToggleAnsiFilter) window.terminalToggleAnsiFilter = () => uiActions.terminalToggleAnsiFilter();
  if (!window.terminalToggleLogHighlight) window.terminalToggleLogHighlight = () => uiActions.terminalToggleLogHighlight();
  if (!window.terminalToggleFollow) window.terminalToggleFollow = () => uiActions.terminalToggleFollow();

  // PTY helpers (used by external scripts/tests)
  T.connect = function () { return uiActions.openTerminal('', 'pty'); };
  T.disconnect = function (opts) {
    const ctx = getCtx();
    try { if (ctx && ctx.session && typeof ctx.session.disconnect === 'function') return ctx.session.disconnect(opts || {}); } catch (e) {}
    try {
      const P = T.pty;
      if (P && typeof P.disconnect === 'function') return P.disconnect(opts || {});
    } catch (e2) {}
  };
})();

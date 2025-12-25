// Terminal core: createTerminalContext() — wiring for A/B stages
(function () {
  'use strict';

  window.XKeen = window.XKeen || {};
  window.XKeen.terminal = window.XKeen.terminal || {};
  window.XKeen.terminal.core = window.XKeen.terminal.core || {};

  function createTerminalContext() {
    const core = window.XKeen.terminal._core || null;
    const caps = window.XKeen.terminal.capabilities || null;

    // State (authoritative is terminal/_core.js when available).
    // Stage 1: ctx.state is a store with get/set/subscribe, but still behaves like
    // a plain object for backward compatibility.
    let state = null;
    try {
      state = (core && core.state) ? core.state : null;
    } catch (e) {}
    if (!state) {
      try {
        const ds = window.XKeen.terminal.core.defaultState;
        state = (typeof ds === 'function') ? ds() : { mode: 'shell' };
      } catch (e2) {
        state = { mode: 'shell' };
      }
    }

    const events = (window.XKeen.terminal.core.createEventBus)
      ? window.XKeen.terminal.core.createEventBus()
      : { on: () => () => {}, off: () => {}, emit: () => {} };

    // Upgrade plain state object into a tiny reactive store.
    try {
      const mkStore = window.XKeen.terminal.core.createStateStore;
      if (typeof mkStore === 'function') {
        state = mkStore(state, events);
      }
    } catch (e) {}

    // Logger + config
    const log = (window.XKeen.terminal.core.createLogger)
      ? window.XKeen.terminal.core.createLogger('terminal')
      : { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, enabled: () => false };

    const config = (window.XKeen.terminal.core.createConfig)
      ? window.XKeen.terminal.core.createConfig()
      : { get: () => undefined, set: () => false, defaults: () => ({}), keys: () => ({}) };

    const ui = (window.XKeen.terminal.core.createUiAdapter)
      ? window.XKeen.terminal.core.createUiAdapter(core)
      : { byId: (id) => { try { return (core && typeof core.byId === 'function') ? core.byId(id) : null; } catch (e) { return null; } }, get: {}, toast: () => {}, show: () => {}, hide: () => {} };

    // DOM cache: resolved once (refreshable) so modules can use ctx.dom.*
    function createDomCache() {
      const dom = {};
      function refresh() {
        try {
          if (!ui || !ui.get) return dom;
          const g = ui.get;
          // Hosts
          dom.overlay = typeof g.overlay === 'function' ? g.overlay() : null;
          dom.outputPre = typeof g.outputPre === 'function' ? g.outputPre() : (typeof g.output === 'function' ? g.output() : null);
          dom.output = typeof g.output === 'function' ? g.output() : dom.outputPre;
          dom.xtermHost = typeof g.xtermHost === 'function' ? g.xtermHost() : null;
          // Inputs
          dom.commandInput = typeof g.commandInput === 'function' ? g.commandInput() : (typeof g.cmd === 'function' ? g.cmd() : null);
          dom.stdinInput = typeof g.stdinInput === 'function' ? g.stdinInput() : (typeof g.stdin === 'function' ? g.stdin() : null);
          // Connection
          dom.connLamp = typeof g.connLamp === 'function' ? g.connLamp() : (typeof g.lamp === 'function' ? g.lamp() : null);
          dom.uptime = typeof g.uptime === 'function' ? g.uptime() : null;
          // Retry
          dom.stopRetryBtn = typeof g.stopRetryBtn === 'function' ? g.stopRetryBtn() : null;
          dom.retryNowBtn = typeof g.retryNowBtn === 'function' ? g.retryNowBtn() : null;
          // Common
          dom.followBtn = typeof g.followBtn === 'function' ? g.followBtn() : null;
          dom.bottomBtn = typeof g.bottomBtn === 'function' ? g.bottomBtn() : null;
          // Menus
          dom.overflowMenu = typeof g.overflowMenu === 'function' ? g.overflowMenu() : null;
          dom.viewMenu = typeof g.viewMenu === 'function' ? g.viewMenu() : null;
          dom.bufferMenu = typeof g.bufferMenu === 'function' ? g.bufferMenu() : null;
          // Capability buttons
          dom.openShellBtn = typeof g.openShellBtn === 'function' ? g.openShellBtn() : null;
          dom.openPtyBtn = typeof g.openPtyBtn === 'function' ? g.openPtyBtn() : null;
          // SSH modals
          dom.sshModal = typeof g.sshModal === 'function' ? g.sshModal() : null;
          dom.sshEditModal = typeof g.sshEditModal === 'function' ? g.sshEditModal() : null;
          dom.sshConfirmModal = typeof g.sshConfirmModal === 'function' ? g.sshConfirmModal() : null;
          dom.sshProfilesList = typeof g.sshProfilesList === 'function' ? g.sshProfilesList() : null;
          dom.sshCommandPreview = typeof g.sshCommandPreview === 'function' ? g.sshCommandPreview() : null;
          dom.sshDeleteSelectedBtn = typeof g.sshDeleteSelectedBtn === 'function' ? g.sshDeleteSelectedBtn() : null;
          dom.sshEditTitle = typeof g.sshEditTitle === 'function' ? g.sshEditTitle() : null;
          dom.sshEditDeleteBtn = typeof g.sshEditDeleteBtn === 'function' ? g.sshEditDeleteBtn() : null;
          dom.sshEditError = typeof g.sshEditError === 'function' ? g.sshEditError() : null;
          dom.sshConfirmText = typeof g.sshConfirmText === 'function' ? g.sshConfirmText() : null;
          dom.sshConfirmOk = typeof g.sshConfirmOk === 'function' ? g.sshConfirmOk() : null;
        } catch (e) {}
        return dom;
      }
      dom.refresh = refresh;
      dom.byId = (id) => {
        try { return ui && typeof ui.byId === 'function' ? ui.byId(id) : null; } catch (e) {}
        return null;
      };
      refresh();
      return dom;
    }

    const dom = createDomCache();

    const api = (window.XKeen.terminal.core.createApi)
      ? window.XKeen.terminal.core.createApi(caps)
      : { apiFetch: (...args) => fetch(...args) };

    // Transport manager is injected by transport/index.js (stage B)
    let transport = null;
    try {
      const T = window.XKeen.terminal.transport;
      if (T && typeof T.createTransportManager === 'function') {
        transport = T.createTransportManager({ core, caps, ui, events, api, state, config, log, dom });
      }
    } catch (e) {}

    if (!transport) {
      // Safe fallback (no unified globals): best-effort adapter around existing PTY/lite modules.
      transport = {
        kind: 'unknown',
        connect: () => { try { const P = window.XKeen && window.XKeen.terminal && window.XKeen.terminal.pty; return P && P.connect ? P.connect() : undefined; } catch (e) {} },
        disconnect: () => { try { const P = window.XKeen && window.XKeen.terminal && window.XKeen.terminal.pty; return P && P.disconnect ? P.disconnect() : undefined; } catch (e) {} },
        isConnected: () => {
          try {
            const st = (core && core.state) ? core.state : state;
            const ws = st ? st.ptyWs : null;
            return !!(ws && ws.readyState === WebSocket.OPEN);
          } catch (e) {}
          return false;
        },
        send: (data, opts) => {
          const payload = String(data == null ? '' : data);
          const o = opts || {};
          // Prefer PTY when requested or when in PTY mode.
          let mode = 'shell';
          try { mode = (core && typeof core.getMode === 'function') ? (core.getMode() || 'shell') : (state && state.mode) || 'shell'; } catch (e) {}
          const wantPty = (String(o.prefer || '') === 'pty') || (mode === 'pty');
          if (wantPty) {
            try {
              const P = window.XKeen && window.XKeen.terminal ? window.XKeen.terminal.pty : null;
              if (P && typeof P.sendRaw === 'function') { P.sendRaw(payload); return true; }
            } catch (e) {}
            return false;
          }
          // Lite mode: delegate to lite_runner when available.
          try {
            const lr = window.XKeen && window.XKeen.terminal && window.XKeen.terminal.lite_runner;
            if (!lr || typeof lr.sendTerminalInput !== 'function') return false;
            const cmdEl = ui && ui.get && typeof ui.get.cmd === 'function' ? ui.get.cmd() : ((core && typeof core.byId === 'function') ? core.byId('terminal-command') : null);
            if (cmdEl) cmdEl.value = payload.replace(/\n+$/g, '').trim();
            const shouldRun = /\n$/.test(payload) || o.run === true;
            if (shouldRun) lr.sendTerminalInput();
            return true;
          } catch (e) {}
          return false;
        },
        resize: (cols, rows) => {
          try {
            const st = (core && core.state) ? core.state : state;
            const ws = st ? st.ptyWs : null;
            if (!ws || ws.readyState !== WebSocket.OPEN) return;
            if (!cols || !rows) return;
            ws.send(JSON.stringify({ type: 'resize', cols: cols, rows: rows }));
          } catch (e) {}
        },
      };
    }

    // XTerm facade is lazy because xterm_manager.js is loaded after context.js.
    const xterm = {
      _mgr: null,
      getManager: () => {
        try {
          if (xterm._mgr) return xterm._mgr;
          const XM = (window.XKeen && window.XKeen.terminal) ? window.XKeen.terminal.xterm_manager : null;
          if (XM && typeof XM.getOrCreate === 'function') xterm._mgr = XM.getOrCreate(ctx);
          else if (XM && typeof XM.createManager === 'function') {
            window.XKeen.terminal.__xtermManager = window.XKeen.terminal.__xtermManager || XM.createManager(ctx);
            xterm._mgr = window.XKeen.terminal.__xtermManager;
          }
        } catch (e) {}
        return xterm._mgr;
      },
      ensureTerminal: (opts) => {
        const m = xterm.getManager();
        return m && typeof m.ensureTerminal === 'function' ? m.ensureTerminal(opts || {}) : { term: null, created: false };
      },
      getRefs: () => {
        const m = xterm.getManager();
        return m && typeof m.getRefs === 'function' ? m.getRefs() : {};
      },
      fit: () => {
        const m = xterm.getManager();
        return m && typeof m.fit === 'function' ? m.fit() : undefined;
      },
      dispose: () => {
        const m = xterm.getManager();
        return m && typeof m.disposeTerminal === 'function' ? m.disposeTerminal() : undefined;
      },
    };

    // Construct ctx early so session controller can reference ctx.xterm/transport/etc.
    const ctx = {
      core,
      caps,
      dom,
      xterm,
      transport,
      session: null,
      // Legacy-compatible state object + store API
      state,
      events,
      log,
      config,
      ui,
      api,
      // Filled below
      commands: null,
    };

    // Session controller (Stage 3): unified connect/reconnect/switchMode API.
    // Falls back to a minimal facade if controller is unavailable.
    try {
      const mk = window.XKeen && window.XKeen.terminal && window.XKeen.terminal.core
        ? window.XKeen.terminal.core.createSessionController
        : null;
      if (typeof mk === 'function') {
        ctx.session = mk(ctx);
      }
    } catch (e) {
      ctx.session = null;
    }

    if (!ctx.session) {
      // Minimal fallback (Stage 1 behavior)
      ctx.session = {
        getMode: () => {
          try { return (core && typeof core.getMode === 'function') ? (core.getMode() || 'shell') : (state && state.mode) || 'shell'; } catch (e) {}
          return (state && state.mode) || 'shell';
        },
        setMode: (mode) => {
          const m = String(mode || 'shell');
          try { if (core && typeof core.setMode === 'function') core.setMode(m); } catch (e) {}
          try { if (state && typeof state.set === 'function') state.set('mode', m); else state.mode = m; } catch (e2) {}
          try { events.emit('session:modeChanged', { mode: m }); } catch (e3) {}
        },
        connect: (opts) => {
          const m = (opts && opts.mode) ? String(opts.mode) : null;
          if (m) ctx.session.setMode(m);
          try { events.emit('session:connecting', { mode: ctx.session.getMode() }); } catch (e) {}
          try { return transport && typeof transport.connect === 'function' ? transport.connect() : undefined; } catch (e2) {}
        },
        disconnect: (opts) => {
          try { return transport && typeof transport.disconnect === 'function' ? transport.disconnect(opts || {}) : undefined; } catch (e) {}
        },
        isConnected: () => {
          try { return !!(transport && typeof transport.isConnected === 'function' && transport.isConnected()); } catch (e) {}
          return false;
        },
      };
    }

    // Stage 6: UI updates (lamp/uptime) are handled by ui_controller,
    // which subscribes to session:* events.

    // Commands (Stage 8.5): router/registry/builtins are wired by terminal.js bootstrap.
    // Keep placeholders to avoid undefined checks in modules.
    try { ctx.router = ctx.router || null; } catch (e) { ctx.router = null; }
    try { ctx.commands = ctx.commands || ctx.router; } catch (e) { ctx.commands = null; }
    try { ctx.commandRegistry = ctx.commandRegistry || null; } catch (e) { ctx.commandRegistry = null; }

    // Module registry (Stage D)
    try {
      const regFactory = window.XKeen.terminal.core.createRegistry;
      if (typeof regFactory === 'function') {
        ctx.registry = regFactory(ctx);
      }
    } catch (e) {
      ctx.registry = null;
    }

    // Stage 1: normalize key PTY events -> session events.
    try {
      events.on('pty:connecting', (p) => {
        try { events.emit('session:connecting', Object.assign({ mode: 'pty' }, (p || {}))); } catch (e) {}
      });
      events.on('pty:connected', (p) => {
        try { events.emit('session:connected', Object.assign({ mode: 'pty' }, (p || {}))); } catch (e) {}
      });
      events.on('pty:disconnected', (p) => {
        try { events.emit('session:disconnected', Object.assign({ mode: 'pty' }, (p || {}))); } catch (e) {}
      });
      events.on('pty:error', (p) => {
        try { events.emit('session:error', Object.assign({ mode: 'pty' }, (p || {}))); } catch (e) {}
      });
      events.on('pty:retry', (p) => {
        try { events.emit('session:retry', Object.assign({ mode: 'pty' }, (p || {}))); } catch (e) {}
      });
    } catch (e) {}

    return ctx;
  }

  // Singleton accessor: used by legacy modules without imports
  function getCtx() {
    if (window.XKeen.terminal.ctx) return window.XKeen.terminal.ctx;
    const ctx = createTerminalContext();
    window.XKeen.terminal.ctx = ctx;
    return ctx;
  }

  window.XKeen.terminal.core.createTerminalContext = createTerminalContext;
  window.XKeen.terminal.core.getCtx = getCtx;
})();

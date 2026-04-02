import {
  ensureTerminalRoot,
  getTerminalCompatApi,
  getTerminalCoreCompatApi,
  getTerminalPtyApi,
  getTerminalTransportCompatApi,
  publishTerminalCoreCompatApi,
} from '../runtime.js';

// Terminal core: createTerminalContext() вЂ” wiring for A/B stages
(function () {
  'use strict';

  function createTerminalContext() {
    const terminal = ensureTerminalRoot();
    const core = getTerminalCompatApi('_core');
    const caps = getTerminalCompatApi('capabilities');

    let state = null;
    try {
      state = (core && core.state) ? core.state : null;
    } catch (e) {}
    if (!state) {
      try {
        const ds = getTerminalCoreCompatApi('defaultState');
        state = (typeof ds === 'function') ? ds() : { mode: 'shell' };
      } catch (e2) {
        state = { mode: 'shell' };
      }
    }

    const createEventBus = getTerminalCoreCompatApi('createEventBus');
    const events = createEventBus
      ? createEventBus()
      : { on: () => () => {}, off: () => {}, emit: () => {} };

    try {
      const mkStore = getTerminalCoreCompatApi('createStateStore');
      if (typeof mkStore === 'function') state = mkStore(state, events);
    } catch (e) {}

    const createLogger = getTerminalCoreCompatApi('createLogger');
    const log = createLogger
      ? createLogger('terminal')
      : { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, enabled: () => false };

    const createConfig = getTerminalCoreCompatApi('createConfig');
    const config = createConfig
      ? createConfig()
      : { get: () => undefined, set: () => false, defaults: () => ({}), keys: () => ({}) };

    const createUiAdapter = getTerminalCoreCompatApi('createUiAdapter');
    const ui = createUiAdapter
      ? createUiAdapter(core)
      : { byId: (id) => { try { return (core && typeof core.byId === 'function') ? core.byId(id) : null; } catch (e) { return null; } }, get: {}, toast: () => {}, show: () => {}, hide: () => {} };

    function createDomCache() {
      const dom = {};
      function refresh() {
        try {
          if (!ui || !ui.get) return dom;
          const g = ui.get;
          dom.overlay = typeof g.overlay === 'function' ? g.overlay() : null;
          dom.outputPre = typeof g.outputPre === 'function' ? g.outputPre() : (typeof g.output === 'function' ? g.output() : null);
          dom.output = typeof g.output === 'function' ? g.output() : dom.outputPre;
          dom.xtermHost = typeof g.xtermHost === 'function' ? g.xtermHost() : null;
          dom.commandInput = typeof g.commandInput === 'function' ? g.commandInput() : (typeof g.cmd === 'function' ? g.cmd() : null);
          dom.stdinInput = typeof g.stdinInput === 'function' ? g.stdinInput() : (typeof g.stdin === 'function' ? g.stdin() : null);
          dom.connLamp = typeof g.connLamp === 'function' ? g.connLamp() : (typeof g.lamp === 'function' ? g.lamp() : null);
          dom.uptime = typeof g.uptime === 'function' ? g.uptime() : null;
          dom.stopRetryBtn = typeof g.stopRetryBtn === 'function' ? g.stopRetryBtn() : null;
          dom.retryNowBtn = typeof g.retryNowBtn === 'function' ? g.retryNowBtn() : null;
          dom.followBtn = typeof g.followBtn === 'function' ? g.followBtn() : null;
          dom.bottomBtn = typeof g.bottomBtn === 'function' ? g.bottomBtn() : null;
          dom.overflowMenu = typeof g.overflowMenu === 'function' ? g.overflowMenu() : null;
          dom.viewMenu = typeof g.viewMenu === 'function' ? g.viewMenu() : null;
          dom.bufferMenu = typeof g.bufferMenu === 'function' ? g.bufferMenu() : null;
          dom.openShellBtn = typeof g.openShellBtn === 'function' ? g.openShellBtn() : null;
          dom.openPtyBtn = typeof g.openPtyBtn === 'function' ? g.openPtyBtn() : null;
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

    const createApi = getTerminalCoreCompatApi('createApi');
    const api = createApi ? createApi(caps) : { apiFetch: (...args) => fetch(...args) };

    let transport = null;
    try {
      const createTransportManager = getTerminalTransportCompatApi('createTransportManager');
      if (typeof createTransportManager === 'function') {
        transport = createTransportManager({ core, caps, ui, events, api, state, config, log, dom });
      }
    } catch (e) {}

    if (!transport) {
      transport = {
        kind: 'unknown',
        connect: () => {
          try {
            const pty = getTerminalPtyApi();
            return pty && pty.connect ? pty.connect() : undefined;
          } catch (e) {}
        },
        disconnect: () => {
          try {
            const pty = getTerminalPtyApi();
            return pty && pty.disconnect ? pty.disconnect() : undefined;
          } catch (e) {}
        },
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
          let mode = 'shell';
          try { mode = (core && typeof core.getMode === 'function') ? (core.getMode() || 'shell') : (state && state.mode) || 'shell'; } catch (e) {}
          const wantPty = (String(o.prefer || '') === 'pty') || (mode === 'pty');
          if (wantPty) {
            try {
              const pty = getTerminalPtyApi();
              if (pty && typeof pty.sendRaw === 'function') { pty.sendRaw(payload); return true; }
            } catch (e) {}
            return false;
          }
          try {
            const liteRunner = getTerminalCompatApi('lite_runner');
            if (!liteRunner || typeof liteRunner.sendTerminalInput !== 'function') return false;
            const cmdEl = ui && ui.get && typeof ui.get.cmd === 'function' ? ui.get.cmd() : ((core && typeof core.byId === 'function') ? core.byId('terminal-command') : null);
            if (cmdEl) cmdEl.value = payload.replace(/\n+$/g, '').trim();
            const shouldRun = /\n$/.test(payload) || o.run === true;
            if (shouldRun) liteRunner.sendTerminalInput();
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

    const xterm = {
      _mgr: null,
      getManager: () => {
        try {
          if (xterm._mgr) return xterm._mgr;
          const XM = getTerminalCompatApi('xterm_manager');
          if (XM && typeof XM.getOrCreate === 'function') xterm._mgr = XM.getOrCreate(ctx);
          else if (XM && typeof XM.createManager === 'function') {
            if (terminal) terminal.__xtermManager = terminal.__xtermManager || XM.createManager(ctx);
            xterm._mgr = terminal ? terminal.__xtermManager : XM.createManager(ctx);
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

    const ctx = {
      core,
      caps,
      dom,
      xterm,
      transport,
      session: null,
      state,
      events,
      log,
      config,
      ui,
      api,
      commands: null,
    };

    try {
      const mk = getTerminalCoreCompatApi('createSessionController');
      if (typeof mk === 'function') ctx.session = mk(ctx);
    } catch (e) {
      ctx.session = null;
    }

    if (!ctx.session) {
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

    try { ctx.router = ctx.router || null; } catch (e) { ctx.router = null; }
    try { ctx.commands = ctx.commands || ctx.router; } catch (e) { ctx.commands = null; }
    try { ctx.commandRegistry = ctx.commandRegistry || null; } catch (e) { ctx.commandRegistry = null; }

    try {
      const regFactory = getTerminalCoreCompatApi('createRegistry');
      if (typeof regFactory === 'function') ctx.registry = regFactory(ctx);
    } catch (e) {
      ctx.registry = null;
    }

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

  function getCtx() {
    const terminal = ensureTerminalRoot();
    if (terminal && terminal.ctx) return terminal.ctx;
    const ctx = createTerminalContext();
    if (terminal) terminal.ctx = ctx;
    return ctx;
  }

  publishTerminalCoreCompatApi('createTerminalContext', createTerminalContext);
  publishTerminalCoreCompatApi('getCtx', getCtx);
})();

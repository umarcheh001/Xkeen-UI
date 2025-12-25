// Terminal module: status controller (Stage 8.3.5)
//
// Centralizes terminal "status" UI that must not live in terminal.js:
//  - connection lamp state
//  - uptime timer (PTY)
//
// Listens to session:* events and updates DOM in one place.
(function () {
  'use strict';

  window.XKeen = window.XKeen || {};
  window.XKeen.terminal = window.XKeen.terminal || {};

  function safeOn(events, name, fn) {
    try {
      if (events && typeof events.on === 'function') {
        return events.on(String(name || ''), fn);
      }
    } catch (e) {}
    return function () {};
  }

  function getStore(ctx) {
    try { return (ctx && ctx.state) ? ctx.state : null; } catch (e) {}
    return null;
  }

  function storeGet(store, key, fallback) {
    const k = String(key || '');
    if (!k) return fallback;
    try {
      if (store && typeof store.get === 'function') return store.get(k, fallback);
      if (store && store[k] !== undefined) return store[k];
    } catch (e) {}
    return fallback;
  }

  function storeSet(store, key, value) {
    const k = String(key || '');
    if (!k) return false;
    try {
      if (store && typeof store.set === 'function') return store.set(k, value);
      if (store) { store[k] = value; return true; }
    } catch (e) {}
    return false;
  }

  function getEl(ctx, kind) {
    try {
      const ui = (ctx && ctx.ui) ? ctx.ui : null;
      if (ui) {
        if (ui.get) {
          if (kind === 'lamp' && typeof ui.get.connLamp === 'function') return ui.get.connLamp();
          if (kind === 'uptime' && typeof ui.get.uptime === 'function') return ui.get.uptime();
        }
        if (typeof ui.byId === 'function') {
          return ui.byId(kind === 'lamp' ? 'terminal-conn-lamp' : 'terminal-uptime');
        }
      }
    } catch (e) {}
    try { return document.getElementById(kind === 'lamp' ? 'terminal-conn-lamp' : 'terminal-uptime'); } catch (e2) {}
    return null;
  }

  function formatUptime(ms) {
    const total = Math.max(0, Math.floor((ms || 0) / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n) => String(n).padStart(2, '0');
    if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
    return `${pad(m)}:${pad(s)}`;
  }

  function createController(ctx) {
    const events = (ctx && ctx.events) ? ctx.events : { on: () => function () {} };
    const store = getStore(ctx);
    const legacyCore = (window.XKeen && window.XKeen.terminal) ? window.XKeen.terminal._core : null;

    const st = {
      inited: false,
      timer: null,
      startMs: null,
      connState: 'disconnected',
      disposables: [],
    };

    function updateUptimeUi() {
      const el = getEl(ctx, 'uptime');
      if (!el) return;
      if (!st.startMs) {
        try { el.textContent = '00:00'; } catch (e) {}
        return;
      }
      const ms = Date.now() - st.startMs;
      try { el.textContent = formatUptime(ms); } catch (e2) {}
    }

    function stopUptimeTimer() {
      if (st.timer) {
        try { clearInterval(st.timer); } catch (e) {}
        st.timer = null;
      }
      st.startMs = null;
      storeSet(store, 'terminalUptimeStartMs', null);
      updateUptimeUi();
    }

    function startUptimeTimer(startMs) {
      st.startMs = Number.isFinite(startMs) ? startMs : Date.now();
      storeSet(store, 'terminalUptimeStartMs', st.startMs);
      updateUptimeUi();
      if (st.timer) {
        try { clearInterval(st.timer); } catch (e) {}
      }
      st.timer = setInterval(updateUptimeUi, 1000);
    }

    function applyLamp(connState, detail) {
      const lamp = getEl(ctx, 'lamp');
      if (!lamp) return;

      const map = {
        connected: 'running',
        connecting: 'pending',
        disconnected: 'stopped',
        error: 'error',
      };
      const s = String(connState || 'error');
      const mapped = map[s] || 'error';
      try { lamp.setAttribute('data-state', mapped); } catch (e) {}

      const stateRu = {
        connected: 'подключено',
        connecting: 'подключение...',
        disconnected: 'отключено',
        error: 'ошибка',
      };
      try {
        lamp.title = String(detail || ('Терминал: ' + (stateRu[s] || s)));
      } catch (e2) {}
    }

    function setConnState(connState, detail) {
      const s = String(connState || 'error');
      st.connState = s;
      storeSet(store, 'terminalConnState', s);

      // Keep legacy state in sync for modules that still read it.
      try {
        if (legacyCore && legacyCore.state) legacyCore.state.connState = s;
      } catch (e) {}

      applyLamp(s, detail);

      if (s === 'connected') {
        if (!st.startMs) startUptimeTimer(Date.now());
      } else {
        stopUptimeTimer();
      }
    }

    function restoreFromState() {
      const s = storeGet(store, 'terminalConnState', null) ||
        (legacyCore && legacyCore.state ? legacyCore.state.connState : null) ||
        'disconnected';

      st.connState = String(s || 'disconnected');

      const savedStart = storeGet(store, 'terminalUptimeStartMs', null);
      const start = (savedStart != null) ? Number(savedStart) : null;
      st.startMs = (start && Number.isFinite(start) && start > 0) ? start : null;

      applyLamp(st.connState);

      if (st.connState === 'connected' && st.startMs) {
        startUptimeTimer(st.startMs);
      } else {
        stopUptimeTimer();
      }
    }

    function bindSessionEvents() {
      // NOTE: details are optional; we keep readable Russian defaults.
      st.disposables.push(safeOn(events, 'session:connecting', (p) => {
        const mode = (p && p.mode) ? String(p.mode) : '';
        if (mode && mode !== 'pty') {
          setConnState('disconnected', 'Терминал: отключено');
          return;
        }
        setConnState('connecting', 'Терминал: подключение...');
      }));

      st.disposables.push(safeOn(events, 'session:connected', (p) => {
        const mode = (p && p.mode) ? String(p.mode) : '';
        if (mode && mode !== 'pty') {
          setConnState('disconnected', 'Терминал: отключено');
          return;
        }
        setConnState('connected', 'Терминал: подключено');
      }));

      st.disposables.push(safeOn(events, 'session:disconnected', (p) => {
        const mode = (p && p.mode) ? String(p.mode) : '';
        if (mode && mode !== 'pty') {
          setConnState('disconnected', 'Терминал: отключено');
          return;
        }
        setConnState('disconnected', 'Терминал: отключено');
      }));

      st.disposables.push(safeOn(events, 'session:error', (p) => {
        const msg = (p && (p.message || p.detail)) ? String(p.message || p.detail) : 'ошибка';
        setConnState('error', 'Терминал: ' + msg);
      }));

      // When switching away from PTY, uptime must stop.
      st.disposables.push(safeOn(events, 'session:modeChanged', (p) => {
        const mode = (p && p.mode) ? String(p.mode) : (p && p.to ? String(p.to) : '');
        if (mode && mode !== 'pty') {
          setConnState('disconnected', 'Терминал: отключено');
        }
      }));
    }

    function init() {
      if (st.inited) return;
      st.inited = true;
      bindSessionEvents();
      restoreFromState();
    }

    function dispose() {
      const arr = st.disposables.splice(0, st.disposables.length);
      arr.forEach((off) => {
        try { if (typeof off === 'function') off(); } catch (e) {}
      });
      st.inited = false;
    }

    const api = {
      init,
      dispose,
      setConnState,
      updateUptimeUi,
      startUptimeTimer,
      stopUptimeTimer,
      getConnState: () => st.connState,
    };

    // Expose on ctx + global for compatibility.
    try { if (ctx) ctx.statusCtrl = api; } catch (e) {}
    try { if (ctx) ctx.status = api; } catch (e2) {}
    try { window.XKeen.terminal.status = api; } catch (e3) {}

    return {
      id: 'status_controller',
      priority: 30,
      init: () => { try { api.init(); } catch (e) {} },
      onOpen: () => { try { api.init(); } catch (e) {} },
      onClose: () => {
        // On hard close we stop timers (disconnect will also arrive via events).
        try { api.stopUptimeTimer(); } catch (e) {}
      },
      // Expose method for other modules/wrappers.
      setConnState: api.setConnState,
    };
  }

  window.XKeen.terminal.status_controller = {
    createModule: (ctx) => createController(ctx),
    createController,
  };
})();

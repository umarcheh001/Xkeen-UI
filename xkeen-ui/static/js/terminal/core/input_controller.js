// Terminal core: input controller
//
// Stage 5:
//   - Route xterm input -> ctx.transport
//   - Route lite UI inputs (#terminal-command + #terminal-input) -> ctx.transport
//   - Keep terminal.js as an orchestrator only

(function () {
  'use strict';

  window.XKeen = window.XKeen || {};
  window.XKeen.terminal = window.XKeen.terminal || {};
  window.XKeen.terminal.core = window.XKeen.terminal.core || {};

  function safeToast(ctx, msg, kind) {
    try {
      if (ctx && ctx.ui && typeof ctx.ui.toast === 'function') return ctx.ui.toast(String(msg || ''), kind || 'info');
    } catch (e) {}
    try {
      if (typeof window.showToast === 'function') return window.showToast(String(msg || ''), kind || 'info');
    } catch (e2) {}
  }

  function getMode(ctx) {
    try {
      if (ctx && ctx.session && typeof ctx.session.getMode === 'function') return ctx.session.getMode() || 'shell';
    } catch (e) {}
    try {
      if (ctx && ctx.core && typeof ctx.core.getMode === 'function') return ctx.core.getMode() || 'shell';
    } catch (e2) {}
    try {
      if (ctx && ctx.state) {
        if (typeof ctx.state.get === 'function') return ctx.state.get('mode') || 'shell';
        return ctx.state.mode || 'shell';
      }
    } catch (e3) {}
    return 'shell';
  }

  function normalizeStdin(value) {
    const raw = String(value == null ? '' : value);
    if (raw === '') return '\n';
    return /\r|\n$/.test(raw) ? raw : (raw + '\n');
  }

  function createInputController(ctx) {
    const events = (ctx && ctx.events) ? ctx.events : { on: () => () => {}, emit: () => {} };
    const transport = (ctx && ctx.transport) ? ctx.transport : null;

    let offXtermData = null;

    function isInputLocked() {
      try {
        if (ctx && ctx.state && typeof ctx.state.get === 'function') return !!ctx.state.get('inputLocked');
        if (ctx && ctx.state) return !!ctx.state.inputLocked;
      } catch (e) {}
      return false;
    }

    function setInputLocked(on) {
      const v = !!on;
      try {
        if (ctx && ctx.state && typeof ctx.state.set === 'function') ctx.state.set('inputLocked', v);
        else if (ctx && ctx.state) ctx.state.inputLocked = v;
      } catch (e) {}
      try { events.emit('term:input:lock', { locked: v, ts: Date.now() }); } catch (e2) {}
    }

    function routeXtermToTransport(payload) {
      if (!transport || typeof transport.send !== 'function') return;
      if (isInputLocked()) return;

      const mode = getMode(ctx);
      if (mode !== 'pty') return;

      const data = payload && typeof payload.data === 'string' ? payload.data : String(payload == null ? '' : payload);
      if (!data) return;

      try { transport.send(data, { prefer: 'pty' }); } catch (e) {}
    }

    async function submitFromUi(opts) {
      const o = opts || {};

      // In PTY mode input is typed directly into xterm.
      if (getMode(ctx) === 'pty') return false;
      if (!transport || typeof transport.send !== 'function') {
        safeToast(ctx, 'Terminal transport is not available', 'error');
        return false;
      }

      // UI elements
      let cmdEl = null;
      let stdinEl = null;
      try { cmdEl = ctx && ctx.dom ? (ctx.dom.commandInput || null) : null; } catch (e) {}
      try { stdinEl = ctx && ctx.dom ? (ctx.dom.stdinInput || null) : null; } catch (e2) {}
      try {
        if (!cmdEl && ctx && ctx.ui && ctx.ui.get && typeof ctx.ui.get.commandInput === 'function') cmdEl = ctx.ui.get.commandInput();
      } catch (e3) {}
      try {
        if (!stdinEl && ctx && ctx.ui && ctx.ui.get && typeof ctx.ui.get.stdinInput === 'function') stdinEl = ctx.ui.get.stdinInput();
      } catch (e4) {}
      try {
        if (!cmdEl && ctx && ctx.core && typeof ctx.core.byId === 'function') cmdEl = ctx.core.byId('terminal-command');
        if (!stdinEl && ctx && ctx.core && typeof ctx.core.byId === 'function') stdinEl = ctx.core.byId('terminal-input');
      } catch (e5) {}

      const cmdText = cmdEl ? String(cmdEl.value || '').trim() : '';
      if (!cmdText) {
        safeToast(ctx, 'Введите команду', 'info');
        return false;
      }

      // Builtin router (Stage C)
      try {
        if (ctx && ctx.router && typeof ctx.router.route === 'function') {
          const r = await ctx.router.route(cmdText, { source: 'ui' });
          if (r && r.handled) return true;
        }
      } catch (e6) {}

      // Persist to history (Stage 5: keep history logic outside terminal.js)
      try {
        const H = (window.XKeen && window.XKeen.terminal) ? window.XKeen.terminal.history : null;
        if (H && typeof H.push === 'function') H.push(cmdText);
      } catch (e7) {}

      // stdin/confirm flow: if stdin field is visible and non-empty, send as stdin
      let stdinValue = '';
      try { stdinValue = stdinEl ? String(stdinEl.value || '') : ''; } catch (e8) { stdinValue = ''; }
      const stdinIsMeaningful = !!(stdinValue && stdinValue.trim());

      try {
        const payload = cmdText + '\n';
        if (stdinIsMeaningful || o.forceStdin === true) {
          transport.send(payload, { prefer: 'lite', run: true, stdinValue: normalizeStdin(stdinValue) });
        } else {
          transport.send(payload, { prefer: 'lite', run: true });
        }
      } catch (e9) {
        safeToast(ctx, 'Не удалось отправить команду', 'error');
        return false;
      }

      // Clear stdin after send (confirm should be re-detected from output)
      try { if (stdinEl) stdinEl.value = ''; } catch (e10) {}

      // Keep focus in command field
      try { if (cmdEl && typeof cmdEl.focus === 'function') cmdEl.focus(); } catch (e11) {}

      return true;
    }

    function init() {
      if (offXtermData) return;
      try {
        offXtermData = events.on('xterm:data', (payload) => {
          try { routeXtermToTransport(payload); } catch (e) {}
        });
      } catch (e) {
        offXtermData = null;
      }

      // Mirror command input changes to consumers (optional)
      try {
        const cmdEl = ctx && ctx.dom ? (ctx.dom.commandInput || null) : null;
        if (cmdEl && !cmdEl.__xkeenInputCtlBound) {
          cmdEl.__xkeenInputCtlBound = true;
          cmdEl.addEventListener('input', () => {
            try { events.emit('term:input:buffer', { text: String(cmdEl.value || ''), source: 'ui', ts: Date.now() }); } catch (e) {}
          });
        }
      } catch (e2) {}
    }

    function dispose() {
      try { if (offXtermData) offXtermData(); } catch (e) {}
      offXtermData = null;
    }

    return {
      init,
      dispose,
      submitFromUi,
      setInputLocked,
      isInputLocked,
    };
  }

  // Export factory
  window.XKeen.terminal.core.createInputController = createInputController;

  // Registry plugin wrapper
  window.XKeen.terminal.input_controller = {
    createModule: (ctx) => {
      const ctl = createInputController(ctx);
      try { ctx.input = ctl; } catch (e) {}
      return {
        id: 'input_controller',
        priority: 30,
        init: () => { try { ctl.init(); } catch (e) {} },
        onOpen: () => { try { ctl.init(); } catch (e) {} },
        onClose: () => { try { ctl.dispose(); } catch (e) {} },
      };
    },
  };
})();

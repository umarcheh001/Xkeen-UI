// Terminal confirm prompt module (Stage 8.3.2)
// Shows/hides #terminal-input when output suggests a confirmation prompt.
// Emits: confirm:show, confirm:hide, confirm:submit
(function () {
  'use strict';

  window.XKeen = window.XKeen || {};
  window.XKeen.terminal = window.XKeen.terminal || {};

  function createConfirmPrompt(ctx) {
    const events = (ctx && ctx.events) ? ctx.events : { on: () => () => {}, emit: () => {} };
    const ui = (ctx && ctx.ui) ? ctx.ui : null;
    const session = (ctx && ctx.session) ? ctx.session : null;
    const transport = (ctx && ctx.transport) ? ctx.transport : null;

    const state = {
      offChunk: null,
      offMode: null,
    };

    function byId(id) {
      try { return (ui && typeof ui.byId === 'function') ? ui.byId(id) : document.getElementById(id); } catch (e) {}
      return null;
    }

    function getMode() {
      try { if (session && typeof session.getMode === 'function') return session.getMode(); } catch (e) {}
      try {
        const core = window.XKeen && window.XKeen.terminal && window.XKeen.terminal._core;
        if (core && typeof core.getMode === 'function') return core.getMode();
      } catch (e2) {}
      return 'shell';
    }

    function detectConfirmPrompt(text) {
      const s = String(text || '');
      const patterns = [
        /для\s+подтвержден/i,
        /нужно\s+подтверд/i,
        /подтверд(ите|ить)/i,
        /введите\s+(?:yes|y)\b/i,
        /нажмите\s+enter\b/i,
        /type\s+(?:yes|y)\b/i,
        /are\s+you\s+sure/i,
        /\bconfirm\b/i,
        /\b(y\/n|yes\/no)\b/i,
        /\[[yY]\s*\/\s*[nN]\]/,
        /\([yY]\s*\/\s*[nN]\)/,
        /press\s+enter\b/i,
      ];
      return patterns.some((re) => re.test(s));
    }

    function isVisible() {
      const inputEl = byId('terminal-input');
      if (!inputEl) return false;
      try { if (inputEl.style && inputEl.style.display === 'none') return false; } catch (e) {}
      try { if (inputEl.offsetParent === null) return false; } catch (e2) {}
      return true;
    }

    function setVisible(visible, opts) {
      const o = opts || {};
      const inputEl = byId('terminal-input');
      if (!inputEl) return;
      const row = inputEl.closest ? inputEl.closest('.terminal-input-row') : null;

      if (visible) {
        try { inputEl.style.display = ''; } catch (e) {}
        try { if (row) row.classList.remove('confirm-hidden'); } catch (e2) {}
        try {
          if (o.focus) inputEl.focus();
        } catch (e3) {}
      } else {
        try { inputEl.style.display = 'none'; } catch (e4) {}
        try { if (row) row.classList.add('confirm-hidden'); } catch (e5) {}
        if (!o || o.clear !== false) {
          try { inputEl.value = ''; } catch (e6) {}
        }
      }
    }

    function show(opts) {
      if (getMode() === 'pty') return false;
      if (isVisible()) return false;
      setVisible(true, opts || { focus: true, clear: false });
      try { events.emit('confirm:show', { ts: Date.now() }); } catch (e) {}
      return true;
    }

    function hide(opts) {
      if (!isVisible()) return false;
      setVisible(false, opts || { clear: true });
      try { events.emit('confirm:hide', { ts: Date.now() }); } catch (e) {}
      return true;
    }

    function submit() {
      // In PTY mode confirmation input is not used.
      if (getMode() === 'pty') return false;
      const inputEl = byId('terminal-input');
      if (!inputEl) return false;

      const raw = String(inputEl.value || '');
      const payload = (raw === '' ? '\n' : (raw + '\n'));

      // Hide immediately so UI doesn't flicker while command re-runs.
      try { hide({ clear: false }); } catch (e0) {}

      let ok = false;
      try {
        if (transport && typeof transport.send === 'function') {
          ok = !!transport.send(payload, { stdin: true, source: 'confirm_prompt' });
        } else if (window.XKeen && window.XKeen.terminal && window.XKeen.terminal.api && typeof window.XKeen.terminal.api.send === 'function') {
          // Fallback: raw transport send via API.
          void window.XKeen.terminal.api.send(payload, { raw: true, stdin: true, source: 'confirm_prompt' });
          ok = true;
        }
      } catch (e1) {}

      try { events.emit('confirm:submit', { text: raw, ok: !!ok, ts: Date.now() }); } catch (e2) {}

      // Clear after submit so the next prompt starts clean.
      try { inputEl.value = ''; } catch (e3) {}
      return ok;
    }

    function sendOrSubmit() {
      // Used by UI controller: Enter or Send button.
      if (isVisible()) return submit();
      try {
        if (ctx && ctx.input && typeof ctx.input.submitFromUi === 'function') {
          return ctx.input.submitFromUi();
        }
      } catch (e) {}
      // Last-resort fallback
      try {
        if (window.XKeen && window.XKeen.terminal && window.XKeen.terminal.api && typeof window.XKeen.terminal.api.send === 'function') {
          const cmdEl = byId('terminal-command');
          const cmd = cmdEl ? String(cmdEl.value || '') : '';
          if (cmd.trim()) { void window.XKeen.terminal.api.send(cmd + '\n', { source: 'confirm_prompt_fallback' }); return true; }
        }
      } catch (e2) {}
      return false;
    }

    function onChunk(payload) {
      // payload may be {raw, chunk, source,...}
      if (getMode() === 'pty') {
        // Force-hide in PTY.
        try { hide({ clear: true }); } catch (e0) {}
        return;
      }

      let raw = '';
      try {
        if (payload && typeof payload === 'object') raw = String(payload.raw != null ? payload.raw : (payload.chunk || ''));
        else raw = String(payload || '');
      } catch (e) {
        raw = '';
      }
      if (!raw) return;

      const hasConfirm = detectConfirmPrompt(raw);

      if (!isVisible()) {
        if (hasConfirm) {
          // Focus only when overlay is open.
          try { show({ focus: true, clear: false }); } catch (e2) {}
        }
        return;
      }

      // If visible: hide on obvious completion/prompt markers.
      // Heuristics: shell prompt / exit / done markers without another confirm prompt.
      if (!hasConfirm) {
        const doneRe = /\[Exit\]|\bfinished\b|\bDone\b|\bOK\b|\bуспешно\b/i;
        const promptRe = /(^|\n)\$\s/;
        if (doneRe.test(raw) || promptRe.test(raw)) {
          try { hide({ clear: true }); } catch (e3) {}
        }
      }
    }

    function init() {
      // Hide on start.
      try { hide({ clear: true }); } catch (e0) {}

      try {
        if (events && typeof events.on === 'function' && !state.offChunk) {
          state.offChunk = events.on('output:chunk', onChunk);
        }
      } catch (e1) {}

      try {
        if (events && typeof events.on === 'function' && !state.offMode) {
          state.offMode = events.on('session:modeChanged', () => {
            try {
              if (getMode() === 'pty') hide({ clear: true });
            } catch (e2) {}
          });
        }
      } catch (e3) {}
    }

    function dispose() {
      try { if (state.offChunk) state.offChunk(); } catch (e) {}
      state.offChunk = null;
      try { if (state.offMode) state.offMode(); } catch (e2) {}
      state.offMode = null;
    }

    return { init, dispose, isVisible, show, hide, submit, sendOrSubmit };
  }

  // Registry plugin wrapper
  window.XKeen.terminal.confirm_prompt = {
    createModule: (ctx) => {
      const mod = createConfirmPrompt(ctx);
      try { ctx.confirmPrompt = mod; } catch (e) {}
      try { window.XKeen.terminal.confirmPrompt = mod; } catch (e2) {}

      return {
        id: 'confirm_prompt',
        priority: 22,
        init: () => { try { mod.init(); } catch (e) {} },
        onOpen: () => { try { mod.init(); } catch (e) {} },
        onClose: () => { try { mod.dispose(); } catch (e) {} },
      };
    },
  };
})();

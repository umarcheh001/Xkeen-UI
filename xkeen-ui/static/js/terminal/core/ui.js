// Terminal core: UI adapter (single place for DOM lookups)
(function () {
  'use strict';

  window.XKeen = window.XKeen || {};
  window.XKeen.terminal = window.XKeen.terminal || {};
  window.XKeen.terminal.core = window.XKeen.terminal.core || {};

  function createUiAdapter(core) {
    // NOTE: ui.js is the only place where direct document lookups are allowed.
    const byId = (id) => {
      try {
        if (core && typeof core.byId === 'function') {
          const el = core.byId(id);
          if (el) return el;
        }
      } catch (e) {}
      try {
        return document.getElementById(id);
      } catch (e2) {}
      return null;
    };

    const get = {
      // Main terminal overlay + hosts
      overlay: () => byId('terminal-overlay'),
      outputPre: () => byId('terminal-output'),
      // Backward-compatible alias
      output: () => byId('terminal-output'),
      xtermHost: () => byId('terminal-xterm'),

      // Inputs
      commandInput: () => byId('terminal-command'),
      // Backward-compatible alias
      cmd: () => byId('terminal-command'),
      stdinInput: () => byId('terminal-input'),
      // Backward-compatible alias
      stdin: () => byId('terminal-input'),

      // Retry controls (PTY)
      stopRetryBtn: () => byId('terminal-btn-stop-retry'),
      retryNowBtn: () => byId('terminal-btn-retry-now'),

      // Common view controls
      followBtn: () => byId('terminal-btn-follow'),
      bottomBtn: () => byId('terminal-btn-bottom'),

      // Menus
      overflowMenu: () => byId('terminal-overflow-menu'),
      viewMenu: () => byId('terminal-view-menu'),
      bufferMenu: () => byId('terminal-buffer-menu'),

      // Connection status
      connLamp: () => byId('terminal-conn-lamp'),
      // Aliases used in refactor plan/docs
      lamp: () => byId('terminal-conn-lamp'),
      statusLamp: () => byId('terminal-conn-lamp'),
      uptime: () => byId('terminal-uptime'),

      // Capability-dependent open buttons
      openShellBtn: () => byId('terminal-open-shell-btn'),
      openPtyBtn: () => byId('terminal-open-pty-btn'),

      // SSH modals (used by terminal.js)
      sshModal: () => byId('ssh-modal'),
      sshEditModal: () => byId('ssh-edit-modal'),
      sshConfirmModal: () => byId('ssh-confirm-modal'),
      sshProfilesList: () => byId('ssh-profiles-list'),
      sshCommandPreview: () => byId('ssh-command-preview'),
      sshDeleteSelectedBtn: () => byId('ssh-delete-selected-btn'),
      sshEditTitle: () => byId('ssh-edit-title'),
      sshEditDeleteBtn: () => byId('ssh-edit-delete-btn'),
      sshEditError: () => byId('ssh-edit-error'),
      sshConfirmText: () => byId('ssh-confirm-text'),
      sshConfirmOk: () => byId('ssh-confirm-ok'),
    };

    function toast(msg, kind) {
      try {
        if (typeof window.showToast === 'function') return window.showToast(String(msg || ''), kind || 'info');
      } catch (e) {}
    }

    function show(el) {
      if (!el) return;
      try { el.style.display = ''; } catch (e) {}
    }

    function hide(el) {
      if (!el) return;
      try { el.style.display = 'none'; } catch (e) {}
    }

    const set = {
      visible: (el, on) => {
        if (on) show(el);
        else hide(el);
      },
      enabled: (el, on) => {
        if (!el) return;
        const enabled = !!on;
        try { el.disabled = !enabled; } catch (e) {}
        try { el.classList.toggle('disabled', !enabled); } catch (e2) {}
        try { el.setAttribute('aria-disabled', enabled ? 'false' : 'true'); } catch (e3) {}
      },
      text: (el, v) => {
        if (!el) return;
        try { el.textContent = String(v == null ? '' : v); } catch (e) {}
      },
      html: (el, v) => {
        if (!el) return;
        try { el.innerHTML = String(v == null ? '' : v); } catch (e) {}
      },
      value: (el, v) => {
        if (!el) return;
        try { el.value = String(v == null ? '' : v); } catch (e) {}
      },
    };

    return { byId, get, set, toast, show, hide };
  }

  window.XKeen.terminal.core.createUiAdapter = createUiAdapter;
})();

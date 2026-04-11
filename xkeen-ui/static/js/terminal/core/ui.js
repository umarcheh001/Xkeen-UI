import {
  getTerminalById,
  publishTerminalCoreCompatApi,
  toastTerminal,
} from '../runtime.js';

// Terminal core: UI adapter (single place for DOM lookups)
(function () {
  'use strict';

  function createUiAdapter(core) {
    const byId = (id) => getTerminalById(id, (key) => {
      try {
        if (core && typeof core.byId === 'function') {
          const el = core.byId(key);
          if (el) return el;
        }
      } catch (e) {}
      return null;
    });

    const get = {
      overlay: () => byId('terminal-overlay'),
      outputPre: () => byId('terminal-output'),
      output: () => byId('terminal-output'),
      xtermHost: () => byId('terminal-xterm'),
      commandInput: () => byId('terminal-command'),
      cmd: () => byId('terminal-command'),
      stdinInput: () => byId('terminal-input'),
      stdin: () => byId('terminal-input'),
      stopRetryBtn: () => byId('terminal-btn-stop-retry'),
      retryNowBtn: () => byId('terminal-btn-retry-now'),
      followBtn: () => byId('terminal-btn-follow'),
      bottomBtn: () => byId('terminal-btn-bottom'),
      overflowMenu: () => byId('terminal-overflow-menu'),
      viewMenu: () => byId('terminal-view-menu'),
      bufferMenu: () => byId('terminal-buffer-menu'),
      connLamp: () => byId('terminal-conn-lamp'),
      lamp: () => byId('terminal-conn-lamp'),
      statusLamp: () => byId('terminal-conn-lamp'),
      uptime: () => byId('terminal-uptime'),
      openShellBtn: () => byId('terminal-open-shell-btn'),
      openPtyBtn: () => byId('terminal-open-pty-btn'),
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
      return toastTerminal(String(msg || ''), kind || 'info');
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
        // Safe-by-default: raw strings should not become live DOM markup.
        // Use trustedHtml() only for explicitly reviewed local templates.
        try { el.textContent = String(v == null ? '' : v); } catch (e) {}
      },
      trustedHtml: (el, v) => {
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

  publishTerminalCoreCompatApi('createUiAdapter', createUiAdapter);
})();

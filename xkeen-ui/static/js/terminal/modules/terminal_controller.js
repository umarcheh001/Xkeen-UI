// Terminal module: terminal controller (Stage 6/7)
//
// Purpose:
//   Move terminal business-logic out of terminal.js and expose a clean API via ctx.terminalCtrl.
//   UI (ui_actions / ui_controller) should delegate here.
//
// Responsibilities extracted from terminal.js:
//   - open / close / detach / killSession / reconnect / newSession
//   - switching modes (pty / lite)
//   - apply UI mode (was terminalApplyModeUi)
//   - registry lifecycle interaction (onOpen/onClose/attachTerm/detachTerm, onModeChange)
//   - signals: Ctrl+C / Ctrl+D / SIG*
//
// Notes:
//   - This controller is intentionally defensive (best-effort fallbacks), because load order
//     during refactor can vary.
//   - It does NOT bind any DOM listeners.
//
(function () {
  'use strict';

  window.XKeen = window.XKeen || {};
  window.XKeen.terminal = window.XKeen.terminal || {};

  function resolveCtx(fallbackCtx) {
    try {
      if (fallbackCtx) return fallbackCtx;
    } catch (e) {}
    try {
      const C = window.XKeen && window.XKeen.terminal && window.XKeen.terminal.core ? window.XKeen.terminal.core : null;
      if (C && typeof C.getCtx === 'function') return C.getCtx();
    } catch (e2) {}
    return null;
  }

  function safeToast(ctx, msg, kind) {
    const m = String(msg == null ? '' : msg);
    const k = String(kind || 'info');
    try {
      if (ctx && ctx.ui && typeof ctx.ui.toast === 'function') return ctx.ui.toast(m, k);
    } catch (e) {}
    try {
      if (typeof window.showToast === 'function') return window.showToast(m, k);
    } catch (e2) {}
  }

  function byId(ctx, id) {
    const c = resolveCtx(ctx);
    try {
      if (c && c.ui && typeof c.ui.byId === 'function') return c.ui.byId(id);
    } catch (e0) {}
    try { return document.getElementById(id); } catch (e1) {}
    return null;
  }

  function inputRowEl() {
    try { return document.querySelector('.terminal-input-row'); } catch (e) {}
    return null;
  }

  function getSession(ctx) {
    const c = resolveCtx(ctx);
    try { return c && c.session ? c.session : null; } catch (e) {}
    return null;
  }

  function getCoreState(ctx) {
    const c = resolveCtx(ctx);
    try {
      const core = (c && c.core) ? c.core : (window.XKeen && window.XKeen.terminal ? window.XKeen.terminal._core : null);
      return (core && core.state) ? core.state : null;
    } catch (e) {}
    return null;
  }

  function getRegistry(ctx) {
    const c = resolveCtx(ctx);
    try { return c && c.registry ? c.registry : null; } catch (e) {}
    return null;
  }

  function getOverlayCtrl(ctx) {
    const c = resolveCtx(ctx);
    try { return (c && (c.overlayCtrl || c.overlay)) ? (c.overlayCtrl || c.overlay) : null; } catch (e) {}
    return null;
  }

  function getUiCtrl(ctx) {
    const c = resolveCtx(ctx);
    try { return c && c.uiCtrl ? c.uiCtrl : null; } catch (e) {}
    return null;
  }

  function getXtermFacade(ctx) {
    const c = resolveCtx(ctx);
    try { return c && c.xterm ? c.xterm : null; } catch (e) {}
    return null;
  }

  function getTerm(ctx) {
    const c = resolveCtx(ctx);
    try {
      const xf = getXtermFacade(c);
      if (xf && typeof xf.getRefs === 'function') {
        const r = xf.getRefs() || {};
        return r.term || r.xterm || null;
      }
    } catch (e0) {}
    try {
      const st = getCoreState(c);
      return st ? (st.term || st.xterm || null) : null;
    } catch (e1) {}
    return null;
  }

  function termFocus(term) {
    try { if (term && typeof term.focus === 'function') term.focus(); } catch (e) {}
  }

  function termWriteln(term, text) {
    const s = String(text == null ? '' : text);
    if (!term) return;
    try { if (typeof term.writeln === 'function') return term.writeln(s); } catch (e0) {}
    try { if (typeof term.write === 'function') return term.write(s + '\r\n'); } catch (e1) {}
  }

  function isPtyWsOpen(ctx) {
    const c = resolveCtx(ctx);
    // Prefer session controller
    try {
      const S = getSession(c);
      if (S && typeof S.isConnected === 'function') return !!S.isConnected();
    } catch (e0) {}
    // Prefer transport (if exported)
    try {
      if (c && c.transport && typeof c.transport.isConnected === 'function') return !!c.transport.isConnected();
    } catch (e1) {}
    // Fallback to core.state.ptyWs
    try {
      const st = getCoreState(c);
      const ws = st ? st.ptyWs : null;
      return !!(ws && ws.readyState === WebSocket.OPEN);
    } catch (e2) {}
    return false;
  }

  function hideAllMenus(ctx) {
    const c = resolveCtx(ctx);
    try {
      const uiCtrl = getUiCtrl(c);
      if (uiCtrl && typeof uiCtrl.hideAllGroupedMenus === 'function') return uiCtrl.hideAllGroupedMenus();
    } catch (e0) {}
    try {
      ['terminal-overflow-menu', 'terminal-view-menu', 'terminal-buffer-menu'].forEach((id) => {
        const el = byId(c, id);
        if (el) el.classList.add('hidden');
      });
    } catch (e1) {}
  }

  function clearSearchSilent(ctx) {
    try {
      const s = window.XKeen && window.XKeen.terminal ? window.XKeen.terminal.search : null;
      if (s && typeof s.clear === 'function') s.clear({ silent: true });
    } catch (e) {}
  }

  function setFullscreenOff() {
    try {
      const C = window.XKeen && window.XKeen.terminal ? window.XKeen.terminal.chrome : null;
      if (C && typeof C.setFullscreen === 'function') C.setFullscreen(false);
    } catch (e) {}
  }

  function chromeOnOpen() {
    try {
      const C = window.XKeen && window.XKeen.terminal ? window.XKeen.terminal.chrome : null;
      if (C && typeof C.onOpen === 'function') C.onOpen();
    } catch (e) {}
  }

  function resetConfirmPrompt(ctx) {
    const c = resolveCtx(ctx);
    try {
      if (c && c.confirmPrompt && typeof c.confirmPrompt.hide === 'function') c.confirmPrompt.hide({ clear: true });
    } catch (e) {}
  }

  function showInputs(ctx, on) {
    const c = resolveCtx(ctx);
    const cmdEl = byId(c, 'terminal-command');
    if (cmdEl) {
      try { cmdEl.style.display = on ? '' : 'none'; } catch (e) {}
    }
    const row = inputRowEl();
    if (row) {
      try { row.style.display = on ? '' : 'none'; } catch (e2) {}
    }
  }

  function syncSharedState(ctx, next) {
    const c = resolveCtx(ctx);
    const st = getCoreState(c);
    if (!st) return;
    try {
      if (next && typeof next === 'object') {
        if (next.mode != null) st.currentCommandMode = next.mode;
        if ('flag' in next) st.currentCommandFlag = next.flag;
        if ('label' in next) st.currentCommandLabel = next.label;
      }
    } catch (e) {}
  }

  function createController(ctx) {
    const state = {
      currentCommandMode: 'shell', // 'shell' | 'xkeen' | 'pty'
      currentCommandFlag: null,
      currentCommandLabel: null,
      ptyPrevConvertEol: null,
    };

    function getMode() {
      const c = resolveCtx(ctx);
      try {
        const S = getSession(c);
        if (S && typeof S.getMode === 'function') return S.getMode() || state.currentCommandMode || 'shell';
      } catch (e0) {}
      try {
        const st = getCoreState(c);
        if (st && st.mode) return st.mode;
      } catch (e1) {}
      return state.currentCommandMode || 'shell';
    }

    function setMode(mode, meta) {
      const c = resolveCtx(ctx);
      const m = String(mode || 'shell');
      const info = meta || {};

      state.currentCommandMode = m;

      // xkeen flag parsing (for lite_runner + quick commands)
      if (m === 'xkeen') {
        const initialCommand = String(info.initialCommand || '');
        const mm = initialCommand.match(/^xkeen\s+(.+)$/);
        state.currentCommandFlag = mm ? String(mm[1] || '').trim() : null;
        state.currentCommandLabel = initialCommand || (state.currentCommandFlag ? ('xkeen ' + state.currentCommandFlag) : 'xkeen');
      } else {
        state.currentCommandFlag = null;
        state.currentCommandLabel = null;
      }

      // Notify registry about mode change (Stage D in terminal.js)
      try {
        const reg = getRegistry(c);
        if (reg && typeof reg.onModeChange === 'function') reg.onModeChange(m);
      } catch (e2) {}

      // Sync to session controller (preferred) or legacy core
      try {
        const S = getSession(c);
        if (S && typeof S.setMode === 'function') S.setMode(m);
        else {
          const core = (c && c.core) ? c.core : (window.XKeen && window.XKeen.terminal ? window.XKeen.terminal._core : null);
          if (core && typeof core.setMode === 'function') core.setMode(m);
        }
      } catch (e3) {}

      // Sync shared state used by lite_runner
      syncSharedState(c, { mode: m, flag: state.currentCommandFlag, label: state.currentCommandLabel });
    }

    function applyModeUi() {
      const c = resolveCtx(ctx);
      const mode = getMode();
      const isPty = (mode === 'pty');

      // Serialize addon: only available when loaded.
      let hasSerialize = false;
      try {
        const xf = getXtermFacade(c);
        if (xf && typeof xf.getRefs === 'function') {
          const r = xf.getRefs() || {};
          hasSerialize = !!r.serializeAddon;
        }
      } catch (e0) {}

      const show = (id, on) => {
        const el = byId(c, id);
        if (!el) return;
        try { el.style.display = on ? '' : 'none'; } catch (e) {}
      };

      // PTY-only chrome
      show('terminal-conn-lamp', isPty);
      show('terminal-uptime', isPty);
      show('terminal-search-row', isPty);

      // Terminal overflow menu (top-right "⋯") is PTY-only.
      // Lite terminal is intended for weak devices and should expose only minimal controls.
      show('terminal-btn-overflow', isPty);
      show('terminal-overflow-menu', isPty);
      show('terminal-btn-reconnect', isPty);
      // Stop retry visibility is driven by retry state (ui_controller keeps it in sync)
      try {
        const uiCtrl = getUiCtrl(c);
        if (uiCtrl && typeof uiCtrl.updateRetryUi === 'function') uiCtrl.updateRetryUi();
      } catch (e1) {}
      show('terminal-btn-new-session', isPty);
      show('terminal-btn-ctrlc', isPty);
      show('terminal-btn-ctrld', isPty);
      show('terminal-btn-detach', isPty);
      show('terminal-btn-kill', isPty);
      show('terminal-btn-retry-now', isPty);
      show('terminal-btn-ssh', isPty);
      show('terminal-btn-xraylogs', isPty);
      show('terminal-xraylogs-menu', isPty);

      // Requested: in lite terminal remove Follow/bottom/minimize/fullscreen.
      show('terminal-btn-minimize', isPty);
      show('terminal-btn-fullscreen', isPty);
      show('terminal-btn-follow', isPty);
      show('terminal-btn-bottom', isPty);

      // History button is PTY-only (as per Stage 6 requirements)
      show('terminal-history-btn', isPty);

      // Cursor blink makes sense only for interactive PTY.
      show('terminal-btn-cursorblink', isPty);

      // Footer groups: buffer/commands are PTY-only.
      show('terminal-buffer-group', isPty);
      show('terminal-commands-group', isPty);

      // Serialize exports
      show('terminal-btn-download-html', isPty && hasSerialize);
      show('terminal-btn-snapshot-vt', isPty && hasSerialize);

      // ANSI filter / log highlight are PTY-only (lite terminal: keep only font +/- in "Вид").
      show('terminal-btn-ansi', isPty);
      show('terminal-btn-loghl', isPty);

      // Elements marked as PTY-only
      try {
        document.querySelectorAll('#terminal-overlay .terminal-pty-only').forEach((el) => {
          try { el.style.display = isPty ? '' : 'none'; } catch (e) {}
        });
      } catch (e2) {}

      // When leaving PTY: clear search UI state.
      if (!isPty) {
        try { clearSearchSilent(c); } catch (e3) {}
      }
    }

    function ensureXterm() {
      const c = resolveCtx(ctx);
      try {
        const xf = getXtermFacade(c);
        if (xf && typeof xf.ensureTerminal === 'function') {
          return xf.ensureTerminal({});
        }
      } catch (e) {}
      return { term: getTerm(c), created: false };
    }

    function restoreMinimizedPtyIfPossible(requestedMode) {
      const c = resolveCtx(ctx);
      if (String(requestedMode || '') !== 'pty') return false;

      try {
        const overlay = byId(c, 'terminal-overlay');
        const term = getTerm(c);
        const wasHidden = !!(overlay && overlay.style && overlay.style.display === 'none');
        if (!wasHidden) return false;

        const isAlreadyPty = (getMode() === 'pty') || (state.currentCommandMode === 'pty');
        if (!isAlreadyPty) return false;
        if (!isPtyWsOpen(c)) return false;
        if (!term) return false;

        // show overlay without reconnecting
        try {
          const oc = getOverlayCtrl(c);
          if (oc && typeof oc.show === 'function') oc.show({ display: 'flex' });
          else if (overlay) overlay.style.display = 'flex';
        } catch (e0) {}

        try { applyModeUi(); } catch (e1) {}
        try { chromeOnOpen(); } catch (e2) {}
        try {
          const uiCtrl = getUiCtrl(c);
          if (uiCtrl && typeof uiCtrl.onOverlayShow === 'function') uiCtrl.onOverlayShow();
        } catch (e3) {}

        // Re-apply output prefs and follow scroll if needed.
        try {
          if (c && c.outputPrefs && typeof c.outputPrefs.applyUi === 'function') c.outputPrefs.applyUi();
        } catch (e4) {}
        try {
          const prefs = (c && c.outputPrefs && typeof c.outputPrefs.getPrefs === 'function') ? c.outputPrefs.getPrefs() : null;
          if (prefs && prefs.follow) {
            const t = getTerm(c);
            try { if (t && typeof t.scrollToBottom === 'function') t.scrollToBottom(); } catch (e5) {}
          }
        } catch (e6) {}

        termFocus(term);
        return true;
      } catch (e) {}
      return false;
    }

    function open(initialCommand, mode) {
      const c = resolveCtx(ctx);
      const m = String(mode || 'shell');
      const cmd = String(initialCommand || '');

      // Restore minimized PTY window without reconnecting.
      if (restoreMinimizedPtyIfPossible(m)) return;

      // Update mode & shared state
      setMode(m, { initialCommand: cmd });

      // Update command UI
      try {
        const cmdEl = byId(c, 'terminal-command');
        if (cmdEl) {
          cmdEl.value = cmd;
          try { cmdEl.focus(); cmdEl.select(); } catch (e0) {}
        }
        const inputEl = byId(c, 'terminal-input');
        if (inputEl) inputEl.value = '';
      } catch (e1) {}

      // Ensure confirm prompt is hidden initially
      try { resetConfirmPrompt(c); } catch (e2) {}

      // Ensure xterm exists if available
      const ensured = ensureXterm();
      const term = ensured ? (ensured.term || null) : null;

      if (m === 'pty') {
        // Hide lite inputs in PTY
        showInputs(c, false);

        if (!term) {
          // PTY requires xterm
          const out = byId(c, 'terminal-output') || byId(c, 'terminal-xterm');
          if (out) {
            try { out.textContent = 'xterm.js недоступен — PTY режим невозможен.'; } catch (e3) {}
          }
        } else {
          // Raw mode: convertEol must be off for escape seq (store previous)
          try {
            if (state.ptyPrevConvertEol === null && typeof term.getOption === 'function') {
              state.ptyPrevConvertEol = term.getOption('convertEol');
            }
            if (typeof term.setOption === 'function') term.setOption('convertEol', false);
          } catch (e4) {}

          // Unblock retry if any
          try {
            const S = getSession(c);
            if (S && typeof S.resetRetry === 'function') S.resetRetry({ unblock: true });
          } catch (e5) {}

          // Connect (or reconnect) PTY via session controller
          try {
            const S = getSession(c);
            if (S && typeof S.switchMode === 'function') {
              S.switchMode('pty', { term: term, preserveScreen: false, autoConnect: true });
            } else if (S && typeof S.connect === 'function') {
              S.connect({ mode: 'pty', term: term, preserveScreen: false });
            } else {
              const P = window.XKeen && window.XKeen.terminal ? window.XKeen.terminal.pty : null;
              if (P && typeof P.connect === 'function') P.connect(term, { preserveScreen: false });
            }
          } catch (e6) {
            try {
              const P2 = window.XKeen && window.XKeen.terminal ? window.XKeen.terminal.pty : null;
              if (P2 && typeof P2.connect === 'function') P2.connect(term, { preserveScreen: false });
            } catch (e7) {}
          }
        }
      } else {
        // Lite (shell/xkeen): show inputs
        showInputs(c, true);
        try {
          const S = getSession(c);
          if (S && typeof S.switchMode === 'function') S.switchMode(m, { autoConnect: false });
        } catch (e8) {}
      }

      // Apply UI toggles for the mode
      try { applyModeUi(); } catch (e9) {}

      // Show overlay
      try {
        const oc = getOverlayCtrl(c);
        if (oc && typeof oc.show === 'function') oc.show({ display: 'flex' });
        else {
          const overlay = byId(c, 'terminal-overlay');
          if (overlay) overlay.style.display = 'flex';
        }
      } catch (e10) {}

      // Restore terminal window geometry (chrome)
      try { chromeOnOpen(); } catch (e11) {}

      // Registry: onOpen + attachTerm (when present)
      try {
        const reg = getRegistry(c);
        if (reg) {
          if (typeof reg.onOpen === 'function') reg.onOpen();
          if (term && typeof reg.attachTerm === 'function') reg.attachTerm(term);
        }
      } catch (e12) {}

      // Hint: show the initial command in the terminal output area
      try {
        if (term && cmd) termWriteln(term, '$ ' + cmd);
      } catch (e13) {}

      // Focus terminal if PTY
      if (m === 'pty') termFocus(term);
    }

    function close() {
      const c = resolveCtx(ctx);
      const term = getTerm(c);

      // Hide overlay
      try {
        const oc = getOverlayCtrl(c);
        if (oc && typeof oc.hide === 'function') oc.hide();
        else {
          const overlay = byId(c, 'terminal-overlay');
          if (overlay) overlay.style.display = 'none';
        }
      } catch (e0) {}

      // Registry: onClose + detachTerm
      try {
        const reg = getRegistry(c);
        if (reg) {
          if (typeof reg.onClose === 'function') reg.onClose();
          if (term && typeof reg.detachTerm === 'function') reg.detachTerm(term);
        }
      } catch (e1) {}

      // Clear search & exit fullscreen
      try { clearSearchSilent(c); } catch (e2) {}
      try { setFullscreenOff(); } catch (e3) {}

      // Stop retry and disconnect (sendClose=true)
      try {
        const S = getSession(c);
        if (S && typeof S.stopRetry === 'function') S.stopRetry({ silent: true });
      } catch (e4) {}
      try {
        const S = getSession(c);
        if (S && typeof S.disconnect === 'function') S.disconnect({ sendClose: true, reason: 'close' });
        else {
          const P = window.XKeen && window.XKeen.terminal ? window.XKeen.terminal.pty : null;
          if (P && typeof P.disconnect === 'function') P.disconnect({ sendClose: true });
        }
      } catch (e5) {}

      // Restore xterm option (convertEol) for lite mode
      try {
        if (term && state.ptyPrevConvertEol !== null && typeof term.setOption === 'function') {
          term.setOption('convertEol', state.ptyPrevConvertEol);
        }
      } catch (e6) {}
      state.ptyPrevConvertEol = null;

      // Restore lite inputs visibility
      showInputs(c, true);
      resetConfirmPrompt(c);

      // Reset mode state to shell
      state.currentCommandFlag = null;
      state.currentCommandLabel = null;
      state.currentCommandMode = 'shell';
      try { setMode('shell', { initialCommand: '' }); } catch (e7) {}
      try { applyModeUi(); } catch (e8) {}
    }

    function detach() {
      const c = resolveCtx(ctx);
      const term = getTerm(c);

      // Close overlay, but keep server session alive (sendClose=false)
      try {
        const oc = getOverlayCtrl(c);
        if (oc && typeof oc.hide === 'function') oc.hide();
        else {
          const overlay = byId(c, 'terminal-overlay');
          if (overlay) overlay.style.display = 'none';
        }
      } catch (e0) {}

      try { hideAllMenus(c); } catch (e1) {}
      try { clearSearchSilent(c); } catch (e2) {}
      try { setFullscreenOff(); } catch (e3) {}

      // Stop retry
      try {
        const S = getSession(c);
        if (S && typeof S.stopRetry === 'function') S.stopRetry({ silent: true });
      } catch (e4) {}

      // Disconnect WS without sending {type:"close"}
      try {
        const S = getSession(c);
        if (S && typeof S.disconnect === 'function') S.disconnect({ sendClose: false, reason: 'detach' });
        else {
          const P = window.XKeen && window.XKeen.terminal ? window.XKeen.terminal.pty : null;
          if (P && typeof P.disconnect === 'function') P.disconnect({ sendClose: false });
        }
      } catch (e5) {}

      // Restore xterm option
      try {
        if (term && state.ptyPrevConvertEol !== null && typeof term.setOption === 'function') {
          term.setOption('convertEol', state.ptyPrevConvertEol);
        }
      } catch (e6) {}
      state.ptyPrevConvertEol = null;

      showInputs(c, true);
      resetConfirmPrompt(c);

      // Reset mode state to shell
      state.currentCommandFlag = null;
      state.currentCommandLabel = null;
      state.currentCommandMode = 'shell';
      try { setMode('shell', { initialCommand: '' }); } catch (e7) {}
      try { applyModeUi(); } catch (e8) {}
    }

    function killSession() {
      const c = resolveCtx(ctx);
      if (getMode() !== 'pty') return;
      try { hideAllMenus(c); } catch (e0) {}
      try {
        const S = getSession(c);
        if (S && typeof S.stopRetry === 'function') S.stopRetry({ silent: true });
      } catch (e1) {}

      const term = getTerm(c);
      try { termWriteln(term, '\r\n[PTY] Killing session...'); } catch (e2) {}

      try {
        const S = getSession(c);
        if (S && typeof S.disconnect === 'function') S.disconnect({ sendClose: true, clearSession: true, reason: 'killSession' });
        else {
          const P = window.XKeen && window.XKeen.terminal ? window.XKeen.terminal.pty : null;
          if (P && typeof P.disconnect === 'function') P.disconnect({ sendClose: true, clearSession: true });
        }
      } catch (e3) {}
    }

    function reconnect() {
      const c = resolveCtx(ctx);
      if (getMode() !== 'pty') {
        open('', 'pty');
        return;
      }
      const term = getTerm(c);
      if (!term) return;

      try { termWriteln(term, '\r\n[PTY] Reconnect...'); } catch (e0) {}

      try {
        const S = getSession(c);
        if (S && typeof S.reconnect === 'function') {
          S.reconnect({ term: term });
          return;
        }
      } catch (e1) {}

      // Fallback (legacy pty.js)
      try {
        const P = window.XKeen && window.XKeen.terminal ? window.XKeen.terminal.pty : null;
        if (P && typeof P.connect === 'function') P.connect(term, { preserveScreen: true });
      } catch (e2) {}
    }

    function newSession() {
      // Open a new browser tab and auto-open PTY terminal there.
      try {
        const url = new URL(window.location.href);
        url.searchParams.set('terminal', 'pty');
        window.open(url.toString(), '_blank');
        return;
      } catch (e0) {}

      // Fallback: same tab (popup blocked). Ensure we start a NEW PTY session here.
      try {
        const S = getSession(resolveCtx(ctx));
        if (S && typeof S.disconnect === 'function') S.disconnect({ sendClose: true, clearSession: true, reason: 'newSession' });
        else {
          const P = window.XKeen && window.XKeen.terminal ? window.XKeen.terminal.pty : null;
          if (P && typeof P.disconnect === 'function') P.disconnect({ sendClose: true, clearSession: true });
        }
      } catch (e1) {}

      open('', 'pty');
    }

    function sendRaw(data) {
      const c = resolveCtx(ctx);
      const s = String(data == null ? '' : data);
      try {
        const P = window.XKeen && window.XKeen.terminal ? window.XKeen.terminal.pty : null;
        if (P && typeof P.sendRaw === 'function') {
          P.sendRaw(s);
          return true;
        }
      } catch (e0) {}

      // Prefer unified transport if available
      try {
        if (c && c.transport && typeof c.transport.send === 'function') return !!c.transport.send(s, { prefer: 'pty' });
      } catch (e1) {}
      return false;
    }

    function sendCtrlC() {
      try { hideAllMenus(resolveCtx(ctx)); } catch (e) {}
      sendRaw('\x03');
      termFocus(getTerm(resolveCtx(ctx)));
    }

    function sendCtrlD() {
      try { hideAllMenus(resolveCtx(ctx)); } catch (e) {}
      sendRaw('\x04');
      termFocus(getTerm(resolveCtx(ctx)));
    }

    function sendSignal(name) {
      const c = resolveCtx(ctx);
      hideAllMenus(c);
      const sig = String(name || '').trim();
      if (!sig) return;
      try {
        const P = window.XKeen && window.XKeen.terminal ? window.XKeen.terminal.pty : null;
        if (P && typeof P.sendSignal === 'function') {
          P.sendSignal(sig);
          termFocus(getTerm(c));
          return;
        }
      } catch (e0) {}

      safeToast(c, 'PTY не подключён (pty.js missing)', 'info');
    }

    const api = {
      // Lifecycle-ish UI entry points
      open,
      close,
      detach,
      killSession,
      reconnect,
      newSession,

      // Mode
      getMode,
      setMode,
      applyModeUi,

      // Signals
      sendRaw,
      sendCtrlC,
      sendCtrlD,
      sendSignal,

      // Misc
      isPtyActive: () => (getMode() === 'pty') && !!getTerm(resolveCtx(ctx)),
      getTerm: () => getTerm(resolveCtx(ctx)),
    };

    // Expose controller on ctx for UI delegation
    try { if (ctx) ctx.terminalCtrl = api; } catch (e) {}
    try { window.XKeen.terminal.terminalCtrl = api; } catch (e2) {}

    return api;
  }

  function createModule(ctx) {
    // Ensure controller exists and is attached to ctx.
    const api = createController(ctx);

    return {
      id: 'terminal_controller',
      // Should run early so other modules can use ctx.terminalCtrl.
      priority: 20,
      init: () => {
        try { if (ctx) ctx.terminalCtrl = api; } catch (e) {}
      },
      // No-op hooks (controller itself triggers registry lifecycle at the right time).
      onOpen: () => {},
      onClose: () => {},
      onModeChange: () => {},
      attachTerm: () => {},
      detachTerm: () => {},
    };
  }

  // Export
  window.XKeen.terminal.terminal_controller = {
    createController,
    createModule,
  };
})();

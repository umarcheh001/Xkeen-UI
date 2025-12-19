// Terminal lite runner: HTTP command execution + confirm prompt detection + ANSI filter/highlight (for lite output)
(function () {
  'use strict';

  window.XKeen = window.XKeen || {};
  window.XKeen.terminal = window.XKeen.terminal || {};

  const core = window.XKeen.terminal._core || null;
  const caps = window.XKeen.terminal.capabilities || null;
  const state = (core && core.state) ? core.state : (window.XKeen.terminal.__lite_state = window.XKeen.terminal.__lite_state || {});

  // --------------------
  // ANSI helpers (lite output only)
  // --------------------
  function ansiToHtml(text) {
    // Minimal conversion; if global converter exists, prefer it.
    try {
      if (window.XKeen && XKeen.util && XKeen.util.ansiToHtml) {
        return XKeen.util.ansiToHtml(String(text || ''));
      }
    } catch (e) {}
    const s = String(text || '');
    // Very basic: escape HTML, keep newlines (caller handles <br>)
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // Basic ANSI stripper (CSI + OSC). Good enough for log highlighting.
  function stripAnsi(text) {
    if (!text) return '';
    const s = String(text);
    // OSC (ESC ] ... BEL or ESC \\)
    const noOsc = s.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '');
    // CSI (ESC [ ... final)
    return noOsc.replace(/\x1b\[[0-9;?]*[@-~]/g, '');
  }

  function highlightWarnErr(text) {
    if (!text) return '';
    const s = String(text);

    // Do not inject ANSI if text is already HTML
    // (this highlighter is intended for xterm.write path).
    const RESET = '\x1b[0m';
    const RED = '\x1b[31;1m';
    const YEL = '\x1b[33;1m';

    // Word-ish boundaries to avoid highlighting parts of other words
    return s
      .replace(/\b(ERROR|ERR|FATAL|FAIL|FAILED)\b/gi, (m) => (RED + m + RESET))
      .replace(/\b(WARN|WARNING)\b/gi, (m) => (YEL + m + RESET));
  }

  // --------------------
  // Confirm prompt detection (lite mode)
  // --------------------
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

  function confirmIsVisible() {
    const inputEl = document.getElementById('terminal-input');
    if (!inputEl) return false;
    if (inputEl.style && inputEl.style.display === 'none') return false;
    if (inputEl.offsetParent === null) return false;
    return true;
  }

  function setConfirmVisible(visible, opts = {}) {
    const inputEl = document.getElementById('terminal-input');
    if (!inputEl) return;

    const row = inputEl.closest ? inputEl.closest('.terminal-input-row') : null;

    if (visible) {
      inputEl.style.display = '';
      if (row) row.classList.remove('confirm-hidden');
      if (opts && opts.focus) {
        try { inputEl.focus(); } catch (e) {}
      }
    } else {
      inputEl.style.display = 'none';
      if (row) row.classList.add('confirm-hidden');
      if (!opts || opts.clear !== false) inputEl.value = '';
    }
  }

  function maybeRevealConfirm(text, opts = {}) {
    try {
      if (core && typeof core.getMode === 'function' && core.getMode() === 'pty') return false;
    } catch (e) {}
    if (confirmIsVisible()) return false;
    if (!detectConfirmPrompt(text)) return false;
    setConfirmVisible(true, { focus: !!opts.focus });
    return true;
  }

  // --------------------
  // HTTP runner glue (delegates to XKeen.util.commandJob)
  // --------------------
  async function runShellCommand(cmd, stdinValue, options = {}) {
    try {
      const CJ = (window.XKeen && XKeen.util && XKeen.util.commandJob) ? XKeen.util.commandJob : null;
      if (CJ && typeof CJ.runShellCommand === 'function') {
        const opts = Object.assign({}, (options || {}), { hasWs: (caps && typeof caps.hasWs === 'function') ? caps.hasWs() : false });
        return await CJ.runShellCommand(cmd, stdinValue, opts);
      }
    } catch (e) {}
    return { res: { ok: false, status: 0 }, data: { ok: false, error: 'command_job util is not available' } };
  }

  async function runXkeenFlag(flag, stdinValue, options = {}) {
    try {
      const CJ = (window.XKeen && XKeen.util && XKeen.util.commandJob) ? XKeen.util.commandJob : null;
      if (CJ && typeof CJ.runXkeenFlag === 'function') {
        const opts = Object.assign({}, (options || {}), { hasWs: (caps && typeof caps.hasWs === 'function') ? caps.hasWs() : false });
        return await CJ.runXkeenFlag(flag, stdinValue, opts);
      }
    } catch (e) {}
    return { res: { ok: false, status: 0 }, data: { ok: false, error: 'command_job util is not available' } };
  }

  // --------------------
  // Lite runner main: read UI, run command, stream chunks, render output
  // --------------------
  function getUseXterm() {
    // Prefer xterm if present
    try { return !!(state.xterm && typeof state.xterm.write === 'function'); } catch (e) {}
    return false;
  }

  function xtermWriteln(term, text) {
    if (!term) return;
    const s = String(text == null ? '' : text);
    try { if (typeof term.writeln === 'function') return term.writeln(s); } catch (e) {}
    try { if (typeof term.write === 'function') return term.write(s + '\r\n'); } catch (e) {}
  }

  async function sendTerminalInput() {
    // In PTY mode, input is handled by xterm.onData() in PTY transport.
    try { if (core && typeof core.getMode === 'function' && core.getMode() === 'pty') return; } catch (e) {}

    const cmdEl = document.getElementById('terminal-command');
    const inputEl = document.getElementById('terminal-input');
    const outputEl = document.getElementById('terminal-output');

    const cmdText = cmdEl ? String(cmdEl.value || '').trim() : '';
    const stdinValue = inputEl ? String(inputEl.value || '') : '';

    const term = state.xterm || null;
    const useXterm = getUseXterm();

    if (!cmdText) {
      if (useXterm) {
        xtermWriteln(term, '[Ошибка] Введите команду.');
      } else if (outputEl) {
        outputEl.textContent = 'Ошибка: введите команду.';
      }
      return;
    }

    // Hide confirm input once used (unless caller wants it kept)
    try { setConfirmVisible(false, { clear: false }); } catch (e) {}

    // Prepare output
    if (useXterm) {
      xtermWriteln(term, '');
      xtermWriteln(term, '$ ' + cmdText);
    } else if (outputEl) {
      outputEl.textContent = '';
    }

    const onChunk = (chunk) => {
      if (!chunk) return;
      let out = String(chunk);
      // Optional post-processing for lite output:
      // - strip ANSI for HTML fallback
      // - highlight WARN/ERR for xterm (only if user enabled later; default off)
      try {
        if (state.liteStripAnsi) out = stripAnsi(out);
      } catch (e) {}
      try {
        if (state.liteHighlightWarnErr && useXterm) out = highlightWarnErr(out);
      } catch (e) {}

      if (useXterm) {
        try { term.write(out); } catch (e) {}
      } else if (outputEl) {
        try {
          const html = ansiToHtml(out).replace(/\n/g, '<br>');
          outputEl.innerHTML += html;
          outputEl.scrollTop = outputEl.scrollHeight;
        } catch (e) {}
      }

      // detect confirm prompts and reveal input if needed
      try { maybeRevealConfirm(out, { focus: true }); } catch (e) {}
    };

    try {
      let runner;
      // Allow terminal.js to set a flag-mode in shared state (optional)
      if (state.currentCommandMode === 'xkeen' && state.currentCommandFlag) {
        runner = runXkeenFlag(state.currentCommandFlag, stdinValue, { onChunk });
      } else {
        runner = runShellCommand(cmdText, stdinValue, { onChunk });
      }

      const { res, data } = await runner;

      if (!res.ok || !data || !data.ok) {
        const msg = (data && data.error) ? data.error : ('HTTP ' + (res && res.status ? res.status : 0));
        if (useXterm) {
          xtermWriteln(term, '');
          xtermWriteln(term, '[Ошибка] ' + msg);
        } else if (outputEl) {
          outputEl.textContent = 'Ошибка: ' + msg;
        }
        return;
      }

      // Final payload text (if any)
      const text = (data && (data.stdout || data.output || data.text)) ? String(data.stdout || data.output || data.text) : '';
      if (text) onChunk(text);

      // Exit code hint (nonzero)
      const exitCode = (data && data.exit_code != null) ? (parseInt(data.exit_code, 10) || 0) : 0;
      if (useXterm) {
        xtermWriteln(term, '');
        xtermWriteln(term, '[exit_code=' + exitCode + ']');
      }
    } catch (e) {
      const msg = (e && e.message) ? e.message : String(e);
      if (useXterm) {
        xtermWriteln(term, '');
        xtermWriteln(term, '[Ошибка] ' + msg);
      } else if (outputEl) {
        outputEl.textContent = 'Ошибка: ' + msg;
      }
    }
  }

  // Export
  window.XKeen.terminal.lite_runner = {
    sendTerminalInput,
    detectConfirmPrompt,
    maybeRevealConfirm,

    // output helpers
    ansiToHtml,
    stripAnsi,
    highlightWarnErr,

    // confirm UI helpers (kept here because they are lite-only)
    confirmIsVisible,
    setConfirmVisible,
  };
})();

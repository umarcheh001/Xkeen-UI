import { getFileManagerNamespace } from '../file_manager_namespace.js';

(() => {
  'use strict';

  // File Manager: Terminal integration ("Terminal here")
  // Export: FM.terminal.openHere(side, ctx)

  window.XKeen = window.XKeen || {};
  const XKeen = window.XKeen;
  const FM = getFileManagerNamespace();
  const C = FM.common || {};

  FM.terminal = FM.terminal || {};
  const T = FM.terminal;

  function getLazyRuntimeApi() {
    try {
      if (C && typeof C.getLazyRuntime === 'function') return C.getLazyRuntime();
    } catch (e) {
      return null;
    }
    return null;
  }

  function getS() {
    try { return (FM.state && FM.state.S) ? FM.state.S : {}; } catch (e) { return {}; }
  }

  function _toast(msg, kind) {
    try { if (C && typeof C.toast === 'function') return C.toast(msg, kind); } catch (e) {}
    return undefined;
  }

  function _shSingleQuote(s) {
    // Safe single-quoted string for POSIX shells:  abc'd  ->  'abc'\''d'
    const x = String(s == null ? '' : s).replace(/[\r\n]+/g, '');
    return "'" + x.replace(/'/g, "'\\''") + "'";
  }

  function _terminalApi() {
    try {
      const term = (C && typeof C.getTerminal === 'function') ? C.getTerminal() : null;
      const api = term && term.api ? term.api : null;
      if (!api) return null;
      if (typeof api.open !== 'function') return null;
      if (typeof api.send !== 'function') return null;
      return api;
    } catch (e) {
      return null;
    }
  }

  async function _terminalChooseMode() {
    // Prefer interactive PTY only when backend explicitly allows PTY.
    try {
      const term = (C && typeof C.getTerminal === 'function') ? C.getTerminal() : null;
      const caps = term && term.capabilities ? term.capabilities : null;
      if (caps && typeof caps.initCapabilities === 'function') {
        await Promise.resolve(caps.initCapabilities());
      }
      if (caps && typeof caps.hasPty === 'function') {
        return caps.hasPty() ? 'pty' : 'shell';
      }
      if (caps && typeof caps.hasWs === 'function') {
        return caps.hasWs() ? 'pty' : 'shell';
      }
    } catch (e) {}
    return 'shell';
  }

  function _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
  }

  async function _waitFor(fn, timeoutMs, stepMs) {
    const t0 = Date.now();
    const timeout = Math.max(0, Number(timeoutMs) || 0);
    const step = Math.max(25, Number(stepMs) || 100);
    while (Date.now() - t0 <= timeout) {
      try { if (fn && fn()) return true; } catch (e) {}
      await _sleep(step);
    }
    return false;
  }

  function _joinLocal(cwd, name) {
    try {
      if (FM.common && typeof FM.common.joinLocal === 'function') {
        return FM.common.joinLocal(cwd, name);
      }
    } catch (e) {}
    const c = String(cwd || '');
    const n = String(name || '');
    if (!c) return n;
    if (!n) return c;
    const sep = c.endsWith('/') ? '' : '/';
    return c + sep + n;
  }

  async function openHere(side, ctx) {
    const S = getS();
    const s = String(side || S.activeSide || 'left');
    const p = (S.panels && S.panels[s]) ? S.panels[s] : null;
    if (!p) return false;

    // Current behavior: only local panel is supported.
    if (String(p.target || 'local') !== 'local') {
      _toast('Terminal here доступен только для локальной панели', 'info');
      return false;
    }

    let api = _terminalApi();
    if (!api) {
      // Terminal is lazy-loaded. If stubs are available, try to load it on-demand.
      try {
        const lazyRuntime = getLazyRuntimeApi();
        const lazy = (lazyRuntime && typeof lazyRuntime.ensureTerminalReady === 'function')
          ? lazyRuntime.ensureTerminalReady
          : null;
        if (lazy) {
          await Promise.resolve(lazy());
          await _waitFor(() => !!_terminalApi(), 3000, 100);
          api = _terminalApi();
        }
      } catch (e0) {}
    }

    if (!api) {
      _toast('Терминал недоступен (api не найден)', 'error');
      return false;
    }

    let cwd = String(p.cwd || '/') || '/';
    try {
      const o = ctx || {};
      const name = String(o.name || '').trim();
      const isDir = !!o.isDir;
      if (name && isDir) cwd = _joinLocal(cwd, name);
    } catch (e) {}

    // Normalize local path
    cwd = String(cwd || '/');
    if (!cwd.startsWith('/')) cwd = '/' + cwd;
    cwd = cwd.replace(/\/+/g, '/');
    if (cwd.length > 1) cwd = cwd.replace(/\/+$/, '');

    const q = _shSingleQuote(cwd);
    const mode = await _terminalChooseMode();

    try {
      if (mode === 'shell') {
        // Lite terminal can't keep state; prefill a safe prefix for the user.
        await Promise.resolve(api.open({ mode: 'shell', cmd: `cd -- ${q} && ` }));
        _toast('Lite терминал: добавляй команды после "&&"', 'info');
        return true;
      }

      // PTY mode: open + wait for WS + cd/pwd
      await Promise.resolve(api.open({ mode: 'pty', cmd: '' }));

      try {
        if (typeof api.isConnected === 'function') {
          // Give the session a moment to connect.
          await _waitFor(() => api.isConnected(), 2500, 100);
        }
      } catch (e3) {}

      const sendRes = await Promise.resolve(api.send(`cd -- ${q} && pwd`, { source: 'file_manager_terminal_here' }));
      const delivered = !!(
        sendRes &&
        ((sendRes.handled === true) || (sendRes.result && sendRes.result.ok === true))
      );
      if (!delivered) {
        _toast('Терминал: PTY ещё не готов принять команду', 'error');
        return false;
      }
      return true;
    } catch (e4) {
      _toast('Терминал: не удалось открыть', 'error');
      return false;
    }
  }

  T.openHere = openHere;
})();

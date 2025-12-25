// Terminal core: API wrapper (single place for fetch/command-job calls)
(function () {
  'use strict';

  window.XKeen = window.XKeen || {};
  window.XKeen.terminal = window.XKeen.terminal || {};
  window.XKeen.terminal.core = window.XKeen.terminal.core || {};

  function createApi(caps) {
    async function apiFetch(url, options) {
      const opts = Object.assign({ credentials: 'same-origin' }, (options || {}));
      const res = await fetch(url, opts);
      let data = null;
      const ctype = res.headers ? (res.headers.get('content-type') || '') : '';
      if (ctype.indexOf('application/json') !== -1) {
        try { data = await res.json(); } catch (e) { data = null; }
      } else {
        try { data = await res.text(); } catch (e) { data = null; }
      }
      if (!res.ok) {
        const err = new Error('HTTP ' + res.status);
        err.status = res.status;
        err.data = data;
        throw err;
      }
      return { res, data };
    }

    // Prefer the existing util layer if present.
    async function runShellCommand(cmd, stdinValue, options) {
      try {
        const CJ = (window.XKeen && XKeen.util && XKeen.util.commandJob) ? XKeen.util.commandJob : null;
        if (CJ && typeof CJ.runShellCommand === 'function') {
          const opts = Object.assign({}, (options || {}), { hasWs: (caps && typeof caps.hasWs === 'function') ? caps.hasWs() : false });
          return await CJ.runShellCommand(cmd, stdinValue, opts);
        }
      } catch (e) {}
      return { res: { ok: false, status: 0 }, data: { ok: false, error: 'command_job util is not available' } };
    }

    async function runXkeenFlag(flag, stdinValue, options) {
      try {
        const CJ = (window.XKeen && XKeen.util && XKeen.util.commandJob) ? XKeen.util.commandJob : null;
        if (CJ && typeof CJ.runXkeenFlag === 'function') {
          const opts = Object.assign({}, (options || {}), { hasWs: (caps && typeof caps.hasWs === 'function') ? caps.hasWs() : false });
          return await CJ.runXkeenFlag(flag, stdinValue, opts);
        }
      } catch (e) {}
      return { res: { ok: false, status: 0 }, data: { ok: false, error: 'command_job util is not available' } };
    }

    return {
      apiFetch,
      runShellCommand,
      runXkeenFlag,
    };
  }

  window.XKeen.terminal.core.createApi = createApi;
})();

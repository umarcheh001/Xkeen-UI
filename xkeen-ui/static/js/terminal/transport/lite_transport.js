import {
  getTerminalCommandJobApi,
  getTerminalCompatApi,
  getTerminalMode,
  publishTerminalTransportCompatApi,
} from '../runtime.js';

// Transport adapter: Lite (HTTP run-command via util/command_job)
(function () {
  'use strict';

  function createLiteTransport(ctx) {
    const caps = (ctx && ctx.caps) ? ctx.caps : getTerminalCompatApi('capabilities');
    const events = (ctx && ctx.events) ? ctx.events : { on: () => () => {}, off: () => {}, emit: () => {} };

    const onMsgCbs = new Set();
    const onCloseCbs = new Set();
    const onErrCbs = new Set();

    let lastCmd = '';
    let buffered = '';

    function emitRaw(chunk, meta) {
      const payload = Object.assign({
        chunk: String(chunk == null ? '' : chunk),
        source: 'lite',
        ts: Date.now(),
      }, (meta || {}));

      try {
        onMsgCbs.forEach((cb) => {
          try { cb(payload.chunk, payload); } catch (e2) {}
        });
      } catch (e3) {}
    }

    function emitErr(err, meta) {
      const e = err instanceof Error ? err : new Error(String(err == null ? 'error' : err));
      const payload = Object.assign({ error: e, source: 'lite', ts: Date.now() }, (meta || {}));
      try {
        onErrCbs.forEach((cb) => {
          try { cb(e, payload); } catch (e2) {}
        });
      } catch (e3) {}
    }

    function isConnected() {
      return true;
    }

    function connect() {}

    function disconnect() {
      try {
        onCloseCbs.forEach((cb) => {
          try { cb({ source: 'lite', reason: 'disconnect', ts: Date.now() }); } catch (e2) {}
        });
      } catch (e) {}
    }

    function normalizeStdin(stdinValue) {
      const raw = String(stdinValue == null ? '' : stdinValue);
      if (raw === '') return '\n';
      return /\r|\n$/.test(raw) ? raw : (raw + '\n');
    }

    async function runLite(cmd, stdinValue, opts) {
      const CJ = getTerminalCommandJobApi();
      if (!CJ || typeof CJ.runShellCommand !== 'function') {
        emitRaw('\r\n[РћС€РёР±РєР°] command_job util is not available\r\n', { kind: 'error' });
        emitErr('command_job util is not available');
        return false;
      }

      const hasWs = (caps && typeof caps.hasWs === 'function') ? !!caps.hasWs() : true;
      emitRaw('\r\n$ ' + cmd + '\r\n', { kind: 'prompt' });

      try {
        const r = await CJ.runShellCommand(cmd, stdinValue, {
          hasWs: hasWs,
          onChunk: (chunk) => {
            if (typeof chunk === 'string' && chunk !== '') emitRaw(chunk, { kind: 'chunk' });
          },
        });

        const resOk = r && r.res && r.res.ok;
        const data = r && r.data ? r.data : null;

        if (!resOk || (data && data.ok === false)) {
          const msg = (CJ && typeof CJ.describeRunCommandError === 'function')
            ? CJ.describeRunCommandError(data, r && r.res)
            : ((data && data.error) ? String(data.error) : 'HTTP error');
          emitRaw('\r\n[РћС€РёР±РєР°] ' + msg + '\r\n', { kind: 'error' });
          emitErr(msg, { stage: 'create' });
          return false;
        }

        if (data && data.status === 'error') {
          const msg2 = (CJ && typeof CJ.describeRunCommandError === 'function')
            ? CJ.describeRunCommandError(data, r && r.res)
            : (data.error ? String(data.error) : 'command failed');
          emitRaw('\r\n[РћС€РёР±РєР°] ' + msg2 + '\r\n', { kind: 'error' });
          emitErr(msg2, { stage: 'wait', jobId: data.job_id });
          return false;
        }

        if (data && typeof data.exit_code === 'number' && data.exit_code !== 0) {
          emitRaw('\r\n[Exit] code=' + String(data.exit_code) + '\r\n', { kind: 'exit', exit_code: data.exit_code });
        }
        return true;
      } catch (e) {
        const msg3 = (e && e.message) ? e.message : String(e);
        emitRaw('\r\n[РћС€РёР±РєР°] ' + msg3 + '\r\n', { kind: 'error' });
        emitErr(e);
        return false;
      }
    }

    function send(data, opts) {
      const payload = String(data == null ? '' : data);
      const o = opts || {};

      if (getTerminalMode(ctx) === 'pty' && o.prefer !== 'lite' && o.force !== true) return false;

      const shouldRun = /\r|\n$/.test(payload) || o.run === true;
      if (!shouldRun) {
        buffered = payload;
        try { events.emit('term:input:buffer', { text: buffered, source: 'lite', ts: Date.now() }); } catch (e) {}
        return true;
      }

      const cmdText = payload.replace(/[\r\n]+$/g, '').trim();
      if (!cmdText) {
        emitRaw('\r\n[РћС€РёР±РєР°] Р’РІРµРґРёС‚Рµ РєРѕРјР°РЅРґСѓ.\r\n', { kind: 'error' });
        emitErr('empty command');
        return false;
      }
      buffered = '';
      lastCmd = cmdText;

      let stdinValue = undefined;
      if (o && o.stdin) {
        const cmdOverride = (typeof o.cmd === 'string' && o.cmd.trim()) ? o.cmd.trim() : '';
        const cmdToUse = cmdOverride || lastCmd || cmdText;
        lastCmd = cmdToUse;
        stdinValue = normalizeStdin(payload.replace(/[\r\n]+$/g, ''));
        void runLite(cmdToUse, stdinValue, o);
        return true;
      }

      if (typeof o.stdinValue === 'string') stdinValue = normalizeStdin(o.stdinValue);
      void runLite(cmdText, stdinValue, o);
      return true;
    }

    function resize() {}

    function onMessage(cb) {
      if (typeof cb !== 'function') return () => {};
      onMsgCbs.add(cb);
      return () => { try { onMsgCbs.delete(cb); } catch (e) {} };
    }
    function onClose(cb) {
      if (typeof cb !== 'function') return () => {};
      onCloseCbs.add(cb);
      return () => { try { onCloseCbs.delete(cb); } catch (e) {} };
    }
    function onError(cb) {
      if (typeof cb !== 'function') return () => {};
      onErrCbs.add(cb);
      return () => { try { onErrCbs.delete(cb); } catch (e) {} };
    }

    return { kind: 'lite', connect, disconnect, isConnected, send, resize, onMessage, onClose, onError };
  }

  publishTerminalTransportCompatApi('createLiteTransport', createLiteTransport);
})();

// Transport adapter: Lite (HTTP run-command via util/command_job)
//
// Stage 4 contract:
//   connect() / disconnect() / send(data, opts?)
//   onMessage(cb) / onClose(cb) / onError(cb)
//
// Important:
// - No DOM access.
// - No direct XTerm calls.
// - Output chunks are delivered to listeners registered via onMessage(cb).
(function () {
  'use strict';

  window.XKeen = window.XKeen || {};
  window.XKeen.terminal = window.XKeen.terminal || {};
  window.XKeen.terminal.transport = window.XKeen.terminal.transport || {};

  function createLiteTransport(ctx) {
    const core = (ctx && ctx.core) ? ctx.core : (window.XKeen.terminal._core || null);
    const caps = (ctx && ctx.caps) ? ctx.caps : (window.XKeen.terminal.capabilities || null);
    const events = (ctx && ctx.events) ? ctx.events : { on: () => () => {}, off: () => {}, emit: () => {} };

    const onMsgCbs = new Set();
    const onCloseCbs = new Set();
    const onErrCbs = new Set();

    let lastCmd = '';
    let buffered = '';

    function getMode() {
      try { if (ctx && ctx.session && typeof ctx.session.getMode === 'function') return ctx.session.getMode() || 'shell'; } catch (e) {}
      try { if (core && typeof core.getMode === 'function') return core.getMode() || 'shell'; } catch (e2) {}
      try {
        if (ctx && ctx.state) {
          if (typeof ctx.state.get === 'function') return ctx.state.get('mode') || 'shell';
          return ctx.state.mode || 'shell';
        }
      } catch (e3) {}
      return 'shell';
    }

    function emitRaw(chunk, meta) {
      const payload = Object.assign({
        chunk: String(chunk == null ? '' : chunk),
        source: 'lite',
        ts: Date.now(),
      }, (meta || {}));

      // Direct callbacks (for future controllers/tests).
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
      // Lite mode has no persistent socket.
      return true;
    }

    function connect() {
      // no-op
      return;
    }

    function disconnect() {
      // no-op, but we can notify close listeners for symmetry.
      try {
        onCloseCbs.forEach((cb) => {
          try { cb({ source: 'lite', reason: 'disconnect', ts: Date.now() }); } catch (e2) {}
        });
      } catch (e) {}
    }

    function pickCommandJob() {
      try {
        const CJ = (window.XKeen && window.XKeen.util && window.XKeen.util.commandJob) ? window.XKeen.util.commandJob : null;
        if (CJ) return CJ;
      } catch (e) {}
      return null;
    }

    function normalizeStdin(stdinValue) {
      const raw = String(stdinValue == null ? '' : stdinValue);
      if (raw === '') return '\n';
      // many prompts require a trailing newline
      return /\r|\n$/.test(raw) ? raw : (raw + '\n');
    }

    async function runLite(cmd, stdinValue, opts) {
      const CJ = pickCommandJob();
      if (!CJ || typeof CJ.runShellCommand !== 'function') {
        emitRaw('\r\n[Ошибка] command_job util is not available\r\n', { kind: 'error' });
        emitErr('command_job util is not available');
        return false;
      }

      // Best-effort capability hint
      const hasWs = (caps && typeof caps.hasWs === 'function') ? !!caps.hasWs() : true;

      // Show prompt + command like the legacy lite_runner did.
      emitRaw('\r\n$ ' + cmd + '\r\n', { kind: 'prompt' });

      try {
        const r = await CJ.runShellCommand(cmd, stdinValue, {
          hasWs: hasWs,
          onChunk: (chunk) => {
            if (typeof chunk === 'string' && chunk !== '') emitRaw(chunk, { kind: 'chunk' });
          },
        });

        // If backend failed early
        const resOk = r && r.res && r.res.ok;
        const data = r && r.data ? r.data : null;

        if (!resOk || (data && data.ok === false)) {
          const msg = (data && data.error) ? String(data.error) : 'HTTP error';
          emitRaw('\r\n[Ошибка] ' + msg + '\r\n', { kind: 'error' });
          emitErr(msg, { stage: 'create' });
          return false;
        }

        // waitForCommandJob() returns an object (data) for the job.
        // Output was already streamed via onChunk; don't print full output again.
        if (data && data.status === 'error') {
          const msg2 = data.error ? String(data.error) : 'command failed';
          emitRaw('\r\n[Ошибка] ' + msg2 + '\r\n', { kind: 'error' });
          emitErr(msg2, { stage: 'wait', jobId: data.job_id });
          return false;
        }

        if (data && typeof data.exit_code === 'number' && data.exit_code !== 0) {
          emitRaw('\r\n[Exit] code=' + String(data.exit_code) + '\r\n', { kind: 'exit', exit_code: data.exit_code });
        }
        return true;
      } catch (e) {
        const msg3 = (e && e.message) ? e.message : String(e);
        emitRaw('\r\n[Ошибка] ' + msg3 + '\r\n', { kind: 'error' });
        emitErr(e);
        return false;
      }
    }

    function send(data, opts) {
      const payload = String(data == null ? '' : data);
      const o = opts || {};

      // Do not run lite commands while in PTY mode (unless explicitly forced).
      const mode = getMode();
      if (mode === 'pty' && o.prefer !== 'lite' && o.force !== true) return false;

      // Buffering mode: allow callers to build a command without running it.
      const shouldRun = /\r|\n$/.test(payload) || o.run === true;
      if (!shouldRun) {
        buffered = payload;
        // Consumers (UI/input controller) may choose to reflect the buffer in a text field.
        try { events.emit('term:input:buffer', { text: buffered, source: 'lite', ts: Date.now() }); } catch (e) {}
        return true;
      }

      // Command text
      const cmdText = payload.replace(/[\r\n]+$/g, '').trim();
      if (!cmdText) {
        emitRaw('\r\n[Ошибка] Введите команду.\r\n', { kind: 'error' });
        emitErr('empty command');
        return false;
      }
      buffered = '';
      lastCmd = cmdText;

      // stdin logic: either explicit stdin send, or optional override.
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

      // Fire and forget; output is streamed via events.
      void runLite(cmdText, stdinValue, o);
      return true;
    }

    function resize() {
      // no-op
    }

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

  window.XKeen.terminal.transport.createLiteTransport = createLiteTransport;
})();

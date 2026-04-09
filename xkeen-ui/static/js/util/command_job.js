(() => {
  'use strict';

  window.XKeen = window.XKeen || {};
  const XKeen = window.XKeen;
  XKeen.util = XKeen.util || {};
  XKeen.util.commandJob = XKeen.util.commandJob || {};

  const CJ = XKeen.util.commandJob;

  function commonPrefixLength(a, b) {
    const left = String(a == null ? '' : a);
    const right = String(b == null ? '' : b);
    const limit = Math.min(left.length, right.length);
    let i = 0;
    while (i < limit && left.charCodeAt(i) === right.charCodeAt(i)) i += 1;
    return i;
  }

  CJ.describeRunCommandError = function describeRunCommandError(data, res) {
    const payload = data && typeof data === 'object' ? data : {};
    const parts = [];
    const message = String(payload.message || '').trim();
    const error = String(payload.error || '').trim();
    const hint = String(payload.hint || '').trim();

    if (message) parts.push(message);
    else if (error) parts.push(error);
    else if (res && typeof res.status === 'number' && res.status > 0) parts.push('HTTP ' + res.status);
    else parts.push('Command request failed');

    if (hint && parts.indexOf(hint) === -1) parts.push(hint);
    return parts.join(' ');
  };

  CJ.runShellCommand = async function runShellCommand(cmd, stdinValue, options = {}) {
    const body = { cmd };
    if (typeof stdinValue === 'string') body.stdin = stdinValue;

    const createRes = await fetch('/api/run-command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const createData = await createRes.json().catch(() => ({}));

    if (!createRes.ok || createData.ok === false) return { res: createRes, data: createData };

    const jobId = createData.job_id;
    if (!jobId) return { res: createRes, data: { ok: false, error: 'no job_id returned from /api/run-command' } };

    return { res: createRes, data: await CJ.waitForCommandJob(jobId, options || {}) };
  };

  CJ.runXkeenFlag = async function runXkeenFlag(flag, stdinValue, options = {}) {
    const body = { flag };
    if (typeof stdinValue === 'string') body.stdin = stdinValue;

    const createRes = await fetch('/api/run-command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const createData = await createRes.json().catch(() => ({}));

    if (!createRes.ok || createData.ok === false) return { res: createRes, data: createData };

    const jobId = createData.job_id;
    if (!jobId) return { res: createRes, data: { ok: false, error: 'no job_id returned from /api/run-command' } };

    return { res: createRes, data: await CJ.waitForCommandJob(jobId, options || {}) };
  };

  CJ.waitForCommandJob = async function waitForCommandJob(jobId, options = {}) {
    const start = Date.now();
    const MAX_WAIT_MS = (typeof options.maxWaitMs === 'number' && options.maxWaitMs > 0) ? options.maxWaitMs : 300000;
    const onChunk = (typeof options.onChunk === 'function') ? options.onChunk : null;

    // capability hint (terminal будет передавать hasWs)
    const canWs = (typeof options.hasWs === 'boolean') ? options.hasWs : true;

    let accOutput = '';

    // WS first (best effort)
    if (canWs && typeof WebSocket !== 'undefined') {
      const proto = (location.protocol === 'https:') ? 'wss:' : 'ws:';

      // One-time WS token (scoped).
      let wsToken = '';
      try {
        const tr = await fetch('/api/ws-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scope: 'cmd' })
        });
        const tj = await tr.json().catch(() => ({}));
        if (tr.ok && tj && tj.ok && tj.token) wsToken = String(tj.token || '');
      } catch (e) {
        // ignore, will fallback to HTTP
      }

      if (wsToken) {
        const url = `${proto}//${location.host}/ws/command-status?job_id=${encodeURIComponent(jobId)}&token=${encodeURIComponent(wsToken)}`;

        try {
          const wsResult = await new Promise((resolve) => {
          let resolved = false;
          let ws = null;

          const finish = (result) => {
            if (resolved) return;
            resolved = true;
            try { if (ws && ws.readyState === WebSocket.OPEN) ws.close(); } catch (e) {}
            resolve(result);
          };

          const timeoutId = setTimeout(() => finish({
            ok: false, status: 'error',
            error: 'Client-side timeout while waiting for command result (WS)',
            job_id: jobId, output: accOutput
          }), MAX_WAIT_MS);

          try { ws = new WebSocket(url); } catch (e) {
            clearTimeout(timeoutId);
            return finish(null);
          }

          ws.onmessage = (event) => {
            let msg; try { msg = JSON.parse(event.data); } catch (e) { return; }

            if (msg.type === 'chunk' && typeof msg.data === 'string') {
              accOutput += msg.data;
              if (onChunk) { try { onChunk(msg.data, { via: 'ws', jobId }); } catch (e) {} }
              return;
            }

            if (msg.type === 'done') {
              clearTimeout(timeoutId);
              const status = msg.status || 'finished';
              const exitCode = (typeof msg.exit_code === 'number') ? msg.exit_code : null;
              const error = msg.error || null;
              return finish({
                ok: status === 'finished' && exitCode === 0 && !error,
                status, exit_code: exitCode, output: accOutput, job_id: jobId, error
              });
            }

            if (msg.type === 'error') {
              clearTimeout(timeoutId);
              return finish({
                ok: false, status: 'error',
                error: msg.message || 'WebSocket command error',
                job_id: jobId, output: accOutput
              });
            }
          };

          ws.onerror = () => { clearTimeout(timeoutId); finish(null); };
          ws.onclose = () => { clearTimeout(timeoutId); finish(null); };
        });

          if (wsResult) return wsResult;
        } catch (e) {}
      }
    }

    // HTTP polling fallback
    let lastLen = 0;
    let httpAlignedToWs = accOutput.length === 0;
    while (true) {
      const res = await fetch(`/api/run-command/${encodeURIComponent(jobId)}`);
      const data = await res.json().catch(() => ({}));

      if (!res.ok || data.ok === false) {
        if (!data.error) data.error = 'HTTP ' + res.status;
        if (accOutput && typeof data.output !== 'string') data.output = accOutput;
        return data;
      }

      const output = (typeof data.output === 'string') ? data.output : '';
      if (!httpAlignedToWs) {
        const finished = (data.status === 'finished' || data.status === 'error');
        if (output.length < accOutput.length && !finished) {
          await new Promise(r => setTimeout(r, 250));
          continue;
        }
        lastLen = output.startsWith(accOutput) ? accOutput.length : commonPrefixLength(accOutput, output);
        httpAlignedToWs = true;
      }
      if (output.length > lastLen) {
        const chunk = output.slice(lastLen);
        lastLen = output.length;
        if (chunk) {
          accOutput += chunk;
          if (onChunk) { try { onChunk(chunk, { via: 'http', jobId }); } catch (e) {} }
        }
      }

      if (data.status === 'finished' || data.status === 'error') {
        const finalData = Object.assign({}, data);
        if (accOutput) finalData.output = accOutput;
        return finalData;
      }

      if (Date.now() - start > MAX_WAIT_MS) {
        return { ok: false, status: 'error', error: 'Client-side timeout while waiting for command result', job_id: jobId, output: accOutput };
      }

      await new Promise(r => setTimeout(r, 1000));
    }
  };
})();

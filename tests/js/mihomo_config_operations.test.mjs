import { test } from 'node:test';
import assert from 'node:assert/strict';

const module = await import('../../xkeen-ui/static/js/features/mihomo_config_operations.js').catch(() => ({}));
const make = (options = {}) => {
  assert.equal(typeof module.createMihomoConfigOperations, 'function', 'shared config operation adapter is available');
  return module.createMihomoConfigOperations({ request: async () => ({ ok: true }), ...options });
};

test('one shared operation excludes another writer until released', async () => {
  const ops = make();
  const release = ops.acquire();
  assert.throws(() => ops.acquire(), /выполняется/);
  release();
  const secondRelease = ops.acquire();
  release(); // old release must not unlock a different operation
  assert.equal(ops.busy, true);
  secondRelease();
  assert.equal(ops.busy, false);
});

test('unknown save outcome blocks another write until recovery', () => {
  const ops = make();
  ops.remember({ state: 'unknown', jobId: 'job-1' });
  assert.throws(() => ops.acquire(), /наблюдение/);
  const release = ops.acquire({ recovery: true });
  release();
});

test('snapshot mismatch includes changes made during candidate preparation', () => {
  const ops = make();
  const snapshot = { sourceEditorContent: 'old', context: 'profile-1' };
  assert.equal(ops.isCurrent(snapshot, 'old', 'profile-1'), true);
  assert.equal(ops.isCurrent(snapshot, 'new', 'profile-1'), false);
  assert.equal(ops.isCurrent(snapshot, 'old', 'profile-2'), false);
});

test('pending subscription is registered only after a save containing its exact proxy', async () => {
  const calls = [];
  const ops = make({ request: async (url, options) => { calls.push({ url, ...options }); return { ok: true }; } });
  ops.addPending([{ url: 'https://sub.example/token', proxies: [{ proxy_name: 'A', proxy_yaml: '- name: A\n  type: direct\n' }] }]);
  assert.equal(calls.length, 0);
  await ops.registerPending('proxies: []\n');
  assert.equal(calls.length, 0);
  await ops.registerPending('proxies:\n  - name: A\n    type: direct\n');
  assert.equal(calls.length, 1);
  await ops.registerPending('proxies:\n  - name: A\n    type: direct\n');
  assert.equal(calls.length, 1);
});

test('registration retry repeats only failed metadata and never saves or restarts', async () => {
  const calls = [];
  let failing = true;
  const ops = make({ request: async (_url, { body }) => {
    calls.push(body.url);
    if (body.url.endsWith('/b') && failing) throw new Error('registration failed');
    return { ok: true };
  } });
  ops.addPending(['a', 'b'].map(name => ({ url: `https://sub.example/${name}`, proxies: [{ proxy_name: name, proxy_yaml: `- name: ${name}\n  type: direct\n` }] })));
  const content = 'proxies:\n  - name: a\n    type: direct\n  - name: b\n    type: direct\n';
  const first = await ops.registerPending(content);
  assert.equal(first.failed, 1);
  failing = false;
  const second = await ops.registerPending(content);
  assert.equal(second.failed, 0);
  assert.deepEqual(calls, ['https://sub.example/a', 'https://sub.example/b', 'https://sub.example/b']);
});

test('a different proxy with the same name does not activate pending registration', async () => {
  let calls = 0;
  const ops = make({ request: async () => { calls++; return { ok: true }; } });
  ops.addPending([{ url: 'https://sub.example/a', proxies: [{ proxy_name: 'A', proxy_yaml: '- name: A\n  type: direct\n' }] }]);
  await ops.registerPending('proxies:\n  - name: A\n    type: reject\n');
  assert.equal(calls, 0);
});

test('HTTP success with a failed process is an apply failure', async () => {
  const ops = make({ request: async () => ({ ok: true, status: 'finished', exit_code: 1, error: 'failed' }) });
  ops.remember({ jobId: 'job-1', saved: true });
  const result = await ops.monitor();
  assert.equal(result.state, 'apply-failed');
  assert.equal(result.saved, true);
});

test('successful job still requires a running Mihomo process', async () => {
  const ops = make({ request: async url => url.includes('restart-job')
    ? { ok: true, status: 'finished', exit_code: 0 }
    : { ok: true, running: false } });
  ops.remember({ jobId: 'job-1', saved: true });
  assert.equal((await ops.monitor()).state, 'apply-failed');
});

test('running process with unchecked API is reported without an API health claim', async () => {
  const ops = make({ request: async url => url.includes('restart-job')
    ? { ok: true, status: 'finished', exit_code: 0 }
    : { ok: true, running: true, api_checked: false } });
  ops.remember({ jobId: 'job-1', saved: true });
  const result = await ops.monitor();
  assert.equal(result.state, 'applied');
  assert.equal(result.apiChecked, false);
});

test('poll timeout preserves job identity and allows monitoring to resume', async () => {
  let tick = 0;
  let finished = false;
  const ops = make({ now: () => tick, sleep: async () => { tick += 10; }, jobTimeoutMs: 15,
    request: async url => url.includes('restart-job')
      ? { ok: true, status: finished ? 'finished' : 'running', exit_code: finished ? 0 : null }
      : { ok: true, running: true } });
  ops.remember({ jobId: 'job-1', saved: true });
  assert.equal((await ops.monitor()).state, 'unknown');
  assert.equal(ops.operation.jobId, 'job-1');
  finished = true;
  assert.equal((await ops.monitor()).state, 'applied');
});

test('lost polling response is unknown, not a false failed or applied result', async () => {
  const ops = make({ request: async () => { throw new Error('network lost'); } });
  ops.remember({ jobId: 'job-1', saved: true });
  assert.equal((await ops.monitor()).state, 'unknown');
});

test('controller health is checked separately when the process is running', async () => {
  const ops = make({ request: async url => {
    if (url.includes('restart-job')) return { ok: true, status: 'finished', exit_code: 0 };
    if (url.includes('clash/status')) return { ok: true, state: 'ready' };
    return { ok: true, running: true };
  } });
  ops.remember({ jobId: 'job-1', saved: true });
  assert.equal((await ops.monitor()).apiChecked, true);
});

test('registration intents are copied rather than sharing mutable parser results', async () => {
  let sent;
  const ops = make({ request: async (_url, { body }) => { sent = body; return { ok: true }; } });
  const intents = [{ url: 'https://sub.example/a', proxies: [{ proxy_name: 'A', proxy_yaml: '- name: A\n  type: direct\n' }] }];
  ops.addPending(intents);
  intents[0].url = 'https://wrong.example';
  await ops.registerPending('proxies:\n  - name: A\n    type: direct\n');
  assert.equal(sent.url, 'https://sub.example/a');
});

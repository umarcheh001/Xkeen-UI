import { test } from 'node:test';
import assert from 'node:assert/strict';

const bridge = await import('../../xkeen-ui/static/js/features/module_parts.js').catch(() => ({}));

function api() {
  for (const name of ['loadModulePart', 'loadedModulePart', 'rememberModulePart', '__setModuleEntriesForTest']) {
    assert.equal(typeof bridge[name], 'function', `module_parts.js exports ${name}`);
  }
  return bridge;
}

function fakeEntry(moduleId, parts) {
  const calls = [];
  return {
    calls,
    entry: {
      load(part) {
        calls.push(part);
        const mod = parts[part];
        if (!mod) return Promise.reject(new Error(`unknown part: ${part}`));
        bridge.rememberModulePart(moduleId, part, mod);
        return Promise.resolve(mod);
      },
    },
  };
}

test('a part is null before it is loaded', () => {
  const { loadedModulePart, __setModuleEntriesForTest } = api();
  __setModuleEntriesForTest({ 'engine.fake-a': () => Promise.resolve(fakeEntry('engine.fake-a', {}).entry) });
  assert.equal(loadedModulePart('engine.fake-a', 'routing'), null);
});

test('a loaded part is seen through loadedModulePart', async () => {
  const { loadModulePart, loadedModulePart, __setModuleEntriesForTest } = api();
  const routing = { getRoutingApi() { return 'routing-api'; } };
  const fake = fakeEntry('engine.fake-b', { routing });
  __setModuleEntriesForTest({ 'engine.fake-b': () => Promise.resolve(fake.entry) });

  const mod = await loadModulePart('engine.fake-b', 'routing');

  assert.equal(mod, routing);
  assert.deepEqual(fake.calls, ['routing']);
  assert.equal(loadedModulePart('engine.fake-b', 'routing'), routing);
  assert.equal(loadedModulePart('engine.fake-b', 'outbounds'), null);
  assert.equal(loadedModulePart('engine.other', 'routing'), null);
});

test('an unknown module is rejected', async () => {
  const { loadModulePart, __setModuleEntriesForTest } = api();
  __setModuleEntriesForTest({});
  await assert.rejects(loadModulePart('engine.nope', 'routing'), { message: 'module is not separate: engine.nope' });
});

test('an unknown part of a known module is rejected by its entry', async () => {
  const { loadModulePart, loadedModulePart, __setModuleEntriesForTest } = api();
  __setModuleEntriesForTest({ 'engine.fake-c': () => Promise.resolve(fakeEntry('engine.fake-c', {}).entry) });
  await assert.rejects(loadModulePart('engine.fake-c', 'missing'));
  assert.equal(loadedModulePart('engine.fake-c', 'missing'), null);
});

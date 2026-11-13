import { test } from 'node:test';
import assert from 'node:assert/strict';

const styles = await import('../../xkeen-ui/static/js/ui/module_styles.js').catch(() => ({}));

test('stylesheet loads once and a failed load can be retried', async () => {
  assert.equal(typeof styles.ensureModuleStylesheet, 'function');
  const links = [];
  const previous = globalThis.document;
  globalThis.document = {
    head: {
      querySelector() { return null; },
      appendChild(node) { links.push(node); },
    },
    createElement() {
      const events = {};
      return {
        dataset: {}, events,
        addEventListener(name, fn) { events[name] = fn; },
        remove() { links.splice(links.indexOf(this), 1); },
      };
    },
  };
  try {
    const first = styles.ensureModuleStylesheet('test-module', '/test.css');
    const second = styles.ensureModuleStylesheet('test-module', '/test.css');
    assert.equal(first, second);
    assert.equal(links.length, 1);
    const failed = assert.rejects(first, /failed to load module stylesheet/);
    links[0].events.error();
    await failed;
    assert.equal(links.length, 0);
    const retry = styles.ensureModuleStylesheet('test-module', '/test.css');
    assert.equal(links.length, 1);
    assert.equal(links[0].href, '/test.css');
    links[0].events.load();
    assert.equal(await retry, true);
    assert.equal(await styles.ensureModuleStylesheet('test-module', '/test.css'), true);
    assert.equal(links.length, 1);
  } finally {
    globalThis.document = previous;
  }
});

test('an untracked server stylesheet without a sheet is retried even if its error already fired', async () => {
  const previous = globalThis.document;
  const events = {};
  let removed = false;
  const existing = { sheet: null, href:'/screen.css?v=123', remove() { removed = true; }, addEventListener() {} };
  const replacement = {dataset:{},addEventListener(name,fn){events[name]=fn;}};
  globalThis.document = {head:{querySelector(){return existing;},appendChild(){}},createElement(){return replacement;}};
  try {
    const pending = styles.ensureModuleStylesheet('screen-host-style','/screen.css');
    assert.equal(removed, true);
    assert.equal(replacement.href, '/screen.css?v=123');
    assert.equal(typeof events.load, 'function');
    events.load();
    assert.equal(await pending, true);
  } finally { globalThis.document = previous; }
});

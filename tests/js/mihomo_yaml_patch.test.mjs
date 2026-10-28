import assert from 'node:assert/strict';
import test from 'node:test';
import { insertIntoSection } from '../../xkeen-ui/static/js/features/mihomo_yaml_patch.js';

test('provider insertion can prepend without changing the existing entry', () => {
  const source = 'proxy-providers:\n  Existing:\n    type: http\nrules: []\n';
  const result = insertIntoSection(source, 'proxy-providers', '  New:\n    type: http\n', { position: 'start' });
  assert.ok(result.indexOf('  New:') < result.indexOf('  Existing:'));
  assert.match(result, /  Existing:\n    type: http/);
  assert.match(result, /rules: \[\]/);
});

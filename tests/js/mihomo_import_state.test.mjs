import test from 'node:test';
import assert from 'node:assert/strict';
import {
  beginMihomoImportRequest,
  commitMihomoImportResult,
  createMihomoImportState,
  invalidateMihomoImportResult,
  isCurrentMihomoImportRequest,
  isCurrentMihomoImportResult,
  resetMihomoImportState,
  updateMihomoImportContext,
} from '../../xkeen-ui/static/js/features/mihomo_import_state.js';

test('request token becomes stale when source revision changes', () => {
  const state = createMihomoImportState();
  const token = beginMihomoImportRequest(state, 'parse');
  assert.equal(isCurrentMihomoImportRequest(state, token), true);

  invalidateMihomoImportResult(state);
  assert.equal(isCurrentMihomoImportRequest(state, token), false);
  assert.equal(commitMihomoImportResult(state, token, { outputs: [] }), false);
});

test('new request supersedes an older request in the same session', () => {
  const state = createMihomoImportState();
  const first = beginMihomoImportRequest(state, 'parse');
  const second = beginMihomoImportRequest(state, 'parse');
  assert.equal(isCurrentMihomoImportRequest(state, first), false);
  assert.equal(isCurrentMihomoImportRequest(state, second), true);
});

test('committed result is tied to its current source revision', () => {
  const state = createMihomoImportState();
  const token = beginMihomoImportRequest(state, 'parse');
  const result = { outputs: [{ type: 'proxy' }] };
  assert.equal(commitMihomoImportResult(state, token, result), true);
  assert.equal(isCurrentMihomoImportResult(state, result), true);

  invalidateMihomoImportResult(state);
  assert.equal(isCurrentMihomoImportResult(state, result), false);
});

test('reset invalidates tokens from a previous modal session', () => {
  const state = createMihomoImportState();
  const token = beginMihomoImportRequest(state, 'parse');
  resetMihomoImportState(state);
  assert.equal(isCurrentMihomoImportRequest(state, token), false);
  assert.equal(state.result, null);
});

test('context keeps source, mode, groups and candidate outside the DOM', () => {
  const state = createMihomoImportState();
  updateMihomoImportContext(state, {
    source: 'vless://example',
    mode: 'proxy',
    selectedGroups: ['Main'],
    destination: 'proxies',
    warnings: ['one skipped'],
    baseConfigRevision: 42,
    candidate: 'proxies: []',
  });
  assert.deepEqual(state, {
    sessionId: 0,
    sourceRevision: 0,
    source: 'vless://example',
    mode: 'proxy',
    selectedGroups: ['Main'],
    destination: 'proxies',
    warnings: ['one skipped'],
    baseConfigRevision: 42,
    candidate: 'proxies: []',
    requestId: 0,
    activeRequest: null,
    resultRevision: 0,
    result: null,
  });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createMihomoImportApi } from '../../xkeen-ui/static/js/features/mihomo_import_api.js';

test('fulfilled ok:false keeps not_xray_json metadata for the provider fallback', async () => {
  const payload = { ok: false, code: 'not_xray_json', error: 'not Xray' };
  const api = createMihomoImportApi({ getCoreHttp: () => ({ postJSON: async () => payload }) });
  await assert.rejects(api.postJSON('/api/mihomo/parse/xray-json', {}), (error) => {
    assert.equal(error.data, payload);
    assert.equal(error.data.code, 'not_xray_json');
    return true;
  });
});

test('post passes the same body/options to the existing core transport', async () => {
  const calls = [];
  const api = createMihomoImportApi({ getCoreHttp: () => ({ postJSON: async (...args) => { calls.push(args); return { ok: true }; } }) });
  const body = { content: 'proxies: []' };
  const options = { signal: new AbortController().signal };
  assert.deepEqual(await api.postJSON('/api/mihomo/patch/apply_insert', body, options), { ok: true });
  assert.deepEqual(calls, [['/api/mihomo/patch/apply_insert', body, options]]);
});

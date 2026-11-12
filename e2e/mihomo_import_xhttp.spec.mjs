import { test, expect } from './fixtures.mjs';
import yaml from 'js-yaml';

test('REALITY import enables ML-KEM by default and preserves explicit false', async ({ page }) => {
  await page.goto('/');
  const results = await page.evaluate(async () => {
    const { generateMihomoImportConfig: generate } = await import('/static/js/features/mihomo_import.js');
    const link = 'vless://11111111-1111-1111-1111-111111111111@example.com:443?security=reality&pbk=key';
    return [generate(link), generate(link + '&support-x25519mlkem768=false')];
  });
  expect(results.map(result => yaml.load(result.content)[0]['reality-opts']['support-x25519mlkem768'])).toEqual([true, false]);
});

test('XHTTP import preserves query uploads and XMUX without forcing TCP Fast Open', async ({ page }) => {
  const extra = {
    sessionIDPlacement: 'query', sessionIDKey: 'cid', sessionIDLength: '40-52',
    seqPlacement: 'query', seqKey: 'storage', uplinkHTTPMethod: 'GET',
    uplinkDataPlacement: 'body', uplinkChunkSize: '16384-131072',
    xPaddingPlacement: 'query', xPaddingKey: 'trl', xPaddingObfsMode: true,
    noGRPCHeader: false,
    xmux: { maxConnections: 1, cMaxReuseTimes: 0, hKeepAlivePeriod: 30 },
  };
  const query = new URLSearchParams({ type: 'xhttp', security: 'tls', path: '/edge', mode: 'packet-up', extra: JSON.stringify(extra) });
  await page.goto('/');
  const result = await page.evaluate(async link => {
    const { generateMihomoImportConfig } = await import('/static/js/features/mihomo_import.js');
    return generateMihomoImportConfig(link);
  }, `vless://11111111-1111-1111-1111-111111111111@example.com:443?${query}#XHTTP`);
  const proxy = yaml.load(result.content)[0];
  expect(proxy).not.toHaveProperty('tfo');
  expect(proxy['xhttp-opts']).toMatchObject({
    path: '/edge', mode: 'packet-up',
    'session-placement': 'query', 'session-key': 'cid', 'session-length': '40-52',
    'seq-placement': 'query', 'seq-key': 'storage', 'uplink-http-method': 'GET',
    'uplink-data-placement': 'body', 'uplink-chunk-size': '16384-131072',
    'x-padding-placement': 'query', 'x-padding-key': 'trl', 'x-padding-obfs-mode': true,
    'no-grpc-header': false,
    'reuse-settings': { 'max-connections': 1, 'c-max-reuse-times': 0, 'h-keep-alive-period': 30 },
  });
});

test('TCP Fast Open remains opt-in for nodes and subscription providers', async ({ page }) => {
  await page.goto('/');
  const results = await page.evaluate(async () => {
    const { generateMihomoImportConfig: generate } = await import('/static/js/features/mihomo_import.js');
    const link = 'vless://11111111-1111-1111-1111-111111111111@example.com:443?type=xhttp&security=tls';
    return [generate(link), generate(link + '&tfo=true'), generate(link + '&tfo=false'), generate('https://subscription.example/list')];
  });
  const proxies = results.slice(0, 3).map(result => yaml.load(result.content)[0]);
  expect(proxies[0]).not.toHaveProperty('tfo');
  expect(proxies[1].tfo).toBe(true);
  expect(proxies[2].tfo).toBe(false);
  const providers = Object.values(yaml.load(results[3].content));
  expect(providers).toHaveLength(1);
  expect(providers[0].override).not.toHaveProperty('tfo');
});

test('Xray zero padding keeps its default without changing native Mihomo zero padding', async ({ page }) => {
  await page.goto('/');
  const results = await page.evaluate(async () => {
    const { generateMihomoImportConfig: generate } = await import('/static/js/features/mihomo_import.js');
    const link = 'vless://11111111-1111-1111-1111-111111111111@example.com:443?type=xhttp&security=tls';
    return [{ xPaddingBytes: '0-0' }, { 'x-padding-bytes': 0 }].map(extra =>
      generate(link + '&extra=' + encodeURIComponent(JSON.stringify(extra))));
  });
  const options = results.map(result => yaml.load(result.content)[0]['xhttp-opts']);
  expect(options[0]['x-padding-bytes']).toBe('100-1000');
  expect(options[1]['x-padding-bytes']).toBe(0);
});

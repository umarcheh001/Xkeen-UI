import { test, expect } from './fixtures.mjs';


function statusPayload() {
  return {
    ok: true,
    state: 'ready',
    schema_version: 1,
    core: { version: 'test-1.0' },
    runtime: { mode: 'rule' },
    capabilities: {
      status: true,
      connections_snapshot: true,
      connections_stream: false,
      connection_disconnect: true,
    },
  };
}


function connectionsPayload(ids = ['connection-one', 'connection-two']) {
  return {
    ok: true,
    schema_version: 1,
    download_total: 4096,
    upload_total: 2048,
    memory: 1048576,
    total_connections: ids.length,
    truncated: false,
    fallback: { transport: 'http-snapshot', poll_interval_ms: 2000 },
    capabilities: {
      connections_snapshot: true,
      connections_stream: false,
      connection_disconnect: true,
    },
    connections: ids.map((id, index) => ({
      id,
      metadata: {
        network: index ? 'udp' : 'tcp',
        type: 'Mixed',
        source_ip: `192.0.2.${index + 1}`,
        source_port: '5000',
        source_name: index ? 'Phone' : 'Laptop',
        destination_ip: '198.51.100.10',
        destination_port: '443',
        host: index ? 'video.example' : 'docs.example',
        sniff_host: '',
        inbound_name: 'mixed-in',
        inbound_user: '',
        process: '',
      },
      upload: 100 + index,
      download: 200 + index,
      start: new Date(Date.now() - (index + 1) * 60000).toISOString(),
      chains: ['AUTO', index ? 'node-b' : 'node-a'],
      provider_chains: [],
      rule: 'DomainSuffix',
      rule_payload: 'example',
    })),
  };
}


test('Mihomo connections use HTTP fallback, local filters, inspector and confirmed disconnect', async ({ page }) => {
  let ids = ['connection-one', 'connection-two'];
  const disconnects = [];
  await page.route('**/api/mihomo/clash/status', (route) => route.fulfill({ json: statusPayload() }));
  await page.route(/\/api\/mihomo\/clash\/connections(?:\/.*)?$/, async (route) => {
    const request = route.request();
    if (request.method() === 'DELETE') {
      const id = decodeURIComponent(new URL(request.url()).pathname.split('/').pop());
      disconnects.push(id);
      await route.fulfill({ json: { ok: true, schema_version: 1, disconnected: true } });
      return;
    }
    await route.fulfill({ json: connectionsPayload(ids) });
  });

  await page.goto('/');
  await page.locator('.top-tab-btn[data-view="mihomo"]').click();
  await page.evaluate(async () => {
    const mod = await import('/static/js/features/mihomo_clash/index.js');
    mod.activateMihomoClashWorkspace({ reason: 'e2e' });
  });
  await page.locator('#mihomo-clash-tab-connections').click();

  await expect(page.locator('#mihomo-clash-stream-state')).toHaveText('HTTP fallback');
  await expect(page.locator('#mihomo-clash-connection-count')).toHaveText('2');
  await expect(page.locator('#mihomo-clash-connections-rows tr')).toHaveCount(2);
  await expect(page.locator('#mihomo-clash-connections-rows')).toContainText('Laptop');
  await expect(page.locator('#mihomo-clash-connections-rows')).toContainText('AUTO → node-a');

  await page.locator('#mihomo-clash-connections-filter').fill('video.example');
  await expect(page.locator('#mihomo-clash-connections-rows tr')).toHaveCount(1);
  await page.locator('#mihomo-clash-connections-filter').fill('');
  await page.locator('#mihomo-clash-connections-network').selectOption('udp');
  await expect(page.locator('#mihomo-clash-connections-rows tr')).toHaveCount(1);
  await page.locator('#mihomo-clash-connections-network').selectOption('all');

  await page.locator('[data-connection-id="connection-one"]').click();
  await expect(page.locator('#mihomo-clash-connection-inspector')).toBeVisible();
  await expect(page.locator('#mihomo-clash-connection-inspector-details')).toContainText('DomainSuffix');

  await page.locator('[data-mihomo-connection-close="connection-one"]').click();
  await expect(page.locator('#confirm-modal')).not.toHaveClass(/hidden/);
  await page.locator('#confirm-modal-ok-btn').click();
  await expect.poll(() => disconnects).toEqual(['connection-one']);
  // The row remains until a subsequent authoritative snapshot removes it.
  await expect(page.locator('[data-connection-id="connection-one"]')).toHaveCount(1);

  await page.locator('#mihomo-clash-tab-config').click();
  await expect(page.locator('#mihomo-clash-runtime')).toBeHidden();
  await expect(page.locator('#mihomo-clash-stream-state')).toHaveText('Пауза');
});


test('Mihomo connections mobile table becomes records without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/mihomo/clash/status', (route) => route.fulfill({ json: statusPayload() }));
  await page.route('**/api/mihomo/clash/connections', (route) => route.fulfill({ json: connectionsPayload(['mobile-one']) }));
  await page.goto('/');
  await page.locator('.top-tab-btn[data-view="mihomo"]').click();
  await page.evaluate(async () => {
    const mod = await import('/static/js/features/mihomo_clash/index.js');
    mod.activateMihomoClashWorkspace({ reason: 'e2e-mobile' });
  });
  await page.locator('#mihomo-clash-tab-connections').click();
  await expect(page.locator('[data-connection-id="mobile-one"]')).toBeVisible();
  const layout = await page.locator('[data-connection-id="mobile-one"]').evaluate((row) => ({
    display: getComputedStyle(row).display,
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  }));
  expect(layout).toEqual({ display: 'grid', overflow: false });
});


test('Mihomo connections keeps one WebSocket and closes it outside the subview', async ({ page }) => {
  await page.addInitScript(() => {
    window.__clashSockets = [];
    class ClashSocket {
      constructor(url) {
        this.url = url;
        this.readyState = 0;
        this.closed = false;
        this.isClash = String(url).includes('/ws/mihomo-clash/connections');
        if (this.isClash) window.__clashSockets.push(this);
        setTimeout(() => {
          this.readyState = 1;
          this.onopen?.({});
          this.onmessage?.({
            data: JSON.stringify({
              type: 'mihomo-clash-connections', schema_version: 1, sequence: 1,
              received_at_ms: Date.now(), state: 'live', payload: connectionsPayloadForBrowser(),
            }),
          });
        }, 0);
      }
      close() { this.closed = true; this.readyState = 3; }
    }
    function connectionsPayloadForBrowser() {
      return {
        schema_version: 1, download_total: 10, upload_total: 5, memory: 1024,
        total_connections: 1, truncated: false,
        connections: [{
          id: 'ws-one', metadata: { network: 'tcp', source_ip: '192.0.2.1', source_port: '1', source_name: 'TV', destination_ip: '198.51.100.1', destination_port: '443', host: 'ws.example' },
          upload: 5, download: 10, start: new Date().toISOString(), chains: ['AUTO'], provider_chains: [], rule: 'Match', rule_payload: '',
        }],
      };
    }
    window.WebSocket = ClashSocket;
  });
  const status = statusPayload();
  status.capabilities.connections_stream = true;
  const bootstrap = connectionsPayload([]);
  bootstrap.capabilities.connections_stream = true;
  await page.route('**/api/mihomo/clash/status', (route) => route.fulfill({ json: status }));
  await page.route('**/api/mihomo/clash/connections', (route) => route.fulfill({ json: bootstrap }));
  await page.route('**/api/ws-token', (route) => route.fulfill({ json: { ok: true, token: 'fixture-token', scope: 'mihomo-clash', ttl: 60 } }));

  await page.goto('/');
  await page.locator('.top-tab-btn[data-view="mihomo"]').click();
  await page.locator('#mihomo-clash-tab-connections').click();
  await expect(page.locator('#mihomo-clash-stream-state')).toHaveText('Live');
  await expect(page.locator('[data-connection-id="ws-one"]')).toBeVisible();
  expect(await page.evaluate(() => window.__clashSockets.filter((socket) => !socket.closed).length)).toBe(1);

  await page.locator('#mihomo-clash-tab-control').click();
  expect(await page.evaluate(() => window.__clashSockets.every((socket) => socket.closed))).toBe(true);
  const countBeforeReentry = await page.evaluate(() => window.__clashSockets.length);
  await page.locator('#mihomo-clash-tab-connections').click();
  await expect(page.locator('#mihomo-clash-stream-state')).toHaveText('Live');
  expect(await page.evaluate(() => ({
    count: window.__clashSockets.length,
    active: window.__clashSockets.filter((socket) => !socket.closed).length,
  }))).toEqual({ count: countBeforeReentry + 1, active: 1 });
});

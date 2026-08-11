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
        inbound_ip: '192.0.2.254',
        inbound_port: '7890',
        remote_destination: '198.51.100.10:443',
        dns_mode: 'normal-redir',
        process: 'browser',
        process_path: '/usr/bin/browser',
        uid: 1000,
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
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
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
  const firstSource = page.locator('[data-connection-id="connection-one"] td').first();
  await expect(firstSource).toContainText('192.0.2.1:5000');
  await expect(firstSource.locator('.xk-mihomo-device-name')).toHaveText('Laptop');
  const deviceStyle = await firstSource.locator('.xk-mihomo-device-name').evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      background: style.backgroundColor,
      borderRadius: style.borderRadius,
      borderLeftStyle: style.borderLeftStyle,
    };
  });
  expect(deviceStyle).toEqual({
    background: 'rgba(0, 0, 0, 0)',
    borderRadius: '0px',
    borderLeftStyle: 'solid',
  });

  await firstSource.locator('.xk-mihomo-device-name').click();
  await expect(page.locator('#mihomo-clash-connections-filter')).toHaveValue('Laptop');
  await page.locator('#mihomo-clash-connections-filter').fill('');

  const destinationSort = page.locator('[data-mihomo-connection-sort="destination"]');
  await destinationSort.click();
  await expect(destinationSort).toHaveAttribute('aria-sort', 'ascending');
  await destinationSort.click();
  await expect(destinationSort).toHaveAttribute('aria-sort', 'descending');

  const closeButton = page.locator('[data-mihomo-connection-close="connection-one"]');
  await expect(closeButton).toHaveAttribute('data-tooltip', 'Завершить соединение');
  const closeColorBeforeHover = await closeButton.evaluate((element) => getComputedStyle(element).color);
  await closeButton.hover();
  await expect.poll(() => closeButton.evaluate((element) => getComputedStyle(element).color))
    .not.toBe(closeColorBeforeHover);

  await page.locator('#mihomo-clash-connections-filter').fill('video.example');
  await expect(page.locator('#mihomo-clash-connections-rows tr')).toHaveCount(1);
  await page.locator('#mihomo-clash-connections-filter').fill('');
  await page.locator('#mihomo-clash-connections-network').selectOption('udp');
  await expect(page.locator('#mihomo-clash-connections-rows tr')).toHaveCount(1);
  await page.locator('#mihomo-clash-connections-network').selectOption('all');

  await page.locator('[data-connection-id="connection-one"]').click();
  await expect(page.locator('#mihomo-clash-connection-inspector')).toBeVisible();
  await expect(page.locator('#mihomo-clash-connection-inspector-details')).toContainText('DomainSuffix');
  await expect(page.locator('#mihomo-clash-connection-inspector-details')).toContainText('normal-redir');
  await expect(page.locator('#mihomo-clash-connection-inspector-details')).toContainText('/usr/bin/browser');
  await page.locator('#mihomo-clash-connection-copy').click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('Источник: 192.0.2.1:5000');

  await page.locator('[data-mihomo-connection-close="connection-one"]').click();
  await expect(page.locator('#confirm-modal')).not.toHaveClass(/hidden/);
  await page.locator('#confirm-modal-ok-btn').click();
  await expect.poll(() => disconnects).toEqual(['connection-one']);
  // The row remains until a subsequent authoritative snapshot removes it.
  await expect(page.locator('[data-connection-id="connection-one"]')).toHaveCount(1);

  ids = ['connection-two'];
  await page.locator('#mihomo-clash-connections-refresh').click();
  await expect(page.locator('[data-connection-id="connection-one"]')).toHaveCount(0);
  await page.locator('#mihomo-clash-connections-closed-tab').click();
  await expect(page.locator('#mihomo-clash-closed-count')).toHaveText('1');
  await expect(page.locator('[data-connection-id="connection-one"]')).toHaveAttribute('data-connection-state', 'closed');
  await expect(page.locator('[data-connection-id="connection-one"]')).toContainText('Закрыто');
  await page.locator('[data-connection-id="connection-one"]').click();
  await expect(page.locator('#mihomo-clash-connection-inspector-details')).toContainText('Недавно закрыто');
  await page.locator('#mihomo-clash-closed-clear').click();
  await expect(page.locator('#mihomo-clash-closed-count')).toHaveText('0');

  await page.locator('#mihomo-clash-tab-config').click();
  await expect(page.locator('#mihomo-clash-runtime')).toBeHidden();
  await expect(page.locator('#mihomo-clash-stream-state')).toHaveText('Пауза');
});


test('Mihomo connections fill the desktop viewport and scroll inside the table', async ({ page }) => {
  const ids = Array.from({ length: 60 }, (_, index) => `scroll-${index}`);
  await page.route('**/api/mihomo/clash/status', (route) => route.fulfill({ json: statusPayload() }));
  await page.route('**/api/mihomo/clash/connections', (route) => route.fulfill({ json: connectionsPayload(ids) }));
  await page.goto('/');
  await page.locator('.top-tab-btn[data-view="mihomo"]').click();
  await page.locator('#mihomo-clash-tab-connections').click();
  await expect(page.locator('#mihomo-clash-connections-rows tr')).toHaveCount(60);

  const layout = await page.evaluate(() => {
    const workspace = document.querySelector('#mihomo-clash-connections');
    const tableWrap = document.querySelector('#mihomo-clash-connections-table-wrap');
    const tableHead = document.querySelector('.xk-mihomo-connections-table th');
    const workspaceRect = workspace.getBoundingClientRect();
    const wrapStyle = getComputedStyle(tableWrap);
    return {
      workspaceHeight: workspaceRect.height,
      viewportHeight: window.innerHeight,
      overflowY: wrapStyle.overflowY,
      scrollable: tableWrap.scrollHeight > tableWrap.clientHeight,
      stickyHead: getComputedStyle(tableHead).position,
    };
  });
  expect(layout.workspaceHeight).toBeCloseTo(Math.max(420, layout.viewportHeight - 230), 0);
  expect(layout.overflowY).toBe('auto');
  expect(layout.scrollable).toBe(true);
  expect(layout.stickyHead).toBe('sticky');
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


test('Mihomo closed history ignores disappearance from a truncated snapshot and stays bounded', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const mod = await import('/static/js/features/mihomo_clash/connections.js');
    const previous = Array.from({ length: 305 }, (_, index) => ({ id: `closed-${index}`, metadata: {} }));
    return {
      truncated: mod.reconcileMihomoClosedConnectionsForTest(previous.slice(0, 2), [], { authoritative: false }),
      bounded: mod.reconcileMihomoClosedConnectionsForTest(previous, [], { authoritative: true, closedAt: 1000 }),
    };
  });
  expect(result.truncated).toEqual([]);
  expect(result.bounded).toHaveLength(300);
  expect(result.bounded[0].id).toBe('closed-5');
  expect(result.bounded.at(-1).closed_at).toBe('1970-01-01T00:00:01.000Z');
});

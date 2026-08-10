import { test, expect } from './fixtures.mjs';


function statusPayload() {
  return {
    ok: true, state: 'ready', schema_version: 1,
    core: { version: 'Mihomo Meta pr9-fixture' }, runtime: { mode: 'rule' },
    capabilities: {
      status: true, rules: true, providers: true,
      provider_update: true, provider_healthcheck: true,
      logs: true, logs_stream: true,
    },
  };
}


function rulesPayload() {
  return {
    ok: true, schema_version: 1, total_rules: 3, truncated: false,
    rules: [
      { index: 0, type: 'DomainSuffix', payload: 'example.test', target: 'AUTO', disabled: null, size: null },
      { index: 1, type: 'RuleSet', payload: 'fixture-rules', target: 'DIRECT', disabled: false, size: 12 },
      { index: 2, type: 'Match', payload: '', target: 'AUTO', disabled: null, size: null },
    ],
  };
}


function providersPayload() {
  return {
    ok: true, schema_version: 1, total_providers: 2, truncated: false,
    providers: [
      { name: 'proxy/fixture', kind: 'proxy', type: 'Proxy', vehicle_type: 'HTTP', updated_at: '2026-08-10T10:00:00Z', count: 2, alive: 1, failed: 1, behavior: '', format: '', healthcheck: true },
      { name: 'fixture-rules', kind: 'rule', type: 'Rule', vehicle_type: 'HTTP', updated_at: '2026-08-10T10:01:00Z', count: 12, alive: null, failed: null, behavior: 'domain', format: 'mrs', healthcheck: false },
    ],
  };
}


function connectionsPayload() {
  return {
    ok: true, schema_version: 1, download_total: 0, upload_total: 0, memory: 1024,
    total_connections: 1, truncated: false,
    capabilities: { connections_snapshot: true, connections_stream: false, connection_disconnect: true },
    connections: [{
      id: 'cross-link', metadata: { network: 'tcp', source_ip: '192.0.2.1', source_port: '1', source_name: 'Laptop', destination_ip: '198.51.100.1', destination_port: '443', host: 'example.test' },
      upload: 0, download: 0, start: new Date().toISOString(), chains: ['AUTO'], provider_chains: [],
      rule: 'DomainSuffix', rule_payload: 'example.test',
    }],
  };
}


async function mockPr9(page) {
  const actions = [];
  let groupRequests = 0;
  await page.route('**/api/mihomo/clash/status', (route) => route.fulfill({ json: statusPayload() }));
  await page.route('**/api/mihomo/clash/proxy-groups', (route) => {
    groupRequests += 1;
    return route.fulfill({ json: { ok: true, schema_version: 1, groups: [], providers: [] } });
  });
  await page.route('**/api/mihomo/clash/rules', (route) => route.fulfill({ json: rulesPayload() }));
  await page.route(/\/api\/mihomo\/clash\/providers(?:\/.*)?$/, (route) => {
    if (route.request().method() === 'POST') {
      actions.push(decodeURIComponent(new URL(route.request().url()).pathname));
      return route.fulfill({ json: { ok: true, schema_version: 1 } });
    }
    return route.fulfill({ json: providersPayload() });
  });
  await page.route('**/api/mihomo/clash/connections', (route) => route.fulfill({ json: connectionsPayload() }));
  await page.route('**/api/ws-token', (route) => {
    const scope = route.request().postDataJSON()?.scope || 'mihomo-clash';
    return route.fulfill({ json: { ok: true, token: 'pr9-token', scope } });
  });
  return { actions, groupRequests: () => groupRequests };
}


test('rules search, connection cross-link and provider actions stay explicit', async ({ page }) => {
  const runtime = await mockPr9(page);
  const { actions } = runtime;
  await page.goto('/');
  await page.locator('.top-tab-btn[data-view="mihomo"]').click();
  await page.locator('#mihomo-clash-tab-rules').click();

  await expect(page.locator('#mihomo-clash-rules-rows tr')).toHaveCount(3);
  await expect(page.locator('#mihomo-clash-providers-list .xk-mihomo-provider')).toHaveCount(2);
  await page.locator('#mihomo-clash-rules-filter').fill('fixture-rules');
  await expect(page.locator('#mihomo-clash-rules-rows tr')).toHaveCount(1);
  await page.locator('#mihomo-clash-provider-kind').selectOption('rule');
  await expect(page.locator('#mihomo-clash-providers-list .xk-mihomo-provider')).toHaveCount(1);
  await page.locator('#mihomo-clash-provider-kind').selectOption('all');

  await page.locator('[data-provider-key="proxy:proxy/fixture"] [data-mihomo-provider-healthcheck]').click();
  await page.locator('#confirm-modal-ok-btn').click();
  await expect.poll(() => actions.length).toBe(1);
  await page.locator('[data-provider-key="rule:fixture-rules"] [data-mihomo-provider-update]').click();
  await page.locator('#confirm-modal-ok-btn').click();
  await expect.poll(() => actions.length).toBe(2);
  expect(actions).toEqual([
    '/api/mihomo/clash/providers/proxy/proxy/fixture/healthcheck',
    '/api/mihomo/clash/providers/rule/fixture-rules/update',
  ]);

  await page.locator('#mihomo-clash-tab-control').click();
  await expect.poll(runtime.groupRequests).toBeGreaterThan(0);

  await page.locator('#mihomo-clash-tab-connections').click();
  await page.locator('[data-connection-id="cross-link"]').click();
  await page.locator('#mihomo-clash-connection-rule-link').click();
  await expect(page.locator('#mihomo-clash-panel-rules')).toBeVisible();
  await expect(page.locator('#mihomo-clash-rules-filter')).toHaveValue('DomainSuffix example.test');
  await expect(page.locator('#mihomo-clash-rules-rows tr')).toHaveCount(1);
});


test('structured logs use one on-demand socket, ring buffer, pause and close lifecycle', async ({ page }) => {
  await page.addInitScript(() => {
    window.__pr9LogSockets = [];
    class LogSocket {
      constructor(url) {
        this.url = url; this.closed = false;
        if (String(url).includes('/ws/mihomo-clash/logs')) window.__pr9LogSockets.push(this);
        setTimeout(() => { this.onopen?.({}); }, 0);
      }
      close() { this.closed = true; }
      emit(payload) { this.onmessage?.({ data: JSON.stringify(payload) }); }
    }
    window.WebSocket = LogSocket;
  });
  await mockPr9(page);
  await page.goto('/');
  await page.locator('.top-tab-btn[data-view="mihomo"]').click();
  await page.locator('#mihomo-clash-tab-rules').click();
  await page.locator('#mihomo-clash-logs-open').click();
  await expect(page.locator('#mihomo-clash-logs-drawer')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__pr9LogSockets.length)).toBe(1);

  await page.evaluate(() => {
    const socket = window.__pr9LogSockets[0];
    for (let index = 0; index < 505; index += 1) {
      socket.emit({
        type: 'mihomo-clash-logs', schema_version: 1, state: 'live', sequence: index + 1,
        payload: { sequence: index + 1, time: `t-${index}`, level: index % 2 ? 'info' : 'warning', message: `fixture-${index}`, fields: { network: 'tcp' } },
      });
    }
  });
  await expect(page.locator('#mihomo-clash-logs-list li')).toHaveCount(500);
  await expect(page.locator('#mihomo-clash-logs-list')).not.toContainText('fixture-0');
  await expect(page.locator('#mihomo-clash-logs-list')).toContainText('fixture-504');

  await page.locator('#mihomo-clash-logs-pause').click();
  await page.evaluate(() => window.__pr9LogSockets[0].emit({
    type: 'mihomo-clash-logs', schema_version: 1, state: 'live', sequence: 506,
    payload: { sequence: 506, time: 'paused', level: 'error', message: 'while-paused', fields: {} },
  }));
  await expect(page.locator('#mihomo-clash-logs-list')).not.toContainText('while-paused');
  await page.locator('#mihomo-clash-logs-pause').click();
  await expect(page.locator('#mihomo-clash-logs-list')).toContainText('while-paused');

  await page.locator('#mihomo-clash-tab-control').click();
  expect(await page.evaluate(() => window.__pr9LogSockets.every((socket) => socket.closed))).toBe(true);
  await expect(page.locator('#mihomo-clash-logs-drawer')).toBeHidden();
});


test('rules/providers remain responsive on mobile without page overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockPr9(page);
  await page.goto('/');
  await page.locator('.top-tab-btn[data-view="mihomo"]').click();
  await page.locator('#mihomo-clash-tab-rules').click();
  await expect(page.locator('#mihomo-clash-rules-rows tr').first()).toBeVisible();
  const metrics = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ruleDisplay: getComputedStyle(document.querySelector('#mihomo-clash-rules-rows tr')).display,
    columns: getComputedStyle(document.querySelector('.xk-mihomo-rules-layout')).gridTemplateColumns.split(' ').length,
  }));
  expect(metrics.overflow).toBeLessThanOrEqual(1);
  expect(metrics.ruleDisplay).toBe('grid');
  expect(metrics.columns).toBe(1);
});

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
      { name: 'proxy/fixture', kind: 'proxy', type: 'Proxy', vehicle_type: 'HTTP', updated_at: '2026-08-10T10:00:00Z', count: 2, alive: 1, failed: 1, behavior: '', format: '', healthcheck: true, subscription: { used: 1073741824, total: 107374182400, expires_at: 1780000000 } },
      { name: 'fixture-rules', kind: 'rule', type: 'Rule', vehicle_type: 'HTTP', updated_at: '2026-08-10T10:01:00Z', count: 12, alive: null, failed: null, behavior: 'domain', format: 'mrs', healthcheck: false },
    ],
  };
}


function providerContentPayload(url) {
  const request = new URL(url);
  const query = String(request.searchParams.get('q') || '').trim().toLowerCase();
  const allRules = ['example.test', '+.filtered.test', 'DOMAIN-SUFFIX,fixture.test'];
  const rules = query ? allRules.filter((rule) => rule.toLowerCase().includes(query)) : allRules;
  return {
    ok: true, schema_version: 1,
    provider: { name: 'fixture-rules', type: 'http', behavior: 'domain', format: 'mrs' },
    rules, query, offset: 0, limit: 200, total_rules: allRules.length, matched_rules: rules.length,
    truncated: false, cache: { hit: false, key: 'mtime' }, source: { size_bytes: 512, mtime_ns: 1 },
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
  await page.route(/\/api\/mihomo\/clash\/providers(?:\/.*)?(?:\?.*)?$/, (route) => {
    if (new URL(route.request().url()).pathname.endsWith('/content')) {
      return route.fulfill({ json: providerContentPayload(route.request().url()) });
    }
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
  await expect(page.locator('[data-provider-key="proxy:proxy/fixture"]')).toContainText('1.0 ГБ из 100 ГБ');
  await expect(page.locator('[data-provider-key="proxy:proxy/fixture"]')).toContainText('Срок истёк');
  await expect(page.locator('[data-provider-key="proxy:proxy/fixture"]')).toContainText('Обновлено');
  await expect(page.locator('#mihomo-clash-providers-update-http')).toBeVisible();
  const layout = await page.evaluate(() => {
    const ruleHead = document.querySelector('.xk-mihomo-rules-section .xk-mihomo-rules-section-head').getBoundingClientRect();
    const providerHead = document.querySelector('.xk-mihomo-providers-section .xk-mihomo-rules-section-head').getBoundingClientRect();
    const rules = document.querySelector('#mihomo-clash-rules').getBoundingClientRect();
    const ruleSection = document.querySelector('.xk-mihomo-rules-section').getBoundingClientRect();
    const providerSection = document.querySelector('.xk-mihomo-providers-section').getBoundingClientRect();
    const providerList = document.querySelector('#mihomo-clash-providers-list');
    const tableWrap = document.querySelector('.xk-mihomo-rules-table-wrap');
    return {
      headerBottomDelta: Math.abs(ruleHead.bottom - providerHead.bottom),
      workspaceHeight: rules.height,
      viewportHeight: window.innerHeight,
      sectionHeightDelta: Math.abs(ruleSection.height - providerSection.height),
      providerListOverflow: getComputedStyle(providerList).overflowY,
      tableMaxHeight: getComputedStyle(tableWrap).maxHeight,
    };
  });
  expect(layout.headerBottomDelta).toBeLessThanOrEqual(1);
  expect(layout.workspaceHeight).toBeCloseTo(Math.max(420, layout.viewportHeight - 230), 0);
  expect(layout.sectionHeightDelta).toBeLessThanOrEqual(1);
  expect(layout.providerListOverflow).toBe('auto');
  expect(layout.tableMaxHeight).toBe('none');
  await page.locator('#mihomo-clash-rules-filter').fill('fixture-rules');
  await expect(page.locator('#mihomo-clash-rules-rows tr')).toHaveCount(1);
  await page.locator('#mihomo-clash-provider-kind').selectOption('rule');
  await expect(page.locator('#mihomo-clash-providers-list .xk-mihomo-provider')).toHaveCount(1);
  await page.locator('#mihomo-clash-provider-kind').selectOption('all');

  await page.locator('[data-provider-key="rule:fixture-rules"] [data-mihomo-provider-inspect]').click();
  await expect(page.locator('#mihomo-clash-provider-inspector')).toBeVisible();
  await expect(page.locator('#mihomo-clash-provider-inspector-meta')).toContainText('MRS');
  await expect(page.locator('#mihomo-clash-provider-rules li')).toHaveCount(3);
  await page.locator('#mihomo-clash-provider-filter').fill('filtered');
  await expect(page.locator('#mihomo-clash-provider-rules li')).toHaveCount(1);
  await expect(page.locator('#mihomo-clash-provider-rules')).toContainText('+.filtered.test');

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


test('HTTP provider batch confirms count, limits concurrency, reports progress and result', async ({ page }) => {
  const providers = Array.from({ length: 8 }, (_, index) => ({
    name: `http-${index + 1}`, kind: 'proxy', type: 'Proxy', vehicle_type: 'HTTP',
    updated_at: '2026-08-10T10:00:00Z', count: 1, alive: 1, failed: 0,
    behavior: '', format: '', healthcheck: false, subscription: null,
  }));
  let activeUpdates = 0;
  let maxActiveUpdates = 0;
  const updated = [];
  await page.route('**/api/mihomo/clash/status', (route) => route.fulfill({ json: statusPayload() }));
  await page.route('**/api/mihomo/clash/rules', (route) => route.fulfill({ json: rulesPayload() }));
  await page.route(/\/api\/mihomo\/clash\/providers(?:\/.*)?(?:\?.*)?$/, async (route) => {
    const request = route.request();
    if (request.method() !== 'POST') {
      return route.fulfill({ json: { ok: true, schema_version: 1, total_providers: providers.length, truncated: false, providers } });
    }
    const path = decodeURIComponent(new URL(request.url()).pathname);
    activeUpdates += 1;
    maxActiveUpdates = Math.max(maxActiveUpdates, activeUpdates);
    await new Promise((resolve) => setTimeout(resolve, 120));
    activeUpdates -= 1;
    updated.push(path);
    if (path.includes('/http-6/')) return route.fulfill({ status: 502, json: { ok: false, error: 'fixture failure' } });
    return route.fulfill({ json: { ok: true, schema_version: 1 } });
  });

  await page.goto('/');
  await page.locator('.top-tab-btn[data-view="mihomo"]').click();
  await page.locator('#mihomo-clash-tab-rules').click();
  await expect(page.locator('#mihomo-clash-providers-update-http')).toContainText('Обновить HTTP (8)');
  await expect.poll(() => page.locator('#mihomo-clash-providers-list').evaluate((list) => (
    list.scrollHeight > list.clientHeight && getComputedStyle(list).overflowY === 'auto'
  ))).toBe(true);
  await page.locator('#mihomo-clash-providers-update-http').click();
  await expect(page.locator('#confirm-modal-title')).toContainText('8');
  await expect(page.locator('#confirm-modal-message')).toContainText('8 HTTP providers');
  await page.locator('#confirm-modal-ok-btn').click();
  await expect(page.locator('#mihomo-clash-rules-notice')).toContainText(/Обновление HTTP providers: [1-7]\/8/);
  await expect(page.locator('#mihomo-clash-rules-notice')).toContainText('обновлено 7, с ошибкой 1');
  expect(updated).toHaveLength(8);
  expect(maxActiveUpdates).toBeLessThanOrEqual(2);
});


test('structured logs use a full workspace tab, one on-demand socket, ring buffer and lifecycle', async ({ page }) => {
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
  await page.locator('#mihomo-clash-tab-logs').click();
  await expect(page.locator('#mihomo-clash-panel-logs')).toBeVisible();
  await expect(page.locator('#mihomo-clash-panel-rules')).toBeHidden();
  const workspaceGeometry = await page.evaluate(() => {
    const panel = document.querySelector('#mihomo-clash-panel-logs').getBoundingClientRect();
    const workspace = document.querySelector('#mihomo-clash-logs').getBoundingClientRect();
    return {
      position: getComputedStyle(document.querySelector('#mihomo-clash-logs')).position,
      insidePanel: workspace.left >= panel.left && workspace.right <= panel.right + 1,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  expect(workspaceGeometry.position).not.toBe('fixed');
  expect(workspaceGeometry.insidePanel).toBe(true);
  expect(workspaceGeometry.overflow).toBeLessThanOrEqual(1);
  await expect.poll(() => page.evaluate(() => window.__pr9LogSockets.length)).toBe(1);

  await page.evaluate(() => {
    const socket = window.__pr9LogSockets[0];
    for (let index = 0; index < 505; index += 1) {
      socket.emit({
        type: 'mihomo-clash-logs', schema_version: 1, state: 'live', sequence: index + 1,
        payload: { sequence: index + 1, time: `t-${index}`, level: index % 2 ? 'info' : 'warning', message: `fixture-${index} 192.0.2.10:5000`, fields: { network: 'tcp' }, devices: [{ ip: '192.0.2.10', name: 'Ноутбук' }] },
      });
    }
  });
  await expect(page.locator('#mihomo-clash-logs-list li')).toHaveCount(500);
  await expect(page.locator('#mihomo-clash-logs-list')).not.toContainText('fixture-0');
  await expect(page.locator('#mihomo-clash-logs-list')).toContainText('fixture-504');
  await expect(page.locator('#mihomo-clash-logs-list li').last().locator('.xk-mihomo-device-name')).toHaveText('Ноутбук');
  const logLayout = await page.locator('#mihomo-clash-logs').evaluate((workspace) => {
    const list = workspace.querySelector('#mihomo-clash-logs-list');
    return {
      workspaceHeight: workspace.getBoundingClientRect().height,
      viewportHeight: window.innerHeight,
      overflowY: getComputedStyle(list).overflowY,
      scrollable: list.scrollHeight > list.clientHeight,
      followsTail: Math.abs(list.scrollHeight - list.clientHeight - list.scrollTop) <= 1,
    };
  });
  expect(logLayout.workspaceHeight).toBeCloseTo(Math.max(420, logLayout.viewportHeight - 230), 0);
  expect(logLayout.overflowY).toBe('auto');
  expect(logLayout.scrollable).toBe(true);
  expect(logLayout.followsTail).toBe(true);

  await page.locator('#mihomo-clash-logs-list').evaluate((list) => { list.scrollTop = 0; });
  await page.evaluate(() => window.__pr9LogSockets[0].emit({
    type: 'mihomo-clash-logs', schema_version: 1, state: 'live', sequence: 506,
    payload: { sequence: 506, time: 'after-scroll', level: 'info', message: 'keep-position', fields: {} },
  }));
  await expect(page.locator('#mihomo-clash-logs-list')).toContainText('keep-position');
  await expect.poll(() => page.locator('#mihomo-clash-logs-list').evaluate((list) => list.scrollTop)).toBe(0);

  await page.locator('#mihomo-clash-logs-pause').click();
  await page.evaluate(() => window.__pr9LogSockets[0].emit({
    type: 'mihomo-clash-logs', schema_version: 1, state: 'live', sequence: 507,
    payload: { sequence: 507, time: 'paused', level: 'error', message: 'while-paused', fields: {} },
  }));
  await expect(page.locator('#mihomo-clash-logs-list')).not.toContainText('while-paused');
  await page.locator('#mihomo-clash-logs-pause').click();
  await expect(page.locator('#mihomo-clash-logs-list')).toContainText('while-paused');

  await page.locator('#mihomo-clash-tab-control').click();
  expect(await page.evaluate(() => window.__pr9LogSockets.every((socket) => socket.closed))).toBe(true);
  await expect(page.locator('#mihomo-clash-panel-logs')).toBeHidden();
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

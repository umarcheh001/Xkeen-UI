import { test, expect } from './fixtures.mjs';


const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
  { width: 390, height: 844 },
  { width: 360, height: 800 },
];


function statusPayload({ stream = false } = {}) {
  return {
    ok: true,
    state: 'ready',
    schema_version: 1,
    core: { version: 'Mihomo Meta local-acceptance' },
    runtime: { mode: 'rule' },
    capabilities: {
      status: true,
      proxy_groups: true,
      proxy_select: true,
      proxy_delay: true,
      connections_snapshot: true,
      connections_stream: stream,
      connection_disconnect: true,
    },
  };
}


function groupsPayload(count = 120) {
  const nodes = Array.from({ length: count }, (_, index) => ({
    name: `node-${String(index).padStart(3, '0')}`,
    type: index % 2 ? 'Trojan' : 'VLESS',
    alive: index % 7 !== 0,
    udp: true,
    provider: `provider-${index % 4}`,
    provider_candidates: [`provider-${index % 4}`],
    provider_ambiguous: false,
    delay_ms: 30 + index,
  }));
  return {
    ok: true, schema_version: 1, truncated: false,
    providers: [],
    groups: [{ name: 'LOCAL-LOAD', type: 'Selector', now: 'node-001', hidden: false, selectable: true, nodes }],
  };
}


function connectionsPayload(count = 500, generation = 1, { stream = false } = {}) {
  const connections = Array.from({ length: Math.min(count, 250) }, (_, index) => ({
    id: `conn-${generation}-${index}`,
    metadata: {
      network: index % 5 ? 'tcp' : 'udp', type: 'Mixed', source_ip: `192.0.2.${index % 200 + 1}`,
      source_port: String(30000 + index), source_name: index % 3 ? `device-${index % 20}` : '',
      destination_ip: `198.51.100.${index % 200 + 1}`, destination_port: '443',
      host: `host-${index}.example.test`, sniff_host: '', inbound_name: 'mixed-in', inbound_user: '', process: '',
    },
    upload: generation * 100000 + index * 97,
    download: generation * 500000 + index * 509,
    start: new Date(Date.now() - index * 1000).toISOString(),
    chains: ['AUTO', `node-${index % 12}`], provider_chains: ['fixture-provider'],
    rule: 'DomainSuffix', rule_payload: 'example.test',
  }));
  return {
    ok: true, schema_version: 1,
    download_total: generation * 10000000,
    upload_total: generation * 3000000,
    memory: 48 * 1024 * 1024,
    total_connections: count,
    truncated: count > connections.length,
    connections,
    fallback: { transport: 'http-snapshot', poll_interval_ms: 2000 },
    capabilities: { connections_snapshot: true, connections_stream: stream, connection_disconnect: true },
  };
}


async function mockRuntime(page, { connections = 500, stream = false } = {}) {
  let generation = 1;
  let connectionRequests = 0;
  await page.route('**/api/mihomo/clash/status', (route) => route.fulfill({ json: statusPayload({ stream }) }));
  await page.route('**/api/mihomo/clash/proxy-groups', (route) => route.fulfill({ json: groupsPayload() }));
  await page.route('**/api/mihomo/clash/connections', (route) => {
    connectionRequests += 1;
    generation += 1;
    return route.fulfill({ json: connectionsPayload(connections, generation, { stream }) });
  });
  return { requests: () => connectionRequests };
}


async function openMihomo(page, theme, viewport) {
  await page.setViewportSize(viewport);
  await page.addInitScript((nextTheme) => {
    localStorage.setItem('xkeen-theme', nextTheme);
  }, theme);
  await page.goto('/');
  await page.locator('.top-tab-btn[data-view="mihomo"]').click();
  await expect(page.locator('#mihomo-clash-runtime')).toBeVisible();
}


test('500-connection fallback stays bounded, responsive and idle when hidden', async ({ page }) => {
  const runtime = await mockRuntime(page, { connections: 500, stream: false });
  await openMihomo(page, 'dark', VIEWPORTS[1]);
  await page.locator('#mihomo-clash-tab-connections').click();
  await expect(page.locator('#mihomo-clash-stream-state')).toHaveText('HTTP fallback');
  await expect(page.locator('#mihomo-clash-connection-count')).toHaveText('500');
  await expect(page.locator('#mihomo-clash-connections-rows tr')).toHaveCount(100);
  await expect(page.locator('#mihomo-clash-connections-notice')).toContainText('Показаны первые 250');

  const desktopMetrics = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    rowCount: document.querySelectorAll('#mihomo-clash-connections-rows tr').length,
    heap: performance.memory?.usedJSHeapSize || null,
  }));
  expect(desktopMetrics.overflow).toBeLessThanOrEqual(1);
  expect(desktopMetrics.rowCount).toBe(100);
  if (desktopMetrics.heap) expect(desktopMetrics.heap).toBeLessThan(256 * 1024 * 1024);

  const beforeHidden = runtime.requests();
  await page.locator('#mihomo-clash-tab-config').click();
  await page.waitForTimeout(2300);
  expect(runtime.requests()).toBe(beforeHidden);

  await page.locator('#mihomo-clash-tab-connections').click();
  await expect.poll(runtime.requests).toBeGreaterThan(beforeHidden);
});


for (const theme of ['dark', 'light']) {
  test(`Mihomo runtime has no page overflow across PR8 viewport matrix in ${theme}`, async ({ page }) => {
    await mockRuntime(page, { connections: 100, stream: false });
    await openMihomo(page, theme, VIEWPORTS[0]);
    for (const viewport of VIEWPORTS) {
      await page.setViewportSize(viewport);
      await page.locator('#mihomo-clash-tab-connections').click();
      await expect(page.locator('#mihomo-clash-connections-rows tr').first()).toBeVisible();
      const metrics = await page.evaluate(() => ({
        pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        workspaceRight: document.querySelector('#view-mihomo')?.getBoundingClientRect().right || 0,
        viewport: innerWidth,
        rows: document.querySelectorAll('#mihomo-clash-connections-rows tr').length,
      }));
      expect(metrics.pageOverflow, `${viewport.width}x${viewport.height}`).toBeLessThanOrEqual(1);
      expect(metrics.workspaceRight, `${viewport.width}x${viewport.height}`).toBeLessThanOrEqual(metrics.viewport + .5);
      expect(metrics.rows).toBe(100);
    }
  });
}


test('keyboard, focus, reduced motion and touch targets remain operable', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
  await mockRuntime(page, { connections: 3, stream: false });
  await openMihomo(page, 'dark', VIEWPORTS[4]);

  const connectionsTab = page.locator('#mihomo-clash-tab-connections');
  await connectionsTab.focus();
  await connectionsTab.press('Enter');
  await expect(page.locator('#mihomo-clash-panel-connections')).toBeVisible();

  const firstRow = page.locator('#mihomo-clash-connections-rows tr').first();
  await firstRow.focus();
  await firstRow.press('Enter');
  await expect(page.locator('#mihomo-clash-connection-inspector')).toBeVisible();
  await firstRow.press('Escape');
  await expect(page.locator('#mihomo-clash-connection-inspector')).toBeHidden();

  const audit = await page.evaluate(() => {
    const labelledControls = Array.from(document.querySelectorAll(
      '#mihomo-clash-panel-connections button, #mihomo-clash-panel-connections input, #mihomo-clash-panel-connections select',
    )).filter((node) => node.getClientRects().length > 0).map((node) => ({
      name: node.getAttribute('aria-label') || node.textContent?.trim() || node.getAttribute('placeholder') || '',
      width: node.getBoundingClientRect().width,
      height: node.getBoundingClientRect().height,
    }));
    const animated = Array.from(document.querySelectorAll('#mihomo-clash-panel-connections *'))
      .filter((node) => getComputedStyle(node).animationName !== 'none');
    return { labelledControls, animated: animated.length };
  });
  expect(audit.labelledControls.every((control) => control.name.length > 0)).toBe(true);
  expect(audit.labelledControls.every((control) => control.width >= 24 && control.height >= 24)).toBe(true);
  expect(audit.animated).toBe(0);
});


test('ten subview cycles do not duplicate fallback pollers or listeners', async ({ page }) => {
  const runtime = await mockRuntime(page, { connections: 2, stream: false });
  await openMihomo(page, 'light', VIEWPORTS[1]);
  for (let index = 0; index < 10; index += 1) {
    await page.locator('#mihomo-clash-tab-connections').click();
    await expect(page.locator('#mihomo-clash-stream-state')).toHaveText('HTTP fallback');
    await page.locator('#mihomo-clash-tab-control').click();
  }
  const before = runtime.requests();
  await page.locator('#mihomo-clash-tab-connections').click();
  await expect.poll(runtime.requests).toBeGreaterThan(before);
  const afterBootstrap = runtime.requests();
  await page.waitForTimeout(2200);
  expect(runtime.requests() - afterBootstrap).toBeLessThanOrEqual(2);

  await page.locator('#mihomo-clash-connections-filter').fill('device-1');
  await expect(page.locator('#mihomo-clash-connections-rows tr')).toHaveCount(1);
});

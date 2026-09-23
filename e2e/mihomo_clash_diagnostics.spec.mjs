import { test, expect, selectPanelView } from './fixtures.mjs';


function statusPayload() {
  return {
    ok: true,
    state: 'ready',
    schema_version: 1,
    core: { version: 'Mihomo Meta diagnostics-fixture' },
    runtime: { mode: 'rule' },
    capabilities: {
      status: true,
      runtime_mode_switch: true,
      proxy_groups: true,
      rules: true,
      logs: true,
    },
  };
}


function tracePayload() {
  return {
    ok: true,
    schema_version: 1,
    domain: 'github.com',
    dns: { ok: true, addresses: ['140.82.121.4'], answer_count: 1 },
    matched_rule: {
      index: 1,
      type: 'DOMAIN-SUFFIX',
      payload: 'github.com',
      target: 'AUTO',
      result: 'match',
      reason: 'Домен входит в указанный suffix.',
    },
    route: {
      policy: 'AUTO',
      chain: ['AUTO', 'node-a'],
      leaf: 'node-a',
      leaf_type: 'VLESS',
    },
    steps: [
      { index: 0, type: 'DOMAIN', payload: 'example.test', target: 'DIRECT', result: 'skip', reason: 'Точное совпадение домена.' },
      { index: 1, type: 'DOMAIN-SUFFIX', payload: 'github.com', target: 'AUTO', result: 'match', reason: 'Домен входит в указанный suffix.' },
    ],
    rule_count: 2,
    truncated: false,
  };
}

function trafficPayload() {
  const now = Math.floor(Date.now() / 60000) * 60;
  return {
    ok: true,
    schema_version: 1,
    range_seconds: 86400,
    summary: {
      mihomo_bytes: 900 * 1024 * 1024,
      outside_bytes: 100 * 1024 * 1024,
      total_bytes: 1000 * 1024 * 1024,
      device_count: 2,
      route_count: 2,
      resource_count: 2,
    },
    series: [
      { at: now - 120, mihomo_bytes: 10_000_000, outside_bytes: 2_000_000, total_bytes: 12_000_000 },
      { at: now - 60, mihomo_bytes: 16_000_000, outside_bytes: 1_000_000, total_bytes: 17_000_000 },
      { at: now, mihomo_bytes: 12_000_000, outside_bytes: 3_000_000, total_bytes: 15_000_000 },
    ],
    devices: [
      {
        ip: '192.0.2.10', name: 'Ноутбук', total_bytes: 700_000_000,
        mihomo_bytes: 650_000_000, outside_bytes: 50_000_000,
        routes: [
          { route: 'AUTO', node: 'vpn-a', download: 500_000_000, upload: 50_000_000 },
          { route: 'WORK', node: 'vpn-b', download: 90_000_000, upload: 10_000_000 },
        ],
      },
      {
        ip: '192.0.2.20', name: 'Телевизор', total_bytes: 300_000_000,
        mihomo_bytes: 250_000_000, outside_bytes: 50_000_000,
        routes: [{ route: 'MEDIA', node: 'vpn-c', download: 240_000_000, upload: 10_000_000 }],
      },
    ],
    routes: [
      { route: 'AUTO', node: 'vpn-a', device_count: 1, bytes: 550_000_000 },
      { route: 'MEDIA', node: 'vpn-c', device_count: 1, bytes: 250_000_000 },
    ],
    resources: [
      { resource: 'github.com', routes: ['AUTO'], devices: ['Ноутбук'], bytes: 300_000_000 },
      { resource: 'youtube.com', routes: ['MEDIA'], devices: ['Телевизор'], bytes: 240_000_000 },
    ],
    coverage: {
      mihomo: true,
      keenetic_client_counters: true,
      outside_estimated: true,
      outside_method: 'keenetic_total_minus_mihomo',
    },
    collection: {
      state: 'collecting',
      last_sample_at: now,
      last_error: null,
      sample_interval_seconds: 5,
      client_interval_seconds: 30,
    },
  };
}


async function openDiagnostics(page, viewport) {
  await page.setViewportSize(viewport);
  await page.route('**/api/mihomo/clash/status', (route) => route.fulfill({ json: statusPayload() }));
  await page.route('**/api/mihomo/clash/diagnostics/trace**', (route) => route.fulfill({ json: tracePayload() }));
  await page.route('**/api/mihomo/clash/diagnostics/traffic**', (route) => route.fulfill({ json: trafficPayload() }));
  await page.goto('/');
  await selectPanelView(page, 'mihomo');
  await page.locator('#mihomo-clash-tab-diagnostics').click();
}


for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`diagnostics traces and stays within ${viewport.width}px viewport`, async ({ page }) => {
    await openDiagnostics(page, viewport);
    await expect(page.locator('#mihomo-clash-panel-diagnostics')).toBeVisible();
    await expect(page.locator('#mihomo-clash-traffic-summary')).toContainText('Через Mihomo');
    await expect(page.locator('#mihomo-clash-traffic-devices .xk-mihomo-traffic-device')).toHaveCount(2);
    await expect(page.locator('#mihomo-clash-traffic-devices')).toContainText('vpn-a');
    await expect(page.locator('#mihomo-clash-traffic-resources')).toContainText('github.com');
    await expect(page.locator('.xk-mihomo-traffic-svg path.mihomo')).toHaveCount(1);
    const trafficButtons = await page.evaluate(() => (
      ['mihomo-clash-diagnostics-tab-traffic', 'mihomo-clash-diagnostics-tab-trace', 'mihomo-clash-traffic-refresh'].map((id) => {
        const button = document.getElementById(id);
        const icon = button?.querySelector('.xk-action-icon')?.getBoundingClientRect();
        const label = button?.querySelector('span:not(.xk-action-icon)')?.getBoundingClientRect();
        const bounds = button?.getBoundingClientRect();
        return {
          display: button ? getComputedStyle(button).display : '',
          whiteSpace: button ? getComputedStyle(button).whiteSpace : '',
          iconCenterY: icon ? icon.top + icon.height / 2 : 0,
          labelCenterY: label ? label.top + label.height / 2 : 0,
          contentFits: !!(bounds && icon && label && label.right <= bounds.right + 0.5),
        };
      })
    ));
    for (const button of trafficButtons) {
      expect(button.display).toBe('flex');
      expect(button.whiteSpace).toBe('nowrap');
      expect(Math.abs(button.iconCenterY - button.labelCenterY)).toBeLessThanOrEqual(1);
      expect(button.contentFits).toBe(true);
    }
    await page.locator('#mihomo-clash-diagnostics-tab-trace').click();
    await page.locator('#mihomo-clash-diagnostics-domain').fill('github.com');
    await page.locator('#mihomo-clash-diagnostics-run').click();
    await expect(page.locator('#mihomo-clash-diagnostics-notice')).toContainText('Трассировка завершена');
    await expect(page.locator('#mihomo-clash-diagnostics-summary')).toContainText('140.82.121.4');
    await expect(page.locator('#mihomo-clash-diagnostics-chain')).toHaveText('AUTO → node-a');
    await expect(page.locator('.xk-mihomo-diagnostic-step')).toHaveCount(2);
    await expect(page.locator('#mihomo-clash-diagnostics-copy')).toBeEnabled();

    const metrics = await page.evaluate(() => ({
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      panelRight: document.querySelector('#mihomo-clash-panel-diagnostics')?.getBoundingClientRect().right || 0,
      viewport: innerWidth,
      buttons: ['mihomo-clash-diagnostics-copy', 'mihomo-clash-diagnostics-run'].map((id) => {
        const button = document.getElementById(id);
        const icon = button?.querySelector('.xk-action-icon')?.getBoundingClientRect();
        const label = button?.querySelector('span:not(.xk-action-icon)')?.getBoundingClientRect();
        const bounds = button?.getBoundingClientRect();
        return {
          display: button ? getComputedStyle(button).display : '',
          whiteSpace: button ? getComputedStyle(button).whiteSpace : '',
          iconCenterY: icon ? icon.top + icon.height / 2 : 0,
          labelCenterY: label ? label.top + label.height / 2 : 0,
          contentFits: !!(bounds && icon && label && label.right <= bounds.right + 0.5),
        };
      }),
    }));
    expect(metrics.pageOverflow).toBeLessThanOrEqual(1);
    expect(metrics.panelRight).toBeLessThanOrEqual(metrics.viewport + 0.5);
    for (const button of metrics.buttons) {
      expect(button.display).toBe('flex');
      expect(button.whiteSpace).toBe('nowrap');
      expect(Math.abs(button.iconCenterY - button.labelCenterY)).toBeLessThanOrEqual(1);
      expect(button.contentFits).toBe(true);
    }
  });
}

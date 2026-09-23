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
    demo: true,
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
      { at: now - 120, mihomo_bytes: 10_000_000, outside_bytes: 2_000_000, download_bytes: 10_500_000, upload_bytes: 1_500_000, total_bytes: 12_000_000 },
      { at: now - 60, mihomo_bytes: 16_000_000, outside_bytes: 1_000_000, download_bytes: 15_500_000, upload_bytes: 1_500_000, total_bytes: 17_000_000 },
      { at: now, mihomo_bytes: 12_000_000, outside_bytes: 3_000_000, download_bytes: 13_500_000, upload_bytes: 1_500_000, total_bytes: 15_000_000 },
    ],
    devices: [
      {
        ip: '192.0.2.10', name: 'Ноутбук', total_bytes: 700_000_000,
        mihomo_bytes: 650_000_000, outside_bytes: 50_000_000,
        total_download: 640_000_000, total_upload: 60_000_000,
        mihomo_download: 600_000_000, mihomo_upload: 50_000_000,
        outside_download: 40_000_000, outside_upload: 10_000_000,
        routes: [
          { route: 'AUTO', node: 'vpn-a', download: 500_000_000, upload: 50_000_000 },
          { route: 'WORK', node: 'vpn-b', download: 90_000_000, upload: 10_000_000 },
        ],
      },
      {
        ip: '192.0.2.20', name: 'Телевизор', total_bytes: 300_000_000,
        mihomo_bytes: 250_000_000, outside_bytes: 50_000_000,
        total_download: 285_000_000, total_upload: 15_000_000,
        mihomo_download: 240_000_000, mihomo_upload: 10_000_000,
        outside_download: 45_000_000, outside_upload: 5_000_000,
        routes: [{ route: 'MEDIA', node: 'vpn-c', download: 240_000_000, upload: 10_000_000 }],
      },
    ],
    routes: [
      { route: 'AUTO', node: 'vpn-a', device_count: 1, device_ips: ['192.0.2.10'], download: 500_000_000, upload: 50_000_000, bytes: 550_000_000, breakdown: [{ ip: '192.0.2.10', name: 'Ноутбук', download: 500_000_000, upload: 50_000_000 }] },
      { route: 'MEDIA', node: 'vpn-c', device_count: 1, device_ips: ['192.0.2.20'], download: 240_000_000, upload: 10_000_000, bytes: 250_000_000, breakdown: [{ ip: '192.0.2.20', name: 'Телевизор', download: 240_000_000, upload: 10_000_000 }] },
    ],
    resources: [
      { resource: 'github.com', routes: ['AUTO'], devices: ['Ноутбук'], device_ips: ['192.0.2.10'], download: 290_000_000, upload: 10_000_000, bytes: 300_000_000, breakdown: [{ ip: '192.0.2.10', name: 'Ноутбук', route: 'AUTO', download: 290_000_000, upload: 10_000_000 }] },
      { resource: 'youtube.com', routes: ['MEDIA'], devices: ['Телевизор'], device_ips: ['192.0.2.20'], download: 235_000_000, upload: 5_000_000, bytes: 240_000_000, breakdown: [{ ip: '192.0.2.20', name: 'Телевизор', route: 'MEDIA', download: 235_000_000, upload: 5_000_000 }] },
    ],
    coverage: {
      mihomo: true,
      keenetic_client_counters: true,
      outside_estimated: true,
      outside_method: 'keenetic_total_minus_mihomo',
    },
    quality: {
      state: 'demo',
      classification_percent: 90,
      confirmed_bytes: 900_000_000,
      estimated_bytes: 100_000_000,
      unclassified_bytes: 0,
      connections: { state: 'demo', samples: 100, errors: 0, age_seconds: 0 },
      clients: { state: 'demo', samples: 100, errors: 0, age_seconds: 0 },
      storage: { database_size_bytes: 2_000_000, rows: {} },
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

function emptyTrafficPayload() {
  const now = Math.floor(Date.now() / 60000) * 60;
  return {
    ok: true,
    schema_version: 1,
    range_seconds: 86400,
    summary: {
      mihomo_bytes: 0, outside_bytes: 0, total_bytes: 0,
      download_bytes: 0, upload_bytes: 0,
      device_count: 0, route_count: 0, resource_count: 0,
    },
    series: [],
    devices: [],
    routes: [],
    resources: [],
    coverage: { mihomo: true, keenetic_client_counters: false, outside_estimated: true },
    quality: {
      state: 'partial',
      classification_percent: null,
      connections: { state: 'live', samples: 2, errors: 0, age_seconds: 0 },
      clients: { state: 'unavailable', samples: 2, errors: 0, age_seconds: 0 },
      storage: { database_size_bytes: 72 * 1024, rows: {} },
    },
    collection: {
      state: 'collecting',
      last_sample_at: now,
      last_error: null,
      sample_interval_seconds: 10,
      client_interval_seconds: 30,
    },
  };
}


async function openDiagnostics(page, viewport, analytics = trafficPayload()) {
  await page.setViewportSize(viewport);
  await page.route('**/api/mihomo/clash/status', (route) => route.fulfill({ json: statusPayload() }));
  await page.route('**/api/mihomo/clash/diagnostics/trace**', (route) => route.fulfill({ json: tracePayload() }));
  await page.route('**/api/mihomo/clash/diagnostics/traffic**', (route) => route.fulfill({ json: analytics }));
  await page.goto('/');
  await selectPanelView(page, 'mihomo');
  await page.locator('#mihomo-clash-tab-diagnostics').click();
}


for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`diagnostics traces and stays within ${viewport.width}px viewport`, async ({ page }) => {
    await openDiagnostics(page, viewport);
    await expect(page.locator('#mihomo-clash-panel-diagnostics')).toBeVisible();
    await expect(page.locator('#mihomo-clash-traffic-summary')).toContainText('Через Mihomo');
    await expect(page.locator('#mihomo-clash-traffic-notice')).toContainText('Демо-режим');
    await expect(page.locator('#mihomo-clash-traffic-devices .xk-mihomo-traffic-device')).toHaveCount(2);
    await expect(page.locator('#mihomo-clash-traffic-devices')).toContainText('vpn-a');
    const diagnosticsTabs = page.locator('.xk-mihomo-groups-toolbar #mihomo-clash-diagnostics-tabs');
    await expect(diagnosticsTabs).toBeVisible();
    if (viewport.width >= 800) {
      const toolbarOrder = await page.evaluate(() => (
        ['.xk-mihomo-parameters', '#mihomo-clash-diagnostics-tabs', '#mihomo-clash-tab-config']
          .map((selector) => document.querySelector(selector)?.getBoundingClientRect().left ?? -1)
      ));
      expect(toolbarOrder[0]).toBeLessThan(toolbarOrder[1]);
      expect(toolbarOrder[1]).toBeLessThan(toolbarOrder[2]);
    }
    const trafficTitle = page.locator('#mihomo-clash-diagnostics-title .xk-mihomo-traffic-title-tooltip');
    await expect(trafficTitle).toHaveAttribute('data-tooltip', /Локальная история по устройствам, маршрутам\/VPN и запрошенным доменам/);
    if (viewport.width >= 800) {
      await trafficTitle.hover();
      await expect(trafficTitle).toHaveCSS('cursor', 'help');
    }
    await expect(page.getByRole('heading', { name: 'Запрошенные ресурсы' })).toHaveCount(0);
    await expect(page.locator('.xk-mihomo-traffic-svg path.mihomo')).toHaveCount(1);
    await expect(page.locator('#mihomo-clash-traffic-quality')).toContainText('90%');
    await expect(page.locator('#mihomo-clash-traffic-chart-stats .xk-mihomo-traffic-chart-stat')).toHaveCount(2);
    await expect(page.locator('#mihomo-clash-traffic-chart path.mihomo')).toHaveCount(1);
    await page.locator('[data-mihomo-traffic-series="download"]').click();
    await expect(page.locator('#mihomo-clash-traffic-chart-stats .xk-mihomo-traffic-chart-stat')).toHaveCount(3);
    await page.locator('[data-mihomo-traffic-series="upload"]').click();
    await page.mouse.move(0, 0);
    const seriesState = await page.locator('[data-mihomo-traffic-series]').evaluateAll((buttons) => buttons.map((button) => ({
      pressed: button.getAttribute('aria-pressed'),
      active: button.classList.contains('is-active'),
      background: getComputedStyle(button).backgroundColor,
      color: getComputedStyle(button).color,
    })));
    expect(seriesState.every((item) => item.pressed === 'true' && item.active)).toBe(true);
    expect(new Set(seriesState.map((item) => item.background)).size).toBe(1);
    expect(new Set(seriesState.map((item) => item.color)).size).toBe(1);
    if (viewport.width >= 800) {
      const hit = page.locator('#mihomo-clash-traffic-chart [data-chart-hit]');
      const box = await hit.boundingBox();
      await hit.dispatchEvent('pointermove', {
        clientX: (box?.x || 0) + Math.min(260, (box?.width || 300) - 4),
        clientY: (box?.y || 0) + 80,
      });
      await expect(page.locator('#mihomo-clash-traffic-tooltip')).toBeVisible();
      await expect(page.locator('#mihomo-clash-traffic-tooltip')).toContainText('Загрузка');
    }
    await page.locator('#mihomo-clash-traffic-device').selectOption('192.0.2.10');
    await expect(page.locator('#mihomo-clash-traffic-devices .xk-mihomo-traffic-device')).toHaveCount(1);
    await expect(page.locator('#mihomo-clash-traffic-devices')).not.toContainText('Телевизор');
    await expect(page.locator('#mihomo-clash-traffic-routes tr')).toHaveCount(1);
    const jsonDownload = page.waitForEvent('download');
    await page.locator('#mihomo-clash-traffic-export-json').click();
    expect((await jsonDownload).suggestedFilename()).toMatch(/^xkeen-mihomo-traffic-\d{4}-\d{2}-\d{2}\.json$/);
    await page.locator('#mihomo-clash-traffic-filters-reset').click();
    await expect(page.locator('#mihomo-clash-traffic-devices .xk-mihomo-traffic-device')).toHaveCount(2);
    await page.locator('#mihomo-clash-traffic-route').selectOption(JSON.stringify(['AUTO', 'vpn-a']));
    await expect(page.locator('#mihomo-clash-traffic-routes tr')).toHaveCount(1);
    const csvDownload = page.waitForEvent('download');
    await page.locator('#mihomo-clash-traffic-export-csv').click();
    expect((await csvDownload).suggestedFilename()).toMatch(/^xkeen-mihomo-traffic-\d{4}-\d{2}-\d{2}\.csv$/);
    await page.locator('#mihomo-clash-traffic-filters-reset').click();
    const trafficButtons = await page.evaluate(() => (
      [
        'mihomo-clash-diagnostics-tab-traffic',
        'mihomo-clash-diagnostics-tab-trace',
        'mihomo-clash-traffic-refresh',
        'mihomo-clash-traffic-filters-reset',
        'mihomo-clash-traffic-export-csv',
        'mihomo-clash-traffic-export-json',
      ].map((id) => {
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
    if (viewport.width >= 1281) {
      const summaryRows = await page.locator('#mihomo-clash-traffic-summary .xk-mihomo-diagnostic-stat').evaluateAll(
        (cards) => [...new Set(cards.map((card) => Math.round(card.getBoundingClientRect().top)))],
      );
      expect(summaryRows).toHaveLength(1);
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


test('empty analytics keeps six desktop metrics compact and separates filters from quality', async ({ page }) => {
  await openDiagnostics(page, { width: 1440, height: 900 }, emptyTrafficPayload());
  await expect(page.locator('#mihomo-clash-traffic-summary .xk-mihomo-diagnostic-stat')).toHaveCount(6);
  const layout = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('#mihomo-clash-traffic-summary .xk-mihomo-diagnostic-stat'));
    const chart = document.querySelector('#mihomo-clash-traffic-chart')?.getBoundingClientRect();
    const filters = document.querySelector('.xk-mihomo-traffic-filters')?.getBoundingClientRect();
    const quality = document.querySelector('#mihomo-clash-traffic-quality')?.getBoundingClientRect();
    return {
      summaryRows: new Set(cards.map((card) => Math.round(card.getBoundingClientRect().top))).size,
      chartHeight: chart?.height || 0,
      filterQualityGap: filters && quality ? quality.top - filters.bottom : 0,
      qualityChartGap: quality && document.querySelector('.xk-mihomo-traffic-chart-section .xk-mihomo-diagnostic-steps-head')
        ? document.querySelector('.xk-mihomo-traffic-chart-section .xk-mihomo-diagnostic-steps-head').getBoundingClientRect().top - quality.bottom
        : 0,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  expect(layout.summaryRows).toBe(1);
  expect(layout.chartHeight).toBeLessThanOrEqual(80);
  expect(layout.filterQualityGap).toBeGreaterThanOrEqual(20);
  expect(layout.qualityChartGap).toBeGreaterThanOrEqual(20);
  expect(layout.overflow).toBeLessThanOrEqual(1);
});

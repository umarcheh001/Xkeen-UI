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
      matched_mihomo_bytes: 900_000_000,
      unmatched_mihomo_bytes: 0,
      unmatched_device_count: 0,
      source_age_seconds: { mihomo: 0, keenetic: 0 },
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

function mismatchTrafficPayload() {
  const payload = trafficPayload();
  const unmatched = 100 * 1024 * 1024;
  payload.summary = {
    ...payload.summary,
    mihomo_bytes: payload.summary.mihomo_bytes + unmatched,
    outside_bytes: 0,
    device_count: 3,
  };
  payload.devices.push({
    ip: 'unknown', name: 'Неизвестное устройство', total_bytes: unmatched,
    mihomo_bytes: unmatched, outside_bytes: 0,
    total_download: 0, total_upload: 0,
    mihomo_download: unmatched, mihomo_upload: 0,
    outside_download: 0, outside_upload: 0,
    unmatched_mihomo_bytes: unmatched,
    routes: [{ route: 'AUTO', node: 'vpn-a', download: unmatched, upload: 0 }],
  });
  payload.coverage = {
    ...payload.coverage,
    matched_mihomo_bytes: 900 * 1024 * 1024,
    unmatched_mihomo_bytes: unmatched,
    unmatched_device_count: 1,
  };
  return payload;
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
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await page.screenshot({ path: `C:/Users/umar/.codex/visualizations/2026/10/28/01a18204-0351-7571-be5b-5b23a52b066e/mihomo-traffic-compact-final-${viewport.width}.png` });
    if (viewport.width < 521) {
      await page.locator('.xk-mihomo-traffic-quality').scrollIntoViewIfNeeded();
      await page.screenshot({ path: 'C:/Users/umar/.codex/visualizations/2026/10/28/01a18204-0351-7571-be5b-5b23a52b066e/mihomo-traffic-compact-mobile-quality.png' });
    }
    if (viewport.width < 521) {
      const summaryColumns = await page.locator('#mihomo-clash-traffic-summary').evaluate((element) => (
        getComputedStyle(element).gridTemplateColumns.split(' ').length
      ));
      expect(summaryColumns).toBe(2);
      const qualityColumns = await page.locator('#mihomo-clash-traffic-quality').evaluate((element) => (
        getComputedStyle(element).gridTemplateColumns.split(' ').length
      ));
      expect(qualityColumns).toBe(2);
      const controlsAligned = await page.evaluate(() => {
        const range = document.querySelector('#mihomo-clash-traffic-range')?.getBoundingClientRect();
        const refresh = document.querySelector('#mihomo-clash-traffic-refresh')?.getBoundingClientRect();
        return Math.abs((range?.top || 0) - (refresh?.top || 0)) <= 1;
      });
      expect(controlsAligned).toBe(true);
      const actionsAligned = await page.locator('.xk-mihomo-traffic-filter-actions button').evaluateAll((buttons) => (
        new Set(buttons.map((button) => Math.round(button.getBoundingClientRect().top))).size === 1
      ));
      expect(actionsAligned).toBe(true);
    }
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
    await expect(page.locator('.xk-mihomo-traffic-svg path[data-series-path="mihomo"]')).toHaveCount(1);
    await expect(page.locator('#mihomo-clash-traffic-quality')).toContainText('90%');
    await expect(page.locator('#mihomo-clash-traffic-chart-stats .xk-mihomo-traffic-chart-stat')).toHaveCount(4);
    if (viewport.width < 521) {
      const statColumns = await page.locator('#mihomo-clash-traffic-chart-stats').evaluate((element) => (
        getComputedStyle(element).gridTemplateColumns.split(' ').length
      ));
      expect(statColumns).toBe(2);
    }
    await expect(page.locator('#mihomo-clash-traffic-chart path[data-series-path="mihomo"]')).toHaveCount(1);
    await expect(page.locator('#mihomo-clash-traffic-chart [data-chart-area]')).toHaveCount(2);
    expect(await page.locator('#mihomo-clash-traffic-chart .grid-vertical').count()).toBeGreaterThanOrEqual(3);
    await expect(page.locator('#mihomo-clash-traffic-chart path.download')).toHaveCount(1);
    await page.locator('[data-mihomo-traffic-series="unmatched"]').click();
    await expect(page.locator('#mihomo-clash-traffic-chart path.unmatched')).toHaveCount(1);
    await page.locator('[data-mihomo-traffic-series="unmatched"]').click();
    await page.locator('[data-mihomo-traffic-series="download"]').click();
    await expect(page.locator('#mihomo-clash-traffic-chart-stats .xk-mihomo-traffic-chart-stat')).toHaveCount(3);
    await page.locator('[data-mihomo-traffic-series="upload"]').click();
    await page.locator('[data-mihomo-traffic-series="download"]').click();
    await page.locator('[data-mihomo-traffic-series="upload"]').click();
    await page.mouse.move(0, 0);
    // The last clicked button animates its background; read the state only
    // after the transition has settled instead of mid-way (rgba … 0.925).
    await expect.poll(() => page.locator('[data-mihomo-traffic-series][aria-pressed="true"]').evaluateAll(
      (buttons) => new Set(buttons.map((button) => getComputedStyle(button).backgroundColor)).size,
    )).toBe(1);
    const seriesState = await page.locator('[data-mihomo-traffic-series]').evaluateAll((buttons) => buttons.map((button) => ({
      key: button.dataset.mihomoTrafficSeries,
      pressed: button.getAttribute('aria-pressed'),
      active: button.classList.contains('is-active'),
      background: getComputedStyle(button).backgroundColor,
      color: getComputedStyle(button).color,
      shadow: getComputedStyle(button).boxShadow,
    })));
    expect(seriesState.filter((item) => item.key !== 'unmatched').every((item) => item.pressed === 'true' && item.active)).toBe(true);
    expect(seriesState.find((item) => item.key === 'unmatched')).toMatchObject({ pressed: 'false', active: false });
    const activeSeriesState = seriesState.filter((item) => item.key !== 'unmatched');
    expect(new Set(activeSeriesState.map((item) => item.background)).size).toBe(1);
    expect(new Set(activeSeriesState.map((item) => item.color)).size).toBe(1);
    const inactiveSeriesState = seriesState.find((item) => item.key === 'unmatched');
    expect(activeSeriesState[0].background).not.toBe(inactiveSeriesState.background);
    expect(activeSeriesState[0].shadow).toContain('inset');
    expect(inactiveSeriesState.shadow).not.toContain('inset');
    if (viewport.width >= 800) {
      const hit = page.locator('#mihomo-clash-traffic-chart [data-chart-hit]');
      const box = await hit.boundingBox();
      await hit.dispatchEvent('pointermove', {
        clientX: (box?.x || 0) + Math.min(260, (box?.width || 300) - 4),
        clientY: (box?.y || 0) + 80,
      });
      await expect(page.locator('#mihomo-clash-traffic-tooltip')).toBeVisible();
      await expect(page.locator('#mihomo-clash-traffic-tooltip')).toContainText('Загрузка');
      await expect(page.locator('#mihomo-clash-traffic-chart .chart-marker:not([hidden])')).toHaveCount(4);
      await page.locator('#mihomo-clash-traffic-chart').focus();
      await page.keyboard.press('Home');
      await expect(page.locator('#mihomo-clash-traffic-tooltip')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.locator('#mihomo-clash-traffic-tooltip')).toBeHidden();
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


test('traffic analytics offers a month range and clear button feedback', async ({ page }) => {
  await openDiagnostics(page, { width: 1440, height: 900 });
  const range = page.locator('#mihomo-clash-traffic-range');
  await expect(range.locator('option[value="7d"]')).toHaveText('Неделя');
  await expect(range.locator('option[value="14d"]')).toHaveText('14 дней');
  await expect(range.locator('option[value="30d"]')).toHaveText('Месяц');
  const request = page.waitForRequest((candidate) => (
    candidate.url().includes('/api/mihomo/clash/diagnostics/traffic?range=30d')
  ));
  await range.selectOption('30d');
  await request;
  for (const selector of ['#mihomo-clash-traffic-refresh', '#mihomo-clash-traffic-export-csv', '[data-mihomo-traffic-series="unmatched"]']) {
    const button = page.locator(selector);
    const initial = await button.evaluate((element) => getComputedStyle(element).transform);
    await button.hover();
    await expect.poll(() => button.evaluate((element) => getComputedStyle(element).transform)).not.toBe(initial);
  }
  await expect(page.locator('#mihomo-clash-traffic-quality .xk-mihomo-traffic-quality-item')).toHaveCount(7);
  const columns = await page.locator('#mihomo-clash-traffic-quality').evaluate((element) => (
    getComputedStyle(element).gridTemplateColumns.split(' ').length
  ));
  expect(columns).toBe(7);
  const density = await page.evaluate(() => {
    const bounds = (selector) => document.querySelector(selector)?.getBoundingClientRect();
    const summary = bounds('#mihomo-clash-traffic-summary .xk-mihomo-diagnostic-stat');
    const quality = bounds('.xk-mihomo-traffic-quality');
    const filters = document.querySelector('.xk-mihomo-traffic-filters > label');
    const filterLabel = filters?.querySelector('span')?.getBoundingClientRect();
    const filterSelect = filters?.querySelector('select')?.getBoundingClientRect();
    return {
      summaryHeight: summary?.height || 0,
      qualityHeight: quality?.height || 0,
      filterAlignment: Math.abs((filterLabel?.top || 0) - (filterSelect?.top || 0)),
      chartStatHeight: bounds('.xk-mihomo-traffic-chart-stat')?.height || 0,
    };
  });
  expect(density.summaryHeight).toBeLessThanOrEqual(70);
  expect(density.qualityHeight).toBeLessThanOrEqual(125);
  expect(density.filterAlignment).toBeLessThanOrEqual(1);
  expect(density.chartStatHeight).toBeLessThanOrEqual(60);
  await expect(page.locator('#mihomo-clash-traffic-notice')).toHaveCSS('border-top-style', 'solid');
  await expect(page.locator('.xk-mihomo-traffic-chart-section')).toHaveCSS('background-color', await page.locator('.xk-mihomo-traffic-quality').evaluate((element) => getComputedStyle(element).backgroundColor));
});

test('traffic chart preserves empty five-minute buckets on the time axis', async ({ page }) => {
  const payload = trafficPayload();
  payload.series[1] = { ...payload.series[1], mihomo_bytes: 0, outside_bytes: 0, download_bytes: 0, upload_bytes: 0, total_bytes: 0 };
  await openDiagnostics(page, { width: 1440, height: 900 }, payload);
  const hit = page.locator('#mihomo-clash-traffic-chart [data-chart-hit]');
  const box = await hit.boundingBox();
  await hit.dispatchEvent('pointermove', { clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 });
  await expect(page.locator('#mihomo-clash-traffic-tooltip .xk-mihomo-traffic-tooltip-row b')).toHaveText(['0 Б', '0 Б', '0 Б', '0 Б']);
  await expect(page.locator('.xk-mihomo-traffic-chart-stat[data-series="mihomo"] dd').nth(1)).toHaveText('6.99 МБ');
});

test('traffic chart renders a dense day with peaks and a collection gap', async ({ page }) => {
  const payload = trafficPayload();
  const end = Math.floor(Date.now() / 300000) * 300;
  payload.series = Array.from({ length: 288 }, (_, index) => {
    const gap = index >= 85 && index <= 88;
    const wave = 1 + .28 * Math.sin(index * .16) + .12 * Math.sin(index * .71);
    const burst = index % 47 >= 42 ? 2.4 : 1;
    const download = gap ? 0 : Math.round(6_000_000 * wave * burst);
    const upload = gap ? 0 : Math.round(1_200_000 * (1 + .3 * Math.sin(index * .21)));
    const total = download + upload;
    const mihomo = Math.round(total * .78);
    return {
      at: end - (287 - index) * 300,
      mihomo_bytes: mihomo,
      outside_bytes: total - mihomo,
      download_bytes: download,
      upload_bytes: upload,
      total_bytes: total,
    };
  });
  await openDiagnostics(page, { width: 1440, height: 900 }, payload);
  const line = page.locator('#mihomo-clash-traffic-chart [data-series-path="mihomo"]');
  await expect(line).toHaveCount(1);
  expect((await line.getAttribute('d')).match(/\b[ML]\b/g)).toHaveLength(288);
  await expect(page.locator('#mihomo-clash-traffic-chart .grid-vertical')).toHaveCount(7);
  await page.locator('#mihomo-clash-traffic-chart').focus();
  await page.keyboard.press('Home');
  await expect(page.locator('#mihomo-clash-traffic-tooltip')).toBeVisible();
  await page.keyboard.press('End');
  await expect(page.locator('#mihomo-clash-traffic-tooltip')).toBeVisible();
});

test('traffic device cards keep natural heights in balanced columns', async ({ page }) => {
  const payload = trafficPayload();
  const base = payload.devices[0];
  const route = base.routes[0];
  payload.devices = [
    { ...base, name: 'Много маршрутов', routes: Array.from({ length: 9 }, (_, index) => ({ ...route, node: `vpn-${index}` })) },
    { ...base, ip: '192.0.2.11', name: 'Один маршрут', routes: [route] },
    { ...base, ip: '192.0.2.12', name: 'Без маршрутов', mihomo_bytes: 0, outside_bytes: base.total_bytes, routes: [] },
    { ...base, ip: '192.0.2.13', name: 'Несколько маршрутов', routes: base.routes },
  ];
  await openDiagnostics(page, { width: 1440, height: 900 }, payload);
  const cards = page.locator('#mihomo-clash-traffic-devices .xk-mihomo-traffic-device');
  await expect(cards).toHaveCount(4);
  const layout = await cards.evaluateAll((elements) => elements.map((element) => {
    const box = element.getBoundingClientRect();
    return { left: Math.round(box.left), top: box.top, bottom: box.bottom, height: box.height };
  }));
  expect(new Set(layout.map((box) => box.left)).size).toBe(2);
  expect(layout[0].height).toBeGreaterThan(layout[1].height * 2);
  expect(layout[2].height).toBeLessThan(160);
  const internalGaps = await cards.evaluateAll((elements) => elements.map((element) => {
    const header = element.querySelector('header')?.getBoundingClientRect();
    const split = element.querySelector('.xk-mihomo-device-split')?.getBoundingClientRect();
    return split && header ? split.top - header.bottom : 0;
  }));
  expect(Math.max(...internalGaps)).toBeLessThanOrEqual(12);
  for (const left of new Set(layout.map((box) => box.left))) {
    const column = layout.filter((box) => box.left === left).sort((a, b) => a.top - b.top);
    for (let index = 1; index < column.length; index += 1) {
      expect(column[index].top - column[index - 1].bottom).toBeLessThanOrEqual(10);
    }
  }
  await expect(cards.nth(2)).toContainText('Маршруты ещё не накоплены');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(cards).toHaveCount(4);
  const mobileColumns = await page.locator('#mihomo-clash-traffic-devices').evaluate((element) => getComputedStyle(element).columnCount);
  expect(mobileColumns).toBe('1');
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
});


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

test('unmatched Mihomo bytes stay in the canonical total', async ({ page }) => {
  await openDiagnostics(page, { width: 1440, height: 900 }, mismatchTrafficPayload());
  const cards = page.locator('#mihomo-clash-traffic-summary .xk-mihomo-diagnostic-stat');
  await expect(cards).toHaveCount(6);
  await expect(cards.nth(0)).toContainText('1000 МБ');
  await expect(cards.nth(3)).toContainText('1000 МБ');
  await expect(page.locator('#mihomo-clash-traffic-devices')).toContainText('Неизвестное устройство');
  await expect(page.locator('#mihomo-clash-traffic-quality')).toContainText('Без пары');
});

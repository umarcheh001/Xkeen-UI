import { test, expect } from './fixtures.mjs';

// The "Модемы" tab of the diagnostics window (shadow DOM). The tab exists only when the
// connection list or the interfaces name a mobile modem, so the summary carries both.

const modems = [
  { id: 'UsbQmi0', name: 'BEELINE', model: 'Snapdragon X55', operator: 'Beeline', connected: true, connection_state: 'connected', default_route: true },
  { id: 'UsbQmi1', name: 'T2_STATIC', model: 'Snapdragon X20', operator: 'Tele2', connected: true, connection_state: 'connected', default_route: false },
];

const summaryWithModems = {
  ok: true, ts: 1792602000, status: { tone: 'ok', problems: [] }, uptime_s: 1000, values: {}, zones: {},
  links: [{ id: 'UsbQmi0', label: 'Билайн', kernel: 'wwan0', primary: true, connected: true, tariff: null }],
  cards: {}, rci_available: true,
  router: { internet: { available: true, internet: true, gateway: true, dns: true, captive: true },
    interfaces: { available: true, count: 2, items: [{ name: 'UsbQmi0', kind: 'wan', online: true }, { name: 'UsbQmi1', kind: 'wan', online: true }] } },
};

async function openModems(page, items = modems) {
  await page.route('**/api/system/resources', route => route.fulfill({ json: {
    ok: true, cpu: { percent: 11.7, cores: 2 }, memory: { percent: 48 }, sampled_at: Date.now() / 1000,
  } }));
  await page.route('**/api/system/summary', route => route.fulfill({ json: summaryWithModems }));
  await page.route('**/api/system/hardware', route => route.fulfill({ status: 503, json: { ok: false } }));
  await page.route('**/api/system/history*', route => route.fulfill({ status: 503, json: { ok: false } }));
  await page.route('**/api/system/events*', route => route.fulfill({ json: { ok: true, events: [], active: [] } }));
  await page.route('**/api/system/router/lte', route => route.fulfill({ json: {
    ok: true, available: true, count: items.length, items,
  } }));
  await page.goto('/');
  await expect(page.locator('#xk-resource-monitor')).toHaveAttribute('data-state', 'ready');
  if (await page.locator('#xk-resource-monitor').isVisible()) {
    await page.locator('#xk-resource-monitor').click();
  } else {
    await page.locator('#xk-resource-monitor').evaluate(button => button.click());
  }
  await expect(page.locator('#xk-resource-dashboard-modal')).toBeVisible();
  const view = page.locator('#xk-resource-dashboard-view');
  await view.locator('[data-tab="modems"]').click();
  await expect(view.locator('.xkt-modem')).toHaveCount(items.length);
  return {
    view,
    beeline: view.locator('.xkt-modem[data-modem-id="UsbQmi0"]'),
    tele2: view.locator('.xkt-modem[data-modem-id="UsbQmi1"]'),
  };
}

for (const width of [1440, 390]) {
  test(`LTE probe stays read-only at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const errors = [];
    const controlRequests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      if (request.url().includes('/api/system/router/lte/')) controlRequests.push(request.url());
    });
    await page.route('**/api/system/router/lte/UsbQmi1/probe', route => route.fulfill({ json: {
      modem: { id: 'UsbQmi1', name: 'T2_STATIC' }, preferred_transport: 'qmi',
      transports: [{ kind: 'qmi', available: true }], sampled_at: 1,
    } }));

    const { view, beeline, tele2 } = await openModems(page);

    await expect(view.locator('#xkt-panel-modems .xkt-note')).toContainText('Перезапуск из панели отключён');
    await expect(view.getByRole('button', { name: 'Перезапустить модем' })).toHaveCount(0);
    await expect(beeline.locator('.xkt-probe-status')).toBeEmpty();
    await tele2.getByRole('button', { name: 'Проверить управление' }).click();
    await expect(tele2.locator('.xkt-probe-status')).toContainText('QMI доступен');
    await expect(beeline.locator('.xkt-probe-status')).toBeEmpty();
    expect(controlRequests).toEqual([expect.stringContaining('/api/system/router/lte/UsbQmi1/probe')]);
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test('offline modem can be probed but remains reported as offline', async ({ page }) => {
  const offline = { ...modems[1], connected: false, connection_state: 'disconnected' };
  await page.route('**/api/system/router/lte/UsbQmi1/probe', route => route.fulfill({ json: {
    modem: { id: 'UsbQmi1', name: 'T2_STATIC' }, preferred_transport: 'qmi',
    transports: [{ kind: 'qmi', available: true }], sampled_at: 1,
  } }));

  const { tele2 } = await openModems(page, [modems[0], offline]);

  await expect(tele2.locator('.xkt-probe-status')).toContainText('не подключён');
  await tele2.getByRole('button', { name: 'Проверить управление' }).click();
  await expect(tele2.locator('.xkt-probe-status')).toContainText('не подключён');
  await expect(tele2.getByRole('button', { name: 'Перезапустить модем' })).toHaveCount(0);
});

test('missing QMI tool explains how to install the required package', async ({ page }) => {
  await page.route('**/api/system/router/lte/UsbQmi1/probe', route => route.fulfill({ json: {
    modem: { id: 'UsbQmi1', name: 'T2_STATIC' }, preferred_transport: null,
    transports: [{ kind: 'qmi', available: false }], code: 'qmi_tool_missing', sampled_at: 1,
  } }));

  const { tele2 } = await openModems(page);
  await tele2.getByRole('button', { name: 'Проверить управление' }).click();

  await expect(tele2.locator('.xkt-probe-status')).toContainText('Установите пакет qmi-utils');
  await expect(tele2.locator('.xkt-probe-status')).toContainText('opkg install qmi-utils');
  await expect(tele2.getByRole('button', { name: 'Перезапустить модем' })).toHaveCount(0);
});

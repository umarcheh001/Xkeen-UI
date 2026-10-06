import { test, expect } from './fixtures.mjs';

const modems = [
  { id: 'UsbQmi0', name: 'BEELINE', model: 'Snapdragon X55', operator: 'Beeline', connected: true, connection_state: 'connected', default_route: true },
  { id: 'UsbQmi1', name: 'T2_STATIC', model: 'Snapdragon X20', operator: 'Tele2', connected: true, connection_state: 'connected', default_route: false },
];

async function openModems(page, items = modems) {
  await page.route('**/api/system/resources', route => route.fulfill({ json: {
    ok: true, cpu: { percent: 11.7, cores: 2 }, memory: { percent: 48 }, sampled_at: Date.now() / 1000,
  } }));
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
  await page.locator('#xk-lte-action').click();
  await expect(page.locator('.xk-lte-modem')).toHaveCount(items.length);
  return {
    beeline: page.locator('.xk-lte-modem[data-modem-id="UsbQmi0"]'),
    tele2: page.locator('.xk-lte-modem[data-modem-id="UsbQmi1"]'),
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

    const { beeline, tele2 } = await openModems(page);

    await expect(page.locator('.xk-lte-safety-note')).toContainText('Перезапуск из панели отключён');
    await expect(page.getByRole('button', { name: 'Перезапустить модем' })).toHaveCount(0);
    await expect(beeline.locator('.xk-lte-control-status')).toBeEmpty();
    await tele2.getByRole('button', { name: 'Проверить управление' }).click();
    await expect(tele2.locator('.xk-lte-control-status')).toContainText('QMI доступен');
    await expect(beeline.locator('.xk-lte-control-status')).toBeEmpty();
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

  await expect(tele2.locator('.xk-lte-control-status')).toContainText('не подключён');
  await tele2.getByRole('button', { name: 'Проверить управление' }).click();
  await expect(tele2.locator('.xk-lte-control-status')).toContainText('не подключён');
  await expect(tele2.getByRole('button', { name: 'Перезапустить модем' })).toHaveCount(0);
});

test('missing QMI tool explains how to install the required package', async ({ page }) => {
  await page.route('**/api/system/router/lte/UsbQmi1/probe', route => route.fulfill({ json: {
    modem: { id: 'UsbQmi1', name: 'T2_STATIC' }, preferred_transport: null,
    transports: [{ kind: 'qmi', available: false }], code: 'qmi_tool_missing', sampled_at: 1,
  } }));

  const { tele2 } = await openModems(page);
  await tele2.getByRole('button', { name: 'Проверить управление' }).click();

  await expect(tele2.locator('.xk-lte-control-status')).toContainText('Установите пакет qmi-utils');
  await expect(tele2.locator('.xk-lte-control-status')).toContainText('opkg install qmi-utils');
  await expect(tele2.getByRole('button', { name: 'Перезапустить модем' })).toHaveCount(0);
});

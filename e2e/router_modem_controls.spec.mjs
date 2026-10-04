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
  await expect(page.locator('.xk-lte-modem')).toHaveCount(2);
  return {
    beeline: page.locator('.xk-lte-modem[data-modem-id="UsbQmi0"]'),
    tele2: page.locator('.xk-lte-modem[data-modem-id="UsbQmi1"]'),
  };
}

for (const width of [1440, 390]) {
  test(`T2_STATIC reset uses its own transport and recovers at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const errors = [];
    const resets = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/system/router/lte/UsbQmi1/probe', route => route.fulfill({ json: {
      modem: { id: 'UsbQmi1', name: 'T2_STATIC' }, preferred_transport: 'qmi',
      transports: [{ kind: 'qmi', available: true }], sampled_at: 1,
    } }));
    await page.route('**/api/system/router/lte/UsbQmi1/reset', route => {
      resets.push(route.request().postDataJSON());
      return route.fulfill({ status: 202, json: {
        operation_id: 'test-operation-1', modem_id: 'UsbQmi1', status: 'queued', transport: 'qmi', before: { id: 'UsbQmi1' },
      } });
    });
    let polls = 0;
    await page.route('**/api/system/router/lte/operations/test-operation-1', route => {
      polls += 1;
      return route.fulfill({ json: {
        operation_id: 'test-operation-1', modem_id: 'UsbQmi1', status: polls < 2 ? 'waiting_for_modem' : 'recovered',
        transport: 'qmi', message: null, before: { id: 'UsbQmi1' }, after: polls < 2 ? null : { id: 'UsbQmi1', connected: true },
      } });
    });
    const { beeline, tele2 } = await openModems(page);
    const beelineStatus = beeline.locator('.xk-lte-control-status');
    await expect(tele2.getByRole('button', { name: 'Перезапустить модем' })).toBeDisabled();
    await tele2.getByRole('button', { name: 'Проверить управление' }).click();
    await expect(tele2.getByRole('button', { name: 'Перезапустить модем' })).toBeEnabled();
    await expect(beelineStatus).toBeEmpty();
    await tele2.getByRole('button', { name: 'Перезапустить модем' }).click();
    await expect(page.locator('#confirm-modal-message')).toContainText('T2_STATIC');
    await expect(page.locator('#confirm-modal-message')).toContainText('UsbQmi1');
    await page.locator('#confirm-modal-ok-btn').click();
    await expect(tele2.getByRole('button', { name: 'Перезапустить модем' })).toBeDisabled();
    await expect(tele2.locator('.xk-lte-control-status')).toContainText('Восстановлен');
    expect(resets).toEqual([{ confirmation: 'UsbQmi1' }]);
    expect(polls).toBeGreaterThanOrEqual(2);
    await expect(beelineStatus).toBeEmpty();
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test('failed T2_STATIC operation leaves the other modem untouched', async ({ page }) => {
  await page.route('**/api/system/router/lte/UsbQmi1/probe', route => route.fulfill({ json: {
    modem: { id: 'UsbQmi1', name: 'T2_STATIC' }, preferred_transport: 'tty',
    transports: [{ kind: 'tty', available: true }], sampled_at: 1,
  } }));
  await page.route('**/api/system/router/lte/UsbQmi1/reset', route => route.fulfill({ status: 202, json: {
    operation_id: 'test-operation-2', modem_id: 'UsbQmi1', status: 'queued', transport: 'tty', before: { id: 'UsbQmi1' },
  } }));
  await page.route('**/api/system/router/lte/operations/test-operation-2', route => route.fulfill({ json: {
    operation_id: 'test-operation-2', modem_id: 'UsbQmi1', status: 'timed_out', transport: 'tty',
    code: 'modem_recovery_timeout', message: 'Возврат модема не подтверждён.', before: { id: 'UsbQmi1' }, after: null,
  } }));
  const { beeline, tele2 } = await openModems(page);
  await tele2.getByRole('button', { name: 'Проверить управление' }).click();
  await tele2.getByRole('button', { name: 'Перезапустить модем' }).click();
  await page.locator('#confirm-modal-ok-btn').click();
  await expect(tele2.locator('.xk-lte-control-status')).toContainText('не подтвердился');
  await expect(beeline.locator('.xk-lte-control-status')).toBeEmpty();
});

test('offline modem keeps reset unavailable after a successful port probe', async ({ page }) => {
  const offline = { ...modems[1], connected: false, connection_state: 'disconnected' };
  await page.route('**/api/system/router/lte/UsbQmi1/probe', route => route.fulfill({ json: {
    modem: { id: 'UsbQmi1', name: 'T2_STATIC' }, preferred_transport: 'qmi',
    transports: [{ kind: 'qmi', available: true }], sampled_at: 1,
  } }));
  const { tele2 } = await openModems(page, [modems[0], offline]);
  await expect(tele2.locator('.xk-lte-control-status')).toContainText('не подключён');
  await tele2.getByRole('button', { name: 'Проверить управление' }).click();
  await expect(tele2.locator('.xk-lte-control-status')).toContainText('не подключён');
  await expect(tele2.getByRole('button', { name: 'Перезапустить модем' })).toBeDisabled();
});

test('hung operation status times out and releases its modem controls', async ({ page }) => {
  test.setTimeout(60_000);
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, options = {}) => {
      if (!String(input).includes('/api/system/router/lte/operations/hung-operation')) {
        return originalFetch(input, options);
      }
      return new Promise((resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    };
  });
  await page.route('**/api/system/router/lte/UsbQmi1/probe', route => route.fulfill({ json: {
    modem: { id: 'UsbQmi1' }, preferred_transport: 'qmi',
    transports: [{ kind: 'qmi', available: true }], sampled_at: 1,
  } }));
  await page.route('**/api/system/router/lte/UsbQmi1/reset', route => route.fulfill({ status: 202, json: {
    operation_id: 'hung-operation', modem_id: 'UsbQmi1', status: 'queued', transport: 'qmi', before: { id: 'UsbQmi1' },
  } }));
  const { tele2 } = await openModems(page);
  await tele2.getByRole('button', { name: 'Проверить управление' }).click();
  await tele2.getByRole('button', { name: 'Перезапустить модем' }).click();
  await page.locator('#confirm-modal-ok-btn').click();
  await expect(tele2.locator('.xk-lte-control-status')).toContainText('Нет ответа', { timeout: 15_000 });
  await expect(tele2.getByRole('button', { name: 'Проверить управление' })).toBeEnabled();
  await expect(tele2.getByRole('button', { name: 'Перезапустить модем' })).toBeDisabled();
});

test('recovery refresh waits for an in-flight manual LTE refresh and reads fresh data', async ({ page }) => {
  await page.route('**/api/system/router/lte/UsbQmi1/probe', route => route.fulfill({ json: {
    modem: { id: 'UsbQmi1' }, preferred_transport: 'qmi',
    transports: [{ kind: 'qmi', available: true }], sampled_at: 1,
  } }));
  await page.route('**/api/system/router/lte/UsbQmi1/reset', route => route.fulfill({ status: 202, json: {
    operation_id: 'overlap-operation', modem_id: 'UsbQmi1', status: 'queued', transport: 'qmi', before: { id: 'UsbQmi1' },
  } }));
  await page.route('**/api/system/router/lte/operations/overlap-operation', route => route.fulfill({ json: {
    operation_id: 'overlap-operation', modem_id: 'UsbQmi1', status: 'recovered', transport: 'qmi',
    before: { id: 'UsbQmi1' }, after: { id: 'UsbQmi1', connected: true },
  } }));
  const { tele2 } = await openModems(page);
  await page.unroute('**/api/system/router/lte');
  let reads = 0;
  let releaseManual;
  await page.route('**/api/system/router/lte', async route => {
    reads += 1;
    if (reads === 1) await new Promise(resolve => { releaseManual = resolve; });
    const version = reads === 1 ? 'stale' : 'fresh';
    await route.fulfill({ json: {
      ok: true, available: true, count: 2,
      items: [modems[0], { ...modems[1], model: `${version} X20` }],
    } });
  });
  await tele2.getByRole('button', { name: 'Проверить управление' }).click();
  await page.locator('#xk-lte-action').click();
  await expect.poll(() => reads).toBe(1);
  await tele2.getByRole('button', { name: 'Перезапустить модем' }).click();
  await page.locator('#confirm-modal-ok-btn').click();
  await expect(tele2.locator('.xk-lte-control-status')).toContainText('Восстановлен');
  releaseManual();
  await expect(tele2.locator('header')).toContainText('fresh X20');
  expect(reads).toBe(2);
});

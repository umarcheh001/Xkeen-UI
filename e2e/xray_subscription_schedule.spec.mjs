import { test, expect } from './fixtures.mjs';
import { buildDemoSubscription, openSubscriptionsModal } from './subscriptions_modal_support.mjs';

test('calendar presets create a checked cron and expert input remains available', async ({ page }) => {
  await page.route('**/api/xray/subscriptions', route => route.fulfill({ json: { ok: true, subscriptions: [] } }));
  await page.route('**/api/xray/subscriptions/schedule-preview', route => route.fulfill({ json: { ok: true, next_update_local: 'завтра 04:00', router_timezone: 'MSK' } }));
  await openSubscriptionsModal(page);
  await page.locator('#outbounds-subscriptions-schedule-mode').selectOption('cron');
  await expect(page.locator('#outbounds-subscriptions-repeat')).toBeVisible();
  await expect(page.locator('#outbounds-subscriptions-schedule-mode option:checked')).toHaveText('По расписанию');
  const boxes = await Promise.all([page.locator('#outbounds-subscriptions-schedule-mode').boundingBox(), page.locator('#outbounds-subscriptions-repeat').boundingBox()]);
  expect(Math.abs(boxes[0].y - boxes[1].y)).toBeLessThan(2);
  await page.locator('#outbounds-subscriptions-repeat').selectOption('daily');
  await page.locator('#outbounds-subscriptions-time').fill('04:00');
  await expect(page.locator('#outbounds-subscriptions-cron')).toHaveValue('0 4 * * *');
  await expect(page.locator('#outbounds-subscriptions-cron-note')).toContainText('завтра 04:00');
  await page.locator('#outbounds-subscriptions-repeat').selectOption('custom');
  await expect(page.locator('#outbounds-subscriptions-cron')).toBeVisible();
  await page.locator('#outbounds-subscriptions-cron').fill('*/15 * * * *');
  await expect(page.locator('#outbounds-subscriptions-cron')).toHaveValue('*/15 * * * *');
  await page.locator('#outbounds-subscriptions-repeat').selectOption('daily');
  await page.locator('#outbounds-subscriptions-repeat').selectOption('custom');
  await expect(page.locator('#outbounds-subscriptions-cron')).toHaveValue('*/15 * * * *');
  await page.locator('#outbounds-subscriptions-repeat').selectOption('weekly');
  await page.locator('#outbounds-subscriptions-weekdays input[value="1"]').check();
  await page.locator('#outbounds-subscriptions-weekdays input[value="3"]').check();
  await expect(page.locator('#outbounds-subscriptions-cron')).toHaveValue('0 4 * * 1,3');
  await page.locator('#outbounds-subscriptions-repeat').selectOption('monthly');
  await page.locator('#outbounds-subscriptions-month-day').fill('31');
  await expect(page.locator('#outbounds-subscriptions-cron')).toHaveValue('0 4 31 * *');
  await page.locator('#outbounds-subscriptions-schedule-mode').selectOption('interval');
  await expect(page.locator('#outbounds-subscriptions-interval')).toBeEnabled();
});

test('list explains schedule and age of failure without exposing raw timeout', async ({ page }) => {
  const now = Date.now() / 1000;
  const sub = buildDemoSubscription([], { id: 'cron-sub', name: 'Cron demo', tag: 'Cron demo',
    schedule_mode: 'cron', cron_expression: '0 4 * * *', last_ok: false,
    last_error: '<urlopen error timed out>', first_scheduled_failure_ts: now - 6 * 86400,
    last_success_ts: now - 7 * 86400, next_update_ts: now + 3600 });
  await page.route('**/api/xray/subscriptions', route => route.fulfill({ json: { ok: true, subscriptions: [sub] } }));
  await openSubscriptionsModal(page);
  const row = page.locator('#outbounds-subscriptions-modal tr[data-sub-id="cron-sub"]');
  await expect(row).toContainText('По расписанию · каждый день');
  await expect(row).toContainText('Не удаётся обновить 6 д');
  await expect(row).toContainText('Первый сбой:');
  await expect(row).toContainText('Последняя успешная загрузка');
  await expect(row).toContainText('Сервер не ответил вовремя');
  await expect(row).not.toContainText('<urlopen error timed out>');
});

test('subscription errors do not expose secret URLs in the list', async ({ page }) => {
  const sub = buildDemoSubscription([], { id: 'secret-sub', name: 'Secret demo', tag: 'Secret demo',
    last_ok: false, last_error: 'HTTP Error 403 for https://example.com/sub?token=private-secret' });
  await page.route('**/api/xray/subscriptions', route => route.fulfill({ json: { ok: true, subscriptions: [sub] } }));
  await openSubscriptionsModal(page);
  const row = page.locator('#outbounds-subscriptions-modal tr[data-sub-id="secret-sub"]');
  await expect(row).toContainText('Ошибка обновления');
  await expect(row).not.toContainText('private-secret');
});

test('calendar controls fit both themes and narrow screens', async ({ page }, testInfo) => {
  await page.route('**/api/xray/subscriptions', route => route.fulfill({ json: { ok: true, subscriptions: [] } }));
  await page.route('**/api/xray/subscriptions/schedule-preview', route => route.fulfill({ json: { ok: true, next_update_local: '2026-12-31 04:00', router_timezone: 'MSK' } }));
  await openSubscriptionsModal(page);
  await page.locator('#outbounds-subscriptions-schedule-mode').selectOption('cron');
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const kind of ['daily', 'weekly', 'monthly', 'custom']) {
        await page.locator('#outbounds-subscriptions-repeat').selectOption(kind);
        const fits = await page.locator('.xk-sub-schedule').evaluate(el => el.scrollWidth <= el.clientWidth + 1);
        expect(fits, `${kind} ${theme} ${width}`).toBe(true);
      }
      await page.screenshot({ path: testInfo.outputPath(`calendar-${theme}-${width}.png`) });
    }
  }
});

test('editing a complex expression preserves it and blocks save while validation is pending', async ({ page }) => {
  const cron = '*/15 8-18 * * 1-5';
  const sub = buildDemoSubscription([], { schedule_mode: 'cron', cron_expression: cron });
  await page.route('**/api/xray/subscriptions', route => route.fulfill({ json: { ok: true, subscriptions: [sub] } }));
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  await page.route('**/api/xray/subscriptions/schedule-preview', async route => {
    await pending;
    await route.fulfill({ json: { ok: true, next_update_local: 'завтра', router_timezone: 'MSK' } });
  });
  await openSubscriptionsModal(page);
  await page.locator('tr[data-sub-id="demo-sub"]').click();
  await expect(page.locator('#outbounds-subscriptions-repeat')).toHaveValue('custom');
  await expect(page.locator('#outbounds-subscriptions-cron')).toHaveValue(cron);
  await expect(page.locator('#outbounds-subscriptions-save-btn')).toBeDisabled();
  release();
  await expect(page.locator('#outbounds-subscriptions-cron-note')).toContainText('Следующий запуск');
  await page.locator('#outbounds-subscriptions-schedule-mode').selectOption('interval');
  await page.locator('#outbounds-subscriptions-schedule-mode').selectOption('cron');
  await expect(page.locator('#outbounds-subscriptions-cron')).toHaveValue(cron);
});

test('editing an interval subscription keeps its empty cron unchanged', async ({ page }) => {
  const sub = buildDemoSubscription([], { schedule_mode: 'interval', cron_expression: '' });
  await page.route('**/api/xray/subscriptions', route => route.fulfill({ json: { ok: true, subscriptions: [sub] } }));
  await openSubscriptionsModal(page);
  await page.locator('tr[data-sub-id="demo-sub"]').click();
  await expect(page.locator('#outbounds-subscriptions-cron')).toHaveValue('');
});

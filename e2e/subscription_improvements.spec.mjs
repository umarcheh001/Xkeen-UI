import { test, expect } from './fixtures.mjs';
import { buildDemoNodes, buildDemoSubscription, openSubscriptionsModal } from './subscriptions_modal_support.mjs';

async function demo(page) {
  const nodes = buildDemoNodes().slice(0, 4).map((node, index) => ({
    ...node,
    name: [
      'Germany — Frankfurt premium connection with a deliberately long descriptive name for testing overflow',
      'France ws', 'France TLS', 'Singapore TCP',
    ][index],
  }));
  const subscription = buildDemoSubscription(nodes, { id: 'demo-sub', name: 'Demo subscription', tag: 'demo', name_filter: '', interval_hours: 24, last_hash: 'demo-fixture', last_update_ts: 1792912800, next_update_ts: 1792999200 });
  await page.route('**/api/xray/subscriptions', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({ json: { ok: true, subscriptions: [subscription], router_timezone: 'UTC' } });
  });
  await openSubscriptionsModal(page);
  await page.locator('tr[data-sub-id="demo-sub"]').click();
  const advanced = page.locator('.xk-sub-advanced');
  if (!(await advanced.getAttribute('open'))) await advanced.locator(':scope > summary').click();
  await expect(page.locator('.xk-sub-node-item')).toHaveCount(4);
}

async function expectScheduleRow(page, fieldId) {
  const layout = await page.evaluate((id) => {
    const mode = document.getElementById('outbounds-subscriptions-schedule-mode').getBoundingClientRect();
    const field = document.getElementById(id).getBoundingClientRect();
    return { modeY: mode.y, fieldY: field.y, modeRight: mode.right, fieldX: field.x };
  }, fieldId);
  expect(Math.abs(layout.modeY - layout.fieldY)).toBeLessThan(2);
  expect(layout.fieldX).toBeGreaterThanOrEqual(layout.modeRight);
}

test('calendar schedule and Python regex share the saved semantics', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1100 });
  await demo(page);
    await expect(page.locator('#outbounds-subscriptions-schedule-mode')).toHaveValue('interval');
    await expect(page.locator('#outbounds-subscriptions-cron-field')).toBeHidden();
    await expect(page.locator('#outbounds-subscriptions-interval')).toBeEnabled();
    await expect(page.locator('#outbounds-subscriptions-interval-field')).toBeVisible();
    await expectScheduleRow(page, 'outbounds-subscriptions-interval');
    await page.locator('#outbounds-subscriptions-schedule-mode').selectOption('cron');
    await page.locator('#outbounds-subscriptions-repeat').selectOption('custom');
    await page.locator('#outbounds-subscriptions-cron').fill('0 4 * * *');
    await expect(page.locator('#outbounds-subscriptions-cron-note')).toContainText('Следующий запуск');
    await expect(page.locator('#outbounds-subscriptions-interval-field')).toBeHidden();
    await expect(page.locator('#outbounds-subscriptions-interval')).toBeDisabled();
    await expect(page.locator('#outbounds-subscriptions-cron')).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('#outbounds-subscriptions-cron')).toBeVisible();
    await expect(page.locator('#outbounds-subscriptions-interval-field')).toBeHidden();
    await page.setViewportSize({ width: 1600, height: 1100 });
  await page.locator('#outbounds-subscriptions-name-filter').fill('(?i)^(?!.*ws)(?P<region>Germany|France).*$');
    await expect(page.locator('.xk-sub-node-item')).toHaveCount(2);
    await expect(page.locator('#outbounds-subscriptions-name-filter')).not.toHaveAttribute('aria-invalid', 'true');
    const title = page.locator('.xk-sub-node-title-text').first();
    await title.focus();
    await expect(title).toHaveAttribute('data-tooltip', /deliberately long/);
    await title.hover();
    await expect(page.locator('.xk-tooltip-text')).toContainText('deliberately long');
});

test('cron and filters report errors and save calendar fields', async ({ page }) => {
  await demo(page);
  await page.locator('#outbounds-subscriptions-schedule-mode').selectOption('cron');
  await page.locator('#outbounds-subscriptions-repeat').selectOption('custom');
  await page.locator('#outbounds-subscriptions-cron').fill('70 4 * * *');
  await expect(page.locator('#outbounds-subscriptions-cron')).toHaveAttribute('aria-invalid', 'true');
  await page.locator('#outbounds-subscriptions-cron').fill('0 4 * * *');
  await expect(page.locator('#outbounds-subscriptions-cron-note')).toContainText('Следующий запуск');
  await page.locator('#outbounds-subscriptions-name-filter').fill('[');
  await expect(page.locator('#outbounds-subscriptions-name-filter')).toHaveAttribute('aria-invalid', 'true');
  await page.locator('#outbounds-subscriptions-name-filter').fill('(?i)France');
  await expect(page.locator('.xk-sub-node-item')).toHaveCount(2);
  await page.locator('label').filter({ has: page.locator('#outbounds-subscriptions-refresh-now') }).click();
  await expect(page.locator('#outbounds-subscriptions-refresh-now')).not.toBeChecked();
  const saved = page.waitForRequest(request => request.url().endsWith('/api/xray/subscriptions') && request.method() === 'POST');
  await page.route('**/api/xray/subscriptions', async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    const payload = route.request().postDataJSON();
    await route.fulfill({ json: { ok: true, subscription: { ...payload, id: 'demo-sub' } } });
  });
  await page.locator('#outbounds-subscriptions-save-btn').click();
  const request = await saved;
  expect(request.postDataJSON()).toMatchObject({ schedule_mode: 'cron', cron_expression: '0 4 * * *', name_filter: '(?i)France' });
});

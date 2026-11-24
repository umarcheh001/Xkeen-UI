import { test, expect } from './fixtures.mjs';
import { STATUS } from './dns_over_vless_fixtures.mjs';

// Вход в DNS-over-VLESS продублирован в тулбаре над редактором роутинга.
// Копия должна открывать то же окно и показывать то же состояние, что и
// кнопка в блоке правил, иначе две точки начнут расходиться.
test('кнопка DNS в тулбаре редактора открывает окно и повторяет состояние', async ({ page }) => {
  await page.route('**/api/routing/dns-over-vless', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...STATUS, enabled: true, can_enable: false, can_disable: true }),
    });
  });
  await page.addInitScript(() => localStorage.setItem('xk.routing.rules.open.v2', '1'));
  await page.goto('/');
  await expect(page.locator('#view-routing')).toBeVisible();

  const dot = page.locator('#routing-dns-over-vless-dot');
  const toolbarDot = page.locator('#routing-dns-over-vless-toolbar-dot');
  await expect(dot).toHaveAttribute('data-state', 'enabled');
  await expect(toolbarDot).toHaveAttribute('data-state', 'enabled');

  const button = page.locator('#routing-dns-over-vless-toolbar-btn');
  await expect(button).toBeVisible();
  await button.click();
  await expect(page.locator('#routing-dns-over-vless-modal')).toBeVisible();
});

test('обе точки DNS показывают предупреждение об устройствах при закрытом окне', async ({ page }) => {
  await page.clock.install();
  await page.route('**/api/routing/dns-over-vless', (route) => route.fulfill({
    json: { ...STATUS, enabled: true, can_enable: false, can_disable: true },
  }));
  let device = { verdict: 'intercepted', captured: false };
  await page.route('**/api/routing/dns-over-vless/clients?read_only=1', (route) => route.fulfill({
    json: { available: true, clients: [device] },
  }));
  await page.addInitScript(() => localStorage.setItem('xk.routing.rules.open.v2', '1'));
  await page.goto('/');

  const dot = page.locator('#routing-dns-over-vless-dot');
  const toolbarDot = page.locator('#routing-dns-over-vless-toolbar-dot');
  await expect(page.locator('#routing-dns-over-vless-modal')).toBeHidden();
  await expect(dot).toHaveAttribute('data-state', 'blocked');
  await expect(toolbarDot).toHaveAttribute('data-state', 'blocked');

  device = { verdict: 'reaches', captured: true };
  await page.clock.fastForward(60000);
  await expect(dot).toHaveAttribute('data-state', 'enabled');
  await expect(toolbarDot).toHaveAttribute('data-state', 'enabled');

  device = { verdict: 'intercepted', captured: true };
  await page.clock.fastForward(60000);
  await expect(dot).toHaveAttribute('data-state', 'blocked');
  await expect(toolbarDot).toHaveAttribute('data-state', 'blocked');
});

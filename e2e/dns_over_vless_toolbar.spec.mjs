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

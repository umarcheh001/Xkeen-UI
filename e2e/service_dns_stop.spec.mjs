import { test, expect } from './fixtures.mjs';


test('stopping xkeen releases protected DNS only after confirmation', async ({ page }) => {
  let running = true;
  const stopRequests = [];

  await page.route('**/api/xkeen/status', async (route) => {
    await route.fulfill({ json: { running, core: 'mihomo' } });
  });
  await page.route('**/api/xkeen/stop-check', async (route) => {
    await route.fulfill({
      json: {
        ok: true,
        dns_protection: {
          active: true,
          owner: 'mihomo-dns',
          label: 'защита DNS Mihomo',
        },
      },
    });
  });
  await page.route('**/api/xkeen/stop', async (route) => {
    stopRequests.push({
      body: route.request().postDataJSON(),
      csrf: route.request().headers()['x-csrf-token'] || '',
    });
    running = false;
    await route.fulfill({ json: { ok: true, dns_released: true } });
  });

  await page.goto('/');
  // Кнопки управления сервисом живут в меню статуса компактной шапки.
  await page.locator('.xk-brand-service-trigger').click();
  await expect(page.locator('#xkeen-stop-btn')).toBeEnabled();
  await page.locator('#xkeen-stop-btn').click();

  await expect(page.locator('#confirm-modal')).toContainText('Простая остановка xkeen оставит устройства без DNS');
  await expect(page.locator('#confirm-modal-ok-btn')).toHaveText('Вернуть DNS и остановить');
  expect(stopRequests).toHaveLength(0);
  await page.locator('#confirm-modal-ok-btn').click();

  await expect.poll(() => stopRequests.length).toBe(1);
  expect(stopRequests[0].body).toEqual({ release_dns: true });
  expect(stopRequests[0].csrf).not.toBe('');
  await expect(page.locator('#xkeen-stop-btn')).toBeDisabled();
});

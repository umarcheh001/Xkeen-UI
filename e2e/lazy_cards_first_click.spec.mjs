import { test, expect } from './fixtures.mjs';

// «Входящие подключения» и «Бэкапы Xray» — такие же сворачиваемые карточки,
// как «Прокси-серверы»: их модуль просыпается от первого нажатия на заголовок
// и на роутере догружается секунды. Карточка должна раскрыться сразу, а
// содержимое — догрузиться, когда придёт.

const LOAD_DELAY_MS = 2500;
const CARDS = [
  { name: 'inbounds', header: '#inbounds-header', body: '#inbounds-body' },
  { name: 'backups', header: '#routing-backups-header', body: '#routing-backups-body' },
];

async function openPanelThenSlowEverythingDown(page, card) {
  await page.goto('/');
  await expect(page.locator(card.header)).toBeVisible();
  await page.waitForLoadState('networkidle');
  await page.route(/\/(static\/.*\.js|api\/)/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, LOAD_DELAY_MS));
    await route.continue();
  });
}

for (const card of CARDS) {
  test.describe(`${card.name} card header`, () => {
    test('opens on the first click while its module is still loading', async ({ page }) => {
      await openPanelThenSlowEverythingDown(page, card);
      const header = page.locator(card.header);
      const body = page.locator(card.body);
      await expect(body).toBeHidden();

      await header.click();

      await expect(body).toBeVisible({ timeout: 500 });
      await expect(header).toHaveAttribute('aria-expanded', 'true');

      // Догрузка не переключает карточку обратно.
      await page.waitForTimeout(LOAD_DELAY_MS + 2500);
      await expect(body).toBeVisible();
      await expect(header).toHaveAttribute('aria-expanded', 'true');
    });

    test('a second click during the load closes what the first one opened', async ({ page }) => {
      await openPanelThenSlowEverythingDown(page, card);
      const header = page.locator(card.header);
      const body = page.locator(card.body);

      await header.click();
      await expect(body).toBeVisible({ timeout: 500 });
      await page.waitForTimeout(300);
      await header.click();
      await expect(body).toBeHidden({ timeout: 500 });

      await page.waitForTimeout(LOAD_DELAY_MS + 2500);
      await expect(body).toBeHidden();
    });

    test('keeps working by one click once the module is there', async ({ page }) => {
      await openPanelThenSlowEverythingDown(page, card);
      const header = page.locator(card.header);
      const body = page.locator(card.body);

      await header.click();
      await expect(body).toBeVisible({ timeout: 500 });
      await page.waitForTimeout(LOAD_DELAY_MS + 2500);

      await header.click();
      await expect(body).toBeHidden({ timeout: 500 });
      await header.click();
      await expect(body).toBeVisible({ timeout: 500 });
    });
  });
}

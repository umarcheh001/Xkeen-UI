import { test, expect } from './fixtures.mjs';

// Заголовок «Прокси-серверы» принадлежит модулю, который догружается после
// страницы. На роутере это секунды: нажатие в это время не давало ничего
// видимого, а повторное переключало карточку дважды, и она оставалась
// закрытой. Карточка должна раскрываться сразу, что бы ни происходило с
// догрузкой, — как обычная сворачиваемая секция.

const LOAD_DELAY_MS = 2500;

async function openPanelWithSlowRoutingModule(page) {
  await page.addInitScript(() => {
    try { window.localStorage.removeItem('xkeen_outbounds_open'); } catch (error) {}
  });
  await page.goto('/');
  await expect(page.locator('#outbounds-header')).toBeVisible();
  await page.waitForLoadState('networkidle');
  // Модуль карточки просыпается от первого нажатия. Всё, за чем он после
  // этого сходит на сервер, приходит с задержкой, как на роутере.
  await page.route(/\/(static\/.*\.js|api\/)/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, LOAD_DELAY_MS));
    await route.continue();
  });
}

test.describe('outbounds card header', () => {
  test('opens on the first click while its module is still loading', async ({ page }) => {
    await openPanelWithSlowRoutingModule(page);
    const header = page.locator('#outbounds-header');
    const body = page.locator('#outbounds-body');

    await header.click();

    // Сразу, а не когда догрузится модуль.
    await expect(body).toBeVisible({ timeout: 500 });
    await expect(header).toHaveAttribute('aria-expanded', 'true');

    // Догрузка не должна переключить карточку обратно.
    await page.waitForTimeout(LOAD_DELAY_MS + 2500);
    await expect(body).toBeVisible();
    await expect(header).toHaveAttribute('aria-expanded', 'true');
  });

  test('a second click during the load closes what the first one opened', async ({ page }) => {
    await openPanelWithSlowRoutingModule(page);
    const header = page.locator('#outbounds-header');
    const body = page.locator('#outbounds-body');

    await header.click();
    await expect(body).toBeVisible({ timeout: 500 });
    await page.waitForTimeout(300);
    await header.click();
    await expect(body).toBeHidden({ timeout: 500 });

    await page.waitForTimeout(LOAD_DELAY_MS + 2500);
    await expect(body).toBeHidden();
    await expect(header).toHaveAttribute('aria-expanded', 'false');
  });

  test('keeps working by one click once the module is there', async ({ page }) => {
    await openPanelWithSlowRoutingModule(page);
    const header = page.locator('#outbounds-header');
    const body = page.locator('#outbounds-body');

    await header.click();
    await expect(body).toBeVisible({ timeout: 500 });
    await page.waitForTimeout(LOAD_DELAY_MS + 2500);

    await header.click();
    await expect(body).toBeHidden({ timeout: 500 });
    await header.click();
    await expect(body).toBeVisible({ timeout: 500 });
  });

  test('remembers the choice made before the module arrived', async ({ page }) => {
    await openPanelWithSlowRoutingModule(page);

    await page.locator('#outbounds-header').click();
    await expect(page.locator('#outbounds-body')).toBeVisible({ timeout: 500 });

    expect(await page.evaluate(() => window.localStorage.getItem('xkeen_outbounds_open'))).toBe('1');
  });
});

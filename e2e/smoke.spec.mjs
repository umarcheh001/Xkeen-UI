import { test, expect } from '@playwright/test';


test('panel shell renders top-level navigation', async ({ page }) => {
  await page.goto('/');

  await expect(page).toHaveTitle(/Xkeen UI/i);
  await expect(page.locator('#top-tab-mihomo-generator')).toBeVisible();
  await expect(page.locator('body')).toContainText('Mihomo Генератор');
  await expect(page.locator('body')).toContainText('DevTools');
});


test('devtools page renders update and env sections', async ({ page }) => {
  await page.goto('/devtools');

  await expect(page).toHaveTitle(/DevTools/i);
  await expect(page.locator('#dt-update-card')).toBeVisible();
  await page.locator('#dt-update-card').evaluate((node) => { node.open = true; });
  await expect(page.locator('#dt-update-check')).toBeVisible();
  await expect(page.locator('#dt-update-run')).toBeVisible();
  await expect(page.locator('#dt-env-card')).toBeVisible();
});


test('backups history page renders table', async ({ page }) => {
  await page.goto('/backups');

  await expect(page).toHaveTitle(/Бэкапы/i);
  await expect(page.locator('#backups-table')).toBeVisible();
  await expect(page.locator('body')).toContainText('Бэкапы Xray конфигов');
});


test('mihomo generator page renders source and preview panes', async ({ page }) => {
  await page.goto('/mihomo_generator');

  await expect(page).toHaveTitle(/Mihomo/i);
  await expect(page.locator('#profileSelect')).toBeVisible();
  await expect(page.locator('#defaultGroupsInput')).toBeVisible();
  await expect(page.locator('#previewTextarea')).toBeAttached();
  await expect(page.locator('body')).toContainText('Исходные данные');
  await expect(page.locator('body')).toContainText('Предпросмотр');
});

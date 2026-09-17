import { test, expect } from './fixtures.mjs';


async function openMemorySettings(page) {
  await page.goto('/');
  await page.locator('[aria-controls="xk-mihomo-panel-menu"]').click();
  await page.locator('#ui-settings-open-btn').click();
  await expect(page.locator('#ui-settings-modal')).toBeVisible();
  await page.locator('#ui-settings-nav-btn-resources').click();
  await expect(page.locator('#ui-settings-section-resources')).toBeVisible();
}


test('memory budget is persisted through the shared settings API', async ({ page }) => {
  await openMemorySettings(page);

  const budget = page.locator('[data-ui-settings-control="runtime-memory-budget"]');
  await expect(budget).toHaveValue('auto');
  await budget.selectOption('128');
  await expect(page.locator('#ui-settings-status')).toContainText('Сохранено');
  await expect(budget).toHaveValue('128');

  await page.locator('#ui-settings-close-btn').click();
  await page.locator('[aria-controls="xk-mihomo-panel-menu"]').click();
  await page.locator('#ui-settings-open-btn').click();
  await page.locator('#ui-settings-nav-btn-resources').click();
  await expect(budget).toHaveValue('128');
});


test('memory settings stay inside the mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openMemorySettings(page);

  const geometry = await page.locator('#ui-settings-section-resources').evaluate((section) => {
    const bounds = section.getBoundingClientRect();
    const control = section.querySelector('[data-ui-settings-control="runtime-memory-budget"]');
    const controlBounds = control.getBoundingClientRect();
    return {
      sectionLeft: bounds.left,
      sectionRight: bounds.right,
      controlLeft: controlBounds.left,
      controlRight: controlBounds.right,
      viewportWidth: window.innerWidth,
    };
  });

  expect(geometry.sectionLeft).toBeGreaterThanOrEqual(0);
  expect(geometry.sectionRight).toBeLessThanOrEqual(geometry.viewportWidth);
  expect(geometry.controlLeft).toBeGreaterThanOrEqual(0);
  expect(geometry.controlRight).toBeLessThanOrEqual(geometry.viewportWidth);
});

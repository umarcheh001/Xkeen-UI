import { test, expect } from './fixtures.mjs';


test('hides the vacated service-controls row after it moves into the panel menu', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');

  await expect(page.locator('body')).toHaveClass(/xk-operator-header-active/);
  await expect(page.locator('.panel-header .xkeen-ctrl-row')).toBeHidden();
});

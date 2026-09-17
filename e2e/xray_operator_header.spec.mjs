import { test, expect, selectPanelView } from './fixtures.mjs';

test('Xray uses the compact routing header in desktop and mobile layouts', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/system/resources', route => route.fulfill({ json: {
    ok: true, cpu: { percent: 11.7, cores: 2 }, memory: { percent: 48 }, sampled_at: Date.now() / 1000,
  } }));

  await page.goto('/');
  await expect(page.locator('body')).toHaveClass(/xk-operator-header-active/);
  await expect(page.locator('body')).toHaveClass(/xk-routing-header-active/);
  await expect(page.locator('body')).not.toHaveClass(/xk-mihomo-header-active/);
  await expect(page.locator('.xk-routing-operator-title')).toHaveCount(0);
  await expect(page.locator('#routing-editor-card .commands-header h2')).toContainText('Редактор конфигурации Xray');
  await expect(page.locator('.panel-shell-status')).not.toBeInViewport();
  await expect(page.locator('#xk-mihomo-sections-menu')).toBeHidden();
  await expect(page.locator('#xk-mihomo-sections-menu .header-tabs')).toBeAttached();

  await page.locator('.xk-brand-service-trigger').click();
  await expect(page.locator('#xkeen-restart-btn')).toBeVisible();
  await expect(page.locator('#routing-focus-switch')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.xk-brand-service-trigger')).toBeFocused();

  for (const width of [1440, 390, 360]) {
    await page.setViewportSize({ width, height: 960 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const header = await page.locator('.panel-header-shell').boundingBox();
    const workspace = await page.locator('.layout-2col.routing-layout').boundingBox();
    expect(workspace.y - header.y - header.height).toBeGreaterThanOrEqual(11);
    expect(workspace.y - header.y - header.height).toBeLessThanOrEqual(13);

    for (const id of ['xk-mihomo-sections-menu', 'xk-mihomo-panel-menu', 'xk-mihomo-service-menu']) {
      await page.locator(`[aria-controls="${id}"]`).click();
      const box = await page.locator(`#${id}`).boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      await page.keyboard.press('Escape');
    }
  }

  await page.setViewportSize({ width: 1440, height: 960 });
  await page.locator('[aria-controls="xk-mihomo-sections-menu"]').click();
  await selectPanelView(page, 'mihomo');
  await expect(page.locator('body')).toHaveClass(/xk-mihomo-header-active/);
  await expect(page.locator('.xk-mihomo-operator-title')).toHaveCount(0);
  await page.locator('[aria-controls="xk-mihomo-sections-menu"]').click();
  await selectPanelView(page, 'routing');
  await expect(page.locator('body')).toHaveClass(/xk-routing-header-active/);
  await expect(page.locator('#xkeen-restart-btn')).toHaveCount(1);
  expect(errors).toEqual([]);
});

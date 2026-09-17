import { test, expect, selectPanelView } from './fixtures.mjs';


const workspaces = [
  { view: 'xkeen', content: '#view-xkeen > .commands-card' },
  { view: 'commands', content: '#view-commands > .commands-card' },
  { view: 'files', content: '#view-files > .fm-card' },
];


test('ports, commands and files share the compact panel header', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('xkeen-theme', 'dark'));
  await page.route('**/api/system/resources', route => route.fulfill({ json: {
    ok: true, cpu: { percent: 11.7, cores: 2 }, memory: { percent: 48 }, sampled_at: Date.now() / 1000,
  } }));
  await page.goto('/');

  for (const width of [1440, 390, 360]) {
    await page.setViewportSize({ width, height: 900 });
    for (const workspace of workspaces) {
      await selectPanelView(page, workspace.view);
      await expect(page.locator(`#view-${workspace.view}`)).toBeVisible();
      await expect(page.locator('body')).toHaveClass(/xk-operator-header-active/);
      await expect(page.locator('body')).not.toHaveClass(/xk-mihomo-header-active/);
      await expect(page.locator('.panel-shell-status')).not.toBeInViewport();
      await page.evaluate((view) => {
        document.documentElement.style.scrollBehavior = 'auto';
        window.scrollTo(0, 0);
        document.getElementById(`view-${view}`).scrollTop = 0;
      }, workspace.view);

      const header = await page.locator('.panel-header-shell').boundingBox();
      const content = await page.locator(workspace.content).boundingBox();
      const gap = content.y - header.y - header.height;
      expect(gap, `${workspace.view} header gap at ${width}px`).toBeGreaterThanOrEqual(11);
      expect(gap, `${workspace.view} header gap at ${width}px`).toBeLessThanOrEqual(13);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        `${workspace.view} overflow at ${width}px`,
      ).toBe(true);

      if (width !== 360) {
        await page.screenshot({ path: `.tmp/${workspace.view}-compact-header-${width}.png` });
      }
    }
  }

  await page.locator('[aria-controls="xk-mihomo-sections-menu"]').click();
  await expect(page.locator('#top-tab-mihomo-generator')).not.toHaveAttribute('data-view');
  await expect(page.locator('#top-tab-mihomo-generator')).toHaveAttribute('data-nav-href', /mihomo_generator$/);
  await page.keyboard.press('Escape');
  await page.locator('[aria-controls="xk-mihomo-panel-menu"]').click();
  await expect(page.locator('#xk-mihomo-panel-menu .xk-header-btn-devtools')).toHaveAttribute('href', /devtools$/);
});

import { test, expect } from './fixtures.mjs';

async function readyPanel(page) {
  await page.goto('/');
  await expect(page.locator('.top-tab-btn[data-view="mihomo"]')).toHaveAttribute('data-xkeen-wired-tabs', '1');
  await expect.poll(() => page.evaluate(() => window.XKeen?.topLevel?.router?.hasScreen('devtools'))).toBe(true);
}

test('panel tabs and top-level screens animate without holding navigation', async ({ page }) => {
  await readyPanel(page);

  const tabMotion = await page.evaluate(() => {
    document.querySelector('.top-tab-btn[data-view="mihomo"]').click();
    const view = document.getElementById('view-mihomo');
    return { visible: getComputedStyle(view).display !== 'none', animations: view.getAnimations().length };
  });
  expect(tabMotion).toEqual({ visible: true, animations: 1 });
  await expect.poll(() => page.locator('#view-mihomo').evaluate((node) => node.getAnimations().length)).toBe(0);

  await page.evaluate(() => {
    window.__screenMotion = [];
    window.addEventListener('xkeen:top-level-route-change', (event) => {
      if (event.detail?.initial) return;
      const name = event.detail?.screen;
      const root = document.querySelector(`[data-xk-top-level-screen-root="${name}"]`);
      window.__screenMotion.push({ name, animations: root?.getAnimations().length || 0 });
    });
    document.querySelector('a.xk-header-btn-devtools').click();
  });
  await expect(page).toHaveURL(/\/devtools$/);
  await expect.poll(() => page.evaluate(() => window.__screenMotion.at(-1))).toEqual({ name: 'devtools', animations: 1 });
  await expect.poll(() => page.locator('[data-xk-top-level-screen-root="devtools"]').evaluate((node) => node.getAnimations().length)).toBe(0);

  await expect(async () => {
    await page.locator('#dt-tab-btn-logs').click();
    await expect(page.locator('#dt-tab-btn-logs')).toHaveAttribute('aria-selected', 'true', { timeout: 500 });
  }).toPass({ timeout: 20_000 });
  await page.locator('#dt-tab-btn-tools').click();
  await expect(page.locator('#dt-tab-btn-tools')).toHaveAttribute('aria-selected', 'true');
  const devtoolsMotion = await page.evaluate(() => {
    document.getElementById('dt-tab-btn-logs').click();
    const view = document.getElementById('dt-tab-logs');
    return { visible: getComputedStyle(view).display !== 'none', animations: view.getAnimations().length };
  });
  expect(devtoolsMotion).toEqual({ visible: true, animations: 1 });

  await page.locator('.xk-header-btn-back').click();
  await expect(page).toHaveURL(/\/$/);
  await expect.poll(() => page.evaluate(() => window.__screenMotion.at(-1))).toEqual({ name: 'panel', animations: 1 });
});

test('reduced motion keeps screen changes immediate', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await readyPanel(page);

  // Reduced-motion styles keep 0.01 ms CSS transitions: only the screen motion counts.
  const tabMotion = await page.evaluate(() => {
    document.querySelector('.top-tab-btn[data-view="mihomo"]').click();
    const view = document.getElementById('view-mihomo');
    const animations = view.getAnimations().filter((item) => item.constructor.name === 'Animation').length;
    return { visible: getComputedStyle(view).display !== 'none', animations };
  });
  expect(tabMotion).toEqual({ visible: true, animations: 0 });

  await page.evaluate(() => document.querySelector('a.xk-header-btn-devtools').click());
  await expect(page).toHaveURL(/\/devtools$/);
  await expect(page.locator('[data-xk-top-level-screen-root="devtools"]')).toBeVisible();
  expect(await page.locator('[data-xk-top-level-screen-root="devtools"]').evaluate(
    (node) => node.getAnimations().filter((item) => item.constructor.name === 'Animation').length,
  )).toBe(0);
});

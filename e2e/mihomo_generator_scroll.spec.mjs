import { test, expect } from './fixtures.mjs';


test('Mihomo Generator keeps its document-scroll page contract', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 400 });
  await page.goto('/mihomo_generator');
  await expect(page.locator('body.mihomo-generator-page')).toBeVisible();

  await page.evaluate(() => {
    const spacer = document.createElement('div');
    spacer.dataset.generatorScrollProbe = '1';
    spacer.style.cssText = 'height: 1200px; width: 1px; pointer-events: none;';
    document.querySelector('.container.container-wide').appendChild(spacer);
  });

  const contract = await page.evaluate(() => {
    const body = document.body;
    const root = document.documentElement;
    return {
      bodyOverflowY: getComputedStyle(body).overflowY,
      rootOverflowY: getComputedStyle(root).overflowY,
      bodyScrollHeight: body.scrollHeight,
      bodyClientHeight: body.clientHeight,
      rootScrollHeight: root.scrollHeight,
      rootClientHeight: root.clientHeight,
      scrollY: window.scrollY,
      viewSectionCount: document.querySelectorAll('.view-section').length,
      panelHeaderCount: document.querySelectorAll('.panel-header').length,
    };
  });

  expect(['auto', 'visible'], 'Generator body overflow').toContain(contract.bodyOverflowY);
  expect(['auto', 'visible'], 'Generator root overflow').toContain(contract.rootOverflowY);
  expect(contract.viewSectionCount, 'Generator must not use a panel workspace').toBe(0);
  expect(contract.panelHeaderCount, 'Generator must not use the panel shell').toBe(0);
  expect(contract.bodyScrollHeight).toBeGreaterThanOrEqual(contract.bodyClientHeight);
  expect(contract.rootScrollHeight).toBeGreaterThan(contract.rootClientHeight);

  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);

  await page.locator('[data-generator-scroll-probe="1"]').evaluate((node) => node.remove());
});

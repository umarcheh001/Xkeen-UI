import { test, expect } from './fixtures.mjs';

const PROFILE = String(process.env.XKEEN_E2E_MODULE_PROFILE || 'full').toLowerCase();
const HAS_XRAY = { full: true, 'xray-minimal': true, 'mihomo-minimal': false, 'core-only': false };

test.skip(!(PROFILE in HAS_XRAY), `profile ${PROFILE} is not described for the Xray module`);

for (const engine of ['xray', 'mihomo']) {
const present = engine === 'xray' ? HAS_XRAY : { full:true, 'xray-minimal':false, 'mihomo-minimal':true, 'core-only':false };
for (const path of ['/', '/devtools']) {
  test(`${path} opens ${present[PROFILE] ? 'with' : 'without'} ${engine}`, async ({ page }) => {
    const problems = [];
    const failedModules = [];
    const xrayRequests = [];
    page.on('console', (message) => {
      if (message.type() === 'error' && /xk-module/.test(message.text())) problems.push(message.text());
    });
    page.on('pageerror', (error) => {
      if (/xk-module/.test(error.message)) problems.push(error.message);
    });
    page.on('request', (request) => {
      if (request.url().includes(`/modules/engine.${engine}/`)) xrayRequests.push(request.url());
    });
    page.on('response', (response) => {
      if (response.status() >= 400 && response.url().includes('/frontend-build/modules/')) failedModules.push(response.url());
    });

    const response = await page.goto(path);
    expect(response?.ok()).toBe(true);
    await expect(page.locator('body')).toBeVisible();
    await page.waitForLoadState('networkidle');
    const importmaps = page.locator('script[type="importmap"]');
    await expect(importmaps).toHaveCount(1);
    const imports = await importmaps.evaluateAll((scripts) =>
      Object.assign({}, ...scripts.map((script) => JSON.parse(script.textContent).imports || {}))
    );
    if (!present[PROFILE]) {
      expect(Object.keys(imports)).not.toContain(`xk-module/engine.${engine}`);
      if (path === '/') {
        for (const view of (engine === 'xray' ? ['routing', 'xray-logs'] : ['mihomo'])) {
          await expect(page.locator(`[data-view="${view}"]`)).toHaveCount(0);
          await expect(page.locator(`#view-${view}`)).toHaveCount(0);
        }
        const menu = page.locator('[aria-controls="xk-mihomo-panel-menu"]');
        if (await menu.isVisible()) await menu.click();
        await page.locator('#ui-settings-open-btn:visible').click();
        await expect(page.locator('#ui-settings-modal')).toBeVisible();
        await page.locator('#ui-settings-close-btn').click();
        await expect(page.locator('#ui-settings-modal')).toBeHidden();
      }
      expect(xrayRequests).toEqual([]);
    } else {
      expect(Object.keys(imports)).toContain(`xk-module/engine.${engine}`);
    }
    expect(problems).toEqual([]);
    expect(failedModules).toEqual([]);
  });
}
}

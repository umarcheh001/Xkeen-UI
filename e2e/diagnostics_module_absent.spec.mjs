import { test, expect } from './fixtures.mjs';

// The diagnostics window is a module built apart from the panel. Without it the
// panel and DevTools must open as usual, say nothing about a missing bundle and
// offer no way into the window.
const PROFILE = String(process.env.XKEEN_E2E_MODULE_PROFILE || 'full').toLowerCase();
const HAS_DIAGNOSTICS = { full: true, 'no-diagnostics': false, 'xray-minimal': false, 'mihomo-minimal': false, 'core-only': false };

test.skip(!(PROFILE in HAS_DIAGNOSTICS), `profile ${PROFILE} is not described for the diagnostics module`);

for (const path of ['/', '/devtools']) {
  test(`${path} opens ${HAS_DIAGNOSTICS[PROFILE] ? 'with' : 'without'} the diagnostics module`, async ({ page }) => {
    const problems = [];
    page.on('console', (message) => {
      if (message.type() === 'error') problems.push(message.text());
    });
    page.on('pageerror', (error) => { problems.push(String(error && error.message || error)); });
    const failedModuleRequests = [];
    page.on('response', (response) => {
      if (response.status() >= 400 && /xk-module|frontend-build\/modules\//.test(response.url())) failedModuleRequests.push(response.url());
    });

    await page.setViewportSize({ width: 1440, height: 900 });
    const response = await page.goto(path);
    expect(response && response.ok()).toBe(true);
    await expect(page.locator('body')).toBeVisible();
    await page.waitForLoadState('networkidle');

    expect(problems.filter((text) => /xk-module/.test(text))).toEqual([]);
    expect(failedModuleRequests).toEqual([]);

    if (path === '/') {
      const entry = page.locator('#xk-resource-monitor');
      const offer = page.locator('#xk-resource-monitor-install-offer');
      if (HAS_DIAGNOSTICS[PROFILE]) {
        await expect(entry).toHaveCount(1);
        await expect(offer).toHaveCount(0);
      } else {
        await expect(page.locator('#xk-resource-dashboard-modal')).toHaveCount(0);
        await expect(page.locator('button#xk-resource-monitor')).toHaveCount(0);
        await expect(offer).toBeVisible();
      }
    } else {
      await expect(page.locator('#dt-update-card')).toBeVisible();
    }
  });
}

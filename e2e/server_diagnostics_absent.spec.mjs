import { test, expect } from './fixtures.mjs';

// The server diagnostics window is an optional module: its checks send server
// addresses to outside services. Without it the panel offers no way in: no
// "Servers" buttons, no window, no hint in the engine error messages.
const PROFILE = String(process.env.XKEEN_E2E_MODULE_PROFILE || 'full').toLowerCase();
const HAS_MODULE = { full: true, 'no-server-diagnostics': false };

test.skip(!(PROFILE in HAS_MODULE), `profile ${PROFILE} is not described for the server diagnostics module`);

test(`the panel opens ${HAS_MODULE[PROFILE] ? 'with' : 'without'} the server diagnostics module`, async ({ page }) => {
  const problems = [];
  page.on('pageerror', (error) => { problems.push(String(error && error.message || error)); });
  const failedModuleRequests = [];
  page.on('response', (response) => {
    if (response.status() >= 400 && /xk-module|frontend-build\/modules\/|server-diagnostics/.test(response.url())) {
      failedModuleRequests.push(response.url());
    }
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  const response = await page.goto('/');
  expect(response && response.ok()).toBe(true);
  await page.waitForLoadState('networkidle');

  const expected = HAS_MODULE[PROFILE] ? 1 : 0;
  await expect(page.locator('[data-provider-check-core="xray"]')).toHaveCount(expected);
  await expect(page.locator('[data-provider-check-core="mihomo"]')).toHaveCount(expected);
  await expect(page.locator('#provider-check-modal')).toHaveCount(expected);
  await expect(page.locator('link[href*="server-diagnostics.css"]')).toHaveCount(expected);

  // The hint the engines add to a network error offers the window only with the module.
  const hinted = await page.evaluate(async () => {
    const hint = await import('/static/js/features/provider_diagnostics_hint.js');
    const host = document.createElement('div');
    hint.appendProviderDiagnosticsHint(host, 'Connection timed out', 'xray', 'missing-input');
    return host.querySelector('.xk-provider-check-error-hint') !== null;
  });
  expect(hinted).toBe(HAS_MODULE[PROFILE]);

  expect(problems).toEqual([]);
  expect(failedModuleRequests).toEqual([]);
});

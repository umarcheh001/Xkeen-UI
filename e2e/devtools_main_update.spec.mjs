import { test, expect } from './fixtures.mjs';

const installed = {
  ok: true,
  profile: 'full',
  modules: [
    { id: 'core', name: 'Xkeen UI Core', version: '1.0.0', enabled: true },
    { id: 'engine.mihomo', name: 'Mihomo', version: '1.19.0', enabled: false },
  ],
};

function infoPayload(channel) {
  return {
    ok: true,
    build: {
      version: '2.10.0', repo: 'umarcheh001/Xkeen-UI', channel,
      branch: channel, commit: 'abc123456789', built_utc: '2026-10-09T09:10:11Z',
    },
    settings: { repo: 'umarcheh001/Xkeen-UI', channel, branch: channel },
    capabilities: { curl: true, tar: true, tar_exclude: true, sha256sum: true },
    security: {},
  };
}

async function mockPanelSummary(page, { channel = 'main' } = {}) {
  await page.route('**/api/devtools/update/info', (route) => route.fulfill({ json: infoPayload(channel) }));
  await page.route('**/api/modules/installed', (route) => route.fulfill({ json: installed }));
}

test.describe('DevTools panel summary', () => {
  test('shows panel identity and delegates update work to Modules', async ({ page }) => {
    await mockPanelSummary(page);
    await page.goto('/devtools');

    const card = page.locator('#dt-update-card');
    await expect(card).toContainText('2.10.0');
    await expect(card).toContainText('abc123456789');
    await expect(card).toContainText('Xkeen UI Core');
    await expect(card).toContainText('Mihomo 1.19.0 (выключен)');
    await expect(page.locator('#dt-panel-profile')).toHaveText('full');
    await expect(page.locator('#dt-update-check')).toHaveCount(0);
    await expect(page.locator('#dt-update-run')).toHaveCount(0);
    await expect(page.locator('[data-dt-main-update-controls]')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Модули и обновления', exact: true })).toHaveCount(1);
  });

  test('keeps the summary usable after an info request fails and recovers', async ({ page }) => {
    let fail = true;
    await page.route('**/api/devtools/update/info', (route) => route.fulfill(
      fail ? { status: 503, json: { ok: false, error: 'temporary failure' } } : { json: infoPayload('stable') },
    ));
    await page.route('**/api/modules/installed', (route) => route.fulfill({ json: installed }));
    await page.goto('/devtools');

    // A transient info failure leaves the compact summary in a neutral state;
    // it must remain recoverable without restoring legacy update controls.
    await expect(page.locator('#dt-update-current-version')).toHaveText('—');
    fail = false;
    await page.evaluate(async () => {
      const { getDevtoolsNamespace } = await import('/static/js/features/devtools_namespace.js');
      getDevtoolsNamespace().devtoolsUpdate.activate();
    });
    await expect(page.locator('#dt-update-current-version')).toHaveText('2.10.0');
    await expect(page.locator('#dt-update-channel')).toHaveText('stable');
  });
});

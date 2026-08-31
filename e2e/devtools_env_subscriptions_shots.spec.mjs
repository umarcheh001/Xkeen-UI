import { test, expect } from './fixtures.mjs';
import { mkdirSync } from 'node:fs';

/* Screenshots of the subscription/DNS knobs now reachable from the ENV editor. */

const SHOTS = process.env.XKEEN_ENV_SHOTS_DIR || 'playwright-report/env-subscriptions';
mkdirSync(SHOTS, { recursive: true });

async function openEnvEditor(page, theme) {
  await page.addInitScript((nextTheme) => {
    localStorage.setItem('xkeen-theme', nextTheme);
  }, theme);
  await page.goto('/devtools');
  await expect(page.locator('body')).toHaveClass(/\bdevtools-page\b/);
  await expect(page.locator('#dt-env-card')).toBeVisible();
  await expect(page.locator('.dt-env-group-toggle').first()).toBeVisible();
}

async function search(page, query) {
  const input = page.locator('#dt-env-search');
  await input.fill(query);
  // Rendering is synchronous on input, but wait for the first matching row.
  await expect(page.locator('#dt-env-tbody tr')).not.toHaveCount(0);
}

async function shot(page, name) {
  await page.locator('#dt-env-card').screenshot({ path: `${SHOTS}/${name}.png` });
}

test.describe('ENV editor exposes subscription and DNS knobs', () => {
  test.use({ viewport: { width: 1600, height: 1400 } });

  for (const theme of ['dark', 'light']) {
    test(`subscription auto-refresh settings are listed in ${theme}`, async ({ page }) => {
      await openEnvEditor(page, theme);

      // The exact key from the report: it used to render "Ничего не найдено".
      await search(page, 'XKEEN_SUBSCRIPTIONS_LOOKAHEAD_SEC');
      await expect(
        page.locator('#dt-env-tbody').getByText('XKEEN_SUBSCRIPTIONS_LOOKAHEAD_SEC', { exact: true }),
      ).toBeVisible();
      await expect(page.locator('#dt-env-tbody')).not.toContainText('Ничего не найдено');
      await shot(page, `01-lookahead-${theme}`);

      // Whole group: Xray + Mihomo schedulers and the URL policy.
      await search(page, 'SUBSCRIPTION');
      await expect(page.locator('#dt-env-tbody')).toContainText('Подписки и автообновление');
      for (const key of [
        'XKEEN_SUBSCRIPTIONS_SCHEDULER',
        'XKEEN_SUBSCRIPTIONS_SCHEDULER_TICK',
        'XKEEN_SUBSCRIPTIONS_LOOKAHEAD_SEC',
        'XKEEN_SUBSCRIPTIONS_RESTART_BATCH',
        'XKEEN_MIHOMO_SUBSCRIPTIONS_SCHEDULER',
        'XKEEN_MIHOMO_SUBSCRIPTIONS_SCHEDULER_TICK',
        'XKEEN_MIHOMO_SUBSCRIPTIONS_LOOKAHEAD_SEC',
        'XKEEN_MIHOMO_SUBSCRIPTIONS_RESTART_BATCH',
        'XKEEN_SUBSCRIPTION_ALLOW_HTTP',
        'XKEEN_SUBSCRIPTION_ALLOW_PRIVATE_HOSTS',
      ]) {
        await expect(page.locator('#dt-env-tbody').getByText(key, { exact: true })).toBeVisible();
      }
      await shot(page, `02-subscriptions-group-${theme}`);

      // DNS-over-VLESS watchdog knobs, documented since the DNS rework.
      await search(page, 'WATCHDOG');
      await expect(page.locator('#dt-env-tbody')).toContainText('DNS-over-VLESS');
      await shot(page, `03-dns-watchdog-${theme}`);
    });
  }

  test('help modal describes the new keys', async ({ page }) => {
    await openEnvEditor(page, 'dark');
    await search(page, 'LOOKAHEAD');
    await page.locator('#dt-env-help-btn').click();
    const modal = page.locator('#dt-env-help-modal');
    await expect(modal).toBeVisible();
    await expect(modal).toContainText('XKEEN_SUBSCRIPTIONS_LOOKAHEAD_SEC');
    await modal.screenshot({ path: `${SHOTS}/04-help-lookahead-dark.png` });
  });
});

import { test, expect } from './fixtures.mjs';
import { STATUS } from './dns_over_vless_fixtures.mjs';
import { mkdirSync } from 'node:fs';


const SHOTS = process.env.XKEEN_DNS_ROLLBACK_SHOTS_DIR || '';
if (SHOTS) mkdirSync(SHOTS, { recursive: true });


test('a rollback follows the Xray restart and refreshes the card automatically', async ({ page }) => {
  let applyStarted = false;
  let statusChecksAfterRollback = 0;

  await page.route('**/api/routing/dns-over-vless', async (route) => {
    const request = route.request();
    if (request.method() === 'POST') {
      applyStarted = true;
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: false,
          code: 'dns_probe_failed',
          error: 'Проверочный DNS-запрос не получил ответа.',
          rolled_back: true,
          rollback: {
            attempted: true,
            configuration_restored: true,
            router_restored: true,
            restart_requested: true,
            restart_ok: true,
            active_core: 'unknown',
            restored: true,
            error: '',
          },
        }),
      });
      return;
    }

    if (applyStarted) statusChecksAfterRollback += 1;
    const activeCore = applyStarted && statusChecksAfterRollback < 5 ? 'unknown' : 'xray';
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...STATUS,
        active_core: activeCore,
        can_enable: activeCore === 'xray',
        blockers: activeCore === 'xray' ? [] : ['Работающий процесс Xray пока не обнаружен.'],
      }),
    });
  });

  await page.route('**/api/routing/dns-over-vless/clients', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ available: true, clients: [], counts: { total: 0, reaches: 0, intercepted: 0, unknown: 0 } }),
    });
  });
  await page.addInitScript(() => localStorage.setItem('xk.routing.rules.open.v2', '1'));
  await page.goto('/');
  await page.locator('#routing-dns-over-vless-btn').click();
  await expect(page.locator('#routing-dns-over-vless-modal')).toBeVisible();

  await page.locator('#routing-dns-over-vless-apply').click();
  await expect(page.locator('#confirm-modal')).toBeVisible();
  await page.locator('#confirm-modal-ok-btn').click();

  const modal = page.locator('#routing-dns-over-vless-modal');
  await expect(page.locator('#routing-dns-over-vless-lead-title'))
    .toHaveText('Откат выполнен — проверяем запуск Xray');
  await expect(page.locator('#routing-dns-over-vless-badge')).toHaveText('Проверяем Xray');
  await expect(page.locator('#routing-dns-over-vless-apply')).toHaveText('Проверяем Xray…');
  await expect(modal).toContainText('Панель проверяет Xray каждую секунду');
  await expect(modal).toContainText('Причина отката: Проверочный DNS-запрос не получил ответа.');
  const operationCopy = await page.locator([
    '#routing-dns-over-vless-lead-title',
    '#routing-dns-over-vless-lead-text',
    '#routing-dns-over-vless-status',
    '#routing-dns-over-vless-details',
  ].join(', ')).allTextContents();
  expect(operationCopy.join(' ')).not.toContain('Mihomo');
  if (SHOTS) {
    await page.locator('#routing-dns-over-vless-modal .modal-content')
      .screenshot({ path: `${SHOTS}/dns-over-vless-rollback-waiting.png` });
  }

  // No click, reopen or page reload: the polling request alone advances the
  // same card from the transitional state to the running process.
  await expect(page.locator('#routing-dns-over-vless-lead-title'))
    .toHaveText('Откат завершён — Xray снова работает', { timeout: 7000 });
  await expect(page.locator('#routing-dns-over-vless-badge')).toHaveText('Откат завершён');
  await expect(modal).toContainText('Xray обнаружен: откатный перезапуск завершён');
  await expect(page.locator('#routing-dns-over-vless-apply')).toHaveText('Включить безопасно');
  expect(statusChecksAfterRollback).toBeGreaterThanOrEqual(5);
  if (SHOTS) {
    await page.locator('#routing-dns-over-vless-modal .modal-content')
      .screenshot({ path: `${SHOTS}/dns-over-vless-rollback-complete.png` });
  }
});

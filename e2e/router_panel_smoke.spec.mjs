import { test, expect, selectPanelView } from './fixtures.mjs';


const enabled = process.env.E2E_ROUTER_SMOKE === '1';


async function openCoreDialog(page, engine = 'mihomo') {
  await page.goto('/');
  await expect(page).not.toHaveURL(/\/(?:login|setup)(?:[/?#]|$)/);

  const trigger = page.locator('.xk-brand-service-trigger');
  await expect(trigger).toBeVisible();
  await trigger.click();

  const action = page.locator(`#xk-mihomo-service-menu [data-xk-svc-core][data-core="${engine}"]`);
  await expect(action).toBeVisible();
  await expect(action).not.toHaveAttribute('aria-disabled', 'true');
  await action.click();
  await expect(page.locator('#core-modal')).toBeVisible();
}


test.describe('Router panel smoke (read-only)', () => {
  test.skip(!enabled, 'Set E2E_ROUTER_SMOKE=1 to target a real router.');

  test('opens Mihomo core management and source selection without applying changes', async ({ page }) => {
    await openCoreDialog(page);

    const source = page.locator('#core-modal [data-core-source][data-core-engine="mihomo"]');
    await expect(source).toBeVisible();
    await expect(source.locator('[data-core-source-version]')).not.toContainText('Проверяем');
    await expect(source.locator('[data-core-source-status]')).not.toContainText('Загружаем состояние');

    await source.getByRole('button', { name: /источник/i }).click();
    const modal = page.locator('#mihomo-core-source-modal');
    await expect(modal).toBeVisible();
    await expect(modal.locator('[data-core-source-profiles] input[type="radio"]')).not.toHaveCount(0);

    await modal.getByRole('button', { name: 'Закрыть выбор источника' }).click();
    await expect(modal).toBeHidden();
  });

  test('Mihomo DNS dialog matches live router diagnostics without changing DNS', async ({ page }, testInfo) => {
    await page.goto('/');
    await selectPanelView(page, 'mihomo');
    await page.locator('#mihomo-clash-tab-config').click();
    const response = page.waitForResponse((result) =>
      new URL(result.url()).pathname === '/api/mihomo/dns'
      && result.request().method() === 'GET');
    await page.locator('#mihomo-dns-btn').click();
    const result = await response;
    expect(result.ok()).toBe(true);
    const status = await result.json();
    expect(status.ok).toBe(true);
    const bypass = status.dns_diagnostics?.bypass;
    expect(bypass).toBeTruthy();
    const badge = page.locator('#mihomo-dns-router-bypass-state');
    await expect(badge).toHaveAttribute('data-state', bypass.router_state);
    await expect(badge).not.toHaveAttribute('data-tooltip', /стенд/);
    if (status.enabled) {
      expect(status.dns_override).toBe(true);
      expect(status.dns_listener_configured).toBe(true);
      expect(bypass.router_state).toBe('safe');
      await expect(badge).toHaveText('DNS роутера: защищён');
    } else if (status.dns_override === false && !status.dns_listener_configured) {
      expect(bypass.router_state).toBe('inactive');
      await expect(badge).toHaveText('DNS роутера: защита выключена');
    }
    await testInfo.attach('dns-diagnostics', {
      body: JSON.stringify({
        enabled: status.enabled, active_core: status.active_core,
        dns_override: status.dns_override, policy: status.keenetic_dns_policy, bypass,
      }, null, 2),
      contentType: 'application/json',
    });
    await testInfo.attach('dns-dialog', {
      body: await page.locator('#mihomo-dns-modal .modal-content').screenshot(),
      contentType: 'image/png',
    });
  });
});

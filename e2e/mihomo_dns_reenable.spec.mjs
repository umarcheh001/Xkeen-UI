import { test, expect, selectPanelView, openMihomoConfig } from './fixtures.mjs';

const BASE_STATUS = {
  ok: true,
  enabled: false,
  prepared: false,
  partial: true,
  tampered: true,
  can_recover: false,
  can_enable: false,
  can_reenable: true,
  can_disable: false,
  can_release: false,
  can_reconfigure: false,
  active_core: 'mihomo',
  proxy_group: 'Заблок. сервисы',
  proxy_groups: ['Заблок. сервисы'],
  dns_override: false,
  dns_present: true,
  dns_enabled: false,
  dns_listener_configured: false,
  listen: '0.0.0.0:53',
  mode: 'redir-host',
  blockers: [
    'Сохранённый пользовательский DNS-блок отключён. Его можно включить обратно без удаления комментариев и ручных правок.',
  ],
  watchdog: {
    source: 'user',
    reason: 'DNS возвращён прошивке Keenetic без восстановления старого снимка.',
  },
  watchdog_settings: { enabled: true, interval: 30, fail_threshold: 3, restart_attempts: 2 },
};

const ENABLED_STATUS = {
  ...BASE_STATUS,
  enabled: true,
  prepared: true,
  partial: false,
  tampered: false,
  can_reenable: false,
  can_disable: true,
  can_reconfigure: true,
  dns_override: true,
  dns_enabled: true,
  dns_listener_configured: true,
};

test('Mihomo DNS offers one-click re-enable for a preserved edited block', async ({ page }) => {
  let resumed = false;

  await page.route('**/api/mihomo/dns', async (route) => {
    if (route.request().method() === 'POST') {
      expect(route.request().postDataJSON().action).toBe('resume');
      resumed = true;
      await route.fulfill({ json: { ok: true, enabled: true, reenabled: true, probe: { latency_ms: 4 } } });
      return;
    }
    await route.fulfill({ json: resumed ? ENABLED_STATUS : BASE_STATUS });
  });
  await page.route('**/api/mihomo-config', async (route) => {
    await route.fulfill({ json: { ok: true, content: 'dns:\n  enable: true\n  listen: 0.0.0.0:53\n# TEST\n' } });
  });

  await page.goto('/');
  await selectPanelView(page, 'mihomo');
  await openMihomoConfig(page);
  await page.locator('#mihomo-dns-btn').click();

  await expect(page.locator('#mihomo-dns-badge')).toHaveText('Готово к повторному включению');
  await expect(page.locator('#mihomo-dns-status')).toContainText('включить его обратно одной кнопкой');
  await expect(page.locator('#mihomo-dns-apply')).toHaveText('Включить сохранённый DNS');

  await page.locator('#mihomo-dns-apply').click();
  await expect(page.locator('#confirm-modal')).toContainText('dns.enable на true');
  await expect(page.locator('#confirm-modal')).toContainText('пользовательские правки');
  await page.locator('#confirm-modal-ok-btn').click();

  await expect.poll(() => resumed).toBe(true);
  await expect(page.locator('#toast-container .toast').filter({ hasText: 'Защищённый DNS включён' })).toBeVisible();
  await expect(page.locator('#mihomo-dns-apply')).toHaveText('Отключить и восстановить');
});

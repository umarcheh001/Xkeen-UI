import { test, expect, selectPanelView } from './fixtures.mjs';


const STATUS = {
  ok: true,
  enabled: true,
  prepared: true,
  partial: false,
  tampered: false,
  can_recover: false,
  can_enable: false,
  can_disable: true,
  active_core: 'mihomo',
  proxy_group: 'PROXY',
  dns_override: true,
  dns_present: true,
  dns_enabled: true,
  dns_listener_configured: true,
  listen: '0.0.0.0:53',
  mode: 'redir-host',
  blockers: [],
  keenetic_dns_policy: {
    transit_intercept: false,
    provider_ignored: true,
    provider_interfaces: [{
      name: 'GigabitEthernet1',
      ignored: true,
      ipv4_ignored: true,
      ipv6_ignored: true,
    }],
  },
  dns_diagnostics: {
    bypass: {
      state: 'safe',
      router_state: 'safe',
      client_state: 'unknown',
      client_reason: 'Клиентские DNS нельзя подтвердить из панели.',
      reasons: [],
    },
    upstreams: { items: [] },
  },
  watchdog: null,
  watchdog_settings: { enabled: true, interval: 30, fail_threshold: 3, restart_attempts: 2 },
};


test('Mihomo DNS reports a secured active WAN without a stale provider warning', async ({ page }) => {
  await page.route('**/api/mihomo/dns', async (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(STATUS),
  }));

  await page.goto('/');
  await selectPanelView(page, 'mihomo');
  await page.locator('#mihomo-clash-tab-config').click();
  await page.locator('#mihomo-dns-btn').click();

  const modal = page.locator('#mihomo-dns-modal');
  await expect(modal).toBeVisible();
  const bypass = modal.locator('#mihomo-dns-router-bypass-state');
  await expect(bypass).toHaveText('DNS роутера: защищён');
  await expect(bypass).toHaveAttribute(
    'data-tooltip',
    'Пути DNS на роутере проверены. Клиентские DNS нельзя подтвердить из панели.',
  );
  await expect(modal.locator('#mihomo-dns-details')).toContainText('DNS провайдера: игнорируется');
  await expect(modal.locator('#mihomo-dns-details')).toContainText('Транзит запросов: выключен');
  await expect(modal.locator('#mihomo-dns-details')).not.toContainText('DNS bypass: DNS провайдера');
});

for (const state of ['inactive', 'unknown', 'warning']) {
  test(`Mihomo DNS explains ${state} without test-environment wording`, async ({ page }) => {
    const reason = state === 'warning'
      ? 'IPv6 DNS провайдера на WAN-интерфейсе не игнорируется'
      : 'Не удалось определить настройки IPv6 DNS провайдера';
    const status = structuredClone(STATUS);
    if (state === 'inactive') {
      Object.assign(status, {
        enabled: false, prepared: false, can_enable: true, can_disable: false,
        dns_override: false, dns_present: false, dns_enabled: false, dns_listener_configured: false,
      });
    }
    Object.assign(status.dns_diagnostics.bypass, {
      state, router_state: state, reasons: state === 'inactive' ? [] : [reason],
    });
    await page.route('**/api/mihomo/dns', (route) => route.fulfill({ json: status }));
    await page.goto('/');
    await selectPanelView(page, 'mihomo');
    await page.locator('#mihomo-clash-tab-config').click();
    await page.locator('#mihomo-dns-btn').click();

    const badge = page.locator('#mihomo-dns-router-bypass-state');
    await expect(badge).toHaveAttribute('data-state', state);
    await expect(badge).toHaveText(state === 'inactive'
      ? 'DNS роутера: защита выключена'
      : (state === 'warning' ? 'DNS роутера: требует внимания' : 'DNS роутера: не подтверждён'));
    await expect(badge).toHaveAttribute('data-tooltip', state === 'inactive'
      ? 'Защищённый DNS Mihomo выключен. Устройства используют DNS Keenetic. После включения панель проверит защищённый DNS.'
      : reason);
    await expect(badge).not.toHaveAttribute('data-tooltip', /стенд|все пути/);
  });
}

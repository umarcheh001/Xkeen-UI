import { test, expect } from './fixtures.mjs';
import { STATUS, openDialog } from './dns_over_vless_fixtures.mjs';


// Ядро, отвергнувшее конфигурацию, не запускается вовсе, и панель до сих пор
// привязывала любое действие к живому процессу Xray: владелец не мог ни
// включить функцию, ни выключить -- а выключение как раз и убирает фрагмент,
// из-за которого ядро не поднимается. Бэкенд теперь пропускает выключение, и
// окно обязано дать его нажать, а не только объяснить положение.
const CORE_DOWN = {
  ...STATUS,
  enabled: true,
  can_enable: false,
  can_disable: true,
  active_core: 'unknown',
  available_cores: ['xray'],
  dns_override: true,
};


test('при незапущенном Xray окно позволяет снять настройку', async ({ page }) => {
  await openDialog(page, CORE_DOWN);

  const apply = page.locator('#routing-dns-over-vless-apply');
  await expect(apply).toBeVisible();
  await expect(apply).toBeEnabled();
  // Кнопка снимает настройку, а не включает её.
  await expect(apply).toHaveClass(/btn-danger/);

  // Объяснение должно называть выход, иначе кнопку рядом читают как опасную.
  const status = page.locator('#routing-dns-over-vless-status');
  await expect(status).toContainText('процесс Xray сейчас не найден');
  await expect(status).toContainText('снимет настройку DNS-over-VLESS');
});


test('снятие настройки при лежащем ядре доходит до панели', async ({ page }) => {
  await openDialog(page, CORE_DOWN);

  const sent = [];
  await page.route('**/api/routing/dns-over-vless', async (route) => {
    const request = route.request();
    if (request.method() === 'POST') {
      sent.push(JSON.parse(request.postData() || '{}'));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...CORE_DOWN, enabled: false, can_disable: false, can_enable: true }),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(CORE_DOWN) });
  });

  await page.locator('#routing-dns-over-vless-apply').click();
  // Снятие защиты спрашивает подтверждение, как и включение.
  await expect(page.locator('#confirm-modal')).not.toHaveClass(/hidden/);
  await page.locator('#confirm-modal-ok-btn').click();

  await expect.poll(() => sent.map((item) => item.action)).toContain('disable');
});

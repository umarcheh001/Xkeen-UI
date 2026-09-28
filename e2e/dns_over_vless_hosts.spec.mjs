import { test, expect } from './fixtures.mjs';
import { openDialog, openZone, STATUS } from './dns_over_vless_fixtures.mjs';


// «Подмена адресов» — необязательная секция: имя получает адреса другого
// имени, а SNI остаётся своим. Записи приходят объектом, в окне — по строке.

async function catchApply(page, status) {
  // После openDialog: последний зарегистрированный обработчик побеждает.
  const box = { sent: null };
  await page.route('**/api/routing/dns-over-vless', async (route) => {
    if (route.request().method() === 'POST') {
      box.sent = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, action: 'enable', enabled: true, restarted: true, probe: { ok: true } }),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(status) });
  });
  return box;
}

async function applyDialog(page) {
  await page.locator('#routing-dns-over-vless-apply').click();
  await expect(page.locator('#confirm-modal')).not.toHaveClass(/hidden/);
  await page.locator('#confirm-modal-ok-btn').click();
}

const zone = (page) => page.locator('.xk-dns-zone[data-zone="hosts"]');
const summary = (page) => page.locator('[data-zone-sum="hosts"]');


test('без записей секция необязательная и говорит «не используется»', async ({ page }) => {
  await openDialog(page);

  await expect(zone(page)).toBeVisible();
  await expect(zone(page).locator('.xk-dns-zone-req')).toHaveCount(0);
  await expect(summary(page)).toHaveText('не используется');
});


test('записи с сервера видны строками, сводка считает их', async ({ page }) => {
  await openDialog(page, {
    ...STATUS,
    hosts: { 'full:m.youtube.com': 'www.youtube.com', 'domain:example.org': ['1.2.3.4', '5.6.7.8'] },
  });

  await expect(summary(page)).toHaveText('2 записи');
  await openZone(page, 'hosts');
  await expect(page.locator('#routing-dns-over-vless-hosts')).toHaveValue(
    'full:m.youtube.com = www.youtube.com\ndomain:example.org = 1.2.3.4, 5.6.7.8',
  );
});


test('введённая запись уходит на сервер текстом', async ({ page }) => {
  await openDialog(page, STATUS);
  await openZone(page, 'hosts');
  const box = await catchApply(page, STATUS);

  await page.locator('#routing-dns-over-vless-hosts').fill('m.youtube.com = www.youtube.com');
  await expect(summary(page)).toHaveText('1 запись');
  await applyDialog(page);

  await expect.poll(() => box.sent).not.toBeNull();
  expect(box.sent.hosts).toBe('m.youtube.com = www.youtube.com');
});


test('«Не использовать эту область» стирает записи и уходит пустой строкой', async ({ page }) => {
  const status = { ...STATUS, hosts: { 'm.youtube.com': 'www.youtube.com' } };
  await openDialog(page, status);
  await openZone(page, 'hosts');
  const box = await catchApply(page, status);

  await page.locator('#routing-dns-over-vless-hosts-clear').click();
  await expect(page.locator('#routing-dns-over-vless-hosts')).toHaveValue('');
  await expect(summary(page)).toHaveText('не используется');
  await expect(page.locator('#routing-dns-over-vless-hosts-clear')).toBeDisabled();
  await applyDialog(page);

  await expect.poll(() => box.sent).not.toBeNull();
  expect(box.sent.hosts).toBe('');
});

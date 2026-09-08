import { test, expect } from './fixtures.mjs';
import { openDialog, openZone, STATUS } from './dns_over_vless_fixtures.mjs';


// Резолвер прошивки — отдельная настройка, включённая по умолчанию: адрес
// панель находит сама, человек видит найденное и узнаёт о расхождении, а поле
// рядом остаётся под собственные резолверы сети.

async function catchApply(page, status) {
  // Регистрируем route ПОСЛЕ openDialog: она сама вешает обработчик на этот
  // же путь, и последний зарегистрированный обработчик побеждает — иначе
  // POST тоже уезжает в статичную заглушку статуса и sent остаётся null.
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


test('подсказка называет найденные резолверы прошивки', async ({ page }) => {
  await openDialog(page, { ...STATUS, firmware_resolvers: ['127.0.0.1:41100', '127.0.0.1:41101'] });
  await openZone(page, 'home');

  const hint = page.locator('#routing-dns-over-vless-local-hint');
  await expect(hint).toBeVisible();
  await expect(hint).toContainText('127.0.0.1:41100');
  await expect(hint).toContainText('127.0.0.1:41101');
});


test('галочка включена по умолчанию, поле своих резолверов пустое', async ({ page }) => {
  await openDialog(page, { ...STATUS, firmware_resolvers: ['127.0.0.1:41100'] });
  await openZone(page, 'home');

  await expect(page.locator('#routing-dns-over-vless-firmware')).toBeChecked();
  await expect(page.locator('#routing-dns-over-vless-local')).toHaveValue('');
  // Зоны нужны и без своих резолверов: на них отвечает прошивка.
  await expect(page.locator('#routing-dns-over-vless-zones-row')).toBeVisible();
});


test('расхождение с записанным адресом видно', async ({ page }) => {
  await openDialog(page, {
    ...STATUS,
    enabled: true,
    firmware_resolvers_applied: ['127.0.0.1:41100'],
    firmware_resolvers: ['127.0.0.1:41101'],
  });
  await openZone(page, 'home');

  const hint = page.locator('#routing-dns-over-vless-local-hint');
  await expect(hint).toContainText('больше не слушает');
  await expect(hint).toHaveClass(/routing-dns-over-vless-local-hint--warn/);
});


test('частичное совпадение предупреждением не считается', async ({ page }) => {
  // Один живой резолвер отвечает за все зоны сразу — второй адрес может
  // устареть без вреда для функции, пугать тут нечем.
  await openDialog(page, {
    ...STATUS,
    enabled: true,
    firmware_resolvers_applied: ['127.0.0.1:41100', '127.0.0.1:41102'],
    firmware_resolvers: ['127.0.0.1:41100', '127.0.0.1:41101'],
  });
  await openZone(page, 'home');

  const hint = page.locator('#routing-dns-over-vless-local-hint');
  await expect(hint).toBeVisible();
  await expect(hint).not.toContainText('больше не слушает');
  await expect(hint).not.toHaveClass(/routing-dns-over-vless-local-hint--warn/);
});


test('прошивка не найдена — об этом говорят прямо', async ({ page }) => {
  // Молчаливо пустая подсказка читалась бы как «всё в порядке», хотя домашние
  // имена в этом случае разрешать некому.
  await openDialog(page, { ...STATUS, firmware_resolvers: [] });
  await openZone(page, 'home');

  const hint = page.locator('#routing-dns-over-vless-local-hint');
  await expect(hint).toBeVisible();
  await expect(hint).toContainText('не найден');
});


test('снятая галочка прячет подсказку про прошивку', async ({ page }) => {
  await openDialog(page, { ...STATUS, firmware_resolvers: ['127.0.0.1:41100'] });
  await openZone(page, 'home');

  await page.locator('.xk-dns-zone[data-zone="home"] .dt-switch').click();

  await expect(page.locator('#routing-dns-over-vless-local-hint')).toBeHidden();
});


test('включение по умолчанию уходит с согласием на резолвер прошивки', async ({ page }) => {
  const status = { ...STATUS, firmware_resolvers: ['127.0.0.1:41100'] };
  await openDialog(page, status);
  await openZone(page, 'home');
  const box = await catchApply(page, status);

  await applyDialog(page);

  await expect.poll(() => box.sent).not.toBeNull();
  expect(box.sent.use_firmware_resolver).toBe(true);
  expect(box.sent.local_resolver).toBe('');
});


test('снятая галочка доезжает до сервера отказом', async ({ page }) => {
  // Осознанный отказ обязан доехать: иначе следующее включение молча вернёт
  // резолвер прошивки вместо того, что человек выбрал.
  const status = { ...STATUS, firmware_resolvers: ['127.0.0.1:41100'] };
  await openDialog(page, status);
  await openZone(page, 'home');
  await page.locator('.xk-dns-zone[data-zone="home"] .dt-switch').click();
  const box = await catchApply(page, status);

  await applyDialog(page);

  await expect.poll(() => box.sent).not.toBeNull();
  expect(box.sent.use_firmware_resolver).toBe(false);
});


test('свой резолвер уходит вместе с согласием на прошивку', async ({ page }) => {
  const status = { ...STATUS, firmware_resolvers: ['127.0.0.1:41100'] };
  await openDialog(page, status);
  await openZone(page, 'home');
  await page.locator('#routing-dns-over-vless-local').fill('192.168.1.1');
  const box = await catchApply(page, status);

  await applyDialog(page);

  await expect.poll(() => box.sent && box.sent.local_resolver).toBe('192.168.1.1');
  expect(box.sent.use_firmware_resolver).toBe(true);
});

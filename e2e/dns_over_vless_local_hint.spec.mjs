import { test, expect } from './fixtures.mjs';
import { openDialog, openZone, STATUS } from './dns_over_vless_fixtures.mjs';


// Подсказка про резолвер прошивки: видно найденное, кнопка подставляет,
// расхождение видно глазами, а частичное совпадение предупреждением не
// считается.

test('подсказка называет найденные резолверы прошивки', async ({ page }) => {
  await openDialog(page, { ...STATUS, firmware_resolvers: ['127.0.0.1:41100', '127.0.0.1:41101'] });
  await openZone(page, 'home');

  const hint = page.locator('#routing-dns-over-vless-local-hint');
  await expect(hint).toBeVisible();
  await expect(hint).toContainText('127.0.0.1:41100');
  await expect(hint).toContainText('127.0.0.1:41101');
});


test('кнопка подставляет найденное в поле', async ({ page }) => {
  await openDialog(page, { ...STATUS, firmware_resolvers: ['127.0.0.1:41100'] });
  await openZone(page, 'home');

  await page.click('#routing-dns-over-vless-local-apply');

  await expect(page.locator('#routing-dns-over-vless-local')).toHaveValue('127.0.0.1:41100');
});


test('расхождение с записанным адресом видно', async ({ page }) => {
  await openDialog(page, {
    ...STATUS,
    local_resolvers: ['127.0.0.1:41100'],
    firmware_resolvers: ['127.0.0.1:41101'],
  });
  await openZone(page, 'home');

  const hint = page.locator('#routing-dns-over-vless-local-hint');
  await expect(hint).toContainText('больше не слушает');
  await expect(hint).toHaveClass(/routing-dns-over-vless-local-hint--warn/);
});


test('без прошивки подсказки нет', async ({ page }) => {
  await openDialog(page, { ...STATUS, firmware_resolvers: [] });
  await openZone(page, 'home');

  await expect(page.locator('#routing-dns-over-vless-local-hint')).toBeHidden();
});


test('частичное совпадение предупреждением не считается', async ({ page }) => {
  // Один живой резолвер отвечает за все зоны сразу — второй адрес в поле
  // может устареть без вреда для функции, пугать тут нечем.
  await openDialog(page, {
    ...STATUS,
    local_resolvers: ['127.0.0.1:41100', '127.0.0.1:41102'],
    firmware_resolvers: ['127.0.0.1:41100', '127.0.0.1:41101'],
  });
  await openZone(page, 'home');

  const hint = page.locator('#routing-dns-over-vless-local-hint');
  await expect(hint).toBeVisible();
  await expect(hint).not.toContainText('больше не слушает');
  await expect(hint).not.toHaveClass(/routing-dns-over-vless-local-hint--warn/);
});


// Критерий 2 спеки: включение с пустым нетронутым полем должно оставлять
// автоподстановку резолвера прошивки серверу, а не подменять её осознанной
// очисткой. Ключ local_resolver в запросе уходит только когда поле реально
// тронуто (руками очищено или в него что-то вписано).

test('пустое нетронутое поле — включение уходит без local_resolver', async ({ page }) => {
  const status = { ...STATUS, firmware_resolvers: ['127.0.0.1:41100'] };
  await openDialog(page, status);
  await openZone(page, 'home');

  // Поле резолвера пустое, никто его не трогал.
  await expect(page.locator('#routing-dns-over-vless-local')).toHaveValue('');

  // Регистрируем route ПОСЛЕ openDialog: она сама вешает обработчик на этот
  // же путь, и последний зарегистрированный обработчик побеждает — иначе
  // POST тоже уезжает в статичную заглушку статуса и sent остаётся null.
  let sent = null;
  await page.route('**/api/routing/dns-over-vless', async (route) => {
    if (route.request().method() === 'POST') {
      sent = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, action: 'enable', enabled: true, restarted: true, probe: { ok: true } }),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(status) });
  });

  await page.locator('#routing-dns-over-vless-apply').click();
  await expect(page.locator('#confirm-modal')).not.toHaveClass(/hidden/);
  await page.locator('#confirm-modal-ok-btn').click();

  await expect.poll(() => sent).not.toBeNull();
  expect(Object.prototype.hasOwnProperty.call(sent, 'local_resolver')).toBe(false);
});


test('адрес вписан руками — включение уходит с local_resolver', async ({ page }) => {
  const status = { ...STATUS, firmware_resolvers: ['127.0.0.1:41100'] };
  await openDialog(page, status);
  await openZone(page, 'home');

  await page.locator('#routing-dns-over-vless-local').fill('192.168.1.1');

  // См. комментарий выше: route регистрируется после openDialog нарочно.
  let sent = null;
  await page.route('**/api/routing/dns-over-vless', async (route) => {
    if (route.request().method() === 'POST') {
      sent = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, action: 'enable', enabled: true, restarted: true, probe: { ok: true } }),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(status) });
  });

  await page.locator('#routing-dns-over-vless-apply').click();
  await expect(page.locator('#confirm-modal')).not.toHaveClass(/hidden/);
  await page.locator('#confirm-modal-ok-btn').click();

  await expect.poll(() => sent && sent.local_resolver).toBe('192.168.1.1');
});


test('сохранённый адрес стёрли руками — включение уходит с пустым local_resolver', async ({ page }) => {
  // Обратная сторона той же развилки: панель подставляет своё только пока
  // человек ничего не решил. Стёртое руками поле — это решение, и оно
  // обязано доехать до сервера пустой строкой, иначе следующее включение
  // молча вернёт резолвер прошивки вместо осознанного отказа.
  const status = {
    ...STATUS,
    firmware_resolvers: ['127.0.0.1:41100'],
    local_resolvers: ['127.0.0.1:41100'],
    local_domains: ['domain:lan'],
  };
  await openDialog(page, status);
  await openZone(page, 'home');

  const field = page.locator('#routing-dns-over-vless-local');
  await expect(field).toHaveValue('127.0.0.1:41100');
  await field.fill('');

  // См. комментарий выше: route регистрируется после openDialog нарочно.
  let sent = null;
  await page.route('**/api/routing/dns-over-vless', async (route) => {
    if (route.request().method() === 'POST') {
      sent = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, action: 'enable', enabled: true, restarted: true, probe: { ok: true } }),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(status) });
  });

  await page.locator('#routing-dns-over-vless-apply').click();
  await expect(page.locator('#confirm-modal')).not.toHaveClass(/hidden/);
  await page.locator('#confirm-modal-ok-btn').click();

  await expect.poll(() => sent).not.toBeNull();
  expect(Object.prototype.hasOwnProperty.call(sent, 'local_resolver')).toBe(true);
  expect(sent.local_resolver).toBe('');
});

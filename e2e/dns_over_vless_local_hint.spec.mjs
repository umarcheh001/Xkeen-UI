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

import { test, expect } from './fixtures.mjs';

/* Хост экранов верхнего уровня при первом монтировании переносит всю разметку
   body внутрь своего контейнера. Перенос узла — это удаление и вставка, и
   фокус на нём браузер снимает молча: пользователь, нажавший Tab в первые
   доли секунды, оказывался ни на чём. */

test('перенос разметки при старте не роняет фокус', async ({ page }) => {
  // Придерживаем модули, пока не поставим фокус: иначе перенос успевает
  // случиться раньше — ровно та гонка, из-за которой флакует panel_operator_i5.
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  await page.route('**/static/frontend-build/assets/*.js', async (route) => {
    await gate;
    await route.continue();
  });

  await page.goto('/', { waitUntil: 'commit' });
  // Кнопка темы: её, в отличие от кнопки ядра, панель не выключает на время
  // загрузки статуса — иначе проверялся бы не перенос, а выключение.
  const button = page.locator('#theme-toggle-btn');
  await expect(button).toBeAttached();
  await button.focus();
  expect(await page.evaluate(() => document.activeElement?.id)).toBe('theme-toggle-btn');

  release();
  // Ждём сам перенос: контейнер экрана появляется в body вместе с ним.
  await expect(page.locator('#xk-top-level-screen-mount [data-xk-top-level-screen-root]').first()).toBeAttached();
  await expect(page.locator('body')).toHaveClass(/\bpanel-page\b/);
  await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('theme-toggle-btn');
});

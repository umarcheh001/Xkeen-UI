import { test, expect } from './fixtures.mjs';

/* Пока грузится статус ядра, кнопка в шапке показывает скелетон. Раньше на это
   время она становилась `disabled`, а выключенный элемент браузер лишает
   фокуса: пользователь, добравшийся до кнопки клавиатурой, оказывался ни на
   чём. Теперь состояние объявляется через `aria-disabled`.

   Компактная шапка убрала управление сервисом в меню бренда, поэтому кнопку
   сначала надо открыть: закрытое меню помечено `hidden`, а скрытый элемент
   фокус не принимает — проверка фокуса без открытия меню зеленела бы впустую. */

// Держит ответ о статусе, пока тест не отпустит: состояние загрузки живёт
// ровно столько, сколько идёт запрос, и поймать его иначе нельзя.
async function holdStatus(page) {
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  // Держать надо оба: `status` оставляет скелетон, а выключение снимает
  // только ответ `core` — задержишь один, и окна загрузки не увидишь.
  for (const endpoint of ['**/api/xkeen/status', '**/api/xkeen/core']) {
    await page.route(endpoint, async (route) => {
      await gate;
      await route.continue();
    });
  }
  return release;
}

async function openServiceMenu(page) {
  const trigger = page.locator('.xk-brand-service-trigger');
  await expect(trigger).toBeVisible();
  await trigger.click();
  await expect(page.locator('#xk-mihomo-service-menu')).toBeVisible();
}

async function activeElementId(page) {
  return page.evaluate(() => document.activeElement?.id || document.activeElement?.nodeName || null);
}

test('фокус на кнопке ядра переживает окончание загрузки', async ({ page }) => {
  const release = await holdStatus(page);
  await page.goto('/');
  await openServiceMenu(page);

  const core = page.locator('#xkeen-core-text');
  await expect(core).toHaveAttribute('data-loading', 'true');
  await core.focus();
  expect(await activeElementId(page)).toBe('xkeen-core-text');

  release();
  await expect(core).not.toHaveAttribute('data-loading', 'true');
  // Будь кнопка на время загрузки `disabled`, браузер отобрал бы фокус молча,
  // а снятие выключения его уже не вернуло бы.
  expect(await activeElementId(page)).toBe('xkeen-core-text');
});


test('во время загрузки кнопка ядра не открывает окно выбора', async ({ page }) => {
  const release = await holdStatus(page);
  await page.goto('/');
  await openServiceMenu(page);
  const core = page.locator('#xkeen-core-text');
  await expect(core).toHaveAttribute('data-loading', 'true');
  await expect(core).toHaveAttribute('aria-disabled', 'true');

  // Мышиный клик гасит pointer-events, а клавиатура доходит до обработчика —
  // значит отбой нужен в нём самом.
  await core.focus();
  expect(await activeElementId(page)).toBe('xkeen-core-text');
  await page.keyboard.press('Enter');
  await expect(page.locator('#core-modal')).toBeHidden();

  release();
  await expect(core).not.toHaveAttribute('data-loading', 'true');
  await expect(core).not.toHaveAttribute('aria-disabled', 'true');
});

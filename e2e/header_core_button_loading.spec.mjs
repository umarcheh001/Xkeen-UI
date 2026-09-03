import { test, expect } from './fixtures.mjs';

/* Пока грузится статус ядра, кнопка в шапке показывает скелетон. Раньше на это
   время она становилась `disabled`, а выключенный элемент браузер лишает
   фокуса: пользователь, добравшийся до кнопки клавиатурой, оказывался ни на
   чём. Теперь состояние объявляется через `aria-disabled`. */

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

test('фокус на кнопке ядра переживает инициализацию панели', async ({ page }) => {
  // Ставим фокус в первый же кадр, как только кнопка появилась в разметке, —
  // так же, как это делает пользователь, нажавший Tab сразу после загрузки.
  // Окно, в котором кнопка выключена, короткое: следующий же рендер шапки
  // снимает выключение, поэтому ловить его ожиданием бесполезно.
  await page.addInitScript(() => {
    window.__focusLost = null;
    const attach = () => {
      const el = document.getElementById('xkeen-core-text');
      if (!el) { requestAnimationFrame(attach); return; }
      el.addEventListener('blur', () => {
        if (window.__focusLost === null) {
          window.__focusLost = document.activeElement?.id || document.activeElement?.nodeName || 'unknown';
        }
      });
      el.focus();
    };
    attach();
  });

  await page.goto('/');
  const core = page.locator('#xkeen-core-text');
  await expect(core).not.toHaveAttribute('data-loading', 'true');
  expect(await page.evaluate(() => window.__focusLost)).toBe(null);
  expect(await page.evaluate(() => document.activeElement?.id)).toBe('xkeen-core-text');
});


test('во время загрузки кнопка ядра не открывает окно выбора', async ({ page }) => {
  const release = await holdStatus(page);
  await page.goto('/');
  const core = page.locator('#xkeen-core-text');
  await expect(core).toHaveAttribute('data-loading', 'true');
  await expect(core).toHaveAttribute('aria-disabled', 'true');

  // Мышиный клик гасит pointer-events, а клавиатура доходит до обработчика —
  // значит отбой нужен в нём самом.
  await core.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#core-modal')).toBeHidden();

  release();
  await expect(core).not.toHaveAttribute('data-loading', 'true');
  await expect(core).not.toHaveAttribute('aria-disabled', 'true');
});

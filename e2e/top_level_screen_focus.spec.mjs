import { test, expect } from './fixtures.mjs';

/* Хост экранов верхнего уровня при первом монтировании переносит всю разметку
   body внутрь своего контейнера. Перенос узла — это удаление и вставка, и
   фокус на нём браузер снимает молча: пользователь, добравшийся до кнопки
   клавиатурой, оказывался ни на чём.

   Снаружи фокус в нужный момент не поставить. Пока идёт старт, компактная
   шапка гасит себя целиком (`visibility: hidden` — защита от мигания, пока
   контролы перекладывают по меню), а невидимый элемент браузер не фокусирует.
   Окно между снятием стража и переносом — доли секунды, поэтому фокус ставит
   сама страница, а тест проверяет, что успел попасть в это окно. */

// Монитор ресурсов: кнопка живёт в разметке страницы, шапка её не пересоздаёт,
// а после старта она видима — в отличие от кнопок темы и ядра, которые
// компактная шапка убирает в закрытые меню.
const TARGET_ID = 'xk-resource-monitor';

test('перенос разметки при старте не роняет фокус', async ({ page }) => {
  await page.addInitScript((targetId) => {
    window.__focusProbe = { focused: null, beforeMove: null };
    const observer = new MutationObserver(() => {
      const body = document.body;
      if (!body || window.__focusProbe.focused) return;
      // Старт ещё идёт — шапка невидима, фокус на неё не встанет.
      if (body.classList.contains('xk-panel-startup')) return;
      if (body.classList.contains('xk-operator-header-pending')) return;

      const target = document.getElementById(targetId);
      if (!target) return;
      target.focus();
      if (document.activeElement !== target) return;

      window.__focusProbe.focused = targetId;
      // Если перенос уже случился, проверять нечего: тест обязан упасть, а не
      // позеленеть впустую.
      window.__focusProbe.beforeMove = !document.getElementById('xk-top-level-screen-mount');
      observer.disconnect();
    });

    const start = () => observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['class'],
    });
    if (document.documentElement) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });
  }, TARGET_ID);

  await page.goto('/');

  // Ждём сам перенос: контейнер экрана появляется в body вместе с ним.
  await expect(page.locator('#xk-top-level-screen-mount [data-xk-top-level-screen-root]').first()).toBeAttached();
  await expect(page.locator('body')).toHaveClass(/\bpanel-page\b/);

  const probe = await page.evaluate(() => window.__focusProbe);
  expect(probe.focused).toBe(TARGET_ID);
  expect(probe.beforeMove).toBe(true);
  await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe(TARGET_ID);
});

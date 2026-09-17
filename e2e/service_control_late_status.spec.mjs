import { test, expect } from './fixtures.mjs';

/* Статус сервиса опрашивается по таймеру, и его ответ может прийти уже после
   того, как пользователь нажал «Перезапустить». Такой запоздавший ответ
   описывает состояние ДО операции, и записывать его нельзя: он снимал признак
   «идёт операция», после чего перезапуск терял право показать свой итог.
   Пользователь видел только «Перезапускаем xkeen...» — и это сообщение висело
   до конца собственного таймера (40 секунд), хотя ядро уже перезапустилось. */

function json(route, payload) {
  return route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(payload),
  });
}

test('итог перезапуска показывается, даже если ответ о статусе опоздал', async ({ page }) => {
  test.setTimeout(120_000);

  let armed = false;
  let heldRequests = 0;
  let releaseHeld = () => {};
  const held = new Promise((resolve) => { releaseHeld = resolve; });

  // Придерживаем ровно один ответ о статусе — тот, что опрос запросит уже
  // после загрузки панели. Он и должен опоздать к нажатию.
  await page.route('**/api/xkeen/status', async (route) => {
    if (armed && heldRequests === 0) {
      heldRequests += 1;
      await held;
    }
    await json(route, { running: true, core: 'xray' });
  });

  // Без WebSocket-токена ожидание задачи идёт понятным HTTP-опросом.
  await page.route('**/api/ws-token', (route) => json(route, { ok: false }));
  await page.route('**/api/run-command', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    return json(route, { ok: true, job_id: 'restart-job' });
  });
  await page.route('**/api/run-command/restart-job', (route) => json(route, {
    ok: true,
    status: 'finished',
    exit_code: 0,
    output: 'xkeen restarted',
    job_id: 'restart-job',
  }));

  await page.goto('/');
  armed = true;

  // Нажимать нужно, пока запрос статуса в полёте, — иначе гонки не будет.
  await expect.poll(() => heldRequests, { timeout: 60_000 }).toBe(1);
  // Кнопки управления сервисом живут в меню статуса компактной шапки.
  await page.locator('.xk-brand-service-trigger').click();
  await page.locator('#xkeen-restart-btn').click();

  const pending = page.locator('#toast-container .toast-message', { hasText: 'Перезапускаем xkeen' });
  await expect(pending).toBeVisible();

  releaseHeld();

  const result = page.locator('#toast-container .toast-message', { hasText: 'xkeen перезапущен' });
  await expect(result).toBeVisible({ timeout: 30_000 });
  await expect(pending).toHaveCount(0);
});

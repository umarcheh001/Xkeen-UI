import { test, expect, selectPanelView } from './fixtures.mjs';
import { mockClients, openDialog, STATUS } from './dns_over_vless_fixtures.mjs';


// Перезапуск ядра может оборвать соединение браузера посреди включения или
// выключения защиты DNS: операция на роутере доходит до конца, а ответ
// теряется. Окно тогда достаёт итог из статуса по номеру операции.

const VLESS_ON = {
  ...STATUS,
  enabled: true,
  prepared: true,
  can_enable: false,
  can_disable: true,
  dns_override: true,
  selected_targets: ['proxy'],
  choice_required: false,
};
const VLESS_OFF = { ...STATUS, selected_targets: ['proxy'], choice_required: false };

// Первый POST окна: запоминаем номер операции и решаем, что стало с ответом.
// После этого статус начинает отдавать записанный итог.
async function loseAnswer(page, url, { before, after, answer, hang = false, lateBy = 0 }) {
  const box = { id: null, posts: 0, statusAfter: 0 };
  await page.route(url, async (route) => {
    const request = route.request();
    if (request.method() === 'POST') {
      box.posts += 1;
      box.id = request.postDataJSON().operation_id;
      if (hang) return; // ответ так и не приходит
      await route.abort('connectionreset');
      return;
    }
    let body = before;
    if (box.id) {
      box.statusAfter += 1;
    }
    // Роутер ещё не ответил на несколько переспросов: итога в статусе нет.
    if (box.id && box.statusAfter > lateBy) {
      body = { ...after, last_operation: { id: box.id, action: 'x', status_code: answer.status, body: answer.body } };
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  return box;
}

async function confirmApply(page, applyId) {
  await page.locator(applyId).click();
  await expect(page.locator('#confirm-modal')).not.toHaveClass(/hidden/);
  await page.locator('#confirm-modal-ok-btn').click();
}


test('DNS-over-VLESS: оборванный ответ на включение достаётся из статуса', async ({ page }) => {
  await mockClients(page, { available: true, counts: { total: 1, reaches: 1, intercepted: 0 }, clients: [] });
  await openDialog(page, VLESS_OFF);
  const box = await loseAnswer(page, '**/api/routing/dns-over-vless', {
    before: VLESS_OFF,
    after: VLESS_ON,
    answer: { status: 200, body: { ok: true, action: 'enable', enabled: true, restarted: true, probe: { ok: true, latency_ms: 7 } } },
  });

  await confirmApply(page, '#routing-dns-over-vless-apply');

  await expect(page.locator('#toast-container .toast')).toContainText('DNS-over-VLESS включён · DNS 7 мс');
  await expect(page.locator('#routing-dns-over-vless-apply')).toHaveText('Отключить и восстановить');
  await expect(page.locator('#routing-dns-over-vless-apply')).toBeEnabled();
  expect(box.posts).toBe(1);
  expect(box.id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
});


test('DNS-over-VLESS: потерянный отказ показывается как отказ', async ({ page }) => {
  await mockClients(page, { available: true, counts: { total: 1, reaches: 1, intercepted: 0 }, clients: [] });
  await openDialog(page, VLESS_ON);
  await loseAnswer(page, '**/api/routing/dns-over-vless', {
    before: VLESS_ON,
    after: VLESS_ON,
    answer: { status: 409, body: { ok: false, error: 'Keenetic не восстановил штатный DNS-сервер на порту 53.', code: 'dns_port_restore_failed' } },
  });

  await confirmApply(page, '#routing-dns-over-vless-apply');

  await expect(page.locator('#toast-container .toast')).toContainText('Keenetic не восстановил штатный DNS-сервер');
  await expect(page.locator('#routing-dns-over-vless-apply')).toBeEnabled();
});


test('DNS-over-VLESS: зависший ответ — окно говорит, что проверяет, и находит итог', async ({ page }) => {
  test.setTimeout(90000);
  await mockClients(page, { available: true, counts: { total: 1, reaches: 1, intercepted: 0 }, clients: [] });
  await openDialog(page, VLESS_ON);
  await loseAnswer(page, '**/api/routing/dns-over-vless', {
    before: VLESS_ON,
    after: VLESS_OFF,
    answer: { status: 200, body: { ok: true, action: 'disable', enabled: false, restarted: true, probe: { ok: true, skipped: true } } },
    hang: true,
    lateBy: 5,
  });

  await confirmApply(page, '#routing-dns-over-vless-apply');

  // Синяя плашка со счётчиком и яркая кнопка с тем же счётчиком.
  const notice = page.locator('#routing-dns-over-vless-status .xk-dns-op-notice');
  await expect(notice).toHaveAttribute('data-tone', 'info', { timeout: 30000 });
  await expect(notice).toContainText(/Ждём ответа роутера · \d+ с/);
  await expect(notice).toContainText('Ничего нажимать не нужно');
  const apply = page.locator('#routing-dns-over-vless-apply');
  await expect(apply).toHaveText(/Ждём ответа роутера… \d+ с/);
  // Яркая: без атрибута disabled (от него кнопка бледнеет), но для
  // вспомогательных технологий помечена недоступной.
  await expect(apply).not.toHaveAttribute('disabled', /.*/);
  await expect(apply).toHaveAttribute('aria-disabled', 'true');
  const first = await notice.locator('.xk-dns-op-notice-title').textContent();
  await expect(notice.locator('.xk-dns-op-notice-title')).not.toHaveText(first || '');

  await expect(page.locator('#toast-container .toast')).toContainText('DNS-over-VLESS отключён', { timeout: 15000 });
  await expect(apply).toHaveText('Включить безопасно');
  await expect(apply).not.toHaveAttribute('aria-disabled', 'true');
  await expect(notice).toHaveCount(0);
});


const MIHOMO_OFF = {
  ok: true,
  enabled: false,
  prepared: false,
  partial: false,
  tampered: false,
  can_recover: false,
  can_enable: true,
  can_disable: false,
  active_core: 'mihomo',
  proxy_group: 'PROXY',
  dns_override: false,
  dns_present: false,
  dns_enabled: false,
  dns_listener_configured: false,
  listen: '0.0.0.0:53',
  mode: 'redir-host',
  blockers: [],
  watchdog: null,
  watchdog_settings: { enabled: true, interval: 30, fail_threshold: 3, restart_attempts: 2 },
};
const MIHOMO_ON = {
  ...MIHOMO_OFF,
  enabled: true,
  prepared: true,
  can_enable: false,
  can_disable: true,
  dns_override: true,
  dns_present: true,
  dns_enabled: true,
  dns_listener_configured: true,
};

test('Mihomo DNS: оборванный ответ на включение достаётся из статуса', async ({ page }) => {
  const box = await loseAnswer(page, '**/api/mihomo/dns', {
    before: MIHOMO_OFF,
    after: MIHOMO_ON,
    answer: { status: 200, body: { ok: true, enabled: true, probe: { ok: true, latency_ms: 5 } } },
  });
  await page.goto('/');
  await selectPanelView(page, 'mihomo');
  await expect(page.locator('#view-mihomo')).toBeVisible();
  await page.locator('#mihomo-clash-tab-config').click();
  await page.locator('#mihomo-dns-btn').click();
  await expect(page.locator('#mihomo-dns-modal')).toBeVisible();

  await confirmApply(page, '#mihomo-dns-apply');

  await expect(page.locator('#toast-container .toast')).toContainText('Защищённый DNS включён · 5 мс');
  expect(box.posts).toBe(1);
  expect(box.statusAfter).toBeGreaterThan(0);
});


test('DNS-over-VLESS: итог так и не пришёл — плашка становится оранжевой', async ({ page }) => {
  test.setTimeout(240000);
  await mockClients(page, { available: true, counts: { total: 1, reaches: 1, intercepted: 0 }, clients: [] });
  await openDialog(page, VLESS_ON);
  // Статус отвечает, но записи с нашим номером в нём нет: итог неизвестен.
  const box = await loseAnswer(page, '**/api/routing/dns-over-vless', {
    before: VLESS_ON,
    after: VLESS_ON,
    answer: { status: 200, body: { ok: true } },
    hang: true,
    lateBy: Infinity,
  });

  await confirmApply(page, '#routing-dns-over-vless-apply');

  const notice = page.locator('#routing-dns-over-vless-status .xk-dns-op-notice');
  await expect(notice).toHaveAttribute('data-tone', 'info', { timeout: 30000 });
  await expect(notice).toHaveAttribute('data-tone', 'warn', { timeout: 170000 });
  await expect(notice).toContainText('Итог операции неизвестен');
  await expect(notice).toContainText('обновите страницу');
  const apply = page.locator('#routing-dns-over-vless-apply');
  await expect(apply).toHaveText('Отключить и восстановить');
  await expect(apply).not.toHaveAttribute('aria-disabled', 'true');
  // Раз в 3 секунды за две с половиной минуты — около полусотни запросов,
  // а не шквал после того, как сам запрос оборвался по тайм-ауту.
  expect(box.statusAfter).toBeLessThan(80);
  // Красного уведомления с тем же текстом нет: хватает плашки.
  await expect(page.locator('#toast-container .toast')).toHaveCount(0);
});


test('Mihomo DNS: зависший ответ — счётчик на нажатой кнопке и синяя плашка', async ({ page }) => {
  test.setTimeout(90000);
  await loseAnswer(page, '**/api/mihomo/dns', {
    before: MIHOMO_OFF,
    after: MIHOMO_ON,
    answer: { status: 200, body: { ok: true, enabled: true, probe: { ok: true, latency_ms: 5 } } },
    hang: true,
    lateBy: 2,
  });
  await page.goto('/');
  await selectPanelView(page, 'mihomo');
  await expect(page.locator('#view-mihomo')).toBeVisible();
  await page.locator('#mihomo-clash-tab-config').click();
  await page.locator('#mihomo-dns-btn').click();
  await expect(page.locator('#mihomo-dns-modal')).toBeVisible();

  await confirmApply(page, '#mihomo-dns-apply');

  const notice = page.locator('#mihomo-dns-status .xk-dns-op-notice');
  await expect(notice).toHaveAttribute('data-tone', 'info', { timeout: 30000 });
  await expect(page.locator('#mihomo-dns-apply')).toHaveText(/Ждём ответа роутера… \d+ с/);
  await expect(page.locator('#toast-container .toast')).toContainText('Защищённый DNS включён', { timeout: 15000 });
  await expect(notice).toHaveCount(0);
});


test('Mihomo DNS: «Применить изменения» — счётчик в подписи, иконка на месте', async ({ page }) => {
  test.setTimeout(90000);
  const on = { ...MIHOMO_ON, can_reconfigure: true, proxy_groups: ['PROXY'] };
  await loseAnswer(page, '**/api/mihomo/dns', {
    before: on,
    after: on,
    answer: { status: 200, body: { ok: true, enabled: true, probe: { ok: true, latency_ms: 3 } } },
    hang: true,
    lateBy: 3,
  });
  await page.goto('/');
  await selectPanelView(page, 'mihomo');
  await expect(page.locator('#view-mihomo')).toBeVisible();
  await page.locator('#mihomo-clash-tab-config').click();
  await page.locator('#mihomo-dns-btn').click();
  await expect(page.locator('#mihomo-dns-update')).toBeVisible();

  await confirmApply(page, '#mihomo-dns-update');

  const update = page.locator('#mihomo-dns-update');
  await expect(page.locator('#mihomo-dns-update-label')).toHaveText(/Ждём ответа роутера… \d+ с/, { timeout: 30000 });
  await expect(update.locator('svg')).toHaveCount(1);
  await expect(page.locator('#toast-container .toast')).toContainText('Настройки защищённого DNS применены', { timeout: 20000 });
  await expect(page.locator('#mihomo-dns-update-label')).toHaveText('Применить изменения');
  await expect(update.locator('svg')).toHaveCount(1);
});

import { test, expect } from './fixtures.mjs';
import {
  buildDemoNodes, buildDemoSubscription, openSubscriptionsModal,
} from './subscriptions_modal_support.mjs';

// Xray subscriptions window: what the list says about each subscription and how
// saving, clearing and the refresh-due button behave.

// Колонка состояния говорит словами. Раньше там стояло «OK · 2»: слово не
// по-русски, число без подписи, а «due» и «обновлено N назад» дублировались
// отдельными бейджами рядом.
async function routeSubscriptions(page, subscriptions) {
  await page.route('**/api/xray/subscriptions', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, subscriptions }),
    });
  });
}

async function readState(page, subId) {
  // The list is drawn after the window opens, once /api/xray/subscriptions
  // answers: wait for the row instead of racing it.
  await page.locator(`tr[data-sub-id="${subId}"] .xk-sub-state`).waitFor();
  return page.evaluate((id) => {
    const row = document.querySelector(`tr[data-sub-id="${id}"]`);
    const state = row?.querySelector('.xk-sub-state');
    const lines = Array.from(row?.querySelectorAll('.xk-sub-status-cell .xk-sub-muted') || []);
    return {
      tone: state?.getAttribute('data-state') || '',
      word: String(state?.querySelector('b')?.textContent || '').trim(),
      hasDot: !!state?.querySelector('i'),
      lines: lines.map((node) => String(node.textContent || '').trim()),
      badges: Array.from(row?.querySelectorAll('.xk-sub-badge') || [])
        .map((node) => String(node.textContent || '').trim()),
    };
  }, subId);
}

test('a working subscription says so in words and counts its nodes', async ({ page }) => {
  const now = Math.floor(Date.now() / 1000);
  await routeSubscriptions(page, [buildDemoSubscription(buildDemoNodes().slice(0, 5), {
    id: 'live-sub',
    last_ok: true,
    last_count: 5,
    last_source_count: 7,
    last_filtered_out_count: 2,
    last_update_ts: now - 300,
    next_update_ts: now + 26 * 3600,
    interval_hours: 24,
  })]);
  await openSubscriptionsModal(page);

  const seen = await readState(page, 'live-sub');
  expect(seen.tone).toBe('ok');
  expect(seen.word).toBe('Работает');
  expect(seen.hasDot).toBe(true);
  expect(seen.lines[0]).toBe('5 узлов из 7 · обновлено 5 мин назад');
  // Слово состояния и время обновления переехали из бейджей: дублировать их
  // рядом больше незачем, «скрыто N» остаётся.
  expect(seen.badges).toEqual(['скрыто 2']);
});

test('a failed subscription leads with the failure, not with a stale count', async ({ page }) => {
  const now = Math.floor(Date.now() / 1000);
  await routeSubscriptions(page, [buildDemoSubscription(buildDemoNodes().slice(0, 3), {
    id: 'bad-sub',
    last_ok: false,
    last_count: 3,
    last_source_count: 3,
    last_filtered_out_count: 0,
    last_error: 'HTTP Error 403: Forbidden',
    last_update_ts: now - 7200,
    next_update_ts: now + 3600,
  })]);
  await openSubscriptionsModal(page);

  const seen = await readState(page, 'bad-sub');
  expect(seen.tone).toBe('bad');
  expect(seen.word).toBe('Ошибка обновления');
  expect(seen.lines[0]).toContain('Сервер вернул ошибку HTTP 403');
});

test('an overdue subscription states it plainly instead of a due badge', async ({ page }) => {
  const now = Math.floor(Date.now() / 1000);
  await routeSubscriptions(page, [buildDemoSubscription(buildDemoNodes().slice(0, 2), {
    id: 'due-sub',
    last_ok: true,
    last_count: 2,
    last_source_count: 2,
    last_filtered_out_count: 0,
    last_update_ts: now - 3 * 86400,
    next_update_ts: now - 600,
    interval_hours: 24,
    profile_update_interval_hours: 24,
  })]);
  await openSubscriptionsModal(page);

  const seen = await readState(page, 'due-sub');
  expect(seen.tone).toBe('due');
  expect(seen.word).toBe('Пора обновить');
  expect(seen.badges).not.toContain('due');
  expect(seen.lines[1]).toBe('Срок наступил — обновится при ближайшей проверке · каждые 24 ч');
});

test('a never-updated subscription admits it has no nodes yet', async ({ page }) => {
  await routeSubscriptions(page, [buildDemoSubscription([], {
    id: 'fresh-sub',
    last_ok: null,
    last_count: 0,
    last_source_count: 0,
    last_filtered_out_count: 0,
    last_update_ts: 0,
    next_update_ts: 0,
    last_nodes: [],
  })]);
  await openSubscriptionsModal(page);

  const seen = await readState(page, 'fresh-sub');
  expect(seen.tone).toBe('due');
  expect(seen.word).toBe('Не скачана');
  expect(seen.lines[0]).toBe('узлов пока нет');
});

test('the schedule line names the day instead of a bare timestamp', async ({ page }) => {
  const now = Math.floor(Date.now() / 1000);
  await routeSubscriptions(page, [
    buildDemoSubscription(buildDemoNodes().slice(0, 2), {
      id: 'soon-sub', last_ok: true, last_count: 2, last_source_count: 2,
      last_filtered_out_count: 0, last_update_ts: now - 60,
      next_update_ts: now + 26 * 3600, interval_hours: 24, profile_update_interval_hours: 24,
    }),
  ]);
  await openSubscriptionsModal(page);

  const seen = await readState(page, 'soon-sub');
  const schedule = seen.lines[1];
  // Секунды и английское «next» уходят: точное время остаётся в подсказке.
  expect(schedule).not.toContain('next:');
  expect(schedule).toMatch(/^Следующее обновление (сегодня|завтра|\d{2}\.\d{2}) в \d{2}:\d{2} · каждые 24 ч$/);

  const hint = await page.evaluate(() => {
    const row = document.querySelector('tr[data-sub-id="soon-sub"]');
    const lines = Array.from(row?.querySelectorAll('.xk-sub-status-cell .xk-sub-muted') || []);
    // Подсказку панель переносит из title в data-tooltip и title снимает,
    // поэтому спрашиваем именно её.
    return lines[1]?.getAttribute('data-tooltip') || '';
  });
  expect(hint).toContain('Точное время:');
});

test('the listed url keeps the host and the tail that tells subscriptions apart', async ({ page }) => {
  await routeSubscriptions(page, [buildDemoSubscription(buildDemoNodes().slice(0, 2), {
    id: 'url-sub',
    url: 'https://example-provider.com/api/v1/subscribe/a8f3',
  })]);
  await openSubscriptionsModal(page);
  await page.locator('tr[data-sub-id="url-sub"] td:first-child .xk-sub-muted').first().waitFor();

  const meta = await page.evaluate(() => {
    const row = document.querySelector('tr[data-sub-id="url-sub"]');
    const muted = row?.querySelector('td:first-child .xk-sub-muted');
    return String(muted?.textContent || '');
  });
  expect(meta).toContain('example-provider.com/…/a8f3');
});

// Сервер-заглушка, который помнит сохранённое: без неё POST ушёл бы в
// настоящую панель стенда и оставил там подписки.
async function routeStatefulSubscriptions(page, initial = [], extra = {}) {
  const store = { subscriptions: initial.slice(), posts: [] };
  await page.route('**/api/xray/subscriptions', async (route) => {
    const request = route.request();
    if (request.method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, subscriptions: store.subscriptions, ...extra }),
      });
      return;
    }
    if (request.method() !== 'POST') {
      await route.fallback();
      return;
    }
    const body = request.postDataJSON() || {};
    store.posts.push(body);
    const now = Math.floor(Date.now() / 1000);
    const id = String(body.id || body.tag || `sub-${store.posts.length}`).toLowerCase();
    const index = store.subscriptions.findIndex((item) => item.id === id);
    const saved = {
      last_ok: null,
      last_count: 0,
      last_nodes: [],
      output_file: `04_outbounds.${id}.json`,
      next_update_ts: now + 86400,
      ...(index >= 0 ? store.subscriptions[index] : {}),
      ...body,
      id,
      updated_ts: now,
    };
    if (index >= 0) store.subscriptions[index] = saved;
    else store.subscriptions.push(saved);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, subscription: saved }),
    });
  });
  return store;
}

async function openSubscriptionAdvanced(page) {
  const advanced = page.locator('#outbounds-subscriptions-modal .xk-sub-advanced');
  if ((await advanced.getAttribute('open')) === null) await advanced.locator(':scope > summary').click();
  await expect(advanced).toHaveAttribute('open', '');
}

async function setSubscriptionSwitch(page, id, wanted) {
  const input = page.locator(`#${id}`);
  if ((await input.isChecked()) !== wanted) await input.locator('xpath=ancestor::label[1]').click();
  if (wanted) await expect(input).toBeChecked();
  else await expect(input).not.toBeChecked();
}

test('a subscription saved without a download is listed as not downloaded yet', async ({ page }) => {
  const now = Math.floor(Date.now() / 1000);
  await routeSubscriptions(page, [buildDemoSubscription([], {
    id: 'saved-sub',
    last_ok: null,
    last_count: 0,
    last_source_count: 0,
    last_filtered_out_count: 0,
    last_nodes: [],
    // Запись только что сохранена, но подписку ещё ни разу не скачивали.
    created_ts: now - 5,
    updated_ts: now - 5,
    next_update_ts: now + 86400,
    interval_hours: 24,
    profile_update_interval_hours: 24,
  })]);
  await openSubscriptionsModal(page);

  const seen = await readState(page, 'saved-sub');
  expect(seen.word).toBe('Не скачана');
  expect(seen.tone).toBe('due');
  expect(seen.lines[0]).toBe('узлов пока нет');
  expect(seen.lines[1]).toMatch(/^Первое автообновление завтра в \d\d:\d\d · каждые 24 ч$/);
  // Что нажать — в подсказке: в узкой колонке полный текст занимал три строки.
  const hint = await page.locator('tr[data-sub-id="saved-sub"] .xk-sub-state-row').getAttribute('data-tooltip');
  expect(hint).toContain('«Обновить просроченные»');
});

test('saving a new subscription without a download clears the form but keeps the window settings', async ({ page }) => {
  const store = await routeStatefulSubscriptions(page, [], {
    routing_balancers: [
      { tag: 'fast_web_balancer', strategy_type: 'leastPing', fallback_tag: 'direct', selector_count: 1 },
      { tag: 'heavy_load_balancer', strategy_type: 'leastLoad', fallback_tag: 'direct', selector_count: 1 },
    ],
  });
  await openSubscriptionsModal(page);
  await openSubscriptionAdvanced(page);

  const field = (name) => page.locator(`#outbounds-subscriptions-${name}`);
  const balancer = page.locator('#outbounds-subscriptions-routing-balancers input[data-balancer-tag="fast_web_balancer"]');

  await field('url').fill('https://one.example.com/sub/aaa');
  await field('name').fill('First');
  await field('tag').fill('first');
  await field('interval').fill('12');
  await setSubscriptionSwitch(page, 'outbounds-subscriptions-refresh-now', false);
  await setSubscriptionSwitch(page, 'outbounds-subscriptions-routing-auto-rule', true);
  await field('routing-mode').selectOption('subscription-only');
  await balancer.locator('xpath=ancestor::label[1]').click();
  await expect(balancer).toBeChecked();

  await field('save-btn').click();
  await expect(page.locator('tr[data-sub-id="first"]')).toBeVisible();

  // То, что принадлежит одной подписке, ушло…
  await expect(field('url')).toHaveValue('');
  await expect(field('name')).toHaveValue('');
  await expect(field('tag')).toHaveValue('');
  await expect(field('id')).toHaveValue('');
  await expect(page.locator('tr[data-sub-id="first"]')).not.toHaveClass(/is-selected/);
  // …а настройки окна остались для следующей.
  await expect(field('interval')).toHaveValue('12');
  await expect(field('refresh-now')).not.toBeChecked();
  await expect(field('routing-auto-rule')).toBeChecked();
  await expect(field('routing-mode')).toHaveValue('subscription-only');
  await expect(balancer).toBeChecked();
  await expect(field('status')).toContainText('Сохранено');

  await field('url').fill('https://two.example.com/sub/bbb');
  await field('tag').fill('second');
  await field('save-btn').click();
  await expect(page.locator('tr[data-sub-id="second"]')).toBeVisible();

  expect(store.posts).toHaveLength(2);
  expect(String(store.posts[1].id || '')).toBe('');
  expect(store.posts[1].url).toBe('https://two.example.com/sub/bbb');
  expect(store.posts[1].interval_hours).toBe(12);
  expect(store.posts[1].routing_mode).toBe('subscription-only');
  expect(store.posts[1].routing_balancer_tags).toEqual(['fast_web_balancer']);
  await expect(page.locator('#outbounds-subscriptions-tbody tr[data-sub-id]')).toHaveCount(2);

  // Перенесённые настройки — не черновик: окно закрывается без вопроса.
  await field('close-btn').click();
  await expect(page.locator('#outbounds-subscriptions-modal')).toBeHidden();
  await expect(page.locator('#confirm-modal')).toHaveClass(/hidden/);

  // Новое открытие окна начинает с настроек по умолчанию.
  await page.locator('#outbounds-subscriptions-btn').click();
  await expect(page.locator('#outbounds-subscriptions-modal')).toBeVisible();
  await expect(field('interval')).toHaveValue('24');
  await expect(field('refresh-now')).toBeChecked();
  await expect(field('routing-mode')).toHaveValue('safe-fallback');
  await expect(balancer).not.toBeChecked();
});

test('the clear button drops the settings carried over from the previous subscription', async ({ page }) => {
  await routeStatefulSubscriptions(page, []);
  await openSubscriptionsModal(page);
  await openSubscriptionAdvanced(page);

  const field = (name) => page.locator(`#outbounds-subscriptions-${name}`);
  await field('url').fill('https://one.example.com/sub/aaa');
  await field('tag').fill('first');
  await field('interval').fill('12');
  await setSubscriptionSwitch(page, 'outbounds-subscriptions-refresh-now', false);
  await field('save-btn').click();
  await expect(field('url')).toHaveValue('');
  await expect(field('interval')).toHaveValue('12');

  await field('reset-btn').click();
  await expect(field('interval')).toHaveValue('24');
  await expect(field('refresh-now')).toBeChecked();
});

test('saving edits to an existing subscription keeps it in the form', async ({ page }) => {
  const store = await routeStatefulSubscriptions(page, [buildDemoSubscription([], {
    url: 'https://one.example.com/sub/aaa',
    interval_hours: 24,
  })]);
  await openSubscriptionsModal(page);
  await page.locator('tr[data-sub-id="demo-sub"]').click();

  const field = (name) => page.locator(`#outbounds-subscriptions-${name}`);
  await expect(field('id')).toHaveValue('demo-sub');
  await openSubscriptionAdvanced(page);
  await setSubscriptionSwitch(page, 'outbounds-subscriptions-refresh-now', false);
  await field('interval').fill('6');
  await field('save-btn').click();

  await expect(field('status')).toContainText('Сохранено');
  expect(store.posts).toHaveLength(1);
  expect(store.posts[0].id).toBe('demo-sub');
  await expect(field('id')).toHaveValue('demo-sub');
  await expect(field('url')).toHaveValue('https://one.example.com/sub/aaa');
  await expect(page.locator('#confirm-modal')).toHaveClass(/hidden/);
});

test('changing the address of a saved subscription asks before overwriting it', async ({ page }) => {
  const store = await routeStatefulSubscriptions(page, [buildDemoSubscription([], {
    tag: 'VPS_DE_SUB',
    url: 'https://one.example.com/sub/aaa',
  })]);
  await openSubscriptionsModal(page);
  await page.locator('tr[data-sub-id="demo-sub"]').click();

  const field = (name) => page.locator(`#outbounds-subscriptions-${name}`);
  await openSubscriptionAdvanced(page);
  await setSubscriptionSwitch(page, 'outbounds-subscriptions-refresh-now', false);
  await field('url').fill('https://two.example.net/sub/bbb');
  await field('save-btn').click();

  const confirm = page.locator('#confirm-modal');
  await expect(confirm).not.toHaveClass(/hidden/);
  await expect(confirm).toContainText('VPS_DE_SUB');
  await expect(confirm).toContainText('one.example.com');
  await expect(confirm).toContainText('two.example.net');
  await expect(page.locator('#confirm-modal-ok-btn')).toHaveText('Изменить адрес');
  // В панели отказ — это крестик в шапке: кнопка «Отмена» скрыта.
  await page.locator('#confirm-modal-close-btn').click();
  await expect(confirm).toHaveClass(/hidden/);
  expect(store.posts).toHaveLength(0);
  // Отказ ничего не стирает: набранный адрес остаётся в форме.
  await expect(field('url')).toHaveValue('https://two.example.net/sub/bbb');

  await field('save-btn').click();
  await expect(confirm).not.toHaveClass(/hidden/);
  await page.locator('#confirm-modal-ok-btn').click();
  await expect(field('status')).toContainText('Сохранено');
  expect(store.posts).toHaveLength(1);
  expect(store.posts[0].id).toBe('demo-sub');
  expect(store.posts[0].url).toBe('https://two.example.net/sub/bbb');
});

test('the refresh-due button counts what it is about to download', async ({ page }) => {
  const now = Math.floor(Date.now() / 1000);
  const fresh = { last_ok: null, last_count: 0, last_nodes: [], next_update_ts: now + 86400 };
  const done = { last_ok: true, last_update_ts: now - 600, next_update_ts: now + 86400 };
  await routeSubscriptions(page, [
    buildDemoSubscription([], { id: 'new-a', tag: 'new-a', ...fresh }),
    buildDemoSubscription([], { id: 'new-b', tag: 'new-b', ...fresh }),
    // Выключенное автообновление кнопка не трогает — и не считает.
    buildDemoSubscription([], { id: 'new-off', tag: 'new-off', ...fresh, enabled: false }),
    buildDemoSubscription([], { id: 'overdue', tag: 'overdue', ...done, next_update_ts: now - 600 }),
    buildDemoSubscription([], { id: 'fine', tag: 'fine', ...done }),
  ]);
  await openSubscriptionsModal(page);

  const count = page.locator('#outbounds-subscriptions-refresh-due-count');
  await expect(count).toBeVisible();
  await expect(count).toHaveText('3');
});

test('the refresh-due button shows no counter when nothing is waiting', async ({ page }) => {
  const now = Math.floor(Date.now() / 1000);
  await routeSubscriptions(page, [buildDemoSubscription([], {
    id: 'fine', last_ok: true, last_update_ts: now - 600, next_update_ts: now + 86400,
  })]);
  await openSubscriptionsModal(page);

  await expect(page.locator('tr[data-sub-id="fine"]')).toBeVisible();
  await expect(page.locator('#outbounds-subscriptions-refresh-due-count')).toBeHidden();
});

test('the form says whether saving adds a subscription or changes the open one', async ({ page }) => {
  await routeSubscriptions(page, [buildDemoSubscription([], { tag: 'VPS_DE_SUB' })]);
  await openSubscriptionsModal(page);

  const mode = page.locator('#outbounds-subscriptions-mode');
  await expect(mode).toHaveText('новая');
  await expect(mode).not.toHaveClass(/is-edit/);

  await page.locator('tr[data-sub-id="demo-sub"]').click();
  await expect(mode).toHaveText('изменение · VPS_DE_SUB');
  await expect(mode).toHaveClass(/is-edit/);
  const box = await mode.evaluate((node) => {
    const pill = node.getBoundingClientRect();
    const head = node.closest('.xk-sub-form-head').getBoundingClientRect();
    return { inside: pill.right <= head.right + 1, oneLine: pill.height < 30 };
  });
  expect(box.inside).toBe(true);
  expect(box.oneLine).toBe(true);

  await page.locator('#outbounds-subscriptions-reset-btn').click();
  await expect(mode).toHaveText('новая');
  await expect(mode).not.toHaveClass(/is-edit/);
});

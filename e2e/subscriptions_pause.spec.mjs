import { test, expect } from './fixtures.mjs';

function sub(id, extra = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    id,
    name: id,
    tag: id,
    url: `https://example.com/sub/${id}`,
    interval_hours: 24,
    enabled: true,
    ping_enabled: true,
    routing_mode: 'safe-fallback',
    last_ok: true,
    last_count: 4,
    last_source_count: 4,
    last_update_ts: now - 3600,
    next_update_ts: now + 23 * 3600,
    output_file: `04_outbounds.${id}.json`,
    last_nodes: [],
    node_latency: {},
    ...extra,
  };
}

// Подставной сервер: список подписок, прогноз и сам рубильник.
async function mockApi(page, { subs = [sub('alpha'), sub('beta')], dns = { outcome: 'none', restarts: 1 }, onSwitch } = {}) {
  const state = { paused: false, posts: [] };
  await page.route('**/api/xray/subscriptions', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const list = subs.map((item) => ({ ...item, paused: state.paused }));
    await route.fulfill({
      json: { ok: true, subscriptions: list, paused: state.paused && list.length > 0, paused_ts: state.paused ? 1790970900 : null },
    });
  });
  await page.route('**/api/xray/subscriptions/pause-plan', async (route) => {
    await route.fulfill({ json: { ok: true, paused: state.paused, total: subs.length, dns: { enabled: true, from: [], ...dns } } });
  });
  await page.route(/\/api\/xray\/subscriptions\/(pause|resume)$/, async (route) => {
    const action = route.request().url().endsWith('/pause') ? 'pause' : 'resume';
    const body = route.request().postDataJSON() || {};
    state.posts.push({ action, body });
    if (onSwitch) {
      const custom = onSwitch({ action, body, state });
      if (custom) return route.fulfill(custom);
    }
    state.paused = action === 'pause';
    await route.fulfill({ json: { ok: true, changed: true, paused: state.paused, restarts: 1, dns: { action: 'none', from: [], to: [] } } });
  });
  return state;
}

async function openSubscriptions(page) {
  await page.goto('/');
  const body = page.locator('#outbounds-body');
  for (let attempt = 0; attempt < 3 && !(await body.isVisible()); attempt += 1) {
    await page.locator('#outbounds-header').click();
    await page.waitForTimeout(350);
  }
  await expect(body).toBeVisible();
  await page.locator('#outbounds-subscriptions-btn').click();
  await expect(page.locator('#outbounds-subscriptions-modal')).toBeVisible();
}

const master = (page) => page.locator('#outbounds-subscriptions-master');
const masterWrap = (page) => page.locator('#outbounds-subscriptions-master-wrap');
const banner = (page) => page.locator('#outbounds-subscriptions-paused-banner');
const confirmText = (page) => page.locator('#confirm-modal-message');

test.describe('рубильник подписок', () => {
  test('без подписок рубильника нет', async ({ page }) => {
    await mockApi(page, { subs: [] });
    await openSubscriptions(page);
    await expect(page.locator('#outbounds-subscriptions-empty')).toBeVisible();
    await expect(masterWrap(page)).toBeHidden();
    await expect(banner(page)).toBeHidden();
  });

  test('пауза: подтверждение называет сервер, окно показывает плашку и состояние строк', async ({ page }) => {
    const state = await mockApi(page, {
      dns: { outcome: 'retarget', to: { tag: 'my-server', kind: 'outbound' }, restarts: 2 },
    });
    await openSubscriptions(page);
    await expect(page.locator('#outbounds-subscriptions-tbody tr')).toHaveCount(2);
    await expect(masterWrap(page)).toBeVisible();
    await expect(master(page)).toBeChecked();
    await expect(masterWrap(page)).toContainText('Подписки работают');

    await masterWrap(page).click();
    await expect(page.locator('#confirm-modal-title')).toHaveText('Приостановить подписки?');
    await expect(confirmText(page)).toContainText('Все 2 подписки перестанут работать');
    await expect(confirmText(page)).toContainText('будет переведён на ваш сервер «my-server»');
    await expect(confirmText(page)).toContainText('перезапущен дважды');
    // До подтверждения ничего не меняется.
    expect(state.posts).toEqual([]);
    await expect(master(page)).toBeChecked();

    await page.locator('#confirm-modal-ok-btn').click();

    await expect(banner(page)).toBeVisible();
    await expect(banner(page)).toContainText('Подписки приостановлены');
    await expect(banner(page)).toContainText('Трафик идёт через ваши серверы');
    await expect(banner(page)).toContainText(/с \d{1,2} [а-я]+ в \d{2}:\d{2}\./);
    await expect(master(page)).not.toBeChecked();
    await expect(masterWrap(page)).toContainText('Подписки приостановлены');
    expect(state.posts).toEqual([{ action: 'pause', body: { dns_target: '' } }]);

    const rows = page.locator('#outbounds-subscriptions-tbody tr');
    await expect(rows).toHaveCount(2);
    await expect(rows.first().locator('.xk-sub-state b')).toHaveText('Приостановлена');
    await expect(rows.first()).toContainText('Автообновление остановлено до возобновления');
    await expect(rows.first().locator('.xk-sub-refresh')).toBeDisabled();
    await expect(page.locator('#outbounds-subscriptions-refresh-due-btn')).toBeDisabled();
    await expect(page.locator('#outbounds-subscriptions-align-btn')).toBeDisabled();
    await expect(page.locator('#outbounds-subscriptions-status')).toContainText('Подписки приостановлены.');
  });

  test('отказ в подтверждении ничего не отправляет', async ({ page }) => {
    const state = await mockApi(page);
    await openSubscriptions(page);
    await masterWrap(page).click();
    await expect(page.locator('#confirm-modal')).toBeVisible();
    await page.locator('#confirm-modal-close-btn').click();
    await expect(page.locator('#confirm-modal')).toBeHidden();
    expect(state.posts).toEqual([]);
    await expect(master(page)).toBeChecked();
    await expect(banner(page)).toBeHidden();
  });

  test('несколько своих серверов: выбранный уходит на сервер', async ({ page }) => {
    const candidates = [
      { tag: 'my-server', kind: 'outbound' },
      { tag: 'home-nl', kind: 'outbound' },
      { tag: 'my-pool', kind: 'balancer' },
    ];
    const state = await mockApi(page, { dns: { outcome: 'choose', candidates, restarts: 2 } });
    await openSubscriptions(page);
    await masterWrap(page).click();

    const select = page.locator('#outbounds-subscriptions-pause-dns-target');
    await expect(select).toBeVisible();
    await expect(select.locator('option')).toHaveText(['сервер «my-server»', 'сервер «home-nl»', 'балансировщик «my-pool»']);
    await select.selectOption('home-nl');
    await page.locator('#confirm-modal-ok-btn').click();

    await expect(banner(page)).toBeVisible();
    expect(state.posts).toEqual([{ action: 'pause', body: { dns_target: 'home-nl' } }]);
  });

  test('возобновление возвращает окно в рабочий вид', async ({ page }) => {
    const state = await mockApi(page, {
      dns: { outcome: 'restore', to: { tag: 'proxy', kind: 'balancer' }, restarts: 2 },
    });
    state.paused = true;
    await openSubscriptions(page);
    await expect(banner(page)).toBeVisible();
    await expect(master(page)).not.toBeChecked();

    await masterWrap(page).click();
    await expect(page.locator('#confirm-modal-title')).toHaveText('Возобновить подписки?');
    await expect(confirmText(page)).toContainText('будет возвращён на балансировщик «proxy», как было до паузы');
    await page.locator('#confirm-modal-ok-btn').click();

    await expect(banner(page)).toBeHidden();
    await expect(master(page)).toBeChecked();
    await expect(page.locator('#outbounds-subscriptions-tbody tr').first().locator('.xk-sub-state b')).toHaveText('Работает');
    await expect(page.locator('#outbounds-subscriptions-refresh-due-btn')).toBeEnabled();
    expect(state.posts.map((item) => item.action)).toEqual(['resume']);
  });

  test('сбой перевода DNS: окно говорит причину и остаётся в рабочем виде', async ({ page }) => {
    await mockApi(page, {
      dns: { outcome: 'retarget', to: { tag: 'my-server', kind: 'outbound' }, restarts: 2 },
      onSwitch: () => ({
        status: 409,
        json: {
          ok: false,
          code: 'dns_switch_failed',
          error: 'Не удалось перевести DNS-over-VLESS: Тестовый DNS-запрос через VLESS не получил ответ.',
          rolled_back: true,
        },
      }),
    });
    await openSubscriptions(page);
    await masterWrap(page).click();
    await page.locator('#confirm-modal-ok-btn').click();

    await expect(page.locator('#outbounds-subscriptions-status')).toContainText('Подписки не приостановлены');
    await expect(page.locator('#outbounds-subscriptions-status')).toContainText('не получил ответ');
    await expect(banner(page)).toBeHidden();
    await expect(master(page)).toBeChecked();
  });
});

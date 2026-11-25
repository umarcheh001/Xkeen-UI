import { test, expect } from './fixtures.mjs';
import { STATUS as DNS_STATUS } from './dns_over_vless_fixtures.mjs';

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
async function mockApi(page, { subs = [sub('alpha'), sub('beta')], dns = { outcome: 'none', restarts: 1 }, routeMappings = [], onSwitch } = {}) {
  const state = { paused: false, deleted: false, posts: [], notice: {} };
  await page.route('**/api/xray/subscriptions', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const list = state.deleted ? [] : subs.map((item) => ({ ...item, paused: state.paused }));
    await route.fulfill({
      json: {
        ok: true,
        subscriptions: list,
        paused: state.paused && list.length > 0,
        paused_ts: state.paused ? 1790970900 : null,
        switch_notice: state.notice,
      },
    });
  });
  await page.route('**/api/xray/subscriptions/pause-plan', async (route) => {
    await route.fulfill({ json: { ok: true, paused: state.paused, total: subs.length, route_mappings: routeMappings, dns: { enabled: true, from: [], ...dns } } });
  });
  await page.route(/\/api\/xray\/subscriptions\/(pause|resume|delete-all)$/, async (route) => {
    const action = route.request().url().split('/').pop();
    const body = route.request().postDataJSON() || {};
    state.posts.push({ action, body });
    if (onSwitch) {
      const custom = onSwitch({ action, body, state });
      if (custom === 'abort') return route.abort('connectionreset');
      if (custom) return route.fulfill(custom);
    }
    if (action === 'delete-all') {
      state.deleted = true;
      state.paused = false;
    } else {
      state.paused = action === 'pause';
    }
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
  // Часы страницы с этого места управляемые: идут как обычно, но их можно
  // перевести вперёд, когда окно переспрашивает роутер об итоге.
  await page.clock.install();
}

// Окно узнаёт итог переспросами раз в несколько секунд. Ждать их по-настоящему
// незачем: часы переводятся шагами, пока в статусе не появится нужный текст, —
// шагами, чтобы ответ на каждый переспрос успел прийти до следующего.
async function advanceUntilText(page, locator, text, limitMs = 120000, step = 500) {
  for (let passed = 0; passed < limitMs; passed += step) {
    if (((await locator.textContent()) || '').includes(text)) return;
    await page.clock.runFor(step);
    await new Promise((resolve) => { setTimeout(resolve, 25); });
  }
}

const master = (page) => page.locator('#outbounds-subscriptions-master');
const masterWrap = (page) => page.locator('#outbounds-subscriptions-master-wrap');
const banner = (page) => page.locator('#outbounds-subscriptions-paused-banner');
const confirmText = (page) => page.locator('#confirm-modal-message');
const deleteAll = (page) => page.locator('#outbounds-subscriptions-delete-all-btn');

test.describe('рубильник подписок', () => {
  test('возобновление сохраняет выбранные транспорты одной подписки', async ({ page }) => {
    const reality = { subscription_id: 'us', subscription_name: 'VPS_US_SUB', node_key: 'r',
      tag: 'us--reality', node_name: 'Reality', label: 'VPS_US_SUB · Reality' };
    const xhttp = { ...reality, node_key: 'x', tag: 'us--xhttp', node_name: 'XHTTP', label: 'VPS_US_SUB · XHTTP' };
    const state = await mockApi(page, { routeMappings: [{
      outbound_tag: 'VPS_US', revision: 'transport', required: true, rules: [],
      candidates: [reality, xhttp], selected: reality, selected_nodes: [reality],
    }] });
    state.paused = true;
    await openSubscriptions(page);
    await masterWrap(page).click();
    const dialog = page.locator('#confirm-modal');
    await expect(dialog.getByRole('checkbox', { name: 'Reality' })).toBeChecked();
    await expect(confirmText(page)).toHaveCSS('font-size', '13px');
    await expect(dialog.getByRole('combobox')).toHaveCSS('font-size', '13px');
    await expect(dialog.locator('.xk-sub-transport-options label').first()).toHaveCSS('font-size', '13px');
    await expect(dialog.locator('.xk-sub-transport-options .modal-hint')).toHaveCSS('font-size', '12.5px');
    await dialog.getByRole('checkbox', { name: 'XHTTP' }).check();
    await dialog.getByRole('button', { name: 'Переключить' }).click();
    await expect.poll(() => state.posts.find((item) => item.action === 'resume')?.body.route_mappings)
      .toEqual([{ outbound_tag: 'VPS_US', revision: 'transport', subscription_id: 'us', node_keys: ['r', 'x'] }]);
  });

  test('возобновление показывает затронутые сайты и отправляет выбранную замену', async ({ page }) => {
    const node = { subscription_id: 'alpha', node_key: 'us-reality', tag: 'alpha--US', label: 'США · Reality' };
    const group = {
      outbound_tag: 'VPS_US', revision: 'revision',
      rules: [{ ruleTag: '50_ai_via_us', domain: ['ext:geosite_v2fly.dat:openai'] },
        { ruleTag: '52_streaming_us', domain: ['domain:stream.example'] }],
      candidates: [node], selected: null,
    };
    const state = await mockApi(page, { routeMappings: [
      group,
      { ...group, outbound_tag: 'VPS_DE', selected: node,
        rules: [{ ruleTag: '60_games_de', domain: ['geosite:category-games'] },
          { ruleTag: '65_updates_de', domain: ['full:updates.example'] }] },
      { ...group, outbound_tag: 'VPS_NL', required: false, rules: [{ ruleTag: '70_work_nl', domain: ['full:portal.example'] }] },
    ] });
    state.paused = true;
    await openSubscriptions(page);
    const modal = page.locator('#confirm-modal');
    const confirm = modal.getByRole('button', { name: 'Переключить' });
    await masterWrap(page).click();
    await expect(modal.getByRole('combobox')).toHaveCount(3);
    await expect(confirm).toBeDisabled();
    await modal.getByText('Какие сайты затронет выбор', { exact: true }).first().click();
    await expect(modal.getByText('openai', { exact: false })).toBeVisible();
    await expect(modal.getByText('updates.example', { exact: true })).toBeHidden();
    const choose = async (tag) => modal.getByRole('combobox', { name: 'Узел подписки вместо ' + tag })
      .selectOption({ label: node.label });
    await choose('VPS_US');
    await expect(confirm).toBeEnabled();
    await expect(modal.getByRole('option', { name: 'Продолжить без замены' })).toHaveCount(1);
    await modal.locator('#confirm-modal-close-btn').click();
    expect(state.posts).toEqual([]);
    await masterWrap(page).click();
    await choose('VPS_US');
    await confirm.click();
    await expect.poll(() => state.posts).toEqual([{
      action: 'resume',
      body: { dns_target: '', route_mappings: [
        ...['VPS_US', 'VPS_DE'].map((tag) =>
          ({ outbound_tag: tag, subscription_id: 'alpha', node_key: 'us-reality', revision: 'revision' })),
        { outbound_tag: 'VPS_NL', subscription_id: null, node_key: null, revision: 'revision' },
      ] },
    }]);
  });

  test('обновление предлагает замену при первом применении режима «Только подписка»', async ({ page }) => {
    await mockApi(page);
    const node = { subscription_id: 'alpha', node_key: 'us', tag: 'alpha--US', label: 'США · Reality' };
    const posts = [];
    await page.route(/\/api\/xray\/subscriptions\/alpha\/refresh\?/, (route) => {
      const payload = route.request().postDataJSON();
      posts.push(payload);
      if (!payload.route_mappings) return route.fulfill({
        status: 409,
        json: { ok: false, code: 'route_mapping_choice_required', route_mappings: [{
          outbound_tag: 'VPS_US', revision: 'fresh', rules: [], candidates: [node],
        }] },
      });
      return route.fulfill({ json: { ok: true, count: 1 } });
    });
    await openSubscriptions(page);
    await page.locator('#outbounds-subscriptions-tbody .xk-sub-refresh').first().click();
    const modal = page.locator('#confirm-modal');
    await expect(modal.locator('#confirm-modal-title')).toHaveText('Перейти в режим «Только подписка»?');
    await modal.getByRole('combobox').selectOption({ label: node.label });
    await modal.getByRole('button', { name: 'Переключить' }).click();
    await expect.poll(() => posts).toEqual([{}, {
      route_mappings: [{ outbound_tag: 'VPS_US', revision: 'fresh', subscription_id: 'alpha', node_key: 'us' }],
    }]);
  });
  test('пропуск необязательной замены сохраняет настройку автоперезапуска', async ({ page }) => {
    await mockApi(page);
    const node = { subscription_id: 'alpha', node_key: 'us', tag: 'alpha--US', label: 'США · Reality' };
    const restarts = [];
    await page.route(/\/api\/xray\/subscriptions\/alpha\/refresh\?/, (route) => {
      const request = route.request();
      restarts.push(new URL(request.url()).searchParams.get('restart'));
      if (!request.postDataJSON().route_mappings) return route.fulfill({
        status: 409,
        json: { ok: false, code: 'route_mapping_choice_required', route_mappings: [{
          outbound_tag: 'VPS_US', revision: 'fresh', required: false, rules: [], candidates: [node],
        }] },
      });
      return route.fulfill({ json: { ok: true, count: 1 } });
    });
    await openSubscriptions(page);
    await page.locator('#global-autorestart-xkeen').evaluate((input) => { input.checked = false; });
    await page.locator('#outbounds-subscriptions-tbody .xk-sub-refresh').first().click();
    await page.locator('#confirm-modal').getByRole('button', { name: 'Переключить' }).click();
    await expect.poll(() => restarts).toEqual(['0', '0']);
  });
  test('при обновлении просроченных актуальный выбор нужен только до первого применения', async ({ page }) => {
    await mockApi(page, { subs: ['alpha', 'beta'].map((id) => sub(id, { next_update_ts: 1 })) });
    const node = { subscription_id: 'alpha', node_key: 'us', tag: 'alpha--US', label: 'США · Reality' };
    const group = { outbound_tag: 'VPS_US', revision: 'fresh', required: false, rules: [], candidates: [node] };
    const posts = [];
    await page.route(/\/api\/xray\/subscriptions\/refresh-due\?/, (route) => {
      expect(new URL(route.request().url()).searchParams.get('offer_route_mappings')).toBe('1');
      return route.fulfill({ json: { ok: true, updated: 2, ok_count: 0, results: ['alpha', 'beta'].map((id) => ({
        id, ok: false, code: 'route_mapping_choice_required', route_mappings: [group],
      })) } });
    });
    await page.route(/\/api\/xray\/subscriptions\/(alpha|beta)\/refresh\?/, (route) => {
      const request = route.request();
      const id = new URL(request.url()).pathname.split('/').at(-2);
      const payload = request.postDataJSON();
      posts.push({ id, payload });
      if (id === 'alpha' && !payload.route_mappings) return route.fulfill({
        status: 409,
        json: { ok: false, code: 'route_mapping_choice_required', route_mappings: [group] },
      });
      return route.fulfill({ json: { ok: true, id, count: 1, changed: true, hot_applied: true } });
    });
    await openSubscriptions(page);
    await page.locator('#outbounds-subscriptions-refresh-due-btn').click();
    const modal = page.locator('#confirm-modal');
    await modal.getByRole('button', { name: 'Переключить' }).click();
    await expect.poll(() => posts).toEqual([
      { id: 'alpha', payload: {} },
      { id: 'alpha', payload: { route_mappings: [{ outbound_tag: 'VPS_US', revision: 'fresh', subscription_id: null, node_key: null }] } },
      { id: 'beta', payload: {} },
    ]);
    await expect(page.getByText('Просроченные обновлены: 2 / 2')).toBeVisible();
    await expect(page.getByText('Подписки Xray применены без перезапуска: 2.')).toBeVisible();
  });
  test('без подписок рубильника нет', async ({ page }) => {
    await mockApi(page, { subs: [] });
    await openSubscriptions(page);
    await expect(page.locator('#outbounds-subscriptions-empty')).toBeVisible();
    await expect(masterWrap(page)).toBeHidden();
    await expect(banner(page)).toBeHidden();
    await expect(deleteAll(page)).toBeHidden();
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

  test('пауза говорит, что не вернулось на место, и не красит итог в зелёный', async ({ page }) => {
    const warning = 'Не возвращено на прежнее место, потому что изменено вручную: сервер «vless-reality».';
    await mockApi(page, {
      onSwitch: ({ state }) => {
        state.paused = true;
        return {
          json: {
            ok: true,
            changed: true,
            paused: true,
            restarts: 1,
            dns: { action: 'none', from: [], to: [] },
            warning,
            skipped: [{ kind: 'outbound', name: 'vless-reality', reason: 'exists' }],
          },
        };
      },
    });
    await openSubscriptions(page);

    await masterWrap(page).click();
    await page.locator('#confirm-modal-ok-btn').click();

    const status = page.locator('#outbounds-subscriptions-status');
    await expect(status).toContainText('Подписки приостановлены.');
    await expect(status).toContainText(warning);
    await expect(status).toHaveClass(/is-warning/);
    await expect(status).not.toHaveClass(/is-success/);
    await expect(banner(page)).toBeVisible();
  });

  test('связь оборвалась на перезапуске: окно всё равно говорит, что не вернулось', async ({ page }) => {
    const warning = 'Не возвращено на прежнее место, потому что изменено вручную: сервер «vless-reality».';
    await mockApi(page, {
      onSwitch: ({ state }) => {
        // Роутер довёл паузу до конца, но ответ до окна не дошёл.
        state.paused = true;
        state.notice = { action: 'pause', warning, skipped: [] };
        return 'abort';
      },
    });
    await openSubscriptions(page);

    await masterWrap(page).click();
    await page.locator('#confirm-modal-ok-btn').click();

    const status = page.locator('#outbounds-subscriptions-status');
    await expect(status).toContainText('Жду итог');
    await advanceUntilText(page, status, warning);
    await expect(status).toContainText(warning);
    await expect(status).toHaveClass(/is-warning/);
    await expect(banner(page)).toBeVisible();
  });

  test('чужое сообщение от прошлого переключения окно не показывает', async ({ page }) => {
    await mockApi(page, {
      onSwitch: ({ state }) => {
        state.paused = true;
        state.notice = { action: 'resume', warning: 'старое сообщение', skipped: [] };
        return 'abort';
      },
    });
    await openSubscriptions(page);

    await masterWrap(page).click();
    await page.locator('#confirm-modal-ok-btn').click();

    const status = page.locator('#outbounds-subscriptions-status');
    await advanceUntilText(page, status, 'Подписки приостановлены.');
    await expect(status).toContainText('Подписки приостановлены.');
    await expect(status).not.toContainText('старое сообщение');
    await expect(status).toHaveClass(/is-success/);
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

  test('удалить все: окно предупреждает о необратимости, список пустеет', async ({ page }) => {
    const state = await mockApi(page, {
      dns: { outcome: 'resync', from: [{ tag: 'my-pool', kind: 'balancer' }], restarts: 2 },
    });
    await openSubscriptions(page);
    await expect(page.locator('#outbounds-subscriptions-tbody tr')).toHaveCount(2);
    await expect(deleteAll(page)).toBeVisible();
    // Корзина красная: её нельзя спутать с соседними кнопками обновления.
    const tone = await deleteAll(page).evaluate((node) => {
      const [r, g, b] = getComputedStyle(node).color.match(/\d+/g).map(Number);
      return r > g + 40 && r > b + 40;
    });
    expect(tone).toBe(true);

    await deleteAll(page).click();
    await expect(page.locator('#confirm-modal-title')).toHaveText('Удалить все подписки?');
    await expect(confirmText(page)).toContainText('Все 2 подписки будут удалены');
    await expect(confirmText(page)).toContainText('вернуть их будет нельзя');
    await expect(confirmText(page)).toContainText('переключатель «Подписки работают»');
    await expect(confirmText(page)).toContainText('останется на прежнем маршруте (ваш балансировщик «my-pool»)');
    await expect(confirmText(page)).toContainText('перезапущен дважды');
    await expect(page.locator('#confirm-modal-ok-btn')).toHaveText('Удалить все');
    expect(state.posts).toEqual([]);

    await page.locator('#confirm-modal-ok-btn').click();

    await expect(page.locator('#outbounds-subscriptions-tbody tr')).toHaveCount(0);
    await expect(page.locator('#outbounds-subscriptions-empty')).toBeVisible();
    await expect(deleteAll(page)).toBeHidden();
    await expect(masterWrap(page)).toBeHidden();
    await expect(page.locator('#outbounds-subscriptions-status')).toContainText('Все подписки удалены');
    expect(state.posts).toEqual([{ action: 'delete-all', body: { dns_target: '' } }]);
  });

  test('удалить все с паузы: без перезапуска и без слов про DNS', async ({ page }) => {
    const state = await mockApi(page, {
      dns: { outcome: 'restore', to: { tag: 'proxy', kind: 'balancer' }, restarts: 2 },
    });
    state.paused = true;
    await openSubscriptions(page);
    await expect(banner(page)).toBeVisible();
    await expect(deleteAll(page)).toBeEnabled();

    await deleteAll(page).click();
    await expect(confirmText(page)).toContainText('Подписки уже приостановлены');
    await expect(confirmText(page)).toContainText('Xray перезапускаться не будет');
    await expect(confirmText(page)).not.toContainText('DNS-over-VLESS');
    await expect(confirmText(page)).not.toContainText('будет перезапущен');
    await page.locator('#confirm-modal-ok-btn').click();

    await expect(page.locator('#outbounds-subscriptions-empty')).toBeVisible();
    await expect(banner(page)).toBeHidden();
    expect(state.posts.map((item) => item.action)).toEqual(['delete-all']);
  });

  test('удалить все: отказ ничего не отправляет', async ({ page }) => {
    const state = await mockApi(page);
    await openSubscriptions(page);
    await deleteAll(page).click();
    await expect(page.locator('#confirm-modal')).toBeVisible();
    await page.locator('#confirm-modal-close-btn').click();
    await expect(page.locator('#confirm-modal')).toBeHidden();
    expect(state.posts).toEqual([]);
    await expect(page.locator('#outbounds-subscriptions-tbody tr')).toHaveCount(2);
  });
});

// Удаление одной подписки: роутер доводит его до конца, даже если ответ потерян.
async function mockSingleDelete(page, onDelete) {
  const state = { removed: [], notice: {}, deletes: [] };
  const subs = [sub('alpha'), sub('beta')];
  await page.route('**/api/xray/subscriptions', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({
      json: {
        ok: true,
        subscriptions: subs.filter((item) => !state.removed.includes(item.id)),
        paused: false,
        paused_ts: null,
        switch_notice: state.notice,
      },
    });
  });
  await page.route(/\/api\/xray\/subscriptions\/(alpha|beta)(\?.*)?$/, async (route) => {
    if (route.request().method() !== 'DELETE') return route.fallback();
    const id = new URL(route.request().url()).pathname.split('/').pop();
    state.deletes.push(id);
    const custom = onDelete({ id, state, payload: route.request().postDataJSON() });
    if (custom === 'abort') return route.abort('connectionreset');
    if (custom) return route.fulfill(custom);
    state.removed.push(id);
    await route.fulfill({ json: { ok: true, deleted: { id, output_file: `04_outbounds.${id}.json` }, warning: '', skipped: [] } });
  });
  return state;
}

async function deleteFirstSubscription(page) {
  await expect(page.locator('#outbounds-subscriptions-tbody tr')).toHaveCount(2);
  await page.locator('#outbounds-subscriptions-tbody tr').first().locator('.xk-sub-delete').click();
  await expect(page.locator('#confirm-modal-title')).toHaveText('Удалить подписку?');
  await expect(confirmText(page)).toHaveCSS('font-size', '13px');
  await page.locator('#confirm-modal-ok-btn').click();
}

test('удаление подписки с группой запрашивает узлы для замены', async ({ page }) => {
  const node = { subscription_id: 'beta', node_key: 'backup', tag: 'beta--backup', label: 'Резерв' };
  const state = await mockSingleDelete(page, ({ payload }) => {
    if (payload?.route_mappings?.[0]?.node_key === node.node_key) return undefined;
    return {
      status: 409,
      json: { code: 'route_mapping_choice_required', route_mappings: [{
        outbound_tag: 'VPS_US', revision: 'delete', required: true, candidates: [node], rules: [],
      }] },
    };
  });
  await openSubscriptions(page);
  await deleteFirstSubscription(page);
  const dialog = page.locator('#confirm-modal');
  await dialog.getByRole('combobox', { name: 'Узел подписки вместо VPS_US' }).selectOption({ label: node.label });
  await dialog.getByRole('button', { name: 'Удалить и применить' }).click();
  await expect(page.locator('#outbounds-subscriptions-tbody tr')).toHaveCount(1);
  expect(state.deletes).toEqual(['alpha', 'alpha']);
});

test('pool2-integration: удаление подписки обновляет индикатор DNS без открытия окна', async ({ page }) => {
  let dns = { ...DNS_STATUS, enabled: true, can_disable: true, dns_override: true };
  await page.addInitScript(() => localStorage.setItem('xk.routing.rules.open.v2', '1'));
  await page.route('**/api/routing/dns-over-vless', async (route) => route.fulfill({ json: dns }));
  await mockSingleDelete(page, () => { dns = { ...dns, tampered: true }; });
  await openSubscriptions(page);
  await expect(page.locator('#routing-dns-over-vless-dot')).toHaveAttribute('data-state', 'enabled');
  await deleteFirstSubscription(page);
  await expect(page.locator('#outbounds-subscriptions-tbody tr')).toHaveCount(1);
  for (const id of ['routing-dns-over-vless-dot', 'routing-dns-over-vless-toolbar-dot']) {
    await expect(page.locator(`#${id}`)).toHaveAttribute('data-state', 'blocked');
  }
});

test.describe('удаление одной подписки при обрыве связи', () => {
  const warning = 'Не возвращено на прежнее место, потому что изменено вручную: сервер «vless-reality».';
  const status = (page) => page.locator('#outbounds-subscriptions-status');

  test('окно дожидается итога и говорит, что не вернулось', async ({ page }) => {
    const state = await mockSingleDelete(page, ({ id, state: s }) => {
      // Роутер удалил подписку, но ответ до окна не дошёл.
      s.removed.push(id);
      s.notice = { action: 'delete', subject: id, warning, skipped: [] };
      return 'abort';
    });
    await openSubscriptions(page);
    await deleteFirstSubscription(page);

    await expect(status(page)).toContainText('Жду итог');
    await advanceUntilText(page, status(page), warning);
    await expect(status(page)).toContainText(warning);
    await expect(status(page)).toContainText('Удалено.');
    await expect(status(page)).not.toContainText('Ошибка удаления');
    await expect(status(page)).toHaveClass(/is-warning/);
    await expect(page.locator('#outbounds-subscriptions-tbody tr')).toHaveCount(1);
    expect(state.deletes).toEqual(['alpha']);
  });

  test('сообщение от другой операции окно не показывает', async ({ page }) => {
    await mockSingleDelete(page, ({ id, state: s }) => {
      s.removed.push(id);
      s.notice = { action: 'delete', subject: 'gamma', warning: 'старое сообщение', skipped: [] };
      return 'abort';
    });
    await openSubscriptions(page);
    await deleteFirstSubscription(page);

    await advanceUntilText(page, status(page), 'Удалено.');

    await expect(status(page)).toContainText('Удалено.');
    await expect(status(page)).not.toContainText('старое сообщение');
    await expect(status(page)).toHaveClass(/is-success/);
    await expect(page.locator('#outbounds-subscriptions-tbody tr')).toHaveCount(1);
  });

  test('подписка осталась на месте: окно говорит об этом, не дожидаясь полутора минут', async ({ page }) => {
    await mockSingleDelete(page, () => 'abort');
    await openSubscriptions(page);
    await deleteFirstSubscription(page);

    await expect(status(page)).toContainText('Жду итог');
    await advanceUntilText(page, status(page), 'Ошибка удаления');
    await expect(status(page)).toContainText('Ошибка удаления');
    await expect(status(page)).toContainText('подписка осталась на месте');
    await expect(page.locator('#outbounds-subscriptions-tbody tr')).toHaveCount(2);
  });
});

// Обновление: роутер скачал и применил, а ответ потерян на перезапуске ядра.
async function mockRefresh(page, onRefresh) {
  const past = Math.floor(Date.now() / 1000) - 600;
  const state = { subs: [sub('alpha'), sub('beta', { next_update_ts: past })], posts: [] };
  await page.route('**/api/xray/subscriptions', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({
      json: { ok: true, subscriptions: state.subs, paused: false, paused_ts: null, switch_notice: {} },
    });
  });
  await page.route(/\/api\/xray\/subscriptions\/(alpha\/refresh|beta\/refresh|refresh-due)(\?.*)?$/, async (route) => {
    const target = new URL(route.request().url()).pathname.split('/subscriptions/').pop();
    state.posts.push(target);
    onRefresh({ target, state });
    await route.abort('connectionreset');
  });
  return state;
}

function refreshed(state, id, extra = {}) {
  state.subs = state.subs.map((item) => (item.id !== id ? item : {
    ...item,
    last_update_ts: Math.floor(Date.now() / 1000) + 5,
    last_ok: true,
    last_count: 7,
    last_source_count: 7,
    last_changed: true,
    last_routing_changed: false,
    last_observatory_changed: false,
    last_warnings: [],
    ...extra,
  }));
}

test.describe('обновление подписки при обрыве связи', () => {
  const status = (page) => page.locator('#outbounds-subscriptions-status');
  const rows = (page) => page.locator('#outbounds-subscriptions-tbody tr');

  test('одна подписка: окно дожидается итога и называет его', async ({ page }) => {
    const warning = 'Не возвращено на прежнее место, потому что изменено вручную: сервер «vless-reality».';
    const state = await mockRefresh(page, ({ state: s }) => refreshed(s, 'alpha', { last_warnings: [warning] }));
    await openSubscriptions(page);
    await expect(rows(page)).toHaveCount(2);
    await page.locator('#outbounds-subscriptions-tbody tr[data-sub-id="alpha"] .xk-sub-refresh').click();

    await expect(status(page)).toContainText('Жду итог');
    await advanceUntilText(page, status(page), 'Готово: узлов 7');
    await expect(status(page)).toContainText('Готово: узлов 7');
    await expect(status(page)).toContainText('файл обновлён');
    await expect(status(page)).toContainText(warning);
    await expect(status(page)).not.toContainText('Ошибка обновления');
    expect(state.posts).toEqual(['alpha/refresh']);
  });

  test('одна подписка: роутер не смог скачать — окно называет настоящую причину', async ({ page }) => {
    await mockRefresh(page, ({ state: s }) => refreshed(s, 'alpha', { last_ok: false, last_error: 'сервер подписки ответил 502' }));
    await openSubscriptions(page);
    await page.locator('#outbounds-subscriptions-tbody tr[data-sub-id="alpha"] .xk-sub-refresh').click();

    await advanceUntilText(page, status(page), 'Ошибка обновления: сервер подписки ответил 502');

    await expect(status(page)).toContainText('Ошибка обновления: сервер подписки ответил 502');
    await expect(status(page)).not.toContainText('Failed to fetch');
  });

  test('одна подписка: ничего не изменилось — окно говорит об этом', async ({ page }) => {
    await mockRefresh(page, () => {});
    await openSubscriptions(page);
    await page.locator('#outbounds-subscriptions-tbody tr[data-sub-id="alpha"] .xk-sub-refresh').click();

    await expect(status(page)).toContainText('Жду итог');
    await advanceUntilText(page, status(page), 'Ошибка обновления');
    await expect(status(page)).toContainText('Ошибка обновления');
    await expect(status(page)).toContainText('подписка осталась в прежнем состоянии');
    await expect(status(page)).not.toContainText('Failed to fetch');
  });

  test('просроченные: окно дожидается итога и считает обновлённые', async ({ page }) => {
    const state = await mockRefresh(page, ({ state: s }) => refreshed(s, 'beta'));
    await openSubscriptions(page);
    await expect(rows(page)).toHaveCount(2);
    await page.locator('#outbounds-subscriptions-refresh-due-btn').click();

    await expect(status(page)).toContainText('Жду итог');
    await advanceUntilText(page, status(page), 'Просроченные обновлены: 1 / 1');
    await expect(status(page)).toContainText('Просроченные обновлены: 1 / 1');
    await expect(status(page)).toHaveClass(/is-success/);
    expect(state.posts).toEqual(['refresh-due']);
  });
});

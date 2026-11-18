import { test, expect } from './fixtures.mjs';
import { openDialog, openZone, mockClients, STATUS } from './dns_over_vless_fixtures.mjs';


// Пользователь дописал в служебный файл больше восьми серверов, и в окне не
// работала ни одна кнопка. Здесь — как окно ведёт себя после ручной правки.

const SERVERS = Array.from({ length: 20 }, (_, n) => `9.9.9.${n + 1}`);
const ON = { ...STATUS, enabled: true, can_enable: false, can_disable: true, dns_override: true, max_upstreams: 16 };
const TAMPERED = {
  ...STATUS,
  enabled: false,
  partial: true,
  tampered: true,
  can_enable: false,
  can_disable: false,
  can_discard_edits: true,
  dns_override: true,
  blockers: ['Служебные объекты DNS-over-VLESS изменены вручную; автоматическое удаление отключено.'],
  presence: { fragment_owned: true, proxy_rule_owned: true, capture_rule_owned: true, balancer_owned: true },
  managed_fragment: '02_dns_over_vless.json',
  routing_file_name: '05_routing.json',
  tamper_details: [
    { zone: 'servers', text: 'Файл 02_dns_over_vless.json, dns.servers: «dns.google»: нужен IP-адрес.' },
    { zone: 'route', text: 'Правило xk_dns_over_vless_proxy в 05_routing.json: outboundTag «direct» — не прокси-подключение.' },
  ],
};
const READY = { ...STATUS, dns_override: false };

for (const [name, patch] of [
  ['ручные правки', { tampered: true }],
  ['устаревший маршрут', { route_drift: { source: 'proxy', managed: ['a', 'gone'], current: ['a'] } }],
  ['удалённый узел прочих записей', { pass_non_ip: true, pass_non_ip_node: 'gone', pass_non_ip_options: ['a'], pass_non_ip_missing: true,
    pass_non_ip_health: { ok: true, node: 'gone', checked_at: 1 } }],
]) {
  test(`pool2: зелёная точка не остаётся при проблеме — ${name}`, async ({ page }) => {
    await openDialog(page, { ...ON, ...patch });
    for (const id of ['routing-dns-over-vless-dot', 'routing-dns-over-vless-toolbar-dot']) {
      await expect(page.locator(`#${id}`)).toHaveAttribute('data-state', 'blocked');
    }
    if (patch.pass_non_ip_missing) {
      await expect(page.locator('#routing-dns-over-vless-pass-node')).toHaveValue('gone');
      await expect(page.locator('#routing-dns-over-vless-pass-health')).not.toContainText('проходят через');
    }
  });
}

test('pool2: проверить снова восстанавливает разрешённое сервером расхождение', async ({ page }) => {
  const stale = { ...ON, enabled: false, can_disable: false, can_resync: true, pass_non_ip_missing: true };
  await openDialog(page, stale);
  const actions = [];
  let current = stale;
  await page.route('**/api/routing/dns-over-vless', async (route) => {
    if (route.request().method() === 'POST') {
      actions.push(route.request().postDataJSON().action);
      current = ON;
      await route.fulfill({ json: { ok: true, action: 'resync', enabled: true, restarted: true } });
    } else await route.fulfill({ json: current });
  });
  const button = page.locator('#routing-dns-over-vless-apply');
  await expect(button).toHaveText('Проверить снова');
  await button.click();
  await expect(page.locator('#routing-dns-over-vless-badge')).toHaveText('Включено');
  expect(actions).toEqual(['resync']);
});

test('pool2: событие изменения подписки обновляет обе точки с закрытым окном', async ({ page }) => {
  await openDialog(page, ON);
  await page.keyboard.press('Escape');
  await expect(page.locator('#routing-dns-over-vless-modal')).toBeHidden();
  await page.route('**/api/routing/dns-over-vless', async (route) => {
    await route.fulfill({ json: { ...ON, tampered: true } });
  });
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('xkeen-routing-fragment-saved', {
    detail: { reason: 'xray-subscriptions' },
  })));
  for (const id of ['routing-dns-over-vless-dot', 'routing-dns-over-vless-toolbar-dot']) {
    await expect(page.locator(`#${id}`)).toHaveAttribute('data-state', 'blocked');
  }
});

test('pool2-review: ошибка фоновой проверки снимает зелёную индикацию', async ({ page }) => {
  await openDialog(page, ON);
  await page.route('**/api/routing/dns-over-vless', async (route) => {
    await route.fulfill({ status: 503, json: { error: 'status unavailable' } });
  });
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('xkeen-routing-fragment-saved', {
    detail: { reason: 'xray-subscriptions' },
  })));
  await expect(page.locator('#routing-dns-over-vless-badge')).toHaveText('Ошибка проверки');
  for (const id of ['routing-dns-over-vless-dot', 'routing-dns-over-vless-toolbar-dot']) {
    await expect(page.locator(`#${id}`)).toHaveAttribute('data-state', 'blocked');
  }
});

test('pool2-review: изменение подписки во время выбора устройств не теряет статус', async ({ page }) => {
  await mockClients(page, { available: true, clients: [{ mac: 'aa:bb:cc:dd:ee:02', title: 'Телефон', active: true,
    can_capture: true, verdict: 'intercepted' }], counts: { total: 1 } });
  await openDialog(page, { ...ON, capture_clients: false, capture_macs: [] });
  await openZone(page, 'devices');
  await page.locator('.routing-dns-over-vless-clients-pick').check({ force: true });
  let finishPost;
  await page.route('**/api/routing/dns-over-vless', async (route) => {
    if (route.request().method() === 'POST') {
      await new Promise((resolve) => { finishPost = resolve; });
      await route.fulfill({ json: { ok: true, action: 'capture', enabled: true } });
    } else await route.fulfill({ json: { ...ON, tampered: true } });
  });
  await page.locator('#routing-dns-over-vless-clients-apply').click();
  await expect.poll(() => !!finishPost).toBe(true);
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('xkeen-routing-fragment-saved', {
    detail: { reason: 'xray-subscriptions' },
  })));
  finishPost();
  await expect(page.locator('#routing-dns-over-vless-dot')).toHaveAttribute('data-state', 'blocked');
});


test('серверы сверх предела: метка называет лишние, отключить можно', async ({ page }) => {
  await openDialog(page, { ...ON, upstreams: SERVERS });

  await expect(page.locator('[data-zone-req="servers"]')).toHaveText('4 лишних');
  await expect(page.locator('[data-zone-req="servers"]')).toHaveAttribute('data-state', 'warn');
  await expect(page.locator('[data-zone-sum="servers"]')).toHaveText('20 серверов, панель пишет до 16');
  await expect(page.locator('#routing-dns-over-vless-upstreams-over')).toContainText('не больше 16');
  await expect(page.locator('#routing-dns-over-vless-details')).toContainText('лишние понадобится убрать');
  const apply = page.locator('#routing-dns-over-vless-apply');
  await expect(apply).toHaveText('Отключить и восстановить');
  await expect(apply).toBeEnabled();
});


test('в пределах лимита ни метки, ни пояснения о лишних нет', async ({ page }) => {
  await openDialog(page, { ...ON, upstreams: SERVERS.slice(0, 11) });

  await expect(page.locator('[data-zone-req="servers"]')).toHaveText('серверы применены');
  await expect(page.locator('#routing-dns-over-vless-upstreams-over')).toBeHidden();
});


test('обычное отключение — штатная кнопка, а не опасная', async ({ page }) => {
  await openDialog(page, ON);

  const apply = page.locator('#routing-dns-over-vless-apply');
  await expect(apply).toHaveText('Отключить и восстановить');
  await expect(apply).toHaveClass(/btn-secondary/);
  await expect(apply).not.toHaveClass(/btn-danger/);
  await expect(page.locator('#routing-dns-over-vless-discard')).toBeHidden();
});


test('ручная правка: своё состояние, перечень и две рабочие кнопки', async ({ page }) => {
  await openDialog(page, TAMPERED);

  await expect(page.locator('#routing-dns-over-vless-badge')).toHaveText('Изменено вручную');
  const status = page.locator('#routing-dns-over-vless-status');
  await expect(status).not.toContainText('прерванной операции');
  const details = page.locator('#routing-dns-over-vless-details');
  await expect(details).toContainText('«dns.google»');
  await expect(details).toContainText('xk_dns_over_vless_proxy');
  // Общая строка «изменены вручную» заменена перечнем.
  await expect(details).not.toContainText('автоматическое удаление отключено');
  await expect(page.locator('[data-zone-req="servers"]')).toHaveText('изменено вручную');
  await expect(page.locator('[data-zone-req="route"]')).toHaveText('изменено вручную');

  const apply = page.locator('#routing-dns-over-vless-apply');
  await expect(apply).toHaveText('Проверить снова');
  await expect(apply).toBeEnabled();
  const discard = page.locator('#routing-dns-over-vless-discard');
  await expect(discard).toBeVisible();
  await expect(discard).toBeEnabled();
  await expect(discard).toHaveText('Выключить и удалить правки…');
});


test('«Проверить снова» перечитывает состояние и принимает исправленный файл', async ({ page }) => {
  await openDialog(page, TAMPERED);
  let current = TAMPERED;
  await page.route('**/api/routing/dns-over-vless', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(current) });
  });

  current = ON;
  await page.locator('#routing-dns-over-vless-apply').click();

  await expect(page.locator('#routing-dns-over-vless-badge')).toHaveText('Включено');
  await expect(page.locator('#routing-dns-over-vless-discard')).toBeHidden();
});


test('выключение с удалением правок: подтверждение, запрос и строка до закрытия окна', async ({ page }) => {
  await openDialog(page, TAMPERED);
  const sent = [];
  let current = TAMPERED;
  await page.route('**/api/routing/dns-over-vless', async (route) => {
    const request = route.request();
    if (request.method() === 'POST') {
      sent.push(JSON.parse(request.postData() || '{}'));
      current = READY;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, action: 'disable', enabled: false, discarded_edits: true }),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(current) });
  });

  await page.locator('#routing-dns-over-vless-discard').click();
  const confirm = page.locator('#confirm-modal');
  await expect(confirm).not.toHaveClass(/hidden/);
  await expect(page.locator('#confirm-modal-title')).toHaveText('Выключить DNS-over-VLESS и удалить правки');
  await expect(page.locator('#confirm-modal-message')).toContainText('02_dns_over_vless.json');
  await expect(page.locator('#confirm-modal-message')).toContainText('xk_dns_over_vless_proxy и xk_dns_over_vless_capture в 05_routing.json');
  await expect(page.locator('#confirm-modal-ok-btn')).toHaveText('Выключить и удалить правки');
  await page.locator('#confirm-modal-ok-btn').click();

  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0].action).toBe('disable');
  expect(sent[0].discard_edits).toBe(true);
  const details = page.locator('#routing-dns-over-vless-details');
  await expect(details).toContainText('ручные правки служебной настройки удалены');

  // Строка важна в ту минуту, когда это случилось: при новом открытии её нет.
  await page.locator('#routing-dns-over-vless-close').click();
  await page.locator('#routing-dns-over-vless-btn').click();
  await expect(page.locator('#routing-dns-over-vless-modal')).toBeVisible();
  await expect(page.locator('#routing-dns-over-vless-badge')).toHaveText('Готово');
  await expect(details).not.toContainText('ручные правки служебной настройки удалены');
});


test('отказ в подтверждении ничего не отправляет', async ({ page }) => {
  await openDialog(page, TAMPERED);
  const sent = [];
  await page.route('**/api/routing/dns-over-vless', async (route) => {
    if (route.request().method() === 'POST') sent.push(1);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(TAMPERED) });
  });

  await page.locator('#routing-dns-over-vless-discard').click();
  await expect(page.locator('#confirm-modal')).not.toHaveClass(/hidden/);
  await page.locator('#confirm-modal-close-btn').click();
  await expect(page.locator('#confirm-modal')).toHaveClass(/hidden/);
  expect(sent).toHaveLength(0);
});


test('домашние имена без резолвера прошивки называют последствие', async ({ page }) => {
  await openDialog(page, { ...STATUS, firmware_resolvers: [] });

  await expect(page.locator('[data-zone-sum="home"]')).toHaveText('домашние имена не разрешаются');
  await page.locator('.xk-dns-zone[data-zone="home"] .xk-dns-zone-head b').click();
  await expect(page.locator('#routing-dns-over-vless-local-hint')).toContainText('Свои локальные DNS');
  await page.locator('.xk-dns-zone[data-zone="home"] .xk-dns-zone-body .dt-switch').first().click();
  await expect(page.locator('[data-zone-sum="home"]')).toHaveText('домашние имена уходят в туннель');
});


test('правка во включённой защите тоже ведёт к «Проверить снова», а не к отказу сервера', async ({ page }) => {
  // Например, правило своих резолверов изменено: DNS работает, но обычное
  // отключение сервер отклонил бы.
  await openDialog(page, {
    ...ON,
    tampered: true,
    can_disable: false,
    can_discard_edits: true,
    presence: TAMPERED.presence,
    tamper_details: [{ zone: 'home', text: 'Правило xk_dns_over_vless_local в 05_routing.json: ip: ["10.0.0.1"] вместо ["192.168.1.1"].' }],
  });

  await expect(page.locator('#routing-dns-over-vless-badge')).toHaveText('Изменено вручную');
  const apply = page.locator('#routing-dns-over-vless-apply');
  await expect(apply).toHaveText('Проверить снова');
  await expect(apply).toHaveClass(/btn-primary/);
  await expect(page.locator('#routing-dns-over-vless-discard')).toBeVisible();
});


test('после ручной правки окно не говорит «сторожить нечего», пока сторож следит', async ({ page }) => {
  await openDialog(page, { ...TAMPERED, guard_watching: true });

  const details = page.locator('#routing-dns-over-vless-details');
  await expect(details).toContainText('Сторож следит');
  await expect(details).not.toContainText('сторожить нечего');
});


test('если защиту не включали, сторожить и правда нечего', async ({ page }) => {
  await openDialog(page, { ...TAMPERED, guard_watching: false });

  await expect(page.locator('#routing-dns-over-vless-details')).toContainText('сторожить нечего');
});

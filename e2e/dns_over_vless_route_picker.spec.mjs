import { test, expect } from './fixtures.mjs';
import { STATUS, openDialog, openZone } from './dns_over_vless_fixtures.mjs';


const BYPASS_STATUS = {
  ...STATUS,
  direct_resolvers: [],
  direct_domains: [],
  // What the user's own routing rules already send past the tunnel.
  direct_rule_domains: ['geosite:category-ru', 'domain:ok.ru'],
};


const MIHOMO_STATUS = {
  ...STATUS,
  active_core: 'mihomo',
  can_enable: false,
  blockers: ['Для активации переключите активное ядро на Xray.'],
  // Wording the universal guard actually writes when the core is switched.
  watchdog: { reason: 'Активно ядро mihomo, а защита DNS рассчитана на xray; перезапуски делу не помогут, DNS возвращён прошивке.' },
};


test('the dialog opens with its footer inside the frame and scrolls its body', async ({ page }) => {
  // A short viewport is the case that used to cut the footer off.
  await page.setViewportSize({ width: 1280, height: 700 });
  await openDialog(page);
  // Окно открывается свёрнутым и на этой высоте помещается целиком:
  // проверяем прокрутку, поэтому раскрываем зоны, как человек с длинной
  // настройкой перед собой.
  await page.locator('#routing-dns-over-vless-modal .xk-dns-zone')
    .evaluateAll((zones) => zones.forEach((zone) => { zone.open = true; }));

  const geometry = await page.evaluate(() => {
    const content = document.querySelector('#routing-dns-over-vless-modal .modal-content');
    const body = document.querySelector('#routing-dns-over-vless-modal .routing-dns-over-vless-body');
    const actions = document.querySelector('#routing-dns-over-vless-modal .routing-dns-over-vless-actions');
    return {
      contentTop: content.getBoundingClientRect().top,
      contentHeight: content.getBoundingClientRect().height,
      contentBottom: content.getBoundingClientRect().bottom,
      actionsBottom: actions.getBoundingClientRect().bottom,
      actionsHeight: actions.getBoundingClientRect().height,
      bodyOverflows: body.scrollHeight > body.clientHeight + 1,
      viewportHeight: window.innerHeight,
    };
  });

  expect(geometry.actionsHeight).toBeGreaterThan(0);
  // The footer used to be cut off by the grid overflowing its own max-height.
  expect(geometry.actionsBottom).toBeLessThanOrEqual(geometry.contentBottom + 1);
  expect(geometry.actionsBottom).toBeLessThanOrEqual(geometry.viewportHeight);
  expect(geometry.bodyOverflows).toBe(true);
  // Pinned to the top and as tall as the screen allows.
  expect(geometry.contentTop).toBeLessThanOrEqual(20);
  expect(geometry.contentHeight).toBeGreaterThan(geometry.viewportHeight - 40);
  await expect(page.locator('#routing-dns-over-vless-apply')).toBeVisible();
});


test('with Mihomo running the dialog talks about Mihomo, not Xray', async ({ page }) => {
  await openDialog(page, MIHOMO_STATUS);

  await expect(page.locator('#routing-dns-over-vless-lead-title')).toContainText('Mihomo');
  await expect(page.locator('#routing-dns-over-vless-lead-text')).toContainText('вкладке Mihomo');
  // Mihomo has the same protection of its own, so nothing may read as "you
  // cannot have protected DNS".
  await expect(page.locator('#routing-dns-over-vless-modal')).not.toContainText('только с Xray');
  await expect(page.locator('#routing-dns-over-vless-modal')).not.toContainText('только для Xray');
  // The guard is one mechanism for both cores, so both windows announce it with
  // the same sentence and the same badge.
  await expect(page.locator('#routing-dns-over-vless-badge')).toHaveText('Снято сторожем');
  await expect(page.locator('#routing-dns-over-vless-status')).toContainText('Сторож вернул DNS роутеру');
  await expect(page.locator('#routing-dns-over-vless-status')).toContainText('вернув активным ядром Xray вместо Mihomo');
  // The guard's own reason is accurate, so it is shown as written.
  await expect(page.locator('#routing-dns-over-vless-status')).toContainText('перезапуски делу не помогут');
  // No point picking a route that cannot be applied under this core.
  await expect(page.locator('#routing-dns-over-vless-route')).toBeHidden();
  const apply = page.locator('#routing-dns-over-vless-apply');
  await expect(apply).toHaveText('Нужно ядро Xray');
  await expect(apply).toBeDisabled();
});


test('with Xray running the dialog keeps its Xray wording', async ({ page }) => {
  await openDialog(page);

  await expect(page.locator('#routing-dns-over-vless-lead-title')).toHaveText('DNS через защищённый туннель Xray');
  await expect(page.locator('#routing-dns-over-vless-status')).toContainText('конфигурация совместима');
  await expect(page.locator('#routing-dns-over-vless-apply')).toHaveText('Включить безопасно');
});


test('a click ticks a proxy and the next click unticks it', async ({ page }) => {
  await openDialog(page);
  await openZone(page, 'route');

  const picker = page.locator('#routing-dns-over-vless-target');
  const options = picker.locator('.routing-dns-over-vless-option');
  await expect(options).toHaveCount(5);
  // Single-target mode preselects the saved default.
  await expect(picker.locator('[data-tag="proxy"]')).toHaveAttribute('data-selected', '1');

  await page.locator('#routing-dns-over-vless-multi').check();
  await expect(picker).toHaveAttribute('data-mode', 'multi');
  // Balancers cannot be combined, so only plain proxies remain.
  await expect(options).toHaveCount(4);

  const first = picker.locator('[data-tag="cdn.pecan.run--YYY_Netherlands.0005"]');
  const second = picker.locator('[data-tag="cdn.pecan.run--XXX_Germany.98.1016"]');
  // Switching modes keeps one working default ticked instead of an empty list.
  await expect(first).toHaveAttribute('data-selected', '1');
  await expect(page.locator('#routing-dns-over-vless-target-count')).toHaveText('Отмечено 1 из 3');

  await second.click();
  await expect(first).toHaveAttribute('data-selected', '1');
  await expect(second).toHaveAttribute('data-selected', '1');
  await expect(page.locator('#routing-dns-over-vless-target-count')).toHaveText('Отмечено 2 из 3');
  await expect(page.locator('#routing-dns-over-vless-apply')).toBeEnabled();

  await second.click();
  await expect(first).toHaveAttribute('data-selected', '1');
  await expect(second).toHaveAttribute('data-selected', '0');
  await expect(page.locator('#routing-dns-over-vless-target-count')).toHaveText('Отмечено 1 из 3');
  await expect(page.locator('#routing-dns-over-vless-route-fallback')).toContainText('балансировки не будет');

  // An unusable candidate stays inert.
  const broken = picker.locator('[data-tag="cdn.pecan.run--ZZZ_Kazakhstan_02.a361"]');
  await expect(broken).toHaveAttribute('aria-disabled', 'true');
  // Playwright treats aria-disabled as disabled, so drive the click directly.
  await broken.click({ force: true });
  await expect(broken).toHaveAttribute('data-selected', '0');
});


test('bulk buttons fill and clear the selection, and an empty one blocks the action', async ({ page }) => {
  await openDialog(page);
  await openZone(page, 'route');
  await page.locator('#routing-dns-over-vless-multi').check();

  await page.locator('#routing-dns-over-vless-target-all').click();
  await expect(page.locator('#routing-dns-over-vless-target-count')).toHaveText('Отмечено 3 из 3');
  await expect(page.locator('#routing-dns-over-vless-apply')).toBeEnabled();

  await page.locator('#routing-dns-over-vless-target-none').click();
  await expect(page.locator('#routing-dns-over-vless-target-count')).toHaveText('Отмечено 0 из 3');
  // Nothing ticked means no route to build: the action must stay closed.
  await expect(page.locator('#routing-dns-over-vless-apply')).toBeDisabled();
  await expect(page.locator('#routing-dns-over-vless-route-fallback')).toContainText('Отметьте хотя бы два прокси');
});


test('the list is operable from the keyboard', async ({ page }) => {
  await openDialog(page);
  await openZone(page, 'route');
  await page.locator('#routing-dns-over-vless-multi').check();

  const picker = page.locator('#routing-dns-over-vless-target');
  await picker.locator('[data-tag="cdn.pecan.run--XXX_Germany.98.1016"]').focus();
  await page.keyboard.press('Space');
  await expect(picker.locator('[data-tag="cdn.pecan.run--XXX_Germany.98.1016"]')).toHaveAttribute('data-selected', '1');
  await expect(page.locator('#routing-dns-over-vless-target-count')).toHaveText('Отмечено 2 из 3');

  // The redraw must not lose the focused row, so the next arrow key moves on.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(picker.locator('[data-tag="cdn.pecan.run--YYY_Sweden.e026"]')).toHaveAttribute('data-selected', '1');
  await expect(page.locator('#routing-dns-over-vless-target-count')).toHaveText('Отмечено 3 из 3');
});


test('clicking the header leaves the dialog where it is, dragging still moves it', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 700 });
  await openDialog(page);

  const content = page.locator('#routing-dns-over-vless-modal .modal-content');
  const geometry = () => content.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return { top: Math.round(rect.top), left: Math.round(rect.left), height: Math.round(rect.height) };
  });

  const before = await geometry();
  const header = page.locator('#routing-dns-over-vless-modal .modal-header');
  const box = await header.boundingBox();
  if (!box) throw new Error('modal header has no bounding box');

  // A plain click used to freeze the dialog into fixed coordinates and drop its
  // max-height, so it grew to full content height and slid off screen.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.up();
  const afterClick = await geometry();
  expect(afterClick).toEqual(before);

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 30, { steps: 6 });
  await page.mouse.up();
  const afterDrag = await geometry();
  expect(afterDrag.left).toBeGreaterThan(before.left + 40);
});


test('the bypass domain list appears with its resolver and fills from the rules', async ({ page }) => {
  await openDialog(page, BYPASS_STATUS);
  await openZone(page, 'direct');

  const resolvers = page.locator('#routing-dns-over-vless-direct');
  const domains = page.locator('#routing-dns-over-vless-direct-zones');
  const fromRules = page.locator('#routing-dns-over-vless-direct-from-rules');

  // Domains mean nothing until a resolver is named, so the list stays hidden.
  await expect(resolvers).toBeVisible();
  await expect(domains).toBeHidden();

  await resolvers.fill('77.88.8.8, 77.88.8.1');
  await expect(domains).toBeVisible();

  // Retyping the list by hand is what lets it drift from the routing rules.
  await expect(fromRules).toBeEnabled();
  await fromRules.click();
  await expect(domains).toHaveValue('geosite:category-ru, domain:ok.ru');
});


test('with no direct rules the offer button stays closed', async ({ page }) => {
  await openDialog(page, { ...BYPASS_STATUS, direct_rule_domains: [] });
  await openZone(page, 'direct');

  await page.locator('#routing-dns-over-vless-direct').fill('77.88.8.8');
  await expect(page.locator('#routing-dns-over-vless-direct-zones')).toBeVisible();
  await expect(page.locator('#routing-dns-over-vless-direct-from-rules')).toBeDisabled();
});


test('the other record types are let through on one node the dialog names', async ({ page }) => {
  const status = {
    ...STATUS,
    pass_non_ip: false,
    pass_non_ip_node: '',
    pass_non_ip_options: ['node-alpha', 'node-beta'],
  };
  await openDialog(page, status);
  await openZone(page, 'records');

  const row = page.locator('#routing-dns-over-vless-pass-row');
  const toggle = page.locator('#routing-dns-over-vless-pass');
  const node = page.locator('#routing-dns-over-vless-pass-node');

  // The node only matters once the pass-through is on, so it stays out of the
  // way until then.
  await expect(toggle).not.toBeChecked();
  await expect(row).toBeHidden();

  // The switch is styled: its slider covers the box, so drive the input itself.
  await toggle.check({ force: true });
  await expect(row).toBeVisible();
  await expect(node.locator('option')).toHaveCount(2);
  await expect(node).toHaveValue('node-alpha');

  await node.selectOption('node-beta');

  let sent = null;
  await page.route('**/api/routing/dns-over-vless', async (route) => {
    if (route.request().method() === 'POST') {
      sent = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, action: 'enable', enabled: true, restarted: true, probe: { ok: true } }),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(status) });
  });

  const apply = page.locator('#routing-dns-over-vless-apply');
  await expect(apply).toBeEnabled();
  await apply.click();

  // Enabling asks for confirmation first; the request only fires once it is
  // accepted.
  await expect(page.locator('#confirm-modal')).not.toHaveClass(/hidden/);
  await page.locator('#confirm-modal-ok-btn').click();

  await expect.poll(() => sent && sent.pass_non_ip).toBe(true);
  // The node the user picked, not the first one the panel offered.
  expect(sent.pass_non_ip_node).toBe('node-beta');
});


test('a remembered node keeps its place and a vanished one does not look chosen', async ({ page }) => {
  await openDialog(page, {
    ...STATUS,
    pass_non_ip: true,
    pass_non_ip_node: 'node-beta',
    pass_non_ip_options: ['node-alpha', 'node-beta'],
  });
  await openZone(page, 'records');

  // Reordering the user's own balancer must not move the traffic silently.
  await expect(page.locator('#routing-dns-over-vless-pass')).toBeChecked();
  await expect(page.locator('#routing-dns-over-vless-pass-row')).toBeVisible();
  await expect(page.locator('#routing-dns-over-vless-pass-node')).toHaveValue('node-beta');
});


const CLIENTS = {
  ok: true,
  available: true,
  error: '',
  counts: { total: 3, reaches: 1, intercepted: 1, unknown: 1 },
  clients: [
    { mac: 'aa:bb:cc:dd:ee:01', ip: '192.168.10.20', title: 'Ноутбук', policy: 'XKeen', active: true, registered: true, verdict: 'reaches', reason: 'устройство не состоит в политике доступа', can_capture: false, captured: false, firmware_resolver: '' },
    { mac: 'aa:bb:cc:dd:ee:02', ip: '192.168.10.21', title: 'Телефон', policy: 'XKeen', active: true, registered: true, verdict: 'intercepted', reason: 'DNS перехватывает политика «XKeen»', can_capture: true, captured: false, firmware_resolver: '127.0.0.1:41100' },
    { mac: 'aa:bb:cc:dd:ee:03', ip: '', title: 'Камера', policy: 'Гости', active: false, registered: true, verdict: 'unknown', reason: 'не удалось определить метку политики «Гости»', can_capture: true, captured: false, firmware_resolver: '' },
  ],
  policies: [],
};


async function routeClients(page, payload) {
  await page.route('**/api/routing/dns-over-vless/clients', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
  });
}


test('the dialog says who uses the feature and puts the taken-away devices first', async ({ page }) => {
  await routeClients(page, CLIENTS);
  await openDialog(page);

  const summary = page.locator('#routing-dns-over-vless-clients-summary');
  await expect(summary).toContainText('Пользуются 1 из 3');
  await expect(summary).toContainText('у 1 DNS забирает политика доступа');

  const rows = page.locator('#routing-dns-over-vless-clients-list li');
  await expect(rows).toHaveCount(3);
  // Devices the feature never reaches are the reason to open this list at all.
  await expect(rows.nth(0)).toHaveAttribute('data-verdict', 'intercepted');
  await expect(rows.nth(0)).toContainText('Телефон');
  await expect(rows.nth(1)).toHaveAttribute('data-verdict', 'unknown');
  await expect(rows.nth(2)).toHaveAttribute('data-verdict', 'reaches');
});


test('a device that is away says so instead of showing an address it no longer has', async ({ page }) => {
  await routeClients(page, CLIENTS);
  await openDialog(page);

  const rows = page.locator('#routing-dns-over-vless-clients-list li');
  const away = rows.filter({ hasText: 'Камера' });
  await expect(away).toHaveAttribute('data-offline', '1');
  await expect(away).toContainText('не в сети');
  // Без аренды адреса прошивка отдаёт 0.0.0.0; вместо него остаётся MAC.
  await expect(away).toContainText('aa:bb:cc:dd:ee:03');

  // Устройство в сети такой отметки не получает.
  const here = rows.filter({ hasText: 'Ноутбук' });
  await expect(here).not.toHaveAttribute('data-offline', '1');
  await expect(here).toContainText('192.168.10.20');
});


test('an unreadable device list is admitted instead of passing for success', async ({ page }) => {
  await routeClients(page, {
    ok: false,
    available: false,
    error: 'ndmc не найден — это не Keenetic',
    clients: [],
    counts: { total: 0, reaches: 0, intercepted: 0, unknown: 0 },
  });
  await openDialog(page);

  await expect(page.locator('#routing-dns-over-vless-clients-summary')).toContainText('это не Keenetic');
  await expect(page.locator('#routing-dns-over-vless-clients-list li')).toHaveCount(0);
});


test('devices are ticked one by one and only with the switch on', async ({ page }) => {
  const status = { ...STATUS, capture_clients: false, capture_macs: [] };
  await routeClients(page, CLIENTS);
  await openDialog(page, status);
  await openZone(page, 'devices');

  const picks = page.locator('.routing-dns-over-vless-clients-pick');
  // Отмечать можно только тех, у кого DNS забирает политика: ноутбук доходит
  // и без правила, галочки у него нет.
  await expect(picks).toHaveCount(2);
  // Пока переключатель выключен, цепочки нет вовсе — и галочки не трогаются.
  await expect(picks.first()).toBeDisabled();

  const toggle = page.locator('#routing-dns-over-vless-capture');
  await toggle.check({ force: true });
  await expect(picks.first()).toBeEnabled();

  const phone = page.locator('#routing-dns-over-vless-clients-list li', { hasText: 'Телефон' });
  // Адрес резолвера прошивки назван прямо в строке: он же отвечает за
  // домашние имена, которые устройство потеряет.
  await expect(phone).toContainText('127.0.0.1:41100');
  await phone.locator('.routing-dns-over-vless-clients-pick').check({ force: true });

  let sent = null;
  await page.route('**/api/routing/dns-over-vless', async (route) => {
    if (route.request().method() === 'POST') {
      sent = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, action: 'enable', enabled: true, restarted: true, probe: { ok: true } }),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(status) });
  });

  await page.locator('#routing-dns-over-vless-apply').click();
  await expect(page.locator('#confirm-modal')).not.toHaveClass(/hidden/);
  await page.locator('#confirm-modal-ok-btn').click();

  await expect.poll(() => sent && sent.capture_clients).toBe(true);
  expect(sent.capture_macs).toEqual(['aa:bb:cc:dd:ee:02']);
});


test('a remembered choice comes back ticked', async ({ page }) => {
  await routeClients(page, CLIENTS);
  await openDialog(page, {
    ...STATUS,
    capture_clients: true,
    capture_macs: ['aa:bb:cc:dd:ee:03'],
  });

  const camera = page.locator('#routing-dns-over-vless-clients-list li', { hasText: 'Камера' });
  await expect(camera.locator('.routing-dns-over-vless-clients-pick')).toBeChecked();
  const phone = page.locator('#routing-dns-over-vless-clients-list li', { hasText: 'Телефон' });
  await expect(phone.locator('.routing-dns-over-vless-clients-pick')).not.toBeChecked();
});


test('with the feature on, the window still shows what the router holds', async ({ page }) => {
  await routeClients(page, {
    ...CLIENTS,
    clients: CLIENTS.clients.map((item) =>
      item.mac === 'aa:bb:cc:dd:ee:02'
        ? { ...item, captured: true, verdict: 'reaches', reason: 'DNS заведён в туннель правилом панели' }
        : item),
  });
  // Включённая функция прячет выбор маршрута — и раньше вместе с ним
  // переставали заполняться все остальные поля окна.
  await openDialog(page, {
    ...STATUS,
    enabled: true,
    can_enable: false,
    can_disable: true,
    upstreams: ['127.0.0.53'],
    upstreams_remote: true,
    capture_clients: true,
    capture_macs: ['aa:bb:cc:dd:ee:02'],
  });

  await expect(page.locator('#routing-dns-over-vless-capture')).toBeChecked();
  await expect(page.locator('#routing-dns-over-vless-remote')).toBeChecked();
  await expect(page.locator('#routing-dns-over-vless-upstreams')).toHaveValue('127.0.0.53');

  const phone = page.locator('#routing-dns-over-vless-clients-list li', { hasText: 'Телефон' });
  await expect(phone.locator('.routing-dns-over-vless-clients-pick')).toBeChecked();
});


test('the reset button clears the window without touching the router', async ({ page }) => {
  await routeClients(page, CLIENTS);
  const status = {
    ...STATUS,
    upstreams: ['127.0.0.53'],
    upstreams_remote: true,
    capture_clients: true,
    capture_macs: ['aa:bb:cc:dd:ee:02'],
  };
  await openDialog(page, status);

  let posted = 0;
  await page.route('**/api/routing/dns-over-vless', async (route) => {
    if (route.request().method() === 'POST') posted += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(status),
    });
  });

  const upstreams = page.locator('#routing-dns-over-vless-upstreams');
  const remote = page.locator('#routing-dns-over-vless-remote');
  await expect(upstreams).toHaveValue('127.0.0.53');
  await expect(remote).toBeChecked();
  const phone = page.locator('#routing-dns-over-vless-clients-list li', { hasText: 'Телефон' });
  await expect(phone.locator('.routing-dns-over-vless-clients-pick')).toBeChecked();

  await page.locator('#routing-dns-over-vless-reset').click();

  // Настройки теперь переживают выключение функции, поэтому нужен способ
  // начать с чистого листа.
  await expect(upstreams).toHaveValue('8.8.8.8');
  await expect(remote).not.toBeChecked();
  await expect(page.locator('#routing-dns-over-vless-capture')).not.toBeChecked();
  await expect(phone.locator('.routing-dns-over-vless-clients-pick')).not.toBeChecked();
  // Роутер при этом не трогаем: сброс — это только поля окна.
  expect(posted).toBe(0);
});


test('the dialog says when the other record types moved to a reserve node', async ({ page }) => {
  await openDialog(page, {
    ...STATUS,
    pass_non_ip: true,
    pass_non_ip_node: 'node-beta',
    pass_non_ip_options: ['node-alpha', 'node-beta'],
    pass_non_ip_health: {
      ok: false,
      checked_at: 1756800000,
      node: 'node-beta',
      switched_from: 'node-alpha',
      switched_at: 1756800000,
      exhausted: false,
      error: '',
    },
  });
  await openZone(page, 'records');

  // The guard probe asks for A, so without this line a half-broken feature
  // looks perfectly healthy in the window.
  const health = page.locator('#routing-dns-over-vless-pass-health');
  await expect(health).toBeVisible();
  await expect(health).toContainText('node-beta');
  await expect(health).toContainText('node-alpha');
});


test('the dialog admits it when no node carries the other record types', async ({ page }) => {
  await openDialog(page, {
    ...STATUS,
    pass_non_ip: true,
    pass_non_ip_node: 'node-beta',
    pass_non_ip_options: ['node-alpha', 'node-beta'],
    pass_non_ip_health: {
      ok: false,
      checked_at: 1756800000,
      node: 'node-beta',
      switched_from: 'node-alpha',
      switched_at: 1756800000,
      exhausted: true,
      error: '',
    },
  });
  await openZone(page, 'records');

  const health = page.locator('#routing-dns-over-vless-pass-health');
  await expect(health).toBeVisible();
  await expect(health).toContainText('ни один');
  // A and AAAA keep working: the reader has to know the outage is partial.
  await expect(health).toContainText('AAAA');
});

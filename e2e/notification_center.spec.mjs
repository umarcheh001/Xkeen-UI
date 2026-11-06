import { readFileSync } from 'node:fs';

import { test, expect } from './fixtures.mjs';

const server = JSON.parse(readFileSync(new URL('./fixtures/module_manager_server.json', import.meta.url), 'utf8'));

function record(id, kind, title, message) {
  return {
    id,
    kind,
    channel: 'prerelease',
    version: '2.11.0-beta.1',
    title,
    message,
    size: 1_048_576,
    requires_restart: true,
    dependency_changes: { requires_added: ['tool.editor'], requires_removed: [], conflicts_added: [], conflicts_removed: [] },
    seen: false,
  };
}

async function mockLifecycle(page) {
  await page.route('**/api/modules/installed', (route) => route.fulfill({ json: server.installed }));
  await page.route('**/api/modules/operations/status', (route) => route.fulfill({ json: server.status_none }));
  await page.route('**/api/modules/panel/update-check', (route) => route.fulfill({ json: server.update_check_current }));
}

test('notification center is core-owned, text-safe, and does not fetch archives', async ({ page }) => {
  await mockLifecycle(page);
  let records = [
    record('a'.repeat(64), 'panel-update', 'Доступна новая версия панели', 'Сохранит выбранный профиль.'),
    record('b'.repeat(64), 'module-new', '<img src=x onerror=alert(1)>', 'Новый модуль появится после обновления панели.'),
  ];
  const snapshot = () => ({
    ok: true,
    channel: 'prerelease',
    records,
    unread_count: records.filter((item) => !item.seen).length,
    status: { last_success_at: 1_791_700_000, freshness: 'fresh', stale_reason: null, error_code: null },
  });
  const archiveRequests = [];
  page.on('request', (request) => {
    if (/\.tar\.gz(?:$|[?#])/.test(request.url())) archiveRequests.push(request.url());
  });
  await page.route('**/api/notifications', (route) => route.fulfill({ json: snapshot() }));
  await page.route('**/api/notifications/mark-seen', async (route) => {
    const body = route.request().postDataJSON();
    const seen = new Set(body.record_ids);
    records = records.map((item) => (seen.has(item.id) ? { ...item, seen: true } : item));
    await route.fulfill({ json: snapshot() });
  });
  await page.route('**/api/notifications/check', (route) => route.fulfill({ json: snapshot() }));
  await page.route('**/api/notifications/*', async (route) => {
    const url = route.request().url();
    const body = route.request().postDataJSON();
    if (url.endsWith('/mark-seen')) {
      const seen = new Set(body.record_ids || []);
      records = records.map((item) => (seen.has(item.id) ? { ...item, seen: true } : item));
    } else if (body.action === 'dismiss') {
      records = records.filter((item) => !url.endsWith(item.id));
    }
    await route.fulfill({ json: snapshot() });
  });

  await page.goto('/modules');
  const trigger = page.locator('.xk-notification-trigger');
  await expect(trigger).toBeVisible();
  await expect(trigger.locator('.xk-notification-trigger__count')).toHaveText('2');

  await trigger.click();
  const center = page.locator('.xk-notification-popover');
  await expect(center).toBeVisible();
  await expect(center).toContainText('Доступна новая версия панели');
  await expect(center).toContainText('Новый модуль появится после обновления панели.');
  await expect(center.locator('img')).toHaveCount(0);
  await expect(center).toContainText('<img src=x onerror=alert(1)>');

  await center.getByRole('button', { name: 'Проверить обновления' }).click();
  await expect(center).toContainText('Проверено');
  await expect(archiveRequests).toEqual([]);

  await center.locator('.xk-notification-record').first().getByRole('button', { name: 'Скрыть' }).click();
  await expect(trigger.locator('.xk-notification-trigger__count')).toHaveText('0');
});

test('panel note lists the modules it changes with their own versions', async ({ page }) => {
  await mockLifecycle(page);
  const panel = {
    ...record('e'.repeat(64), 'panel-update', 'Доступна новая версия панели',
      'Обновление панели проверит совместимость и сохранит выбранный профиль. Вместе с ней обновятся модули:'),
    version: '3.0.3-beta.22',
    dependency_changes: {},
    module_changes: [
      { module_id: 'engine.mihomo', name: 'Mihomo', from: '1.0.2', to: '1.0.3' },
      { module_id: 'integration.happ', name: '<b>Расшифровка подписок</b>', from: '1.0.0', to: '1.0.1' },
    ],
  };
  await page.route('**/api/notifications**', (route) => route.fulfill({ json: {
    ok: true, channel: 'prerelease', records: [panel], unread_count: 1,
    status: { last_success_at: 1_791_700_000, freshness: 'fresh' },
  } }));

  await page.goto('/modules');
  await page.locator('.xk-notification-trigger').click();
  const card = page.locator('.xk-notification-record');
  await expect(card).toHaveCount(1);
  const items = card.locator('.xk-notification-modules li');
  await expect(items).toHaveText(['Mihomo: 1.0.2 → 1.0.3', '<b>Расшифровка подписок</b>: 1.0.0 → 1.0.1']);
  await expect(card.locator('b')).toHaveCount(0);
  // The list sits between the message and the version line.
  const order = await card.evaluate((node) => [...node.children].map((child) => child.tagName));
  expect(order.slice(0, 4)).toEqual(['STRONG', 'P', 'UL', 'SMALL']);
});

// Where the bell lives: always in sight, never inside a menu or past the
// screen edge, and its window is drawn above the page rather than in the header.
function mockCenter(page) {
  const records = [
    record('c'.repeat(64), 'panel-update', 'Доступна новая версия панели', 'Сохранит выбранный профиль.'),
    record('d'.repeat(64), 'module-new', 'Новый модуль: Терминал', 'Появится после обновления панели.'),
  ];
  return page.route('**/api/notifications**', (route) => route.fulfill({ json: {
    ok: true, channel: 'prerelease', records, unread_count: 2,
    status: { last_success_at: 1_791_700_000, freshness: 'fresh' },
  } }));
}

async function expectInsideViewport(page, locator) {
  const box = await locator.boundingBox();
  const width = await page.evaluate(() => document.documentElement.clientWidth);
  expect(box, 'element is rendered').not.toBeNull();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(width);
}

async function expectOnTop(locator) {
  // The middle of the element is the element itself, not something drawn over it.
  const onTop = await locator.evaluate((node) => {
    const r = node.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 60));
    return Boolean(hit && node.contains(hit));
  });
  expect(onTop).toBe(true);
}

for (const width of [1440, 390]) {
  test(`main panel shows the bell next to the gear at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await mockLifecycle(page);
    await mockCenter(page);
    await page.goto('/');

    const trigger = page.locator('.xk-notification-trigger');
    await expect(trigger).toBeVisible();
    await expect(trigger.locator('.xk-notification-trigger__count')).toHaveText('2');
    await expect(trigger.locator('use')).toHaveAttribute('href', /#xk-bell$/);
    // It sits in the header row itself, right before the gear.
    const gearWrap = page.locator('.xk-header-panel-trigger').locator('xpath=..');
    expect(await trigger.evaluate((node, gear) => {
      const root = node.closest('.xk-notification-center');
      return root.nextElementSibling === gear;
    }, await gearWrap.elementHandle())).toBe(true);
    // The two icons read as one pair: the row's wide gap between the
    // resource monitor and the buttons does not part them.
    const gearBox = await page.locator('.xk-header-panel-trigger').boundingBox();
    const pairBox = await trigger.boundingBox();
    expect(Math.abs(gearBox.y - pairBox.y)).toBeLessThan(2);
    expect(gearBox.x - (pairBox.x + pairBox.width)).toBeLessThanOrEqual(8);
    await expectInsideViewport(page, trigger);
    await expect(page.locator('.xk-header-panel-trigger [data-xk-modules-update-dot]')).toHaveCount(0);

    await trigger.click();
    const popover = page.locator('.xk-notification-popover');
    await expect(popover).toBeVisible();
    await expectInsideViewport(page, popover);
    await expectOnTop(popover);
    expect(await popover.evaluate((node) => Boolean(node.closest('header')))).toBe(false);
    // Opens below the bell, never on top of it.
    const bellBox = await trigger.boundingBox();
    const popBox = await popover.boundingBox();
    expect(popBox.y).toBeGreaterThanOrEqual(bellBox.y + bellBox.height);
  });
}

test('gear menu of the main panel is visible on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await mockLifecycle(page);
  await mockCenter(page);
  await page.goto('/');
  await page.locator('.xk-header-panel-trigger').click();
  const menu = page.locator('#xk-mihomo-panel-menu');
  await expect(menu).toBeVisible();
  await expectInsideViewport(page, menu);
  await expectOnTop(menu.getByRole('link', { name: 'Модули и обновления' }));
});

for (const path of ['/modules', '/devtools', '/mihomo_generator']) {
  test(`bell stays on screen at 390px on ${path}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await mockLifecycle(page);
    await mockCenter(page);
    await page.goto(path);
    const trigger = page.locator('.xk-notification-trigger');
    await expect(trigger).toBeVisible();
    await expectInsideViewport(page, trigger);
    // On a phone the bell shares the line with the page title.
    const sameLine = await trigger.evaluate((node) => {
      const h1 = document.querySelector('h1');
      const a = node.getBoundingClientRect();
      const b = h1.getBoundingClientRect();
      return a.top < b.bottom && b.top < a.bottom;
    });
    expect(sameLine).toBe(true);
    await trigger.click();
    await expectInsideViewport(page, page.locator('.xk-notification-popover'));
  });

  test(`bell leads the header buttons at 1440px on ${path}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 800 });
    await mockLifecycle(page);
    await mockCenter(page);
    await page.goto(path);
    const first = await page.locator('.header-actions').first().evaluate((node) => {
      const visible = [...node.children].filter((child) => child.getBoundingClientRect().width > 0);
      return visible[0]?.classList.contains('xk-notification-center') || false;
    });
    expect(first).toBe(true);
  });
}

test('notification window stays readable above DevTools in the light theme', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 1440, height: 800 });
  await mockLifecycle(page);
  await mockCenter(page);
  await page.goto('/devtools');
  await page.locator('.xk-notification-trigger').click();
  const popover = page.locator('.xk-notification-popover');
  await expect(popover).toBeVisible();
  for (const record of await popover.locator('.xk-notification-record').all()) await expectOnTop(record);
  const size = await popover.locator('.xk-notification-record p').first().evaluate((node) => getComputedStyle(node).fontSize);
  expect(size).toBe('12px');
});

test('the router announcing the screen it booted on leaves an opened window open', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 800 });
  await mockLifecycle(page);
  await mockCenter(page);
  await page.goto('/devtools');
  const popover = page.locator('.xk-notification-popover');
  await page.locator('.xk-notification-trigger').click();
  await expect(popover).toBeVisible();

  // A slow router may announce the first screen after the owner has clicked.
  const announce = (initial) => page.evaluate((value) => {
    window.dispatchEvent(new CustomEvent('xkeen:top-level-route-change', { detail: { screen: 'devtools', initial: value } }));
  }, initial);
  await announce(true);
  await expect(popover).toBeVisible();

  // A real switch of screens still closes it.
  await announce(false);
  await expect(popover).toBeHidden();
});

test('bell follows the screens without a page reload', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 800 });
  await mockLifecycle(page);
  await mockCenter(page);
  await page.goto('/');
  const trigger = page.locator('.xk-notification-trigger:visible');
  await expect(trigger).toHaveCount(1);

  await page.locator('.xk-header-panel-trigger').click();
  await page.locator('#xk-mihomo-panel-menu').getByRole('link', { name: 'Модули и обновления' }).click();
  await expect(page.locator('#xk-modules-manager .modules-summary')).toBeVisible();
  await expect(trigger).toHaveCount(1);
  await expectInsideViewport(page, trigger);
  await trigger.click();
  await expect(page.locator('.xk-notification-popover:visible')).toHaveCount(1);
  await page.keyboard.press('Escape');

  await page.getByRole('link', { name: 'Назад' }).click();
  await expect(page.locator('.xk-header-panel-trigger')).toBeVisible();
  await expect(trigger).toHaveCount(1);
  expect(await trigger.evaluate((node) => node.closest('.xk-notification-center').nextElementSibling
    ?.contains(document.querySelector('.xk-header-panel-trigger')))).toBe(true);
});

test('closing the window by a click elsewhere leaves focus where the user clicked', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 800 });
  await mockLifecycle(page);
  await mockCenter(page);
  await page.goto('/devtools');
  const trigger = page.locator('.xk-notification-trigger');
  await trigger.click();
  await expect(page.locator('.xk-notification-popover')).toBeVisible();
  const field = page.locator('input[type="text"]:visible, input[type="search"]:visible, input:not([type]):visible').first();
  await field.click();
  await expect(page.locator('.xk-notification-popover')).toBeHidden();
  await expect(field).toBeFocused();

  // Escape is a keyboard exit: focus returns to the bell.
  await trigger.click();
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
});

test('a tab brought back to the screen rereads the notifications', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 800 });
  await mockLifecycle(page);
  let unread = 0;
  await page.route('**/api/notifications**', (route) => route.fulfill({ json: {
    ok: true, channel: 'stable', unread_count: unread, status: { last_success_at: 1_791_700_000, freshness: 'fresh' },
    records: unread ? [record('e'.repeat(64), 'panel-update', 'Доступна новая версия панели', 'Сохранит профиль.')] : [],
  } }));
  await page.goto('/devtools');
  const count = page.locator('.xk-notification-trigger__count');
  await expect(count).toBeHidden();

  unread = 1; // the background poll found a release while the tab was hidden
  await page.evaluate(() => {
    const flip = (state) => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
      document.dispatchEvent(new Event('visibilitychange'));
    };
    flip('hidden');
    flip('visible');
  });
  await expect(count).toHaveText('1');
});


test('a release notification leads to the update screen without a reload', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 800 });
  await mockLifecycle(page);
  await mockCenter(page);
  await page.goto('/');
  await page.evaluate(() => { window.__sameDocument = true; });
  await page.locator('.xk-notification-trigger:visible').click();
  const popover = page.locator('.xk-notification-popover');
  const panelRecord = popover.locator('.xk-notification-record').filter({ hasText: 'Доступна новая версия панели' });
  // A new module arrives with the panel update: its note leads there too.
  await expect(popover.locator('.xk-notification-record').filter({ hasText: 'Новый модуль' })
    .getByRole('link', { name: 'К обновлению' })).toHaveAttribute('href', '/modules');
  await panelRecord.getByRole('link', { name: 'К обновлению' }).click();
  await expect(page.locator('#xk-modules-manager .modules-summary')).toBeVisible();
  await expect(popover).toBeHidden();
  expect(await page.evaluate(() => window.__sameDocument)).toBe(true);
});

for (const width of [1440, 390]) {
  test(`record buttons share the row in equal parts at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await mockLifecycle(page);
    await page.route('**/api/notifications**', (route) => route.fulfill({ json: {
      ok: true, channel: 'stable', unread_count: 2, status: { error_code: 'catalog_unavailable' },
      records: [
        record('f'.repeat(64), 'panel-update', 'Доступна новая версия панели', 'Сохранит профиль.'),
        { id: '0'.repeat(64), kind: 'catalog-error', title: 'Проверка обновлений требует внимания', message: 'Нет связи.', seen: false },
      ],
    } }));
    await page.goto('/devtools');
    await page.locator('.xk-notification-trigger').click();
    for (const row of await page.locator('.xk-notification-record__actions').all()) {
      const geometry = await row.evaluate((node) => {
        const box = node.getBoundingClientRect();
        const items = [...node.children].map((child) => child.getBoundingClientRect());
        return { left: box.left, right: box.right, items: items.map((r) => ({ left: r.left, right: r.right, width: r.width, height: r.height })) };
      });
      const widths = geometry.items.map((item) => item.width);
      expect(Math.max(...widths) - Math.min(...widths), JSON.stringify(widths)).toBeLessThanOrEqual(1);
      expect(Math.abs(geometry.items[0].left - geometry.left)).toBeLessThanOrEqual(1);
      expect(Math.abs(geometry.items.at(-1).right - geometry.right)).toBeLessThanOrEqual(1);
      const heights = geometry.items.map((item) => item.height);
      expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(1);
      // Labels fit on one line: a wrapped label makes the row twice as tall.
      expect(Math.max(...heights)).toBeLessThanOrEqual(width > 600 ? 32 : 44);
    }
  });
}

test('a failed check still tells when the catalog last answered', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 800 });
  await mockLifecycle(page);
  await page.route('**/api/notifications**', (route) => route.fulfill({ json: {
    ok: true, channel: 'stable', records: [], unread_count: 0,
    status: { error_code: 'catalog_unavailable', last_success_at: 1_791_700_000, freshness: null },
  } }));
  await page.goto('/modules');
  await page.locator('.xk-notification-trigger:visible').click();
  const status = page.locator('.xk-notification-popover .xk-notification-status');
  await expect(status).toContainText('Проверка не выполнена · последняя удачная');
  await expect(status).toHaveClass(/is-error/);
});

test('when the panel does not answer, the center offers a retry instead of actions on a missing note', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 800 });
  await mockLifecycle(page);
  let answer = 'fail';
  await page.route('**/api/notifications**', (route) => (answer === 'fail'
    ? route.fulfill({ status: 500, json: { ok: false, error: 'internal' } })
    : route.fulfill({ json: { ok: true, channel: 'stable', records: [], unread_count: 0, status: { last_success_at: 1_791_700_000, freshness: 'fresh' } } })));
  await page.goto('/modules');
  await page.locator('.xk-notification-trigger:visible').click();
  const card = page.locator('.xk-notification-popover .xk-notification-record').filter({ hasText: 'Центр уведомлений недоступен' });
  await expect(card).toBeVisible();
  await expect(card.getByRole('button', { name: 'Скрыть' })).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'На день' })).toHaveCount(0);

  answer = 'ok';
  await card.getByRole('button', { name: 'Повторить' }).click();
  await expect(page.locator('.xk-notification-popover')).toContainText('Новых уведомлений нет.');
});

test('a snoozed note comes back in an open tab when its day is over', async ({ page }) => {
  await page.clock.install();
  await page.setViewportSize({ width: 1440, height: 800 });
  await mockLifecycle(page);
  const note = record('e'.repeat(64), 'panel-update', 'Доступна новая версия панели', 'Сохранит выбранный профиль.');
  let snoozed = true;
  await page.route('**/api/notifications**', (route) => route.fulfill({ json: snoozed
    ? { ok: true, channel: 'prerelease', records: [], unread_count: 0, status: { last_success_at: 1_791_700_000, freshness: 'fresh', snooze_wake_in_s: 60 } }
    : { ok: true, channel: 'prerelease', records: [note], unread_count: 1, status: { last_success_at: 1_791_700_000, freshness: 'fresh', snooze_wake_in_s: null } } }));
  await page.goto('/modules');
  const count = page.locator('.xk-notification-trigger:visible .xk-notification-trigger__count');
  await expect(count).toBeHidden();

  snoozed = false;
  await page.clock.fastForward(61_000);
  await expect(count).toHaveText('1');
});

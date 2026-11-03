import { test, expect } from './fixtures.mjs';

// DevTools -> Logs: the panel's own logs as a table (23.10.2026).
// Lines are from router 45.1; the server is mocked, so the test owns them.

const DNS = (ts) => `${ts} [INFO] DNS-over-VLESS: правило устройств восстановлено — оно снова стоит первым, а было на месте 2. | event=dns_over_vless.capture_restored, repairs=jump, jump_was=2, macs=8\n`;
const CORE = [
  '2026-10-23 10:40:38,000 [INFO] xkeen-ui init | pid=13695, ui_state_dir=/opt/etc/xkeen-ui, ws_runtime=False\n',
  DNS('2026-10-23 14:30:30,000'),
  DNS('2026-10-23 14:31:30,000'),
  DNS('2026-10-23 14:32:30,000'),
  '2026-10-23 14:40:00,000 [WARNING] memory guard reclaimed runtime memory | mode=auto, rss_before=59117568, rss_after=48656384\n',
  '2026-10-23 15:00:00,000 [INFO] xray subscriptions auto-refresh | total=7, ok=7, restarted=True\n',
];
// module-operations/history.jsonl (пример): an update and a module that did not install.
const STEPS = ['prepared', 'downloading', 'verifying', 'applying', 'state', 'restarting', 'health', 'committed'];
const UPDATES = [
  {
    operation_id: '20261025T150210Z-4b81c2', scope: 'module', operation: 'install', module_id: 'tool.terminal',
    module_name: 'Терминал и команды', version: '3.0.3-beta.6', result: 'rolled_back',
    error: 'архив модуля не прошёл проверку', started_at: 1792940530, finished_at: 1792940536,
    log: [{ step: 'prepared', at: 1792940530 }, { step: 'downloading', at: 1792940531 }], channel: 'prerelease',
  },
  {
    operation_id: '20261026T122903Z-e1d4a5', scope: 'panel', operation: 'panel-update', version: '3.0.3-beta.6',
    source_version: '3.0.3-beta.5', result: 'committed', started_at: 1793017743, finished_at: 1793017762,
    log: STEPS.map((step, index) => ({ step, at: 1793017744 + index })), channel: 'prerelease',
    environment: ['=== prepare ===', '[ok] opkg update', '[ok] curl уже стоит'],
  },
].map((entry) => `${JSON.stringify(entry)}\n`);

async function openLogs(page, { files, live = false, extra = [] } = {}) {
  const now = Date.now() / 1000;
  const data = Object.assign({ core: CORE, updates: UPDATES, stdout: [], stderr: [] }, files || {});
  const list = Object.keys(data).map((name) => ({
    name, exists: true, size: data[name].join('').length, mtime: now - 60, path: `/opt/var/log/xkeen-ui/${name}.log`,
  })).concat(extra);
  const state = { data, appended: [], requests: [] };
  await page.addInitScript((on) => {
    localStorage.setItem('xkeen-theme', 'dark');
    localStorage.removeItem('xkeen.devtools.logs.file');
    localStorage.setItem('xkeen.devtools.logs.live.touched', '1');
    localStorage.setItem('xkeen.devtools.logs.live', on ? '1' : '0');
    localStorage.setItem('xkeen.devtools.logs.interval', '1000');
  }, live);
  await page.route('**/api/capabilities', (r) => r.fulfill({ json: { websocket: false } }));
  await page.route('**/api/devtools/logs', (r) => r.fulfill({ json: { ok: true, logs: list } }));
  await page.route(/\/api\/devtools\/logs\/[^/?]+\?/, (r) => {
    const url = new URL(r.request().url());
    const name = decodeURIComponent(url.pathname.split('/').pop());
    const cursor = url.searchParams.get('cursor');
    state.requests.push({ name, cursor });
    const meta = list.find((f) => f.name === name) || {};
    const lines = cursor ? state.appended.splice(0) : (state.data[name] || []);
    r.fulfill({ json: { ok: true, name, path: meta.path, lines, cursor: 'c1', mode: cursor ? 'append' : 'full', exists: true, size: meta.size, mtime: meta.mtime } });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/devtools');
  await expect(page.locator('body')).toHaveClass(/\bdevtools-page\b/);
  // The tab buttons are wired once the deferred screen bootstrap has run.
  await expect(async () => {
    await page.locator('#dt-tab-btn-logs').click();
    await expect(page.locator('#dt-tab-logs')).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 15000 });
  return state;
}

const rows = (page) => page.locator('#dt-log-view .tr:not([hidden])');

test.describe('DevTools logs', () => {
  test('files with content are a segment, empty ones wait in the menu', async ({ page }) => {
    await openLogs(page);
    await expect(page.locator('#dt-log-files [data-log-name]')).toHaveText([/^Панель/, /^Обновления/]);
    await expect(page.locator('#dt-log-files [data-log-name="core"]')).toHaveAttribute('aria-checked', 'true');
    await page.locator('#dt-log-more > summary').click();
    await expect(page.locator('#dt-log-empty-list [data-log-name]')).toHaveCount(2);
  });

  test('a core.log line reads as time, level, source and event; repeats fold', async ({ page }) => {
    await openLogs(page);
    await expect(rows(page)).toHaveCount(4);
    const dns = rows(page).filter({ hasText: 'правило устройств восстановлено' });
    await expect(dns.locator('.src')).toHaveText('DNS-over-VLESS');
    // The source column says it already: the event does not repeat it.
    await expect(dns.locator('.msg')).not.toContainText('DNS-over-VLESS:');
    await expect(dns.locator('.rep')).toContainText('×3');
    await expect(dns.locator('.ts')).toHaveText('14:32:30');

    await dns.click();
    const detail = page.locator('#dt-log-view .detail');
    await expect(detail).toContainText('Повторилось 3 раз');
    await expect(detail.locator('dt')).toContainText(['event', 'repairs', 'jump_was', 'macs']);

    await page.locator('#dt-log-fold').evaluate((el) => { el.checked = false; el.dispatchEvent(new Event('change')); });
    await expect(rows(page)).toHaveCount(6);
  });

  test('chips, level and search narrow the table', async ({ page }) => {
    await openLogs(page);
    await expect(rows(page)).toHaveCount(4);
    await page.locator('#dt-log-chips [data-plog-source="DNS-over-VLESS"]').click();
    await expect(rows(page)).toHaveCount(3);
    await expect(page.locator('#dt-log-chips [data-plog-source="DNS-over-VLESS"]')).toHaveClass(/is-off/);
    await page.locator('#dt-log-chips [data-plog-source-reset]').click();
    await expect(rows(page)).toHaveCount(4);

    await expect(page.locator('#dt-log-level-seg [data-level="warning"] .n')).toHaveText('1');
    await page.locator('#dt-log-level-seg [data-level="warning"]').click();
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first().locator('.src')).toHaveText('Память');
    await page.locator('#dt-log-level-seg [data-level="all"]').click();

    await page.locator('#dt-log-search').fill('restarted=true');
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first().locator('.src')).toHaveText('Подписки');
    await expect(page.locator('#dt-log-stats')).toContainText('Показано: 1');
  });

  test('обновления: одна строка на операцию, вывод подготовки свёрнут', async ({ page }) => {
    await openLogs(page);
    await page.locator('#dt-log-files [data-log-name="updates"]').click();
    await expect(rows(page)).toHaveCount(2);
    await expect(page.locator('#dt-log-level-seg')).toBeHidden();
    const failed = rows(page).first();
    await expect(failed).toHaveClass(/k-error/);
    await expect(failed.locator('.src')).toHaveText('Установка модуля');
    await expect(failed.locator('.msg')).toContainText('Не выполнено: архив модуля не прошёл проверку');
    const run = rows(page).nth(1);
    await expect(run.locator('.src')).toHaveText('Обновление панели');
    await expect(run.locator('.msg')).toContainText('Панель обновлена до 3.0.3-beta.6');
    await expect(run.locator('.rep')).toHaveText('19 с');
    await run.click();
    const detail = page.locator('#dt-log-view .detail');
    await expect(detail).toContainText('3.0.3-beta.5 → 3.0.3-beta.6');
    await expect(detail).toContainText('предрелизный');
    await expect(detail).toContainText('Проверка панели после перезапуска');
    await expect(detail.locator('summary')).toHaveText('Вывод подготовки окружения · 3 строк');
    await expect(detail.locator('pre')).toBeHidden();
  });

  test('кнопки файлов подписаны по-русски, ранние части — в меню', async ({ page }) => {
    const old = Date.UTC(2026, 9, 20, 9, 0, 0) / 1000;
    await openLogs(page, {
      files: { restart: ['2026-10-26 15:29:20 | src=panel-update | OK | ver=3.0.3-beta.6\n'], install: ['[*] Установка\n'] },
      extra: [
        { name: 'core.1', exists: true, size: 2097152, mtime: old, path: '/opt/var/log/xkeen-ui/core.log.1' },
        { name: 'install-previous', exists: true, size: 3518, mtime: old, path: '/opt/var/log/xkeen-ui-install.log.previous' },
      ],
    });
    await expect(page.locator('#dt-log-files [data-log-name]')).toHaveText([/^Панель/, /^Обновления/, /^Xkeen/, /^Установка/]);
    await expect(page.locator('#dt-log-files [data-log-name="core.1"]')).toHaveCount(0);
    await page.locator('#dt-log-more > summary').click();
    await expect(page.locator('#dt-log-older-list [data-log-name="core.1"]')).toContainText('Панель, до 20 окт.');
    await expect(page.locator('#dt-log-older-list [data-log-name="install-previous"]')).toContainText('Предыдущая установка, 20 окт.');
    await page.locator('#dt-log-older-list [data-log-name="core.1"]').click();
    await expect(page.locator('#dt-log-download-name')).toHaveText('core.log.1');
  });

  test('online appends new lines; pause holds them until resumed', async ({ page }) => {
    const state = await openLogs(page, { live: true });
    await expect(page.locator('#dt-log-lamp')).toHaveAttribute('data-state', 'on');
    await expect(rows(page)).toHaveCount(4);

    state.appended.push('2026-10-23 15:10:00,000 [ERROR] xkeen.cmd_failed | cmd=xkeen -restart, rc=1\n');
    await expect(rows(page)).toHaveCount(5);
    await expect(rows(page).last().locator('.lvl')).toHaveText('ERROR');

    await page.locator('#dt-log-pause').click();
    await expect(page.locator('#dt-log-lamp')).toHaveAttribute('data-state', 'armed');
    state.appended.push('2026-10-23 15:11:00,000 [INFO] xkeen.start | source=api\n');
    await expect(page.locator('#dt-log-play .xk-xlog-badge')).toHaveText('+1');
    await expect(rows(page)).toHaveCount(5);

    await page.locator('#dt-log-play').click();
    await expect(rows(page)).toHaveCount(6);
    await page.locator('#dt-log-stop').click();
    await expect(page.locator('#dt-log-lamp')).toHaveAttribute('data-state', 'off');
    const before = state.requests.length;
    await page.waitForTimeout(1500);
    expect(state.requests.length).toBe(before);
  });
});

// 03.11.2026: the order of the table, the way back to the new rows, the
// installer's runs and the plain output without empty columns.
test.describe('DevTools logs: order and the new rows', () => {
  const twoDays = [
    '2026-10-22 23:50:00,000 [INFO] xkeen-ui init | pid=1, ui_state_dir=/opt/etc/xkeen-ui\n',
    ...CORE,
  ];
  const times = (page) => page.locator('#dt-log-view .tr:not([hidden]), #dt-log-view .day:not([hidden])').evaluateAll((nodes) => nodes
    .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
    .map((node) => (node.matches('.day') ? `day ${node.textContent.trim()}` : node.querySelector('.ts').textContent.trim())));

  test('the order button puts the newest first and is remembered', async ({ page }) => {
    await openLogs(page, { files: { core: twoDays } });
    const order = page.locator('#dt-log-order');
    await expect(order).toHaveAttribute('aria-pressed', 'false');
    await expect(rows(page)).toHaveCount(5);
    expect(await times(page)).toEqual(['day 22 октября', '23:50:00', 'day 23 октября', '10:40:38', '14:32:30', '14:40:00', '15:00:00']);

    await order.click();
    await expect(order).toHaveAttribute('aria-pressed', 'true');
    await expect(order).toHaveAttribute('aria-label', 'Порядок: новые сверху');
    // Repeats fold before the order turns: «×3 с 14:30:30» stays right.
    expect(await times(page)).toEqual(['day 23 октября', '15:00:00', '14:40:00', '14:32:30', '10:40:38', 'day 22 октября', '23:50:00']);
    await expect(rows(page).filter({ hasText: 'правило устройств' }).locator('.rep')).toContainText('с 14:30:30');

    await page.reload();
    await expect(async () => {
      await page.locator('#dt-log-tab-btn-logs, #dt-tab-btn-logs').first().click();
      await expect(page.locator('#dt-tab-logs')).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 15000 });
    await expect(page.locator('#dt-log-order')).toHaveAttribute('aria-pressed', 'true');
    await expect(rows(page)).toHaveCount(5);
    expect((await times(page))[1]).toBe('15:00:00');
  });

  test('the menu has no «Следить за концом»: away from the new rows a button leads back', async ({ page }) => {
    const many = Array.from({ length: 80 }, (_, i) => `2026-10-23 12:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')},000 [INFO] xray subscriptions auto-refresh | total=${i}, ok=${i}, restarted=False\n`);
    const state = await openLogs(page, { files: { core: many }, live: true });
    await expect(page.locator('#dt-log-follow')).toHaveCount(0);
    await expect(page.locator('#dt-log-more')).not.toContainText('Следить за концом');
    const host = page.locator('#dt-log-view');
    const back = page.locator('#dt-log-view .tonew');
    await expect(rows(page).first()).toBeVisible();
    // At the end the table follows the new rows by itself.
    await expect.poll(() => host.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThan(60);
    await expect(back).toBeHidden();
    state.appended.push('2026-10-23 13:00:00,000 [WARNING] memory guard reclaimed runtime memory | mode=auto\n');
    await expect(rows(page).filter({ hasText: 'memory guard' })).toBeVisible();

    // Away from them, it stays put and counts what came.
    await host.evaluate((el) => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); });
    await expect(back).toBeVisible();
    await expect(back).toHaveText('↓ К новым');
    state.appended.push('2026-10-23 13:01:00,000 [INFO] xkeen.start | source=api\n');
    await expect(back).toHaveText('↓ К новым · 1');
    expect(await host.evaluate((el) => el.scrollTop)).toBeLessThan(60);
    await back.click();
    await expect.poll(() => host.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThan(60);
    await expect(back).toBeHidden();

    // Newest first: the new rows are on top, and so is the way back.
    await page.locator('#dt-log-order').click();
    await expect.poll(() => host.evaluate((el) => el.scrollTop)).toBeLessThan(60);
    await host.evaluate((el) => { el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event('scroll')); });
    await expect(back).toHaveText('↑ К новым');
  });

  test('the install log is one row per run, its lines open under it', async ({ page }) => {
    const install = [
      '===== Xkeen UI install: 2026-10-31 01:42:14 =====\n',
      '========================================\n',
      '  Xkeen Web UI — установка\n',
      '========================================\n',
      '[*] Python-зависимости в порядке.\n',
      '[*] Запускаю сервис...\n',
      '2026-10-31 01:43:03 [=] Итог установки:\n',
      '2026-10-31 01:43:03 [=] Подробности установки: /opt/var/log/xkeen-ui-install.log\n',
    ];
    await openLogs(page, { files: { install } });
    await page.locator('#dt-log-files [data-log-name="install"]').click();
    await expect(rows(page)).toHaveCount(1);
    const run = rows(page).first();
    await expect(run.locator('.ts')).toHaveText('01:42:14');
    await expect(run.locator('.src')).toHaveText('Установка панели');
    await expect(run.locator('.msg')).toHaveText('Установка завершена за 49 с');
    await run.click();
    const detail = page.locator('#dt-log-view .detail');
    await expect(detail.locator('pre')).toHaveCount(1);
    await expect(detail.locator('pre')).toContainText('[*] Запускаю сервис...');
    await expect(detail.locator('pre')).not.toContainText('Xkeen Web UI — установка');
  });

  test('on a phone the «⋯» menu opens on the screen', async ({ page }) => {
    await openLogs(page);
    await page.setViewportSize({ width: 390, height: 900 });
    await page.locator('#dt-log-more summary').click();
    const [left, right, width] = await page.locator('#dt-log-more .xk-xlog-menu-panel').evaluate((el) => {
      const r = el.getBoundingClientRect();
      return [r.left, r.right, innerWidth];
    });
    expect(left).toBeGreaterThanOrEqual(0);
    expect(right).toBeLessThanOrEqual(width);
  });

  test('a file whose lines have no time and no source hides those columns', async ({ page }) => {
    await openLogs(page, { files: { stdout: [" * Serving Flask app 'app_factory'\n", ' * Debug mode: off\n'] } });
    await page.locator('#dt-log-files [data-log-name="stdout"]').click();
    // The second line is indented: it belongs to the first.
    await expect(rows(page)).toHaveCount(1);
    const head = page.locator('#dt-log-view .thead');
    await expect(head.getByText('Время', { exact: true })).toBeHidden();
    await expect(head.getByText('Источник', { exact: true })).toBeHidden();
    await expect(head.getByText('Событие', { exact: true })).toBeVisible();
    // The event takes the room: it starts right after the level.
    const [lvl, msg] = await rows(page).first().evaluate((row) => [row.querySelector('.lvl').getBoundingClientRect().right, row.querySelector('.msg').getBoundingClientRect().left]);
    expect(msg - lvl).toBeLessThan(40);
    // core.log keeps every column.
    await page.locator('#dt-log-files [data-log-name="core"]').click();
    await expect(head.getByText('Время', { exact: true })).toBeVisible();
  });
});

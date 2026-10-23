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
const UPDATE = [
  '[2026-10-02T11:44:40Z] === Xkeen-UI updater start ===\n',
  '[2026-10-02T11:44:40Z] repo=umarcheh001/Xkeen-UI channel=stable action=update\n',
  '[2026-10-02T11:44:47Z] [*] Latest tag: v2.9.1b\n',
  '  01/05  Проверка окружения\n',
  '[2026-10-02T11:45:15Z] === Xkeen-UI updater done ===\n',
];

async function openLogs(page, { files, live = false } = {}) {
  const now = Date.now() / 1000;
  const data = Object.assign({ core: CORE, update: UPDATE, stdout: [], stderr: [] }, files || {});
  const list = Object.keys(data).map((name) => ({
    name, exists: true, size: data[name].join('').length, mtime: now - 60, path: `/opt/var/log/xkeen-ui/${name}.log`,
  }));
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
    await expect(page.locator('#dt-log-files [data-log-name]')).toHaveText([/^core/, /^update/]);
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

  test('update.log is one row per run, with the installer output folded', async ({ page }) => {
    await openLogs(page);
    await page.locator('#dt-log-files [data-log-name="update"]').click();
    await expect(rows(page)).toHaveCount(1);
    await expect(page.locator('#dt-log-level-seg')).toBeHidden();
    const run = rows(page).first();
    await expect(run.locator('.msg')).toContainText('Панель обновлена до v2.9.1b');
    await expect(run.locator('.rep')).toHaveText('35 с');
    await run.click();
    const detail = page.locator('#dt-log-view .detail');
    await expect(detail.locator('summary')).toHaveText('Вывод установщика · 1 строк');
    await expect(detail.locator('pre')).toBeHidden();
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

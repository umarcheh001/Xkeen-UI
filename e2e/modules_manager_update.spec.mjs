import { test, expect } from './fixtures.mjs';
import { server, installLifecycleRoutes, routePlans } from './modules_manager_support.mjs';

// The Modules window: a module updated on its own, inside the installed release.
// Mihomo 1.0.0 is installed, its update entry is 1.0.1 (answers of the service).

const MIHOMO = 'engine.mihomo';
const steps = server.module_update_steps;
const tileOf = (page, id) => page.locator(`.modules-module[data-module-id="${id}"]`);

async function routeUpdateCheck(page, answer) {
  await page.route('**/api/modules/panel/update-check', (route) => route.fulfill({
    json: typeof answer === 'function' ? answer() : answer,
  }));
}

test.describe('Module update', () => {
  test('a module with an update shows both versions and the button «Обновить»', async ({ page }) => {
    await installLifecycleRoutes(page, { available: server.available_update });
    await routeUpdateCheck(page, server.update_check_modules);

    await page.goto('/modules');
    const tile = tileOf(page, MIHOMO);
    await expect(tile.locator('.modules-tile-version')).toHaveText('версия 1.0.0 → 1.0.1');
    await expect(tile.locator('.modules-tile-foot')).toContainText('Доступна версия 1.0.1');
    const button = tile.getByRole('button', { name: 'Обновить «Mihomo» до 1.0.1' });
    await expect(button).toBeVisible();
    await expect(button).toHaveText('Обновить');
    // Only the module that has an update offers one.
    await expect(page.locator('.modules-tile-update .modules-action-update')).toHaveCount(1);
    await expect(tileOf(page, 'tool.editor').locator('.modules-tile-version')).toHaveText('версия 1.0.0');

    const counter = page.locator('.xk-summary-stat[data-stat="update"]');
    await expect(counter.locator('b')).toHaveText('1');
    await expect(counter.locator('span')).toHaveText('модуль можно обновить');
    await expect(page.locator('.modules-summary')).toContainText('Есть обновления модулей: Mihomo 1.0.1.');
  });

  test('the update goes on in the window of the operation and ends in success', async ({ page }) => {
    let status = server.status_none;
    const downloading = (done) => ({ ...steps.downloading, downloaded_bytes: done, total_bytes: 4_000_000 });
    await installLifecycleRoutes(page, { available: server.available_update });
    await page.route('**/api/modules/installed', (route) => route.fulfill({
      json: status.result === 'committed' ? server.installed_after_update : server.installed,
    }));
    await page.route('**/api/modules/operations/status', (route) => route.fulfill({ json: status }));
    await routeUpdateCheck(page, () => (status.result === 'committed' ? server.update_check_after_update : server.update_check_modules));
    const plans = [];
    await routePlans(page, (body) => {
      plans.push(body);
      return { json: server.module_update_plan };
    });
    await page.route('**/api/modules/operations/apply', (route) => {
      status = steps.prepared;
      return route.fulfill({ status: 202, json: { ok: true, operation_id: status.operation_id, status } });
    });

    await page.goto('/modules');
    await page.evaluate(() => { window.xkBeforeUpdate = true; });
    await tileOf(page, MIHOMO).getByRole('button', { name: 'Обновить «Mihomo» до 1.0.1' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.locator('#modules-plan-title')).toHaveText('Обновить «Mihomo» до 1.0.1');
    await expect(dialog.locator('#modules-plan-description')).toHaveText(
      'Текущие файлы модуля будут сохранены. При ошибке проверки или перезапуска панель вернёт версию 1.0.0.',
    );
    await expect(dialog.locator('.modules-plan-facts')).toContainText('Версия1.0.0 → 1.0.1');
    expect(plans).toEqual([{ operation: 'update', module_id: MIHOMO }]);

    await dialog.getByRole('button', { name: 'Обновить', exact: true }).click();
    await expect(dialog.locator('.modules-plan-progress-head strong')).toHaveText('Подготовка');
    await expect(dialog.getByRole('button', { name: 'Обновление…' })).toBeDisabled();
    await expect(tileOf(page, MIHOMO).locator('.modules-tile-foot')).toContainText('Обновляется до 1.0.1…');
    await expect(page.locator('#modules-operation-status')).toContainText('Обновление модуля «Mihomo» до 1.0.1');

    // The archive comes down: how much, how fast, how long still.
    status = downloading(1_000_000);
    await expect(dialog.locator('.modules-plan-progress-head strong')).toHaveText('Загрузка архива');
    await expect(dialog.locator('.modules-plan-progress-head small')).toContainText('1,0 из 3,8 МБ');
    // A quarter of the archive: the bar stands a quarter into its second step,
    // (1 + 0.25) / 7, not at the half-step a step without bytes shows (21%).
    await expect(dialog.locator('.modules-plan-progress-bar i')).toHaveAttribute('style', 'width: 18%;');
    status = downloading(3_000_000);
    await expect(dialog.locator('.modules-plan-progress-head small')).toContainText('2,9 из 3,8 МБ');
    await expect(dialog.locator('.modules-plan-progress-head small')).toContainText('Мбит/с');
    await expect(dialog.locator('.modules-plan-progress-head small')).toContainText('осталось около');
    // Three quarters: (1 + 0.75) / 7.
    await expect(dialog.locator('.modules-plan-progress-bar i')).toHaveAttribute('style', 'width: 25%;');

    // The runner restarted the panel: the page loads anew and the window says how it ended.
    status = server.module_update_committed;
    await expect.poll(() => page.evaluate(() => window.xkBeforeUpdate === true).catch(() => true), { timeout: 15000 }).toBe(false);
    await expect(page.getByRole('dialog', { name: '«Mihomo» обновлён до 1.0.1' })).toBeVisible();
    await expect(dialog.locator('.modules-plan-progress-head output')).toHaveText('7 из 7');
    await dialog.getByRole('button', { name: 'Готово' }).click();
    await expect(tileOf(page, MIHOMO).locator('.modules-tile-version')).toHaveText('версия 1.0.1');
    await expect(page.locator('.modules-action-update')).toHaveCount(0);
  });

  test('without an update there is no button and the counter is as before', async ({ page }) => {
    await installLifecycleRoutes(page);
    await routeUpdateCheck(page, server.update_check_current);

    await page.goto('/modules');
    await expect(page.locator('.xk-summary-stat[data-stat="update"] span')).toHaveText('версия актуальна');
    await expect(tileOf(page, MIHOMO).locator('.modules-tile-version')).toHaveText('версия 1.0.0');
    await expect(page.locator('.modules-action-update')).toHaveCount(0);
    await expect(page.locator('.modules-tile-update')).toHaveCount(0);
  });

  test('a local build offers no module update', async ({ page }) => {
    const local = {
      ...server.installed,
      panel_version: '2.10.0+local.f46f1f10',
      lifecycle: { ...server.installed.lifecycle, local: true },
    };
    await installLifecycleRoutes(page, { installed: local });
    await routeUpdateCheck(page, server.update_check_modules);

    await page.goto('/modules');
    await expect(page.locator('.modules-summary')).toContainText('Локальная сборка');
    await expect(page.locator('.xk-summary-stat[data-stat="update"] b')).toHaveText('2.10.0');
    await expect(page.locator('.modules-action-update')).toHaveCount(0);
    await expect(tileOf(page, MIHOMO).locator('.modules-tile-version')).toHaveText('версия 1.0.0');
  });

  test('an update catalog that cannot be read does not disturb the screen', async ({ page }) => {
    await installLifecycleRoutes(page, {
      available: { ...server.available, update_stale_reason: 'catalog_transport_failed' },
    });
    await routeUpdateCheck(page, {
      ...server.update_check_current, module_updates: [], module_updates_stale_reason: 'catalog_transport_failed',
    });

    await page.goto('/modules');
    const note = page.locator('.modules-list .modules-update-stale');
    await expect(note).toContainText('Обновления модулей сейчас не проверить.');
    await expect(page.locator('.modules-summary')).toContainText('Обновления модулей не проверены');
    await expect(page.locator('#modules-error')).toBeEmpty();
    await expect(page.locator('.modules-action-update')).toHaveCount(0);
    await expect(tileOf(page, MIHOMO).getByRole('switch')).toBeEnabled();
    await expect(page.locator('.xk-summary-stat[data-stat="update"] span')).toHaveText('версия актуальна');

    await page.getByRole('tab', { name: 'Доступные' }).click();
    await expect(page.locator('#modules-card-host .modules-update-stale')).toContainText('Обновления модулей сейчас не проверить.');
    await expect(page.locator('#modules-card-host .modules-warning')).toHaveCount(0);
    await expect(page.locator('#modules-card-host .modules-card')).toHaveCount(server.available.modules.length);
  });

  test('a catalog that is missing is not called a lost connection', async ({ page }) => {
    await installLifecycleRoutes(page, {
      available: { ...server.available, update_stale_reason: 'catalog_unavailable' },
    });
    await routeUpdateCheck(page, {
      ...server.update_check_current, module_updates: [], module_updates_stale_reason: 'catalog_unavailable',
    });

    await page.goto('/modules');
    const note = page.locator('.modules-list .modules-update-stale');
    await expect(note).toContainText('Обновления модулей сейчас не проверить.');
    // catalog_unavailable is also a release without its catalog (404): the network may be fine.
    await expect(note).not.toContainText('GitHub');
    await expect(note).toContainText('Каталог обновлений сейчас недоступен.');
  });

  test('a local build shows no stale line on the tab of available modules', async ({ page }) => {
    const local = {
      ...server.installed,
      panel_version: '2.10.0+local.f46f1f10',
      lifecycle: { ...server.installed.lifecycle, local: true },
    };
    await installLifecycleRoutes(page, {
      installed: local,
      available: {
        ...server.available, read_only: true, freshness: 'stale', stale_reason: 'catalog_transport_failed', update_stale_reason: null,
      },
    });
    await routeUpdateCheck(page, server.update_check_current);

    await page.goto('/modules');
    await page.getByRole('tab', { name: 'Доступные' }).click();
    await expect(page.locator('#modules-card-host .modules-catalog-readonly')).toBeVisible();
    await expect(page.locator('#modules-card-host .modules-update-stale')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Обновить каталог' })).toHaveCount(0);
  });

  test('the update button of a tile has no shadow at rest, as in the mockup', async ({ page }) => {
    await installLifecycleRoutes(page, { available: server.available_update });
    await routeUpdateCheck(page, server.update_check_modules);

    await page.goto('/modules');
    const button = tileOf(page, MIHOMO).locator('.modules-tile-update .modules-action-update');
    await expect(button).toBeVisible();
    expect(await button.evaluate((element) => getComputedStyle(element).boxShadow)).toBe('none');
  });

  test('the tile menu offers the update first', async ({ page }) => {
    await installLifecycleRoutes(page, { available: server.available_update });
    await routeUpdateCheck(page, server.update_check_modules);
    await routePlans(page, () => ({ json: server.module_update_plan }));

    await page.goto('/modules');
    await tileOf(page, MIHOMO).getByRole('button', { name: 'Обновить «Mihomo» до 1.0.1' }).waitFor();
    await tileOf(page, MIHOMO).locator('.modules-tile-menu-button').click();
    const items = tileOf(page, MIHOMO).locator('.modules-tile-menu-item');
    await expect(items.first()).toHaveText('Обновить до 1.0.1');
    await expect(items).toHaveText(['Обновить до 1.0.1', 'Восстановить файлы модуля', 'Удалить модуль']);
    await items.first().click();
    await expect(page.getByRole('dialog').locator('#modules-plan-title')).toHaveText('Обновить «Mihomo» до 1.0.1');
  });

  test('the tab of available modules offers the update of an installed module', async ({ page }) => {
    await installLifecycleRoutes(page, { available: server.available_update });
    await routeUpdateCheck(page, server.update_check_modules);
    await routePlans(page, () => ({ json: server.module_update_plan }));

    await page.goto('/modules');
    await page.getByRole('tab', { name: 'Доступные' }).click();
    const card = page.locator('#modules-card-host .modules-card').filter({ has: page.locator('h2', { hasText: /^Mihomo/ }) });
    await expect(card.locator('h2')).toContainText('Mihomo 1.0.0 → 1.0.1');
    await expect(card.locator('.modules-chip')).toHaveText('Установлен');
    await expect(card.getByRole('button')).toHaveText(['Обновить до 1.0.1']);
    await expect(card).toContainText('установлена 1.0.0');
    // Installed without an update: nothing to press here, as before.
    await expect(page.locator('#modules-card-host .modules-card').filter({ has: page.locator('h2', { hasText: /^Редакторы/ }) }).getByRole('button')).toHaveCount(0);
    await card.getByRole('button', { name: 'Обновить до 1.0.1' }).click();
    await expect(page.getByRole('dialog').locator('#modules-plan-title')).toHaveText('Обновить «Mihomo» до 1.0.1');
  });

  test('a tile with a lock line puts the update above it, under one divider', async ({ page }) => {
    // The editors are needed while an engine is on: the tile says so in its bottom line.
    const locked = {
      ...server.installed,
      modules: server.installed.modules.map((item) => (item.id === 'tool.editor' ? { ...item, can_disable: false } : item)),
    };
    await installLifecycleRoutes(page, { installed: locked, available: server.available_update });
    await routeUpdateCheck(page, {
      ...server.update_check_modules,
      module_updates: [{ module_id: 'tool.editor', version: '1.0.1', installed_version: '1.0.0' }],
    });

    await page.goto('/modules');
    const tile = tileOf(page, 'tool.editor');
    await expect(tile.locator('.modules-tile-foot')).toHaveCount(1);
    const rows = tile.locator('.modules-tile-foot > *');
    await expect(rows.nth(0)).toContainText('Доступна версия 1.0.1');
    await expect(rows.nth(1)).toContainText('Нужен, пока включено ядро');
  });

  test('the notification center tells of a module update once and leads to the screen', async ({ page }) => {
    await installLifecycleRoutes(page, { available: server.available_update });
    await routeUpdateCheck(page, server.update_check_modules);
    let records = [{
      id: 'e'.repeat(64),
      kind: 'module_update_available',
      channel: 'stable',
      module_id: MIHOMO,
      version: '1.0.1',
      installed_version: '1.0.0',
      title: 'Обновление модуля: Mihomo',
      message: 'Доступна версия 1.0.1, установлена 1.0.0. Обновить можно на странице модулей.',
      requires_restart: true,
      seen: false,
    }];
    const snapshot = () => ({
      ok: true,
      channel: 'stable',
      records,
      unread_count: records.filter((item) => !item.seen).length,
      status: { last_success_at: 1_791_700_000, freshness: 'fresh', stale_reason: null, error_code: null },
    });
    await page.route('**/api/notifications', (route) => route.fulfill({ json: snapshot() }));
    await page.route('**/api/notifications/*', async (route) => {
      records = records.map((item) => ({ ...item, seen: true }));
      await route.fulfill({ json: snapshot() });
    });

    await page.goto('/modules');
    const trigger = page.locator('.xk-notification-trigger');
    await expect(trigger.locator('.xk-notification-trigger__count')).toHaveText('1');
    await trigger.click();
    const center = page.locator('.xk-notification-popover');
    await expect(center.locator('.xk-notification-record')).toHaveCount(1);
    await expect(center).toContainText('Обновление модуля: Mihomo');
    await expect(center.getByRole('link', { name: 'К обновлению' })).toHaveAttribute('href', '/modules');

    // After the update the server has nothing to say about it.
    records = [];
    await page.reload();
    await expect(page.locator('.xk-notification-trigger__count')).toBeHidden();
  });
});

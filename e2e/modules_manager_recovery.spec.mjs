import { test, expect } from './fixtures.mjs';
import {
  server, installedSnapshot, idleStatus, availableSnapshot, installPlan, panelUpdatePlan, runningStatus,
  committedStatus, TERMINAL, withMihomo, installIdleLifecycleRoutes, installLifecycleRoutes, advanceClock,
  interruptedStatus, rollbackFailedStatus, restartStatus,
  routePlans,
} from './modules_manager_support.mjs';

// The Modules window: restarts of the panel, recovery after a failed operation
// and the guards that keep the actions locked meanwhile.

test.describe('Module manager recovery and guards', () => {
  test('shows no operation block while the panel has never run an operation', async ({ page }) => {
    // The server has no "idle" result: without operations it answers null.
    await installLifecycleRoutes(page, { status: { ok: true, result: null } });

    await page.goto('/modules');

    await expect(page.locator('.modules-summary')).toBeVisible();
    await expect(page.locator('#modules-operation-status .modules-operation')).toHaveCount(0);
  });

  test('main panel opens the modules screen from the gear menu, after DevTools', async ({ page }) => {
    await installIdleLifecycleRoutes(page);
    await page.goto('/');

    const gear = page.locator('.xk-header-panel-trigger');
    // The item lives in the gear menu only: the sections menu is for workspaces.
    await expect(page.locator('[data-xk-section="modules"]')).toHaveCount(0);
    await gear.click();
    const menu = page.locator('#xk-mihomo-panel-menu');
    const link = menu.getByRole('link', { name: 'Модули и обновления' });
    await expect(link).toBeVisible();
    await expect(link.locator('[data-xk-modules-update-badge]')).toBeHidden();
    const order = await menu.evaluate((node) => Array.from(node.querySelectorAll('a, button'))
      .filter((item) => item.getBoundingClientRect().width > 0)
      .map((item) => item.textContent.trim()));
    expect(order.indexOf('Модули и обновления'), JSON.stringify(order)).toBe(order.indexOf('DevTools') + 1);
    const box = await link.boundingBox();
    const devtools = await menu.getByRole('link', { name: 'DevTools' }).boundingBox();
    expect(Math.abs(box.width - devtools.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(box.height - devtools.height)).toBeLessThanOrEqual(1);

    await link.click();
    await expect(page.locator('#xk-modules-manager .modules-summary')).toBeVisible();
  });

  test('marks the menu item, not the gear, while an update is known', async ({ page }) => {
    await installIdleLifecycleRoutes(page);
    await page.addInitScript(() => sessionStorage.setItem('xkeen.modules.update.v2', JSON.stringify({
      schema: 2, sourceVersion: '2.10.0', targetVersion: '2.11.0', channel: 'stable',
    })));
    await page.goto('/');

    // The notification bell next to the gear already counts the update.
    const gear = page.locator('.xk-header-panel-trigger');
    await expect(gear.locator('[data-xk-modules-update-dot]')).toHaveCount(0);
    await gear.click();
    const badge = page.locator('#xk-mihomo-panel-menu').getByRole('link', { name: /Модули и обновления/ })
      .locator('[data-xk-modules-update-badge]');
    await expect(badge).toHaveText('Обновление');
    // A pill, not bare text glued to the label.
    expect(await badge.evaluate((node) => Number.parseFloat(getComputedStyle(node).borderTopLeftRadius))).toBeGreaterThan(4);
    expect(await badge.evaluate((node) => getComputedStyle(node).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
  });

  test('going back from a directly opened modules page keeps the panel import map', async ({ page }) => {
    await installIdleLifecycleRoutes(page);

    await page.goto('/modules');
    await expect(page.locator('.modules-summary')).toBeVisible();
    await page.getByRole('link', { name: 'Назад' }).click();

    // The browser reads the import map from the first loaded page only;
    // without it the editor bundle cannot resolve "@codemirror/state".
    await expect(page.locator('#view-routing .cm-editor').first()).toBeVisible();
    await expect(page.locator('#toast-container')).not.toContainText('Не удалось загрузить часть панели');
  });

  test('offers a single restart action in the profile summary after a registry toggle', async ({ page }) => {
    let enabled = false;
    let restartCalls = 0;
    await installIdleLifecycleRoutes(page);
    await page.route('**/api/modules/installed', (route) => route.fulfill({ json: {
      ...withMihomo(enabled), restart_required: enabled,
    } }));
    await page.route('**/api/modules/engine.mihomo', (route) => {
      enabled = route.request().postDataJSON().enabled;
      return route.fulfill({ json: { ok: true, restart_required: true } });
    });
    await page.route('**/api/modules/restart', (route) => {
      restartCalls += 1;
      return route.fulfill({ json: { ok: true, restart_requested: true } });
    });
    await page.goto('/modules');
    await page.getByRole('switch', { name: 'Включить Mihomo' }).locator('..').click();
    await expect(page.locator('.modules-summary')).toContainText('Требуется перезапуск');
    const restart = page.locator('.modules-summary').getByRole('button', { name: 'Перезапустить панель' });
    await expect(restart).toBeEnabled();
    await expect(page.locator('#modules-operation-status').getByRole('button', { name: 'Перезапустить панель' })).toHaveCount(0);
    expect(restartCalls).toBe(0);
    await restart.click();
    await expect(page.locator('#modules-operation-status')).toContainText('Перезапуск запрошен');
    expect(restartCalls).toBe(1);
  });

  test('waits for the restarted panel, reloads the page and offers the next restart again', async ({ page }) => {
    let enabled = false;
    let restartRequired = false;
    let panelDown = false;
    let probesWhileDown = 0;
    await installIdleLifecycleRoutes(page);
    await page.route('**/api/modules/installed', (route) => {
      if (panelDown) { probesWhileDown += 1; return route.abort('connectionrefused'); }
      return route.fulfill({ json: {
        ...withMihomo(enabled), restart_required: restartRequired,
      } });
    });
    await page.route('**/api/modules/operations/status', (route) => (panelDown
      ? route.abort('connectionrefused')
      : route.fulfill({ json: { ok: true, result: null } })));
    await page.route('**/api/modules/engine.mihomo', (route) => {
      enabled = route.request().postDataJSON().enabled;
      restartRequired = true;
      return route.fulfill({ json: { ok: true, restart_required: true } });
    });
    await page.route('**/api/modules/restart', (route) => {
      panelDown = true;
      return route.fulfill({ json: { ok: true, restart_requested: true } });
    });
    await page.goto('/modules');
    await page.evaluate(() => { window.xkBeforeRestart = true; });
    const toggle = page.getByRole('switch', { name: 'Включить Mihomo' });
    const restart = page.locator('.modules-summary').getByRole('button', { name: 'Перезапустить панель' });

    await toggle.locator('..').click();
    await restart.click();
    await expect(page.locator('#modules-operation-status')).toContainText('Ждём возвращения панели');
    // Nothing may be switched while the panel is going down.
    await expect(toggle).toBeDisabled();
    await expect(restart).toHaveCount(0);
    await expect.poll(() => probesWhileDown).toBeGreaterThanOrEqual(1);
    await expect(page.locator('#modules-error')).toBeEmpty();

    // The panel is back: the registry forgot the request as it started.
    restartRequired = false;
    panelDown = false;
    await expect.poll(() => page.evaluate(() => window.xkBeforeRestart === true), { timeout: 15000 }).toBe(false);
    await expect(toggle).toBeEnabled();
    await expect(page.locator('#modules-operation-status')).not.toContainText('Перезапуск запрошен');

    await toggle.locator('..').click();
    await expect(restart).toBeEnabled();
  });

  test('gives the controls back when the panel never restarts', async ({ page }) => {
    await page.clock.install();
    await installLifecycleRoutes(page, { installed: { ...installedSnapshot, restart_required: true } });
    await page.route('**/api/modules/operations/status', (route) => route.fulfill({ json: { ok: true, result: null } }));
    await page.route('**/api/modules/restart', (route) => route.fulfill({ json: { ok: true, restart_requested: true } }));
    await page.goto('/modules');
    await page.evaluate(() => { window.xkBeforeRestart = true; });
    await page.locator('.modules-summary').getByRole('button', { name: 'Перезапустить панель' }).click();
    await expect(page.locator('#modules-operation-status')).toContainText('Ждём возвращения панели');

    await advanceClock(page, 100 * 1000, 2500);

    await expect(page.locator('#modules-operation-status')).toContainText('Панель не перезапустилась');
    expect(await page.evaluate(() => window.xkBeforeRestart)).toBe(true);
    await page.getByRole('button', { name: 'Обновить состояние' }).click();
    await expect(page.locator('.modules-summary').getByRole('button', { name: 'Перезапустить панель' })).toBeEnabled();
    await expect(page.locator('#modules-operation-status')).not.toContainText('Панель не перезапустилась');
  });

  test('shows the planned restart of an operation as a wait and slows the polling down', async ({ page }) => {
    await page.clock.install();
    const restarting = server.install_steps.restarting;
    let panelDown = false;
    let finished = false;
    let failedPolls = 0;
    await installLifecycleRoutes(page, { status: restarting });
    await page.route('**/api/modules/operations/status', (route) => {
      if (panelDown) { failedPolls += 1; return route.abort('connectionrefused'); }
      return route.fulfill({ json: finished ? committedStatus : restarting });
    });
    await page.goto('/modules');
    await page.evaluate(() => { window.xkBeforeRestart = true; });
    await expect(page.locator('#modules-operation-status')).toContainText('Перезапуск панели');

    panelDown = true;
    await advanceClock(page, 1100);
    await expect(page.locator('#modules-operation-status')).toContainText('Панель перезапускается');
    await expect(page.locator('#modules-error')).toBeEmpty();
    await expect(page.locator('body')).not.toContainText('network_error');
    await expect(page.getByRole('switch', { name: 'Включить Mihomo' })).toBeDisabled();
    // One request a second would make ten here.
    await advanceClock(page, 9000);
    expect(failedPolls).toBeLessThanOrEqual(4);
    expect(failedPolls).toBeGreaterThanOrEqual(2);

    // The panel answers again on the files of the operation: the page takes them too.
    finished = true;
    panelDown = false;
    await advanceClock(page, 10000);
    await expect.poll(() => page.evaluate(() => window.xkBeforeRestart === true), { timeout: 15000 }).toBe(false);
    await expect(page.locator('#modules-operation-status .modules-operation')).toHaveCount(0);
    await expect(page.locator('#modules-operation-status')).not.toContainText('Панель перезапускается');
  });

  test('names a lost connection plainly while an operation has not reached the restart', async ({ page }) => {
    await page.clock.install();
    let panelDown = false;
    await installLifecycleRoutes(page, { status: runningStatus });
    await page.route('**/api/modules/operations/status', (route) => (panelDown
      ? route.abort('connectionrefused')
      : route.fulfill({ json: runningStatus })));
    await page.goto('/modules');
    await expect(page.locator('#modules-operation-status')).toContainText('Загрузка архива');

    panelDown = true;
    await advanceClock(page, 1100);
    await expect(page.locator('#modules-operation-status')).toContainText('Нет связи с панелью');
    await expect(page.locator('#modules-operation-status')).not.toContainText('Панель перезапускается');

    panelDown = false;
    await advanceClock(page, 2100);
    await expect(page.locator('#modules-operation-status')).not.toContainText('Нет связи с панелью');
    await expect(page.getByRole('button', { name: 'Отменить операцию' })).toBeEnabled();
  });

  test('reads the installed modules again after a recovery the polling has already seen', async ({ page }) => {
    let installedLoads = 0;
    let currentStatus = runningStatus;
    let recovered = false;
    await page.route('**/api/modules/installed', (route) => {
      installedLoads += 1;
      return route.fulfill({ json: recovered ? server.installed_after_install : installedSnapshot });
    });
    await page.route('**/api/modules/operations/status', (route) => route.fulfill({ json: currentStatus }));
    await page.route('**/api/modules/available', (route) => route.fulfill({ json: availableSnapshot }));
    await page.route('**/api/modules/recovery', (route) => {
      recovered = true;
      currentStatus = server.recovery_rolled_back;
      return route.fulfill({ json: currentStatus });
    });
    await page.goto('/modules');
    await expect(page.getByRole('button', { name: 'Отменить операцию' })).toBeVisible();
    // The polling, not a page load, is what sees the failed undo.
    currentStatus = rollbackFailedStatus;
    const recover = page.getByRole('button', { name: 'Повторить восстановление' });
    await expect(recover).toBeEnabled();
    const loadsBeforeRecovery = installedLoads;

    await recover.click();

    await expect(page.locator('#modules-operation-status')).toContainText('Отменено, файлы возвращены');
    await expect(page.locator('.modules-module').filter({ hasText: TERMINAL })).toBeVisible();
    expect(installedLoads).toBeGreaterThan(loadsBeforeRecovery);
  });

  test('removes the restart action after a switch is returned to its original state', async ({ page }) => {
    let enabled = true;
    let profile = 'full';
    let restartRequired = false;
    await installIdleLifecycleRoutes(page);
    await page.route('**/api/modules/installed', (route) => route.fulfill({ json: {
      ...withMihomo(enabled),
      restart_required: restartRequired,
    } }));
    await page.route('**/api/modules/engine.mihomo', (route) => {
      enabled = route.request().postDataJSON().enabled;
      profile = enabled ? 'full' : 'custom';
      restartRequired = !enabled;
      return route.fulfill({ json: { ok: true, profile, restart_required: restartRequired } });
    });

    await page.goto('/modules');
    const row = page.locator('.modules-tile[data-module-id="engine.mihomo"]');
    const control = row.getByRole('switch', { name: 'Включить Mihomo' });
    await expect(row.locator('.modules-switch-state')).toHaveText('Включён');
    await expect(row.locator('.modules-switch-state')).toHaveClass(/is-enabled/);
    const enabledCount = page.locator('.modules-summary .xk-summary-stat[data-stat="enabled"] b');
    await control.locator('..').click();
    await expect(enabledCount).toHaveText('2 из 3');
    await expect(page.getByRole('button', { name: 'Перезапустить панель' })).toBeVisible();
    await control.locator('..').click();
    await expect(enabledCount).toHaveText('3 из 3');
    await expect(page.locator('.modules-summary')).not.toContainText('Требуется перезапуск');
    await expect(page.getByRole('button', { name: 'Перезапустить панель' })).toHaveCount(0);
  });

  for (const [was, previousStatus] of [['no operation', idleStatus], ['a committed one', committedStatus]]) {
    test(`refreshes the status after ${was} when the manager is reactivated`, async ({ page }) => {
      let currentStatus = previousStatus;
      let statusCalls = 0;
      let catalogCalls = 0;
      await installIdleLifecycleRoutes(page);
      await page.route('**/api/modules/operations/status', (route) => {
        statusCalls += 1;
        return route.fulfill({ json: currentStatus });
      });
      await page.route('**/api/modules/available', (route) => {
        catalogCalls += 1;
        return route.fulfill({ json: availableSnapshot });
      });
      await page.goto('/modules');
      await expect(page.getByRole('button', { name: 'Обновить панель' })).toBeEnabled();
      await page.evaluate(async () => {
        const { getModulesController } = await import('/static/js/pages/modules.init.js');
        getModulesController().deactivate();
        await getModulesController().activate();
        getModulesController().deactivate();
      });
      const beforeReturn = statusCalls;
      currentStatus = { ...interruptedStatus, operation_id: 'op-external' };
      await page.evaluate(async () => {
        const { getModulesController } = await import('/static/js/pages/modules.init.js');
        await getModulesController().activate();
      });
      await expect(page.locator('#modules-operation-status')).toContainText('Прервана');
      await expect(page.getByRole('button', { name: 'Обновить панель' })).toBeEnabled();
      expect(statusCalls).toBeGreaterThan(beforeReturn);
      expect(catalogCalls).toBe(0);
    });
  }

  test('leaves the manager usable after an interrupted operation', async ({ page }) => {
    // What the server keeps after a failed download or a cancel: the
    // record of the operation is gone and there is nothing to recover.
    let recoveryCalls = 0;
    await installLifecycleRoutes(page, { status: server.cancelled });
    await page.route('**/api/modules/recovery', (route) => {
      recoveryCalls += 1;
      return route.fulfill({ json: { ...server.cancelled, recovery_result: null } });
    });
    await page.goto('/modules');

    await expect(page.locator('#modules-operation-status')).toContainText('Операция отменена');
    await expect(page.locator('#modules-operation-status')).toContainText('Файлы панели не изменены');
    // Nothing to recover: the only button is the one that closes the report.
    await expect(page.locator('#modules-operation-status').getByRole('button')).toHaveCount(1);
    await expect(page.locator('#modules-operation-status').getByRole('button', { name: 'Скрыть отчёт об операции' })).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Включить Mihomo' })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Обновить панель' })).toBeEnabled();
    await page.getByRole('tab', { name: 'Доступные' }).click();
    await expect(page.getByRole('button', { name: `Установить ${TERMINAL}` })).toBeEnabled();
    expect(recoveryCalls).toBe(0);
  });

  test('says that the installer replaced the files of an unfinished operation', async ({ page }) => {
    await installLifecycleRoutes(page, { status: { ...interruptedStatus, error_code: 'operation_superseded' } });
    await page.goto('/modules');

    await expect(page.locator('#modules-operation-status')).toContainText('заменены установщиком');
    await expect(page.locator('#modules-operation-status')).not.toContainText('Файлы панели не изменены');
    await expect(page.getByRole('button', { name: 'Обновить панель' })).toBeEnabled();
  });

  test('repeats a failed undo without restarting', async ({ page }) => {
    let recoveryCalls = 0;
    let restartCalls = 0;
    let currentStatus = rollbackFailedStatus;
    await installLifecycleRoutes(page, { status: rollbackFailedStatus });
    await page.route('**/api/modules/operations/status', (route) => route.fulfill({ json: currentStatus }));
    await page.route('**/api/modules/recovery', (route) => {
      recoveryCalls += 1;
      currentStatus = server.recovery_rolled_back;
      return route.fulfill({ json: currentStatus });
    });
    await page.route('**/api/modules/restart', (route) => {
      restartCalls += 1;
      return route.fulfill({ json: { ok: true, restart_requested: true } });
    });
    await page.goto('/modules');
    await expect(page.getByRole('switch', { name: 'Включить Mihomo' })).toBeDisabled();
    await page.getByRole('button', { name: 'Повторить восстановление' }).click();
    await expect(page.locator('#modules-operation-status')).toContainText('Отменено, файлы возвращены');
    await expect(page.getByRole('switch', { name: 'Включить Mihomo' })).toBeEnabled();
    expect(recoveryCalls).toBe(1);
    expect(restartCalls).toBe(0);
  });

  test('a report of an undone operation is closed for good, a failed undo cannot be closed', async ({ page }) => {
    let status = restartStatus;
    await installLifecycleRoutes(page, { status });
    await page.route('**/api/modules/operations/status', (route) => route.fulfill({ json: status }));
    await page.goto('/modules');
    const block = page.locator('#modules-operation-status .modules-operation');
    await expect(block).toContainText('Отменено, файлы возвращены');

    await block.getByRole('button', { name: 'Скрыть отчёт об операции' }).click();
    await expect(block).toHaveCount(0);
    // Closing the report does not take the restart it asked for.
    await expect(page.getByRole('button', { name: 'Перезапустить панель' })).toBeVisible();
    await page.reload();
    await expect(page.locator('.modules-summary')).toBeVisible();
    await expect(block).toHaveCount(0);

    // Another operation brings its own report back.
    status = { ...interruptedStatus, operation_id: 'another-operation' };
    await page.reload();
    await expect(block).toContainText('Прервана');
    await expect(block.getByRole('button', { name: 'Скрыть отчёт об операции' })).toBeVisible();

    status = rollbackFailedStatus;
    await page.reload();
    await expect(block).toContainText('Файлы не возвращены');
    await expect(block.getByRole('button', { name: 'Скрыть отчёт об операции' })).toHaveCount(0);
  });

  test('locks mutations after rollback_failed and offers to repeat the undo', async ({ page }) => {
    await installLifecycleRoutes(page, { status: rollbackFailedStatus });
    await page.goto('/modules');
    await expect(page.getByText('Восстановление файлов не завершилось')).toBeVisible();
    await page.getByRole('tab', { name: 'Доступные' }).click();
    await expect(page.getByRole('button', { name: `Установить ${TERMINAL}` })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Повторить восстановление' })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Перезапустить панель' })).toHaveCount(0);
  });

  test('offers guarded restart only after a restart-required terminal outcome', async ({ page }) => {
    let restartCalls = 0;
    await installLifecycleRoutes(page, { status: restartStatus });
    await page.route('**/api/modules/restart', (route) => {
      restartCalls += 1;
      return route.fulfill({ json: { ok: true, restart_requested: true } });
    });
    await page.goto('/modules');
    await page.screenshot({ path: 'test-results/modules-operation-desktop.png', fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole('button', { name: 'Перезапустить панель' }).click();
    await expect(page.locator('#modules-operation-status')).toContainText('Перезапуск запрошен');
    expect(restartCalls).toBe(1);
  });

  test('profile transition offers reviewed plan instead of restart', async ({ page }) => {
    await installLifecycleRoutes(page, { status: restartStatus, installed: { ...installedSnapshot, transition_required: true } });
    await page.route('**/api/modules/operations/plan', (route) => route.fulfill({ json: {
      ...panelUpdatePlan, operation: 'profile-transition',
    } }));
    await page.goto('/modules');
    await expect(page.getByRole('button', { name: 'Перезапустить панель' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Применить профиль' }).click();
    await expect(page.getByRole('dialog', { name: 'Применить набор модулей' })).toBeVisible();
  });

  test('does not offer restart without an authoritative installed profile guard', async ({ page }) => {
    await installLifecycleRoutes(page, { status: restartStatus });
    await page.route('**/api/modules/installed', (route) => route.fulfill({ status: 503, json: {
      ok: false, code: 'module_state_unavailable', message: '/private/state',
    } }));
    await page.goto('/modules');
    await expect(page.locator('#modules-error .modules-page-alert')).toHaveAttribute('data-code', 'module_state_unavailable');
    await expect(page.getByRole('button', { name: 'Перезапустить панель' })).toHaveCount(0);
  });

  test('maps catalog errors without printing remote message and preserves installed cards', async ({ page }) => {
    await installLifecycleRoutes(page);
    await page.route('**/api/modules/available', (route) => route.fulfill({ status: 503, json: {
      ok: false, code: 'catalog_unavailable', message: '<img src=x onerror="window.catalogInjected=1"> /private/path',
    } }));
    await page.goto('/modules');
    await page.getByRole('tab', { name: 'Доступные' }).click();
    await expect(page.locator('#modules-card-host')).toContainText('catalog_unavailable');
    await expect(page.locator('#modules-card-host')).not.toContainText('/private/path');
    await page.getByRole('tab', { name: 'Установленные' }).click();
    await expect(page.locator('.modules-core')).toContainText('Xkeen UI Core');
    expect(await page.evaluate(() => window.catalogInjected)).toBeUndefined();
  });

  test('keeps installed cards when operation status is unavailable', async ({ page }) => {
    await installLifecycleRoutes(page);
    await page.route('**/api/modules/operations/status', (route) => route.fulfill({ status: 503, json: {
      ok: false, code: 'operation_in_progress', message: '/private/operation.log',
    } }));
    await page.goto('/modules');
    await expect(page.locator('.modules-core')).toContainText('Xkeen UI Core');
    await expect(page.locator('#modules-error .modules-page-alert')).toHaveAttribute('data-code', 'operation_in_progress');
    await expect(page.locator('#modules-error')).not.toContainText('/private/operation.log');
    await expect(page.getByRole('button', { name: 'Обновить панель' })).toBeDisabled();
    await expect(page.getByRole('switch', { name: 'Включить Mihomo' })).toBeDisabled();
    await page.getByRole('tab', { name: 'Доступные' }).click();
    await expect(page.getByRole('button', { name: `Установить ${TERMINAL}` })).toBeDisabled();
  });

  test('locks stale terminal actions until a failed status refresh succeeds', async ({ page }) => {
    let statusLoads = 0;
    let planCalls = 0;
    let restartCalls = 0;
    let toggleCalls = 0;
    await installLifecycleRoutes(page, { status: restartStatus });
    await page.route('**/api/modules/operations/status', (route) => {
      statusLoads += 1;
      return statusLoads === 2
        ? route.fulfill({ status: 503, json: { ok: false, code: 'module_request_failed', message: '/private/path' } })
        : route.fulfill({ json: restartStatus });
    });
    await page.route('**/api/modules/operations/plan', (route) => { planCalls += 1; return route.fulfill({ json: installPlan }); });
    await page.route('**/api/modules/restart', (route) => { restartCalls += 1; return route.fulfill({ json: { ok: true, restart_requested: true } }); });
    await page.route('**/api/modules/engine.mihomo', (route) => { toggleCalls += 1; return route.fulfill({ json: installedSnapshot }); });
    await page.goto('/modules');
    await expect(page.getByRole('button', { name: 'Перезапустить панель' })).toBeVisible();
    await page.evaluate(async () => {
      const { getModulesController } = await import('/static/js/pages/modules.init.js');
      await getModulesController().refreshInstalledAfterTerminal();
    });
    await expect(page.locator('.modules-core')).toContainText('Xkeen UI Core');
    await expect(page.getByRole('button', { name: 'Обновить панель' })).toBeDisabled();
    await expect(page.getByRole('switch', { name: 'Включить Mihomo' })).toBeDisabled();
    await page.evaluate(() => document.querySelector('input[role="switch"]').click());
    await expect(page.getByRole('button', { name: 'Перезапустить панель' })).toHaveCount(0);
    await page.getByRole('tab', { name: 'Доступные' }).click();
    await expect(page.getByRole('button', { name: `Установить ${TERMINAL}` })).toBeDisabled();
    await page.evaluate(async () => {
      const { getModulesController } = await import('/static/js/pages/modules.init.js');
      await getModulesController().requestPlan('install', 'tool.terminal');
    });
    expect({ planCalls, restartCalls, toggleCalls }).toEqual({ planCalls: 0, restartCalls: 0, toggleCalls: 0 });
    await page.getByRole('button', { name: 'Обновить состояние' }).click();
    await page.getByRole('tab', { name: 'Установленные' }).click();
    await expect(page.getByRole('button', { name: 'Обновить панель' })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Перезапустить панель' })).toBeVisible();
  });

  test('explains public lifecycle failure families without remote details', async ({ page }) => {
    await installLifecycleRoutes(page);
    await page.goto('/modules');
    const descriptions = await page.evaluate(async () => {
      const { describeLifecycleFailure } = await import('/static/js/features/module_manager/render.js');
      return ['catalog_stale', 'catalog_trust_failed', 'module_archive_invalid', 'module_free_space', 'operation_free_space',
        'operation_in_progress', 'module_plan_stale', 'profile_transition_required', 'operation_rollback_failed']
        .map((code) => describeLifecycleFailure({ code, message: '/private/file' }));
    });
    expect(descriptions).toHaveLength(9);
    for (const description of descriptions) {
      expect(description).toMatch(/[А-Яа-я]/);
      expect(description).not.toContain('/private/file');
    }
    expect(descriptions.at(-1)).toContain('ручная проверка');
    expect(descriptions[4]).toContain('Недостаточно свободного места');
  });

  test('keeps expanded operation and plan readable on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await installLifecycleRoutes(page, { status: { ...restartStatus, log: [{ step: 'a'.repeat(200), at: 1781000001 }] } });
    await routePlans(page, () => ({ json: {
      ...installPlan, affected_module_ids: ['a'.repeat(120)],
    } }));
    await page.goto('/modules');
    await expect(page.getByRole('button', { name: 'Перезапустить панель' })).toBeVisible();
    await expect(page.locator('.modules-operation-log-region')).toContainText('a'.repeat(200));
    await page.screenshot({ path: 'test-results/modules-operation-mobile.png', fullPage: true });
    const overflow = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: innerWidth,
      elements: [...document.querySelectorAll('body *')].filter((el) => el.getBoundingClientRect().right > innerWidth + 1).slice(0, 8).map((el) => [el.tagName, el.className, Math.round(el.getBoundingClientRect().right)]),
    }));
    expect(overflow.width <= overflow.viewport, JSON.stringify(overflow)).toBe(true);
    await page.getByRole('button', { name: 'Обновить панель' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    expect(await dialog.evaluate((element) => element.getBoundingClientRect().right <= innerWidth)).toBe(true);
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await dialog.getByRole('button', { name: 'Отмена' }).click();
    await expect(page.getByRole('button', { name: 'Обновить панель' })).toBeFocused();
  });
});

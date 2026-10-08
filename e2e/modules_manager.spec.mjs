import { test, expect } from './fixtures.mjs';

const installedSnapshot = {
  ok: true,
  panel_version: '2.10.0',
  profile: 'mihomo-minimal',
  transition_required: false,
  editor: { variant: 'codemirror' },
  restart_required: false,
  lifecycle: { available: true, code: null },
  modules: [
    { id: 'core', name: 'Xkeen UI Core', version: '1.0.0', enabled: true, can_disable: false },
    { id: 'engine.mihomo', name: 'Mihomo', version: '1.19.0', enabled: false, can_disable: true, lifecycle_actions: ['repair', 'remove'] },
  ],
};
const idleStatus = { ok: true, result: 'idle' };
const availableSnapshot = {
  ok: true,
  release_version: '2.10.0',
  modules: [
    { id: 'tool.terminal', name: 'Терминал', description: 'Командная строка', version: '2.10.0', requires: ['core'], conflicts: [], lifecycle_actions: ['install'] },
  ],
};
const installPlan = {
  ok: true, operation: 'install', module_id: 'tool.terminal', version: '2.10.0',
  affected_module_ids: ['tool.terminal'], files_add: [{ path: 'terminal.js' }], files_remove: [],
  required_free_bytes: 12 * 1024 * 1024, restart_required: true,
  dependency_diff: { add: ['core'], remove: [] }, blockers: [], applicable: true,
  plan_id: 'a'.repeat(64),
};
const runningStatus = {
  ok: true, operation_id: 'op-123', operation: 'install', module_id: 'tool.terminal',
  result: 'running', step: 'download', started_at: 1781000000,
  log: [{ step: 'prepare', at: 1781000000 }, { step: 'download', at: 1781000001 }],
};

async function installIdleLifecycleRoutes(page) {
  await page.route('**/api/modules/installed', (route) => route.fulfill({ json: installedSnapshot }));
  await page.route('**/api/modules/operations/status', (route) => route.fulfill({ json: idleStatus }));
  await page.route('**/api/modules/available', (route) => route.fulfill({ json: availableSnapshot }));
}

async function installLifecycleRoutes(page, { status = idleStatus, installed = installedSnapshot, available = availableSnapshot } = {}) {
  await page.route('**/api/modules/installed', (route) => route.fulfill({ json: installed }));
  await page.route('**/api/modules/operations/status', (route) => route.fulfill({ json: status }));
  await page.route('**/api/modules/available', (route) => route.fulfill({ json: available }));
}

const interruptedStatus = { ...runningStatus, result: 'interrupted', step: 'recover', error_code: 'operation_interrupted' };
const rollbackFailedStatus = { ...interruptedStatus, result: 'rollback_failed', error_code: 'operation_rollback_failed' };
const restartStatus = { ...runningStatus, result: 'committed', step: 'done', restart_required: true };

test.describe('DevTools update channel boundary', () => {
  const updateInfo = (channel) => ({
    ok: true,
    build: { version: '2.10.0', repo: 'umarcheh001/Xkeen-UI', channel, commit: 'abc1234' },
    settings: { repo: 'umarcheh001/Xkeen-UI', channel, branch: 'main' },
    capabilities: { curl: true, tar: true, sha256sum: true },
    security: { sha_strict: '1', require_sha: '1' },
  });

  test('stable DevTools links to Modules without legacy update requests', async ({ page }) => {
    const legacyRequests = [];
    await page.route('**/api/devtools/update/info', (route) => route.fulfill({ json: updateInfo('stable') }));
    await page.route(/\/api\/devtools\/update\/(?:check|status|run|rollback)(?:\?|$)/, (route) => {
      legacyRequests.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
      return route.fulfill({ json: { ok: true, status: { state: 'idle' } } });
    });
    await installIdleLifecycleRoutes(page);

    await page.goto('/devtools');
    const notice = page.locator('[data-dt-modules-manager-notice]');
    await expect(notice).toBeVisible();
    await expect(page.locator('[data-dt-main-update-controls]')).toBeHidden();
    await expect(page.locator('#xk-update-link')).toBeHidden();
    await page.waitForTimeout(1000);
    expect(legacyRequests).toEqual([]);

    const link = notice.getByRole('link', { name: 'Модули и обновления' });
    await expect(link).toHaveAttribute('data-xk-top-nav', '1');
    await link.click();
    await expect(page).toHaveURL(/\/modules$/);
    await expect(page.locator('.modules-summary')).toBeVisible();
    expect(legacyRequests).toEqual([]);
  });

  test('main DevTools retains the manual legacy check', async ({ page }) => {
    const checkBodies = [];
    await page.route('**/api/devtools/update/info', (route) => route.fulfill({ json: updateInfo('main') }));
    await page.route('**/api/devtools/update/status**', (route) => route.fulfill({ json: { ok: true, status: { state: 'idle' }, log_tail: [] } }));
    await page.route('**/api/devtools/update/check', (route) => {
      checkBodies.push(route.request().postDataJSON());
      const tarballUrl = 'https://codeload.github.com/umarcheh001/Xkeen-UI/tar.gz/abc1234';
      return route.fulfill({ json: {
        ok: true, error: null, repo: 'umarcheh001/Xkeen-UI', channel: 'main', branch: 'main',
        current: { version: '2.10.0', commit: 'abc1234' },
        latest: { kind: 'main', branch: 'main', sha: 'abc1234', short_sha: 'abc1234',
          committed_at: null, message: null, html_url: null, tarball_url: tarballUrl },
        update_available: false, stale: false, meta: { repo: 'umarcheh001/Xkeen-UI', branch: 'main' },
        development_only: true,
        security: { settings: {}, download: { url: tarballUrl, ok: true, reason: null },
          checksum: null, warnings: [], will_block_run: false },
      } });
    });

    await page.goto('/devtools');
    await expect(page.locator('[data-dt-main-update-controls]')).toBeVisible();
    await expect(page.locator('[data-dt-modules-manager-notice]')).toBeHidden();
    await page.locator('#dt-update-check').click();
    await expect.poll(() => checkBodies.some((body) => body.force_refresh === true)).toBe(true);
  });

  for (const channel of ['main', 'stable']) {
    test(`${channel} DevTools recovers after the first info request fails`, async ({ page }) => {
      let allowInfo = false;
      const legacyRequests = [];
      await page.route('**/api/devtools/update/info', (route) => route.fulfill(
        allowInfo ? { json: updateInfo(channel) } : { status: 503, json: { ok: false, error: 'temporary failure' } },
      ));
      await page.route(/\/api\/devtools\/update\/(?:check|status|run|rollback)(?:\?|$)/, (route) => {
        legacyRequests.push({ path: new URL(route.request().url()).pathname, body: route.request().postDataJSON() });
        return route.fulfill({ json: { ok: true, channel, status: { state: 'idle' }, log_tail: [] } });
      });

      await page.goto('/devtools');
      await expect(page.locator('#dt-update-status')).toContainText('temporary failure');
      await expect(page.locator('[data-dt-main-update-controls]')).toBeHidden();
      allowInfo = true;
      await page.evaluate(async () => {
        const { getDevtoolsNamespace } = await import('/static/js/features/devtools_namespace.js');
        getDevtoolsNamespace().devtoolsUpdate.activate();
      });

      if (channel === 'main') {
        await expect(page.locator('[data-dt-main-update-controls]')).toBeVisible();
        await page.evaluate(async () => {
          const { getDevtoolsNamespace } = await import('/static/js/features/devtools_namespace.js');
          getDevtoolsNamespace().devtoolsUpdate.activate();
        });
        await page.locator('#dt-update-check').click();
        await expect.poll(() => legacyRequests.filter((request) => request.path.endsWith('/check') && request.body.force_refresh === true).length).toBe(1);
        await page.waitForTimeout(250);
        expect(legacyRequests.filter((request) => request.path.endsWith('/check') && request.body.force_refresh === true)).toHaveLength(1);
      } else {
        await expect(page.locator('[data-dt-modules-manager-notice]')).toBeVisible();
        await page.waitForTimeout(1000);
        expect(legacyRequests).toEqual([]);
      }
    });
  }
});

test.describe('Module manager recovery and guards', () => {
  test('reconciles external profile and registry changes on re-entry and invalidates catalog', async ({ page }) => {
    let installed = { ...installedSnapshot, restart_required: true };
    let catalogCalls = 0;
    await installIdleLifecycleRoutes(page);
    await page.route('**/api/modules/installed', (route) => route.fulfill({ json: installed }));
    await page.route('**/api/modules/available', (route) => {
      catalogCalls += 1;
      return route.fulfill({ json: installed.transition_required ? { ...availableSnapshot, modules: [] } : availableSnapshot });
    });
    await page.goto('/modules');
    await expect(page.getByRole('button', { name: 'Перезапустить панель' })).toBeEnabled();
    await page.getByRole('tab', { name: 'Доступные' }).click();
    await expect(page.getByRole('button', { name: 'Установить Терминал' })).toBeVisible();
    await page.getByRole('tab', { name: 'Установленные' }).click();
    await page.evaluate(async () => (await import('/static/js/pages/modules.init.js')).getModulesController().deactivate());
    installed = { ...installed, profile: 'full', transition_required: true,
      modules: installed.modules.map((item) => ({ ...item, enabled: true })) };
    await page.evaluate(async () => (await import('/static/js/pages/modules.init.js')).getModulesController().activate());
    await expect(page.locator('.modules-summary')).toContainText('Профиль: full');
    await expect(page.getByRole('switch', { name: 'Включить Mihomo' })).toBeChecked();
    await expect(page.getByRole('button', { name: 'Применить профиль' })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Перезапустить панель' })).toHaveCount(0);
    expect(catalogCalls).toBe(1);
    await page.getByRole('tab', { name: 'Доступные' }).click();
    await expect(page.getByText('Доступных модулей нет.')).toBeVisible();
    expect(catalogCalls).toBe(2);
  });

  test('keeps re-entry locked after installed reconciliation fails until both snapshots recover', async ({ page }) => {
    let unavailable = false;
    await installLifecycleRoutes(page, { installed: { ...installedSnapshot, restart_required: true } });
    await page.route('**/api/modules/installed', (route) => route.fulfill(unavailable
      ? { status: 503, json: { ok: false, code: 'module_state_unavailable' } }
      : { json: { ...installedSnapshot, restart_required: true } }));
    await page.goto('/modules');
    await expect(page.getByRole('button', { name: 'Перезапустить панель' })).toBeEnabled();
    await page.evaluate(async () => (await import('/static/js/pages/modules.init.js')).getModulesController().deactivate());
    unavailable = true;
    await page.evaluate(async () => (await import('/static/js/pages/modules.init.js')).getModulesController().activate());
    await expect(page.getByRole('button', { name: 'Обновить панель' })).toBeDisabled();
    await expect(page.getByRole('switch', { name: 'Включить Mihomo' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Перезапустить панель' })).toHaveCount(0);
    await expect(page.locator('#modules-error')).toContainText('module_state_unavailable');
    await page.locator('#modules-refresh-status').click();
    await expect(page.getByRole('button', { name: 'Обновить панель' })).toBeDisabled();
    unavailable = false;
    await page.locator('#modules-refresh-status').click();
    await expect(page.getByRole('button', { name: 'Обновить панель' })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Перезапустить панель' })).toBeEnabled();
  });

  test('offers explicit restart after a registry toggle while lifecycle is idle', async ({ page }) => {
    let enabled = false;
    let restartCalls = 0;
    await installIdleLifecycleRoutes(page);
    await page.route('**/api/modules/installed', (route) => route.fulfill({ json: {
      ...installedSnapshot, restart_required: enabled,
      modules: installedSnapshot.modules.map((item) => item.id === 'engine.mihomo' ? { ...item, enabled } : item),
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
    await page.getByRole('switch', { name: 'Включить Mihomo' }).click();
    await expect(page.locator('.modules-summary')).toContainText('Требуется перезапуск');
    const restart = page.getByRole('button', { name: 'Перезапустить панель' });
    await expect(restart).toBeEnabled();
    expect(restartCalls).toBe(0);
    await restart.click();
    await expect(page.locator('#modules-operation-status')).toContainText('Перезапуск запрошен');
    expect(restartCalls).toBe(1);
  });

  for (const previousStatus of [idleStatus, { ...runningStatus, result: 'committed', step: 'done' }]) {
    test(`refreshes ${previousStatus.result} status when the manager is reactivated`, async ({ page }) => {
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
      await expect(page.getByRole('button', { name: 'Восстановить операцию' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Обновить панель' })).toBeDisabled();
      expect(statusCalls).toBeGreaterThan(beforeReturn);
      expect(catalogCalls).toBe(0);
    });
  }

  test('recovers interrupted operation without restarting', async ({ page }) => {
    let recoveryCalls = 0;
    let restartCalls = 0;
    let currentStatus = interruptedStatus;
    await installLifecycleRoutes(page, { status: interruptedStatus });
    await page.route('**/api/modules/operations/status', (route) => route.fulfill({ json: currentStatus }));
    await page.route('**/api/modules/recovery', (route) => {
      recoveryCalls += 1;
      currentStatus = { ...interruptedStatus, result: 'rolled_back', recovered: true };
      return route.fulfill({ json: currentStatus });
    });
    await page.route('**/api/modules/restart', (route) => {
      restartCalls += 1;
      return route.fulfill({ json: { ok: true, restart_requested: true } });
    });
    await page.goto('/modules');
    await page.getByRole('button', { name: 'Восстановить операцию' }).click();
    await expect(page.locator('#modules-operation-status')).toContainText('rolled_back');
    expect(recoveryCalls).toBe(1);
    expect(restartCalls).toBe(0);
  });

  test('locks mutations after rollback_failed and exposes manual recovery boundary', async ({ page }) => {
    await installLifecycleRoutes(page, { status: rollbackFailedStatus });
    await page.goto('/modules');
    await expect(page.getByText('Восстановление файлов не завершилось')).toBeVisible();
    await page.getByRole('tab', { name: 'Доступные' }).click();
    await expect(page.getByRole('button', { name: 'Установить Терминал' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Восстановить операцию' })).toHaveCount(0);
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
      ...installPlan, operation: 'profile-transition', module_id: null, scope: 'panel',
    } }));
    await page.goto('/modules');
    await expect(page.getByRole('button', { name: 'Перезапустить панель' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Применить профиль' }).click();
    await expect(page.getByRole('dialog', { name: 'План перехода профиля' })).toBeVisible();
  });

  test('does not offer restart without an authoritative installed profile guard', async ({ page }) => {
    await installLifecycleRoutes(page, { status: restartStatus });
    await page.route('**/api/modules/installed', (route) => route.fulfill({ status: 503, json: {
      ok: false, code: 'module_state_unavailable', message: '/private/state',
    } }));
    await page.goto('/modules');
    await expect(page.locator('#modules-error')).toContainText('module_state_unavailable');
    await expect(page.getByRole('button', { name: 'Перезапустить панель' })).toHaveCount(0);
  });

  test('maps catalog errors without printing remote message and preserves installed cards', async ({ page }) => {
    await installLifecycleRoutes(page);
    await page.route('**/api/modules/available', (route) => route.fulfill({ status: 503, json: {
      ok: false, code: 'catalog_unavailable', message: '<img src=x onerror="window.catalogInjected=1"> /private/path',
    } }));
    await page.goto('/modules');
    await page.getByRole('tab', { name: 'Доступные' }).click();
    await expect(page.locator('#modules-error')).toContainText('catalog_unavailable');
    await expect(page.locator('#modules-error')).not.toContainText('/private/path');
    await page.getByRole('tab', { name: 'Установленные' }).click();
    await expect(page.locator('.modules-row').first()).toContainText('Xkeen UI Core');
    expect(await page.evaluate(() => window.catalogInjected)).toBeUndefined();
  });

  test('keeps installed cards when operation status is unavailable', async ({ page }) => {
    await installLifecycleRoutes(page);
    await page.route('**/api/modules/operations/status', (route) => route.fulfill({ status: 503, json: {
      ok: false, code: 'operation_in_progress', message: '/private/operation.log',
    } }));
    await page.goto('/modules');
    await expect(page.locator('.modules-row').first()).toContainText('Xkeen UI Core');
    await expect(page.locator('#modules-error')).toContainText('operation_in_progress');
    await expect(page.locator('#modules-error')).not.toContainText('/private/operation.log');
    await expect(page.getByRole('button', { name: 'Обновить панель' })).toBeDisabled();
    await expect(page.getByRole('switch', { name: 'Включить Mihomo' })).toBeDisabled();
    await page.getByRole('tab', { name: 'Доступные' }).click();
    await expect(page.getByRole('button', { name: 'Установить Терминал' })).toBeDisabled();
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
    await expect(page.locator('.modules-row').first()).toContainText('Xkeen UI Core');
    await expect(page.getByRole('button', { name: 'Обновить панель' })).toBeDisabled();
    await expect(page.getByRole('switch', { name: 'Включить Mihomo' })).toBeDisabled();
    await page.evaluate(() => document.querySelector('input[role="switch"]').click());
    await expect(page.getByRole('button', { name: 'Перезапустить панель' })).toHaveCount(0);
    await page.getByRole('tab', { name: 'Доступные' }).click();
    await expect(page.getByRole('button', { name: 'Установить Терминал' })).toBeDisabled();
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
    await page.route('**/api/modules/operations/plan', (route) => route.fulfill({ json: {
      ...installPlan, affected_module_ids: ['a'.repeat(120)],
    } }));
    await page.goto('/modules');
    await expect(page.getByRole('button', { name: 'Перезапустить панель' })).toBeVisible();
    await expect(page.locator('.modules-operation-log-region code')).toContainText('a'.repeat(200));
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
    await dialog.getByRole('button', { name: 'Отменить' }).click();
    await expect(page.getByRole('button', { name: 'Обновить панель' })).toBeFocused();
  });
});

test.describe('Module manager loading', () => {
  test('opens installed state without downloading the catalog', async ({ page }) => {
    const initialCalls = [];
    let availableCalls = 0;
    const enabledBodies = [];
    await page.route('**/api/modules/installed', (route) => {
      initialCalls.push('installed');
      return route.fulfill({ json: installedSnapshot });
    });
    await page.route('**/api/modules/operations/status', (route) => {
      initialCalls.push('status');
      return route.fulfill({ json: idleStatus });
    });
    await page.route('**/api/modules/available', (route) => {
      availableCalls += 1;
      return route.fulfill({ json: availableSnapshot });
    });
    await page.route('**/api/modules/engine.mihomo', (route) => {
      enabledBodies.push(route.request().postDataJSON());
      return route.fulfill({ json: installedSnapshot });
    });

    await page.goto('/modules');
    await expect(page.getByRole('heading', { name: 'Модули и обновления' })).toBeVisible();
    await expect(page.locator('.modules-summary')).toContainText('Xkeen UI 2.10.0');
    await expect(page.locator('.modules-row').first()).toContainText('Xkeen UI Core 1.0.0');
    await expect(page.getByRole('button', { name: 'Восстановить Mihomo' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Удалить Mihomo' })).toBeVisible();
    expect(initialCalls.sort()).toEqual(['installed', 'status']);
    expect(availableCalls).toBe(0);

    await page.getByRole('tab', { name: 'Доступные' }).click();
    await expect(page.getByRole('heading', { name: 'Терминал 2.10.0' })).toBeVisible();
    expect(availableCalls).toBe(1);

    await page.getByRole('tab', { name: 'Установленные' }).click();
    await page.getByRole('switch', { name: 'Включить Mihomo' }).click();
    await expect.poll(() => enabledBodies).toEqual([{ enabled: true }]);
  });

  test('renders catalog text without executing markup', async ({ page }) => {
    await page.route('**/api/modules/installed', (route) => route.fulfill({ json: installedSnapshot }));
    await page.route('**/api/modules/operations/status', (route) => route.fulfill({ json: idleStatus }));
    await page.route('**/api/modules/available', (route) => route.fulfill({ json: {
      ...availableSnapshot,
      modules: [{ ...availableSnapshot.modules[0], name: '<img src=x onerror="window.catalogInjected=1">' }],
    } }));
    await page.goto('/modules');
    await page.getByRole('tab', { name: 'Доступные' }).click();
    await expect(page.getByRole('heading', { name: '<img src=x onerror="window.catalogInjected=1"> 2.10.0' })).toBeVisible();
    expect(await page.evaluate(() => window.catalogInjected || 0)).toBe(0);
    expect(await page.locator('#modules-card-host img').count()).toBe(0);
  });

  test('shows a per-tab badge only after an applicable update plan', async ({ page }) => {
    await page.route('**/api/modules/installed', (route) => route.fulfill({ json: installedSnapshot }));
    await page.route('**/api/modules/operations/status', (route) => route.fulfill({ json: idleStatus }));
    await page.goto('/modules');
    await expect(page.locator('.modules-summary')).toContainText('Xkeen UI 2.10.0');
    await page.evaluate(async () => {
      const badge = await import('/static/js/features/module_manager/badge.js');
      badge.reconcileModulesUpdatePlan({ operation: 'panel-update', applicable: true, source_version: '2.10.0', target_version: '2.11.0' });
    });
    await page.goto('/');
    await expect(page.locator('[data-xk-modules-update-badge]').first()).not.toHaveAttribute('hidden');
    await page.evaluate(async () => {
      const badge = await import('/static/js/features/module_manager/badge.js');
      badge.reconcileModulesUpdatePlan({ operation: 'panel-update', applicable: false, blockers: [{ code: 'panel_version_current' }] });
    });
    await expect(page.locator('[data-xk-modules-update-badge]').first()).toHaveAttribute('hidden', '');
  });

  test('retries initial loading without registering duplicate tab listeners', async ({ page }) => {
    await page.route('**/api/modules/installed', (route) => route.fulfill({ json: installedSnapshot }));
    await page.route('**/api/modules/operations/status', (route) => route.fulfill({ json: idleStatus }));
    await page.goto('/modules');
    const result = await page.evaluate(async () => {
      const { createModuleManagerController } = await import('/static/js/features/module_manager/controller.js');
      const root = document.createElement('div');
      root.innerHTML = '<button id="modules-tab-installed"></button><button id="modules-tab-available"></button><div id="modules-operation-status"></div><div id="modules-card-host"></div>';
      let listeners = 0;
      root.querySelectorAll('button').forEach((tab) => {
        const add = tab.addEventListener.bind(tab);
        tab.addEventListener = (...args) => { listeners += 1; return add(...args); };
      });
      let loads = 0;
      const api = {
        loadInstalled: () => (++loads === 1 ? Promise.reject({ message: 'Temporary failure' }) : Promise.resolve({ ok: true, panel_version: '2.10.0', modules: [] })),
        loadStatus: () => Promise.resolve({ ok: true, result: 'idle' }),
      };
      const controller = createModuleManagerController({ root, api, pollMs: 0 });
      await controller.init();
      await controller.init();
      return { loads, listeners };
    });
    expect(result).toEqual({ loads: 2, listeners: 2 });
  });
});

test.describe('Module lifecycle review', () => {
  for (const conflictAt of ['plan', 'apply']) {
    for (const statusUnavailable of [false, true]) {
      test(`reconciles ${conflictAt} operation conflict with ${statusUnavailable ? 'failed' : 'successful'} status fetch`, async ({ page }) => {
        let conflicted = false;
        let statusCalls = 0;
        await installIdleLifecycleRoutes(page);
        await page.route('**/api/modules/operations/status', (route) => {
          statusCalls += 1;
          return route.fulfill(conflicted && statusUnavailable
            ? { status: 503, json: { ok: false, code: 'module_status_unavailable' } }
            : { json: conflicted ? { ...runningStatus, operation_id: 'op-external' } : idleStatus });
        });
        await page.route('**/api/modules/operations/plan', (route) => {
          if (conflictAt === 'plan') conflicted = true;
          return route.fulfill(conflicted
            ? { status: 409, json: { ok: false, code: 'operation_in_progress' } }
            : { json: { ...installPlan, operation: 'panel-update', module_id: null } });
        });
        await page.route('**/api/modules/operations/apply', (route) => {
          conflicted = true;
          return route.fulfill({ status: 409, json: { ok: false, code: 'operation_in_progress' } });
        });
        await page.goto('/modules');
        await page.getByRole('button', { name: 'Обновить панель' }).click();
        if (conflictAt === 'apply') await page.getByRole('button', { name: 'Применить план' }).click();
        await expect(page.getByRole('dialog')).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Обновить панель' })).toBeDisabled();
        await expect.poll(() => statusCalls).toBeGreaterThan(1);
        if (statusUnavailable) {
          await expect(page.locator('#modules-error')).toContainText('module_status_unavailable');
          await expect(page.locator('#modules-refresh-status')).toBeVisible();
        } else {
          await expect(page.locator('#modules-operation-status')).toContainText('download');
          await expect(page.getByRole('button', { name: 'Отменить операцию' })).toBeEnabled();
          await expect.poll(() => statusCalls).toBeGreaterThan(2);
        }
      });
    }
  }

  test('ignores a pre-terminal catalog response that arrives after installed refresh', async ({ page }) => {
    let status = runningStatus;
    let releaseCatalog;
    let catalogCalls = 0;
    await installIdleLifecycleRoutes(page);
    await page.route('**/api/modules/operations/status', (route) => route.fulfill({ json: status }));
    await page.route('**/api/modules/available', async (route) => {
      catalogCalls += 1;
      if (catalogCalls === 1) {
        await new Promise((resolve) => { releaseCatalog = resolve; });
        return route.fulfill({ json: availableSnapshot });
      }
      return route.fulfill({ json: { ...availableSnapshot, modules: [] } });
    });
    await page.goto('/modules');
    await page.getByRole('tab', { name: 'Доступные' }).click();
    await expect.poll(() => Boolean(releaseCatalog)).toBe(true);
    status = { ...runningStatus, result: 'committed', step: 'done' };
    await expect(page.getByRole('tab', { name: 'Установленные' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('button', { name: 'Обновить панель' })).toBeEnabled();
    const staleResponse = page.waitForResponse('**/api/modules/available');
    releaseCatalog();
    await staleResponse;
    await page.getByRole('tab', { name: 'Доступные' }).click();
    await expect(page.getByText('Доступных модулей нет.')).toBeVisible();
    expect(catalogCalls).toBe(2);
  });

  test('discards catalog after terminal refresh and fetches fresh actions on next Available selection', async ({ page }) => {
    let status = idleStatus;
    let catalogCalls = 0;
    let installedCalls = 0;
    await installIdleLifecycleRoutes(page);
    await page.route('**/api/modules/installed', (route) => {
      installedCalls += 1;
      return route.fulfill({ json: installedSnapshot });
    });
    await page.route('**/api/modules/operations/status', (route) => route.fulfill({ json: status }));
    await page.route('**/api/modules/available', (route) => {
      catalogCalls += 1;
      return route.fulfill({ json: status.result === 'committed' ? {
        ...availableSnapshot, modules: [{ ...availableSnapshot.modules[0], lifecycle_actions: ['repair', 'remove'] }],
      } : availableSnapshot });
    });
    await page.route('**/api/modules/operations/plan', (route) => route.fulfill({ json: installPlan }));
    await page.route('**/api/modules/operations/apply', (route) => {
      status = { ...runningStatus, result: 'committed', step: 'done' };
      return route.fulfill({ status: 202, json: { ok: true, operation_id: status.operation_id, status } });
    });
    await page.goto('/modules');
    await page.getByRole('tab', { name: 'Доступные' }).click();
    await page.getByRole('button', { name: 'Установить Терминал' }).click();
    await page.getByRole('button', { name: 'Применить план' }).click();
    await expect(page.getByRole('tab', { name: 'Установленные' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('button', { name: 'Обновить панель' })).toBeEnabled();
    expect(installedCalls).toBe(2);
    expect(catalogCalls).toBe(1);
    await page.getByRole('tab', { name: 'Доступные' }).click();
    await expect(page.getByRole('button', { name: 'Восстановить Терминал' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Установить Терминал' })).toHaveCount(0);
    expect(catalogCalls).toBe(2);
  });

  test('resets dialog dismissal and operation cancel controls for a second plan', async ({ page }) => {
    let status = idleStatus;
    let applyCalls = 0;
    let cancelCalls = 0;
    await installIdleLifecycleRoutes(page);
    await page.route('**/api/modules/operations/status', (route) => route.fulfill({ json: status }));
    await page.route('**/api/modules/operations/plan', (route) => route.fulfill({ json: {
      ...installPlan, operation: 'panel-update', module_id: null, scope: 'panel',
    } }));
    await page.route('**/api/modules/operations/apply', (route) => {
      applyCalls += 1;
      status = { ...runningStatus, operation_id: `op-${applyCalls}`, result: applyCalls === 1 ? 'committed' : 'running' };
      return route.fulfill({ status: 202, json: { ok: true, operation_id: status.operation_id, status } });
    });
    await page.route('**/api/modules/operations/op-2/cancel', (route) => {
      cancelCalls += 1;
      return route.fulfill({ status: 202, json: { ok: true, operation_id: 'op-2', cancel_requested: true } });
    });
    await page.goto('/modules');
    await page.getByRole('button', { name: 'Обновить панель' }).click();
    await page.getByRole('button', { name: 'Применить план' }).click();
    await expect(page.getByRole('button', { name: 'Обновить панель' })).toBeEnabled();
    await page.getByRole('button', { name: 'Обновить панель' }).click();
    const dismiss = page.getByRole('dialog').getByRole('button', { name: 'Отменить', exact: true });
    await expect(dismiss).toBeEnabled();
    await dismiss.click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('button', { name: 'Обновить панель' }).click();
    await page.getByRole('button', { name: 'Применить план' }).click();
    await page.getByRole('button', { name: 'Отменить операцию' }).click();
    expect(applyCalls).toBe(2);
    expect(cancelCalls).toBe(1);
  });

  for (const { name, width, height } of [
    { name: 'desktop', width: 1440, height: 960 },
    { name: 'mobile', width: 390, height: 844 },
  ]) {
    test(`open plan dialog is centered and reachable on ${name}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await installIdleLifecycleRoutes(page);
      await page.route('**/api/modules/operations/plan', (route) => route.fulfill({ json: {
        ...installPlan, affected_module_ids: ['a'.repeat(120)],
      } }));
      await page.goto('/modules');
      await page.getByRole('tab', { name: 'Доступные' }).click();
      await page.getByRole('button', { name: 'Установить Терминал' }).click();
      const dialog = page.getByRole('dialog', { name: 'План установки' });
      await expect(dialog).toBeVisible();

      const geometry = await dialog.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return {
          viewportWidth: innerWidth, viewportHeight: innerHeight,
          left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
          centerOffset: (rect.left + rect.right - innerWidth) / 2,
          scrollWidth: element.scrollWidth, clientWidth: element.clientWidth,
        };
      });
      expect(Math.abs(geometry.centerOffset), JSON.stringify(geometry)).toBeLessThanOrEqual(2);
      expect(geometry.left).toBeGreaterThanOrEqual(0);
      expect(geometry.right).toBeLessThanOrEqual(width);
      expect(geometry.top).toBeGreaterThanOrEqual(0);
      expect(geometry.bottom).toBeLessThanOrEqual(height);
      expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
      await dialog.getByRole('button', { name: 'Применить план' }).scrollIntoViewIfNeeded();
      await expect(dialog.getByRole('button', { name: 'Применить план' })).toBeInViewport();
      await expect(dialog.getByRole('button', { name: 'Отменить' })).toBeInViewport();
      await page.screenshot({ path: `test-results/modules-plan-dialog-${name}.png` });
    });
  }

  test('retains apply result while inactive and resumes monitoring on activation', async ({ page }) => {
    let releaseApply;
    let statusLoads = 0;
    await installIdleLifecycleRoutes(page);
    await page.route('**/api/modules/operations/status', (route) => {
      statusLoads += 1;
      return route.fulfill({ json: statusLoads === 1 ? idleStatus : runningStatus });
    });
    await page.route('**/api/modules/operations/plan', (route) => route.fulfill({ json: installPlan }));
    await page.route('**/api/modules/operations/apply', async (route) => {
      await new Promise((resolve) => { releaseApply = resolve; });
      await route.fulfill({ status: 202, json: { ok: true, operation_id: 'op-123', status: runningStatus } });
    });
    await page.goto('/modules');
    await page.getByRole('tab', { name: 'Доступные' }).click();
    await page.getByRole('button', { name: 'Установить Терминал' }).click();
    await page.getByRole('button', { name: 'Применить план' }).click();
    await expect.poll(() => Boolean(releaseApply)).toBe(true);
    await page.evaluate(async () => {
      const { getModulesController } = await import('/static/js/pages/modules.init.js');
      getModulesController().deactivate();
    });
    const applied = page.waitForResponse('**/api/modules/operations/apply');
    releaseApply();
    await applied;
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(statusLoads).toBe(1);
    await page.evaluate(async () => {
      const { getModulesController } = await import('/static/js/pages/modules.init.js');
      await getModulesController().activate();
    });
    await expect(page.locator('#modules-operation-status')).toContainText('download');
    await expect.poll(() => statusLoads).toBeGreaterThan(1);
  });

  test('locks dismissal while reviewed plan is being applied', async ({ page }) => {
    let releaseApply;
    let applyCalls = 0;
    await installIdleLifecycleRoutes(page);
    await page.route('**/api/modules/operations/plan', (route) => route.fulfill({ json: installPlan }));
    await page.route('**/api/modules/operations/apply', async (route) => {
      applyCalls += 1;
      await new Promise((resolve) => { releaseApply = resolve; });
      await route.fulfill({ status: 202, json: { ok: true, operation_id: 'op-123', status: runningStatus } });
    });
    await page.goto('/modules');
    await page.getByRole('tab', { name: 'Доступные' }).click();
    await page.getByRole('button', { name: 'Установить Терминал' }).click();
    await page.getByRole('button', { name: 'Применить план' }).click();
    await expect.poll(() => Boolean(releaseApply)).toBe(true);
    await expect(page.getByRole('button', { name: 'Отменить', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'План установки' })).toBeVisible();
    expect(applyCalls).toBe(1);
    releaseApply();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('requires a reviewed server plan before apply and returns focus on dismissal', async ({ page }) => {
    const planBodies = [];
    const applyBodies = [];
    await installIdleLifecycleRoutes(page);
    await page.route('**/api/modules/operations/plan', (route) => {
      planBodies.push(route.request().postDataJSON());
      return route.fulfill({ json: installPlan });
    });
    await page.route('**/api/modules/operations/apply', (route) => {
      applyBodies.push(route.request().postDataJSON());
      return route.fulfill({ status: 202, json: { ok: true, operation_id: 'op-123', status: runningStatus } });
    });

    await page.goto('/modules');
    await page.getByRole('tab', { name: 'Доступные' }).click();
    const install = page.getByRole('button', { name: 'Установить Терминал' });
    await install.click();
    const dialog = page.getByRole('dialog', { name: 'План установки' });
    await expect(dialog).toContainText('Нужно места: 12 МБ');
    await expect(dialog).toContainText('tool.terminal');
    await expect(page.locator('#modules-plan-title')).toBeFocused();
    expect(planBodies).toEqual([{ operation: 'install', module_id: 'tool.terminal' }]);
    expect(applyBodies).toEqual([]);
    await dialog.getByRole('button', { name: 'Отменить' }).click();
    await expect(install).toBeFocused();

    await install.click();
    await dialog.getByRole('button', { name: 'Применить план' }).click();
    await expect(page.locator('#modules-operation-status')).toContainText('download');
    expect(applyBodies).toEqual([{ operation: 'install', module_id: 'tool.terminal', plan_id: 'a'.repeat(64) }]);
    await expect(install).toBeDisabled();
  });

  test('keeps a blocked plan visible without an apply action', async ({ page }) => {
    await installIdleLifecycleRoutes(page);
    await page.route('**/api/modules/operations/plan', (route) => route.fulfill({ json: {
      ...installPlan, applicable: false, plan_id: null,
      blockers: [{ code: 'module_dependency_missing', message: 'Не хватает зависимости' }],
    } }));
    await page.goto('/modules');
    await page.getByRole('tab', { name: 'Доступные' }).click();
    await page.getByRole('button', { name: 'Установить Терминал' }).click();
    const dialog = page.getByRole('dialog', { name: 'План установки' });
    await expect(dialog).toContainText('Не хватает зависимости');
    await expect(dialog.getByRole('button', { name: 'Применить план' })).toHaveCount(0);
  });

  test('installer-only stable panel update cannot reach apply', async ({ page }) => {
    let applyCalls = 0;
    await installIdleLifecycleRoutes(page);
    await page.route('**/api/modules/operations/plan', (route) => route.fulfill({
      status: 409, json: { ok: false, code: 'panel_update_requires_installer',
        details: { min_updater: '2.10.5', current_version: '2.10.0' } },
    }));
    await page.route('**/api/modules/operations/apply', (route) => {
      applyCalls += 1;
      return route.fulfill({ json: { ok: true } });
    });
    await page.goto('/modules');
    await page.getByRole('button', { name: 'Обновить панель' }).click();

    await expect(page.locator('#modules-error')).toContainText('panel_update_requires_installer');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(applyCalls).toBe(0);
  });

  for (const code of ['module_plan_stale', 'operation_plan_stale']) {
    test(`discards ${code} and requires a new review`, async ({ page }) => {
      const catalog = code === 'operation_plan_stale' ? null : availableSnapshot;
      const plan = code === 'operation_plan_stale'
        ? { ...installPlan, operation: 'panel-update', module_id: null, scope: 'panel', source_version: '2.10.0', target_version: '2.11.0' }
        : installPlan;
      const bodies = [];
      await installIdleLifecycleRoutes(page);
      await page.route('**/api/modules/operations/plan', (route) => route.fulfill({ json: plan }));
      await page.route('**/api/modules/operations/apply', (route) => {
        bodies.push(route.request().postDataJSON());
        return route.fulfill({ status: 409, json: { ok: false, code, message: 'План устарел' } });
      });
      await page.goto('/modules');
      if (catalog) await page.getByRole('tab', { name: 'Доступные' }).click();
      await page.getByRole('button', { name: catalog ? 'Установить Терминал' : 'Обновить панель' }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Применить план' }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.locator('#modules-error')).toContainText('План устарел');
      expect(bodies).toHaveLength(1);
    });
  }

  test('clears update badge when server says panel version is current', async ({ page }) => {
    await installIdleLifecycleRoutes(page);
    await page.addInitScript(() => sessionStorage.setItem('xkeen.modules.update.v1', JSON.stringify({
      schema: 1, sourceVersion: '2.10.0', targetVersion: '2.11.0',
    })));
    await page.route('**/api/modules/operations/plan', (route) => route.fulfill({ json: {
      ...installPlan, operation: 'panel-update', module_id: null, scope: 'panel', applicable: false,
      plan_id: null, blockers: [{ code: 'panel_version_current', message: 'Обновлений нет' }],
    } }));
    await page.goto('/modules');
    await page.getByRole('button', { name: 'Обновить панель' }).click();
    await expect(page.getByRole('dialog')).toContainText('Обновлений нет');
    expect(await page.evaluate(() => sessionStorage.getItem('xkeen.modules.update.v1'))).toBeNull();
  });

  test('sets update badge only after an applicable newer panel plan', async ({ page }) => {
    await installIdleLifecycleRoutes(page);
    await page.route('**/api/modules/operations/plan', (route) => route.fulfill({ json: {
      ...installPlan, operation: 'panel-update', module_id: null, scope: 'panel',
      source_version: '2.10.0', target_version: '2.11.0',
    } }));
    await page.goto('/modules');
    expect(await page.evaluate(() => sessionStorage.getItem('xkeen.modules.update.v1'))).toBeNull();
    await page.getByRole('button', { name: 'Обновить панель' }).click();
    await expect(page.getByRole('dialog', { name: 'План обновления панели' })).toContainText('2.11.0');
    expect(JSON.parse(await page.evaluate(() => sessionStorage.getItem('xkeen.modules.update.v1')))).toEqual({
      schema: 1, sourceVersion: '2.10.0', targetVersion: '2.11.0',
    });
  });

  test('monitors running operation, requests cancel, and refreshes installed at terminal', async ({ page }) => {
    let installedLoads = 0;
    let statusLoads = 0;
    let terminal = false;
    let cancelCalls = 0;
    await page.route('**/api/modules/installed', (route) => {
      installedLoads += 1;
      return route.fulfill({ json: installedSnapshot });
    });
    await page.route('**/api/modules/operations/status', (route) => {
      statusLoads += 1;
      return route.fulfill({ json: statusLoads === 1 || !terminal ? runningStatus : {
        ...runningStatus, result: 'committed', step: 'done', finished_at: 1781000002,
      } });
    });
    await page.route('**/api/modules/operations/op-123/cancel', (route) => {
      cancelCalls += 1;
      return route.fulfill({ status: 202, json: { ok: true, operation_id: 'op-123', cancel_requested: true } });
    });
    await page.route('**/api/modules/operations/plan', (route) => route.fulfill({ json: {
      ...installPlan, operation: 'panel-update', module_id: null, scope: 'panel',
      source_version: '2.10.0', target_version: '2.11.0',
    } }));
    await page.route('**/api/modules/operations/apply', (route) => route.fulfill({ status: 202, json: {
      ok: true, operation_id: 'op-456', status: {
        ...runningStatus, operation_id: 'op-456', operation: 'panel-update', module_id: null,
      },
    } }));
    await page.goto('/modules');
    await expect(page.locator('#modules-operation-status')).toContainText('download');
    await page.getByRole('button', { name: 'Отменить операцию' }).click();
    expect(cancelCalls).toBe(1);
    await expect(page.locator('#modules-operation-status')).toContainText('download');
    terminal = true;
    await expect(page.locator('#modules-operation-status')).toContainText('committed');
    await expect.poll(() => installedLoads).toBe(2);
    await expect.poll(() => statusLoads).toBeGreaterThanOrEqual(3);
    await page.getByRole('button', { name: 'Обновить панель' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Применить план' }).click();
    await expect(page.getByRole('button', { name: 'Отменить операцию' })).toBeEnabled();
  });
});

import { test, expect } from './fixtures.mjs';

const installedSnapshot = {
  ok: true,
  panel_version: '2.10.0',
  profile: 'mihomo-minimal',
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
      await expect(page.locator('#modules-operation-status')).toContainText('План устарел');
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

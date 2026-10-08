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
    { id: 'engine.mihomo', name: 'Mihomo', version: '1.19.0', enabled: false, can_disable: true },
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
    expect(initialCalls.sort()).toEqual(['installed', 'status']);
    expect(availableCalls).toBe(0);

    await page.getByRole('tab', { name: 'Доступные' }).click();
    await expect(page.getByText('Терминал')).toBeVisible();
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
    await expect(page.getByText('<img src=x onerror="window.catalogInjected=1">')).toBeVisible();
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

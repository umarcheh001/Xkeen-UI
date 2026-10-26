import { test, expect } from './fixtures.mjs';
import {
  server, installedSnapshot, idleStatus, availableSnapshot, installPlan, panelUpdatePlan, runningStatus,
  committedStatus, TERMINAL, installIdleLifecycleRoutes, routePlans, installPanelPrepareRoutes, prepareStep,
} from './modules_manager_support.mjs';

// The Modules window: a plan is reviewed, applied and followed in its window.

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
        await routePlans(page, () => {
          if (conflictAt === 'plan') conflicted = true;
          return conflicted
            ? { status: 409, json: { ok: false, code: 'operation_in_progress' } }
            : { json: panelUpdatePlan };
        });
        await page.route('**/api/modules/operations/apply', (route) => {
          conflicted = true;
          return route.fulfill({ status: 409, json: { ok: false, code: 'operation_in_progress' } });
        });
        await page.goto('/modules');
        await page.getByRole('button', { name: 'Обновить панель' }).click();
        if (conflictAt === 'apply') await page.getByRole('dialog').getByRole('button', { name: 'Обновить', exact: true }).click();
        await expect(page.getByRole('dialog')).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Обновить панель' })).toBeDisabled();
        await expect.poll(() => statusCalls).toBeGreaterThan(1);
        if (statusUnavailable) {
          await expect(page.locator('#modules-error .modules-page-alert')).toHaveAttribute('data-code', 'module_status_unavailable');
          await expect(page.locator('#modules-error .modules-page-alert-retry')).toBeVisible();
        } else {
          await expect(page.locator('#modules-operation-status')).toContainText('Загрузка архива');
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
    status = server.cancelled;
    await expect(page.getByRole('tab', { name: 'Установленные' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('button', { name: 'Обновить панель' })).toBeEnabled();
    const staleResponse = page.waitForResponse('**/api/modules/available');
    releaseCatalog();
    await staleResponse;
    await page.getByRole('tab', { name: 'Доступные' }).click();
    await expect(page.getByText('Доступных модулей нет.')).toBeVisible();
    expect(catalogCalls).toBe(2);
  });

  test('loads the page anew after a confirmed installation and shows the module as installed', async ({ page }) => {
    let status = idleStatus;
    let catalogCalls = 0;
    await installIdleLifecycleRoutes(page);
    await page.route('**/api/modules/installed', (route) => route.fulfill({
      json: status.result === 'committed' ? server.installed_after_install : installedSnapshot,
    }));
    await page.route('**/api/modules/operations/status', (route) => route.fulfill({ json: status }));
    await page.route('**/api/modules/available', (route) => {
      catalogCalls += 1;
      return route.fulfill({ json: status.result === 'committed' ? server.available_after_install : availableSnapshot });
    });
    await routePlans(page, () => ({ json: installPlan }));
    await page.route('**/api/modules/operations/apply', (route) => {
      status = server.install_steps.prepared;
      return route.fulfill({ status: 202, json: { ok: true, operation_id: status.operation_id, status } });
    });
    await page.goto('/modules');
    await page.evaluate(() => { window.xkBeforeInstall = true; });
    await page.getByRole('tab', { name: 'Доступные' }).click();
    await page.getByRole('button', { name: `Установить ${TERMINAL}` }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Установить', exact: true }).click();
    // The operation goes on in the window it was planned in.
    await expect(dialog.locator('.modules-plan-progress-head strong')).toHaveText('Подготовка');
    await expect(dialog.locator('.modules-plan-progress-head output')).toHaveText('1 из 7');
    await expect(dialog.getByRole('button', { name: 'Установка…' })).toBeDisabled();
    await expect(page.locator('#modules-operation-status')).toContainText('Сейчас: Подготовка');

    // The runner restarted the panel on the way: the page must not go on with the old scripts.
    status = committedStatus;
    // A question asked while the page is being reloaded counts as "not yet".
    await expect.poll(() => page.evaluate(() => window.xkBeforeInstall === true).catch(() => true), { timeout: 15000 }).toBe(false);
    // After the reload the window opens again and tells how it ended.
    await expect(page.getByRole('dialog', { name: `«${TERMINAL}» установлен` })).toBeVisible();
    await expect(dialog.locator('.modules-plan-progress-head output')).toHaveText('7 из 7');
    await expect(dialog.locator('.modules-plan-steps li[data-state="done"]')).toHaveCount(7);
    await dialog.getByRole('button', { name: 'Готово' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await page.evaluate(() => sessionStorage.getItem('xkeen.modules.operationDialog.v1'))).toBeNull();
    await expect(page.locator('.modules-module').filter({ hasText: TERMINAL })).toBeVisible();
    // The window has told how it ended: the page keeps no report of a success.
    await expect(page.locator('#modules-operation-status .modules-operation')).toHaveCount(0);
    expect(catalogCalls).toBe(1);
    await page.getByRole('tab', { name: 'Доступные' }).click();
    const card = page.locator('#modules-card-host .modules-card').filter({ hasText: TERMINAL });
    await expect(card.locator('.modules-chip')).toHaveText('Установлен');
    await expect(card.getByRole('button')).toHaveCount(0);
    expect(catalogCalls).toBe(2);
  });

  test('resets dialog dismissal and operation cancel controls for a second plan', async ({ page }) => {
    let status = idleStatus;
    let applyCalls = 0;
    let cancelCalls = 0;
    await installIdleLifecycleRoutes(page);
    await page.route('**/api/modules/operations/status', (route) => route.fulfill({ json: status }));
    await routePlans(page, () => ({ json: panelUpdatePlan }));
    await page.route('**/api/modules/operations/apply', (route) => {
      applyCalls += 1;
      status = { ...server.install_steps.prepared, operation_id: `op-${applyCalls}` };
      return route.fulfill({ status: 202, json: { ok: true, operation_id: status.operation_id, status } });
    });
    await page.route('**/api/modules/operations/op-2/cancel', (route) => {
      cancelCalls += 1;
      return route.fulfill({ status: 202, json: { ok: true, operation_id: 'op-2', cancel_requested: true } });
    });
    await page.goto('/modules');
    const dialog = page.getByRole('dialog');
    await page.getByRole('button', { name: 'Обновить панель' }).click();
    await dialog.getByRole('button', { name: 'Обновить', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Отменить операцию' })).toBeEnabled();
    status = { ...server.cancelled, operation_id: 'op-1' };
    await expect(dialog.locator('.modules-plan-progress-head strong')).toHaveText('Прервана');
    await dialog.getByRole('button', { name: 'Закрыть', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Обновить панель' })).toBeEnabled();
    await page.getByRole('button', { name: 'Обновить панель' }).click();
    const dismiss = dialog.getByRole('button', { name: 'Отмена', exact: true });
    await expect(dismiss).toBeEnabled();
    await dismiss.click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('button', { name: 'Обновить панель' }).click();
    await dialog.getByRole('button', { name: 'Обновить', exact: true }).click();
    await dialog.getByRole('button', { name: 'Отменить операцию' }).click();
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
      await page.getByRole('button', { name: `Установить ${TERMINAL}` }).click();
      const dialog = page.getByRole('dialog', { name: `Установить «${TERMINAL}»` });
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
      await dialog.getByRole('button', { name: 'Установить', exact: true }).scrollIntoViewIfNeeded();
      await expect(dialog.getByRole('button', { name: 'Установить', exact: true })).toBeInViewport();
      await expect(dialog.getByRole('button', { name: 'Отмена' })).toBeInViewport();
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
    await routePlans(page, () => ({ json: installPlan }));
    await page.route('**/api/modules/operations/apply', async (route) => {
      await new Promise((resolve) => { releaseApply = resolve; });
      await route.fulfill({ status: 202, json: { ok: true, operation_id: runningStatus.operation_id, status: server.install_steps.prepared } });
    });
    await page.goto('/modules');
    await page.getByRole('tab', { name: 'Доступные' }).click();
    await page.getByRole('button', { name: `Установить ${TERMINAL}` }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Установить', exact: true }).click();
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
    await expect(page.locator('#modules-operation-status')).toContainText('Загрузка архива');
    await expect.poll(() => statusLoads).toBeGreaterThan(1);
  });

  test('locks dismissal while reviewed plan is being applied', async ({ page }) => {
    let releaseApply;
    let applyCalls = 0;
    await installIdleLifecycleRoutes(page);
    await routePlans(page, () => ({ json: installPlan }));
    await page.route('**/api/modules/operations/apply', async (route) => {
      applyCalls += 1;
      await new Promise((resolve) => { releaseApply = resolve; });
      await route.fulfill({ status: 202, json: { ok: true, operation_id: runningStatus.operation_id, status: server.install_steps.prepared } });
    });
    await page.goto('/modules');
    await page.getByRole('tab', { name: 'Доступные' }).click();
    await page.getByRole('button', { name: `Установить ${TERMINAL}` }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Установить', exact: true }).click();
    await expect.poll(() => Boolean(releaseApply)).toBe(true);
    await expect(page.getByRole('button', { name: 'Отмена', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    const dialog = page.getByRole('dialog', { name: `Установить «${TERMINAL}»` });
    await expect(dialog).toBeVisible();
    expect(applyCalls).toBe(1);
    releaseApply();
    // The plan turns into the operation: the window stays and can be folded away.
    await expect(dialog.locator('.modules-plan-progress')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Свернуть' })).toBeEnabled();
    await dialog.getByRole('button', { name: 'Свернуть' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('#modules-operation-status')).toContainText('Подготовка');
  });

  test('requires a reviewed server plan before apply and returns focus on dismissal', async ({ page }) => {
    const planBodies = [];
    const applyBodies = [];
    await installIdleLifecycleRoutes(page);
    await page.route('**/api/modules/operations/status', (route) => route.fulfill({ json: applyBodies.length ? runningStatus : idleStatus }));
    await page.route('**/api/modules/operations/plan', (route) => {
      planBodies.push(route.request().postDataJSON());
      return route.fulfill({ json: installPlan });
    });
    await page.route('**/api/modules/operations/apply', (route) => {
      applyBodies.push(route.request().postDataJSON());
      return route.fulfill({ status: 202, json: { ok: true, operation_id: runningStatus.operation_id, status: server.install_steps.prepared } });
    });

    await page.goto('/modules');
    await page.getByRole('tab', { name: 'Доступные' }).click();
    const install = page.getByRole('button', { name: `Установить ${TERMINAL}` });
    await install.click();
    const dialog = page.getByRole('dialog', { name: `Установить «${TERMINAL}»` });
    await expect(dialog).toContainText('нужно 12 МБ');
    await expect(dialog.locator('.modules-plan-facts dd').first()).toHaveText(TERMINAL);
    await expect(dialog).not.toContainText('tool.terminal');
    await expect(page.locator('#modules-plan-title')).toBeFocused();
    expect(planBodies).toEqual([{ operation: 'install', module_id: 'tool.terminal' }]);
    expect(applyBodies).toEqual([]);
    await dialog.getByRole('button', { name: 'Отмена' }).click();
    await expect(install).toBeFocused();

    await install.click();
    await dialog.getByRole('button', { name: 'Установить', exact: true }).click();
    await expect(page.locator('#modules-operation-status')).toContainText('Загрузка архива');
    expect(applyBodies).toEqual([{ operation: 'install', module_id: 'tool.terminal', plan_id: installPlan.plan_id }]);
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
    await page.getByRole('button', { name: `Установить ${TERMINAL}` }).click();
    const dialog = page.getByRole('dialog', { name: `Установить «${TERMINAL}»` });
    await expect(dialog).toContainText('Не хватает зависимости');
    await expect(dialog).toContainText('применить его сейчас нельзя');
    await expect(dialog.getByRole('button', { name: 'Установить', exact: true })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Закрыть', exact: true })).toBeVisible();
    // The plan is asked for again from the same window.
    const planned = page.waitForRequest('**/api/modules/operations/plan');
    await dialog.getByRole('button', { name: 'Проверить снова' }).click();
    await planned;
    await expect(dialog).toContainText('Не хватает зависимости');
  });

  test('buttons of the catalog and of the window have the size of the summary buttons', async ({ page }) => {
    await installIdleLifecycleRoutes(page);
    await routePlans(page, () => ({ json: installPlan }));
    await page.goto('/modules');
    const summarySize = await page.locator('.xk-summary-actions button').first()
      .evaluate((element) => getComputedStyle(element).fontSize);
    await page.getByRole('tab', { name: 'Доступные' }).click();
    const install = page.getByRole('button', { name: `Установить ${TERMINAL}` });
    expect(await install.evaluate((element) => getComputedStyle(element).fontSize)).toBe(summarySize);
    await install.click();
    const apply = page.getByRole('dialog').getByRole('button', { name: 'Установить', exact: true });
    expect(await apply.evaluate((element) => getComputedStyle(element).fontSize)).toBe(summarySize);
    expect(summarySize).toBe('12.5px');
  });

  test('installer-only stable panel update cannot reach apply', async ({ page }) => {
    let applyCalls = 0;
    await installIdleLifecycleRoutes(page);
    // The refusal comes at the end of the preparation and is said in its window.
    await installPanelPrepareRoutes(page, { steps: [prepareStep({
      state: 'failed', phase: 'catalog', finished_at: 1004,
      error: { code: 'panel_update_requires_installer', message: 'panel update requires the installer' },
    })] });
    await page.route('**/api/modules/operations/apply', (route) => {
      applyCalls += 1;
      return route.fulfill({ json: { ok: true } });
    });
    await page.goto('/modules');
    await page.getByRole('button', { name: 'Обновить панель' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog.locator('.modules-plan-error')).toContainText('Обновление не подготовлено.');
    await expect(dialog.locator('.modules-plan-progress-box')).toHaveClass(/is-bad/);
    await expect(dialog.locator('#modules-plan-apply')).toBeHidden();
    expect(applyCalls).toBe(0);
  });

  for (const code of ['module_plan_stale', 'operation_plan_stale']) {
    test(`discards ${code} and requires a new review`, async ({ page }) => {
      const catalog = code === 'operation_plan_stale' ? null : availableSnapshot;
      const plan = code === 'operation_plan_stale'
        ? panelUpdatePlan
        : installPlan;
      const bodies = [];
      await installIdleLifecycleRoutes(page);
      await routePlans(page, () => ({ json: plan }));
      await page.route('**/api/modules/operations/apply', (route) => {
        bodies.push(route.request().postDataJSON());
        return route.fulfill({ status: 409, json: { ok: false, code, message: 'План устарел' } });
      });
      await page.goto('/modules');
      if (catalog) await page.getByRole('tab', { name: 'Доступные' }).click();
      await page.getByRole('button', { name: catalog ? `Установить ${TERMINAL}` : 'Обновить панель' }).click();
      await page.getByRole('dialog').getByRole('button', { name: catalog ? 'Установить' : 'Обновить', exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.locator('#modules-error')).toContainText('План устарел');
      expect(bodies).toHaveLength(1);
    });
  }

  test('clears update badge when server says panel version is current', async ({ page }) => {
    await installIdleLifecycleRoutes(page);
    await page.addInitScript(() => sessionStorage.setItem('xkeen.modules.update.v2', JSON.stringify({
      schema: 2, sourceVersion: '2.10.0', targetVersion: '2.11.0', channel: 'stable',
    })));
    await routePlans(page, () => ({ json: server.panel_update_current }));
    await page.goto('/modules');
    await page.getByRole('button', { name: 'Обновить панель' }).click();
    // A current panel is an answer, not a plan with nothing in it: the counter
    // says so and the button that has nothing to lay goes away.
    await expect(page.locator('.modules-summary .xk-summary-stat[data-stat="update"] span')).toHaveText('версия актуальна');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('#modules-error')).toBeEmpty();
    await expect(page.getByRole('button', { name: 'Обновить панель' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Проверить ещё раз' })).toBeEnabled();
    expect(await page.evaluate(() => sessionStorage.getItem('xkeen.modules.update.v2'))).toBeNull();
  });

  test('sets update badge only after an applicable newer panel plan', async ({ page }) => {
    await installIdleLifecycleRoutes(page);
    await routePlans(page, () => ({ json: panelUpdatePlan }));
    await page.goto('/modules');
    expect(await page.evaluate(() => sessionStorage.getItem('xkeen.modules.update.v2'))).toBeNull();
    await page.getByRole('button', { name: 'Обновить панель' }).click();
    await expect(page.getByRole('dialog', { name: 'Обновить панель до 2.11.0' })).toContainText('2.11.0');
    expect(JSON.parse(await page.evaluate(() => sessionStorage.getItem('xkeen.modules.update.v2')))).toEqual({
      schema: 2, sourceVersion: '2.10.0', targetVersion: '2.11.0', channel: 'stable',
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
      return route.fulfill({ json: statusLoads === 1 || !terminal ? runningStatus : server.cancelled });
    });
    await page.route(`**/api/modules/operations/${runningStatus.operation_id}/cancel`, (route) => {
      cancelCalls += 1;
      return route.fulfill({ status: 202, json: { ok: true, operation_id: runningStatus.operation_id, cancel_requested: true } });
    });
    await routePlans(page, () => ({ json: panelUpdatePlan }));
    await page.route('**/api/modules/operations/apply', (route) => route.fulfill({ status: 202, json: {
      ok: true, operation_id: 'op-456', status: {
        ...runningStatus, operation_id: 'op-456', operation: 'panel-update', module_id: null,
      },
    } }));
    await page.goto('/modules');
    await expect(page.locator('#modules-operation-status')).toContainText('Загрузка архива');
    await page.getByRole('button', { name: 'Отменить операцию' }).click();
    expect(cancelCalls).toBe(1);
    await expect(page.locator('#modules-operation-status')).toContainText('Загрузка архива');
    terminal = true;
    await expect(page.locator('#modules-operation-status')).toContainText('Операция отменена');
    await expect.poll(() => installedLoads).toBe(2);
    await expect.poll(() => statusLoads).toBeGreaterThanOrEqual(3);
    await page.getByRole('button', { name: 'Обновить панель' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Обновить', exact: true }).click();
    await expect(page.getByRole('dialog').getByRole('button', { name: 'Отменить операцию' })).toBeEnabled();
  });
});

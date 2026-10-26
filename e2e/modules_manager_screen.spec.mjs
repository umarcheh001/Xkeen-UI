import { test, expect } from './fixtures.mjs';
import {
  server, installedSnapshot, idleStatus, availableSnapshot, panelUpdatePlan, runningStatus, terminalEntry,
  TERMINAL, withMihomo, installIdleLifecycleRoutes, installLifecycleRoutes, advanceClock, restartStatus,
  routePlans,
} from './modules_manager_support.mjs';

// The Modules window: how the screen looks, a local build, coming back to the
// screen, the first loading and redrawing only for a reason.

test.describe('Module manager screen', () => {
  test('keeps the modules header comfortably inset with the shared theme action', async ({ page }) => {
    await page.setViewportSize({ width: 1800, height: 1300 });
    await installIdleLifecycleRoutes(page);
    await page.goto('/modules');

    const geometry = await page.locator('header.modules-header').evaluate((header) => {
      const headerRect = header.getBoundingClientRect();
      const titleRect = header.querySelector('h1').getBoundingClientRect();
      const logoutRect = header.querySelector('.xk-header-btn-logout').getBoundingClientRect();
      const theme = header.querySelector('#theme-toggle-btn');
      const themeRect = theme.getBoundingClientRect();
      const backRect = header.querySelector('a[href="/"]').getBoundingClientRect();
      return {
        titleInset: titleRect.left - headerRect.left,
        logoutInset: headerRect.right - logoutRect.right,
        themeHeight: themeRect.height,
        themeLabel: theme.querySelector('.theme-toggle-text').getBoundingClientRect().width,
        backHeight: backRect.height,
      };
    });

    expect(geometry.titleInset, JSON.stringify(geometry)).toBeGreaterThanOrEqual(18);
    expect(geometry.logoutInset, JSON.stringify(geometry)).toBeGreaterThanOrEqual(18);
    // Same theme action as DevTools and the generator: icon and label.
    expect(geometry.themeLabel, JSON.stringify(geometry)).toBeGreaterThan(0);
    expect(Math.abs(geometry.themeHeight - geometry.backHeight), JSON.stringify(geometry)).toBeLessThanOrEqual(2);
  });

  test('puts the theme icon before its label and uses the compact settings switch geometry', async ({ page }) => {
    await installIdleLifecycleRoutes(page);
    await page.goto('/modules');

    const layout = await page.locator('header.modules-header').evaluate((header) => {
      const theme = header.querySelector('#theme-toggle-btn');
      const icon = theme.querySelector('.theme-toggle-icon');
      const label = theme.querySelector('.theme-toggle-text');
      const slider = document.querySelector('.modules-switch .dt-switch-slider');
      const state = document.querySelector('.modules-switch-state');
      const themeRect = theme.getBoundingClientRect();
      const iconRect = icon.getBoundingClientRect();
      const sliderRect = slider.getBoundingClientRect();
      const stateRect = state.getBoundingClientRect();
      return {
        iconMiddleOffset: (iconRect.top + iconRect.height / 2) - (themeRect.top + themeRect.height / 2),
        iconBeforeLabel: iconRect.right <= label.getBoundingClientRect().left,
        sliderWidth: sliderRect.width,
        sliderHeight: sliderRect.height,
        sliderBackground: getComputedStyle(slider).backgroundColor,
        stateText: state.textContent,
        stateWidth: stateRect.width,
      };
    });

    expect(Math.abs(layout.iconMiddleOffset), JSON.stringify(layout)).toBeLessThanOrEqual(1);
    expect(layout.iconBeforeLabel, JSON.stringify(layout)).toBe(true);
    expect(layout.sliderWidth, JSON.stringify(layout)).toBeLessThanOrEqual(30);
    expect(layout.sliderHeight, JSON.stringify(layout)).toBeLessThanOrEqual(16);
    // The switch of the main panel: no green, no words beside the slider; the
    // state is still said to screen readers.
    expect(layout.sliderBackground, JSON.stringify(layout)).not.toBe('rgb(62, 174, 120)');
    expect(layout.stateText, JSON.stringify(layout)).toMatch(/^(Включён|Выключен)$/);
    expect(layout.stateWidth, JSON.stringify(layout)).toBeLessThanOrEqual(1);
  });

  test('keeps module navigation inside the compact operator header', async ({ page }) => {
    await page.setViewportSize({ width: 1800, height: 1300 });
    await installIdleLifecycleRoutes(page);
    await page.goto('/modules');

    const layout = await page.locator('header.modules-header').evaluate((header) => {
      const main = header.querySelector('.modules-header-main');
      const tabs = header.querySelector('.modules-tabs');
      const tabsRect = tabs?.getBoundingClientRect();
      const activeTab = tabs?.querySelector('.top-tab-btn.active');
      return {
        tabsWithinHeader: Boolean(tabs),
        tabsAfterMain: Boolean(main && tabs && main.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING),
        tabsTop: tabsRect?.top ?? null,
        mainBottom: main?.getBoundingClientRect().bottom ?? null,
        activeTabRadius: activeTab ? Number.parseFloat(getComputedStyle(activeTab).borderRadius) : null,
      };
    });

    expect(layout.tabsWithinHeader, JSON.stringify(layout)).toBe(true);
    expect(layout.tabsAfterMain, JSON.stringify(layout)).toBe(true);
    expect(layout.tabsTop, JSON.stringify(layout)).toBeGreaterThanOrEqual(layout.mainBottom);
    expect(layout.activeTabRadius, JSON.stringify(layout)).toBeLessThanOrEqual(6);
  });

  test('a tile keeps its switch and menu on the line of its name', async ({ page }) => {
    // 16.10.2026: in a row stretched across the screen the switch stood far
    // from the name. A tile keeps them together; restore and remove live in «⋯».
    await page.setViewportSize({ width: 1800, height: 1300 });
    await installIdleLifecycleRoutes(page);
    await page.goto('/modules');

    const tile = page.locator('.modules-tile[data-module-id="engine.mihomo"]');
    await expect(tile.getByRole('switch')).toBeAttached();
    await expect(tile.getByRole('button', { name: 'Восстановить Mihomo' })).toBeHidden();
    await tile.getByLabel('Действия: Mihomo').click();
    await expect(tile.getByRole('button', { name: 'Восстановить Mihomo' })).toBeVisible();
    await expect(tile).toContainText('Нужен для работы: Xkeen UI Core');
    const geometry = await tile.evaluate((element) => {
      const box = (selector) => element.querySelector(selector).getBoundingClientRect();
      const name = box('.modules-tile-name');
      const slider = box('.modules-switch .dt-switch-slider');
      return {
        gap: Math.round(slider.left - name.right),
        tileWidth: Math.round(element.getBoundingClientRect().width),
        sliderMiddle: slider.top + slider.height / 2,
        topMiddle: box('.modules-tile-top').top + box('.modules-tile-top').height / 2,
      };
    });
    expect(geometry.gap, JSON.stringify(geometry)).toBeGreaterThan(0);
    expect(geometry.gap, JSON.stringify(geometry)).toBeLessThan(geometry.tileWidth);
    expect(Math.abs(geometry.sliderMiddle - geometry.topMiddle), JSON.stringify(geometry)).toBeLessThanOrEqual(2);

    // A click elsewhere closes the menu, as every panel menu does.
    await page.locator('.modules-list-header').click();
    await expect(tile.getByRole('button', { name: 'Восстановить Mihomo' })).toBeHidden();
  });

  test('module icons stand in one column and Core is framed like a tile on a phone', async ({ page }) => {
    await installIdleLifecycleRoutes(page);
    for (const width of [1600, 1100, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto('/modules');
      const geometry = await page.evaluate(() => {
        const left = (selector) => document.querySelector(selector).getBoundingClientRect().left;
        const core = document.querySelector('.modules-core');
        return {
          offset: Math.round(left('.modules-core .modules-module-icon') - left('.modules-tile .modules-module-icon')),
          coreBorder: getComputedStyle(core).borderTopWidth,
          columns: getComputedStyle(document.querySelector('.modules-grid')).gridTemplateColumns.split(' ').length,
        };
      });
      expect(geometry.offset, `${width}: ${JSON.stringify(geometry)}`).toBe(0);
      expect(geometry.coreBorder, `${width}: ${JSON.stringify(geometry)}`).toBe(width <= 700 ? '1px' : '0px');
      expect(geometry.columns, `${width}: ${JSON.stringify(geometry)}`).toBe(width > 1300 ? 4 : width > 700 ? 2 : 1);
    }
  });

  test('uses neutral dashboard surfaces in the dark theme', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('xkeen-theme', 'dark'));
    await installIdleLifecycleRoutes(page);
    await page.goto('/modules');

    const colors = await page.evaluate(() => {
      const color = (selector) => getComputedStyle(document.querySelector(selector)).backgroundColor;
      return {
        body: getComputedStyle(document.body).backgroundColor,
        header: color('.modules-header'),
        card: color('.modules-summary'),
      };
    });

    expect(colors).toEqual({
      body: 'rgb(13, 15, 19)',
      header: 'rgb(20, 23, 28)',
      card: 'rgb(20, 23, 28)',
    });
  });

  test('uses compact operator typography and indigo actions in the modules header', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('xkeen-theme', 'dark'));
    await installLifecycleRoutes(page, { installed: {
      ...installedSnapshot,
      restart_required: true,
      lifecycle: { available: false, code: 'panel_version_unsupported' },
      modules: installedSnapshot.modules.map((item) => (
        item.id === 'engine.mihomo' ? { ...item, description: 'Mihomo config and telemetry.' } : item
      )),
    } });
    await page.goto('/modules');

    const styles = await page.evaluate(() => {
      const read = (element) => {
        const style = getComputedStyle(element);
        return { background: style.backgroundColor, color: style.color, fontSize: Number.parseFloat(style.fontSize) };
      };
      const restartButton = Array.from(document.querySelectorAll('.modules-summary button'))
        .find((button) => button.textContent.trim() === 'Перезапустить панель');
      const headerButton = read(document.querySelector('header.modules-header .xk-header-btn-logout'));
      const theme = read(document.querySelector('#theme-toggle-btn'));
      const restart = read(restartButton);
      const title = read(document.querySelector('header.modules-header h1'));
      const description = read(document.querySelector('.modules-tile-description'));
      const probe = document.createElement('span');
      probe.style.background = 'var(--op-accent)';
      document.body.append(probe);
      const accent = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return { headerButton, theme, restart, title, description, accent };
    });

    expect(styles.title.fontSize, JSON.stringify(styles)).toBeLessThanOrEqual(19);
    expect(styles.description.fontSize, JSON.stringify(styles)).toBeLessThanOrEqual(14);
    expect(styles.theme.background, JSON.stringify(styles)).toBe(styles.headerButton.background);
    expect(styles.theme.color, JSON.stringify(styles)).toBe(styles.headerButton.color);
    expect(styles.restart.background, JSON.stringify(styles)).toBe(styles.accent);
  });

  test('keeps update controls and tooltips on the neutral operator surface', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('xkeen-theme', 'dark'));
    await installIdleLifecycleRoutes(page);
    await page.goto('/modules');

    const layout = await page.evaluate(() => {
      const updateButton = document.querySelector('.modules-update-check-button');
      const stat = document.querySelector('.xk-summary-stat');
      const buttonRect = updateButton.getBoundingClientRect();
      const statRect = stat.getBoundingClientRect();
      return {
        buttonWidth: Math.round(buttonRect.width),
        statWidth: Math.round(statRect.width),
        updateBackground: getComputedStyle(updateButton).backgroundColor,
        statBackground: getComputedStyle(stat).backgroundColor,
      };
    });
    // The check button is as wide as a counter and lies on the same surface.
    expect(layout.buttonWidth, JSON.stringify(layout)).toBe(layout.statWidth);
    expect(layout.updateBackground, JSON.stringify(layout)).toBe(layout.statBackground);

    await page.getByRole('button', { name: 'Выйти' }).hover();
    const tooltip = page.locator('#xk-tooltip-portal .xk-tooltip-bubble');
    await expect(tooltip).toBeVisible();
    await expect.poll(async () => tooltip.evaluate((element) => ({
      background: getComputedStyle(element).backgroundColor,
      border: getComputedStyle(element).borderTopColor,
    }))).toEqual({ background: 'rgb(38, 43, 52)', border: 'rgb(59, 66, 78)' });
  });

  test('renders module activation with the panel switch control', async ({ page }) => {
    await installIdleLifecycleRoutes(page);
    await page.goto('/modules');

    const control = page.getByRole('switch', { name: 'Включить Mihomo' });
    await expect(control).toBeVisible();
    const switchShell = control.locator('xpath=../..');
    await expect(switchShell).toHaveClass(/dt-switch/);
    await expect(switchShell.locator('.dt-switch-slider')).toBeVisible();
    await expect(switchShell.locator('.dt-switch-label')).toHaveText('Выключен');
    await expect(switchShell.locator('.dt-switch-label')).toHaveClass(/is-disabled/);
    // The words are for screen readers only: the slider alone shows the state.
    const placement = await switchShell.evaluate((shell) => ({
      stateWidth: shell.querySelector('.dt-switch-label').getBoundingClientRect().width,
      slider: shell.querySelector('.dt-switch-slider').getBoundingClientRect().width,
    }));
    expect(placement.stateWidth, JSON.stringify(placement)).toBeLessThanOrEqual(1);
    expect(placement.slider, JSON.stringify(placement)).toBe(30);
  });

  test('keeps a local build readable while withholding signed lifecycle actions', async ({ page }) => {
    await installLifecycleRoutes(page, {
      installed: {
        ...installedSnapshot,
        panel_version: null,
        lifecycle: { available: false, code: 'panel_version_unsupported' },
        modules: installedSnapshot.modules.map((item) => ({ ...item, lifecycle_actions: [] })),
      },
    });

    await page.goto('/modules');

    await expect(page.locator('body')).not.toHaveClass(/\bpanel-page\b/);
    await expect(page.locator('.modules-summary')).toContainText('Локальная сборка.');
    await expect(page.getByRole('button', { name: 'Обновить панель' })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Доступные' })).toBeDisabled();
    await expect(page.getByRole('switch', { name: /Включить Mihomo/ })).toBeVisible();
  });

  test('withholds the catalog while a local build capability is still loading', async ({ page }) => {
    let releaseInstalled;
    const installedReady = new Promise((resolve) => { releaseInstalled = resolve; });
    let catalogCalls = 0;
    const localInstalled = {
      ...installedSnapshot,
      panel_version: null,
      lifecycle: { available: false, code: 'panel_version_unsupported' },
      modules: installedSnapshot.modules.map((item) => ({ ...item, lifecycle_actions: [] })),
    };
    await page.route('**/api/modules/installed', async (route) => {
      await installedReady;
      await route.fulfill({ json: localInstalled });
    });
    await page.route('**/api/modules/operations/status', (route) => route.fulfill({ json: idleStatus }));
    await page.route('**/api/modules/available', (route) => {
      catalogCalls += 1;
      return route.fulfill({ json: availableSnapshot });
    });

    await page.goto('/modules');
    await expect(page.getByRole('tab', { name: 'Доступные' })).toBeDisabled();
    await page.evaluate(async () => {
      const controller = (await import('/static/js/pages/modules.init.js')).getModulesController();
      await controller.restoreState({ selectedTab: 'available' });
    });
    expect(catalogCalls).toBe(0);

    releaseInstalled();
    await expect(page.locator('.modules-summary')).toContainText('Локальная сборка.');
    expect(catalogCalls).toBe(0);
  });

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
    await expect(page.getByRole('button', { name: `Установить ${TERMINAL}` })).toBeVisible();
    await page.getByRole('tab', { name: 'Установленные' }).click();
    await page.evaluate(async () => (await import('/static/js/pages/modules.init.js')).getModulesController().deactivate());
    installed = { ...withMihomo(true), transition_required: true };
    await page.evaluate(async () => (await import('/static/js/pages/modules.init.js')).getModulesController().activate());
    await expect(page.locator('.modules-summary .xk-summary-stat[data-stat="enabled"] b')).toHaveText('3 из 3');
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
    await expect(page.locator('#modules-error .modules-page-alert')).toHaveAttribute('data-code', 'module_state_unavailable');
    // The refresh lives in the alert while there is one: one button, not two.
    const retry = page.locator('#modules-error .modules-page-alert-retry');
    await expect(page.locator('#modules-refresh-status')).toBeHidden();
    await retry.click();
    await expect(page.getByRole('button', { name: 'Обновить панель' })).toBeDisabled();
    unavailable = false;
    await retry.click();
    await expect(page.getByRole('button', { name: 'Обновить панель' })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Перезапустить панель' })).toBeEnabled();
  });

  test('offers restart for a registry change without a lifecycle operation', async ({ page }) => {
    let restartCalls = 0;
    await installLifecycleRoutes(page, {
      status: { ok: true, result: null },
      installed: {
        ...installedSnapshot,
        panel_version: null,
        profile: 'custom',
        restart_required: true,
        lifecycle: { available: false, code: 'panel_version_unsupported' },
      },
    });
    await page.route('**/api/modules/restart', (route) => {
      restartCalls += 1;
      return route.fulfill({ json: { ok: true, restart_requested: true } });
    });

    await page.goto('/modules');

    const restart = page.locator('.modules-summary').getByRole('button', { name: 'Перезапустить панель' });
    await expect(restart).toBeEnabled();
    await restart.click();
    await expect(page.locator('#modules-operation-status')).toContainText('Перезапуск запрошен');
    expect(restartCalls).toBe(1);
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
    await expect(page.locator('.modules-core')).toContainText('Xkeen UI Core');
    await expect(page.locator('.modules-core')).toContainText('версия 1.0.0');
    await page.getByLabel('Действия: Mihomo').click();
    await expect(page.getByRole('button', { name: 'Восстановить Mihomo' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Удалить Mihomo' })).toBeVisible();
    expect(initialCalls.sort()).toEqual(['installed', 'status']);
    expect(availableCalls).toBe(0);

    await page.getByRole('tab', { name: 'Доступные' }).click();
    await expect(page.getByRole('heading', { name: `${TERMINAL} 2.10.0` })).toBeVisible();
    expect(availableCalls).toBe(1);

    await page.getByRole('tab', { name: 'Установленные' }).click();
    await page.getByRole('switch', { name: 'Включить Mihomo' }).locator('..').click();
    await expect.poll(() => enabledBodies).toEqual([{ enabled: true }]);
  });

  test('renders catalog text without executing markup', async ({ page }) => {
    await page.route('**/api/modules/installed', (route) => route.fulfill({ json: installedSnapshot }));
    await page.route('**/api/modules/operations/status', (route) => route.fulfill({ json: idleStatus }));
    await page.route('**/api/modules/available', (route) => route.fulfill({ json: {
      ...availableSnapshot,
      modules: [{ ...terminalEntry, name: '<img src=x onerror="window.catalogInjected=1">' }],
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
        loadStatus: () => Promise.resolve({ ok: true, result: null }),
      };
      const controller = createModuleManagerController({ root, api, pollMs: 0 });
      await controller.init();
      await controller.init();
      return { loads, listeners };
    });
    expect(result).toEqual({ loads: 2, listeners: 2 });
  });
});

test.describe('A screen that is not drawn anew without a reason', () => {
  const mark = (page) => page.evaluate(() => {
    document.querySelector('.modules-summary').dataset.drawn = 'before';
    document.querySelector('.modules-operation').dataset.drawn = 'before';
  });
  const drawn = (page, selector) => page.locator(selector).first().getAttribute('data-drawn');

  test('polling a running operation leaves the cards and an unchanged status as they are', async ({ page }) => {
    await page.clock.install();
    let status = runningStatus;
    let polls = 0;
    await installLifecycleRoutes(page, { status });
    await page.route('**/api/modules/operations/status', (route) => { polls += 1; return route.fulfill({ json: status }); });
    await page.goto('/modules');
    await expect(page.locator('#modules-operation-status')).toContainText('Сейчас: Загрузка архива');
    await mark(page);
    const cancel = page.getByRole('button', { name: 'Отменить операцию' });
    await cancel.focus();
    const pollsBefore = polls;

    await advanceClock(page, 3500);

    expect(polls).toBeGreaterThanOrEqual(pollsBefore + 3);
    expect(await drawn(page, '.modules-summary')).toBe('before');
    // The same words drawn again would be read aloud again.
    expect(await drawn(page, '.modules-operation')).toBe('before');
    await expect(cancel).toBeFocused();

    // A new step is news: the block is drawn, the cards and the focus stay.
    status = server.install_steps.verifying;
    await advanceClock(page, 1500);
    await expect(page.locator('#modules-operation-status')).toContainText('Сейчас: Проверка подписи и состава');
    expect(await drawn(page, '.modules-operation')).toBeNull();
    expect(await drawn(page, '.modules-summary')).toBe('before');
    await expect(page.getByRole('button', { name: 'Отменить операцию' })).toBeFocused();
  });

  test('of two overlapping readings of the state the later one stays on the screen', async ({ page }) => {
    let installedCalls = 0;
    let releaseFirst;
    await installIdleLifecycleRoutes(page);
    await page.route('**/api/modules/installed', async (route) => {
      installedCalls += 1;
      if (installedCalls === 2) {
        // The first of the two readings is answered last, with what was true before.
        await new Promise((resolve) => { releaseFirst = resolve; });
        return route.fulfill({ json: installedSnapshot });
      }
      return route.fulfill({ json: installedCalls === 1 ? installedSnapshot : withMihomo(true) });
    });
    await page.goto('/modules');
    await expect(page.getByRole('switch', { name: 'Включить Mihomo' })).not.toBeChecked();

    await page.evaluate(async () => {
      const controller = (await import('/static/js/pages/modules.init.js')).getModulesController();
      window.xkReadings = Promise.all([controller.refreshInstalledAfterTerminal(), controller.refreshInstalledAfterTerminal()]);
    });
    await expect(page.getByRole('switch', { name: 'Включить Mihomo' })).toBeChecked();
    await expect.poll(() => Boolean(releaseFirst)).toBe(true);
    releaseFirst();
    await page.evaluate(() => window.xkReadings);

    await expect(page.getByRole('switch', { name: 'Включить Mihomo' })).toBeChecked();
    await expect(page.locator('.modules-summary')).toContainText('Требуется перезапуск');
    await expect(page.getByRole('button', { name: 'Обновить панель' })).toBeEnabled();
  });

  test('a switch being saved locks the other actions and keeps the focus', async ({ page }) => {
    let enabled = false;
    let releaseSave;
    let planCalls = 0;
    await installIdleLifecycleRoutes(page);
    await page.route('**/api/modules/installed', (route) => route.fulfill({ json: withMihomo(enabled) }));
    await page.route('**/api/modules/engine.mihomo', async (route) => {
      await new Promise((resolve) => { releaseSave = resolve; });
      enabled = route.request().postDataJSON().enabled;
      return route.fulfill({ json: { ok: true, restart_required: true } });
    });
    await routePlans(page, () => { planCalls += 1; return { json: panelUpdatePlan }; });
    await page.goto('/modules');
    const toggle = page.getByRole('switch', { name: 'Включить Mihomo' });
    await page.getByLabel('Действия: Mihomo').click();
    await toggle.focus();
    await page.keyboard.press('Space');
    await expect.poll(() => Boolean(releaseSave)).toBe(true);

    await expect(page.getByRole('button', { name: 'Обновить панель' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Удалить Mihomo' })).toBeDisabled();
    await expect(page.getByRole('switch', { name: 'Включить Редакторы' })).toBeDisabled();
    await page.evaluate(async () => {
      const controller = (await import('/static/js/pages/modules.init.js')).getModulesController();
      await controller.requestPlan('panel-update', null);
    });
    expect(planCalls).toBe(0);

    releaseSave();
    await expect(toggle).toBeChecked();
    await expect(toggle).toBeFocused();
    await expect(page.getByRole('button', { name: 'Обновить панель' })).toBeEnabled();
  });

  test('a module that is not installed is still called by its name', async ({ page }) => {
    // The installation was undone: the terminal is not among the installed,
    // and the catalog has not been asked for.
    let catalogCalls = 0;
    await installLifecycleRoutes(page, { status: restartStatus });
    await page.route('**/api/modules/available', (route) => { catalogCalls += 1; return route.fulfill({ json: availableSnapshot }); });
    await routePlans(page, () => ({ json: {
      ...panelUpdatePlan, operation: 'profile-transition', affected_module_ids: ['core', 'tool.terminal', 'tool.files'],
    } }));
    await page.goto('/modules');

    const block = page.locator('.modules-operation');
    await expect(block.locator('h2')).toContainText(`Установка модуля «${TERMINAL}» 2.10.0`);
    await expect(block).not.toContainText('tool.terminal');

    await page.getByRole('button', { name: 'Обновить панель' }).click();
    const facts = page.getByRole('dialog').locator('.modules-plan-facts');
    await expect(facts).toContainText(`Xkeen UI Core, ${TERMINAL}, ${installedSnapshot.module_names['tool.files']}`);
    await expect(facts).not.toContainText('tool.');
    expect(catalogCalls).toBe(0);
  });

  test('summary buttons stand in the grid of the counters', async ({ page }) => {
    await installIdleLifecycleRoutes(page);
    await page.route('**/api/modules/panel/update-check', (route) => route.fulfill({ json: server.update_check }));
    for (const width of [1600, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/modules');
      await expect(page.getByRole('button', { name: 'Обновить до 2.11.0' })).toBeVisible();
      const grid = await page.locator('.modules-summary').evaluate((root, wide) => {
        const box = (node) => node.getBoundingClientRect();
        const stats = [...root.querySelectorAll('.xk-summary-stat')].map(box);
        const buttons = [...root.querySelectorAll('.xk-summary-actions > button')].map(box);
        const card = box(root);
        return {
          statGap: Math.round(stats[1].left - stats[0].right),
          edge: Math.round(card.right - stats[2].right),
          buttonsRight: Math.round(buttons[buttons.length - 1].right),
          statsRight: Math.round(stats[2].right),
          buttonGap: Math.round(buttons[1].left - buttons[0].right),
          secondLeft: Math.round(buttons[0].left),
          statLeft: Math.round(stats[wide ? 1 : 0].left),
        };
      }, width > 480);
      // The gap between the counters equals their distance to the edge of the
      // block; the buttons keep the same gap and end where the counters end.
      expect(Math.abs(grid.statGap - (grid.edge - 1)), `${width}: ${JSON.stringify(grid)}`).toBeLessThanOrEqual(1);
      expect(grid.buttonsRight, `${width}: ${JSON.stringify(grid)}`).toBe(grid.statsRight);
      expect(grid.buttonGap, `${width}: ${JSON.stringify(grid)}`).toBe(grid.statGap);
      expect(grid.secondLeft, `${width}: ${JSON.stringify(grid)}`).toBe(grid.statLeft);
    }
  });
});

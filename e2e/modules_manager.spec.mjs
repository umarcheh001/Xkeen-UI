import { test, expect } from './fixtures.mjs';

const installedSnapshot = {
  ok: true,
  panel_version: '2.10.0',
  build: {
    exists: true,
    version: '2.10.0',
    commit: 'abc123456789',
    built_utc: '2026-10-09T09:10:11Z',
    repo: 'umarcheh001/Xkeen-UI',
    channel: 'stable',
  },
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

// The timers of the manager are chained through requests: the clock moves
// in steps, so every answer arrives before the next timer is due.
async function advanceClock(page, ms, step = 500) {
  for (let passed = 0; passed < ms; passed += step) {
    await page.clock.runFor(Math.min(step, ms - passed));
    await new Promise((resolve) => { setTimeout(resolve, 25); });
  }
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

  test('stable DevTools shows panel identity and one Modules link without legacy update requests', async ({ page }) => {
    const legacyRequests = [];
    await page.route('**/api/devtools/update/info', (route) => route.fulfill({ json: updateInfo('stable') }));
    await page.route(/\/api\/devtools\/update\/(?:check|status|run|rollback)(?:\?|$)/, (route) => {
      legacyRequests.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
      return route.fulfill({ json: { ok: true, status: { state: 'idle' } } });
    });
    await installIdleLifecycleRoutes(page);

    await page.goto('/devtools');
    const updateCard = page.locator('#dt-update-card');
    await expect(page.locator('[data-dt-modules-manager-notice]')).toHaveCount(0);
    await expect(page.locator('[data-dt-main-update-controls]')).toHaveCount(0);
    await expect(page.locator('#xk-update-link')).toBeHidden();
    await expect(updateCard).toContainText('2.10.0');
    await expect(updateCard).toContainText('mihomo-minimal');
    await expect(updateCard).toContainText('Xkeen UI Core');
    await expect(updateCard).toContainText('Mihomo');
    const modulesLinks = page.getByRole('link', { name: 'Модули и обновления', exact: true });
    await expect(modulesLinks).toHaveCount(1);
    await expect(modulesLinks).toHaveAttribute('href', /\/modules$/);
    await page.waitForTimeout(1000);
    expect(legacyRequests).toEqual([]);
  });

  test('stable DevTools stretches the panel information card to the ENV bottom edge', async ({ page }) => {
    await page.route('**/api/devtools/update/info', (route) => route.fulfill({ json: updateInfo('stable') }));
    await installIdleLifecycleRoutes(page);

    await page.goto('/devtools');

    const updateCard = page.locator('#dt-update-card');
    const metrics = await page.evaluate(() => {
      const update = document.getElementById('dt-update-card');
      const env = document.getElementById('dt-env-card');
      return {
        updateGrow: update ? getComputedStyle(update).flexGrow : '',
        bottomDelta: update && env
          ? Math.abs(update.getBoundingClientRect().bottom - env.getBoundingClientRect().bottom)
          : Number.POSITIVE_INFINITY,
      };
    });
    expect(metrics.updateGrow).toBe('1');
    expect(metrics.bottomDelta, JSON.stringify(metrics)).toBeLessThanOrEqual(2);
  });

  test('main DevTools stays informational and delegates update work to Modules', async ({ page }) => {
    await page.route('**/api/devtools/update/info', (route) => route.fulfill({ json: updateInfo('main') }));
    await installIdleLifecycleRoutes(page);

    await page.goto('/devtools');
    await expect(page.locator('#dt-update-current-version')).toHaveText('2.10.0');
    await expect(page.locator('#dt-update-channel')).toHaveText('main');
    await expect(page.locator('#dt-update-check')).toHaveCount(0);
  });

  for (const channel of ['main', 'stable']) {
    test(`${channel} DevTools recovers after the first info request fails`, async ({ page }) => {
      let allowInfo = false;
      await page.route('**/api/devtools/update/info', (route) => route.fulfill(
        allowInfo ? { json: updateInfo(channel) } : { status: 503, json: { ok: false, error: 'temporary failure' } },
      ));

      await page.goto('/devtools');
      await expect(page.locator('#dt-update-current-version')).toHaveText('—');
      allowInfo = true;
      await page.evaluate(async () => {
        const { getDevtoolsNamespace } = await import('/static/js/features/devtools_namespace.js');
        getDevtoolsNamespace().devtoolsUpdate.activate();
      });

      await expect(page.locator('#dt-update-current-version')).toHaveText('2.10.0');
    });
  }
});

test.describe('Modules panel update surface', () => {
  test('shows a local archive identity instead of an unknown panel version', async ({ page }) => {
    const localBuild = {
      ...installedSnapshot,
      panel_version: null,
      build: {
        exists: true,
        version: 'd523ffcf',
        base_commit: 'd523ffcf',
        commit: 'd523ffcf7cc474bea600e173d704d7c89d9b996b',
        dirty: false,
        tree_sha256: 'a'.repeat(64),
        built_utc: '2026-10-09T08:35:46Z',
        repo: 'umarcheh001/Xkeen-UI',
        channel: 'stable',
      },
      lifecycle: { available: false, code: 'panel_version_unsupported' },
    };
    await installLifecycleRoutes(page, { installed: localBuild });

    await page.goto('/modules');

    await expect(page.getByText('Локальная сборка d523ffcf')).toBeVisible();
    await expect(page.getByText('Версия панели неизвестна')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Проверить обновления' })).toBeDisabled();
  });

  test('checks the signed catalog before offering a panel update plan', async ({ page }) => {
    await installIdleLifecycleRoutes(page);
    await page.route('**/api/modules/panel/update-check', (route) => route.fulfill({ json: {
      ok: true,
      source_version: '2.10.0',
      target_version: '2.11.0',
      update_available: true,
      requires_installer: false,
      min_updater: null,
    } }));
    await page.route('**/api/modules/operations/plan', (route) => route.fulfill({ json: {
      ...installPlan,
      operation: 'panel-update',
      module_id: null,
      scope: 'panel',
      source_version: '2.10.0',
      target_version: '2.11.0',
    } }));

    await page.goto('/modules');
    await expect(page.getByText('Источник: umarcheh001/Xkeen-UI · канал: stable')).toBeVisible();
    await page.getByRole('button', { name: 'Проверить обновления' }).click();
    await expect(page.getByText('Доступна версия 2.11.0')).toBeVisible();
    await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('xkeen.modules.update.v1'))?.targetVersion)).toBe('2.11.0');
    await page.getByRole('button', { name: 'Обновить панель' }).click();
    await expect(page.getByRole('dialog', { name: 'План обновления панели' })).toContainText('2.11.0');
  });

  test('says that the update answer comes from an old copy of the catalog', async ({ page }) => {
    await installIdleLifecycleRoutes(page);
    await page.route('**/api/modules/panel/update-check', (route) => route.fulfill({ json: {
      ok: true, source_version: '2.10.0', target_version: '2.10.0', update_available: false,
      requires_installer: false, min_updater: null,
      freshness: 'stale', stale_reason: 'catalog_transport_unavailable', fetched_at: 1791000000.5,
    } }));
    await page.goto('/modules');

    await page.getByRole('button', { name: 'Проверить обновления' }).click();

    const check = page.locator('.modules-update-check');
    await expect(check).toContainText('Не удалось связаться с GitHub');
    await expect(check).toContainText(await page.evaluate(() => new Date(1791000000500).toLocaleDateString('ru-RU')));
    await expect(check).not.toContainText('Установлена актуальная версия');
    await expect(check).toContainText('По сохранённым данным новой версии нет');
  });

  test('keeps update feedback focused and clears a stale badge after a failed check', async ({ page }) => {
    await installIdleLifecycleRoutes(page);
    await page.route('**/api/modules/panel/update-check', (route) => route.fulfill({ status: 503, json: {
      ok: false,
      code: 'catalog_unavailable',
      error: 'offline',
    } }));
    await page.goto('/modules');
    await page.evaluate(() => sessionStorage.setItem('xkeen.modules.update.v1', JSON.stringify({
      schema: 1,
      sourceVersion: '2.10.0',
      targetVersion: '2.11.0',
    })));

    await page.getByRole('button', { name: 'Проверить обновления' }).click();

    const check = page.locator('.modules-update-check');
    await expect(check.getByRole('status')).toContainText('Каталог модулей временно недоступен.');
    await expect(check.getByRole('button', { name: 'Проверить обновления' })).toBeFocused();
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem('xkeen.modules.update.v1'))).toBeNull();
  });
});

test.describe('Module manager recovery and guards', () => {
  test('keeps the modules header comfortably inset with a compact theme action', async ({ page }) => {
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
        themeWidth: themeRect.width,
        themeHeight: themeRect.height,
        backHeight: backRect.height,
      };
    });

    expect(geometry.titleInset, JSON.stringify(geometry)).toBeGreaterThanOrEqual(18);
    expect(geometry.logoutInset, JSON.stringify(geometry)).toBeGreaterThanOrEqual(18);
    expect(geometry.themeWidth, JSON.stringify(geometry)).toBeGreaterThanOrEqual(30);
    expect(geometry.themeWidth, JSON.stringify(geometry)).toBeLessThanOrEqual(34);
    expect(Math.abs(geometry.themeWidth - geometry.themeHeight), JSON.stringify(geometry)).toBeLessThanOrEqual(2);
    expect(Math.abs(geometry.themeHeight - geometry.backHeight), JSON.stringify(geometry)).toBeLessThanOrEqual(2);
  });

  test('centers the theme icon and uses the compact settings switch geometry', async ({ page }) => {
    await installIdleLifecycleRoutes(page);
    await page.goto('/modules');

    const layout = await page.locator('header.modules-header').evaluate((header) => {
      const theme = header.querySelector('#theme-toggle-btn');
      const icon = theme.querySelector('.theme-toggle-icon');
      const slider = document.querySelector('.modules-switch .dt-switch-slider');
      const state = document.querySelector('.modules-switch-state');
      const themeRect = theme.getBoundingClientRect();
      const iconRect = icon.getBoundingClientRect();
      const sliderRect = slider.getBoundingClientRect();
      const stateRect = state.getBoundingClientRect();
      return {
        iconCenterOffset: (iconRect.left + iconRect.width / 2) - (themeRect.left + themeRect.width / 2),
        sliderWidth: sliderRect.width,
        sliderHeight: sliderRect.height,
        stateFontSize: Number.parseFloat(getComputedStyle(state).fontSize),
        stateSliderGap: sliderRect.top - stateRect.bottom,
        stateBelowSlider: stateRect.bottom > sliderRect.top,
      };
    });

    expect(Math.abs(layout.iconCenterOffset), JSON.stringify(layout)).toBeLessThanOrEqual(1);
    expect(layout.sliderWidth, JSON.stringify(layout)).toBeLessThanOrEqual(30);
    expect(layout.sliderHeight, JSON.stringify(layout)).toBeLessThanOrEqual(16);
    expect(layout.stateFontSize, JSON.stringify(layout)).toBeLessThanOrEqual(10.5);
    expect(layout.stateSliderGap, JSON.stringify(layout)).toBeGreaterThanOrEqual(7);
    expect(layout.stateBelowSlider, JSON.stringify(layout)).toBe(false);
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

  test('groups installed module controls at the trailing edge of a row', async ({ page }) => {
    await page.setViewportSize({ width: 1800, height: 1300 });
    await installIdleLifecycleRoutes(page);
    await page.goto('/modules');

    const row = page.locator('.modules-row').filter({ hasText: 'Mihomo' });
    const controls = row.locator('.modules-row-actions');
    await expect(controls).toBeVisible();
    await expect(controls.getByRole('switch')).toBeVisible();
    await expect(controls.getByRole('button', { name: 'Восстановить Mihomo' })).toBeVisible();
    const geometry = await row.evaluate((element) => {
      const body = element.querySelector('.modules-row-body').getBoundingClientRect();
      const actions = element.querySelector('.modules-row-actions').getBoundingClientRect();
      return { bodyRight: body.right, actionsLeft: actions.left };
    });
    expect(geometry.actionsLeft, JSON.stringify(geometry)).toBeGreaterThanOrEqual(geometry.bodyRight);
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
      const description = read(document.querySelector('.modules-row p'));
      return { headerButton, theme, restart, title, description };
    });

    expect(styles.title.fontSize, JSON.stringify(styles)).toBeLessThanOrEqual(19);
    expect(styles.description.fontSize, JSON.stringify(styles)).toBeLessThanOrEqual(14);
    expect(styles.theme.background, JSON.stringify(styles)).toBe(styles.headerButton.background);
    expect(styles.theme.color, JSON.stringify(styles)).toBe(styles.headerButton.color);
    expect(styles.restart.background, JSON.stringify(styles)).toBe('rgb(63, 58, 126)');
  });

  test('keeps update controls and tooltips on the neutral operator surface', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('xkeen-theme', 'dark'));
    await installIdleLifecycleRoutes(page);
    await page.goto('/modules');

    const layout = await page.evaluate(() => {
      const update = document.querySelector('.modules-update-check');
      const updateButton = document.querySelector('.modules-update-check-button');
      const headerButton = document.querySelector('header.modules-header .xk-header-btn');
      const state = document.querySelector('.modules-switch-state');
      const slider = document.querySelector('.modules-switch .dt-switch-slider');
      const updateRect = update.getBoundingClientRect();
      const buttonRect = updateButton.getBoundingClientRect();
      const headerStyle = getComputedStyle(headerButton);
      const updateStyle = getComputedStyle(updateButton);
      const stateRect = state.getBoundingClientRect();
      const sliderRect = slider.getBoundingClientRect();
      return {
        buttonWidth: buttonRect.width,
        updateWidth: updateRect.width,
        updateBackground: updateStyle.backgroundColor,
        updateBorder: updateStyle.borderTopColor,
        headerBackground: headerStyle.backgroundColor,
        headerBorder: headerStyle.borderTopColor,
        switchGap: sliderRect.top - stateRect.bottom,
      };
    });

    expect(layout.buttonWidth, JSON.stringify(layout)).toBeLessThan(layout.updateWidth / 2);
    expect(layout.updateBackground, JSON.stringify(layout)).toBe(layout.headerBackground);
    expect(layout.updateBorder, JSON.stringify(layout)).toBe(layout.headerBorder);
    expect(layout.switchGap, JSON.stringify(layout)).toBeGreaterThanOrEqual(3);

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
    const placement = await switchShell.evaluate((shell) => {
      const state = shell.querySelector('.dt-switch-label').getBoundingClientRect();
      const slider = shell.querySelector('.dt-switch-slider').getBoundingClientRect();
      const style = getComputedStyle(shell);
      return { display: style.display, stateBottom: state.bottom, sliderTop: slider.top };
    });
    expect(placement.display, JSON.stringify(placement)).toBe('grid');
    expect(placement.stateBottom, JSON.stringify(placement)).toBeLessThanOrEqual(placement.sliderTop);
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
    await expect(page.locator('.modules-summary')).toContainText('локальной сборки');
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
    await expect(page.locator('.modules-summary')).toContainText('локальной сборки');
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
    await expect(gear.locator('[data-xk-modules-update-dot]')).toBeHidden();
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

  test('marks the gear and its menu item while an update is known', async ({ page }) => {
    await installIdleLifecycleRoutes(page);
    await page.addInitScript(() => sessionStorage.setItem('xkeen.modules.update.v1', JSON.stringify({
      schema: 1, sourceVersion: '2.10.0', targetVersion: '2.11.0',
    })));
    await page.goto('/');

    const gear = page.locator('.xk-header-panel-trigger');
    const dot = gear.locator('[data-xk-modules-update-dot]');
    await expect(dot).toBeVisible();
    const dotBox = await dot.boundingBox();
    expect(dotBox.width).toBeGreaterThanOrEqual(6);
    expect(dotBox.width).toBeLessThanOrEqual(10);
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
    await page.getByRole('link', { name: '← Назад' }).click();

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
        ...installedSnapshot, restart_required: restartRequired,
        modules: installedSnapshot.modules.map((item) => item.id === 'engine.mihomo' ? { ...item, enabled } : item),
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
    const restarting = {
      ...runningStatus, step: 'restarting',
      log: [{ step: 'applying', at: 1781000001.5 }, { step: 'restarting', at: 1781000002.25 }],
    };
    let panelDown = false;
    let finished = false;
    let failedPolls = 0;
    await installLifecycleRoutes(page, { status: restarting });
    await page.route('**/api/modules/operations/status', (route) => {
      if (panelDown) { failedPolls += 1; return route.abort('connectionrefused'); }
      return route.fulfill({ json: finished ? {
        ...restarting, result: 'committed', step: 'committed', finished_at: 1781000009.5,
        log: [...restarting.log, { step: 'health', at: 1781000003 }, { step: 'committed', at: 1781000009.5 }],
      } : restarting });
    });
    await page.goto('/modules');
    await page.evaluate(() => { window.xkBeforeRestart = true; });
    await expect(page.locator('#modules-operation-status')).toContainText('restarting');

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
    await expect(page.locator('#modules-operation-status')).toContainText('committed');
  });

  test('names a lost connection plainly while an operation has not reached the restart', async ({ page }) => {
    await page.clock.install();
    let panelDown = false;
    await installLifecycleRoutes(page, { status: runningStatus });
    await page.route('**/api/modules/operations/status', (route) => (panelDown
      ? route.abort('connectionrefused')
      : route.fulfill({ json: runningStatus })));
    await page.goto('/modules');
    await expect(page.locator('#modules-operation-status')).toContainText('download');

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
      return route.fulfill({ json: recovered ? {
        ...installedSnapshot,
        modules: [...installedSnapshot.modules, { id: 'tool.terminal', name: 'Терминал', version: '2.10.0', enabled: true, can_disable: true }],
      } : installedSnapshot });
    });
    await page.route('**/api/modules/operations/status', (route) => route.fulfill({ json: currentStatus }));
    await page.route('**/api/modules/available', (route) => route.fulfill({ json: availableSnapshot }));
    await page.route('**/api/modules/recovery', (route) => {
      recovered = true;
      currentStatus = { ...rollbackFailedStatus, result: 'rolled_back', error_code: 'operation_interrupted', recovered: true };
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

    await expect(page.locator('#modules-operation-status')).toContainText('rolled_back');
    await expect(page.locator('.modules-row').filter({ hasText: 'Терминал' })).toBeVisible();
    expect(installedLoads).toBeGreaterThan(loadsBeforeRecovery);
  });

  test('removes the restart action after a switch is returned to its original state', async ({ page }) => {
    let enabled = true;
    let profile = 'full';
    let restartRequired = false;
    await installIdleLifecycleRoutes(page);
    await page.route('**/api/modules/installed', (route) => route.fulfill({ json: {
      ...installedSnapshot,
      profile,
      restart_required: restartRequired,
      modules: installedSnapshot.modules.map((item) => item.id === 'engine.mihomo' ? { ...item, enabled } : item),
    } }));
    await page.route('**/api/modules/engine.mihomo', (route) => {
      enabled = route.request().postDataJSON().enabled;
      profile = enabled ? 'full' : 'custom';
      restartRequired = !enabled;
      return route.fulfill({ json: { ok: true, profile, restart_required: restartRequired } });
    });

    await page.goto('/modules');
    const row = page.locator('.modules-row').filter({ hasText: 'Mihomo' });
    const control = row.getByRole('switch', { name: 'Включить Mihomo' });
    await expect(row.locator('.modules-switch-state')).toHaveText('Включён');
    await expect(row.locator('.modules-switch-state')).toHaveClass(/is-enabled/);
    await control.locator('..').click();
    await expect(page.locator('.modules-summary')).toContainText('Профиль: custom');
    await expect(page.getByRole('button', { name: 'Перезапустить панель' })).toBeVisible();
    await control.locator('..').click();
    await expect(page.locator('.modules-summary')).toContainText('Профиль: full');
    await expect(page.locator('.modules-summary')).not.toContainText('Требуется перезапуск');
    await expect(page.getByRole('button', { name: 'Перезапустить панель' })).toHaveCount(0);
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
      await expect(page.locator('#modules-operation-status')).toContainText('interrupted');
      await expect(page.getByRole('button', { name: 'Обновить панель' })).toBeEnabled();
      expect(statusCalls).toBeGreaterThan(beforeReturn);
      expect(catalogCalls).toBe(0);
    });
  }

  test('leaves the manager usable after an interrupted operation', async ({ page }) => {
    // What the server keeps after a failed download or a cancel: the
    // record of the operation is gone and there is nothing to recover.
    let recoveryCalls = 0;
    await installLifecycleRoutes(page, { status: { ...interruptedStatus, step: 'downloading', error_code: 'operation_cancelled' } });
    await page.route('**/api/modules/recovery', (route) => {
      recoveryCalls += 1;
      return route.fulfill({ json: { ok: true, recovery_result: null, ...interruptedStatus } });
    });
    await page.goto('/modules');

    await expect(page.locator('#modules-operation-status')).toContainText('Операция отменена');
    await expect(page.locator('#modules-operation-status')).toContainText('Файлы панели не изменены');
    await expect(page.locator('#modules-operation-status').getByRole('button')).toHaveCount(0);
    await expect(page.getByRole('switch', { name: 'Включить Mihomo' })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Обновить панель' })).toBeEnabled();
    await page.getByRole('tab', { name: 'Доступные' }).click();
    await expect(page.getByRole('button', { name: 'Установить Терминал' })).toBeEnabled();
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
      currentStatus = { ...interruptedStatus, result: 'rolled_back', recovered: true };
      return route.fulfill({ json: currentStatus });
    });
    await page.route('**/api/modules/restart', (route) => {
      restartCalls += 1;
      return route.fulfill({ json: { ok: true, restart_requested: true } });
    });
    await page.goto('/modules');
    await expect(page.getByRole('switch', { name: 'Включить Mihomo' })).toBeDisabled();
    await page.getByRole('button', { name: 'Повторить восстановление' }).click();
    await expect(page.locator('#modules-operation-status')).toContainText('rolled_back');
    await expect(page.getByRole('switch', { name: 'Включить Mihomo' })).toBeEnabled();
    expect(recoveryCalls).toBe(1);
    expect(restartCalls).toBe(0);
  });

  test('locks mutations after rollback_failed and offers to repeat the undo', async ({ page }) => {
    await installLifecycleRoutes(page, { status: rollbackFailedStatus });
    await page.goto('/modules');
    await expect(page.getByText('Восстановление файлов не завершилось')).toBeVisible();
    await page.getByRole('tab', { name: 'Доступные' }).click();
    await expect(page.getByRole('button', { name: 'Установить Терминал' })).toBeDisabled();
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
    await page.getByRole('switch', { name: 'Включить Mihomo' }).locator('..').click();
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
    // A current panel is an answer, not a plan with nothing in it.
    await expect(page.locator('.modules-update-check').getByRole('status')).toContainText('Установлена актуальная версия');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('#modules-error')).toBeEmpty();
    await expect(page.getByRole('button', { name: 'Обновить панель' })).toBeEnabled();
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

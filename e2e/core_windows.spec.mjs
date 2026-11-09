import { test, expect } from './fixtures.mjs';

// The service menu shows the engines as a switch; the core dialog keeps a tab
// per engine. What either shows depends on which engines are on the router
// and which engine modules the panel has.

async function serveCores(page, { cores, current = 'xray', running = true }) {
  await page.route('**/api/xkeen/status', (route) => route.fulfill({ json: { ok: true, running, core: current } }));
  await page.route('**/api/xkeen/core', (route) => (route.request().method() === 'GET'
    ? route.fulfill({ json: { ok: true, cores, currentCore: current } })
    : route.continue()));
  await page.route('**/api/cores/versions', (route) => route.fulfill({ json: { ok: true, cores: {
    xray: { installed: cores.includes('xray'), version: cores.includes('xray') ? '26.9.9' : null },
    mihomo: { installed: cores.includes('mihomo'), version: cores.includes('mihomo') ? 'v1.19.14' : null },
  } } }));
}

// A profile without the engine module: the page no longer lists it as active
// and renders no source controls for it.
async function dropEngineModule(page, engine) {
  await page.evaluate((name) => {
    const ids = window.XKeen.pageConfig.frontendModules.activeModuleIds;
    const at = ids.indexOf(`engine.${name}`);
    if (at >= 0) ids.splice(at, 1);
    document.querySelector(`#core-modal [data-core-source][data-core-engine="${name}"]`)?.remove();
  }, engine);
}

async function openServiceMenu(page) {
  await expect(page.locator('body')).toHaveClass(/xk-operator-header-active/);
  await page.locator('.xk-brand-service-trigger').click();
  const menu = page.locator('#xk-mihomo-service-menu');
  await expect(menu).toBeVisible();
  return menu;
}

function engineSwitch(menu, engine) {
  return menu.locator(`[data-xk-svc-core][data-core="${engine}"]`);
}

function tab(page, engine) {
  return page.locator(`#core-modal .core-option[data-core="${engine}"]`);
}

test('the service menu marks the active engine and lays the service buttons out evenly', async ({ page }) => {
  await serveCores(page, { cores: ['xray', 'mihomo'] });
  await page.goto('/');
  const menu = await openServiceMenu(page);

  await expect(menu.locator('[data-xk-svc-state-text]')).toHaveText('Работает');
  await expect(engineSwitch(menu, 'xray')).toHaveAttribute('aria-pressed', 'true');
  await expect(engineSwitch(menu, 'xray')).toContainText('26.9.9 · активно');
  await expect(engineSwitch(menu, 'xray')).toHaveAttribute('data-tooltip', 'Открыть управление ядром Xray');
  await expect(engineSwitch(menu, 'mihomo')).toHaveAttribute('aria-pressed', 'false');
  await expect(engineSwitch(menu, 'mihomo')).toContainText('1.19.14');
  await expect(menu.locator('#xkeen-core-text')).toBeHidden();

  // Two equal buttons, and the gap between them equals the menu padding.
  const [stop, restart, box] = await Promise.all([
    menu.locator('#xkeen-stop-btn').boundingBox(),
    menu.locator('#xkeen-restart-btn').boundingBox(),
    menu.boundingBox(),
  ]);
  expect(Math.abs(stop.width - restart.width)).toBeLessThanOrEqual(1);
  const gap = restart.x - (stop.x + stop.width);
  const edge = box.x + box.width - (restart.x + restart.width);
  expect(Math.abs(gap - edge)).toBeLessThanOrEqual(2);
});

test('a stopped service offers Start in the place of Stop', async ({ page }) => {
  await serveCores(page, { cores: ['xray', 'mihomo'], running: false });
  await page.goto('/');
  const menu = await openServiceMenu(page);

  await expect(menu.locator('[data-xk-svc-state-text]')).toHaveText('Остановлено');
  await expect(menu.locator('#xkeen-start-btn')).toBeVisible();
  await expect(menu.locator('#xkeen-stop-btn')).toBeHidden();
  await expect(menu.locator('#xkeen-restart-btn')).toBeVisible();
});

test('an engine with neither a binary nor a module stays out of the switch', async ({ page }) => {
  await serveCores(page, { cores: ['xray'] });
  await page.goto('/');
  await dropEngineModule(page, 'mihomo');
  const menu = await openServiceMenu(page);

  await expect(engineSwitch(menu, 'mihomo')).toBeHidden();
  await expect(menu.locator('[data-xk-svc-cores]')).toHaveAttribute('data-cores', '1');

  // The dialog still has the tab, and it leads to the modules page.
  await engineSwitch(menu, 'xray').click();
  await expect(page.locator('#core-modal')).toBeVisible();
  await tab(page, 'mihomo').click();
  await expect(tab(page, 'mihomo')).toContainText('Не установлено');
  const absent = page.locator('#core-modal [data-core-absent]');
  await expect(absent).toBeVisible();
  await expect(absent).toContainText('Mihomo не установлено на роутере');
  await expect(absent.getByRole('link', { name: 'Открыть модули' })).toBeVisible();
  await expect(page.locator('#core-modal-confirm-btn')).toBeHidden();
});

test('an absent engine with its module enabled stays listed and installable', async ({ page }) => {
  await serveCores(page, { cores: ['xray'] });
  await page.goto('/');
  const menu = await openServiceMenu(page);

  await expect(engineSwitch(menu, 'mihomo')).toBeVisible();
  await expect(engineSwitch(menu, 'mihomo')).toContainText('не установлено');
  await engineSwitch(menu, 'mihomo').click();

  await expect(page.locator('#core-modal')).toBeVisible();
  await expect(tab(page, 'mihomo')).toHaveAttribute('aria-selected', 'true');
  const source = page.locator('#core-modal [data-core-source][data-core-engine="mihomo"]');
  await expect(source).toBeVisible();
  await expect(page.locator('#core-modal [data-core-source][data-core-engine="xray"]')).toBeHidden();
  await expect(source.getByRole('button', { name: 'Выбрать источник' })).toBeVisible();
  await expect(page.locator('#core-modal-confirm-btn')).toBeHidden();
});

test('an absent Mihomo shows the selected source and installable version', async ({ page }) => {
  await serveCores(page, { cores: ['xray'] });
  await page.route('**/api/mihomo/core-profiles', route => route.fulfill({ json: { ok: true, data: {
    state: { selected_profile_id: 'official', last_status: 'idle', installed_release_tag: 'v1.19.20' },
    profiles: [{ profile_id: 'official', display_name: 'Официальный Mihomo', release: { installable: true, stable: { tag: 'v1.19.20' } } }],
    platform: {},
  } } }));
  await page.goto('/');
  const menu = await openServiceMenu(page);
  await engineSwitch(menu, 'mihomo').click();
  const source = page.locator('#core-modal [data-core-source][data-core-engine="mihomo"]');
  await expect(source.locator('[data-core-first-install-note]')).toBeVisible();
  await expect(source.locator('[data-core-first-source]')).toHaveText('Официальный Mihomo');
  await expect(source.getByRole('button', { name: 'Установить 1.19.20' })).toBeVisible();
  await expect(source.locator('[data-core-source-action="retry"]')).toBeHidden();
});

test('an absent Xray shows the selected source and installable version', async ({ page }) => {
  await serveCores(page, { cores: ['mihomo'], current: 'mihomo' });
  await page.route('**/api/xray/core-profiles', route => route.fulfill({ json: { ok: true, data: {
    state: { selected_profile_id: 'official', last_status: 'idle' },
    profiles: [{ profile_id: 'official', display_name: 'Официальный Xray', release: { installable: true, stable: { tag: 'v26.11.9' } } }],
    platform: {},
  } } }));
  await page.goto('/');
  const menu = await openServiceMenu(page);
  await engineSwitch(menu, 'xray').click();
  const source = page.locator('#core-modal [data-core-source][data-core-engine="xray"]');
  await expect(source.locator('[data-core-first-install-note]')).toBeVisible();
  await expect(source.locator('[data-core-first-source]')).toHaveText('Официальный Xray');
  await expect(source.getByRole('button', { name: 'Установить 26.11.9' })).toBeVisible();
});

test('an absent core names the version for an alternative source even with stale alpha state', async ({ page }) => {
  await serveCores(page, { cores: ['xray'] });
  await page.route('**/api/mihomo/core-profiles', route => route.fulfill({ json: { ok: true, data: {
    state: { selected_profile_id: 'prizrak-core', installed_profile_id: 'official', installed_asset_name: 'mihomo-linux-alpha-abcdef.gz', last_status: 'idle' },
    profiles: [{ profile_id: 'prizrak-core', display_name: 'Prizrak-Core', release: { installable: true, stable: { tag: 'v1.19.20' }, asset: { name: 'mihomo-linux-alpha-abcdef.gz' } } }], platform: {},
  } } }));
  await page.goto('/');
  const menu = await openServiceMenu(page);
  await engineSwitch(menu, 'mihomo').click();
  const source = page.locator('#core-modal [data-core-source][data-core-engine="mihomo"]');
  await expect(source.getByRole('button', { name: 'Установить 1.19.20' })).toBeVisible();
});

test('an absent core offers retry when its source cannot be loaded', async ({ page }) => {
  await serveCores(page, { cores: ['xray'] });
  await page.route('**/api/mihomo/core-profiles', route => route.fulfill({ status: 503, json: { ok: false, error: 'Источник недоступен' } }));
  await page.goto('/');
  const menu = await openServiceMenu(page);
  await engineSwitch(menu, 'mihomo').click();
  const source = page.locator('#core-modal [data-core-source][data-core-engine="mihomo"]');
  await expect(source.locator('[data-core-first-status]')).toBeVisible();
  await expect(source.getByRole('button', { name: 'Повторить проверку' })).toBeVisible();
  await expect(source.locator('[data-core-source-action="prepare"]')).toBeDisabled();
});

test('an absent core explains why the selected release cannot be installed', async ({ page }) => {
  await serveCores(page, { cores: ['xray'] });
  await page.route('**/api/mihomo/core-profiles', route => route.fulfill({ json: { ok: true, data: {
    state: { selected_profile_id: 'official', last_status: 'idle' },
    profiles: [{ profile_id: 'official', display_name: 'Официальный Mihomo', release: { installable: false, reason: 'asset_missing' } }], platform: {},
  } } }));
  await page.goto('/');
  const menu = await openServiceMenu(page);
  await engineSwitch(menu, 'mihomo').click();
  const source = page.locator('#core-modal [data-core-source][data-core-engine="mihomo"]');
  await expect(source.locator('[data-core-first-status]')).toContainText('нет сборки для архитектуры');
  await expect(source.locator('[data-core-source-action="prepare"]')).toBeDisabled();
});

test('an absent core cannot use a stale release after source loading fails', async ({ page }) => {
  await serveCores(page, { cores: ['xray'] });
  let fail = false;
  await page.route('**/api/mihomo/core-profiles', route => fail
    ? route.fulfill({ status: 503, json: { ok: false, error: 'Источник недоступен' } })
    : route.fulfill({ json: { ok: true, data: { state: { selected_profile_id: 'official' }, profiles: [{ profile_id: 'official', display_name: 'Официальный Mihomo', release: { installable: true, stable: { tag: 'v1.19.20' } } }], platform: {} } } }));
  await page.goto('/');
  const menu = await openServiceMenu(page);
  await engineSwitch(menu, 'mihomo').click();
  const source = page.locator('#core-modal [data-core-source][data-core-engine="mihomo"]');
  await expect(source.locator('[data-core-source-action="prepare"]')).toBeEnabled();
  fail = true;
  await source.getByRole('button', { name: 'Выбрать источник' }).click();
  await page.locator('#mihomo-core-source-modal').getByRole('button', { name: 'Закрыть выбор источника' }).click();
  await expect(source.locator('[data-core-source-action="prepare"]')).toBeDisabled();
});

test('first installation explains that the service keeps running and offers a panel restart', async ({ page }) => {
  await serveCores(page, { cores: ['xray'] });
  await page.route('**/api/mihomo/core-profiles', route => route.fulfill({ json: { ok: true, data: {
    state: { selected_profile_id: 'official', last_status: 'idle' },
    profiles: [{ profile_id: 'official', display_name: 'Официальный Mihomo', release: { installable: true, stable: { tag: 'v1.19.20' } } }], platform: {},
  } } }));
  await page.route('**/api/mihomo/core-install/prepare', route => route.fulfill({ json: { ok: true, confirmation: { confirmation_id: 'first', first_install: true, profile: {}, release: {} } } }));
  await page.route('**/api/mihomo/core-install/apply', route => route.fulfill({ json: { ok: true, operation: { operation_id: 'first-op' } } }));
  await page.route('**/api/mihomo/core-install/status?*', route => route.fulfill({ json: { ok: true, operation: { operation_id: 'first-op', first_install: true, status: 'succeeded', phase: 'complete', progress: 100 } } }));
  await page.goto('/');
  const menu = await openServiceMenu(page);
  await engineSwitch(menu, 'mihomo').click();
  await page.locator('#core-modal [data-core-source][data-core-engine="mihomo"]').getByRole('button', { name: 'Установить 1.19.20' }).click();
  const dialog = page.locator('#mihomo-core-install-modal');
  await expect(dialog.locator('[data-core-install-description]')).toContainText('без переключения');
  await dialog.getByRole('button', { name: 'Установить', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Перезапустить панель' })).toBeVisible();
  await expect(dialog.locator('[data-core-install-message]')).toContainText('Ядро установлено');
});

test('a newly installed core still offers panel restart after reopening the page', async ({ page }) => {
  await serveCores(page, { cores: ['xray', 'mihomo'] });
  await page.route('**/api/mihomo/core-profiles', route => route.fulfill({ json: { ok: true, data: {
    state: { selected_profile_id: 'official', detected_version: '1.19.20', last_status: 'succeeded' },
    profiles: [{ profile_id: 'official', display_name: 'Официальный Mihomo', release: { installable: true, stable: { tag: 'v1.19.20' } } }], platform: {},
  } } }));
  await page.goto('/');
  await page.locator('#core-modal [data-core-source][data-core-engine="mihomo"]').evaluate(el => { el.dataset.firstInstall = 'true'; el.dispatchEvent(new CustomEvent('xkeen:core-installation-state')); });
  const menu = await openServiceMenu(page);
  await engineSwitch(menu, 'mihomo').click();
  const source = page.locator('#core-modal [data-core-source][data-core-engine="mihomo"]');
  await expect(source.getByRole('button', { name: 'Перезапустить панель' })).toBeVisible();
  await expect(source.locator('[data-core-source-action="prepare"]')).toBeDisabled();
});

test('the only installed engine is shown active, and another installed one can be activated', async ({ page }) => {
  await serveCores(page, { cores: ['xray', 'mihomo'] });
  await page.goto('/');
  const menu = await openServiceMenu(page);
  await engineSwitch(menu, 'xray').click();

  await expect(tab(page, 'xray')).toHaveAttribute('aria-selected', 'true');
  await expect(tab(page, 'xray')).toContainText('Активно');
  await expect(tab(page, 'xray')).toBeEnabled();
  await expect(tab(page, 'mihomo')).toContainText('Установлено');
  await expect(page.locator('#core-modal-confirm-btn')).toBeHidden();

  await tab(page, 'mihomo').click();
  await expect(page.locator('#core-modal-confirm-btn')).toBeVisible();
  await expect(page.locator('#core-modal-confirm-btn')).toHaveText('Сделать Mihomo активным');
  await expect(page.locator('#core-modal-status')).toContainText('Служба xkeen перезапустится');
});

test('an active Mihomo router keeps Xray as a pending switch with confirmation', async ({ page }) => {
  await serveCores(page, { cores: ['xray', 'mihomo'], current: 'mihomo' });
  await page.goto('/');
  const menu = await openServiceMenu(page);

  await expect(engineSwitch(menu, 'mihomo')).toHaveAttribute('aria-pressed', 'true');
  await engineSwitch(menu, 'xray').click();

  await expect(tab(page, 'xray')).toHaveAttribute('aria-selected', 'true');
  await expect(tab(page, 'xray')).toContainText('Установлено');
  await expect(tab(page, 'xray')).not.toContainText('Активно');
  await expect(tab(page, 'mihomo')).toContainText('Активно');
  await expect(page.locator('#core-modal-confirm-btn')).toBeVisible();
  await expect(page.locator('#core-modal-confirm-btn')).toHaveText('Сделать Xray активным');
});

test('a Mihomo-only router shows one Mihomo card', async ({ page }) => {
  await serveCores(page, { cores: ['mihomo'], current: 'mihomo' });
  await page.goto('/');
  await dropEngineModule(page, 'xray');
  const menu = await openServiceMenu(page);

  await expect(engineSwitch(menu, 'xray')).toBeHidden();
  await expect(engineSwitch(menu, 'mihomo')).toHaveAttribute('aria-pressed', 'true');
  // The card shows its state itself; the hover hint only names the action.
  // It used to keep the first aria-label, read before the engines arrived.
  await expect(engineSwitch(menu, 'mihomo')).toHaveAttribute('data-tooltip', 'Открыть управление ядром Mihomo');
  await engineSwitch(menu, 'mihomo').click();
  await expect(tab(page, 'mihomo')).toHaveAttribute('aria-selected', 'true');
  await expect(tab(page, 'mihomo')).toContainText('Активно');
});

// A stopped service (or a crashed core) has no running engine. The window
// names the one the panel last saw running and starts xkeen with the engine
// of the open tab.
async function serveStopped(page, { lastCore = null } = {}) {
  const posts = [];
  await page.route('**/api/xkeen/status', (route) => route.fulfill({ json: { ok: true, running: false, status: 'stopped', core: null } }));
  await page.route('**/api/xkeen/core', (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({ json: { ok: true, cores: ['xray', 'mihomo'], currentCore: null, lastCore } });
    }
    posts.push(route.request().postDataJSON());
    return route.fulfill({ json: { ok: true, core: posts.at(-1).core, restarted: true } });
  });
  await page.route('**/api/cores/versions', (route) => route.fulfill({ json: { ok: true, cores: {
    xray: { installed: true, version: '26.9.9' }, mihomo: { installed: true, version: 'v1.19.14' },
  } } }));
  return posts;
}

test('a stopped service names the engine that ran last and starts the engine of the open tab', async ({ page }) => {
  const posts = await serveStopped(page, { lastCore: 'xray' });
  await page.goto('/');
  const menu = await openServiceMenu(page);
  const confirm = page.locator('#core-modal-confirm-btn');
  const status = page.locator('#core-modal-status');

  await expect(engineSwitch(menu, 'xray').locator('[data-xk-svc-core-last]')).toBeVisible();
  await expect(engineSwitch(menu, 'xray').locator('[data-xk-svc-core-note]')).toHaveText('26.9.9');
  await expect(engineSwitch(menu, 'mihomo').locator('[data-xk-svc-core-last]')).toBeHidden();

  await engineSwitch(menu, 'xray').click();
  await expect(tab(page, 'xray')).toContainText('Было активным');
  await expect(tab(page, 'xray').locator('[data-core-option-version]')).toHaveText('26.9.9');
  await expect(tab(page, 'mihomo').locator('[data-core-option-version]')).toHaveText('1.19.14');
  await expect(confirm).toHaveText('Запустить xkeen с Xray');
  await expect(status).toHaveText('Служба xkeen остановлена. Последним работало ядро Xray. Кнопка запустит службу с Xray.');

  // The button follows the tab: what is picked is what starts.
  await tab(page, 'mihomo').click();
  await expect(confirm).toHaveText('Запустить xkeen с Mihomo');
  await expect(status).toHaveText('Служба xkeen остановлена. Последним работало ядро Xray. Кнопка выберет Mihomo и запустит службу.');
  await confirm.click();
  await expect.poll(() => posts).toEqual([{ core: 'mihomo' }]);
});

test('a stopped service the panel never saw running offers both engines without a mark', async ({ page }) => {
  await serveStopped(page);
  await page.goto('/');
  const menu = await openServiceMenu(page);
  await expect(menu.locator('[data-xk-svc-core-last]:visible')).toHaveCount(0);

  await engineSwitch(menu, 'xray').click();
  await expect(tab(page, 'xray')).toContainText('Установлено');
  await expect(page.locator('#core-modal-confirm-btn')).toHaveText('Запустить xkeen с Xray');
  await expect(page.locator('#core-modal-status')).toHaveText('Служба xkeen остановлена. Кнопка выберет Xray и запустит службу.');
  await tab(page, 'mihomo').click();
  await expect(page.locator('#core-modal-confirm-btn')).toHaveText('Запустить xkeen с Mihomo');
});

// Both engines have an update. The window has one main action: while its
// footer offers to switch, the update of the card is an ordinary button.
const sourceProfiles = (engine, installed, latest) => ({
  ok: true,
  data: {
    engine_id: engine,
    platform: { machine: 'aarch64', opkg_arch: 'aarch64-3.10', endianness: 'le' },
    state: { selected_profile_id: 'official', installed_profile_id: 'official', last_status: 'idle', detected_version: installed, installed_release_tag: `v${installed}` },
    profiles: [{
      profile_id: 'official', display_name: engine === 'xray' ? 'Официальный Xray' : 'Официальный Mihomo', repo: 'x/y', description: '',
      release: { installable: true, stable: { tag: `v${latest}` }, asset: { name: `${engine}.zip` }, checksum: { sha256: 'a'.repeat(64) } },
    }],
  },
});

for (const [running, other] of [['xray', 'mihomo'], ['mihomo', 'xray']]) {
  test(`with ${running} running, the update of ${other} steps back while switching is offered`, async ({ page }) => {
    await serveCores(page, { cores: ['xray', 'mihomo'], current: running });
    await page.route('**/api/xray/core-profiles', (route) => route.fulfill({ json: sourceProfiles('xray', '26.9.9', '26.10.1') }));
    await page.route('**/api/mihomo/core-profiles', (route) => route.fulfill({ json: sourceProfiles('mihomo', '1.19.14', '1.19.32') }));
    await page.goto('/');
    const menu = await openServiceMenu(page);
    const update = (engine) => page.locator(`#core-modal [data-core-source][data-core-engine="${engine}"] [data-core-source-action="prepare"]`);

    await engineSwitch(menu, other).click();
    await expect(page.locator('#core-modal-confirm-btn')).toBeVisible();
    await expect(update(other)).toContainText('Обновить до');
    await expect(update(other)).toHaveClass(/btn-secondary/);
    await expect(update(other)).not.toHaveClass(/btn-primary/);

    // The running engine's tab offers no switch: its update is the main action.
    await tab(page, running).click();
    await expect(page.locator('#core-modal-confirm-btn')).toBeHidden();
    await expect(update(running)).toContainText('Обновить до');
    await expect(update(running)).toHaveClass(/btn-primary/);
  });
}

test('an open core window follows the service when it stops and starts again', async ({ page }) => {
  await page.clock.install();
  let status = { ok: true, running: true, status: 'running', core: 'mihomo' };
  await page.route('**/api/xkeen/status', (route) => route.fulfill({ json: status }));
  await page.route('**/api/xkeen/core', (route) => route.fulfill({ json: {
    ok: true, cores: ['xray', 'mihomo'], currentCore: status.running ? status.core : null, lastCore: 'mihomo',
  } }));
  await page.route('**/api/cores/versions', (route) => route.fulfill({ json: { ok: true, cores: {
    xray: { installed: true, version: '26.9.9' }, mihomo: { installed: true, version: 'v1.19.14' },
  } } }));
  await page.goto('/');
  const menu = await openServiceMenu(page);
  await engineSwitch(menu, 'xray').click();
  const confirm = page.locator('#core-modal-confirm-btn');
  await expect(tab(page, 'mihomo')).toContainText('Активно');
  await expect(confirm).toHaveText('Сделать Xray активным');

  // The core crashed: the next status poll turns the switch into a start.
  status = { ok: true, running: false, status: 'stopped', core: null };
  await page.clock.fastForward(16000);
  await expect(tab(page, 'mihomo')).toContainText('Было активным');
  await expect(confirm).toHaveText('Запустить xkeen с Xray');
  await expect(page.locator('#core-modal-status')).toHaveText('Служба xkeen остановлена. Последним работало ядро Mihomo. Кнопка выберет Xray и запустит службу.');

  // Started again from the console: the window says so without reopening.
  status = { ok: true, running: true, status: 'running', core: 'mihomo' };
  await page.clock.fastForward(16000);
  await expect(tab(page, 'mihomo')).toContainText('Активно');
  await expect(confirm).toHaveText('Сделать Xray активным');
});

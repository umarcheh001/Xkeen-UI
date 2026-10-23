import { test, expect } from './fixtures.mjs';
import {
  server, installedSnapshot, availableSnapshot, panelUpdatePlan, runningStatus, TERMINAL, withMihomo,
  installIdleLifecycleRoutes, installLifecycleRoutes, advanceClock,
} from './modules_manager_support.mjs';

// The Modules window: the panel summary and its update, the build time, the
// counter of enabled modules, the editor variant and the words of the window.

test.describe('DevTools panel summary boundary', () => {
  const noUpdate = server.update_check_current;

  test('DevTools shows panel identity and one Modules link without legacy update requests', async ({ page }) => {
    const legacyRequests = [];
    await page.route(/\/api\/devtools\/update\//, (route) => {
      legacyRequests.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
      return route.fulfill({ status: 404, json: { ok: false } });
    });
    await page.route('**/api/modules/panel/update-check', (route) => route.fulfill({ json: noUpdate }));
    await installIdleLifecycleRoutes(page);

    await page.goto('/devtools');
    const updateCard = page.locator('#dt-update-card');
    await expect(page.locator('[data-dt-modules-manager-notice]')).toHaveCount(0);
    await expect(page.locator('[data-dt-main-update-controls]')).toHaveCount(0);
    await expect(page.locator('#xk-update-link')).toHaveCount(0);
    await expect(updateCard).toContainText('2.10.0');
    await expect(updateCard.locator('.xk-summary-stat[data-stat="enabled"] b')).toHaveText('2 из 3');
    // Одна ссылка на «Модули и обновления» — в карточке, в шапке её больше нет.
    const modulesLinks = page.locator('a[href$="/modules"]');
    await expect(modulesLinks).toHaveCount(1);
    await expect(updateCard.locator('a[href$="/modules"]')).toHaveText('Открыть «Модули и обновления»');
    await page.waitForTimeout(1000);
    expect(legacyRequests).toEqual([]);
  });

  test('DevTools stretches the panel information card to the ENV bottom edge', async ({ page }) => {
    await page.route('**/api/modules/panel/update-check', (route) => route.fulfill({ json: noUpdate }));
    await installIdleLifecycleRoutes(page);

    await page.goto('/devtools');
    await expect(page.locator('#dt-panel-summary .xk-summary-stats')).toBeVisible();

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
      update_channel: 'prerelease',
      lifecycle: { available: false, code: 'panel_version_unsupported' },
    };
    await installLifecycleRoutes(page, { installed: localBuild });

    await page.goto('/modules');

    const summary = page.locator('.modules-summary');
    await expect(summary.locator('.xk-summary-version')).toHaveText('Локальная сборка d523ffcf');
    await expect(summary.locator('.xk-summary-meta-line')).toContainText('Источник: umarcheh001/Xkeen-UI');
    await expect(summary.locator('.xk-summary-chip')).toHaveText('Предрелизный канал');
    await expect(summary.locator('.xk-summary-channel-hint')).toHaveText('Канал запомнится и сработает, когда панель будет поставлена из выпуска.');
    await expect(summary.locator('.xk-summary-note')).toContainText('Локальная сборка.');
    await expect(summary.locator('.xk-summary-stat[data-stat="update"] span')).toHaveText('обновление из окна недоступно');
    await expect(page.getByText('Версия панели неизвестна')).toHaveCount(0);
    // Подписанные операции недоступны: кнопок проверки и обновления нет.
    await expect(page.getByRole('button', { name: /Проверить/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Обновить/ })).toHaveCount(0);
  });

  test('checks the signed catalog before offering a panel update plan', async ({ page }) => {
    await installIdleLifecycleRoutes(page);
    await page.route('**/api/modules/panel/update-check', (route) => route.fulfill({ json: server.update_check }));
    await page.route('**/api/modules/operations/plan', (route) => route.fulfill({ json: panelUpdatePlan }));

    await page.goto('/modules');
    const summary = page.locator('.modules-summary');
    await expect(summary.locator('.xk-summary-chip')).toHaveText('Стабильный канал');
    // Сохранённый ответ каталога приходит сам, кнопка проверяет заново.
    await expect(summary.locator('.xk-summary-stat[data-stat="update"] b')).toHaveText('2.11.0');
    await expect(summary.locator('.xk-summary-stat[data-stat="update"] span')).toHaveText('доступно обновление');
    await page.getByRole('button', { name: 'Проверить ещё раз' }).click();
    await expect(summary).toContainText('Обновит панель и все модули одним выпуском.');
    await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('xkeen.modules.update.v2'))?.targetVersion)).toBe('2.11.0');
    await page.getByRole('button', { name: 'Обновить до 2.11.0' }).click();
    await expect(page.getByRole('dialog', { name: 'Обновить панель до 2.11.0' })).toContainText('2.10.0 → 2.11.0');
  });

  test('a kept catalog older than an hour is checked again on GitHub when the screen opens', async ({ page }) => {
    await installIdleLifecycleRoutes(page);
    const forced = [];
    const keptAt = Date.now() / 1000 - 3 * 60 * 60;
    await page.route('**/api/modules/panel/update-check', (route) => {
      const force = Boolean(route.request().postDataJSON()?.force_refresh);
      forced.push(force);
      return route.fulfill({ json: force
        ? { ...server.update_check, fetched_at: Date.now() / 1000 }
        : { ...server.update_check_current, fetched_at: keptAt } });
    });
    await page.goto('/modules');

    // The kept copy said "no update"; the fresh one from GitHub finds 2.11.0.
    const stat = page.locator('.modules-summary .xk-summary-stat[data-stat="update"]');
    await expect(stat.locator('b')).toHaveText('2.11.0');
    expect(forced).toEqual([false, true]);
  });

  test('a kept catalog of the last hour is not checked again', async ({ page }) => {
    await installIdleLifecycleRoutes(page);
    const forced = [];
    await page.route('**/api/modules/panel/update-check', (route) => {
      forced.push(Boolean(route.request().postDataJSON()?.force_refresh));
      return route.fulfill({ json: { ...server.update_check, fetched_at: Date.now() / 1000 - 10 * 60 } });
    });
    await page.goto('/modules');

    await expect(page.locator('.modules-summary .xk-summary-stat[data-stat="update"] b')).toHaveText('2.11.0');
    await page.waitForTimeout(500);
    expect(forced).toEqual([false]);
  });

  test('says that the update answer comes from an old copy of the catalog', async ({ page }) => {
    await installIdleLifecycleRoutes(page);
    await page.route('**/api/modules/panel/update-check', (route) => route.fulfill({ json: {
      ...server.update_check_current,
      freshness: 'stale', stale_reason: 'catalog_transport_unavailable', fetched_at: 1791000000.5,
    } }));
    await page.goto('/modules');

    await page.getByRole('button', { name: 'Проверить ещё раз' }).click();

    const check = page.locator('.modules-summary .xk-summary-col.is-controls');
    await expect(check).toContainText('Не удалось связаться с GitHub');
    await expect(check).toContainText(await page.evaluate(() => new Date(1791000000500).toLocaleDateString('ru-RU')));
    await expect(check.locator('.xk-summary-stat[data-stat="update"] span')).toHaveText('актуальна по сохранённым данным');
  });

  test('explains the stable channel before its first modular release', async ({ page }) => {
    await installIdleLifecycleRoutes(page);
    await page.route('**/api/modules/panel/update-check', (route) => route.fulfill({ json: {
      ...server.update_check_current,
      source_version: '2.10.0-beta.2', target_version: null, stable_unreleased: true,
    } }));
    await page.goto('/modules');

    await page.getByRole('button', { name: 'Проверить ещё раз' }).click();

    const check = page.locator('.modules-summary .xk-summary-col.is-controls');
    await expect(check.getByRole('status')).toHaveText(
      'Вы на стабильном канале, а все текущие обновления пока выходят как пререлизы. Как только появится стабильный выпуск, панель предложит его здесь.',
    );
    await expect(check.locator('.xk-summary-stat[data-stat="update"] span')).toHaveText('стабильных выпусков пока нет');
    // Номер беты не обрезается: выпуск крупно, метка беты рядом мелко.
    const number = check.locator('.xk-summary-stat[data-stat="update"] b');
    await expect(number).toHaveText('2.10.0 beta.2');
    await expect(number.locator('small')).toHaveText('beta.2');
    expect(await number.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await expect(check.getByRole('button', { name: /Обновить/ })).toHaveCount(0);
  });

  test('a local build of a release updates the panel and shows the module catalog read-only', async ({ page }) => {
    const local = { ...installedSnapshot, panel_version: '2.10.0+local.f46f1f10', lifecycle: { available: true, code: null, local: true },
      modules: installedSnapshot.modules.map((item) => ({ ...item, lifecycle_actions: [] })) };
    const readOnly = { ...availableSnapshot, read_only: true,
      modules: availableSnapshot.modules.map((item) => ({ ...item, lifecycle_actions: [] })) };
    await installLifecycleRoutes(page, { installed: local, available: readOnly });
    await page.route('**/api/modules/panel/update-check', (route) => route.fulfill({ json: {
      ...server.update_check_current, source_version: '2.10.0+local.f46f1f10', target_version: '2.11.0', update_available: true,
    } }));
    await page.goto('/modules');

    await expect(page.getByRole('button', { name: 'Обновить до 2.11.0' })).toBeVisible();
    await expect(page.locator('.modules-summary .xk-summary-note')).toContainText('Локальная сборка.');
    await page.getByRole('tab', { name: 'Доступные' }).click();
    const host = page.locator('#modules-card-host');
    await expect(host.locator('.modules-catalog-readonly')).toHaveText(
      `Только просмотр. Это локальная сборка: модули ставятся на выпуске панели. Каталог — выпуска ${readOnly.release_version}.`,
    );
    await expect(host.locator('.modules-card').filter({ hasText: TERMINAL })).toBeVisible();
    await expect(host.getByRole('button')).toHaveCount(0);
  });

  test('keeps update feedback focused and clears a stale badge after a failed check', async ({ page }) => {
    await installIdleLifecycleRoutes(page);
    await page.route('**/api/modules/panel/update-check', (route) => route.fulfill({ status: 503, json: {
      ok: false,
      code: 'catalog_unavailable',
      error: 'offline',
    } }));
    await page.goto('/modules');
    await page.evaluate(() => sessionStorage.setItem('xkeen.modules.update.v2', JSON.stringify({
      schema: 2,
      sourceVersion: '2.10.0',
      targetVersion: '2.11.0',
      channel: 'stable',
    })));

    await page.getByRole('button', { name: 'Проверить обновления' }).click();

    const check = page.locator('.modules-summary .xk-summary-col.is-controls');
    await expect(check.getByRole('status')).toContainText('Каталог модулей временно недоступен.');
    await expect(check.locator('.xk-summary-stat[data-stat="update"] span')).toHaveText('не удалось проверить');
    await expect(check.getByRole('button', { name: 'Проверить обновления' })).toBeFocused();
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem('xkeen.modules.update.v2'))).toBeNull();
  });
});

test.describe('Modules build time', () => {
  test.use({ timezoneId: 'Europe/Moscow' });

  test('shows the same local build time as DevTools instead of raw UTC', async ({ page }) => {
    const snapshot = {
      ...installedSnapshot,
      build: { ...installedSnapshot.build, built_utc: '2026-10-13T15:52:13Z' },
    };
    await installLifecycleRoutes(page, { installed: snapshot });
    for (const [path, root] of [['/modules', '.modules-summary'], ['/devtools', '#dt-panel-summary']]) {
      await page.goto(path);
      const summary = page.locator(root);
      await expect(summary.locator('.xk-summary-meta-line')).toContainText('собрано 13.10.2026');
      await summary.locator('.xk-summary-more > summary').click();
      await expect(summary.locator('.xk-summary-facts')).toContainText('13.10.2026, 18:52:13');
    }
  });
});

test.describe('Enabled modules counter', () => {
  const nine = ['core', 'engine.xray', 'engine.mihomo', 'tool.editor', 'tool.terminal', 'tool.files', 'tool.backups', 'integration.happ', 'tool.advanced-diagnostics'];
  const withSets = (off, sets) => ({
    ...installedSnapshot,
    profile: 'custom',
    ...sets,
    modules: nine.map((id) => ({ id, name: id, version: '1.0.0', enabled: !off.includes(id), can_disable: id !== 'core' })),
  });
  const enabled = (page) => page.locator('.modules-summary .xk-summary-stat[data-stat="enabled"]');

  test('the summary counts enabled modules instead of printing the stored label', async ({ page }) => {
    await installLifecycleRoutes(page, { status: { ok: true, result: null }, installed: withSets([], { installed_set: 'full', enabled_set: 'full' }) });
    await page.goto('/modules');
    await expect(enabled(page).locator('b')).toHaveText('9 из 9');
    await expect(enabled(page).locator('span')).toHaveText('модулей включено');
    await expect(page.locator('.modules-summary')).not.toContainText('custom');
    await expect(page.locator('.modules-summary')).not.toContainText('Профиль:');
  });

  test('modules switched off lower the counter', async ({ page }) => {
    await installLifecycleRoutes(page, {
      status: { ok: true, result: null },
      installed: withSets(['engine.mihomo', 'tool.terminal'], { installed_set: 'full', enabled_set: 'custom' }),
    });
    await page.goto('/modules');
    await expect(enabled(page).locator('b')).toHaveText('7 из 9');
  });
});

test.describe('Editor variant choice', () => {
  // Mihomo is on, so the editors cannot be switched off.
  // Unless told otherwise, the running panel has loaded the chosen variant.
  const withEditor = (editor, extra = {}) => ({
    ...withMihomo(true),
    restart_required: false,
    editor: { ...withMihomo(true).editor, installed_variant: 'full', active_variant: editor.variant, ...editor },
    ...extra,
  });

  test('the Editors row offers three variants in rising order and saves the chosen one', async ({ page }) => {
    let snapshot = withEditor({ variant: 'full' });
    const patches = [];
    await page.route('**/api/modules/installed', (route) => route.fulfill({ json: snapshot }));
    await page.route('**/api/modules/operations/status', (route) => route.fulfill({ json: { ok: true, result: null } }));
    await page.route('**/api/modules/editor', (route) => {
      patches.push(`${route.request().method()} ${route.request().postData()}`);
      snapshot = withEditor({ variant: 'advanced' }, { restart_required: true });
      return route.fulfill({ json: { ok: true, changed: true } });
    });

    await page.goto('/modules');
    const row = page.locator('.modules-tile[data-module-id="tool.editor"]');
    const options = row.getByRole('group', { name: 'Вариант редакторов' }).getByRole('button');
    await expect(options).toHaveText(['Лёгкий', 'Стандартный', 'Расширенный']);
    await expect(options.nth(1)).toHaveAttribute('aria-pressed', 'true');
    await expect(row.locator('.modules-tile-foot')).toHaveText('Нужен, пока включено ядро');
    await expect(row).toContainText('Стандартный: всё из лёгкого, редактор Monaco и сравнение версий.');
    await expect(row.getByRole('switch')).toHaveCount(0);

    await options.nth(2).click();

    await expect(options.nth(2)).toHaveAttribute('aria-pressed', 'true');
    await expect(options.nth(2)).toBeFocused();
    await expect(options.nth(1)).toHaveAttribute('aria-pressed', 'false');
    await expect(row).toContainText('Расширенный: всё из стандартного');
    await expect(page.getByText('Требуется перезапуск')).toBeVisible();
    expect(patches).toEqual(['PATCH {"variant":"advanced"}']);

    // The chosen variant is not sent again.
    await options.nth(2).click();
    expect(patches).toHaveLength(1);
  });

  test('a local build with the light editor keeps the variants that need files closed', async ({ page }) => {
    await installLifecycleRoutes(page, {
      status: { ok: true, result: null },
      installed: withEditor({ variant: 'light', installed_variant: 'light' }, {
        panel_version: null,
        lifecycle: { available: false, code: 'panel_version_unsupported' },
      }),
    });

    await page.goto('/modules');
    const row = page.locator('.modules-tile[data-module-id="tool.editor"]');
    const options = row.getByRole('group', { name: 'Вариант редакторов' }).getByRole('button');
    await expect(options.nth(0)).toHaveAttribute('aria-pressed', 'true');
    await expect(options.nth(1)).toBeDisabled();
    await expect(options.nth(2)).toBeDisabled();
    await expect(row).toContainText('На локальной сборке докачка недоступна.');
  });

  test('the variant buttons read as one control in both themes', async ({ page }) => {
    await installLifecycleRoutes(page, { status: { ok: true, result: null }, installed: withEditor({ variant: 'full' }) });
    for (const theme of ['dark', 'light']) {
      await page.addInitScript((value) => { localStorage.setItem('xkeen-theme', value); }, theme);
      await page.goto('/modules');
      const options = page.locator('.modules-variant-option');
      await expect(options).toHaveCount(3);
      const look = await options.evaluateAll((buttons) => buttons.map((button) => {
        const style = getComputedStyle(button);
        const box = button.getBoundingClientRect();
        return { radius: style.borderTopLeftRadius, background: style.backgroundColor, color: style.color, top: Math.round(box.top), height: Math.round(box.height) };
      }));
      expect(new Set(look.map((item) => item.radius)), theme).toEqual(new Set(['0px']));
      expect(new Set(look.map((item) => item.top)).size, theme).toBe(1);
      expect(new Set(look.map((item) => item.height)).size, theme).toBe(1);
      expect(look[1].background, theme).not.toBe(look[0].background);
      expect(look[1].color, theme).toBe('rgb(255, 255, 255)');
    }
  });

  test('the editor variants are not folded: the pressed button names the choice', async ({ page }) => {
    await installLifecycleRoutes(page, { status: { ok: true, result: null }, installed: withEditor({ variant: 'advanced' }) });
    await page.goto('/modules');
    const row = page.locator('.modules-tile[data-module-id="tool.editor"]');
    await expect(row.locator('.modules-variant-block details, details.modules-variant-block, .modules-variant-block summary')).toHaveCount(0);
    await expect(row.locator('.modules-variant-option[aria-pressed="true"]')).toHaveText('Расширенный');
    await expect(row.locator('.modules-variant-option')).toHaveCount(3);
    await expect(row.locator('.modules-variant-option').first()).toBeVisible();
  });

  // What the server answers once «Расширенный» is chosen over a light install:
  // the same modules are wanted, only the editor files are missing.
  const lightToAdvanced = (extra = {}) => withEditor(
    { variant: 'advanced', installed_variant: 'light', active_variant: 'light' },
    {
      restart_required: true,
      transition_required: true,
      transition_target: { profile: 'custom', module_ids: [...withMihomo(true).installed_module_ids], editor_variant: 'advanced' },
      ...extra,
    },
  );

  test('a variant that needs files is applied from the summary, the tile only tells', async ({ page }) => {
    await installLifecycleRoutes(page, { status: { ok: true, result: null }, installed: lightToAdvanced() });
    await page.goto('/modules');
    const row = page.locator('.modules-tile[data-module-id="tool.editor"]');
    const summary = page.locator('.modules-summary');

    await expect(row.locator('.modules-variant-pending')).toHaveText(
      'Сейчас работает «Лёгкий». «Расширенный» включится после кнопки «Докачать и перезапустить» вверху.',
    );
    await expect(row.getByRole('button', { name: /Применить|Докачать/ })).toHaveCount(0);
    await expect(summary).toContainText('Нужно докачать файлы редакторов и перезапустить панель');
    await expect(summary).not.toContainText('Требуется перезапуск');
    const apply = summary.getByRole('button', { name: 'Докачать и перезапустить' });
    await expect(apply).toBeVisible();
    await expect(apply).toHaveClass(/btn-primary/);
    await expect(summary.getByRole('button', { name: 'Применить профиль' })).toHaveCount(0);

  });

  test('a pending set of modules keeps its general words', async ({ page }) => {
    const installed = lightToAdvanced({
      transition_target: { profile: 'full', module_ids: [...withMihomo(true).installed_module_ids, 'tool.terminal'], editor_variant: 'advanced' },
    });
    await installLifecycleRoutes(page, { status: { ok: true, result: null }, installed });
    await page.goto('/modules');
    const summary = page.locator('.modules-summary');

    await expect(summary).toContainText('Нужно применить набор модулей и перезапустить панель');
    await expect(summary.getByRole('button', { name: 'Применить профиль' })).toBeVisible();
    await expect(page.locator('.modules-tile[data-module-id="tool.editor"] .modules-variant-pending'))
      .toHaveText('Сейчас работает «Лёгкий». «Расширенный» включится, когда набор модулей будет применён.');
  });

  test('a local build says the choice waits for a release and offers no transition', async ({ page }) => {
    const installed = lightToAdvanced({
      panel_version: '2.10.0-beta.3+local.abc',
      lifecycle: { available: true, code: null, local: true },
    });
    await installLifecycleRoutes(page, { status: { ok: true, result: null }, installed });
    await page.goto('/modules');
    const row = page.locator('.modules-tile[data-module-id="tool.editor"]');

    await expect(row.locator('.modules-variant-pending.is-muted')).toHaveText(
      'Сейчас работает «Лёгкий». «Расширенный» докачивает файлы, а на локальной сборке докачки нет — выбор вступит в силу на выпуске.',
    );
    await expect(row).not.toContainText('На локальной сборке докачка недоступна.');
    await expect(page.locator('[data-operation="profile-transition"]')).toHaveCount(0);
  });

  test('standard to advanced waits only for a restart and is clean after it', async ({ page }) => {
    let installed = withEditor({ variant: 'advanced', installed_variant: 'full', active_variant: 'full' }, { restart_required: true });
    await page.route('**/api/modules/installed', (route) => route.fulfill({ json: installed }));
    await page.route('**/api/modules/operations/status', (route) => route.fulfill({ json: { ok: true, result: null } }));
    await page.route('**/api/modules/available', (route) => route.fulfill({ json: server.available }));
    await page.goto('/modules');
    const row = page.locator('.modules-tile[data-module-id="tool.editor"]');

    await expect(row.locator('.modules-variant-pending'))
      .toHaveText('«Расширенный» включится после перезапуска панели. Докачивать ничего не нужно.');
    await expect(page.locator('.modules-summary')).toContainText('Требуется перезапуск');
    await expect(page.locator('.modules-summary').getByRole('button', { name: 'Перезапустить панель' })).toBeVisible();

    // After the restart the panel runs the chosen variant; the installer
    // record still names the standard one, and that is no difference.
    installed = withEditor({ variant: 'advanced', installed_variant: 'full', active_variant: 'advanced' });
    await page.reload();
    await expect(row.locator('.modules-variant-block')).toBeAttached();
    await expect(row.locator('.modules-variant-pending')).toHaveCount(0);
  });

  test('the editor files are fetched in the operation window named after them', async ({ page }) => {
    const plan = {
      ...server.panel_update_plan,
      scope: 'profile', operation: 'profile-transition', version: '2.10.0', source_version: '2.10.0', target_version: '2.10.0',
      target_profile: lightToAdvanced().transition_target,
      files_add: ['static/monaco-editor/vs/loader.js', 'static/js/vendor/prettier-standalone.js'],
      files_remove: [], required_free_bytes: 9_400_000, restart_required: true, blockers: [], applicable: true, plan_id: 'f'.repeat(64),
    };
    const step = (name) => ({ ...server.install_steps[name], scope: 'profile', operation: 'profile-transition', module_id: null });
    let status = { ok: true, result: null };
    const after = withEditor({ variant: 'advanced', installed_variant: 'advanced', active_variant: 'advanced' });
    await page.route('**/api/modules/installed', (route) => route.fulfill({ json: status.result === 'committed' ? after : lightToAdvanced() }));
    await page.route('**/api/modules/operations/status', (route) => route.fulfill({ json: status }));
    await page.route('**/api/modules/available', (route) => route.fulfill({ json: server.available }));
    await page.route('**/api/modules/operations/plan', (route) => route.fulfill({ json: plan }));
    await page.route('**/api/modules/operations/apply', (route) => {
      status = step('prepared');
      return route.fulfill({ status: 202, json: { ok: true, operation_id: status.operation_id, status } });
    });
    await page.goto('/modules');
    await page.evaluate(() => { window.xkBeforeTransition = true; });

    await page.locator('.modules-summary').getByRole('button', { name: 'Докачать и перезапустить' }).click();
    const dialog = page.getByRole('dialog', { name: 'Докачать файлы редакторов и перезапустить' });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.modules-plan-facts')).toContainText('Редакторы: «Лёгкий» → «Расширенный»');
    await dialog.getByRole('button', { name: 'Докачать и перезапустить' }).click();
    await expect(dialog.locator('.modules-plan-progress-head strong')).toHaveText('Подготовка');
    await expect(dialog.getByRole('button', { name: 'Докачка…' })).toBeDisabled();

    // The runner restarts the panel; after the reload the window tells the end in the same words.
    status = { ...server.install_committed, scope: 'profile', operation: 'profile-transition', module_id: null };
    await expect.poll(() => page.evaluate(() => window.xkBeforeTransition === true).catch(() => true), { timeout: 15000 }).toBe(false);
    const done = page.getByRole('dialog', { name: 'Редакторы переведены на «Расширенный»' });
    await expect(done).toBeVisible();
    await expect(done.locator('.modules-plan-progress-head output')).toHaveText('7 из 7');
    await done.getByRole('button', { name: 'Готово' }).click();
    await expect(page.locator('.modules-tile[data-module-id="tool.editor"] .modules-variant-pending')).toHaveCount(0);
  });

  test('DevTools names the missing editor files instead of a restart', async ({ page }) => {
    await installLifecycleRoutes(page, { status: { ok: true, result: null }, installed: lightToAdvanced() });
    await page.route('**/api/modules/panel/update-check', (route) => route.fulfill({ json: server.update_check_current }));
    await page.goto('/devtools');
    const card = page.locator('#dt-update-card');
    await expect(card).toContainText('Нужно докачать файлы редакторов — откройте «Модули и обновления»');
    await expect(card).not.toContainText('Нужен перезапуск');
  });
});

// The stubs here keep the shape the server really sends: seconds with a
// fraction, the runner's own step names, the four keys of the dependency diff.
test.describe('What the window says about operations and refusals', () => {
  const T0 = 1791571142.1234567;
  const named = {
    ...installedSnapshot,
    modules: [
      ...installedSnapshot.modules,
      { id: 'tool.files', name: 'Файловый менеджер', version: '1.0.0', enabled: true, can_disable: true, lifecycle_actions: ['repair', 'remove'] },
    ],
  };
  const failedUpdate = {
    ok: true, operation_id: 'op-7f3a', scope: 'panel', operation: 'panel-update', module_id: null, version: '2.11.0',
    step: 'rolling_back', result: 'rolled_back', error_code: 'operation_environment_failed',
    error: 'the router could not be prepared for the release',
    error_detail: 'pip: No space left on device', failed_path: 'xkeen-ui/requirements.txt', environment_restored: false,
    warnings: [{ code: 'package_missing', package: 'python3-light', command: 'opkg install python3-light' }, { code: 'packages_step_failed' }],
    started_at: T0, finished_at: T0 + 47.71, restart_required: false,
    log: [{ step: 'prepared', at: T0 + 0.2 }, { step: 'downloading', at: T0 + 1.4 }, { step: 'rolling_back', at: T0 + 39.6 }],
  };
  const realPlan = {
    ok: true, operation: 'install', module_id: 'tool.terminal', scope: 'module', version: '2.10.0',
    affected_module_ids: ['tool.terminal'], files_add: [{ path: 'a' }, { path: 'b' }], files_remove: [],
    required_free_bytes: 12 * 1024 * 1024, restart_required: true, target_profile: null,
    dependency_diff: { requires: ['core'], missing: [], conflicts: [], required_by: ['tool.files'] },
    blockers: [], applicable: true, plan_id: 'b'.repeat(64),
  };
  const realCatalog = {
    ok: true, release_version: '2.10.0', fetched_at: 1791560000, freshness: 'fresh', stale_reason: null,
    modules: [
      { id: 'tool.files', name: 'Файловый менеджер', version: '2.10.0', requires: ['core'], conflicts: [], installed: true, lifecycle_actions: ['repair', 'remove'] },
      { id: 'tool.terminal', name: 'Терминал и команды', version: '2.10.0', requires: ['core'], conflicts: ['tool.files'], installed: false, lifecycle_actions: ['install'] },
    ],
  };

  test('a failed operation names itself, its cause and what is missing', async ({ page }) => {
    await installLifecycleRoutes(page, { status: failedUpdate, installed: named });
    await page.goto('/modules');
    const block = page.locator('.modules-operation');
    await expect(block.locator('h2')).toContainText('Обновление панели до 2.11.0');
    await expect(block.locator('.modules-chip')).toHaveText('Отменено, файлы возвращены');
    await expect(block).toContainText(/Начато \d{2}\.\d{2}\.\d{4}, \d{2}:\d{2}:\d{2} · длилось 48 с/);
    await expect(block).not.toContainText('1791571142');
    await expect(block).toContainText('Роутер не удалось подготовить к новому выпуску.');
    await expect(block).toContainText('pip: No space left on device');
    await expect(block).toContainText('Сорвалось на файле xkeen-ui/requirements.txt');
    await expect(block).toContainText('Окружение роутера не восстановлено.');
    await expect(block).toContainText('Не установлен пакет python3-light.');
    await expect(block.locator('.modules-command code')).toHaveText('opkg install python3-light');
    await expect(block.getByRole('button', { name: 'Копировать' })).toBeVisible();
    await expect(block).toContainText('Установка пакетов завершилась с ошибкой.');
    const steps = block.locator('.modules-operation-log');
    await expect(steps).toHaveCount(3);
    await expect(steps.nth(1)).toHaveText(/^\d{2}:\d{2}:\d{2}Загрузка архива$/);
    await expect(steps.nth(2)).toContainText('Возврат прежних файлов');
    for (const word of ['rolled_back', 'rolling_back', 'downloading', 'prepared']) await expect(block).not.toContainText(word);
    // An operation that was undone is not marked with the colour of success.
    const stripe = await block.evaluate((node) => getComputedStyle(node).borderLeftColor);
    expect(stripe).toBe('rgb(194, 65, 58)');
  });

  test('an operation on a module is called by the module name', async ({ page }) => {
    await installLifecycleRoutes(page, {
      installed: named,
      status: { ...runningStatus, operation: 'remove', module_id: 'tool.files', version: '1.0.0', step: 'applying', started_at: T0, log: [{ step: 'applying', at: T0 }] },
    });
    await page.goto('/modules');
    const block = page.locator('.modules-operation');
    await expect(block.locator('h2')).toContainText('Удаление модуля «Файловый менеджер» 1.0.0');
    await expect(block.locator('.modules-chip')).toHaveText('Выполняется');
    await expect(block).toContainText('Сейчас: Замена файлов');
  });

  test('warnings and refusals are set apart from plain text in both themes', async ({ page }) => {
    await installLifecycleRoutes(page, { status: failedUpdate, installed: { ...named, restart_required: true } });
    for (const theme of ['dark', 'light']) {
      await page.addInitScript((value) => { localStorage.setItem('xkeen-theme', value); }, theme);
      await page.goto('/modules');
      await page.locator('.modules-operation .modules-alert').first().waitFor();
      const look = await page.evaluate(() => {
        const read = (selector) => {
          const style = getComputedStyle(document.querySelector(selector));
          return { stripe: style.borderLeftWidth, colour: style.borderLeftColor, fill: style.backgroundColor };
        };
        return {
          alert: read('.modules-operation .modules-alert'),
          warning: read('.modules-operation .modules-warning'),
          restart: read('.modules-summary .modules-warning'),
          plain: getComputedStyle(document.querySelector('.modules-summary .xk-summary-version')).backgroundColor,
        };
      });
      expect(look.alert.stripe, theme).toBe('3px');
      expect(look.warning.stripe, theme).toBe('3px');
      expect(look.alert.colour, theme).not.toBe(look.warning.colour);
      expect(look.alert.fill, theme).not.toBe(look.plain);
      expect(look.restart.colour, theme).toBe(look.warning.colour);
    }
  });

  test('the plan speaks of modules by name and shows the free space next to the needed', async ({ page }) => {
    await installLifecycleRoutes(page, { installed: named, available: realCatalog });
    await page.route('**/api/modules/operations/plan', (route) => route.fulfill({ json: {
      ...realPlan, applicable: false, plan_id: null,
      blockers: [{ code: 'module_free_space', message: 'not enough free space for the operation and its rollback copy', required: 12 * 1024 * 1024, free: 3 * 1024 * 1024 }],
    } }));
    await page.goto('/modules');
    await page.getByRole('tab', { name: 'Доступные' }).click();
    await page.getByRole('button', { name: 'Установить Терминал и команды' }).click();
    const dialog = page.getByRole('dialog', { name: 'Установить «Терминал и команды»' });
    const facts = dialog.locator('.modules-plan-facts');
    await expect(facts.locator('dt')).toHaveText(['Модуль', 'Версия', 'Файлы', 'Место', 'Нужны модули', 'От него зависят']);
    await expect(facts.locator('dd')).toHaveText([
      'Терминал и команды', '2.10.0', 'добавить 2, удалить 0', 'нужно 12 МБ, свободно 3 МБ',
      'Xkeen UI Core', 'Файловый менеджер',
    ]);
    await expect(dialog.locator('.modules-alert')).toContainText('Недостаточно свободного места. Нужно 12 МБ, свободно 3 МБ.');
    // A plan that cannot be applied restarts nothing.
    await expect(dialog.locator('.modules-warning')).toHaveCount(0);
    for (const word of ['requires', 'required_by', 'module', 'tool.']) await expect(facts).not.toContainText(word);
    await expect(dialog.getByRole('button', { name: 'Установить', exact: true })).toBeHidden();
    const border = await dialog.evaluate((node) => getComputedStyle(node).borderTopWidth);
    expect(border).toBe('1px');
  });

  test('a refusal to apply is said inside the plan, in the words of the server', async ({ page }) => {
    await installLifecycleRoutes(page, { installed: named, available: realCatalog });
    await page.route('**/api/modules/operations/plan', (route) => route.fulfill({ json: realPlan }));
    let refusal = { ok: false, code: 'dns_guard_refused', message: 'Сначала безопасно снимите активную DNS-защиту' };
    await page.route('**/api/modules/operations/apply', (route) => route.fulfill({ status: 409, json: refusal }));
    await page.goto('/modules');
    await page.getByRole('tab', { name: 'Доступные' }).click();
    await page.getByRole('button', { name: 'Установить Терминал и команды' }).click();
    const dialog = page.getByRole('dialog', { name: 'Установить «Терминал и команды»' });
    const apply = dialog.getByRole('button', { name: 'Установить', exact: true });
    await apply.click();
    const error = dialog.locator('.modules-plan-error');
    await expect(error).toHaveText('План не применён. Сначала безопасно снимите активную DNS-защиту (dns_guard_refused)');
    await expect(page.locator('#modules-error')).toBeEmpty();
    await expect(apply).toBeEnabled();

    // Words meant for a log, a path or markup are never shown as sent.
    refusal = { ok: false, code: 'weird_refusal', message: 'Ошибка в /opt/etc/private <b>x</b>' };
    await apply.click();
    await expect(error).toHaveText('План не применён. Не удалось выполнить операцию с модулями. (weird_refusal)');
    await expect(dialog.locator('.modules-plan-error')).toHaveCount(1);
  });

  test('the Available tab marks what is installed and offers no actions on it', async ({ page }) => {
    await installLifecycleRoutes(page, { installed: named, available: { ...realCatalog, freshness: 'stale', stale_reason: 'network' } });
    await page.goto('/modules');
    await page.getByRole('tab', { name: 'Доступные' }).click();
    const host = page.locator('#modules-card-host');
    await expect(host.locator('.modules-warning')).toContainText('Каталог мог устареть. Не удалось связаться с GitHub, показан каталог выпуска 2.10.0 от');
    await expect(host.getByRole('button', { name: 'Обновить каталог' })).toBeVisible();
    const files = host.locator('.modules-card').filter({ hasText: 'Файловый менеджер 2.10.0' });
    await expect(files.locator('.modules-chip')).toHaveText('Установлен');
    await expect(files.getByRole('button')).toHaveCount(0);
    const terminal = host.locator('.modules-card').filter({ hasText: 'Терминал и команды' });
    await expect(terminal.locator('.modules-chip')).toHaveCount(0);
    await expect(terminal).toContainText('Нужны модули: Xkeen UI Core');
    await expect(terminal).toContainText('Конфликтуют: Файловый менеджер');
    await expect(terminal.getByRole('button', { name: 'Установить Терминал и команды' })).toBeVisible();
  });

  test('a fresh catalog carries no warning', async ({ page }) => {
    await installLifecycleRoutes(page, { installed: named, available: realCatalog });
    await page.goto('/modules');
    await page.getByRole('tab', { name: 'Доступные' }).click();
    await expect(page.locator('#modules-card-host .modules-card')).toHaveCount(2);
    await expect(page.locator('#modules-card-host .modules-warning')).toHaveCount(0);
  });

  test('a catalog that failed to load stays said, once, with a way to try again', async ({ page }) => {
    await installLifecycleRoutes(page, { installed: named, status: { ...runningStatus, started_at: T0 } });
    let fail = true;
    let requests = 0;
    await page.route('**/api/modules/available', (route) => {
      requests += 1;
      return fail ? route.fulfill({ status: 503, json: { ok: false, code: 'catalog_unavailable' } }) : route.fulfill({ json: realCatalog });
    });
    await page.clock.install();
    await page.goto('/modules');
    await page.getByRole('tab', { name: 'Доступные' }).click();
    const host = page.locator('#modules-card-host');
    await expect(host.locator('.modules-alert')).toContainText('Каталог модулей временно недоступен. (catalog_unavailable)');
    // The running operation is asked about every second.
    await advanceClock(page, 3500);
    await expect(host.locator('.modules-alert')).toHaveCount(1);
    await expect(host).not.toContainText('Загрузка каталога');
    await expect(page.locator('#modules-error')).toBeEmpty();
    expect(requests).toBe(1);

    fail = false;
    await host.getByRole('button', { name: 'Повторить' }).click();
    await expect(host.locator('.modules-card')).toHaveCount(2);
    await expect(host.locator('.modules-alert')).toHaveCount(0);
  });

  test('the tab the owner left is the one they come back to', async ({ page }) => {
    await installLifecycleRoutes(page, { installed: named, available: realCatalog });
    await page.goto('/modules');
    await page.getByRole('tab', { name: 'Доступные' }).click();
    await expect(page.locator('#modules-card-host .modules-card')).toHaveCount(2);
    await page.evaluate(async () => {
      const controller = (await import('/static/js/pages/modules.init.js')).getModulesController();
      controller.deactivate();
      await controller.activate();
    });
    await expect(page.getByRole('tab', { name: 'Доступные' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#modules-card-host .modules-card')).toHaveCount(2);
  });

  test('DevTools says about an update in its card, not in the header', async ({ page }) => {
    await page.addInitScript(() => {
      sessionStorage.setItem('xkeen.modules.update.v2', JSON.stringify({ schema: 2, sourceVersion: '2.10.0', targetVersion: '2.11.0', channel: 'stable' }));
    });
    await installIdleLifecycleRoutes(page);
    await page.route('**/api/modules/panel/update-check', (route) => route.fulfill({ json: server.update_check }));
    await page.goto('/devtools');
    await expect(page.locator('header [data-xk-modules-update-badge]')).toHaveCount(0);
    await expect(page.locator('#dt-panel-summary .xk-summary-stat[data-stat="update"] b')).toHaveText('2.11.0');
    await expect(page.locator('#dt-panel-summary .xk-summary-link')).toHaveClass(/is-primary/);
  });
});

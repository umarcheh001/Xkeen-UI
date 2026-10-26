import { test, expect } from './fixtures.mjs';
import {
  server, panelUpdatePlan, runningStatus, installIdleLifecycleRoutes,
  installPanelPrepareRoutes, prepareStep, prepareReady, PANEL_ARCHIVE_BYTES,
} from './modules_manager_support.mjs';

// «Обновить до …» prepares the update in the background: the window opens at
// once and walks the first three of the seven steps of the operation, stops
// on «3 из 7» with the plan and goes on along the same bar after «Обновить».

const downloading = (bytes) => prepareStep({ phase: 'downloading', downloaded_bytes: bytes, total_bytes: PANEL_ARCHIVE_BYTES });

async function openModules(page) {
  await installIdleLifecycleRoutes(page);
  await page.route('**/api/modules/panel/update-check', (route) => route.fulfill({ json: server.update_check }));
  await page.goto('/modules');
}

const updateButton = (page) => page.getByRole('button', { name: 'Обновить до 2.11.0' });
const updateDialog = (page) => page.getByRole('dialog', { name: 'Обновить панель до 2.11.0' });
const progressBox = (page) => page.locator('#modules-plan-progress .modules-plan-progress-box');

test('окно открывается сразу и показывает загрузку', async ({ page }) => {
  const calls = await installPanelPrepareRoutes(page, { steps: [prepareStep(), downloading(7444889)] });
  await openModules(page);
  await updateButton(page).click();

  await expect(updateDialog(page)).toBeVisible();
  await expect(updateDialog(page)).toContainText('Роутер скачивает выпуск с GitHub и проверяет его.');
  await expect(progressBox(page).locator('output')).toHaveText('2 из 7');
  await expect(progressBox(page)).toContainText('Загрузка архива');
  await expect(progressBox(page)).toContainText('7,1 из 12,0 МБ');
  await expect(page.locator('#modules-plan-apply')).toHaveText('Подготовка…');
  await expect(page.locator('#modules-plan-apply')).toBeDisabled();
  expect(calls.starts).toBe(1);
});

test('остановка на подтверждении', async ({ page }) => {
  await installPanelPrepareRoutes(page, { steps: [downloading(1048576), prepareReady()] });
  await openModules(page);
  await updateButton(page).click();

  await expect(updateDialog(page)).toContainText('2.10.0 → 2.11.0');
  await expect(progressBox(page)).toContainText('Готово к обновлению');
  await expect(progressBox(page)).toContainText('Выпуск скачан и проверен за 27 с. Файлы панели пока не тронуты.');
  await expect(progressBox(page).locator('output')).toHaveText('3 из 7');
  await expect(progressBox(page)).toHaveClass(/is-run/);
  await expect(progressBox(page).locator('li[data-state="done"]')).toHaveCount(3);
  await expect(page.locator('#modules-plan-apply')).toHaveText('Обновить');
  await expect(page.locator('#modules-plan-apply')).toBeEnabled();
});

test('архив из кэша', async ({ page }) => {
  await installPanelPrepareRoutes(page, { steps: [prepareReady(panelUpdatePlan, { cached: true, finished_at: 1003 })] });
  await openModules(page);
  await updateButton(page).click();

  await expect(progressBox(page)).toContainText('Выпуск уже был скачан и проверен. Файлы панели пока не тронуты.');
});

test('Отмена зовёт отмену и закрывает окно', async ({ page }) => {
  const calls = await installPanelPrepareRoutes(page, { steps: [downloading(1048576)] });
  await openModules(page);
  await updateButton(page).click();
  await expect(progressBox(page).locator('output')).toHaveText('2 из 7');

  await page.locator('#modules-plan-cancel').click();

  await expect(updateDialog(page)).toBeHidden();
  await expect.poll(() => calls.cancels).toBe(1);
});

test('Отмена до ответа на запуск всё равно отменяет подготовку', async ({ page }) => {
  let answerStart;
  const holdStart = new Promise((resolve) => { answerStart = resolve; });
  const calls = await installPanelPrepareRoutes(page, { steps: [downloading(1048576)], holdStart });
  await openModules(page);
  await updateButton(page).click();
  await expect(updateDialog(page)).toBeVisible();
  await expect.poll(() => calls.starts).toBe(1);

  await page.locator('#modules-plan-cancel').click();
  await expect(updateDialog(page)).toBeHidden();
  answerStart();

  await expect.poll(() => calls.cancels).toBe(1);
  await page.waitForTimeout(1500);
  expect(calls.polls).toBe(0);
});

test('повторное нажатие подхватывает подготовку', async ({ page }) => {
  const calls = await installPanelPrepareRoutes(page, { steps: [downloading(1048576), downloading(3145728)] });
  await openModules(page);
  await updateButton(page).click();
  await expect(progressBox(page)).toContainText('3,0 из 12,0 МБ');

  await page.locator('#modules-plan-close').click();
  await expect(updateDialog(page)).toBeHidden();
  expect(calls.cancels).toBe(0);
  await updateButton(page).click();

  await expect(updateDialog(page)).toBeVisible();
  await expect(progressBox(page)).toContainText('Загрузка архива');
  expect(calls.starts).toBe(2);
});

test('ошибка на шаге', async ({ page }) => {
  const failed = prepareStep({
    state: 'failed', phase: 'downloading', total_bytes: PANEL_ARCHIVE_BYTES, finished_at: 1005,
    error: { code: 'panel_update_unavailable', message: 'no trusted compatible panel update is available' },
  });
  await installPanelPrepareRoutes(page, { steps: [prepareStep(), failed] });
  await openModules(page);
  await updateButton(page).click();

  await expect(progressBox(page)).toHaveClass(/is-bad/);
  await expect(progressBox(page).locator('li').nth(1)).toHaveAttribute('data-state', 'failed');
  await expect(page.locator('#modules-plan-recheck')).toBeVisible();
  await expect(page.locator('#modules-plan-cancel')).toHaveText('Закрыть');
});

test('актуальная панель', async ({ page }) => {
  const current = {
    ...panelUpdatePlan, applicable: false, plan_id: null, target_version: '2.10.0',
    blockers: [{ code: 'panel_version_current', message: 'the selected catalog does not contain a newer panel release' }],
  };
  await installPanelPrepareRoutes(page, { steps: [prepareReady(current)] });
  await openModules(page);
  await updateButton(page).click();

  await expect(updateDialog(page)).toBeHidden();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(updateButton(page)).toHaveCount(0);
});

test('уход с экрана останавливает опрос', async ({ page }) => {
  const calls = await installPanelPrepareRoutes(page, { steps: [downloading(1048576)] });
  await openModules(page);
  await updateButton(page).click();
  await expect.poll(() => calls.polls).toBeGreaterThan(0);

  // The open window covers the page; the panel's own navigation still runs.
  await page.locator('header .xk-header-btn-back').dispatchEvent('click');
  await expect(page).not.toHaveURL(/\/modules$/);
  await page.waitForTimeout(300);
  const seen = calls.polls;
  await page.waitForTimeout(2500);

  expect(calls.polls).toBe(seen);
});

test('сбой опроса', async ({ page }) => {
  const broken = (route) => route.fulfill({ status: 500, json: { ok: false, code: 'module_lifecycle_failed' } });
  await installPanelPrepareRoutes(page, { steps: [prepareStep(), broken, prepareReady()] });
  await openModules(page);
  await updateButton(page).click();

  await expect(progressBox(page)).toContainText('Готово к обновлению');
});

test('три сбоя опроса подряд краснят шаг, на котором шла работа', async ({ page }) => {
  const broken = (route) => route.fulfill({ status: 500, json: { ok: false, code: 'module_lifecycle_failed' } });
  await installPanelPrepareRoutes(page, { steps: [downloading(1048576), broken, broken, broken] });
  await openModules(page);
  await updateButton(page).click();

  await expect(progressBox(page)).toHaveClass(/is-bad/, { timeout: 15000 });
  await expect(progressBox(page).locator('li').nth(1)).toHaveAttribute('data-state', 'failed');
  await expect(progressBox(page).locator('li').nth(0)).toHaveAttribute('data-state', 'done');
  await expect(page.locator('#modules-plan-recheck')).toBeVisible();
});

test('подготовка, отменённая в другой вкладке, закрывает окно', async ({ page }) => {
  await installPanelPrepareRoutes(page, { steps: [downloading(1048576), prepareStep({ state: 'cancelled', finished_at: 1010 })] });
  await openModules(page);
  await updateButton(page).click();
  await expect(updateDialog(page)).toBeVisible();

  await expect(updateDialog(page)).toBeHidden();
  await expect(page.locator('#modules-error')).toBeEmpty();
});

test('операция не откатывается ниже 4 из 7', async ({ page }) => {
  await installPanelPrepareRoutes(page, { steps: [prepareReady()] });
  const running = { ...runningStatus, operation: 'panel-update', module_id: null, version: '2.11.0', step: 'downloading' };
  await openModules(page);
  await page.route('**/api/modules/operations/apply', (route) => route.fulfill({
    status: 202, json: { ok: true, operation_id: running.operation_id, status: running },
  }));
  await page.unroute('**/api/modules/operations/status');
  await page.route('**/api/modules/operations/status', (route) => route.fulfill({ json: running }));
  await updateButton(page).click();
  await expect(progressBox(page)).toContainText('Готово к обновлению');

  await page.locator('#modules-plan-apply').click();

  await expect(progressBox(page).locator('output')).toHaveText('4 из 7');
  await expect(progressBox(page).locator('li[data-state="done"]')).toHaveCount(3);
  // The runner checks its copy of the archive: the words say so, not «Замена файлов».
  await expect(progressBox(page).locator('strong')).toHaveText('Сверка копии архива');
});

test('сорванное на сверке обновление не откатывает полосу назад', async ({ page }) => {
  await installPanelPrepareRoutes(page, { steps: [prepareReady()] });
  const panel = { operation: 'panel-update', scope: 'panel', module_id: null, version: '2.11.0' };
  let current = { ...runningStatus, ...panel, step: 'verifying' };
  await openModules(page);
  await page.route('**/api/modules/operations/apply', (route) => route.fulfill({
    status: 202, json: { ok: true, operation_id: current.operation_id, status: current },
  }));
  await page.unroute('**/api/modules/operations/status');
  await page.route('**/api/modules/operations/status', (route) => route.fulfill({ json: current }));
  await updateButton(page).click();
  await expect(progressBox(page)).toContainText('Готово к обновлению');
  await page.locator('#modules-plan-apply').click();
  await expect(progressBox(page).locator('output')).toHaveText('4 из 7');

  current = {
    ...server.interrupted, ...panel, operation_id: current.operation_id, step: 'verifying',
    log: [{ step: 'prepared', at: 1791463146.9 }, { step: 'downloading', at: 1791463147.1 }, { step: 'verifying', at: 1791463147.3 }],
  };

  await expect(progressBox(page)).toHaveClass(/is-bad/);
  await expect(progressBox(page).locator('li[data-state="done"]')).toHaveCount(3);
  await expect(progressBox(page).locator('li').nth(3)).toHaveAttribute('data-state', 'failed');
  await expect(progressBox(page).locator('output')).toHaveText('3 из 7');
});

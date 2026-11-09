import { readFileSync } from 'node:fs';

import { test, expect } from './fixtures.mjs';

// The server diagnostics checks the servers of Xray or Mihomo. Its tile says
// so when neither engine is there, and says why it is off when it came with an
// update of the panel without an explicit choice.
const server = JSON.parse(readFileSync(new URL('./fixtures/module_manager_server.json', import.meta.url), 'utf8'));
const MODULE_ID = 'tool.server-diagnostics';
const editor = server.installed.modules.find((item) => item.id === 'tool.editor');
const serverDiagnostics = (fields) => ({
  ...editor,
  id: MODULE_ID,
  module_id: MODULE_ID,
  name: 'Диагностика серверов',
  description: 'Проверка доступности серверов из конфигураций Xray и Mihomo.',
  lifecycle_actions: ['repair', 'remove'],
  ...fields,
});

function installedWith(item, { engines = true, base = server.installed_mihomo_on } = {}) {
  const modules = base.modules
    .map((module) => (engines || !['engine.xray', 'engine.mihomo'].includes(module.id) ? module : { ...module, enabled: false }));
  return { ...base, modules: [...modules, item] };
}

async function mockModules(page, installed, available = server.available) {
  await page.route('**/api/modules/installed', (route) => route.fulfill({ json: installed }));
  await page.route('**/api/modules/available**', (route) => route.fulfill({ json: available }));
  await page.route('**/api/modules/operations/status', (route) => route.fulfill({ json: server.status_none }));
  await page.route('**/api/modules/panel/update-check', (route) => route.fulfill({ json: server.update_check_current }));
}

const tile = (page) => page.locator(`.modules-tile[data-module-id="${MODULE_ID}"]`);

test('a module that came without a choice says why it is off', async ({ page }) => {
  await mockModules(page, installedWith(serverDiagnostics({
    enabled: false, effective_enabled: false, status: 'disabled', off_reason: 'not_chosen',
  })));
  await page.goto('/modules');
  await expect(tile(page).locator('.modules-tile-foot')).toHaveText('Выключен: не выбирался при установке');
  await expect(tile(page).getByRole('switch')).not.toBeChecked();
});

test('the installed module without an engine says what it needs', async ({ page }) => {
  await mockModules(page, installedWith(serverDiagnostics({}), { engines: false }));
  await page.goto('/modules');
  await expect(tile(page).locator('.modules-tile-foot')).toHaveText('Нужен модуль Xray или Mihomo');
});

test('the installed module with an engine says nothing more', async ({ page }) => {
  await mockModules(page, installedWith(serverDiagnostics({})));
  await page.goto('/modules');
  await expect(tile(page)).toBeVisible();
  await expect(tile(page).locator('.modules-tile-foot')).toHaveCount(0);
});

test('the catalog warns before installing it on a router without engines', async ({ page }) => {
  const withoutEngines = {
    ...server.available,
    modules: server.available.modules.map((item) => (
      ['engine.xray', 'engine.mihomo'].includes(item.id) ? { ...item, installed: false, lifecycle_actions: ['install'] }
        : item.id === MODULE_ID ? { ...item, description: 'Проверка доступности серверов. Нужен модуль Xray или Mihomo. Часть проверок обращается к внешним сервисам.' } : item
    )),
  };
  await mockModules(page, server.installed, withoutEngines);
  await page.goto('/modules');
  await page.getByRole('tab', { name: 'Доступные' }).click();
  const catalogTile = page.locator(`.modules-catalog-tile[data-module-id="${MODULE_ID}"]`);
  await expect(catalogTile.locator('.modules-tile-description')).toHaveText('Проверка доступности серверов. Часть проверок обращается к внешним сервисам.');
  await expect(catalogTile.locator('.modules-tile-meta').first()).toHaveText('Нужны модули: Xkeen UI Core, а также Xray или Mihomo');
  await expect(catalogTile.locator('.modules-tile-meta')).toContainText(['Нужен модуль Xray или Mihomo']);

  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await mockModules(page, server.installed, server.available);
  await page.goto('/modules');
  await page.getByRole('tab', { name: 'Доступные' }).click();
  await expect(catalogTile.locator('.modules-tile-meta')).not.toContainText(['Нужен модуль Xray или Mihomo']);
});

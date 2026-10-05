import { test, expect } from './fixtures.mjs';


// Отдельные страницы копий и генератора Mihomo раньше тянули поддержку Monaco
// статически, при открытии. В установке с лёгким редактором этих файлов нет,
// и страница модуля, доустановленного из пакета, не загружалась бы вовсе.
// Теперь Monaco подключается тем же ленивым путём, что и на главной панели:
// только когда его выбрали.

const MONACO_REQUEST = /\/(?:monaco_loader|monaco_shared|editor_monaco\.shared|panel\.editor\.monaco\.bundle)[^/]*\.js|\/monaco-editor\//;


function recordRequests(page) {
  const urls = [];
  page.on('request', (request) => urls.push(request.url()));
  return urls;
}


function monacoState(page) {
  return page.evaluate(() => ({
    loader: !!(window.XKeen && window.XKeen.monacoLoader),
    shared: !!(window.XKeen && window.XKeen.ui && window.XKeen.ui.monacoShared),
    api: !!(window.monaco && window.monaco.editor),
    lazy: !!(window.XKeen && window.XKeen.runtime && window.XKeen.runtime.lazy
      && typeof window.XKeen.runtime.lazy.ensureEditorSupport === 'function'),
  }));
}


test('Mihomo Generator loads Monaco only after it is chosen', async ({ page }) => {
  const urls = recordRequests(page);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  await page.goto('/mihomo_generator');
  await expect(page.locator('body.mihomo-generator-page')).toBeVisible();
  await expect(page.locator('#mihomo-preview-engine-select')).toBeVisible();
  await page.waitForLoadState('networkidle');

  expect(urls.filter((url) => MONACO_REQUEST.test(url)), 'Monaco files requested on open').toEqual([]);
  expect(await monacoState(page)).toEqual({ loader: false, shared: false, api: false, lazy: true });
  await expect(page.locator('#previewMonaco')).toBeHidden();

  await page.locator('#mihomo-preview-engine-select').selectOption('monaco');

  await expect(page.locator('#previewMonaco')).toBeVisible({ timeout: 30000 });
  await expect(page.locator('#previewMonaco .monaco-editor').first()).toBeVisible({ timeout: 30000 });
  expect(urls.some((url) => MONACO_REQUEST.test(url)), 'Monaco files requested after the choice').toBe(true);
  expect(pageErrors).toEqual([]);
});


test('Backups page loads Monaco only when an editor asks for it', async ({ page }) => {
  const urls = recordRequests(page);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  await page.goto('/backups');
  await expect(page.locator('body')).toBeVisible();
  await page.waitForLoadState('networkidle');
  await expect.poll(() => page.evaluate(() => !!(window.XKeen && window.XKeen.ui && window.XKeen.ui.editorEngine))).toBe(true);

  expect(urls.filter((url) => MONACO_REQUEST.test(url)), 'Monaco files requested on open').toEqual([]);
  expect(await monacoState(page)).toEqual({ loader: false, shared: false, api: false, lazy: true });

  const runtime = await page.evaluate(async () => {
    const result = await window.XKeen.ui.editorEngine.ensureRuntime('monaco');
    return { ok: !!result, engine: result ? result.engine : null };
  });

  expect(runtime).toEqual({ ok: true, engine: 'monaco' });
  const after = await monacoState(page);
  expect(after.loader && after.shared && after.api).toBe(true);
  expect(pageErrors).toEqual([]);
});


test('standalone pages keep CodeMirror working without touching Monaco', async ({ page }) => {
  const urls = recordRequests(page);

  await page.goto('/mihomo_generator');
  await expect(page.locator('#mihomo-preview-engine-select')).toHaveValue('codemirror');
  const runtime = await page.evaluate(async () => {
    const result = await window.XKeen.ui.editorEngine.ensureRuntime('codemirror');
    return !!result;
  });

  expect(runtime).toBe(true);
  expect(urls.filter((url) => MONACO_REQUEST.test(url))).toEqual([]);
});

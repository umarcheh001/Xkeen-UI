import { test, expect } from './fixtures.mjs';


// В лёгком варианте редактора файлов Monaco нет. Главная панель это знает и
// запирает пункт Monaco в выборе движка, а отдельные страницы (копии,
// генератор Mihomo) описания редактора не получали: предлагали Monaco и
// узнавали, что его нет, только по ошибке загрузки. Теперь страница получает
// то же описание и ведёт себя так же, как панель.

const PROFILE = String(process.env.XKEEN_E2E_MODULE_PROFILE || 'full').toLowerCase();
const MONACO_REQUEST = /\/(?:monaco_loader|monaco_shared|editor_monaco\.shared|panel\.editor\.monaco\.bundle)[^/]*\.js|\/monaco-editor\//;
const LOCKED_LABEL = 'Monaco (нет в этом варианте редактора)';
// Наборы стенда, в которых есть страница генератора.
const HAS_GENERATOR = new Set(['full', 'mihomo-minimal']);


test.describe(`standalone page editor: ${PROFILE}`, () => {
  test.skip(!HAS_GENERATOR.has(PROFILE), 'этот набор модулей не содержит страницы генератора');

  test('Mihomo Generator offers Monaco only when the editor variant carries it', async ({ page }) => {
    const urls = [];
    const pageErrors = [];
    page.on('request', (request) => urls.push(request.url()));
    page.on('pageerror', (error) => pageErrors.push(String(error)));

    await page.goto('/mihomo_generator');
    const select = page.locator('#mihomo-preview-engine-select');
    await expect(select).toBeVisible();
    await page.waitForLoadState('networkidle');
    await expect.poll(() => page.evaluate(() => !!(window.XKeen && window.XKeen.ui && window.XKeen.ui.editorEngine))).toBe(true);

    const editor = await page.evaluate(() => window.XKeen.pageConfig.frontendModules.editor);
    const option = select.locator('option[value="monaco"]');

    if (PROFILE === 'full') {
      expect(editor.variant).toBe('full');
      expect(editor.capabilities).toContain('monaco');
      await expect(option).toBeEnabled();
      await expect(option).toHaveText('Monaco');
      return;
    }

    expect(editor.variant).toBe('light');
    expect(editor.capabilities).not.toContain('monaco');
    await expect(option).toBeDisabled();
    await expect(option).toHaveText(LOCKED_LABEL);
    await expect(select).toHaveValue('codemirror');

    // Даже если Monaco попросят в обход списка, страница не идёт за его файлами.
    const support = await page.evaluate(() => window.XKeen.runtime.lazy.ensureEditorSupport('monaco'));
    expect(support).toBe(false);
    expect(urls.filter((url) => MONACO_REQUEST.test(url)), 'Monaco files must not be requested').toEqual([]);
    await expect(page.locator('#previewMonaco')).toBeHidden();
    expect(pageErrors).toEqual([]);
  });
});

import { test, expect, selectPanelView, serveAdvancedEditorVariant, openMihomoConfig } from './fixtures.mjs';

// proxies of a group as a bare name instead of a list.
const SCALAR_PROXIES_CONFIG = [
  'proxy-groups:',
  '  - name: G',
  '    type: select',
  '    proxies: DIRECT',
  'rules:',
  '  - MATCH,G',
  '',
].join('\n');

test('Mihomo CodeMirror offers quick fixes as buttons of the diagnostic tooltip', async ({ page }) => {
  await serveAdvancedEditorVariant(page);
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => window.XKeen?.pageConfig?.frontendModules?.editor?.variant)).toBe('advanced');
  await selectPanelView(page, 'mihomo');
  await openMihomoConfig(page);
  const mihomo = page.locator('#view-mihomo');
  await expect(mihomo.locator('.cm-editor').first()).toBeVisible();

  await mihomo.locator('.cm-content').first().click();
  await page.keyboard.press('Control+A');
  await page.keyboard.insertText(SCALAR_PROXIES_CONFIG);
  await page.keyboard.press('Escape');
  // The field help would stack above the diagnostic and push its buttons
  // below a small window.
  await page.evaluate(() => window.XKeen?.ui?.settings?.patchLocal?.({ editor: { schemaHoverEnabled: false } }));

  const fixButton = page.locator('.cm-tooltip-lint .cm-diagnosticAction', { hasText: 'Обернуть значение в список' });
  // Diagnostics arrive after a validation delay, the tooltip after a hover delay.
  await expect(async () => {
    await page.mouse.move(8, 8);
    await mihomo.locator('.cm-lintRange', { hasText: 'proxies' }).first().hover();
    await expect(fixButton).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 15000 });

  await fixButton.first().click();
  await expect(mihomo.locator('.cm-content').first()).not.toContainText('proxies: DIRECT');
  await expect(mihomo.locator('.cm-content').first()).toContainText('DIRECT');
});

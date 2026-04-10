import { test, expect } from '@playwright/test';

async function waitForMihomoGeneratorPreview(page) {
  await expect(page.locator('#profileSelect')).toBeVisible();
  await page.waitForFunction(() => {
    const editors = Array.isArray(window.__xkeenEditors) ? window.__xkeenEditors : [];
    return editors.some((editor) => {
      try {
        return typeof editor.getValue === 'function';
      } catch (error) {
        return false;
      }
    });
  });
}

async function getMihomoGeneratorPreviewText(page) {
  return page.evaluate(() => {
    const editors = Array.isArray(window.__xkeenEditors) ? window.__xkeenEditors : [];
    for (const editor of editors) {
      try {
        if (typeof editor.getValue !== 'function') continue;
        const value = String(editor.getValue() || '');
        if (value.includes('proxy-groups:')) return value;
      } catch (error) {}
    }
    return '';
  });
}


test('panel shell renders top-level navigation', async ({ page }) => {
  await page.goto('/');

  await expect(page).toHaveTitle(/Xkeen UI/i);
  await expect(page.locator('#top-tab-mihomo-generator')).toBeVisible();
  await expect(page.locator('body')).toContainText('Mihomo Генератор');
  await expect(page.locator('body')).toContainText('DevTools');
});


test('devtools page renders update and env sections', async ({ page }) => {
  await page.goto('/devtools');

  await expect(page).toHaveTitle(/DevTools/i);
  await expect(page.locator('#dt-update-card')).toBeVisible();
  await page.locator('#dt-update-card').evaluate((node) => { node.open = true; });
  await expect(page.locator('#dt-update-check')).toBeVisible();
  await expect(page.locator('#dt-update-run')).toBeVisible();
  await expect(page.locator('#dt-env-card')).toBeVisible();
});


test('backups history page renders table', async ({ page }) => {
  await page.goto('/backups');

  await expect(page).toHaveTitle(/Бэкапы/i);
  await expect(page.locator('#backups-table')).toBeVisible();
  await expect(page.locator('body')).toContainText('Бэкапы Xray конфигов');
});


test('mihomo generator page renders source and preview panes', async ({ page }) => {
  await page.goto('/mihomo_generator');

  await expect(page).toHaveTitle(/Mihomo/i);
  await expect(page.locator('#profileSelect')).toBeVisible();
  await expect(page.locator('#defaultGroupsInput')).toBeVisible();
  await expect(page.locator('#previewTextarea')).toBeAttached();
  await expect(page.locator('body')).toContainText('Исходные данные');
  await expect(page.locator('body')).toContainText('Предпросмотр');
  await expect(page.locator('#previewToolbarHost button[data-action-id="fs"], #previewToolbarHost button[data-action-id="fs_any"]').first()).toBeVisible();
});


test('mihomo generator removes optional rule groups from preview when all checkboxes are cleared', async ({ page }) => {
  await page.goto('/mihomo_generator');
  await waitForMihomoGeneratorPreview(page);

  await page.selectOption('#profileSelect', 'router_zkeen');
  await expect
    .poll(() => page.evaluate(() => document.querySelectorAll('.rule-group-checkbox:checked').length))
    .toBeGreaterThan(0);
  await expect(page.locator('#stateSummary')).toContainText(/Rule-групп:\s*[1-9]/);
  await expect.poll(() => getMihomoGeneratorPreviewText(page)).toContain('- name: YouTube');

  await page.locator('#ruleGroupsSelectAll').evaluate((node) => {
    node.checked = false;
    node.dispatchEvent(new Event('change', { bubbles: true }));
  });

  await expect(page.locator('#stateSummary')).toContainText('Rule-групп: 0');
  await expect.poll(() => getMihomoGeneratorPreviewText(page)).not.toContain('- name: YouTube');
  await expect.poll(() => getMihomoGeneratorPreviewText(page)).not.toContain('- name: Discord');
  await expect.poll(() => getMihomoGeneratorPreviewText(page)).toContain('- name: Заблок. сервисы');
});


test('mihomo preview modal collapses the empty log column', async ({ page }) => {
  await page.goto('/mihomo_generator');
  await waitForMihomoGeneratorPreview(page);

  await page.locator('#defaultGroupsInput').fill('GhostGroup');
  await page.locator('#generateBtn').click();

  await expect(page.locator('#mihomoResultModal')).toBeVisible();
  await expect(page.locator('#mihomoResultGrid')).toHaveAttribute('data-has-log', '0');
  await expect(page.locator('#mihomoResultSidePanel')).toBeHidden();
  await expect(page.locator('.mihomo-result-overview')).toBeVisible();
  await expect(page.locator('#mihomoResultWarnings')).toContainText('Неизвестные группы по умолчанию');
});

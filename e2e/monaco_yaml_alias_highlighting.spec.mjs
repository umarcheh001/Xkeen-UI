import { test, expect } from '@playwright/test';

test('Monaco marks the YAML alias sigil separately from its name', async ({ page }) => {
  await page.goto('/');
  await page.locator('.top-tab-btn[data-view="mihomo"]').click();
  await page.locator('#mihomo-editor-engine-select').selectOption('monaco');
  await expect(page.locator('#mihomo-editor-monaco .monaco-editor').last()).toBeVisible();

  await page.evaluate(async () => {
    const host = document.createElement('div');
    host.className = 'xk-alias-probe';
    host.style.cssText = 'position:fixed;inset:0 auto auto 0;width:320px;height:80px;z-index:99999';
    document.body.appendChild(host);
    window.__xkAliasProbe = await window.XKeen.ui.monacoShared.createEditor(host, {
      language: 'yaml',
      value: 'rule: *domain\n',
    });
  });

  await expect(page.locator('.xk-alias-probe .xk-monaco-yaml-alias-sigil')).toBeVisible();
});

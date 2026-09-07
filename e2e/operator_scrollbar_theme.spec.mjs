import { test, expect } from './fixtures.mjs';


test('operator scrollbars use panel tokens without exposing hidden navigation rails', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('xkeen-theme', 'dark'));
  await page.goto('/');
  await expect(page.locator('.panel-header')).toBeVisible();

  const contract = await page.evaluate(() => {
    const workspace = document.querySelector('#view-routing');
    const tabs = document.querySelector('.top-tabs.header-tabs');
    const workspaceStyle = getComputedStyle(workspace);
    const tabsStyle = getComputedStyle(tabs);
    const bodyStyle = getComputedStyle(document.body);
    const rootStyle = getComputedStyle(document.documentElement);

    return {
      bodyScrollbar: bodyStyle.scrollbarColor,
      rootScrollbar: rootStyle.scrollbarColor,
      trackToken: bodyStyle.getPropertyValue('--op-scrollbar-track').trim(),
      thumbToken: bodyStyle.getPropertyValue('--op-scrollbar-thumb').trim(),
      hoverToken: bodyStyle.getPropertyValue('--op-scrollbar-thumb-hover').trim(),
      workspaceScrollbar: workspaceStyle.scrollbarColor,
      workspaceWidth: workspaceStyle.scrollbarWidth,
      tabsWidth: tabsStyle.scrollbarWidth,
    };
  });

  expect(contract.trackToken).not.toBe('');
  expect(contract.thumbToken).not.toBe('');
  expect(contract.hoverToken).not.toBe('');
  expect(contract.workspaceScrollbar).toBe(contract.bodyScrollbar);
  expect(contract.rootScrollbar).not.toBe('auto');
  expect(contract.workspaceWidth).toBe('thin');
  expect(contract.tabsWidth).toBe('none');
});


test('operator scrollbar tokens follow the light palette', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('xkeen-theme', 'light'));
  await page.goto('/');
  await expect(page.locator('.panel-header')).toBeVisible();

  const contract = await page.evaluate(() => {
    const bodyStyle = getComputedStyle(document.body);
    const workspaceStyle = getComputedStyle(document.querySelector('#view-routing'));
    return {
      colorScheme: bodyStyle.colorScheme,
      trackToken: bodyStyle.getPropertyValue('--op-scrollbar-track').trim(),
      thumbToken: bodyStyle.getPropertyValue('--op-scrollbar-thumb').trim(),
      scrollbar: workspaceStyle.scrollbarColor,
    };
  });

  expect(contract.colorScheme).toBe('light');
  expect(contract.trackToken).not.toBe('');
  expect(contract.thumbToken).not.toBe('');
  // Chromium serializes color-mix() as `color(srgb …)` rather than rgb().
  // The important contract is that the workspace exposes an explicit pair,
  // not the platform default scrollbar color.
  expect(contract.scrollbar).toMatch(/\s/);
  expect(contract.scrollbar).not.toBe('auto');
});

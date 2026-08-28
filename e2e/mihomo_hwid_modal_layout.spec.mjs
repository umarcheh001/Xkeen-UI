import { test, expect } from './fixtures.mjs';


test('HWID subscription uses the resizable Operator workbench and stretches its YAML preview', async ({ page }) => {
  await page.addInitScript(() => localStorage.removeItem('xk.modal.state.v1.mihomo-hwid'));
  await page.goto('/');
  await page.locator('.top-tab-btn[data-view="mihomo"]').click();
  await expect(page.locator('#view-mihomo')).toBeVisible();
  await page.locator('#mihomo-clash-tab-config').click();
  const menu = page.locator('.xk-mihomo-menu');
  await menu.locator('summary').click();
  await expect(page.locator('#mihomo-hwid-sub-btn')).toBeVisible();

  await page.locator('#mihomo-hwid-sub-btn').click();
  await expect(page.locator('#mihomo-hwid-modal')).toBeVisible();
  await expect(page.locator('#mihomo-hwid-modal .modal-resizer')).toBeVisible();

  const before = await page.locator('#mihomo-hwid-modal .xk-hw-preview-wrap').evaluate((node) => {
    const modal = document.querySelector('#mihomo-hwid-modal');
    const content = modal?.querySelector('.modal-content');
    const style = getComputedStyle(node);
    const contentStyle = content ? getComputedStyle(content) : null;
    return {
      previewHeight: node.getBoundingClientRect().height,
      contentHeight: content ? content.getBoundingClientRect().height : 0,
      gridRows: contentStyle ? contentStyle.gridTemplateRows : '',
      previewFlexGrow: style.flexGrow,
    };
  });

  expect(before.gridRows).not.toBe('none');
  expect(before.previewFlexGrow).toBe('1');

  const handle = page.locator('#mihomo-hwid-modal .modal-resizer');
  const box = await handle.boundingBox();
  if (!box) throw new Error('HWID resize handle has no bounding box');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 120, { steps: 8 });
  await page.mouse.up();

  await expect.poll(() => page.locator('#mihomo-hwid-modal .xk-hw-preview-wrap').evaluate((node) => node.getBoundingClientRect().height)).toBeGreaterThan(before.previewHeight + 40);

  const after = await page.locator('#mihomo-hwid-modal .xk-hw-preview-wrap').evaluate((node) => {
    const content = document.querySelector('#mihomo-hwid-modal .modal-content');
    const editor = node.querySelector('#mihomo-hwid-preview-monaco:not(.hidden), .xk-hw-preview-cm:not(.hidden), #mihomo-hwid-preview:not(.hidden)');
    return {
      previewHeight: node.getBoundingClientRect().height,
      contentHeight: content ? content.getBoundingClientRect().height : 0,
      editorHeight: editor ? editor.getBoundingClientRect().height : 0,
    };
  });

  expect(after.contentHeight).toBeGreaterThan(before.contentHeight + 40);
  expect(after.previewHeight).toBeGreaterThan(before.previewHeight + 40);
  expect(after.editorHeight).toBeGreaterThanOrEqual(after.previewHeight - 2);
});


test('HWID device profile is compact, editable, and resets to Mihomo panel defaults', async ({ page }) => {
  await page.addInitScript(() => localStorage.removeItem('xkeen.mihomo.hwid.device-profile.v1'));
  await page.goto('/');
  await page.locator('.top-tab-btn[data-view="mihomo"]').click();
  await expect(page.locator('#view-mihomo')).toBeVisible();
  await page.locator('#mihomo-clash-tab-config').click();
  const menu = page.locator('.xk-mihomo-menu');
  await menu.locator('summary').click();
  await page.locator('#mihomo-hwid-sub-btn').click();

  const editor = page.locator('#mihomo-hwid-diag');
  await expect(editor).toBeVisible();
  const hwid = page.locator('#mihomo-hwid-device-hwid');
  const userAgent = page.locator('#mihomo-hwid-device-ua');
  await expect(hwid).not.toHaveValue('');
  const panelHwid = await hwid.inputValue();
  const panelUa = await userAgent.inputValue();

  await expect(userAgent).toHaveValue(/mihomo\//);
  await expect(page.locator('#mihomo-hwid-ua-android-btn')).toHaveCount(0);
  await expect(page.locator('#mihomo-hwid-ua-iphone-btn')).toHaveCount(0);
  await hwid.fill('CUSTOM-HWID');

  await page.locator('#mihomo-hwid-reset-btn').click();
  await expect(hwid).toHaveValue(panelHwid);
  await expect(userAgent).toHaveValue(panelUa);

  const density = await editor.evaluate((node) => {
    const fields = node.querySelectorAll('.xk-hw-device-input');
    const style = getComputedStyle(node);
    return {
      gap: parseFloat(style.gap || '0'),
      paddingTop: parseFloat(style.paddingTop || '0'),
      maxInputHeight: Math.max(...Array.from(fields).map((field) => field.getBoundingClientRect().height)),
    };
  });
  expect(density.gap).toBeLessThanOrEqual(8);
  expect(density.paddingTop).toBeLessThanOrEqual(10);
  expect(density.maxInputHeight).toBeLessThanOrEqual(36);
});

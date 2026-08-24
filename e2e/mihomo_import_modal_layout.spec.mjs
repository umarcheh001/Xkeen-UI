import { test, expect } from './fixtures.mjs';


test('Mihomo import uses the resizable Operator workbench and stretches its YAML preview', async ({ page }) => {
  await page.goto('/');
  await page.locator('.top-tab-btn[data-view="mihomo"]').click();
  await expect(page.locator('#view-mihomo')).toBeVisible();
  await page.locator('#mihomo-clash-tab-config').click();
  const menu = page.locator('.xk-mihomo-menu');
  await menu.locator('summary').click();
  await expect(page.locator('#mihomo-import-node-btn')).toBeVisible();

  await page.locator('#mihomo-import-node-btn').click();
  await expect(page.locator('#mihomo-import-modal')).toBeVisible();
  await expect(page.locator('#mihomo-import-modal .modal-resizer')).toBeVisible();

  const before = await page.locator('#mihomo-import-modal .xk-mi-preview-wrap').evaluate((node) => {
    const content = document.querySelector('#mihomo-import-modal .modal-content');
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

  const handle = page.locator('#mihomo-import-modal .modal-resizer');
  const box = await handle.boundingBox();
  if (!box) throw new Error('Mihomo import resize handle has no bounding box');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 140, { steps: 8 });
  await page.mouse.up();

  await expect.poll(() => page.locator('#mihomo-import-modal .xk-mi-preview-wrap').evaluate((node) => node.getBoundingClientRect().height)).toBeGreaterThan(before.previewHeight + 40);

  const after = await page.locator('#mihomo-import-modal .xk-mi-preview-wrap').evaluate((node) => {
    const content = document.querySelector('#mihomo-import-modal .modal-content');
    const editor = node.querySelector('.xk-mihomo-import-preview');
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


test('global error toasts stay above the Mihomo import modal', async ({ page }) => {
  await page.goto('/');
  await page.locator('.top-tab-btn[data-view="mihomo"]').click();
  await page.locator('#mihomo-clash-tab-config').click();
  await page.locator('.xk-mihomo-menu summary').click();
  await page.locator('#mihomo-import-node-btn').click();
  await expect(page.locator('#mihomo-import-modal')).toBeVisible();

  await page.evaluate(() => window.toast('Не удалось удалить подписку: тестовая ошибка.', 'error'));
  const toast = page.locator('#toast-container .toast').last();
  await expect(toast).toBeVisible();

  const layers = await page.evaluate(() => {
    const modal = document.querySelector('#mihomo-import-modal');
    const container = document.querySelector('#toast-container');
    const toast = container?.querySelector('.toast:last-child');
    const toastRect = toast?.getBoundingClientRect();
    const point = toastRect
      ? document.elementFromPoint(toastRect.left + toastRect.width / 2, toastRect.top + toastRect.height / 2)
      : null;
    return {
      modalZ: Number(getComputedStyle(modal).zIndex || 0),
      toastZ: Number(getComputedStyle(container).zIndex || 0),
      toastOwnsTopPoint: !!(point && point.closest('#toast-container')),
    };
  });

  expect(layers.toastZ).toBeGreaterThan(layers.modalZ);
  expect(layers.toastOwnsTopPoint).toBe(true);
});

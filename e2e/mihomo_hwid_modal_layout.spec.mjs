import { test, expect } from './fixtures.mjs';


test('HWID subscription uses the resizable Operator workbench and stretches its YAML preview', async ({ page }) => {
  await page.addInitScript(() => localStorage.removeItem('xk.modal.state.v1.mihomo-hwid'));
  await page.goto('/');
  await page.locator('.top-tab-btn[data-view="mihomo"]').click();
  await expect(page.locator('#view-mihomo')).toBeVisible();
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

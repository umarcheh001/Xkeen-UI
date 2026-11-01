import { test, expect, selectPanelView, openMihomoConfig } from './fixtures.mjs';


test('HWID subscription uses the resizable Operator workbench and stretches its YAML preview', async ({ page }) => {
  await page.addInitScript(() => localStorage.removeItem('xk.modal.state.v1.mihomo-hwid'));
  await page.goto('/');
  await selectPanelView(page, 'mihomo');
  await expect(page.locator('#view-mihomo')).toBeVisible();
  await openMihomoConfig(page);
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
  await selectPanelView(page, 'mihomo');
  await expect(page.locator('#view-mihomo')).toBeVisible();
  await openMihomoConfig(page);
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

  await page.setViewportSize({ width: 390, height: 900 });
  const mobileFlow = await page.evaluate(() => {
    const modal = document.querySelector('#mihomo-hwid-modal');
    const controls = modal?.querySelector('.xk-hw-panel--controls')?.getBoundingClientRect();
    const preview = modal?.querySelector('.xk-hw-panel--preview')?.getBoundingClientRect();
    return {
      noHorizontalOverflow: document.documentElement.scrollWidth <= window.innerWidth,
      previewStartsAfterControls: !!controls && !!preview && preview.top >= controls.bottom - 1,
    };
  });
  expect(mobileFlow.noHorizontalOverflow).toBe(true);
  expect(mobileFlow.previewStartsAfterControls).toBe(true);
});


test('HWID HAPP redirect stays inside the form and opens the node importer', async ({ page }) => {
  await page.route('**/api/mihomo/hwid/probe', (route) => route.fulfill({
    status: 400,
    json: {
      ok: false,
      error: {
        code: 'HAPP_REDIRECT',
        message: 'Ссылка ведёт на зашифрованную HAPP-подписку.',
        hint: 'Откройте эту ссылку в модале «Узел», чтобы импортировать подписку.',
      },
    },
  }));
  await page.goto('/');
  await selectPanelView(page, 'mihomo');
  await openMihomoConfig(page);
  await page.locator('.xk-mihomo-menu summary').click();
  await page.locator('#mihomo-hwid-sub-btn').click();
  await expect(page.locator('#mihomo-hwid-modal .xk-hw-panel--controls .xk-hw-panel-head')).toBeVisible();

  const layout = await page.locator('#mihomo-hwid-modal').evaluate((modal) => {
    const body = modal.querySelector('.xk-hw-body').getBoundingClientRect();
    const lead = modal.querySelector('.xk-hw-lead').getBoundingClientRect();
    const controls = modal.querySelector('.xk-hw-panel--controls').getBoundingClientRect();
    const heading = modal.querySelector('.xk-hw-panel--controls .xk-hw-panel-head').getBoundingClientRect();
    return { leftInset: heading.left - controls.left, outerInset: controls.left - body.left, topGap: heading.top - lead.bottom };
  });
  expect(layout.leftInset).toBeGreaterThanOrEqual(12);
  expect(layout.outerInset).toBeGreaterThanOrEqual(0);
  expect(layout.topGap).toBeGreaterThanOrEqual(12);

  const source = 'https://provider.example/sub/happ';
  await page.locator('#mihomo-hwid-url').fill(source);
  await page.locator('#mihomo-hwid-probe-btn').click();
  await expect(page.locator('#mihomo-hwid-status')).toContainText('зашифрованную HAPP-подписку');
  await expect(page.locator('#mihomo-hwid-open-node-btn')).toBeVisible();

  await page.locator('#mihomo-hwid-status').evaluate((node) => {
    node.textContent = 'Ошибка: ' + 'happ://crypt4/' + 'A'.repeat(250);
  });
  const overflow = await page.locator('#mihomo-hwid-status').evaluate((node) =>
    node.scrollWidth > node.clientWidth + 1);
  expect(overflow).toBe(false);
  await page.setViewportSize({ width: 390, height: 900 });
  const mobileOverflow = await page.locator('#mihomo-hwid-status').evaluate((node) =>
    node.scrollWidth > node.clientWidth + 1);
  expect(mobileOverflow).toBe(false);

  await page.locator('#mihomo-hwid-open-node-btn').click();
  await expect(page.locator('#mihomo-hwid-modal')).toBeHidden();
  await expect(page.locator('#mihomo-import-modal')).toBeVisible();
  await expect(page.locator('#mihomo-import-input')).toHaveValue(source);
});

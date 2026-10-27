import { test, expect, selectPanelView } from './fixtures.mjs';


const AMNEZIA_LOCATIONS = [
  'FI', 'DE', 'FR', 'GB', 'NL', 'SE', 'NO', 'PL', 'ES', 'IT',
  'CH', 'AT', 'BE', 'CZ', 'DK', 'EE', 'GR', 'HU', 'IE', 'IS',
  'LT', 'LU', 'LV', 'PT', 'RO', 'SK', 'SI', 'US', 'CA', 'BR',
  'AU', 'JP', 'KR', 'SG', 'HK', 'AE', 'TR', 'KZ', 'IN', 'ID',
].map((code) => ({ code, name: `Location ${code}` }));


async function openMihomoImport(page) {
  await selectPanelView(page, 'mihomo');
  await expect(page.locator('#view-mihomo')).toBeVisible();
  const configTab = page.locator('#mihomo-clash-tab-config');
  if (await configTab.isVisible()) await configTab.click();
  const menu = page.locator('.xk-mihomo-menu');
  await menu.locator('summary').click();
  await expect(page.locator('#mihomo-import-node-btn')).toBeVisible();
  await page.locator('#mihomo-import-node-btn').click();
  await expect(page.locator('#mihomo-import-modal')).toBeVisible();
}


test('Amnezia Premium locations use compact flags and a two-column scroller', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 960 });
  await page.route('**/api/mihomo/amnezia-premium/locations', (route) => route.fulfill({
    json: { ok: true, locations: AMNEZIA_LOCATIONS },
  }));
  await page.goto('/');
  await openMihomoImport(page);

  await page.locator('#mihomo-import-mode').selectOption('amnezia-premium');
  await page.locator('#mihomo-import-input').fill('vpn://fixture-key');
  await page.locator('#mihomo-import-parse-btn').click();

  const shell = page.locator('#mihomo-import-amnezia-locations');
  await expect(shell.locator('.mihomo-import-amnezia-location-cb')).toHaveCount(40);

  const layout = await shell.evaluate((node) => {
    const flag = node.querySelector('.xk-mi-amnezia-location-flag');
    const svg = flag?.querySelector('svg');
    const flagRect = flag?.getBoundingClientRect();
    const svgRect = svg?.getBoundingClientRect();
    return {
      columns: getComputedStyle(node).gridTemplateColumns.split(' ').filter(Boolean).length,
      clientHeight: node.clientHeight,
      scrollHeight: node.scrollHeight,
      flagWidth: flagRect?.width,
      flagHeight: flagRect?.height,
      svgWidth: svgRect?.width,
      svgHeight: svgRect?.height,
    };
  });

  expect(layout.columns).toBe(2);
  expect(layout.clientHeight).toBeGreaterThanOrEqual(172);
  expect(layout.scrollHeight).toBeGreaterThan(layout.clientHeight);
  expect(layout.flagWidth).toBe(20);
  expect(layout.flagHeight).toBe(14);
  expect(layout.svgWidth).toBeGreaterThanOrEqual(12);
  expect(layout.svgWidth).toBeLessThanOrEqual(20);
  expect(layout.svgHeight).toBeGreaterThanOrEqual(10);
  expect(layout.svgHeight).toBeLessThanOrEqual(14);
});


test('Mihomo import compact form is draggable, remembers its position, and keeps the refresh interval compact', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 960 });
  await page.addInitScript(() => {
    localStorage.removeItem('xk.modal.state.v1.mihomo-import-source-v3');
  });
  await page.goto('/');
  await openMihomoImport(page);

  const content = page.locator('#mihomo-import-modal .modal-content');
  const header = page.locator('#mihomo-import-modal .modal-header');
  const start = await content.boundingBox();
  const headerBox = await header.boundingBox();
  if (!start || !headerBox) throw new Error('Mihomo import modal geometry is unavailable');

  await page.mouse.move(headerBox.x + 180, headerBox.y + 20);
  await page.mouse.down();
  await page.mouse.move(headerBox.x + 270, headerBox.y + 80, { steps: 8 });
  await page.mouse.up();

  await expect.poll(async () => (await content.boundingBox())?.x || 0).toBeGreaterThan(start.x + 50);
  const moved = await content.boundingBox();
  if (!moved) throw new Error('Mihomo import modal did not move');

  await page.locator('#mihomo-import-close-btn').click();
  await expect(page.locator('#mihomo-import-modal')).toBeHidden();
  await openMihomoImport(page);
  const restored = await content.boundingBox();
  if (!restored) throw new Error('Mihomo import modal position was not restored');
  expect(Math.abs(restored.x - moved.x)).toBeLessThanOrEqual(2);
  expect(Math.abs(restored.y - moved.y)).toBeLessThanOrEqual(2);

  const intervalWidth = await page.locator('#mihomo-import-xray-interval').evaluate(
    (input) => Number.parseFloat(getComputedStyle(input).width),
  );
  expect(intervalWidth).toBe(64);
});


test('Mihomo import opens as a compact source form and expands into the Operator workbench', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 960 });
  await page.addInitScript(() => {
    localStorage.removeItem('xk.modal.state.v1.mihomo-import');
  });
  await page.goto('/');
  await selectPanelView(page, 'mihomo');
  await expect(page.locator('#view-mihomo')).toBeVisible();
  await page.locator('#mihomo-clash-tab-config').click();
  const menu = page.locator('.xk-mihomo-menu');
  await menu.locator('summary').click();
  await expect(page.locator('#mihomo-import-node-btn')).toBeVisible();

  await page.locator('#mihomo-import-node-btn').click();
  await expect(page.locator('#mihomo-import-modal')).toBeVisible();
  await expect(page.locator('#mihomo-import-modal .modal-resizer')).toBeHidden();

  const before = await page.locator('#mihomo-import-modal .xk-mi-preview-wrap').evaluate((node) => {
    const content = document.querySelector('#mihomo-import-modal .modal-content');
    const style = getComputedStyle(node);
    const contentStyle = content ? getComputedStyle(content) : null;
    return {
      previewHeight: node.getBoundingClientRect().height,
      contentHeight: content ? content.getBoundingClientRect().height : 0,
      contentWidth: content ? content.getBoundingClientRect().width : 0,
      gridRows: contentStyle ? contentStyle.gridTemplateRows : '',
      previewFlexGrow: style.flexGrow,
    };
  });

  expect(before.contentWidth).toBeLessThanOrEqual(760);
  expect(before.previewHeight).toBe(0);
  await expect(page.locator('#mihomo-import-groups-block')).toBeHidden();

  await page.locator('#mihomo-import-input').fill(
    'vless://11111111-1111-1111-1111-111111111111@example.com:443?encryption=none&type=tcp#compact',
  );
  await page.locator('#mihomo-import-parse-btn').click();
  await expect(page.locator('#mihomo-import-insert-btn')).toBeEnabled();
  await expect(page.locator('#mihomo-import-modal .modal-resizer')).toBeHidden();
  await expect(page.locator('#mihomo-import-groups-block')).toBeVisible();
  await expect(page.locator('#mihomo-import-modal .xk-mi-panel--preview')).toBeHidden();
  await page.locator('#mihomo-import-preview-toggle').click();
  await expect(page.locator('#mihomo-import-modal .modal-resizer')).toBeVisible();
  await expect(page.locator('#mihomo-import-modal .xk-mi-panel--preview')).toBeVisible();

  const expanded = await page.locator('#mihomo-import-modal .xk-mi-preview-wrap').evaluate((node) => {
    const content = document.querySelector('#mihomo-import-modal .modal-content');
    const style = getComputedStyle(node);
    const contentStyle = content ? getComputedStyle(content) : null;
    return {
      previewHeight: node.getBoundingClientRect().height,
      contentHeight: content ? content.getBoundingClientRect().height : 0,
      contentWidth: content ? content.getBoundingClientRect().width : 0,
      gridRows: contentStyle ? contentStyle.gridTemplateRows : '',
      previewFlexGrow: style.flexGrow,
    };
  });

  expect(expanded.gridRows).not.toBe('none');
  expect(expanded.previewFlexGrow).toBe('1');
  expect(expanded.contentWidth).toBeGreaterThan(1000);

  const handle = page.locator('#mihomo-import-modal .modal-resizer');
  const box = await handle.boundingBox();
  if (!box) throw new Error('Mihomo import resize handle has no bounding box');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 140, { steps: 8 });
  await page.mouse.up();

  await expect.poll(() => page.locator('#mihomo-import-modal .xk-mi-preview-wrap').evaluate((node) => node.getBoundingClientRect().height)).toBeGreaterThan(expanded.previewHeight + 40);

  const after = await page.locator('#mihomo-import-modal .xk-mi-preview-wrap').evaluate((node) => {
    const content = document.querySelector('#mihomo-import-modal .modal-content');
    const editor = node.querySelector('.xk-mihomo-import-preview');
    return {
      previewHeight: node.getBoundingClientRect().height,
      contentHeight: content ? content.getBoundingClientRect().height : 0,
      editorHeight: editor ? editor.getBoundingClientRect().height : 0,
    };
  });

  expect(after.contentHeight).toBeGreaterThan(expanded.contentHeight + 40);
  expect(after.previewHeight).toBeGreaterThan(expanded.previewHeight + 40);
  expect(after.editorHeight).toBeGreaterThanOrEqual(after.previewHeight - 2);
});


test('Mihomo import stays within a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    localStorage.removeItem('xk.modal.state.v1.mihomo-import');
  });
  await page.goto('/');
  await selectPanelView(page, 'mihomo');
  await page.locator('#mihomo-clash-tab-config').click();
  await page.locator('.xk-mihomo-menu summary').click();
  await page.locator('#mihomo-import-node-btn').click();
  await expect(page.locator('#mihomo-import-modal')).toBeVisible();

  const frame = await page.locator('#mihomo-import-modal .modal-content').evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      width: rect.width,
      viewportWidth: window.innerWidth,
    };
  });

  expect(frame.width).toBeGreaterThan(360);
  expect(frame.left).toBeGreaterThanOrEqual(0);
  expect(frame.right).toBeLessThanOrEqual(frame.viewportWidth);
});

test('Mihomo import result cards stay readable and keep the final action reachable at 390px', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await openMihomoImport(page);
  await page.locator('#mihomo-import-input').fill(
    'vless://11111111-1111-1111-1111-111111111111@example.com:443?encryption=none&type=tcp#mobile-card',
  );
  await page.locator('#mihomo-import-parse-btn').click();

  const card = page.locator('#mihomo-import-result-cards');
  await expect(card).toBeVisible();
  await expect(card).toContainText('Адрес: example.com:443');
  const geometry = await page.evaluate(() => {
    const cardNode = document.querySelector('#mihomo-import-result-cards');
    const insert = document.querySelector('#mihomo-import-insert-btn');
    const cardRect = cardNode?.getBoundingClientRect();
    const insertRect = insert?.getBoundingClientRect();
    return {
      cardWidth: cardRect?.width || 0,
      insertBottom: insertRect?.bottom || 0,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    };
  });
  expect(geometry.cardWidth).toBeGreaterThan(0);
  expect(geometry.cardWidth).toBeLessThanOrEqual(geometry.viewportWidth - 16);
  expect(geometry.insertBottom).toBeLessThanOrEqual(geometry.viewportHeight);
});


test('global error toasts stay above the Mihomo import modal', async ({ page }) => {
  await page.goto('/');
  await selectPanelView(page, 'mihomo');
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


test('busy spinner in the import status is centred on the first line of text', async ({ page }) => {
  let releaseParse;
  let resolveParseStarted;
  const parseStarted = new Promise((resolve) => {
    resolveParseStarted = resolve;
  });
  await page.route('**/api/mihomo/parse/xray-json', async (route) => {
    resolveParseStarted();
    await new Promise((resume) => {
      releaseParse = resume;
    });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: false, code: 'not_xray_json' }),
    });
  });

  await page.goto('/');
  await selectPanelView(page, 'mihomo');
  await page.locator('#mihomo-clash-tab-config').click();
  await page.locator('.xk-mihomo-menu summary').click();
  await page.locator('#mihomo-import-node-btn').click();
  await expect(page.locator('#mihomo-import-modal')).toBeVisible();

  await page.locator('#mihomo-import-input').fill(
    'https://right-side.example.com/api/v1/client/subscribe?token=0123456789abcdef0123456789abcdef',
  );
  await page.locator('#mihomo-import-parse-btn').click();
  await parseStarted;

  const busy = page.locator('#mihomo-import-status .xk-status-inline.is-busy');
  await expect(busy).toBeVisible();

  const geometry = await busy.evaluate((wrap) => {
    const spinner = wrap.querySelector('.xk-inline-spinner');
    const message = wrap.querySelector('.xk-status-message');
    const spinnerRect = spinner.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(message);
    const firstLine = range.getClientRects()[0];
    return {
      spinnerCentre: spinnerRect.top + spinnerRect.height / 2,
      firstLineCentre: firstLine.top + firstLine.height / 2,
      lines: range.getClientRects().length,
    };
  });

  // Кружок должен стоять по центру первой строки, а не по центру всего блока
  // и не над ним: при многострочном сообщении разъезд особенно заметен.
  expect(Math.abs(geometry.spinnerCentre - geometry.firstLineCentre)).toBeLessThanOrEqual(1);

  releaseParse();
});


test('editing source or mode invalidates the previous import result', async ({ page }) => {
  await page.goto('/');
  await selectPanelView(page, 'mihomo');
  await page.locator('#mihomo-clash-tab-config').click();
  await page.locator('.xk-mihomo-menu summary').click();
  await page.locator('#mihomo-import-node-btn').click();
  await expect(page.locator('#mihomo-import-modal')).toBeVisible();

  const input = page.locator('#mihomo-import-input');
  await input.fill('vless://11111111-1111-1111-1111-111111111111@example.com:443?encryption=none&type=tcp#first');
  await page.locator('#mihomo-import-parse-btn').click();
  await expect(page.locator('#mihomo-import-insert-btn')).toBeEnabled();

  await input.fill('vless://22222222-2222-2222-2222-222222222222@example.com:443?encryption=none&type=tcp#second');
  await expect(page.locator('#mihomo-import-insert-btn')).toBeDisabled();

  await page.locator('#mihomo-import-mode').selectOption('wireguard');
  await expect(page.locator('#mihomo-import-insert-btn')).toBeDisabled();
});


test('closing the modal invalidates a late parse response', async ({ page }) => {
  let releaseParse;
  const parseStarted = new Promise((resolve) => {
    page.route('**/api/mihomo/parse/xray-json', async (route) => {
      resolve();
      await new Promise((resume) => { releaseParse = resume; });
      await route.fulfill({
        json: {
          ok: true,
          proxies: [{ proxy_name: 'Late node', proxy_yaml: '- name: Late node\n  type: direct\n' }],
        },
      });
    });
  });

  await page.goto('/');
  await selectPanelView(page, 'mihomo');
  await page.locator('#mihomo-clash-tab-config').click();
  await page.locator('.xk-mihomo-menu summary').click();
  await page.locator('#mihomo-import-node-btn').click();
  await expect(page.locator('#mihomo-import-modal')).toBeVisible();

  await page.locator('#mihomo-import-mode').selectOption('subscription');
  await page.locator('#mihomo-import-input').fill('https://late.example/subscription');
  await page.locator('#mihomo-import-parse-btn').click();
  await parseStarted;

  await page.locator('#mihomo-import-close-btn').click();
  releaseParse();
  await expect(page.locator('#mihomo-import-modal')).toBeHidden();

  // Reopen must be a clean session; the late response cannot enable Insert.
  await page.locator('.xk-mihomo-menu summary').click();
  await page.locator('#mihomo-import-node-btn').click();
  await expect(page.locator('#mihomo-import-insert-btn')).toBeDisabled();
});

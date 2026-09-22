import { test, expect } from './fixtures.mjs';


const viewports = [
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1024, height: 600 },
  { width: 640, height: 360 },
  { width: 390, height: 400 },
];
const workspaceTabs = ['routing', 'mihomo', 'xkeen', 'xray-logs', 'commands', 'files'];


async function openPanel(page, viewport) {
  await page.setViewportSize(viewport);
  await page.addInitScript(() => {
    localStorage.setItem('xkeen-theme', 'dark');
    localStorage.setItem('xkeen.editor.engine', 'codemirror');
    localStorage.removeItem('xkeen.panel.last_view.v1');
  });
  await page.goto('/');
  // Шапку прячет класс xk-operator-header-pending, и панель снимает его сама
  // через 12 секунд, даже если бутстрап не дошёл до конца (templates/panel.html).
  // Стандартные 10 секунд ожидания попадают внутрь этого окна, и медленная
  // загрузка на занятой машине выглядит как поломка вёрстки. Ждём дольше
  // страховки, чтобы падение означало настоящую регрессию.
  await expect(page.locator('.panel-header')).toBeVisible({ timeout: 15000 });
  await page.waitForFunction(() => typeof window.showView === 'function');
  await page.evaluate(() => window.showView('routing'));
  await expect(page.locator('#view-routing')).toBeVisible();
  // Шапку панель пересобирает уже после первой отрисовки: переносит кнопки в
  // компактную полосу и только потом ставит на body класс
  // xk-operator-header-active. Мерить высоты до этого момента бессмысленно —
  // получаются размеры промежуточной разметки.
  await expect(page.locator('body')).toHaveClass(/xk-operator-header-active/);
}


async function openScrollSettings(page) {
  await page.locator('[aria-controls="xk-mihomo-panel-menu"]').click();
  await page.locator('#ui-settings-open-btn').click();
  await expect(page.locator('#ui-settings-modal')).toBeVisible();
  await page.locator('#ui-settings-nav-btn-scrolling').click();
  await expect(page.locator('#ui-settings-section-scrolling')).toBeVisible();
}


async function readScrollContract(page, viewId) {
  return page.evaluate((id) => {
    const view = document.getElementById(id);
    const body = document.body;
    const root = document.documentElement;
    const container = document.querySelector('.container.container-wide');
    const header = document.querySelector('.panel-header');
    const viewStyle = getComputedStyle(view);
    const bodyStyle = getComputedStyle(body);
    const rootStyle = getComputedStyle(root);
    const containerStyle = getComputedStyle(container);
    const headerStyle = getComputedStyle(header);
    const viewRect = view.getBoundingClientRect();
    const headerRect = header.getBoundingClientRect();
    return {
      viewOverflowY: viewStyle.overflowY,
      viewScrollHeight: view.scrollHeight,
      viewClientHeight: view.clientHeight,
      viewScrollTop: view.scrollTop,
      viewBottom: viewRect.bottom,
      viewportHeight: innerHeight,
      outerScrollTop: window.scrollY,
      headerOverflowY: headerStyle.overflowY,
      headerScrollHeight: header.scrollHeight,
      headerClientHeight: header.clientHeight,
      headerBottom: headerRect.bottom,
      containerOverflowY: containerStyle.overflowY,
      containerScrollHeight: container.scrollHeight,
      containerClientHeight: container.clientHeight,
      bodyOverflowY: bodyStyle.overflowY,
      rootOverflowY: rootStyle.overflowY,
      bodyScrollHeight: body.scrollHeight,
      bodyClientHeight: body.clientHeight,
      rootScrollHeight: root.scrollHeight,
      rootClientHeight: root.clientHeight,
    };
  }, viewId);
}


test('panel workspaces keep a usable scroll region across desktop and short viewports', async ({ page }) => {
  // The matrix intentionally reopens the panel for every viewport and checks
  // six workspaces; keep the assertion budget independent from the default
  // single-page Playwright timeout.
  test.setTimeout(120_000);

  for (const viewport of viewports) {
    await openPanel(page, viewport);

    for (const tab of workspaceTabs) {
      console.log('viewport/tab', viewport, tab);
      const tabButton = page.locator(`.top-tab-btn[data-view="${tab}"]`);
      if (!(await tabButton.count())) continue;

      await page.evaluate((name) => window.showView(name), tab);
      const viewId = `view-${tab}`;
      const view = page.locator(`#${viewId}`);
      await expect(view).toBeVisible();

      await page.evaluate((id) => {
        const spacer = document.createElement('div');
        spacer.dataset.issue33Probe = id;
        spacer.style.cssText = 'height: 1200px; width: 1px; pointer-events: none;';
        document.getElementById(id).appendChild(spacer);
      }, viewId);

      const before = await readScrollContract(page, viewId);
      const label = `${viewport.width}x${viewport.height} ${tab}`;
      expect(['auto', 'scroll'], label).toContain(before.viewOverflowY);
      expect(before.viewClientHeight, label).toBeGreaterThan(0);
      expect(before.viewClientHeight, label).toBeGreaterThanOrEqual(before.viewportHeight - 1);
      expect(before.headerBottom, label).toBeLessThanOrEqual(before.viewportHeight + 1);
      expect(['visible', 'auto'], label).toContain(before.containerOverflowY);
      expect(before.containerScrollHeight - before.containerClientHeight, label).toBeLessThanOrEqual(1);
      if (viewport.height <= 640 || viewport.width <= 720) {
        // Every in-panel workspace now uses the compact shell. Its popovers
        // open outside the header, so the header must not become a scroll box.
        expect(before.headerOverflowY, label).toBe('visible');
        expect(before.headerScrollHeight - before.headerClientHeight, label).toBeLessThanOrEqual(1);
        expect(before.headerClientHeight, label).toBeGreaterThan(0);
        // The outer document carries the compact header on short screens;
        // its intrinsic content must fit without a second scroll position.
        expect(before.headerScrollHeight, label).toBeGreaterThanOrEqual(before.headerClientHeight);
      }
      expect(['auto', 'scroll'], label).toContain(before.bodyOverflowY);
      expect(before.rootScrollHeight - before.rootClientHeight, label).toBeGreaterThan(1);
      expect(before.viewScrollHeight, label).toBeGreaterThan(before.viewClientHeight);

      await view.evaluate((node) => { node.scrollTop = node.scrollHeight; });
      const afterInner = await readScrollContract(page, viewId);
      expect(afterInner.viewScrollTop, label).toBeGreaterThan(0);

      // A wheel gesture at the inner bottom is bridged to the document
      // scrollport, so users do not need to hunt for the second scrollbar.
      await page.evaluate((id) => {
        window.scrollTo(0, 0);
        const node = document.getElementById(id);
        node.dispatchEvent(new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          deltaY: 120,
        }));
      }, viewId);
      const afterWheel = await readScrollContract(page, viewId);
      expect(afterWheel.outerScrollTop, label).toBeGreaterThan(0);

      // The outer document and the active workspace retain independent
      // positions: a page scroll must not reset the focused workspace.
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      const afterOuter = await readScrollContract(page, viewId);
      expect(afterOuter.outerScrollTop, label).toBeGreaterThan(0);
      expect(afterOuter.viewScrollTop, label).toBe(afterInner.viewScrollTop);

      await page.locator(`[data-issue33-probe="${viewId}"]`).evaluate((node) => node.remove());
      await page.evaluate(() => window.scrollTo(0, 0));
      await view.evaluate((node) => { node.scrollTop = 0; });
    }
  }
});


test('UI settings can keep either panel scroll surface without allowing both off', async ({ page }) => {
  test.setTimeout(60_000);
  await openPanel(page, { width: 1024, height: 600 });
  await page.evaluate(() => {
    const spacer = document.createElement('div');
    spacer.dataset.scrollModeProbe = '1';
    spacer.style.cssText = 'height: 1400px; width: 1px; pointer-events: none;';
    document.getElementById('view-routing').appendChild(spacer);
  });

  await openScrollSettings(page);
  const pageScroll = page.locator('[data-ui-settings-control="layout-page-scroll"]');
  const workspaceScroll = page.locator('[data-ui-settings-control="layout-workspace-scroll"]');
  const pageScrollSlider = page.locator('[data-item-id="layout-page-scroll"] .dt-switch-slider');
  const workspaceScrollSlider = page.locator('[data-item-id="layout-workspace-scroll"] .dt-switch-slider');
  await expect(pageScroll).toBeChecked();
  await expect(workspaceScroll).toBeChecked();

  await pageScrollSlider.click();
  await expect(pageScroll).not.toBeChecked();
  await expect(page.locator('#ui-settings-status')).toContainText('Сохранено');
  await expect(workspaceScroll).toBeDisabled();
  await page.locator('#ui-settings-close-btn').click();

  await expect(page.locator('body')).toHaveClass(/xk-page-scroll-disabled/);
  let contract = await readScrollContract(page, 'view-routing');
  expect(contract.bodyOverflowY).toBe('hidden');
  expect(['auto', 'scroll']).toContain(contract.viewOverflowY);
  expect(contract.viewScrollHeight).toBeGreaterThan(contract.viewClientHeight);
  await page.locator('#view-routing').evaluate((node) => { node.scrollTop = node.scrollHeight; });
  contract = await readScrollContract(page, 'view-routing');
  expect(contract.viewScrollTop).toBeGreaterThan(0);
  expect(contract.outerScrollTop).toBe(0);

  await openScrollSettings(page);
  await pageScrollSlider.click();
  await expect(pageScroll).toBeChecked();
  await expect(workspaceScroll).toBeEnabled();
  await workspaceScrollSlider.click();
  await expect(workspaceScroll).not.toBeChecked();
  await expect(page.locator('#ui-settings-status')).toContainText('Сохранено');
  await expect(pageScroll).toBeDisabled();
  await page.locator('#ui-settings-close-btn').click();

  await expect(page.locator('body')).toHaveClass(/xk-workspace-scroll-disabled/);
  contract = await readScrollContract(page, 'view-routing');
  expect(['auto', 'scroll']).toContain(contract.bodyOverflowY);
  expect(contract.viewOverflowY).toBe('visible');
  expect(contract.viewScrollTop).toBe(0);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  contract = await readScrollContract(page, 'view-routing');
  expect(contract.outerScrollTop).toBeGreaterThan(0);

  await page.evaluate(() => window.XKeen.topLevel.router.navigate('/devtools'));
  await expect(page.locator('body')).toHaveClass(/devtools-page/);
  await page.evaluate(() => window.XKeen.topLevel.router.navigate('/'));
  await expect(page.locator('body')).toHaveClass(/panel-page/);
  await expect(page.locator('body')).toHaveClass(/xk-workspace-scroll-disabled/);
});

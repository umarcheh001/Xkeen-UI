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
  await expect(page.locator('.panel-header')).toBeVisible();
  await page.waitForFunction(() => typeof window.showView === 'function');
  await page.evaluate(() => window.showView('routing'));
  await expect(page.locator('#view-routing')).toBeVisible();
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
        expect(before.headerOverflowY, label).toBe('auto');
        expect(before.headerClientHeight, label).toBeGreaterThan(0);
        // The outer page scroll now carries the header on short screens; the
        // header remains locally scrollable when its controls need it, but it
        // is valid for its intrinsic content to fit at a given width.
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

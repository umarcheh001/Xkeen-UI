import { test, expect } from './fixtures.mjs';


const viewport = { width: 1366, height: 768 };
const workspaceTabs = ['routing', 'mihomo', 'xkeen', 'xray-logs', 'commands', 'files'];


async function openPanel(page) {
  await page.setViewportSize(viewport);
  await page.addInitScript(() => {
    localStorage.setItem('xkeen-theme', 'dark');
    localStorage.setItem('xkeen.editor.engine', 'codemirror');
  });
  await page.goto('/');
  await expect(page.locator('.panel-header')).toBeVisible();
  await expect(page.locator('#view-routing')).toBeVisible();
}


async function readScrollContract(page, viewId) {
  return page.evaluate((id) => {
    const view = document.getElementById(id);
    const body = document.body;
    const root = document.documentElement;
    const viewStyle = getComputedStyle(view);
    const bodyStyle = getComputedStyle(body);
    const rootStyle = getComputedStyle(root);
    const viewRect = view.getBoundingClientRect();
    return {
      viewOverflowY: viewStyle.overflowY,
      viewScrollHeight: view.scrollHeight,
      viewClientHeight: view.clientHeight,
      viewScrollTop: view.scrollTop,
      viewBottom: viewRect.bottom,
      viewportHeight: innerHeight,
      bodyOverflowY: bodyStyle.overflowY,
      rootOverflowY: rootStyle.overflowY,
      bodyScrollHeight: body.scrollHeight,
      bodyClientHeight: body.clientHeight,
      rootScrollHeight: root.scrollHeight,
      rootClientHeight: root.clientHeight,
    };
  }, viewId);
}


test('panel workspaces scroll inside the active view without page overflow', async ({ page }) => {
  await openPanel(page);

  for (const tab of workspaceTabs) {
    const tabButton = page.locator(`.top-tab-btn[data-view="${tab}"]`);
    if (!(await tabButton.count())) continue;

    await tabButton.click();
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
    expect(['auto', 'scroll'], tab).toContain(before.viewOverflowY);
    expect(before.viewBottom, tab).toBeLessThanOrEqual(before.viewportHeight + 1);
    expect(before.bodyOverflowY, tab).toBe('hidden');
    expect(before.bodyScrollHeight - before.bodyClientHeight, tab).toBeLessThanOrEqual(1);
    expect(before.rootScrollHeight - before.rootClientHeight, tab).toBeLessThanOrEqual(1);
    expect(before.viewScrollHeight, tab).toBeGreaterThan(before.viewClientHeight);

    await view.evaluate((node) => { node.scrollTop = node.scrollHeight; });
    const after = await readScrollContract(page, viewId);
    expect(after.viewScrollTop, tab).toBeGreaterThan(0);

    await page.locator(`[data-issue33-probe="${viewId}"]`).evaluate((node) => node.remove());
  }
});

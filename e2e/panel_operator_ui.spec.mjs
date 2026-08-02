import path from 'node:path';

import { test, expect } from './fixtures.mjs';


const captureEnabled = process.env.XKEEN_CAPTURE_UI === '1';

async function openInteractivePanel(page) {
  await page.goto('/');
  await page.waitForFunction(() => {
    const shell = window.XKeen?.pages?.panelShell;
    return !!shell?.isInitialized?.();
  });
}

async function capture(page, name) {
  if (!captureEnabled) return;
  await page.screenshot({
    path: path.join(process.cwd(), '.tmp', name),
    fullPage: true,
  });
}

async function expectNoPageOverflow(page) {
  const dimensions = await page.evaluate(() => ({
    viewport: window.innerWidth,
    body: document.body.scrollWidth,
    root: document.documentElement.scrollWidth,
  }));
  expect(Math.max(dimensions.body, dimensions.root)).toBeLessThanOrEqual(dimensions.viewport + 1);
}

test('operator stylesheet is isolated and loaded last', async ({ page }) => {
  await openInteractivePanel(page);

  await expect(page.locator('body')).toHaveClass(/\bpanel-page\b/);
  await expect(page.locator('#routing-focus-note')).toBeAttached();
  await expect(page.locator('#routing-focus-note')).toBeHidden();

  const stylesheets = await page.evaluate(() => {
    return Array.from(document.styleSheets).map((sheet) => sheet.href || 'inline');
  });
  expect(stylesheets.at(-1)).toContain('/static/panel-operator.css');

  const token = await page.evaluate(() => {
    return getComputedStyle(document.body).getPropertyValue('--op-accent').trim();
  });
  expect(token).toBeTruthy();
  await expectNoPageOverflow(page);
  await capture(page, 'panel-operator-routing-desktop.png');
});

test('ports workspace uses dense editor rows instead of pill actions', async ({ page }) => {
  await openInteractivePanel(page);
  await page.locator('.top-tab-btn[data-view="xkeen"]').click();

  await expect(page.locator('#view-xkeen')).toBeVisible();
  await expect(page.locator('.xkeen-mini-editor')).toHaveCount(4);
  await expectNoPageOverflow(page);

  const saveButtonShape = await page.locator('#port-proxying-save-btn').evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      radius: Number.parseFloat(style.borderTopLeftRadius),
      height: node.getBoundingClientRect().height,
    };
  });
  expect(saveButtonShape.radius).toBeLessThanOrEqual(9);
  expect(saveButtonShape.height).toBeLessThanOrEqual(36);
  await capture(page, 'panel-operator-ports-desktop.png');
});

test('ports and Xray logs keep a standard gap before the operation journal', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('xkeen-theme', 'dark'));
  await openInteractivePanel(page);

  const workspaces = [
    {
      tab: 'xkeen',
      view: '#view-xkeen',
      primary: '#view-xkeen > .commands-card',
      journal: '#view-xkeen > .xk-xkeen-log-card',
    },
    {
      tab: 'xray-logs',
      view: '#view-xray-logs',
      primary: '#view-xray-logs > .log-card:not(.xk-restart-log-card)',
      journal: '#view-xray-logs > .xk-xray-logs-log-card',
    },
  ];

  for (const workspace of workspaces) {
    await page.locator(`.top-tab-btn[data-view="${workspace.tab}"]`).click();
    await expect(page.locator(workspace.view)).toBeVisible();

    const gap = await page.evaluate(({ primary, journal }) => {
      const primaryRect = document.querySelector(primary).getBoundingClientRect();
      const journalRect = document.querySelector(journal).getBoundingClientRect();
      return journalRect.top - primaryRect.bottom;
    }, workspace);

    expect(gap).toBeGreaterThanOrEqual(9.5);
    expect(gap).toBeLessThanOrEqual(10.5);
    await capture(page, `panel-operator-${workspace.tab}-journal-spacing.png`);
  }
});

test('help links render as compact data rows', async ({ page }) => {
  await openInteractivePanel(page);
  await page.locator('#routing-help-header').click();

  const links = page.locator('#routing-help-body .links > li');
  await expect(links).toHaveCount(8);
  await expect(links.first()).toBeVisible();
  const firstRow = await links.first().evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      radius: Number.parseFloat(style.borderTopLeftRadius),
      height: node.getBoundingClientRect().height,
    };
  });
  expect(firstRow.radius).toBeLessThanOrEqual(6);
  expect(firstRow.height).toBeLessThanOrEqual(38);
  await capture(page, 'panel-operator-help-desktop.png');
});

test('json editor modal keeps the editor as the visual center', async ({ page }) => {
  await openInteractivePanel(page);
  const outboundsBody = page.locator('#outbounds-body');
  if (!(await outboundsBody.isVisible())) {
    await page.locator('#outbounds-header').click();
  }
  await expect(outboundsBody).toBeVisible();
  await page.locator('#outbounds-open-editor-btn').click();

  const modal = page.locator('#json-editor-modal');
  await expect(modal).toBeVisible();
  await expect(page.locator('#json-editor-file-label')).toBeHidden();

  const layout = await modal.evaluate((node) => {
    const content = node.querySelector('.modal-content');
    const body = node.querySelector('.modal-body');
    const editor = Array.from(node.querySelectorAll('.xkeen-cm6-host, .CodeMirror, .xk-monaco-editor:not(.hidden), textarea:not(.hidden)'))
      .find((candidate) => candidate.getBoundingClientRect().height > 0);
    const contentRect = content?.getBoundingClientRect();
    const bodyRect = body?.getBoundingClientRect();
    const editorRect = editor?.getBoundingClientRect();
    return {
      contentHeight: contentRect?.height || 0,
      bodyHeight: bodyRect?.height || 0,
      editorHeight: editorRect?.height || 0,
      viewportHeight: window.innerHeight,
    };
  });
  expect(layout.contentHeight).toBeLessThanOrEqual(layout.viewportHeight - 16);
  expect(layout.editorHeight).toBeGreaterThan(layout.bodyHeight * 0.62);
  await capture(page, 'panel-operator-json-editor-desktop.png');
});

test.describe('mobile operator shell', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('navigation and workspace fit without horizontal page scrolling', async ({ page }) => {
    await openInteractivePanel(page);
    await expect(page.locator('.panel-header')).toBeVisible();
    await expectNoPageOverflow(page);

    await page.locator('.top-tab-btn[data-view="xkeen"]').click();
    await expect(page.locator('#view-xkeen')).toBeVisible();
    await expectNoPageOverflow(page);
    await capture(page, 'panel-operator-ports-mobile.png');
  });
});

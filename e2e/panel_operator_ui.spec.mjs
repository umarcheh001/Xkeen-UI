import path from 'node:path';

import { test, expect } from '@playwright/test';


const captureEnabled = process.env.XKEEN_CAPTURE_UI === '1';

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
  await page.goto('/');

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
  await page.goto('/');
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

test('help links render as compact data rows', async ({ page }) => {
  await page.goto('/');
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
  await page.goto('/');
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
    const editor = node.querySelector('.xkeen-cm6-host, .CodeMirror, .xk-monaco-editor:not(.hidden), textarea:not(.hidden)');
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
    await page.goto('/');
    await expect(page.locator('.panel-header')).toBeVisible();
    await expectNoPageOverflow(page);

    await page.locator('.top-tab-btn[data-view="xkeen"]').click();
    await expect(page.locator('#view-xkeen')).toBeVisible();
    await expectNoPageOverflow(page);
    await capture(page, 'panel-operator-ports-mobile.png');
  });
});

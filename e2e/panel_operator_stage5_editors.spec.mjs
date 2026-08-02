import { test, expect } from './fixtures.mjs';


async function openPanel(page, theme, viewport = { width: 1440, height: 900 }) {
  await page.setViewportSize(viewport);
  await page.addInitScript((nextTheme) => {
    localStorage.setItem('xkeen-theme', nextTheme);
    localStorage.setItem('xkeen.editor.engine', 'codemirror');
  }, theme);
  await page.goto('/');
  await expect(page.locator('body')).toHaveClass(/\bpanel-page\b/);
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}

async function openJsonEditor(page) {
  const routingTab = page.locator('.top-tab-btn[data-view="routing"]');
  await routingTab.click();
  await expect(page.locator('#view-routing')).toBeVisible();
  const outbounds = page.locator('#outbounds-body');
  if (!(await outbounds.isVisible())) await page.locator('#outbounds-header').click();
  await page.locator('#outbounds-open-editor-btn').waitFor({ state: 'visible' });
  await page.locator('#outbounds-open-editor-btn').click();
  await expect(page.locator('#json-editor-modal')).toBeVisible();
}

async function openStaticWorkbenchModal(page, id) {
  await page.locator(`#${id}`).evaluate((node) => node.classList.remove('hidden'));
  await expect(page.locator(`#${id}`)).toBeVisible();
}

async function openEditorHelp(page) {
  await page.locator('#json-editor-format-btn').focus();
  await page.evaluate(() => window.xkeenOpenCmHelp({}));
  await expect(page.locator('#xkeen-cm-help-drawer')).toHaveClass(/\bis-open\b/);
}

async function workbenchGeometry(page, id) {
  return page.locator(`#${id}`).evaluate((modal) => {
    const content = modal.querySelector('.modal-content');
    const header = modal.querySelector('.modal-header');
    const body = modal.querySelector('.modal-body');
    const footer = modal.querySelector('.modal-actions');
    const editor = Array.from(modal.querySelectorAll('textarea, .CodeMirror, .xkeen-cm6-host, .xk-monaco-editor'))
      .find((node) => !node.classList.contains('hidden') && node.getBoundingClientRect().height > 0);
    const rect = (node) => {
      const value = node?.getBoundingClientRect();
      return value ? { top: value.top, bottom: value.bottom, height: value.height } : null;
    };
    return {
      content: rect(content),
      header: rect(header),
      body: rect(body),
      footer: rect(footer),
      editor: rect(editor),
      viewport: window.innerHeight,
    };
  });
}

function expectWorkbench(geometry, fullscreen = false) {
  expect(geometry.content.height).toBeGreaterThan(500);
  expect(geometry.header.height).toBeGreaterThanOrEqual(48);
  expect(geometry.header.height).toBeLessThanOrEqual(52);
  expect(geometry.footer.height).toBeGreaterThanOrEqual(48);
  expect(geometry.footer.height).toBeLessThanOrEqual(52);
  expect(geometry.editor.height).toBeGreaterThan(geometry.body.height * 0.6);
  expect(geometry.editor.bottom).toBeLessThanOrEqual(geometry.footer.top + 1);
  expect(geometry.footer.bottom).toBeLessThanOrEqual(geometry.content.bottom + 1);
  if (fullscreen) {
    expect(geometry.content.height).toBeGreaterThanOrEqual(geometry.viewport - 1);
  } else {
    expect(geometry.content.bottom).toBeLessThanOrEqual(geometry.viewport - 16);
  }
}

test.describe('Operator Console Stage 5 editor workbench contract', () => {
  for (const theme of ['dark', 'light']) {
    test(`JSON, file and snapshot keep a bounded workbench in ${theme}`, async ({ page }) => {
      await openPanel(page, theme);
      await openJsonEditor(page);
      expectWorkbench(await workbenchGeometry(page, 'json-editor-modal'));

      await openStaticWorkbenchModal(page, 'fm-editor-modal');
      expectWorkbench(await workbenchGeometry(page, 'fm-editor-modal'));

      await openStaticWorkbenchModal(page, 'xray-snapshot-modal');
      expectWorkbench(await workbenchGeometry(page, 'xray-snapshot-modal'));
    });
  }

  test('JSON status labels are flat, semantic and stay beside the editor controls', async ({ page }) => {
    await openPanel(page, 'dark');
    await openJsonEditor(page);

    const statuses = await page.locator('#json-editor-comments-status, #json-editor-schema-status').evaluateAll((nodes) => nodes.map((node) => {
      const style = getComputedStyle(node);
      return {
        role: node.getAttribute('role'),
        radius: Number.parseFloat(style.borderTopLeftRadius),
        leftBorder: Number.parseFloat(style.borderLeftWidth),
        background: style.backgroundImage,
        before: getComputedStyle(node, '::before').content,
      };
    }));
    expect(statuses).toHaveLength(2);
    for (const status of statuses) {
      expect(status.role).toBe('status');
      expect(status.radius).toBeLessThanOrEqual(1);
      expect(status.leftBorder).toBeGreaterThanOrEqual(2);
      expect(status.background).toBe('none');
      expect(status.before).toBe('none');
    }
  });

  test('narrow JSON workbench is fullscreen with fixed header and footer', async ({ page }) => {
    await openPanel(page, 'light', { width: 390, height: 844 });
    await openJsonEditor(page);
    expectWorkbench(await workbenchGeometry(page, 'json-editor-modal'), true);
  });

  test('editor help is a desktop sidecar and never covers the JSON action row', async ({ page }) => {
    await openPanel(page, 'dark');
    await openJsonEditor(page);
    await openEditorHelp(page);

    const geometry = await page.evaluate(() => {
      const rect = (selector) => {
        const value = document.querySelector(selector)?.getBoundingClientRect();
        return value && { left: value.left, right: value.right, top: value.top, bottom: value.bottom };
      };
      return { drawer: rect('#xkeen-cm-help-drawer'), footer: rect('#json-editor-modal .modal-actions') };
    });
    expect(geometry.drawer.left).toBeGreaterThanOrEqual(geometry.footer.right);

    const sourceAction = page.locator('#json-editor-format-btn');
    await sourceAction.focus();
    await page.evaluate(() => window.xkeenOpenCmHelp({}));
    await expect(page.locator('#xkeen-cm-help-drawer')).toHaveClass(/\bis-open\b/);
    await expect(page.locator('.xkeen-cm-help-close')).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(page.locator('#xkeen-cm-help-drawer')).not.toHaveClass(/\bis-open\b/);
    await expect(sourceAction).toBeFocused();
  });

  test('editor help becomes a fullscreen mobile workbench', async ({ page }) => {
    await openPanel(page, 'light', { width: 390, height: 844 });
    await openJsonEditor(page);
    await openEditorHelp(page);

    const geometry = await page.locator('#xkeen-cm-help-drawer').evaluate((drawer) => {
      const rect = drawer.getBoundingClientRect();
      return { width: rect.width, height: rect.height, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight };
    });
    expect(geometry.width).toBeGreaterThanOrEqual(geometry.viewportWidth - 1);
    expect(geometry.height).toBeGreaterThanOrEqual(geometry.viewportHeight - 1);
    await expect(page.locator('.xkeen-cm-help-close')).toBeVisible();
  });
});

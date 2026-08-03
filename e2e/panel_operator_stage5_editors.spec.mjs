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

async function switchToMonaco(page, { tab, select, host }) {
  await page.locator(`.top-tab-btn[data-view="${tab}"]`).click();
  await expect(page.locator(select)).toBeAttached();
  await page.locator(select).scrollIntoViewIfNeeded();
  await expect(page.locator(select)).toBeVisible();
  await page.locator(select).selectOption('monaco');
  await expect(page.locator(`${host} .monaco-editor`)).toBeVisible({ timeout: 15_000 });
}

async function triggerMonacoSuggest(page, host, text, expectedText, cursorOffset = null) {
  await page.locator(host).evaluate(async (editorHost, { nextText, expected, offset }) => {
    const editor = monaco.editor.getEditors().find((item) => editorHost.contains(item.getDomNode()));
    if (!editor) throw new Error(`Monaco editor is missing from ${editorHost.id}`);
    const model = editor.getModel();
    const until = Date.now() + 8_000;
    do {
      model.setValue(nextText);
      editor.setPosition(model.getPositionAt(offset == null ? nextText.length : offset));
      editor.focus();
      editor.trigger('xkeen-e2e', 'editor.action.triggerSuggest', {});
      await new Promise((resolve) => setTimeout(resolve, 350));
      const widget = editorHost.querySelector('.suggest-widget.visible');
      if (!expected || String(widget?.innerText || '').includes(expected)) return;
    } while (Date.now() < until);
  }, { nextText: text, expected: expectedText, offset: cursorOffset });
}

async function expectVisibleMonacoSuggest(page, host, expectedText) {
  const popup = page.locator(`${host} .suggest-widget.visible`);
  await expect(popup).toBeVisible();
  await expect(popup).toContainText(expectedText);

  const state = await popup.evaluate((widget) => {
    const row = widget.querySelector('.monaco-list-row');
    const label = row?.querySelector('.label-name');
    const style = getComputedStyle(widget);
    const rowStyle = row ? getComputedStyle(row) : null;
    const labelStyle = label ? getComputedStyle(label) : null;
    return {
      rows: widget.querySelectorAll('.monaco-list-row').length,
      widgetBackground: style.backgroundColor,
      widgetColor: style.color,
      rowColor: rowStyle?.color || '',
      labelColor: labelStyle?.color || '',
      widgetHeight: widget.getBoundingClientRect().height,
    };
  });

  expect(state.rows).toBeGreaterThan(0);
  expect(state.widgetHeight).toBeGreaterThan(24);
  expect(state.widgetBackground).not.toBe(state.widgetColor);
  expect(state.rowColor).not.toBe(state.widgetBackground);
  expect(state.labelColor).not.toBe(state.widgetBackground);
}

async function expectMonacoWidgetUsesOperatorSurface(page, host, selector) {
  const widget = page.locator(`${host} ${selector}`);
  await expect(widget).toBeVisible();
  const state = await widget.evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      background: style.backgroundColor,
      color: style.color,
      border: style.borderTopColor,
      height: node.getBoundingClientRect().height,
    };
  });
  expect(state.height).toBeGreaterThan(0);
  expect(state.background).not.toBe(state.color);
  expect(state.border).not.toBe(state.background);
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


  test('all 50 static windows resolve to one of the four shared modal frames', async ({ page }) => {
    await openPanel(page, 'dark');

    const frames = await page.evaluate(() => {
      const expectedCounts = {
        'confirm-compact-form': 22,
        'editor-workbench': 6,
        'master-detail': 19,
        'drawer-help': 3,
      };
      const modals = Array.from(document.querySelectorAll('.modal[data-operator-modal-family]'));
      const records = modals.map((modal) => {
        modal.classList.remove('hidden');
        const content = modal.querySelector('.modal-content');
        const header = modal.querySelector('.modal-header');
        const body = modal.querySelector('.modal-body');
        const contentRect = content?.getBoundingClientRect();
        const headerRect = header?.getBoundingClientRect();
        const bodyRect = body?.getBoundingClientRect();
        const style = content ? getComputedStyle(content) : null;
        modal.classList.add('hidden');
        return {
          id: modal.id,
          family: modal.dataset.operatorModalFamily,
          display: style?.display,
          content: contentRect && {
            width: contentRect.width,
            height: contentRect.height,
            top: contentRect.top,
            bottom: contentRect.bottom,
          },
          headerHeight: headerRect?.height || 0,
          bodyHeight: bodyRect?.height || 0,
        };
      });
      return { expectedCounts, viewport: window.innerHeight, records };
    });

    expect(frames.records).toHaveLength(50);
    const counts = Object.fromEntries(Object.keys(frames.expectedCounts).map((family) => [
      family,
      frames.records.filter((record) => record.family === family).length,
    ]));
    expect(counts).toEqual(frames.expectedCounts);

    for (const frame of frames.records) {
      expect(frame.display, frame.id).toBe('grid');
      expect(frame.content?.width || 0, frame.id).toBeGreaterThan(0);
      expect(frame.content?.height || 0, frame.id).toBeGreaterThan(0);
      expect(frame.content?.top || 0, frame.id).toBeGreaterThanOrEqual(0);
      expect(frame.content?.bottom || Infinity, frame.id).toBeLessThanOrEqual(frames.viewport + 1);
      expect(frame.headerHeight, frame.id).toBeGreaterThanOrEqual(48);
      expect(frame.bodyHeight, frame.id).toBeGreaterThan(0);
    }
  });

  test('JSON status labels are flat, semantic and stay below the editor', async ({ page }) => {
    await openPanel(page, 'dark');
    await openJsonEditor(page);

    const statusMeta = await page.locator('#json-editor-runtime-meta').evaluate((meta) => {
      const editor = document.querySelector('#json-editor-modal textarea:not(.hidden), #json-editor-modal .CodeMirror:not(.hidden)');
      const metaRect = meta.getBoundingClientRect();
      const editorRect = editor?.getBoundingClientRect();
      const statuses = Array.from(meta.querySelectorAll('#json-editor-comments-status, #json-editor-schema-status')).map((node) => {
      const style = getComputedStyle(node);
      return {
        role: node.getAttribute('role'),
        radius: Number.parseFloat(style.borderTopLeftRadius),
        leftBorder: Number.parseFloat(style.borderLeftWidth),
        background: style.backgroundImage,
        before: getComputedStyle(node, '::before').content,
      };
      });
      return {
        parentId: meta.id,
        metaTop: metaRect.top,
        editorBottom: editorRect?.bottom || 0,
        statuses,
      };
    });
    expect(statusMeta.parentId).toBe('json-editor-runtime-meta');
    expect(statusMeta.metaTop).toBeGreaterThanOrEqual(statusMeta.editorBottom - 1);
    expect(statusMeta.statuses).toHaveLength(2);
    for (const status of statusMeta.statuses) {
      expect(status.role).toBe('status');
      expect(status.radius).toBeLessThanOrEqual(1);
      expect(status.leftBorder).toBe(0);
      expect(status.background).toBe('none');
      expect(status.before).toBe('none');
    }
  });

  test('Xray and Mihomo Monaco completion widgets keep schema options readable', async ({ page }) => {
    await openPanel(page, 'dark');

    await switchToMonaco(page, {
      tab: 'routing',
      select: '#routing-editor-engine-select',
      host: '#routing-editor-monaco',
    });
    const xraySuggestText = '{\n  "routing": {\n    "rules": [\n      {\n        "t"\n      }\n    ]\n  }\n}';
    await triggerMonacoSuggest(
      page,
      '#routing-editor-monaco',
      xraySuggestText,
      'type',
      xraySuggestText.indexOf('"t"') + 2,
    );
    await expectVisibleMonacoSuggest(page, '#routing-editor-monaco', 'type');

    await page.locator('#routing-editor-monaco').evaluate((editorHost) => {
      const editor = monaco.editor.getEditors().find((item) => editorHost.contains(item.getDomNode()));
      const target = editorHost.querySelector('.suggest-widget.visible');
      if (!editor || !target) throw new Error('Monaco suggestion widget is missing');
      const details = document.createElement('div');
      details.className = 'suggest-details visible';
      details.textContent = 'Schema documentation preview';
      target.appendChild(details);
    });
    await expectMonacoWidgetUsesOperatorSurface(page, '#routing-editor-monaco', '.suggest-details');

    await switchToMonaco(page, {
      tab: 'mihomo',
      select: '#mihomo-editor-engine-select',
      host: '#mihomo-editor-monaco',
    });
    await triggerMonacoSuggest(page, '#mihomo-editor-monaco', 'proxies:\n  - name: demo\n    type: ', 'vless');
    await expectVisibleMonacoSuggest(page, '#mihomo-editor-monaco', 'vless');
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

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

async function openProxyPool(page) {
  const outbounds = page.locator('#outbounds-body');
  if (!(await outbounds.isVisible())) await page.locator('#outbounds-header').click();
  await page.locator('#outbounds-pool-btn').click();
  await expect(page.locator('#outbounds-pool-modal')).toBeVisible();
}

async function openProxyGenerator(page) {
  const outbounds = page.locator('#outbounds-body');
  if (!(await outbounds.isVisible())) await page.locator('#outbounds-header').click();
  await page.locator('#outbounds-build-btn').click();
  await expect(page.locator('#outbounds-generator-modal')).toBeVisible();
}

async function openQuickBalancer(page) {
  await page.locator('.top-tab-btn[data-view="routing"]').click();
  await expect(page.locator('#view-routing')).toBeVisible();
  const rules = page.locator('#routing-rules-body');
  if (!(await rules.isVisible())) await page.locator('#routing-rules-header').click();
  await page.locator('#routing-balancer-quick-btn').click();
  await expect(page.locator('#routing-balancer-quick-modal')).toBeVisible();
}

async function openForcedRules(page) {
  await page.locator('.top-tab-btn[data-view="routing"]').click();
  await expect(page.locator('#view-routing')).toBeVisible();
  const rules = page.locator('#routing-rules-body');
  if (!(await rules.isVisible())) await page.locator('#routing-rules-header').click();
  await page.locator('#routing-forced-rules-btn').click();
  await expect(page.locator('#routing-forced-rules-modal')).toBeVisible();
}

async function openBalancerHelp(page) {
  await page.locator('.top-tab-btn[data-view="routing"]').click();
  await expect(page.locator('#view-routing')).toBeVisible();
  const rules = page.locator('#routing-rules-body');
  if (!(await rules.isVisible())) await page.locator('#routing-rules-header').click();
  await page.locator('#routing-balancer-help-btn').click();
  await expect(page.locator('#routing-balancer-help-modal')).toBeVisible();
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

async function modalFrameGeometry(page, id) {
  return page.locator(`#${id}`).evaluate((modal) => {
    const content = modal.querySelector('.modal-content');
    const body = modal.querySelector('.modal-body');
    const contentRect = content?.getBoundingClientRect();
    const bodyRect = body?.getBoundingClientRect();
    const contentStyle = content ? getComputedStyle(content) : null;
    const bodyStyle = body ? getComputedStyle(body) : null;
    return {
      contentHeight: contentRect?.height || 0,
      bodyHeight: bodyRect?.height || 0,
      contentRows: contentStyle?.gridTemplateRows || '',
      bodyOverflowY: bodyStyle?.overflowY || '',
    };
  });
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
        'editor-workbench': 7,
        'master-detail': 18,
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

  test('proxy-pool source resizes both directions and keeps actions below the field', async ({ page }) => {
    await openPanel(page, 'dark');
    await openProxyPool(page);

    const input = page.locator('#outbounds-pool-input');
    const toolbar = page.locator('#outbounds-pool-modal .xk-pool-toolbar');
    const modalContent = page.locator('#outbounds-pool-modal .modal-content');
    const geometry = async () => page.locator('#outbounds-pool-modal').evaluate((modal) => {
      const field = modal.querySelector('#outbounds-pool-input').getBoundingClientRect();
      const actions = modal.querySelector('.xk-pool-toolbar').getBoundingClientRect();
      return {
        fieldHeight: field.height,
        fieldBottom: field.bottom,
        toolbarTop: actions.top,
      };
    });

    const dragResizeHandle = async (deltaY) => {
      const box = await input.boundingBox();
      const x = box.x + box.width - 2;
      const y = box.y + box.height - 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x, y + deltaY, { steps: 12 });
      await page.mouse.up();
    };

    const initial = await geometry();
    expect(initial.toolbarTop).toBeGreaterThanOrEqual(initial.fieldBottom + 1);

    await modalContent.evaluate((content) => {
      const current = content.getBoundingClientRect();
      content.style.height = `${Math.min(window.innerHeight - 36, current.height + 100)}px`;
      document.dispatchEvent(new CustomEvent('xkeen-modal-resize', {
        detail: { modal: 'outbounds-pool-modal' },
      }));
    });
    await page.waitForTimeout(50);
    const fitted = await geometry();
    expect(fitted.fieldHeight).toBeGreaterThan(initial.fieldHeight + 70);
    expect(fitted.toolbarTop).toBeGreaterThanOrEqual(fitted.fieldBottom + 1);

    await dragResizeHandle(100);
    const enlarged = await geometry();
    expect(enlarged.fieldHeight).toBeGreaterThan(fitted.fieldHeight + 70);
    expect(enlarged.toolbarTop).toBeGreaterThanOrEqual(enlarged.fieldBottom + 1);

    await dragResizeHandle(-80);
    const reduced = await geometry();
    expect(reduced.fieldHeight).toBeLessThan(enlarged.fieldHeight - 50);
    expect(reduced.toolbarTop).toBeGreaterThanOrEqual(reduced.fieldBottom + 1);
    await expect(toolbar).toBeVisible();
  });

  for (const theme of ['dark', 'light']) {
    test(`Xray mini-generator uses flat operator surfaces in ${theme}`, async ({ page }) => {
      await openPanel(page, theme);
      await openProxyGenerator(page);

      const state = await page.locator('#outbounds-generator-modal').evaluate((modal) => {
        const style = (selector) => getComputedStyle(modal.querySelector(selector));
        const lead = style('.xk-gen-lead');
        const grid = style('.xk-gen-grid2');
        const field = style('.xk-gen-selects label');
        const summary = style('.xk-gen-summary');
        const credentials = style('.xk-gen-credentials-card');
        const preview = style('.xk-gen-preview-block');
        const input = style('#outbounds-gen-host');
        return {
          gradients: [lead, grid, field, summary, credentials, preview, input]
            .map((item) => item.backgroundImage),
          fieldBorder: Number.parseFloat(field.borderTopWidth),
          fieldRadius: Number.parseFloat(field.borderTopLeftRadius),
          summaryBorder: Number.parseFloat(summary.borderTopWidth),
          summaryRadius: Number.parseFloat(summary.borderTopLeftRadius),
          inputHeight: modal.querySelector('#outbounds-gen-host').getBoundingClientRect().height,
          gridColumns: grid.gridTemplateColumns.split(' ').length,
        };
      });

      expect(state.gradients.every((value) => value === 'none')).toBe(true);
      expect(state.fieldBorder).toBe(0);
      expect(state.fieldRadius).toBe(0);
      expect(state.summaryBorder).toBe(0);
      expect(state.summaryRadius).toBe(0);
      expect(state.inputHeight).toBeGreaterThanOrEqual(31);
      expect(state.inputHeight).toBeLessThanOrEqual(33);
      expect(state.gridColumns).toBe(2);
    });
  }

  for (const theme of ['dark', 'light']) {
    test(`Routing quick-start uses the two-step operator workbench in ${theme}`, async ({ page }) => {
      await openPanel(page, theme, { width: 1440, height: 900 });
      await openQuickBalancer(page);

      const state = await page.locator('#routing-balancer-quick-modal').evaluate((modal) => {
        const inspect = (selector) => {
          const node = modal.querySelector(selector);
          const style = getComputedStyle(node);
          const rect = node.getBoundingClientRect();
          return {
            backgroundImage: style.backgroundImage,
            border: Number.parseFloat(style.borderTopWidth),
            radius: Number.parseFloat(style.borderTopLeftRadius),
            height: rect.height,
          };
        };
        const content = modal.querySelector('.modal-content').getBoundingClientRect();
        const footer = modal.querySelector('.modal-actions').getBoundingClientRect();
        const grid = getComputedStyle(modal.querySelector('.xk-qb-grid'));
        const options = Array.from(modal.querySelectorAll('.xk-qb-option-card'));
        return {
          family: modal.dataset.operatorModalFamily,
          lead: inspect('.xk-qb-lead'),
          grid: inspect('.xk-qb-grid'),
          field: inspect('.xk-qb-fields-grid > label'),
          option: inspect('.xk-qb-option-card'),
          note: inspect('.xk-qb-note'),
          input: inspect('#routing-balancer-quick-tag'),
          primary: inspect('#routing-balancer-quick-run-btn'),
          gridColumns: grid.gridTemplateColumns.split(' ').length,
          optionColumns: getComputedStyle(options[0]).gridTemplateColumns.split(' ').length,
          optionTops: options.map((node) => node.getBoundingClientRect().top),
          contentBottom: content.bottom,
          footerBottom: footer.bottom,
          viewport: window.innerHeight,
        };
      });

      expect(state.family).toBe('master-detail');
      for (const surface of [state.lead, state.grid, state.field, state.option, state.note, state.input, state.primary]) {
        expect(surface.backgroundImage).toBe('none');
      }
      expect(state.lead.radius).toBe(0);
      expect(state.field.border).toBe(0);
      expect(state.field.radius).toBe(0);
      expect(state.option.radius).toBe(0);
      expect(state.note.radius).toBe(0);
      expect(state.input.height).toBeGreaterThanOrEqual(31);
      expect(state.input.height).toBeLessThanOrEqual(33);
      expect(state.primary.height).toBeGreaterThanOrEqual(31);
      expect(state.primary.height).toBeLessThanOrEqual(33);
      expect(state.gridColumns).toBe(2);
      expect(state.optionColumns).toBe(2);
      expect(state.optionTops[1]).toBeGreaterThan(state.optionTops[0]);
      expect(state.optionTops[2]).toBeGreaterThan(state.optionTops[1]);
      expect(state.footerBottom).toBeLessThanOrEqual(state.contentBottom + 1);
      expect(state.contentBottom).toBeLessThanOrEqual(state.viewport - 17);

      const toc = page.locator('#routing-balancer-help-modal .xk-balancer-help-toc');
      const main = page.locator('#routing-balancer-help-modal .xk-balancer-help-main');
      const diagnosticLink = toc.locator('a[data-help-target="xk-bhelp-troubles"]');
      await diagnosticLink.click();
      await expect(diagnosticLink).toHaveAttribute('aria-current', 'location');

      await expect.poll(async () => main.evaluate((node) => node.scrollTop)).toBeGreaterThan(100);
      const navigationState = await page.locator('#routing-balancer-help-modal').evaluate((modal) => {
        const body = modal.querySelector('.modal-body');
        const toc = modal.querySelector('.xk-balancer-help-toc');
        const main = modal.querySelector('.xk-balancer-help-main');
        const target = modal.querySelector('#xk-bhelp-troubles');
        const tocRect = toc.getBoundingClientRect();
        const bodyRect = body.getBoundingClientRect();
        const mainRect = main.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        return {
          bodyScrollTop: body.scrollTop,
          mainScrollTop: main.scrollTop,
          tocTop: tocRect.top,
          tocBottom: tocRect.bottom,
          bodyTop: bodyRect.top,
          bodyBottom: bodyRect.bottom,
          targetTop: targetRect.top,
          mainTop: mainRect.top,
        };
      });
      expect(navigationState.bodyScrollTop).toBe(0);
      expect(navigationState.mainScrollTop).toBeGreaterThan(100);
      expect(navigationState.tocTop).toBeGreaterThanOrEqual(navigationState.bodyTop - 1);
      expect(navigationState.tocBottom).toBeLessThanOrEqual(navigationState.bodyBottom + 1);
      expect(Math.abs(navigationState.targetTop - navigationState.mainTop)).toBeLessThanOrEqual(14);
    });
  }

  for (const theme of ['dark', 'light']) {
    test(`Forced routing rules use flat operator controls in ${theme}`, async ({ page }) => {
      await openPanel(page, theme, { width: 1440, height: 900 });
      await openForcedRules(page);

      const state = await page.locator('#routing-forced-rules-modal').evaluate((modal) => {
        const inspect = (selector) => {
          const node = modal.querySelector(selector);
          const style = getComputedStyle(node);
          const rect = node.getBoundingClientRect();
          return {
            backgroundImage: style.backgroundImage,
            border: Number.parseFloat(style.borderTopWidth),
            radius: Number.parseFloat(style.borderTopLeftRadius),
            height: rect.height,
          };
        };
        const content = modal.querySelector('.modal-content').getBoundingClientRect();
        const footer = modal.querySelector('.modal-actions').getBoundingClientRect();
        const optionCards = Array.from(modal.querySelectorAll('.xk-forced-option-card'));
        const toolbar = modal.querySelector('.xk-forced-wizard-toolbar');
        const priorityLabel = optionCards[1].querySelector('.xk-forced-fieldlabel').getBoundingClientRect();
        const prioritySelect = optionCards[1].querySelector('select').getBoundingClientRect();
        return {
          family: modal.dataset.operatorModalFamily,
          lead: inspect('.xk-forced-wizard-lead'),
          grid: inspect('.xk-forced-wizard-grid'),
          panel: inspect('.xk-forced-wizard-panel'),
          toolbar: inspect('.xk-forced-wizard-toolbar'),
          option: inspect('.xk-forced-option-card'),
          note: inspect('.xk-forced-wizard-note'),
          list: inspect('.xk-forced-wizard-list'),
          input: inspect('#routing-forced-rules-outbound'),
          primary: inspect('#routing-forced-rules-run-btn'),
          gridColumns: getComputedStyle(modal.querySelector('.xk-forced-wizard-grid')).gridTemplateColumns.split(' ').length,
          optionColumns: getComputedStyle(modal.querySelector('.xk-forced-options-grid')).gridTemplateColumns.split(' ').length,
          toolbarBorder: Number.parseFloat(getComputedStyle(toolbar).borderTopWidth),
          optionTops: optionCards.map((node) => node.getBoundingClientRect().top),
          priorityLabelRight: priorityLabel.right,
          prioritySelectLeft: prioritySelect.left,
          prioritySelectWidth: prioritySelect.width,
          clearSelectedIcon: modal.querySelector('#routing-forced-rules-clear-proxy-btn use')?.getAttribute('href') || '',
          clearAllIcon: modal.querySelector('#routing-forced-rules-clear-all-btn use')?.getAttribute('href') || '',
          contentBottom: content.bottom,
          footerBottom: footer.bottom,
          viewport: window.innerHeight,
        };
      });

      expect(state.family).toBe('master-detail');
      for (const surface of [state.lead, state.grid, state.panel, state.toolbar, state.option, state.note, state.list, state.input, state.primary]) {
        expect(surface.backgroundImage).toBe('none');
      }
      expect(state.lead.radius).toBe(0);
      expect(state.panel.border).toBe(0);
      expect(state.panel.radius).toBe(0);
      expect(state.toolbarBorder).toBe(0);
      expect(state.option.radius).toBe(0);
      expect(state.note.radius).toBe(0);
      expect(state.input.height).toBeGreaterThanOrEqual(31);
      expect(state.input.height).toBeLessThanOrEqual(33);
      expect(state.primary.height).toBeGreaterThanOrEqual(31);
      expect(state.primary.height).toBeLessThanOrEqual(33);
      expect(state.gridColumns).toBe(2);
      expect(state.optionColumns).toBe(1);
      expect(state.optionTops[1]).toBeGreaterThan(state.optionTops[0]);
      expect(state.optionTops[2]).toBeGreaterThan(state.optionTops[0]);
      expect(state.optionTops[2]).toBeGreaterThan(state.optionTops[1]);
      expect(state.prioritySelectLeft).toBeGreaterThanOrEqual(state.priorityLabelRight + 15);
      expect(state.prioritySelectWidth).toBeLessThanOrEqual(281);
      expect(state.clearSelectedIcon).toContain('#xk-broom');
      expect(state.clearAllIcon).toContain('#xk-trash');
      expect(state.footerBottom).toBeLessThanOrEqual(state.contentBottom + 1);
      expect(state.contentBottom).toBeLessThanOrEqual(state.viewport - 17);
    });
  }

  for (const theme of ['dark', 'light']) {
    test(`Balancer help is a current flat operator handbook in ${theme}`, async ({ page }) => {
      await openPanel(page, theme, { width: 1440, height: 900 });
      await openBalancerHelp(page);

      const state = await page.locator('#routing-balancer-help-modal').evaluate((modal) => {
        const inspect = (selector) => {
          const node = modal.querySelector(selector);
          const style = getComputedStyle(node);
          return {
            backgroundImage: style.backgroundImage,
            border: Number.parseFloat(style.borderTopWidth),
            radius: Number.parseFloat(style.borderTopLeftRadius),
          };
        };
        const content = modal.querySelector('.modal-content').getBoundingClientRect();
        const body = modal.querySelector('.modal-body').getBoundingClientRect();
        const toc = modal.querySelector('.xk-balancer-help-toc').getBoundingClientRect();
        return {
          family: modal.dataset.operatorModalFamily,
          content: inspect('.modal-content'),
          toc: inspect('.xk-balancer-help-toc'),
          tocLink: inspect('.xk-balancer-help-toc a'),
          callout: inspect('.xk-balancer-help-callout'),
          details: inspect('.xk-balancer-help-details'),
          code: inspect('.xk-balancer-help-code'),
          flow: inspect('.xk-balancer-help-flow'),
          sectionCount: modal.querySelectorAll('.xk-balancer-help-section').length,
          tocCount: modal.querySelectorAll('.xk-balancer-help-toc a').length,
          hasCurrentSubscriptionCopy: modal.textContent.includes('Служебный пул')
            && modal.textContent.includes('Только подписка')
            && modal.textContent.includes('xk_auto_leastPing'),
          bodyTop: body.top,
          bodyBottom: body.bottom,
          tocTop: toc.top,
          tocBottom: toc.bottom,
          contentBottom: content.bottom,
          viewport: window.innerHeight,
        };
      });

      expect(state.family).toBe('drawer-help');
      for (const surface of [state.content, state.toc, state.tocLink, state.callout, state.details, state.code]) {
        expect(surface.backgroundImage).toBe('none');
      }
      expect(state.toc.border).toBe(0);
      expect(state.toc.radius).toBe(0);
      expect(state.tocLink.border).toBe(0);
      expect(state.callout.radius).toBe(0);
      expect(state.details.radius).toBeLessThanOrEqual(7);
      expect(state.code.radius).toBeLessThanOrEqual(7);
      expect(state.flow.radius).toBeLessThanOrEqual(7);
      expect(state.sectionCount).toBe(8);
      expect(state.tocCount).toBe(8);
      expect(state.hasCurrentSubscriptionCopy).toBe(true);
      expect(state.tocTop).toBeGreaterThanOrEqual(state.bodyTop - 1);
      expect(state.tocBottom).toBeLessThanOrEqual(state.bodyBottom + 1);
      expect(state.contentBottom).toBeLessThanOrEqual(state.viewport - 17);
    });
  }

  for (const theme of ['dark', 'light']) {
    test(`parsed proxy metadata uses flat operator rows in ${theme}`, async ({ page }) => {
      await openPanel(page, theme);
      const outbounds = page.locator('#outbounds-body');
      if (!(await outbounds.isVisible())) await page.locator('#outbounds-header').click();

      await page.locator('#outbounds-url').fill(
        'vless://11111111-1111-4111-8111-111111111111@example.com:443?security=tls&type=ws&path=%2Fws#demo',
      );
      await expect(page.locator('#outbounds-parse-box')).toBeVisible();
      await expect(page.locator('#outbounds-parse-kv .outbounds-kv-row').first()).toBeVisible();

      const state = await page.locator('.routing-side-card--outbounds').evaluate((card) => {
        const inspect = (selector) => {
          const node = card.querySelector(selector);
          const style = getComputedStyle(node);
          return {
            backgroundImage: style.backgroundImage,
            border: Number.parseFloat(style.borderTopWidth),
            radius: Number.parseFloat(style.borderTopLeftRadius),
          };
        };
        return {
          box: inspect('#outbounds-parse-box'),
          badge: inspect('.outbounds-badge'),
          row: inspect('.outbounds-kv-row'),
          rowCount: card.querySelectorAll('.outbounds-kv-row').length,
        };
      });

      expect(state.box.backgroundImage).toBe('none');
      expect(state.box.radius).toBe(0);
      expect(state.badge.backgroundImage).toBe('none');
      expect(state.badge.border).toBe(0);
      expect(state.badge.radius).toBe(0);
      expect(state.row.backgroundImage).toBe('none');
      expect(state.row.radius).toBe(0);
      expect(state.rowCount).toBeGreaterThan(2);
    });
  }

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

  test('visible empty and error states restore auto-height without shrinking hidden placeholders', async ({ page }) => {
    await openPanel(page, 'dark');

    await openStaticWorkbenchModal(page, 'fm-editor-modal');
    const workbenchLoaded = await modalFrameGeometry(page, 'fm-editor-modal');
    expect(workbenchLoaded.contentHeight).toBeGreaterThan(500);

    const workbenchError = await page.locator('#fm-editor-modal').evaluate((modal) => {
      const error = modal.querySelector('#fm-editor-error');
      error.textContent = 'Unable to load the selected file.';
      error.style.display = 'block';
      const content = modal.querySelector('.modal-content');
      const body = modal.querySelector('.modal-body');
      return {
        contentHeight: content.getBoundingClientRect().height,
        bodyHeight: body.getBoundingClientRect().height,
        contentRows: getComputedStyle(content).gridTemplateRows,
        bodyOverflowY: getComputedStyle(body).overflowY,
      };
    });
    expect(workbenchError.contentHeight).toBeLessThan(workbenchLoaded.contentHeight - 80);
    expect(workbenchError.contentRows).not.toContain('1fr');
    expect(workbenchError.bodyOverflowY).toBe('auto');

    await page.locator('#fm-editor-modal').evaluate((modal) => {
      const error = modal.querySelector('#fm-editor-error');
      error.textContent = '';
      error.style.display = 'none';
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'Nothing to edit.';
      modal.querySelector('.modal-body').prepend(empty);
    });
    const workbenchEmpty = await modalFrameGeometry(page, 'fm-editor-modal');
    expect(workbenchEmpty.contentHeight).toBeLessThan(workbenchLoaded.contentHeight - 80);
    expect(workbenchEmpty.contentRows).not.toContain('1fr');
    expect(workbenchEmpty.bodyOverflowY).toBe('auto');

    await page.locator('#fm-editor-modal').evaluate((modal) => modal.classList.add('hidden'));
    await openStaticWorkbenchModal(page, 'github-catalog-modal');
    const detailLoaded = await modalFrameGeometry(page, 'github-catalog-modal');
    expect(detailLoaded.contentHeight).toBeGreaterThan(500);
    await page.locator('#github-catalog-error').evaluate((error) => {
      error.textContent = 'Catalog is temporarily unavailable.';
      error.style.display = 'block';
    });
    const detailError = await modalFrameGeometry(page, 'github-catalog-modal');
    expect(detailError.contentHeight).toBeLessThan(detailLoaded.contentHeight - 80);
    expect(detailError.contentRows).not.toContain('1fr');
    expect(detailError.bodyOverflowY).toBe('auto');
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

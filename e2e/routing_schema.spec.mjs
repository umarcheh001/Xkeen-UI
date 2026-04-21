import { test, expect } from '@playwright/test';

const VALID_ROUTING = [
  '{',
  '  "routing": {',
  '    "domainStrategy": "AsIs",',
  '    "rules": [',
  '      {',
  '        "type": "field",',
  '        "outboundTag": "direct",',
  '        "ip": [',
  '          "1.1.1.1/32"',
  '        ]',
  '      }',
  '    ]',
  '  }',
  '}',
  '',
].join('\n');

const INVALID_ROUTING = VALID_ROUTING.replace('"1.1.1.1/32"', '"1.1.1.1/32",,');

const COMPLETION_ROUTING = [
  '{',
  '  "routing": {',
  '    ',
  '  }',
  '}',
  '',
].join('\n');

async function waitForRoutingEditor(page) {
  await expect(page.locator('#view-routing')).toBeVisible();
  await page.waitForFunction(() => {
    return !!(
      window.XKeen &&
      window.XKeen.features &&
      window.XKeen.features.routing &&
      window.XKeen.features.routingShell &&
      typeof window.XKeen.features.routing.replaceEditorText === 'function' &&
      typeof window.XKeen.features.routingShell.getEditorInstance === 'function'
    );
  });
}

async function ensureCodeMirrorRouting(page) {
  const select = page.locator('#routing-editor-engine-select');
  await expect(select).toBeVisible();
  await select.selectOption('codemirror');

  await page.waitForFunction(() => {
    const maybeEditor = window.XKeen?.features?.routingShell?.getEditorInstance?.({ preferRaw: true });
    const editor = maybeEditor && maybeEditor.raw ? maybeEditor.raw : maybeEditor;
    const isCm6 = !!(editor && (
      editor.__xkeenCm6Bridge === true ||
      editor.__xkeen_cm6_bridge === true ||
      editor.backend === 'cm6'
    ));
    return !!(isCm6 && typeof editor.getSchema === 'function');
  });
}

async function replaceRoutingText(page, text) {
  await page.evaluate((nextText) => {
    window.XKeen.features.routing.replaceEditorText(nextText, {
      markDirty: false,
      reason: 'e2e-routing-schema',
      scrollTop: true,
    });
  }, text);
}

async function waitForRoutingSchema(page) {
  await page.waitForFunction(() => {
    const maybeEditor = window.XKeen?.features?.routingShell?.getEditorInstance?.({ preferRaw: true });
    const editor = maybeEditor && maybeEditor.raw ? maybeEditor.raw : maybeEditor;
    const schema = editor && typeof editor.getSchema === 'function' ? editor.getSchema() : null;
    return schema && schema.title === 'Xray Routing Fragment';
  });
}

async function findTokenCenter(page, needle) {
  const box = await page.evaluate((token) => {
    const root = document.querySelector('.cm-content');
    if (!root) return null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const index = String(node.nodeValue || '').indexOf(token);
      if (index >= 0) {
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + token.length);
        const rect = range.getBoundingClientRect();
        range.detach();
        if (rect.width || rect.height) {
          return {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
          };
        }
      }
      node = walker.nextNode();
    }
    return null;
  }, needle);

  expect(box, `token ${needle} should be rendered in CodeMirror`).toBeTruthy();
  return box;
}

async function hoverRenderedToken(page, needle) {
  const box = await findTokenCenter(page, needle);
  await page.mouse.move(box.x, box.y);
}

async function clearEditorTooltips(page) {
  await page.mouse.move(8, 8);
  await page.waitForTimeout(200);
}

async function tooltipText(page, selector) {
  return page.evaluate((css) => {
    return Array.from(document.querySelectorAll(css))
      .map((node) => String(node.textContent || ''))
      .join('\n');
  }, selector);
}

async function moveRoutingCursor(page, pos) {
  await page.evaluate(({ line, ch }) => {
    const maybeEditor = window.XKeen?.features?.routingShell?.getEditorInstance?.({ preferRaw: true });
    const editor = maybeEditor && maybeEditor.raw ? maybeEditor.raw : maybeEditor;
    editor.setCursor({ line, ch });
    editor.focus();
  }, pos);
}

test('routing CodeMirror keeps JSONC diagnostics and exposes fragment schema help', async ({ page }) => {
  await page.goto('/');
  await waitForRoutingEditor(page);
  await ensureCodeMirrorRouting(page);
  await waitForRoutingSchema(page);

  await replaceRoutingText(page, INVALID_ROUTING);

  await expect(page.locator('#routing-error')).toContainText(/JSON error|Недопустимый символ|Ожидается/);
  await expect
    .poll(() => page.evaluate(() => document.querySelectorAll('.cm-lintRange-error, .cm-lint-marker-error').length))
    .toBeGreaterThan(0);

  const diagnosticTarget = page.locator('.cm-lintRange-error, .cm-lint-marker-error').first();
  await diagnosticTarget.hover();
  await expect(page.locator('.cm-tooltip-lint')).toContainText(/Недопустимый символ|JSON|Ожидается/);
  await expect.poll(() => tooltipText(page, '.cm-tooltip-hover')).not.toContain('Правило маршрутизации');

  await replaceRoutingText(page, VALID_ROUTING);
  await clearEditorTooltips(page);
  await expect(page.locator('#routing-error')).toHaveText('');
  await expect
    .poll(() => page.evaluate(() => document.querySelectorAll('.cm-lintRange-error, .cm-lint-marker-error').length))
    .toBe(0);

  await hoverRenderedToken(page, '"rules"');
  await expect(page.locator('.cm-tooltip-hover')).toContainText('Массив правил маршрутизации');
  await expect(page.locator('.cm-tooltip-hover')).toContainText('поля:');
  await expect(page.locator('.cm-tooltip-hover')).toContainText('outboundTag');

  await replaceRoutingText(page, COMPLETION_ROUTING);
  await waitForRoutingSchema(page);
  await moveRoutingCursor(page, { line: 2, ch: 4 });
  await page.keyboard.press('Control+Space');
  await expect(page.locator('.cm-tooltip-autocomplete')).toContainText('domainStrategy');
  await expect(page.locator('.cm-tooltip-autocomplete')).toContainText('rules');
});

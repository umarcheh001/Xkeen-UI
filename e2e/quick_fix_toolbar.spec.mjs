import { test, expect } from '@playwright/test';

const ROUTING_SCALAR_ARRAY = [
  '{',
  '  "routing": {',
  '    "balancers": [',
  '      {',
  '        "tag": "auto",',
  '        "selector": "proxy"',
  '      }',
  '    ]',
  '  }',
  '}',
  '',
].join('\n');

const MIHOMO_EMPTY_GROUP = [
  'proxy-groups:',
  '  - name: Auto',
  '    type: select',
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
    return !!(editor && typeof editor.setCursor === 'function' && typeof editor.getQuickFixes === 'function');
  });
}

async function ensureMonacoRouting(page) {
  const select = page.locator('#routing-editor-engine-select');
  await expect(select).toBeVisible();
  await select.selectOption('monaco');
  await page.waitForFunction(() => {
    const maybeEditor = window.XKeen?.features?.routingShell?.getEditorInstance?.({ preferRaw: true });
    const editor = maybeEditor && maybeEditor.raw ? maybeEditor.raw : maybeEditor;
    return !!(
      editor &&
      typeof editor.getModel === 'function' &&
      typeof editor.getQuickFixes === 'function' &&
      typeof editor.applyQuickFix === 'function'
    );
  });
}

async function replaceRoutingText(page, text) {
  await page.evaluate((nextText) => {
    window.XKeen.features.routing.replaceEditorText(nextText, {
      markDirty: false,
      reason: 'e2e-quick-fix',
      scrollTop: true,
    });
  }, text);
  await expect.poll(() => getRoutingText(page)).toBe(text);
}

async function getRoutingText(page) {
  return page.evaluate(() => {
    const maybeEditor = window.XKeen?.features?.routingShell?.getEditorInstance?.({ preferRaw: true });
    const editor = maybeEditor && maybeEditor.raw ? maybeEditor.raw : maybeEditor;
    return editor && typeof editor.getValue === 'function' ? editor.getValue() : '';
  });
}

async function getRoutingQuickFixTitles(page) {
  return page.evaluate(() => {
    const maybeEditor = window.XKeen?.features?.routingShell?.getEditorInstance?.({ preferRaw: true });
    const editor = maybeEditor && maybeEditor.raw ? maybeEditor.raw : maybeEditor;
    const fixes = editor && typeof editor.getQuickFixes === 'function'
      ? editor.getQuickFixes({ limit: 5 })
      : [];
    return Array.isArray(fixes) ? fixes.map((item) => String(item && item.title || '')) : [];
  });
}

async function moveRoutingCursorAfterText(page, needle) {
  await page.evaluate((target) => {
    const maybeEditor = window.XKeen?.features?.routingShell?.getEditorInstance?.({ preferRaw: true });
    const editor = maybeEditor && maybeEditor.raw ? maybeEditor.raw : maybeEditor;
    if (!editor) throw new Error('Routing editor is not ready');
    if (typeof editor.getModel === 'function') {
      const model = editor.getModel();
      const matches = model && typeof model.findMatches === 'function'
        ? model.findMatches(target, false, false, false, null, false)
        : [];
      const range = Array.isArray(matches) && matches.length ? matches[0].range : null;
      if (!range) throw new Error(`Text not found in Monaco routing editor: ${target}`);
      const position = { lineNumber: Number(range.endLineNumber || 1), column: Number(range.endColumn || 1) };
      if (typeof editor.setPosition === 'function') editor.setPosition(position);
      if (typeof editor.revealPositionInCenter === 'function') editor.revealPositionInCenter(position);
      editor.focus?.();
      return;
    }
    const value = editor && typeof editor.getValue === 'function' ? editor.getValue() : '';
    const index = value.indexOf(target);
    if (index < 0) throw new Error(`Text not found in routing editor: ${target}`);
    const before = value.slice(0, index + target.length).split('\n');
    editor.setCursor({ line: before.length - 1, ch: before[before.length - 1].length });
    editor.focus();
  }, needle);
}

async function openMihomo(page) {
  await page.locator('.top-tab-btn[data-view="mihomo"]').click();
  await expect(page.locator('#view-mihomo')).toBeVisible();
  await page.waitForFunction(() => {
    return !!(
      window.XKeen &&
      window.XKeen.features &&
      window.XKeen.features.mihomoPanel &&
      typeof window.XKeen.features.mihomoPanel.setEditorText === 'function' &&
      typeof window.XKeen.features.mihomoPanel.getEditorText === 'function'
    );
  });
}

async function ensureCodeMirrorMihomo(page) {
  await openMihomo(page);
  const select = page.locator('#mihomo-editor-engine-select');
  await expect(select).toBeVisible();
  await select.selectOption('codemirror');
  await page.waitForFunction(() => {
    return !!document.querySelector('#view-mihomo .cm-content');
  });
}

async function replaceMihomoText(page, text) {
  await page.evaluate((nextText) => {
    window.XKeen.features.mihomoPanel.setEditorText(nextText);
  }, text);
}

async function getMihomoText(page) {
  return page.evaluate(() => {
    return window.XKeen?.features?.mihomoPanel?.getEditorText?.() || '';
  });
}

async function moveMihomoCursorAfterText(page, needle) {
  await page.evaluate((target) => {
    const editor = window.XKeen?.state?.mihomoEditor || null;
    if (!editor || typeof editor.getValue !== 'function' || typeof editor.setCursor !== 'function') {
      throw new Error('Shared Mihomo CodeMirror editor is not ready');
    }
    const value = editor.getValue() || '';
    const index = value.indexOf(target);
    if (index < 0) throw new Error(`Text not found in Mihomo editor: ${target}`);
    const before = value.slice(0, index + target.length).split('\n');
    editor.setCursor({ line: before.length - 1, ch: before[before.length - 1].length });
    editor.focus();
  }, needle);
}

async function getMihomoQuickFixTitles(page) {
  return page.evaluate(() => {
    const editor = window.XKeen?.state?.mihomoEditor || null;
    const fixes = editor && typeof editor.getQuickFixes === 'function'
      ? editor.getQuickFixes({ limit: 5 })
      : [];
    return Array.isArray(fixes) ? fixes.map((item) => String(item && item.title || '')) : [];
  });
}

async function clickCodeMirrorToken(page, rootSelector, needle) {
  const box = await page.evaluate(({ root, token }) => {
    const scope = document.querySelector(root);
    const content = scope ? scope.querySelector('.cm-content') : null;
    if (!content) return null;
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
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
  }, { root: rootSelector, token: needle });
  expect(box, `token ${needle} should be rendered inside ${rootSelector}`).toBeTruthy();
  await page.mouse.click(box.x, box.y);
}

test('routing quick fix button shows an icon and applies fixes in CodeMirror and Monaco', async ({ page }) => {
  await page.goto('/');
  await waitForRoutingEditor(page);

  await ensureCodeMirrorRouting(page);
  await replaceRoutingText(page, ROUTING_SCALAR_ARRAY);
  await moveRoutingCursorAfterText(page, '"selector": "');
  await expect.poll(() => getRoutingQuickFixTitles(page)).toContain('Обернуть значение в массив');
  await expect(page.locator('#routing-toolbar-host button[data-action-id="quick_fix"] svg')).toBeVisible();
  await page.locator('#routing-toolbar-host button[data-action-id="quick_fix"]').click();
  await expect.poll(() => getRoutingText(page)).toContain('"selector": [');

  await ensureMonacoRouting(page);
  await replaceRoutingText(page, ROUTING_SCALAR_ARRAY);
  await moveRoutingCursorAfterText(page, '"selector": "');
  await expect.poll(() => getRoutingQuickFixTitles(page)).toContain('Обернуть значение в массив');
  await expect(page.locator('#routing-toolbar-host button[data-action-id="quick_fix"] svg')).toBeVisible();
  await page.locator('#routing-toolbar-host button[data-action-id="quick_fix"]').click();
  await expect.poll(() => getRoutingText(page)).toContain('"selector": [');
});

test('mihomo quick fix button shows an icon and fills the empty group', async ({ page }) => {
  await page.goto('/');
  await ensureCodeMirrorMihomo(page);

  await replaceMihomoText(page, MIHOMO_EMPTY_GROUP);
  await expect.poll(() => getMihomoText(page)).toContain('type: select');
  await moveMihomoCursorAfterText(page, 'type: select');
  await expect.poll(() => getMihomoQuickFixTitles(page)).toContain('Добавить `proxies: [DIRECT]`');
  await expect(page.locator('#mihomo-toolbar-host button[data-action-id="quick_fix"] svg')).toBeVisible();
  await page.locator('#mihomo-toolbar-host button[data-action-id="quick_fix"]').click();
  await expect.poll(() => getMihomoText(page)).toContain('proxies:');
  await expect.poll(() => getMihomoText(page)).toContain('DIRECT');
});

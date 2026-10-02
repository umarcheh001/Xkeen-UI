import { test, expect, selectPanelView } from './fixtures.mjs';


// The panel's own Monaco context menu pastes through the async Clipboard API. Over plain
// HTTP the browser refuses to hand the clipboard to a page, and the editor must
// then say so instead of inserting whatever was last copied inside the editor.

const HOST = '#routing-editor-monaco';


async function stubClipboard(page, mode) {
  await page.addInitScript((clipboardMode) => {
    const clipboard = {
      writeText: async () => {},
      readText: async () => {
        if (clipboardMode === 'denied') throw new DOMException('Read permission denied.', 'NotAllowedError');
        return 'from-notepad';
      },
    };
    Object.defineProperty(Navigator.prototype, 'clipboard', {
      configurable: true,
      get: () => clipboard,
    });
  }, mode);
}


async function openRoutingMonaco(page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    localStorage.setItem('xkeen.editor.engine', 'codemirror');
  });
  await page.goto('/');
  await selectPanelView(page, 'routing');
  const select = page.locator('#routing-editor-engine-select');
  await select.scrollIntoViewIfNeeded();
  await select.selectOption('monaco');
  await expect(page.locator(`${HOST} .monaco-editor`)).toBeVisible({ timeout: 15_000 });
}


async function setEditorText(page, text) {
  await page.locator(HOST).evaluate((editorHost, nextText) => {
    const editor = monaco.editor.getEditors().find((item) => editorHost.contains(item.getDomNode()));
    if (!editor) throw new Error('Monaco editor is missing');
    editor.getModel().setValue(nextText);
    editor.focus();
  }, text);
}


async function readEditorText(page) {
  return page.locator(HOST).evaluate((editorHost) => {
    const editor = monaco.editor.getEditors().find((item) => editorHost.contains(item.getDomNode()));
    return editor.getModel().getValue();
  });
}


async function selectAll(page) {
  await page.locator(HOST).evaluate((editorHost) => {
    const editor = monaco.editor.getEditors().find((item) => editorHost.contains(item.getDomNode()));
    editor.setSelection(editor.getModel().getFullModelRange());
    editor.focus();
  });
}


async function caretToEnd(page) {
  await page.locator(HOST).evaluate((editorHost) => {
    const editor = monaco.editor.getEditors().find((item) => editorHost.contains(item.getDomNode()));
    const model = editor.getModel();
    editor.setPosition(model.getPositionAt(model.getValue().length));
    editor.focus();
  });
}


// A right click moves the caret unless it lands on the selection, so the
// caller says where to click: inside the text or past its end.
async function chooseFromContextMenu(page, action, x) {
  await page.locator(`${HOST} .view-lines`).click({ button: 'right', position: { x, y: 8 } });
  const item = page.locator(`.xk-routing-monaco-menu button[data-action="${action}"]`);
  await expect(item).toBeVisible();
  await item.click();
}


test.describe('Monaco context menu paste', () => {
  test('does not insert the editor\'s own old copy when the clipboard cannot be read', async ({ page }) => {
    await stubClipboard(page, 'denied');
    await openRoutingMonaco(page);
    await setEditorText(page, 'alpha');

    await selectAll(page);
    await chooseFromContextMenu(page, 'copy', 20);

    await caretToEnd(page);
    await chooseFromContextMenu(page, 'paste', 300);

    await expect(page.locator('#toast-container .toast')).toContainText('Ctrl+V');
    expect(await readEditorText(page)).toBe('alpha');
  });

  test('inserts the system clipboard when the browser allows reading it', async ({ page }) => {
    await stubClipboard(page, 'allowed');
    await openRoutingMonaco(page);
    await setEditorText(page, 'alpha');

    await caretToEnd(page);
    await chooseFromContextMenu(page, 'paste', 300);

    await expect.poll(() => readEditorText(page)).toBe('alphafrom-notepad');
    await expect(page.locator('#toast-container .toast')).toHaveCount(0);
  });
});

import { test, expect, selectPanelView } from './fixtures.mjs';


// The link to a router drops for a few seconds whenever the proxy core
// restarts. A section whose bundle was being downloaded at that moment used to
// stay dead until the page was reloaded, and nothing told the user why.

const NOTICE = 'Не удалось загрузить часть панели';

function holdBundle(page, pattern, link) {
  return page.route(pattern, async (route) => {
    if (link.down) {
      link.refused += 1;
      await route.abort('connectionreset');
      return;
    }
    link.served += 1;
    if (link.delayMs) await new Promise((resolve) => { setTimeout(resolve, link.delayMs); });
    await route.fallback();
  });
}


test.describe('Panel sections after a dropped link', () => {
  test('the file manager comes back once its bundle can be downloaded', async ({ page }) => {
    test.setTimeout(90_000);
    const link = { down: true, refused: 0, served: 0 };
    await holdBundle(page, /\/file_manager\.lazy\.entry[^/]*\.js(\?|$)/, link);

    await page.goto('/');
    await selectPanelView(page, 'files');
    await expect(page.locator('#view-files')).toBeVisible();

    // The loader asks again on its own before it gives up and says so.
    await expect(page.locator('#toast-container')).toContainText(NOTICE, { timeout: 30_000 });
    expect(link.refused).toBeGreaterThan(1);
    await expect(page.locator('#view-files .fm-row')).toHaveCount(0);

    link.down = false;
    await selectPanelView(page, 'xkeen');
    await selectPanelView(page, 'files');

    await expect(page.locator('#view-files .fm-row').first()).toBeVisible({ timeout: 30_000 });
    expect(link.served).toBeGreaterThan(0);
  });

  test('the terminal opens on the next press once its bundle can be downloaded', async ({ page }) => {
    test.setTimeout(90_000);
    const link = { down: true, refused: 0, served: 0 };
    await holdBundle(page, /\/terminal\.lazy\.entry[^/]*\.js(\?|$)/, link);

    await page.goto('/');
    await selectPanelView(page, 'commands');
    const open = page.locator('#terminal-open-pty-btn:visible, #terminal-open-shell-btn:visible').first();
    await expect(open).toBeVisible();

    await open.click();
    await expect(page.locator('#toast-container')).toContainText(NOTICE, { timeout: 30_000 });
    await expect(page.locator('#terminal-overlay')).toBeHidden();
    await expect(open).toBeEnabled({ timeout: 20_000 });

    link.down = false;
    await open.click();

    await expect(page.locator('#terminal-overlay')).toBeVisible({ timeout: 30_000 });
    expect(link.served).toBeGreaterThan(0);
  });

  test('the notice retries on request and the open screen renders without another click', async ({ page }) => {
    test.setTimeout(90_000);
    const link = { down: true, refused: 0, served: 0, delayMs: 0 };
    await holdBundle(page, /\/file_manager\.lazy\.entry[^/]*\.js(\?|$)/, link);

    await page.goto('/');
    await selectPanelView(page, 'files');
    const notice = page.locator('#toast-container .toast-error');
    await expect(notice).toContainText(NOTICE, { timeout: 30_000 });
    await expect(notice.getByRole('button', { name: 'Обновить страницу' })).toBeVisible();

    // A retry the reader asked for goes out at once, without the automatic pauses.
    const refusedBefore = link.refused;
    await notice.getByRole('button', { name: 'Повторить' }).click();
    await expect(notice).toContainText('Повторить не удалось', { timeout: 10_000 });
    expect(link.refused).toBe(refusedBefore + 1);

    link.down = false;
    link.delayMs = 1500;
    await notice.getByRole('button', { name: 'Повторить' }).click();
    await expect(notice.getByRole('button', { name: 'Повторяю…' })).toBeDisabled();
    await expect(page.locator('#toast-container .toast-success')).toContainText('Часть панели загружена', { timeout: 30_000 });
    await expect(notice).toHaveCount(0);
    await expect(page.locator('#view-files .fm-row').first()).toBeVisible({ timeout: 30_000 });
  });

  test('reloading from the notice asks first when an editor holds unsaved changes', async ({ page }) => {
    test.setTimeout(90_000);
    await page.route(/\/file_manager\.lazy\.entry[^/]*\.js(\?|$)/, (route) => route.abort('connectionreset'));

    await page.goto('/');
    await selectPanelView(page, 'files');
    const notice = page.locator('#toast-container .toast-error');
    await expect(notice).toContainText(NOTICE, { timeout: 30_000 });

    await page.evaluate(() => {
      window.__beforeReload = true;
      window.XKeen.ui.configDirty.setDirty('routing', 'editor', true, { scopeLabel: 'Routing' });
    });
    await notice.getByRole('button', { name: 'Обновить страницу' }).click();
    const modal = page.locator('#confirm-modal');
    await expect(modal).not.toHaveClass(/hidden/);
    await expect(modal).toContainText('Остались несохранённые изменения: Routing');

    await page.locator('#confirm-modal-close-btn').click();
    await expect(modal).toHaveClass(/hidden/);
    expect(await page.evaluate(() => window.__beforeReload)).toBe(true);

    await notice.getByRole('button', { name: 'Обновить страницу' }).click();
    const reloaded = page.waitForEvent('load');
    await page.locator('#confirm-modal-ok-btn').click();
    await reloaded;
    expect(await page.evaluate(() => window.__beforeReload)).toBeUndefined();
  });

  test('reloading from the notice goes straight through when nothing is unsaved', async ({ page }) => {
    test.setTimeout(90_000);
    await page.route(/\/file_manager\.lazy\.entry[^/]*\.js(\?|$)/, (route) => route.abort('connectionreset'));

    await page.goto('/');
    await selectPanelView(page, 'files');
    const notice = page.locator('#toast-container .toast-error');
    await expect(notice).toContainText(NOTICE, { timeout: 30_000 });

    await page.evaluate(() => { window.__beforeReload = true; });
    const reloaded = page.waitForEvent('load');
    await notice.getByRole('button', { name: 'Обновить страницу' }).click();
    await reloaded;
    expect(await page.evaluate(() => window.__beforeReload)).toBeUndefined();
  });

  test('a feature whose file failed offers only a reload', async ({ page }) => {
    test.setTimeout(90_000);
    // The browser keeps a failed feature file failed, so asking again is pointless.
    await page.route(/\/donate[^/]*\.js(\?|$)/, (route) => route.abort('connectionreset'));

    await page.goto('/');
    await expect(page.locator('#top-tab-donate')).toHaveCount(1);
    await page.evaluate(() => document.getElementById('top-tab-donate').click());
    const notice = page.locator('#toast-container .toast-error');
    await expect(notice).toContainText('Обновите страницу, чтобы загрузить её заново', { timeout: 30_000 });
    await expect(notice.getByRole('button', { name: 'Обновить страницу' })).toBeVisible();
    await expect(notice.getByRole('button', { name: 'Повторить' })).toHaveCount(0);
  });

  test('a missing diagnostics module file shows the notice and offers only a reload', async ({ page }) => {
    test.setTimeout(90_000);
    // The window is built apart and reached through the importmap; its file answers 404.
    await page.route(/\/frontend-build\/modules\/tool\.advanced-diagnostics\/[^/]+\.js(\?|$)/, (route) => route.fulfill({
      status: 404,
      contentType: 'text/plain',
      body: 'not found',
    }));

    await page.goto('/');
    const notice = page.locator('#toast-container .toast-error');
    await expect(notice).toContainText(NOTICE, { timeout: 30_000 });
    // The browser keeps a failed module file failed, so asking again is pointless.
    await expect(notice.getByRole('button', { name: 'Обновить страницу' })).toBeVisible();
    await expect(notice.getByRole('button', { name: 'Повторить' })).toHaveCount(0);
    await expect(page.locator('#xk-resource-dashboard-modal')).toBeHidden();
  });

  test('unsaved text in the file manager editor counts as an unsaved change', async ({ page }) => {
    test.setTimeout(90_000);
    await page.route('**/api/fs/list?**', async (route) => {
      const path = new URL(route.request().url()).searchParams.get('path') || '';
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          path,
          roots: [],
          items: [{ name: 'notes.txt', type: 'file', size: 6, perm: '-rw-r--r--', mtime: 1785312060 }],
          space: { free: 1024 * 1024 * 1024, total: 2 * 1024 * 1024 * 1024 },
        }),
      });
    });
    await page.route('**/api/fs/read?**', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, text: 'hello\n', truncated: false }),
    }));

    await page.goto('/');
    await selectPanelView(page, 'files');
    await page.locator('.fm-panel[data-side="left"] .fm-row[data-name="notes.txt"]').dblclick();
    const editor = page.locator('#fm-editor-modal');
    await expect(editor).toBeVisible({ timeout: 30_000 });
    const isDirty = () => page.evaluate(() => window.XKeen.ui.configDirty.isDirty('file-manager'));
    expect(await isDirty()).toBe(false);

    await editor.getByText('hello', { exact: true }).click();
    await page.keyboard.type('more');
    await expect.poll(isDirty).toBe(true);
    const scope = await page.evaluate(() => window.XKeen.ui.configDirty.getState('file-manager'));
    expect(scope.label).toBe('Файловый менеджер');
  });
});

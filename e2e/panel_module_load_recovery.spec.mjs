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
});

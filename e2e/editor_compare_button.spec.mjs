import { test, expect, selectPanelView } from './fixtures.mjs';


// The diff viewer is loaded when Compare is first pressed. The screens used to
// register their diff scope only while starting, before the viewer existed,
// so the very button that loads the viewer then opened nothing.

function compareButton(root) {
  return root.locator('button[aria-label*="Сравнить"], button[title*="Сравнить"], button[data-tooltip*="Сравнить"]').first();
}

async function closeDiff(page) {
  await page.evaluate(() => {
    try { window.XKeen?.ui?.diffModal?.close?.('e2e'); } catch (error) {}
  });
  await expect(page.locator('#xkeen-diff-modal')).toBeHidden();
}


test.describe('Editor Compare button', () => {
  test('opens the diff viewer on its first press in the routing editor', async ({ page }) => {
    await page.goto('/');
    await selectPanelView(page, 'routing');
    const routing = page.locator('#view-routing');
    await expect(routing.locator('.cm-editor').first()).toBeVisible();
    expect(await page.evaluate(() => !!window.XKeen?.ui?.diff)).toBe(false);

    await compareButton(routing).click();

    await expect(page.locator('#xkeen-diff-modal')).toBeVisible({ timeout: 20_000 });
    await closeDiff(page);
  });

  test('opens the diff viewer on its first press in the Mihomo editor', async ({ page }) => {
    await page.goto('/');
    await selectPanelView(page, 'mihomo');
    await page.locator('[data-mihomo-clash-subview="config"]').click();
    const mihomo = page.locator('#view-mihomo');
    await expect(mihomo.locator('.cm-editor').first()).toBeVisible();
    expect(await page.evaluate(() => !!window.XKeen?.ui?.diff)).toBe(false);

    await compareButton(mihomo).click();

    await expect(page.locator('#xkeen-diff-modal')).toBeVisible({ timeout: 20_000 });
    await closeDiff(page);
  });

  test('opens the diff viewer on its first press in the JSON editor dialog', async ({ page }) => {
    await page.goto('/');
    await selectPanelView(page, 'routing');
    await page.locator('#inbounds-header').click();
    await page.locator('#inbounds-open-editor-btn').click();
    const dialog = page.locator('#json-editor-modal');
    await expect(dialog.locator('.cm-editor').first()).toBeVisible();
    expect(await page.evaluate(() => !!window.XKeen?.ui?.diff)).toBe(false);

    await compareButton(dialog).click();

    await expect(page.locator('#xkeen-diff-modal')).toBeVisible({ timeout: 20_000 });
    await closeDiff(page);
  });
});

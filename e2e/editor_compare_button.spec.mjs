import { test, expect, selectPanelView, openMihomoConfig } from './fixtures.mjs';


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
    await openMihomoConfig(page);
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
  test('opens the diff viewer on its first press in the routing editor under Monaco', async ({ page }) => {
    // The Monaco toolbar has its own Compare button; it used to ask for the
    // viewer without loading it, so in Monaco the button did nothing at all.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript(() => {
      localStorage.setItem('xkeen.editor.engine', 'codemirror');
    });
    await page.goto('/');
    await selectPanelView(page, 'routing');
    const select = page.locator('#routing-editor-engine-select');
    await select.scrollIntoViewIfNeeded();
    await select.selectOption('monaco');
    await expect(page.locator('#routing-editor-monaco .monaco-editor')).toBeVisible({ timeout: 15_000 });
    expect(await page.evaluate(() => !!window.XKeen?.ui?.diff)).toBe(false);

    await page.locator('.xk-routing-monaco-toolbar button[data-action-id="compare"]').click();

    await expect(page.locator('#xkeen-diff-modal')).toBeVisible({ timeout: 20_000 });
    await closeDiff(page);
  });
});


test.describe('Routing editor menu', () => {
  test('closes on a click outside and on Escape', async ({ page }) => {
    await page.goto('/');
    await selectPanelView(page, 'routing');
    const routing = page.locator('#view-routing');
    await expect(routing.locator('.cm-editor').first()).toBeVisible();
    const menu = page.locator('details.xk-routing-menu');
    const trigger = menu.locator('summary');
    const panel = menu.locator('.xk-routing-menu-panel');

    await trigger.click();
    await expect(panel).toBeVisible();
    // A click inside the menu, past its buttons, keeps it open.
    await panel.locator('.terminal-menu-title').first().click();
    await expect(panel).toBeVisible();

    // Меню выпадает над правой частью редактора: щёлкаем в его левую часть.
    await routing.locator('.cm-editor').first().click({ position: { x: 60, y: 200 } });
    await expect(menu).not.toHaveAttribute('open', /.*/);

    await trigger.click();
    await expect(panel).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).not.toHaveAttribute('open', /.*/);
  });
});

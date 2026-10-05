import { test, expect } from './fixtures.mjs';


// То же, что top_level_back_before_bundle.spec.mjs проверяет для DevTools,
// для остальных экранов вне панели: копий, генератора Mihomo и XKeen. Экран
// показывает разметку сразу, скрипты догружаются следом. Возврат в панель
// обязан сработать с первого нажатия и не ждать скриптов экрана, с которого
// уходят, а прерванный заход не должен оставлять экран наполовину запущенным.

const HOLD_MS = 4000;

// Генератор открывается из панели на месте, без загрузки страницы.
const GENERATOR = {
  name: 'mihomo_generator',
  path: '/mihomo_generator',
  bodyClass: /mihomo-generator-page/,
  back: 'a.xk-header-btn-ui[data-xk-top-nav="1"]',
  scripts: /\/static\/js\/(?:pages\/mihomo_generator\.screen\.bootstrap|features\/mihomo_generator)\.js/,
  ready: '#mihomo-preview-engine-select',
};

// Копии и XKeen открываются отдельной загрузкой страницы: ссылок «на месте»
// на них в панели нет.
const DIRECT = [
  {
    name: 'backups',
    path: '/backups',
    back: 'a.xk-header-btn-ui[data-xk-top-nav="1"]',
    scripts: /\/static\/js\/(?:pages\/backups\.(?:init|screen\.bootstrap)|features\/backups)\.js/,
  },
  {
    name: 'xkeen',
    path: '/xkeen',
    back: 'a.btn-link[data-xk-top-nav="1"][href="/"]',
    scripts: /\/static\/js\/(?:pages\/xkeen\.(?:init|screen\.bootstrap)|features\/xkeen_texts)\.js/,
  },
];


async function holdScripts(page, pattern) {
  let release;
  let held = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  await page.route(pattern, async (route) => {
    held += 1;
    await Promise.race([gate, new Promise((resolve) => setTimeout(resolve, HOLD_MS))]);
    await route.continue();
  });
  return { release, heldCount: () => held };
}


async function openPanelReadyFor(page, screen) {
  await page.goto('/');
  await expect.poll(() => page.evaluate((name) => !!(
    window.XKeen && window.XKeen.topLevel && window.XKeen.topLevel.router
    && window.XKeen.topLevel.router.hasScreen(name)
  ), screen.name)).toBe(true);
  await page.evaluate(() => { window.__sameDocument = true; });
}


async function enter(page, screen) {
  const accepted = await page.evaluate((path) => window.XKeen.topLevel.router.navigate(path), screen.path);
  expect(accepted, 'the panel must open the screen in place').toBe(true);
  const back = page.locator(screen.back).first();
  await expect(back).toBeVisible();
  return back;
}


test.describe('leaving the Mihomo generator early', () => {
  const screen = GENERATOR;

  test('Back works at once while the scripts of the screen are still loading', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    const hold = await holdScripts(page, screen.scripts);
    await openPanelReadyFor(page, screen);

    const back = await enter(page, screen);
    expect(hold.heldCount(), 'the scripts of the screen must be the ones held back').toBeGreaterThan(0);
    expect(await back.getAttribute('data-xk-top-nav-wired'), 'Back must be wired before the scripts arrive').toBe('1');

    const pressedAt = Date.now();
    await back.click();
    await expect(page.locator('body')).toHaveClass(/panel-page/, { timeout: HOLD_MS - 1500 });
    expect(Date.now() - pressedAt, 'leaving must not wait for the scripts of the screen being left').toBeLessThan(HOLD_MS - 1000);
    await expect(page).toHaveURL(/\/$/);
    expect(await page.evaluate(() => window.__sameDocument === true), 'the panel must not be reloaded from scratch').toBe(true);

    hold.release();
    // The interrupted visit must not leave the screen half-started for the next one.
    const again = await enter(page, screen);
    await expect(page.locator('body')).toHaveClass(screen.bodyClass);
    await expect(page.locator(screen.ready)).toBeVisible();
    await page.waitForLoadState('networkidle');
    await again.click();
    await expect(page.locator('body')).toHaveClass(/panel-page/);
    expect(await page.evaluate(() => window.__sameDocument === true)).toBe(true);
    expect(pageErrors).toEqual([]);
  });

  test('one press on Back is enough: no extra history entries pile up', async ({ page }) => {
    const hold = await holdScripts(page, screen.scripts);
    await openPanelReadyFor(page, screen);
    const before = await page.evaluate(() => history.length);

    const back = await enter(page, screen);
    await back.click();
    await expect(page.locator('body')).toHaveClass(/panel-page/, { timeout: HOLD_MS - 1500 });
    hold.release();

    // panel -> screen -> panel: two entries, however slow the scripts were.
    expect(await page.evaluate(() => history.length)).toBe(before + 2);
  });
});


for (const screen of DIRECT) {
  test(`${screen.name}: Back works with the first press while the page scripts are still loading`, async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    const hold = await holdScripts(page, screen.scripts);

    // The markup arrives at once; the load event would wait for the held scripts.
    await page.goto(screen.path, { waitUntil: 'commit' });
    const back = page.locator(screen.back).first();
    await expect(back).toBeVisible();
    await expect.poll(() => hold.heldCount(), 'the scripts of the page must be the ones held back').toBeGreaterThan(0);

    const pressedAt = Date.now();
    await back.click();
    // In place or by an ordinary page load - either way one press opens the panel.
    await expect(page).toHaveURL(/\/$/, { timeout: HOLD_MS - 1500 });
    await expect(page.locator('body')).toHaveClass(/panel-page/, { timeout: HOLD_MS - 1500 });
    expect(Date.now() - pressedAt, 'leaving must not wait for the scripts of the page being left').toBeLessThan(HOLD_MS - 1000);
    hold.release();

    await expect(page.locator('.panel-header-shell')).toBeAttached();
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(/\/$/);
    expect(pageErrors).toEqual([]);
  });
}

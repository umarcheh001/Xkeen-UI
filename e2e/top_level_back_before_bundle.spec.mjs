import { test, expect } from './fixtures.mjs';


// Экран DevTools (как и копии, генератор, XKeen) показывает свою разметку
// сразу, а его скрипты догружаются следом — на роутере это секунды: десятки
// отдельных файлов с сервера в один поток. Раньше «← Назад» в это время не
// работала с первого раза по двум причинам. Ссылка становилась «своей» только
// в конце загрузки скриптов, а до того была обычной и перезагружала панель
// целиком. И даже подключённая, она ждала в очереди переходов, пока экран,
// с которого уходят, дозагрузит скрипты, которые уже не нужны.

const HOLD_MS = 4000;
// Whatever part of the DevTools screen the browser asks for first is held back.
const DEVTOOLS_SCRIPTS = /\/static\/js\/(?:pages\/devtools\.(?:init|screen\.bootstrap)|features\/devtools)\.js/;


async function holdScripts(page, pattern) {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await page.route(pattern, async (route) => {
    await Promise.race([gate, new Promise((resolve) => setTimeout(resolve, HOLD_MS))]);
    await route.continue();
  });
  return release;
}


async function openPanelReadyForInPlaceNavigation(page) {
  await page.goto('/');
  // The panel has taken over its links and knows the DevTools screen:
  // from here on DevTools opens in place, without a page load.
  await expect(page.locator('a.xk-header-btn-devtools[data-xk-top-nav-wired="1"]')).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => !!(
    window.XKeen && window.XKeen.topLevel && window.XKeen.topLevel.router
    && window.XKeen.topLevel.router.hasScreen('devtools')
  ))).toBe(true);
  await page.evaluate(() => { window.__sameDocument = true; });
}


async function enterDevtools(page) {
  await page.evaluate(() => document.querySelector('a.xk-header-btn-devtools').click());
  const back = page.locator('.dt-header-btn-back');
  await expect(back).toBeVisible();
  return back;
}


// The tabs answer only once the DevTools scripts have started; press until they do.
async function switchToLogsTab(page) {
  const tab = page.locator('#dt-tab-btn-logs');
  await expect(async () => {
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true', { timeout: 500 });
  }).toPass({ timeout: 20000 });
}


test('Back in DevTools works at once while the DevTools scripts are still loading', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  const release = await holdScripts(page, DEVTOOLS_SCRIPTS);
  await openPanelReadyForInPlaceNavigation(page);

  const back = await enterDevtools(page);
  // The markup is on screen, the scripts are not there yet - and the link is already ours.
  expect(await back.getAttribute('data-xk-top-nav-wired'), 'Back must be wired before the DevTools scripts arrive').toBe('1');

  const pressedAt = Date.now();
  await back.click();
  await expect(back).toBeHidden({ timeout: HOLD_MS - 1500 });
  await expect(page.locator('body')).toHaveClass(/panel-page/);
  expect(Date.now() - pressedAt, 'leaving must not wait for the scripts of the screen being left').toBeLessThan(HOLD_MS - 1000);
  await expect(page).toHaveURL(/\/$/);
  expect(await page.evaluate(() => window.__sameDocument === true), 'the panel must not be reloaded from scratch').toBe(true);

  release();
  // The interrupted visit must not leave DevTools half-started for the next one.
  const again = await enterDevtools(page);
  await switchToLogsTab(page);
  await again.click();
  await expect(again).toBeHidden();
  await expect(page.locator('body')).toHaveClass(/panel-page/);
  expect(await page.evaluate(() => window.__sameDocument === true)).toBe(true);
  expect(pageErrors).toEqual([]);
});


test('one press on Back is enough: no extra history entries pile up', async ({ page }) => {
  const release = await holdScripts(page, DEVTOOLS_SCRIPTS);
  await openPanelReadyForInPlaceNavigation(page);
  const before = await page.evaluate(() => history.length);

  const back = await enterDevtools(page);
  await back.click();
  await expect(back).toBeHidden({ timeout: HOLD_MS - 1500 });
  release();

  // panel -> devtools -> panel: two entries, however slow the scripts were.
  expect(await page.evaluate(() => history.length)).toBe(before + 2);
});


test('DevTools still starts normally when nobody leaves early', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  await openPanelReadyForInPlaceNavigation(page);

  const back = await enterDevtools(page);
  await switchToLogsTab(page);
  await expect(page.locator('#dt-tab-logs')).toBeVisible();
  await back.click();

  await expect(back).toBeHidden();
  await expect(page.locator('body')).toHaveClass(/panel-page/);
  expect(pageErrors).toEqual([]);
});

import { test, expect } from './fixtures.mjs';

// Адрес загрузки, папка и имя DAT-файла — то, что оператор вписал сам. Карточка
// при раскрытии сходит на роутер за списком файлов, и на это уходят секунды.
// Всё, что оператор успел набрать за это время, она потом заменяла тем, что
// прочитала до его правки: поле возвращалось к прежнему значению, а в памяти
// браузера оставалось старое.

const PREF_KEY = 'xk.routing.dat.prefs.v1';
const LIST_DELAY_MS = 2500;
const SAVED = {
  geosite: { dir: '/opt/etc/xray/dat', name: 'geosite_v2fly.dat', url: 'https://example.invalid/old-geosite.dat' },
  geoip: { dir: '/opt/etc/xray/dat', name: 'geoip_v2fly.dat', url: 'https://example.invalid/old-geoip.dat' },
};

async function openDatCardWithSlowRouter(page) {
  await page.addInitScript(([key, saved]) => {
    try {
      if (!window.sessionStorage.getItem('xk-test-seeded')) {
        window.localStorage.setItem(key, JSON.stringify(saved));
        window.localStorage.removeItem('xk.routing.dat.open.v3');
        window.sessionStorage.setItem('xk-test-seeded', '1');
      }
    } catch (error) {}
  }, [PREF_KEY, SAVED]);
  await page.goto('/');
  await expect(page.locator('#routing-dat-header')).toBeVisible();
  await page.waitForLoadState('networkidle');
  await page.route(/\/api\/routing\/dat\/(files|stat)/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, LIST_DELAY_MS));
    await route.continue();
  });
  const body = page.locator('#routing-dat-body');
  for (let attempt = 0; attempt < 3 && !(await body.isVisible()); attempt += 1) {
    await page.locator('#routing-dat-header').click();
    await page.waitForTimeout(250);
  }
  await expect(body).toBeVisible();
}

async function storedPrefs(page) {
  return page.evaluate((key) => JSON.parse(window.localStorage.getItem(key) || '{}'), PREF_KEY);
}

test.describe('DAT card keeps what the operator typed', () => {
  test('an address typed while the card is reading the router is not thrown away', async ({ page }) => {
    await openDatCardWithSlowRouter(page);
    const url = page.locator('#routing-dat-geosite-url');

    await url.fill('https://example.invalid/my-own-geosite.dat');
    await page.waitForTimeout(LIST_DELAY_MS * 2 + 1500);

    await expect(url).toHaveValue('https://example.invalid/my-own-geosite.dat');
    expect((await storedPrefs(page)).geosite.url).toBe('https://example.invalid/my-own-geosite.dat');
  });

  test('a file name typed while the card is reading the router is not put back', async ({ page }) => {
    await openDatCardWithSlowRouter(page);
    const name = page.locator('#routing-dat-geosite-name');

    await name.fill('geosite_mine.dat');
    await page.waitForTimeout(LIST_DELAY_MS * 3 + 2500);

    await expect(name).toHaveValue('geosite_mine.dat');
    expect((await storedPrefs(page)).geosite.name).toBe('geosite_mine.dat');
  });

  test('the typed values are still there after the page is opened again', async ({ page }) => {
    await openDatCardWithSlowRouter(page);

    await page.locator('#routing-dat-geoip-url').fill('https://example.invalid/my-own-geoip.dat');
    await page.locator('#routing-dat-geoip-dir').fill('/opt/etc/xray/mydat');
    await page.waitForTimeout(LIST_DELAY_MS * 3 + 2500);
    await page.unroute(/\/api\/routing\/dat\/(files|stat)/);
    await page.reload();
    await page.waitForLoadState('networkidle');

    const stored = await storedPrefs(page);
    expect(stored.geoip.url).toBe('https://example.invalid/my-own-geoip.dat');
    expect(stored.geoip.dir).toBe('/opt/etc/xray/mydat');
  });
});

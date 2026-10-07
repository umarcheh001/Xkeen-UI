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

async function routerPrefs(page) {
  return page.evaluate(async () => {
    const response = await fetch('/api/ui-settings', { headers: { Accept: 'application/json' } });
    const data = await response.json();
    return (data.settings.routing && data.settings.routing.dat) || {};
  });
}

test.describe('DAT card keeps its values on the router', () => {
  test('what the operator typed is there in a browser that has never seen the panel', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const body = page.locator('#routing-dat-body');
    for (let attempt = 0; attempt < 3 && !(await body.isVisible()); attempt += 1) {
      await page.locator('#routing-dat-header').click();
      await page.waitForTimeout(250);
    }
    await page.locator('#routing-dat-geosite-url').fill('https://example.invalid/kept-on-router.dat');
    await page.locator('#routing-dat-geosite-dir').fill('/opt/etc/xray/mydat');
    await expect.poll(async () => (await routerPrefs(page)).geosite?.url).toBe('https://example.invalid/kept-on-router.dat');

    // Другой браузер: своей памяти о панели у него нет.
    await page.evaluate((key) => window.localStorage.removeItem(key), PREF_KEY);
    await page.reload();
    await page.waitForLoadState('networkidle');

    await expect(page.locator('#routing-dat-geosite-url')).toHaveValue('https://example.invalid/kept-on-router.dat');
    await expect(page.locator('#routing-dat-geosite-dir')).toHaveValue('/opt/etc/xray/mydat');
  });

  test('values kept by the browser alone are handed over to the router', async ({ page }) => {
    await page.addInitScript(([key, saved]) => {
      try { window.localStorage.setItem(key, JSON.stringify(saved)); } catch (error) {}
    }, [PREF_KEY, SAVED]);

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await expect.poll(async () => (await routerPrefs(page)).geoip?.url).toBe(SAVED.geoip.url);
    expect((await routerPrefs(page)).geosite.name).toBe(SAVED.geosite.name);
  });

  test('a shipped value is not stored as the operators choice', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const body = page.locator('#routing-dat-body');
    for (let attempt = 0; attempt < 3 && !(await body.isVisible()); attempt += 1) {
      await page.locator('#routing-dat-header').click();
      await page.waitForTimeout(250);
    }
    await page.locator('#routing-dat-geoip-name').fill('geoip_mine.dat');
    await expect.poll(async () => (await routerPrefs(page)).geoip?.name).toBe('geoip_mine.dat');

    // Адрес оператор не трогал: на роутере он остаётся «не задан».
    expect((await routerPrefs(page)).geoip.url || '').toBe('');
  });
});

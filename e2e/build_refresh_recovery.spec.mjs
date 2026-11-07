import { test, expect } from './fixtures.mjs';

test('stalled DevTools reads leave loading state with an error', async ({ page }) => {
  await page.clock.install();
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    const stalled = new Set(['/api/devtools/ui/status', '/api/devtools/env', '/api/modules/installed']);
    window.fetch = (input, options = {}) => {
      const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
      if (!stalled.has(path)) return originalFetch(input, options);
      return new Promise((resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    };
  });

  await page.goto('/devtools');
  await expect(page.locator('#dt-ui-status')).toContainText('Загрузка');
  await page.clock.fastForward(12_500);
  await expect(page.locator('#dt-ui-status')).toContainText('Ошибка');
  await expect(page.locator('#dt-panel-status')).toContainText('Не удалось загрузить сведения о панели');
  await expect(page.locator('#dt-env-tbody')).toContainText('Ошибка');
});

test('a stalled status response body does not leave the panel checking forever', async ({ page }) => {
  await page.clock.install();
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    window.__xkStatusReads = 0;
    window.__xkStatusAborted = 0;
    window.fetch = (input, options = {}) => {
      const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
      if (path !== '/api/xkeen/status') return originalFetch(input, options);
      window.__xkStatusReads += 1;
      const stalledBody = () => new Promise((resolve, reject) => {
        options.signal?.addEventListener('abort', () => {
          window.__xkStatusAborted += 1;
          reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      });
      return Promise.resolve({ ok: true, status: 200, json: stalledBody, text: stalledBody });
    };
  });

  await page.goto('/');
  await page.waitForFunction(() => window.__xkStatusReads >= 1);
  await page.clock.fastForward(3_000);
  await page.waitForFunction(() => window.__xkStatusAborted >= 1);
  await expect(page.locator('#xkeen-service-text')).toHaveText('Ошибка статуса');
});

test('interrupted cache refresh retries without overloading the panel', async ({ page }) => {
  await page.goto('/devtools');
  const keys = Array.from({ length: 12 }, (_, index) => `/static/cache-probe-${index}.js`);
  await page.evaluate((seen) => {
    localStorage.setItem('xkeen-ui-build-stamp', 'previous-build');
    localStorage.setItem('xkeen-ui-static-seen-v1', JSON.stringify(seen));
    window.cacheProbe = { active: 0, maximum: 0, fail: true, modes: [] };
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, options = {}) => {
      const url = String(input);
      if (!url.startsWith('/static/cache-probe-')) return originalFetch(input, options);
      const state = window.cacheProbe;
      state.active += 1;
      state.maximum = Math.max(state.maximum, state.active);
      state.modes.push(options.cache);
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 30);
          options.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new DOMException('Aborted', 'AbortError'));
          }, { once: true });
        });
        if (state.fail && url.endsWith('cache-probe-0.js')) throw new Error('Connection lost');
        return new Response('ok', { status: 200 });
      } finally {
        state.active -= 1;
      }
    };
  }, keys);

  async function inject(stamp) {
    await page.evaluate((nextStamp) => {
      const script = document.createElement('script');
      script.src = `/static/js/ui/build_refresh.js?recovery-test=${nextStamp}`;
      script.dataset.buildStamp = nextStamp;
      script.dataset.staticBase = '/static/';
      document.head.append(script);
    }, stamp);
    await page.waitForFunction((nextStamp) => window.XKeen?.buildRefresh?.stamp === nextStamp, stamp);
  }

  await inject('recovered-build');
  await page.evaluate(() => window.XKeen.buildRefresh.done);
  const failed = await page.evaluate(() => ({
    stamp: localStorage.getItem('xkeen-ui-build-stamp'),
    maximum: window.cacheProbe.maximum,
    modes: window.cacheProbe.modes,
  }));
  expect(failed.stamp).toBe('previous-build');
  expect(failed.maximum).toBeLessThanOrEqual(4);
  expect(failed.modes).toContain('no-cache');

  await page.evaluate(() => { window.cacheProbe.fail = false; });
  const reloaded = page.waitForEvent('load');
  await inject('recovered-build');
  await reloaded;
  expect(await page.evaluate(() => localStorage.getItem('xkeen-ui-build-stamp'))).toBe('recovered-build');
});

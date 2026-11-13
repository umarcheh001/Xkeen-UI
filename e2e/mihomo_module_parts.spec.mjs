import { test, expect, selectPanelView } from './fixtures.mjs';

test('Mihomo module retries CSS failure and shares loaded parts with the core', async ({ page }) => {
  let requests = 0;
  await page.route(/\/mihomo\.module[^/?]*\.css(?:\?.*)?$/, async route => {
    requests += 1;
    if (requests === 1) await route.abort();
    else await route.continue();
  });
  await page.goto('/');
  const failed = await page.evaluate(async () => {
    const entry = await import('xk-module/engine.mihomo');
    try { await entry.load('clash'); return ''; }
    catch (error) { return error.message; }
  });
  expect(failed).toContain('failed to load module stylesheet');
  await expect(page.locator('link[data-xk-module-css="engine.mihomo"]')).toHaveCount(0);
  const result = await page.evaluate(async () => {
    const entry = await import('xk-module/engine.mihomo');
    const core = await import('xk-core/js/features/module_parts.js');
    const first = entry.load('clash'), second = entry.load('clash');
    const mod = await first;
    await second;
    return {samePromise:first === second, samePart:core.loadedModulePart('engine.mihomo','clash') === mod};
  });
  expect(result).toEqual({samePromise:true,samePart:true});
  expect(requests).toBe(2);
  await expect(page.locator('link[data-xk-module-css="engine.mihomo"]')).toHaveCount(1);
});

test('direct generator entry loads its own CSS without visiting the panel', async ({ page }) => {
  await page.goto('/mihomo_generator');
  const link = page.locator('link[data-xk-module-css="engine.mihomo"]');
  await expect(link).toHaveCount(1);
  await expect.poll(() => link.evaluate(node => !!node.sheet)).toBe(true);
  const ready = await page.evaluate(async () => {
    const entry = await import('xk-module/engine.mihomo');
    const mod = await entry.load('generator');
    return typeof mod.getMihomoGeneratorTopLevelApi()?.init;
  });
  expect(ready).toBe('function');
});

test('source entry loads CSS and shares the raw core instance without Vite', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(() => new Promise(resolve => {
    const receive = event => {
      if (event.data?.tag !== 'mihomo-source-probe') return;
      window.removeEventListener('message', receive);
      resolve(event.data);
    };
    window.addEventListener('message', receive);
    const frame = document.createElement('iframe');
    const imports = {
      'xk-core/': `${location.origin}/static/`,
      'xk-module/engine.mihomo': `${location.origin}/static/js/pages/mihomo.module.entry.js`,
    };
    frame.srcdoc = `<script type="importmap">${JSON.stringify({imports})}</script>
      <script type="module">
        try {
          const entry = await import('xk-module/engine.mihomo');
          const core = await import('xk-core/js/features/module_parts.js');
          const mod = await entry.load('clash');
          const link = document.querySelector('link[data-xk-module-css="engine.mihomo"]');
          parent.postMessage({tag:'mihomo-source-probe',same:core.loadedModulePart('engine.mihomo','clash')===mod,css:!!link?.sheet}, '*');
        } catch(error) {parent.postMessage({tag:'mihomo-source-probe',error:error.message}, '*');}
      </script>`;
    document.body.appendChild(frame);
  }));
  expect(result).toEqual({tag:'mihomo-source-probe',same:true,css:true});
});

test('generator recovers a stylesheet which failed before its JavaScript started', async ({ page }) => {
  let failed = false;
  await page.route(/\/mihomo_generator(?:-bridge|\.entry)\.js(?:\?.*)?$/, async route => {
    await new Promise(resolve => setTimeout(resolve, 500));
    await route.continue();
  });
  await page.route(/\/static\/mihomo\.module\.css(?:\?.*)?$/, async route => {
    if (!failed) { failed = true; await route.abort(); }
    else await route.continue();
  });
  await page.goto('/mihomo_generator');
  await expect(page.locator('.cm-editor')).toBeVisible();
  await expect.poll(() => page.locator('link[data-xk-module-css="engine.mihomo"]').evaluate(node => !!node.sheet)).toBe(true);
  expect(failed).toBe(true);
});

test('panel can retry a failed Mihomo stylesheet instead of caching an initialization failure', async ({ page }) => {
  let blocked = true;
  await page.route(/\/mihomo\.module[^/?]*\.css(?:\?.*)?$/, route => blocked ? route.abort() : route.continue());
  await page.goto('/');
  const first = await page.evaluate(async () => {
    const loader = await import('/static/js/pages/panel.module_loader.js');
    return (await loader.ensurePanelModule('panel-mihomo')).status;
  });
  expect(first).toBe('failed');
  blocked = false;
  const second = await page.evaluate(async () => {
    const loader = await import('/static/js/pages/panel.module_loader.js');
    return (await loader.ensurePanelModule('panel-mihomo')).status;
  });
  expect(second).toBe('ready');
});

test('panel to generator navigation keeps one loaded stylesheet after the screen styles', async ({ page }) => {
  await page.goto('/');
  await selectPanelView(page, 'mihomo');
  await expect.poll(() => page.evaluate(() => !!window.XKeen?.topLevel?.router?.hasScreen('mihomo_generator'))).toBe(true);
  await page.evaluate(() => window.XKeen.topLevel.router.navigate('/mihomo_generator'));
  await expect(page.locator('body')).toHaveClass(/mihomo-generator-page/);
  await expect(page.locator('.cm-editor')).toBeVisible();
  await expect(page.locator('link[data-xk-module-css="engine.mihomo"]')).toHaveCount(1);
});

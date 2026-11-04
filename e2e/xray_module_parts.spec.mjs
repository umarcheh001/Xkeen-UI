import { test, expect } from './fixtures.mjs';

// The core reaches the Xray files only through features/module_parts.js: the
// restart journal, the JSON editor and the routing templates button ask the
// Xray module for a part by name. Each of them must work on a fresh page that
// starts away from the Xray screen.

const PREFLIGHT_REF = 'module-parts-preflight-1';

async function openPanelAwayFromXray(page, options = {}) {
  const problems = [];
  page.on('pageerror', (error) => problems.push(`page error: ${String(error?.message || error)}`));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    // The bench answers 503 to the terminal token and to the router sensors;
    // the browser reports those answers, they are not script errors.
    if (/^Failed to load resource: the server responded with a status of 503\b/.test(message.text())) return;
    problems.push(`console error: ${message.text()}`);
  });

  await page.addInitScript(() => {
    localStorage.setItem('xkeen.panel.last_view.v1', 'xkeen');
  });
  await page.route('**/api/restart-log', async (route) => {
    await route.fulfill({ json: { lines: options.restartLines || [] } });
  });
  await page.route('**/api/ws-token', async (route) => {
    await route.fulfill({ status: 503, json: { ok: false } });
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.locator('body')).toHaveClass(/\bpanel-page\b/);
  await expect(page.locator('#view-xkeen')).toBeVisible();
  await expect(page.locator('#view-routing')).toBeHidden();
  return problems;
}

test.describe('Xray module parts on a fresh page', () => {
  test('the restart journal opens the Xray preflight window', async ({ page }) => {
    await page.route(`**/api/operation-diagnostics/${PREFLIGHT_REF}`, async (route) => {
      await route.fulfill({
        json: {
          ok: true,
          ref: PREFLIGHT_REF,
          payload: {
            phase: 'xray_test',
            returncode: 23,
            timeout_s: 30,
            stderr: 'Failed to start: outbound tag is missing',
            error: 'xray preflight failed',
          },
        },
      });
    });
    const problems = await openPanelAwayFromXray(page, {
      restartLines: [
        `[2026-07-29 09:12:00] source=xray-preflight result=FAIL file=04_outbounds.json phase=validation returncode=23 preflight_ref=${PREFLIGHT_REF}\n`,
      ],
    });

    const button = page.locator(`#view-xkeen [data-xk-restart-log-preflight-ref="${PREFLIGHT_REF}"]`);
    if (!(await button.isVisible())) {
      await page.locator('#view-xkeen .xk-jr-row').filter({ hasText: /preflight/i }).first().click();
    }
    await button.click();

    await expect(page.locator('#xray-preflight-modal')).toBeVisible();
    await expect(page.locator('#xray-preflight-modal')).toContainText('outbound tag is missing');
    await expect(page.locator('#view-routing')).toBeHidden();
    expect(problems).toEqual([]);
  });

  test('saving outbounds from the JSON editor refreshes the outbounds card', async ({ page }) => {
    let savedUrl = 'vless://first@192.0.2.10:443?security=reality#first';
    const posts = [];
    const payload = () => ({
      ok: true,
      file: '04_outbounds.json',
      url: savedUrl,
      outbound_tag: 'proxy',
      text: '{\n  "outbounds": []\n}\n',
      config: { outbounds: [] },
    });
    await page.route(/\/api\/outbounds(\?.*)?$/, async (route) => {
      const request = route.request();
      if (request.method() === 'POST') {
        posts.push(request.url());
        savedUrl = 'vless://second@192.0.2.20:443?security=reality#second';
        await route.fulfill({ json: { ok: true } });
        return;
      }
      if (request.method() !== 'GET') {
        await route.fallback();
        return;
      }
      await route.fulfill({ json: payload() });
    });
    const problems = await openPanelAwayFromXray(page);

    await page.evaluate(() => window.XKeen.jsonEditor.open('outbounds'));
    await expect(page.locator('#json-editor-modal')).toBeVisible();
    await page.evaluate(() => window.XKeen.jsonEditor.save());

    await expect(page.locator('#json-editor-modal')).toBeHidden();
    expect(posts.length).toBe(1);
    await expect(page.locator('#outbounds-url')).toHaveValue('vless://second@192.0.2.20:443?security=reality#second');
    await expect(page.locator('#view-routing')).toBeHidden();
    expect(problems).toEqual([]);
  });

  test('the routing templates button opens the templates window', async ({ page }) => {
    await page.route('**/api/routing/templates', async (route) => {
      if (route.request().method() !== 'GET') {
        await route.fallback();
        return;
      }
      await route.fulfill({
        json: {
          ok: true,
          templates: [{ filename: 'module_parts_template.jsonc', title: 'Шаблон для проверки', description: 'e2e' }],
        },
      });
    });
    const problems = await openPanelAwayFromXray(page);

    // The button sits in the menu of the Xray screen; the click reaches the
    // same document listener without opening that screen.
    await page.locator('#routing-import-template-btn').dispatchEvent('click');

    await expect(page.locator('#routing-template-modal')).toBeVisible();
    await expect(page.locator('#view-routing')).toBeHidden();

    // The Xray entry remembers the part through `xk-core/...module_parts.js`;
    // the importmap must lead to the instance the core keeps its state in,
    // not to a second copy of it. The page loads one body of each shared core
    // file (its source, or its built chunk), and the public name gives the
    // functions of that body.
    const shared = await page.evaluate(async () => {
      const named = await import('xk-core/js/features/module_parts.js');
      const loaded = performance.getEntriesByType('resource').map((entry) => entry.name.split('?')[0]);
      const bodies = (source, chunk) => loaded.filter((name) => name.endsWith(source) || chunk.test(name));
      const parts = bodies('/static/js/features/module_parts.js', /\/frontend-build\/assets\/module_parts-[\w-]+\.js$/);
      const runtime = bodies('/static/js/features/xkeen_runtime.js', /\/frontend-build\/assets\/xkeen_runtime-[\w-]+\.js$/);
      const core = parts.length === 1 ? await import(parts[0]) : {};
      return {
        partsBodies: parts.length,
        runtimeBodies: runtime.length,
        remembered: named.loadedModulePart('engine.xray', 'routing_templates') !== null,
        sameFunctions: Object.values(core).includes(named.loadedModulePart),
      };
    });
    expect(shared).toEqual({ partsBodies: 1, runtimeBodies: 1, remembered: true, sameFunctions: true });
    expect(problems).toEqual([]);
  });
});

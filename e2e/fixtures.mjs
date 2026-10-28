import { test as base, expect } from '@playwright/test';

import { withPanelServer } from './panel_server.mjs';


// The application persists UI preferences server-side. Individual browser tests
// may switch the editor backend or toggle schema help, but those preferences
// are not part of a test's precondition. Keep that mutable API state in the
// browser context so one spec cannot alter the next spec's initial UI.
//
// The persistence API itself is covered by the Python contract tests. E2E
// tests cover consumers of this API and need a fresh, realistic snapshot.
const DEFAULT_UI_SETTINGS = {
  schemaVersion: 4,
  editor: {
    engine: 'codemirror',
    codemirrorFontScale: 100,
    monacoFontScale: 100,
    schemaHoverEnabled: true,
    beginnerModeEnabled: true,
    expertModeEnabled: false,
  },
  format: {
    preferPrettier: false,
    tabWidth: 2,
    printWidth: 80,
  },
  layout: {
    pageScrollEnabled: true,
    workspaceScrollEnabled: true,
    stickyHeaderEnabled: true,
  },
  logs: {
    ansi: false,
    ws2: false,
    view: {},
  },
  runtime: {
    memoryBudget: 'auto',
  },
  routing: {
    guiEnabled: true,
    autoApply: false,
    showActiveOutbound: false,
    showScenarioCard: true,
    dnsOverVlessLayout: 'auto',
  },
  mihomo: {
    hideUnavailable: false,
    consecutiveTimeouts: 3,
  },
};


function clone(value) {
  return JSON.parse(JSON.stringify(value));
}


function merge(baseValue, patchValue) {
  const base = baseValue && typeof baseValue === 'object' && !Array.isArray(baseValue)
    ? baseValue
    : {};
  const patch = patchValue && typeof patchValue === 'object' && !Array.isArray(patchValue)
    ? patchValue
    : {};
  const result = clone(base);

  for (const [key, value] of Object.entries(patch)) {
    result[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? merge(result[key], value)
      : clone(value);
  }

  return result;
}


export const test = base.extend({
  // One panel server per parallel worker: tests in different workers never
  // share server-side state, so spec files can run side by side.
  panelServer: [async ({ browser }, use, workerInfo) => {
    await withPanelServer(browser, workerInfo.parallelIndex, use);
  }, { scope: 'worker', timeout: 180_000 }],

  baseURL: async ({ panelServer }, use) => {
    await use(panelServer.baseURL);
  },

  storageState: async ({ panelServer }, use) => {
    await use(panelServer.storageState);
  },

  page: async ({ page }, use, testInfo) => {
    let settings = clone(DEFAULT_UI_SETTINGS);
    // What the page went through, said only when the test fails: a toast that
    // covers a control or a request that broke is otherwise lost with the page.
    const trouble = [];
    const note = (line) => { if (trouble.length < 40) trouble.push(line); };
    const pathOf = (url) => { try { return new URL(url).pathname; } catch (error) { return String(url); } };
    page.on('requestfailed', (request) => note(`request failed: ${request.method()} ${pathOf(request.url())} (${request.failure()?.errorText || '?'})`));
    page.on('response', (response) => { if (response.status() >= 500) note(`answer ${response.status()}: ${response.request().method()} ${pathOf(response.url())}`); });
    page.on('pageerror', (error) => note(`page error: ${String(error?.message || error).slice(0, 300)}`));

    // A previous browser context can leave the last selected panel view in
    // origin storage. Tests navigate to '/', but they do not all declare the
    // remembered view as part of their setup. Reset only test-owned UI
    // preferences before application scripts observe localStorage.
    await page.addInitScript(() => {
      localStorage.removeItem('xkeen.panel.last_view.v1');
      localStorage.removeItem('xkeen.routing.editor.engine');
      localStorage.removeItem('xkeen.outbounds.fragment');
      localStorage.removeItem('xkeen_inbounds_open');
      localStorage.removeItem('xkeen_outbounds_open');
      localStorage.removeItem('xk.routing.scenario.open.v1');
      localStorage.removeItem('xk.routing.dat.open.v3');
      localStorage.removeItem('xk.routing.backups.open.v1');
      localStorage.removeItem('xk.routing.help.open.v1');
      localStorage.removeItem('xk.routing.rules.open.v2');
      localStorage.removeItem('xk.routing.focus-mode.v1');
      localStorage.removeItem('xkeen.fm.panels.v1');
    });

    await page.route('**/api/ui-settings', async (route) => {
      const request = route.request();
      if (request.method() === 'GET') {
        await route.fulfill({ json: { ok: true, settings } });
        return;
      }

      if (request.method() === 'PATCH') {
        let patch = {};
        try {
          patch = request.postDataJSON() || {};
        } catch (error) {
          patch = {};
        }
        settings = merge(settings, patch);
        await route.fulfill({ json: { ok: true, settings } });
        return;
      }

      await route.fallback();
    });

    await use(page);

    if (testInfo.status !== testInfo.expectedStatus) {
      const toasts = await page.locator('#toast-container .toast').allInnerTexts().catch(() => []);
      for (const text of toasts) note(`toast on screen: ${text.replace(/\s+/g, ' ').trim().slice(0, 300)}`);
      if (trouble.length) {
        const report = trouble.join('\n');
        console.log(`[panel diagnostics] ${testInfo.title}\n${report}`);
        await testInfo.attach('panel-diagnostics', { body: report, contentType: 'text/plain' });
      }
    }
  },
});


export async function selectPanelView(page, view) {
  const tab = page.locator(`.top-tab-btn[data-view="${view}"]`);
  const activeView = await page.locator('.top-tab-btn.active[data-view]').getAttribute('data-view');
  if (['routing', 'mihomo', 'xkeen', 'xray-logs', 'commands', 'files'].includes(activeView)) {
    await expect(page.locator('body')).toHaveClass(/xk-operator-header-active/);
  }
  if (activeView === view && await page.locator(`#view-${view}`).isVisible()) return;
  if (!(await tab.isVisible())) {
    const trigger = page.locator('[aria-controls="xk-mihomo-sections-menu"]');
    await expect(trigger).toBeVisible();
    if (!(await page.locator('#xk-mihomo-sections-menu').isVisible())) {
      await trigger.click();
    }
  }
  await tab.click();
}


export async function switchTopView(page, view) {
  return selectPanelView(page, view);
}


export { expect };

// Quick fixes come with the advanced editor variant only; the bench
// panel serves the standard one.
export async function serveAdvancedEditorVariant(page) {
  await page.route('/', async (route) => {
    const response = await route.fetch();
    const body = (await response.text())
      .replace(
        /(\{[^{}]*"key": "editor-diff"[^{}]*\})/,
        (diff) => `${diff}, ${diff.replace('"editor-diff"', '"editor-enhancements"')}`
      )
      .replace(
        /"editor": \{"availableVariants": (\[[^\]]*\]), "capabilities": \[[^\]]*\], "variant": "[a-z]+"\}/,
        '"editor": {"availableVariants": $1, "capabilities": ["codemirror", "monaco", "diff", "prettier", "quick-fix", "schema-extended"], "variant": "advanced"}'
      );
    await route.fulfill({ response, body });
  });
}

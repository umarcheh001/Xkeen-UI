import { test, expect } from './fixtures.mjs';


const PROFILE = String(process.env.XKEEN_E2E_MODULE_PROFILE || 'full').toLowerCase();

const EXPECTED_BUNDLES = {
  full: ['panel-core', 'panel-routing', 'panel-mihomo', 'terminal-lazy', 'file-manager-lazy', 'diagnostics-panel', 'server-diagnostics-panel', 'editor-runtime', 'editor-codemirror', 'editor-monaco', 'editor-diff'],
  'xray-minimal': ['panel-core', 'panel-routing', 'editor-runtime', 'editor-codemirror'],
  'mihomo-minimal': ['panel-core', 'panel-mihomo', 'editor-runtime', 'editor-codemirror'],
  'core-only': ['panel-core'],
};

const FORBIDDEN_BUNDLE_MARKERS = {
  full: ['panel.editor.enhancements.bundle.js', 'schema_quickfixes.js', 'prettier_loader.js'],
  'xray-minimal': ['panel.mihomo.bundle.js', 'mihomo_clash', 'terminal.lazy.entry.js', 'file_manager.lazy.entry.js', 'panel.diagnostics.bundle.js', 'panel.editor.monaco.bundle.js', 'panel.editor.diff.bundle.js', 'panel.editor.enhancements.bundle.js', 'schema_quickfixes.js', 'prettier_loader.js'],
  'mihomo-minimal': ['panel.routing.bundle.js', 'terminal.lazy.entry.js', 'file_manager.lazy.entry.js', 'panel.diagnostics.bundle.js', 'panel.editor.monaco.bundle.js', 'panel.editor.diff.bundle.js', 'panel.editor.enhancements.bundle.js', 'schema_quickfixes.js', 'prettier_loader.js'],
  'core-only': ['panel.routing.bundle.js', 'panel.mihomo.bundle.js', 'mihomo_clash', 'terminal.lazy.entry.js', 'file_manager.lazy.entry.js', 'panel.diagnostics.bundle.js', 'panel.editor.bundle.js', 'panel.editor.codemirror.bundle.js', 'panel.editor.monaco.bundle.js', 'panel.editor.diff.bundle.js', 'panel.editor.enhancements.bundle.js', 'schema_quickfixes.js', 'prettier_loader.js'],
};

const FORBIDDEN_API_PREFIXES = {
  'xray-minimal': ['/api/mihomo', '/api/mihomo-clash', '/api/terminal', '/fs/', '/remotefs/', '/fileops/', '/api/storage', '/api/system/processes', '/api/system/router'],
  'mihomo-minimal': ['/api/xray', '/api/routing', '/routing/', '/api/terminal', '/fs/', '/remotefs/', '/fileops/', '/api/storage', '/api/system/processes', '/api/system/router'],
  'core-only': ['/api/xray', '/api/routing', '/routing/', '/api/mihomo', '/api/mihomo-clash', '/api/terminal', '/api/ws-token', '/fs/', '/remotefs/', '/fileops/', '/api/storage', '/api/system/processes', '/api/system/router'],
};

const FORBIDDEN_WS_PREFIXES = {
  'xray-minimal': ['/ws/mihomo-clash', '/ws/pty', '/ws/fileops', '/ws/devtools-logs'],
  'mihomo-minimal': ['/ws/xray-logs', '/ws/pty', '/ws/fileops', '/ws/devtools-logs'],
  'core-only': ['/ws/xray-logs', '/ws/mihomo-clash', '/ws/pty', '/ws/fileops', '/ws/devtools-logs'],
};

const INACTIVE_DOM_ROOTS = {
  'xray-minimal': ['view-mihomo', 'view-commands', 'terminal-overlay', 'view-files', 'xk-resource-dashboard-modal'],
  'mihomo-minimal': ['view-routing', 'view-xray-logs', 'view-commands', 'terminal-overlay', 'view-files', 'xk-resource-dashboard-modal'],
  'core-only': ['view-routing', 'view-xray-logs', 'view-mihomo', 'view-commands', 'terminal-overlay', 'view-files', 'xk-resource-dashboard-modal', 'json-editor-modal', 'fm-editor-modal', 'routing-editor', 'mihomo-editor'],
};

const NOOP_VIEW_CASES = {
  'xray-minimal': { inactiveView: 'mihomo', activeBundle: 'panel-routing', roots: ['view-routing', 'view-xray-logs'] },
  'mihomo-minimal': { inactiveView: 'routing', activeBundle: 'panel-mihomo', roots: ['view-mihomo'] },
  'core-only': { inactiveView: 'mihomo', activeBundle: 'panel-core', roots: ['view-xkeen'] },
};


function observeBrowser(page) {
  const requests = [];
  const websockets = [];
  const consoleErrors = [];
  page.on('request', (request) => requests.push(new URL(request.url()).pathname));
  page.on('websocket', (socket) => websockets.push(new URL(socket.url()).pathname));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  return { requests, websockets, consoleErrors };
}


async function moduleDescriptor(page) {
  return page.evaluate(() => window.XKeen?.pageConfig?.frontendModules || null);
}


test.describe(`dynamic panel loading: ${PROFILE}`, () => {
  test('publishes profile descriptor and respects inactive bundle boundaries', async ({ page }) => {
    const observed = observeBrowser(page);
    await page.route('**/api/system/resources', (route) => route.fulfill({
      json: {
        ok: true,
        cpu: { percent: 5.9 },
        memory: { percent: 31.9 },
      },
    }));
    await page.goto('/');
    await expect(page.locator('.panel-header-shell')).toBeAttached();
    await expect.poll(
      async () => (await moduleDescriptor(page))?.version,
      { timeout: 20_000 },
    ).toBe(1);

    const descriptor = await moduleDescriptor(page);
    expect(new Set(descriptor?.bundles?.map((bundle) => bundle.key))).toEqual(
      new Set(EXPECTED_BUNDLES[PROFILE] || []),
    );
    expect(descriptor?.editor?.variant).toBe(PROFILE === 'full' ? 'full' : 'light');
    expect(observed.requests.filter((path) => FORBIDDEN_BUNDLE_MARKERS[PROFILE]?.some((marker) => path.includes(marker)))).toEqual([]);
    expect(observed.requests.filter((path) => FORBIDDEN_API_PREFIXES[PROFILE]?.some((prefix) => path.startsWith(prefix)))).toEqual([]);
    expect(observed.requests.filter((path) => path.endsWith('/static/xterm/xterm.css'))).toEqual([]);
    expect(observed.websockets.filter((path) => FORBIDDEN_WS_PREFIXES[PROFILE]?.some((prefix) => path.startsWith(prefix)))).toEqual([]);
    for (const root of INACTIVE_DOM_ROOTS[PROFILE] || []) {
      await expect(page.locator(`#${root}`)).toHaveCount(0);
    }
    if (PROFILE === 'full') {
      await expect(page.locator('#xk-resource-monitor')).toHaveCount(1);
      await expect(page.locator('#xk-resource-monitor-install-offer')).toHaveCount(0);
    } else {
      await expect(page.locator('#xk-resource-monitor')).toHaveCount(0);
      const resourceOffer = page.locator('#xk-resource-monitor-install-offer');
      await expect(resourceOffer).toHaveCount(1);
      await expect(resourceOffer).toHaveAttribute('href', /\/modules$/);
      await expect(resourceOffer).toHaveAttribute('data-resource-module', 'tool.advanced-diagnostics');
      await expect(resourceOffer.locator('strong').nth(0)).toHaveText('5.9%');
      await expect(resourceOffer.locator('strong').nth(1)).toHaveText('31.9%');
    }
    expect(observed.consoleErrors.filter((text) => !/favicon|ResizeObserver/i.test(text))).toEqual([]);
  });

  test('keeps inactive views and missing roots as typed no-ops', async ({ page }) => {
    const expected = NOOP_VIEW_CASES[PROFILE];
    if (!expected) return;

    const observed = observeBrowser(page);
    await page.goto('/');
    const statuses = await page.evaluate(async (scenario) => {
      const [{ applyPanelViewRuntime }, { ensurePanelModule }] = await Promise.all([
        import('/static/js/pages/panel.view_runtime.js'),
        import('/static/js/pages/panel.module_loader.js'),
      ]);
      const inactive = await applyPanelViewRuntime(scenario.inactiveView);
      for (const root of scenario.roots) document.getElementById(root)?.remove();
      const missingRoot = await ensurePanelModule(scenario.activeBundle, 'e2e-missing-root');
      return { inactive: inactive?.status, missingRoot: missingRoot?.status };
    }, expected);

    expect(statuses).toEqual({ inactive: 'inactive', missingRoot: 'missing-root' });
    expect(observed.requests.filter((path) => FORBIDDEN_BUNDLE_MARKERS[PROFILE]?.some((marker) => path.includes(marker)))).toEqual([]);
    expect(observed.requests.filter((path) => FORBIDDEN_API_PREFIXES[PROFILE]?.some((prefix) => path.startsWith(prefix)))).toEqual([]);
    expect(observed.websockets.filter((path) => FORBIDDEN_WS_PREFIXES[PROFILE]?.some((prefix) => path.startsWith(prefix)))).toEqual([]);
    expect(observed.consoleErrors.filter((text) => !/favicon|ResizeObserver/i.test(text))).toEqual([]);
  });

  test('loads terminal stylesheet only after terminal view activation when available', async ({ page }) => {
    const observed = observeBrowser(page);
    await page.goto('/');
    const terminalTab = page.locator('.top-tab-btn[data-view="commands"]');
    if (!(await terminalTab.count()) || !(await terminalTab.isVisible())) return;

    expect(observed.requests.filter((path) => path.endsWith('/static/xterm/xterm.css'))).toEqual([]);
    await terminalTab.click();
    await expect(page.locator('#view-commands')).toBeVisible();
    await expect.poll(() => observed.requests.filter((path) => path.endsWith('/static/xterm/xterm.css')).length).toBe(1);
    await expect(page.locator('link[data-xk-module-css="xterm"]')).toHaveCount(1);
  });
});

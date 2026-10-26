import fs from 'node:fs/promises';
import path from 'node:path';
import { test, expect, selectPanelView } from './fixtures.mjs';

const MODAL = '#mihomo-import-modal';
const LINK = 'vless://11111111-1111-1111-1111-111111111111@example.com:443?encryption=none&type=tcp#Stage3';
const CONFIG = 'mixed-port: 7890\nproxies: []\nproxy-groups:\n  - name: Main\n    type: select\n    proxies: [DIRECT]\nrules:\n  - MATCH,Main\n';

async function prepare(page, { theme = 'dark', engine = 'codemirror' } = {}) {
  await page.addInitScript((theme) => {
    localStorage.setItem('xkeen-theme', theme);
    localStorage.removeItem('xkeen.mihomo.import.mode.v1');
  }, theme);
  await page.route('**/api/mihomo/subscriptions', (route) => route.fulfill({ json: { ok: true, subscriptions: [] } }));
  await page.goto('/');
  await selectPanelView(page, 'mihomo');
  await page.locator('#mihomo-clash-tab-config').click();
  await page.evaluate(async (content) => {
    const { getMihomoPanelApi } = await import('/static/js/features/mihomo_panel.js');
    getMihomoPanelApi().setEditorText(content);
  }, CONFIG);
  if (engine === 'monaco') {
    await page.locator('#mihomo-editor-engine-select').selectOption('monaco');
    await expect(page.locator('#mihomo-editor-monaco .monaco-editor').last()).toBeVisible();
  }
}

async function open(page) {
  const menu = page.locator('.xk-mihomo-menu');
  if (!await menu.evaluate((el) => el.open)) await menu.locator('summary').click();
  await page.locator('#mihomo-import-node-btn').click();
  await expect(page.locator(MODAL)).toBeVisible();
}

async function parse(page) {
  await page.locator('#mihomo-import-input').fill(LINK);
  await page.locator('#mihomo-import-parse-btn').click();
  await expect(page.locator('#mihomo-import-insert-btn')).toBeVisible();
  await expect(page.locator('#mihomo-import-insert-btn')).toBeEnabled();
}

async function visibleInViewport(locator) {
  const rect = await locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height, vw: innerWidth, vh: innerHeight };
  });
  expect(rect.width).toBeGreaterThan(0);
  expect(rect.height).toBeGreaterThan(0);
  expect(rect.x).toBeGreaterThanOrEqual(0);
  expect(rect.y).toBeGreaterThanOrEqual(0);
  expect(rect.right).toBeLessThanOrEqual(rect.vw);
  expect(rect.bottom).toBeLessThanOrEqual(rect.vh);
  return rect;
}

async function capture(page, name, testInfo) {
  const output = process.env.MIHOMO_STAGE3_CAPTURE_DIR
    ? path.resolve(process.env.MIHOMO_STAGE3_CAPTURE_DIR)
    : testInfo.outputPath('screenshots');
  await fs.mkdir(output, { recursive: true });
  await page.screenshot({ path: path.join(output, `${name}.png`), animations: 'disabled' });
}

test('source/result have no preview runtime; disclosure loads CM and close resets the session', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 960 });
  await prepare(page);
  await open(page);
  await expect(page.getByRole('dialog', { name: 'Добавить узлы в Mihomo' })).toBeVisible();
  await expect(page.locator('#mihomo-import-input')).toBeFocused();
  await expect(page.locator(`${MODAL} .cm-editor, ${MODAL} .monaco-editor`)).toHaveCount(0);
  await expect(page.locator('#mihomo-import-groups-block')).toBeHidden();
  await expect(page.locator('#mihomo-import-engine-select')).toBeHidden();
  await expect(page.locator('#mihomo-import-parse-static-btn')).toBeHidden();
  const frame = await visibleInViewport(page.locator(`${MODAL} .modal-content`));
  expect(frame.width).toBeLessThanOrEqual(720);
  expect(frame.height).toBeLessThan(560);
  await capture(page, 'source-dark', testInfo);
  await parse(page);
  await expect(page.locator('#mihomo-import-groups-block')).toBeVisible();
  await expect(page.locator('#mihomo-import-preview-panel')).toBeHidden();
  await expect(page.locator(`${MODAL} .cm-editor, ${MODAL} .monaco-editor`)).toHaveCount(0);
  await capture(page, 'result-dark', testInfo);
  await page.locator('#mihomo-import-preview-toggle').click();
  await expect(page.locator(`${MODAL} .cm-editor`)).toBeVisible();
  await expect(page.locator('#mihomo-import-preview-toggle')).toHaveAttribute('aria-expanded', 'true');
  await capture(page, 'preview-dark', testInfo);
  await page.locator('#mihomo-import-close-btn').click();
  await expect(page.locator('body')).not.toHaveClass(/modal-open/);
  await expect(page.locator(`${MODAL} .cm-editor, ${MODAL} .monaco-editor`)).toHaveCount(0);
  await open(page);
  await expect(page.locator('#mihomo-import-input')).toHaveValue(LINK);
  await expect(page.locator('#mihomo-import-insert-btn')).toBeHidden();
  expect((await page.locator(`${MODAL} .modal-content`).boundingBox()).width).toBeLessThanOrEqual(720);
});

test('old and new workbench geometry never inflate source; expanded geometry is restored', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 960 });
  await prepare(page);
  await page.evaluate(() => {
    localStorage.setItem('xk.modal.state.v1.mihomo-import-modal', JSON.stringify({ v: 1, x: 30, y: 20, w: 1500, h: 900 }));
    localStorage.setItem('xk.modal.state.v1.mihomo-import-preview-v2', JSON.stringify({ v: 1, x: 110, y: 80, w: 1100, h: 700 }));
  });
  await open(page);
  expect((await page.locator(`${MODAL} .modal-content`).boundingBox()).width).toBe(720);
  await parse(page);
  await page.locator('#mihomo-import-preview-toggle').click();
  expect((await page.locator(`${MODAL} .modal-content`).boundingBox()).width).toBe(1100);
  await page.locator('#mihomo-import-preview-toggle').click();
  expect((await page.locator(`${MODAL} .modal-content`).boundingBox()).width).toBe(720);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('xk.modal.state.v1.mihomo-import-modal')).w)).toBe(1500);
});

test('preferred Monaco stays lazy, keeps the shared preference and renders on disclosure', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 960 });
  await prepare(page, { theme: 'light', engine: 'monaco' });
  await page.evaluate(() => {
    const ee = window.XKeen.ui.editorEngine;
    const ensure = ee.ensureRuntime.bind(ee);
    ee.ensureRuntime = (engine, opts) => {
      if (opts?.scope === 'mihomo-import') window.__importRuntimeCalls = (window.__importRuntimeCalls || 0) + 1;
      return ensure(engine, opts);
    };
  });
  await open(page);
  expect(await page.evaluate(() => window.__importRuntimeCalls || 0)).toBe(0);
  await capture(page, 'source-light', testInfo);
  await parse(page);
  expect(await page.evaluate(() => window.__importRuntimeCalls || 0)).toBe(0);
  await page.locator('#mihomo-import-preview-toggle').click();
  await expect(page.locator('#mihomo-import-preview-monaco .monaco-editor')).toBeVisible();
  await expect(page.locator('#mihomo-editor-engine-select')).toHaveValue('monaco');
  await capture(page, 'preview-light-monaco', testInfo);
});

test('no-runtime fallback is read-only; local parse does not require the technical view', async ({ page }) => {
  await prepare(page);
  await page.evaluate(() => {
    const ee = window.XKeen.ui.editorEngine;
    const get = ee.getRuntime.bind(ee), ensure = ee.ensureRuntime.bind(ee);
    ee.getRuntime = (kind, opts) => opts?.scope === 'mihomo-import' ? null : get(kind, opts);
    ee.ensureRuntime = (kind, opts) => opts?.scope === 'mihomo-import' ? Promise.resolve(null) : ensure(kind, opts);
  });
  await open(page);
  await parse(page);
  await page.locator('#mihomo-import-preview-toggle').click();
  const preview = page.locator('#mihomo-import-preview');
  await expect(preview).toBeVisible();
  await expect(preview).toHaveJSProperty('readOnly', true);
  await expect(preview).toHaveValue(/Stage3/);
});

for (const [width, height] of [[390, 844], [390, 480], [1280, 600]]) {
  test(`source footer remains reachable at ${width}x${height}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height });
    await prepare(page);
    await open(page);
    await visibleInViewport(page.locator('#mihomo-import-parse-btn'));
    await visibleInViewport(page.locator('#mihomo-import-cancel-btn'));
    await capture(page, `source-${width}x${height}`, testInfo);
    await page.locator('#mihomo-import-input').fill('unsupported://synthetic');
    await page.locator('#mihomo-import-parse-btn').click();
    await expect(page.locator('#mihomo-import-status')).toContainText('Неизвестная ссылка');
    await expect(page.locator('#mihomo-import-input')).toHaveValue('unsupported://synthetic');
    await expect(page.locator('#mihomo-import-preview-panel')).toBeHidden();
    await capture(page, `source-error-${width}x${height}`, testInfo);
    await visibleInViewport(page.locator('#mihomo-import-parse-btn'));
    await page.locator('#mihomo-import-close-btn').click();
    await open(page);
    await page.locator('#mihomo-import-input').fill(LINK);
    await page.locator('#mihomo-import-input').press('Control+Enter');
    await expect(page.locator('#mihomo-import-insert-btn')).toBeEnabled();
    await visibleInViewport(page.locator('#mihomo-import-insert-btn'));
    await capture(page, `result-${width}x${height}`, testInfo);
    await page.locator('#mihomo-import-preview-toggle').click();
    await visibleInViewport(page.locator('#mihomo-import-insert-btn'));
    if (width < 980) {
      await page.locator('#mihomo-import-preview-panel').scrollIntoViewIfNeeded();
      await expect(page.locator(`${MODAL} .cm-editor`)).toBeVisible();
      await capture(page, `preview-${width}x${height}`, testInfo);
      await visibleInViewport(page.locator('#mihomo-import-insert-btn'));
    }
  });
}

test('Escape/backdrop, focus cycle and repeated open use the shared modal manager', async ({ page }) => {
  await prepare(page);
  await open(page);
  // DOM order (not visual order) ends with Cancel in the shared footer.
  await page.locator('#mihomo-import-cancel-btn').focus();
  await page.keyboard.press('Tab');
  await expect(page.locator('#mihomo-import-close-btn')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('#mihomo-import-cancel-btn')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator(MODAL)).toBeHidden();
  expect(await page.evaluate(() => window.XKeen.ui.modal.isOpen('mihomo-import-modal'))).toBe(false);
  await open(page);
  await page.locator(MODAL).click({ position: { x: 2, y: 2 } });
  await expect(page.locator(MODAL)).toBeHidden();
  await open(page);
  await expect(page.locator(`${MODAL} .cm-editor, ${MODAL} .monaco-editor`)).toHaveCount(0);
});

test('remote source is requested only on explicit parse; busy hotkeys do not duplicate requests', async ({ page }) => {
  await prepare(page);
  let requests = 0, release;
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  await page.route('**/api/mihomo/parse/xray-json', async (route) => {
    requests += 1;
    started();
    await new Promise((resolve) => { release = resolve; });
    await route.fulfill({ json: { ok: true, proxies: [{ proxy_name: 'Remote', proxy_yaml: '- name: Remote\n  type: direct\n' }] } });
  });
  await open(page);
  await page.locator('#mihomo-import-input').fill('https://subscription.example/fixture');
  expect(requests).toBe(0);
  await expect(page.locator('#mihomo-import-parse-static-btn')).toBeVisible();
  await page.locator('#mihomo-import-parse-btn').click();
  await ready;
  await expect(page.locator('#mihomo-import-parse-btn')).toBeDisabled();
  await expect(page.locator(MODAL)).toHaveAttribute('aria-busy', 'true');
  await page.locator('#mihomo-import-input').press('Control+Enter');
  expect(requests).toBe(1);
  release();
  await expect(page.locator('#mihomo-import-insert-btn')).toBeEnabled();
});

test('managed subscriptions remain reachable from the source without loading preview', async ({ page }) => {
  await prepare(page);
  await page.route('**/api/mihomo/subscriptions', (route) => route.fulfill({
    json: { ok: true, subscriptions: [{
      id: 'synthetic-sub', tag: 'Stage3 fixture', source: 'config',
      interval_hours: 24, enabled: true, proxy_names: ['Fixture'],
    }] },
  }));
  await open(page);
  const details = page.locator('#mihomo-import-managed-disclosure');
  await expect(details).toBeVisible();
  await expect(details).not.toHaveAttribute('open');
  await details.locator('summary').click();
  await expect(page.locator('#mihomo-import-xray-managed')).toContainText('Stage3 fixture');
  await expect(page.locator('#mihomo-import-xray-managed button')).toHaveCount(5);
  await expect(page.locator(`${MODAL} .cm-editor, ${MODAL} .monaco-editor`)).toHaveCount(0);
});

test('VPN formats send the entire textarea; source errors retain the editable input', async ({ page }) => {
  await prepare(page);
  const bodies = [];
  await page.route('**/api/mihomo/parse/wireguard', (route) => {
    bodies.push(route.request().postDataJSON());
    return route.fulfill({ json: { ok: true, proxy_name: 'WG', proxy_yaml: '- name: WG\n  type: wireguard\n' } });
  });
  await open(page);
  const source = '[Interface]\nPrivateKey = synthetic\nAddress = 10.0.0.2/32\n[Peer]\nPublicKey = synthetic-public\nEndpoint = fixture.example:443';
  await page.locator('#mihomo-import-mode').selectOption('wireguard');
  await page.locator('#mihomo-import-input').fill(source);
  await page.locator('#mihomo-import-parse-btn').click();
  await expect(page.locator('#mihomo-import-insert-btn')).toBeEnabled();
  expect(bodies).toEqual([{ text: source }]);
  await page.locator('#mihomo-import-mode').selectOption('proxy');
  await expect(page.locator('#mihomo-import-input')).toHaveValue(source);
  await expect(page.locator('#mihomo-import-preview-toggle')).toBeHidden();
  await expect(page.locator('#mihomo-import-groups-block')).toBeHidden();
  await page.locator('#mihomo-import-input').fill(`${LINK}\n${LINK.replace('#Stage3', '#Second')}`);
  await page.locator('#mihomo-import-parse-btn').click();
  await expect(page.locator('#mihomo-import-insert-btn')).toBeEnabled();
  await page.locator('#mihomo-import-preview-toggle').click();
  await expect(page.locator(`${MODAL} .cm-content`)).toContainText('Second');
});

test('Amnezia discovery is a compact source step with local flags and no YAML runtime', async ({ page }, testInfo) => {
  await prepare(page);
  const countries = ['DE', 'NL', 'PL', 'FR', 'GB', 'US'];
  await page.route('**/api/mihomo/amnezia-premium/locations', (route) => route.fulfill({
    json: { ok: true, locations: countries.map((code) => ({ code, name: `Location ${code}` })) },
  }));
  let issuance = 0;
  await page.route('**/api/mihomo/parse/amnezia-premium', (route) => {
    issuance += 1;
    return route.fulfill({ json: { ok: false, error: 'Issuance is not part of this test' } });
  });
  await open(page);
  await page.locator('#mihomo-import-mode').selectOption('amnezia-premium');
  await page.locator('#mihomo-import-input').fill('vpn://synthetic-stage3');
  await page.locator('#mihomo-import-parse-btn').click();
  await expect(page.locator('#mihomo-import-amnezia-locations input')).toHaveCount(6);
  await expect(page.locator('#mihomo-import-amnezia-locations .xk-mi-amnezia-location-flag svg')).toHaveCount(6);
  expect(issuance).toBe(0);
  await expect(page.locator('#mihomo-import-groups-block')).toBeHidden();
  await expect(page.locator(`${MODAL} .cm-editor, ${MODAL} .monaco-editor`)).toHaveCount(0);
  await page.locator('#mihomo-import-amnezia-locations input').first().check();
  await expect(page.locator('#mihomo-import-amnezia-locations-count')).toContainText('1 из 6');
  await capture(page, 'amnezia-discovery', testInfo);
  await visibleInViewport(page.locator('#mihomo-import-parse-btn'));
});

test('ordinary provider fallback handles fulfilled not_xray_json without eager preview', async ({ page }) => {
  await prepare(page);
  let probes = 0;
  await page.route('**/api/mihomo/parse/xray-json', (route) => route.fulfill({
    json: { ok: false, code: 'not_xray_json' },
  }));
  await page.route('**/api/mihomo/provider/probe', (route) => {
    probes += 1;
    return route.fulfill({ json: {
      ok: true, profile: { suggested_name: 'Stage3-provider' },
      provider_url: 'https://provider.example/fixture.yaml',
    } });
  });
  await open(page);
  await page.locator('#mihomo-import-input').fill('https://provider.example/subscription');
  await page.locator('#mihomo-import-parse-btn').click();
  await expect(page.locator('#mihomo-import-insert-btn')).toBeEnabled();
  expect(probes).toBe(1);
  await expect(page.locator('#mihomo-import-groups-block')).toBeHidden();
  await expect(page.locator(`${MODAL} .cm-editor, ${MODAL} .monaco-editor`)).toHaveCount(0);
  await page.locator('#mihomo-import-preview-toggle').click();
  await expect(page.locator(`${MODAL} .cm-content`)).toContainText('Stage3-provider');
});

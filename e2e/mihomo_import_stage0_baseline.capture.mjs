// Characterization/capture, not the target design. All sources are synthetic.
// No provider traffic, config save, restart or persisted subscription registration.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect, selectPanelView } from './fixtures.mjs';

const DATA = JSON.parse(fs.readFileSync(new URL('./fixtures/mihomo-import/stage0.json', import.meta.url), 'utf8'));
if (process.env.E2E_BASE_URL) throw new Error('Baseline capture requires a disposable local server; E2E_BASE_URL is forbidden.');
const DIR = path.resolve(process.env.MIHOMO_BASELINE_DIR || '.tmp/mihomo-import-stage0-baseline');
const MODAL = '#mihomo-import-modal';
const COUNTRIES = ['FI', 'DE', 'FR', 'GB', 'NL', 'SE', 'NO', 'PL', 'ES', 'IT', 'CH', 'AT', 'BE', 'CZ', 'DK', 'EE', 'GR', 'HU', 'IE', 'IS', 'LT', 'LU', 'LV', 'PT', 'RO', 'SK', 'SI', 'US', 'CA', 'BR', 'AU', 'JP', 'KR', 'SG', 'HK', 'AE', 'TR', 'KZ', 'IN', 'ID'];
const proxyOutput = (name) => ({ proxy_name: name, proxy_yaml: `- name: ${name}\n  type: socks5\n  server: example.com\n  port: 1080\n` });

async function fixtureNetwork(page, calls) {
  const forbidden = [];
  // Fail closed for any live save/restart from this baseline harness.
  await page.route('**/api/**', async (route) => {
    const r = route.request();
    const pathname = new URL(r.url()).pathname;
    const blocked = (r.method() !== 'GET' && (
      pathname === '/api/mihomo-config' || /\/mihomo\/(?:save|restart|generate_apply|hwid\/apply)/.test(pathname)
      || /restart-job|\/command/.test(pathname)
    ));
    if (blocked) {
      forbidden.push(pathname);
      return route.fulfill({ status: 409, json: { ok: false, error: 'Stage 0 blocks persistent/runtime mutations' } });
    }
    return route.fallback();
  });
  await page.route('**/api/mihomo-config', (route) => route.request().method() === 'GET'
    ? route.fulfill({ json: { ok: true, content: DATA.base_config } }) : route.fallback());
  await page.route('**/api/mihomo/subscriptions', (route) => route.fulfill({ json: { ok: true, subscriptions: [] } }));
  await page.route('**/api/mihomo/subscriptions/imported-xray', (route) => {
    calls.registrations += 1;
    return route.fulfill({ json: { ok: true } });
  });
  await page.route('**/api/mihomo/parse/xray-json', (route) => {
    const { url } = route.request().postDataJSON();
    const count = Number(/bulk-(\d+)/.exec(url)?.[1] || 0);
    return route.fulfill({ json: count
      ? { ok: true, proxies: Array.from({ length: count }, (_, i) => proxyOutput(`Bulk-${count}-${i + 1}`)) }
      : { ok: false, code: 'not_xray_json' } });
  });
  await page.route('**/api/mihomo/provider/probe', (route) => route.fulfill({ json: {
    ok: true, provider_mode: 'direct', provider_url: 'https://provider.example/baseline.yaml',
    profile: { suggested_name: 'Baseline-provider' }, provider_proxies: [proxyOutput('Provider-static')],
  } }));
  await page.route('**/api/mihomo/amnezia-premium/locations', (route) => {
    calls.discovery += 1;
    return route.fulfill({ json: { ok: true, locations: COUNTRIES.map((code) => ({ code, name: `Location ${code}` })) } });
  });
  await page.route('**/api/mihomo/parse/amnezia-premium', (route) => {
    calls.issuance += 1;
    const body = route.request().postDataJSON();
    return route.fulfill({ json: { ok: true, proxies: body.server_country_codes.map((code) => proxyOutput(`Amnezia-${code}`)) } });
  });
  return forbidden;
}

async function prepare(page, theme = 'dark') {
  await page.addInitScript((theme) => {
    localStorage.setItem('xkeen-theme', theme);
    if (!sessionStorage.getItem('mihomo-stage0-initialized')) {
      ['xk.modal.state.v1.mihomo-import', 'xk.modal.state.v1.mihomo-import-modal', 'xkeen.mihomo.import.mode.v1', 'xkeen.mihomo.import.groups.v1', 'xkeen.mihomo.import.groups.remember_v1'].forEach((k) => localStorage.removeItem(k));
      sessionStorage.setItem('mihomo-stage0-initialized', '1');
    }
  }, theme);
  await page.goto('/');
  await selectPanelView(page, 'mihomo');
  await page.locator('#mihomo-clash-tab-config').click();
  await seedEditor(page);
}

async function seedEditor(page) {
  await expect(page.locator('#mihomo-editor')).toBeAttached();
  await page.evaluate(async (content) => {
    const mod = await import('/static/js/features/mihomo_panel.js');
    const api = mod.getMihomoPanelApi();
    if (!api) throw new Error('Mihomo panel API not ready');
    api.setEditorText(content);
  }, DATA.base_config);
}

async function open(page) {
  const menu = page.locator('.xk-mihomo-menu');
  if (!(await menu.evaluate((e) => e.open))) await menu.locator('summary').click();
  const start = performance.now();
  await page.locator('#mihomo-import-node-btn').click();
  await expect(page.locator(MODAL)).toBeVisible();
  return Math.round(performance.now() - start);
}

async function capture(page, name) {
  const facts = await page.locator(MODAL).evaluate((modal) => {
    const box = (n) => { if (!n) return null; const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
    const ta = modal.querySelector('#mihomo-import-preview');
    const groups = modal.querySelector('#mihomo-import-groups');
    const flags = modal.querySelector('#mihomo-import-amnezia-locations');
    return {
      visiblePreviewChars: modal.querySelector('#mihomo-import-preview-monaco:not(.hidden) .view-lines')?.innerText.length || modal.querySelector('.cm-editor .cm-content')?.innerText.length || ta?.value.length || 0,
      viewport: { width: innerWidth, height: innerHeight }, theme: document.documentElement.dataset.theme,
      modal: box(modal.querySelector('.modal-content')), preview: box(modal.querySelector('.xk-mi-preview-wrap')),
      status: modal.querySelector('#mihomo-import-status')?.innerText,
      inputMode: modal.querySelector('#mihomo-import-mode')?.value,
      engine: modal.querySelector('#mihomo-import-engine-select')?.value,
      hasCm: !!modal.querySelector('.cm-editor'), hasMonaco: !!modal.querySelector('.monaco-editor'),
      plainVisible: !!ta && ta.getClientRects().length > 0,
      textareaBackingChars: ta?.value.length || 0, insertEnabled: !modal.querySelector('#mihomo-import-insert-btn')?.disabled,
      groupNames: Array.from(groups?.querySelectorAll('[data-group]') || []).map((x) => x.dataset.group),
      selectedGroups: Array.from(groups?.querySelectorAll('input:checked') || []).map((x) => x.dataset.group),
      flags: { count: flags?.querySelectorAll('svg').length || 0, columns: flags ? getComputedStyle(flags).gridTemplateColumns : null },
    };
  });
  await page.screenshot({ path: path.join(DIR, `${name}.png`), animations: 'disabled' });
  return facts;
}

async function parse(page, mode, source, staticMode = false) {
  await page.locator('#mihomo-import-mode').selectOption(mode);
  await page.locator('#mihomo-import-input').fill(source);
  const start = performance.now();
  await page.locator(staticMode ? '#mihomo-import-parse-static-btn' : '#mihomo-import-parse-btn').click();
  await expect(page.locator('#mihomo-import-insert-btn')).toBeEnabled();
  return Math.round(performance.now() - start);
}

test('stage0 source, geometry and lifecycle characterization', async ({ page }) => {
  test.setTimeout(180_000);
  fs.mkdirSync(DIR, { recursive: true });
  const calls = { discovery: 0, issuance: 0, registrations: 0 };
  const forbidden = await fixtureNetwork(page, calls);
  await page.setViewportSize({ width: 1600, height: 960 });
  await prepare(page);
  const requests = [];
  page.on('request', (r) => requests.push({ method: r.method(), path: new URL(r.url()).pathname }));
  const openMs = await open(page);
  await expect(page.locator(`${MODAL} .cm-editor`)).toBeVisible();
  const states = { empty: await capture(page, 'desktop-dark-empty') };
  const singleMs = await parse(page, 'auto', DATA.proxy);
  await page.locator('#mihomo-import-groups-block > summary').click();
  await page.locator('#mihomo-import-groups input[data-group="Main"]').check();
  states.single = await capture(page, 'desktop-dark-single');
  // Characterize existing stale-result behavior, not a target invariant.
  await page.locator('#mihomo-import-input').fill('unsupported://changed-after-parse');
  states.inputEditedAfterParse = { insertStillEnabled: await page.locator('#mihomo-import-insert-btn').isEnabled() };
  await page.locator('#mihomo-import-parse-btn').click();
  await expect(page.locator('#mihomo-import-insert-btn')).toBeDisabled();
  states.error = await capture(page, 'desktop-dark-error');
  await parse(page, 'proxy', `${DATA.proxy}\n${DATA.proxy.replace('#Baseline', '#Second')}\nunsupported://fixture`);
  states.mixedBatch = await capture(page, 'desktop-dark-mixed-batch');
  await parse(page, 'subscription', 'https://provider.example/subscription');
  states.provider = await capture(page, 'desktop-dark-provider');
  await parse(page, 'subscription', 'https://provider.example/subscription', true);
  states.providerStatic = await capture(page, 'desktop-dark-provider-static');
  for (const [mode, source] of [['wireguard', DATA.amnezia_wg_v31_conf], ['openvpn', DATA.openvpn_auth_user_pass_conf], ['tailscale', DATA.tailscale_settings]]) {
    await parse(page, mode, source);
    states[mode] = await capture(page, `desktop-dark-${mode}`);
  }
  await page.locator('#mihomo-import-mode').selectOption('amnezia-premium');
  await page.locator('#mihomo-import-input').fill('vpn://fixture-not-a-real-key');
  await page.locator('#mihomo-import-parse-btn').click();
  await expect(page.locator('#mihomo-import-amnezia-locations input')).toHaveCount(40);
  expect(calls.issuance).toBe(0);
  states.amnezia = await capture(page, 'desktop-dark-amnezia-locations');
  await page.locator('#mihomo-import-amnezia-locations').evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await capture(page, 'desktop-dark-amnezia-bottom');
  await page.locator('#mihomo-import-amnezia-locations').evaluate((el) => { el.scrollTop = 0; });
  await page.locator('#mihomo-import-amnezia-locations input[data-location-code="DE"]').check();
  await page.locator('#mihomo-import-parse-btn').click();
  await expect(page.locator('#mihomo-import-insert-btn')).toBeEnabled();
  await page.locator('#mihomo-import-parse-btn').click();
  expect(calls.issuance).toBe(1);
  states.amneziaIssued = await capture(page, 'desktop-dark-amnezia-issued');
  await page.setViewportSize({ width: 390, height: 844 });
  states.mobileAmnezia = await capture(page, 'mobile-dark-amnezia');
  await page.locator('#mihomo-import-close-btn').click();
  await page.setViewportSize({ width: 1600, height: 960 });
  await page.evaluate(() => {
    localStorage.removeItem('xk.modal.state.v1.mihomo-import');
    localStorage.removeItem('xk.modal.state.v1.mihomo-import-modal');
  });
  await open(page);
  const handle = await page.locator(`${MODAL} .modal-resizer`).boundingBox();
  if (!handle) throw new Error('resize handle missing');
  await page.mouse.move(handle.x + 3, handle.y + 3);
  await page.mouse.down();
  await page.mouse.move(handle.x - 260, handle.y - 60, { steps: 8 });
  await page.mouse.up();
  await page.locator('#mihomo-import-close-btn').click();
  await open(page);
  states.savedGeometry = await capture(page, 'desktop-dark-saved-geometry');
  states.savedGeometry.storage = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([k]) => k.startsWith('xk.modal.state.v1.') && k.includes('mihomo-import'))));
  const dom = await page.locator(MODAL).evaluate((e) => ({
    role: e.getAttribute('role'), ariaModal: e.getAttribute('aria-modal'), ariaLabel: e.getAttribute('aria-label'),
    family: e.dataset.operatorModalFamily,
    ids: [e.id, ...Array.from(e.querySelectorAll('[id]')).map((x) => x.id)],
  }));
  expect(forbidden).toEqual([]);
  fs.writeFileSync(path.join(DIR, 'characterization.json'), JSON.stringify({
    date: '2026-10-26', fixture: 'e2e/fixtures/mihomo-import/stage0.json',
    method: 'local isolated E2E server; actual web parsing for direct/WG/OpenVPN/Tailscale; mocked subscription/Amnezia remote responses; no persistent config writes',
    openMs, singleMs, calls, forbidden, dom, states, openingRequests: requests,
  }, null, 2));
});

test('stage0 light/mobile, Monaco and no-runtime fallback', async ({ page }) => {
  test.setTimeout(150_000);
  fs.mkdirSync(DIR, { recursive: true });
  const forbidden = await fixtureNetwork(page, { discovery: 0, issuance: 0, registrations: 0 });
  await page.setViewportSize({ width: 1600, height: 960 });
  await prepare(page, 'light');
  await open(page);
  await expect(page.locator(`${MODAL} .cm-editor`)).toBeVisible();
  const light = await capture(page, 'desktop-light-empty');
  await page.setViewportSize({ width: 390, height: 844 });
  await capture(page, 'mobile-light-empty');
  await page.locator('#mihomo-import-close-btn').click();
  await page.setViewportSize({ width: 1600, height: 960 });
  await page.evaluate(() => {
    localStorage.removeItem('xk.modal.state.v1.mihomo-import');
    localStorage.removeItem('xk.modal.state.v1.mihomo-import-modal');
  });
  await open(page);
  await page.locator('#mihomo-import-engine-select').selectOption('monaco');
  await expect(page.locator('#mihomo-import-preview-monaco .monaco-editor')).toBeVisible({ timeout: 60_000 });
  await parse(page, 'proxy', DATA.proxy);
  const monaco = await capture(page, 'desktop-light-monaco');
  await page.locator('#mihomo-import-close-btn').click();
  await page.reload();
  await selectPanelView(page, 'mihomo');
  await page.locator('#mihomo-clash-tab-config').click();
  await seedEditor(page);
  // Fault injection is scoped to import preview only, leaving the main editor intact.
  await page.evaluate(() => {
    const ee = window.XKeen.ui.editorEngine;
    const get = ee.getRuntime, ensure = ee.ensureRuntime;
    ee.getRuntime = function(kind, opts) { return opts?.scope === 'mihomo-import' ? null : get.call(this, kind, opts); };
    ee.ensureRuntime = async function(kind, opts) { return opts?.scope === 'mihomo-import' ? null : ensure.call(this, kind, opts); };
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  await expect(page.locator('#mihomo-import-preview')).toBeVisible();
  await parse(page, 'proxy', DATA.proxy);
  const fallback = await capture(page, 'mobile-light-fallback');
  expect(fallback.plainVisible).toBe(true);
  expect(forbidden).toEqual([]);
  fs.writeFileSync(path.join(DIR, 'engines.json'), JSON.stringify({ light, monaco, fallback, forbidden }, null, 2));
});

test('stage0 actual local draft patch request count by batch size', async ({ page }) => {
  test.setTimeout(180_000);
  fs.mkdirSync(DIR, { recursive: true });
  const calls = { discovery: 0, issuance: 0, registrations: 0 };
  const forbidden = await fixtureNetwork(page, calls);
  await prepare(page);
  const requests = [];
  page.on('request', (r) => requests.push({ method: r.method(), path: new URL(r.url()).pathname }));
  const timings = [];
  for (const count of [1, 10, 50]) {
    await open(page);
    const begin = requests.length;
    const parseMs = await parse(page, 'subscription', `https://subscription.example/bulk-${count}`);
    await page.locator('#mihomo-import-groups-block > summary').click();
    await page.locator('#mihomo-import-groups input[data-group="Main"]').check();
    if (count === 50) await capture(page, 'desktop-large-subscription-50');
    const start = performance.now();
    await page.locator('#mihomo-import-insert-btn').click();
    await expect(page.locator(MODAL)).toBeHidden({ timeout: 60_000 });
    const insertMs = Math.round(performance.now() - start);
    timings.push({ count, parseMs, insertMs, postCounts: requests.slice(begin).filter((r) => r.method === 'POST').reduce((acc, r) => { acc[r.path] = (acc[r.path] || 0) + 1; return acc; }, {}) });
  }
  expect(forbidden).toEqual([]);
  expect(timings.map((x) => x.postCounts['/api/mihomo/patch/apply_insert'])).toEqual([1, 10, 50]);
  fs.writeFileSync(path.join(DIR, 'batch.json'), JSON.stringify({
    method: 'one local Chromium run, wall time with Playwright overhead, actual local apply_insert endpoint; parse and registration use synthetic responses, not provider/router latency',
    timings, calls, forbidden,
  }, null, 2));
});


test('stage0 short-height initial geometry', async ({ page }) => {
  fs.mkdirSync(DIR, { recursive: true });
  const forbidden = await fixtureNetwork(page, { discovery: 0, issuance: 0, registrations: 0 });
  await page.setViewportSize({ width: 1280, height: 600 });
  await prepare(page);
  await open(page);
  const short = await capture(page, 'desktop-short-dark-empty');
  expect(forbidden).toEqual([]);
  fs.writeFileSync(path.join(DIR, 'short.json'), JSON.stringify(short, null, 2));
});

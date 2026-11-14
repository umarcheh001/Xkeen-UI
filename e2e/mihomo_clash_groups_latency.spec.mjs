import { test, expect, selectPanelView, openMihomoConfig } from './fixtures.mjs';
import {
  statusPayload, groupsPayload, setHiddenGroupsVisible, openMihomoGroupsMenu,
} from './mihomo_clash_groups_support.mjs';

// Mihomo groups: how fresh a latency is, delay probes, country flags, sorting,
// fixed groups and hiding nodes that time out.

test('Smart availability follows merged probes across groups and a later timeout replaces success', async ({ page }) => {
  const data = groupsPayload();
  const nodes = ['Poland', 'Sweden Reality', 'Sweden XHTTP', 'Netherlands'].map((name) => ({
    name, type: 'VLESS', alive: false, availability: 'unavailable', provider: '', provider_candidates: [],
    delay_ms: 0, delay_history: [{ measured_at: new Date().toISOString(), delay_ms: 0 }],
  }));
  data.groups = ['Smart', 'Fallback'].map((name) => ({
    name, type: name, now: name === 'Smart' ? 'Smart - Select' : 'Sweden Reality', fixed: '',
    hidden: false, selectable: true, nodes,
  }));
  let groupReads = 0;
  let polandDelay = 81;
  await page.route('**/api/mihomo/clash/status', (route) => route.fulfill({ json: statusPayload() }));
  await page.route(/\/api\/mihomo\/clash\/proxy-groups(?:\/.*)?$/, (route) => {
    groupReads += 1;
    // Reproduce the core's last failed service check even when the combined
    // result reports a successful Google/Cloudflare measurement.
    return route.fulfill({ json: data });
  });
  await page.route('**/api/mihomo/clash/smart/weights', (route) => route.fulfill({ json: { ok: true, weights: {} } }));
  await page.route('**/api/mihomo/clash/delay', (route) => {
    const body = route.request().postDataJSON();
    return route.fulfill({ json: {
      ok: true, preset: 'all', effective_preset: 'all',
      results: [{ name: body.name, delay_ms: body.name === 'Poland' ? polandDelay : 0 }],
    } });
  });
  await page.goto('/');
  await selectPanelView(page, 'mihomo');
  await page.evaluate(async () => {
    window.XKeen?.ui?.settings?.setLocal?.({ mihomo: { latencyPreset: 'all' } });
    const mod = await (await import('xk-module/engine.mihomo')).load('clash');
    mod.activateMihomoClashWorkspace({ reason: 'e2e-smart-availability' });
  });
  const smart = page.locator('[data-group-name="Smart"]');
  const fallback = page.locator('[data-group-name="Fallback"]');
  const summary = (group) => group.locator('.xk-mihomo-group-title > small');
  await expect(summary(smart)).toContainText('0/4 доступны');
  await smart.locator('.xk-mihomo-group-head').click();
  await fallback.locator('.xk-mihomo-group-head').click();
  const readsBefore = groupReads;
  await smart.locator('.xk-mihomo-group-test').click();
  await expect.poll(() => groupReads).toBeGreaterThan(readsBefore);
  for (const group of [smart, fallback]) {
    await expect(summary(group)).toContainText('1/4 доступны');
    await expect(group.locator('[data-node-name="Poland"] .xk-mihomo-node-delay')).toHaveText('81 мс');
    await expect(group.locator('[data-node="Poland"].xk-mihomo-node-select')).toBeEnabled();
  }

  // The next complete failure must win over both the previous merged result
  // and a still-positive core snapshot, including in the other group.
  polandDelay = 0;
  nodes[0].alive = true;
  nodes[0].availability = 'available';
  await fallback.locator('[data-node-name="Poland"] .xk-mihomo-node-delay').click();
  for (const group of [smart, fallback]) {
    await expect(summary(group)).toContainText('0/4 доступны');
    await expect(group.locator('[data-node-name="Poland"] .xk-visually-hidden')).toHaveText('нет ответа');
    await expect(group.locator('[data-node="Poland"].xk-mihomo-node-select')).toBeDisabled();
    await expect(group.locator('[data-node-name="Poland"]')).toHaveAttribute('data-alive', 'недоступен');
  }
});

test('expired successful Smart probe no longer overrides the unavailable core snapshot', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-01T13:30:00Z') });
  const data = groupsPayload();
  data.groups = [{
    name: 'Smart', type: 'Smart', now: 'Smart - Select', fixed: '', hidden: false, selectable: true,
    nodes: [{ name: 'Poland', type: 'VLESS', alive: false, provider: '', provider_candidates: [], delay_ms: 0 }],
  }];
  await page.route('**/api/mihomo/clash/status', (route) => route.fulfill({ json: statusPayload() }));
  await page.route(/\/api\/mihomo\/clash\/proxy-groups(?:\/.*)?$/, (route) => route.fulfill({ json: data }));
  await page.route('**/api/mihomo/clash/smart/weights', (route) => route.fulfill({ json: { ok: true, weights: {} } }));
  await page.route('**/api/mihomo/clash/delay', (route) => route.fulfill({ json: {
    ok: true, results: [{ name: 'Poland', delay_ms: 81 }],
  } }));
  await page.goto('/');
  await selectPanelView(page, 'mihomo');
  await page.evaluate(async () => {
    const mod = await (await import('xk-module/engine.mihomo')).load('clash');
    mod.activateMihomoClashWorkspace({ reason: 'e2e-smart-availability-expiry' });
  });
  const group = page.locator('[data-group-name="Smart"]');
  await group.locator('.xk-mihomo-group-head').click();
  await group.locator('[data-node-name="Poland"] .xk-mihomo-node-delay').click();
  await expect(group.locator('.xk-mihomo-group-title > small')).toContainText('1/1 доступны');
  await page.clock.fastForward((5 * 60 * 1000) + 100);
  await page.evaluate(async () => {
    const mod = await (await import('xk-module/engine.mihomo')).load('clash');
    await mod.refreshMihomoClashStatus({ reason: 'e2e-groups-refresh' });
  });
  await expect(group.locator('.xk-mihomo-group-title > small')).toContainText('0/1 доступны');
  await expect(group.locator('[data-node-name="Poland"] .xk-mihomo-node-delay')).toHaveAttribute('data-delay-tone', 'unavailable');
});

test('Mihomo latency stays visible but is marked stale after five minutes and groups refresh on return', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-08-16T10:15:30Z') });
  let groupRequests = 0;
  await page.route('**/api/mihomo/clash/status', (route) => route.fulfill({ json: statusPayload() }));
  await page.route(/\/api\/mihomo\/clash\/proxy-groups(?:\/.*)?$/, (route) => {
    groupRequests += 1;
    return route.fulfill({ json: groupsPayload() });
  });
  await page.route('**/api/mihomo/clash/delay', (route) => {
    const data = route.request().postDataJSON();
    return route.fulfill({
      json: { ok: true, schema_version: 1, results: [{ name: data.name, delay_ms: 44 }] },
    });
  });

  await page.goto('/');
  await selectPanelView(page, 'mihomo');
  await page.evaluate(async () => {
    const mod = await (await import('xk-module/engine.mihomo')).load('clash');
    mod.activateMihomoClashWorkspace({ reason: 'e2e-delay-freshness' });
  });
  await expect(page.locator('#mihomo-clash-groups-list')).toContainText('AUTO');
  await page.locator('[data-group-name="AUTO"] .xk-mihomo-group-head').click();
  const latency = page.locator('[data-group-name="AUTO"] [data-node-name="node-a"] .xk-mihomo-node-delay');
  const unavailable = page.locator('[data-group-name="AUTO"] [data-node-name="node-b"] .xk-mihomo-node-delay');
  await expect(latency).toHaveText('82 мс');
  await expect(unavailable).toHaveText('не ответил на фоновой проверке');

  await latency.click();
  await expect(latency).toHaveText('44 мс');
  await page.clock.fastForward((5 * 60 * 1000) + 100);
  await expect(latency).toHaveText('44 мс');
  await expect(latency).toHaveAttribute('data-delay-tone', 'stale');
  await expect(unavailable).toHaveText('999 мс');
  await expect(unavailable).toHaveAttribute('data-delay-tone', 'stale');
  await latency.hover();
  await expect(page.locator('#mihomo-clash-delay-history-popover')).toContainText('44 мс');

  const requestsBeforeReturn = groupRequests;
  await page.locator('[aria-controls="xk-mihomo-sections-menu"]').click();
  await selectPanelView(page, 'routing');
  await selectPanelView(page, 'mihomo');
  await expect.poll(() => groupRequests).toBeGreaterThan(requestsBeforeReturn);
  await expect(latency).toContainText('44 мс');
});

test('auto freshness follows provider healthcheck interval and core group mode uses one group request', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-08-16T10:15:30Z') });
  const data = groupsPayload();
  // Core batch is for the group types the core tests on its own; a selector is
  // probed node by node, so this fixture has to be a url-test group.
  data.groups[0].type = 'URLTest';
  data.groups[0].healthcheck_interval_seconds = 900;
  data.groups[0].nodes[0].healthcheck_interval_seconds = 900;
  const delayRequests = [];
  await page.route('**/api/ui-settings', async (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({ json: { schemaVersion: 2, mihomo: { latencyFreshness: 'auto', latencyTestMode: 'core' } } });
    }
    return route.fulfill({ json: { ok: true } });
  });
  await page.route('**/api/mihomo/clash/status', (route) => route.fulfill({ json: statusPayload() }));
  await page.route(/\/api\/mihomo\/clash\/proxy-groups(?:\/.*)?$/, (route) => route.fulfill({ json: data }));
  await page.route('**/api/mihomo/clash/delay', async (route) => {
    const body = route.request().postDataJSON();
    delayRequests.push(body);
    return route.fulfill({ json: { ok: true, results: [{ name: 'node-a', delay_ms: 41 }, { name: 'node-b', delay_ms: 52 }] } });
  });

  await page.goto('/');
  await selectPanelView(page, 'mihomo');
  await page.evaluate(async () => {
    const settings = window.XKeen?.ui?.settings;
    settings?.setLocal?.({ mihomo: { latencyFreshness: 'auto', latencyTestMode: 'core' } });
    const mod = await (await import('xk-module/engine.mihomo')).load('clash');
    mod.activateMihomoClashWorkspace({ reason: 'e2e-core-group-mode' });
  });
  await page.locator('[data-group-name="AUTO"] .xk-mihomo-group-head').click();
  const latency = page.locator('[data-node-name="node-a"] .xk-mihomo-node-delay');
  await page.clock.fastForward((5 * 60 * 1000) + 100);
  await expect(latency).toHaveText('82 мс');
  await expect(latency).toHaveAttribute('data-delay-tone', 'good');
  await page.locator('[data-group-name="AUTO"] .xk-mihomo-group-test').click();
  await expect(latency).toHaveText('41 мс');
  expect(delayRequests).toHaveLength(1);
  expect(delayRequests[0]).toMatchObject({ scope: 'group', name: 'AUTO' });
});

test('core batch mode still probes a selector group node by node', async ({ page }) => {
  // Mihomo re-picks ``now`` while answering /group/{name}/delay, so on a
  // selector the batch would both disturb the user's choice and report the
  // group's verdict instead of each node's. Zashboard excludes those group
  // types from the core batch; the mode selector must not override that.
  const data = groupsPayload();
  const requests = [];
  await page.route('**/api/ui-settings', async (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({ json: { schemaVersion: 2, mihomo: { latencyTestMode: 'core' } } });
    }
    return route.fulfill({ json: { ok: true } });
  });
  await page.route('**/api/mihomo/clash/status', (route) => route.fulfill({ json: statusPayload() }));
  await page.route(/\/api\/mihomo\/clash\/proxy-groups(?:\/.*)?$/, (route) => route.fulfill({ json: data }));
  await page.route('**/api/mihomo/clash/delay', async (route) => {
    const body = route.request().postDataJSON();
    requests.push(body);
    return route.fulfill({ json: { ok: true, results: [{ name: body.name, delay_ms: 61 }] } });
  });

  await page.goto('/');
  await selectPanelView(page, 'mihomo');
  await page.evaluate(async () => {
    const settings = window.XKeen?.ui?.settings;
    settings?.setLocal?.({ mihomo: { latencyTestMode: 'core' } });
    const mod = await (await import('xk-module/engine.mihomo')).load('clash');
    mod.activateMihomoClashWorkspace({ reason: 'e2e-core-mode-selector' });
  });
  await page.locator('[data-group-name="AUTO"] .xk-mihomo-group-head').click();
  await page.locator('[data-group-name="AUTO"] .xk-mihomo-group-test').click();

  await expect(page.locator('[data-node-name="node-a"] .xk-mihomo-node-delay')).toHaveText('61 мс');
  expect(requests.some((item) => item.scope === 'group')).toBe(false);
  expect(requests.map((item) => item.scope).sort()).toEqual(['provider-proxy', 'proxy']);
});


test('server cards replace provider emoji with one rectangular country flag', async ({ page }) => {
  const data = groupsPayload('🇩🇪 DE Germany.01');
  data.groups[0].now = '🇩🇪 DE Germany.01';
  data.groups[0].nodes = [{
    name: '🇩🇪 DE Germany.01', type: 'VLESS', alive: true, udp: true,
    provider: 'provider-one', provider_candidates: ['provider-one'], delay_ms: 40,
  }];
  await page.route('**/api/mihomo/clash/status', (route) => route.fulfill({ json: statusPayload() }));
  await page.route(/\/api\/mihomo\/clash\/proxy-groups(?:\/.*)?$/, (route) => route.fulfill({ json: data }));
  await page.goto('/');
  await selectPanelView(page, 'mihomo');
  await page.evaluate(async () => {
    const mod = await (await import('xk-module/engine.mihomo')).load('clash');
    mod.activateMihomoClashWorkspace({ reason: 'e2e-country' });
  });
  await page.locator('[data-group-name="AUTO"] .xk-mihomo-group-head').click();
  const card = page.locator('[data-node-name="🇩🇪 DE Germany.01"]');
  await expect(card.locator('.xk-mihomo-node-country[data-country="DE"]')).toHaveCount(1);
  await expect(card.locator('.xk-mihomo-node-country[data-country="DE"] svg')).toHaveCount(1);
  await expect(card.locator('.xk-mihomo-node-main strong')).toContainText('Germany.01');
  await expect(card.locator('.xk-mihomo-node-main strong')).not.toContainText('🇩🇪');
  await expect(card.locator('.xk-mihomo-node-main strong')).not.toContainText('DE Germany');
});

test('complex country flags use complete inline SVG artwork', async ({ page }) => {
  const names = ['JP Japan', 'IL Israel', 'KZ Kazakhstan'];
  const data = groupsPayload(names[0]);
  data.groups[0].nodes = names.map((name) => ({ name, type: 'VLESS', alive: true, udp: true }));
  await page.route('**/api/mihomo/clash/status', (route) => route.fulfill({ json: statusPayload() }));
  await page.route(/\/api\/mihomo\/clash\/proxy-groups(?:\/.*)?$/, (route) => route.fulfill({ json: data }));
  await page.goto('/');
  await selectPanelView(page, 'mihomo');
  await page.evaluate(async () => {
    const mod = await (await import('xk-module/engine.mihomo')).load('clash');
    mod.activateMihomoClashWorkspace({ reason: 'e2e-complex-flags' });
  });
  await page.locator('[data-group-name="AUTO"] .xk-mihomo-group-head').click();
  for (const code of ['JP', 'IL', 'KZ']) {
    const flag = page.locator(`.xk-mihomo-node-country[data-country="${code}"]`);
    await expect(flag).toHaveCount(1);
    await expect(flag.locator('svg')).toHaveCount(1);
    await expect(flag).toHaveCSS('width', '20px');
    await expect(flag).toHaveCSS('height', '14px');
  }
});

test('visible delay test probes every node beyond the old eight-item limit and reports progress', async ({ page }) => {
  const names = Array.from({ length: 12 }, (_, index) => `bulk-node-${index + 1}`);
  const data = groupsPayload(names[0]);
  data.groups[0].nodes = names.map((name) => ({
    name, type: 'VLESS', alive: true, udp: true, provider: '', provider_candidates: [], delay_ms: null,
  }));
  const probed = [];
  await page.route('**/api/mihomo/clash/status', (route) => route.fulfill({ json: statusPayload() }));
  await page.route(/\/api\/mihomo\/clash\/proxy-groups(?:\/.*)?$/, (route) => route.fulfill({ json: data }));
  await page.route('**/api/mihomo/clash/delay', async (route) => {
    const body = route.request().postDataJSON();
    probed.push(body.name);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await route.fulfill({ json: { ok: true, schema_version: 1, results: [{ name: body.name, delay_ms: 50 }] } });
  });
  await page.goto('/');
  await selectPanelView(page, 'mihomo');
  await page.evaluate(async () => {
    const mod = await (await import('xk-module/engine.mihomo')).load('clash');
    mod.activateMihomoClashWorkspace({ reason: 'e2e-complete-delay-queue' });
  });
  await page.locator('[data-group-name="AUTO"] .xk-mihomo-group-head').click();
  await page.locator('#mihomo-clash-test-visible').click();
  await expect(page.locator('#mihomo-clash-test-visible .xk-action-label')).toContainText(/Проверка \d+\/12/);
  await expect.poll(() => probed.length, { timeout: 10_000 }).toBe(12);
  await expect(page.locator('#mihomo-clash-test-visible .xk-action-label')).toHaveText('Тест видимых');
  expect(probed).toEqual(names);
});

test('visible delay test waits for the backend rolling limit instead of failing the remaining nodes', async ({ page }) => {
  const names = ['node-a', 'node-b'];
  const data = groupsPayload(names[0]);
  data.groups[0].nodes = names.map((name) => ({
    name, type: 'VLESS', alive: true, udp: true, provider: '', provider_candidates: [], delay_ms: null,
  }));
  let nodeBAttempts = 0;
  await page.route('**/api/mihomo/clash/status', (route) => route.fulfill({ json: statusPayload() }));
  await page.route(/\/api\/mihomo\/clash\/proxy-groups(?:\/.*)?$/, (route) => route.fulfill({ json: data }));
  await page.route('**/api/mihomo/clash/delay', async (route) => {
    const body = route.request().postDataJSON();
    if (body.name === 'node-b' && nodeBAttempts++ === 0) {
      return route.fulfill({
        status: 429,
        headers: { 'Retry-After': '0.001' },
        json: { ok: false, code: 'action_rate_limited', retry_after_seconds: 0.001 },
      });
    }
    return route.fulfill({ json: { ok: true, schema_version: 1, results: [{ name: body.name, delay_ms: 52 }] } });
  });

  await page.goto('/');
  await selectPanelView(page, 'mihomo');
  await page.evaluate(async () => {
    const mod = await (await import('xk-module/engine.mihomo')).load('clash');
    mod.activateMihomoClashWorkspace({ reason: 'e2e-delay-rate-limit' });
  });
  await page.locator('[data-group-name="AUTO"] .xk-mihomo-group-head').click();
  await page.locator('#mihomo-clash-test-visible').click();
  await expect(page.locator('[data-node-name="node-b"] .xk-mihomo-node-delay')).toHaveText('52 мс');
  expect(nodeBAttempts).toBe(2);
});

test('retryable Mihomo 503 reads as a node that did not answer, not a panel error', async ({ page }) => {
  const data = groupsPayload('node-a');
  data.groups[0].nodes = [{
    name: 'node-a', type: 'VLESS', alive: false, udp: true,
    provider: '', provider_candidates: [], delay_ms: 0,
  }];
  await page.route('**/api/mihomo/clash/status', (route) => route.fulfill({ json: statusPayload() }));
  await page.route(/\/api\/mihomo\/clash\/proxy-groups(?:\/.*)?$/, (route) => route.fulfill({ json: data }));
  await page.route('**/api/mihomo/clash/delay', (route) => route.fulfill({
    status: 502,
    json: {
      ok: false,
      code: 'upstream_http_error',
      retryable: true,
      upstream_status: 503,
    },
  }));

  await page.goto('/');
  await selectPanelView(page, 'mihomo');
  await page.evaluate(async () => {
    const mod = await (await import('xk-module/engine.mihomo')).load('clash');
    mod.activateMihomoClashWorkspace({ reason: 'e2e-delay-503-timeout' });
  });
  await page.locator('[data-group-name="AUTO"] .xk-mihomo-group-head').click();
  const latency = page.locator('[data-node-name="node-a"] .xk-mihomo-node-delay');
  await latency.click();
  // Nothing was measured — that is a fact about the node, so the badge stays
  // neutral (the icon variant) instead of shouting a red API error.
  await expect(latency).toHaveAttribute('data-delay-tone', 'unknown');
  await expect(latency.locator('.xk-visually-hidden')).toHaveText('нет ответа');
});


test('group delay probes unique nodes without group endpoint and reconciles the snapshot', async ({ page }) => {
  const data = groupsPayload();
  const requests = [];
  let groupReads = 0;
  await page.route('**/api/mihomo/clash/status', (route) => route.fulfill({ json: statusPayload() }));
  await page.route(/\/api\/mihomo\/clash\/proxy-groups(?:\/.*)?$/, (route) => {
    groupReads += 1;
    return route.fulfill({ json: data });
  });
  await page.route('**/api/mihomo/clash/delay', async (route) => {
    const body = route.request().postDataJSON();
    requests.push(body);
    return route.fulfill({
      json: {
        ok: true,
        schema_version: 1,
        results: [{
          name: body.name,
          delay_ms: body.name === 'node-a' ? 51 : body.name === 'node-b' ? 0 : 7,
        }],
        effective_preset: 'auto',
        fallback_used: false,
      },
    });
  });

  await page.goto('/');
  await selectPanelView(page, 'mihomo');
  await page.evaluate(async () => {
    const mod = await (await import('xk-module/engine.mihomo')).load('clash');
    mod.activateMihomoClashWorkspace({ reason: 'e2e-group-delay-batch' });
  });
  await page.locator('[data-group-name="AUTO"] .xk-mihomo-group-head').click();
  const readsBeforeTest = groupReads;
  await page.locator('[data-group-name="AUTO"] .xk-mihomo-group-test').click();

  await expect(page.locator('[data-node-name="node-a"] .xk-mihomo-node-delay')).toHaveText('51 мс');
  const silent = page.locator('[data-node-name="node-b"] .xk-mihomo-node-delay');
  await expect(silent).toHaveAttribute('data-delay-tone', 'unknown');
  await expect(silent.locator('.xk-visually-hidden')).toHaveText('нет ответа');
  await expect(page.locator('[data-node-name="DIRECT"] .xk-mihomo-node-delay')).toHaveCount(0);
  const resultToast = page.locator('#toast-container .toast');
  await expect(resultToast).toContainText('Успешно: 1');
  await expect(resultToast).toContainText('Без ответа: 1');
  // A node that stayed silent is an ordinary outcome, so the run itself
  // succeeded; only a failed request would colour this warning.
  await expect(resultToast).toHaveClass(/toast-success/);
  const toastBox = await resultToast.boundingBox();
  expect(toastBox?.y).toBeLessThan(80);
  await expect(page.locator('#mihomo-clash-delay-summary')).toHaveCount(0);
  await expect.poll(() => groupReads).toBeGreaterThan(readsBeforeTest);
  // A batch asks the core to give up early, the way Zashboard does.
  expect(requests).toEqual([
    { scope: 'proxy', name: 'node-a', preset: 'auto', timeout_ms: 2000 },
    { scope: 'provider-proxy', name: 'node-b', provider: 'provider-one', preset: 'auto', timeout_ms: 2000 },
  ]);
  await expect(resultToast).toHaveCount(0, { timeout: 7_000 });
});


test('nested group card probes itself and falls back to its selected terminal proxy', async ({ page }) => {
  const data = groupsPayload();
  data.groups = [
    {
      name: 'YouTube',
      type: 'Selector',
      now: 'Blocked services',
      fixed: '',
      hidden: false,
      selectable: true,
      nodes: [{
        name: 'Blocked services', type: 'Selector', alive: true, udp: true,
        provider: '', provider_candidates: [], delay_ms: null, delay_history: [],
      }],
    },
    {
      name: 'Blocked services',
      type: 'Selector',
      now: 'XXX Germany.98.1016',
      fixed: '',
      hidden: false,
      selectable: true,
      nodes: [{
        name: 'XXX Germany.98.1016', type: 'VLESS', alive: true, udp: true,
        provider: '', provider_candidates: [], delay_ms: null, delay_history: [],
      }],
    },
  ];
  const requests = [];
  await page.route('**/api/mihomo/clash/status', (route) => route.fulfill({ json: statusPayload() }));
  await page.route(/\/api\/mihomo\/clash\/proxy-groups(?:\/.*)?$/, (route) => route.fulfill({ json: data }));
  await page.route('**/api/mihomo/clash/delay', async (route) => {
    const body = route.request().postDataJSON();
    requests.push(body);
    await route.fulfill({
      json: {
        ok: true,
        schema_version: 1,
        results: [{ name: body.name, delay_ms: 205 }],
      },
    });
  });

  await page.goto('/');
  await selectPanelView(page, 'mihomo');
  await page.evaluate(async () => {
    const mod = await (await import('xk-module/engine.mihomo')).load('clash');
    mod.activateMihomoClashWorkspace({ reason: 'e2e-nested-group-delay' });
  });
  await page.locator('[data-group-name="Blocked services"] .xk-mihomo-group-head').click();
  await page.locator('[data-group-name="Blocked services"] .xk-mihomo-group-test').click();
  await expect(page.locator(
    '[data-group-name="Blocked services"] [data-node-name="XXX Germany.98.1016"] .xk-mihomo-node-delay',
  )).toHaveText('205 мс');

  await page.locator('[data-group-name="YouTube"] .xk-mihomo-group-head').click();
  const nestedProbe = page.locator(
    '[data-group-name="YouTube"] [data-node-name="Blocked services"] .xk-mihomo-node-delay',
  );
  await expect(nestedProbe).toHaveText('205 мс');
  await nestedProbe.hover();
  await expect(page.locator('#mihomo-clash-delay-history-popover')).toContainText('205 мс');
  await page.locator('[data-group-name="YouTube"] .xk-mihomo-group-test').click();
  await expect(page.locator('#toast-container .toast')).toContainText('Успешно: 1');
  expect(requests).toEqual([
    { scope: 'proxy', name: 'XXX Germany.98.1016', preset: 'auto' },
    { scope: 'proxy', name: 'Blocked services', preset: 'auto' },
  ]);
});


test('visible delay de-duplicates the same provider node across expanded groups', async ({ page }) => {
  const data = groupsPayload();
  data.groups.push({
    name: 'DUPLICATE',
    type: 'Selector',
    now: 'node-a',
    fixed: '',
    hidden: false,
    selectable: true,
    nodes: data.groups[0].nodes.map((node) => ({ ...node })),
  });
  const requests = [];
  await page.route('**/api/mihomo/clash/status', (route) => route.fulfill({ json: statusPayload() }));
  await page.route(/\/api\/mihomo\/clash\/proxy-groups(?:\/.*)?$/, (route) => route.fulfill({ json: data }));
  await page.route('**/api/mihomo/clash/delay', async (route) => {
    const body = route.request().postDataJSON();
    requests.push(body);
    return route.fulfill({ json: { ok: true, results: [{ name: body.name, delay_ms: 45 }] } });
  });

  await page.goto('/');
  await selectPanelView(page, 'mihomo');
  await page.evaluate(async () => {
    const mod = await (await import('xk-module/engine.mihomo')).load('clash');
    mod.activateMihomoClashWorkspace({ reason: 'e2e-visible-delay-deduplication' });
  });
  await page.locator('[data-group-name="AUTO"] .xk-mihomo-group-head').click();
  await page.locator('[data-group-name="DUPLICATE"] .xk-mihomo-group-head').click();
  await page.locator('#mihomo-clash-test-visible').click();

  await expect(page.locator('#toast-container .toast')).toContainText('Успешно: 2');
  expect(requests).toHaveLength(2);
  expect(requests.filter((item) => item.name === 'node-b')).toEqual([
    { scope: 'provider-proxy', name: 'node-b', provider: 'provider-one', preset: 'auto', timeout_ms: 2000 },
  ]);
  await expect(page.locator('[data-node-name="node-b"] .xk-mihomo-node-delay')).toHaveText(['45 мс', '45 мс']);
});


test('group delay test keeps shared node progress inside the selected group', async ({ page }) => {
  const data = groupsPayload();
  data.groups.push({
    name: 'DUPLICATE',
    type: 'Selector',
    now: 'node-a',
    fixed: '',
    hidden: false,
    selectable: true,
    nodes: data.groups[0].nodes.map((node) => ({ ...node })),
  });
  await page.route('**/api/mihomo/clash/status', (route) => route.fulfill({ json: statusPayload() }));
  await page.route(/\/api\/mihomo\/clash\/proxy-groups(?:\/.*)?$/, (route) => route.fulfill({ json: data }));
  // The answers wait until the test has seen the probe in progress: a fixed
  // pause let a loaded machine finish the probe before it was looked at.
  let answerProbes;
  const probesAnswered = new Promise((resolve) => { answerProbes = resolve; });
  await page.route('**/api/mihomo/clash/delay', async (route) => {
    const body = route.request().postDataJSON();
    await probesAnswered;
    await route.fulfill({ json: { ok: true, schema_version: 1, results: [{ name: body.name, delay_ms: 50 }] } });
  });

  await page.goto('/');
  await selectPanelView(page, 'mihomo');
  await page.evaluate(async () => {
    const mod = await (await import('xk-module/engine.mihomo')).load('clash');
    mod.activateMihomoClashWorkspace({ reason: 'e2e-group-delay-scope' });
  });
  await expect(page.locator('#mihomo-clash-groups-list')).toContainText('AUTO');
  await page.locator('[data-group-name="AUTO"] .xk-mihomo-group-head').click();
  await page.locator('[data-group-name="DUPLICATE"] .xk-mihomo-group-head').click();
  await page.locator('[data-group-name="AUTO"] .xk-mihomo-group-test').click();

  await expect(page.locator('[data-group-name="AUTO"] [data-node-name="node-a"] .xk-mihomo-node-probe')).toHaveClass(/is-pending/);
  await expect(page.locator('[data-group-name="DUPLICATE"] [data-node-name="node-a"] .xk-mihomo-node-probe')).not.toHaveClass(/is-pending/);
  await expect(page.locator('[data-group-name="AUTO"] .xk-mihomo-group-test')).toHaveAttribute('data-mihomo-delay-testing', 'true');
  await expect(page.locator('[data-group-name="DUPLICATE"] .xk-mihomo-group-test')).not.toHaveAttribute('data-mihomo-delay-testing', 'true');
  answerProbes();
  await expect(page.locator('[data-group-name="AUTO"] [data-node-name="node-a"] .xk-mihomo-node-delay')).toHaveText('50 мс');
  await expect(page.locator('[data-group-name="DUPLICATE"] [data-node-name="node-a"] .xk-mihomo-node-delay')).toHaveText('50 мс');
});


test('automatic fixed group shows lock, unfix action and sorting', async ({ page }) => {
  let fixed = 'hidden-node';
  await page.route('**/api/mihomo/clash/status', (route) => route.fulfill({ json: statusPayload() }));
  await page.route(/\/api\/mihomo\/clash\/proxy-groups(?:\/.*)?$/, async (route) => {
    if (route.request().method() === 'DELETE') {
      fixed = '';
      return route.fulfill({ json: { ok: true, schema_version: 1, group: { ...groupsPayload('hidden-node', '', true).groups[1], fixed: '' }, reconciled: true, connections: { disconnected: 0, failed: 0 } } });
    }
    return route.fulfill({ json: groupsPayload('node-a', fixed, true) });
  });

  await page.goto('/');
  await selectPanelView(page, 'mihomo');
  // Операторская шапка переносит переключатели групп в меню «Параметры» уже
  // после отрисовки вкладки и закрывает меню, если открыть его раньше. Ждём,
  // пока переключатель окажется внутри меню, а не спим наугад.
  await setHiddenGroupsVisible(page);
  await page.keyboard.press('Escape');
  await page.locator('[data-group-name="HIDDEN"] .xk-mihomo-group-head').click();
  await page.locator('[data-group-name="FALLBACK"] .xk-mihomo-group-head').click();
  await expect(page.locator('[data-group-name="HIDDEN"]')).toContainText('Зафиксирован: hidden-node');
  await expect(page.locator('[data-node-name="hidden-node"]')).toHaveClass(/is-fixed/);
  await expect(page.locator('[data-group-name="FALLBACK"] [data-node-name="node-b"]')).toHaveClass(/is-current/);
  await expect(page.locator('[data-group-name="FALLBACK"] [data-node-name="node-b"]')).not.toHaveClass(/is-fixed/);
  await expect(page.locator('[data-group-name="FALLBACK"] [data-node-name="node-a"]')).toHaveClass(/is-fixed/);
  await expect(page.locator('[data-group-name="FALLBACK"] [data-node-name="node-a"]')).not.toHaveClass(/is-current/);
  await page.locator('[data-group-name="FALLBACK"] .xk-mihomo-group-head').click();
  await expect(page.locator('[data-group-name="HIDDEN"] [data-mihomo-group-unfix]')).toBeVisible();
  await page.locator('[data-group-name="HIDDEN"] [data-mihomo-group-unfix]').click();
  await expect(page.locator('#confirm-modal-title')).toContainText('Вернуть автоматический выбор');
  await page.locator('#confirm-modal-ok-btn').click();
  await expect(page.locator('[data-group-name="HIDDEN"] [data-mihomo-group-unfix]')).toHaveCount(0);

  await openMihomoGroupsMenu(page);
  await page.locator('#mihomo-clash-groups-sort').selectOption('name');
  await page.keyboard.press('Escape');
  await page.locator('[data-group-name="AUTO"] .xk-mihomo-group-head').click();
  await expect(page.locator('[data-group-name="AUTO"] .xk-mihomo-node-row').first()).toHaveAttribute('data-node-name', 'node-a');
});


test('sorting keeps service nodes in config slots and workspace settings persist via UI settings', async ({ page }) => {
  const data = groupsPayload();
  data.groups[0].nodes = [
    { name: 'z-node', type: 'VLESS', alive: true, provider: '', provider_candidates: [], delay_ms: 40 },
    { name: 'DIRECT', type: 'Direct', alive: true, provider: '', provider_candidates: [], delay_ms: null },
    { name: 'b-node', type: 'Trojan', alive: true, provider: '', provider_candidates: [], delay_ms: 70 },
    { name: 'a-node', type: 'Trojan', alive: true, provider: '', provider_candidates: [], delay_ms: 90 },
  ];
  data.groups[0].now = 'z-node';
  const settings = {
    schemaVersion: 2,
    editor: {}, format: {}, logs: { view: {} }, routing: {},
    mihomo: {
      hideUnavailable: false,
      consecutiveTimeouts: 3,
      proxySortOrder: 'name',
      collapsedGroups: { AUTO: false },
      latencyPreset: 'cloudflare',
    },
  };
  const patches = [];
  await page.route('**/api/ui-settings', async (route) => {
    if (route.request().method() === 'PATCH') {
      const patch = route.request().postDataJSON();
      patches.push(patch);
      Object.assign(settings.mihomo, patch.mihomo || {});
    }
    return route.fulfill({ json: { ok: true, settings } });
  });
  await page.route('**/api/mihomo/clash/status', (route) => route.fulfill({ json: statusPayload() }));
  await page.route(/\/api\/mihomo\/clash\/proxy-groups(?:\/.*)?$/, (route) => route.fulfill({ json: data }));

  await page.goto('/');
  await selectPanelView(page, 'mihomo');
  await openMihomoGroupsMenu(page);
  await expect(page.locator('#mihomo-clash-groups-sort')).toHaveValue('name');
  await expect(page.locator('#mihomo-clash-latency-preset')).toHaveValue('cloudflare');
  await expect(page.locator('[data-group-name="AUTO"] .xk-mihomo-group-head')).toHaveAttribute('aria-expanded', 'true');
  expect(await page.locator('[data-group-name="AUTO"] .xk-mihomo-node-row').evaluateAll(
    (nodes) => nodes.map((node) => node.dataset.nodeName),
  )).toEqual(['z-node', 'DIRECT', 'a-node', 'b-node']);
  await page.locator('#mihomo-clash-groups-sort').selectOption('delay');
  await page.locator('#mihomo-clash-latency-preset').selectOption('google');
  await expect.poll(() => patches.some((patch) => patch.mihomo?.proxySortOrder === 'delay')).toBe(true);
  await expect.poll(() => patches.some((patch) => patch.mihomo?.latencyPreset === 'google')).toBe(true);
  await page.locator('#mihomo-clash-latency-preset').selectOption('yandex');
  await expect.poll(() => patches.some((patch) => patch.mihomo?.latencyPreset === 'yandex')).toBe(true);
  await page.locator('#mihomo-clash-latency-preset').selectOption('all');
  await expect.poll(() => patches.some((patch) => patch.mihomo?.latencyPreset === 'all')).toBe(true);
});


test('LoadBalance cannot be selected but API fixed state can be removed', async ({ page }) => {
  const data = groupsPayload();
  data.groups[0] = {
    ...data.groups[0],
    type: 'LoadBalance',
    fixed: 'node-a',
  };
  let fixed = 'node-a';
  const selections = [];
  await page.route('**/api/mihomo/clash/status', (route) => route.fulfill({ json: statusPayload() }));
  await page.route(/\/api\/mihomo\/clash\/proxy-groups(?:\/.*)?$/, async (route) => {
    if (route.request().method() === 'PUT') selections.push(route.request().postDataJSON());
    if (route.request().method() === 'DELETE') fixed = '';
    const group = { ...data.groups[0], fixed };
    return route.fulfill({ json: route.request().method() === 'GET'
      ? { ...data, groups: [group, ...data.groups.slice(1)] }
      : { ok: true, schema_version: 1, group, reconciled: !fixed, connections: { disconnected: 0, failed: 0 } } });
  });

  await page.goto('/');
  await selectPanelView(page, 'mihomo');
  await expect(page.locator('[data-group-name="AUTO"] [data-mihomo-picker-toggle]')).toHaveAttribute('disabled', '');
  await page.locator('[data-group-name="AUTO"] .xk-mihomo-group-head').click();
  await expect(page.locator('[data-group-name="AUTO"] [data-mihomo-group-select][data-node="node-b"]')).toHaveAttribute('disabled', '');
  expect(selections).toEqual([]);
  await page.locator('[data-group-name="AUTO"] [data-mihomo-group-unfix]').click();
  await page.locator('#confirm-modal-ok-btn').click();
  await expect(page.locator('[data-group-name="AUTO"] [data-mihomo-group-unfix]')).toHaveCount(0);
});


test('timeout hiding uses Mihomo history across groups and restores a node after success', async ({ page }) => {
  let recovered = false;
  const timeoutHistory = [
    { measured_at: '2026-08-16T10:15:20Z', delay_ms: 70 },
    { measured_at: '2026-08-16T10:15:21Z', delay_ms: 0 },
    { measured_at: '2026-08-16T10:15:22Z', delay_ms: 0 },
    { measured_at: '2026-08-16T10:15:23Z', delay_ms: 0 },
  ];
  const timeoutNode = (provider = 'provider-one') => ({
    name: 'shared-timeout', type: 'VLESS', alive: false, udp: true, provider,
    provider_candidates: provider ? [provider] : [], delay_ms: recovered ? 48 : 0,
    delay_history: recovered
      ? [...timeoutHistory, { measured_at: '2026-08-16T10:15:24Z', delay_ms: 48 }]
      : timeoutHistory,
  });
  const currentTimeoutNode = () => ({
    name: 'current-timeout', type: 'Trojan', alive: false, udp: true, provider: '',
    provider_candidates: [], delay_ms: 0, delay_history: timeoutHistory,
  });
  const fixedTimeoutNode = () => ({
    name: 'fixed-timeout', type: 'Trojan', alive: false, udp: true, provider: '',
    provider_candidates: [], delay_ms: 0, delay_history: timeoutHistory,
  });
  const payloadWithHistory = () => ({
    ok: true,
    schema_version: 1,
    truncated: false,
    groups: [
      {
        name: 'AUTO', type: 'Selector', now: 'current-timeout', fixed: '', hidden: false, selectable: true,
        nodes: [currentTimeoutNode(), timeoutNode(), { name: 'healthy', type: 'VLESS', alive: true, provider: '', provider_candidates: [], delay_ms: 20, delay_history: [{ measured_at: '2026-08-16T10:15:23Z', delay_ms: 20 }] }],
      },
      {
        name: 'FALLBACK', type: 'Fallback', now: 'healthy', fixed: 'fixed-timeout', hidden: false, selectable: true,
        nodes: [timeoutNode(), fixedTimeoutNode(), { name: 'healthy', type: 'VLESS', alive: true, provider: '', provider_candidates: [], delay_ms: 20, delay_history: [{ measured_at: '2026-08-16T10:15:23Z', delay_ms: 20 }] }],
      },
    ],
  });

  await page.route('**/api/ui-settings', async (route) => {
    const settings = {
      schemaVersion: 2,
      editor: {}, format: {}, logs: { view: {} }, routing: {},
      mihomo: { hideUnavailable: true, consecutiveTimeouts: 3 },
    };
    return route.fulfill({ json: { ok: true, settings } });
  });
  await page.route('**/api/mihomo/clash/status', (route) => route.fulfill({ json: statusPayload() }));
  await page.route(/\/api\/mihomo\/clash\/proxy-groups(?:\/.*)?$/, (route) => route.fulfill({ json: payloadWithHistory() }));
  await page.route('**/api/mihomo/clash/delay', async (route) => {
    recovered = true;
    return route.fulfill({ json: { ok: true, schema_version: 1, results: [{ name: 'shared-timeout', delay_ms: 48 }] } });
  });

  await page.goto('/');
  await selectPanelView(page, 'mihomo');
  await expect(page.locator('#mihomo-clash-groups-list')).toContainText('AUTO');
  await page.locator('[data-group-name="AUTO"] .xk-mihomo-group-head').click();
  await page.locator('[data-group-name="FALLBACK"] .xk-mihomo-group-head').click();

  await expect(page.locator('[data-node-name="shared-timeout"]')).toHaveCount(0);
  await expect(page.locator('[data-group-name="AUTO"] [data-node-name="current-timeout"]')).toHaveCount(1);
  await expect(page.locator('[data-group-name="FALLBACK"] [data-node-name="fixed-timeout"]')).toHaveCount(1);
  await expect(page.locator('#mihomo-clash-show-timeout-hidden')).toHaveText(/Скрыто:\s*1/);

  await page.locator('#mihomo-clash-show-timeout-hidden').click();
  await expect(page.locator('[data-node-name="shared-timeout"]')).toHaveCount(2);
  await page.locator('[data-group-name="AUTO"] [data-mihomo-node-delay][data-node="shared-timeout"]').click();
  await expect(page.locator('[data-group-name="AUTO"] [data-node-name="shared-timeout"] .xk-mihomo-node-delay')).toHaveText('48 мс');

  await expect(page.locator('[data-node-name="shared-timeout"]')).toHaveCount(2);
  await expect(page.locator('#mihomo-clash-show-timeout-hidden')).toBeHidden();
});


test('Mihomo group disclosures keep the workspace compact and keyboard accessible', async ({ page }) => {
  await page.route('**/api/mihomo/clash/status', (route) => route.fulfill({ json: statusPayload() }));
  await page.route(/\/api\/mihomo\/clash\/proxy-groups(?:\/.*)?$/, (route) => route.fulfill({ json: groupsPayload() }));
  await page.route('**/api/mihomo/clash/delay', (route) => route.fulfill({
    status: 502,
    json: { ok: false, code: 'upstream_unreachable' },
  }));

  await page.goto('/');
  await selectPanelView(page, 'mihomo');
  await page.evaluate(async () => {
    const mod = await (await import('xk-module/engine.mihomo')).load('clash');
    mod.activateMihomoClashWorkspace({ reason: 'e2e' });
  });
  await expect(page.locator('#mihomo-clash-groups-list')).toContainText('AUTO');

  const hiddenToggle = page.locator('[data-group-name="HIDDEN"] .xk-mihomo-group-head');
  await setHiddenGroupsVisible(page);
  await page.keyboard.press('Escape');
  await expect(hiddenToggle).toHaveAttribute('aria-expanded', 'false');
  await hiddenToggle.focus();
  await hiddenToggle.press('Enter');
  await expect(hiddenToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('[data-group-name="HIDDEN"] .xk-mihomo-group-body')).toBeVisible();
  await expect(page.locator('[data-group-name="HIDDEN"] .xk-mihomo-node-alive')).toHaveCount(0);
  await expect(page.locator('[data-group-name="HIDDEN"] .xk-mihomo-node-head')).toHaveCount(0);
  await page.locator('[data-group-name="AUTO"] .xk-mihomo-group-head').click();
  const expandedGrid = await page.locator('[data-group-name="HIDDEN"] .xk-mihomo-node-list').evaluate((list) => ({
    columns: getComputedStyle(list).gridTemplateColumns.split(' ').length,
    gap: getComputedStyle(list).gap,
    transparentCanvas: getComputedStyle(list).backgroundColor === 'rgba(0, 0, 0, 0)',
    pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  }));
  expect(expandedGrid).toEqual({ columns: 5, gap: '8px', transparentCanvas: true, pageOverflow: false });
  const nodeCard = await page.locator('[data-group-name="HIDDEN"] .xk-mihomo-node-row').evaluate((row) => ({
    radius: getComputedStyle(row).borderRadius,
    minHeight: getComputedStyle(row).minHeight,
    hasSelectionDot: !!row.querySelector('.xk-mihomo-node-marker'),
  }));
  expect(nodeCard).toEqual({ radius: '6px', minHeight: '82px', hasSelectionDot: false });
  await expect(page.locator('[data-node-name="node-b"] .xk-mihomo-node-probe')).toHaveCount(1);
  await expect(page.locator('[data-node-name="node-b"] .xk-mihomo-node-delay')).toHaveText('не ответил на фоновой проверке');
  await expect(page.locator('[data-node-name="node-b"] .xk-mihomo-node-delay')).toHaveAttribute('data-delay-tone', 'unavailable');
  await expect(page.locator('[data-node-name="node-b"] .xk-mihomo-node-delay use')).toHaveAttribute('href', /#xk-server-off$/);
  await expect(page.locator('[data-node-name="node-b"] .xk-mihomo-node-delay')).toHaveAttribute(
    'aria-label',
    /не ответил на фоновой проверке/,
  );
  await expect(page.locator('[data-node-name="node-b"] .xk-mihomo-node-delay')).toHaveAttribute(
    'data-tooltip',
    'Фоновая проверка ядра не получила ответ от узла. Нажмите, чтобы проверить сейчас.',
  );
  const unavailablePlacement = await page.locator('[data-node-name="node-b"]').evaluate((card) => {
    const cardBox = card.getBoundingClientRect();
    const probeBox = card.querySelector('.xk-mihomo-node-probe')?.getBoundingClientRect();
    return probeBox ? {
      rightInset: Math.round(cardBox.right - probeBox.right),
      bottomInset: Math.round(cardBox.bottom - probeBox.bottom),
      iconOnlyWidth: Math.round(probeBox.width),
    } : null;
  });
  expect(unavailablePlacement).toEqual({ rightInset: 9, bottomInset: 7, iconOnlyWidth: 24 });
  await expect(page.locator('[data-node-name="node-b"] .xk-mihomo-node-unavailable')).toHaveCount(0);
  await page.locator('[data-node-name="node-b"] .xk-mihomo-node-delay').click();
  await expect(page.locator('[data-node-name="node-b"] .xk-mihomo-node-delay')).toHaveText('API недоступен');
  await expect(page.locator('[data-node-name="node-b"] .xk-mihomo-node-delay')).toHaveAttribute('data-delay-tone', 'failed');
  await expect(page.locator('[data-node-name="node-b"] .xk-mihomo-node-delay use')).toHaveAttribute('href', /#xk-alert$/);
  await expect(page.locator('[data-node-name="node-b"] .xk-mihomo-node-delay')).toHaveAttribute(
    'aria-label',
    /API недоступен/,
  );
  await expect(page.locator('[data-node-name="node-b"] .xk-mihomo-node-delay')).toHaveAttribute(
    'data-tooltip',
    'Mihomo API недоступен. Нажмите, чтобы повторить.',
  );

  await page.locator('#mihomo-clash-groups-collapse').click();
  await expect(page.locator('.xk-mihomo-group-head[aria-expanded="true"]')).toHaveCount(0);
  await expect(page.locator('#mihomo-clash-test-visible')).toBeDisabled();
  await page.locator('#mihomo-clash-groups-collapse').click();
  await expect(page.locator('.xk-mihomo-group-head[aria-expanded="true"]')).toHaveCount(2);

  await page.locator('[aria-controls="xk-mihomo-parameters-menu"]').click();
  await openMihomoConfig(page);
  await expect(page.locator('#mihomo-clash-panel-config')).toBeVisible();
  await expect(page.locator('#mihomo-clash-runtime')).toBeHidden();
});

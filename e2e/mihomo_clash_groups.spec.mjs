import { test, expect } from './fixtures.mjs';


function statusPayload() {
  return {
    ok: true,
    state: 'ready',
    schema_version: 1,
    core: { version: 'Mihomo Meta v1.19.29' },
    runtime: { mode: 'rule' },
    capabilities: { status: true, proxy_groups: true, proxy_select: true, proxy_unfix: true, proxy_delay: true, connection_disconnect: true },
  };
}


function groupsPayload(now = 'node-a', fixed = '', includeReliabilityFixture = false) {
  return {
    ok: true,
    schema_version: 1,
    truncated: false,
    providers: [{ name: 'provider-one', type: 'Proxy', node_count: 1 }],
    groups: [
      {
        name: 'AUTO',
        type: 'Selector',
        now,
        fixed,
        hidden: false,
        selectable: true,
        nodes: [
          { name: 'node-a', type: 'VLESS', alive: true, udp: true, provider: '', provider_candidates: [], delay_ms: 82, server: 'edge.example.test', port: 443, network: 'xhttp', security: 'tls', host: 'cdn.example.test', path: '/api/v2/' },
          { name: 'node-b', type: 'Trojan', alive: false, udp: true, provider: 'provider-one', provider_candidates: ['provider-one'], delay_ms: 999 },
          { name: 'DIRECT', type: 'Direct', alive: true, udp: true, provider: '', provider_candidates: [], delay_ms: null },
        ],
      },
      {
        name: 'HIDDEN',
        type: 'URLTest',
        now: 'hidden-node',
        fixed: 'hidden-node',
        hidden: true,
        selectable: true,
        nodes: [{ name: 'hidden-node', type: 'VLESS', alive: null, udp: null, provider: '', provider_candidates: [], delay_ms: null }],
      },
      ...(includeReliabilityFixture ? [{
        name: 'FALLBACK',
        type: 'Fallback',
        now: 'node-b',
        fixed: 'node-a',
        hidden: false,
        selectable: true,
        nodes: [
          { name: 'node-a', type: 'VLESS', alive: true, udp: true, provider: '', provider_candidates: [], delay_ms: 120 },
          { name: 'node-b', type: 'Trojan', alive: true, udp: true, provider: '', provider_candidates: [], delay_ms: 80 },
        ],
      }] : []),
    ],
  };
}


function egressPayload(cached = false) {
  return {
    ok: true,
    schema_version: 1,
    route_scope: 'mihomo_proxy',
    lookup_host: 'ipapi.co',
    ip: '198.51.100.25',
    ip_version: 'IPv4',
    city: 'Helsinki',
    region: 'Uusimaa',
    country: 'Finland',
    country_code: 'FI',
    asn: 'AS64500',
    organization: 'Example Network',
    timezone: 'Europe/Helsinki',
    cached,
  };
}


test('Mihomo egress card shows routed IP, refreshes and stays compact on mobile', async ({ page }) => {
  const egressRequests = [];
  await page.route('**/api/mihomo/clash/status', (route) => route.fulfill({ json: statusPayload() }));
  await page.route(/\/api\/mihomo\/clash\/proxy-groups(?:\/.*)?$/, (route) => route.fulfill({ json: groupsPayload() }));
  await page.route('**/api/mihomo/clash/egress-info*', (route) => {
    egressRequests.push(route.request().url());
    return route.fulfill({ json: egressPayload(egressRequests.length > 1) });
  });

  await page.goto('/');
  await page.evaluate(() => localStorage.removeItem('xkeen:mihomo-clash-egress-visible'));
  await page.reload();
  await page.locator('.top-tab-btn[data-view="mihomo"]').click();
  await page.evaluate(async () => {
    const mod = await import('/static/js/features/mihomo_clash/index.js');
    mod.activateMihomoClashWorkspace({ reason: 'e2e-egress-card' });
  });

  await expect(page.locator('#mihomo-clash-egress-toggle')).toBeVisible();
  await expect(page.locator('#mihomo-clash-egress-toggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#mihomo-clash-egress')).toBeHidden();
  expect(egressRequests).toHaveLength(0);

  await page.locator('#mihomo-clash-egress-toggle').click();
  await expect(page.locator('#mihomo-clash-egress-toggle')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#mihomo-clash-egress')).toBeVisible();
  await expect(page.locator('#mihomo-clash-egress-ip')).toHaveText('198.51.100.25');
  await expect(page.locator('#mihomo-clash-egress-country')).toHaveText('FI');
  await expect(page.locator('#mihomo-clash-egress-location')).toHaveText('Helsinki, Uusimaa, Finland');
  await expect(page.locator('#mihomo-clash-egress-provider')).toHaveText('Example Network');
  await expect(page.locator('#mihomo-clash-egress-asn')).toHaveText('AS64500');
  await expect(page.locator('#mihomo-clash-egress-timezone')).toHaveText('Europe/Helsinki');
  await expect(page.locator('#mihomo-clash-egress-notice')).toContainText('ipapi.co');

  const desktopColumns = await page.locator('.xk-mihomo-egress-details').evaluate(
    (details) => getComputedStyle(details).gridTemplateColumns.split(' ').length,
  );
  expect(desktopColumns).toBe(2);

  await page.locator('#mihomo-clash-egress-refresh').click();
  await expect.poll(() => egressRequests.filter((url) => url.includes('refresh=1')).length).toBe(1);
  await expect(page.locator('#mihomo-clash-egress-version')).toContainText('кэш');

  expect(await page.evaluate(() => localStorage.getItem('xkeen:mihomo-clash-egress-visible'))).toBe('1');
  await page.reload();
  await page.locator('.top-tab-btn[data-view="mihomo"]').click();
  await page.evaluate(async () => {
    const mod = await import('/static/js/features/mihomo_clash/index.js');
    mod.activateMihomoClashWorkspace({ reason: 'e2e-egress-persisted' });
  });
  await expect(page.locator('#mihomo-clash-egress-toggle')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#mihomo-clash-egress')).toBeVisible();
  await expect(page.locator('#mihomo-clash-egress-ip')).toHaveText('198.51.100.25');

  await page.setViewportSize({ width: 430, height: 800 });
  const mobileLayout = await page.locator('.xk-mihomo-egress-details').evaluate((details) => ({
    columns: getComputedStyle(details).gridTemplateColumns.split(' ').length,
    pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  }));
  expect(mobileLayout).toEqual({ columns: 1, pageOverflow: false });
});


test('Mihomo groups workspace filters, confirms selection and uses provider delay scope', async ({ page }) => {
  let current = 'node-a';
  const selections = [];
  const delays = [];
  await page.route('**/api/mihomo/clash/status', (route) => route.fulfill({ json: statusPayload() }));
  await page.route(/\/api\/mihomo\/clash\/proxy-groups(?:\/.*)?$/, async (route) => {
    const request = route.request();
    if (request.method() === 'PUT') {
      const data = request.postDataJSON();
      current = data.name;
      selections.push(data.name);
      await route.fulfill({ json: { ok: true, schema_version: 1, group: groupsPayload(current).groups[0], reconciled: true } });
      return;
    }
    if (request.method() === 'DELETE') {
      current = 'hidden-node';
      await route.fulfill({ json: { ok: true, schema_version: 1, group: { ...groupsPayload(current, '').groups[1], fixed: '' }, reconciled: true, connections: { disconnected: 0, failed: 0 } } });
      return;
    }
    await route.fulfill({ json: groupsPayload(current) });
  });
  await page.route('**/api/mihomo/clash/delay', async (route) => {
    const data = route.request().postDataJSON();
    delays.push(data);
    // Keep the mocked request pending long enough to assert the transient
    // loading icon without racing a fast local route fulfilment.
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.fulfill({ json: { ok: true, schema_version: 1, results: [{ name: data.name, delay_ms: 44 }] } });
  });

  await page.goto('/');
  await page.locator('.top-tab-btn[data-view="mihomo"]').click();
  await page.evaluate(async () => {
    const mod = await import('/static/js/features/mihomo_clash/index.js');
    mod.activateMihomoClashWorkspace({ reason: 'e2e' });
  });
  await expect(page.locator('#mihomo-clash-groups-list')).toContainText('AUTO');
  await expect(page.locator('#mihomo-clash-groups-list')).not.toContainText('HIDDEN');
  await expect(page.locator('[data-group-name="AUTO"] [data-mihomo-group-toggle]')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('[data-group-name="AUTO"] .xk-mihomo-group-test')).toHaveCount(0);
  await expect(page.locator('#mihomo-clash-groups-collapse')).toHaveText('Развернуть');
  await expect(page.locator('#mihomo-clash-test-visible')).toBeDisabled();
  const collapseGeometry = await page.locator('#mihomo-clash-groups-collapse').evaluate((button) => {
    const icon = button.querySelector('.xk-action-icon');
    const label = button.querySelector('span:not(.xk-action-icon)');
    const iconBox = icon?.getBoundingClientRect();
    const labelBox = label?.getBoundingClientRect();
    return {
      iconFlexShrink: icon ? getComputedStyle(icon).flexShrink : null,
      labelRightOfIcon: !!iconBox && !!labelBox && labelBox.left >= iconBox.right,
      verticallyAligned: !!iconBox && !!labelBox
        && Math.abs((iconBox.top + iconBox.height / 2) - (labelBox.top + labelBox.height / 2)) <= 1,
    };
  });
  expect(collapseGeometry).toEqual({
    iconFlexShrink: '0',
    labelRightOfIcon: true,
    verticallyAligned: true,
  });

  await page.locator('[data-group-name="AUTO"] [data-mihomo-group-toggle]').click();
  await expect(page.locator('[data-group-name="AUTO"] .xk-mihomo-group-test')).toBeVisible();
  await expect(page.locator('[data-node-name="node-a"]')).toContainText('VLESS · xhttp · tls');
  await expect(page.locator('[data-node-name="node-a"]')).toContainText('edge.example.test:443');
  await expect(page.locator('[data-node-name="node-a"] .xk-mihomo-node-main')).toHaveAttribute(
    'data-tooltip',
    'edge.example.test:443 · path=/api/v2/ · host=cdn.example.test',
  );
  await page.locator('[data-group-name="AUTO"] .xk-mihomo-node-row').evaluateAll((nodes) => {
    nodes.forEach((node, index) => { node.dataset.renderIdentity = String(index); });
  });
  await page.locator('[data-mihomo-node-delay][data-node="node-a"]').click();
  await expect(page.locator('[data-node-name="node-a"] .xk-mihomo-node-probe')).toHaveClass(/is-pending/);
  expect(await page.locator('[data-group-name="AUTO"] .xk-mihomo-node-row').evaluateAll(
    (nodes) => nodes.map((node, index) => node.dataset.renderIdentity === String(index)),
  )).toEqual([true, true, true]);
  expect(await page.locator('#mihomo-clash-test-visible').evaluate((button) => button.disabled)).toBe(false);
  expect(await page.locator('[data-group-name="AUTO"] .xk-mihomo-group-test').evaluate((button) => button.disabled)).toBe(false);
  await expect(page.locator('[data-node-name="node-a"] .xk-mihomo-node-delay')).toHaveText('44 мс');

  await page.locator('#mihomo-clash-show-hidden').check();
  await expect(page.locator('#mihomo-clash-groups-list')).toContainText('HIDDEN');
  await expect(page.locator('[data-group-name="HIDDEN"] [data-mihomo-group-toggle]')).toHaveAttribute('aria-expanded', 'false');
  await page.locator('#mihomo-clash-groups-filter').fill('node-b');
  await expect(page.locator('.xk-mihomo-node-row')).toHaveCount(1);

  await page.locator('[data-mihomo-group-select][data-node="node-b"]').click();
  await expect(page.locator('#confirm-modal-title')).toContainText('Переключить группу');
  await page.locator('#confirm-modal-ok-btn').click();
  await expect(page.locator('[data-node-name="node-b"]')).toHaveClass(/is-current/);
  expect(selections).toEqual(['node-b']);

  await page.locator('[data-mihomo-node-delay][data-node="node-b"]').click();
  await expect(page.locator('[data-node-name="node-b"] .xk-mihomo-node-probe')).toHaveClass(/is-pending/);
  await expect(page.locator('[data-node-name="node-b"] .xk-mihomo-node-probe use')).toHaveAttribute('href', /#xk-loading$/);
  await expect(page.locator('[data-node-name="node-b"] .xk-mihomo-node-delay')).toHaveText('44 мс');
  expect(delays).toContainEqual(
    { scope: 'provider-proxy', name: 'node-b', provider: 'provider-one', preset: 'google' },
  );

  await page.locator('#mihomo-clash-groups-filter').fill('');
  await expect(page.locator('[data-group-name="AUTO"] [data-mihomo-group-toggle]')).toHaveAttribute('aria-expanded', 'true');
  await page.locator('[data-mihomo-delay-visible]').click();
  await expect(page.locator('#mihomo-clash-test-visible')).toHaveAttribute('data-mihomo-delay-testing', 'true');
  await expect(page.locator('#mihomo-clash-test-visible .xk-mihomo-delay-spinner')).toBeVisible();
  await expect(page.locator('[data-group-name="AUTO"] .xk-mihomo-group-test')).not.toHaveAttribute('data-mihomo-delay-testing', 'true');
  await expect(page.locator('[data-node-name="node-a"] .xk-mihomo-node-delay')).toHaveText('44 мс');
  await expect(page.locator('[data-node-name="node-b"] .xk-mihomo-node-delay')).toHaveText('44 мс');
  await expect(page.locator('[data-node-name="DIRECT"] .xk-mihomo-node-delay')).toHaveText('44 мс');
  expect(delays).toContainEqual({ scope: 'proxy', name: 'node-a', preset: 'google' });
  expect(delays).toContainEqual({ scope: 'proxy', name: 'DIRECT', preset: 'google' });

  await page.locator('[data-group-name="AUTO"] .xk-mihomo-group-test').click();
  await expect(page.locator('[data-group-name="AUTO"] .xk-mihomo-group-test')).toHaveAttribute('data-mihomo-delay-testing', 'true');
  await expect(page.locator('[data-group-name="AUTO"] .xk-mihomo-delay-spinner')).toBeVisible();
  await expect(page.locator('#mihomo-clash-test-visible')).not.toHaveAttribute('data-mihomo-delay-testing', 'true');
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
  await page.locator('.top-tab-btn[data-view="mihomo"]').click();
  await page.evaluate(async () => {
    const mod = await import('/static/js/features/mihomo_clash/index.js');
    mod.activateMihomoClashWorkspace({ reason: 'e2e-country' });
  });
  await page.locator('[data-group-name="AUTO"] [data-mihomo-group-toggle]').click();
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
  await page.locator('.top-tab-btn[data-view="mihomo"]').click();
  await page.evaluate(async () => {
    const mod = await import('/static/js/features/mihomo_clash/index.js');
    mod.activateMihomoClashWorkspace({ reason: 'e2e-complex-flags' });
  });
  await page.locator('[data-group-name="AUTO"] [data-mihomo-group-toggle]').click();
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
  await page.locator('.top-tab-btn[data-view="mihomo"]').click();
  await page.evaluate(async () => {
    const mod = await import('/static/js/features/mihomo_clash/index.js');
    mod.activateMihomoClashWorkspace({ reason: 'e2e-complete-delay-queue' });
  });
  await page.locator('[data-group-name="AUTO"] [data-mihomo-group-toggle]').click();
  await page.locator('#mihomo-clash-test-visible').click();
  await expect(page.locator('#mihomo-clash-test-visible .xk-action-label')).toContainText(/Проверка \d+\/12/);
  await expect.poll(() => probed.length, { timeout: 10_000 }).toBe(12);
  await expect(page.locator('#mihomo-clash-test-visible .xk-action-label')).toHaveText('Тест видимых');
  expect(probed).toEqual(names);
});


test('automatic fixed group shows lock, unfix action, sorting and timeout hiding', async ({ page }) => {
  let fixed = 'hidden-node';
  let delayAttempts = 0;
  await page.route('**/api/mihomo/clash/status', (route) => route.fulfill({ json: statusPayload() }));
  await page.route(/\/api\/mihomo\/clash\/proxy-groups(?:\/.*)?$/, async (route) => {
    if (route.request().method() === 'DELETE') {
      fixed = '';
      return route.fulfill({ json: { ok: true, schema_version: 1, group: { ...groupsPayload('hidden-node', '', true).groups[1], fixed: '' }, reconciled: true, connections: { disconnected: 0, failed: 0 } } });
    }
    return route.fulfill({ json: groupsPayload('node-a', fixed, true) });
  });
  await page.route('**/api/mihomo/clash/delay', async (route) => {
    delayAttempts += 1;
    await new Promise((resolve) => setTimeout(resolve, 40));
    return route.fulfill({ status: 504, json: { ok: false, code: 'upstream_timeout' } });
  });

  await page.goto('/');
  await page.locator('.top-tab-btn[data-view="mihomo"]').click();
  await page.locator('#mihomo-clash-show-hidden').check();
  await page.locator('[data-group-name="HIDDEN"] [data-mihomo-group-toggle]').click();
  await expect(page.locator('[data-group-name="HIDDEN"]')).toContainText('Зафиксирован: hidden-node');
  await expect(page.locator('[data-node-name="hidden-node"]')).toHaveClass(/is-fixed/);
  await expect(page.locator('[data-group-name="FALLBACK"] [data-node-name="node-b"]')).toHaveClass(/is-current/);
  await expect(page.locator('[data-group-name="FALLBACK"] [data-node-name="node-b"]')).not.toHaveClass(/is-fixed/);
  await expect(page.locator('[data-group-name="FALLBACK"] [data-node-name="node-a"]')).toHaveClass(/is-fixed/);
  await expect(page.locator('[data-group-name="FALLBACK"] [data-node-name="node-a"]')).not.toHaveClass(/is-current/);
  await page.locator('[data-group-name="FALLBACK"] [data-mihomo-group-toggle]').click();
  await expect(page.locator('[data-group-name="HIDDEN"] [data-mihomo-group-unfix]')).toBeVisible();
  await page.locator('[data-group-name="HIDDEN"] [data-mihomo-group-unfix]').click();
  await expect(page.locator('#confirm-modal-title')).toContainText('Вернуть автоматический выбор');
  await page.locator('#confirm-modal-ok-btn').click();
  await expect(page.locator('[data-group-name="HIDDEN"] [data-mihomo-group-unfix]')).toHaveCount(0);

  await page.locator('#mihomo-clash-groups-sort').selectOption('name');
  await page.locator('[data-group-name="AUTO"] [data-mihomo-group-toggle]').click();
  await expect(page.locator('[data-group-name="AUTO"] .xk-mihomo-node-row').first()).toHaveAttribute('data-node-name', 'node-a');
  for (let index = 0; index < 3; index += 1) {
    await page.locator('[data-group-name="AUTO"] [data-mihomo-node-delay][data-node="node-b"]').click();
    if (index < 2) {
      await expect(page.locator('[data-group-name="AUTO"] [data-node-name="node-b"] .xk-mihomo-node-delay')).toHaveText('таймаут');
    } else {
      await expect(page.locator('[data-group-name="AUTO"] [data-node-name="node-b"]')).toHaveCount(0);
    }
    expect(delayAttempts).toBe(index + 1);
  }
  await expect(page.locator('[data-group-name="AUTO"] [data-node-name="node-b"]')).toHaveCount(0);
  await expect(page.locator('#mihomo-clash-show-timeout-hidden')).toContainText('1');
  await page.locator('#mihomo-clash-show-timeout-hidden').click();
  await expect(page.locator('[data-group-name="AUTO"] [data-node-name="node-b"]')).toHaveCount(1);
});


test('Mihomo group disclosures keep the workspace compact and keyboard accessible', async ({ page }) => {
  await page.route('**/api/mihomo/clash/status', (route) => route.fulfill({ json: statusPayload() }));
  await page.route(/\/api\/mihomo\/clash\/proxy-groups(?:\/.*)?$/, (route) => route.fulfill({ json: groupsPayload() }));
  await page.route('**/api/mihomo/clash/delay', (route) => route.fulfill({
    status: 502,
    json: { ok: false, code: 'upstream_unreachable' },
  }));

  await page.goto('/');
  await page.locator('.top-tab-btn[data-view="mihomo"]').click();
  await page.evaluate(async () => {
    const mod = await import('/static/js/features/mihomo_clash/index.js');
    mod.activateMihomoClashWorkspace({ reason: 'e2e' });
  });
  await expect(page.locator('#mihomo-clash-groups-list')).toContainText('AUTO');

  const hiddenToggle = page.locator('[data-group-name="HIDDEN"] [data-mihomo-group-toggle]');
  await page.locator('#mihomo-clash-show-hidden').check();
  await expect(hiddenToggle).toHaveAttribute('aria-expanded', 'false');
  await hiddenToggle.focus();
  await hiddenToggle.press('Enter');
  await expect(hiddenToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('[data-group-name="HIDDEN"] .xk-mihomo-group-body')).toBeVisible();
  await expect(page.locator('[data-group-name="HIDDEN"] .xk-mihomo-node-alive')).toHaveCount(0);
  await expect(page.locator('[data-group-name="HIDDEN"] .xk-mihomo-node-head')).toHaveCount(0);
  await page.locator('[data-group-name="AUTO"] [data-mihomo-group-toggle]').click();
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
  await expect(page.locator('[data-node-name="node-b"] .xk-mihomo-node-delay')).toHaveText('недоступен');
  await expect(page.locator('[data-node-name="node-b"] .xk-mihomo-node-delay')).toHaveAttribute('data-delay-tone', 'unavailable');
  await expect(page.locator('[data-node-name="node-b"] .xk-mihomo-node-delay use')).toHaveAttribute('href', /#xk-server-off$/);
  await expect(page.locator('[data-node-name="node-b"] .xk-mihomo-node-delay')).toHaveAttribute(
    'aria-label',
    /недоступен/,
  );
  await expect(page.locator('[data-node-name="node-b"] .xk-mihomo-node-delay')).toHaveAttribute(
    'data-tooltip',
    /alive=false/,
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
  await expect(page.locator('[data-node-name="node-b"] .xk-mihomo-node-delay')).toHaveText('ошибка');
  await expect(page.locator('[data-node-name="node-b"] .xk-mihomo-node-delay')).toHaveAttribute('data-delay-tone', 'failed');
  await expect(page.locator('[data-node-name="node-b"] .xk-mihomo-node-delay use')).toHaveAttribute('href', /#xk-alert$/);
  await expect(page.locator('[data-node-name="node-b"] .xk-mihomo-node-delay')).toHaveAttribute(
    'aria-label',
    /ошибка/,
  );
  await expect(page.locator('[data-node-name="node-b"] .xk-mihomo-node-delay')).toHaveAttribute(
    'data-tooltip',
    /Ручная проверка/,
  );

  await page.locator('#mihomo-clash-groups-collapse').click();
  await expect(page.locator('[data-mihomo-group-toggle][aria-expanded="true"]')).toHaveCount(0);
  await expect(page.locator('#mihomo-clash-test-visible')).toBeDisabled();
  await page.locator('#mihomo-clash-groups-collapse').click();
  await expect(page.locator('[data-mihomo-group-toggle][aria-expanded="true"]')).toHaveCount(2);

  await page.locator('#mihomo-clash-tab-config').click();
  await expect(page.locator('#mihomo-clash-panel-config')).toBeVisible();
  await expect(page.locator('#mihomo-clash-runtime')).toBeHidden();
});

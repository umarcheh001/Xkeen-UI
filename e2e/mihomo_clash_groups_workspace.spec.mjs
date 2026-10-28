import { test, expect, selectPanelView } from './fixtures.mjs';
import {
  statusPayload, groupsPayload, globalGroupPayload, egressPayload, setHiddenGroupsVisible,
} from './mihomo_clash_groups_support.mjs';

// Mihomo groups: snapshots, the egress card, DNS diagnostics, choosing in a group
// and the GLOBAL selector.

test('Mihomo groups recover from transient snapshot failures without restarting the panel', async ({ page }) => {
  let requests = 0;
  await page.route('**/api/mihomo/clash/status', (route) => route.fulfill({ json: statusPayload() }));
  await page.route('**/api/mihomo/clash/proxy-groups', (route) => {
    requests += 1;
    if (requests <= 2) {
      return route.fulfill({
        status: 503,
        json: { ok: false, retryable: true, code: 'upstream_busy', error: 'Mihomo API временно занят.' },
      });
    }
    return route.fulfill({ json: groupsPayload() });
  });

  await page.goto('/');
  await selectPanelView(page, 'mihomo');
  await expect(page.locator('[data-mihomo-groups-retry]')).toBeVisible();
  expect(requests).toBe(2);
  await page.locator('[data-mihomo-groups-retry]').click();
  await expect(page.locator('#mihomo-clash-groups-list')).toContainText('AUTO');
  expect(requests).toBe(3);
});


test('Mihomo control view does not start connections telemetry beside group loading', async ({ page }) => {
  let tokenRequests = 0;
  await page.route('**/api/mihomo/clash/status', (route) => route.fulfill({
    json: {
      ...statusPayload(),
      capabilities: { ...statusPayload().capabilities, telemetry_stream: true },
    },
  }));
  await page.route('**/api/mihomo/clash/proxy-groups', (route) => route.fulfill({ json: groupsPayload() }));
  await page.route('**/api/ws-token', (route) => {
    if (route.request().postDataJSON()?.scope === 'mihomo-clash-telemetry') tokenRequests += 1;
    return route.fulfill({ json: { ok: true, token: 'e2e-telemetry-token' } });
  });

  await page.goto('/');
  await selectPanelView(page, 'mihomo');
  await expect(page.locator('#mihomo-clash-groups-list')).toContainText('AUTO');
  await page.waitForTimeout(300);
  expect(tokenRequests).toBe(0);

  await page.locator('#mihomo-clash-tab-connections').click();
  await expect.poll(() => tokenRequests).toBeGreaterThan(0);
});

test('Mihomo node tiles keep compact metadata and reserve room for latency', async ({ page }) => {
  const payload = groupsPayload();
  const nodeData = payload.groups[0].nodes[0];
  nodeData.server = 'cp.landing-se.rfid-technology.example.test';
  nodeData.provider_ambiguous = true;
  nodeData.provider_candidates = Array.from({ length: 19 }, (_, index) => `provider-${index}`);
  await page.route('**/api/mihomo/clash/status', (route) => route.fulfill({ json: statusPayload() }));
  await page.route(/\/api\/mihomo\/clash\/proxy-groups(?:\/.*)?$/, (route) => route.fulfill({ json: payload }));
  await page.goto('/');
  await selectPanelView(page, 'mihomo');
  await page.locator('[data-group-name="AUTO"] .xk-mihomo-group-head').click();

  const node = page.locator('[data-group-name="AUTO"] [data-node-name="node-a"]');
  await expect(node.locator('.xk-mihomo-node-main > small').first()).toHaveText('VLESS · xhttp · tls');
  await expect(node.locator('.xk-mihomo-node-main > small').first()).toHaveAttribute('data-tooltip', 'VLESS · xhttp · tls · 19 providers · UDP');
  await expect(node.locator('.xk-mihomo-node-endpoint')).toHaveAttribute('data-tooltip', 'cp.landing-se.rfid-technology.example.test:443');
  const geometry = async () => node.evaluate((row) => {
    const endpoint = row.querySelector('.xk-mihomo-node-endpoint').getBoundingClientRect();
    const probe = row.querySelector('.xk-mihomo-node-probe').getBoundingClientRect();
    return { endpointRight: endpoint.right, probeLeft: probe.left };
  });
  const desktop = await geometry();
  expect(desktop.endpointRight).toBeLessThanOrEqual(desktop.probeLeft + 1);
  await page.setViewportSize({ width: 375, height: 800 });
  const mobile = await geometry();
  expect(mobile.endpointRight).toBeLessThanOrEqual(mobile.probeLeft + 1);
});


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
  await selectPanelView(page, 'mihomo');
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
  await expect(page.locator('#mihomo-clash-egress-country[data-country="FI"]')).toHaveAttribute('aria-label', 'Finland');
  await expect(page.locator('#mihomo-clash-egress-country svg')).toHaveCount(1);
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
  await selectPanelView(page, 'mihomo');
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


test('Mihomo DNS diagnostics toggle keeps action labels inline', async ({ page }) => {
  await page.route('**/api/mihomo/clash/status', (route) => route.fulfill({
    json: {
      ...statusPayload(),
      capabilities: {
        ...statusPayload().capabilities,
        dns_query: true,
        dns_flush: true,
        fake_ip_flush: true,
      },
    },
  }));
  await page.route(/\/api\/mihomo\/clash\/proxy-groups(?:\/.*)?$/, (route) => route.fulfill({ json: groupsPayload() }));

  await page.goto('/');
  await page.addInitScript(() => localStorage.removeItem('xkeen:mihomo-clash-dns-visible'));
  await page.reload();
  await selectPanelView(page, 'mihomo');
  await page.evaluate(async () => {
    const mod = await import('/static/js/features/mihomo_clash/index.js');
    mod.activateMihomoClashWorkspace({ reason: 'e2e-dns-diagnostics' });
  });

  const toggle = page.locator('#mihomo-clash-dns-toggle');
  const diagnostics = page.locator('#mihomo-clash-dns-diagnostics');
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(diagnostics).toBeHidden();

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(diagnostics).toBeVisible();

  const actionLayout = await page.evaluate(() => {
    const read = (id) => {
      const button = document.getElementById(id);
      const icon = button?.querySelector('.xk-action-icon')?.getBoundingClientRect();
      const label = button?.querySelector('span:not(.xk-action-icon)')?.getBoundingClientRect();
      return {
        display: button ? getComputedStyle(button).display : '',
        whiteSpace: button ? getComputedStyle(button).whiteSpace : '',
        sameRow: !!icon && !!label && Math.abs(icon.top - label.top) < 5,
      };
    };
    return {
      query: read('mihomo-clash-dns-query'),
      dnsFlush: read('mihomo-clash-dns-flush'),
      fakeIpFlush: read('mihomo-clash-fake-ip-flush'),
    };
  });
  for (const action of Object.values(actionLayout)) {
    expect(['flex', 'inline-flex']).toContain(action.display);
    expect(action.whiteSpace).toBe('nowrap');
    expect(action.sameRow).toBe(true);
  }

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileLayout = await page.locator('.xk-mihomo-dns-maintenance-actions').evaluate((element) => ({
    display: getComputedStyle(element).display,
    overflow: [...element.children].some((button) => button.scrollWidth > button.clientWidth + 1),
  }));
  expect(mobileLayout.display).toBe('grid');
  expect(mobileLayout.overflow).toBe(false);
  await expect(page.locator('#mihomo-clash-dns-toggle')).toBeVisible();
  await toggle.click();
  await expect(diagnostics).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem('xkeen:mihomo-clash-dns-visible'))).toBe('0');
});


test('Mihomo egress card offers confirmed automatic loopback listener setup', async ({ page }) => {
  let configured = false;
  const setupCalls = [];
  await page.route('**/api/mihomo/clash/status', (route) => route.fulfill({ json: statusPayload() }));
  await page.route(/\/api\/mihomo\/clash\/proxy-groups(?:\/.*)?$/, (route) => route.fulfill({ json: groupsPayload() }));
  await page.route('**/api/mihomo/clash/egress-info*', (route) => {
    if (configured) return route.fulfill({ json: egressPayload(false) });
    return route.fulfill({
      status: 409,
      json: {
        ok: false,
        code: 'mihomo_proxy_port_unavailable',
        error: 'HTTP/mixed-port Mihomo не настроен.',
        setup_available: true,
        setup_endpoint: '/api/mihomo/security/egress-listener-preview',
      },
    });
  });
  await page.route('**/api/mihomo/security/egress-listener-preview', (route) => {
    setupCalls.push('preview');
    return route.fulfill({ json: {
      ok: true,
      restart_required: true,
      preview: { preview_id: 'preview-1', port: 17890, listen: '127.0.0.1' },
    } });
  });
  await page.route('**/api/mihomo/security/egress-listener-apply', (route) => {
    setupCalls.push(route.request().postDataJSON());
    configured = true;
    return route.fulfill({ json: { ok: true, configured: true, restarted: true, port: 17890 } });
  });

  await page.goto('/');
  await page.evaluate(() => localStorage.setItem('xkeen:mihomo-clash-egress-visible', '1'));
  await page.reload();
  await selectPanelView(page, 'mihomo');
  await page.evaluate(async () => {
    const mod = await import('/static/js/features/mihomo_clash/index.js');
    mod.activateMihomoClashWorkspace({ reason: 'e2e-egress-auto-setup' });
  });

  await expect(page.locator('#mihomo-clash-egress-setup')).toBeVisible();
  await page.locator('#mihomo-clash-egress-setup').click();
  await expect(page.locator('#confirm-modal-title')).toContainText('проверку IP выхода');
  await expect(page.locator('#confirm-modal-message')).toContainText('127.0.0.1');
  await page.locator('#confirm-modal-ok-btn').click();
  await expect(page.locator('#mihomo-clash-egress-ip')).toHaveText('198.51.100.25');
  expect(setupCalls).toEqual([
    'preview',
    { preview_id: 'preview-1', confirmed: true },
  ]);
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
  // A probe is held until the test has seen it in progress, then let go: a
  // fixed pause let a loaded machine finish it before it was looked at.
  let probesHeld = Promise.resolve();
  let releaseProbes = () => {};
  const holdProbes = () => { probesHeld = new Promise((resolve) => { releaseProbes = resolve; }); };
  await page.route('**/api/mihomo/clash/delay', async (route) => {
    const data = route.request().postDataJSON();
    delays.push(data);
    await probesHeld;
    try {
      await route.fulfill({ json: { ok: true, schema_version: 1, results: [{ name: data.name, delay_ms: 44 }] } });
    } catch (error) {
      // The test is over and the page is gone with the probe still held.
    }
  });

  await page.goto('/');
  await selectPanelView(page, 'mihomo');
  await page.evaluate(async () => {
    const mod = await import('/static/js/features/mihomo_clash/index.js');
    mod.activateMihomoClashWorkspace({ reason: 'e2e' });
  });
  await expect(page.locator('#mihomo-clash-groups-list')).toContainText('AUTO');
  const groupIcon = await page.locator('[data-group-name="AUTO"] .xk-mihomo-group-icon').evaluate((icon) => {
    const box = icon.getBoundingClientRect();
    const image = icon.querySelector('img')?.getBoundingClientRect();
    return {
      width: Math.round(box.width),
      height: Math.round(box.height),
      radius: getComputedStyle(icon).borderRadius,
      imageWidth: image ? Math.round(image.width) : null,
      imageHeight: image ? Math.round(image.height) : null,
      hasTooltip: icon.hasAttribute('data-tooltip'),
    };
  });
  expect(groupIcon).toEqual({
    width: 40,
    height: 40,
    radius: '12px',
    imageWidth: 30,
    imageHeight: 30,
    hasTooltip: false,
  });
  await expect(page.locator('#mihomo-clash-groups-list')).not.toContainText('HIDDEN');
  await expect(page.locator('[data-group-name="AUTO"] .xk-mihomo-group-head')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('[data-group-name="AUTO"] .xk-mihomo-group-test')).toHaveCount(0);
  await expect(page.locator('[data-group-name="AUTO"] .xk-mihomo-node-row')).toHaveCount(0);
  await expect(page.locator('[data-group-name="AUTO"] [data-mihomo-picker-toggle]')).toHaveAttribute('role', 'combobox');
  await expect(page.locator('[data-group-name="AUTO"] [data-mihomo-picker-toggle]')).toContainText('node-a');
  await expect(page.locator('#mihomo-clash-groups-collapse')).toHaveAccessibleName('Развернуть все группы');
  await expect(page.locator('#mihomo-clash-groups-collapse > span')).toBeHidden();
  await expect(page.locator('#mihomo-clash-test-visible')).toBeDisabled();
  const collapseGeometry = await page.locator('#mihomo-clash-groups-collapse').evaluate((button) => {
    const icon = button.querySelector('.xk-action-icon');
    const iconBox = icon?.getBoundingClientRect();
    const buttonBox = button.getBoundingClientRect();
    return {
      iconFlexShrink: icon ? getComputedStyle(icon).flexShrink : null,
      centered: !!iconBox
        && Math.abs(iconBox.x + iconBox.width / 2 - buttonBox.x - buttonBox.width / 2) <= 1
        && Math.abs(iconBox.y + iconBox.height / 2 - buttonBox.y - buttonBox.height / 2) <= 1,
    };
  });
  expect(collapseGeometry).toEqual({
    iconFlexShrink: '0',
    centered: true,
  });

  await page.locator('[data-group-name="AUTO"] [data-mihomo-picker-toggle]').click();
  await expect(page.locator('[data-group-name="AUTO"] [data-mihomo-picker-search]')).toBeFocused();
  await expect(page.locator('[data-group-name="AUTO"] .xk-mihomo-picker-option')).toHaveCount(3);
  const pickerSpacing = await page.locator('[data-group-name="AUTO"] .xk-mihomo-picker-option').evaluateAll((options) => ({
    rowGap: options[1].getBoundingClientRect().top - options[0].getBoundingClientRect().bottom,
    triggerGap: options[0].closest('.xk-mihomo-picker-popover').getBoundingClientRect().top
      - options[0].closest('.xk-mihomo-group-picker').querySelector('[data-mihomo-picker-toggle]').getBoundingClientRect().bottom,
  }));
  expect(pickerSpacing.rowGap).toBeGreaterThanOrEqual(4);
  expect(pickerSpacing.triggerGap).toBeGreaterThanOrEqual(4);
  await page.locator('[data-group-name="AUTO"] [data-mihomo-picker-search]').fill('provider-one');
  await expect(page.locator('[data-group-name="AUTO"] .xk-mihomo-picker-option')).toHaveCount(1);
  await expect(page.locator('[data-group-name="AUTO"] .xk-mihomo-picker-option')).toContainText('node-b');
  await page.locator('[data-group-name="AUTO"] [data-mihomo-picker-search]').fill('');
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-group-name="AUTO"] .xk-mihomo-picker-popover')).toHaveCount(0);
  await expect(page.locator('[data-group-name="AUTO"] .xk-mihomo-node-row')).toHaveCount(0);

  await page.locator('[data-group-name="AUTO"] .xk-mihomo-group-head').click();
  await expect(page.locator('[data-group-name="AUTO"] .xk-mihomo-group-test')).toBeVisible();
  await expect(page.locator('[data-node-name="node-a"]')).toContainText('VLESS · xhttp · tls');
  await expect(page.locator('[data-node-name="node-a"]')).toContainText('edge.example.test:443');
  await expect(page.locator('[data-node-name="node-a"] .xk-mihomo-node-main')).not.toHaveAttribute('data-tooltip');
  await page.locator('[data-mihomo-node-delay][data-node="node-a"]').hover();
  await expect(page.locator('#mihomo-clash-delay-history-popover')).toBeVisible();
  await expect(page.locator('#mihomo-clash-delay-history-popover .xk-mihomo-delay-history-row')).toHaveCount(2);
  await expect(page.locator('#mihomo-clash-delay-history-popover')).toContainText('2026-08-16');
  await expect(page.locator('#mihomo-clash-delay-history-popover')).toContainText(':15:20');
  await expect(page.locator('#mihomo-clash-delay-history-popover')).toContainText('79 мс');
  await expect(page.locator('#mihomo-clash-delay-history-popover')).toContainText('82 мс');
  await page.locator('[data-node-name="node-a"] .xk-mihomo-node-main').hover();
  await expect(page.locator('#mihomo-clash-delay-history-popover')).toBeHidden();
  await page.locator('[data-group-name="AUTO"] .xk-mihomo-node-row').evaluateAll((nodes) => {
    nodes.forEach((node, index) => { node.dataset.renderIdentity = String(index); });
  });
  holdProbes();
  await page.locator('[data-mihomo-node-delay][data-node="node-a"]').click();
  await expect(page.locator('[data-node-name="node-a"] .xk-mihomo-node-probe')).toHaveClass(/is-pending/);
  expect(await page.locator('[data-group-name="AUTO"] .xk-mihomo-node-row').evaluateAll(
    (nodes) => nodes.map((node, index) => node.dataset.renderIdentity === String(index)),
  )).toEqual([true, true, true]);
  expect(await page.locator('#mihomo-clash-test-visible').evaluate((button) => button.disabled)).toBe(false);
  expect(await page.locator('[data-group-name="AUTO"] .xk-mihomo-group-test').evaluate((button) => button.disabled)).toBe(false);
  releaseProbes();
  await expect(page.locator('[data-node-name="node-a"] .xk-mihomo-node-delay')).toHaveText('44 мс');
  await page.locator('[data-mihomo-node-delay][data-node="node-a"]').hover();
  await expect(page.locator('#mihomo-clash-delay-history-popover .xk-mihomo-delay-history-row')).toHaveCount(3);
  await expect(page.locator('#mihomo-clash-delay-history-popover')).toContainText('44 мс');

  await setHiddenGroupsVisible(page);
  await page.keyboard.press('Escape');
  await expect(page.locator('#mihomo-clash-groups-list')).toContainText('HIDDEN');
  await expect(page.locator('[data-group-name="HIDDEN"] .xk-mihomo-group-icon--default')).toHaveCount(1);
  await expect(page.locator('[data-group-name="HIDDEN"] .xk-mihomo-group-icon--default use')).toHaveAttribute('href', /#xk-dns$/);
  await expect(page.locator('[data-group-name="HIDDEN"] .xk-mihomo-group-head')).toHaveAttribute('aria-expanded', 'false');
  await page.locator('#mihomo-clash-groups-filter').fill('node-b');
  await expect(page.locator('.xk-mihomo-node-row')).toHaveCount(1);
  await expect(page.locator('[data-group-name="AUTO"] .xk-mihomo-group-head')).toHaveAttribute('aria-expanded', 'true');

  await page.locator('[data-mihomo-group-select][data-node="node-b"]').click();
  await expect(page.locator('#confirm-modal-title')).toContainText('Переключить группу');
  await page.locator('#confirm-modal-ok-btn').click();
  await expect(page.locator('[data-node-name="node-b"]')).toHaveClass(/is-current/);
  expect(selections).toEqual(['node-b']);

  holdProbes();
  await page.locator('[data-mihomo-node-delay][data-node="node-b"]').click();
  await expect(page.locator('[data-node-name="node-b"] .xk-mihomo-node-probe')).toHaveClass(/is-pending/);
  await expect(page.locator('[data-node-name="node-b"] .xk-mihomo-node-probe use')).toHaveAttribute('href', /#xk-loading$/);
  releaseProbes();
  await expect(page.locator('[data-node-name="node-b"] .xk-mihomo-node-delay')).toHaveText('44 мс');
  expect(delays).toContainEqual(
    { scope: 'provider-proxy', name: 'node-b', provider: 'provider-one', preset: 'auto' },
  );

  await page.locator('#mihomo-clash-groups-filter').fill('');
  await expect(page.locator('[data-group-name="AUTO"] .xk-mihomo-group-head')).toHaveAttribute('aria-expanded', 'true');
  holdProbes();
  await page.locator('[data-mihomo-delay-visible]').click();
  await expect(page.locator('#mihomo-clash-test-visible')).toHaveAttribute('data-mihomo-delay-testing', 'true');
  await expect(page.locator('#mihomo-clash-test-visible .xk-mihomo-delay-spinner')).toBeVisible();
  await expect(page.locator('[data-group-name="AUTO"] .xk-mihomo-group-test')).not.toHaveAttribute('data-mihomo-delay-testing', 'true');
  releaseProbes();
  await expect(page.locator('[data-node-name="node-a"] .xk-mihomo-node-delay')).toHaveText('44 мс');
  await expect(page.locator('[data-node-name="node-b"] .xk-mihomo-node-delay')).toHaveText('44 мс');
  await expect(page.locator('[data-node-name="DIRECT"] .xk-mihomo-node-delay')).toHaveCount(0);
  expect(delays).toContainEqual({ scope: 'proxy', name: 'node-a', preset: 'auto' });
  expect(delays.some((item) => item.name === 'DIRECT')).toBe(false);

  holdProbes();
  await page.locator('[data-group-name="AUTO"] .xk-mihomo-group-test').click();
  await expect(page.locator('[data-group-name="AUTO"] .xk-mihomo-group-test')).toHaveAttribute('data-mihomo-delay-testing', 'true');
  await expect(page.locator('[data-group-name="AUTO"] .xk-mihomo-delay-spinner')).toBeVisible();
  await expect(page.locator('#mihomo-clash-test-visible')).not.toHaveAttribute('data-mihomo-delay-testing', 'true');
  releaseProbes();
});


test('collapsed picker stays above sibling cards and shows nested group icon and effective delay', async ({ page }) => {
  const data = groupsPayload();
  const blockedIcon = 'https://cdn.example.test/icons/blocked.png';
  data.groups = [
    {
      name: 'YouTube', type: 'Selector', icon: '', now: 'BLOCKED', fixed: '', hidden: false, selectable: true,
      nodes: [
        { name: 'BLOCKED', type: 'Selector', alive: true, udp: true, provider: '', provider_candidates: [], delay_ms: null },
        ...data.groups[0].nodes,
      ],
    },
    {
      name: 'BLOCKED', type: 'Selector', icon: blockedIcon, now: 'node-a', fixed: '', hidden: false, selectable: true,
      nodes: data.groups[0].nodes,
    },
    {
      name: 'Discord', type: 'Selector', icon: '', now: 'BLOCKED', fixed: '', hidden: false, selectable: true,
      nodes: [{ name: 'BLOCKED', type: 'Selector', alive: true, udp: true, provider: '', provider_candidates: [], delay_ms: null }],
    },
    {
      name: 'Twitch', type: 'Selector', icon: '', now: 'BLOCKED', fixed: '', hidden: false, selectable: true,
      nodes: [{ name: 'BLOCKED', type: 'Selector', alive: true, udp: true, provider: '', provider_candidates: [], delay_ms: null }],
    },
  ];
  await page.route('**/api/mihomo/clash/status', (route) => route.fulfill({ json: statusPayload() }));
  await page.route(/\/api\/mihomo\/clash\/proxy-groups(?:\/.*)?$/, (route) => route.fulfill({ json: data }));

  await page.goto('/');
  await selectPanelView(page, 'mihomo');
  const youtube = page.locator('[data-group-name="YouTube"]');
  const trigger = youtube.locator('[data-mihomo-picker-toggle]');
  await expect(trigger.locator('.xk-mihomo-picker-node-icon--group img')).toHaveAttribute('src', blockedIcon);
  await expect(trigger.locator('.xk-mihomo-picker-delay')).toContainText('82 мс');

  await trigger.click();
  await expect(youtube.locator('.xk-mihomo-picker-popover')).toBeVisible();
  const layering = await youtube.evaluate((card) => {
    const popover = card.querySelector('.xk-mihomo-picker-popover');
    const sibling = document.querySelector('[data-group-name="Discord"]');
    const popoverBox = popover.getBoundingClientRect();
    const siblingBox = sibling.getBoundingClientRect();
    const x = Math.max(popoverBox.left, siblingBox.left) + 12;
    const y = Math.max(popoverBox.top, siblingBox.top) + 12;
    return {
      cardZ: Number(getComputedStyle(card).zIndex),
      overlapsSibling: x < Math.min(popoverBox.right, siblingBox.right)
        && y < Math.min(popoverBox.bottom, siblingBox.bottom),
      hitInsideOpenPicker: popover.contains(document.elementFromPoint(x, y)),
    };
  });
  expect(layering).toEqual({ cardZ: 30, overlapsSibling: true, hitInsideOpenPicker: true });
});


test('Mihomo group disclosure state survives reload without mounting collapsed cards', async ({ page }) => {
  await page.route('**/api/mihomo/clash/status', (route) => route.fulfill({ json: statusPayload() }));
  await page.route(/\/api\/mihomo\/clash\/proxy-groups(?:\/.*)?$/, (route) => route.fulfill({ json: groupsPayload() }));

  await page.goto('/');
  await page.evaluate(() => localStorage.removeItem('xkeen:mihomo-clash-collapsed-groups'));
  await page.reload();
  await selectPanelView(page, 'mihomo');
  await page.evaluate(async () => {
    const mod = await import('/static/js/features/mihomo_clash/index.js');
    mod.activateMihomoClashWorkspace({ reason: 'e2e-disclosure-persistence' });
  });
  await expect(page.locator('[data-group-name="AUTO"] .xk-mihomo-group-head')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('[data-group-name="AUTO"] .xk-mihomo-node-row')).toHaveCount(0);

  await page.locator('[data-group-name="AUTO"] .xk-mihomo-group-head').click();
  await expect(page.locator('[data-group-name="AUTO"] .xk-mihomo-node-row')).toHaveCount(3);
  await expect.poll(() => page.evaluate(() => JSON.parse(
    localStorage.getItem('xkeen:mihomo-clash-collapsed-groups') || '{}',
  ).AUTO)).toBe(false);

  await page.reload();
  await selectPanelView(page, 'mihomo');
  await page.evaluate(async () => {
    const mod = await import('/static/js/features/mihomo_clash/index.js');
    mod.activateMihomoClashWorkspace({ reason: 'e2e-disclosure-restored' });
  });
  await expect(page.locator('[data-group-name="AUTO"] .xk-mihomo-group-head')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('[data-group-name="AUTO"] .xk-mihomo-node-row')).toHaveCount(3);

  await page.locator('[data-group-name="AUTO"] .xk-mihomo-group-head').click();
  await expect(page.locator('[data-group-name="AUTO"] .xk-mihomo-node-row')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => JSON.parse(
    localStorage.getItem('xkeen:mihomo-clash-collapsed-groups') || '{}',
  ).AUTO)).toBe(true);
});


test('Mihomo GLOBAL selector follows runtime mode and reconciles selection locally', async ({ page }) => {
  let runtimeMode = 'rule';
  let globalNow = 'AUTO';
  let groupGets = 0;
  const modeRequests = [];
  const selections = [];

  await page.route('**/api/mihomo/clash/status', (route) => route.fulfill({
    json: {
      ...statusPayload(),
      runtime: { mode: runtimeMode },
      capabilities: {
        ...statusPayload().capabilities,
        runtime_mode_switch: true,
      },
    },
  }));
  await page.route('**/api/mihomo/clash/runtime-mode', async (route) => {
    const previousMode = runtimeMode;
    const data = route.request().postDataJSON();
    runtimeMode = data.mode;
    modeRequests.push(runtimeMode);
    await route.fulfill({
      json: {
        ok: true,
        schema_version: 1,
        mode: runtimeMode,
        previous_mode: previousMode,
        changed: previousMode !== runtimeMode,
        reconciled: true,
        persistent: false,
      },
    });
  });
  await page.route(/\/api\/mihomo\/clash\/proxy-groups(?:\/.*)?$/, async (route) => {
    const request = route.request();
    if (request.method() === 'PUT') {
      expect(new URL(request.url()).pathname).toBe('/api/mihomo/clash/proxy-groups/GLOBAL');
      const data = request.postDataJSON();
      globalNow = data.name;
      selections.push(globalNow);
      await route.fulfill({
        json: {
          ok: true,
          schema_version: 1,
          group: globalGroupPayload(globalNow),
          reconciled: true,
          connections: { requested: false, matched: 0, disconnected: 0, failed: 0, truncated: false },
        },
      });
      return;
    }
    groupGets += 1;
    await route.fulfill({
      json: {
        ...groupsPayload(),
        global_group: globalGroupPayload(globalNow),
      },
    });
  });

  await page.goto('/');
  await selectPanelView(page, 'mihomo');
  await page.evaluate(async () => {
    const mod = await import('/static/js/features/mihomo_clash/index.js');
    mod.activateMihomoClashWorkspace({ reason: 'e2e-global-selector' });
  });

  await expect(page.locator('[data-group-name="AUTO"]')).toBeVisible();
  await expect(page.locator('[data-group-name="GLOBAL"]')).toHaveCount(0);

  await page.locator('#mihomo-clash-status-mode').click();
  await page.locator('[data-mihomo-runtime-mode="global"]').click();
  await expect(page.locator('#confirm-modal-title')).toContainText('Включить режим');
  await page.locator('#confirm-modal-ok-btn').click();

  await expect(page.locator('#mihomo-clash-status-mode-value')).toHaveText('Через GLOBAL');
  await expect(page.locator('#mihomo-clash-groups-list .xk-mihomo-group')).toHaveCount(1);
  await expect(page.locator('[data-group-name="GLOBAL"]')).toBeVisible();
  await expect(page.locator('[data-group-name="AUTO"]')).toHaveCount(0);

  await page.locator('[data-group-name="GLOBAL"] .xk-mihomo-group-head').click();
  const groupGetsBeforeSelection = groupGets;
  await page.locator('[data-group-name="GLOBAL"] [data-mihomo-group-select][data-node="DIRECT"]').click();
  await expect(page.locator('#confirm-modal-title')).toContainText('Переключить группу');
  await page.locator('#confirm-modal-ok-btn').click();

  await expect(page.locator('[data-group-name="GLOBAL"] [data-node-name="DIRECT"]')).toHaveClass(/is-current/);
  expect(groupGets).toBe(groupGetsBeforeSelection);

  await page.locator('#mihomo-clash-status-mode').click();
  await page.locator('[data-mihomo-runtime-mode="rule"]').click();

  await expect(page.locator('#mihomo-clash-status-mode-value')).toHaveText('По правилам');
  await expect(page.locator('[data-group-name="AUTO"]')).toBeVisible();
  await expect(page.locator('[data-group-name="GLOBAL"]')).toHaveCount(0);
  expect(modeRequests).toEqual(['global', 'rule']);
  expect(selections).toEqual(['DIRECT']);
});

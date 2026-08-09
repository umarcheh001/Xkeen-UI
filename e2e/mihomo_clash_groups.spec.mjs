import { test, expect } from './fixtures.mjs';


function statusPayload() {
  return {
    ok: true,
    state: 'ready',
    schema_version: 1,
    core: { version: 'test-1.0' },
    runtime: { mode: 'rule' },
    capabilities: { status: true, proxy_groups: true, proxy_select: true, proxy_delay: true },
  };
}


function groupsPayload(now = 'node-a') {
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
        hidden: false,
        selectable: true,
        nodes: [
          { name: 'node-a', type: 'VLESS', alive: true, udp: true, provider: '', provider_candidates: [], delay_ms: 82 },
          { name: 'node-b', type: 'Trojan', alive: true, udp: true, provider: 'provider-one', provider_candidates: ['provider-one'], delay_ms: null },
          { name: 'DIRECT', type: 'Direct', alive: true, udp: true, provider: '', provider_candidates: [], delay_ms: null },
        ],
      },
      {
        name: 'HIDDEN',
        type: 'URLTest',
        now: 'hidden-node',
        hidden: true,
        selectable: true,
        nodes: [{ name: 'hidden-node', type: 'VLESS', alive: null, udp: null, provider: '', provider_candidates: [], delay_ms: null }],
      },
    ],
  };
}


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
    await route.fulfill({ json: groupsPayload(current) });
  });
  await page.route('**/api/mihomo/clash/delay', async (route) => {
    const data = route.request().postDataJSON();
    delays.push(data);
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

  await page.locator('#mihomo-clash-show-hidden').check();
  await expect(page.locator('#mihomo-clash-groups-list')).toContainText('HIDDEN');
  await expect(page.locator('[data-group-name="HIDDEN"] [data-mihomo-group-toggle]')).toHaveAttribute('aria-expanded', 'false');
  await page.locator('#mihomo-clash-groups-filter').fill('node-b');
  await expect(page.locator('.xk-mihomo-node-row')).toHaveCount(1);

  await page.locator('[data-mihomo-group-select][data-node="node-b"]').click();
  await expect(page.locator('[data-node-name="node-b"]')).toHaveClass(/is-current/);
  expect(selections).toEqual(['node-b']);

  await page.locator('[data-mihomo-node-delay][data-node="node-b"]').click();
  await expect(page.locator('[data-node-name="node-b"] .xk-mihomo-node-delay')).toHaveText('44 мс');
  expect(delays).toEqual([
    { scope: 'provider-proxy', name: 'node-b', provider: 'provider-one', preset: 'google' },
  ]);
});


test('Mihomo group disclosures keep the workspace compact and keyboard accessible', async ({ page }) => {
  await page.route('**/api/mihomo/clash/status', (route) => route.fulfill({ json: statusPayload() }));
  await page.route(/\/api\/mihomo\/clash\/proxy-groups(?:\/.*)?$/, (route) => route.fulfill({ json: groupsPayload() }));

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

  await page.locator('#mihomo-clash-groups-collapse').click();
  await expect(page.locator('[data-mihomo-group-toggle][aria-expanded="true"]')).toHaveCount(0);
  await expect(page.locator('#mihomo-clash-test-visible')).toBeDisabled();
  await page.locator('#mihomo-clash-groups-collapse').click();
  await expect(page.locator('[data-mihomo-group-toggle][aria-expanded="true"]')).toHaveCount(2);

  await page.locator('#mihomo-clash-tab-config').click();
  await expect(page.locator('#mihomo-clash-panel-config')).toBeVisible();
  await expect(page.locator('#mihomo-clash-runtime')).toBeHidden();
});

import { test, expect } from '@playwright/test';

function buildDemoNodes() {
  const specs = [
    ['de-XXX-Germany.98.1016', 'xhttp', 'tls', '195.133.25.89', 443, 'path=/api/v2/'],
    ['se-YYY-Sweden.e026', 'xhttp', 'tls', '103.88.240.173', 443, 'path=/api/v2/'],
    ['nl-YYY-Netherlands.0005', 'xhttp', 'tls', '176.124.210.220', 443, 'path=/api/v2/'],
    ['us-XXX-New-York.6f10', 'xhttp', 'tls', '72.56.242.135', 443, 'path=/api/v2/'],
    ['es-XXX-Spain.94da', 'xhttp', 'tls', '72.56.244.88', 443, 'path=/api/v2/'],
    ['in-XXX-India.0b95', 'xhttp', 'tls', '72.56.6.163', 443, 'path=/api/v2/'],
    ['tr-XXX-Turkey.0e5d', 'xhttp', 'tls', '5.42.120.157', 443, 'path=/api/v2/'],
    ['kz-ZZZ-Kazakhstan.af40', 'xhttp', 'tls', '82.97.207.21', 443, 'path=/api/v2/'],
    ['de-Germany.0005', 'tcp', 'reality', 'germany-05.ptu.ink', 443, ''],
    ['il-Israel.940f', 'tcp', 'reality', '31.133.100.247', 443, ''],
    ['us-New-York.0002', 'tcp', 'reality', '147.185.239.43', 443, ''],
    ['FREE-WhatsApp-Telegram-02', 'xhttp', 'tls', '45.139.27.63', 443, 'path=/api/v2/'],
    ['Анти-Белые-списки-00.59b7', 'tcp', 'reality', '195.163.211.55', 443, ''],
    ['Анти-Белые-списки-00.d1e0', 'tcp', 'reality', '161.0.40.166', 443, ''],
    ['Анти-Белые-списки-20.70ce', 'xhttp', 'tls', '217.16.217.10', 443, 'path=/api/v2/'],
    ['Анти-Белые-списки-00.dc85', 'tcp', 'reality', '95.163.211.169', 443, ''],
    ['Анти-Белые-списки-78.12a4', 'tcp', 'reality', '185.14.46.76', 443, ''],
    ['Анти-Белые-списки-96.37e9', 'tcp', 'reality', '92.38.156.41', 443, ''],
    ['Анти-Белые-списки-70', 'xhttp', 'reality', '212.111.87.132', 443, ''],
    ['Анти-Белые-списки-71', 'xhttp', 'reality', '185.160.108.209', 443, ''],
    ['Анти-Белые-списки-72', 'xhttp', 'reality', '151.250.1.196', 443, ''],
    ['Анти-Белые-списки-06.e026', 'xhttp', 'tls', '103.88.240.173', 443, 'path=/api/v2/'],
  ];

  return specs.map(([name, transport, security, host, port, detail], index) => ({
    key: `node-${index + 1}`,
    name,
    protocol: 'vless',
    transport,
    security,
    host,
    port,
    detail,
    tag: `cdn.pecan.run--${name}`,
  }));
}

function buildNodeLatency(nodes) {
  const values = [
    800, 691, 880, 1213, 806, 3050, null, 1640, 941, null, 886,
    430, 1517, 2969, 2693, 1573, 3376, 925, null, null, null, 691,
  ];
  const map = {};
  nodes.forEach((node, index) => {
    const delay = values[index];
    map[node.key] = delay == null
      ? { status: 'error', error: 'timeout', checked_at: 1777777777 }
      : { status: 'ok', delay_ms: delay, checked_at: 1777777777 };
  });
  return map;
}

function buildDemoSubscription(nodes = buildDemoNodes()) {
  return {
    id: 'demo-sub',
    name: 'cdn.pecan.run',
    tag: 'cdn.pecan.run',
    url: 'https://cdn.pecan.run/xray/subscription/demo#VNI%20Hosting%20-%20Russia',
    interval_hours: 1,
    profile_update_interval_hours: 1,
    enabled: true,
    ping_enabled: true,
    routing_mode: 'safe-fallback',
    last_ok: true,
    last_count: nodes.length,
    last_source_count: nodes.length,
    last_filtered_out_count: 0,
    next_update_ts: 1777777777,
    output_file: '04_outbounds.cdn.pecan.run.json',
    last_nodes: nodes,
    node_latency: buildNodeLatency(nodes),
  };
}

async function openSubscriptionsModal(page) {
  await page.goto('/');
  await page.locator('#outbounds-header').click();
  await expect(page.locator('#outbounds-body')).toBeVisible();
  await page.locator('#outbounds-subscriptions-btn').click();
  await expect(page.locator('#outbounds-subscriptions-modal')).toBeVisible();
}

test('subscriptions modal cards stay separated at medium width', async ({ page }) => {
  const nodes = buildDemoNodes();
  const subscription = buildDemoSubscription(nodes);

  await page.route('**/api/xray/subscriptions', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, subscriptions: [subscription] }),
    });
  });

  await openSubscriptionsModal(page);
  await page.locator('tr[data-sub-id="demo-sub"]').click();

  const modal = page.locator('#outbounds-subscriptions-modal .modal-content');
  await modal.evaluate((node) => {
    node.style.width = '820px';
    node.style.maxWidth = '820px';
  });

  await expect(page.locator('#outbounds-subscriptions-modal .xk-sub-node-item')).toHaveCount(nodes.length);
  await page.waitForTimeout(300);

  const layout = await page.evaluate(() => {
    const modal = document.querySelector('#outbounds-subscriptions-modal .modal-content');
    const modalBody = document.querySelector('#outbounds-subscriptions-modal .modal-body');
    const panel = document.querySelector('#outbounds-subscriptions-nodes-panel');
    const list = document.querySelector('#outbounds-subscriptions-nodes-list');
    const cards = Array.from(document.querySelectorAll('#outbounds-subscriptions-nodes-list .xk-sub-node-item'));
    const rects = cards.map((card, index) => {
      const rect = card.getBoundingClientRect();
      return {
        index,
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
        text: String(card.querySelector('.xk-sub-node-name')?.textContent || '').trim(),
      };
    });
    const overlaps = [];
    for (let i = 0; i < rects.length; i += 1) {
      for (let j = i + 1; j < rects.length; j += 1) {
        const a = rects[i];
        const b = rects[j];
        const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (x > 2 && y > 2) {
          overlaps.push({ a: a.text, b: b.text, x, y });
        }
      }
    }
    const columns = Array.from(new Set(rects.map((item) => Math.round(item.left))));
    return {
      modalWidth: modal ? Math.round(modal.getBoundingClientRect().width) : 0,
      modalBodyHeight: modalBody ? Math.round(modalBody.getBoundingClientRect().height) : 0,
      modalBodyScrollHeight: modalBody ? Math.round(modalBody.scrollHeight) : 0,
      panelTop: panel ? Math.round(panel.getBoundingClientRect().top) : 0,
      panelHeight: panel ? Math.round(panel.getBoundingClientRect().height) : 0,
      listWidth: list ? Math.round(list.getBoundingClientRect().width) : 0,
      listHeight: list ? Math.round(list.getBoundingClientRect().height) : 0,
      columns: columns.length,
      overlaps,
      compact: !!(modal && modal.classList.contains('xk-sub-modal-compact')),
      narrow: !!(modal && modal.classList.contains('xk-sub-modal-narrow')),
      firstCardHeights: rects.slice(0, 4).map((item) => ({ text: item.text, height: Math.round(item.height) })),
    };
  });

  // Scroll the modal body to the nodes section so the screenshot shows the broken layout directly.
  await page.locator('#outbounds-subscriptions-nodes-panel').scrollIntoViewIfNeeded();

  expect(layout.overlaps).toEqual([]);
});

test('subscriptions modal fits three compact node columns on desktop width', async ({ page }) => {
  await page.setViewportSize({ width: 1365, height: 768 });
  const nodes = buildDemoNodes();
  const subscription = buildDemoSubscription(nodes);

  await page.route('**/api/xray/subscriptions', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, subscriptions: [subscription] }),
    });
  });

  await openSubscriptionsModal(page);
  await page.locator('tr[data-sub-id="demo-sub"]').click();
  await expect(page.locator('#outbounds-subscriptions-modal .xk-sub-node-item')).toHaveCount(nodes.length);
  await page.waitForTimeout(250);

  const layout = await page.evaluate(() => {
    const modal = document.querySelector('#outbounds-subscriptions-modal .modal-content');
    const list = document.querySelector('#outbounds-subscriptions-nodes-list');
    const cards = Array.from(document.querySelectorAll('#outbounds-subscriptions-nodes-list .xk-sub-node-item'));
    const rects = cards.map((card) => {
      const rect = card.getBoundingClientRect();
      return {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        right: Math.round(rect.right),
        bottom: Math.round(rect.bottom),
        width: Math.round(rect.width),
      };
    });
    const overlaps = [];
    for (let i = 0; i < rects.length; i += 1) {
      for (let j = i + 1; j < rects.length; j += 1) {
        const a = rects[i];
        const b = rects[j];
        const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (x > 2 && y > 2) overlaps.push({ i, j, x, y });
      }
    }
    return {
      modalWidth: modal ? Math.round(modal.getBoundingClientRect().width) : 0,
      listWidth: list ? Math.round(list.getBoundingClientRect().width) : 0,
      columns: Array.from(new Set(rects.map((item) => item.left))).length,
      minCardWidth: rects.length ? Math.min(...rects.map((item) => item.width)) : 0,
      overlaps,
    };
  });

  expect(layout.columns).toBeGreaterThanOrEqual(3);
  expect(layout.minCardWidth).toBeGreaterThanOrEqual(250);
  expect(layout.overlaps).toEqual([]);
});

test('subscriptions modal ping-all button shows compact spinner while probing', async ({ page }) => {
  const nodes = buildDemoNodes();
  const subscription = buildDemoSubscription(nodes);
  let releaseBulkProbe;
  let resolveBulkProbeStarted;
  const bulkProbeStarted = new Promise((resolve) => {
    resolveBulkProbeStarted = resolve;
  });
  await page.route('**/api/xray/subscriptions/demo-sub/nodes/ping-bulk', async (route) => {
    resolveBulkProbeStarted();
    await new Promise((resume) => {
      releaseBulkProbe = resume;
    });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        requested: nodes.length,
        ok_count: nodes.length,
        failed_count: 0,
        results: nodes.map((node, index) => ({
          node_key: node.key,
          entry: {
            status: 'ok',
            delay_ms: 120 + index,
            checked_at: 1777778888,
          },
        })),
      }),
    });
  });

  await page.route('**/api/xray/subscriptions', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, subscriptions: [subscription] }),
    });
  });

  await openSubscriptionsModal(page);
  await page.locator('tr[data-sub-id="demo-sub"]').click();

  const pingAllBtn = page.locator('#outbounds-subscriptions-nodes-pingall');
  await expect(pingAllBtn).toBeEnabled();
  await pingAllBtn.click();
  await bulkProbeStarted;
  await expect(pingAllBtn).toHaveClass(/is-busy/);
  await expect(pingAllBtn).toHaveAttribute('aria-busy', 'true');
  await page.waitForTimeout(240);

  const busyState = await pingAllBtn.evaluate((button) => {
    const glyph = button.querySelector('.xk-sub-pingall-glyph');
    const spinner = button.querySelector('.xk-sub-pingall-spinner');
    const glyphStyle = glyph ? window.getComputedStyle(glyph) : null;
    const spinnerStyle = spinner ? window.getComputedStyle(spinner) : null;
    return {
      disabled: button.disabled,
      glyphOpacity: glyphStyle ? glyphStyle.opacity : '',
      spinnerOpacity: spinnerStyle ? spinnerStyle.opacity : '',
      spinnerAnimation: spinnerStyle ? spinnerStyle.animationName : '',
    };
  });

  expect(busyState.disabled).toBe(true);
  expect(Number(busyState.glyphOpacity)).toBeLessThan(0.15);
  expect(Number(busyState.spinnerOpacity)).toBeGreaterThan(0.95);
  expect(Number(busyState.spinnerOpacity)).toBeGreaterThan(Number(busyState.glyphOpacity));
  expect(busyState.spinnerAnimation).toBe('xk-sub-pingall-spin');

  releaseBulkProbe();
  await expect(pingAllBtn).not.toHaveClass(/is-busy/);
  await expect(pingAllBtn).not.toHaveAttribute('aria-busy', /./);
});

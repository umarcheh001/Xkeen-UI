import { test, expect } from './fixtures.mjs';

function buildDemoNodes() {
  const specs = [
    ['🇩🇪 de-XXX-Germany.98.1016', 'xhttp', 'tls', '195.133.25.89', 443, 'path=/api/v2/'],
    ['🇸🇪 se-YYY-Sweden.e026', 'xhttp', 'tls', '103.88.240.173', 443, 'path=/api/v2/'],
    ['🇳🇱 nl-YYY-Netherlands.0005', 'xhttp', 'tls', '176.124.210.220', 443, 'path=/api/v2/'],
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

function buildDemoSubscription(nodes = buildDemoNodes(), overrides = {}) {
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
    ...overrides,
  };
}

async function openSubscriptionsModal(page) {
  await page.goto('/');
  const body = page.locator('#outbounds-body');
  for (let attempt = 0; attempt < 3 && !(await body.isVisible()); attempt += 1) {
    await page.locator('#outbounds-header').click();
    await page.waitForTimeout(350);
  }
  await expect(body).toBeVisible();
  await page.locator('#outbounds-subscriptions-btn').click();
  await expect(page.locator('#outbounds-subscriptions-modal')).toBeVisible();
}

async function openOutboundsPanel(page) {
  await page.goto('/');
  const body = page.locator('#outbounds-body');
  for (let attempt = 0; attempt < 3 && !(await body.isVisible()); attempt += 1) {
    await page.locator('#outbounds-header').click();
    await page.waitForTimeout(350);
  }
  await expect(body).toBeVisible();
}

test('main outbounds card keeps proxy nodes inside scrollable panel', async ({ page }) => {
  const nodes = buildDemoNodes();
  const nodeLatency = buildNodeLatency(nodes);

  await page.addInitScript(() => {
    localStorage.setItem('xkeen.outbounds.fragment', '04_outbounds.json');
  });

  await page.route('**/api/ui-settings', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        settings: {
          schemaVersion: 2,
          editor: {
            engine: 'codemirror',
            codemirrorFontScale: 100,
            monacoFontScale: 100,
            schemaHoverEnabled: true,
            beginnerModeEnabled: true,
            expertModeEnabled: false,
          },
          format: { preferPrettier: false, tabWidth: 2, printWidth: 80 },
          logs: { ansi: false, ws2: false, view: {} },
          routing: {
            guiEnabled: false,
            autoApply: false,
            showActiveOutbound: true,
          },
        },
      }),
    });
  });

  await page.route('**/api/outbounds/fragments', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        dir: '/tmp/xray/configs',
        current: '04_outbounds.json',
        items: [{ name: '04_outbounds.json' }],
      }),
    });
  });

  const outboundsPayload = {
    ok: true,
    file: '04_outbounds.json',
    url: 'vless://demo@example.com:443?type=tcp&security=reality#demo',
    config: {
      outbounds: [
        { tag: 'proxy', protocol: 'vless' },
      ],
    },
  };

  await page.route('**/api/outbounds', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(outboundsPayload),
    });
  });

  await page.route('**/api/outbounds?**', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(outboundsPayload),
    });
  });

  await page.route('**/api/xray/outbounds/nodes**', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, nodes, node_latency: nodeLatency }),
    });
  });

  await page.route('**/api/xray/outbounds/active**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        available: true,
        reason: 'observed',
        active: {
          key: nodes[1].key,
          tag: nodes[1].tag,
          name: nodes[1].name,
          source: 'access',
          last_seen: '2026/05/22 20:10:05',
        },
      }),
    });
  });

  await openOutboundsPanel(page);
  await expect(page.locator('#outbounds-nodes-panel')).toBeVisible();
  await expect(page.locator('#outbounds-nodes-list .xk-outbounds-node-item')).toHaveCount(nodes.length);
  await expect(page.locator('#outbounds-active-node-status')).toContainText('Сейчас/последний выбор');
  await expect(page.locator('#outbounds-nodes-list .xk-outbounds-node-item.is-active-route')).toHaveCount(1);
  await expect(page.locator('#outbounds-nodes-list .xk-outbounds-node-item.is-active-route')).toContainText(nodes[1].name);
  await page.waitForTimeout(250);

  const layout = await page.evaluate(() => {
    const panel = document.querySelector('#outbounds-nodes-panel');
    const list = document.querySelector('#outbounds-nodes-list');
    const cards = Array.from(document.querySelectorAll('#outbounds-nodes-list .xk-outbounds-node-item'));
    const rects = cards.map((card, index) => {
      const rect = card.getBoundingClientRect();
      return {
        index,
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
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
    const listStyle = list ? window.getComputedStyle(list) : null;
    const panelStyle = panel ? window.getComputedStyle(panel) : null;
    return {
      panelOverflow: panelStyle ? panelStyle.overflow : '',
      listOverflowY: listStyle ? listStyle.overflowY : '',
      clientHeight: list ? Math.round(list.clientHeight) : 0,
      scrollHeight: list ? Math.round(list.scrollHeight) : 0,
      maxHeight: listStyle ? listStyle.maxHeight : '',
      display: listStyle ? listStyle.display : '',
      columns: new Set(rects.map((item) => Math.round(item.left))).size,
      cardHeights: rects.map((item) => Math.round(item.bottom - item.top)),
      detailsHidden: cards.every((card) => {
        const detail = card.querySelector('.xk-sub-node-detail');
        return !detail || window.getComputedStyle(detail).display === 'none';
      }),
      pingButtons: cards.map((card) => {
        const button = card.querySelector('.xk-outbounds-node-ping');
        const rect = button?.getBoundingClientRect();
        return {
          width: rect ? Math.round(rect.width) : 0,
          height: rect ? Math.round(rect.height) : 0,
          radius: button ? window.getComputedStyle(button).borderRadius : '',
        };
      }),
      pingAll: (() => {
        const button = document.querySelector('#outbounds-nodes-pingall');
        const rect = button?.getBoundingClientRect();
        return {
          width: rect ? Math.round(rect.width) : 0,
          height: rect ? Math.round(rect.height) : 0,
          radius: button ? window.getComputedStyle(button).borderRadius : '',
        };
      })(),
      summary: (() => {
        const badge = document.querySelector('#outbounds-nodes-summary');
        const style = badge ? window.getComputedStyle(badge) : null;
        return {
          radius: style ? style.borderRadius : '',
          backgroundImage: style ? style.backgroundImage : '',
        };
      })(),
      globalMarker: (() => {
        const marker = document.createElement('span');
        marker.className = 'xk-sub-node-country is-globe';
        list?.appendChild(marker);
        const rect = marker?.getBoundingClientRect();
        const result = {
          width: rect ? Math.round(rect.width) : 0,
          height: rect ? Math.round(rect.height) : 0,
          radius: marker ? window.getComputedStyle(marker).borderRadius : '',
        };
        marker.remove();
        return result;
      })(),
      latency: (() => {
        const badge = cards[0]?.querySelector('.xk-sub-node-latency');
        const style = badge ? window.getComputedStyle(badge) : null;
        return {
          radius: style ? style.borderRadius : '',
          backgroundImage: style ? style.backgroundImage : '',
        };
      })(),
      technicalTooltips: cards.map((card) => {
        const protocol = card.querySelector('.xk-sub-node-protocol');
        const endpoint = card.querySelector('.xk-sub-node-endpoint-cell');
        return {
          protocol: protocol?.getAttribute('data-tooltip') || '',
          endpoint: endpoint?.getAttribute('data-tooltip') || '',
        };
      }),
      overlaps,
    };
  });

  expect(layout.panelOverflow).toBe('hidden');
  expect(['auto', 'scroll']).toContain(layout.listOverflowY);
  expect(layout.maxHeight).not.toBe('none');
  expect(layout.scrollHeight).toBeGreaterThan(layout.clientHeight);
  expect(layout.display).toBe('grid');
  expect(layout.columns).toBeGreaterThanOrEqual(1);
  expect(layout.cardHeights.every((height) => height >= 72 && height <= 100)).toBe(true);
  expect(layout.detailsHidden).toBe(true);
  expect(layout.pingButtons.every((button) => (
    button.width === button.height && button.width >= 28 && button.radius === '50%'
  ))).toBe(true);
  expect(layout.pingAll.width).toBe(layout.pingAll.height);
  expect(layout.pingAll.width).toBeGreaterThanOrEqual(28);
  expect(layout.pingAll.radius).toBe('50%');
  expect(layout.summary.radius).toBe('6px');
  expect(layout.summary.backgroundImage).toBe('none');
  expect(layout.globalMarker).toEqual({ width: 20, height: 14, radius: '3px' });
  expect(layout.latency.radius).toBe('6px');
  expect(layout.latency.backgroundImage).toBe('none');
  expect(layout.technicalTooltips.every(({ protocol, endpoint }) => !protocol && !endpoint)).toBe(true);
  expect(layout.overlaps).toEqual([]);
});

test('main outbounds pool card relayouts cleanly after switching between Routing Xray and Routing Mihomo', async ({ page }) => {
  const nodes = buildDemoNodes();
  const nodeLatency = buildNodeLatency(nodes);

  await page.route('**/api/outbounds**', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        file: '04_outbounds.json',
        url: '',
        text: '// Generated by XKeen UI (outbounds pool)',
        config: {
          outbounds: nodes.map((node) => ({
            tag: node.tag,
            protocol: node.protocol,
          })),
        },
      }),
    });
  });

  await page.route('**/api/xray/outbounds/nodes**', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, nodes, node_latency: nodeLatency }),
    });
  });

  await page.route('**/api/mihomo-config', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, content: 'mode: rule\n' }),
    });
  });

  await page.route('**/api/mihomo-templates', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, templates: [] }),
    });
  });

  await openOutboundsPanel(page);
  await expect(page.locator('#outbounds-nodes-panel')).toBeVisible();
  await expect(page.locator('#outbounds-nodes-list .xk-outbounds-node-item')).toHaveCount(nodes.length);
  await expect(page.locator('#outbounds-body')).toHaveClass(/xk-outbounds-pool-fragment/);
  await expect(page.locator('#outbounds-body .outbounds-hints')).toBeHidden();

  const poolPresentation = await page.evaluate(() => {
    const summary = document.querySelector('#outbounds-fragment-summary');
    const flags = Array.from(document.querySelectorAll('#outbounds-nodes-list .xk-sub-node-country'));
    return {
      summaryVisible: !!summary && !summary.classList.contains('hidden')
        && window.getComputedStyle(summary).display !== 'none',
      flagCountries: flags.map((flag) => flag.getAttribute('data-country')),
      summaryMode: document.querySelector('#outbounds-body')?.classList.contains('xk-outbounds-summary-fragment') || false,
      hintsDisplay: window.getComputedStyle(document.querySelector('#outbounds-body .outbounds-hints')).display,
    };
  });
  expect(poolPresentation.summaryVisible).toBe(false);
  expect(poolPresentation.flagCountries).toContain('NL');
  expect(poolPresentation.flagCountries).toContain('DE');
  expect(poolPresentation.flagCountries).toContain('SE');
  expect(poolPresentation.summaryMode).toBe(true);
  expect(poolPresentation.hintsDisplay).toBe('none');

  await page.locator('.top-tab-btn[data-view="mihomo"]').click();
  await expect(page.locator('#view-mihomo')).toBeVisible();

  await page.locator('.top-tab-btn[data-view="routing"]').click();
  await expect(page.locator('#view-routing')).toBeVisible();
  await expect(page.locator('#outbounds-nodes-panel')).toBeVisible();
  await page.waitForTimeout(450);

  const layout = await page.evaluate(() => {
    const panel = document.querySelector('#outbounds-nodes-panel');
    const list = document.querySelector('#outbounds-nodes-list');
    const cards = Array.from(document.querySelectorAll('#outbounds-nodes-list .xk-outbounds-node-item'));
    const rects = cards.map((card, index) => {
      const rect = card.getBoundingClientRect();
      return {
        index,
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
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
    const listStyle = list ? window.getComputedStyle(list) : null;
    const panelStyle = panel ? window.getComputedStyle(panel) : null;
    return {
      panelOverflow: panelStyle ? panelStyle.overflow : '',
      listOverflowY: listStyle ? listStyle.overflowY : '',
      clientHeight: list ? Math.round(list.clientHeight) : 0,
      scrollHeight: list ? Math.round(list.scrollHeight) : 0,
      overlaps,
    };
  });

  expect(layout.panelOverflow).toBe('hidden');
  expect(['auto', 'scroll']).toContain(layout.listOverflowY);
  expect(layout.scrollHeight).toBeGreaterThan(layout.clientHeight);
  expect(layout.overlaps).toEqual([]);
});

test('main outbounds subscription fragment hides single-outbound technical fields', async ({ page }) => {
  const nodes = buildDemoNodes().slice(0, 2);
  const fragment = '04_outbounds.cdn.pecan.run.json';

  await page.addInitScript((selectedFragment) => {
    localStorage.setItem('xkeen.outbounds.fragment', selectedFragment);
  }, fragment);

  await page.route('**/api/outbounds/fragments', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        current: fragment,
        items: [{ name: fragment }],
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
      body: JSON.stringify({
        ok: true,
        subscriptions: [{ id: 'demo-sub', output_file: fragment }],
      }),
    });
  });

  await page.route('**/api/outbounds**', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        file: fragment,
        url: '',
        config: {
          outbounds: nodes.map((node) => ({ tag: node.tag, protocol: node.protocol })),
        },
      }),
    });
  });

  await page.route('**/api/xray/outbounds/nodes**', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, nodes, node_latency: buildNodeLatency(nodes) }),
    });
  });

  await openOutboundsPanel(page);
  await expect(page.locator('#outbounds-body')).toHaveClass(/xk-outbounds-subscription-fragment/);
  await expect(page.locator('#outbounds-body .outbounds-hints')).toBeHidden();
  await expect(page.locator('#outbounds-proto')).toBeHidden();
  await expect(page.locator('#outbounds-type')).toBeHidden();
  await expect(page.locator('#outbounds-security')).toBeHidden();
  await expect(page.locator('#outbounds-nodes-list .xk-outbounds-node-item')).toHaveCount(nodes.length);
});

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

test('subscriptions modal presents nodes as a compact server tile grid on desktop', async ({ page }) => {
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
      const endpoint = card.querySelector('.xk-sub-node-endpoint');
      return {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        right: Math.round(rect.right),
        bottom: Math.round(rect.bottom),
        width: Math.round(rect.width),
        endpoint: String(endpoint?.textContent || '').trim(),
        endpointDisplay: endpoint ? window.getComputedStyle(endpoint).display : '',
        endpointClipped: endpoint ? endpoint.scrollWidth > endpoint.clientWidth + 1 : true,
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
      minTileWidth: rects.length ? Math.min(...rects.map((item) => item.width)) : 0,
      maxTileWidth: rects.length ? Math.max(...rects.map((item) => item.width)) : 0,
      maxTileHeight: rects.length ? Math.max(...rects.map((item) => item.bottom - item.top)) : 0,
      endpoints: rects.map((item) => item.endpoint),
      endpointDisplays: rects.map((item) => item.endpointDisplay),
      clippedEndpoints: rects.filter((item) => item.endpointClipped).map((item) => item.endpoint),
      overlaps,
    };
  });

  expect(layout.columns).toBeGreaterThanOrEqual(5);
  expect(layout.modalWidth).toBeGreaterThanOrEqual(1280);
  expect(layout.minTileWidth).toBeGreaterThanOrEqual(232);
  expect(layout.maxTileWidth).toBeLessThanOrEqual(275);
  expect(layout.maxTileHeight).toBeLessThanOrEqual(88);
  expect(layout.endpoints).toContain('195.133.25.89:443');
  expect(layout.endpointDisplays.every((display) => display !== 'none')).toBe(true);
  expect(layout.clippedEndpoints).toEqual([]);
  expect(layout.overlaps).toEqual([]);
});

test('Xray server cards do not duplicate a country flag from the provider name', async ({ page }) => {
  const nodes = buildDemoNodes().slice(0, 3);
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

  const cards = page.locator('#outbounds-subscriptions-nodes-list .xk-sub-node-item');
  await expect(cards).toHaveCount(3);
  await expect(cards.nth(0).locator('.xk-sub-node-country')).toHaveAttribute('data-country', 'DE');
  await expect(cards.nth(0).locator('.xk-sub-node-title-text')).toHaveText('de-XXX-Germany.98.1016');
  await expect(cards.nth(1).locator('.xk-sub-node-title-text')).toHaveText('se-YYY-Sweden.e026');
  await expect(cards.nth(2).locator('.xk-sub-node-title-text')).toHaveText('nl-YYY-Netherlands.0005');
});

test('Xray latency values use the same color scale as Mihomo', async ({ page }) => {
  const nodes = buildDemoNodes().slice(0, 3);
  const subscription = buildDemoSubscription(nodes, {
    node_latency: {
      [nodes[0].key]: { status: 'ok', delay_ms: 200, checked_at: 1777777777 },
      [nodes[1].key]: { status: 'ok', delay_ms: 500, checked_at: 1777777777 },
      [nodes[2].key]: { status: 'ok', delay_ms: 900, checked_at: 1777777777 },
    },
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

  const probes = page.locator('#outbounds-subscriptions-nodes-list .xk-xray-node-probe');
  await expect(probes).toHaveCount(3);
  await expect(probes.nth(0)).toHaveAttribute('data-probe-tone', 'good');
  await expect(probes.nth(1)).toHaveAttribute('data-probe-tone', 'warning');
  await expect(probes.nth(2)).toHaveAttribute('data-probe-tone', 'bad');

  const colors = await probes.evaluateAll((items) => items.map((item) => window.getComputedStyle(item).color));
  expect(new Set(colors).size).toBe(3);
});

test('subscriptions servers expand into a resized modal and keep compact actions', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1200 });
  const nodes = Array.from({ length: 30 }, (_, index) => ({
    ...buildDemoNodes()[index % buildDemoNodes().length],
    key: `resized-node-${index + 1}`,
    name: `Resized server ${index + 1}`,
    tag: `demo-sub--resized-node-${index + 1}`,
  }));
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
  await expect(page.locator('#outbounds-subscriptions-nodes-list .xk-sub-node-item')).toHaveCount(nodes.length);

  await page.locator('#outbounds-subscriptions-modal .modal-content').evaluate((node) => {
    node.style.width = '1300px';
    node.style.height = '1000px';
  });
  await page.waitForTimeout(100);

  const layout = await page.evaluate(() => {
    const box = (node) => {
      const rect = node?.getBoundingClientRect();
      return rect ? {
        height: Math.round(rect.height),
        clientHeight: node.clientHeight,
        scrollHeight: node.scrollHeight,
      } : null;
    };
    const modal = document.querySelector('#outbounds-subscriptions-modal .modal-content');
    const body = document.querySelector('#outbounds-subscriptions-modal .modal-body');
    const list = document.querySelector('#outbounds-subscriptions-nodes-list');
    const ping = document.querySelector('#outbounds-subscriptions-nodes-list .xk-sub-node-ping');
    const exclude = document.querySelector('#outbounds-subscriptions-nodes-list .xk-sub-node-toggle');
    return {
      modal: box(modal),
      body: box(body),
      list: box(list),
      ping: ping ? {
        width: Math.round(ping.getBoundingClientRect().width),
        height: Math.round(ping.getBoundingClientRect().height),
        radius: window.getComputedStyle(ping).borderRadius,
      } : null,
      exclude: exclude ? {
        width: Math.round(exclude.getBoundingClientRect().width),
        height: Math.round(exclude.getBoundingClientRect().height),
        radius: window.getComputedStyle(exclude).borderRadius,
        background: window.getComputedStyle(exclude).backgroundColor,
      } : null,
    };
  });

  expect(layout.modal.height).toBeGreaterThanOrEqual(990);
  expect(layout.body.scrollHeight).toBeLessThanOrEqual(layout.body.clientHeight + 1);
  expect(layout.list.height).toBeGreaterThan(350);
  expect(layout.list.scrollHeight).toBeGreaterThan(layout.list.clientHeight);
  expect(layout.ping.width).toBeGreaterThanOrEqual(28);
  expect(layout.ping.height).toBe(22);
  expect(layout.ping.radius).toBe('4px');
  expect(layout.exclude.width).toBe(layout.exclude.height);
  expect(layout.exclude.width).toBe(22);
  expect(layout.exclude.radius).not.toBe('50%');
  expect(layout.exclude.background).toBe('rgba(0, 0, 0, 0)');
});

test('subscriptions advanced settings keep a consistent inner gutter', async ({ page }) => {
  const subscription = buildDemoSubscription();
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
  const advanced = page.locator('#outbounds-subscriptions-modal .xk-sub-advanced');
  if (!(await advanced.getAttribute('open'))) await advanced.locator('summary').click();

  const spacing = await advanced.evaluate((root) => {
    const summary = root.querySelector(':scope > summary');
    const grid = root.querySelector('.xk-sub-advanced-grid');
    const summaryStyle = summary ? window.getComputedStyle(summary) : null;
    const gridStyle = grid ? window.getComputedStyle(grid) : null;
    return {
      summaryLeft: summaryStyle ? Number.parseFloat(summaryStyle.paddingLeft) : 0,
      summaryRight: summaryStyle ? Number.parseFloat(summaryStyle.paddingRight) : 0,
      gridLeft: gridStyle ? Number.parseFloat(gridStyle.paddingLeft) : 0,
      gridRight: gridStyle ? Number.parseFloat(gridStyle.paddingRight) : 0,
      gridBottom: gridStyle ? Number.parseFloat(gridStyle.paddingBottom) : 0,
    };
  });

  expect(spacing.summaryLeft).toBeGreaterThanOrEqual(12);
  expect(spacing.summaryRight).toBeGreaterThanOrEqual(12);
  expect(spacing.gridLeft).toBeGreaterThanOrEqual(12);
  expect(spacing.gridRight).toBeGreaterThanOrEqual(12);
  expect(spacing.gridBottom).toBeGreaterThanOrEqual(12);
});

test('subscriptions form uses icon-only actions and themed advanced controls', async ({ page }) => {
  await page.route('**/api/xray/subscriptions', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, subscriptions: [] }),
    });
  });

  await openSubscriptionsModal(page);

  const contract = await page.evaluate(() => {
    const iconName = (node) => String(node?.querySelector('use')?.getAttribute('href') || '').split('#xk-').pop();
    const actionIds = [
      'outbounds-subscriptions-preview-btn',
      'outbounds-subscriptions-reset-btn',
      'outbounds-subscriptions-save-btn',
    ];
    const checkIds = [
      'outbounds-subscriptions-enabled',
      'outbounds-subscriptions-ping',
      'outbounds-subscriptions-refresh-now',
      'outbounds-subscriptions-routing-auto-rule',
    ];
    const advanced = document.querySelector('#outbounds-subscriptions-modal .xk-sub-advanced');
    const caret = advanced?.querySelector('.xk-sub-advanced-caret');
    advanced?.querySelector('summary')?.click();
    return {
      actions: actionIds.map((id) => {
        const node = document.getElementById(id);
        return { id, label: node?.getAttribute('aria-label'), text: String(node?.textContent || '').trim(), icon: iconName(node) };
      }),
      checks: checkIds.map((id) => {
        const input = document.getElementById(id);
        const label = input?.closest('.xk-sub-check');
        const labelRect = label?.getBoundingClientRect();
        const inputRect = input?.getBoundingClientRect();
        const iconRect = label?.querySelector('.xk-sub-check-icon')?.getBoundingClientRect();
        return {
          id,
          label: label?.getAttribute('aria-label'),
          inputLabel: input?.getAttribute('aria-label'),
          text: String(label?.textContent || '').trim(),
          icon: iconName(label),
          inputOffset: inputRect && labelRect ? Math.round(inputRect.left - labelRect.left) : -1,
          iconOffset: iconRect && labelRect ? Math.round(iconRect.left - labelRect.left) : -1,
        };
      }),
      hasCaret: !!caret,
      advancedOpen: !!advanced?.open,
    };
  });

  expect(contract.actions).toEqual([
    { id: 'outbounds-subscriptions-preview-btn', label: 'Скачать подписку (предпросмотр)', text: '', icon: 'download' },
    { id: 'outbounds-subscriptions-reset-btn', label: 'Очистить форму', text: '', icon: 'restore' },
    { id: 'outbounds-subscriptions-save-btn', label: 'Сохранить настройки', text: '', icon: 'save' },
  ]);
  expect(contract.checks).toEqual([
    expect.objectContaining({ id: 'outbounds-subscriptions-enabled', label: 'Авто', inputLabel: 'Авто', text: '', icon: 'refresh' }),
    expect.objectContaining({ id: 'outbounds-subscriptions-ping', label: 'Пинг', inputLabel: 'Пинг', text: '', icon: 'ping' }),
    expect.objectContaining({ id: 'outbounds-subscriptions-refresh-now', label: 'Обновить', inputLabel: 'Обновить', text: '', icon: 'download' }),
    expect.objectContaining({ id: 'outbounds-subscriptions-routing-auto-rule', label: 'Служебный пул', inputLabel: 'Служебный пул', text: '', icon: 'pool' }),
  ]);
  for (const check of contract.checks) {
    expect(check.inputOffset).toBeGreaterThanOrEqual(9);
    expect(check.iconOffset).toBeGreaterThan(check.inputOffset + 20);
  }
  expect(contract.hasCaret).toBe(true);
  expect(contract.advancedOpen).toBe(true);
});

test('subscriptions routing controls stay compact and balancers wrap as tiles', async ({ page }) => {
  const subscription = buildDemoSubscription([], {
    routing_balancer_tags: ['proxy-eu', 'proxy-us'],
  });
  const routingBalancers = [
    { tag: 'proxy-eu', strategy_type: 'leastPing', fallback_tag: 'direct', selector_count: 4 },
    { tag: 'proxy-us', strategy_type: 'leastPing', fallback_tag: 'direct', selector_count: 6 },
    { tag: 'media-streaming', strategy_type: 'leastLoad', fallback_tag: '', selector_count: 3 },
    { tag: 'gaming', strategy_type: 'leastPing', fallback_tag: 'proxy', selector_count: 2 },
    { tag: 'long-balancer-name-for-layout-check', strategy_type: 'leastPing', fallback_tag: 'direct', selector_count: 9 },
  ];
  await page.route('**/api/xray/subscriptions', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, subscriptions: [subscription], routing_balancers: routingBalancers }),
    });
  });

  await openSubscriptionsModal(page);
  await page.locator('tr[data-sub-id="demo-sub"]').click();
  const advanced = page.locator('#outbounds-subscriptions-modal .xk-sub-advanced');
  if (!(await advanced.getAttribute('open'))) await advanced.locator('summary').click();
  await expect(page.locator('#outbounds-subscriptions-routing-balancers .xk-sub-balancer-check')).toHaveCount(routingBalancers.length);

  const layout = await page.evaluate(() => {
    const root = document.querySelector('#outbounds-subscriptions-routing-balancers');
    const mode = document.querySelector('#outbounds-subscriptions-routing-mode');
    const modeLabel = document.querySelector('.xk-sub-routing-mode .xk-sub-inline-label');
    const cards = Array.from(root?.querySelectorAll('.xk-sub-balancer-check') || []);
    const rootRect = root?.getBoundingClientRect();
    const modeRect = mode?.getBoundingClientRect();
    const modeLabelRect = modeLabel?.getBoundingClientRect();
    const cardsMeta = cards.map((card) => {
      const cardRect = card.getBoundingClientRect();
      const checkRect = card.querySelector('input')?.getBoundingClientRect();
      const copyRect = card.querySelector('.xk-sub-balancer-copy')?.getBoundingClientRect();
      return {
        left: Math.round(cardRect.left),
        width: Math.round(cardRect.width),
        checkboxTop: checkRect && copyRect ? Math.round(checkRect.top - copyRect.top) : -99,
      };
    });
    return {
      rootWidth: rootRect ? Math.round(rootRect.width) : 0,
      modeWidth: modeRect ? Math.round(modeRect.width) : 0,
      modeLabelAboveSelect: !!(modeLabelRect && modeRect && modeLabelRect.bottom <= modeRect.top + 1),
      modeAlignedWithBalancers: !!(rootRect && modeRect && Math.abs(rootRect.left - modeRect.left) <= 1),
      columns: new Set(cardsMeta.map((item) => item.left)).size,
      cards: cardsMeta,
    };
  });

  expect(layout.modeWidth).toBeLessThanOrEqual(250);
  expect(layout.modeWidth).toBeLessThan(layout.rootWidth * 0.6);
  expect(layout.modeLabelAboveSelect).toBe(true);
  expect(layout.modeAlignedWithBalancers).toBe(true);
  expect(layout.columns).toBeGreaterThanOrEqual(2);
  expect(layout.cards.every((card) => card.width <= 282)).toBe(true);
  expect(layout.cards.every((card) => card.checkboxTop >= 0 && card.checkboxTop <= 6)).toBe(true);
});

test('subscriptions diagnostics collapses and uses Operator controls', async ({ page }) => {
  const subscription = buildDemoSubscription();
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

  const contract = await page.evaluate(() => {
    const diagnostics = document.querySelector('#outbounds-subscriptions-diagnostics');
    const summary = diagnostics?.querySelector('summary');
    const body = diagnostics?.querySelector('.xk-sub-diag-body');
    const caret = diagnostics?.querySelector('.xk-sub-diag-caret');
    const pill = diagnostics?.querySelector('.xk-sub-diag-pill');
    const pingAll = document.querySelector('#outbounds-subscriptions-nodes-pingall');
    const bodyStyle = window.getComputedStyle(document.body);
    const swatch = document.createElement('span');
    swatch.style.background = bodyStyle.getPropertyValue('--op-accent-soft').trim();
    document.body.appendChild(swatch);
    const accentSoft = window.getComputedStyle(swatch).backgroundColor;
    swatch.remove();
    summary?.click();
    const collapsed = {
      open: !!diagnostics?.open,
      bodyHeight: body ? Math.round(body.getBoundingClientRect().height) : -1,
    };
    summary?.click();
    const pingRect = pingAll?.getBoundingClientRect();
    return {
      hasCaret: !!caret,
      reopened: !!diagnostics?.open,
      collapsed,
      pillBackground: pill ? window.getComputedStyle(pill).backgroundColor : '',
      accentSoft,
      pingWidth: pingRect ? Math.round(pingRect.width) : 0,
      pingHeight: pingRect ? Math.round(pingRect.height) : 0,
    };
  });

  expect(contract.hasCaret).toBe(true);
  expect(contract.collapsed.open).toBe(false);
  expect(contract.collapsed.bodyHeight).toBe(0);
  expect(contract.reopened).toBe(true);
  expect(contract.pillBackground).toBe(contract.accentSoft);
  expect(contract.pingWidth).toBe(contract.pingHeight);
  expect(contract.pingWidth).toBeGreaterThanOrEqual(28);
});

test('subscriptions workbench collapses empty rows and keeps refresh due in the list header', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  const nodes = buildDemoNodes().slice(0, 7);
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
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.locator('tr[data-sub-id="demo-sub"]').click();
  const advanced = page.locator('#outbounds-subscriptions-modal .xk-sub-advanced');
  if (!(await advanced.getAttribute('open'))) await advanced.locator('summary').click();

  const layout = await page.evaluate(() => {
    const modal = document.querySelector('#outbounds-subscriptions-modal .xk-sub-modal');
    const listPanel = document.querySelector('#outbounds-subscriptions-modal .xk-sub-list-panel');
    const panelHead = listPanel?.querySelector('.xk-sub-panelhead');
    const due = document.querySelector('#outbounds-subscriptions-refresh-due-btn');
    const tableWrap = document.querySelector('#outbounds-subscriptions-modal .xk-sub-tablewrap');
    const table = tableWrap?.querySelector('table');
    const nodesList = document.querySelector('#outbounds-subscriptions-nodes-list');
    const cards = Array.from(nodesList?.querySelectorAll('.xk-sub-node-item') || []);
    const hiddenNotes = Array.from(document.querySelectorAll('#outbounds-subscriptions-form .xk-sub-field-note[hidden]'));
    const modalRect = modal?.getBoundingClientRect();
    const headRect = panelHead?.getBoundingClientRect();
    const dueRect = due?.getBoundingClientRect();
    const tableRect = table?.getBoundingClientRect();
    const wrapRect = tableWrap?.getBoundingClientRect();
    const listRect = nodesList?.getBoundingClientRect();
    const cardBottom = cards.length
      ? Math.max(...cards.map((card) => card.getBoundingClientRect().bottom))
      : 0;
    return {
      modalHeight: modalRect ? Math.round(modalRect.height) : 0,
      dueInsideHead: !!(headRect && dueRect && dueRect.top >= headRect.top - 1 && dueRect.bottom <= headRect.bottom + 1),
      tableSlack: tableRect && wrapRect ? Math.round(wrapRect.height - tableRect.height) : 999,
      nodeSlack: listRect && cardBottom ? Math.round(listRect.bottom - cardBottom) : 999,
      hiddenNotesVisible: hiddenNotes.filter((note) => window.getComputedStyle(note).display !== 'none').length,
    };
  });

  expect(layout.dueInsideHead).toBe(true);
  expect(layout.tableSlack).toBeLessThanOrEqual(3);
  expect(layout.nodeSlack).toBeLessThanOrEqual(3);
  expect(layout.hiddenNotesVisible).toBe(0);
  expect(layout.modalHeight).toBeLessThan(1000);
});

test('subscriptions help expands below its summary without a blank split column', async ({ page }) => {
  await page.route('**/api/xray/subscriptions', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, subscriptions: [] }),
    });
  });

  await openSubscriptionsModal(page);
  await page.locator('#outbounds-subscriptions-modal .xk-sub-brief > summary').click();

  const layout = await page.evaluate(() => {
    const details = document.querySelector('#outbounds-subscriptions-modal .xk-sub-brief');
    const summary = details ? details.querySelector(':scope > summary') : null;
    const content = details ? details.querySelector('.xk-sub-brief-content') : null;
    const detailsRect = details ? details.getBoundingClientRect() : null;
    const summaryRect = summary ? summary.getBoundingClientRect() : null;
    const contentRect = content ? content.getBoundingClientRect() : null;
    return {
      display: details ? window.getComputedStyle(details).display : '',
      contentBelowSummary: !!(summaryRect && contentRect && contentRect.top >= summaryRect.bottom - 1),
      contentWidth: contentRect ? Math.round(contentRect.width) : 0,
      detailsWidth: detailsRect ? Math.round(detailsRect.width) : 0,
    };
  });

  expect(layout.display).toBe('block');
  expect(layout.contentBelowSummary).toBe(true);
  expect(layout.contentWidth).toBeGreaterThanOrEqual(layout.detailsWidth - 4);
});

test('subscriptions modal checkboxes use the Operator accent in both themes', async ({ page }) => {
  await page.route('**/api/xray/subscriptions', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, subscriptions: [] }),
    });
  });

  await openSubscriptionsModal(page);

  const readTheme = async (theme) => page.evaluate((nextTheme) => {
    document.documentElement.dataset.theme = nextTheme;
    const input = document.querySelector('#outbounds-subscriptions-enabled');
    const label = input ? input.closest('.xk-sub-check') : null;
    const bodyStyle = window.getComputedStyle(document.body);
    const inputStyle = input ? window.getComputedStyle(input) : null;
    const labelStyle = label ? window.getComputedStyle(label) : null;
    const swatch = document.createElement('span');
    swatch.style.backgroundColor = bodyStyle.getPropertyValue('--op-accent').trim();
    document.body.appendChild(swatch);
    const resolvedAccent = window.getComputedStyle(swatch).backgroundColor;
    swatch.remove();
    return {
      appearance: inputStyle ? inputStyle.appearance : '',
      inputBackground: inputStyle ? inputStyle.backgroundColor : '',
      inputBorder: inputStyle ? inputStyle.borderTopColor : '',
      labelBackground: labelStyle ? labelStyle.backgroundColor : '',
      resolvedAccent,
    };
  }, theme);

  const dark = await readTheme('dark');
  const light = await readTheme('light');

  for (const state of [dark, light]) {
    expect(state.appearance).toBe('none');
    expect(state.inputBackground).toBe(state.resolvedAccent);
    expect(state.inputBorder).toBe(state.resolvedAccent);
    expect(state.labelBackground).not.toBe('rgba(0, 0, 0, 0)');
  }
  expect(dark.resolvedAccent).not.toBe(light.resolvedAccent);
});

test('subscriptions modal keeps its workbench frame available on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/xray/subscriptions', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, subscriptions: [] }),
    });
  });

  await openSubscriptionsModal(page);

  const layout = await page.evaluate(() => {
    const modal = document.querySelector('#outbounds-subscriptions-modal .xk-sub-modal');
    const header = modal ? modal.querySelector('.modal-header') : null;
    const body = modal ? modal.querySelector('.modal-body') : null;
    const modalRect = modal ? modal.getBoundingClientRect() : null;
    const headerRect = header ? header.getBoundingClientRect() : null;
    return {
      width: modalRect ? Math.round(modalRect.width) : 0,
      height: modalRect ? Math.round(modalRect.height) : 0,
      bodyOverflowY: body ? window.getComputedStyle(body).overflowY : '',
      headerInside: !!(modalRect && headerRect && headerRect.top >= modalRect.top && headerRect.bottom <= modalRect.bottom),
      topClose: modal ? modal.querySelectorAll('#outbounds-subscriptions-close-btn').length : 0,
      duplicateClose: modal ? modal.querySelectorAll('#outbounds-subscriptions-cancel-btn').length : 0,
      footer: modal ? modal.querySelector('.modal-actions') : null,
    };
  });

  expect(layout.width).toBeGreaterThanOrEqual(374);
  expect(layout.height).toBeLessThanOrEqual(828);
  expect(['auto', 'scroll']).toContain(layout.bodyOverflowY);
  expect(layout.headerInside).toBe(true);
  expect(layout.topClose).toBe(1);
  expect(layout.duplicateClose).toBe(0);
  expect(layout.footer).toBeNull();
});

test('subscriptions modal does not reserve an empty desktop canvas without nodes', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.route('**/api/xray/subscriptions', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, subscriptions: [] }),
    });
  });

  await openSubscriptionsModal(page);

  const layout = await page.evaluate(() => {
    const modal = document.querySelector('#outbounds-subscriptions-modal .xk-sub-modal');
    const body = modal ? modal.querySelector('.modal-body') : null;
    const modalRect = modal ? modal.getBoundingClientRect() : null;
    return {
      height: modalRect ? Math.round(modalRect.height) : 0,
      bodyScrollHeight: body ? Math.round(body.scrollHeight) : 0,
      hasNodes: !!document.querySelector('#outbounds-subscriptions-nodes-list .xk-sub-node-item'),
    };
  });

  expect(layout.hasNodes).toBe(false);
  expect(layout.height).toBeLessThan(760);
  expect(layout.height).toBeGreaterThanOrEqual(layout.bodyScrollHeight);
});

test('subscriptions diagnostics keep long source links compact without horizontal scroll', async ({ page }) => {
  const nodes = buildDemoNodes();
  const longSourceUrl = 'happ://crypt5/fzvdf6IVsHlFRwbbqoJGcN3Q96xpQiLGj3a2IAJF1PcBOQafyFLmnBB7JgOgXgyQCyUoemrxWpf9nw8ImicCMniTzOjk7tk6MZJxTFQFtlvIf8u36BlS8Kl4RPbkUUsy';
  const subscription = buildDemoSubscription(nodes, {
    last_warnings: [
      `Подписка была получена через Happ helper-дешифратор. Источник: ${longSourceUrl}`,
    ],
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
  await expect(page.locator('#outbounds-subscriptions-diagnostics-body')).toContainText('Источник:');
  await expect(page.locator('#outbounds-subscriptions-diagnostics-body .xk-sub-diag-url code')).toBeVisible();
  await page.waitForTimeout(200);

  const diagnostics = await page.evaluate(() => {
    const body = document.querySelector('#outbounds-subscriptions-diagnostics-body');
    const groups = Array.from(document.querySelectorAll('#outbounds-subscriptions-diagnostics-body .xk-sub-diag-group'));
    const urlChip = document.querySelector('#outbounds-subscriptions-diagnostics-body .xk-sub-diag-url');
    const urlCode = urlChip ? urlChip.querySelector('code') : null;
    const maxGroupOverflow = groups.reduce((max, node) => (
      Math.max(max, Math.max(0, Math.round(node.scrollWidth - node.clientWidth)))
    ), 0);
    return {
      bodyOverflow: body ? Math.max(0, Math.round(body.scrollWidth - body.clientWidth)) : 0,
      maxGroupOverflow,
      shortUrl: urlCode ? String(urlCode.textContent || '').trim() : '',
      fullUrl: urlChip ? String(urlChip.getAttribute('data-full-url') || urlChip.getAttribute('title') || '') : '',
    };
  });

  expect(diagnostics.bodyOverflow).toBeLessThanOrEqual(4);
  expect(diagnostics.maxGroupOverflow).toBeLessThanOrEqual(4);
  expect(diagnostics.shortUrl.length).toBeGreaterThan(0);
  expect(diagnostics.shortUrl.length).toBeLessThan(diagnostics.fullUrl.length);
  expect(diagnostics.shortUrl).toContain('crypt5');
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
  // The glyph fades through a CSS transition; wait for the settled state
  // instead of sampling at an arbitrary point in that transition.
  await expect.poll(() => pingAllBtn.evaluate((button) => {
    const glyph = button.querySelector('.xk-sub-pingall-glyph');
    return glyph ? Number.parseFloat(window.getComputedStyle(glyph).opacity) : 0;
  })).toBeLessThan(0.15);

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

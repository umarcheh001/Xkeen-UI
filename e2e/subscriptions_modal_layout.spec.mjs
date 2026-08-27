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

test('global toasts stay above the runtime Xray subscriptions modal', async ({ page }) => {
  await page.route('**/api/xray/subscriptions', async (route) => {
    await route.fulfill({ json: { ok: true, subscriptions: [] } });
  });
  await openSubscriptionsModal(page);

  await page.evaluate(() => window.toast('Тестовая ошибка подписки Xray.', 'error'));
  const toast = page.locator('#toast-container .toast').last();
  await expect(toast).toBeVisible();

  const layers = await page.evaluate(() => {
    const modal = document.querySelector('#outbounds-subscriptions-modal');
    const container = document.querySelector('#toast-container');
    const toastNode = container?.querySelector('.toast:last-child');
    const toastRect = toastNode?.getBoundingClientRect();
    const point = toastRect
      ? document.elementFromPoint(toastRect.left + toastRect.width / 2, toastRect.top + toastRect.height / 2)
      : null;
    return {
      portalAtBodyRoot: container?.parentElement === document.body,
      modalZ: Number(getComputedStyle(modal).zIndex || 0),
      toastZ: Number(getComputedStyle(container).zIndex || 0),
      toastOwnsTopPoint: !!(point && point.closest('#toast-container')),
    };
  });

  expect(layers.portalAtBodyRoot).toBe(true);
  expect(layers.toastZ).toBeGreaterThan(layers.modalZ);
  expect(layers.toastOwnsTopPoint).toBe(true);
});

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
  await expect(page.locator('#outbounds-nodes-list .xk-outbounds-node-item.is-active-route')).toContainText('se-YYY-Sweden.e026');
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
    button.width >= 24 && button.height === 22 && button.radius === '4px'
  ))).toBe(true);
  expect(layout.pingAll.width).toBe(layout.pingAll.height);
  expect(layout.pingAll.width).toBeGreaterThanOrEqual(28);
  expect(layout.pingAll.radius).toBe('50%');
  expect(layout.summary.radius).toBe('6px');
  expect(layout.summary.backgroundImage).toBe('none');
  expect(layout.globalMarker).toEqual({ width: 20, height: 14, radius: '3px' });
  expect(layout.latency.radius).toBe('4px');
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
  await page.clock.install({ time: new Date('2026-05-03T03:09:37Z') });
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

test('Xray server cards use Mihomo-style latency icons, concise hints and history', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-05-03T03:09:37Z') });
  const nodes = buildDemoNodes().slice(0, 3);
  const checkedAt = 1777777777;
  const subscription = buildDemoSubscription(nodes, {
    node_latency: {
      [nodes[0].key]: {
        status: 'ok', delay_ms: 180, checked_at: checkedAt,
        history: [
          { status: 'ok', delay_ms: 180, checked_at: checkedAt },
          { status: 'ok', delay_ms: 240, checked_at: checkedAt - 60 },
        ],
      },
      [nodes[1].key]: {
        status: 'error', error: 'timeout', checked_at: checkedAt,
        history: [{ status: 'error', error: 'timeout', checked_at: checkedAt }],
      },
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
  const measured = probes.nth(0);
  const failed = probes.nth(1);
  const idle = probes.nth(2);

  await expect(measured).toHaveText('180 мс');
  await expect(measured).toHaveAttribute('data-xray-delay-history', '1');
  await expect(measured).toHaveAttribute('data-tooltip-silent', '1');
  await expect(failed.locator('use')).toHaveAttribute('href', /#xk-alert$/);
  await expect(idle.locator('use')).toHaveAttribute('href', /#xk-bolt$/);
  await expect(idle).toHaveAttribute('data-tooltip', 'Задержка не измерена. Нажмите, чтобы проверить.');

  await measured.hover();
  const history = page.locator('#xray-delay-history-popover');
  await expect(history).toBeVisible();
  await expect(history).toContainText('История задержки');
  await expect(history).toContainText('180 мс');
  await expect(history).toContainText('240 мс');
  await expect(history.locator('.xk-xray-delay-history-row')).toHaveCount(2);
});

test('Xray latency stays visible but becomes muted after five minutes on cards and in subscriptions', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-08-18T20:00:00Z') });
  const nodes = buildDemoNodes().slice(0, 1);
  const checkedAt = Date.parse('2026-08-18T20:00:00Z') / 1000;
  const nodeLatency = {
    [nodes[0].key]: {
      status: 'ok', delay_ms: 180, checked_at: checkedAt,
      history: [{ status: 'ok', delay_ms: 180, checked_at: checkedAt }],
    },
  };
  const subscription = buildDemoSubscription(nodes, { node_latency: nodeLatency });

  await page.addInitScript(() => {
    localStorage.setItem('xkeen.outbounds.fragment', '04_outbounds.json');
  });
  await page.route('**/api/outbounds/fragments', (route) => route.fulfill({
    json: {
      ok: true, dir: '/tmp/xray/configs', current: '04_outbounds.json',
      items: [{ name: '04_outbounds.json' }],
    },
  }));
  await page.route('**/api/outbounds**', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({
      json: {
        ok: true,
        file: '04_outbounds.json',
        url: 'vless://demo@example.com:443?type=tcp&security=reality#demo',
        config: { outbounds: [{ tag: 'proxy', protocol: 'vless' }] },
      },
    });
  });
  await page.route('**/api/xray/outbounds/nodes**', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({ json: { ok: true, nodes, node_latency: nodeLatency } });
  });
  await page.route('**/api/xray/outbounds/active**', (route) => route.fulfill({
    json: { ok: true, available: false, active: null, reason: 'no_match' },
  }));
  await page.route('**/api/xray/subscriptions', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({ json: { ok: true, subscriptions: [subscription] } });
  });

  await openOutboundsPanel(page);
  const cardProbe = page.locator('#outbounds-nodes-list .xk-xray-node-probe');
  await expect(cardProbe).toHaveText('180 мс');
  await expect(cardProbe).toHaveAttribute('data-probe-tone', 'good');

  await page.locator('#outbounds-subscriptions-btn').click();
  await expect(page.locator('#outbounds-subscriptions-modal')).toBeVisible();
  await page.locator('tr[data-sub-id="demo-sub"]').click();
  const subscriptionProbe = page.locator('#outbounds-subscriptions-nodes-list .xk-xray-node-probe');
  await expect(subscriptionProbe).toHaveText('180 мс');
  await expect(subscriptionProbe).toHaveAttribute('data-probe-tone', 'good');

  await page.clock.fastForward((5 * 60 * 1000) + 100);
  await expect(cardProbe).toHaveText('180 мс');
  await expect(cardProbe).toHaveAttribute('data-probe-tone', 'stale');
  await expect(subscriptionProbe).toHaveText('180 мс');
  await expect(subscriptionProbe).toHaveAttribute('data-probe-tone', 'stale');

  const staleOpacity = await subscriptionProbe.evaluate((node) => window.getComputedStyle(node).opacity);
  expect(Number(staleOpacity)).toBeLessThan(1);
});

test('subscriptions servers expand into a resized modal and keep compact actions', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1200 });
  const nodes = Array.from({ length: 60 }, (_, index) => ({
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
  expect(layout.list.height).toBeGreaterThan(350);
  // The server list grows with its cards instead of scrolling inside itself;
  // the window is what scrolls once the cards outgrow the modal.
  expect(layout.list.scrollHeight).toBeLessThanOrEqual(layout.list.clientHeight + 1);
  expect(layout.body.scrollHeight).toBeGreaterThan(layout.body.clientHeight);
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

test('subscriptions form uses icon-only actions, visible switches, and themed advanced controls', async ({ page }) => {
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
        const slider = label?.querySelector('.dt-switch-slider');
        const sliderRect = slider?.getBoundingClientRect();
        return {
          id,
          label: label?.getAttribute('aria-label'),
          inputLabel: input?.getAttribute('aria-label'),
          text: String(label?.textContent || '').trim(),
          inputOpacity: input ? window.getComputedStyle(input).opacity : '',
          sliderOffset: sliderRect && labelRect ? Math.round(sliderRect.left - labelRect.left) : -1,
          sliderWidth: sliderRect ? Math.round(sliderRect.width) : 0,
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
    expect.objectContaining({ id: 'outbounds-subscriptions-enabled', label: 'Авто', inputLabel: 'Авто', text: 'Автообн.', inputOpacity: '0' }),
    expect.objectContaining({ id: 'outbounds-subscriptions-ping', label: 'Пинг', inputLabel: 'Пинг', text: 'Пинг', inputOpacity: '0' }),
    expect.objectContaining({ id: 'outbounds-subscriptions-refresh-now', label: 'Обновить', inputLabel: 'Обновить', text: 'Сразу', inputOpacity: '0' }),
    expect.objectContaining({ id: 'outbounds-subscriptions-routing-auto-rule', label: 'Служебный пул', inputLabel: 'Служебный пул', text: 'Pool', inputOpacity: '0' }),
  ]);
  for (const check of contract.checks) {
    expect(check.sliderOffset).toBeGreaterThanOrEqual(9);
    expect(check.sliderWidth).toBeGreaterThanOrEqual(30);
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
      const input = card.querySelector('input');
      const checkRect = input?.getBoundingClientRect();
      const copyRect = card.querySelector('.xk-sub-balancer-copy')?.getBoundingClientRect();
      const inputStyle = input ? window.getComputedStyle(input) : null;
      const cardStyle = window.getComputedStyle(card);
      return {
        left: Math.round(cardRect.left),
        width: Math.round(cardRect.width),
        checkboxTop: checkRect && copyRect ? Math.round(checkRect.top - copyRect.top) : -99,
        checked: !!input?.checked,
        checkboxOpacity: inputStyle ? inputStyle.opacity : '',
        checkboxWidth: checkRect ? Math.round(checkRect.width) : 0,
        checkboxBackground: inputStyle ? inputStyle.backgroundColor : '',
        cardBackground: cardStyle.backgroundColor,
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
  expect(layout.cards.every((card) => card.checkboxOpacity === '1')).toBe(true);
  expect(layout.cards.every((card) => card.checkboxWidth >= 16)).toBe(true);
  const selectedCards = layout.cards.filter((card) => card.checked);
  const unselectedCards = layout.cards.filter((card) => !card.checked);
  expect(selectedCards.length).toBe(2);
  expect(unselectedCards.length).toBeGreaterThan(0);
  expect(selectedCards[0].checkboxBackground).not.toBe(unselectedCards[0].checkboxBackground);
  expect(selectedCards[0].cardBackground).not.toBe(unselectedCards[0].cardBackground);
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
      // Dead space left under the table inside its own column, status line aside.
      columnSlack: (() => {
        const panelRect = listPanel?.getBoundingClientRect();
        const status = document.querySelector('#outbounds-subscriptions-status');
        const statusHeight = status ? status.getBoundingClientRect().height : 0;
        return panelRect && wrapRect ? Math.round(panelRect.bottom - wrapRect.bottom - statusHeight) : 999;
      })(),
      nodeSlack: listRect && cardBottom ? Math.round(listRect.bottom - cardBottom) : 999,
      hiddenNotesVisible: hiddenNotes.filter((note) => window.getComputedStyle(note).display !== 'none').length,
    };
  });

  expect(layout.dueInsideHead).toBe(true);
  // The table wrapper fills its column instead of collapsing around the rows.
  expect(layout.columnSlack).toBeLessThanOrEqual(24);
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

  const readTheme = async (theme) => page.evaluate(async (nextTheme) => {
    document.documentElement.dataset.theme = nextTheme;
    const input = document.querySelector('#outbounds-subscriptions-enabled');
    const label = input ? input.closest('.xk-sub-check') : null;
    const slider = label ? label.querySelector('.dt-switch-slider') : null;
    if (slider) slider.style.transition = 'none';
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const bodyStyle = window.getComputedStyle(document.body);
    const inputStyle = input ? window.getComputedStyle(input) : null;
    const labelStyle = label ? window.getComputedStyle(label) : null;
    const sliderStyle = slider ? window.getComputedStyle(slider) : null;
    const swatch = document.createElement('span');
    swatch.style.backgroundColor = bodyStyle.getPropertyValue('--op-accent').trim();
    document.body.appendChild(swatch);
    const resolvedAccent = window.getComputedStyle(swatch).backgroundColor;
    swatch.remove();
    return {
      inputOpacity: inputStyle ? inputStyle.opacity : '',
      sliderBackground: sliderStyle ? sliderStyle.backgroundColor : '',
      labelBackground: labelStyle ? labelStyle.backgroundColor : '',
      resolvedAccent,
    };
  }, theme);

  const dark = await readTheme('dark');
  const light = await readTheme('light');

  for (const state of [dark, light]) {
    expect(state.inputOpacity).toBe('0');
    expect(state.sliderBackground).toBe(state.resolvedAccent);
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

test('subscriptions fragment list grows into the free column height', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const nodes = buildDemoNodes().slice(0, 3);
  const subscriptions = Array.from({ length: 8 }, (_, index) =>
    buildDemoSubscription(nodes, {
      id: `demo-sub-${index}`,
      name: `VPS_SUB_${index}`,
      tag: `VPS_SUB_${index}`,
      output_file: `04_outbounds.vps_sub_${index}.json`,
    })
  );
  await page.route('**/api/xray/subscriptions', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, subscriptions }),
    });
  });

  await openSubscriptionsModal(page);
  await expect(page.locator('tr[data-sub-id="demo-sub-0"]')).toBeVisible();
  const advanced = page.locator('#outbounds-subscriptions-modal .xk-sub-advanced');
  if (!(await advanced.getAttribute('open'))) await advanced.locator('summary').click();

  const layout = await page.evaluate(() => {
    const panel = document.querySelector('#outbounds-subscriptions-modal .xk-sub-list-panel');
    const wrap = document.querySelector('#outbounds-subscriptions-modal .xk-sub-tablewrap');
    const table = wrap?.querySelector('table');
    const panelRect = panel?.getBoundingClientRect();
    const wrapRect = wrap?.getBoundingClientRect();
    const tableRect = table?.getBoundingClientRect();
    return {
      wrapHeight: wrapRect ? Math.round(wrapRect.height) : 0,
      tableHeight: tableRect ? Math.round(tableRect.height) : 0,
      panelHeight: panelRect ? Math.round(panelRect.height) : 0,
      wrapInsidePanel: !!(panelRect && wrapRect && wrapRect.bottom <= panelRect.bottom + 1),
    };
  });

  // The old build pinned the wrapper at 190px regardless of the free space.
  expect(layout.wrapHeight).toBeGreaterThan(240);
  expect(layout.wrapHeight).toBeLessThan(layout.panelHeight);
  expect(layout.wrapInsidePanel).toBe(true);
  expect(layout.tableHeight).toBeGreaterThan(0);
});

test('subscriptions window scrolls as a whole so every server is reachable', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const base = buildDemoNodes();
  const nodes = Array.from({ length: 120 }, (_, index) => ({
    ...base[index % base.length],
    key: `bulk-node-${index + 1}`,
    name: `Bulk server ${index + 1}`,
    tag: `demo-sub--bulk-node-${index + 1}`,
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

  // The click scrolls the window down to the servers on its own.
  const readScrollTop = () => page.evaluate(() => {
    const body = document.querySelector('#outbounds-subscriptions-modal .modal-body');
    return body ? Math.round(body.scrollTop) : 0;
  });
  await expect.poll(readScrollTop).toBeGreaterThan(0);
  // Smooth scrolling is still animating right after the click: wait for it to settle.
  await expect
    .poll(async () => {
      const first = await readScrollTop();
      await page.waitForTimeout(80);
      const second = await readScrollTop();
      return first === second ? 'settled' : 'moving';
    })
    .toBe('settled');

  const layout = await page.evaluate(() => {
    const body = document.querySelector('#outbounds-subscriptions-modal .modal-body');
    const list = document.querySelector('#outbounds-subscriptions-nodes-list');
    const panel = document.querySelector('#outbounds-subscriptions-nodes-panel');
    const head = panel?.querySelector('.xk-sub-panelhead');
    const bodyRect = body?.getBoundingClientRect();
    return {
      bodyScrolls: !!(body && body.scrollHeight > body.clientHeight + 1),
      listOwnScroll: !!(list && list.scrollHeight > list.clientHeight + 1),
      listOverflow: list ? window.getComputedStyle(list).overflowY : '',
      headPosition: head ? window.getComputedStyle(head).position : '',
      lastCardBelowFold: (() => {
        const cards = document.querySelectorAll('#outbounds-subscriptions-nodes-list .xk-sub-node-item');
        const last = cards[cards.length - 1];
        const rect = last?.getBoundingClientRect();
        return !!(rect && bodyRect && rect.bottom > bodyRect.bottom);
      })(),
    };
  });

  // The list itself no longer scrolls: the window does, so the servers are
  // reached by scrolling past the form and the fragment table.
  expect(layout.listOwnScroll).toBe(false);
  expect(layout.listOverflow).toBe('visible');
  expect(layout.bodyScrolls).toBe(true);
  expect(layout.headPosition).toBe('sticky');
  expect(layout.lastCardBelowFold).toBe(true);

  // Scrolling to the bottom brings the last server fully into view.
  await page.evaluate(() => {
    const body = document.querySelector('#outbounds-subscriptions-modal .modal-body');
    if (body) body.scrollTop = body.scrollHeight;
  });
  await page.waitForTimeout(120);
  const bottom = await page.evaluate(() => {
    const body = document.querySelector('#outbounds-subscriptions-modal .modal-body');
    const cards = document.querySelectorAll('#outbounds-subscriptions-nodes-list .xk-sub-node-item');
    const last = cards[cards.length - 1];
    const head = document.querySelector('#outbounds-subscriptions-nodes-panel .xk-sub-panelhead');
    const bodyRect = body?.getBoundingClientRect();
    const rect = last?.getBoundingClientRect();
    const headRect = head?.getBoundingClientRect();
    return {
      lastVisible: !!(rect && bodyRect && rect.bottom <= bodyRect.bottom + 1 && rect.top >= bodyRect.top - 1),
      // The heading keeps naming the subscription while the list scrolls past it.
      headPinned: !!(bodyRect && headRect && Math.abs(headRect.top - bodyRect.top) <= 2),
    };
  });
  expect(bottom.lastVisible).toBe(true);
  expect(bottom.headPinned).toBe(true);
});

test('subscriptions fragment table fills the free height of its column', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const nodes = buildDemoNodes().slice(0, 2);
  const subscriptions = Array.from({ length: 8 }, (_, index) =>
    buildDemoSubscription(nodes, {
      id: `fill-sub-${index}`,
      name: `VPS_FILL_${index}`,
      tag: `VPS_FILL_${index}`,
      output_file: `04_outbounds.vps_fill_${index}.json`,
    })
  );
  await page.route('**/api/xray/subscriptions', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, subscriptions }),
    });
  });

  await openSubscriptionsModal(page);
  await expect(page.locator('tr[data-sub-id="fill-sub-0"]')).toBeVisible();
  // The form column is the tall one once its advanced block is open: that is the
  // height the table has to fill instead of leaving a dead zone underneath.
  const advanced = page.locator('#outbounds-subscriptions-modal .xk-sub-advanced');
  if (!(await advanced.getAttribute('open'))) await advanced.locator('summary').click();
  await page.waitForTimeout(150);

  const layout = await page.evaluate(() => {
    const panel = document.querySelector('#outbounds-subscriptions-modal .xk-sub-list-panel');
    const wrap = document.querySelector('#outbounds-subscriptions-modal .xk-sub-tablewrap');
    const status = document.querySelector('#outbounds-subscriptions-status');
    const panelRect = panel?.getBoundingClientRect();
    const wrapRect = wrap?.getBoundingClientRect();
    const statusRect = status?.getBoundingClientRect();
    const statusHeight = statusRect ? statusRect.height : 0;
    return {
      panelHeight: panelRect ? Math.round(panelRect.height) : 0,
      wrapHeight: wrapRect ? Math.round(wrapRect.height) : 0,
      // Dead space between the table and the bottom of its column.
      gap: (panelRect && wrapRect) ? Math.round(panelRect.bottom - wrapRect.bottom - statusHeight) : 999,
      visibleRows: (() => {
        const rows = Array.from(document.querySelectorAll('#outbounds-subscriptions-tbody tr[data-sub-id]'));
        if (!wrapRect) return 0;
        return rows.filter((row) => {
          const rect = row.getBoundingClientRect();
          return rect.top >= wrapRect.top - 1 && rect.bottom <= wrapRect.bottom + 1;
        }).length;
      })(),
    };
  });

  // The old build capped the table at 40dvh and left the rest of the column empty.
  expect(layout.wrapHeight).toBeGreaterThan(500);
  expect(layout.gap).toBeLessThanOrEqual(24);
  expect(layout.visibleRows).toBeGreaterThan(3);
});

test('subscriptions advanced settings remember their expanded state', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
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
  const advanced = page.locator('#outbounds-subscriptions-modal .xk-sub-advanced');

  // A first visit keeps the block collapsed so the modal opens compact.
  await expect(advanced).not.toHaveAttribute('open', '');

  await advanced.locator('summary').click();
  await expect(advanced).toHaveAttribute('open', '');

  // Reopening the modal keeps the operator's choice.
  await page.locator('#outbounds-subscriptions-close-btn').click();
  await expect(page.locator('#outbounds-subscriptions-modal')).toBeHidden();
  await page.locator('#outbounds-subscriptions-btn').click();
  await expect(page.locator('#outbounds-subscriptions-modal')).toBeVisible();
  await expect(advanced).toHaveAttribute('open', '');

  // And it survives a full page reload.
  await page.reload();
  await openSubscriptionsModal(page);
  await expect(page.locator('#outbounds-subscriptions-modal .xk-sub-advanced')).toHaveAttribute('open', '');

  // Collapsing is remembered too.
  await page.locator('#outbounds-subscriptions-modal .xk-sub-advanced > summary').click();
  await page.locator('#outbounds-subscriptions-close-btn').click();
  await page.locator('#outbounds-subscriptions-btn').click();
  await expect(page.locator('#outbounds-subscriptions-modal .xk-sub-advanced')).not.toHaveAttribute('open', '');
});

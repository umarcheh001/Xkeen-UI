import { test, expect, selectPanelView } from './fixtures.mjs';
import {
  buildDemoNodes, buildNodeLatency, buildDemoSubscription, openSubscriptionsModal,
  selectSubscriptionProbeMode, selectOutboundsProbeMode, openOutboundsPanel,
} from './subscriptions_modal_support.mjs';

// Xray subscriptions window: layout of the window and of the outbounds card,
// server tiles, flags and latency.

test('source fields share one row when the subscriptions form is wide enough', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 850, height: 900 });
  await page.route('**/api/xray/subscriptions', (route) => route.fulfill({ json: { ok: true, subscriptions: [] } }));
  await openSubscriptionsModal(page);

  const fields = await page.evaluate(() => {
    const input = (id) => document.getElementById(id);
    const bounds = (element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    };
    return {
      name: bounds(input('outbounds-subscriptions-name').closest('label')),
      tag: bounds(input('outbounds-subscriptions-tag').closest('label')),
      mode: bounds(input('outbounds-subscriptions-schedule-mode').closest('label')),
      interval: bounds(input('outbounds-subscriptions-interval-field')),
      url: bounds(input('outbounds-subscriptions-url')),
      panel: bounds(document.querySelector('#outbounds-subscriptions-modal .xk-sub-form-panel')),
    };
  });
  expect(Math.max(...['name', 'tag', 'mode', 'interval'].map((key) => fields[key].top))
    - Math.min(...['name', 'tag', 'mode', 'interval'].map((key) => fields[key].top))).toBeLessThanOrEqual(1);
  expect(fields.name.right).toBeLessThan(fields.tag.left);
  expect(fields.tag.right).toBeLessThan(fields.mode.left);
  expect(fields.mode.right).toBeLessThan(fields.interval.left);
  expect(fields.interval.right).toBeLessThanOrEqual(fields.panel.right);
  expect(fields.url.top).toBeGreaterThan(fields.name.bottom);
  await page.screenshot({ path: testInfo.outputPath('source-fields-850.png') });

  await page.locator('#outbounds-subscriptions-schedule-mode').selectOption('cron');
  const cronField = page.locator('#outbounds-subscriptions-cron-field');
  await expect(cronField).toBeVisible();
  const cronGeometry = await page.evaluate(() => ({
    cron: document.getElementById('outbounds-subscriptions-cron-field').getBoundingClientRect().toJSON(),
    name: document.getElementById('outbounds-subscriptions-name').closest('label').getBoundingClientRect().toJSON(),
    panel: document.querySelector('#outbounds-subscriptions-modal .xk-sub-form-panel').getBoundingClientRect().toJSON(),
  }));
  expect(cronGeometry.cron.top).toBeCloseTo(cronGeometry.name.top, 0);
  expect(cronGeometry.cron.right).toBeLessThanOrEqual(cronGeometry.panel.right + 1);
  await page.locator('#outbounds-subscriptions-schedule-mode').selectOption('interval');

  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const geometry = await page.locator('#outbounds-subscriptions-form').evaluate((form) => {
      const panel = form.closest('.xk-sub-form-panel');
      const panelBounds = panel.getBoundingClientRect();
      const fieldIds = ['name', 'tag', 'schedule-mode', 'interval'];
      return {
        formFits: form.scrollWidth <= form.clientWidth + 1,
        fieldsFit: fieldIds.every((suffix) => {
          const field = document.getElementById(`outbounds-subscriptions-${suffix}`);
          const bounds = field.getBoundingClientRect();
          return bounds.left >= panelBounds.left - 1 && bounds.right <= panelBounds.right + 1;
        }),
      };
    });
    expect(geometry.formFits, `form overflows at ${width}px`).toBe(true);
    expect(geometry.fieldsFit, `field overflows at ${width}px`).toBe(true);
  }
});

test('subscription controls expose one tooltip per field', async ({ page }) => {
  const subscription = buildDemoSubscription(buildDemoNodes());
  await page.route('**/api/xray/subscriptions', (route) => route.fulfill({
    json: { ok: true, subscriptions: [subscription] },
  }));
  await openSubscriptionsModal(page);
  await expect(page.locator('#outbounds-subscriptions-modal .xk-sub-table tbody tr')).toHaveCount(1);

  const nestedOwners = await page.locator('#outbounds-subscriptions-modal').evaluate((modal) => (
    [...modal.querySelectorAll('[data-tooltip]')]
      .filter((element) => element.parentElement?.closest('[data-tooltip]'))
      .map((element) => element.id || element.className || element.tagName)
  ));
  expect(nestedOwners).toEqual([]);

  for (const suffix of ['name', 'tag', 'interval', 'url', 'name-filter', 'type-filter', 'transport-filter']) {
    const input = page.locator(`#outbounds-subscriptions-${suffix}`);
    await expect(input).toHaveAttribute('data-tooltip', /\S/);
    await expect(input.locator('xpath=..')).not.toHaveAttribute('data-tooltip');
  }
  await expect(page.locator('#outbounds-subscriptions-tag')).toHaveAttribute('data-tooltip', /балансировщики/);
  await expect(page.locator('#outbounds-subscriptions-url')).toHaveAttribute('data-tooltip', /JSON-списки/);
  for (const suffix of ['enabled', 'ping', 'refresh-now', 'routing-auto-rule', 'entware-mark-btn']) {
    const input = page.locator(`#outbounds-subscriptions-${suffix}`);
    await expect(input.locator('xpath=..')).toHaveAttribute('data-tooltip', /\S/);
    await expect(input).not.toHaveAttribute('data-tooltip');
    await expect(input).not.toHaveAttribute('title');
  }
  await expect(page.locator('#outbounds-subscriptions-ping')).not.toHaveAttribute('data-tooltip-placement');
  await expect(page.locator('#outbounds-subscriptions-ping').locator('xpath=..')).toHaveAttribute('data-tooltip-placement', 'bottom');
  await expect(page.locator('#outbounds-subscriptions-routing-mode')).toHaveAttribute('data-tooltip-placement', 'bottom');

  await page.locator('#outbounds-subscriptions-name').hover();
  await expect(page.locator('#xk-tooltip-portal .xk-tooltip-text')).toContainText('Короткое имя подписки');
  await page.locator('label:has(#outbounds-subscriptions-name) > .xk-pool-fieldlabel').hover();
  await expect(page.locator('#xk-tooltip-portal')).toBeHidden();
});

test('clicking outside the subscriptions modal keeps it open', async ({ page }) => {
  await page.route('**/api/xray/subscriptions', (route) => route.fulfill({ json: { ok: true, subscriptions: [] } }));
  await openSubscriptionsModal(page);

  const modal = page.locator('#outbounds-subscriptions-modal');
  await expect(modal).toHaveAttribute('data-modal-backdrop-close', '0');
  const name = page.locator('#outbounds-subscriptions-name');
  await name.fill('Новая подписка');
  await page.mouse.click(5, 5);
  await expect(modal).toBeVisible();
  await expect(name).toHaveValue('Новая подписка');
  await expect(page.locator('#confirm-modal')).toHaveClass(/hidden/);

  await page.locator('#outbounds-subscriptions-close-btn').click();
  await expect(page.locator('#confirm-modal')).not.toHaveClass(/hidden/);
  await expect(modal).toBeVisible();
});

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
      body: JSON.stringify({ ok: true, nodes, node_latency: nodeLatency, node_tcp_latency: buildNodeLatency(nodes) }),
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
  const probeMode = page.locator('#outbounds-nodes-probe-mode');
  await expect(probeMode).toBeVisible();
  await expect(probeMode.locator('[data-probe-mode="tcp"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(probeMode.locator('[data-probe-mode="tcp"]')).toHaveClass(/is-active/);
  await probeMode.locator('[data-probe-mode="proxy"]').click();
  await expect(probeMode.locator('[data-probe-mode="proxy"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(probeMode.locator('[data-probe-mode="proxy"]')).toHaveClass(/is-active/);
  await expect(probeMode.locator('[data-probe-mode="tcp"]')).not.toHaveClass(/is-active/);
  await probeMode.locator('[data-probe-mode="tcp"]').click();
  await expect(probeMode.locator('[data-probe-mode="tcp"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(probeMode.locator('[data-probe-mode="tcp"]')).toHaveClass(/is-active/);
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

  await selectPanelView(page, 'mihomo');
  await expect(page.locator('#view-mihomo')).toBeVisible();

  await selectPanelView(page, 'routing');
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
  await selectSubscriptionProbeMode(page, 'proxy');

  const probes = page.locator('#outbounds-subscriptions-nodes-list .xk-xray-node-probe');
  await expect(probes).toHaveCount(3);
  await expect(probes.nth(0)).toHaveAttribute('data-probe-tone', 'good');
  await expect(probes.nth(1)).toHaveAttribute('data-probe-tone', 'warning');
  await expect(probes.nth(2)).toHaveAttribute('data-probe-tone', 'bad');

  const colors = await probes.evaluateAll((items) => items.map((item) => window.getComputedStyle(item).color));
  expect(new Set(colors).size).toBe(3);
});

test('subscription TCP and Proxy modes keep independent latency histories', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-05-03T03:09:37Z') });
  const nodes = buildDemoNodes().slice(0, 1);
  const checkedAt = 1777777777;
  const subscription = buildDemoSubscription(nodes, {
    node_tcp_latency: {
      [nodes[0].key]: { status: 'ok', delay_ms: 111, checked_at: checkedAt },
    },
    node_latency: {
      [nodes[0].key]: { status: 'ok', delay_ms: 777, checked_at: checkedAt },
    },
  });

  await page.route('**/api/xray/subscriptions', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({ json: { ok: true, subscriptions: [subscription] } });
  });

  await openSubscriptionsModal(page);
  await page.locator('tr[data-sub-id="demo-sub"]').click();

  const probe = page.locator('#outbounds-subscriptions-nodes-list .xk-xray-node-probe');
  await expect(probe).toHaveText('111 мс');
  await expect(probe).toHaveAttribute('data-probe-mode', 'tcp');

  await selectSubscriptionProbeMode(page, 'proxy');
  await expect(probe).toHaveText('777 мс');
  await expect(probe).toHaveAttribute('data-probe-mode', 'proxy');
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
  await selectSubscriptionProbeMode(page, 'proxy');

  const probes = page.locator('#outbounds-subscriptions-nodes-list .xk-xray-node-probe');
  const measured = probes.nth(0);
  const failed = probes.nth(1);
  const idle = probes.nth(2);

  await expect(measured).toHaveText('180 мс');
  await expect(measured).toHaveAttribute('data-xray-delay-history', '1');
  await expect(measured).toHaveAttribute('data-tooltip-silent', '1');
  await expect(failed.locator('use')).toHaveAttribute('href', /#xk-alert$/);
  await expect(idle.locator('use')).toHaveAttribute('href', /#xk-bolt$/);
  await expect(idle).toHaveAttribute(
    'data-tooltip',
    /Задержка не измерена\. Нажмите, чтобы проверить\.[\s\S]*Proxy-проверка/,
  );

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
  await selectOutboundsProbeMode(page, 'proxy');
  const cardProbe = page.locator('#outbounds-nodes-list .xk-xray-node-probe');
  await expect(cardProbe).toHaveText('180 мс');
  await expect(cardProbe).toHaveAttribute('data-probe-tone', 'good');

  await page.locator('#outbounds-subscriptions-btn').click();
  await expect(page.locator('#outbounds-subscriptions-modal')).toBeVisible();
  await page.locator('tr[data-sub-id="demo-sub"]').click();
  await selectSubscriptionProbeMode(page, 'proxy');
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

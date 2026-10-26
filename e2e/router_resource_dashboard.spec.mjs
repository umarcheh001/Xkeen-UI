import { test, expect } from './fixtures.mjs';

// The dashboard window (shadow DOM). All API answers are replaced with JSON of the real
// shapes (see tests/test_system_resources_api.py); addresses are documentation ranges.

const zoneOf = (value, orange, red) => (value == null ? null : value >= red ? 2 : value >= orange ? 1 : 0);

function bars(values, orange, red) {
  return { values, zones: values.map(v => zoneOf(v, orange, red)) };
}

const wave = (base, swing, offset = 0) => Array.from({ length: 40 }, (_, i) => Math.round(base + swing * Math.abs(Math.sin((i + offset) / 5))));

function legacyResources() {
  return {
    ok: true, sampled_at: 1792602000,
    cpu: { percent: 19, cores: 3, load_1m: 0.4, load_5m: 0.4, load_15m: 0.3, total_tasks: 100, runnable_tasks: 1 },
    memory: { percent: 47, total_bytes: 1024 ** 3, used_bytes: 500000000, swap_total_bytes: 0, swap_used_bytes: 0 },
    storage: { percent: 18.5, total_bytes: 8 * 1024 ** 3, free_bytes: 7 * 1024 ** 3 },
    temperature_celsius: 55, uptime_seconds: 454000,
    network: { receive_bytes_per_second: 1, send_bytes_per_second: 1, received_bytes: 1, sent_bytes: 1, interfaces: [] },
    router: { freshness: { state: 'fresh', age_seconds: 0 }, rci: { available: true }, internet: { available: true }, conntrack: { available: false }, interfaces: { available: true, items: [] }, incidents: [] },
  };
}

function summary(over = {}) {
  const base = {
    ok: true, ts: 1792602000,
    status: { tone: 'ok', problems: [] },
    identity: { model: 'Netcraze Ultra (NC-1812)', firmware: 'KeeneticOS 5.1.8' },
    uptime_s: 454000,
    cards: {
      cpu: { value: 19, zone: 0, cores: 3, queue: 0.4, queue_zone: 0, text: '3 ядра · очередь задач небольшая', bars: bars(wave(15, 50), 60, 85) },
      memory: { value: 47, zone: 0, text: 'программы 456 МБ · кэш 245 МБ · свободно 290 МБ', programs_bytes: 478150656, cache_bytes: 256901120, free_bytes: 304087040, total_bytes: 1039138816, bars: bars(wave(45, 6, 3), 75, 90) },
      internet: { state: 'online', label: 'В сети', zone: 0, text: 'Через WAN (GigabitEthernet1) · без перерывов 1 д 0 ч', bars: { values: Array.from({ length: 40 }, (_, i) => (i < 3 ? null : 1)), zones: Array.from({ length: 40 }, (_, i) => (i < 3 ? null : 0)) } },
      link: {
        id: 'ISP', label: 'WAN', has_tariff: true, tariff: { up_mbps: 50, down_mbps: 100 },
        up_percent: 2, down_percent: 6, up_mbps: 1.1, down_mbps: 5.8, zone: 0,
        text: '1,1 / 5,8 Мбит/с из 50 / 100 по тарифу',
        bars: { up: bars(wave(2, 10), 70, 90), down: bars(wave(5, 30, 2), 70, 90) }, secondary: [],
      },
    },
    rci_available: true,
    router: {
      freshness: { state: 'fresh', age_seconds: 0 }, rci: { available: true },
      internet: { available: true, internet: true, gateway: true, dns: true, captive: true, interface: 'GigabitEthernet1', address: '192.0.2.1' },
      conntrack: { available: true, percent: 3.2, count: 1048, max: 32768, available_entries: 31720 },
    },
  };
  return { ...base, ...over };
}

const MB = 1048576;

function tempGroup(id, label, value, kind = 'chip', extra = {}) {
  const bands = kind === 'wifi' ? { orange_c: 85, red_c: 100 } : { orange_c: 80, red_c: 95 };
  const zone = value == null ? null : value >= bands.red_c ? 2 : value >= bands.orange_c ? 1 : 0;
  return {
    id, label, kind, value_c: value,
    sensors: value == null ? [] : kind === 'wifi' ? [{ name: id, value_c: value }] : [{ name: `${id}_thermal0`, value_c: value }, { name: `${id}_thermal1`, value_c: value - 0.5 }],
    shutdown_c: kind === 'chip' ? 125 : null, zone, usual_c: null, hotter_by: null, bands, ...extra,
  };
}

function ports(count, { slow = null } = {}) {
  const list = [{ id: 'WAN', label: 'WAN', is_wan: true, link: true, speed_mbps: 1000, duplex: 'full', description: 'Provider A' }];
  for (let n = 1; n <= count; n += 1) {
    const linked = n === 1 || n === slow;
    list.push({ id: String(n), label: String(n), is_wan: false, link: linked, speed_mbps: linked ? (n === slow ? 100 : 1000) : null, duplex: linked ? 'full' : null, description: '' });
  }
  return list;
}

function hardware(kind = 'nc1812', over = {}) {
  const nc = kind === 'nc1812';
  const none = kind === 'none';
  const temperatures = none ? [] : nc
    ? [tempGroup('cpu', 'Процессор', 54), tempGroup('soc', 'Чип целиком', 55), tempGroup('tops', 'Сетевой ускоритель', 53), tempGroup('eth', 'Порты и коммутатор', 55), tempGroup('wifi24', 'Wi‑Fi 2,4 ГГц', 47, 'wifi'), tempGroup('wifi5', 'Wi‑Fi 5 ГГц', 53, 'wifi')]
    : [tempGroup('cpu', 'Процессор', 61), tempGroup('wifi24', 'Wi‑Fi 2,4 ГГц', 70, 'wifi'), tempGroup('wifi5', 'Wi‑Fi 5 ГГц', 63, 'wifi')];
  return {
    ok: true,
    identity: nc ? { model: 'Netcraze Ultra (NC-1812)', firmware: 'KeeneticOS 5.1.8' } : { model: 'Keenetic Ultra (KN-1811)', firmware: 'KeeneticOS 5.1.8' },
    cores: nc ? 3 : 2,
    temperatures,
    throttle: nc ? null : { current_mhz: 1350, max_mhz: 1350, throttled: false },
    memory: { total_bytes: 991 * MB, programs_bytes: 456 * MB, cache_bytes: 245 * MB, free_bytes: 290 * MB, percent: 46 },
    zram: { size_bytes: 1024 * MB, used_bytes: 0 },
    storage: { total_bytes: 8 * 1024 * MB, used_bytes: 1536 * MB, free_bytes: 6656 * MB, percent: 18.8, path: '/opt' },
    conntrack: { available: true, count: 1048, max: 32768, percent: 3.2, available_entries: 31720 },
    ports: nc ? ports(4) : ports(5),
    slow_ports: [],
    ...over,
  };
}

async function openDashboard(page, { sum = summary(), hw = hardware(), width = 1600 } = {}) {
  await page.setViewportSize({ width, height: 1000 });
  await page.route('**/api/system/resources', route => route.fulfill({ json: legacyResources() }));
  await page.route('**/api/system/summary', route => route.fulfill({ json: sum }));
  await page.route('**/api/system/hardware', route => route.fulfill({ json: hw }));
  await page.route('**/api/system/history*', route => route.fulfill({ status: 503, json: { ok: false } }));
  await page.route('**/api/system/events*', route => route.fulfill({ json: { ok: true, events: [], active: [] } }));
  await page.goto('/');
  const monitor = page.locator('#xk-resource-monitor');
  await expect(monitor).toHaveAttribute('data-state', 'ready');
  await monitor.evaluate(button => button.click());
  await expect(page.locator('#xk-resource-dashboard-modal')).toBeVisible();
  const view = page.locator('#xk-resource-dashboard-view');
  await expect(view.locator('.xkm-card').first()).toBeVisible();
  await expect(view.locator('.hw-grid')).toBeVisible();
  return view;
}

const rect = (locator) => locator.evaluate(el => {
  const r = el.getBoundingClientRect();
  return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
});

test('dashboard renders cards with aligned indicators', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const view = await openDashboard(page, { sum: summary({ cards: { ...summary().cards, cpu: { ...summary().cards.cpu, text: 'очень длинное пояснение, которое не должно ломать ровную линию нижних краёв всех четырёх карточек в окне' } } }) });
  await expect(view.locator('.xkm-card')).toHaveCount(4);
  const bottoms = [];
  for (let i = 0; i < 4; i += 1) bottoms.push((await rect(view.locator('.xkm-card').nth(i).locator('.xkm-spark'))).bottom);
  for (const b of bottoms) expect(Math.abs(b - bottoms[0])).toBeLessThanOrEqual(1);
  const heights = [];
  for (let i = 0; i < 4; i += 1) heights.push((await rect(view.locator('.xkm-card').nth(i))).height);
  for (const h of heights) expect(Math.abs(h - heights[0])).toBeLessThanOrEqual(1);
  expect((await rect(view.locator('.xkm-card').first().locator('.xkm-spark'))).height).toBeCloseTo(34, 0);
  await expect(view.locator('.xkm-card').nth(0)).toContainText('Процессор');
  await expect(view.locator('.xkm-card').nth(0)).toContainText('19');
  await expect(view.locator('.xkm-card').nth(2)).toContainText('В сети');
  await expect(view.locator('.xkm-card').nth(3)).toContainText('↑ 2');
  await expect(view.locator('.xkm-status')).toContainText('Всё в порядке');
  await expect(view.locator('.xkm-status')).toContainText('Netcraze Ultra (NC-1812) · KeeneticOS 5.1.8');
  await expect(view.locator('.xkm-status')).toContainText('Работает 5 д 6 ч');
  // the indicator canvases are really drawn
  const painted = await view.locator('.xkm-card').first().locator('.xkm-spark').evaluate(canvas => {
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) return true;
    return false;
  });
  expect(painted).toBe(true);
  expect(errors).toEqual([]);
});

test('window header has refresh, a menu with the JSON snapshot and no intervals or poll select', async ({ page }) => {
  await openDashboard(page);
  const modal = page.locator('#xk-resource-dashboard-modal');
  await expect(modal.locator('.modal-title')).toHaveText('Диагностика роутера');
  await expect(modal.locator('#xk-resource-dashboard-freshness')).toContainText('Обновлено');
  await expect(modal.locator('#xk-resource-dashboard-refresh')).toBeVisible();
  await expect(modal.locator('#xk-resource-poll')).toHaveCount(0);
  await expect(modal.locator('[data-resource-range]')).toHaveCount(0);
  await expect(modal.locator('#xk-resource-export')).toBeHidden();
  await modal.locator('#xk-resource-more').click();
  await expect(modal.locator('#xk-resource-export')).toBeVisible();
  await expect(modal.locator('#xk-resource-export')).toHaveText('Снимок JSON');
  await page.keyboard.press('Escape');
  await expect(modal.locator('#xk-resource-export')).toBeHidden();
});

test('hardware layout NC-1812', async ({ page }) => {
  const view = await openDashboard(page);
  const tiles = view.locator('.hw-t');
  await expect(tiles).toHaveCount(6);
  const tops = [];
  const lefts = [];
  for (let i = 0; i < 6; i += 1) {
    const r = await rect(tiles.nth(i));
    tops.push(Math.round(r.top));
    lefts.push(r.left);
  }
  expect(new Set(tops.slice(0, 3)).size).toBe(1);
  expect(new Set(tops.slice(3)).size).toBe(1);
  expect(tops[3]).toBeGreaterThan(tops[0]);
  expect(Math.abs(lefts[0] - lefts[3])).toBeLessThanOrEqual(1);
  // tiles fill the section: gap between tiles equals the inset from the section edge
  const section = await rect(view.locator('.hw-sec').first());
  const first = await rect(tiles.nth(0));
  const second = await rect(tiles.nth(1));
  const third = await rect(tiles.nth(2));
  const inset = first.left - section.left;
  expect(Math.abs(second.left - first.right - inset)).toBeLessThanOrEqual(1);
  expect(Math.abs(section.right - third.right - inset)).toBeLessThanOrEqual(1);
  // ports: five sockets, gap between them equals the inset from the section edge
  const portsSection = view.locator('.hw-sec').nth(2);
  const ps = await rect(portsSection);
  const sockets = portsSection.locator('.hw-port');
  await expect(sockets).toHaveCount(5);
  const a = await rect(sockets.nth(0));
  const b = await rect(sockets.nth(1));
  const last = await rect(sockets.nth(4));
  expect(Math.abs(b.left - a.right - (a.left - ps.left))).toBeLessThanOrEqual(1);
  expect(Math.abs(ps.right - last.right - (a.left - ps.left))).toBeLessThanOrEqual(1);
  await expect(sockets.nth(0)).toContainText('WAN');
  await expect(sockets.nth(0)).toContainText('1 Гбит/с');
  await expect(sockets.nth(2)).toContainText('нет кабеля');
  await expect(view.locator('.hw-res')).not.toHaveClass(/two/);
});

test('hardware layout KN-1811', async ({ page }) => {
  const view = await openDashboard(page, { hw: hardware('kn1811') });
  await expect(view.locator('.hw-t')).toHaveCount(3);
  const tops = [];
  for (let i = 0; i < 3; i += 1) tops.push(Math.round((await rect(view.locator('.hw-t').nth(i))).top));
  expect(new Set(tops).size).toBe(1);
  await expect(view.locator('.hw-res')).toHaveClass(/two/);
  const items = view.locator('.hw-res > *');
  await expect(items).toHaveCount(4);
  const p0 = await rect(items.nth(0));
  const p1 = await rect(items.nth(1));
  const p2 = await rect(items.nth(2));
  expect(Math.abs(p0.top - p1.top)).toBeLessThanOrEqual(1);
  expect(p2.top).toBeGreaterThan(p0.top);
  const bottoms = [];
  for (let i = 0; i < 3; i += 1) bottoms.push((await rect(view.locator('.hw-sec').nth(i))).bottom);
  for (const bottom of bottoms) expect(Math.abs(bottom - bottoms[0])).toBeLessThanOrEqual(2);
  await expect(view.locator('.hw-port')).toHaveCount(6);
});

test('no sensors hides temperature section', async ({ page }) => {
  const view = await openDashboard(page, { hw: hardware('none') });
  await expect(view.locator('.hw-t')).toHaveCount(0);
  await expect(view.locator('.hw-sec')).toHaveCount(2);
  await expect(view.locator('.hw-grid')).not.toContainText('Температура');
  await expect(view.locator('.hw-res')).toHaveClass(/two/);
  await expect(view.locator('.xkm-panel', { hasText: 'Состояние железа' })).toContainText('датчиков температуры у этой модели нет');
});

test('problem state', async ({ page }) => {
  const sum = summary({
    status: {
      tone: 'problem',
      problems: [
        { id: 'memory_low-1', type: 'memory_low', at: 1792601640, until: null, severity: 'problem', title: 'Память занята больше чем на 90 %', detail: '', key: '' },
        { id: 'dns_failed-1', type: 'dns_failed', at: 1792601760, until: null, severity: 'problem', title: 'Не отвечает DNS', detail: '', key: '' },
      ],
    },
    cards: {
      ...summary().cards,
      memory: { ...summary().cards.memory, value: 94, zone: 2, text: 'выше 90 % уже 6 мин', bars: bars(wave(80, 15, 3), 75, 90) },
      internet: { ...summary().cards.internet, state: 'dns_failed', label: 'С перебоями', zone: 1, text: 'Через WAN (GigabitEthernet1) · сбой DNS идёт 4 мин' },
    },
    router: { ...summary().router, internet: { available: true, internet: true, gateway: true, dns: false, captive: true, interface: 'GigabitEthernet1', address: '192.0.2.1' } },
  });
  const view = await openDashboard(page, { sum });
  await expect(view.locator('.xkm-status')).toContainText('Есть проблемы: 2');
  await expect(view.locator('.xkm-status')).toHaveAttribute('data-tone', 'warn');
  const memory = view.locator('.xkm-card').nth(1);
  await expect(memory.locator('.xkm-badge')).toHaveText('критично');
  await expect(memory).toContainText('выше 90 % уже 6 мин');
  await expect(memory).toContainText('94');
  await expect(view.locator('.xkm-card').nth(2)).toContainText('С перебоями');
  await expect(view.locator('.xkm-card').nth(2).locator('.xkm-badge')).toHaveText('сбой DNS');
  // connection chain: DNS is broken, the last link is unknown
  const nodes = view.locator('.xkm-node');
  await expect(nodes).toHaveCount(4);
  await expect(nodes.nth(2)).toHaveClass(/bad/);
  await expect(nodes.nth(3)).toHaveClass(/unk/);
  await expect(view.locator('.xkm-conn-alert')).toContainText('DNS не отвечает');
  await expect(view.locator('.xkm-conn-alert [data-link="dns-log"]')).toHaveText('Журнал ошибок DNS');
});

test('rci unavailable', async ({ page }) => {
  const sum = summary({
    rci_available: false,
    router: { freshness: { state: 'unavailable', age_seconds: 0, stale_after_seconds: 15 }, rci: { available: false, state: 'unavailable' }, internet: { available: false }, conntrack: { available: false } },
    cards: { ...summary().cards, internet: { state: null, label: 'нет данных', zone: null, text: '', bars: { values: Array(40).fill(null), zones: Array(40).fill(null) } } },
  });
  const view = await openDashboard(page, { sum });
  await expect(view.locator('.xkm-status')).toContainText('Часть данных недоступна');
  await expect(view.locator('.xkm-card').nth(0)).toContainText('19');
  await expect(view.locator('.xkm-card').nth(1)).toContainText('47');
  await expect(view.locator('.xkm-card').nth(2)).toContainText('нет данных');
  await expect(view.locator('.xkm-node.unk')).toHaveCount(4);
});

test('hotter than usual', async ({ page }) => {
  const hw = hardware();
  hw.temperatures[0] = tempGroup('cpu', 'Процессор', 66, 'chip', { hotter_by: 18, usual_c: 48 });
  const view = await openDashboard(page, { hw });
  const tile = view.locator('.hw-t').first();
  await expect(tile).toContainText('на 18 °C горячее обычного — проверьте, не закрыт ли роутер');
  await expect(tile).toHaveClass(/z0/);
  await expect(tile).not.toHaveClass(/z1|z2/);
  await expect(view.locator('.hw-t').nth(1)).not.toContainText('горячее обычного');
});

test('throttled', async ({ page }) => {
  const hw = hardware('kn1811', { throttle: { current_mhz: 900, max_mhz: 1350, throttled: true } });
  const view = await openDashboard(page, { hw });
  const tile = view.locator('.hw-t').first();
  await expect(tile).toContainText('Процессор');
  await expect(tile).toHaveClass(/z2/);
  await expect(tile).toContainText('процессор замедлился из-за нагрева: 900 из 1350 МГц');
  const colours = await view.locator('.hw-t').evaluateAll(els => els.map(el => getComputedStyle(el).borderTopColor));
  expect(colours[0]).not.toBe(colours[1]);
  await expect(view.locator('.xkm-status')).toContainText('процессор замедлился из-за нагрева: 900 из 1350 МГц');
  await expect(view.locator('.xkm-status')).toContainText('Есть проблемы: 1');
});

test('slow port is highlighted with a hint', async ({ page }) => {
  const hw = hardware('nc1812', { ports: ports(4, { slow: 4 }), slow_ports: [{ id: '4', label: '4', is_wan: false, link: true, speed_mbps: 100, duplex: 'full', description: '' }] });
  const view = await openDashboard(page, { hw });
  await expect(view.locator('.hw-port.warn')).toHaveCount(1);
  await expect(view.locator('.hw-note')).toContainText('Порт 4 работает на 100 Мбит/с вместо 1 Гбит/с');
});

test('View reports card and link clicks through callbacks', async ({ page }) => {
  await openDashboard(page);
  const result = await page.evaluate(async ({ sum, hw }) => {
    const { mountDashboardView } = await import('/static/js/features/resource_monitor/view.js');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = mountDashboardView(host);
    const cards = [];
    const links = [];
    view.onCardClick(metric => cards.push(metric));
    view.onLinkClick(name => links.push(name));
    sum.cards.link = { ...sum.cards.link, has_tariff: false, tariff: null };
    view.renderHardware(hw);
    view.renderSummary(sum);
    view.renderConnection({ internet: { available: true, internet: true, gateway: true, dns: false, captive: true, interface: 'GigabitEthernet1', address: '192.0.2.1' } });
    const root = host.shadowRoot;
    root.querySelector('.xkm-card[data-metric="memory"]').click();
    root.querySelector('.xkm-card[data-metric="internet"]').click();
    root.querySelector('[data-link="tariff"]').click();
    root.querySelector('[data-link="dns-log"]').click();
    const out = { cards, links, chart: !!view.chartHost, tools: !!view.toolsHost, title: root.querySelector('.xkm-card[data-metric="link"]').textContent };
    host.remove();
    return out;
  }, { sum: summary(), hw: hardware() });
  expect(result.cards).toEqual(['memory', 'internet']);
  expect(result.links).toEqual(['tariff', 'dns-log']);
  expect(result.chart && result.tools).toBe(true);
  expect(result.title).toContain('Интернет-трафик');
});

for (const width of [1600, 1024, 390]) {
  test(`no horizontal scroll at ${width}`, async ({ page }) => {
    const view = await openDashboard(page, { width });
    const scroll = await page.evaluate(() => {
      const body = document.querySelector('#xk-resource-dashboard-modal .modal-body');
      const host = document.getElementById('xk-resource-dashboard-view');
      return { body: body.scrollWidth - body.clientWidth, doc: document.documentElement.scrollWidth - innerWidth, host: host.scrollWidth - host.clientWidth };
    });
    expect(scroll.body).toBeLessThanOrEqual(1);
    expect(scroll.doc).toBeLessThanOrEqual(1);
    expect(scroll.host).toBeLessThanOrEqual(1);
    if (width === 390) {
      // phone: sections stacked, temperatures by two, ports by three
      const sections = view.locator('.hw-sec');
      const first = await rect(sections.nth(0));
      const second = await rect(sections.nth(1));
      expect(second.top).toBeGreaterThanOrEqual(first.bottom - 1);
      const tops = [];
      for (let i = 0; i < 6; i += 1) tops.push(Math.round((await rect(view.locator('.hw-t').nth(i))).top));
      expect(new Set(tops).size).toBe(3);
      const portTops = [];
      for (let i = 0; i < 5; i += 1) portTops.push(Math.round((await rect(view.locator('.hw-port').nth(i))).top));
      expect(new Set(portTops).size).toBe(2);
      expect(portTops[0]).toBe(portTops[2]);
    }
  });
}

test('panel-operator.css does not style inside shadow root', async ({ page }) => {
  const view = await openDashboard(page);
  const before = await view.locator('.xkm-card').first().evaluate(el => getComputedStyle(el).color);
  await page.addStyleTag({ content: 'body.panel-page .xkm-card{color:red !important}' });
  const after = await view.locator('.xkm-card').first().evaluate(el => getComputedStyle(el).color);
  expect(after).toBe(before);
  const hasShadow = await page.evaluate(() => !!document.getElementById('xk-resource-dashboard-view').shadowRoot);
  expect(hasShadow).toBe(true);
});

test('both themes render the cards with panel colours', async ({ page }) => {
  const view = await openDashboard(page);
  const light = await view.locator('.xkm-card').first().evaluate(el => getComputedStyle(el).backgroundColor);
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await expect.poll(() => view.locator('.xkm-card').first().evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe(light);
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await expect.poll(() => view.locator('.xkm-card').first().evaluate(el => getComputedStyle(el).backgroundColor)).toBe(light);
});

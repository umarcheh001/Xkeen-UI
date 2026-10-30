import { test, expect } from './fixtures.mjs';
import { aggregationLabel, frequenciesWord, hasModems } from '../xkeen-ui/static/js/features/resource_monitor/tool_modems.js';

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
    values: { cpu: 19, memory: 47, queue: 0.4, online: 1, 'link_up:ISP': 2, 'link_down:ISP': 6, 'rate_up:ISP': 1.1, 'rate_down:ISP': 5.8 },
    zones: { cpu: 0, memory: 0, queue: 0, 'link_up:ISP': 0, 'link_down:ISP': 0 },
    links: [LINK_ISP],
    cards: {
      cpu: { value: 19, zone: 0, cores: 3, queue: 0.4, queue_zone: 0, text: '3 ядра · очередь задач небольшая', bars: bars(wave(15, 50), 60, 85) },
      memory: { value: 47, zone: 0, text: 'программы 456 МБ · свободно 535 МБ, из них кэш 245 МБ', programs_bytes: 478150656, cache_bytes: 256901120, free_bytes: 304087040, total_bytes: 1039138816, bars: bars(wave(45, 6, 3), 75, 90) },
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
    ? [tempGroup('cpu', 'Процессор', 54), tempGroup('soc', 'Главный чип', 55), tempGroup('npu', 'Сетевой ускоритель', 53), tempGroup('ports', 'Порты и коммутатор', 55), tempGroup('wifi24', 'Wi‑Fi 2,4 ГГц', 47, 'wifi'), tempGroup('wifi5', 'Wi‑Fi 5 ГГц', 53, 'wifi')]
    : [tempGroup('cpu', 'Процессор', 61, 'chip', { sensors: [{ name: 'mtktscpu', value_c: 61 }] }), tempGroup('wifi24', 'Wi‑Fi 2,4 ГГц', 70, 'wifi'), tempGroup('wifi5', 'Wi‑Fi 5 ГГц', 63, 'wifi')];
  return {
    ok: true,
    identity: nc ? { model: 'Netcraze Ultra (NC-1812)', firmware: 'KeeneticOS 5.1.8' } : { model: 'Keenetic Ultra (KN-1811)', firmware: 'KeeneticOS 5.1.8' },
    cores: nc ? 3 : 2,
    temperatures,
    throttle: nc ? null : { current_mhz: 1350, max_mhz: 1350, throttled: false },
    memory: { total_bytes: 991 * MB, programs_bytes: 456 * MB, cache_bytes: 245 * MB, free_bytes: 290 * MB, percent: 46 },
    zram: { size_bytes: 1024 * MB, used_bytes: 0, pressure: false },
    storage: { total_bytes: 8 * 1024 * MB, used_bytes: 1536 * MB, free_bytes: 6656 * MB, percent: 18.8, path: '/opt', zone: 0 },
    conntrack: { available: true, count: 1048, max: 32768, percent: 3.2, available_entries: 31720, zone: 0 },
    ports: nc ? ports(4) : ports(5),
    slow_ports: [],
    ...over,
  };
}

// ---- history of the big chart (GET /api/system/history?range=...) ------------------------

const TS = 1792602000;
const RANGE_STEP = { '15m': 15, '30m': 30, '1h': 60, '6h': 300, '24h': 900, '7d': 1800 };
const RANGE_COLS = { '15m': 60, '30m': 60, '1h': 60, '6h': 72, '24h': 96, '7d': 336 };

const LINK_ISP = { id: 'ISP', label: 'МТС', kernel: 'eth3', primary: true, priority: 700, connected: true, tariff: { up_mbps: 50, down_mbps: 100 } };
const LINK_LTE = { id: 'UsbQmi0', label: 'Билайн', kernel: 'wwan0', primary: false, priority: 500, connected: true, tariff: null };

function column(values, orange, red) {
  const max = values.map(v => (v == null ? null : Math.round(v * 115) / 100));
  return { avg: values, max, zone: values.map(v => zoneOf(v, orange, red)), peak_zone: max.map(v => zoneOf(v, orange, red)) };
}

function plainColumn(values) {
  return { avg: values, max: values.map(v => (v == null ? null : v)) };
}

// `over` replaces single metrics, `down`/`up` are percent series of every tariff link.
function history(range, { links = [LINK_ISP], over = {}, since = null, top = null } = {}) {
  const step = RANGE_STEP[range];
  const count = RANGE_COLS[range];
  const start = Math.floor(TS / step) * step - (count - 1) * step;
  const series = fn => Array.from({ length: count }, (_, i) => fn(i));
  const metrics = {
    cpu: column(series(i => 20 + (i % 7) * 9), 60, 85),
    memory: column(series(() => 47), 75, 90),
    queue: column(series(i => 0.4 + (i % 5) * 0.2), 2.1, 3),
    online: { ...plainColumn(series(i => (i === 5 ? 0.6 : 1))), zone: series(i => (i === 5 ? 2 : 0)), peak_zone: series(() => 0) },
    'temp:cpu': column(series(() => 54), 80, 95),
  };
  for (const link of links) {
    const tariffed = !!link.tariff;
    metrics[`link_up:${link.id}`] = tariffed ? column(series(i => 8 + (i % 4)), 70, 90) : plainColumn(series(() => null));
    metrics[`link_down:${link.id}`] = tariffed ? column(series(i => 54 + (i % 3)), 70, 90) : plainColumn(series(() => null));
    metrics[`rate_up:${link.id}`] = plainColumn(series(i => 4 + (i % 4)));
    metrics[`rate_down:${link.id}`] = plainColumn(series(i => 53.7 + (i % 3)));
  }
  Object.assign(metrics, over);
  return {
    ok: true, range, step_s: step, start, history_since: since ?? start, cores: 3,
    bands: { cpu: { orange: 60, red: 85 }, memory: { orange: 75, red: 90 }, link: { orange: 70, red: 90 }, queue: { orange: 2.1, red: 3, scale_max: 6 } },
    metrics, links, top: top ? series(top) : [],
  };
}

// Requests the window makes, recorded by the helper below.
const api = { summary: 0, hardware: 0, history: [], patches: [], tools: [] };

async function openDashboard(page, { sum = summary(), hw = hardware(), width = 1600, hist = range => history(range), clock = false, patch = null, tools = {}, initrc = { state: 'ok' }, initrcAction = null } = {}) {
  api.summary = 0; api.hardware = 0; api.history = []; api.patches = []; api.tools = [];
  if (clock) await page.clock.install();
  await page.setViewportSize({ width, height: 1000 });
  api.initrc = []; api.initrcActions = [];
  await page.route('**/api/system/router/initrc', async route => {
    api.initrc.push(route.request().method());
    if (typeof initrc === 'function') { await initrc(route); return; }
    await route.fulfill({ json: { ok: true, path: null, dismissed: false, ...initrc } });
  });
  await page.route('**/api/system/router/initrc/*', async route => {
    const action = route.request().url().split('/').at(-1);
    api.initrcActions.push({ action, method: route.request().method(), csrf: route.request().headers()['x-csrf-token'] });
    if (initrcAction) { await initrcAction(route, action); return; }
    if (action === 'dismiss') initrc = { state: 'missing', dismissed: true };
    if (action === 'apply') initrc = { state: 'ok' };
    await route.fulfill({ json: { ok: true, state: 'ok' } });
  });
  await page.route('**/api/system/resources', route => route.fulfill({ json: legacyResources() }));
  await page.route('**/api/system/summary', route => { api.summary += 1; route.fulfill(sum ? { json: sum } : { status: 503, json: { ok: false } }); });
  await page.route('**/api/system/hardware', route => { api.hardware += 1; route.fulfill({ json: hw }); });
  await page.route('**/api/system/history*', route => {
    const range = new URL(route.request().url()).searchParams.get('range');
    api.history.push(range);
    const data = hist(range);
    route.fulfill(data ? { json: data } : { status: 503, json: { ok: false } });
  });
  // the tool tabs: every request is recorded; a key set to null answers 503
  const serve = (key, fallback) => route => {
    api.tools.push(route.request().url());
    const body = key in tools ? tools[key] : fallback;
    route.fulfill(body ? { json: body } : { status: 503, json: { ok: false } });
  };
  await page.route('**/api/system/events*', route => route.request().method() === 'GET' ? serve('events', { ok: true, events: [], active: [] })(route) : route.fallback());
  await page.route('**/api/system/router/clients*', serve('clients', { available: false, count: 0, items: [], top: [] }));
  await page.route('**/api/system/router/channel-check*', serve('channel', { available: false, state: 'unavailable', error: 'нет ping' }));
  await page.route('**/api/system/router/lte', serve('lte', { available: false, count: 0, items: [] }));
  await page.route('**/api/system/processes*', serve('processes', { available: false, count: 0, items: [] }));
  await page.route('**/api/ui-settings', async route => {
    if (route.request().method() !== 'PATCH') { await route.fallback(); return; }
    const body = route.request().postDataJSON();
    api.patches.push(body);
    if (patch) { await route.fulfill(patch(body)); return; }
    await route.fulfill({ json: { ok: true, settings: {} } });
  });
  await page.goto('/');
  const monitor = page.locator('#xk-resource-monitor');
  await expect(monitor).toHaveAttribute('data-state', 'ready');
  await monitor.evaluate(button => button.click());
  await expect(page.locator('#xk-resource-dashboard-modal')).toBeVisible();
  const view = page.locator('#xk-resource-dashboard-view');
  if (sum) await expect(view.locator('.xkm-card').first()).toBeVisible();
  if (sum) await expect(view.locator('.hw-grid')).toBeVisible();
  return view;
}

// Chart geometry through the handle the window keeps on the canvas.
const chartInfo = (view) => view.locator('.xkc-canvas').evaluate(canvas => {
  const handle = canvas.xkChart;
  const rect = canvas.getBoundingClientRect();
  const probe = (x, y) => (handle.cellAt ? handle.cellAt(x, y) : null);
  const last = handle.cellAt ? null : handle.columnAt(handle.plot.left + handle.plot.width - 0.5);
  const grid = handle.cellAt
    ? { columns: probe(rect.width - 1, 1).column + 1, rows: probe(1, rect.height - 1).row + 1 }
    : null;
  return { kind: canvas.dataset.kind, columns: grid ? grid.columns : last + 1, rows: grid ? grid.rows : 1, width: rect.width, height: rect.height, plotWidth: handle.plot.width, count: handle.count };
});

async function pointOfColumn(view, index) {
  // the chart sits below the hardware panel: bring it into the viewport before aiming the mouse
  await view.locator('.xkc-canvas').scrollIntoViewIfNeeded();
  return view.locator('.xkc-canvas').evaluate((canvas, i) => {
    const rect = canvas.getBoundingClientRect();
    const h = canvas.xkChart;
    return { x: rect.left + h.plot.left + (i + 0.5) * (h.plot.width / h.count), y: rect.top + rect.height * 0.25 };
  }, index);
}

const rect = (locator) => locator.evaluate(el => {
  const r = el.getBoundingClientRect();
  return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
});

const INITRC_TITLE = 'При перезагрузке роутера теряется часть истории';

test('event actions acknowledge and exclude only problems, and exceptions can be restored', async ({ page }) => {
  page.on('dialog', dialog => dialog.accept());
  const now = Math.floor(Date.now() / 1000);
  const problem = { id: 'port-1', type: 'port_slow', key: '4', at: now - 20, until: null, severity: 'warning', title: 'Порт 4 работает на 100 Мбит/с' };
  const info = { id: 'boot-1', type: 'router_rebooted', key: '', at: now - 30, until: now - 30, severity: 'info', title: 'Роутер перезагружен' };
  const data = { ok: true, events: [problem, info], active: [problem], exceptions: [] };
  await page.route('**/api/system/events/action', async route => {
    await new Promise(resolve => setTimeout(resolve, 400));
    const body = route.request().postDataJSON();
    if (body.action === 'acknowledge') problem.acknowledged = true;
    if (body.action === 'exclude') { problem.acknowledged = true; data.exceptions.push({ type: 'port_slow', key: '4' }); }
    if (body.action === 'restore') data.exceptions = [];
    return route.fulfill({ json: { ok: true } });
  });
  const view = await openDashboard(page, { tools: { events: data } });
  await view.locator('[data-tab="events"]').click();
  const warning = view.locator('.xkt-ev[data-type="port_slow"]');
  const informational = view.locator('.xkt-ev[data-type="router_rebooted"]');
  await expect(informational.locator('button')).toHaveCount(0);
  await warning.getByRole('button', { name: 'Прочитано' }).click();
  await expect(warning.getByRole('button', { name: 'Не предупреждать повторно' })).toBeDisabled();
  await expect(warning).toContainText('Прочитано');
  await warning.getByRole('button', { name: 'Не предупреждать повторно' }).click();
  await expect(view.getByRole('button', { name: /Исключения/ })).toBeVisible();
  await view.getByRole('button', { name: /Исключения/ }).click();
  await expect(view.locator('[data-role="exceptions"]')).toContainText('порт 4');
  await view.getByRole('button', { name: 'Снова предупреждать' }).click();
  await expect(view.locator('[data-role="exceptions"]')).not.toContainText('порт 4');
});
const INITRC_SUCCESS = 'Готово: сценарий остановки служб прописан';
const initrcHint = view => view.locator('.xkm-initrc');
async function reopenInitrcDashboard(page) {
  await page.locator('#xk-resource-dashboard-close').click();
  await page.locator('#xk-resource-monitor').evaluate(el => el.click());
}

test('initrc warning follows status and checks only once per opening', async ({ page }) => {
  const view = await openDashboard(page, { initrc: { state: 'missing' }, clock: true });
  await expect(initrcHint(view)).toContainText(INITRC_TITLE);
  expect((await rect(initrcHint(view))).top).toBeGreaterThan((await rect(view.locator('.xkm-status'))).bottom);
  await expect(view.locator('.xkm-status')).toContainText('Всё в порядке');
  await page.clock.runFor(16000);
  expect(api.initrc).toEqual(['GET']);
  await reopenInitrcDashboard(page);
  await expect.poll(() => api.initrc.length).toBe(2);
});

for (const status of [{ state: 'ok' }, { state: 'unknown' }, { state: 'missing', dismissed: true }]) {
  test(`initrc hides for ${JSON.stringify(status)}`, async ({ page }) => {
    const view = await openDashboard(page, { initrc: status });
    await expect.poll(() => api.initrc.length).toBe(1);
    await expect(initrcHint(view)).toBeHidden();
  });
}

test('initrc confirmation cancel and successful apply with CSRF', async ({ page }) => {
  let finish;
  const view = await openDashboard(page, { initrc: { state: 'missing' }, initrcAction: async route => {
    await new Promise(resolve => { finish = resolve; });
    await route.fulfill({ json: { ok: true, state: 'ok' } });
  } });
  const hint = initrcHint(view);
  await hint.getByRole('button', { name: 'Исправить', exact: true }).click();
  await expect(hint).toContainText('Прописать сценарий остановки служб?');
  await expect(hint).toContainText('opkg initrc /opt/etc/init.d/rc.unslung');
  expect(api.initrcActions).toHaveLength(0);
  await hint.getByRole('button', { name: 'Отмена', exact: true }).click();
  await expect(hint).toContainText(INITRC_TITLE);
  await hint.getByRole('button', { name: 'Исправить', exact: true }).click();
  await hint.getByRole('button', { name: 'Прописать', exact: true }).click();
  await expect.poll(() => api.initrcActions.length).toBe(1);
  expect(api.initrcActions[0]).toMatchObject({ action: 'apply', method: 'POST' });
  expect(api.initrcActions[0].csrf).toBeTruthy();
  await expect(hint.getByRole('button').first()).toBeDisabled();
  finish();
  await expect(hint).toContainText(INITRC_SUCCESS);
  await expect(hint).toHaveAttribute('data-state', 'success');
});

test('initrc apply failure is text and retry succeeds', async ({ page }) => {
  let attempts = 0;
  const details = '<img src=x onerror="window.initrcInjected=true"> % error denied';
  const view = await openDashboard(page, { initrc: { state: 'missing' }, initrcAction: route => {
    attempts += 1;
    return route.fulfill(attempts === 1 ? { status: 502, json: { ok: false, error: 'Ошибка прошивки', details } } : { json: { ok: true, state: 'ok' } });
  } });
  const hint = initrcHint(view);
  await hint.getByRole('button', { name: 'Исправить', exact: true }).click();
  await hint.getByRole('button', { name: 'Прописать', exact: true }).click();
  await expect(hint).toContainText(details);
  await expect(hint.locator('img')).toHaveCount(0);
  expect(await page.evaluate(() => window.initrcInjected)).toBeUndefined();
  await hint.getByRole('button', { name: 'Повторить', exact: true }).click();
  await expect(hint).toContainText(INITRC_SUCCESS);
  expect(attempts).toBe(2);
});

test('initrc dismiss persists across opening', async ({ page }) => {
  const view = await openDashboard(page, { initrc: { state: 'missing' } });
  await initrcHint(view).getByRole('button', { name: 'Скрыть', exact: true }).click();
  await expect(initrcHint(view)).toBeHidden();
  await reopenInitrcDashboard(page);
  await expect.poll(() => api.initrc.length).toBe(2);
  await expect(initrcHint(view)).toBeHidden();
  expect(api.initrcActions.map(r => r.action)).toEqual(['dismiss']);
});

test('initrc dismiss error retries dismiss instead of apply', async ({ page }) => {
  let attempts = 0;
  const view = await openDashboard(page, { initrc: { state: 'missing' }, initrcAction: route => {
    attempts += 1;
    return route.fulfill(attempts === 1 ? { status: 500, json: { ok: false, error: 'Не удалось сохранить настройки.' } } : { json: { ok: true } });
  } });
  const hint = initrcHint(view);
  await hint.getByRole('button', { name: 'Скрыть', exact: true }).click();
  await expect(hint).toContainText('Не удалось сохранить настройки.');
  await hint.getByRole('button', { name: 'Повторить', exact: true }).click();
  await expect(hint).toBeHidden();
  expect(api.initrcActions.map(r => r.action)).toEqual(['dismiss', 'dismiss']);
});

test('initrc successful apply resets on reopen', async ({ page }) => {
  const view = await openDashboard(page, { initrc: { state: 'missing' } });
  const hint = initrcHint(view);
  await hint.getByRole('button', { name: 'Исправить', exact: true }).click();
  await hint.getByRole('button', { name: 'Прописать', exact: true }).click();
  await expect(hint).toContainText(INITRC_SUCCESS);
  await reopenInitrcDashboard(page);
  await expect.poll(() => api.initrc.length).toBe(2);
  await expect(hint).toBeHidden();
});

test('initrc failed GET keeps diagnostics usable', async ({ page }) => {
  const view = await openDashboard(page, { initrc: route => route.fulfill({ status: 503, json: { ok: false } }) });
  await expect(initrcHint(view)).toBeHidden();
  await expect(view.locator('.xkm-card').first()).toBeVisible();
});

test('initrc late apply response cannot replace reopened warning', async ({ page }) => {
  let finish;
  const view = await openDashboard(page, { initrc: { state: 'missing' }, initrcAction: async route => {
    await new Promise(resolve => { finish = resolve; });
    await route.fulfill({ json: { ok: true, state: 'ok' } }).catch(() => {});
  } });
  const hint = initrcHint(view);
  await hint.getByRole('button', { name: 'Исправить', exact: true }).click();
  await hint.getByRole('button', { name: 'Прописать', exact: true }).click();
  await expect.poll(() => api.initrcActions.length).toBe(1);
  await reopenInitrcDashboard(page);
  await expect(hint).toContainText(INITRC_TITLE);
  finish();
  await expect(hint).toHaveAttribute('data-state', 'warning');
});

for (const width of [1280, 390]) {
  test(`initrc layout and long errors at ${width}px`, async ({ page }) => {
    const view = await openDashboard(page, { width, initrc: { state: 'missing' }, initrcAction: route => route.fulfill({ status: 502, json: { ok: false, details: 'error:' + 'x'.repeat(400) } }) });
    const hint = initrcHint(view);
    await expect(hint).toContainText(INITRC_TITLE);
    const noOverflow = async () => expect(await hint.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await noOverflow();
    if (width === 390) expect((await rect(hint.locator('.xkm-initrc-actions'))).top).toBeGreaterThanOrEqual((await rect(hint.locator('.xkm-initrc-copy'))).bottom);
    await hint.screenshot({ path: `.superpowers/sdd/2026-10-27-entware-initrc-fix/warning-${width}.png` });
    await hint.getByRole('button', { name: 'Исправить', exact: true }).click();
    await noOverflow();
    await hint.screenshot({ path: `.superpowers/sdd/2026-10-27-entware-initrc-fix/confirm-${width}.png` });
    await hint.getByRole('button', { name: 'Прописать', exact: true }).click();
    await expect(hint).toContainText('error:');
    await noOverflow();
  });
}

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
  // "свободно" counts the cache, as the router's own UI does: 290 + 245 MB
  await expect(view.locator('.hw-leg')).toHaveText(/программы 456\sМБ\s*свободно 535\sМБ\s*из них кэш 245\sМБ/);
});

test('hardware: many sensors keep the temperature tiles compact, port labels are never cut', async ({ page }) => {
  for (const width of [1280, 1600, 1920]) {
    const view = await openDashboard(page, { width, hw: hardware('nc1812', { ports: ports(5, { slow: 4 }) }) });
    await expect(view.locator('.hw-t')).toHaveCount(6);
    const m = await view.locator('.hw-grid').evaluate(grid => ({
      temps: grid.querySelector('[data-section="temperature"]').getBoundingClientRect().width,
      ports: grid.querySelector('[data-section="ports"]').getBoundingClientRect().width,
      cut: [...grid.querySelectorAll('.hw-port small:not(.d)')].filter(e => e.scrollWidth > e.clientWidth + 1).map(e => e.textContent),
    }));
    // the ports get nearly the room of the temperatures (it was ~62 % before the tiles were narrowed)
    expect(m.ports / m.temps, `ports vs temperatures at ${width}`).toBeGreaterThanOrEqual(0.9);
    expect(m.cut, `port labels at ${width}`).toEqual([]);
  }
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

test('temperature tiles explain themselves in a hint, without sensor names or counts', async ({ page }) => {
  const view = await openDashboard(page);
  const cpu = view.locator('.hw-t[data-temp="cpu"]');
  await expect(cpu.locator('.n')).toHaveText('Процессор');
  await expect(view.locator('.hw-sec[data-section="temperature"]')).not.toContainText('датчик');
  await cpu.hover();
  const pop = cpu.locator('.hw-pop');
  await expect(pop).toBeVisible();
  await expect(pop).toContainText('Ядра процессора');
  await expect(pop).toContainText('Греется от: шифрование прокси');
  await expect(pop).toContainText('норма до 80 °C');
  await expect(pop).toContainText('перегрев выше 95 °C');
  await expect(pop).not.toContainText('_thermal');
  // Wi-Fi has its own thresholds; a tile of the right column hangs its hint from the right edge
  const wifi = view.locator('.hw-t[data-temp="wifi5"]');
  await wifi.hover();
  await expect(wifi.locator('.hw-pop')).toContainText('горячо 85–100 °C');
  const [tile, hint] = [await rect(wifi), await rect(wifi.locator('.hw-pop'))];
  expect(Math.abs(hint.right - tile.right)).toBeLessThanOrEqual(1);
});

test('the only sensor of a model is the processor, its hint speaks of the whole chip', async ({ page }) => {
  const view = await openDashboard(page, { hw: hardware('kn1811') });
  const cpu = view.locator('.hw-t[data-temp="cpu"]');
  await expect(cpu.locator('.n')).toHaveText('Процессор');
  await cpu.hover();
  await expect(cpu.locator('.hw-pop')).toContainText('Датчик главной микросхемы роутера');
  await expect(cpu.locator('.hw-pop')).not.toContainText('Ядра процессора');
});

test('phone: a tapped tile shows its hint inside the screen', async ({ page }) => {
  const view = await openDashboard(page, { width: 390 });
  for (const id of ['npu', 'ports']) {
    const tile = view.locator(`.hw-t[data-temp="${id}"]`);
    await tile.scrollIntoViewIfNeeded();
    await tile.focus();
    const hint = tile.locator('.hw-pop');
    await expect(hint).toBeVisible();
    const box = await rect(hint);
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(390);
  }
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

test('memory block colours meters and the zram warning from server zones only', async ({ page }) => {
  const hw = hardware('nc1812', {
    zram: { size_bytes: 1024 * MB, used_bytes: 100 * MB, pressure: true },
    storage: { total_bytes: 8 * 1024 * MB, used_bytes: 1536 * MB, free_bytes: 6656 * MB, percent: 18.8, path: '/opt', zone: 2 },
    conntrack: { available: true, count: 1048, max: 32768, percent: 3.2, available_entries: 31720, zone: 1 },
  });
  const view = await openDashboard(page, { hw });
  await expect(view.locator('.hw-kv em.o')).toHaveText('роутеру не хватает памяти');
  await expect(view.locator('.hw-meter.r')).toHaveCount(1);
  await expect(view.locator('.hw-meter.o')).toHaveCount(1);
});

// ---- the big chart: ranges, metrics, network mirror, tariff, polling ----------------------

test('range buttons change column count', async ({ page }) => {
  const view = await openDashboard(page);
  await expect(view.locator('.xkc-canvas')).toHaveAttribute('data-kind', 'level');
  expect(api.history).toEqual(['1h']);
  expect((await chartInfo(view)).columns).toBe(60);
  for (const [range, columns] of [['15m', 60], ['30m', 60], ['1h', 60], ['6h', 72]]) {
    await view.locator(`.xkc-b[data-range="${range}"]`).click();
    await expect(view.locator(`.xkc-b[data-range="${range}"]`)).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => api.history.at(-1)).toBe(range);
    await expect.poll(async () => (await chartInfo(view)).columns).toBe(columns);
  }
  // 24 h: a grid of 96 cells per row, the metric tabs are hidden
  await view.locator('.xkc-b[data-range="24h"]').click();
  await expect(view.locator('.xkc-canvas')).toHaveAttribute('data-kind', 'grid24');
  const day = await chartInfo(view);
  expect(day.columns).toBe(96);
  expect(day.rows).toBe(6);
  await expect(view.locator('.xkc-tabs')).toBeHidden();
  // 7 d: seven day rows, the tabs come back with "Все" chosen
  await view.locator('.xkc-b[data-range="7d"]').click();
  await expect(view.locator('.xkc-canvas')).toHaveAttribute('data-kind', 'grid7');
  const week = await chartInfo(view);
  expect(week.rows).toBe(7);
  expect(week.columns).toBe(48);
  await expect(view.locator('.xkc-b[data-metric="all"]')).toBeVisible();
  await expect(view.locator('.xkc-b[data-metric="all"]')).toHaveAttribute('aria-pressed', 'true');
  // back to a short range: "Все" is gone and the earlier metric returns
  await view.locator('.xkc-b[data-range="1h"]').click();
  await expect(view.locator('.xkc-canvas')).toHaveAttribute('data-kind', 'level');
  await expect(view.locator('.xkc-b[data-metric="all"]')).toBeHidden();
  await expect(view.locator('.xkc-b[data-metric="cpu"]')).toHaveAttribute('aria-pressed', 'true');
});

test('metric tabs and the level chart take the bands from the server', async ({ page }) => {
  const view = await openDashboard(page);
  await view.locator('.xkc-b[data-metric="queue"]').click();
  const gutter = view.locator('.xkc-gutter');
  // scale top = 2 x cores, red from 1 x cores, orange from 0,7 x cores: all of it the server's `bands`
  await expect(gutter).toContainText('6,0');
  await expect(gutter).toContainText('3,0');
  await expect(gutter).toContainText('2,1');
  await expect(view.locator('.xkc-info')).toContainText('перегрузка выше 3,0');
  await view.locator('.xkc-b[data-metric="cpu"]').click();
  await expect(view.locator('.xkc-info')).toContainText('перегрузка выше 85 %');
  await expect(view.locator('.xkc-summary')).toContainText('Сейчас');
  await expect(view.locator('.xkc-summary')).toContainText('В среднем');
  await expect(view.locator('.xkc-summary')).toContainText('В оранжевой зоне');
  await expect(view.locator('.xkc-summary')).toContainText('В красной');
  await expect(view.locator('.xkc-summary')).toContainText(/Пик в \d\d:\d\d/);
  // a zero minute count is neutral, a real one is coloured
  const red = view.locator('.xkc-summary b').last();
  await expect(red).toHaveClass(/z2|zero/);
});

test('card click switches chart metric', async ({ page }) => {
  const view = await openDashboard(page);
  const pressed = metric => expect(view.locator(`.xkc-b[data-metric="${metric}"]`)).toHaveAttribute('aria-pressed', 'true');
  await view.locator('.xkm-card[data-metric="memory"]').click();
  await pressed('memory');
  await view.locator('.xkm-card[data-metric="link"]').click();
  await pressed('net');
  await expect(view.locator('.xkc-canvas')).toHaveAttribute('data-kind', 'mirror');
  await view.locator('.xkm-card[data-metric="cpu"]').click();
  await pressed('cpu');
  await expect(view.locator('.xkc-canvas')).toHaveAttribute('data-kind', 'level');
  // the Internet card opens the details of the connection chain
  await expect(view.locator('.xkm-node-detail')).toHaveCount(0);
  await view.locator('.xkm-card[data-metric="internet"]').click();
  await expect(view.locator('.xkm-node-detail')).toBeVisible();
  // on "24 ч" a metric card returns to a short range
  await view.locator('.xkc-b[data-range="24h"]').click();
  await expect(view.locator('.xkc-canvas')).toHaveAttribute('data-kind', 'grid24');
  await view.locator('.xkm-card[data-metric="memory"]').click();
  await expect(view.locator('.xkc-canvas')).toHaveAttribute('data-kind', 'level');
  await pressed('memory');
});

test('net chart percent and over-tariff tooltip', async ({ page }) => {
  const over = 105;
  const hist = range => {
    const base = history(range);
    const down = base.metrics['link_down:ISP'];
    const last = down.avg.length - 1;
    down.avg[10] = 54; down.max[10] = 55; down.zone[10] = 0; down.peak_zone[10] = 0;
    down.avg[last] = over; down.max[last] = over + 3; down.zone[last] = 2; down.peak_zone[last] = 2;
    base.metrics['rate_down:ISP'].avg[10] = 53.7;
    base.metrics['rate_down:ISP'].avg[last] = 105.4;
    return base;
  };
  const view = await openDashboard(page, { hist });
  await view.locator('.xkm-card[data-metric="link"]').click();
  await expect(view.locator('.xkc-canvas')).toHaveAttribute('data-kind', 'mirror');
  await expect(view.locator('.xkc-gutter')).toContainText('↑ Отдача');
  await expect(view.locator('.xkc-gutter')).toContainText('↓ Приём');
  // upload is above the centre line, download below it
  const order = await view.locator('.xkc-gutter span.b').evaluateAll(els => els.map(el => ({ text: el.textContent, top: el.getBoundingClientRect().top })));
  expect(order.find(o => o.text.includes('Отдача')).top).toBeLessThan(order.find(o => o.text.includes('Приём')).top);
  const count = (await chartInfo(view)).count;
  let p = await pointOfColumn(view, 10);
  await page.mouse.move(p.x, p.y);
  await expect(view.locator('.xkc-tip')).toContainText('↓ Приём 54 % · 53,7 Мбит/с');
  p = await pointOfColumn(view, count - 1);
  await page.mouse.move(p.x, p.y);
  await expect(view.locator('.xkc-tip')).toContainText('105 % — выше тарифа');
  // the over-tariff column is painted red from the server zone: the first lit segment below the centre line
  const pixel = await view.locator('.xkc-canvas').evaluate((canvas, i) => {
    const h = canvas.xkChart;
    const dpr = canvas.width / canvas.getBoundingClientRect().width;
    const x = Math.round((h.plot.left + (i + 0.5) * (h.plot.width / h.count)) * dpr);
    const y = Math.round((canvas.getBoundingClientRect().height / 2 + 4) * dpr);
    return Array.from(canvas.getContext('2d').getImageData(x, y, 1, 1).data);
  }, count - 1);
  expect(pixel[3]).toBeGreaterThan(200);
  expect(pixel[0]).toBeGreaterThan(pixel[1] + 40);
  await expect(view.locator('.xkc-info')).toContainText('до 70 % тарифа');
  await expect(view.locator('.xkc-info')).toContainText('Тариф: приём 100, отдача 50 Мбит/с');
  await expect(view.locator('.xkc-reserve')).toHaveCount(0);
});

test('no tariff shows Mbit and link', async ({ page }) => {
  const noTariff = { ...LINK_ISP, tariff: null };
  const sum = summary({ links: [noTariff] });
  sum.cards.link = { ...sum.cards.link, has_tariff: false, tariff: null, text: 'тариф не указан' };
  const view = await openDashboard(page, { sum, hist: range => history(range, { links: [noTariff] }) });
  await view.locator('.xkm-card[data-metric="link"]').click();
  await expect(view.locator('.xkc-canvas')).toHaveAttribute('data-kind', 'mirror');
  await expect(view.locator('.xkc-info [data-link="tariff"]')).toHaveText('указать скорость тарифа');
  await expect(view.locator('.xkc-gutter')).toContainText('Мбит/с');
  await expect(view.locator('.xkc-info')).not.toContainText('до 70 % тарифа');
  const p = await pointOfColumn(view, 20);
  await page.mouse.move(p.x, p.y);
  await expect(view.locator('.xkc-tip')).toContainText('↓ Приём');
  await expect(view.locator('.xkc-tip')).toContainText('Мбит/с');
  await expect(view.locator('.xkc-tip')).not.toContainText('%');
  await expect(view.locator('.xkc-reserve')).toHaveCount(0);
});

test('two connections: switcher, per-connection tariff, secondary line in card, two channel rows in 24h', async ({ page }) => {
  const links = [LINK_ISP, LINK_LTE];
  const sum = summary({ links });
  sum.cards.link = { ...sum.cards.link, secondary: [{ label: 'Билайн', up_percent: 0, down_percent: 3, up_mbps: 0, down_mbps: 0.2 }] };
  const view = await openDashboard(page, { sum, hist: range => history(range, { links }) });
  await expect(view.locator('.xkm-card[data-metric="link"]')).toContainText('Билайн: ↑ 0 % / ↓ 3 %');
  await view.locator('.xkm-card[data-metric="link"]').click();
  const switcher = view.locator('.xkc-links .xkc-b');
  await expect(switcher).toHaveCount(2);
  await expect(switcher.nth(0)).toHaveText('МТС');
  await expect(switcher.nth(0)).toHaveAttribute('aria-pressed', 'true');
  await expect(view.locator('.xkc-info')).toContainText('Канал · МТС');
  await expect(view.locator('.xkc-info')).toContainText('Тариф: приём 100, отдача 50 Мбит/с');
  // the second connection has no tariff of its own
  await switcher.nth(1).click();
  await expect(switcher.nth(1)).toHaveAttribute('aria-pressed', 'true');
  await expect(view.locator('.xkc-info')).toContainText('Канал · Билайн');
  await expect(view.locator('.xkc-info [data-link="tariff"]')).toHaveText('указать скорость тарифа');
  await expect(view.locator('.xkc-gutter')).toContainText('Мбит/с');
  // the primary one is not "reserve": the other connection has no tariff either
  await expect(view.locator('.xkc-reserve')).toHaveCount(0);
  // 24 h: one channel row per connection
  await view.locator('.xkc-b[data-range="24h"]').click();
  await expect(view.locator('.xkc-gutter .rl')).toContainText(['Процессор', 'Память', 'Канал · МТС', 'Канал · Билайн', 'Очередь задач', 'Интернет', 'Температура']);
  expect((await chartInfo(view)).rows).toBe(7);
});

test('single connection hides the switcher', async ({ page }) => {
  const view = await openDashboard(page);
  await view.locator('.xkm-card[data-metric="link"]').click();
  await expect(view.locator('.xkc-canvas')).toHaveAttribute('data-kind', 'mirror');
  await expect(view.locator('.xkc-links')).toHaveCount(0);
});

test('failover to connection without tariff shows «резервный канал»', async ({ page }) => {
  const links = [{ ...LINK_ISP, primary: false }, { ...LINK_LTE, primary: true }];
  const sum = summary({ links });
  sum.cards.link = { ...sum.cards.link, id: 'UsbQmi0', label: 'Билайн', has_tariff: false, tariff: null, text: 'тариф не указан' };
  const view = await openDashboard(page, { sum, hist: range => history(range, { links }) });
  await view.locator('.xkm-card[data-metric="link"]').click();
  await expect(view.locator('.xkc-canvas')).toHaveAttribute('data-kind', 'mirror');
  await expect(view.locator('.xkc-links .xkc-b[aria-pressed="true"]')).toHaveText('Билайн');
  await expect(view.locator('.xkc-reserve')).toHaveText('резервный канал');
  await expect(view.locator('.xkc-gutter')).toContainText('Мбит/с');
  // the connection that has the tariff is one click away
  await view.locator('.xkc-links .xkc-b').first().click();
  await expect(view.locator('.xkc-reserve')).toHaveCount(0);
  await expect(view.locator('.xkc-info')).toContainText('Тариф: приём 100, отдача 50 Мбит/с');
});

test('tariff form rejects text and saves numbers', async ({ page }) => {
  const view = await openDashboard(page, {
    patch: body => {
      const t = body.diagnostics.tariffs.ISP;
      if (t.down_mbps === 99999) return { status: 400, json: { ok: false, code: 'bad_patch', errors: [{ path: 'diagnostics.tariffs.ISP.down_mbps', error: 'Скорость тарифа — целое число от 1 до 10000 Мбит/с' }] } };
      return { json: { ok: true, settings: {} } };
    },
  });
  await view.locator('.xkm-card[data-metric="link"]').click();
  await view.locator('.xkc-info [data-link="tariff"]').click();
  const form = view.locator('.xkt');
  await expect(form).toBeVisible();
  await expect(form).toContainText('Тариф · МТС');
  await expect(form).toContainText('за сутки приём доходил до');
  await expect(form).toContainText('проверьте, верно ли указан тариф');
  const up = form.locator('input[name="up"]');
  const down = form.locator('input[name="down"]');
  await expect(up).toHaveValue('50');
  await expect(down).toHaveValue('100');
  // text and fractions are refused on the client: nothing is sent
  await up.fill('abc');
  await form.locator('[type="submit"]').click();
  await expect(form.locator('[data-for="up"]')).toContainText('целое число');
  await up.fill('12.5');
  await form.locator('[type="submit"]').click();
  await expect(form.locator('[data-for="up"]')).toContainText('целое число');
  expect(api.patches).toEqual([]);
  // the server's own message is shown under the field it is about
  await up.fill('60');
  await down.fill('99999');
  await form.locator('[type="submit"]').click();
  await expect(form.locator('[data-for="down"]')).toContainText('целое число от 1 до 10000');
  await expect(form.locator('[data-for="up"]')).toHaveText('');
  expect(api.patches.length).toBe(1);
  // numbers are saved through the settings patch, the window then reloads its data
  const before = api.history.length;
  await down.fill('300');
  await form.locator('[type="submit"]').click();
  await expect(form).toHaveCount(0);
  expect(api.patches.at(-1)).toEqual({ diagnostics: { tariffs: { ISP: { up_mbps: 60, down_mbps: 300 } } } });
  await expect.poll(() => api.history.length).toBeGreaterThan(before);
});

test('hidden tab stops polling', async ({ page }) => {
  const view = await openDashboard(page, { clock: true });
  await expect(view.locator('.xkc-canvas')).toBeVisible();
  const setVisibility = state => page.evaluate(value => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => value === 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
  const requests = () => api.summary + api.hardware + api.history.length;
  // visible: the 5 s tick asks for the summary
  const first = api.summary;
  await page.clock.runFor(5200);
  await expect.poll(() => api.summary).toBeGreaterThan(first);
  // hidden: a minute of timers brings no request at all
  await setVisibility('hidden');
  await page.waitForTimeout(100);
  const quiet = requests();
  await page.clock.runFor(60000);
  await page.waitForTimeout(300);
  expect(requests()).toBe(quiet);
  // back: exactly one history request
  const historyBefore = api.history.length;
  await setVisibility('visible');
  await expect.poll(() => api.history.length).toBe(historyBefore + 1);
  await page.waitForTimeout(400);
  expect(api.history.length).toBe(historyBefore + 1);
});

test('only last column redrawn on tick', async ({ page }) => {
  const sum = summary();
  const view = await openDashboard(page, { sum, clock: true });
  await expect(view.locator('.xkc-canvas')).toBeVisible();
  const info = await chartInfo(view);
  expect(info.count).toBe(60);
  // a heavier sample arrives with the next tick; only the open column changes
  sum.values = { ...sum.values, cpu: 95 };
  sum.zones = { ...sum.zones, cpu: 2 };
  await page.evaluate(() => {
    window.__clears = [];
    const original = CanvasRenderingContext2D.prototype.clearRect;
    CanvasRenderingContext2D.prototype.clearRect = function patched(x, y, w, h) {
      if (this.canvas.classList.contains('xkc-canvas')) window.__clears.push({ x, y, w, h });
      return original.call(this, x, y, w, h);
    };
  });
  await page.clock.runFor(5200);
  await expect.poll(() => page.evaluate(() => window.__clears.length)).toBeGreaterThan(0);
  const clears = await page.evaluate(() => window.__clears);
  const column = info.plotWidth / info.count;
  for (const c of clears) {
    expect(Math.abs(c.w - column)).toBeLessThan(1);
    expect(c.w).toBeLessThan(info.width / 2);
  }
  // the clears are all at the last column
  for (const c of clears) expect(c.x).toBeGreaterThan(info.plotWidth - column - 1);
  expect(api.history).toEqual(['1h']);
});

test('phone network current value survives an open-column update', async ({ page }) => {
  const sum = summary();
  const view = await openDashboard(page, { sum, clock: true, width: 390 });
  await view.locator('.xkc-tabs [data-metric="net"]').click();
  await expect(view.locator('.xkc-summary')).toContainText('↑ Отдача сейчас 2 %');
  sum.values['link_up:ISP'] = 7;
  await page.clock.runFor(5200);
  await expect(view.locator('.xkc-summary')).toContainText('↑ Отдача сейчас 7 %', { timeout: 1500 });
});

test('network current values become unavailable after a failed summary fetch', async ({ page }) => {
  const view = await openDashboard(page, { clock: true });
  await view.locator('.xkc-tabs [data-metric="net"]').click();
  await expect(view.locator('.xkc-summary')).toContainText('↑ Отдача сейчас 2 %');
  await page.unroute('**/api/system/summary');
  await page.route('**/api/system/summary', route => route.fulfill({ status: 503, json: { ok: false } }));
  await page.clock.runFor(5200);
  await expect(view.locator('.xkc-summary')).toContainText('↑ Отдача сейчас —');
  await expect(view.locator('.xkc-summary')).toContainText('Среднее последнего столбца');
});

test('initial fetch failure shows a message with a retry button', async ({ page }) => {
  let healthy = false;
  const view = await openDashboard(page, { sum: null, hist: range => (healthy ? history(range) : null) });
  const error = view.locator('.xkc-error');
  await expect(error).toBeVisible();
  await expect(error).toContainText('Не удалось получить данные диагностики роутера');
  await expect(error.locator('[data-retry]')).toHaveText('Повторить');
  await expect(view.locator('.xkc')).toBeHidden();
  healthy = true;
  await page.unroute('**/api/system/summary');
  await page.route('**/api/system/summary', route => route.fulfill({ json: summary() }));
  await error.locator('[data-retry]').click();
  await expect(view.locator('.xkc-canvas')).toBeVisible();
  await expect(view.locator('.xkc-error')).toBeHidden();
  await expect(view.locator('.xkm-card').first()).toBeVisible();
});

test('reopening starts from the default 1 h, the old chart is cleared on close', async ({ page }) => {
  const view = await openDashboard(page);
  await view.locator('.xkc-b[data-range="7d"]').click();
  await expect(view.locator('.xkc-canvas')).toHaveAttribute('data-kind', 'grid7');
  await page.locator('#xk-resource-dashboard-close').click();
  await expect(page.locator('#xk-resource-dashboard-modal')).toBeHidden();
  expect(await view.locator('.xkc').evaluate(el => el.hidden)).toBe(true);
  api.history = [];
  await page.locator('#xk-resource-monitor').evaluate(button => button.click());
  await expect(view.locator('.xkc-canvas')).toHaveAttribute('data-kind', 'level');
  expect(api.history[0]).toBe('1h');
  await expect(view.locator('.xkc-b[data-range="1h"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(view.locator('.xkc-b[data-metric="cpu"]')).toHaveAttribute('aria-pressed', 'true');
});

test('a failed range switch shows the error and retries to the new range', async ({ page }) => {
  let healthy = true;
  const view = await openDashboard(page, { hist: range => (range !== '1h' && !healthy ? null : history(range)) });
  await expect(view.locator('.xkc-canvas')).toHaveAttribute('data-kind', 'level');
  healthy = false;
  await view.locator('.xkc-b[data-range="6h"]').click();
  await expect(view.locator('.xkc-error')).toBeVisible();
  await expect(view.locator('.xkc-error')).toContainText('Не удалось загрузить историю');
  await expect(view.locator('.xkc-b[data-range="6h"]')).toHaveAttribute('aria-pressed', 'true');
  healthy = true;
  await view.locator('.xkc-b[data-range="6h"]').click();
  await expect(view.locator('.xkc-error')).toBeHidden();
  await expect.poll(async () => (await chartInfo(view)).columns).toBe(72);
  // the retry button works as well
  healthy = false;
  await view.locator('.xkc-b[data-range="15m"]').click();
  await expect(view.locator('.xkc-error')).toBeVisible();
  healthy = true;
  await view.locator('.xkc-error [data-retry]').click();
  await expect(view.locator('.xkc-error')).toBeHidden();
  await expect(view.locator('.xkc-b[data-range="15m"]')).toHaveAttribute('aria-pressed', 'true');
});

test('freshness text counts seconds since the last answer', async ({ page }) => {
  await openDashboard(page, { clock: true });
  const freshness = page.locator('#xk-resource-dashboard-freshness');
  await expect(freshness).toHaveText(/Обновлено \d+ с назад/);
  await page.clock.runFor(3000);
  await expect(freshness).toHaveText(/Обновлено [1-9]\d* с назад/);
});

test('JSON snapshot is built from the new data without addresses', async ({ page }) => {
  const view = await openDashboard(page);
  await expect(view.locator('.xkc-canvas')).toBeVisible();
  const modal = page.locator('#xk-resource-dashboard-modal');
  await expect(modal.locator('#xk-resource-export')).toBeHidden();
  await modal.locator('#xk-resource-more').click();
  await expect(modal.locator('#xk-resource-export')).toBeEnabled();
  const [download] = await Promise.all([page.waitForEvent('download'), modal.locator('#xk-resource-export').click()]);
  const text = await (await import('node:fs/promises')).readFile(await download.path(), 'utf8');
  const snapshot = JSON.parse(text);
  expect(snapshot.schema_version).toBe(2);
  expect(snapshot.range).toBe('1h');
  expect(snapshot.history.cpu.avg.length).toBe(60);
  expect(snapshot.now.cpu_percent).toBe(19);
  expect(text).not.toContain('192.0.2.');
  expect(text).not.toContain('МТС');
  expect(text).not.toContain('Provider A');
});

test('24 h cell opens 6 h with highlight, the last hour opens 1 h; 7 d last day opens 24 h', async ({ page }) => {
  const view = await openDashboard(page);
  await view.locator('.xkc-b[data-range="24h"]').click();
  await expect(view.locator('.xkc-canvas')).toHaveAttribute('data-kind', 'grid24');
  const clickCell = async (column, row = 0) => {
    await view.locator('.xkc-canvas').scrollIntoViewIfNeeded();
    return clickCellPoint(column, row);
  };
  const clickCellPoint = (column, row = 0) => view.locator('.xkc-canvas').evaluate((canvas, [c, r]) => {
    const rect = canvas.getBoundingClientRect();
    const h = canvas.xkChart;
    const cols = Number(canvas.dataset.columns);
    const rows = Number(canvas.dataset.rows);
    return { x: rect.left + h.plot.left + (c + 0.5) * (h.plot.width / cols), y: rect.top + (r + 0.5) * (rect.height / rows) };
  }, [column, row]);
  // cell 90 of 96 is within the last 3 hours of the day, not the last hour; 80 is 4 hours back
  let p = await clickCell(80);
  await page.mouse.move(p.x, p.y);
  await expect(view.locator('.xkc-tip')).toContainText('Процессор');
  await page.mouse.click(p.x, p.y);
  await expect(view.locator('.xkc-canvas')).toHaveAttribute('data-kind', 'level');
  await expect(view.locator('.xkc-b[data-range="6h"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(view.locator('.xkc-hl')).toBeVisible();
  await view.locator('.xkc-b[data-range="24h"]').click();
  await expect(view.locator('.xkc-canvas')).toHaveAttribute('data-kind', 'grid24');
  p = await clickCell(95);
  await page.mouse.click(p.x, p.y);
  await expect(view.locator('.xkc-b[data-range="1h"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(view.locator('.xkc-hl')).toBeVisible();
  // 7 d: a cell of today opens "24 ч" (the last cell of the first row belongs to the last day)
  await view.locator('.xkc-b[data-range="7d"]').click();
  await expect(view.locator('.xkc-canvas')).toHaveAttribute('data-kind', 'grid7');
  await view.locator('.xkc-canvas').scrollIntoViewIfNeeded();
  // the history ends at TS, not at the wall clock: after that hour the cells of today are empty
  const today = await view.locator('.xkc-canvas').evaluate((canvas, ts) => {
    const rect = canvas.getBoundingClientRect();
    const h = canvas.xkChart;
    const last = new Date(ts * 1000);
    const cell = Math.max(0, Math.floor((last.getHours() * 60 + last.getMinutes()) / 30) - 1);
    return { x: rect.left + h.plot.left + (cell + 0.5) * (h.plot.width / 48), y: rect.top + rect.height / 14 };
  }, TS);
  await page.mouse.click(today.x, today.y);
  await expect(view.locator('.xkc-b[data-range="24h"]')).toHaveAttribute('aria-pressed', 'true');
});

// Even columns: xray leads; odd ones: the network packets of the kernel lead; column 3 has no data.
const LEADERS = i => (i === 3 ? null : i % 2 ? [['ksoftirqd', 30], ['xray', 10]] : [['xray', 40], ['ndm', 2]]);

test('who loaded the processor: chart tooltip, 24 h cell and status line', async ({ page }) => {
  const sum = summary({
    status: {
      tone: 'problem',
      problems: [{
        id: 'cpu_overload-1', type: 'cpu_overload', at: 1792601640, until: null, severity: 'problem',
        title: 'Процессор перегружен', detail: 'больше всех: xray 62 %', key: 'cpu', leaders: [['xray', 62.4], ['ndm', 3]],
      }],
    },
  });
  const view = await openDashboard(page, { sum, hist: range => history(range, { top: LEADERS }) });
  await expect(view.locator('.xkm-status')).toContainText('процессор перегружен — больше всех xray (62 %)');
  await expect(view.locator('.xkc-canvas')).toHaveAttribute('data-kind', 'level');
  let p = await pointOfColumn(view, 10);
  await page.mouse.move(p.x, p.y);
  const tip = view.locator('.xkc-tip');
  await expect(tip).toContainText('Больше всех нагружали');
  await expect(tip).toContainText('xray · ядро прокси Xray40 %');
  await expect(tip).toContainText('ndm · система Keenetic2 %');
  p = await pointOfColumn(view, 3);
  await page.mouse.move(p.x, p.y);
  await expect(tip).toBeVisible();
  await expect(tip).not.toContainText('Больше всех');
  // other metrics do not name processes
  await view.locator('.xkm-card[data-metric="memory"]').click();
  p = await pointOfColumn(view, 10);
  await page.mouse.move(p.x, p.y);
  await expect(tip).toContainText('В среднем');
  await expect(tip).not.toContainText('Больше всех');
  // a 24 h cell
  await view.locator('.xkc-b[data-range="24h"]').click();
  await expect(view.locator('.xkc-canvas')).toHaveAttribute('data-kind', 'grid24');
  await view.locator('.xkc-canvas').scrollIntoViewIfNeeded();
  p = await view.locator('.xkc-canvas').evaluate(canvas => {
    const rect = canvas.getBoundingClientRect();
    const h = canvas.xkChart;
    return { x: rect.left + h.plot.left + 11.5 * (h.plot.width / Number(canvas.dataset.columns)), y: rect.top + rect.height / 2 };
  });
  await page.mouse.move(p.x, p.y);
  await expect(tip).toContainText('ksoftirqd · обработка сетевых пакетов30 %');
});

test('phone folds the leaders of two columns into one', async ({ page }) => {
  const view = await openDashboard(page, { width: 390, hist: range => history(range, { top: LEADERS }) });
  await expect(view.locator('.xkc-canvas')).toBeVisible();
  await view.locator('.xkc-canvas').scrollIntoViewIfNeeded();
  // folded column 5 = columns 10 and 11: xray (40 + 10) / 2, ksoftirqd 30 / 2, ndm 2 / 2
  const p = await pointOfColumn(view, 5);
  await page.mouse.move(p.x, p.y);
  const tip = view.locator('.xkc-tip');
  await expect(tip).toContainText('xray · ядро прокси Xray25 %');
  await expect(tip).toContainText('ksoftirqd · обработка сетевых пакетов15 %');
  await expect(tip).toContainText('ndm · система Keenetic1 %');
});

test('phone draws half as many columns', async ({ page }) => {
  const view = await openDashboard(page, { width: 390 });
  await expect(view.locator('.xkc-canvas')).toBeVisible();
  expect((await chartInfo(view)).columns).toBe(30);
  await view.locator('.xkc-b[data-range="24h"]').click();
  expect((await chartInfo(view)).columns).toBe(48);
  const scroll = await page.evaluate(() => {
    const body = document.querySelector('#xk-resource-dashboard-modal .modal-body');
    return { body: body.scrollWidth - body.clientWidth, doc: document.documentElement.scrollWidth - innerWidth };
  });
  expect(scroll.body).toBeLessThanOrEqual(1);
  expect(scroll.doc).toBeLessThanOrEqual(1);
});

// ---- tool tabs (devices, connection check, interfaces, processes, modems, events) -------------
// Every tab loads on its first show; "ping" runs only on its button.

const nowS = () => Math.floor(Date.now() / 1000);

const device = (i) => ({
  name: `Устройство ${i}`, mac: `AA:BB:CC:00:${String(Math.floor(i / 256)).padStart(2, '0')}:${(i % 256).toString(16).padStart(2, '0')}`,
  ip: `192.168.${Math.floor(i / 250)}.${(i % 250) + 1}`, interface: i % 3 ? 'WifiMaster1/AccessPoint0' : 'GigabitEthernet0/Vlan1',
  rssi: i % 3 ? -50 - (i % 30) : null, rx_rate: 866e6, tx_rate: 433e6, received_bytes: 1, sent_bytes: 1, traffic_bytes: (100000 - i) * 1e6, online: true,
});

function clientsFixture(count) {
  const items = Array.from({ length: count }, (_, i) => device(i + 1));
  return { available: true, sampled_at: TS, count, items, top: items.slice(0, 5), wifi: [], truncated: false };
}

const hop = (number, address, latency) => ({ number, responded: address != null, address: address || '', latency_ms: latency });

const channelFixture = () => ({
  available: true, target: '1.1.1.1', sampled_at: TS, sent: 10, received: 10, loss_percent: 0, latency_ms: 18, jitter_ms: 2.1, state: 'good',
  trace: '1  192.168.1.1  0.4 ms\n2  10.0.0.1  3 ms', trace_state: 'partial', trace_summary: 'Маршрут получен частично', trace_note: 'Ответили 5 из 6 узлов.',
  trace_hops: [hop(1, '192.168.1.1', 0.4), hop(2, '10.0.0.1', 3), hop(3, null, null), hop(4, '185.1.2.3', 9), hop(5, '172.70.4.1', 41), hop(6, '1.1.1.1', 18)],
});

const IMEI = '356938035643809';

const carrier = (band, bandwidth, earfcn, pci) => ({ technology: 'LTE', band, bandwidth, earfcn, phy_cell_id: pci, downlink_frequency: null, uplink_frequency: null });

const modemMegafon = () => ({
  id: 'UsbQmi0', name: 'MegaFon', operator: 'MegaFon', technology: 'LTE-A', model: 'Quectel EG18-EA', connection_state: 'connected', connected: true, default_route: true,
  address: '10.120.4.17', uptime: 11520, band: '3', bandwidth: 20, rsrp: -88, rsrq: -9, cinr: 17, rssi: -61, imei: IMEI, sim: 'готова', apn: 'internet', roaming: false,
  base_station: '', enb_id: '123456', sector_id: '2', tac: '7710', distance: 1200, firmware: 'EG18EAPAR03A08M4G',
  carriers: [carrier('3', 20, 1602, '241'), carrier('7', 20, 3048, '241'), carrier('20', 10, 6300, '118')],
});

const lteFixture = (items = [modemMegafon()]) => ({ available: items.length > 0, sampled_at: TS, count: items.length, items });

const processesFixture = () => ({
  available: true, sampled_at: TS, count: 3, items: [
    { pid: 2214, name: 'xray', service: '', state: 'S', cpu_percent: 9.2, memory_bytes: 84 * MB, threads: 12 },
    { pid: 412, name: 'ndm', service: '', state: 'S', cpu_percent: 3.1, memory_bytes: 41 * MB, threads: 9 },
    { pid: 3381, name: 'python3', service: '', state: 'S', cpu_percent: 1.4, memory_bytes: 120 * MB, threads: 6 },
  ],
});

const ifaceItem = (name, kind, online, extra = {}) => ({
  name, description: '', kind, online, state: online ? 'up' : 'down', address: '', default_gateway: false, received_bytes: 9.1 * 1024 ** 3, sent_bytes: 1.2 * 1024 ** 3,
  receive_bits_per_second: 5.6e6, send_bits_per_second: 0.8e6, receive_errors: 0, send_errors: 0, receive_dropped: 0, send_dropped: 0, ...extra,
});

function eventsFixture() {
  const now = nowS();
  return {
    ok: true,
    events: [
      { id: 'cpu_overload-1', type: 'cpu_overload', at: now - 3000, until: now - 2760, severity: 'problem', title: 'Процессор перегружен', detail: 'Пик 88 %', key: 'cpu' },
      { id: 'internet_lost-1', type: 'internet_lost', at: now - 1200, until: null, severity: 'problem', title: 'Связь с интернетом потеряна', detail: 'Шлюз провайдера не отвечал', key: '' },
      { id: 'dns_failed-1', type: 'dns_failed', at: now - 900, until: now - 400, severity: 'problem', title: 'Не отвечает DNS', detail: '', key: '' },
      { id: 'internet_restored-1', type: 'internet_restored', at: now - 5000, until: now - 5000, severity: 'info', title: 'Связь с интернетом восстановлена', detail: '', key: '' },
      { id: 'port_slow-1', type: 'port_slow', at: now - 7200, until: now - 3600, severity: 'warning', title: 'Порт 2 работает на 100 Мбит/с', detail: '', key: '2' },
    ],
    active: [],
  };
}

const problemItem = (type, title) => ({ id: `${type}-1`, type, at: nowS() - 600, until: null, severity: 'problem', title, detail: '', key: '' });

// the summary of a router with a mobile modem connection; `extra` adds ordinary interfaces
function withModems(over = {}) {
  const base = summary();
  return summary({
    links: [LINK_ISP, LINK_LTE],
    router: { ...base.router, interfaces: { available: true, count: 3, items: [ifaceItem('GigabitEthernet1', 'wan', true, { description: 'Интернет (WAN)', address: '192.0.2.1' }), ifaceItem('UsbQmi0', 'wan', true), ifaceItem('Bridge0', 'lan', true, { address: '192.168.1.1' })] } },
    ...over,
  });
}

const toolRequests = () => api.tools.map(url => new URL(url, 'http://x').pathname);
const tab = (view, id) => view.locator(`[data-tab="${id}"]`);
const pane = (view, id) => view.locator(`.xkt-panel[data-panel="${id}"]`);

test('tabs load lazily', async ({ page }) => {
  const view = await openDashboard(page, { sum: withModems(), tools: { clients: clientsFixture(8), lte: lteFixture(), processes: processesFixture(), events: eventsFixture(), channel: channelFixture() } });
  await expect(tab(view, 'modems')).toBeVisible();
  await page.waitForTimeout(400);
  // the window is open and its own data is loaded, no tool was asked for anything
  expect(toolRequests()).toEqual([]);
  await expect(view.locator('.xkt-tab[aria-selected="true"]')).toHaveCount(0);
  await tab(view, 'devices').click();
  await expect(view.locator('.xkt-row')).toHaveCount(5);
  expect(toolRequests()).toEqual(['/api/system/router/clients']);
  // the connection check starts only on its button, not by showing the tab
  await tab(view, 'ping').click();
  await expect(view.locator('[data-act="run"]')).toBeVisible();
  await page.waitForTimeout(200);
  expect(toolRequests()).toEqual(['/api/system/router/clients']);
  await view.locator('[data-act="run"]').click();
  await expect(view.locator('[data-tile="verdict"]')).toBeVisible();
  expect(toolRequests()).toEqual(['/api/system/router/clients', '/api/system/router/channel-check']);
  expect(api.tools[1]).toContain('target=1.1.1.1');
  await tab(view, 'procs').click();
  await expect(view.locator('.xkt-pr-cols.xkt-row')).toHaveCount(3);
  await tab(view, 'modems').click();
  await expect(view.locator('.xkt-modem')).toHaveCount(1);
  await tab(view, 'events').click();
  await expect(view.locator('.xkt-ev')).toHaveCount(5);
  // the interfaces list is a part of the summary: no request of its own
  await tab(view, 'ifaces').click();
  await expect(view.locator('[data-iface="GigabitEthernet1"]')).toBeVisible();
  expect(toolRequests()).toEqual(['/api/system/router/clients', '/api/system/router/channel-check', '/api/system/processes', '/api/system/router/lte', '/api/system/events']);
  // a shown tab is not loaded again by showing it again
  await tab(view, 'devices').click();
  await tab(view, 'procs').click();
  expect(toolRequests()).toHaveLength(5);
});

test('closing the window forgets the tools: a reopened window is lazy again', async ({ page }) => {
  const view = await openDashboard(page, { sum: withModems(), tools: { clients: clientsFixture(8) } });
  await tab(view, 'devices').click();
  await expect(view.locator('.xkt-row')).toHaveCount(5);
  await page.locator('#xk-resource-dashboard-close').click();
  await expect(page.locator('#xk-resource-dashboard-modal')).toBeHidden();
  const before = api.tools.length;
  await page.locator('#xk-resource-monitor').evaluate(button => button.click());
  await expect(view.locator('.xkm-card').first()).toBeVisible();
  await expect(view.locator('.xkt-tab[aria-selected="true"]')).toHaveCount(0);
  await page.waitForTimeout(300);
  expect(api.tools.length).toBe(before);
});

test('devices: link speed of a cable host is its port speed, the radio band names a Wi-Fi host', async ({ page }) => {
  const clients = clientsFixture(3);
  clients.items[0] = { ...clients.items[0], interface: 'WifiMaster1/AccessPoint1', rx_rate: 867e6, tx_rate: null, port: '', port_speed: null };
  clients.items[1] = { ...clients.items[1], interface: 'Bridge0', rssi: null, rx_rate: null, tx_rate: null, port: '4', port_speed: 100e6 };
  clients.items[2] = { ...clients.items[2], interface: 'Bridge0', rssi: null, rx_rate: null, tx_rate: null, port: '2', port_speed: 1000e6 };
  clients.top = clients.items.slice();
  const view = await openDashboard(page, { tools: { clients } });
  await tab(view, 'devices').click();
  const rows = view.locator('.xkt-row');
  await expect(rows.nth(0)).toContainText('5 ГГц');
  await expect(rows.nth(0)).toContainText('867 Мбит/с');
  await expect(rows.nth(1)).toContainText('порт 4');
  await expect(rows.nth(1)).toContainText('100 Мбит/с');
  await expect(rows.nth(1)).not.toContainText('Bridge0');
  await expect(rows.nth(2)).toContainText('1 Гбит/с');
  await expect(rows.nth(2)).not.toContainText('1,0');
});

test('devices: five most active, all of them on demand', async ({ page }) => {
  const view = await openDashboard(page, { tools: { clients: clientsFixture(14) } });
  await tab(view, 'devices').click();
  await expect(view.locator('.xkt-row')).toHaveCount(5);
  await expect(pane(view, 'devices').locator('.xkt-lead')).toContainText('Сейчас в сети 14 устройств');
  await expect(pane(view, 'devices').locator('.xkt-lead')).toContainText('показаны 5 самых активных');
  await expect(view.locator('.xkt-row').first()).toContainText('Устройство 1');
  await expect(view.locator('.xkt-row').first()).toContainText('Wi‑Fi');
  await view.locator('[data-act="all"]').click();
  await expect(view.locator('.xkt-row')).toHaveCount(14);
  expect(await view.locator('.xkv').count()).toBe(0);
});

test('500 devices virtualized', async ({ page }) => {
  const view = await openDashboard(page, { tools: { clients: clientsFixture(500) } });
  await tab(view, 'devices').click();
  await expect(view.locator('.xkt-row')).toHaveCount(5);
  await view.locator('[data-act="all"]').click();
  await expect(view.locator('.xkv')).toBeVisible();
  const drawn = await view.locator('.xkv-row').count();
  expect(drawn).toBeGreaterThan(0);
  expect(drawn).toBeLessThanOrEqual(60);
  await view.locator('.xkv').evaluate(box => { box.scrollTop = box.scrollHeight; });
  await expect(view.locator('.xkv-row', { hasText: 'Устройство 500' })).toBeVisible();
  expect(await view.locator('.xkv-row').count()).toBeLessThanOrEqual(60);
  // the list keeps its place in the middle, too
  await view.locator('.xkv').evaluate(box => { box.scrollTop = 250 * 52; });
  await expect(view.locator('.xkv-row', { hasText: 'Устройство 251' })).toBeAttached();
  expect(await view.locator('.xkv-row').count()).toBeLessThanOrEqual(60);
});

test('modems render carriers', async ({ page }) => {
  const view = await openDashboard(page, { sum: withModems(), tools: { lte: lteFixture() } });
  await tab(view, 'modems').click();
  const card = view.locator('.xkt-modem[data-modem-id="UsbQmi0"]');
  await expect(card).toBeVisible();
  await expect(card.locator('.xkt-carrier')).toHaveCount(3);
  await expect(card.locator('.xkt-agg')).toHaveText('агрегация 3 частоты · 50 МГц');
  await expect(card.locator('.xkt-carrier').nth(0)).toContainText('Основная');
  await expect(card.locator('.xkt-carrier').nth(0)).toContainText('B3 · 1800 МГц');
  await expect(card.locator('.xkt-carrier').nth(0)).toContainText('EARFCN 1602 · PCI 241');
  await expect(card.locator('.xkt-carrier').nth(2)).toContainText('Доп. 2');
  // four signal gauges with a verbal rating
  await expect(card.locator('.xkt-sig-tile')).toHaveCount(4);
  await expect(card.locator('[data-signal="rsrp"]')).toContainText('−88 дБм');
  await expect(card.locator('[data-signal="rsrp"]')).toContainText('отличный');
  await expect(card.locator('[data-signal="cinr"]')).toContainText('хорошо');
  // the details in four columns
  const cells = card.locator('.xkt-info-c');
  await expect(cells).toHaveCount(8);
  const tops = [];
  for (let i = 0; i < 8; i += 1) tops.push(Math.round((await rect(cells.nth(i))).top));
  expect(new Set(tops.slice(0, 4)).size).toBe(1);
  expect(new Set(tops.slice(4)).size).toBe(1);
  expect(tops[4]).toBeGreaterThan(tops[0]);
  await expect(cells.nth(0)).toContainText('eNB 123456, сектор 2');
  await expect(cells.nth(2)).toContainText('≈ 1,2 км');
  await expect(card).toContainText('основной канал');
  await expect(card).toContainText('в сети 3 ч 12 мин');
  // the IMEI is masked everywhere in the page
  await expect(card.locator('.xkt-info-c', { hasText: 'IMEI' })).toContainText('•••• •••• 3809');
  const html = await view.evaluate(host => host.shadowRoot.innerHTML);
  expect(html).not.toContain(IMEI);
  expect(html).not.toContain('356938035');
  // no restart button
  await expect(view.getByRole('button', { name: /Перезапустить/ })).toHaveCount(0);
  await expect(view.locator('.xkt-note')).toContainText('Перезапуск из панели отключён');
});

test('aggregation label uses the Russian plural', () => {
  expect([1, 2, 5, 11, 21, 22, 14, 25].map(frequenciesWord)).toEqual(['частота', 'частоты', 'частот', 'частот', 'частота', 'частоты', 'частот', 'частот']);
  const carriers = (n) => Array.from({ length: n }, () => ({ bandwidth: 20 }));
  expect(aggregationLabel(carriers(2))).toBe('агрегация 2 частоты · 40 МГц');
  expect(aggregationLabel(carriers(5))).toBe('агрегация 5 частот · 100 МГц');
  expect(aggregationLabel(carriers(1))).toBe('');
});

test('modem detection mirrors the backend tokens', () => {
  const withItems = (items, links = []) => ({ router: { interfaces: { available: true, items } }, links });
  expect(hasModems(withItems([{ name: 'UsbModem0', kind: 'wan' }]))).toBe(true);
  expect(hasModems(withItems([{ name: 'Wwan1', description: 'Mobile broadband' }]))).toBe(true);
  expect(hasModems(withItems([{ name: 'UsbNet0', kind: 'lan' }, { name: 'Bridge0' }]))).toBe(false);
  expect(hasModems(withItems([{ name: 'Bridge0' }], [{ id: 'UsbLte0' }]))).toBe(true);
  expect(hasModems({ router: null })).toBe(true);
  expect(hasModems({ router: { interfaces: { available: false, items: [] } } })).toBe(true);
});

test('modems tab is shown without interface data and the first load decides', async ({ page }) => {
  const view = await openDashboard(page, { tools: { lte: { available: false, count: 0, items: [] } } });
  await expect(tab(view, 'modems')).toBeVisible();
  await page.waitForTimeout(300);
  expect(toolRequests()).toEqual([]);
  await tab(view, 'modems').click();
  await expect(pane(view, 'modems')).toContainText('LTE-модемы не обнаружены');
  expect(toolRequests()).toEqual(['/api/system/router/lte']);
  // the next summary hides the tab that has no modems behind it
  await expect(tab(view, 'modems')).toBeHidden({ timeout: 10000 });
});

test('a modem named in an unusual way shows the tab', async ({ page }) => {
  const base = summary();
  const sum = summary({ router: { ...base.router, interfaces: { available: true, count: 2, items: [ifaceItem('UsbModem0', 'wan', true), ifaceItem('Bridge0', 'lan', true)] } } });
  const view = await openDashboard(page, { sum });
  await expect(tab(view, 'modems')).toBeVisible();
  expect(toolRequests()).toEqual([]);
});

test('modems tab hidden without modems', async ({ page }) => {
  const base = summary();
  const sum = summary({ router: { ...base.router, interfaces: { available: true, count: 2, items: [ifaceItem('GigabitEthernet1', 'wan', true), ifaceItem('UsbNet0', 'lan', true)] } } });
  const view = await openDashboard(page, { sum, tools: { lte: lteFixture() } });
  await expect(tab(view, 'devices')).toBeVisible();
  await expect(tab(view, 'modems')).toBeHidden();
  expect(toolRequests()).toEqual([]);
});

test('ping layout full width', async ({ page }) => {
  for (const width of [1600, 1024, 390]) {
    const view = await openDashboard(page, { width, tools: { channel: channelFixture() } });
    await tab(view, 'ping').click();
    await view.locator('[data-act="run"]').click();
    await expect(view.locator('[data-tile="verdict"]')).toBeVisible();
    await view.locator('[data-tile="verdict"]').scrollIntoViewIfNeeded();
    const area = await rect(view.locator('.xkt-panel[data-panel="ping"]'));
    const tiles = view.locator('.xkt-tiles > .xkt-tile');
    await expect(tiles).toHaveCount(4);
    if (width >= 1100) {
      const verdict = await rect(view.locator('[data-tile="verdict"]'));
      expect(Math.abs(area.right - 14 - verdict.right)).toBeLessThanOrEqual(1);
      const widths = [];
      const tops = [];
      for (let i = 0; i < 4; i += 1) { const r = await rect(tiles.nth(i)); widths.push(r.width); tops.push(Math.round(r.top)); }
      for (const w of widths) expect(Math.abs(w - widths[0])).toBeLessThanOrEqual(1);
      expect(new Set(tops).size).toBe(1);
      // the route spans the area: first node near the left edge, last near the right edge
      const hops = view.locator('.xkt-hop');
      await expect(hops).toHaveCount(6);
      const first = await rect(hops.first());
      const last = await rect(hops.last());
      expect(Math.abs(first.left - (area.left + 14))).toBeLessThanOrEqual(1);
      expect(Math.abs(area.right - 14 - last.right)).toBeLessThanOrEqual(1);
    } else {
      const verdict = await rect(view.locator('[data-tile="verdict"]'));
      expect(verdict.right).toBeLessThanOrEqual(area.right - 14 + 1);
    }
    await expect(view.locator('.xkt-route-h')).toContainText('Маршрут до 1.1.1.1 · 6 узлов');
    await expect(view.locator('.xkt-route-h')).toContainText('самый медленный участок — между узлами 4 и 5 (+32 мс)');
    await expect(view.locator('.xkt-hop.silent')).toContainText('не отвечает');
    await expect(view.locator('.xkt-hop.silent')).toContainText('это нормально');
    await expect(view.locator('[data-tile="verdict"]')).toContainText('Связь хорошая');
    const scroll = await page.evaluate(() => {
      const body = document.querySelector('#xk-resource-dashboard-modal .modal-body');
      return { body: body.scrollWidth - body.clientWidth, doc: document.documentElement.scrollWidth - innerWidth };
    });
    expect(scroll.body).toBeLessThanOrEqual(1);
    expect(scroll.doc).toBeLessThanOrEqual(1);
  }
});

test('ping: a failed check shows a message and the button works again', async ({ page }) => {
  const view = await openDashboard(page, { tools: { channel: null } });
  await tab(view, 'ping').click();
  await view.locator('.xkt-quick', { hasText: '8.8.8.8' }).click();
  await expect(view.locator('[data-role="target"]')).toHaveValue('8.8.8.8');
  await view.locator('[data-act="run"]').click();
  await expect(view.locator('[data-role="status"]')).toContainText('Проверка канала не выполнена');
  await expect(view.locator('[data-act="run"]')).toBeEnabled();
  expect(api.tools[0]).toContain('target=8.8.8.8');
});

test('events filter and counter', async ({ page }) => {
  const sum = summary({ status: { tone: 'problem', problems: [problemItem('internet_lost', 'Связь с интернетом потеряна'), problemItem('cpu_overload', 'Процессор перегружен')] } });
  const view = await openDashboard(page, { sum, tools: { events: eventsFixture() } });
  // the counter is the number of active problems, known from the summary: no request for it
  await expect(tab(view, 'events').locator('.xkt-count')).toHaveText('2');
  expect(toolRequests()).toEqual([]);
  await tab(view, 'events').click();
  await expect(view.locator('.xkt-ev')).toHaveCount(5);
  expect(api.tools[0]).toMatch(/\/api\/system\/events\?since=\d+/);
  await expect(view.locator('.xkt-ev').first()).toContainText('Не отвечает DNS');
  await expect(view.locator('.xkt-ev[data-type="cpu_overload"]')).toContainText('длилось 4 мин');
  await expect(view.locator('.xkt-ev[data-type="internet_lost"]')).toContainText('идёт 20 мин');
  await expect(view.locator('.xkt-ev[data-type="internet_restored"] .xkt-ev-l')).toHaveText('');
  await pane(view, 'events').locator('[data-filter="problems"]').click();
  await expect(view.locator('.xkt-ev')).toHaveCount(3);
  await expect(view.locator('.xkt-ev[data-severity="info"]')).toHaveCount(0);
  await expect(view.locator('.xkt-ev[data-severity="warning"]')).toHaveCount(0);
  await expect(pane(view, 'events').locator('[data-filter="problems"]')).toHaveAttribute('aria-pressed', 'true');
  await pane(view, 'events').locator('[data-filter="all"]').click();
  await expect(view.locator('.xkt-ev')).toHaveCount(5);
});

test('events counter is hidden without active problems', async ({ page }) => {
  const view = await openDashboard(page);
  await expect(tab(view, 'events').locator('.xkt-count')).toBeHidden();
});

test('events: the DNS link of the connection chain opens the journal with DNS failures only', async ({ page }) => {
  const base = summary();
  const sum = summary({ router: { ...base.router, internet: { ...base.router.internet, dns: false } } });
  const view = await openDashboard(page, { sum, tools: { events: eventsFixture() } });
  await view.locator('[data-node="dns"]').click();
  await view.locator('[data-link="dns-log"]').click();
  await expect(tab(view, 'events')).toHaveAttribute('aria-selected', 'true');
  await expect(view.locator('.xkt-ev')).toHaveCount(1);
  await expect(view.locator('.xkt-ev')).toContainText('Не отвечает DNS');
  await expect(view.locator('.xkt-chip')).toContainText('Только сбои DNS');
  await view.locator('[data-act="clear-only"]').click();
  await expect(view.locator('.xkt-ev')).toHaveCount(5);
});

test('interfaces: human names, filter, errors', async ({ page }) => {
  const base = summary();
  const items = [
    ifaceItem('GigabitEthernet1', 'wan', true, { description: 'Интернет (WAN)', address: '192.0.2.1' }),
    ifaceItem('Bridge0', 'lan', true, { address: '192.168.1.1', receive_dropped: 12 }),
    ifaceItem('WifiMaster0/AccessPoint1', 'wifi', false),
  ];
  const sum = summary({ router: { ...base.router, interfaces: { available: true, count: 3, items } } });
  const view = await openDashboard(page, { sum });
  await tab(view, 'ifaces').click();
  await expect(pane(view, 'ifaces').locator('.xkt-row')).toHaveCount(2);
  await expect(pane(view, 'ifaces').locator('.xkt-lead')).toContainText('Показаны активные · 2 из 3');
  await expect(view.locator('[data-iface="GigabitEthernet1"]')).toContainText('Интернет (WAN)');
  await expect(view.locator('[data-iface="GigabitEthernet1"]')).toContainText('5,6 / 0,8 Мбит/с');
  await expect(view.locator('[data-iface="GigabitEthernet1"]')).toContainText('9,1 / 1,2 ГБ');
  await expect(view.locator('[data-iface="Bridge0"]')).toContainText('Домашняя сеть');
  await expect(view.locator('[data-iface="Bridge0"]')).toContainText('12 потерь');
  await pane(view, 'ifaces').locator('[data-filter="all"]').click();
  await expect(view.locator('.xkt-row')).toHaveCount(3);
  await expect(view.locator('[data-iface="WifiMaster0/AccessPoint1"]')).toContainText('отключён');
});

test('processes: notes, bars, sorting', async ({ page }) => {
  const view = await openDashboard(page, { tools: { processes: processesFixture() } });
  await tab(view, 'procs').click();
  await expect(view.locator('.xkt-row')).toHaveCount(3);
  await expect(view.locator('.xkt-row').first()).toContainText('xray');
  await expect(view.locator('.xkt-row').first()).toContainText('ядро прокси Xray');
  await expect(view.locator('.xkt-row').first()).toContainText('9,2 %');
  // the bar starts under its header, not in the middle of a wide column
  const head = await rect(pane(view, 'procs').locator('.xkt-head > div').nth(1));
  const meter = await rect(view.locator('.xkt-row').first().locator('.xkt-meter'));
  expect(Math.abs(meter.left - head.left)).toBeLessThanOrEqual(1);
  await view.locator('[data-sort="memory"]').click();
  await expect(view.locator('.xkt-row').first()).toContainText('python3');
  await expect(pane(view, 'procs').locator('.xkt-lead')).toContainText('по нагрузке на память');
});

test('server strings in the tabs are escaped', async ({ page }) => {
  const hostile = '<img src=x onerror="window.__xss=1">';
  const clients = clientsFixture(3);
  clients.items[0].name = hostile;
  clients.top = clients.items.slice(0, 5);
  const lte = lteFixture([{ ...modemMegafon(), operator: hostile, apn: hostile }]);
  const events = eventsFixture();
  events.events[0].title = hostile;
  const view = await openDashboard(page, { sum: withModems(), tools: { clients, lte, events } });
  for (const id of ['devices', 'modems', 'events']) await tab(view, id).click();
  await expect(view.locator('.xkt-ev').first()).toBeVisible();
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  expect(await view.locator('img').count()).toBe(0);
  await expect(view.locator('.xkt-modem')).toContainText(hostile);
});

test('every tab fits the width at 1024 and 390 without a horizontal scroll', async ({ page }) => {
  for (const width of [1024, 390]) {
    const events = eventsFixture();
    const view = await openDashboard(page, { width, sum: withModems(), tools: { clients: clientsFixture(60), lte: lteFixture([modemMegafon(), { ...modemMegafon(), id: 'UsbQmi1', default_route: false, carriers: [carrier('7', 15, 3300, '77')] }]), processes: processesFixture(), events, channel: channelFixture() } });
    for (const id of ['devices', 'ping', 'ifaces', 'procs', 'modems', 'events']) {
      await tab(view, id).click();
      if (id === 'ping') await view.locator('[data-act="run"]').click();
      if (id === 'devices') await view.locator('.xkt-row').first().waitFor();
      if (id === 'modems') await expect(view.locator('.xkt-modem')).toHaveCount(2);
      if (id === 'events') await expect(view.locator('.xkt-ev').first()).toBeVisible();
      const area = await rect(view.locator('.xkt-root'));
      const overflow = await view.locator(`.xkt-panel[data-panel="${id}"]`).evaluate(panel => {
        const box = panel.getBoundingClientRect();
        let worst = 0;
        for (const el of panel.querySelectorAll('*')) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.right > box.right + 1) worst = Math.max(worst, r.right - box.right);
        }
        return worst;
      });
      expect(overflow, `${id} at ${width}`).toBeLessThanOrEqual(1);
      expect(area.right).toBeLessThanOrEqual(width);
      const scroll = await page.evaluate(() => {
        const body = document.querySelector('#xk-resource-dashboard-modal .modal-body');
        return { body: body.scrollWidth - body.clientWidth, doc: document.documentElement.scrollWidth - innerWidth };
      });
      expect(scroll.body, `${id} at ${width}`).toBeLessThanOrEqual(1);
      expect(scroll.doc, `${id} at ${width}`).toBeLessThanOrEqual(1);
    }
  }
});

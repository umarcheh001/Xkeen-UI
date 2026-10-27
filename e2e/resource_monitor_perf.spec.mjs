import { test, expect } from './fixtures.mjs';

// Speed of the router diagnostics window with the processor slowed down four times
// (CDP Emulation.setCPUThrottlingRate). Tagged @perf: a normal run skips these tests,
// run them by name:  npx playwright test e2e/resource_monitor_perf.spec.mjs --workers=1
//
// Method. The page clock is faked (so are performance.now and requestAnimationFrame), so the
// real clock is captured before it is installed (window.__realNow) and the frame requests of the
// browser are used as they are (window.__nativeRaf). With the processor slowed down, wall time
// measured this way is the time a slow router-side browser would need.
//   - A tick = clock.fastForward(5000): every pending timer fires once, the window asks for
//     /api/system/summary, draws the answer and the frame that shows it is produced. Its cost is
//     measured from the moment the answer is parsed (the window's handlers run right after, as
//     microtasks) to the end of the frame: scripts + forced style/layout ("work"), plus the time
//     from the start of the frame (requestAnimationFrame) to the task after it ("paint"). The wait
//     for the next vsync is not counted.
//   - Floor = the same "frame" for a repaint of one changed text. Any change on this page costs
//     about this much (software rendering, slowed processor), so the window's redraw is judged by
//     what it adds over it.
//   - First picture = from the click on the header monitor to the frame after the chart canvas of
//     the window is drawn.
//   - Hidden tab = no requestAnimationFrame call and no request in five (page-clock) minutes.

const BUDGET_TICK_MS = 8;
const BUDGET_FIRST_FRAME_MS = 150;
// Measured on the development machine (headless, software rendering): 250-330 ms for the first
// picture, most of it the first layout of the window. The test fails when it gets clearly worse.
const LIMIT_FIRST_FRAME_MS = 450;
const THROTTLE = 4;

const TS = 1792602000;
const RANGE_STEP = { '15m': 15, '30m': 30, '1h': 60, '6h': 300, '24h': 900, '7d': 1800 };
const RANGE_COLS = { '15m': 60, '30m': 60, '1h': 60, '6h': 72, '24h': 96, '7d': 336 };
const LINKS = [
  { id: 'ISP', label: 'МТС', kernel: 'eth3', primary: true, priority: 700, connected: true, tariff: { up_mbps: 50, down_mbps: 100 } },
  { id: 'UsbQmi0', label: 'Билайн', kernel: 'wwan0', primary: false, priority: 500, connected: true, tariff: null },
];

const zoneOf = (value, orange, red) => (value == null ? null : value >= red ? 2 : value >= orange ? 1 : 0);

function column(values, orange, red) {
  const max = values.map(v => (v == null ? null : Math.round(v * 115) / 100));
  return { avg: values, max, zone: values.map(v => zoneOf(v, orange, red)), peak_zone: max.map(v => zoneOf(v, orange, red)) };
}

const plain = values => ({ avg: values, max: values.slice() });

// 14 metrics, the way a router with a tariff link and a modem answers.
function history(range) {
  const step = RANGE_STEP[range];
  const count = RANGE_COLS[range];
  const start = Math.floor(TS / step) * step - (count - 1) * step;
  const series = fn => Array.from({ length: count }, (_, i) => fn(i));
  const metrics = {
    cpu: column(series(i => 20 + (i % 7) * 9), 60, 85),
    memory: column(series(() => 47), 75, 90),
    queue: column(series(i => 0.4 + (i % 5) * 0.2), 2.1, 3),
    online: { ...plain(series(i => (i === 5 ? 0.6 : 1))), zone: series(i => (i === 5 ? 2 : 0)), peak_zone: series(() => 0) },
    'temp:cpu': column(series(() => 54), 80, 95),
    'temp:wifi5': column(series(() => 53), 85, 100),
    'link_up:ISP': column(series(i => 8 + (i % 4)), 70, 90),
    'link_down:ISP': column(series(i => 54 + (i % 3)), 70, 90),
    'rate_up:ISP': plain(series(i => 4 + (i % 4))),
    'rate_down:ISP': plain(series(i => 53.7 + (i % 3))),
    'link_up:UsbQmi0': plain(series(() => null)),
    'link_down:UsbQmi0': plain(series(() => null)),
    'rate_up:UsbQmi0': plain(series(i => 1 + (i % 3))),
    'rate_down:UsbQmi0': plain(series(i => 9 + (i % 5))),
  };
  return {
    ok: true, range, step_s: step, start, history_since: start, cores: 3,
    bands: { cpu: { orange: 60, red: 85 }, memory: { orange: 75, red: 90 }, link: { orange: 70, red: 90 }, queue: { orange: 2.1, red: 3, scale_max: 6 } },
    metrics, links: LINKS,
  };
}

function bars(values, orange, red) {
  return { values, zones: values.map(v => zoneOf(v, orange, red)) };
}

const wave = (base, swing, offset = 0) => Array.from({ length: 40 }, (_, i) => Math.round(base + swing * Math.abs(Math.sin((i + offset) / 5))));

// `tick` changes the load a little so every answer really repaints something.
function summary(tick = 0) {
  const cpu = 20 + (tick % 40);
  return {
    ok: true, ts: TS,
    status: { tone: 'ok', problems: [] },
    identity: { model: 'Netcraze Ultra (NC-1812)', firmware: 'KeeneticOS 5.1.8' },
    uptime_s: 454000,
    values: { cpu, memory: 47, queue: 0.4, online: 1, 'link_up:ISP': 2, 'link_down:ISP': 6, 'rate_up:ISP': 1.1, 'rate_down:ISP': 5.8 },
    zones: { cpu: zoneOf(cpu, 60, 85), memory: 0, queue: 0, 'link_up:ISP': 0, 'link_down:ISP': 0 },
    links: [LINKS[0]],
    cards: {
      cpu: { value: cpu, zone: zoneOf(cpu, 60, 85), cores: 3, queue: 0.4, queue_zone: 0, text: '3 ядра · очередь задач небольшая', bars: bars(wave(15, 50), 60, 85) },
      memory: { value: 47, zone: 0, text: 'программы 456 МБ · кэш 245 МБ · свободно 290 МБ', programs_bytes: 478150656, cache_bytes: 256901120, free_bytes: 304087040, total_bytes: 1039138816, bars: bars(wave(45, 6, 3), 75, 90) },
      internet: { state: 'online', label: 'В сети', zone: 0, text: 'Через WAN (GigabitEthernet1)', bars: { values: Array.from({ length: 40 }, () => 1), zones: Array.from({ length: 40 }, () => 0) } },
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
}

const MB = 1048576;
function hardware() {
  return {
    ok: true,
    identity: { model: 'Netcraze Ultra (NC-1812)', firmware: 'KeeneticOS 5.1.8' },
    cores: 3,
    temperatures: [{ id: 'cpu', label: 'Процессор', kind: 'chip', value_c: 54, sensors: [{ name: 'cpu_thermal0', value_c: 54 }], shutdown_c: 125, zone: 0, usual_c: null, hotter_by: null, bands: { orange_c: 80, red_c: 95 } }],
    throttle: null,
    memory: { total_bytes: 991 * MB, programs_bytes: 456 * MB, cache_bytes: 245 * MB, free_bytes: 290 * MB, percent: 46 },
    zram: { size_bytes: 1024 * MB, used_bytes: 0, pressure: false },
    storage: { total_bytes: 8 * 1024 * MB, used_bytes: 1536 * MB, free_bytes: 6656 * MB, percent: 18.8, path: '/opt', zone: 0 },
    conntrack: { available: true, count: 1048, max: 32768, percent: 3.2, available_entries: 31720, zone: 0 },
    ports: [{ id: 'WAN', label: 'WAN', is_wan: true, link: true, speed_mbps: 1000, duplex: 'full', description: '' }],
    slow_ports: [],
  };
}

const api = { summary: 0, requests: [] };

async function prepare(page, { width }) {
  api.summary = 0;
  api.requests = [];
  // the real clock, before the page clock replaces performance.now; and a counter of frame requests
  await page.addInitScript(() => {
    window.__realNow = performance.now.bind(performance);
    window.__nativeRaf = window.requestAnimationFrame.bind(window);
    // a macrotask that the page clock does not fake
    window.__soon = (callback) => { const c = new MessageChannel(); c.port1.onmessage = () => { c.port1.close(); callback(); }; c.port2.postMessage(0); };
    // The cost of one redraw of the window: from the moment the answer of /api/system/summary is
    // parsed (the window's handlers run right after, as microtasks) to the end of the frame that
    // shows it. `work` = scripts + the forced style/layout, `paint` = from the start of the frame
    // (requestAnimationFrame) to the task after it; the wait for the next vsync is not counted.
    window.__frames = [];
    const parse = Response.prototype.json;
    Response.prototype.json = function json() {
      const promise = parse.call(this);
      if (!/\/api\/system\/summary/.test(this.url)) return promise;
      return promise.then((value) => {
        const started = window.__realNow();
        window.__soon(() => {
          const scripted = window.__realNow();
          void document.body.offsetHeight;
          const worked = window.__realNow();
          window.__nativeRaf(() => {
            const frameStart = window.__realNow();
            window.__soon(() => window.__frames.push({ script: scripted - started, layout: worked - scripted, work: worked - started, paint: window.__realNow() - frameStart }));
          });
        });
        return value;
      });
    };
  });
  await page.clock.install();
  await page.setViewportSize({ width, height: 1000 });
  const note = route => api.requests.push(new URL(route.request().url()).pathname);
  await page.route('**/api/system/resources', route => { note(route); route.fulfill({ json: { ok: true, sampled_at: TS, cpu: { percent: 19, cores: 3, load_1m: 0.4 }, memory: { percent: 47, total_bytes: 1024 ** 3, used_bytes: 5e8 }, router: {} } }); });
  await page.route('**/api/system/summary', route => { note(route); api.summary += 1; route.fulfill({ json: summary(api.summary) }); });
  await page.route('**/api/system/hardware', route => { note(route); route.fulfill({ json: hardware() }); });
  await page.route('**/api/system/history*', route => {
    note(route);
    route.fulfill({ json: history(new URL(route.request().url()).searchParams.get('range')) });
  });
  await page.route('**/api/system/events*', route => { note(route); route.fulfill({ json: { ok: true, events: [], active: [] } }); });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  await page.goto('/');
  await expect(page.locator('#xk-resource-monitor')).toHaveAttribute('data-state', 'ready');
  // count the frame requests of the page (after the clock replaced requestAnimationFrame)
  await page.evaluate(() => {
    window.__rafCalls = 0;
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) => { window.__rafCalls += 1; return raf(callback); };
  });
  return cdp;
}

const throttle = (cdp, rate) => cdp.send('Emulation.setCPUThrottlingRate', { rate });

// Opens the window and returns the time (ms, real clock, slowed processor) from the click
// to the first animation frame that shows a drawn chart.
async function openAndTime(page) {
  return page.evaluate(() => new Promise((resolve) => {
    const now = window.__realNow;
    const monitor = document.getElementById('xk-resource-monitor');
    const started = now();
    monitor.click();
    const look = () => {
      const host = document.getElementById('xk-resource-dashboard-view');
      const canvas = host?.shadowRoot?.querySelector('.xkc-canvas');
      if (canvas && canvas.xkChart) {
        // the frame that paints it
        window.__nativeRaf(() => resolve(now() - started));
        return;
      }
      window.__soon(look);
    };
    look();
  }));
}

// One tick of the open window: the page clock jumps 5 s (every pending timer fires once, as the
// next poll would), the window asks for the summary, draws the answer and produces the frame.
async function oneTick(page) {
  const before = await page.evaluate(() => window.__frames.length);
  await page.clock.fastForward(5000);
  await expect.poll(() => page.evaluate(() => window.__frames.length), { timeout: 15_000 }).toBeGreaterThan(before);
  await page.waitForTimeout(150);
  return page.evaluate((index) => window.__frames[index], before);
}

const report = (label, values) => {
  const sorted = values.slice().sort((a, b) => a - b);
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  console.log(`[perf] ${label}: n=${values.length} mean=${mean.toFixed(2)} ms median=${sorted[Math.floor(sorted.length / 2)].toFixed(2)} max=${sorted.at(-1).toFixed(2)}`);
};

for (const [name, width] of [['desktop 1440', 1440], ['phone 390', 390]]) {
  test(`@perf window opens with the first chart (target ${BUDGET_FIRST_FRAME_MS} ms, limit ${LIMIT_FIRST_FRAME_MS} ms) at CPU x${THROTTLE} (${name})`, async ({ page }) => {
    const cdp = await prepare(page, { width });
    await throttle(cdp, THROTTLE);
    const opened = await openAndTime(page);
    report(`first chart ${name}`, [opened]);
    expect(opened).toBeLessThanOrEqual(LIMIT_FIRST_FRAME_MS);
    // 7 days: 14 metrics, 336 columns, one row per day
    const view = page.locator('#xk-resource-dashboard-view');
    const week = await page.evaluate(() => new Promise((resolve) => {
      const now = window.__realNow;
      const button = document.getElementById('xk-resource-dashboard-view').shadowRoot.querySelector('[data-range="7d"]');
      const started = now();
      button.click();
      const look = () => {
        const canvas = document.getElementById('xk-resource-dashboard-view').shadowRoot.querySelector('.xkc-canvas');
        if (canvas?.dataset.kind === 'grid7') { window.__nativeRaf(() => resolve(now() - started)); return; }
        window.__soon(look);
      };
      look();
    }));
    report(`switch to 7 days ${name}`, [week]);
    expect(week).toBeLessThanOrEqual(BUDGET_FIRST_FRAME_MS);
    await expect(view.locator('.xkc-canvas')).toHaveAttribute('data-kind', 'grid7');
  });

  test(`@perf 20 ticks of 5 s: the redraw of the window costs at most ${BUDGET_TICK_MS} ms over the cheapest frame, at CPU x${THROTTLE} (${name})`, async ({ page }) => {
    const cdp = await prepare(page, { width });
    await page.evaluate(() => document.getElementById('xk-resource-monitor').click());
    await expect(page.locator('#xk-resource-dashboard-view').locator('.xkc-canvas')).toBeVisible();
    await page.waitForTimeout(500);
    await throttle(cdp, THROTTLE);
    await oneTick(page); // warm-up: first paint of the changed state, JIT
    // The floor of this machine: a frame that repaints one changed text (the "updated N s ago" line).
    const floor = [];
    for (let i = 0; i < 12; i += 1) {
      floor.push(await page.evaluate(() => new Promise((resolve) => {
        document.getElementById('xk-resource-dashboard-freshness').firstChild.data = `Обновлено ${Math.random()}`;
        window.__nativeRaf(() => {
          const frameStart = window.__realNow();
          window.__soon(() => resolve(window.__realNow() - frameStart));
        });
      })));
      await page.waitForTimeout(80);
    }
    const ticks = [];
    for (let i = 0; i < 20; i += 1) ticks.push(await oneTick(page));
    const total = ticks.map(t => t.work + t.paint);
    const median = values => values.slice().sort((x, y) => x - y)[Math.floor(values.length / 2)];
    const p90 = values => values.slice().sort((x, y) => x - y)[Math.ceil(values.length * 0.9) - 1];
    report(`floor ${name} (one changed text, paint only)`, floor);
    report(`tick ${name} (work: scripts, style, layout)`, ticks.map(t => t.work));
    report(`tick ${name} (scripts)`, ticks.map(t => t.script));
    report(`tick ${name} (style and layout)`, ticks.map(t => t.layout));
    report(`tick ${name} (paint)`, ticks.map(t => t.paint));
    report(`tick ${name} (frame = work + paint)`, total);
    // The redraw adds at most the budget to the frame that any single change already costs.
    expect(median(total) - median(floor)).toBeLessThanOrEqual(BUDGET_TICK_MS);
    // Never worse than one 60 Hz frame at the typical tick; stray ticks (a collection of garbage,
    // a timer of another part of the panel) get two.
    expect(median(total)).toBeLessThanOrEqual(16);
    expect(p90(total)).toBeLessThanOrEqual(32);
  });
}

test('@perf hidden tab: five minutes bring no frame request and no request to the router', async ({ page }) => {
  const cdp = await prepare(page, { width: 1440 });
  await page.evaluate(() => document.getElementById('xk-resource-monitor').click());
  await expect(page.locator('#xk-resource-dashboard-view').locator('.xkc-canvas')).toBeVisible();
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(200);
  const frames = await page.evaluate(() => window.__rafCalls);
  const requests = api.requests.length;
  await page.clock.runFor(5 * 60 * 1000);
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.__rafCalls)).toBe(frames);
  expect(api.requests.length).toBe(requests);
  await cdp.detach();
});

import { test, expect, selectPanelView } from './fixtures.mjs';

test('Xray log flags use the local sprite and an unknown flag becomes a globe',async({page})=>{
  const lines=['🇸🇴 Somalia','🇿🇿 Unknown'].map((name,i)=>`2026/11/13 21:00:0${i} from 192.168.1.34:53122 accepted tcp:example.test:443 [redirect-in -> ${name}]`);
  await openLogs(page,'dark',{width:1440,height:900},{accessLines:lines});
  const table=page.locator('#xray-log-output');
  await expect(table.locator('.tr .flag svg use')).toHaveAttribute('href',/#flag-SO$/);
  await expect(table.locator('.tr .xk-country-globe')).toBeVisible();
  await expect(table.locator('.tr').nth(1)).toContainText('Unknown');
  await expect(table.locator('.tr').nth(1)).not.toContainText('🇿🇿');
});

test('xray rows alternate their background after filtering and reversing order',async({page})=>{
  await openLogs(page,'dark',{width:1440,height:900});
  const colors=()=>rows(page).evaluateAll(els=>els.map(el=>getComputedStyle(el).backgroundColor));
  const initial=await colors();
  expect(initial[0]).not.toBe(initial[1]);expect(initial[0]).toBe(initial[2]);expect(initial[1]).toBe(initial[3]);
  await page.locator('#xray-log-order').click();
  const reversed=await colors();expect(reversed[0]).not.toBe(reversed[1]);
  await page.locator('#xray-log-chips [data-xlog-act="kind"][data-value="block"]').click();
  await expect(rows(page)).toHaveCount(3);
  const filtered=await colors();expect(filtered[0]).not.toBe(filtered[1]);expect(filtered[0]).toBe(filtered[2]);
});

test('translated route labels keep technical log content intact',async({page})=>{
  await openLogs(page,'dark',{width:1600,height:1000});
  const table=page.locator('#xray-log-output');
  await expect(table).toContainText('Маршрут / узел');
  await expect(table).toContainText('Через прокси');
  await expect(table).toContainText('Напрямую');
  await expect(table).toContainText('Заблокировано');
  await expect(page.locator('#xray-log-chips')).toContainText('DNS');
  const colors=await page.evaluate(()=>['proxy','direct','block'].map(k=>getComputedStyle(document.querySelector(`#xray-log-chips [data-value="${k}"]`)).color));
  expect(new Set(colors).size).toBe(3);
});

const restartLines = [
  '[2026-07-29 09:10:00] source=routing result=OK file=03_routing.json duration_ms=41\n',
  '[2026-07-29 09:12:00] source=xray-preflight result=FAIL file=04_outbounds.json phase=validation returncode=23 summary=invalid_rule\n',
];

const accessLines = [
  '2026/07/29 09:00:00.100000 from 192.168.1.34:53122 accepted tcp:www.youtube.com:443 [tproxy-in -> pecan--Frankfurt-2] email: phone',
  '2026/07/29 09:00:01.200000 from 192.168.1.20:61002 accepted tcp:api.github.com:443 [redirect-in -> direct]',
  '2026/07/29 09:00:02.300000 from 192.168.1.51:40211 accepted tcp:ads.doubleclick.net:443 [redirect-in -> block]',
  '2026/07/29 09:00:03.400000 from 192.168.1.20:61004 accepted tcp:192.0.2.15:443 [tproxy-in -> pecan--Amsterdam-1]',
  '2026/07/29 09:00:04.500000 something the parser does not know',
];

const errorLines = [
  '2026/07/29 09:00:00 [Warning] [3021571] app/dispatcher: sample warning line',
  '2026/07/29 09:00:01 [Error] [3021588] transport/internet/reality: sample error line',
  '2026/07/29 09:00:02 [Info] [3021602] proxy/dns: handling DNS traffic',
];


async function mockLogs(page, options = {}) {
  await page.route('**/api/xray-logs/status', async (route) => {
    await route.fulfill({ json: { loglevel: options.loglevel || 'warning' } });
  });
  await page.route('**/api/xray-logs/devices**', async (route) => {
    await route.fulfill({ json: { devices: [{ ip: '192.168.1.34', name: 'iPhone', source: 'manual' }] } });
  });
  await page.route('**/api/xray-logs/outbound-names', async (route) => {
    await route.fulfill({ json: { ok: true, names: {
      'pecan--Frankfurt-2': { name: '🇩🇪 Frankfurt-2', subscription: 'Pecan' },
      'pecan--Amsterdam-1': { name: '🇳🇱 Amsterdam-1', subscription: 'Pecan' },
    } } });
  });
  await page.route('**/api/xray-logs?**', async (route) => {
    const url = new URL(route.request().url());
    const lines = url.searchParams.get('file') === 'error'
      ? errorLines
      : (options.accessLines || accessLines);
    await route.fulfill({ json: { mode: 'full', cursor: 'stage4-logs', lines } });
  });
  await page.route('**/api/restart-log', async (route) => {
    await route.fulfill({ json: { lines: options.restartLines || restartLines } });
  });
  await page.route('**/api/ws-token', async (route) => {
    await route.fulfill({ status: 503, json: { ok: false } });
  });
}


async function openLogs(page, theme, viewport, options = {}) {
  await page.setViewportSize(viewport);
  await page.addInitScript((nextTheme) => {
    localStorage.setItem('xkeen-theme', nextTheme);
    localStorage.setItem('xkeen.editor.engine', 'codemirror');
  }, theme);
  await mockLogs(page, options);
  await page.goto('/');
  await selectPanelView(page, 'xray-logs');
  await expect(page.locator('#view-xray-logs')).toBeVisible();
  await expect(page.locator('#xray-log-output .tr').first()).toBeVisible();
  await expect(page.locator('[data-xk-restart-log="1"]').last()).toContainText('Xray preflight');
}

const rows = (page) => page.locator('#xray-log-output .tr:not([hidden])');

async function openFrameTestView(page, mode = 'access') {
  await page.goto('/');
  await page.evaluate(async mode => {
    const { createXrayLogView } = await import('/static/js/features/xray_log_view.js');
    const root = document.createElement('div');
    root.style.cssText = 'height:360px;width:1280px;overflow:auto';
    document.body.append(root);
    const view = createXrayLogView({ root });
    const line = n => mode === 'access'
      ? `2026/11/14 13:21:42 from 192.168.10.13:53535 accepted tcp:frame${n}.test:443 [redirect-in -> direct]`
      : `2026/11/14 13:21:42 [Warning] [3021571] app/dispatcher: frame${n}.test`;
    view.setMode(mode); view.setMaxLines(50);
    view.reset(Array.from({ length: 50 }, (_, n) => line(n)));
    window.__frameTest = { root, view, line };
    window.__withHeldFrames = run => {
      const original = window.requestAnimationFrame, cancel = window.cancelAnimationFrame;
      const pending = new Map(); let id = 1000000;
      window.requestAnimationFrame = callback => { pending.set(++id, callback); return id; };
      window.cancelAnimationFrame = id => pending.delete(id);
      const flush = () => { const callbacks = [...pending.values()]; pending.clear(); for (const callback of callbacks) callback(performance.now()); };
      try { return run({ ...window.__frameTest, pending, flush }); }
      finally { window.requestAnimationFrame = original; window.cancelAnimationFrame = cancel; }
    };
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, mode);
}

test('frame batching defers repeated stream counters until the scheduled output update', async ({ page }) => {
  await page.addInitScript(() => {
    class Socket {
      static OPEN = 1;
      static CONNECTING = 0;
      constructor(url) {
        this.readyState = 1;
        if (String(url).includes('/ws/xray-logs')) window.__frameSocket = this;
        setTimeout(() => this.onopen?.({}), 0);
      }
      send() {}
      close() { this.readyState = 3; }
      emit(line) { this.onmessage?.({ data: JSON.stringify({ type: 'line', line }) }); }
    }
    window.WebSocket = Socket;
  });
  await openLogs(page, 'dark', { width: 1440, height: 900 }, { accessLines: manyAccessLines(50) });
  await page.route('**/api/ws-token', route => route.fulfill({ json: { ok: true, token: 'frame' } }));
  await page.locator('#xray-log-enable-btn').click();
  await expect.poll(() => page.evaluate(() => typeof window.__frameSocket?.onmessage)).toBe('function');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const unchanged = await page.evaluate(lines => {
    const footer = document.querySelector('#xray-log-stats');
    const before = footer.innerHTML;
    for (const line of lines) window.__frameSocket.emit(line);
    return before === footer.innerHTML;
  }, manyAccessLines(10, 50));
  expect(unchanged).toBe(true);
  await expect(page.locator('#xray-log-stats [data-kind="shown"] .xk-log-counter-value')).toHaveText('60 из 60');
  await expect(page.locator('#xray-log-output')).toContainText('h59.example.com');
});

for (const mode of ['access', 'error']) {
  test(`frame batching coalesces ${mode} rows without delaying parsing or changing the buffer limit`, async ({ page }) => {
    await openFrameTestView(page, mode);
    const result = await page.evaluate(() => window.__withHeldFrames(({ root, view, line, pending, flush }) => {
      const before = root.shadowRoot.innerHTML;
      for (let n = 50; n < 60; n++) view.append([line(n)]);
      const result = { unchanged: before === root.shadowRoot.innerHTML, frames: pending.size,
        total: view.stats().total, lines: view.visibleLines() };
      flush(); result.after = root.shadowRoot.textContent;
      return result;
    }));
    expect(result.unchanged).toBe(true);
    expect(result.frames).toBe(1);
    expect(result.total).toBe(50);
    expect(result.lines).toHaveLength(50);
    expect(result.lines[0]).toContain('frame10.test');
    expect(result.lines.at(-1)).toContain('frame59.test');
    expect(result.after).toContain('frame59.test');
  });
}

test('frame batching freezes the pending update and keeps later arrivals off the paused table', async ({ page }) => {
  await openFrameTestView(page);
  const result = await page.evaluate(() => window.__withHeldFrames(({ root, view, line, pending, flush }) => {
    view.append([line(50)]); view.setFrozen(true);
    const paused = root.shadowRoot.innerHTML;
    const result = { paused: root.shadowRoot.textContent, frames: pending.size };
    for (let n = 51; n < 111; n++) view.append([line(n)]);
    flush(); result.unchanged = paused === root.shadowRoot.innerHTML;
    view.setFrozen(false); result.resumed = root.shadowRoot.textContent;
    result.total = view.stats().total;
    return result;
  }));
  expect(result.paused).toContain('frame50.test');
  expect(result.frames).toBe(0);
  expect(result.unchanged).toBe(true);
  expect(result.resumed).toContain('frame110.test');
  expect(result.total).toBe(50);
});

test('frame batching cancels a pending append when a new snapshot replaces the buffer', async ({ page }) => {
  await openFrameTestView(page);
  const result = await page.evaluate(() => window.__withHeldFrames(({ root, view, line, pending, flush }) => {
    view.append([line(50)]); view.reset([line(200)]);
    const frames = pending.size;
    flush();
    return { frames, text: root.shadowRoot.textContent, lines: view.visibleLines() };
  }));
  expect(result.frames).toBe(0);
  expect(result.lines).toHaveLength(1);
  expect(result.text).toContain('frame200.test');
  expect(result.text).not.toContain('frame50.test');
});

for (const order of ['oldest', 'newest']) {
  test(`frame batching preserves the reading anchor while trimming ${order} rows`, async ({ page }) => {
    await openFrameTestView(page);
    const result = await page.evaluate(order => window.__withHeldFrames(({ root, view, line, flush }) => {
      view.setOrder(order); root.scrollTop = 600;
      root.dispatchEvent(new Event('scroll')); flush();
      const visible = () => [...root.shadowRoot.querySelectorAll('.tr')].filter(row => !row.hidden)
        .map(row => ({ text: row.textContent.match(/frame\d+\.test/)[0], top: row.getBoundingClientRect().top }))
        .filter(row => row.top >= root.getBoundingClientRect().top + 30).sort((a, b) => a.top - b.top)[0];
      const before = visible();
      for (let n = 50; n < 55; n++) view.append([line(n)]);
      flush();
      return { before, after: visible(), unseen: view.unseen() };
    }), order);
    expect(result.after.text).toBe(result.before.text);
    expect(Math.abs(result.after.top - result.before.top)).toBeLessThan(1);
    expect(result.unseen).toBe(5);
  });
}


async function readLogsGeometry(page) {
  return page.evaluate(() => {
    const view = document.querySelector('#view-xray-logs');
    const head = view.querySelector('.xk-xlog-head');
    const search = view.querySelector('.xk-xlog-search input');
    const output = document.querySelector('#xray-log-output');
    const detail = Array.from(document.querySelectorAll('.xk-jr-more')).at(-1) || null;
    const detailToggle = Array.from(document.querySelectorAll('.xk-jr-row > .chev')).at(-1) || null;
    const state = document.querySelector('#xray-log-status');
    return {
      headDisplay: head ? getComputedStyle(head).display : '',
      searchHeight: search ? search.getBoundingClientRect().height : 0,
      outputHeight: output ? output.getBoundingClientRect().height : 0,
      detailDisplay: detail ? getComputedStyle(detail).display : '',
      detailToggleRadius: detailToggle ? getComputedStyle(detailToggle).borderRadius : '',
      stateBorderLeft: state ? getComputedStyle(state).borderLeftWidth : '',
      viewOverflow: view ? view.scrollWidth - view.clientWidth : 999,
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
}


// Many lines, a second apart, so the table scrolls: 09:00:00, 09:00:01…
const pad2 = (n) => String(n).padStart(2, '0');
const manyAccessLines = (count, from = 0) => Array.from({ length: count }, (_, k) => {
  const i = from + k;
  return `2026/07/29 09:${pad2(Math.floor(i / 60) % 60)}:${pad2(i % 60)}.000000 from 192.168.1.20:${40000 + i} accepted tcp:h${i}.example.com:443 [redirect-in -> direct]`;
});

// The times of the rows the eye sees, top to bottom.
async function seenTimes(page) {
  return page.evaluate(() => {
    const host = document.querySelector('#xray-log-output');
    const box = host.getBoundingClientRect();
    return Array.from(host.shadowRoot.querySelectorAll('.tr'))
      .filter((row) => !row.hidden)
      .map((row) => ({ top: row.getBoundingClientRect().top, time: (row.textContent.match(/\d\d:\d\d:\d\d/) || [''])[0] }))
      .filter((row) => row.top >= box.top + 28 && row.top < box.bottom - 8)
      .sort((a, b) => a.top - b.top)
      .map((row) => row.time);
  });
}

test.describe('Xray logs: order and the edge of new rows', () => {
  test('the table shows its newest rows as soon as the screen opens', async ({ page }) => {
    await openLogs(page, 'dark', { width: 1440, height: 900 }, { accessLines: manyAccessLines(80) });
    // The view drew the end while hidden; once shown it must stand there too.
    await expect.poll(async () => (await seenTimes(page)).at(-1)).toBe('09:01:19');
  });

  test('the order button turns the table and is remembered', async ({ page }) => {
    await openLogs(page, 'dark', { width: 1440, height: 900 }, { accessLines: manyAccessLines(80) });
    const order = page.locator('#xray-log-order');
    await expect(order).toHaveAttribute('aria-pressed', 'false');
    await expect(order).toHaveAttribute('aria-label', 'Порядок: старые сверху');
    await order.click();
    await expect(order).toHaveAttribute('aria-pressed', 'true');
    await expect(order).toHaveAttribute('aria-label', 'Порядок: новые сверху');
    // Newest first, and the table stands at its top, by the new rows.
    await expect.poll(async () => (await seenTimes(page)).slice(0, 3)).toEqual(['09:01:19', '09:01:18', '09:01:17']);

    await page.reload();
    await selectPanelView(page, 'xray-logs');
    await expect(page.locator('#xray-log-order')).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => (await seenTimes(page))[0]).toBe('09:01:19');
  });

  test('away from the new rows a button leads back, on either order', async ({ page }) => {
    await openLogs(page, 'dark', { width: 1440, height: 900 }, { accessLines: manyAccessLines(80) });
    const toNew = page.locator('#xray-log-scroll-bottom');
    await expect(toNew).toBeHidden();
    await page.locator('#xray-log-output').hover();
    await page.mouse.wheel(0, -800);
    await expect(toNew).toBeVisible();
    await expect(toNew).toHaveText('↓ К новым');
    await toNew.click();
    await expect(toNew).toBeHidden();
    await expect.poll(async () => (await seenTimes(page)).at(-1)).toBe('09:01:19');

    await page.locator('#xray-log-order').click();
    await expect(toNew).toBeHidden();
    await page.locator('#xray-log-output').hover();
    await page.mouse.wheel(0, 800);
    await expect(toNew).toHaveText('↑ К новым');
    // Above the table, not over the selection bar at its foot.
    const button = await toNew.boundingBox();
    const output = await page.locator('#xray-log-output').boundingBox();
    expect(button.y).toBeLessThan(output.y + output.height / 2);
    await toNew.click();
    await expect.poll(async () => (await seenTimes(page))[0]).toBe('09:01:19');
  });

  test('new lines do not move the rows the eye is on and are counted on the button', async ({ page }) => {
    let n = 80;
    await openLogs(page, 'dark', { width: 1440, height: 900 }, { accessLines: manyAccessLines(80) });
    await page.route('**/api/xray-logs?**', async (route) => {
      const cursor = new URL(route.request().url()).searchParams.get('cursor');
      if (!cursor) {
        await route.fulfill({ json: { mode: 'full', cursor: 'p0', lines: manyAccessLines(80) } });
        return;
      }
      const lines = manyAccessLines(2, n);
      n += 2;
      await route.fulfill({ json: { mode: 'append', cursor: `p${n}`, lines } });
    });
    await page.locator('#xray-log-order').click();
    await page.locator('#xray-log-more > summary').click();
    await page.locator('#xray-log-interval').selectOption('1000');
    await page.keyboard.press('Escape');
    await page.locator('#xray-log-output').hover();
    await page.mouse.wheel(0, 640);
    const toNew = page.locator('#xray-log-scroll-bottom');
    await expect(toNew).toBeVisible();
    const before = await seenTimes(page);
    await page.locator('#xray-log-enable-btn').click();
    await expect(toNew).toHaveText(/^↑ К новым · \d+$/, { timeout: 10_000 });
    expect((await seenTimes(page))[0]).toBe(before[0]);
    await toNew.click();
    await expect(toNew).toBeHidden();
    // At the edge the table follows the new rows.
    const top = (await seenTimes(page))[0];
    await expect.poll(async () => (await seenTimes(page))[0], { timeout: 10_000 }).not.toBe(top);
    await expect(toNew).toBeHidden();
  });
});

test.describe('Operator Console Stage 4 logs', () => {
  test('keeps stream preferences in the more menu and couples auto-update to Пуск and Стоп', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('xkeen.ui.xrayLogs.liveWanted.v1', '1');
    });
    await openLogs(page, 'dark', { width: 1440, height: 900 });

    await expect(page.locator('.xk-xlog-head > * #xray-log-live:visible')).toHaveCount(0);
    await page.locator('#xray-log-more > summary').click();
    await expect(page.locator('#xray-log-more #xray-log-live')).toBeAttached();
    await expect(page.locator('#xray-log-more')).not.toContainText('Следить за концом');
    await expect(page.locator('#xray-log-more #xray-log-interval')).toBeVisible();
    const menuBox = await page.locator('#xray-log-more .dt-log-menu-panel').boundingBox();
    expect(menuBox.x).toBeGreaterThanOrEqual(0);
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(1440);

    const live = page.locator('#xray-log-more #xray-log-live');
    await expect(live).not.toBeChecked();

    await page.locator('#xray-log-view-btn').click();
    await expect(live).not.toBeChecked();

    await page.route('**/api/xray-logs/enable', async (route) => {
      await route.fulfill({ json: { loglevel: 'warning', xray_restarted: true } });
    });
    await page.route('**/api/xray-logs/disable', async (route) => {
      await route.fulfill({ json: { ok: true } });
    });

    await page.locator('#xray-log-enable-btn').click();
    await expect(live).toBeChecked();
    // Пуск and Пауза share one slot: a running stream offers only Пауза.
    await expect(page.locator('#xray-log-pause')).toBeVisible();
    await expect(page.locator('#xray-log-enable-btn')).toBeHidden();

    await page.locator('#xray-log-disable-btn').click();
    await expect(live).not.toBeChecked();
  });

  test('Пуск enables Xray logging only when it is off', async ({ page }) => {
    let enableCalls = 0;
    await openLogs(page, 'dark', { width: 1440, height: 900 }, { loglevel: 'none' });
    await page.route('**/api/xray-logs/enable', async (route) => {
      enableCalls += 1;
      await route.fulfill({ json: { loglevel: 'warning', xray_restarted: true } });
    });
    await page.locator('#xray-log-enable-btn').click();
    await expect.poll(() => enableCalls).toBe(1);
  });

  test('pause turns the slot into «Продолжить» that counts new lines', async ({ page }) => {
    let n = 0;
    const next = () => {
      n += 1;
      return `2026/07/29 10:00:${String(n % 60).padStart(2, '0')}.000000 from 192.168.1.20:${40000 + n} accepted tcp:h${n}.example.com:443 [tproxy-in -> direct]`;
    };
    await openLogs(page, 'dark', { width: 1440, height: 900 });
    await page.route('**/api/xray-logs?**', async (route) => {
      const cursor = new URL(route.request().url()).searchParams.get('cursor');
      if (!cursor) {
        await route.fulfill({ json: { mode: 'full', cursor: 'p0', lines: Array.from({ length: 10 }, next) } });
        return;
      }
      await route.fulfill({ json: { mode: 'append', cursor: `p${n}`, lines: [next(), next()] } });
    });
    await page.locator('#xray-log-more > summary').click();
    await page.locator('#xray-log-interval').selectOption('1000');
    await page.keyboard.press('Escape');
    const play = page.locator('#xray-log-enable-btn');
    const pause = page.locator('#xray-log-pause');
    await expect(play).toContainText('Пуск');
    await expect(pause).toBeHidden();
    await play.click();
    await expect(pause).toBeVisible();
    await expect(play).toBeHidden();

    await pause.click();
    await expect(pause).toBeHidden();
    await expect(play).toBeVisible();
    await expect(play).toBeFocused();
    await expect(play.locator('[data-xlog-play-label]')).toHaveText('Продолжить');
    await expect(play.locator('.xk-xlog-badge')).toHaveText(/^\+\d+$/);
    const newLines = page.locator('#xray-log-new-lines');
    await expect(newLines).toBeVisible();
    await expect(newLines).toContainText(/\d+ нов\S+ строк\S* — показать/);
    await expect(page.locator('#xray-log-scroll-bottom')).toBeHidden();

    // New lines must not rebuild the buttons: a click whose mousedown landed
    // on an element replaced before mouseup was lost (seen on 45.1).
    await page.evaluate(() => { window.__playLabel = document.querySelector('#xray-log-enable-btn [data-xlog-play-label]'); });
    await expect.poll(() => play.locator('.xk-xlog-badge').textContent()).not.toBe('+0');
    await page.waitForTimeout(2500);
    expect(await page.evaluate(() => window.__playLabel === document.querySelector('#xray-log-enable-btn [data-xlog-play-label]'))).toBe(true);

    await newLines.click();
    await expect(pause).toBeVisible();
    await expect(newLines).toBeHidden();

    // «Продолжить» only unfreezes the stream: no request to enable logging.
    let enableCalls = 0;
    await page.route('**/api/xray-logs/enable', async (route) => {
      enableCalls += 1;
      await route.fulfill({ json: { loglevel: 'warning', xray_restarted: true } });
    });
    await pause.click();
    await play.click();
    await expect(pause).toBeVisible();
    await expect(play.locator('[data-xlog-play-label]')).toHaveText('Пуск');
    expect(enableCalls).toBe(0);

    let disabled = 0;
    await page.route('**/api/xray-logs/disable', async (route) => {
      disabled += 1;
      await route.fulfill({ json: { ok: true } });
    });
    await pause.click();
    const stop = await page.locator('#xray-log-disable-btn').boundingBox();
    await page.mouse.move(stop.x + stop.width / 2, stop.y + stop.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(1200);
    await page.mouse.up();
    await expect.poll(() => disabled).toBe(1);
  });

  test('header controls share one height', async ({ page }) => {
    await openLogs(page, 'dark', { width: 1440, height: 900 });
    const heights = await page.evaluate(() => [
      '.xk-xlog-title',
      '.xk-xlog-seg',
      '.xk-xlog-run',
      '.xk-xlog-search input',
      '#xray-log-more > summary',
      '#xray-log-fullscreen',
    ].map((sel) => Math.round(document.querySelector('#view-xray-logs').querySelector(sel).getBoundingClientRect().height)));
    expect(new Set(heights)).toEqual(new Set([32]));
  });

  test('access.log is a table with device names, node flags and hidden unparsed lines', async ({ page }) => {
    await openLogs(page, 'dark', { width: 1440, height: 900 });

    await expect(rows(page)).toHaveCount(4);
    const first = rows(page).first();
    await expect(first.locator('.dev')).toContainText('iPhone');
    await expect(first.locator('.dst')).toContainText('www.youtube.com');
    await expect(first.locator('.pill.proxy')).toContainText('Frankfurt-2');
    await expect(first.locator('.pill.proxy .flag svg')).toHaveCount(1);
    await expect(first.locator('.grp')).toContainText('Pecan');
    await expect(rows(page).nth(1).locator('.pill.direct')).toContainText('Напрямую');
    await expect(rows(page).nth(2).locator('.pill.block')).toContainText('Заблокировано');

    await expect(page.locator('[data-xlog-raw-note]')).toContainText('Не разобрано и скрыто: 1');
    await page.locator('#xray-log-more > summary').click();
    await page.locator('label.xk-xlog-menu-item:has(#xray-log-show-raw)').click();
    await expect(rows(page)).toHaveCount(5);
    await expect(page.locator('#xray-log-output .tr.is-raw .raw')).toContainText('something the parser does not know');
  });

  test('rows are selected with click, Shift and Ctrl+A and copied as lines or a table', async ({ page }) => {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await openLogs(page, 'dark', { width: 1440, height: 900 });

    await rows(page).nth(0).click();
    await rows(page).nth(2).click({ modifiers: ['Shift'] });
    await expect(page.locator('#xray-log-selbar')).toBeVisible();
    await expect(page.locator('[data-xlog-selcount]')).toHaveText('3');

    await page.locator('[data-xlog-act="copy-selected"]').click();
    // Windows hands the clipboard back with CRLF line breaks.
    const clipboard = () => page.evaluate(async () => (await navigator.clipboard.readText()).replace(/\r\n/g, '\n'));
    await expect.poll(clipboard).toBe(accessLines.slice(0, 3).join('\n'));

    await page.locator('[data-xlog-act="copy-selected-tsv"]').click();
    await expect.poll(clipboard).toContain('Время\tУстройство');
    const tsv = await clipboard();
    expect(tsv.split('\n')[0]).toBe('Время\tУстройство\tIP\tНазначение\tПорт\tПротокол\tInbound\tOutbound\tУзел');
    expect(tsv.split('\n')[1]).toContain('iPhone\t192.168.1.34\twww.youtube.com\t443\ttcp\ttproxy-in\tpecan--Frankfurt-2\tFrankfurt-2');

    await page.locator('#xray-log-output').focus();
    await page.keyboard.press('Control+a');
    await expect(page.locator('[data-xlog-selcount]')).toHaveText('4');
    await page.keyboard.press('Escape');
    await expect(page.locator('#xray-log-selbar')).toBeHidden();
  });

  test('chips filter by route and conditions come from row details', async ({ page }) => {
    await openLogs(page, 'dark', { width: 1440, height: 900 });

    await page.locator('#xray-log-chips [data-xlog-act="kind"][data-value="block"]').click();
    await expect(rows(page)).toHaveCount(3);
    await page.locator('#xray-log-chips [data-xlog-act="reset"]').click();
    await expect(rows(page)).toHaveCount(4);

    await page.locator('#xray-log-chips [data-xlog-act="node"][data-value="pecan--Amsterdam-1"]').click();
    await expect(rows(page)).toHaveCount(1);
    await page.locator('#xray-log-chips [data-xlog-act="reset"]').click();

    const detail = page.locator('#xray-log-output .detail');
    await rows(page).nth(0).locator('.chev').click();
    await expect(detail.locator('.line')).toContainText(accessLines[0]);
    await expect(detail.locator('dt')).not.toContainText(['Пользователь']);
    await rows(page).nth(1).locator('.chev').click();
    await expect(detail.locator('dt')).not.toContainText(['Пользователь']);
    await expect(detail).toContainText('192.168.1.20');
    await expect(detail.locator('.line')).toContainText(accessLines[1]);
    await detail.locator('[data-field="ip"]').click();
    await expect(rows(page)).toHaveCount(2);
    await expect(page.locator('#xray-log-chips .is-cond')).toContainText('192.168.1.20');
    await page.locator('#xray-log-chips .is-cond').click();
    await expect(rows(page)).toHaveCount(4);

    // A second click on the same condition removes it.
    await detail.locator('[data-field="ip"]').click();
    await expect(rows(page)).toHaveCount(2);
    await expect(detail.locator('[data-field="ip"]')).toHaveAttribute('aria-pressed', 'true');
    await detail.locator('[data-field="ip"]').click();
    await expect(rows(page)).toHaveCount(4);
    await expect(page.locator('#xray-log-chips .is-cond')).toHaveCount(0);

    await page.locator('[data-xlog-summary-toggle]').click();
    const node = page.locator('[data-xlog-summary-body] button[data-field="node"][data-value="pecan--Amsterdam-1"]');
    await node.click();
    await expect(rows(page)).toHaveCount(1);
    await expect(node).toHaveAttribute('aria-pressed', 'true');
    await node.click();
    await expect(rows(page)).toHaveCount(4);
    await expect(node).toHaveAttribute('aria-pressed', 'false');
  });

  test('dns lookups are hidden by default and never count in the summary tiles', async ({ page }) => {
    const dnsLines = [
      '2026/10/23 14:29:51.100000 from 192.168.1.34:51001 accepted udp:127.0.0.1:53 [xk-dns-listener -> dns-out]',
      '2026/10/23 14:29:51.200000 from DNS accepted udp:8.8.8.8:53 [dns-in -> pecan--Amsterdam-1]',
      '2026/10/23 14:29:51.300000 from DNS accepted udp:77.88.8.8:53 [dns-in -> direct]',
      '2026/10/23 14:29:52.100000 from 192.168.1.34:52110 accepted tcp:www.youtube.com:443 [redirect -> pecan--Frankfurt-2]',
      '2026/10/23 14:29:52.200000 from 192.168.1.20:52111 accepted tcp:api.github.com:443 [redirect -> direct]',
    ];
    await openLogs(page, 'dark', { width: 1440, height: 900 }, { accessLines: dnsLines });

    const dnsChip = page.locator('#xray-log-chips [data-xlog-act="kind"][data-value="dns"]');
    await expect(rows(page)).toHaveCount(2);
    await expect(dnsChip).toHaveAttribute('aria-pressed', 'false');
    await expect(dnsChip).toContainText('3');
    await expect(page.locator('#xray-log-chips [data-xlog-act="kind"][data-value="proxy"]')).toContainText('1');
    await expect(page.locator('#xray-log-chips [data-xlog-act="kind"][data-value="direct"]')).toContainText('1');
    await expect(page.locator('#xray-log-chips [data-xlog-act="reset"]')).toHaveCount(0);
    await expect(page.locator('#xray-log-chips [data-xlog-act="node"]')).toHaveCount(1);

    await page.locator('[data-xlog-summary-toggle]').click();
    const body = page.locator('[data-xlog-summary-body]');
    await expect(page.locator('[data-xlog-summary-extra]')).toHaveText('· 2 соединений · устройств 2 · узлов 1 · доменов 2');
    await expect(body.locator('button[data-field="domain"]')).toHaveText(['youtube.com', 'github.com']);
    await expect(body.locator('button[data-field="ip"]')).toHaveCount(2);
    await expect(body.locator('.xk-xlog-legend .dot-dns')).toHaveCount(0);

    await dnsChip.click();
    await expect(rows(page)).toHaveCount(5);
    await expect(page.locator('[data-xlog-summary-extra]')).toHaveText('· 5 соединений, из них DNS 3 · устройств 2 · узлов 1 · доменов 2');
    await expect(body.locator('.xk-xlog-legend .dot-dns')).toHaveCount(1);
    await expect(body.locator('button[data-field="domain"]')).toHaveCount(2);
    // Xray's own lookup is DNS, yet its route still shows the node it went through.
    const coreLookup = rows(page).filter({ hasText: '8.8.8.8' });
    await expect(coreLookup).toHaveClass(/k-dns/);
    await expect(coreLookup.locator('.pill.proxy')).toContainText('Amsterdam-1');

    // The choice survives a reload; "Сбросить" hides DNS again.
    await page.reload();
    await selectPanelView(page, 'xray-logs');
    await expect(rows(page)).toHaveCount(5);
    await expect(dnsChip).toHaveAttribute('aria-pressed', 'true');
    await page.locator('#xray-log-chips [data-xlog-act="reset"]').click();
    await expect(rows(page)).toHaveCount(2);
    await expect(dnsChip).toHaveAttribute('aria-pressed', 'false');
  });

  test('error.log keeps level chips and full messages in details', async ({ page }) => {
    await openLogs(page, 'dark', { width: 1440, height: 900 });
    await page.locator('[data-xlog-file-btn="error"]').click();
    await expect(rows(page)).toHaveCount(3);
    await expect(page.locator('#xray-log-level')).toBeVisible();
    await expect(page.locator('#xray-log-summary')).toBeHidden();
    await expect(rows(page).nth(1).locator('.lvl')).toHaveText('error');
    await expect(rows(page).nth(1).locator('.mod')).toHaveText('transport/internet/reality');

    await page.locator('#xray-log-chips [data-xlog-act="level"][data-value="info"]').click();
    await expect(rows(page)).toHaveCount(2);

    await rows(page).nth(1).locator('.chev').click();
    await expect(page.locator('#xray-log-output .detail .full')).toHaveText('sample error line');
  });

  test('a 5000 line buffer keeps only the visible rows in the DOM', async ({ page }) => {
    const many = Array.from({ length: 5000 }, (_, i) => (
      `2026/07/29 09:${String(Math.floor(i / 60) % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000000 from 192.168.1.${20 + (i % 30)}:${40000 + i} accepted tcp:host${i}.example.com:443 [tproxy-in -> direct]`
    ));
    await openLogs(page, 'dark', { width: 1440, height: 900 }, { accessLines: many });
    await page.locator('#xray-log-more > summary').click();
    await page.locator('#xray-log-lines').fill('5000');
    await page.locator('#xray-log-lines').dispatchEvent('change');
    await page.keyboard.press('Escape');
    await expect(page.locator('#xray-log-stats')).toContainText('5000 из 5000');

    const domRows = await page.evaluate(() => document.getElementById('xray-log-output').shadowRoot.querySelectorAll('.tr').length);
    expect(domRows).toBeLessThan(80);
    await expect(rows(page).last()).toContainText('host4999.example.com');

    await page.locator('#xray-log-output').evaluate((el) => { el.scrollTop = 0; });
    await expect(rows(page).first()).toContainText('host0.example.com');
  });

  test('renders log mode and counters in the footer', async ({ page }) => {
    await openLogs(page, 'dark', { width: 1440, height: 900 });
    await expect(page.locator('.xk-xlog-foot #xray-log-mode')).toBeVisible();
    await expect(page.locator('.xk-xlog-foot .xk-log-counter[data-kind="lines"]')).toBeVisible();
    await expect(page.locator('.xk-xlog-foot .xk-log-counter[data-kind="shown"]')).toContainText('4 из 5');
  });

  test('Xray log search clear icon is centered in its button', async ({ page }) => {
    await openLogs(page, 'dark', { width: 1440, height: 900 });
    await page.locator('#xray-log-filter').fill('youtube');
    await expect(rows(page)).toHaveCount(1);

    const geometry = await page.locator('#xray-log-filter-clear').evaluate((button) => {
      const icon = button.querySelector('.xk-action-icon');
      if (!icon) return null;
      const buttonBox = button.getBoundingClientRect();
      const iconBox = icon.getBoundingClientRect();
      return {
        buttonCenterX: buttonBox.left + buttonBox.width / 2,
        buttonCenterY: buttonBox.top + buttonBox.height / 2,
        iconCenterX: iconBox.left + iconBox.width / 2,
        iconCenterY: iconBox.top + iconBox.height / 2,
      };
    });
    expect(geometry).not.toBeNull();
    expect(Math.abs(geometry.iconCenterX - geometry.buttonCenterX)).toBeLessThanOrEqual(1);
    expect(Math.abs(geometry.iconCenterY - geometry.buttonCenterY)).toBeLessThanOrEqual(1);

    await page.locator('#xray-log-filter-clear').click();
    await expect(rows(page)).toHaveCount(4);
    await expect(page.locator('#xray-log-filter-clear')).toBeHidden();
  });

  test('"/" focuses the search', async ({ page }) => {
    await openLogs(page, 'dark', { width: 1440, height: 900 });
    await page.locator('#view-xray-logs .xk-xlog-title').click();
    await page.keyboard.press('/');
    await expect(page.locator('#xray-log-filter')).toBeFocused();
  });

  test('the more menu groups view, data and the red file removal', async ({ page }) => {
    await openLogs(page, 'dark', { width: 1440, height: 900 });
    await page.locator('#xray-log-more > summary').click();

    const titles = page.locator('#xray-log-more .xk-xlog-menu-title');
    await expect(titles).toHaveText(['Вид', 'Данные']);
    for (const id of ['xray-log-copy-btn', 'xray-log-download', 'xray-log-load-more', 'xray-log-view-btn', 'xray-log-devices-btn', 'xray-log-clear-screen-btn']) {
      await expect(page.locator(`#${id}`)).toBeVisible();
    }
    const danger = page.locator('#xray-log-clear-files-btn');
    await expect(danger).toHaveClass(/is-danger/);
    const colors = await page.evaluate(() => ({
      danger: getComputedStyle(document.getElementById('xray-log-clear-files-btn')).color,
      normal: getComputedStyle(document.getElementById('xray-log-download')).color,
    }));
    expect(colors.danger).not.toBe(colors.normal);
  });

  test('keeps the more menu open while changing the log line limit', async ({ page }) => {
    await openLogs(page, 'dark', { width: 1440, height: 900 });
    await page.locator('#xray-log-more > summary').click();

    const menu = page.locator('#xray-log-more');
    const lines = page.locator('#xray-log-lines');
    await expect(menu).toHaveAttribute('open', '');
    await expect(lines).toHaveValue('800');

    await lines.focus();
    await page.keyboard.press('ArrowUp');
    await expect(lines).toHaveValue('850');
    await expect(menu).toHaveAttribute('open', '');
  });

  test('closes the more menu on an outside click and on Escape', async ({ page }) => {
    await openLogs(page, 'dark', { width: 1440, height: 900 });
    const menu = page.locator('#xray-log-more');
    const summary = page.locator('#xray-log-more > summary');

    await summary.click();
    await expect(menu).toHaveAttribute('open', '');
    await page.locator('#xray-log-interval').selectOption('5000');
    await expect(menu).toHaveAttribute('open', '');
    await page.locator('#view-xray-logs .xk-xlog-foot').click();
    await expect(menu).not.toHaveAttribute('open', '');

    await summary.click();
    await expect(menu).toHaveAttribute('open', '');
    await page.keyboard.press('Escape');
    await expect(menu).not.toHaveAttribute('open', '');
    await expect(summary).toBeFocused();

    await summary.click();
    await summary.click();
    await expect(menu).not.toHaveAttribute('open', '');
  });

  test('restores the more menu values after a reload', async ({ page }) => {
    let stored = {};
    const merge = (target, patch) => {
      for (const [key, value] of Object.entries(patch || {})) {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          target[key] = merge(target[key] && typeof target[key] === 'object' ? target[key] : {}, value);
        } else {
          target[key] = value;
        }
      }
      return target;
    };
    await page.route('**/api/ui-settings', async (route) => {
      if (route.request().method() === 'PATCH') {
        stored = merge(stored, route.request().postDataJSON());
      }
      await route.fulfill({ json: { ok: true, settings: stored } });
    });
    await openLogs(page, 'dark', { width: 1440, height: 900 });

    await page.locator('#xray-log-more > summary').click();
    await page.locator('#xray-log-interval').selectOption('5000');
    await page.locator('#xray-log-lines').fill('1200');
    await page.locator('#xray-log-lines').dispatchEvent('change');
    await expect.poll(() => stored?.logs?.view?.maxLines).toBe(1200);
    await expect.poll(() => stored?.logs?.view?.pollMs).toBe(5000);

    await page.reload();
    await selectPanelView(page, 'xray-logs');
    await page.locator('#xray-log-more > summary').click();
    await expect(page.locator('#xray-log-interval')).toHaveValue('5000');
    await expect(page.locator('#xray-log-lines')).toHaveValue('1200');
  });

  test('the summary collapses to one line and remembers it', async ({ page }) => {
    await openLogs(page, 'dark', { width: 1440, height: 900 });
    const toggle = page.locator('[data-xlog-summary-toggle]');
    const body = page.locator('[data-xlog-summary-body]');
    await expect(body).toBeHidden();
    await expect(page.locator('[data-xlog-summary-mini]')).toContainText('Через прокси');

    await toggle.click();
    await expect(body).toBeVisible();
    await expect(body.locator('.xk-xlog-tile')).toHaveCount(4);
    await expect(body).toContainText('Frankfurt-2');

    await page.reload();
    await selectPanelView(page, 'xray-logs');
    await expect(page.locator('[data-xlog-summary-body]')).toBeVisible();
  });

  test('Xray logs use the compact operator header in desktop and mobile layouts', async ({ page }) => {
    await openLogs(page, 'dark', { width: 1440, height: 900 });

    await expect(page.locator('body')).toHaveClass(/xk-operator-header-active/);
    await expect(page.locator('body')).toHaveClass(/xk-xray-logs-header-active/);
    await expect(page.locator('body')).not.toHaveClass(/xk-routing-header-active|xk-mihomo-header-active/);
    await expect(page.locator('.panel-shell-status')).not.toBeInViewport();
    await expect(page.locator('#xk-mihomo-sections-menu .header-tabs')).toBeAttached();

    await page.locator('.xk-brand-service-trigger').click();
    await expect(page.locator('#xkeen-restart-btn')).toBeVisible();
    await expect(page.locator('#global-autorestart-xkeen')).toBeVisible();
    await expect(page.locator('#xray-logs-badge use')).toHaveAttribute('href', /#xk-terminal$/);
    await page.keyboard.press('Escape');
    await expect(page.locator('.xk-brand-service-trigger')).toBeFocused();

    for (const width of [1440, 390, 360]) {
      await page.setViewportSize({ width, height: 900 });
      // Escape restores focus and may scroll the sticky header into view.
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const header = await page.locator('.panel-header-shell').boundingBox();
      const logs = await page.locator('#view-xray-logs > .xk-logs-live-card').boundingBox();
      expect(logs.y - header.y - header.height).toBeGreaterThanOrEqual(11);
      expect(logs.y - header.y - header.height).toBeLessThanOrEqual(13);

      for (const id of ['xk-mihomo-sections-menu', 'xk-mihomo-panel-menu', 'xk-mihomo-service-menu']) {
        await page.locator(`[aria-controls="${id}"]`).click();
        const box = await page.locator(`#${id}`).boundingBox();
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
        await page.keyboard.press('Escape');
      }
    }

    await page.setViewportSize({ width: 1440, height: 900 });
    await selectPanelView(page, 'xkeen');
    await expect(page.locator('body')).toHaveClass(/xk-operator-header-active/);
    await expect(page.locator('#xk-mihomo-sections-menu .header-tabs')).toBeHidden();
    await selectPanelView(page, 'xray-logs');
    await expect(page.locator('body')).toHaveClass(/xk-xray-logs-header-active/);
    await expect(page.locator('#xkeen-restart-btn')).toHaveCount(1);
  });

  test('screen cleanup uses a broom while log-file cleanup retains trash', async ({ page }) => {
    await openLogs(page, 'dark', { width: 1440, height: 900 });
    await expect(page.locator('#xray-log-clear-screen-btn use')).toHaveAttribute('href', /#xk-broom$/);
    await expect(page.locator('#xray-log-clear-files-btn use')).toHaveAttribute('href', /#xk-trash$/);
  });

  test('the journal folds command output under its operation and filters by errors and source', async ({ page }) => {
    const journal = [
      '[2026-07-29 09:12:04] source=xray-preflight result=FAIL file=04_outbounds.json phase=validation returncode=23\n',
      'Прокси-клиент остановлен\n',
      'time="2026-07-29T06:02:58.29Z" level=info msg="Initial configuration complete, total time: 10ms"\n',
      '[2026-07-29 09:13:00] source=core-switch result=OK core=mihomo previous=xray duration_ms=5021\n',
      '[2026-07-29 09:14:00] source=xray-logs-enable result=OK loglevel=info xray_restarted=True\n',
      '$ xkeen -status\n',
      'Прокси-клиент запущен\n',
    ];
    await openLogs(page, 'dark', { width: 1440, height: 900 }, { restartLines: journal });

    const card = page.locator('#view-xray-logs .xk-restart-log-card');
    const rowsOf = card.locator('.xk-jr-row');
    // Three operations and the output of a command with no result yet.
    await expect(rowsOf).toHaveCount(4);
    await expect(card.locator('[data-xk-restart-log-count="all"]')).toHaveText('4');
    await expect(card.locator('[data-xk-restart-log-count="errors"]')).toHaveText('1');
    const core = rowsOf.filter({ hasText: 'Ядро Xkeen' });
    await expect(core.locator('.msg')).toContainText('переключено на Mihomo, xkeen перезапущен');
    await expect(core.locator('.outn')).toHaveText('вывод · 2');
    await expect(core.locator('.dur')).toHaveText('5.0с');
    await expect(rowsOf.filter({ hasText: 'Логи Xray' }).locator('.msg')).toContainText('запись включена, Xray перезапущен');
    // The output with no result line stays open at the end.
    await expect(rowsOf.last()).toHaveClass(/is-open/);
    await expect(card.locator('.xk-jr-out').last()).toContainText('Прокси-клиент запущен');

    await core.click();
    await expect(core).toHaveClass(/is-open/);
    const out = card.locator('.xk-jr-row.is-open + .xk-jr-out').first();
    await expect(out.locator('.xk-jr-oline')).toHaveCount(2);
    await expect(out.locator('.xk-jr-oline').first()).toHaveClass(/k-error/);
    await expect(card.locator('.xk-jr-more dl').first()).toContainText('Предыдущее ядро');

    await card.locator('[data-xk-restart-log-filter="errors"]').click();
    await expect(card.locator('[data-xk-restart-log-filter="errors"]')).toHaveAttribute('aria-checked', 'true');
    await expect(rowsOf).toHaveCount(1);
    await expect(rowsOf.first()).toHaveClass(/k-err/);
    await card.locator('[data-xk-restart-log-filter="all"]').click();

    await rowsOf.filter({ hasText: 'Логи Xray' }).locator('.xk-jr-src').click();
    await expect(card.locator('[data-xk-restart-log-search]')).toHaveValue('xray-logs-enable');
    await expect(rowsOf).toHaveCount(1);

    // The row is one control: Enter opens it and the focus stays on it.
    await rowsOf.first().focus();
    await page.keyboard.press('Enter');
    await expect(rowsOf.first()).toHaveClass(/is-open/);
    await expect(rowsOf.first()).toBeFocused();
  });

  test('background restart shows its date, time and folded output', async ({ page }) => {
    await openLogs(page, 'dark', { width: 1440, height: 900 }, { restartLines: [
      '[2026-07-29 09:12:00] source=xray-preflight result=FAIL\n',
      'Xray output\n',
      '[2026-07-29 09:13:00] source=job-restart result=OK runtime_status=running runtime_core=xray\n',
    ] });
    const card = page.locator('#view-xray-logs .xk-restart-log-card');
    const row = card.locator('.xk-jr-row').filter({ hasText: 'Перезапуск' });
    await expect(card).toContainText('29 июля');
    await expect(row).toContainText('09:13:00');
    await expect(row).toContainText('Xkeen перезапущен');
    await row.click();
    await expect(card.locator('.xk-jr-out')).toContainText('Xray output');
  });

  test('the journal shows the newest first when asked and remembers it', async ({ page }) => {
    const journal = [
      '[2026-07-28 22:00:00] source=routing result=OK file=03_routing.json duration_ms=41\n',
      '[2026-07-29 09:12:04] source=xray-preflight result=FAIL file=04_outbounds.json phase=validation returncode=23\n',
      'Прокси-клиент остановлен\n',
      'Прокси-клиент запущен\n',
      '[2026-07-29 09:13:00] source=core-switch result=OK core=mihomo previous=xray duration_ms=5021\n',
      '$ xkeen -status\n',
    ];
    await openLogs(page, 'dark', { width: 1440, height: 900 }, { restartLines: journal });
    const card = page.locator('#view-xray-logs .xk-restart-log-card');
    const box = card.locator('[data-xk-restart-log="1"]');
    const order = card.locator('[data-xk-restart-log-action="order"]');
    const lines = () => box.locator(':scope > .xk-jr-day, :scope > .xk-jr-row').evaluateAll((nodes) => nodes.map((node) => (
      node.matches('.xk-jr-day') ? `day ${node.textContent.trim()}` : (node.querySelector('.ts')?.textContent.trim() || 'live')
    )));
    // As before: the oldest first.
    await expect(order).toHaveAttribute('aria-pressed', 'false');
    await expect(order).toHaveAttribute('data-tooltip', 'Сейчас: старые сверху. Нажмите — новые сверху');
    expect(await lines()).toEqual(['day 28 июля', '22:00:00', 'day 29 июля', '09:12:04', '09:13:00', 'live']);

    await order.click();
    await expect(order).toHaveAttribute('aria-pressed', 'true');
    await expect(order).toHaveAttribute('data-tooltip', 'Сейчас: новые сверху. Нажмите — старые сверху');
    // Days from today back, the newest row of a day first, a command still running on top.
    expect(await lines()).toEqual(['day 29 июля', 'live', '09:13:00', '09:12:04', 'day 28 июля', '22:00:00']);
    expect(await box.evaluate((el) => el.scrollTop)).toBe(0);
    // The output of one operation keeps the order of its lines.
    const core = card.locator('.xk-jr-row').filter({ hasText: 'Ядро Xkeen' });
    await core.click();
    await expect(core).toHaveClass(/is-open/);
    await expect(core.locator('xpath=following-sibling::*[1]').locator('.xk-jr-oline')).toHaveText(['Прокси-клиент остановлен', 'Прокси-клиент запущен']);

    await page.reload();
    await selectPanelView(page, 'xray-logs');
    await expect(card.locator('.xk-jr-row').first()).toBeVisible();
    await expect(order).toHaveAttribute('aria-pressed', 'true');
    expect(await lines()).toEqual(['day 29 июля', 'live', '09:13:00', '09:12:04', 'day 28 июля', '22:00:00']);
  });

  test('on a phone the «⋯» menu of the journal opens on the screen', async ({ page }) => {
    await openLogs(page, 'dark', { width: 390, height: 900 });
    const card = page.locator('#view-xray-logs .xk-restart-log-card');
    await card.locator('.xk-jr-menu summary').click();
    const [left, right, width] = await card.locator('.xk-jr-menu-panel').evaluate((el) => {
      const r = el.getBoundingClientRect();
      return [r.left, r.right, innerWidth];
    });
    expect(left).toBeGreaterThanOrEqual(0);
    expect(right).toBeLessThanOrEqual(width);
  });

  test('the logs card and the operations journal share edges and padding', async ({ page }) => {
    await openLogs(page, 'dark', { width: 1440, height: 900 });
    const boxes = await page.evaluate(() => [
      document.querySelector('#view-xray-logs .xk-xlog-card'),
      document.querySelector('#view-xray-logs .xk-restart-log-card'),
    ].map((el) => {
      const box = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return [Math.round(box.left), Math.round(box.right), style.paddingLeft, style.paddingTop];
    }));
    expect(boxes[0]).toEqual(boxes[1]);
  });

  for (const theme of ['dark', 'light']) {
    test(`header, output and journal details share one contract in ${theme}`, async ({ page }) => {
      await openLogs(page, theme, { width: 1440, height: 900 });

      const toggle = page.locator('#view-xray-logs .xk-jr-row').last();
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      await expect(page.locator('#view-xray-logs .xk-jr-more').last()).toBeVisible();

      const geometry = await readLogsGeometry(page);
      expect(geometry.headDisplay).toBe('flex');
      expect(Math.round(geometry.searchHeight)).toBe(32);
      expect(geometry.outputHeight).toBeGreaterThanOrEqual(300);
      expect(geometry.detailDisplay).toBe('grid');
      expect(geometry.detailToggleRadius).toBe('5px');
      expect(geometry.stateBorderLeft).toBe('2px');
      expect(geometry.viewOverflow).toBeLessThanOrEqual(1);
      expect(geometry.pageOverflow).toBeLessThanOrEqual(1);
    });
  }

  test('context detail focuses the selected row', async ({ page }) => {
    await openLogs(page, 'dark', { width: 1440, height: 900 });

    await rows(page).nth(1).click({ button: 'right' });
    await expect(page.locator('#xray-line-menu')).toBeVisible();
    await page.locator('#xray-line-menu-context').click();
    await expect(page.locator('#xray-context-modal')).toBeVisible();
    await expect(page.locator('#xray-context-title')).toContainText('Контекст access.log');
    await expect(page.locator('#xray-context-output [data-context-focus="1"]')).toHaveCount(1);
    await expect(page.locator('#xray-context-output [data-context-focus="1"]')).toContainText('api.github.com');
  });

  test('load failures use the same inline error row', async ({ page }) => {
    await openLogs(page, 'dark', { width: 1440, height: 900 });
    await page.route('**/api/xray-logs?**', async (route) => {
      await route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
    });
    await page.route('**/api/restart-log', async (route) => {
      await route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
    });

    await page.locator('#xray-log-more > summary').click();
    await page.locator('#xray-log-clear-screen-btn').click();
    await page.locator('#xray-log-more > summary').click();
    await page.locator('#xray-log-view-btn').click();
    await expect(page.locator('#xray-log-status')).toHaveAttribute('data-tone', 'error');
    await expect(page.locator('#xray-log-output [data-empty-state="title"]')).toContainText('Не удалось получить строки лога');

    await page.locator('.xk-xray-logs-log-card .xk-jr-menu > summary').click();
    await page.locator('.xk-xray-logs-log-card [data-xk-restart-log-action="refresh"]').click();
    await expect(page.locator('.xk-xray-logs-log-card .xk-jr-menu')).not.toHaveAttribute('open', '');
    const restart = page.locator('.xk-xray-logs-log-card [data-xk-restart-log="1"]');
    await expect(restart).toHaveAttribute('data-state', 'error');
    await expect(restart.locator('.xk-jr-empty.is-error')).toContainText('Не удалось загрузить журнал');
  });

  test('mobile keeps the table readable without page overflow', async ({ page }) => {
    await openLogs(page, 'light', { width: 390, height: 844 });
    const geometry = await readLogsGeometry(page);
    expect(geometry.headDisplay).toBe('flex');
    expect(geometry.outputHeight).toBeGreaterThanOrEqual(300);
    expect(geometry.viewOverflow).toBeLessThanOrEqual(1);
    expect(geometry.pageOverflow).toBeLessThanOrEqual(1);
  });
});

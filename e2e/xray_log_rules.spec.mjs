import { test, expect, selectPanelView } from './fixtures.mjs';

async function openView(page) {
  await page.goto('/');
  await page.evaluate(async () => {
    const { createXrayLogView } = await import('/static/js/features/xray_log_view.js');
    const root = document.createElement('div');
    root.id = 'rule-test'; root.style.cssText = 'position:fixed;top:100px;left:0;z-index:10000;height:360px;width:1280px;overflow:auto';
    document.body.append(root);
    const selection = document.createElement('div'); selection.id = 'rule-selection'; selection.style.cssText = 'position:fixed;bottom:0;left:0;z-index:10000'; document.body.append(selection);
    selection.innerHTML = '<span data-xlog-selcount>0</span><button type="button" data-xlog-act="copy-selected-tsv">Копировать таблицу</button>';
    const summary = document.createElement('div'); summary.id = 'rule-summary'; summary.hidden = true;
    summary.innerHTML = '<span data-xlog-summary-extra></span><div data-xlog-summary-body></div>';
    document.body.append(summary);
    window.__inlineRuleLookups = 0;
    const view = createXrayLogView({ root, selbar: selection, summary,
      domainHint: () => window.__destinationHint || '',
      domainsVisible: () => window.__domainsVisible !== false,
      ruleTag: () => { window.__inlineRuleLookups++; return 'inline'; },
      onCopy: text => { window.__ruleCopy = text; } });
    const line = '2026/11/14 17:00:00.001000 from 192.168.10.2:53000 accepted tcp:example.org:443 [redirect -> proxy]';
    view.reset([line]);
    window.__rules = { view, root, line };
  });
}

test('rule column escapes tags, exposes details and includes tag/raw in TSV', async ({ page }) => {
  await openView(page);
  const methods = await page.evaluate(() => [typeof window.__rules.view.setRulesVisible, typeof window.__rules.view.updateRules]);
  expect(methods).toEqual(['function', 'function']);
  await page.evaluate(() => {
    window.__rules.view.setRulesVisible(true);
    window.__rules.view.updateRules(() => 'custom[<img src=x onerror=alert(1)>]');
  });
  const table = page.locator('#rule-test');
  await expect(table.locator('.thead')).toContainText('Правило');
  await expect(table.locator('.rule')).toHaveText('custom[<img src=x onerror=alert(1)>]');
  await expect(table.locator('img')).toHaveCount(0);
  await table.locator('.chev').click();
  await expect(table.locator('.detail')).toContainText('custom[<img src=x onerror=alert(1)>]');
  await table.locator('.tr .cb').click();
  await page.locator('#rule-selection [data-xlog-act="copy-selected-tsv"]').click();
  const copied = await page.evaluate(() => window.__ruleCopy);
  expect(copied.split('\n')[0]).toContain('\tПравило\tОригинал');
  expect(copied.split('\n')[1]).toContain('custom[<img src=x onerror=alert(1)>]');
  expect(copied.split('\n')[1]).toContain('from 192.168.10.2:53000 accepted');
  await page.evaluate(() => {
    window.__rules.view.setFrozen(true);
    window.__rules.view.updateRules(() => 'late-tag');
  });
  await page.locator('#rule-selection [data-xlog-act="copy-selected-tsv"]').click();
  expect(await page.evaluate(() => window.__ruleCopy)).toBe(copied);
  await page.evaluate(() => { window.__rules.view.setFrozen(false); window.__rules.view.copyVisible(); });
  expect(await page.evaluate(() => window.__ruleCopy)).toBe(await page.evaluate(() => window.__rules.line));
  await page.evaluate(() => window.__rules.view.setRulesVisible(false));
  await expect(table.locator('.thead')).not.toContainText('Правило');
  await expect(table.locator('.rule')).toHaveCount(0);
});

test('rule updates share one frame and remain frozen until resume', async ({ page }) => {
  await openView(page);
  expect(await page.evaluate(() => typeof window.__rules.view.updateRules)).toBe('function');
  const sample = await page.evaluate(async () => {
    const { view, root } = window.__rules;
    view.setRulesVisible(true);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const original = requestAnimationFrame, cancel = cancelAnimationFrame;
    const callbacks = new Map(); let id = 100000;
    window.requestAnimationFrame = fn => { callbacks.set(++id, fn); return id; };
    window.cancelAnimationFrame = token => callbacks.delete(token);
    try {
      view.updateRules(() => 'first');
      view.updateRules(() => 'second');
      const before = root.shadowRoot.querySelector('.rule').textContent;
      const frames = callbacks.size;
      for (const fn of callbacks.values()) fn(performance.now());
      callbacks.clear();
      const after = root.shadowRoot.querySelector('.rule').textContent;
      view.setFrozen(true);
      view.updateRules(() => 'paused-result');
      const paused = root.shadowRoot.querySelector('.rule').textContent;
      view.setFrozen(false);
      const resumed = root.shadowRoot.querySelector('.rule').textContent;
      return { before, frames, after, paused, resumed };
    } finally { window.requestAnimationFrame = original; window.cancelAnimationFrame = cancel; }
  });
  expect(sample).toEqual({ before: '—', frames: 1, after: 'second', paused: 'second', resumed: 'paused-result' });
});

test('a revoked rule stays unknown even after another candidate survives', async ({ page }) => {
  await openView(page);
  await page.evaluate(() => {
    const view = window.__rules.view;
    view.setRulesVisible(true);
    view.updateRules(() => 'confirmed');
    view.updateRules(() => '');
    view.updateRules(() => 'surviving-other-rule');
  });
  await expect(page.locator('#rule-test .rule')).toHaveText('—');
});

test('access receipt defers rule matching to a background batch', async ({ page }) => {
  await openView(page);
  const sample = await page.evaluate(() => {
    const { view, line } = window.__rules;
    view.setRulesVisible(true);
    view.setMaxLines(50);
    for (let n = 0; n < 1000; n++) view.append([line.replace('example.org', `batch${n}.example`)]);
    return { lookups: window.__inlineRuleLookups, total: view.stats().total };
  });
  expect(sample).toEqual({ lookups: 0, total: 50 });
  await page.evaluate(() => window.__rules.view.updateRules(() => 'batch-rule'));
  await expect(page.locator('#rule-test .rule').first()).toHaveText('batch-rule');
});

test('confirmed destination leads the IP while hints, pause and ambiguity keep their meaning', async ({ page }) => {
  await openView(page);
  await page.evaluate(() => {
    const { view, line } = window.__rules;
    window.__destinationHint = 'shared.example';
    window.__rules.ipLine = line.replace('example.org', '203.0.113.7');
    view.reset([window.__rules.ipLine, window.__rules.ipLine.replace(':53000 ', ':53001 ')]);
    view.updateRules(() => '', p => p.srcPort === '53000' ? 'exact.example' : '');
  });
  const destinations = page.locator('#rule-test .dst');
  await expect(destinations.nth(0)).toHaveText('exact.example · 203.0.113.7');
  await expect(destinations.nth(0).locator('small')).toHaveText(' · 203.0.113.7');
  await expect(destinations.nth(1)).toHaveText('203.0.113.7 · shared.example');
  await page.evaluate(() => { window.__domainsVisible = false; window.__rules.view.refreshDecorations(); });
  await expect(destinations.nth(0)).toHaveText('203.0.113.7 · shared.example');
  await page.evaluate(() => { window.__domainsVisible = true; window.__rules.view.refreshDecorations(); window.__rules.view.setSearch('exact.example'); });
  await expect(page.locator('#rule-test .tr:not([hidden])')).toHaveCount(1);
  await page.evaluate(() => window.__rules.view.setSearch(''));
  await page.evaluate(() => {
    window.__rules.view.setFrozen(true);
    window.__rules.view.updateRules(() => '', () => '');
  });
  await expect(destinations.nth(0)).toHaveText('exact.example · 203.0.113.7');
  await page.evaluate(() => window.__rules.view.setFrozen(false));
  await expect(destinations.nth(0)).toHaveText('203.0.113.7 · shared.example');
  await page.evaluate(() => window.__rules.view.updateRules(() => '', () => 'other.example'));
  await expect(destinations.nth(0)).toHaveText('203.0.113.7 · shared.example');
  await page.evaluate(() => window.__rules.view.copyVisible());
  expect(await page.evaluate(() => window.__ruleCopy)).toContain('accepted tcp:203.0.113.7:443');
});

test('summary follows confirmed domains per connection through filtering, pause, revocation and trimming', async ({ page }) => {
  await openView(page);
  await page.evaluate(() => {
    const { view, line } = window.__rules;
    const ipLine = line.replace('example.org', '203.0.113.7');
    window.__rules.ipLine = ipLine;
    view.reset([ipLine, ipLine.replace(':53000 ', ':53001 ')]);
  });
  const summary = page.locator('#rule-summary');
  const domain = value => summary.locator(`[data-field="domain"][data-value="${value}"]`);
  await expect(domain('203.0.113.7')).toHaveCount(1);
  await page.evaluate(() => window.__rules.view.updateRules(() => '', p => p.srcPort === '53000' ? 'gateway.icloud.com' : 'mtalk.google.com'));
  await expect(domain('icloud.com')).toHaveCount(1);
  await expect(domain('google.com')).toHaveCount(1);
  await expect(domain('203.0.113.7')).toHaveCount(0);
  await domain('icloud.com').evaluate(el => el.click());
  await expect(page.locator('#rule-test .tr:not([hidden])')).toHaveCount(1);
  await page.evaluate(() => {
    window.__rules.view.setFrozen(true);
    window.__rules.view.updateRules(() => '', p => p.srcPort === '53000' ? '' : 'mtalk.google.com');
  });
  await expect(domain('icloud.com')).toHaveCount(1);
  await expect(page.locator('#rule-test .tr:not([hidden]) .dst')).toContainText('gateway.icloud.com');
  await page.evaluate(() => window.__rules.view.setFrozen(false));
  await expect(domain('icloud.com')).toHaveCount(0);
  await expect(domain('203.0.113.7')).toHaveCount(1);
  await expect(page.locator('#rule-test .tr:not([hidden])')).toHaveCount(0);
  await page.evaluate(() => {
    const { view, ipLine } = window.__rules;
    view.resetFilter();
    view.setMaxLines(50);
    view.append(Array.from({ length: 50 }, (_, n) => ipLine.replace(':53000 ', `:${54000 + n} `)));
  });
  await expect(domain('google.com')).toHaveCount(0);
  await expect(domain('203.0.113.7').locator('..').locator('em')).toHaveText('50');
});

test('a 5000-row table keeps proven rules and domains after unrelated index evictions', async ({ page }) => {
  await openView(page);
  await page.evaluate(async () => {
    const { createXrayRoutingEventIndex } = await import('/static/js/features/xray_log_rules.js');
    const { view, root, line } = window.__rules;
    let clock = 0;
    const index = createXrayRoutingEventIndex({ now: () => clock });
    index.begin({ generation: 'load', since: 0, events: [] });
    view.reset([]); view.setMaxLines(5000); view.setRulesVisible(true);
    for (let start = 1; start <= 5000; start += 500) {
      const lines = [];
      for (let id = start; id < start + 500; id++) {
        const srcPort = String(10000 + id);
        const second = Math.floor((id - 1) / 100);
        lines.push(line.replace('17:00:00.001000', `17:00:${String(second).padStart(2, '0')}.500000`)
          .replace(':53000 ', `:${srcPort} `).replace('example.org', '203.0.113.7'));
        index.ingest({ id, stamp: Date.UTC(2026, 10, 14, 17, 0, second), srcIp: '192.168.10.2', srcPort,
          host: '203.0.113.7', port: '443', proto: 'tcp', inTag: 'redirect', outTag: 'proxy',
          tag: 'load-rule', domain: 'load.example' });
      }
      view.append(lines);
      clock += 5000;
      view.updateRules((p, previous) => index.lookup(p, previous), (p, previous) => index.lookupDomain(p, previous));
    }
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    root.scrollTop = 0;
    root.dispatchEvent(new Event('scroll'));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  const table = page.locator('#rule-test');
  expect(await page.evaluate(() => {
    const { view, root } = window.__rules;
    return view.lineBySeq(Number(root.shadowRoot.querySelector('.tr:not([hidden])').dataset.seq));
  })).toContain(':10001 ');
  await expect(table.locator('.tr:not([hidden]) .rule').first()).toHaveText('load-rule');
  await expect(table.locator('.tr:not([hidden]) .dst').first()).toHaveText('load.example · 203.0.113.7');
  expect(await page.evaluate(() => window.__rules.view.stats().total)).toBe(5000);
  await expect(page.locator('#rule-summary [data-field="domain"][data-value="load.example"]')).toHaveCount(1);
});

test('domain confirmation works through the shared diagnostic poll without rule tags', async ({ page }) => {
  await openController(page, { domains: true, tags: false, debug: false,
    lines: ['2026/11/14 17:00:00.001000 from 192.168.10.2:53000 accepted tcp:203.0.113.7:443 [redirect -> direct]'],
    diagnostic: [
      '2026/11/14 17:00:00.000000 [Info] [1234] proxy/dokodemo: received request for 192.168.10.2:53000',
      '2026/11/14 17:00:00.000100 [Info] [1234] app/dispatcher: taking detour [direct] for [tcp:exact.example:443]',
      '2026/11/14 17:00:00.001100 [Info] [1234] proxy/freedom: connection opened to tcp:203.0.113.7:443, local endpoint 192.168.10.1:55000, remote endpoint 203.0.113.7:443',
    ],
  });
  await expect(page.locator('#xray-log-output .dst')).toHaveText('exact.example · 203.0.113.7', { timeout: 9000 });
  await expect(page.locator('#xray-log-output .rule')).toHaveCount(0);
  await page.locator('#xray-log-output .chev').click();
  await expect(page.locator('#xray-log-output .detail')).toContainText('exact.example');
});

test('XHTTP server names and old cached hints do not label access destinations', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('xkeen.ui.xrayLogs.domainCache.v1', JSON.stringify({
    v: 1,
    items: [{ ip: '203.0.113.8', domain: 'vps.example', updatedAt: Date.now() }],
  })));
  await openController(page, { domains: true, debug: false,
    lines: [
      '2026/11/14 17:00:00 from 192.168.10.2:53000 accepted tcp:203.0.113.7:80 [redirect -> proxy]',
      '2026/11/14 17:00:01 from 192.168.10.3:53001 accepted tcp:203.0.113.8:5222 [redirect -> proxy]',
      '2026/11/14 17:00:02 from 192.168.10.4:53002 accepted tcp:203.0.113.9:443 [redirect -> proxy]',
    ],
    diagnostic: [
      '2026/11/14 17:00:00 [Info] [1234] transport/internet/splithttp: XHTTP is dialing to tcp:vps.example:443, mode packet-up, HTTP version 2, host vps.example',
      '2026/11/14 17:00:00 [Info] [1234] proxy/vless/outbound: tunneling request to tcp:203.0.113.7:80 via vps.example:443',
      '2026/11/14 17:00:02 [Info] [5678] app/dispatcher: sniffed domain: target.example',
      '2026/11/14 17:00:02 [Info] [5678] proxy/vless/outbound: tunneling request to tcp:203.0.113.9:443 via vps.example:443',
    ],
  });
  const destinations = page.locator('#xray-log-output .dst');
  await expect(destinations.filter({ hasText: '203.0.113.9' })).toHaveText('203.0.113.9 · target.example');
  await expect(destinations.filter({ hasText: '203.0.113.7' })).toHaveText('203.0.113.7');
  await expect(destinations.filter({ hasText: '203.0.113.8' })).toHaveText('203.0.113.8');
});

async function openController(page, options = {}) {
  await page.addInitScript(domains => localStorage.setItem('xkeen.ui.xrayLogs.domainsWanted.v1', domains ? '1' : '0'), !!options.domains);
  const debugStatus = () => ({ enabled: options.debug !== false, active: options.active ?? (options.debug !== false && options.level !== 'none'),
    supported: options.supported !== false, version: options.version || '26.11.9',
    reason: options.reason || '', generation: String(options.generation || 1) });
  await page.route('**/api/xray-logs/status', route => options.statusError ? route.fulfill({ status: 500, json: {} }) : route.fulfill({ json: { loglevel: options.level || 'info', has_rule_tags: 'tags' in options ? options.tags : true, log_generation: options.generation || 1, routing_debug: debugStatus() } }));
  await page.route('**/api/xray-logs/devices**', route => route.fulfill({ json: { devices: options.devices || [] } }));
  await page.route('**/api/xray-logs/outbound-names', route => route.fulfill({ json: { ok: true, names: options.names || {} } }));
  await page.route('**/api/restart-log', route => route.fulfill({ json: { lines: [] } }));
  await page.route('**/api/ws-token', route => route.fulfill({ status: 503, json: { ok: false } }));
  let diagnosticRequests = 0;
  await page.route('**/api/xray-logs/routing-debug', route => {
    options.debug = route.request().postDataJSON().enabled;
    return route.fulfill({ json: { ok: true, ...debugStatus() } });
  });
  await page.route('**/api/xray-logs/routing-debug/events', async route => {
    diagnosticRequests++;
    options.pollTimes?.push(performance.now());
    if (options.hold) await options.hold;
    return route.fulfill({ json: { generation: String(options.generation || 1), since: 0, dropped: 0,
      events: options.events || [{ id: 1, stamp: Date.UTC(2026, 10, 14, 17), srcIp: '192.168.10.2', srcPort: '53000',
        host: 'example.org', port: '443', proto: 'tcp', inTag: 'redirect', outTag: 'proxy', tag: 'debug-rule', domain: 'example.org' }],
    } });
  });
  await page.route('**/api/xray-logs?**', async route => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('file') === 'error') {
      diagnosticRequests++;
      options.pollTimes?.push(performance.now());
      if (options.hold) await options.hold;
      return route.fulfill({ json: { mode: diagnosticRequests === 1 ? 'full' : 'append',
        reset: diagnosticRequests === 1, skipped: false, caught_up: true, cursor: 'diagnostic', lines: diagnosticRequests === 1 ? (options.diagnostic || [
          '2026/11/14 17:00:00.000000 [Info] [1234] proxy/dokodemo: received request for 192.168.10.2:53000',
          '2026/11/14 17:00:00.000100 [Info] [1234] app/dispatcher: Hit route rule: [debug-rule] so taking detour [proxy] for [tcp:example.org:443]',
        ]) : [] } });
    }
    return route.fulfill({ json: { mode: 'full', cursor: 'access', lines: options.lines || ['2026/11/14 17:00:00.001000 from 192.168.10.2:53000 accepted tcp:example.org:443 [redirect -> proxy]'] } });
  });
  await page.goto('/');
  await selectPanelView(page, 'xray-logs');
  await expect(page.locator('#xray-log-output .tr').first()).toBeVisible();
  return () => diagnosticRequests;
}

test('screenshot mode masks devices and nodes throughout the access log', async ({ page }) => {
  const ip = '192.168.10.2';
  const tag = 'private-outbound';
  const target = 'example.org';
  await openController(page, {
    debug: false,
    devices: [{ ip, name: 'Private laptop' }],
    names: { [tag]: { name: 'DE Private node', subscription: 'Private subscription' } },
    lines: [
      `2026/11/14 17:00:00 from ${ip}:53000 accepted tcp:${target}:443 [redirect -> ${tag}]`,
      `2026/11/14 17:00:01 from ${ip}:53001 accepted tcp:203.0.113.9:80 [redirect -> ${tag}]`,
      `Unparsed private record with ${ip} via ${tag}`,
    ],
  });
  const output = page.locator('#xray-log-output');
  const summary = page.locator('#xray-log-summary');
  const chips = page.locator('#xray-log-chips');
  await expect(output.locator('.dev').first()).toContainText('Private laptop');
  await expect(output.locator('.rt').first()).toContainText('Private node');
  const more = page.locator('#xray-log-more > summary');
  await more.click();
  await page.locator('label').filter({ has: page.locator('#xray-log-show-raw') }).click();
  await more.click();
  await expect(output.locator('.tr.is-raw')).toContainText(ip);
  const search = page.locator('#xray-log-filter');
  await search.fill(ip);
  await search.press('Enter');
  await summary.locator('[data-xlog-summary-toggle]').click();
  await output.locator('.dev').first().click({ modifiers: ['Alt'] });
  await output.locator('.chev').first().click();
  await page.getByRole('button', { name: 'Скрыть устройства и узлы', exact: true }).click({ timeout: 3000 });
  await expect(search).toBeHidden();
  await expect(output.locator('.dev')).toHaveText(['Устройство 1', 'Устройство 1']);
  await expect(output.locator('.tr.is-raw')).toHaveCount(0);
  await expect(output.locator('.dev').first()).toHaveAttribute('title', 'Устройство 1');
  await expect(output.locator('.pill.proxy').first()).toHaveAttribute('title', 'Узел 1');
  await expect(output.locator('.dst').filter({ hasText: target })).toBeVisible();
  await expect(output.locator('.dst').filter({ hasText: '203.0.113.9' })).toBeVisible();
  await expect(output.locator('.detail')).toContainText('Устройство 1');
  await expect(output.locator('.detail')).toContainText('Узел 1');
  await expect(summary).toContainText('Устройство 1');
  await expect(summary).toContainText('Узел 1');
  await expect(chips.locator('.is-cond')).toContainText('Устройство 1');
  for (const panel of [output.locator('.tr').first(), output.locator('.detail'), summary, chips]) {
    await expect(panel).not.toContainText(/192\.168\.10\.2|Private|private-outbound/);
  }
  await page.getByRole('button', { name: 'Показать устройства и узлы', exact: true }).click();
  await expect(search).toBeVisible();
  await expect(search).toHaveValue(ip);
  await expect(output.locator('.dev').first()).toContainText(ip);
  await expect(output.locator('.rt').first()).toContainText('Private subscription');
  await expect(output.locator('.detail')).toContainText(tag);
  await expect(chips.locator('.is-cond')).toContainText('Private laptop');
  await expect(output.locator('.tr.is-raw')).toContainText(ip);
});

test('screenshot mode stays active when switching to error.log', async ({ page }) => {
  const message = 'request from 192.168.10.2 via private-outbound';
  await openController(page, {
    debug: false,
    diagnostic: [`2026/11/14 17:00:00 [Info] [1234] proxy/dokodemo: ${message}`],
  });
  await page.getByRole('button', { name: 'Скрыть устройства и узлы', exact: true }).click();
  await page.locator('[data-xlog-file-btn="error"]').click();
  const output = page.locator('#xray-log-output');
  const row = output.locator('.tr').first();
  await expect(row.locator('.msg')).toHaveAttribute('title', 'Сообщение скрыто');
  await expect(row).not.toContainText(message);
  await row.locator('.chev').click();
  await expect(output.locator('.detail')).not.toContainText(message);
  await page.getByRole('button', { name: 'Показать устройства и узлы', exact: true }).click();
  await expect(output.locator('.detail')).toContainText(message);
});

for (const debug of [false, true]) {
  test(`shared metadata polling refreshes every second: routing debug=${debug}`, async ({ page }) => {
    const pollTimes = [];
    await openController(page, { debug, domains: true, level: debug ? 'warning' : 'info', pollTimes });
    await expect.poll(() => pollTimes.length, { timeout: 8000 }).toBeGreaterThanOrEqual(3);
    const interval = pollTimes.at(-1) - pollTimes.at(-2);
    expect(interval).toBeGreaterThan(750);
    expect(interval).toBeLessThan(1800);
  });
}

test('routing presence stays on pause and in background, closes on navigation and returns', async ({ page }) => {
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    window.__presence = { opened: 0, closed: 0 };
    window.fetch = (url, init) => {
      if (String(url).endsWith('/api/xray-logs/routing-debug/viewer')) {
        window.__presence.opened++;
        return Promise.resolve(new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(': viewer\n\n'));
            init.signal.addEventListener('abort', () => {
              window.__presence.closed++;
              controller.error(new DOMException('Aborted', 'AbortError'));
            }, { once: true });
          },
        }), { headers: { 'Content-Type': 'text/event-stream' } }));
      }
      return original(url, init);
    };
  });
  await openController(page);
  await expect.poll(() => page.evaluate(() => window.__presence.opened)).toBe(1);
  await page.locator('#xray-log-pause').evaluate(el => el.click());
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(await page.evaluate(() => window.__presence.closed)).toBe(0);
  await selectPanelView(page, 'routing');
  await expect.poll(() => page.evaluate(() => window.__presence.closed)).toBe(1);
  await selectPanelView(page, 'xray-logs');
  await expect.poll(() => page.evaluate(() => window.__presence.opened)).toBe(2);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  await expect.poll(() => page.evaluate(() => window.__presence.closed)).toBe(2);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await expect.poll(() => page.evaluate(() => window.__presence.opened)).toBe(3);
});

test('routing debug is third in View, off means no column or event polling, choice survives reload', async ({ page }) => {
  const options = { debug: false, level: 'warning' };
  const requests = await openController(page, options);
  const toggle = page.locator('#xray-log-routing-debug');
  await page.locator('#xray-log-more > summary').click();
  await expect(toggle).not.toBeChecked();
  expect(await toggle.evaluate(el => Array.from(el.closest('[role="menu"]').querySelectorAll('label')).indexOf(el.closest('label')))).toBe(2);
  await expect(page.locator('#xray-log-output .rule')).toHaveCount(0);
  expect(requests()).toBe(0);
  await toggle.locator('..').locator('..').click();
  await expect(page.locator('#xray-log-output .rule')).toHaveText('debug-rule', { timeout: 9000 });
  await page.reload();
  await selectPanelView(page, 'xray-logs');
  await page.locator('#xray-log-more > summary').click();
  await expect(toggle).toBeChecked();
  await toggle.locator('..').locator('..').click();
  await expect(page.locator('#xray-log-output .rule')).toHaveCount(0);
});

for (const [version, reason] of [['26.3.26', 'Требуется Xray 26.3.27 или новее.'], ['', 'Не удалось определить версию Xray.']]) {
  test(`unsupported routing debug is disabled with a reason: ${version || 'unknown'}`, async ({ page }) => {
    await openController(page, { debug: false, supported: false, version, reason });
    await page.locator('#xray-log-more > summary').click();
    const toggle = page.locator('#xray-log-routing-debug');
    await expect(toggle).toBeDisabled();
    await expect(toggle.locator('..').locator('..')).toHaveAttribute('data-tooltip', reason);
  });
}

test('warning routing debug confirms blocked domain without diagnostic error-log fallback', async ({ page }) => {
  await openController(page, { level: 'warning', domains: true,
    lines: ['2026/11/14 17:00:00.001000 from 192.168.10.2:53000 accepted udp:172.224.181.15:443 [tproxy -> block]'],
    events: [{ id: 1, stamp: Date.UTC(2026, 10, 14, 17), srcIp: '192.168.10.2', srcPort: '53000',
      host: '172.224.181.15', port: '443', proto: 'udp', inTag: 'tproxy', outTag: 'block', tag: '30_block_quic_foreign', domain: 'mask.icloud.com' }],
  });
  await expect(page.locator('#xray-log-output .rule')).toHaveText('30_block_quic_foreign', { timeout: 9000 });
  await expect(page.locator('#xray-log-output .dst')).toHaveText('mask.icloud.com · 172.224.181.15');
});

test('phone hides the rule column but retains the tag in row details', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openController(page);
  await expect(page.locator('#xray-log-output .rule')).toHaveText('debug-rule', { timeout: 9000 });
  expect(await page.locator('#xray-log-output .rule').evaluate(el => getComputedStyle(el).visibility)).toBe('hidden');
  await page.locator('#xray-log-output .chev').click();
  await expect(page.locator('#xray-log-output .detail')).toContainText('debug-rule');
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
});

test('status failure hides rule availability instead of keeping stale data', async ({ page }) => {
  const options = {};
  await openController(page, options);
  await expect(page.locator('#xray-log-output .rule')).toHaveText('debug-rule', { timeout: 9000 });
  options.statusError = true;
  await expect(page.locator('#xray-log-output .thead')).not.toContainText('Правило', { timeout: 12000 });
});

test('stopping logs preserves the rule column and tags while filtering the snapshot', async ({ page }) => {
  const options = {};
  await openController(page, options);
  const table = page.locator('#xray-log-output');
  await expect(table.locator('.rule')).toHaveText('debug-rule', { timeout: 9000 });
  let stops = 0;
  await page.route('**/api/xray-logs/disable', route => {
    options.level = 'none';
    options.generation = 2;
    return route.fulfill({ json: { ok: true, xray_restarted: ++stops === 1 } });
  });
  const stoppedStatus = page.waitForResponse(async response => response.url().endsWith('/api/xray-logs/status')
    && (await response.json()).loglevel === 'none');
  await page.locator('#xray-log-disable-btn').click();
  await stoppedStatus;
  await expect(page.locator('#xray-log-status')).toContainText('Логи остановлены');
  await expect(page.locator('#xray-log-status')).toContainText('Xray перезапущен');
  await page.locator('#xray-log-disable-btn').click();
  await expect(page.locator('#xray-log-status')).toContainText('Логи остановлены');
  await expect(page.locator('#xray-log-status')).not.toContainText('перезапущен');
  expect(stops).toBe(2);
  await expect(table.locator('.rule-head')).toBeVisible();
  await expect(table.locator('.rule')).toHaveText('debug-rule');
  const search = page.locator('#xray-log-filter');
  await search.fill('absent.invalid');
  await search.press('Enter');
  await expect(table.locator('.tr:not([hidden])')).toHaveCount(0);
  await search.fill('example.org');
  await search.press('Enter');
  await expect(table.locator('.tr:not([hidden])')).toHaveCount(1);
  await expect(table.locator('.rule')).toHaveText('debug-rule');
  await table.locator('.chev').click();
  await expect(table.locator('.detail')).toContainText('debug-rule');
  await page.locator('#xray-log-more > summary').click();
  const debugToggle = page.locator('#xray-log-routing-debug');
  await debugToggle.locator('..').locator('..').click();
  await expect(table.locator('.rule-head')).toHaveCount(0);
  await expect(debugToggle).toBeEnabled();
  await debugToggle.locator('..').locator('..').click();
  await expect(table.locator('.rule')).toHaveText('debug-rule');
});

test('a diagnostic response arriving after leaving the view cannot attach a tag', async ({ page }) => {
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  await openController(page, { hold });
  await selectPanelView(page, 'routing');
  release();
  await page.waitForTimeout(300);
  expect(await page.locator('#xray-log-output .rule').textContent()).toBe('—');
});

test('rules work with domain display off through the existing diagnostic poll', async ({ page }) => {
  const requests = await openController(page);
  await expect(page.locator('#xray-log-output .thead')).toContainText('Правило');
  await expect(page.locator('#xray-log-output .rule')).toHaveText('debug-rule', { timeout: 9000 });
  expect(requests()).toBeLessThanOrEqual(4);
  expect(await page.evaluate(() => localStorage.getItem('xkeen.ui.xrayLogs.domainsWanted.v1'))).toBe('0');
});

test('starting wanted debug with domains keeps warning and applies hooks in one enable', async ({ page }) => {
  const options = { level: 'none', domains: true };
  let requested;
  await page.route('**/api/xray-logs/enable', route => {
    requested = route.request().postDataJSON().loglevel;
    options.level = requested;
    return route.fulfill({ json: { ok: true, loglevel: requested, xray_restarted: true } });
  });
  await openController(page, options);
  await page.locator('#xray-log-enable-btn').click();
  await expect.poll(() => requested).toBe('warning');
});

test('Start reapplies an invalidated wanted debug session without changing warning', async ({ page }) => {
  const options = { level: 'warning', active: false };
  let restarts = 0;
  await page.route('**/api/xray-logs/enable', route => {
    restarts++;
    expect(route.request().postDataJSON().loglevel).toBe('warning');
    options.active = true;
    return route.fulfill({ json: { ok: true, loglevel: 'warning', xray_restarted: true } });
  });
  await openController(page, options);
  await page.locator('#xray-log-enable-btn').click();
  await expect.poll(() => restarts).toBe(1);
});

for (const options of [{ level: 'warning', tags: true, debug: false }, { level: 'info', tags: false, debug: false }, { level: 'info', tags: null, debug: false }]) {
  test(`rule column stays hidden for ${options.level} / tags=${options.tags}`, async ({ page }) => {
    const requests = await openController(page, options);
    await expect(page.locator('#xray-log-output .thead')).not.toContainText('Правило');
    expect(requests()).toBe(0);
  });
}

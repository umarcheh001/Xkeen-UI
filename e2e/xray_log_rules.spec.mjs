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
    window.__inlineRuleLookups = 0;
    const view = createXrayLogView({ root, selbar: selection,
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

async function openController(page, options = {}) {
  await page.addInitScript(() => localStorage.setItem('xkeen.ui.xrayLogs.domainsWanted.v1', '0'));
  await page.route('**/api/xray-logs/status', route => options.statusError ? route.fulfill({ status: 500, json: {} }) : route.fulfill({ json: { loglevel: options.level || 'info', has_rule_tags: 'tags' in options ? options.tags : true, log_generation: 1 } }));
  await page.route('**/api/xray-logs/devices**', route => route.fulfill({ json: { devices: [] } }));
  await page.route('**/api/xray-logs/outbound-names', route => route.fulfill({ json: { ok: true, names: {} } }));
  await page.route('**/api/restart-log', route => route.fulfill({ json: { lines: [] } }));
  await page.route('**/api/ws-token', route => route.fulfill({ status: 503, json: { ok: false } }));
  let diagnosticRequests = 0;
  await page.route('**/api/xray-logs?**', async route => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('file') === 'error') {
      diagnosticRequests++;
      if (options.hold) await options.hold;
      return route.fulfill({ json: { mode: diagnosticRequests === 1 ? 'full' : 'append',
        reset: diagnosticRequests === 1, skipped: false, caught_up: true, cursor: 'diagnostic', lines: diagnosticRequests === 1 ? [
          '2026/11/14 17:00:00.000000 [Info] [1234] proxy/dokodemo: received request for 192.168.10.2:53000',
          '2026/11/14 17:00:00.000100 [Info] [1234] app/dispatcher: Hit route rule: [debug-rule] so taking detour [proxy] for [tcp:example.org:443]',
        ] : [] } });
    }
    return route.fulfill({ json: { mode: 'full', cursor: 'access', lines: ['2026/11/14 17:00:00.001000 from 192.168.10.2:53000 accepted tcp:example.org:443 [redirect -> proxy]'] } });
  });
  await page.goto('/');
  await selectPanelView(page, 'xray-logs');
  await expect(page.locator('#xray-log-output .tr').first()).toBeVisible();
  return () => diagnosticRequests;
}

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

for (const options of [{ level: 'warning', tags: true }, { level: 'info', tags: false }, { level: 'info', tags: null }]) {
  test(`rule column stays hidden for ${options.level} / tags=${options.tags}`, async ({ page }) => {
    const requests = await openController(page, options);
    await expect(page.locator('#xray-log-output .thead')).not.toContainText('Правило');
    expect(requests()).toBe(0);
  });
}

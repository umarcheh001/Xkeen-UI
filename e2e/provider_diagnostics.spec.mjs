import { test, expect, selectPanelView, openMihomoConfig } from './fixtures.mjs';

const TARGETS = [
  { name: 'Edge', host: 'edge.example.org', port: 443, network: 'tcp', protocol: 'vless', source: '04_outbounds.json', tls: true, tls_mode: 'standard', sni: 'front.example.org' },
  { name: 'AWG', host: 'awg.example', port: 51820, network: 'udp', protocol: 'wireguard', source: '04_outbounds.json', tls: false },
];

async function expectCompactDetailActions(page) {
  const geometry = await page.locator('.xk-provider-check-details').first().locator('.xk-provider-check-detail-actions').evaluate((container) => {
    const frame = container.getBoundingClientRect();
    const actions = [...container.querySelectorAll('button, a')].map((item) => item.getBoundingClientRect());
    const icon = container.querySelector('a .xk-provider-check-external-icon')?.getBoundingClientRect();
    return { right: frame.right, actions: actions.map((item) => ({ top: item.top, right: item.right, width: item.width, height: item.height })), iconCenter: icon ? icon.left + icon.width / 2 : null };
  });
  expect(geometry.actions).toHaveLength(5);
  expect(Math.max(...geometry.actions.map((item) => item.top)) - Math.min(...geometry.actions.map((item) => item.top))).toBeLessThan(1);
  expect(Math.max(...geometry.actions.map((item) => item.right))).toBeLessThanOrEqual(geometry.right + 1);
  expect(Math.max(...geometry.actions.map((item) => item.width)) - Math.min(...geometry.actions.map((item) => item.width))).toBeLessThan(1);
  expect(Math.max(...geometry.actions.map((item) => item.height)), JSON.stringify(geometry)).toBeLessThanOrEqual(30);
  const link = geometry.actions[4];
  expect(Math.abs(geometry.iconCenter - (link.right - link.width / 2))).toBeLessThan(1);
}

test('Xray toolbar opens server diagnostics and runs selected checks', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('xkeen-theme', 'dark'));
  await page.route('**/api/provider-diagnostics/targets?core=xray', (route) => route.fulfill({ json: { ok: true, targets: TARGETS } }));
  const checked = [];
  await page.route('**/api/provider-diagnostics/probe', async (route) => {
    const target = route.request().postDataJSON();
    checked.push(target.host);
    await new Promise((resolve) => setTimeout(resolve, 200));
    return route.fulfill({ json: { ok: true, result: {
      ...target,
      status: target.network === 'udp' ? 'udp_unknown' : 'reachable',
      message: target.network === 'udp' ? 'Адрес разрешён.' : 'Соединение установлено.',
      addresses: ['198.51.100.10'],
      dns_ms: 9,
      tcp_ms: target.network === 'udp' ? undefined : 12,
      tls_ms: target.tls ? 18 : undefined,
      source_ip: target.network === 'udp' ? undefined : '192.0.2.10',
      connected_ip: target.network === 'udp' ? undefined : '198.51.100.10',
      sni_sent: target.tls ? true : undefined,
    } } });
  });
  await page.route('**/api/provider-diagnostics/dns-compare', (route) => route.fulfill({ json: {
    ok: true, result: { host: 'edge.example.org', status: 'ok', local: ['198.51.100.10'], public: ['203.0.113.20'], different: true },
  } }));
  await page.route('**/api/provider-diagnostics/public-lists', (route) => route.fulfill({ json: {
    ok: true, result: {
      status: 'ok', host: 'edge.example.org', listed: true, registry_domain: 'edge.example.org',
      blocked_subnets: [], cdn_providers: [{ name: 'Example CDN', networks: ['203.0.113.0/24'] }],
      ips: ['203.0.113.10'], organization: 'Example Hosting', asn: 'AS64500', location: 'RU',
    },
  } }));
  await page.route('**/api/provider-diagnostics/compare-tls', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    return route.fulfill({ json: { ok: true, result: {
    status: 'ok', verdict: 'tls_sni_filtering', confidence: 'medium', reason: 'consistent_sni_pattern', target_ip: '198.51.100.10', sni: 'front.example.org', rounds_per_ip: 2,
    trials: { with_sni: ['tls_error', 'tls_error'], without_sni: ['tls_ok', 'tls_ok'] },
    address_results: [
      { ip: '198.51.100.10', with_sni: ['tls_error', 'tls_error'], without_sni: ['tls_ok', 'tls_ok'], pattern: 'sni_only_failure' },
      { ip: '198.51.100.11', with_sni: ['tls_error', 'tls_error'], without_sni: ['tls_ok', 'tls_ok'], pattern: 'sni_only_failure' },
    ],
    control: { ip: '1.1.1.1', result: 'tls_ok' }, registry: { status: 'ok', domain: '', subnets: [] },
    } } });
  });
  await page.goto('/');
  await selectPanelView(page, 'routing');
  await page.locator('[data-provider-check-core="xray"]').click();
  await expect(page.locator('#provider-check-modal')).toBeVisible();
  for (const id of ['provider-check-close', 'provider-check-mode-current', 'provider-check-mode-manual', 'provider-check-refresh', 'provider-check-parse', 'provider-check-run', 'provider-check-cancel']) {
    await expect(page.locator(`#${id}`)).toHaveAttribute('data-tooltip', /.+/);
  }
  await page.locator('#provider-check-mode-manual').hover();
  await expect(page.locator('#xk-tooltip-portal')).toContainText('Ввести адреса серверов');
  await expect(page.locator('.xk-provider-check-row')).toHaveCount(2);
  await expect(page.locator('#provider-check-run')).toBeEnabled();
  await page.locator('#provider-check-select-all').uncheck();
  await expect(page.locator('#provider-check-run')).toBeDisabled();
  await page.locator('[data-provider-check-index="0"]').check();
  await expect(page.locator('#provider-check-run')).toBeEnabled();
  await expect(page.locator('#provider-check-select-all')).toHaveJSProperty('indeterminate', true);
  await page.locator('#provider-check-select-all').check();
  await page.locator('#provider-check-run').click();
  await expect(page.locator('#provider-check-run')).toHaveClass(/is-loading/);
  await expect(page.locator('#provider-check-status')).toContainText('проверено 2');
  await expect(page.locator('.xk-provider-check-row-state.is-reachable')).toHaveCount(1);
  await expect(page.locator('.xk-provider-check-row-state.is-udp_unknown')).toHaveCount(1);
  const summaryLayout = await page.evaluate(() => {
    const source = document.querySelector('#provider-check-current-panel').getBoundingClientRect();
    const stats = document.querySelector('#provider-check-overview').getBoundingClientRect();
    const cards = [...document.querySelectorAll('.xk-provider-check-stat')].map((item) => item.getBoundingClientRect());
    return { source, stats, cards };
  });
  expect(Math.abs(summaryLayout.source.top - summaryLayout.stats.top)).toBeLessThan(2);
  expect(summaryLayout.stats.left).toBeGreaterThan(summaryLayout.source.right);
  expect(Math.max(...summaryLayout.cards.map((card) => card.top)) - Math.min(...summaryLayout.cards.map((card) => card.top))).toBeLessThan(2);
  await page.screenshot({ path: 'test-results/provider-diagnostics-summary-desktop.png', fullPage: false });
  await page.locator('.xk-provider-check-details').first().locator('summary').click();
  await expect(page.locator('.xk-provider-check-details').first()).toContainText('DNS');
  await expect(page.locator('.xk-provider-check-details').first()).toContainText('front.example.org');
  await expect(page.locator('.xk-provider-check-details').first()).toContainText('192.0.2.10');
  await page.getByRole('button', { name: 'Сравнить TLS/SNI' }).first().click();
  await expect(page.getByRole('button', { name: 'Сравнить TLS/SNI' }).first()).toHaveClass(/is-loading/);
  await expect(page.locator('.xk-provider-check-comparison').first()).toContainText('Признаки фильтрации TLS/SNI');
  await expect(page.locator('.xk-provider-check-comparison').first()).toContainText('Уверенность: средняя');
  await expect(page.locator('.xk-provider-check-comparison-ip').first()).toContainText('198.51.100.10');
  await expect(page.locator('.xk-provider-check-comparison-ip')).toHaveCount(2);
  await page.getByRole('button', { name: 'Сравнить DNS' }).first().click();
  await expect(page.locator('.xk-provider-check-dns-compare').first()).toContainText('Google DNS (A)');
  await page.getByRole('button', { name: 'Проверить списки' }).first().click();
  await expect(page.locator('.xk-provider-check-public-lists').first()).toContainText('Проверен сервер: edge.example.org');
  await expect(page.locator('.xk-provider-check-public-lists').first()).toContainText('В реестре заблокированных ресурсов');
  await expect(page.locator('.xk-provider-check-public-lists').first()).toContainText('AS64500');
  await expect(page.locator('.xk-provider-check-row').first()).toHaveClass(/is-registry-blocked/);
  await expect(page.locator('.xk-provider-check-registry-badge')).toContainText('Сервер в реестре');
  for (const action of await page.locator('.xk-provider-check-detail-actions').first().locator('button, a').all()) {
    await expect(action).toHaveAttribute('data-tooltip', /.+/);
  }
  await expect(page.locator('#provider-check-ok-count')).toHaveText('1');
  await expect(page.locator('#provider-check-run')).toBeInViewport();
  await expect(page.locator('#provider-check-cancel')).toBeInViewport();
  expect(checked.sort()).toEqual(['awg.example', 'edge.example.org']);
  await page.screenshot({ path: 'test-results/provider-diagnostics-desktop.png', fullPage: false });
  const content = page.locator('#provider-check-modal .xk-provider-check-content');
  const beforeResize = await content.boundingBox();
  const grip = page.locator('#provider-check-modal .modal-resizer');
  await expect(grip).toBeVisible();
  const gripBox = await grip.boundingBox();
  await page.mouse.move(gripBox.x + gripBox.width / 2, gripBox.y + gripBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(gripBox.x + gripBox.width / 2, gripBox.y + gripBox.height / 2 + 90, { steps: 5 });
  await page.mouse.up();
  const afterResize = await content.boundingBox();
  expect(afterResize.height).toBeGreaterThan(beforeResize.height + 20);
  expect(Math.abs(afterResize.width - beforeResize.width)).toBeLessThan(2);
  const titleBox = await page.locator('#provider-check-title').boundingBox();
  await page.mouse.move(titleBox.x + 20, titleBox.y + titleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(titleBox.x + 60, titleBox.y + titleBox.height / 2, { steps: 5 });
  await page.mouse.up();
  const afterDrag = await content.boundingBox();
  expect(afterDrag.x).toBeGreaterThan(afterResize.x + 20);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('xk.modal.state.v1.provider-check-modal') || '{}').h)).toBeGreaterThan(beforeResize.height + 20);
  await page.keyboard.press('Escape');
  await expect(page.locator('#provider-check-modal')).toBeHidden();
  await page.locator('[data-provider-check-core="xray"]').click();
  const restored = await content.boundingBox();
  expect(Math.abs(restored.x - afterDrag.x)).toBeLessThan(2);
  expect(Math.abs(restored.height - afterDrag.height)).toBeLessThan(2);
});

test('Mihomo diagnostics accepts manual sources on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/provider-diagnostics/targets?core=mihomo', (route) => route.fulfill({ json: { ok: true, targets: [] } }));
  await page.route('**/api/provider-diagnostics/probe', (route) => route.fulfill({ json: { ok: true, result: {
    ...route.request().postDataJSON(), status: 'reachable', message: 'Соединение установлено.',
    addresses: ['203.0.113.10'], dns_ms: 8, tcp_ms: 15,
  } } }));
  await page.route('**/api/provider-diagnostics/public-lists', (route) => route.fulfill({ json: { ok: true, result: {
    status: 'ok', listed: false, registry_domain: '', blocked_subnets: [], cdn_providers: [],
    ips: ['203.0.113.10'], organization: 'Example Hosting', asn: 'AS64500', location: 'RU',
  } } }));
  await page.route('**/api/provider-diagnostics/compare-tls', (route) => route.fulfill({ json: { ok: true, result: {
    status: 'ok', verdict: 'undetermined', confidence: 'low', target_ip: '203.0.113.10', sni: 'example.com',
    trials: { with_sni: ['tls_ok', 'tls_ok'], without_sni: ['tls_ok', 'tls_ok'] },
    control: { ip: '1.1.1.1', result: 'tls_ok' }, registry: { status: 'ok', domain: '', subnets: [] },
  } } }));
  await page.route('**/api/provider-diagnostics/parse', (route) => {
    expect(route.request().postDataJSON().source).toBe('example.com\n203.0.113.10:8443');
    return route.fulfill({ json: { ok: true, targets: [
      { name: 'example.com', host: 'example.com', port: 443, network: 'tcp', protocol: 'web', source: 'Ввод', tls: true },
      { name: '203.0.113.10', host: '203.0.113.10', port: 8443, network: 'tcp', protocol: '', source: 'Ввод', tls: false },
    ], warnings: [], truncated: false } });
  });
  await page.goto('/');
  await selectPanelView(page, 'mihomo');
  await openMihomoConfig(page);
  await page.locator('[data-provider-check-core="mihomo"]').click();
  await page.locator('#provider-check-mode-manual').click();
  await page.locator('#provider-check-input').fill('example.com\n203.0.113.10:8443');
  await page.locator('#provider-check-parse').click();
  await expect(page.locator('.xk-provider-check-row')).toHaveCount(2);
  await expect(page.locator('#provider-check-run')).toBeEnabled();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
  const geometry = await page.evaluate(() => {
    const close = document.querySelector('#provider-check-close').getBoundingClientRect();
    const parse = document.querySelector('#provider-check-parse');
    const icon = parse.querySelector('svg').getBoundingClientRect();
    const label = parse.querySelector('span').getBoundingClientRect();
    const modes = [...document.querySelectorAll('.xk-provider-check-modes button')].map((button) => button.getBoundingClientRect());
    return { closeWidth: close.width, closeHeight: close.height, iconRight: icon.right, labelLeft: label.left, chipGap: modes[1].left - modes[0].right };
  });
  expect(Math.abs(geometry.closeWidth - geometry.closeHeight), JSON.stringify(geometry)).toBeLessThan(1);
  expect(geometry.labelLeft).toBeGreaterThanOrEqual(geometry.iconRight);
  expect(geometry.chipGap).toBeGreaterThanOrEqual(4);
  await expect(page.locator('#provider-check-run')).toBeInViewport();
  await page.screenshot({ path: 'test-results/provider-diagnostics-mobile.png', fullPage: false });
  await page.locator('#provider-check-run').click();
  await expect(page.locator('.xk-provider-check-row-state.is-reachable')).toHaveCount(2);
  const mobileSummary = await page.evaluate(() => ({
    sourceBottom: document.querySelector('#provider-check-manual-panel').getBoundingClientRect().bottom,
    statsTop: document.querySelector('#provider-check-overview').getBoundingClientRect().top,
  }));
  expect(mobileSummary.statsTop).toBeGreaterThanOrEqual(mobileSummary.sourceBottom);
  await page.locator('.xk-provider-check-details').first().locator('summary').click();
  await page.getByRole('button', { name: 'Сравнить TLS/SNI' }).first().click();
  await expect(page.locator('.xk-provider-check-comparison').first()).toContainText('Причина не установлена');
  await page.getByRole('button', { name: 'Проверить списки' }).first().click();
  await expect(page.locator('.xk-provider-check-public-lists').first()).toContainText('Совпадений в списках не найдено');
  await expect(page.locator('.xk-provider-check-row').first()).not.toHaveClass(/is-registry-blocked/);
  await expect(page.locator('#provider-check-run')).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Проверить списки' }).first()).toBeInViewport();
  await expectCompactDetailActions(page);
  await page.screenshot({ path: 'test-results/provider-diagnostics-mobile-detail.png', fullPage: false });
  await page.setViewportSize({ width: 320, height: 640 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  await expect(page.locator('#provider-check-run')).toBeInViewport();
  await expect(page.locator('#provider-check-modal .modal-resizer')).toBeHidden();
  await expectCompactDetailActions(page);
});

test('a failed diagnostic request is not reported as a blocked server', async ({ page }) => {
  await page.route('**/api/provider-diagnostics/targets?core=xray', (route) => route.fulfill({ json: { ok: true, targets: [TARGETS[0]] } }));
  await page.route('**/api/provider-diagnostics/probe', (route) => route.abort());
  await page.goto('/');
  await selectPanelView(page, 'routing');
  await page.locator('[data-provider-check-core="xray"]').click();
  await page.locator('#provider-check-run').click();
  await expect(page.locator('.xk-provider-check-row-state.is-probe_error')).toContainText('Проверка не выполнена');
  await expect(page.locator('#provider-check-unknown-count')).toHaveText('1');
  await expect(page.locator('#provider-check-issue-count')).toHaveText('0');
  await page.locator('.xk-provider-check-details summary').click();
  await expect(page.locator('.xk-provider-check-details dt')).toHaveText('Запрос');
});

test('saved Xray diagnostics shows servers from every outbound file', async ({ page }) => {
  const sources = [
    ['04_outbounds.auth.quattro-cloud.ru.json', 107],
    ['04_outbounds.cdn.pecan.run-2.json', 17],
    ['04_outbounds.cdn.pecan.run.json', 17],
  ];
  const targets = sources.flatMap(([source, count]) => Array.from({ length: count }, (_, index) => ({
    name: `${source}-${index}`, host: `edge-${index}.example.org`, port: 443,
    network: 'tcp', protocol: 'vless', source, tls: true, tls_mode: 'standard',
  })));
  await page.route('**/api/provider-diagnostics/targets?core=xray', (route) => route.fulfill({ json: {
    ok: true, targets, has_more: false,
  } }));
  await page.goto('/');
  await selectPanelView(page, 'routing');
  await page.locator('[data-provider-check-core="xray"]').click();
  await expect(page.locator('.xk-provider-check-row')).toHaveCount(141);
  await expect(page.locator('#provider-check-count')).toHaveText('141');
  await expect(page.locator('#provider-check-status')).toContainText('Найдено серверов: 141');
  await expect(page.locator('#provider-check-more-wrap')).toBeHidden();
  for (const [source, count] of sources) {
    await expect(page.locator('.xk-provider-check-row').filter({ hasText: source })).toHaveCount(count);
  }
});

test('saved Xray diagnostics loads further pages without losing selection', async ({ page }) => {
  const target = (name) => ({ name, host: `${name}.example.org`, port: 443, network: 'tcp', protocol: 'vless', source: '04_outbounds.json', tls: true });
  await page.route('**/api/provider-diagnostics/targets?core=xray', (route) => route.fulfill({ json: {
    ok: true, targets: [target('first'), target('second')], has_more: true, next_offset: 2,
  } }));
  await page.route('**/api/provider-diagnostics/targets?core=xray&offset=2', (route) => route.fulfill({ json: {
    ok: true, targets: [target('third')], has_more: false, next_offset: 3,
  } }));
  await page.goto('/');
  await selectPanelView(page, 'routing');
  await page.locator('[data-provider-check-core="xray"]').click();
  await expect(page.locator('#provider-check-more-wrap')).toBeVisible();
  await page.locator('[data-provider-check-index="1"]').uncheck();
  await page.locator('#provider-check-more').click();
  await expect(page.locator('.xk-provider-check-row')).toHaveCount(3);
  await expect(page.locator('#provider-check-count')).toHaveText('3');
  await expect(page.locator('[data-provider-check-index="0"]')).toBeChecked();
  await expect(page.locator('[data-provider-check-index="1"]')).not.toBeChecked();
  await expect(page.locator('[data-provider-check-index="2"]')).not.toBeChecked();
  await expect(page.locator('#provider-check-more-wrap')).toBeHidden();
});

test('manual subscription shows every server and loading state', async ({ page }) => {
  const targets = Array.from({ length: 107 }, (_, index) => ({
    name: `Node ${index + 1}`, host: `node-${index + 1}.example.org`, port: 443,
    network: 'tcp', protocol: 'vless', source: 'Ссылка', tls: true,
  }));
  await page.route('**/api/provider-diagnostics/parse', async (route) => {
    expect(route.request().postDataJSON().source).toBe('https://provider.example/subscription/private-token');
    await new Promise((resolve) => setTimeout(resolve, 150));
    return route.fulfill({ json: {
      ok: true, targets, warnings: ['Подписка получена с HWID-заголовками.'], truncated: false,
    } });
  });
  await page.goto('/');
  await selectPanelView(page, 'routing');
  await page.locator('[data-provider-check-core="xray"]').click();
  await page.locator('#provider-check-mode-manual').click();
  await page.locator('#provider-check-input').fill('https://provider.example/subscription/private-token');
  await page.locator('#provider-check-parse').click();
  await expect(page.locator('#provider-check-parse')).toHaveClass(/is-loading/);
  await expect(page.locator('.xk-provider-check-row')).toHaveCount(107);
  await expect(page.locator('#provider-check-status')).toContainText('Найдено серверов: 107');
  await expect(page.locator('#provider-check-status')).not.toContainText('Лимит ручного ввода');
  await expect(page.locator('#provider-check-run')).toBeEnabled();
});

test('manual proxy link can be checked through the proxy before TCP checks', async ({ page }) => {
  let finishComparison;
  const comparisonPending = new Promise((resolve) => { finishComparison = resolve; });
  await page.route('**/api/provider-diagnostics/parse', (route) => route.fulfill({ json: {
    ok: true, targets: [{ name: 'Private', host: 'edge.example.org', port: 443,
      network: 'tcp', protocol: 'vless', tls: true, tls_mode: 'standard', source: 'Ссылка',
      proxy_ref: 'opaque-reference', proxy_index: 0 }], warnings: [], truncated: false,
  } }));
  await page.route('**/api/provider-diagnostics/proxy-probe', async (route) => {
    expect(route.request().postDataJSON()).toEqual({ ref: 'opaque-reference', index: 0 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    return route.fulfill({ json: { ok: true, result: {
      status: 'ok', delay_ms: 86, message: 'Прокси передал HTTPS-запрос к контрольному адресу.',
    } } });
  });
  await page.route('**/api/provider-diagnostics/resource-compare', async (route) => {
    expect(route.request().postDataJSON()).toEqual({ url: 'https://kino.watch/', ref: 'opaque-reference', index: 0 });
    await comparisonPending;
    return route.fulfill({ json: { ok: true, result: {
      status: 'ok', resource_host: 'kino.watch', network: { verdict: 'both_reachable', confidence: 'high' },
      direct: { status: 'http_response', http_status: 200, connected_ip: '8.8.8.8', dns_ips: ['8.8.8.8'], tcp_ms: 10, tls_ms: 20 },
      proxy: { status: 'http_response', http_status: 200, connected_ip: '8.8.8.8', tcp_ms: 30, tls_ms: 40 },
      registry: { status: 'ok', listed: true, match: 'kino.watch' },
    } } });
  });
  await page.goto('/');
  await selectPanelView(page, 'routing');
  await page.locator('[data-provider-check-core="xray"]').click();
  await page.locator('#provider-check-mode-manual').click();
  await page.locator('#provider-check-input').fill('vless://private@example.org:443');
  await page.locator('#provider-check-parse').click();
  const proxyButton = page.getByRole('button', { name: 'Проверить прокси' });
  await expect(proxyButton).toBeVisible();
  await proxyButton.click();
  await expect(proxyButton).toHaveClass(/is-loading/);
  await expect(page.locator('.xk-provider-check-proxy-status')).toContainText('Прокси работает · 86 мс');
  await expect(page.locator('.xk-provider-check-row-state')).toContainText('Не проверен');
  await expect(page.locator('#provider-check-resource-hint')).toContainText('Ссылка подписки выше нужна только для поиска серверов');
  const resourceButton = page.getByRole('button', { name: 'Сравнить доступ' });
  await resourceButton.click();
  await expect(page.locator('#provider-check-resource-feedback')).toContainText('например kino.watch');
  await expect(page.locator('#provider-check-resource-url')).toBeFocused();
  await page.locator('#provider-check-resource-url').fill('kino.watch');
  await expect(page.locator('#provider-check-resource-feedback')).toBeEmpty();
  await resourceButton.click();
  await expect(page.locator('#provider-check-resource-url')).toHaveValue('https://kino.watch/');
  await expect(resourceButton).toHaveClass(/is-loading/);
  await expect(page.locator('.xk-provider-check-resource-result')).toContainText('Проверяем kino.watch напрямую и через этот прокси');
  await expect(page.locator('#provider-check-status')).toContainText('Сравниваем доступ к kino.watch');
  finishComparison();
  await expect(page.locator('.xk-provider-check-resource-result')).toContainText('Сеть: Успешный ответ напрямую и через прокси');
  await expect(page.locator('.xk-provider-check-resource-result')).toContainText('Реестр сайта kino.watch: запись найдена');
  await expect(page.locator('#provider-check-status')).toContainText('Сравнение kino.watch завершено');
  await page.locator('.xk-provider-check-resource-result').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/provider-diagnostics-resource-desktop.png', fullPage: false });
});

test('Mihomo proxy check starts the selected engine and shows its result', async ({ page }) => {
  await page.route('**/api/provider-diagnostics/targets?core=mihomo', (route) => route.fulfill({ json: {
    ok: true, targets: [{ name: 'Private', host: 'edge.example.org', port: 443,
      network: 'tcp', protocol: 'vless', tls: true, tls_mode: 'standard', source: 'config.yaml',
      proxy_ref: 'mihomo-reference', proxy_index: 0, proxy_engine: 'mihomo' }],
  } }));
  await page.route('**/api/provider-diagnostics/proxy-probe', async (route) => {
    expect(route.request().postDataJSON()).toEqual({ ref: 'mihomo-reference', index: 0 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    return route.fulfill({ json: { ok: true, result: {
      status: 'ok', delay_ms: 54, message: 'Прокси передал HTTPS-запрос к контрольному адресу.',
    } } });
  });
  await page.goto('/');
  await selectPanelView(page, 'mihomo');
  await openMihomoConfig(page);
  await page.locator('[data-provider-check-core="mihomo"]').click();
  const proxyButton = page.getByRole('button', { name: 'Проверить прокси' });
  await expect(proxyButton).toHaveAttribute('data-tooltip', /Mihomo/);
  await proxyButton.click();
  await expect(proxyButton).toHaveClass(/is-loading/);
  await expect(page.locator('.xk-provider-check-proxy-status')).toContainText('Прокси работает · 54 мс');
});

test('resource comparison remains readable on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/provider-diagnostics/targets?core=mihomo', (route) => route.fulfill({ json: {
    ok: true, targets: [{ name: 'Private', host: 'edge.example.org', port: 443,
      network: 'tcp', protocol: 'vless', tls: true, source: 'config.yaml',
      proxy_ref: 'mihomo-reference', proxy_index: 0, proxy_engine: 'mihomo' }],
  } }));
  await page.route('**/api/provider-diagnostics/resource-compare', (route) => route.fulfill({ json: {
    ok: true, result: {
      status: 'ok', resource_host: 'kino.watch', network: { verdict: 'proxy_only', confidence: 'medium' },
      direct: { status: 'tls_error', connected_ip: '8.8.8.8', dns_ips: ['8.8.8.8'], tcp_ms: 30 },
      proxy: { status: 'http_response', connected_ip: '8.8.8.8', http_status: 200, tcp_ms: 50, tls_ms: 60 },
      registry: { status: 'ok', listed: true, match: 'kino.watch' },
    },
  } }));
  await page.goto('/');
  await selectPanelView(page, 'mihomo');
  await openMihomoConfig(page);
  await page.locator('[data-provider-check-core="mihomo"]').click();
  await page.locator('#provider-check-resource-url').fill('https://kino.watch/');
  await page.getByRole('button', { name: 'Сравнить доступ' }).click();
  await expect(page.locator('.xk-provider-check-resource-result')).toContainText('Через прокси доступен, напрямую нет');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  await expect(page.locator('.xk-provider-check-resource-result')).toBeInViewport();
  await page.screenshot({ path: 'test-results/provider-diagnostics-resource-mobile.png', fullPage: false });
});

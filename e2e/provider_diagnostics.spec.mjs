import { test, expect, selectPanelView, openMihomoConfig } from './fixtures.mjs';

const TARGETS = [
  { name: 'Edge', host: 'edge.example.org', port: 443, network: 'tcp', protocol: 'vless', source: '04_outbounds.json', tls: false },
  { name: 'AWG', host: 'awg.example', port: 51820, network: 'udp', protocol: 'wireguard', source: '04_outbounds.json', tls: false },
];

async function expectCompactDetailActions(page) {
  const geometry = await page.locator('.xk-provider-check-details').first().locator('.xk-provider-check-detail-actions').evaluate((container) => {
    const frame = container.getBoundingClientRect();
    const actions = [...container.querySelectorAll('button, a')].map((item) => item.getBoundingClientRect());
    return { right: frame.right, actions: actions.map((item) => ({ top: item.top, right: item.right })) };
  });
  expect(geometry.actions).toHaveLength(4);
  expect(Math.max(...geometry.actions.map((item) => item.top)) - Math.min(...geometry.actions.map((item) => item.top))).toBeLessThan(1);
  expect(Math.max(...geometry.actions.map((item) => item.right))).toBeLessThanOrEqual(geometry.right + 1);
}

test('Xray toolbar opens server diagnostics and runs selected checks', async ({ page }) => {
  await page.route('**/api/provider-diagnostics/targets?core=xray', (route) => route.fulfill({ json: { ok: true, targets: TARGETS } }));
  const checked = [];
  await page.route('**/api/provider-diagnostics/probe', (route) => {
    const target = route.request().postDataJSON();
    checked.push(target.host);
    return route.fulfill({ json: { ok: true, result: {
      ...target,
      status: target.network === 'udp' ? 'udp_unknown' : 'reachable',
      message: target.network === 'udp' ? 'Адрес разрешён.' : 'Соединение установлено.',
      addresses: ['198.51.100.10'],
      dns_ms: 9,
      tcp_ms: target.network === 'udp' ? undefined : 12,
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
  await page.goto('/');
  await selectPanelView(page, 'routing');
  await page.locator('[data-provider-check-core="xray"]').click();
  await expect(page.locator('#provider-check-modal')).toBeVisible();
  await expect(page.locator('.xk-provider-check-row')).toHaveCount(2);
  await expect(page.locator('#provider-check-run')).toBeEnabled();
  await page.locator('#provider-check-run').click();
  await expect(page.locator('#provider-check-status')).toContainText('проверено 2');
  await expect(page.locator('.xk-provider-check-row-state.is-reachable')).toHaveCount(1);
  await expect(page.locator('.xk-provider-check-row-state.is-udp_unknown')).toHaveCount(1);
  await page.locator('.xk-provider-check-details').first().locator('summary').click();
  await expect(page.locator('.xk-provider-check-details').first()).toContainText('DNS');
  await page.getByRole('button', { name: 'Сравнить DNS' }).first().click();
  await expect(page.locator('.xk-provider-check-dns-compare').first()).toContainText('Google DNS (A)');
  await page.getByRole('button', { name: 'Проверить списки' }).first().click();
  await expect(page.locator('.xk-provider-check-public-lists').first()).toContainText('Есть совпадение в списках');
  await expect(page.locator('.xk-provider-check-public-lists').first()).toContainText('AS64500');
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
  await page.locator('.xk-provider-check-details').first().locator('summary').click();
  await page.getByRole('button', { name: 'Проверить списки' }).first().click();
  await expect(page.locator('.xk-provider-check-public-lists').first()).toContainText('Совпадений в списках не найдено');
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

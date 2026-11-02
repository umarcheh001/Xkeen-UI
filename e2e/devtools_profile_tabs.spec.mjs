import { test, expect } from './fixtures.mjs';

// A profile without the Mihomo engine: the page lists no Mihomo tabs. The
// server side of that is covered by tests/test_devtools_profile_layout.py;
// here the full test panel serves the page the way a minimal profile gets it.
const HIDDEN = 'mihomo,mihomo-generator';

async function openAsXrayOnly(page) {
  await page.route('**/devtools', async (route) => {
    const response = await route.fetch();
    let html = await response.text();
    html = html.replace('data-hidden-sections=""', `data-hidden-sections="${HIDDEN}"`);
    // Without the link utility card the logging card is alone in its row.
    html = html.replace(/<details class="card dt-collapsible" id="dt-happ-decryptor-card"[\s\S]*?<\/details>\s*<\/div>\s*<\/details>/, '');
    html = html.replace('dt-logging-card dt-collapsible"', 'dt-logging-card dt-collapsible dt-card-wide"');
    html = html.replace(/<div class="dt-rename-row">\s*<span class="dt-rename-label">Роутинг Mihomo<\/span>[\s\S]*?<\/div>/, '');
    html = html.replace(/<div class="dt-rename-row">\s*<span class="dt-rename-label">Mihomo Генератор<\/span>[\s\S]*?<\/div>/, '');
    await route.fulfill({ response, body: html });
  });
  await page.goto('/devtools');
}

async function routerBranding(page, action, config) {
  return page.evaluate(async ({ action, config }) => {
    const token = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || '';
    const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': token };
    const url = action === 'reset' ? '/api/devtools/branding/reset' : '/api/devtools/branding';
    const init = action === 'get'
      ? { cache: 'no-store' }
      : { method: 'POST', headers, body: JSON.stringify(action === 'reset' ? {} : { config }) };
    const response = await fetch(url, init);
    return response.json();
  }, { action, config });
}

test.describe('DevTools on a profile without some panel tabs', () => {
  test('tab order lists only present tabs and keeps the places of absent ones', async ({ page }) => {
    await page.addInitScript(() => {
      if (sessionStorage.getItem('xk-test-seeded')) return;
      sessionStorage.setItem('xk-test-seeded', '1');
      localStorage.setItem('xkeen-layout-v1', JSON.stringify({
        tabOrder: ['view:routing', 'view:mihomo', 'view:xkeen', 'view:xray-logs', 'view:commands', 'view:files', 'id:top-tab-mihomo-generator', 'id:top-tab-donate'],
      }));
    });
    await openAsXrayOnly(page);

    const list = page.locator('#dt-layout-tab-list .dt-tab-item');
    await expect(list).toHaveCount(6);
    await expect(page.locator('#dt-layout-tab-list')).not.toContainText('Mihomo');

    // Move «Порты и Исключения» before «Роутинг Xray».
    await page.evaluate(() => {
      const ul = document.getElementById('dt-layout-tab-list');
      const src = ul.querySelector('[data-key="view:xkeen"]');
      const target = ul.querySelector('[data-key="view:routing"]');
      const dataTransfer = new DataTransfer();
      src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer }));
      target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer }));
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
      src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer }));
    });

    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('xkeen-layout-v1')).tabOrder);
    expect(saved).toEqual([
      'view:xkeen', 'view:mihomo', 'view:routing', 'view:xray-logs', 'view:commands', 'view:files', 'id:top-tab-mihomo-generator', 'id:top-tab-donate',
    ]);
  });

  test('logging card alone in its row spans it in two columns, one column on a phone', async ({ page }) => {
    await openAsXrayOnly(page);
    await expect(page.locator('#dt-happ-decryptor-card')).toHaveCount(0);

    const geometry = () => page.evaluate(() => {
      const rect = (el) => el.getBoundingClientRect();
      const card = document.getElementById('dt-logging-card');
      const zone = card.parentElement;
      return {
        card: rect(card).width,
        zone: rect(zone).width,
        level: rect(document.getElementById('dt-log-core-level')),
        rotate: rect(document.getElementById('dt-log-rotate-mb')),
        body: rect(card.querySelector('.dt-logging-grid')).width,
      };
    });

    const wide = await geometry();
    expect(Math.abs(wide.card - wide.zone)).toBeLessThanOrEqual(1);
    expect(Math.abs(wide.level.top - wide.rotate.top)).toBeLessThanOrEqual(1);
    expect(wide.rotate.left).toBeGreaterThan(wide.level.right);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(async () => (await geometry()).rotate.top > (await geometry()).level.bottom).toBe(true);
    const phone = await geometry();
    expect(Math.abs(phone.level.width - phone.body)).toBeLessThanOrEqual(1);
    expect(Math.abs(phone.rotate.width - phone.body)).toBeLessThanOrEqual(1);
  });

  test('saving tab names keeps the names of absent tabs', async ({ page }) => {
    await page.goto('/devtools');
    await routerBranding(page, 'save', { tabRename: { 'view:mihomo': 'Прокси', 'view:routing': 'Маршруты' } });
    try {
      await openAsXrayOnly(page);
      await expect(page.locator('#dt-branding-tab-rename input[data-tab-key="view:mihomo"]')).toHaveCount(0);
      const routing = page.locator('#dt-branding-tab-rename input[data-tab-key="view:routing"]');
      await expect(routing).toHaveValue('Маршруты');

      await routing.fill('Роутинг');
      await page.locator('#dt-branding-save').click();

      await expect.poll(async () => (await routerBranding(page, 'get')).config?.tabRename).toEqual({
        'view:mihomo': 'Прокси',
        'view:routing': 'Роутинг',
      });
    } finally {
      await routerBranding(page, 'reset');
    }
  });
});

import { test, expect } from '@playwright/test';


const editorContracts = [
  { editor: 'port-proxying-editor', save: 'port-proxying-save-btn', status: 'port-proxying-status', min: 156, max: 220 },
  { editor: 'port-exclude-editor', save: 'port-exclude-save-btn', status: 'port-exclude-status', min: 156, max: 220 },
  { editor: 'ip-exclude-editor', save: 'ip-exclude-save-btn', status: 'ip-exclude-status', min: 168, max: 240 },
  { editor: 'xkeen-config-editor', save: 'xkeen-config-save-btn', status: 'xkeen-config-status', min: 220, max: 320 },
];


async function mockPorts(page) {
  const payloads = {
    '/api/xkeen/port-proxying': '80\n443\n596:599\n',
    '/api/xkeen/port-exclude': '22\n25\n',
    '/api/xkeen/ip-exclude': '192.168.0.0/16\n2001:db8::/32\n',
    '/api/xkeen/config': '{\n  "xkeen": { "port": "80,443" }\n}\n',
  };

  await page.route('**/api/xkeen/**', async (route) => {
    const url = new URL(route.request().url());
    const content = payloads[url.pathname];
    if (content === undefined) {
      await route.fallback();
      return;
    }
    if (route.request().method() === 'POST') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, restarted: false }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, content }),
    });
  });
}


async function openPorts(page, theme, viewport) {
  await page.setViewportSize(viewport);
  await page.addInitScript((nextTheme) => {
    localStorage.setItem('xkeen-theme', nextTheme);
    localStorage.setItem('xkeen.editor.engine', 'codemirror');
  }, theme);
  await mockPorts(page);
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  await page.locator('.top-tab-btn[data-view="xkeen"]').click();
  await expect(page.locator('#view-xkeen')).toBeVisible();
  await expect(page.locator('#view-xkeen .xkeen-mini-editor')).toHaveCount(4);
  await expect(page.locator('#view-xkeen .xkeen-mini-editor .xkeen-cm6-host')).toHaveCount(4);
}


async function measurePorts(page) {
  return page.evaluate((contracts) => {
    const items = contracts.map((contract) => {
      const textarea = document.getElementById(contract.editor);
      const card = textarea.closest('.xkeen-mini-editor');
      const editor = card.querySelector('.xkeen-cm6-host, .CodeMirror:not(.xkeen-cm6-host), textarea:not([style*="display: none"])');
      const footer = card.querySelector('.xkeen-mini-footer');
      const status = document.getElementById(contract.status);
      const save = document.getElementById(contract.save);
      const cardRect = card.getBoundingClientRect();
      const editorRect = editor.getBoundingClientRect();
      const footerRect = footer.getBoundingClientRect();
      const statusRect = status.getBoundingClientRect();
      const saveRect = save.getBoundingClientRect();
      return {
        cardHeight: cardRect.height,
        editorHeight: editorRect.height,
        editorMin: Number.parseFloat(getComputedStyle(card).getPropertyValue('--xk-mini-editor-min')),
        editorMax: Number.parseFloat(getComputedStyle(card).getPropertyValue('--xk-mini-editor-max')),
        footerDisplay: getComputedStyle(footer).display,
        footerTop: footerRect.top,
        editorBottom: editorRect.bottom,
        statusCenter: statusRect.top + statusRect.height / 2,
        saveCenter: saveRect.top + saveRect.height / 2,
        saveHeight: saveRect.height,
        saveWidth: saveRect.width,
        footerWidth: footerRect.width,
      };
    });
    return {
      items,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  }, editorContracts);
}


test.describe('Operator Console Stage 4 ports', () => {
  for (const theme of ['dark', 'light']) {
    test(`bounded editors and compact footers in ${theme}`, async ({ page }) => {
      await openPorts(page, theme, { width: 1440, height: 900 });
      const layout = await measurePorts(page);

      expect(layout.overflow).toBeLessThanOrEqual(1);
      for (let index = 0; index < editorContracts.length; index += 1) {
        const contract = editorContracts[index];
        const item = layout.items[index];
        expect(item.editorMin).toBe(contract.min);
        expect(item.editorMax).toBe(contract.max);
        expect(item.editorHeight).toBeGreaterThanOrEqual(contract.min - 1);
        expect(item.editorHeight).toBeLessThanOrEqual(contract.max + 1);
        expect(item.footerDisplay).toBe('flex');
        expect(item.footerTop).toBeGreaterThanOrEqual(item.editorBottom + 7);
        expect(Math.abs(item.statusCenter - item.saveCenter)).toBeLessThanOrEqual(1);
        expect(item.saveHeight).toBeLessThanOrEqual(32.5);
        expect(item.saveWidth).toBeLessThan(item.footerWidth * 0.4);
      }

      expect(layout.items[0].cardHeight).toBeLessThan(360);
      expect(layout.items[0].cardHeight).not.toBe(layout.items[1].cardHeight);

      await page.locator('#port-proxying-save-btn').click();
      await expect(page.locator('#port-proxying-status')).toHaveText('port_proxying.lst сохранён.');
      await expect(page.locator('#port-proxying-save-btn')).toHaveText('Сохранить');
    });
  }

  test('mobile keeps bounded editors, footer actions and page width', async ({ page }) => {
    await openPorts(page, 'dark', { width: 390, height: 844 });
    const layout = await measurePorts(page);

    expect(layout.overflow).toBeLessThanOrEqual(1);
    for (const item of layout.items) {
      expect(item.editorHeight).toBeGreaterThanOrEqual(item.editorMin - 1);
      expect(item.editorHeight).toBeLessThanOrEqual(item.editorMax + 1);
      expect(item.footerTop).toBeGreaterThanOrEqual(item.editorBottom + 7);
      expect(item.saveHeight).toBeGreaterThanOrEqual(39.5);
      expect(item.saveWidth).toBeLessThan(item.footerWidth * 0.5);
    }
  });
});

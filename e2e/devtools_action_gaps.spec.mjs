import { test, expect } from './fixtures.mjs';

// DevTools: every row of buttons keeps the same gap, every row of small chips its own.
//
// 15.10.2026 the owner marked rows that drifted apart: 3.6 px (buttons set in a
// line, the gap was the space between tags), 5 px, 8 px against 12 px elsewhere.
// One token per kind now (operator-tokens.css: --op-gap-actions, --op-gap-chips);
// this test measures the real page so a new row with its own gap is caught.

const ACTIONS_GAP = 12;
const CHIPS_GAP = 6;

const READY = {
  path: '/opt/etc/xkeen-ui/bin/happ-decrypt-universal',
  kind: 'native',
  installed: true,
  version: 'happ-decrypt-universal v1.4.0 (8af0af5, 2026-09-15T10:00:00Z)',
  assets_dir: '/opt/etc/xkeen-ui/bin/happ-decrypt-universal.assets',
  keys: {
    formats: ['crypt', 'crypt2', 'crypt3', 'crypt4', 'crypt5'],
    crypt5_keys: { present: true, keys: 36, invalid: 0 },
    legacy_keys: { present: true, keys: 4, invalid: 0 },
  },
  keys_meta: null,
  platform: { arch: 'aarch64', opkg_arch: 'aarch64-3.10', endian: 'le', asset: 'happ-decrypt-universal-linux-arm64', supported: true },
  cmd_override: false,
};

// Tab strips, the update channel switch and the segments of the logs header
// (file, level, online) are segmented controls, not rows of separate buttons.
// The logs source chips are chips: they keep the chip gap of the Xray logs screen.
const NOT_A_BUTTON_ROW = ['top-tabs', 'dt-tabs', 'xk-summary-switch', 'xk-xlog-seg', 'xk-xlog-chiprow'];

async function buttonRows(page) {
  return page.evaluate((skip) => {
    const visible = (el) => !!el.offsetParent && el.getBoundingClientRect().width > 0;
    const isControl = (el) => el.matches('button, .dt-btn-like') && visible(el);
    const parents = new Set();
    document.querySelectorAll('button, .dt-btn-like').forEach((el) => {
      if (visible(el)) parents.add(el.parentElement);
    });
    const rows = [];
    for (const parent of parents) {
      if (parent.closest('.modal')) continue;
      if (skip.some((cls) => parent.classList.contains(cls))) continue;
      const controls = Array.from(parent.children).filter(isControl);
      const rects = controls.map((el) => el.getBoundingClientRect());
      const gaps = [];
      for (let i = 1; i < rects.length; i += 1) {
        // Only neighbours on one line: a wrapped button starts a new line.
        if (Math.abs(rects[i].top - rects[i - 1].top) < 4) gaps.push(Math.round(rects[i].left - rects[i - 1].right));
      }
      if (!gaps.length) continue;
      const card = parent.closest('[id]');
      rows.push({
        where: `${card ? '#' + card.id : '?'} .${String(parent.className).trim().split(/\s+/).join('.')}`,
        items: controls.map((el) => (el.textContent || '').trim()),
        gaps,
      });
    }
    return rows;
  }, NOT_A_BUTTON_ROW);
}

async function openAll(page) {
  await page.evaluate(() => document.querySelectorAll('details').forEach((d) => { d.open = true; }));
}

test('every row of buttons in DevTools keeps one gap on both tabs', async ({ page }) => {
  await page.route('**/api/happ-decryptor/status', (route) => route.fulfill({ json: { ok: true, status: READY } }));
  await page.goto('/devtools');
  await expect(page.locator('#dt-happ-install')).toHaveText('Переустановить движок');
  await openAll(page);

  const tools = await buttonRows(page);

  await page.locator('.top-tabs button', { hasText: 'Логи' }).click();
  await openAll(page);
  await page.waitForTimeout(300);
  const logs = await buttonRows(page);

  const rows = [...tools, ...logs];
  const wheres = rows.map((row) => row.where).join('\n');
  // The rows the owner marked must be among the measured ones.
  for (const marker of ['.dt-update-actions', '.dt-actions-grid', '.dt-branding-row', '.dt-logging-actions', '.dt-service-actions']) {
    expect(wheres, `ряд ${marker} не найден`).toContain(marker);
  }
  const off = rows.filter((row) => row.gaps.some((gap) => gap !== ACTIONS_GAP));
  expect(off, 'ряды кнопок с другим зазором').toEqual([]);
});

test('format chips of the subscription decryption card keep the chip gap', async ({ page }) => {
  await page.route('**/api/happ-decryptor/status', (route) => route.fulfill({ json: { ok: true, status: READY } }));
  await page.goto('/devtools#dt-happ-decryptor-card');
  await expect(page.locator('#dt-happ-formats code')).toHaveCount(5);

  const gaps = await page.locator('#dt-happ-formats code').evaluateAll((chips) => {
    const rects = chips.map((chip) => chip.getBoundingClientRect());
    return rects.slice(1).map((rect, i) => Math.round(rect.left - rects[i].right));
  });

  expect(gaps).toEqual([CHIPS_GAP, CHIPS_GAP, CHIPS_GAP, CHIPS_GAP]);
});

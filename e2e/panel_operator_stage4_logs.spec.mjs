import { test, expect } from '@playwright/test';


const restartLines = [
  '[2026-07-29 09:10:00] source=routing result=OK file=03_routing.json duration_ms=41\n',
  '[2026-07-29 09:12:00] source=xray-preflight result=FAIL file=04_outbounds.json phase=validation returncode=23 summary=invalid_rule\n',
];


async function mockLogs(page) {
  await page.route('**/api/xray-logs/status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ loglevel: 'warning' }),
    });
  });

  await page.route('**/api/xray-logs/devices**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [] }),
    });
  });

  await page.route('**/api/xray-logs?**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        mode: 'full',
        cursor: 'stage4-logs',
        lines: [
          '2026/07/29 09:00:00 [Warning] sample warning line',
          '2026/07/29 09:00:01 [Error] sample error line',
          '2026/07/29 09:00:02 [Warning] destination 192.0.2.15:443',
        ],
      }),
    });
  });

  await page.route('**/api/restart-log', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ lines: restartLines }),
    });
  });

  await page.route('**/api/ws-token', async (route) => {
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ ok: false }),
    });
  });
}


async function openLogs(page, theme, viewport) {
  await page.setViewportSize(viewport);
  await page.addInitScript((nextTheme) => {
    localStorage.setItem('xkeen-theme', nextTheme);
    localStorage.setItem('xkeen.editor.engine', 'codemirror');
  }, theme);
  await mockLogs(page);
  await page.goto('/');
  await page.locator('.top-tab-btn[data-view="xray-logs"]').click();
  await expect(page.locator('#view-xray-logs')).toBeVisible();
  await expect(page.locator('#xray-log-output')).toContainText('sample ERROR line');
  await expect(page.locator('[data-xk-restart-log="1"]').last()).toContainText('Xray preflight');
}


async function readLogsGeometry(page) {
  return page.evaluate(() => {
    const view = document.querySelector('#view-xray-logs');
    const filter = document.querySelector('.xk-log-filter-bar');
    const counters = document.querySelector('.xk-log-counters');
    const output = document.querySelector('#xray-log-output');
    const detail = Array.from(document.querySelectorAll('.restart-log-details')).at(-1) || null;
    const detailToggle = Array.from(document.querySelectorAll('.restart-log-details-toggle')).at(-1) || null;
    const state = document.querySelector('#xray-log-status');
    return {
      filterDisplay: filter ? getComputedStyle(filter).display : '',
      filterRadius: filter ? getComputedStyle(filter.querySelector('input')).borderRadius : '',
      countersDisplay: counters ? getComputedStyle(counters).display : '',
      counterCount: counters ? counters.querySelectorAll('.xk-log-counter').length : 0,
      outputBackground: output ? getComputedStyle(output).backgroundColor : '',
      outputHeight: output ? output.getBoundingClientRect().height : 0,
      detailDisplay: detail ? getComputedStyle(detail).display : '',
      detailToggleRadius: detailToggle ? getComputedStyle(detailToggle).borderRadius : '',
      stateTone: state?.dataset.tone || '',
      stateBorderLeft: state ? getComputedStyle(state).borderLeftWidth : '',
      viewOverflow: view ? view.scrollWidth - view.clientWidth : 999,
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
}


test.describe('Operator Console Stage 4 logs', () => {
  for (const theme of ['dark', 'light']) {
    test(`filters, counters and details share one contract in ${theme}`, async ({ page }) => {
      await openLogs(page, theme, { width: 1440, height: 900 });

      const toggle = page.locator('.restart-log-details-toggle').last();
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      await expect(page.locator('.restart-log-details').last()).toBeVisible();

      const geometry = await readLogsGeometry(page);
      expect(geometry.filterDisplay).toBe('grid');
      expect(geometry.filterRadius).toBe('6px');
      expect(geometry.countersDisplay).toBe('flex');
      expect(geometry.counterCount).toBeGreaterThanOrEqual(1);
      expect(geometry.outputHeight).toBeGreaterThanOrEqual(300);
      expect(geometry.detailDisplay).toBe('grid');
      expect(geometry.detailToggleRadius).toBe('4px');
      expect(geometry.stateBorderLeft).toBe('2px');
      expect(geometry.viewOverflow).toBeLessThanOrEqual(1);
      expect(geometry.pageOverflow).toBeLessThanOrEqual(1);
    });
  }

  test('context detail focuses the selected row', async ({ page }) => {
    await openLogs(page, 'dark', { width: 1440, height: 900 });

    await page.locator('#xray-log-output .log-line').nth(1).click({ button: 'right' });
    await expect(page.locator('#xray-line-menu')).toBeVisible();
    await page.locator('#xray-line-menu-context').click();
    await expect(page.locator('#xray-context-modal')).toBeVisible();
    await expect(page.locator('#xray-context-title')).toContainText('Контекст access.log');
    await expect(page.locator('#xray-context-output [data-context-focus="1"]')).toHaveCount(1);
    await expect(page.locator('#xray-context-output [data-context-focus="1"]')).toContainText('sample error line');
  });

  test('load failures use the same inline error row', async ({ page }) => {
    await openLogs(page, 'dark', { width: 1440, height: 900 });
    await page.route('**/api/xray-logs?**', async (route) => {
      await route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
    });
    await page.route('**/api/restart-log', async (route) => {
      await route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
    });

    await page.locator('#xray-log-clear-screen-btn').click();
    await page.locator('#xray-log-view-btn').click();
    await expect(page.locator('#xray-log-status')).toHaveAttribute('data-tone', 'error');
    await expect(page.locator('#xray-log-output [data-empty-state="title"]')).toContainText('Не удалось получить строки лога');

    await page.locator('.xk-xray-logs-log-card [data-xk-restart-log-action="refresh"]').click();
    const restart = page.locator('.xk-xray-logs-log-card [data-xk-restart-log="1"]');
    await expect(restart).toHaveAttribute('data-state', 'error');
    await expect(restart.locator('.restart-log-empty.is-error')).toContainText('Не удалось загрузить журнал');
  });

  test('mobile keeps the terminal readable without page overflow', async ({ page }) => {
    await openLogs(page, 'light', { width: 390, height: 844 });
    const geometry = await readLogsGeometry(page);
    expect(geometry.filterDisplay).toBe('grid');
    expect(geometry.outputHeight).toBeGreaterThanOrEqual(300);
    expect(geometry.viewOverflow).toBeLessThanOrEqual(1);
    expect(geometry.pageOverflow).toBeLessThanOrEqual(1);
  });
});

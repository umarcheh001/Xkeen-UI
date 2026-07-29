import { test, expect } from '@playwright/test';


async function openDevtools(page, theme, viewport) {
  await page.setViewportSize(viewport);
  await page.addInitScript((nextTheme) => {
    localStorage.setItem('xkeen-theme', nextTheme);
  }, theme);
  await page.goto('/devtools');
  await expect(page.locator('body')).toHaveClass(/\bdevtools-page\b/);
  await expect(page.locator('#dt-env-card')).toBeVisible();
  // ENV is intentionally deferred; its first group is also a stable signal
  // that the keep-alive screen bootstrap has finished restoring initial state.
  await expect(page.locator('.dt-env-group-toggle').first()).toBeVisible();
}


async function readOperatorGeometry(page) {
  return page.evaluate(() => {
    const rect = (selector) => document.querySelector(selector)?.getBoundingClientRect() || null;
    const style = (selector, pseudo = null) => getComputedStyle(document.querySelector(selector), pseudo);
    const representatives = [
      'body',
      '.dt-page-header',
      '.dt-tabs',
      '#dt-service-card',
      '#dt-env-card',
      '.dt-env-group-toggle',
    ];
    return {
      lastStylesheet: Array.from(document.querySelectorAll('link[rel="stylesheet"]')).at(-1)?.getAttribute('href') || '',
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      headerHeight: rect('.dt-page-header')?.height || 0,
      headerRadius: style('.dt-page-header').borderRadius,
      cardRadius: style('#dt-service-card').borderRadius,
      groupRadius: style('.dt-env-group-toggle').borderRadius,
      toolsColumns: style('.dt-tools-layout').gridTemplateColumns,
      envScrollOverflow: document.querySelector('.dt-env-scroll').scrollWidth - document.querySelector('.dt-env-scroll').clientWidth,
      bodyBackground: style('body').backgroundImage,
      gradients: representatives.filter((selector) => style(selector).backgroundImage !== 'none'),
      backdropFilters: representatives.filter((selector) => !['none', ''].includes(style(selector).backdropFilter)),
      tabMarker: style('.dt-top-tab.active').boxShadow,
      activePseudoDisplay: style('.dt-top-tab.active', '::after').display,
    };
  });
}


test.describe('DevTools Operator Console theme', () => {
  for (const theme of ['dark', 'light']) {
    test(`tools use flat operator chrome in ${theme}`, async ({ page }) => {
      await openDevtools(page, theme, { width: 1440, height: 900 });
      const geometry = await readOperatorGeometry(page);

      expect(geometry.lastStylesheet).toContain('/static/devtools-operator.css');
      expect(geometry.pageOverflow).toBeLessThanOrEqual(1);
      expect(geometry.headerHeight).toBeLessThanOrEqual(54);
      expect(geometry.headerRadius).toBe('12px 12px 0px 0px');
      expect(geometry.cardRadius).toBe('9px');
      expect(geometry.groupRadius).toBe('6px');
      const [sideWidth] = geometry.toolsColumns.split(' ').map(Number.parseFloat);
      expect(sideWidth).toBeGreaterThanOrEqual(400);
      expect(sideWidth).toBeLessThanOrEqual(440);
      expect(geometry.bodyBackground).toBe('none');
      expect(geometry.gradients).toEqual([]);
      expect(geometry.backdropFilters).toEqual([]);
      expect(geometry.tabMarker).toContain('inset');
      expect(geometry.activePseudoDisplay).toBe('none');
    });
  }

  test('logs keep the log canvas dominant without glass effects', async ({ page }) => {
    await openDevtools(page, 'dark', { width: 1440, height: 900 });
    await page.locator('#dt-tab-btn-logs').click();
    await expect(page.locator('#dt-tab-logs')).toBeVisible();

    const geometry = await page.evaluate(() => {
      const view = document.querySelector('#dt-log-view');
      const card = document.querySelector('.dt-logs-card');
      return {
        pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        viewHeight: view.getBoundingClientRect().height,
        viewBackgroundImage: getComputedStyle(view).backgroundImage,
        cardBackgroundImage: getComputedStyle(card).backgroundImage,
        viewRadius: getComputedStyle(view).borderRadius,
        intervalBackground: getComputedStyle(document.querySelector('.dt-log-interval')).backgroundColor,
        intervalRadius: getComputedStyle(document.querySelector('.dt-log-interval')).borderRadius,
      };
    });

    expect(geometry.pageOverflow).toBeLessThanOrEqual(1);
    expect(geometry.viewHeight).toBeGreaterThanOrEqual(420);
    expect(geometry.viewBackgroundImage).toBe('none');
    expect(geometry.cardBackgroundImage).toBe('none');
    expect(geometry.viewRadius).toBe('9px');
    expect(geometry.intervalBackground).toBe('rgba(0, 0, 0, 0)');
    expect(geometry.intervalRadius).toBe('6px');
  });

  test('ENV actions and portal tooltips stay inside operator chrome', async ({ page }) => {
    await openDevtools(page, 'dark', { width: 1440, height: 900 });

    const firstGroup = page.locator('.dt-env-group-toggle').first();
    if ((await firstGroup.getAttribute('aria-expanded')) !== 'true') {
      await firstGroup.click();
    }
    await expect(page.locator('.dt-env-row').first()).toBeVisible();

    const actionGeometry = await page.locator('.dt-env-row').first().evaluate((row) => {
      const cell = row.querySelector('td:nth-child(4)');
      const buttons = Array.from(cell.querySelectorAll('button'));
      const cellRect = cell.getBoundingClientRect();
      return {
        cellRight: cellRect.right,
        lastButtonRight: buttons.at(-1).getBoundingClientRect().right,
        tableRight: row.closest('table').getBoundingClientRect().right,
        actionTextAlign: getComputedStyle(cell).textAlign,
      };
    });
    expect(actionGeometry.lastButtonRight).toBeLessThanOrEqual(actionGeometry.cellRight + 1);
    expect(actionGeometry.lastButtonRight).toBeLessThanOrEqual(actionGeometry.tableRight + 1);
    expect(actionGeometry.cellRight - actionGeometry.lastButtonRight).toBeLessThanOrEqual(8);
    expect(actionGeometry.actionTextAlign).toBe('right');

    const interval = page.locator('.dt-log-interval');
    await page.locator('#dt-tab-btn-logs').click();
    await interval.hover();
    const tooltip = page.locator('#xk-tooltip-portal .xk-tooltip-bubble');
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toHaveCSS('background-color', 'rgb(32, 37, 45)');
    await expect(tooltip).toHaveCSS('border-radius', '6px');
    await expect(tooltip).toHaveCSS('backdrop-filter', 'none');
  });

  test('mobile contains the ENV table in its own scroller', async ({ page }) => {
    await openDevtools(page, 'light', { width: 390, height: 844 });
    const geometry = await readOperatorGeometry(page);

    expect(geometry.pageOverflow).toBeLessThanOrEqual(1);
    expect(geometry.envScrollOverflow).toBeGreaterThan(0);
    await expect(page.locator('.dt-env-scroll')).toHaveCSS('overflow-x', 'auto');
    await expect(page.locator('.dt-page-header')).toHaveCSS('border-radius', '9px 9px 0px 0px');
  });
});

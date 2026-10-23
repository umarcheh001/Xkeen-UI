import { test, expect } from './fixtures.mjs';


async function openDevtools(page, theme, viewport) {
  await page.setViewportSize(viewport);
  await page.addInitScript((nextTheme) => {
    localStorage.setItem('xkeen-theme', nextTheme);
  }, theme);
  await page.goto('/devtools');
  await expect(page.locator('body')).toHaveClass(/\bdevtools-page\b/);
  await expect(page.locator('#dt-env-card')).toBeVisible();
  // ENV is intentionally deferred; its first group is the stable signal that
  // the keep-alive screen bootstrap has finished restoring initial state.
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

      // The page shell shared with the modules screen and the Mihomo generator
      // comes last, right after the DevTools operator layer.
      expect(geometry.lastStylesheet).toContain('/static/page-shell.css');
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
      const box = document.querySelector('.xk-plog-box');
      const card = document.querySelector('.dt-logs-card');
      const level = document.querySelector('#dt-log-level-seg');
      return {
        pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        viewHeight: view.getBoundingClientRect().height,
        viewBackgroundImage: getComputedStyle(box).backgroundImage,
        cardBackgroundImage: getComputedStyle(card).backgroundImage,
        viewRadius: getComputedStyle(box).borderRadius,
        segHeight: level.getBoundingClientRect().height,
        segRadius: getComputedStyle(level).borderRadius,
      };
    });

    expect(geometry.pageOverflow).toBeLessThanOrEqual(1);
    expect(geometry.viewHeight).toBeGreaterThanOrEqual(420);
    expect(geometry.viewBackgroundImage).toBe('none');
    expect(geometry.cardBackgroundImage).toBe('none');
    expect(geometry.viewRadius).toBe('9px');
    // The header is the Xray logs screen's: 32 px controls, 6 px corners.
    expect(geometry.segHeight).toBe(32);
    expect(geometry.segRadius).toBe('6px');
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

    const online = page.locator('#dt-log-play');
    await page.locator('#dt-tab-btn-logs').click();
    await online.hover();
    const tooltip = page.locator('#xk-tooltip-portal .xk-tooltip-bubble');
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toHaveCSS('background-color', 'rgb(32, 37, 45)');
    await expect(tooltip).toHaveCSS('border-radius', '6px');
    await expect(tooltip).toHaveCSS('backdrop-filter', 'none');
  });

  test('dialogs put their buttons on the edges of the text block, mid-strip, at 13 px', async ({ page }) => {
    await openDevtools(page, 'dark', { width: 1440, height: 900 });
    await page.evaluate(() => {
      window.XKeen.ui.confirm({ title: 'Проверка', message: 'Текст окна.', okText: 'Подтвердить', cancelText: 'Отменить' });
    });
    const modal = page.locator('#confirm-modal:not(.hidden)');
    await expect(modal).toBeVisible();
    const geometry = await modal.locator('.modal-content').evaluate((element) => {
      const box = (node) => node.getBoundingClientRect();
      const body = box(element.querySelector('.modal-body'));
      const header = box(element.querySelector('.modal-header'));
      const strip = box(element.querySelector('.modal-actions'));
      const close = box(element.querySelector('.modal-close'));
      const title = box(element.querySelector('.modal-title'));
      const cancel = element.querySelector('#confirm-modal-cancel-btn');
      const ok = element.querySelector('#confirm-modal-ok-btn');
      return {
        titleLeft: Math.round(title.left - body.left),
        closeRight: Math.round(body.right - close.right),
        cancelLeft: Math.round(box(cancel).left - body.left),
        okRight: Math.round(body.right - box(ok).right),
        closeAbove: Math.round(close.top - header.top),
        closeBelow: Math.round(header.bottom - close.bottom),
        okAbove: Math.round(box(ok).top - strip.top),
        okBelow: Math.round(strip.bottom - box(ok).bottom),
        font: getComputedStyle(ok).fontSize,
        height: Math.round(box(ok).height),
      };
    });
    expect(geometry.titleLeft).toBe(0);
    expect(geometry.closeRight).toBe(0);
    expect(geometry.cancelLeft).toBe(0);
    expect(geometry.okRight).toBe(0);
    // The strip's own 1 px border sits on one side of the button.
    expect(Math.abs(geometry.closeAbove - geometry.closeBelow)).toBeLessThanOrEqual(1);
    expect(Math.abs(geometry.okAbove - geometry.okBelow)).toBeLessThanOrEqual(1);
    expect(geometry.font).toBe('13px');
    expect(geometry.height).toBe(34);
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

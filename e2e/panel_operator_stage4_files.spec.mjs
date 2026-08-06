import { test, expect } from './fixtures.mjs';


const leftItems = [
  { name: 'configs', type: 'dir', size: 0, perm: 'drwxr-xr-x', mtime: 1785312000 },
  { name: 'routing.json', type: 'file', size: 4096, perm: '-rw-r--r--', mtime: 1785312060 },
  { name: 'xray.log', type: 'file', size: 8192, perm: '-rw-r--r--', mtime: 1785312120 },
];


async function mockFiles(page, options = {}) {
  const emptyRight = options.emptyRight !== false;
  await page.route('**/api/capabilities', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        storageUsb: { enabled: false },
        remoteFs: { enabled: true, supported: true, arch: 'x86_64' },
      }),
    });
  });
  await page.route('**/api/fs/list?**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.searchParams.get('path') || '';
    const isRight = path === '/tmp' || path.includes('/tmp/mnt');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        path,
        roots: [],
        items: isRight && emptyRight ? [] : leftItems,
        space: { free: 1024 * 1024 * 1024, total: 2 * 1024 * 1024 * 1024 },
      }),
    });
  });
}


async function openFiles(page, theme, viewport) {
  await page.setViewportSize(viewport);
  await page.addInitScript((nextTheme) => {
    localStorage.setItem('xkeen-theme', nextTheme);
    localStorage.removeItem('xkeen.fm.panels.v1');
  }, theme);
  await mockFiles(page);
  await page.goto('/');
  await page.locator('.top-tab-btn[data-view="files"]').click();
  await expect(page.locator('#view-files')).toBeVisible();
  await expect(page.locator('.fm-panel[data-side="left"] .fm-row[data-name]')).toHaveCount(3);
  await expect(page.locator('.fm-panel[data-side="right"] .fm-empty')).toBeVisible();
}


async function geometry(page) {
  return page.evaluate(() => {
    const view = document.querySelector('#view-files');
    const toolbar = document.querySelector('.fm-panel-bar');
    const row = document.querySelector('.fm-row[data-name]');
    const empty = document.querySelector('.fm-empty');
    return {
      toolbarHeight: toolbar?.getBoundingClientRect().height || 0,
      rowHeight: row?.getBoundingClientRect().height || 0,
      rowRadius: row ? getComputedStyle(row).borderRadius : '',
      emptyBorderLeft: empty ? getComputedStyle(empty).borderLeftWidth : '',
      rowFontSize: row ? parseFloat(getComputedStyle(row).fontSize) : 0,
      activePanel: (() => {
        const panel = document.querySelector('.fm-panel-active');
        if (!panel) return null;
        const styles = getComputedStyle(panel);
        const list = panel.querySelector('.fm-list');
        const bar = panel.querySelector('.fm-panel-bar');
        return {
          borderColor: styles.borderTopColor,
          borderWidth: styles.borderTopWidth,
          background: styles.backgroundColor,
          boxShadow: styles.boxShadow,
          listBackground: list ? getComputedStyle(list).backgroundColor : '',
          barBackground: bar ? getComputedStyle(bar).backgroundColor : '',
        };
      })(),
      viewOverflow: view ? view.scrollWidth - view.clientWidth : 999,
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
}


test.describe('Operator Console Stage 4 files', () => {
  for (const theme of ['dark', 'light']) {
    test(`toolbar, rows and empty state share one contract in ${theme}`, async ({ page }) => {
      await openFiles(page, theme, { width: 1440, height: 900 });
      const g = await geometry(page);
      expect(g.toolbarHeight).toBeGreaterThanOrEqual(40);
      expect(g.toolbarHeight).toBeLessThanOrEqual(48);
      expect(g.rowHeight).toBeGreaterThanOrEqual(34);
      expect(g.rowFontSize).toBeGreaterThanOrEqual(13);
      expect(g.rowRadius).toBe('0px');
      expect(g.emptyBorderLeft).toBe('2px');
      expect(g.activePanel.borderWidth).toBe('1px');
      expect(g.activePanel.borderColor).not.toBe('rgba(0, 0, 0, 0)');
      expect(g.activePanel.boxShadow).not.toBe('none');
      expect(g.activePanel.listBackground).not.toBe(g.activePanel.background);
      expect(g.activePanel.barBackground).not.toBe(g.activePanel.background);
      expect(g.viewOverflow).toBeLessThanOrEqual(1);
      expect(g.pageOverflow).toBeLessThanOrEqual(1);
    });
  }

  test('bookmark actions use centered Operator icons without presentation emoji', async ({ page }) => {
    await openFiles(page, 'dark', { width: 1440, height: 900 });
    const controls = page.locator('.fm-panel[data-side="left"] .fm-panel-bar');
    await expect(controls.locator('.fm-bookmarks-control .xk-action-icon')).toBeVisible();
    await expect(controls.locator('.fm-bookmarks-add .xk-action-icon')).toBeVisible();
    await expect(controls.locator('.fm-bookmarks-edit .xk-action-icon')).toBeVisible();

    const geometry = await controls.locator('.fm-bookmarks-control').evaluate((control) => {
      const icon = control.querySelector('.xk-action-icon');
      const outer = control.getBoundingClientRect();
      const inner = icon.getBoundingClientRect();
      return {
        deltaX: Math.abs((inner.left + inner.width / 2) - (outer.left + outer.width / 2)),
        deltaY: Math.abs((inner.top + inner.height / 2) - (outer.top + outer.height / 2)),
      };
    });
    expect(geometry.deltaX).toBeLessThanOrEqual(1);
    expect(geometry.deltaY).toBeLessThanOrEqual(1);

    await controls.locator('.fm-bookmarks-edit').click();
    const modal = page.locator('#fm-bookmarks-modal');
    await expect(modal).toBeVisible();
    await expect(modal.locator('.modal-close .xk-action-icon')).toBeVisible();
    await expect(modal.locator('#fm-bookmarks-add-current-btn .xk-action-icon')).toBeVisible();
    await expect(modal).not.toContainText('⭐');
    await expect(modal).not.toContainText('📌');
  });

  test('bottom file actions keep their icon and persistent text label together', async ({ page }) => {
    await openFiles(page, 'dark', { width: 1440, height: 900 });

    const actions = [
      ['#fm-help-btn', 'Справка'],
      ['#fm-mkdir-btn', 'Новая папка'],
      ['#fm-touch-btn', 'Новый файл'],
      ['#fm-upload-btn', 'Загрузить'],
      ['#fm-download-btn', 'Скачать'],
    ];

    for (const [selector, label] of actions) {
      const action = page.locator(selector);
      await expect(action).toBeVisible();
      await expect(action.locator('.xk-action-icon')).toBeVisible();
      await expect(action.locator('.xk-action-label')).toHaveText(label);
    }

    const layout = await page.locator('#fm-mkdir-btn').evaluate((button) => {
      const icon = button.querySelector('.xk-action-icon')?.getBoundingClientRect();
      const label = button.querySelector('.xk-action-label')?.getBoundingClientRect();
      return { iconRight: icon?.right || 0, labelLeft: label?.left || 0 };
    });
    expect(layout.iconRight).toBeLessThan(layout.labelLeft);
  });

  test('selection and keyboard focus remain distinct and accessible', async ({ page }) => {
    await openFiles(page, 'dark', { width: 1440, height: 900 });
    const list = page.locator('.fm-panel[data-side="left"] .fm-list');
    const first = list.locator('.fm-row[data-name]').first();
    const second = list.locator('.fm-row[data-name]').nth(1);

    await first.click();
    await expect(first).toHaveAttribute('aria-selected', 'true');
    await expect(first).toHaveClass(/is-focused/);
    await second.click({ modifiers: ['ControlOrMeta'] });
    await expect(first).toHaveAttribute('aria-selected', 'true');
    await expect(second).toHaveAttribute('aria-selected', 'true');
    await expect(list).toHaveAttribute('aria-activedescendant', await second.getAttribute('id'));
    await list.focus();
    await list.press('ArrowUp');
    await expect(first).toHaveClass(/is-focused/);
  });

  test('drag source and destination publish explicit visual state', async ({ page }) => {
    await openFiles(page, 'dark', { width: 1440, height: 900 });
    const source = page.locator('.fm-panel[data-side="left"] .fm-row[data-name="routing.json"]');
    const targetList = page.locator('.fm-panel[data-side="right"] .fm-list');

    await page.evaluate(() => {
      const sourceRow = document.querySelector('.fm-panel[data-side="left"] .fm-row[data-name="routing.json"]');
      const sourceList = sourceRow.closest('.fm-list');
      sourceRow.classList.add('is-dragging');
      sourceList.dataset.dragCount = '1';
      const target = document.querySelector('.fm-panel[data-side="right"] .fm-list');
      target.classList.add('is-drop-target');
      target.dataset.dropState = 'panel';
      target.dataset.dropEffect = 'Переместить';
    });

    await expect(source).toHaveClass(/is-dragging/);
    await expect(targetList).toHaveClass(/is-drop-target/);
    await expect(targetList).toHaveAttribute('data-drop-state', 'panel');
    await expect(targetList).toHaveAttribute('data-drop-effect', 'Переместить');
  });

  test('bottom grip resizes height without changing width', async ({ page }) => {
    await openFiles(page, 'dark', { width: 1440, height: 1400 });
    const card = page.locator('.fm-card');
    const grip = page.locator('.fm-resize-handle-bottom');
    await expect(grip).toBeVisible();

    const before = await card.boundingBox();
    const box = await grip.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 260, { steps: 10 });
    await page.mouse.up();
    const after = await card.boundingBox();

    expect(after.height).toBeGreaterThan(before.height + 220);
    expect(after.height).toBeGreaterThan(760);
    expect(Math.abs(after.width - before.width)).toBeLessThanOrEqual(2);
  });

  test('mobile stacks panels without page overflow', async ({ page }) => {
    await openFiles(page, 'light', { width: 390, height: 844 });
    const g = await geometry(page);
    expect(g.viewOverflow).toBeLessThanOrEqual(1);
    expect(g.pageOverflow).toBeLessThanOrEqual(1);
  });
});

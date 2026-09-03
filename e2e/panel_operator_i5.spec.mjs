import { test, expect } from './fixtures.mjs';

const TOP_LEVEL_VIEWS = ['routing', 'xkeen', 'commands', 'files'];

// Части экрана, которые зависят от машины и момента запуска, а не от вёрстки:
// отметка времени последней проверки ядер и всё, что файловый менеджер читает
// с реальной файловой системы (листинги, пути, свободное место, статус lftp).
// Без масок эталон закреплял бы состояние конкретного компьютера.
const SNAPSHOT_MASKS = {
  commands: ['#cores-checked-at'],
  files: ['.fm-list', '.fm-path-input', '#fm-footer-status', '#fm-disabled-note'],
};

async function openPanel(page, theme, viewport = { width: 1440, height: 900 }) {
  await page.setViewportSize(viewport);
  await page.addInitScript((nextTheme) => {
    localStorage.setItem('xkeen-theme', nextTheme);
    localStorage.setItem('xkeen.editor.engine', 'codemirror');
  }, theme);
  await page.goto('/');
  await expect(page.locator('body')).toHaveClass(/\bpanel-page\b/);
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  // Пока статус ядра грузится, панель держит его кнопку выключенной, а
  // выключение уносит фокус. Тесты ниже фокусируют первую кнопку шапки, так
  // что ждём устоявшегося состояния — иначе меряем момент загрузки.
  await expect(page.locator('#xkeen-core-text')).toBeEnabled();
  await page.evaluate(() => document.fonts?.ready);
}

async function freezeAnimations(page) {
  await page.addStyleTag({
    content: `*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }`,
  });
}

async function expectNoOverflow(page) {
  const width = await page.evaluate(() => Math.max(document.body.scrollWidth, document.documentElement.scrollWidth));
  expect(width).toBeLessThanOrEqual(await page.evaluate(() => window.innerWidth) + 1);
}

test.describe('Operator Console I5 accessibility and responsive contract', () => {
  for (const theme of ['dark', 'light']) {
    test(`operator icons keep monochrome state contract in ${theme}`, async ({ page }) => {
      await openPanel(page, theme);
      const result = await page.locator('.xk-action-icon').evaluateAll((nodes) => {
        const node = nodes.find((candidate) => candidate.getBoundingClientRect().width > 0) || nodes[0];
        const style = getComputedStyle(node);
        const use = node.querySelector('use');
        return {
          width: node.getBoundingClientRect().width,
          height: node.getBoundingClientRect().height,
          fill: style.fill,
          stroke: style.stroke,
          strokeWidth: style.strokeWidth,
          href: use?.getAttribute('href') || '',
        };
      });
      expect(result.width).toBeGreaterThanOrEqual(15);
      expect(result.width).toBeLessThanOrEqual(22);
      expect(result.height).toBeGreaterThanOrEqual(15);
      expect(result.height).toBeLessThanOrEqual(22);
      expect(result.fill).toBe('none');
      expect(result.stroke).not.toBe('none');
      expect(Number.parseFloat(result.strokeWidth)).toBeCloseTo(1.75, 2);
      expect(result.href).toMatch(/^\/static\/icons\/operator\.svg(?:\?[^#]+)?#xk-/);

      const unnamed = await page.locator('button:visible, [role="button"]:visible, a[href]:visible, summary:visible').evaluateAll((nodes) => nodes
        .filter((node) => node.querySelector('.xk-action-icon'))
        .filter((node) => !((node.getAttribute('aria-label') || node.getAttribute('title') || node.getAttribute('data-tooltip') || node.textContent || '').trim()))
        .map((node) => node.id || node.className));
      expect(unnamed).toEqual([]);
    });

    test(`keyboard focus, hover tooltip and zoom remain usable in ${theme}`, async ({ page }) => {
      await openPanel(page, theme);
      const iconButton = page.locator('button:has(.xk-action-icon)[aria-label], button:has(.xk-action-icon)[data-tooltip]').first();
      await expect(iconButton).toBeVisible();
      await iconButton.focus();
      const focus = await iconButton.evaluate((node) => {
        const style = getComputedStyle(node);
        return { outlineWidth: style.outlineWidth, outlineStyle: style.outlineStyle };
      });
      expect(focus.outlineStyle).toBe('solid');
      expect(Number.parseFloat(focus.outlineWidth)).toBeGreaterThanOrEqual(2);

      await page.evaluate(() => { document.documentElement.style.zoom = '1.25'; });
      await expectNoOverflow(page);
      await page.evaluate(() => { document.documentElement.style.zoom = '1.5'; });
      await expectNoOverflow(page);
    });
  }

  test('forced-colors keeps operator SVG and visible focus usable', async ({ page }) => {
    await page.emulateMedia({ forcedColors: 'active' });
    await openPanel(page, 'dark');
    const icon = page.locator('.xk-action-icon:visible').first();
    await expect(icon).toBeVisible();
    // Chromium maps SVG paint values to system colors in forced-colors mode,
    // so computed fill/stroke is not a stable contract. Visibility and the
    // focus assertion below verify the user-perceived accessible fallback.
    const focusable = page.locator('button, [role="button"], a[href], summary').first();
    await focusable.focus();
    // The ring comes from our own forced-colors block, not from whatever the
    // browser happens to draw by default: that default changed once already
    // and took the assertion with it.
    await expect(focusable).toHaveCSS('outline-style', 'solid');
    const width = await focusable.evaluate((node) => Number.parseFloat(getComputedStyle(node).outlineWidth));
    expect(width).toBeGreaterThanOrEqual(2);
  });

  test('mobile controls use 40px targets without glyph scaling or page overflow', async ({ page }) => {
    await openPanel(page, 'dark', { width: 390, height: 844 });
    const geometry = await page.locator('.btn-icon:visible, .icon-only:visible, .xk-icon-btn:visible, .xkeen-cm-tool:visible').first().evaluate((node) => ({
      control: Math.min(node.getBoundingClientRect().width, node.getBoundingClientRect().height),
      glyph: node.querySelector('.xk-action-icon')?.getBoundingClientRect().width || 0,
    }));
    expect(geometry.control).toBeGreaterThanOrEqual(40);
    expect(geometry.glyph).toBeGreaterThanOrEqual(15);
    expect(geometry.glyph).toBeLessThanOrEqual(22);
    await expectNoOverflow(page);
  });

  test('visual regression snapshots cover representative views and editor modal', async ({ page }) => {
    await openPanel(page, 'dark');
    await freezeAnimations(page);
    for (const view of TOP_LEVEL_VIEWS) {
      await page.locator(`.top-tab-btn[data-view="${view}"]`).click();
      await expect(page.locator(`#view-${view}`)).toBeVisible();
      await expect(page.locator(`#view-${view}`)).toHaveScreenshot(`i5-${view}-dark-desktop.png`, {
        animations: 'disabled',
        caret: 'hide',
        maxDiffPixels: 300,
        mask: (SNAPSHOT_MASKS[view] || []).map((selector) => page.locator(`#view-${view} ${selector}`)),
      });
    }

    await page.locator('.top-tab-btn[data-view="routing"]').click();
    const outboundsBody = page.locator('#outbounds-body');
    if (!(await outboundsBody.isVisible())) await page.locator('#outbounds-header').click();
    await page.locator('#outbounds-open-editor-btn').click();
    await expect(page.locator('#json-editor-modal')).toBeVisible();
    await expect(page.locator('#json-editor-modal .modal-content')).toHaveScreenshot('i5-editor-workbench-dark-desktop.png', {
      animations: 'disabled',
      caret: 'hide',
      maxDiffPixels: 180,
    });
  });
});

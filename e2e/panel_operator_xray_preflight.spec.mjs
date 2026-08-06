import { test, expect } from './fixtures.mjs';

async function openPanel(page, theme = 'dark', viewport = { width: 1440, height: 900 }) {
  await page.setViewportSize(viewport);
  await page.addInitScript((nextTheme) => localStorage.setItem('xkeen-theme', nextTheme), theme);
  await page.goto('/');
  await expect(page.locator('body')).toHaveClass(/\bpanel-page\b/);
}

async function showPreflight(page, payload) {
  await page.evaluate(async (nextPayload) => {
    if (typeof window.XKeen?.ui?.showXrayPreflightError !== 'function') {
      await import('/static/js/ui/xray_preflight_modal.js');
    }
    window.XKeen.ui.showXrayPreflightError(nextPayload);
  }, payload);
  await expect(page.locator('#xray-preflight-modal')).toBeVisible();
}

test('Xray preflight uses the flat compact Operator diagnostic without an empty output column', async ({ page }) => {
  await openPanel(page);
  await showPreflight(page, {
    phase: 'xray_test',
    returncode: null,
    timeout_s: 30,
    error: 'xray binary not found',
    hint: 'Не найден бинарник Xray для preflight-проверки.',
  });

  const modal = page.locator('#xray-preflight-modal');
  await expect(modal).not.toHaveClass(/\bhas-output\b/);
  await expect(modal.locator('[data-xk-preflight-output-panel]')).toBeHidden();
  await expect(modal.locator('[data-operator-dismiss-duplicate="true"]')).toBeHidden();
  await expect(modal.locator('[data-xk-preflight-copy] .xk-action-icon')).toBeVisible();

  const style = await modal.locator('.xk-preflight-modal').evaluate((node) => {
    const frame = getComputedStyle(node);
    const lead = getComputedStyle(node.querySelector('.xk-preflight-lead'));
    const grid = getComputedStyle(node.querySelector('.xk-preflight-grid'));
    return {
      width: node.getBoundingClientRect().width,
      backgroundImage: frame.backgroundImage,
      leadBackgroundImage: lead.backgroundImage,
      columns: grid.gridTemplateColumns.split(' ').length,
    };
  });
  expect(style.width).toBeLessThanOrEqual(762);
  expect(style.backgroundImage).toBe('none');
  expect(style.leadBackgroundImage).toBe('none');
  expect(style.columns).toBe(1);
});

test('Xray preflight opens its output pane only when diagnostic output exists', async ({ page }) => {
  await openPanel(page, 'light');
  await showPreflight(page, {
    phase: 'xray_test',
    returncode: 23,
    timeout_s: 30,
    stderr: 'Failed to start: outbound tag is missing',
    error: 'xray preflight failed',
  });

  const modal = page.locator('#xray-preflight-modal');
  await expect(modal).toHaveClass(/\bhas-output\b/);
  await expect(modal.locator('[data-xk-preflight-output-panel]')).toBeVisible();
  const columns = await modal.locator('.xk-preflight-grid').evaluate(
    (node) => getComputedStyle(node).gridTemplateColumns.split(' ').length,
  );
  expect(columns).toBe(2);
});

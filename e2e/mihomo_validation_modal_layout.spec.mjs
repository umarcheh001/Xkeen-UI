import { test, expect } from './fixtures.mjs';

const ROUTING_VALIDATION_MODAL = '#mihomo-validation-modal';

async function openRoutingMihomoValidation(page) {
  await page.route('**/api/mihomo/validate_raw', async (route) => {
    await route.fulfill({
      json: {
        ok: true,
        log: 'configuration test is successful\n',
      },
    });
  });

  await page.goto('/');
  await page.locator('.top-tab-btn[data-view="mihomo"]').click();
  await expect(page.locator('#view-mihomo')).toBeVisible();
  await page.locator('#mihomo-clash-tab-config').click();
  await expect.poll(() => page.evaluate(() => (
    typeof window.XKeen?.features?.mihomoPanel?.setEditorText === 'function'
  ))).toBe(true);

  await page.evaluate(() => {
    window.XKeen.features.mihomoPanel.setEditorText('mixed-port: 7890\n');
  });
  await page.locator('details.xk-mihomo-menu > summary').click();
  await page.locator('#mihomo-validate-btn').click();
  await expect(page.locator(ROUTING_VALIDATION_MODAL)).toBeVisible();
}

test('routing Mihomo validation uses the flat operator diagnostic', async ({ page }) => {
  await openRoutingMihomoValidation(page);

  await expect(page.locator(`${ROUTING_VALIDATION_MODAL} .modal-content`)).toHaveCSS('background-image', 'none');
  await expect(page.locator(`${ROUTING_VALIDATION_MODAL} .xk-mihomo-validation-state-badge`)).toHaveCSS('border-radius', '6px');
  await expect(page.locator(`${ROUTING_VALIDATION_MODAL} .xk-mihomo-validation-grid`)).toHaveCSS('border-radius', '9px');

  const geometry = await page.locator(ROUTING_VALIDATION_MODAL).evaluate((modal) => {
    const body = modal.querySelector('.xk-mihomo-validation-body');
    const grid = modal.querySelector('#mihomo-validation-grid');
    const bodyRect = body.getBoundingClientRect();
    const gridRect = grid.getBoundingClientRect();
    return Math.round(bodyRect.bottom - gridRect.bottom);
  });
  expect(geometry).toBeLessThanOrEqual(16);
});

test('routing Mihomo validation is fullscreen with one scroll region on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openRoutingMihomoValidation(page);

  const layout = await page.locator(ROUTING_VALIDATION_MODAL).evaluate((modal) => {
    const content = modal.querySelector('.modal-content');
    const body = modal.querySelector('.xk-mihomo-validation-body');
    const footer = modal.querySelector('.xk-mihomo-validation-footer');
    const contentRect = content.getBoundingClientRect();
    const bodyRect = body.getBoundingClientRect();
    const footerRect = footer.getBoundingClientRect();
    return {
      contentHeight: Math.round(contentRect.height),
      viewportHeight: window.innerHeight,
      bodyOverflows: getComputedStyle(body).overflowY,
      footerHeight: Math.round(footerRect.height),
      bodyHeight: Math.round(bodyRect.height),
    };
  });

  expect(layout.contentHeight).toBe(layout.viewportHeight);
  expect(layout.bodyOverflows).toBe('auto');
  expect(layout.footerHeight).toBe(50);
  expect(layout.bodyHeight).toBeGreaterThan(0);
});

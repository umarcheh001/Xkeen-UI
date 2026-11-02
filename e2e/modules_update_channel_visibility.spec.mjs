import { readFileSync } from 'node:fs';

import { test, expect } from './fixtures.mjs';


const PROFILE = String(process.env.XKEEN_E2E_MODULE_PROFILE || 'full').toLowerCase();
const server = JSON.parse(readFileSync(new URL('./fixtures/module_manager_server.json', import.meta.url), 'utf8'));


test(`Modules screen shows the update channel in its summary: ${PROFILE}`, async ({ page }) => {
  let selected = 'stable';
  await page.route('**/api/modules/installed', (route) => route.fulfill({
    json: { ...server.installed, update_channel: selected },
  }));
  await page.route('**/api/modules/operations/status', (route) => route.fulfill({ json: server.status_none }));
  await page.route('**/api/modules/update-channel', (route) => {
    if (route.request().method() === 'POST') selected = route.request().postDataJSON().channel;
    return route.fulfill({ json: { ok: true, channel: selected } });
  });

  await page.goto('/modules');

  // The summary is the same as the DevTools card: the channel is switched in
  // both, and DevTools is there in every module set.
  const channel = page.locator('.modules-summary .xk-summary-switch');
  await expect(channel).toHaveCount(1);
  await expect(page.locator('body')).toHaveAttribute('data-xk-devtools-available', '1');

  {
    const prerelease = channel.locator('button[data-channel="prerelease"]');
    await prerelease.click();
    await expect(page.locator('#confirm-modal')).toBeVisible();
    // The frame is the DevTools one (page-shell.css): buttons on the edges of
    // the text block, in the middle of their strip, 13 px.
    const modalStyle = await page.locator('#confirm-modal .modal-content').evaluate((element) => {
      const box = (node) => node.getBoundingClientRect();
      const body = box(element.querySelector('.modal-body'));
      const strip = box(element.querySelector('.modal-actions'));
      const cancel = element.querySelector('#confirm-modal-cancel-btn');
      const ok = element.querySelector('#confirm-modal-ok-btn');
      return {
        radius: getComputedStyle(element).borderRadius,
        actionRadius: getComputedStyle(ok).borderRadius,
        actionFont: getComputedStyle(ok).fontSize,
        leftGap: Math.round(box(cancel).left - body.left),
        rightGap: Math.round(body.right - box(ok).right),
        above: Math.round(box(ok).top - strip.top),
        below: Math.round(strip.bottom - box(ok).bottom),
      };
    });
    expect(modalStyle.radius).toBe('12px');
    expect(modalStyle.actionRadius).toBe('6px');
    expect(modalStyle.actionFont).toBe('13px');
    expect(modalStyle.leftGap).toBe(0);
    expect(modalStyle.rightGap).toBe(0);
    expect(Math.abs(modalStyle.above - modalStyle.below)).toBeLessThanOrEqual(1);
    await page.locator('#confirm-modal-ok-btn').click();
    await expect(prerelease).toHaveAttribute('aria-pressed', 'true');
    expect(selected).toBe('prerelease');
  }
});

test('local builds still allow changing the selected update channel', async ({ page }) => {
  let selected = 'stable';
  let changes = 0;
  await page.route('**/api/modules/installed', (route) => route.fulfill({
    json: {
      ...server.installed,
      update_channel: selected,
      panel_version: null,
      lifecycle: { available: false, code: 'panel_version_unsupported' },
    },
  }));
  await page.route('**/api/modules/operations/status', (route) => route.fulfill({ json: server.status_none }));
  await page.route('**/api/modules/update-channel', (route) => {
    if (route.request().method() === 'POST') {
      selected = route.request().postDataJSON().channel;
      changes += 1;
    }
    return route.fulfill({ json: { ok: true, channel: selected } });
  });

  await page.goto('/modules');
  const channel = page.locator('.modules-summary .xk-summary-switch');
  await expect(channel.locator('button[data-channel="stable"]')).toBeEnabled();
  await channel.locator('button[data-channel="prerelease"]').click();
  await expect(page.locator('#confirm-modal')).toBeVisible();
  await page.locator('#confirm-modal-ok-btn').click();
  await expect(channel.locator('button[data-channel="prerelease"]')).toHaveAttribute('aria-pressed', 'true');
  expect(changes).toBe(1);
  expect(selected).toBe('prerelease');
});

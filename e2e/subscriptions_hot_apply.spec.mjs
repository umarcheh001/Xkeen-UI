import { test, expect } from './fixtures.mjs';
import { openSubscriptionsModal } from './subscriptions_modal_support.mjs';

async function routeSetup(page, { failure = false, dropResponse = false } = {}) {
  let enabled = false;
  const requests = [];
  await page.route('**/api/xray/subscriptions', (route) => route.fulfill({ json: { ok: true, subscriptions: [] } }));
  await page.route('**/api/xray/subscriptions/hot-apply', async (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      requests.push(body);
      if (failure) return route.fulfill({ status: 409, json: { ok: false, error: 'Xray не подтвердил конфигурацию API. Файлы восстановлены.' } });
      enabled = body.enabled;
      if (dropResponse) return route.abort();
    }
    return route.fulfill({ json: {
      ok: true, enabled, ready: enabled, restart_required: !enabled,
      message: enabled ? 'Включено для всех подписок Xray.' : 'При включении панель настроит локальный API и один раз перезапустит Xray.',
    } });
  });
  return requests;
}

test('one click configures hot apply for all subscriptions without saving the form', async ({ page }) => {
  const requests = await routeSetup(page);
  await openSubscriptionsModal(page);
  const toggle = page.locator('#outbounds-subscriptions-hot-apply');
  const label = page.locator('.xk-sub-hot-apply-switch');
  await expect(toggle).toBeEnabled();
  await expect(page.locator('#outbounds-subscriptions-hot-apply-status')).toContainText('один раз');
  await label.click();
  await expect(toggle).toBeChecked();
  await expect(toggle).toBeEnabled();
  await expect(page.locator('#outbounds-subscriptions-hot-apply-status')).toContainText('Включено для всех');
  await label.click();
  await expect(toggle).not.toBeChecked();
  expect(requests).toEqual([{ enabled: true }, { enabled: false }]);
  await expect(page.locator('#outbounds-subscriptions-url')).toHaveValue('');
  await page.locator('#outbounds-subscriptions-close-btn').click();
  await expect(page.locator('#confirm-modal')).toHaveClass(/hidden/);
});

test('failed setup restores the switch and displays the server error', async ({ page }) => {
  await routeSetup(page, { failure: true });
  await openSubscriptionsModal(page);
  await expect(page.locator('#outbounds-subscriptions-hot-apply')).toBeEnabled();
  await page.locator('.xk-sub-hot-apply-switch').click();
  await expect(page.locator('#outbounds-subscriptions-hot-apply')).not.toBeChecked();
  await expect(page.locator('#outbounds-subscriptions-hot-apply-status')).toContainText('Файлы восстановлены');
  await expect(page.locator('#outbounds-subscriptions-hot-apply')).toBeEnabled();
});

test('a lost setup response reads the outcome without repeating the operation', async ({ page }) => {
  const requests = await routeSetup(page, { dropResponse: true });
  await openSubscriptionsModal(page);
  await expect(page.locator('#outbounds-subscriptions-hot-apply')).toBeEnabled();
  await page.locator('.xk-sub-hot-apply-switch').click();
  await expect(page.locator('#outbounds-subscriptions-hot-apply-status')).toContainText('Включено для всех');
  expect(requests).toEqual([{ enabled: true }]);
});

for (const theme of ['dark', 'light']) {
  for (const width of [390, 850]) {
    test(`hot apply and help fit ${theme} theme at ${width}px`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 950 });
      await routeSetup(page);
      await openSubscriptionsModal(page);
      await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
      const geometry = await page.locator('.xk-sub-hot-apply').evaluate((row) => {
        const bounds = row.getBoundingClientRect();
        return {
          fits: row.scrollWidth <= row.clientWidth + 1,
          controls: [...row.children].every((node) => {
            const box = node.getBoundingClientRect();
            return box.left >= bounds.left && box.right <= bounds.right + 1;
          }),
        };
      });
      expect(geometry).toEqual({ fits: true, controls: true });
      const styles = await page.evaluate(() => {
        const read = (selector) => {
          const style = getComputedStyle(document.querySelector(selector));
          return [style.borderRadius, style.borderColor, style.backgroundColor];
        };
        return { actual: read('.xk-sub-hot-apply-switch'), expected: read('.xk-sub-controls .xk-sub-check') };
      });
      expect(styles.actual).toEqual(styles.expected);
      await page.screenshot({ path: testInfo.outputPath(`hot-apply-${theme}-${width}.png`) });
      await page.locator('#outbounds-subscriptions-hot-apply-help').click();
      const help = page.locator('#outbounds-subscriptions-hot-apply-help-modal');
      await expect(help).toBeVisible();
      await expect(help).toContainText('HandlerService');
      await expect(help).toContainText('не атомарна');
      await page.keyboard.press('Escape');
      await expect(help).toBeHidden();
      await expect(page.locator('#outbounds-subscriptions-modal')).toBeVisible();
      await expect(page.locator('#outbounds-subscriptions-hot-apply-help')).toBeFocused();
    });
  }
}

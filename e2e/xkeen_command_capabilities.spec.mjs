import { test, expect, selectPanelView } from './fixtures.mjs';

test('список команд учитывает обнаруженные флаги и обновляется при повторном открытии', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('xkeen-theme', 'dark'));
  let known = false;
  await page.route('**/api/xkeen/command-capabilities', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(known ? { known: true, flags: ['-i', '-uy', '-start', '-diag'] } : { known: false, flags: [] }),
  }));
  await page.goto('/');
  await selectPanelView(page, 'commands');
  const command = page.locator('.command-item[data-flag="-uy"]');
  await expect(page.locator('#xkeen-command-capabilities-status')).toBeVisible();
  await expect(command).toHaveAttribute('data-availability', 'unknown');
  await expect(command.locator('.command-availability-icon')).toBeVisible();
  await expect(command.locator('.command-item-desc')).not.toContainText('Неизвестно');
  await expect(command.locator('.command-item-desc')).toHaveCSS('color', 'rgb(246, 189, 96)');
  await expect(page.locator('.commands-column[data-command-column="3"] .command-group').filter({ hasText: 'Утилиты панели' })).toBeVisible();
  known = true;
  await selectPanelView(page, 'routing');
  await selectPanelView(page, 'commands');
  await expect(command).toHaveAttribute('data-availability', 'available');
  await expect(page.locator('.command-item[data-flag="-rrk"]')).toBeHidden();
  await expect(command.locator('.command-availability-icon')).toBeHidden();
  await expect(page.locator('#xkeen-command-capabilities-status')).toBeHidden();
  await expect(page.locator('.command-group').filter({ hasText: 'Утилиты панели' })).toBeVisible();
});

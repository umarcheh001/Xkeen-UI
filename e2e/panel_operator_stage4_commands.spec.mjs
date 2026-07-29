import { test, expect } from '@playwright/test';


async function openCommands(page, theme, viewport) {
  await page.setViewportSize(viewport);
  await page.addInitScript((nextTheme) => {
    localStorage.setItem('xkeen-theme', nextTheme);
  }, theme);
  await page.goto('/');
  await page.locator('.top-tab-btn[data-view="commands"]').click();
  await expect(page.locator('#view-commands')).toBeVisible();
}


async function readCommandGeometry(page) {
  return page.evaluate(() => {
    const body = document.querySelector('#commands-body');
    const groups = Array.from(body.querySelectorAll('.command-group'));
    const item = body.querySelector('.command-item');
    const prefix = item.querySelector('.command-item-prefix');
    const description = item.querySelector('.command-item-desc');
    const action = item.querySelector('.command-item-action');
    const itemRect = item.getBoundingClientRect();
    const groupRect = groups[0].getBoundingClientRect();
    return {
      columns: Number.parseInt(getComputedStyle(body).columnCount, 10),
      groupWidth: groupRect.width,
      itemWidth: itemRect.width,
      itemHeight: itemRect.height,
      itemDisplay: getComputedStyle(item).display,
      prefixDisplay: getComputedStyle(prefix).display,
      descriptionDisplay: getComputedStyle(description).display,
      actionDisplay: getComputedStyle(action).display,
      actionText: action.textContent.trim(),
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
}


test.describe('Operator Console Stage 4 commands', () => {
  for (const theme of ['dark', 'light']) {
    test(`compact three-column command rows in ${theme}`, async ({ page }) => {
      await openCommands(page, theme, { width: 1440, height: 900 });
      const geometry = await readCommandGeometry(page);
      expect(geometry.columns).toBe(3);
      expect(geometry.groupWidth).toBeLessThan(500);
      expect(geometry.itemWidth).toBeLessThan(500);
      expect(geometry.itemHeight).toBeLessThanOrEqual(44);
      expect(geometry.itemDisplay).toBe('grid');
      expect(geometry.prefixDisplay).toBe('none');
      expect(geometry.descriptionDisplay).not.toBe('none');
      expect(geometry.actionDisplay).toBe('flex');
      expect(geometry.actionText).toBe('Выполнить');
      expect(geometry.pageOverflow).toBeLessThanOrEqual(1);
    });
  }

  test('mobile uses one readable column without overflow', async ({ page }) => {
    await openCommands(page, 'dark', { width: 390, height: 844 });
    const geometry = await readCommandGeometry(page);
    expect(geometry.columns).toBe(1);
    expect(geometry.itemWidth).toBeLessThanOrEqual(370);
    expect(geometry.itemHeight).toBeGreaterThanOrEqual(40);
    expect(geometry.prefixDisplay).toBe('none');
    expect(geometry.pageOverflow).toBeLessThanOrEqual(1);
  });
});

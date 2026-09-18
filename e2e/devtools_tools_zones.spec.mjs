import { test, expect } from './fixtures.mjs';


async function openTools(page, viewport) {
  await page.setViewportSize(viewport);
  await page.goto('/devtools');
  await expect(page.locator('body')).toHaveClass(/\bdevtools-page\b/);
  await expect(page.locator('#dt-env-card')).toBeVisible();
}


test.describe('DevTools Tools zones', () => {
  test('cards are laid out in three zones without horizontal scroll', async ({ page }) => {
    await openTools(page, { width: 1600, height: 1000 });

    const heads = page.locator('#dt-tab-tools .dt-zone-head');
    await expect(heads).toHaveCount(3);
    await expect(heads.nth(0)).toHaveText('Сервис, обновление и настройки');
    await expect(heads.nth(1)).toHaveText('Система');
    await expect(heads.nth(2)).toHaveText('Вид интерфейса');

    const geometry = await page.evaluate(() => {
      const zoneLabel = (id) => document.getElementById(id).closest('.dt-zone')?.getAttribute('aria-label') || '';
      const bottom = (id) => document.getElementById(id).getBoundingClientRect().bottom;
      return {
        pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        happZone: zoneLabel('dt-happ-decryptor-card'),
        terminalZone: zoneLabel('dt-terminal-theme-card'),
        brandingZone: zoneLabel('dt-branding-card'),
        layoutZone: zoneLabel('dt-layout-card'),
        trayBottom: document.querySelector('.dt-tools-left').getBoundingClientRect().bottom,
        envBottom: bottom('dt-env-card'),
        prefsBottom: bottom('dt-ui-prefs-card'),
        ioBottom: bottom('dt-ui-prefs-io-card'),
      };
    });

    expect(geometry.pageOverflow).toBeLessThanOrEqual(1);
    expect(geometry.happZone).toBe('Система');
    expect(geometry.terminalZone).toBe('Система');
    expect(geometry.brandingZone).toBe('Вид интерфейса');
    expect(geometry.layoutZone).toBe('Вид интерфейса');
    expect(Math.abs(geometry.trayBottom - geometry.envBottom)).toBeLessThanOrEqual(2);
    expect(Math.abs(geometry.prefsBottom - geometry.ioBottom)).toBeLessThanOrEqual(2);

    const logBox = page.locator('#dt-update-log-box');
    await expect(logBox).not.toHaveAttribute('open', /.*/);
    await logBox.locator('summary').click();
    await expect(logBox).toHaveAttribute('open', /.*/);

    const logGeometry = await page.evaluate(() => {
      const log = document.getElementById('dt-update-log');
      const card = document.getElementById('dt-update-card');
      return {
        logHeight: log.getBoundingClientRect().height,
        logBottom: log.getBoundingClientRect().bottom,
        cardBottom: card.getBoundingClientRect().bottom,
      };
    });

    expect(logGeometry.logHeight).toBeGreaterThan(240);
    expect(logGeometry.logBottom).toBeLessThanOrEqual(logGeometry.cardBottom + 2);
  });

  test('zones collapse to one column on a narrow screen', async ({ page }) => {
    await openTools(page, { width: 900, height: 900 });

    const columns = await page.evaluate(() => {
      const zone = document.querySelector('#dt-tab-tools .dt-zone');
      return getComputedStyle(zone).gridTemplateColumns.split(' ').length;
    });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );

    expect(columns).toBe(1);
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test('terminal theme card starts collapsed and remembers being opened', async ({ page }) => {
    await openTools(page, { width: 1600, height: 1000 });

    const card = page.locator('#dt-terminal-theme-card');
    await expect(card).not.toHaveAttribute('open', /.*/);

    await card.locator('summary').click();
    await expect(card).toHaveAttribute('open', /.*/);

    await page.reload();
    await expect(page.locator('#dt-env-card')).toBeVisible();
    await expect(page.locator('#dt-terminal-theme-card')).toHaveAttribute('open', /.*/);

    const stored = await page.evaluate(
      () => localStorage.getItem('xk.devtools.collapse.dt-terminal-theme-card.open'),
    );
    expect(stored).toBe('1');

    await page.locator('#dt-terminal-theme-card summary').click();
    await page.reload();
    await expect(page.locator('#dt-env-card')).toBeVisible();
    await expect(page.locator('#dt-terminal-theme-card')).not.toHaveAttribute('open', /.*/);
  });
});

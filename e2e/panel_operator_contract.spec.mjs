import { test, expect } from './fixtures.mjs';


async function openPanel(page, theme = 'dark') {
  await page.addInitScript((nextTheme) => {
    localStorage.setItem('xkeen-theme', nextTheme);
  }, theme);
  await page.goto('/');
  await expect(page.locator('.panel-header')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}

test.describe('Operator Console Stage 0 runtime contract', () => {
  for (const theme of ['dark', 'light']) {
    test(`operator stylesheet stays isolated and last in ${theme}`, async ({ page }) => {
      await openPanel(page, theme);
      await expect(page.locator('body')).toHaveClass(/\bpanel-page\b/);

      const contract = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('link[rel~="stylesheet"]'));
        const sheets = Array.from(document.styleSheets);
        return {
          lastLink: links.at(-1)?.href || '',
          lastSheet: sheets.at(-1)?.href || '',
          operatorLinkCount: links.filter((link) => link.href.includes('/static/panel-operator.css')).length,
          accent: getComputedStyle(document.body).getPropertyValue('--op-accent').trim(),
        };
      });
      expect(contract.lastLink).toContain('/static/panel-operator.css');
      expect(contract.lastSheet).toContain('/static/panel-operator.css');
      expect(contract.operatorLinkCount).toBe(1);
      expect(contract.accent).not.toBe('');
    });
  }

  test('critical view, accordion, theme and modal handlers remain connected', async ({ page }) => {
    await openPanel(page, 'dark');

    await page.locator('#theme-toggle-btn').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

    for (const view of ['mihomo', 'xkeen', 'xray-logs', 'commands', 'files', 'routing']) {
      await page.locator(`.top-tab-btn[data-view="${view}"]`).click();
      await expect(page.locator(`#view-${view}`)).toBeVisible();
    }
    await expect(page.locator('#routing-rules-header')).toHaveAttribute('data-xk-collapse-wired', '1');

    for (const [controlId, targetId] of [
      ['routing-dat-header', 'routing-dat-body'],
      ['inbounds-header', 'inbounds-body'],
      ['routing-scenario-header', 'routing-scenario-body'],
      ['outbounds-header', 'outbounds-body'],
      ['routing-backups-header', 'routing-backups-body'],
      ['routing-help-header', 'routing-help-body'],
    ]) {
      const control = page.locator(`#${controlId}`);
      const target = page.locator(`#${targetId}`);
      const wasVisible = await target.isVisible();
      await control.click();
      if (wasVisible) {
        await expect(target).toBeHidden();
      } else {
        await expect(target).toBeVisible();
      }
      await control.click();
      if (wasVisible) {
        await expect(target).toBeVisible();
      } else {
        await expect(target).toBeHidden();
      }
    }

    if (!(await page.locator('#outbounds-body').isVisible())) {
      await page.locator('#outbounds-header').click();
    }
    await page.locator('#outbounds-open-editor-btn').click();
    await expect(page.locator('#json-editor-modal')).toBeVisible();
    await page.locator('#json-editor-close-btn').click();
    await expect(page.locator('#json-editor-modal')).toBeHidden();
  });

  test('runtime duplicate nodes remain attached but visually suppressed', async ({ page }) => {
    await openPanel(page, 'dark');

    await expect(page.locator('#routing-focus-note')).toBeAttached();
    await expect(page.locator('#routing-focus-note')).toBeHidden();

    if (!(await page.locator('#inbounds-body').isVisible())) {
      await page.locator('#inbounds-header').click();
    }
    await expect(page.locator('#inbounds-file-code')).toBeAttached();
    await expect(page.locator('#inbounds-file-code').locator('..')).toBeHidden();

    if (!(await page.locator('#outbounds-body').isVisible())) {
      await page.locator('#outbounds-header').click();
    }
    await expect(page.locator('#outbounds-file-code')).toBeAttached();
    await expect(page.locator('#outbounds-file-code').locator('..')).toBeHidden();

    await page.locator('.top-tab-btn[data-view="mihomo"]').click();
    await expect(page.locator('.xk-mihomo-topbar .xk-routing-active-inline')).toBeAttached();
    await expect(page.locator('.xk-mihomo-topbar .xk-routing-active-inline')).toBeHidden();

    await page.locator('.top-tab-btn[data-view="routing"]').click();
    await page.locator('#outbounds-open-editor-btn').click();
    await expect(page.locator('#json-editor-file-label')).toBeAttached();
    await expect(page.locator('#json-editor-file-label')).toBeHidden();
  });
});

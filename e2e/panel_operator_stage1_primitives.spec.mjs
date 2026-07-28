import { test, expect } from '@playwright/test';


async function openPanel(page, theme, viewport = null) {
  if (viewport) await page.setViewportSize(viewport);
  await page.addInitScript((nextTheme) => {
    localStorage.setItem('xkeen-theme', nextTheme);
  }, theme);
  await page.goto('/');
  await expect(page.locator('.panel-header')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}

async function exposePanelChrome(page) {
  for (const controlId of [
    'routing-dat-header',
    'inbounds-header',
    'routing-scenario-header',
    'outbounds-header',
    'routing-backups-header',
    'routing-help-header',
  ]) {
    const control = page.locator(`#${controlId}`);
    const targetId = await control.getAttribute('aria-controls');
    if (targetId && !(await page.locator(`#${targetId}`).isVisible())) {
      await control.click();
    }
  }
}

async function collectChromeEffects(page) {
  return page.evaluate(() => {
    const selectors = [
      '.panel-header',
      '.panel-header *',
      '.xkeen-ctrl-row',
      '.xkeen-ctrl-row *',
      '.view-section:not(.hidden) .card',
      '.view-section:not(.hidden) .card > .commands-header',
      '.view-section:not(.hidden) .routing-side-card *',
      '#view-commands:not(.hidden) *',
      '#view-files:not(.hidden) *',
      '.modal:not(.hidden) .modal-content',
      '.modal:not(.hidden) *',
      '#terminal-overlay .terminal-window',
      '#terminal-overlay .terminal-window *',
    ];
    const nodes = Array.from(document.querySelectorAll(selectors.join(',')))
      .filter((node) => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden';
      });

    const coloredGlow = (shadow) => {
      if (!shadow || shadow === 'none') return false;
      const layers = shadow.split(/\),\s*/).map((layer, index, all) => (
        index < all.length - 1 ? `${layer})` : layer
      ));
      return layers.some((layer) => {
        const color = layer.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        const lengths = Array.from(layer.matchAll(/(-?\d+(?:\.\d+)?)px/g), (match) => Number(match[1]));
        if (!color || lengths.length < 3 || lengths[2] <= 0) return false;
        const channels = color.slice(1, 4).map(Number);
        return Math.max(...channels) - Math.min(...channels) > 18;
      });
    };

    const violations = [];
    for (const node of nodes) {
      for (const pseudo of [null, '::before', '::after']) {
        const style = getComputedStyle(node, pseudo);
        const label = `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ''}${pseudo || ''}`;
        if (style.backgroundImage.includes('gradient(')) {
          violations.push(`${label}: gradient ${style.backgroundImage}`);
        }
        if (coloredGlow(style.boxShadow)) {
          violations.push(`${label}: coloured glow ${style.boxShadow}`);
        }
      }
      if (node.matches('button, [role="button"], .command-row, .fm-row, .routing-side-card .links a')) {
        const transform = getComputedStyle(node).transform;
        if (transform !== 'none') violations.push(`${node.id || node.className}: transform ${transform}`);
      }
    }
    return violations;
  });
}

test.describe('Operator Console Stage 1 primitive contract', () => {
  for (const theme of ['dark', 'light']) {
    test(`panel chrome has no legacy effects in ${theme}`, async ({ page }) => {
      await openPanel(page, theme);
      await exposePanelChrome(page);

      await page.locator('#ui-settings-open-btn').click();
      await expect(page.locator('#ui-settings-modal')).toBeVisible();
      expect(await collectChromeEffects(page), `legacy effects in settings/${theme}`).toEqual([]);
      await page.locator('#ui-settings-close-btn').click();
      await expect(page.locator('#ui-settings-modal')).toBeHidden();

      for (const view of ['routing', 'mihomo', 'xkeen', 'xray-logs', 'commands', 'files']) {
        await page.locator(`.top-tab-btn[data-view="${view}"]`).click();
        await expect(page.locator(`#view-${view}`)).toBeVisible();
        expect(await collectChromeEffects(page), `legacy effects in ${view}/${theme}`).toEqual([]);

        if (view === 'commands') {
          await page.locator('#terminal-open-pty-btn').click();
          await expect(page.locator('#terminal-overlay')).toBeVisible();
          expect(await collectChromeEffects(page), `legacy effects in terminal/${theme}`).toEqual([]);
          await page.locator('#terminal-btn-close').click();
          await expect(page.locator('#terminal-overlay')).toBeHidden();
        }
      }
    });
  }

  test('primitive geometry is shared across representative workspaces', async ({ page }) => {
    await openPanel(page, 'dark');
    await exposePanelChrome(page);

    const geometry = await page.evaluate(() => {
      const measure = (selector) => {
        const node = document.querySelector(selector);
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return {
          height: rect.height,
          width: rect.width,
          radius: Number.parseFloat(style.borderTopLeftRadius),
        };
      };
      return {
        control: measure('#routing-dat-geosite-browse'),
        compact: measure('#routing-dat-geodat-install-btn'),
        icon: measure('#routing-dat-refresh-btn'),
        surface: measure('#routing-editor-card'),
        status: measure('#routing-scenario-badge'),
        dataRow: measure('#routing-help-body .links > li'),
      };
    });

    expect(geometry.control.height).toBe(32);
    expect(geometry.compact.height).toBe(28);
    expect(geometry.icon.height).toBe(32);
    expect(geometry.icon.width).toBe(32);
    expect(geometry.control.radius).toBeGreaterThanOrEqual(5);
    expect(geometry.control.radius).toBeLessThanOrEqual(6);
    expect(geometry.surface.radius).toBeGreaterThanOrEqual(9);
    expect(geometry.surface.radius).toBeLessThanOrEqual(12);
    expect(geometry.status.radius).toBeLessThanOrEqual(5);
    expect(geometry.dataRow.radius).toBe(0);
  });

  test('interactive mobile targets are at least 40px', async ({ page }) => {
    await openPanel(page, 'dark', { width: 390, height: 844 });
    await exposePanelChrome(page);

    const undersized = await page.evaluate(() => {
      const selectors = [
        '.panel-header button',
        '.panel-header a[href]',
        '.xkeen-ctrl-row button',
        '.view-section:not(.hidden) button',
        '.view-section:not(.hidden) a[href]',
        '.view-section:not(.hidden) summary',
        '.view-section:not(.hidden) label:has(input[type="checkbox"])',
        '.view-section:not(.hidden) label:has(input[type="radio"])',
        '.view-section:not(.hidden) select',
        '.view-section:not(.hidden) input:not([type="checkbox"]):not([type="radio"]):not([type="file"])',
        '.routing-side-card .links a',
      ];
      return Array.from(document.querySelectorAll(selectors.join(',')))
        .filter((node) => {
          const rect = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && rect.height < 39.5;
        })
        .map((node) => `${node.tagName.toLowerCase()}#${node.id || node.className}:${node.getBoundingClientRect().height}`);
    });

    expect(undersized).toEqual([]);
  });
});

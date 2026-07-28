import { test, expect } from '@playwright/test';


const viewports = [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
  { width: 1280, height: 720 },
  { width: 1024, height: 768 },
  { width: 390, height: 844 },
  { width: 360, height: 800 },
];


async function openPanel(page, theme, viewport = viewports[0]) {
  await page.setViewportSize(viewport);
  await page.addInitScript((nextTheme) => {
    localStorage.setItem('xkeen-theme', nextTheme);
    localStorage.setItem('xkeen.editor.engine', 'codemirror');
  }, theme);
  await page.goto('/');
  await expect(page.locator('.panel-header')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  await expect(page.locator('#view-routing')).toBeVisible();
  await expect(page.locator('.xkeen-cm6-host')).toBeVisible();
}


async function settleResponsiveLayout(page) {
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
}


async function collectLayout(page) {
  return page.evaluate(() => {
    const rect = (selector) => {
      const node = document.querySelector(selector);
      const box = node?.getBoundingClientRect();
      return box ? {
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        right: box.right,
        bottom: box.bottom,
      } : null;
    };
    const editor = rect('.xkeen-cm6-host');
    const shellMain = document.querySelector('.panel-header-shell-main');
    const serviceRow = document.querySelector('.xkeen-ctrl-row');
    const rail = document.querySelector('.top-tabs.header-tabs');
    return {
      viewport: { width: innerWidth, height: innerHeight },
      zones: Array.from(
        document.querySelectorAll('.panel-header-shell-main > [data-xk-shell-zone]'),
        (node) => node.dataset.xkShellZone,
      ),
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      shellOverflow: shellMain.scrollWidth - shellMain.clientWidth,
      serviceOverflow: serviceRow.scrollWidth - serviceRow.clientWidth,
      railOverflowMode: getComputedStyle(rail).overflowX,
      header: rect('.panel-header'),
      shellMain: rect('.panel-header-shell-main'),
      identity: rect('.panel-shell-identity'),
      globalActions: rect('.panel-shell-right'),
      rail: rect('.top-tabs.header-tabs'),
      serviceRow: rect('.xkeen-ctrl-row'),
      workspace: rect('.layout-2col.routing-layout'),
      editorColumn: rect('.routing-col-center'),
      inspector: rect('.layout-side.routing-side'),
      editor,
      editorVisibleHeight: editor
        ? Math.max(0, Math.min(innerHeight, editor.bottom) - Math.max(0, editor.y))
        : 0,
    };
  });
}


test.describe('Operator Console Stage 2 shell and workspace contract', () => {
  for (const theme of ['dark', 'light']) {
    test(`shell and grid stay readable without page overflow in ${theme}`, async ({ page }) => {
      await openPanel(page, theme);

      for (const viewport of viewports) {
        await page.setViewportSize(viewport);
        await settleResponsiveLayout(page);
        const layout = await collectLayout(page);

        expect(layout.zones).toEqual(['identity', 'global-actions']);
        expect(layout.pageOverflow, `${viewport.width}x${viewport.height}`).toBeLessThanOrEqual(1);
        expect(layout.shellOverflow, `shell ${viewport.width}x${viewport.height}`).toBeLessThanOrEqual(1);
        expect(layout.serviceOverflow, `service ${viewport.width}x${viewport.height}`).toBeLessThanOrEqual(1);
        expect(layout.railOverflowMode).toBe('auto');
        expect(layout.header.x).toBeGreaterThanOrEqual(0);
        expect(layout.header.right).toBeLessThanOrEqual(viewport.width + 0.5);
        expect(layout.identity.width).toBeGreaterThan(0);
        expect(layout.globalActions.width).toBeGreaterThan(0);

        if (viewport.width > 720) {
          expect(layout.shellMain.height).toBeLessThanOrEqual(51);
          expect(layout.header.height).toBeLessThanOrEqual(130);
        } else {
          expect(layout.shellMain.height).toBeLessThanOrEqual(103);
          expect(layout.header.height).toBeLessThanOrEqual(250);
        }

        if (viewport.width > 1180) {
          expect(layout.editorColumn.y).toBeCloseTo(layout.inspector.y, 0);
          expect(layout.editorColumn.right).toBeLessThan(layout.inspector.x);
        } else {
          expect(layout.editorColumn.y).toBeLessThan(layout.inspector.y);
          expect(layout.editorColumn.x).toBeCloseTo(layout.inspector.x, 0);
        }

        if (viewport.width === 1280 && viewport.height === 720) {
          expect(layout.editor.y).toBeLessThanOrEqual(250);
          expect(layout.editorVisibleHeight).toBeGreaterThanOrEqual(460);
        }
      }
    });

    test(`navigation and ordinary shell actions keep the Stage 2 hierarchy in ${theme}`, async ({ page }) => {
      await openPanel(page, theme, { width: 1280, height: 720 });

      const actionStyles = await page.evaluate(() => {
        const read = (selector) => {
          const style = getComputedStyle(document.querySelector(selector));
          return {
            background: style.backgroundColor,
            border: style.borderColor,
            color: style.color,
            image: style.backgroundImage,
            shadow: style.boxShadow,
          };
        };
        return [
          read('#theme-toggle-btn'),
          read('#ui-settings-open-btn'),
          read('.xk-header-btn-devtools'),
          read('.xk-header-btn-logout'),
        ];
      });

      expect(new Set(actionStyles.map((style) => JSON.stringify(style))).size).toBe(1);
      expect(actionStyles[0].image).toBe('none');
      expect(actionStyles[0].shadow).toBe('none');

      const commandsTab = page.locator('.top-tab-btn[data-view="commands"]');
      await commandsTab.click();
      await expect(commandsTab).toHaveClass(/\bactive\b/);
      await page.locator('#theme-toggle-btn').focus();
      let reachedByKeyboard = false;
      for (let index = 0; index < 20; index += 1) {
        await page.keyboard.press('Tab');
        reachedByKeyboard = await commandsTab.evaluate((node) => node === document.activeElement);
        if (reachedByKeyboard) break;
      }
      expect(reachedByKeyboard).toBe(true);
      await expect(commandsTab).toBeFocused();
      const navState = await commandsTab.evaluate((node) => {
        const style = getComputedStyle(node);
        const marker = getComputedStyle(node, '::after');
        return {
          focusVisible: node.matches(':focus-visible'),
          outlineStyle: style.outlineStyle,
          outlineWidth: style.outlineWidth,
          marker: marker.backgroundColor,
          markerHeight: marker.height,
        };
      });
      expect(navState.focusVisible).toBe(true);
      expect(navState.outlineStyle).not.toBe('none');
      expect(Number.parseFloat(navState.outlineWidth)).toBeGreaterThanOrEqual(2);
      expect(navState.marker).not.toBe('rgba(0, 0, 0, 0)');
      expect(navState.markerHeight).toBe('2px');
    });
  }
});

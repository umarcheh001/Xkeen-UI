import { test, expect } from './fixtures.mjs';


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
      core: rect('.panel-shell-center'),
      globalActions: rect('.panel-shell-right'),
      summary: rect('.panel-shell-summary'),
      actionButtons: rect('.panel-shell-actions'),
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
  test('DevTools container modes size and centre the redesigned panel', async ({ page }) => {
    await openPanel(page, 'dark', { width: 1920, height: 1080 });

    const expectedWidths = {
      fixed: 960,
      fluid: 1600,
      max: 1920,
    };

    for (const [mode, expectedWidth] of Object.entries(expectedWidths)) {
      await page.evaluate((nextMode) => {
        const key = 'xkeen-layout-v1';
        let prefs = {};
        try { prefs = JSON.parse(localStorage.getItem(key) || '{}'); } catch (error) {}
        const next = { ...prefs, container: nextMode };
        localStorage.setItem(key, JSON.stringify(next));
        document.documentElement.dataset.xkContainer = nextMode;
        document.documentElement.style.setProperty(
          '--xk-container-max-width',
          nextMode === 'fixed' ? '960px' : nextMode === 'fluid' ? 'min(1600px, 96vw)' : '100%',
        );
      }, mode);
      await settleResponsiveLayout(page);
      const result = await page.evaluate(() => {
        const node = document.querySelector('.container.container-wide');
        const box = node.getBoundingClientRect();
        const shellMain = document.querySelector('.panel-header-shell-main');
        const serviceRow = document.querySelector('.xkeen-ctrl-row');
        const rect = (selector) => {
          const element = document.querySelector(selector);
          const elementBox = element?.getBoundingClientRect();
          return elementBox ? {
            x: elementBox.x,
            y: elementBox.y,
            width: elementBox.width,
            right: elementBox.right,
          } : null;
        };
        return {
          container: {
            x: box.x,
            width: box.width,
            right: box.right,
            maxWidth: getComputedStyle(node).maxWidth,
          },
          pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          shellOverflow: shellMain.scrollWidth - shellMain.clientWidth,
          serviceOverflow: serviceRow.scrollWidth - serviceRow.clientWidth,
          editorColumn: rect('.routing-col-center'),
          inspector: rect('.layout-side.routing-side'),
        };
      });
      const { container } = result;

      expect(container.width, mode).toBeCloseTo(expectedWidth, 0);
      expect(container.x, mode).toBeCloseTo((1920 - expectedWidth) / 2, 0);
      expect(container.right, mode).toBeLessThanOrEqual(1920 + 0.5);
      expect(result.pageOverflow, mode).toBeLessThanOrEqual(1);
      expect(result.shellOverflow, mode).toBeLessThanOrEqual(1);
      expect(result.serviceOverflow, mode).toBeLessThanOrEqual(1);

      if (mode === 'fixed') {
        expect(result.editorColumn.x).toBeCloseTo(result.inspector.x, 0);
        expect(result.editorColumn.y).toBeLessThan(result.inspector.y);
      } else {
        expect(result.editorColumn.y).toBeCloseTo(result.inspector.y, 0);
        expect(result.editorColumn.right).toBeLessThan(result.inspector.x);
      }
    }

    await page.setViewportSize({ width: 390, height: 844 });
    for (const mode of Object.keys(expectedWidths)) {
      await page.evaluate((nextMode) => {
        const key = 'xkeen-layout-v1';
        let prefs = {};
        try { prefs = JSON.parse(localStorage.getItem(key) || '{}'); } catch (error) {}
        const next = { ...prefs, container: nextMode };
        localStorage.setItem(key, JSON.stringify(next));
        document.documentElement.dataset.xkContainer = nextMode;
        document.documentElement.style.setProperty(
          '--xk-container-max-width',
          nextMode === 'fixed' ? '960px' : nextMode === 'fluid' ? 'min(1600px, 96vw)' : '100%',
        );
      }, mode);
      await settleResponsiveLayout(page);
      const layout = await collectLayout(page);
      expect(layout.header.x, mode).toBeGreaterThanOrEqual(0);
      expect(layout.header.right, mode).toBeLessThanOrEqual(390 + 0.5);
      expect(layout.pageOverflow, mode).toBeLessThanOrEqual(1);
      expect(layout.editorColumn.x, mode).toBeCloseTo(layout.inspector.x, 0);
      expect(layout.editorColumn.y, mode).toBeLessThan(layout.inspector.y);
      const sideGridColumns = await page.locator('.routing-side-grid').evaluate(
        (node) => getComputedStyle(node).gridTemplateColumns,
      );
      expect(sideGridColumns.trim().split(/\s+/), mode).toHaveLength(1);
    }

    await page.evaluate(() => {
      const key = 'xkeen-layout-v1';
      let prefs = {};
      try { prefs = JSON.parse(localStorage.getItem(key) || '{}'); } catch (error) {}
      localStorage.setItem(key, JSON.stringify({ ...prefs, container: 'max' }));
      document.documentElement.dataset.xkContainer = 'max';
      document.documentElement.style.setProperty('--xk-container-max-width', '100%');
    });
    await page.setViewportSize(viewports[0]);
  });

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
          expect(layout.core.right, `core vs summary ${viewport.width}x${viewport.height}`)
            .toBeLessThanOrEqual((layout.summary?.x ?? layout.actionButtons.x) + 0.5);
          expect(layout.summary?.right ?? layout.core.right, `summary vs actions ${viewport.width}x${viewport.height}`)
            .toBeLessThanOrEqual(layout.actionButtons.x + 0.5);
        }

        if (viewport.width > 720) {
          expect(layout.shellMain.height).toBeLessThanOrEqual(51);
          // The navigation rail may wrap once at 1280px; it must stay compact,
          // but no longer has the old fixed 130px height.
          expect(layout.header.height).toBeLessThanOrEqual(170);
        } else {
          expect(layout.shellMain.height).toBeLessThanOrEqual(103);
          // Mobile navigation naturally spans multiple rows. Keep a bounded
          // shell, rather than preserving a pre-I6 hard-coded height.
          expect(layout.header.height).toBeLessThanOrEqual(360);
        }

        if (viewport.width > 1180) {
          expect(layout.editorColumn.y).toBeCloseTo(layout.inspector.y, 0);
          expect(layout.editorColumn.right).toBeLessThan(layout.inspector.x);
        } else {
          expect(layout.editorColumn.y).toBeLessThan(layout.inspector.y);
          expect(layout.editorColumn.x).toBeCloseTo(layout.inspector.x, 0);
        }

        if (viewport.width === 1280 && viewport.height === 720) {
          // On short desktop viewports a taller routing toolbar can place the
          // editor below the fold. Width/overflow and intrinsic editor height
          // are the responsive contract; absolute y-position is not.
          expect(layout.editor.height).toBeGreaterThanOrEqual(460);
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
          shadow: style.boxShadow,
          marker: marker.backgroundColor,
          markerHeight: marker.height,
        };
      });
      expect(navState.focusVisible).toBe(true);
      expect(navState.outlineStyle).not.toBe('none');
      expect(Number.parseFloat(navState.outlineWidth)).toBeGreaterThanOrEqual(2);
      expect(navState.shadow).toBe('none');
      expect(navState.marker).not.toBe('rgba(0, 0, 0, 0)');
      expect(navState.markerHeight).toBe('2px');
    });

    test(`service and routing focus controls stay flat and restrained in ${theme}`, async ({ page }) => {
      await openPanel(page, theme, { width: 1280, height: 720 });

      const styles = await page.evaluate(() => {
        const read = (selector) => {
          const node = document.querySelector(selector);
          const style = getComputedStyle(node);
          const before = getComputedStyle(node, '::before');
          return {
            background: style.backgroundColor,
            image: style.backgroundImage,
            border: style.borderColor,
            color: style.color,
            shadow: style.boxShadow,
            beforeContent: before.content,
            beforeDisplay: before.display,
          };
        };
        return {
          service: [
            read('#xkeen-start-btn'),
            read('#xkeen-stop-btn'),
            read('#xkeen-restart-btn'),
          ],
          gui: read('#routing-focus-gui-btn'),
          raw: read('#routing-focus-raw-btn'),
          activeFocus: document.querySelector('.routing-focus-btn[aria-pressed="true"]')?.id || '',
        };
      });

      expect(new Set(styles.service.map((style) => JSON.stringify(style))).size).toBe(1);
      expect(styles.service[0].image).toBe('none');
      expect(styles.service[0].shadow).toBe('none');
      expect(styles.service[0].beforeContent).toBe('none');
      expect(styles.service[0].beforeDisplay).toBe('none');

      const focusStyles = [styles.gui, styles.raw];
      for (const style of focusStyles) {
        expect(style.image).toBe('none');
        expect(style.shadow).toBe('none');
      }
      expect(styles.activeFocus).not.toBe('');
      const inactiveFocus = styles.activeFocus === 'routing-focus-gui-btn' ? styles.raw : styles.gui;
      expect(inactiveFocus.background).toBe('rgba(0, 0, 0, 0)');
    });
  }
});

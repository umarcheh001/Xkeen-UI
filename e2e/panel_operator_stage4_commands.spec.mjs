import { test, expect } from './fixtures.mjs';


async function openCommands(page, theme, viewport) {
  await page.setViewportSize(viewport);
  await page.addInitScript((nextTheme) => {
    localStorage.setItem('xkeen-theme', nextTheme);
  }, theme);
  await page.goto('/');
  const commandsTab = page.locator('.top-tab-btn[data-view="commands"]');
  await expect(commandsTab).toBeVisible();
  await commandsTab.click();
  await expect(commandsTab).toHaveClass(/\bactive\b/);
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
    const bodyStyle = getComputedStyle(body);
    const columns = Array.from(body.querySelectorAll('.commands-column'));
    const columnHeights = columns.map((column) => column.getBoundingClientRect().height);
    const terminal = document.querySelector('#terminal-open-pty-btn:not([style*="display:none"]), #terminal-open-shell-btn:not([style*="display:none"])');
    const statusPanel = document.querySelector('.commands-status-panel');
    return {
      gridColumns: bodyStyle.gridTemplateColumns.split(' ').filter(Boolean).length,
      columnDisplays: columns.map((column) => getComputedStyle(column).display),
      columnHeights,
      heightSpread: Math.max(...columnHeights) - Math.min(...columnHeights),
      groupWidth: groupRect.width,
      itemWidth: itemRect.width,
      itemHeight: itemRect.height,
      itemDisplay: getComputedStyle(item).display,
      prefixDisplay: getComputedStyle(prefix).display,
      descriptionDisplay: getComputedStyle(description).display,
      actionDisplay: getComputedStyle(action).display,
      actionText: action.textContent.trim(),
      terminalText: terminal?.textContent.trim() || '',
      terminalHeight: terminal?.getBoundingClientRect().height || 0,
      statusDisplay: getComputedStyle(statusPanel).display,
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
}


test.describe('Operator Console Stage 4 commands', () => {
  for (const theme of ['dark', 'light']) {
    test(`balanced three-column command catalog in ${theme}`, async ({ page }) => {
      await openCommands(page, theme, { width: 1440, height: 900 });
      const geometry = await readCommandGeometry(page);
      expect(geometry.gridColumns).toBe(3);
      expect(geometry.columnDisplays).toEqual(['flex', 'flex', 'flex']);
      expect(geometry.heightSpread).toBeLessThan(240);
      expect(geometry.groupWidth).toBeGreaterThan(400);
      expect(geometry.groupWidth).toBeLessThan(500);
      expect(geometry.itemWidth).toBeGreaterThan(400);
      expect(geometry.itemHeight).toBeGreaterThanOrEqual(44);
      expect(geometry.itemDisplay).toBe('grid');
      expect(geometry.prefixDisplay).toBe('none');
      expect(geometry.descriptionDisplay).not.toBe('none');
      expect(geometry.actionDisplay).toBe('flex');
      expect(geometry.actionText).toBe('Выполнить');
      expect(geometry.terminalText).toContain('Открыть терминал');
      expect(geometry.terminalHeight).toBeGreaterThanOrEqual(36);
      expect(geometry.statusDisplay).toBe('grid');
      expect(geometry.pageOverflow).toBeLessThanOrEqual(1);
    });
  }

  test('mobile uses one readable column without overflow', async ({ page }) => {
    await openCommands(page, 'dark', { width: 390, height: 844 });
    const geometry = await readCommandGeometry(page);
    expect(geometry.gridColumns).toBe(1);
    expect(geometry.itemWidth).toBeLessThanOrEqual(370);
    expect(geometry.itemHeight).toBeGreaterThanOrEqual(40);
    expect(geometry.prefixDisplay).toBe('none');
    expect(geometry.pageOverflow).toBeLessThanOrEqual(1);
  });

  test('only the explicit action button runs a command', async ({ page }) => {
    await openCommands(page, 'dark', { width: 1440, height: 900 });
    const row = page.locator('.command-item[data-flag="-i"]');
    const action = row.locator('.command-item-action');
    await expect(row).toBeVisible();
    await expect(action).toBeVisible();

    await row.locator('.command-item-desc').click();
    await expect(row).not.toHaveAttribute('aria-busy', 'true');

    await action.click();
    await expect(row).toHaveAttribute('aria-busy', 'true');
  });

  test('GitHub failure is explained next to both cores', async ({ page }) => {
    await page.route('**/api/cores/versions', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          cores: {
            xray: { installed: true, version: '26.6.1' },
            mihomo: { installed: true, version: 'alpha-test' },
          },
        }),
      });
    });
    await page.route('**/api/cores/updates*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: false,
          refreshing: false,
          stale: false,
          latest: {
            xray: { ok: false, error: 'request_failed', meta: {} },
            mihomo: { ok: false, error: 'request_failed', meta: {} },
          },
          installed: {
            xray: { installed: true, version: '26.6.1' },
            mihomo: { installed: true, version: 'alpha-test' },
          },
          update_available: { xray: false, mihomo: false },
          prerelease_update_available: { xray: false, mihomo: false },
        }),
      });
    });

    await openCommands(page, 'dark', { width: 1440, height: 900 });
    await expect(page.locator('#core-xray-state')).toHaveText('GitHub недоступен');
    await expect(page.locator('#core-mihomo-state')).toHaveText('GitHub недоступен');
    await expect(page.locator('#core-pill-xray')).toHaveClass(/has-error/);
    await expect(page.locator('#core-pill-mihomo')).toHaveClass(/has-error/);
  });

  test('actions stay hidden for current cores and the absent core is not shown', async ({ page }) => {
    await page.route('**/api/cores/versions', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          cores: {
            xray: { installed: false, version: null },
            mihomo: { installed: true, version: '1.19.30' },
          },
        }),
      });
    });
    await page.route('**/api/cores/updates*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          refreshing: false,
          stale: false,
          latest: {
            // A stale release for an absent core must not leak into the UI.
            xray: {
              ok: true,
              stable: { tag: 'v99.0.0', url: 'https://example.test/xray' },
              prerelease: { tag: 'v100.0.0-rc1', url: 'https://example.test/xray-pre' },
            },
            mihomo: {
              ok: true,
              stable: { tag: 'v1.19.30', url: 'https://example.test/mihomo' },
              prerelease: {
                tag: 'Prerelease-Alpha',
                display_tag: 'alpha-current',
                url: 'https://example.test/mihomo-pre',
                install: {
                  mode: 'direct_asset',
                  supported: true,
                  build_ids: ['1.19.30'],
                },
              },
            },
          },
          installed: {
            xray: { installed: false, version: null },
            mihomo: { installed: true, version: '1.19.30' },
          },
          update_available: { xray: false, mihomo: false },
          prerelease_update_available: { xray: false, mihomo: false },
        }),
      });
    });

    await openCommands(page, 'dark', { width: 1440, height: 900 });
    await expect(page.locator('#core-pill-xray')).toBeHidden();
    await expect(page.locator('#core-pill-mihomo')).toBeVisible();
    await expect(page.locator('#core-mihomo-update-btn')).toBeHidden();
    await expect(page.locator('#core-mihomo-prerelease-update-btn')).toBeHidden();
  });

  test('stable and pre-release updates are grouped and visibly distinct', async ({ page }) => {
    await page.route('**/api/cores/versions', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          cores: {
            xray: { installed: true, version: '26.6.1' },
            mihomo: { installed: true, version: 'alpha-978d25a' },
          },
        }),
      });
    });
    await page.route('**/api/cores/updates*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          refreshing: false,
          stale: false,
          checked_ts: 1_786_000_000,
          latest: {
            xray: {
              ok: true,
              stable: { tag: 'v26.7.28', url: 'https://example.test/xray-stable' },
              prerelease: { tag: 'v26.8.0-rc1', url: 'https://example.test/xray-pre' },
            },
            mihomo: {
              ok: true,
              stable: { tag: 'v1.19.29', url: 'https://example.test/mihomo-stable' },
              prerelease: { tag: 'pre-alpha-9a9c4c6', url: 'https://example.test/mihomo-pre' },
            },
          },
          installed: {
            xray: { installed: true, version: '26.6.1' },
            mihomo: { installed: true, version: 'alpha-978d25a' },
          },
          update_available: { xray: true, mihomo: true },
          prerelease_update_available: { xray: true, mihomo: true },
        }),
      });
    });

    await openCommands(page, 'dark', { width: 1440, height: 900 });
    await expect(page.locator('#core-mihomo-stable-release')).toBeVisible();
    await expect(page.locator('#core-mihomo-prerelease-release')).toBeVisible();
    await expect(page.locator('#core-mihomo-update-btn')).toHaveText(/Обновить/);
    await expect(page.locator('#core-mihomo-prerelease-update-btn')).toHaveText(/Установить/);

    const geometry = await page.evaluate(() => {
      const stable = document.querySelector('#core-mihomo-stable-release');
      const prerelease = document.querySelector('#core-mihomo-prerelease-release');
      const stableAction = document.querySelector('#core-mihomo-update-btn');
      const prereleaseAction = document.querySelector('#core-mihomo-prerelease-update-btn');
      return {
        stableWidth: stable.getBoundingClientRect().width,
        prereleaseWidth: prerelease.getBoundingClientRect().width,
        stableActionWidth: stableAction.getBoundingClientRect().width,
        prereleaseActionWidth: prereleaseAction.getBoundingClientRect().width,
        stableKind: stable.querySelector('.core-release-kind').textContent.trim(),
        prereleaseKind: prerelease.querySelector('.core-release-kind').textContent.trim(),
        prereleaseBorder: getComputedStyle(prerelease).borderColor,
        stableBorder: getComputedStyle(stable).borderColor,
      };
    });
    expect(geometry.stableWidth).toBeGreaterThan(220);
    expect(geometry.prereleaseWidth).toBeGreaterThan(220);
    expect(geometry.stableActionWidth).toBeGreaterThan(80);
    expect(geometry.prereleaseActionWidth).toBeGreaterThan(80);
    expect(geometry.stableKind).toBe('Stable');
    expect(geometry.prereleaseKind).toBe('Pre-release');
    expect(geometry.prereleaseBorder).not.toBe(geometry.stableBorder);
  });

  for (const core of [
    { name: 'xray', flag: '-ux' },
    { name: 'mihomo', flag: '-um' },
  ]) {
    test(`${core.name} stable update delegates to its executable command action`, async ({ page }) => {
      await page.route('**/api/cores/versions', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            cores: {
              xray: { installed: true, version: '26.6.1' },
              mihomo: { installed: true, version: 'alpha-978d25a' },
            },
          }),
        });
      });
      await page.route('**/api/cores/updates*', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            refreshing: false,
            stale: false,
            latest: {
              xray: { ok: true, stable: { tag: 'v26.7.28', url: 'https://example.test/xray' } },
              mihomo: { ok: true, stable: { tag: 'v1.19.30', url: 'https://example.test/mihomo' } },
            },
            installed: {
              xray: { installed: true, version: '26.6.1' },
              mihomo: { installed: true, version: 'alpha-978d25a' },
            },
            update_available: { xray: true, mihomo: true },
            prerelease_update_available: { xray: false, mihomo: false },
          }),
        });
      });

      await openCommands(page, 'dark', { width: 1440, height: 900 });
      const command = page.locator(`.command-item[data-flag="${core.flag}"]`);
      await expect(command).not.toHaveAttribute('aria-busy', 'true');
      await page.locator(`#core-${core.name}-update-btn`).click();
      await expect(command).toHaveAttribute('aria-busy', 'true');
    });
  }

  for (const core of ['xray', 'mihomo']) {
    test(`${core} pre-release install opens the executable terminal flow`, async ({ page }) => {
      await page.route('**/api/cores/versions', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            cores: {
              xray: { installed: true, version: '26.6.1' },
              mihomo: { installed: true, version: 'alpha-978d25a' },
            },
          }),
        });
      });
      await page.route('**/api/cores/updates*', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            refreshing: false,
            stale: false,
            latest: {
              xray: {
                ok: true,
                stable: { tag: 'v26.7.28', url: 'https://example.test/xray' },
                prerelease: { tag: 'v26.8.0-rc1', url: 'https://example.test/xray-pre' },
              },
              mihomo: {
                ok: true,
                stable: { tag: 'v1.19.30', url: 'https://example.test/mihomo' },
                prerelease: { tag: 'pre-alpha-9a9c4c6', url: 'https://example.test/mihomo-pre' },
              },
            },
            installed: {
              xray: { installed: true, version: '26.6.1' },
              mihomo: { installed: true, version: 'alpha-978d25a' },
            },
            update_available: { xray: true, mihomo: true },
            prerelease_update_available: { xray: true, mihomo: true },
          }),
        });
      });

      await openCommands(page, 'dark', { width: 1440, height: 900 });
      const install = page.locator(`#core-${core}-prerelease-update-btn`);
      await expect(install).toBeEnabled();
      await install.click();
      await expect(install).toBeDisabled();
      await expect(page.locator('#terminal-overlay')).toBeVisible();
    });
  }
});

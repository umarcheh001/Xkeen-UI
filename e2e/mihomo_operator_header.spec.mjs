import { test, expect, selectPanelView } from './fixtures.mjs';

test('Mihomo header preserves controls, service state and navigation in both themes', async ({ page }) => {
  // Спека обходит два оформления, три ширины и пять меню со скриншотами: на
  // машине помедленнее это около полутора минут, и в 60 с она не укладывалась —
  // падала то на клике, то на скриншоте, смотря где кончался бюджет.
  test.setTimeout(180_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/system/resources', route => route.fulfill({ json: {
    ok: true, cpu: { percent: 11.7, cores: 2 }, memory: { percent: 48 }, sampled_at: Date.now() / 1000,
  } }));
  await page.route('**/api/mihomo/clash/status', route => route.fulfill({ json: {
    ok: true, state: 'ready', schema_version: 1,
    core: { version: 'alpha-65287f0' }, runtime: { mode: 'rule' },
    capabilities: { status: true, proxy_groups: true, proxy_select: true, proxy_delay: true, runtime_mode_switch: true },
  } }));
  await page.route(/\/api\/mihomo\/clash\/proxy-groups(?:\?.*)?$/, route => route.fulfill({ json: {
    ok: true, schema_version: 1, providers: [], groups: [
      { name: 'Заблок. сервисы', type: 'Selector', now: 'Fallback', selectable: true, hidden: false,
        nodes: [{ name: 'Fallback', type: 'Fallback', alive: true, delay_ms: 162 }, { name: 'Germany', type: 'VLESS', alive: true, delay_ms: 127 }] },
      { name: 'HIDDEN', type: 'Selector', now: 'DIRECT', selectable: true, hidden: true,
        nodes: [{ name: 'DIRECT', type: 'Direct', alive: true }] },
    ],
  } }));
  await page.goto('/');
  await page.locator('[aria-controls="xk-mihomo-sections-menu"]').click();
  await selectPanelView(page, 'mihomo');
  await expect(page.locator('body')).toHaveClass(/xk-mihomo-header-active/);
  await expect(page.locator('.xk-mihomo-operator-title')).toHaveCount(0);
  await expect(page.locator('#mihomo-clash-groups-list')).toContainText('Заблок. сервисы');
  await expect(page.locator('#mihomo-clash-status-strip')).toHaveAttribute('data-tone', 'positive');
  await expect(page.locator('.panel-shell-status')).not.toBeInViewport();
  await expect(page.locator('#xk-mihomo-sections-menu')).toBeHidden();
  await expect(page.locator('.panel-header-shell')).not.toContainText('/  Маршрутизация');
  await expect(page.locator('#mihomo-clash-status-strip')).toBeHidden();

  await page.locator('.xk-brand-service-trigger').click();
  await expect(page.locator('#xkeen-restart-btn')).toBeVisible();
  await expect(page.locator('#global-autorestart-xkeen')).toBeAttached();
  await page.keyboard.press('Escape');
  await expect(page.locator('.xk-brand-service-trigger')).toBeFocused();
  await expect(page.locator('#xk-mihomo-service-menu')).toBeHidden();

  await page.locator('[aria-controls="xk-mihomo-parameters-menu"]').click();
  await expect(page.locator('#xk-mihomo-parameters-menu #mihomo-clash-status-strip')).toBeVisible();
  await expect(page.locator('#mihomo-clash-status-version')).toHaveText('alpha-65287f0');
  await expect(page.locator('#mihomo-clash-latency-preset')).toHaveCSS('appearance', 'none');
  await expect(page.locator('.xk-mihomo-select-field:has(#mihomo-clash-latency-preset) .xk-disclosure-chevron')).toBeVisible();
  await page.locator('#mihomo-clash-show-hidden').check();
  await expect(page.locator('#mihomo-clash-groups-list')).toContainText('HIDDEN');
  await page.locator('#mihomo-clash-show-hidden').uncheck();
  await page.keyboard.press('Escape');
  await page.locator('#mihomo-clash-groups-filter').fill('does-not-exist');
  await expect(page.locator('#mihomo-clash-groups-list')).not.toContainText('Заблок. сервисы');
  await page.locator('#mihomo-clash-groups-filter').fill('');
  await page.locator('#mihomo-clash-status-mode').click();
  await expect(page.locator('#mihomo-clash-mode-menu')).toBeVisible();
  await page.keyboard.press('Escape');

  // Status stays in Parameters on non-control subviews; the editor has no toolbar.
  await page.locator('#mihomo-clash-tab-rules').click();
  await expect(page.locator('#mihomo-clash-status-mode')).toBeVisible();
  await page.locator('[aria-controls="xk-mihomo-parameters-menu"]').click();
  await expect(page.locator('#mihomo-clash-status-strip')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.locator('#mihomo-clash-tab-config').click();
  await expect(page.locator('#mihomo-clash-runtime')).toBeHidden();
  await expect(page.locator('#mihomo-clash-tab-config')).toBeHidden();
  await expect(page.locator('.xk-mihomo-groups-toolbar')).toBeHidden();
  await expect(page.locator('#mihomo-clash-panel-config .commands-header h2')).toHaveText('Редактор конфигурации Mihomo');
  const editorHeader = page.locator('[data-xk-toggle="mihomo-card"]');
  await expect(editorHeader).toBeFocused();
  await expect(page.locator('#mihomo-arrow use')).toHaveAttribute('href', /#xk-chevron-down$/);
  await editorHeader.click();
  await expect(page.locator('#mihomo-body')).toBeHidden();
  await expect(editorHeader).toHaveAttribute('aria-expanded', 'false');
  await editorHeader.press('Enter');
  await expect(page.locator('#mihomo-body')).toBeVisible();
  await expect(editorHeader).toHaveAttribute('aria-expanded', 'true');
  await page.screenshot({ path: '.tmp/mihomo-header-config-fixed.png' });
  await page.locator('#mihomo-clash-tab-control').focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('#mihomo-clash-tab-logs')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await expect(page.locator('#mihomo-clash-status-strip')).toBeHidden();

  // Drive the existing status hook: no second service poller is introduced.
  await page.evaluate(() => document.getElementById('xkeen-service-lamp').dataset.state = 'running');
  await expect(page.locator('.panel-shell-branding')).toHaveAttribute('data-service-state', 'running');
  expect(await page.locator('#xk-brand-title').evaluate(el => getComputedStyle(el).animationName)).toBe('xk-operator-brand-breathe');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await page.locator('#xk-brand-title').evaluate(el => getComputedStyle(el).animationName)).toBe('none');
  await page.evaluate(() => document.getElementById('xkeen-service-lamp').dataset.state = 'stopped');
  await expect(page.locator('.panel-shell-branding')).toHaveAttribute('data-service-state', 'stopped');
  expect(await page.locator('#xk-brand-title').evaluate(el => getComputedStyle(el).animationName)).toBe('none');

  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(() => document.getElementById('xkeen-service-lamp').dataset.state = 'running');
  const groupHeader = page.locator('[data-group-name="Заблок. сервисы"] .xk-mihomo-group-head');
  if (await groupHeader.getAttribute('aria-expanded') !== 'true') await groupHeader.click();
  for (const theme of ['dark', 'light']) {
    if (await page.locator('html').getAttribute('data-theme') !== theme) {
      await page.locator('[aria-controls="xk-mihomo-panel-menu"]').click();
      await page.locator('#theme-toggle-btn').click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    }
    for (const width of [1668, 1024, 390, 360]) {
      await page.setViewportSize({ width, height: 960 });
      await page.keyboard.press('Escape');
      await expect(page.locator('#mihomo-clash-test-visible')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      // The approved header has inline controls: icons and labels must not stack.
      const parameters = page.locator('[aria-controls="xk-mihomo-parameters-menu"]');
      const iconBox = await parameters.locator('svg').first().boundingBox();
      const labelBox = await parameters.locator('.xk-action-label').boundingBox();
      expect(Math.abs(iconBox.y + iconBox.height / 2 - labelBox.y - labelBox.height / 2)).toBeLessThan(3);
      await expect(parameters.locator('.xk-disclosure-chevron use')).toHaveAttribute('href', /#xk-chevron-down$/);
      const modeChevron = await page.locator('#mihomo-clash-status-mode > svg').boundingBox();
      const orderChevron = await page.locator('.xk-mihomo-select-field:has(#mihomo-clash-groups-sort) > svg').boundingBox();
      const paramsChevron = await parameters.locator('.xk-disclosure-chevron').boundingBox();
      expect([orderChevron.width, paramsChevron.width]).toEqual([modeChevron.width, modeChevron.width]);
      await expect(page.locator('#mihomo-clash-groups-collapse > span')).toBeHidden();
      const tab = page.locator('#mihomo-clash-tab-control');
      expect(await tab.evaluate(el => getComputedStyle(el).borderBottomColor)).toBe(await tab.evaluate(el => {
        const probe = document.createElement('span'); probe.style.color = 'var(--op-accent)'; el.append(probe);
        const color = getComputedStyle(probe).color; probe.remove(); return color;
      }));
      await page.screenshot({ path: `.tmp/mihomo-header-${theme}-${width}.png` });
      if (width === 1668) {
        const header = await page.locator('.panel-header-shell').boundingBox();
        const workspaceHead = await page.locator('.xk-mihomo-workspace-head').boundingBox();
        const toolbar = await page.locator('.xk-mihomo-groups-toolbar').boundingBox();
        expect(Math.abs(workspaceHead.y - header.y - header.height)).toBeLessThanOrEqual(1);
        expect(Math.abs(workspaceHead.x - header.x)).toBeLessThanOrEqual(1);
        expect(Math.abs(workspaceHead.width - header.width)).toBeLessThanOrEqual(1);
        expect(toolbar.y + toolbar.height - header.y).toBeLessThanOrEqual(215);
        const order = await page.locator('.xk-mihomo-toolbar-field').nth(1).boundingBox();
        const search = await page.locator('.xk-mihomo-groups-search').boundingBox();
        expect(order.y).toBe(search.y);
        expect(Math.abs(search.x - header.x - 457)).toBeLessThan(4);
        const logs = await page.locator('#mihomo-clash-tab-logs').boundingBox();
        const egress = await page.locator('#mihomo-clash-egress-toggle').boundingBox();
        const dns = await page.locator('#mihomo-clash-dns-toggle').boundingBox();
        const settings = await parameters.boundingBox();
        const config = await page.locator('#mihomo-clash-tab-config').boundingBox();
        expect(egress.x).toBeGreaterThan(logs.x + logs.width);
        expect(dns.x).toBeGreaterThan(egress.x + egress.width);
        expect(Math.abs(egress.y + egress.height / 2 - logs.y - logs.height / 2)).toBeLessThan(2);
        expect(config.x).toBeGreaterThan(settings.x + settings.width);
        expect(config.y).toBe(settings.y);
        await page.screenshot({ path: `.tmp/mihomo-header-implemented-${theme}.png`, clip: {
          x: 0, y: 0, width, height: Math.ceil(toolbar.y + toolbar.height + 8),
        } });
      }
      const configRect = await page.locator('#mihomo-clash-tab-config').boundingBox();
      const dnsRect = await page.locator('#mihomo-clash-dns-toggle').boundingBox();
      if (configRect && dnsRect) {
        const overlap = configRect.x < dnsRect.x + dnsRect.width && configRect.x + configRect.width > dnsRect.x
          && configRect.y < dnsRect.y + dnsRect.height && configRect.y + configRect.height > dnsRect.y;
        expect(overlap).toBe(false);
      }
      for (const id of ['xk-mihomo-parameters-menu', 'xk-mihomo-sections-menu', 'xk-mihomo-panel-menu', 'xk-mihomo-service-menu', 'mihomo-clash-mode-menu']) {
        await page.locator(id === 'mihomo-clash-mode-menu' ? '#mihomo-clash-status-mode' : `[aria-controls="${id}"]`).click();
        const box = await page.locator(`#${id}`).boundingBox();
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
        // Check the contents too: the old theme button's label escaped its 30px slot.
        for (const child of await page.locator(`#${id}`).locator('button:visible, a:visible, .theme-toggle-text:visible, .dt-switch:visible').all()) {
          const rect = await child.boundingBox();
          expect(rect.x, `${id}: content left`).toBeGreaterThanOrEqual(box.x);
          expect(rect.x + rect.width, `${id}: content right`).toBeLessThanOrEqual(box.x + box.width);
          expect(rect.y, `${id}: content top`).toBeGreaterThanOrEqual(box.y);
          expect(rect.y + rect.height, `${id}: content bottom`).toBeLessThanOrEqual(box.y + box.height);
        }
        if (id === 'xk-mihomo-service-menu') {
          const toggle = await page.locator('#xk-mihomo-service-menu .dt-switch').boundingBox();
          const core = await page.locator('#xkeen-core-text').boundingBox();
          expect(Math.abs(toggle.x - core.x)).toBeLessThanOrEqual(1);
        }
        if (id === 'xk-mihomo-sections-menu') {
          const rows = page.locator('#xk-mihomo-sections-menu .top-tab-btn:visible');
          for (const row of await rows.all()) {
            const rect = await row.boundingBox();
            expect(rect.width).toBeCloseTo(box.width - 26, 0);
            await expect(row).toHaveCSS('text-align', 'left');
            await expect(row).toHaveCSS('border-top-width', '1px');
            expect(await row.evaluate(el => getComputedStyle(el, '::after').display)).toBe('none');
          }
        }
        if (id === 'xk-mihomo-panel-menu') {
          const activity = page.locator('#last-load');
          await expect(activity.locator('.xk-last-activity-menu-label')).toBeVisible();
          await activity.click();
          await expect(activity.locator('.last-load-chip__body')).toHaveCSS('opacity', '1');
          await activity.click();
        }
        if (width === 1668) await page.screenshot({ path: `.tmp/mihomo-${id}-${theme}-fixed.png`, clip: { x: 0, y: 0, width, height: Math.ceil(box.y + box.height + 16) } });
        await page.keyboard.press('Escape');
      }
    }
  }
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.locator('[aria-controls="xk-mihomo-sections-menu"]').click();
  await selectPanelView(page, 'routing');
  await expect(page.locator('body')).not.toHaveClass(/xk-mihomo-header-active/);
  await expect(page.locator('body')).toHaveClass(/xk-operator-header-active/);
  await expect(page.locator('body')).toHaveClass(/xk-routing-header-active/);
  await expect(page.locator('#xk-mihomo-sections-menu .header-tabs')).toBeHidden();
  await page.locator('[aria-controls="xk-mihomo-sections-menu"]').click();
  await selectPanelView(page, 'mihomo');
  await expect(page.locator('body')).toHaveClass(/xk-mihomo-header-active/);
  await expect(page.locator('#xkeen-restart-btn')).toHaveCount(1);
  expect(errors).toEqual([]);
});

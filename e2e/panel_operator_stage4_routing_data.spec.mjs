import { test, expect } from '@playwright/test';


const STAGE4_ROUTING = `{
  "routing": {
    "domainStrategy": "AsIs",
    "balancers": [
      {
        "tag": "proxy",
        "fallbackTag": "direct",
        "selector": ["edge-a", "edge-b", "edge-c", "edge-d", "edge-e", "edge-f", "edge-g"],
        "strategy": { "type": "leastPing" }
      },
      {
        "tag": "reserve",
        "selector": ["reserve-a", "reserve-b"],
        "strategy": { "type": "random" }
      }
    ],
    "rules": [
      {
        "ruleTag": "private-direct",
        "type": "field",
        "domain": ["geosite:private", "domain:router.local"],
        "outboundTag": "direct"
      },
      {
        "ruleTag": "ads-block",
        "type": "field",
        "domain": ["geosite:category-ads-all"],
        "outboundTag": "block"
      },
      {
        "ruleTag": "proxy-traffic",
        "type": "field",
        "inboundTag": ["redirect", "tproxy"],
        "port": "53, 80-443",
        "network": "tcp,udp",
        "balancerTag": "proxy"
      },
      {
        "ruleTag": "dns-out",
        "type": "field",
        "port": "53",
        "outboundTag": "dns-out"
      }
    ]
  }
}`;


const ROUTING_WITH_DISABLED_RULE = `{
  "routing": {
    "rules": [
      {
        "ruleTag": "private-direct",
        "type": "field",
        "domain": ["geosite:private"],
        "outboundTag": "direct"
      },
      //__XK_DISABLED_RULE_START__
      // {
      //   "ruleTag": "paused-block",
      //   "type": "field",
      //   "domain": ["geosite:category-ads-all"],
      //   "outboundTag": "block"
      // }
      //__XK_DISABLED_RULE_END__
      {
        "ruleTag": "proxy-traffic",
        "type": "field",
        "balancerTag": "proxy"
      }
    ]
  }
}`;


async function mockStage4Dependencies(page) {
  await page.route('**/api/ui-settings', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        settings: {
          schemaVersion: 2,
          editor: {
            engine: 'codemirror',
            codemirrorFontScale: 100,
            monacoFontScale: 100,
            schemaHoverEnabled: true,
            beginnerModeEnabled: true,
            expertModeEnabled: false,
          },
          format: { preferPrettier: false, tabWidth: 2, printWidth: 80 },
          logs: { ansi: false, ws2: false, view: {} },
          routing: {
            guiEnabled: true,
            autoApply: false,
            showActiveOutbound: false,
            showScenarioCard: true,
          },
        },
      }),
    });
  });

  await page.route('**/api/xray/outbound-tags**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        tags: [
          'direct', 'block', 'dns-out',
          'edge-a', 'edge-b', 'edge-c', 'edge-d', 'edge-e', 'edge-f', 'edge-g',
          'reserve-a', 'reserve-b',
        ],
      }),
    });
  });

  await page.route('**/api/xray/observatory/config', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, exists: true, file: '07_observatory.json' }),
    });
  });
}


async function replaceRoutingText(page, text) {
  await page.evaluate((nextText) => {
    window.XKeen.features.routing.replaceEditorText(nextText, {
      markDirty: false,
      reason: 'e2e-stage4-routing-data',
      scrollTop: true,
    });
  }, text);

  const expectedMarker = text.includes('paused-block') ? 'paused-block' : 'private-direct';
  await expect.poll(() => page.evaluate(() => {
    const maybeEditor = window.XKeen?.features?.routingShell?.getEditorInstance?.({ preferRaw: true });
    const editor = maybeEditor && maybeEditor.raw ? maybeEditor.raw : maybeEditor;
    return editor && typeof editor.getValue === 'function' ? editor.getValue() : '';
  })).toContain(expectedMarker);
}


async function openStage4Routing(page, theme, text = STAGE4_ROUTING) {
  await page.setViewportSize({ width: 1400, height: 960 });
  await page.addInitScript((nextTheme) => {
    localStorage.setItem('xkeen-theme', nextTheme);
    localStorage.setItem('xkeen.editor.engine', 'codemirror');
    localStorage.setItem('xk.routing.rules.open.v2', '0');
    localStorage.setItem('xk.routing.focus-mode.v1', 'gui');
  }, theme);
  await mockStage4Dependencies(page);
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  await expect(page.locator('#view-routing')).toBeVisible();

  await page.waitForFunction(() => !!(
    window.XKeen?.features?.routing?.replaceEditorText &&
    window.XKeen?.features?.routingShell?.getEditorInstance
  ));
  await expect(page.locator('#routing-status')).toContainText('Routing загружен');
  await replaceRoutingText(page, text);

  const rulesBody = page.locator('#routing-rules-body');
  if (!(await rulesBody.isVisible())) {
    await page.locator('#routing-rules-header').click();
  }
  await expect(rulesBody).toBeVisible();
  await page.locator('#routing-rules-reload-btn').click();
}


async function expectRecordGeometry(page, width) {
  await page.setViewportSize({ width, height: 960 });
  await expect(page.locator('#routing-rules-list .routing-rule-card')).toHaveCount(4);

  const geometry = await page.evaluate(() => {
    const list = document.querySelector('#routing-rules-list');
    const cards = Array.from(list.querySelectorAll('.routing-rule-card'));
    const listRect = list.getBoundingClientRect();
    const rects = cards.map((card) => {
      const rect = card.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
    });
    const token = getComputedStyle(document.body).getPropertyValue('--op-surface').trim();
    return {
      display: getComputedStyle(list).display,
      list: { left: listRect.left, right: listRect.right, width: listRect.width },
      rects,
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      listBackground: getComputedStyle(list).backgroundColor,
      operatorSurface: token,
    };
  });

  expect(geometry.display).toBe('block');
  expect(geometry.pageOverflow).toBeLessThanOrEqual(1);
  for (const rect of geometry.rects) {
    expect(Math.abs(rect.left - geometry.list.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(rect.right - geometry.list.right)).toBeLessThanOrEqual(1);
    expect(rect.height).toBeLessThan(width <= 390 ? 220 : 190);
  }
  for (let index = 1; index < geometry.rects.length; index += 1) {
    expect(geometry.rects[index].top).toBeGreaterThanOrEqual(geometry.rects[index - 1].bottom - 1);
  }
  expect(geometry.listBackground).not.toBe('rgba(0, 0, 0, 0)');
  expect(geometry.operatorSurface).toBeTruthy();
}


test.describe('Operator Console Stage 4 routing data screens', () => {
  for (const theme of ['dark', 'light']) {
    test(`dense records, target states and balancer disclosure in ${theme}`, async ({ page }) => {
      await openStage4Routing(page, theme);

      const cards = page.locator('#routing-rules-list .routing-rule-card');
      await expect(cards).toHaveCount(4);
      await expect(cards.nth(0)).toHaveClass(/\bis-target-direct\b/);
      await expect(cards.nth(1)).toHaveClass(/\bis-target-block\b/);
      await expect(cards.nth(2)).toHaveClass(/\bis-target-balancer\b/);
      await expect(cards.nth(3)).toHaveClass(/\bis-target-outbound\b/);
      await expect(cards.nth(0).locator('.routing-rule-badge.is-target')).toHaveText('outbound: direct');
      await expect(cards.nth(1).locator('.routing-rule-badge.is-target')).toHaveText('outbound: block');
      await expect(cards.nth(2).locator('.routing-rule-badge.is-target')).toHaveText('balancer: proxy');

      const markerColors = await cards.evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).borderLeftColor));
      expect(markerColors[0]).not.toBe(markerColors[1]);
      expect(markerColors[1]).not.toBe(markerColors[2]);

      await cards.nth(2).locator('.routing-rule-toggle').click();
      await expect(cards.nth(2).locator('.routing-rule-form')).toBeVisible();
      const ruleDeleteGeometry = await cards.nth(2).evaluate((record) => {
        const chipDelete = record.querySelector('.routing-chip-remove');
        const fieldDelete = record.querySelector('.routing-rule-remove-field');
        const geometry = (node) => {
          if (!node) return null;
          const rect = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          return { width: rect.width, height: rect.height, radius: style.borderRadius };
        };
        return {
          chipDelete: geometry(chipDelete),
          fieldDelete: geometry(fieldDelete),
        };
      });
      expect(ruleDeleteGeometry.chipDelete).toEqual({ width: 22, height: 22, radius: '50%' });
      expect(ruleDeleteGeometry.fieldDelete).toEqual({ width: 22, height: 22, radius: '50%' });
      await cards.nth(2).locator('.routing-rule-toggle').click();

      await expect(cards.nth(0)).toHaveAttribute('data-open', '0');
      await expect(cards.nth(0).locator('.routing-rule-form')).toHaveCount(0);
      await cards.nth(0).locator('.routing-rule-toggle').click();
      await expect(cards.nth(0)).toHaveAttribute('data-open', '1');
      await expect(cards.nth(0).locator('.routing-rule-form')).toBeVisible();
      await cards.nth(0).locator('.routing-rule-toggle').click();
      await expect(cards.nth(0)).toHaveAttribute('data-open', '0');
      await expect(cards.nth(0).locator('.routing-rule-form')).toHaveCount(0);

      await expect(page.locator('#routing-rules-list')).toHaveAttribute('data-dnd-mode', /^(pointer|native)$/);
      await expect(page.locator('#routing-rules-list .routing-rule-handle')).toHaveCount(4);
      await expect(page.locator('#routing-rules-list .routing-rule-card.is-draggable')).toHaveCount(4);

      const balancers = page.locator('#routing-balancers-list .routing-balancer-card');
      await expect(balancers).toHaveCount(2);
      await expect(balancers.nth(0)).toHaveAttribute('data-open', '0');
      await expect(balancers.nth(0).locator('.routing-balancer-body .routing-rule-form')).toHaveCount(0);
      await expect(balancers.nth(0).locator('.routing-balancer-summary')).toContainText('fallback direct');
      await expect(balancers.nth(0).locator('.routing-balancer-summary')).toContainText('strategy leastPing');
      await expect(balancers.nth(0).locator('.routing-balancer-summary')).toContainText('selector 7');

      const toggle = balancers.nth(0).locator('.routing-balancer-toggle-btn');
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await toggle.click();
      await expect(balancers.nth(0)).toHaveAttribute('data-open', '1');
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      await expect(balancers.nth(0).locator('.routing-balancer-body .routing-rule-form')).toBeVisible();

      const chipField = balancers.nth(0).locator('.routing-selector-chipfield');
      await expect(chipField.locator('.routing-selector-chip')).toHaveCount(4);
      const compactGeometry = await balancers.nth(0).evaluate((record) => {
        const rows = Array.from(record.querySelectorAll('.routing-balancer-form > .routing-rule-field'));
        const controls = rows.slice(0, 2).map((row) => row.querySelector('.routing-rule-input')?.getBoundingClientRect());
        const chipDelete = record.querySelector('.routing-selector-chip-x');
        const balancerDelete = record.querySelector('.routing-balancer-del-btn');
        const chipStyle = chipDelete ? getComputedStyle(chipDelete) : null;
        const balancerDeleteStyle = balancerDelete ? getComputedStyle(balancerDelete) : null;
        return {
          fieldGap: controls.length === 2 && controls[0] && controls[1]
            ? controls[1].top - controls[0].bottom
            : -1,
          chipDelete: chipDelete && chipStyle ? {
            width: chipDelete.getBoundingClientRect().width,
            height: chipDelete.getBoundingClientRect().height,
            radius: chipStyle.borderRadius,
          } : null,
          balancerDelete: balancerDelete && balancerDeleteStyle ? {
            width: balancerDelete.getBoundingClientRect().width,
            height: balancerDelete.getBoundingClientRect().height,
            radius: balancerDeleteStyle.borderRadius,
          } : null,
        };
      });
      expect(compactGeometry.fieldGap).toBeGreaterThanOrEqual(8);
      expect(compactGeometry.chipDelete).toEqual({ width: 22, height: 22, radius: '50%' });
      expect(compactGeometry.balancerDelete).toEqual({ width: 28, height: 28, radius: '50%' });

      const more = chipField.locator('.routing-selector-more-btn');
      await expect(more).toHaveText('Ещё 3');
      await expect(more).toHaveAttribute('aria-expanded', 'false');
      await more.click();
      await expect(chipField.locator('.routing-selector-chip')).toHaveCount(7);
      await expect(more).toHaveText('Свернуть');
      await expect(more).toHaveAttribute('aria-expanded', 'true');
      const overflowStyle = await chipField.evaluate((node) => ({
        maxHeight: Number.parseFloat(getComputedStyle(node).maxHeight),
        overflowY: getComputedStyle(node).overflowY,
      }));
      expect(overflowStyle.maxHeight).toBeLessThanOrEqual(92);
      expect(overflowStyle.overflowY).toBe('auto');

      await toggle.click();
      await expect(balancers.nth(0)).toHaveAttribute('data-open', '0');
      await expect(balancers.nth(0).locator('.routing-balancer-body .routing-rule-form')).toHaveCount(0);

      await expect(page.locator('#routing-rules-apply-btn')).toHaveClass(/\bbtn-primary\b/);
      await expect(page.locator('#routing-rules-body .btn-primary')).toHaveCount(1);
      const toolbarGeometry = await page.evaluate(() => {
        const apply = document.querySelector('#routing-rules-apply-btn');
        const reload = document.querySelector('#routing-rules-reload-btn');
        const summary = document.querySelector('.routing-balancer-summary');
        const surface = document.querySelector('.routing-balancers-grid');
        const rgb = (value) => (String(value).match(/[\d.]+/g) || []).slice(0, 3).map(Number);
        const luminance = (value) => {
          const channels = rgb(value).map((channel) => {
            const normalized = channel / 255;
            return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
          });
          return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
        };
        const contrast = (a, b) => {
          const lighter = Math.max(luminance(a), luminance(b));
          const darker = Math.min(luminance(a), luminance(b));
          return (lighter + 0.05) / (darker + 0.05);
        };
        const applyRect = apply.getBoundingClientRect();
        const reloadRect = reload.getBoundingClientRect();
        return {
          apply: { width: applyRect.width, height: applyRect.height },
          reload: { width: reloadRect.width, height: reloadRect.height },
          summaryContrast: contrast(getComputedStyle(summary).color, getComputedStyle(surface).backgroundColor),
        };
      });
      expect(toolbarGeometry.apply).toEqual(toolbarGeometry.reload);
      expect(toolbarGeometry.apply).toEqual({ width: 32, height: 32 });
      expect(toolbarGeometry.summaryContrast).toBeGreaterThanOrEqual(4.5);

      for (const width of [1400, 820, 390]) {
        await expectRecordGeometry(page, width);
      }
    });
  }

  test('pointer drag keeps record ordering operational', async ({ page }) => {
    await openStage4Routing(page, 'dark');

    const firstHandle = page.locator('#routing-rules-list .routing-rule-card').nth(0).locator('.routing-rule-handle');
    const thirdCard = page.locator('#routing-rules-list .routing-rule-card').nth(2);
    const from = await firstHandle.boundingBox();
    const target = await thirdCard.boundingBox();
    expect(from).toBeTruthy();
    expect(target).toBeTruthy();

    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2 + 10, { steps: 2 });

    const dragGeometry = await page.evaluate(() => {
      const ghost = document.querySelector('body > .routing-rule-card.is-pointer-ghost');
      const placeholder = document.querySelector('#routing-rules-list > .routing-rule-placeholder');
      const badge = ghost?.querySelector('.routing-rule-badge');
      const action = ghost?.querySelector('.routing-rule-actions button');
      const read = (node) => node ? getComputedStyle(node) : null;
      const ghostStyle = read(ghost);
      const placeholderStyle = read(placeholder);
      const badgeStyle = read(badge);
      const actionRect = action?.getBoundingClientRect();
      return {
        ghost: ghostStyle ? {
          radius: ghostStyle.borderRadius,
          backgroundImage: ghostStyle.backgroundImage,
        } : null,
        placeholder: placeholderStyle ? {
          radius: placeholderStyle.borderRadius,
          backgroundImage: placeholderStyle.backgroundImage,
        } : null,
        badge: badgeStyle ? {
          backgroundImage: badgeStyle.backgroundImage,
          boxShadow: badgeStyle.boxShadow,
        } : null,
        action: actionRect ? { width: actionRect.width, height: actionRect.height } : null,
      };
    });
    expect(dragGeometry.ghost).toEqual({ radius: '0px', backgroundImage: 'none' });
    expect(dragGeometry.placeholder).toEqual({ radius: '0px', backgroundImage: 'none' });
    expect(dragGeometry.badge).toEqual({ backgroundImage: 'none', boxShadow: 'none' });
    // Rule actions became icon-only in I6. The drag ghost must preserve the
    // same compact hit target instead of reviving the former text button.
    expect(dragGeometry.action).toEqual({ width: 28, height: 28 });

    await page.mouse.move(target.x + target.width / 4, target.y + 4, { steps: 8 });
    await page.mouse.up();

    await expect(page.locator('#routing-rules-list .routing-rule-card').nth(1).locator('.routing-rule-badge.is-tag')).toContainText('private-direct');
    await expect(page.locator('#routing-rules-list')).not.toHaveAttribute('data-dnd-active', /.+/);
  });

  test('commented JSONC rule is rendered as an explicit disabled record', async ({ page }) => {
    await openStage4Routing(page, 'light', ROUTING_WITH_DISABLED_RULE);

    const disabled = page.locator('#routing-rules-list .routing-rule-card.is-disabled');
    await expect(disabled).toHaveCount(1);
    await expect(disabled).toHaveAttribute('data-disabled', '1');
    await expect(disabled).toHaveAttribute('data-open', '1');
    await expect(disabled.locator('.routing-rule-badge.is-disabled')).toHaveText('отключено');
    await expect(disabled.locator('.routing-rule-disabled-status')).toContainText('RAW JSONC');
    await expect(disabled.locator('.routing-rule-disabled-note')).toContainText('не участвует в маршрутизации');
    await expect(disabled.locator('.routing-rule-toggle')).toHaveText('Вернуть правило');
    await expect(page.locator('#routing-rules-add-btn')).toBeDisabled();
    await expect(page.locator('#routing-rules-list .routing-rule-handle')).toHaveCount(0);
  });
});

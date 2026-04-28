import { test, expect } from '@playwright/test';

const LEFT_TEXT = [
  '{',
  '  "routing": {',
  '    "domainStrategy": "IPIfNonMatch",',
  '    "rules": [',
  '      {',
  '        "type": "field",',
  '        "network": "udp",',
  '        "port": "443",',
  '        "outboundTag": "block,bbb"',
  '      },',
  '      {',
  '        "type": "field",',
  '        "inboundTag": ["redirect", "tproxy"],',
  '        "outboundTag": "direct",',
  '        "ip": [',
  '          "127.0.0.0/8",',
  '          "10.0.0.0/8",',
  '          "172.16.0.0/12",',
  '          "192.168.0.0/16",',
  '          "169.254.0.0/16"',
  '        ]',
  '      },',
  '      {',
  '        "type": "field",',
  '        "inboundTag": ["redirect", "tproxy"],',
  '        "outboundTag": "block",',
  '        "network": "udp",',
  '        "port": "135, 137, 138, 139"',
  '      },',
  '      {',
  '        "type": "field",',
  '        "inboundTag": ["redirect", "tproxy"],',
  '        "outboundTag": "block",',
  '        "domain": [',
  '          "ext:geosite_v2fly.dat:category-ads-all",',
  '          "google-analytics",',
  '          "analytics.yandex",',
  '          "appcenter.ms"',
  '        ]',
  '      },',
  '      {',
  '        "type": "field",',
  '        "outboundTag": "direct",',
  '        "domain": ["example.com"]',
  '      }',
  '    ]',
  '  }',
  '}',
  '',
].join('\n');

const RIGHT_TEXT = LEFT_TEXT
  .replace('"outboundTag": "block,bbb"', '"outboundTag": "block"')
  .replace('"ext:geosite_v2fly.dat:category-ads-all",', '"ext:geosite_v2fly.dat:category-ads-all",\n          "bbb",');

const WRAP_TEXT = [
  '# '.concat('Long descriptive line '.repeat(18)).concat('https://example.com/').concat('abcdef'.repeat(60)),
  'external-ui-url: https://github.com/Zephyruso/zashboard/releases/latest/download/dist.zip?host=ru&token=' + 'abcdef'.repeat(42),
  'proxy-providers:',
  '  proxy-sub:',
  '    type: http',
  '    url: https://cdn.pecan.run/xray/subscription/' + '1234567890'.repeat(24),
  '    path: ./proxy_providers/proxy-sub.yaml',
  '',
].join('\n');

async function waitForRoutingEditor(page) {
  await expect(page.locator('#view-routing')).toBeVisible();
  await page.waitForFunction(() => {
    return !!(
      window.XKeen &&
      window.XKeen.features &&
      window.XKeen.features.routing &&
      window.XKeen.features.routingShell &&
      typeof window.XKeen.features.routingShell.getEditorInstance === 'function'
    );
  });
}

async function ensureCodeMirrorRouting(page) {
  const select = page.locator('#routing-editor-engine-select');
  await expect(select).toBeVisible();
  await select.selectOption('codemirror');
  await page.waitForFunction(() => {
    const maybeEditor = window.XKeen?.features?.routingShell?.getEditorInstance?.({ preferRaw: true });
    const editor = maybeEditor && maybeEditor.raw ? maybeEditor.raw : maybeEditor;
    return !!(
      editor && (
        editor.__xkeenCm6Bridge === true ||
        editor.__xkeen_cm6_bridge === true ||
        editor.backend === 'cm6'
      )
    );
  });
}

async function installProbeScope(page) {
  await page.evaluate(({ leftText, rightText }) => {
    window.__xkeenDiffProbe = {
      leftText,
      rightText,
      saved: 0,
    };
    const diff = window.XKeen?.ui?.diff;
    if (!diff || typeof diff.registerScope !== 'function' || typeof diff.openForScope !== 'function') {
      throw new Error('diff API is not ready');
    }
    diff.registerScope({
      scope: 'probe-cm6',
      label: 'Probe CM6',
      language: 'jsonc',
      getCurrent: () => String(window.__xkeenDiffProbe.leftText || ''),
      getBaseline: () => String(window.__xkeenDiffProbe.rightText || ''),
      applyTextToSide: (side, text) => {
        if (side === 'right') window.__xkeenDiffProbe.rightText = String(text || '');
        else window.__xkeenDiffProbe.leftText = String(text || '');
      },
      save: () => {
        window.__xkeenDiffProbe.saved += 1;
        return true;
      },
    });
  }, { leftText: LEFT_TEXT, rightText: RIGHT_TEXT });
}

async function installWrapProbeScope(page) {
  await page.evaluate(({ text }) => {
    window.__xkeenDiffWrapProbe = { text };
    const diff = window.XKeen?.ui?.diff;
    if (!diff || typeof diff.registerScope !== 'function' || typeof diff.openForScope !== 'function') {
      throw new Error('diff API is not ready');
    }
    diff.registerScope({
      scope: 'probe-cm6-wrap',
      label: 'Probe CM6 Wrap',
      language: 'yaml',
      getCurrent: () => String(window.__xkeenDiffWrapProbe.text || ''),
      getBaseline: () => String(window.__xkeenDiffWrapProbe.text || ''),
      applyTextToSide: () => {},
      save: () => true,
    });
  }, { text: WRAP_TEXT });
}

async function openScope(page, scopeName) {
  await page.evaluate((scope) => {
    window.XKeen.ui.diff.openForScope(scope).catch((error) => {
      console.error('probe diff open failed', error);
    });
  }, scopeName);
  await expect(page.locator('#xkeen-diff-modal')).toBeVisible();
}

async function openProbeDiff(page) {
  await openScope(page, 'probe-cm6');
  await expect(page.locator('#xkeen-diff-modal .xkeen-diff-summary')).toContainText('Изменений: 2');
}

async function collectCm6State(page) {
  return page.evaluate(() => {
    const root = document.querySelector('#xkeen-diff-modal');
    const textboxes = Array.from(root?.querySelectorAll('.cm-mergeView [role="textbox"]') || []);
    const leftBox = textboxes[0] || null;
    const rightBox = textboxes[1] || null;
    const left = leftBox ? leftBox.querySelector('.cm-scroller') : null;
    const right = rightBox ? rightBox.querySelector('.cm-scroller') : null;
    const placeholders = Array.from(root?.querySelectorAll('.cm-collapsedLines, .cm-merge-collapsed') || []).map((el) =>
      String(el.textContent || '').trim()
    );
    const summary = String(root?.querySelector('.xkeen-diff-summary')?.textContent || '').trim();
    const leftVisibleText = Array.from(leftBox?.querySelectorAll('.cm-line') || [])
      .slice(0, 18)
      .map((el) => String(el.textContent || ''));
    const rightVisibleText = Array.from(rightBox?.querySelectorAll('.cm-line') || [])
      .slice(0, 18)
      .map((el) => String(el.textContent || ''));
    return {
      summary,
      placeholders,
      leftScrollTop: left ? left.scrollTop : -1,
      rightScrollTop: right ? right.scrollTop : -1,
      leftHeight: left ? left.scrollHeight : -1,
      rightHeight: right ? right.scrollHeight : -1,
      leftVisibleText,
      rightVisibleText,
      probe: window.__xkeenDiffProbe || null,
    };
  });
}

async function collectCm6ActiveHunk(page) {
  return page.evaluate(() => {
    const root = document.querySelector('#xkeen-diff-modal');
    const textboxes = Array.from(root?.querySelectorAll('.cm-mergeView [role="textbox"]') || []);
    const leftBox = textboxes[0] || null;
    const rightBox = textboxes[1] || null;
    const collect = (box) => Array.from(box?.querySelectorAll('.cm-line.xkeen-diff-cm6-active-hunk-line') || [])
      .map((el) => String(el.textContent || '').trim())
      .filter(Boolean);
    return {
      leftLines: collect(leftBox),
      rightLines: collect(rightBox),
    };
  });
}

async function collectCm6WrapMetrics(page) {
  return page.evaluate(() => {
    const boxes = Array.from(document.querySelectorAll('#xkeen-diff-modal .cm-mergeView [role="textbox"]'));
    return boxes.map((box) => {
      const scroller = box.querySelector('.cm-scroller');
      const content = box.querySelector('.cm-content');
      if (scroller) {
        try { scroller.scrollLeft = 240; } catch (e) {}
      }
      return {
        clientWidth: scroller ? scroller.clientWidth : -1,
        scrollWidth: scroller ? scroller.scrollWidth : -1,
        scrollLeft: scroller ? scroller.scrollLeft : -1,
        hasWrappingClass: !!(
          (content && content.classList && content.classList.contains('cm-lineWrapping')) ||
          box.querySelector('.cm-lineWrapping')
        ),
      };
    });
  });
}

function expectPanesVisible(state) {
  expect(state.leftVisibleText.length).toBeGreaterThan(0);
  expect(state.rightVisibleText.length).toBeGreaterThan(0);
}

test('CodeMirror diff modal keeps both panes visible after apply-left', async ({ page }) => {
  await page.goto('/');
  await waitForRoutingEditor(page);
  await ensureCodeMirrorRouting(page);
  await page.waitForFunction(() => !!window.XKeen?.ui?.diffModal?.open);
  await installProbeScope(page);
  await openProbeDiff(page);

  const before = await collectCm6State(page);
  expectPanesVisible(before);

  await page.locator('#xkeen-diff-modal .xkeen-diff-apply-group .xkeen-diff-apply-btn').nth(2).click();
  await expect(page.locator('#xkeen-diff-modal .xkeen-diff-summary')).toContainText('перенесено: 1');
  await page.waitForTimeout(300);

  const after = await collectCm6State(page);
  expectPanesVisible(after);
  expect(after.summary).toContain('Изменений: 1');
  expect(after.summary).toContain('перенесено: 1');
  expect(after.leftVisibleText.join('\n')).toContain('"outboundTag": "block"');
  expect(after.rightVisibleText.join('\n')).toContain('"bbb",');
});

test('CodeMirror diff modal keeps panes stable across apply-right, apply-all, and revert', async ({ page }) => {
  await page.goto('/');
  await waitForRoutingEditor(page);
  await ensureCodeMirrorRouting(page);
  await page.waitForFunction(() => !!window.XKeen?.ui?.diffModal?.open);
  await installProbeScope(page);
  await openProbeDiff(page);

  const before = await collectCm6State(page);
  expectPanesVisible(before);

  await page.locator('#xkeen-diff-modal .xkeen-diff-apply-group .xkeen-diff-apply-btn').nth(3).click();
  await expect(page.locator('#xkeen-diff-modal .xkeen-diff-summary')).toContainText('перенесено: 1');
  await page.waitForTimeout(300);

  const afterApplyRight = await collectCm6State(page);
  expectPanesVisible(afterApplyRight);
  expect(afterApplyRight.summary).toContain('Изменений: 1');

  await page.locator('#xkeen-diff-modal .xkeen-diff-apply-group .xkeen-diff-apply-btn').nth(0).click();
  await expect(page.locator('#xkeen-diff-modal .xkeen-diff-summary')).toContainText('Различий нет');
  await page.waitForTimeout(300);

  const afterApplyAll = await collectCm6State(page);
  expectPanesVisible(afterApplyAll);
  expect(afterApplyAll.summary).toContain('Различий нет');

  await page.locator('#xkeen-diff-modal .xkeen-diff-revert-btn').click();
  await expect(page.locator('#xkeen-diff-modal .xkeen-diff-summary')).toContainText('Изменений: 2');
  await page.waitForTimeout(300);

  const afterRevert = await collectCm6State(page);
  expectPanesVisible(afterRevert);
  expect(afterRevert.summary).toContain('Изменений: 2');
});

test('CodeMirror diff modal clearly highlights the hunk clicked with the mouse', async ({ page }) => {
  await page.goto('/');
  await waitForRoutingEditor(page);
  await ensureCodeMirrorRouting(page);
  await page.waitForFunction(() => !!window.XKeen?.ui?.diffModal?.open);
  await installProbeScope(page);
  await openProbeDiff(page);

  const rightPane = page.locator('#xkeen-diff-modal .cm-mergeView [role="textbox"]').nth(1);
  await rightPane.locator('.cm-line').filter({ hasText: '"bbb",' }).first().click();
  await page.waitForTimeout(220);

  const active = await collectCm6ActiveHunk(page);
  expect(active.leftLines.length).toBeGreaterThan(0);
  expect(active.rightLines.length).toBeGreaterThan(0);
  expect(active.rightLines.join('\n')).toContain('"bbb",');
});

test('CodeMirror diff modal wraps long lines without horizontal pane overflow', async ({ page }) => {
  await page.goto('/');
  await waitForRoutingEditor(page);
  await ensureCodeMirrorRouting(page);
  await page.waitForFunction(() => !!window.XKeen?.ui?.diffModal?.open);
  await installWrapProbeScope(page);
  await openScope(page, 'probe-cm6-wrap');
  await expect(page.locator('#xkeen-diff-modal .xkeen-diff-summary')).toContainText('Различий нет');
  await page.waitForTimeout(500);

  const panes = await collectCm6WrapMetrics(page);
  expect(panes.length).toBe(2);
  for (const pane of panes) {
    expect(pane.scrollWidth - pane.clientWidth).toBeLessThanOrEqual(4);
    expect(pane.scrollLeft).toBeLessThanOrEqual(1);
  }
});

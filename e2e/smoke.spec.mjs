import { test, expect } from './fixtures.mjs';

async function waitForMihomoGeneratorPreview(page) {
  await expect(page.locator('#profileSelect')).toBeVisible();
  await page.waitForFunction(() => {
    const editors = Array.isArray(window.__xkeenEditors) ? window.__xkeenEditors : [];
    return editors.some((editor) => {
      try {
        return typeof editor.getValue === 'function';
      } catch (error) {
        return false;
      }
    });
  });
}

async function getMihomoGeneratorPreviewText(page) {
  return page.evaluate(() => {
    const editors = Array.isArray(window.__xkeenEditors) ? window.__xkeenEditors : [];
    for (const editor of editors) {
      try {
        if (typeof editor.getValue !== 'function') continue;
        const value = String(editor.getValue() || '');
        if (value.includes('proxy-groups:')) return value;
      } catch (error) {}
    }
    return '';
  });
}


test('panel shell renders top-level navigation', async ({ page }) => {
  await page.goto('/');

  await expect(page).toHaveTitle(/Xkeen UI/i);
  await expect(page.locator('#top-tab-mihomo-generator')).toBeVisible();
  await expect(page.locator('body')).toContainText('Mihomo Генератор');
  await expect(page.locator('body')).toContainText('DevTools');
});


test('panel navigation style survives generator and DevTools round trips', async ({ page }) => {
  await page.goto('/');

  const panelTabs = page.locator('.top-tabs.header-tabs');
  const routingTab = page.locator('.top-tabs.header-tabs .top-tab-btn').first();
  await expect(panelTabs).toBeVisible();
  await expect(page.locator('body')).toHaveClass(/\bpanel-page\b/);

  const initialStylesheetCount = await page.locator('link[rel="stylesheet"]').evaluateAll((links) => (
    links.filter((link) => new URL(link.href).pathname.endsWith('/static/styles.css')).length
  ));
  const initialTabStyle = await routingTab.evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      borderRadius: style.borderRadius,
      minHeight: style.minHeight,
    };
  });

  await page.locator('#top-tab-mihomo-generator').click();
  await expect(page).toHaveURL(/\/mihomo_generator$/);
  await expect(page.locator('body')).toHaveClass(/\bmihomo-generator-page\b/);
  await page.getByRole('link', { name: /назад/i }).click();

  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator('body')).toHaveClass(/\bpanel-page\b/);
  await expect(panelTabs).toBeVisible();

  const restoredStylesheetCount = await page.locator('link[rel="stylesheet"]').evaluateAll((links) => (
    links.filter((link) => new URL(link.href).pathname.endsWith('/static/styles.css')).length
  ));
  const restoredTabStyle = await routingTab.evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      borderRadius: style.borderRadius,
      minHeight: style.minHeight,
    };
  });

  expect(restoredStylesheetCount).toBe(initialStylesheetCount);
  expect(restoredTabStyle).toEqual(initialTabStyle);

  await page.locator('.panel-header .xk-header-btn-devtools').click();
  await expect(page).toHaveURL(/\/devtools$/);
  await expect(page.locator('body')).toHaveClass(/\bdevtools-page\b/);
  await page.locator('.dt-header-btn-back').click();

  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator('body')).toHaveClass(/\bpanel-page\b/);
  await expect(panelTabs).toBeVisible();

  const devtoolsRoundTripStylesheetCount = await page.locator('link[rel="stylesheet"]').evaluateAll((links) => (
    links.filter((link) => new URL(link.href).pathname.endsWith('/static/styles.css')).length
  ));
  const devtoolsRoundTripTabStyle = await routingTab.evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      borderRadius: style.borderRadius,
      minHeight: style.minHeight,
    };
  });

  expect(devtoolsRoundTripStylesheetCount).toBe(initialStylesheetCount);
  expect(devtoolsRoundTripTabStyle).toEqual(initialTabStyle);
});


test('devtools page renders update and env sections', async ({ page }) => {
  await page.goto('/devtools');

  await expect(page).toHaveTitle(/DevTools/i);
  await expect(page.locator('#dt-update-card')).toBeVisible();
  await page.locator('#dt-update-card').evaluate((node) => { node.open = true; });
  await expect(page.locator('#dt-update-check')).toBeVisible();
  await expect(page.locator('#dt-update-run')).toBeVisible();
  await expect(page.locator('#dt-env-card')).toBeVisible();
});


test('devtools update card completes load-info and manual check flow', async ({ page }) => {
  let infoHits = 0;
  let checkHits = 0;
  let forcedRefreshSeen = false;

  await page.route('**/api/devtools/update/info', async (route) => {
    infoHits += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        build: {
          version: '1.6.0',
          repo: 'umarcheh001/Xkeen-UI',
          channel: 'stable',
          commit: 'abc1234',
          built_utc: '2026-04-10T21:00:00Z',
        },
        capabilities: {
          curl: true,
          tar: true,
          sha256sum: true,
        },
        settings: {
          repo: 'umarcheh001/Xkeen-UI',
          channel: 'stable',
          branch: 'main',
        },
        security: {
          sha_strict: '1',
          require_sha: '1',
        },
      }),
    });
  });

  await page.route('**/api/devtools/update/check', async (route) => {
    checkHits += 1;
    const payload = route.request().postDataJSON() || {};
    if (payload.force_refresh === true) forcedRefreshSeen = true;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        error: null,
        repo: 'umarcheh001/Xkeen-UI',
        channel: 'stable',
        branch: 'main',
        current: {
          version: '1.6.0',
          repo: 'umarcheh001/Xkeen-UI',
          channel: 'stable',
          commit: 'abc1234',
        },
        latest: {
          kind: 'stable',
          tag: 'v1.7.4',
          published_at: '2026-04-11T00:00:00Z',
          asset: {
            name: 'xkeen-ui-routing.tar.gz',
            download_url: 'https://github.com/umarcheh001/Xkeen-UI/releases/download/v1.7.4/xkeen-ui-routing.tar.gz',
          },
          sha256_asset: {
            kind: 'sidecar',
            download_url: 'https://github.com/umarcheh001/Xkeen-UI/releases/download/v1.7.4/xkeen-ui-routing.tar.gz.sha256',
          },
        },
        update_available: true,
        stale: false,
        meta: {
          source: 'e2e-smoke',
        },
        security: {
          settings: {
            sha_strict: '1',
            require_sha: '1',
          },
          download: {
            url: 'https://github.com/umarcheh001/Xkeen-UI/releases/download/v1.7.4/xkeen-ui-routing.tar.gz',
            ok: true,
            reason: 'allowed',
          },
          checksum: {
            present: true,
            kind: 'sidecar',
            url: 'https://github.com/umarcheh001/Xkeen-UI/releases/download/v1.7.4/xkeen-ui-routing.tar.gz.sha256',
            ok: true,
            reason: 'allowed',
          },
          warnings: [],
          will_block_run: false,
        },
      }),
    });
  });

  await page.goto('/devtools');

  await expect(page).toHaveTitle(/DevTools/i);
  await expect(page.locator('#dt-update-card')).toBeVisible();
  await expect.poll(() => infoHits).toBeGreaterThan(0);
  await expect.poll(() => checkHits).toBeGreaterThan(0);

  await expect(page.locator('#dt-update-repo')).toContainText('umarcheh001/Xkeen-UI');
  await expect(page.locator('#dt-update-channel')).toContainText('stable');
  await expect(page.locator('#dt-update-branch')).toContainText('main');
  await expect(page.locator('#dt-update-current-version')).toContainText('1.6.0');
  await expect(page.locator('#dt-update-latest-kind')).toContainText('stable');
  await expect(page.locator('#dt-update-latest-version')).toContainText('v1.7.4');
  await expect(page.locator('#dt-update-verdict')).toContainText('Доступно обновление');

  await page.locator('#dt-update-check').click();

  await expect.poll(() => checkHits).toBeGreaterThan(1);
  await expect.poll(() => forcedRefreshSeen).toBeTruthy();
  await expect(page.locator('#dt-update-verdict')).toContainText('Доступно обновление');
});


test('backups history page renders table', async ({ page }) => {
  await page.goto('/backups');

  await expect(page).toHaveTitle(/Бэкапы/i);
  await expect(page.locator('#backups-table')).toBeVisible();
  await expect(page.locator('body')).toContainText('Бэкапы Xray конфигов');
});


test('mihomo generator page renders source and preview panes', async ({ page }) => {
  await page.goto('/mihomo_generator');

  await expect(page).toHaveTitle(/Mihomo/i);
  await expect(page.locator('#profileSelect')).toBeVisible();
  await expect(page.locator('#defaultGroupsInput')).toBeVisible();
  await expect(page.locator('#previewTextarea')).toBeAttached();
  await expect(page.locator('body')).toContainText('Исходные данные');
  await expect(page.locator('body')).toContainText('Предпросмотр');
  await expect(page.locator('#previewToolbarHost button[data-action-id="fs"], #previewToolbarHost button[data-action-id="fs_any"]').first()).toBeVisible();
});


test('mihomo generator keeps its editor controls and subscription fields aligned', async ({ page }) => {
  await page.goto('/mihomo_generator');
  await waitForMihomoGeneratorPreview(page);
  await expect(page.locator('#previewToolbarHost .xkeen-cm-toolbar')).toBeVisible();
  await expect(page.locator('.subscription-row button')).toBeVisible();
  await expect(page.locator('.rule-group-checkbox').first()).toBeVisible();

  const geometry = await page.evaluate(() => {
    const engine = document.querySelector('#mihomo-preview-engine-select');
    const toolbar = document.querySelector('#previewToolbarHost .xkeen-cm-toolbar');
    const row = document.querySelector('.subscription-row');
    const input = row?.querySelector('input');
    const remove = row?.querySelector('button');
    const selectAll = document.querySelector('#ruleGroupsSelectAll');
    const ruleGroup = document.querySelector('.rule-group-checkbox');

    if (!engine || !toolbar || !row || !input || !remove || !selectAll || !ruleGroup) {
      throw new Error('Mihomo generator controls are incomplete');
    }

    const engineRect = engine.getBoundingClientRect();
    const toolbarRect = toolbar.getBoundingClientRect();
    const inputRect = input.getBoundingClientRect();
    const removeRect = remove.getBoundingClientRect();

    return {
      toolbarGap: Math.round(toolbarRect.left - engineRect.right),
      rowControlBottomDelta: Math.abs(Math.round(removeRect.bottom - inputRect.bottom)),
      selectAllAccent: getComputedStyle(selectAll).accentColor,
      ruleGroupAccent: getComputedStyle(ruleGroup).accentColor,
    };
  });

  expect(geometry.toolbarGap).toBeGreaterThanOrEqual(8);
  expect(geometry.rowControlBottomDelta).toBeLessThanOrEqual(1);
  expect(geometry.selectAllAccent).toBe(geometry.ruleGroupAccent);
  expect(geometry.selectAllAccent).not.toBe('rgb(37, 99, 235)');
  expect(geometry.selectAllAccent).not.toBe('rgb(96, 165, 250)');
});


test('mihomo managed subscription confirmation stays clickable without an overlapping tooltip', async ({ page }) => {
  let subscriptionPresent = true;
  let deleteRequested = false;
  await page.route('**/api/mihomo/subscriptions', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        subscriptions: subscriptionPresent ? [{
          id: 'e2e-subscription',
          url: 'https://example.invalid/subscription',
          tag: 'xray-sub:e2e',
          enabled: true,
          interval_hours: 24,
          last_count: 17,
          last_ok: true,
          next_update_ts: Date.now() / 1000 + 86400,
        }] : [],
      }),
    });
  });
  await page.route('**/api/mihomo/subscriptions/e2e-subscription', async (route) => {
    deleteRequested = true;
    subscriptionPresent = false;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, subscription: { id: 'e2e-subscription' } }),
    });
  });

  await page.goto('/mihomo_generator');
  await waitForMihomoGeneratorPreview(page);

  const deleteButton = page.getByRole('button', { name: 'Удалить запись автообновления' });
  await expect(deleteButton).toBeVisible();
  await expect(deleteButton).toHaveAttribute('data-tooltip-silent', '1');
  await expect(deleteButton).not.toHaveAttribute('data-tooltip', /.+/);

  await deleteButton.hover();
  await expect(page.locator('#xk-tooltip-portal')).toBeHidden();
  await deleteButton.click();

  const confirm = page.locator('#confirm-modal');
  await expect(confirm).toBeVisible();
  const remove = confirm.getByRole('button', { name: 'Удалить', exact: true });
  await expect(remove).toBeEnabled();
  await remove.click();
  await expect(confirm).toBeHidden();
  await expect.poll(() => deleteRequested).toBeTruthy();
  await expect(page.locator('.mihomo-managed-sub-item')).toHaveCount(0);
});


test('mihomo bulk import presents a guided operator flow without legacy blue chrome', async ({ page }) => {
  await page.goto('/mihomo_generator');
  await waitForMihomoGeneratorPreview(page);
  await page.locator('#bulkImportBtn').click();

  const modal = page.locator('#bulkImportModal');
  await expect(modal).toBeVisible();
  await expect(modal).toHaveAttribute('data-operator-modal-family', 'compact-form');
  await expect(modal.locator('#bulkImportModalTitle')).toHaveText('Импорт списка');
  await expect(modal.locator('.bulk-import-options-title')).toContainText('Шаг 2');
  await expect(modal.locator('.bulk-import-summary-title')).toHaveText('Сводка импорта');

  const chrome = await modal.evaluate((node) => {
    const summary = node.querySelector('#bulkImportSummary');
    const textarea = node.querySelector('#bulkImportTextarea');
    const check = node.querySelector('#bulkImportToSubscriptions');
    return {
      modalBackgroundImage: getComputedStyle(node).backgroundImage,
      summaryBackgroundImage: summary ? getComputedStyle(summary).backgroundImage : '',
      textareaBackgroundImage: textarea ? getComputedStyle(textarea).backgroundImage : '',
      accent: check ? getComputedStyle(check).accentColor : '',
    };
  });

  expect(chrome.modalBackgroundImage).toBe('none');
  expect(chrome.summaryBackgroundImage).toBe('none');
  expect(chrome.textareaBackgroundImage).toBe('none');
  expect(chrome.accent).not.toBe('rgb(96, 165, 250)');

  await modal.locator('#bulkImportTextarea').fill('vless://example\nhttps://sub.example.com/list');
  await expect(modal.locator('#bulkImportSummary')).toContainText('Будет добавлено: узлов 1, подписок 1.');
});


test('routing Mihomo proxy tools use a compact operator empty state', async ({ page }) => {
  await page.goto('/');
  await page.locator('.top-tab-btn[data-view="mihomo"]').click();
  await expect(page.locator('#view-mihomo')).toBeVisible();

  const menu = page.locator('.xk-mihomo-menu');
  await menu.locator('summary').click();
  await page.locator('#mihomo-proxy-tools-btn').click();

  const modal = page.locator('#mihomo-proxy-tools-modal');
  await expect(modal).toBeVisible();
  await expect(modal.locator('#mihomo-proxy-tools-title')).toHaveText('Управление proxy');
  await expect(modal.locator('.xk-pt-section-kicker').first()).toHaveText('Шаг 1');
  await expect(modal.locator('.xk-pt-empty')).toBeVisible();
  await expect(modal.locator('.xk-pt-empty-title')).toHaveText('В конфиге нет статических узлов');
  await expect(modal.locator('#mihomo-proxy-tools-add-static-btn')).toHaveText('Добавить пример proxy');

  const chrome = await modal.evaluate((node) => {
    const lead = node.querySelector('.xk-pt-lead');
    const empty = node.querySelector('.xk-pt-empty');
    const add = node.querySelector('#mihomo-proxy-tools-add-static-btn');
    return {
      modalBackgroundImage: getComputedStyle(node).backgroundImage,
      leadBackgroundImage: lead ? getComputedStyle(lead).backgroundImage : '',
      emptyBackgroundImage: empty ? getComputedStyle(empty).backgroundImage : '',
      addBackgroundImage: add ? getComputedStyle(add).backgroundImage : '',
    };
  });

  expect(chrome.modalBackgroundImage).toBe('none');
  expect(chrome.leadBackgroundImage).toBe('none');
  expect(chrome.emptyBackgroundImage).toBe('none');
  expect(chrome.addBackgroundImage).toBe('none');
});


test('routing Mihomo proxy tools keep a scrollable resize-safe workbench and aligned action labels', async ({ page }) => {
  await page.goto('/');
  await page.locator('.top-tab-btn[data-view="mihomo"]').click();
  await expect(page.locator('#view-mihomo')).toBeVisible();

  const menu = page.locator('.xk-mihomo-menu');
  await menu.locator('summary').click();
  await page.locator('#mihomo-proxy-tools-btn').click();

  const modal = page.locator('#mihomo-proxy-tools-modal');
  const content = modal.locator('.modal-content');
  const body = modal.locator('.xk-pt-body');
  await expect(modal).toBeVisible();

  const before = await content.evaluate((node) => ({
    height: node.getBoundingClientRect().height,
    scrollHeight: node.querySelector('.xk-pt-body')?.scrollHeight || 0,
    clientHeight: node.querySelector('.xk-pt-body')?.clientHeight || 0,
    overflowY: getComputedStyle(node.querySelector('.xk-pt-body')).overflowY,
  }));
  expect(before.overflowY).toBe('auto');

  await content.evaluate((node) => {
    const panel = node.querySelector('.xk-pt-empty') || node.querySelector('.xk-pt-card--replace');
    panel.insertAdjacentHTML('beforeend', '<div data-test-proxy-tools-overflow style="height: 1200px"></div>');
  });
  await expect.poll(() => body.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);

  const resizer = modal.locator('.modal-resizer');
  await expect(resizer).toBeVisible();
  const resizerBox = await resizer.boundingBox();
  await page.mouse.move(resizerBox.x + 4, resizerBox.y + 4);
  await page.mouse.down();
  await page.mouse.move(resizerBox.x + 4, resizerBox.y + 84, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => content.evaluate((node) => node.getBoundingClientRect().height)).toBeGreaterThan(before.height + 50);

  await modal.locator('#mihomo-proxy-tools-add-static-btn').click();
  await expect(modal.locator('#mihomo-proxy-tools-select')).toHaveValue('static-proxy-1');

  for (const selector of [
    '#mihomo-proxy-tools-rename-btn',
    '#mihomo-proxy-tools-prepare-btn',
    '#mihomo-proxy-tools-replace-btn',
  ]) {
    const action = modal.locator(selector);
    const layout = await action.evaluate((button) => {
      const buttonRect = button.getBoundingClientRect();
      const icon = button.querySelector('.xk-action-icon')?.getBoundingClientRect();
      const label = button.querySelector('.xk-action-label')?.getBoundingClientRect();
      return {
        buttonTop: buttonRect.top,
        buttonBottom: buttonRect.bottom,
        iconTop: icon?.top || 0,
        iconBottom: icon?.bottom || 0,
        iconRight: icon?.right || 0,
        labelLeft: label?.left || 0,
        labelTop: label?.top || 0,
        labelBottom: label?.bottom || 0,
      };
    });
    expect(layout.iconRight).toBeLessThan(layout.labelLeft);
    expect(layout.labelTop).toBeGreaterThanOrEqual(layout.buttonTop);
    expect(layout.labelBottom).toBeLessThanOrEqual(layout.buttonBottom);
    expect(layout.iconTop).toBeGreaterThanOrEqual(layout.buttonTop);
    expect(layout.iconBottom).toBeLessThanOrEqual(layout.buttonBottom);
  }
});


test('mihomo generator removes optional rule groups from preview when all checkboxes are cleared', async ({ page }) => {
  await page.goto('/mihomo_generator');
  await waitForMihomoGeneratorPreview(page);

  await page.selectOption('#profileSelect', 'router_zkeen');
  await expect
    .poll(() => page.evaluate(() => document.querySelectorAll('.rule-group-checkbox:checked').length))
    .toBeGreaterThan(0);
  await expect(page.locator('#stateSummary')).toContainText(/Rule-групп:\s*[1-9]/);
  await expect.poll(() => getMihomoGeneratorPreviewText(page)).toContain('- name: YouTube');

  await page.locator('#ruleGroupsSelectAll').evaluate((node) => {
    node.checked = false;
    node.dispatchEvent(new Event('change', { bubbles: true }));
  });

  await expect(page.locator('#stateSummary')).toContainText('Rule-групп: 0');
  await expect.poll(() => getMihomoGeneratorPreviewText(page)).not.toContain('- name: YouTube');
  await expect.poll(() => getMihomoGeneratorPreviewText(page)).not.toContain('- name: Discord');
  await expect.poll(() => getMihomoGeneratorPreviewText(page)).toContain('- name: Заблок. сервисы');
});


test('mihomo preview modal collapses the empty log column', async ({ page }) => {
  await page.goto('/mihomo_generator');
  await waitForMihomoGeneratorPreview(page);

  await page.locator('#defaultGroupsInput').fill('GhostGroup');
  await page.locator('#generateBtn').click();

  await expect(page.locator('#mihomoResultModal')).toBeVisible();
  await expect(page.locator('#mihomoResultGrid')).toHaveAttribute('data-has-log', '0');
  await expect(page.locator('#mihomoResultSidePanel')).toBeHidden();
  await expect(page.locator('.mihomo-result-overview')).toBeVisible();
  await expect(page.locator('#mihomoResultWarnings')).toContainText('Неизвестные группы по умолчанию');
});


test('mihomo validation modal uses compact validate layout', async ({ page }) => {
  await page.goto('/mihomo_generator');
  await waitForMihomoGeneratorPreview(page);

  await page.locator('#validateBtn').click();

  await expect(page.locator('#mihomoResultModal')).toBeVisible();
  await expect(page.locator('#mihomoResultModal')).toHaveAttribute('data-mode', 'validate');
  await expect(page.locator('#mihomoResultGrid')).toHaveAttribute('data-has-log', '1');
  await expect(page.locator('#mihomoResultSidePanel')).toBeVisible();
  await expect(page.locator('#mihomoResultMetaWrap')).toContainText('Источник');
  await expect(page.locator('#mihomoResultMetaWrap')).toContainText('Операция');
  await expect(page.locator('#mihomoResultModal .mihomo-result-terminal')).toBeVisible();
  await expect(page.locator('#mihomoResultModal')).toHaveCSS('background-image', 'none');
  await expect(page.locator('#mihomoResultModal .modal-content')).toHaveCSS('background-image', 'none');
  await expect(page.locator('#mihomoResultModal .mihomo-result-state-badge')).toHaveCSS('border-radius', '6px');
  await expect(page.locator('#mihomoResultModal .mihomo-result-grid')).toHaveCSS('border-radius', '9px');
});


test('mihomo generator keeps a readable neutral validation log', async ({ page }) => {
  await page.goto('/mihomo_generator');
  await waitForMihomoGeneratorPreview(page);

  await page.locator('#validationLog').evaluate((node) => {
    node.textContent = 'line 1\nline 2\nline 3\nline 4\nline 5';
  });

  await expect(page.locator('.validation-log-panel')).toHaveCSS('background-image', 'none');
  await expect(page.locator('#validationLog')).toHaveCSS('background-image', 'none');
  const logSurface = await page.locator('#validationLog').evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      background: style.backgroundColor,
      page: getComputedStyle(document.body).backgroundColor,
    };
  });
  expect(logSurface.background).toBe(logSurface.page);

  const geometry = await page.locator('.validation-log-panel').evaluate((panel) => {
    const log = panel.querySelector('.validation-log');
    return {
      panelHeight: Math.round(panel.getBoundingClientRect().height),
      logHeight: Math.round(log.getBoundingClientRect().height),
    };
  });
  expect(geometry.panelHeight).toBeGreaterThanOrEqual(146);
  expect(geometry.logHeight).toBeGreaterThanOrEqual(88);
});

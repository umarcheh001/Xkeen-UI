import { test, expect } from '@playwright/test';

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
});

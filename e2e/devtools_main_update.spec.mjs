import { test, expect } from './fixtures.mjs';

function mockMainUpdate(page, { latestSha }) {
  const repo = 'umarcheh001/Xkeen-UI';
  const current = { version: '2.10.0', repo, channel: 'main', commit: `abc1234${'0'.repeat(33)}` };
  const tarballUrl = `https://codeload.github.com/${repo}/tar.gz/${latestSha}`;
  return Promise.all([
    page.route('**/api/devtools/update/info', (route) => route.fulfill({ json: {
      ok: true, build: current,
      capabilities: { curl: true, tar: true, tar_exclude: true, sha256sum: true },
      settings: { repo, channel: 'main', branch: 'main' }, security: {},
    } })),
    page.route('**/api/devtools/update/status*', (route) => route.fulfill({ json: {
      ok: true, status: { state: 'idle' }, log_tail: [],
      lock: { exists: false, alive: false, stale: false }, backups: [], has_backup: false,
      reconciled: false, development_only: true,
    } })),
    page.route('**/api/devtools/update/check', (route) => route.fulfill({ json: {
      ok: true, error: null, repo, channel: 'main', branch: 'main', current,
      latest: { kind: 'main', branch: 'main', sha: latestSha, short_sha: latestSha.slice(0, 7),
        committed_at: null, message: null, html_url: null, tarball_url: tarballUrl },
      update_available: latestSha !== current.commit, stale: false,
      meta: { repo, branch: 'main', default_branch: null },
      security: { settings: {}, download: { url: tarballUrl, ok: true, reason: null },
        checksum: null, warnings: [], will_block_run: false }, development_only: true,
    } })),
  ]);
}

test('main updater offers a newer GitHub commit through legacy controls', async ({ page }) => {
  await mockMainUpdate(page, { latestSha: `def5678${'0'.repeat(33)}` });
  await page.goto('/devtools');

  await expect(page.locator('[data-dt-main-update-controls]')).toBeVisible();
  await expect(page.locator('#dt-update-latest-version')).toContainText('main@def5678');
  await expect(page.locator('#dt-update-verdict')).toContainText('Доступно обновление');
  await expect(page.locator('#dt-update-run')).toBeEnabled();
  await expect(page.locator('#dt-update-security')).toBeHidden();
});

test('main updater reports the current GitHub commit without installer guidance', async ({ page }) => {
  await mockMainUpdate(page, { latestSha: `abc1234${'0'.repeat(33)}` });
  await page.goto('/devtools');

  await expect(page.locator('#dt-update-latest-version')).toContainText('main@abc1234');
  await expect(page.locator('#dt-update-verdict')).toContainText('У вас актуальная версия');
  await expect(page.locator('#dt-update-security')).toBeHidden();
});

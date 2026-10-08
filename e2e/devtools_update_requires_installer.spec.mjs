import { test, expect } from './fixtures.mjs';

// Релиз может назвать самую старую панель, которая способна обновиться на него
// сама. Панель старше не должна предлагать «Обновить» как обычно: владелец
// видит, что эту версию ставит установщик, а кнопка объясняет это вместо запуска.

function mockUpdate(page, check) {
  let runHits = 0;
  return Promise.all([
    page.route('**/api/devtools/update/info', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        build: { version: '2.10.0', repo: 'umarcheh001/Xkeen-UI', channel: 'stable', commit: 'abc1234' },
        capabilities: { curl: true, tar: true, sha256sum: true },
        settings: { repo: 'umarcheh001/Xkeen-UI', channel: 'stable', branch: 'main' },
        security: {},
      }),
    })),
    page.route('**/api/devtools/update/check', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        error: null,
        repo: 'umarcheh001/Xkeen-UI',
        channel: 'stable',
        branch: null,
        current: { version: '2.10.0' },
        latest: { version: '2.11.0', tag: 'v2.11.0' },
        update_available: true,
        stale: false,
        meta: { source: 'signed_lifecycle_catalog' },
        security: { signed_catalog: true, will_block_run: false },
        lifecycle_check: {
          ok: true,
          source_version: '2.10.0',
          target_version: '2.11.0',
          update_available: true,
          ...check,
        },
      }),
    })),
    page.route('**/api/devtools/update/run', (route) => {
      runHits += 1;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    }),
  ]).then(() => ({ runHits: () => runHits }));
}

test('a panel too old for the release is sent to the installer', async ({ page }) => {
  const calls = await mockUpdate(page, { requires_installer: true, min_updater: '2.10.5' });

  await page.goto('/devtools');
  await expect(page.locator('#dt-update-card')).toBeVisible();

  const verdict = page.locator('#dt-update-verdict');
  await expect(verdict).toContainText('установщик');
  await expect(verdict).toContainText('v2.11.0');
  // Причина названа словами, с версией, начиная с которой панель обновляется сама.
  const box = page.locator('#dt-update-security');
  await expect(box).toBeVisible();
  await expect(box).toContainText('2.10.5');
  await expect(box).toContainText('install.sh');
  await expect(page.locator('#dt-update-verdict')).not.toContainText('политик');

  // Кнопка не запускает обновление, которое заведомо откажет.
  await page.locator('#dt-update-run').click();
  await page.waitForTimeout(500);
  expect(calls.runHits()).toBe(0);
});

test('a panel new enough is offered the update as usual', async ({ page }) => {
  await mockUpdate(page, { requires_installer: false, min_updater: null });

  await page.goto('/devtools');
  await expect(page.locator('#dt-update-card')).toBeVisible();

  await expect(page.locator('#dt-update-verdict')).toContainText('Доступно обновление');
  await expect(page.locator('#dt-update-security')).toBeHidden();
});

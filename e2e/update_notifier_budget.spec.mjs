import { test, expect } from './fixtures.mjs';

// Плашка «есть обновление» хранится в браузере. Пока она висит, загрузка
// страницы не должна каждый раз заново спрашивать GitHub: для этого есть
// обычный интервал проверки.

async function seedPendingUpdate(page, { lastCheckAgeMs, channel = 'main' }) {
  await page.addInitScript(({ ageMs, channel }) => {
    const now = Date.now();
    window.localStorage.setItem('xk_update_notify_enabled', '1');
    window.localStorage.setItem('xk_update_notify_interval_h', '6');
    window.localStorage.setItem(
      'xk_update_notify_last_result',
      JSON.stringify({ ts: now, has_update: true, latest: channel === 'main' ? 'def5678' : 'v9.9.9', channel }),
    );
    window.localStorage.setItem('xk_update_notify_last_check_ts', String(now - ageMs));
  }, { ageMs: lastCheckAgeMs, channel });
}

async function countUpdateChecks(page, channel = 'main') {
  const hits = { info: 0, check: 0 };

  await page.route('**/api/devtools/update/info', async (route) => {
    hits.info += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        build: { version: '1.0.0', commit: 'abc1234', channel, repo: 'umarcheh001/Xkeen-UI' },
        settings: { repo: 'umarcheh001/Xkeen-UI', channel, branch: 'main' },
      }),
    });
  });

  await page.route('**/api/devtools/update/check', async (route) => {
    hits.check += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        error: null,
        channel,
        current: { version: '1.0.0', commit: 'abc1234' },
        latest: channel === 'main'
          ? { kind: 'main', short_sha: 'def5678', sha: 'def56789' }
          : { kind: 'stable', tag: 'v9.9.9' },
        update_available: true,
        stale: false,
      }),
    });
  });

  return hits;
}

test('pending update badge does not ask GitHub again on every page load', async ({ page }) => {
  await seedPendingUpdate(page, { lastCheckAgeMs: 60 * 1000 });
  const hits = await countUpdateChecks(page);

  await page.goto('/');
  await expect(page.locator('#xk-update-link')).toHaveClass(/xk-update-available/);
  await expect.poll(() => hits.info).toBeGreaterThan(0);
  // Локальная сверка версии уже прошла; даём странице время на лишний запрос.
  await page.waitForTimeout(1500);

  expect(hits.check).toBe(0);
});

test('pending update badge is re-checked once the check interval has passed', async ({ page }) => {
  await seedPendingUpdate(page, { lastCheckAgeMs: 7 * 60 * 60 * 1000 });
  const hits = await countUpdateChecks(page);

  await page.goto('/');
  await expect(page.locator('#xk-update-link')).toHaveClass(/xk-update-available/);
  await expect.poll(() => hits.check).toBe(1);
  await page.waitForTimeout(1500);

  expect(hits.check).toBe(1);
});

test('stable suppresses a cached legacy badge without checking GitHub', async ({ page }) => {
  await seedPendingUpdate(page, { lastCheckAgeMs: 7 * 60 * 60 * 1000, channel: 'stable' });
  const hits = await countUpdateChecks(page, 'stable');

  await page.goto('/');
  await expect.poll(() => hits.info).toBeGreaterThan(0);
  await expect(page.locator('#xk-update-link')).toBeHidden();
  await page.waitForTimeout(1500);

  expect(hits.check).toBe(0);
});

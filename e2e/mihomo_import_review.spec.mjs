import { test, expect, selectPanelView } from './fixtures.mjs';

const CONFIG = 'mixed-port: 7890\nproxies: []\nproxy-groups:\n  - name: Main\n    type: select\n    proxies: [DIRECT]\nrules: []\n';
const LINK = 'vless://11111111-1111-1111-1111-111111111111@example.com:443?type=tcp#Review';
async function editor(page, text) {
  return page.evaluate(async value => {
    const { getMihomoPanelApi } = await import('/static/js/features/mihomo_panel.js');
    const api = getMihomoPanelApi();
    if (value !== undefined) api.setEditorText(value);
    return api.getEditorText();
  }, text);
}
async function setup(page, source = LINK) {
  await page.route('**/api/mihomo/subscriptions', route => route.fulfill({ json: { ok: true, subscriptions: [] } }));
  await page.goto('/');
  await selectPanelView(page, 'mihomo');
  await page.locator('#mihomo-clash-tab-config').click();
  await editor(page, CONFIG);
  const menu = page.locator('.xk-mihomo-menu');
  if (!await menu.evaluate(el => el.open)) await menu.locator('summary').click();
  await page.locator('#mihomo-import-node-btn').click();
  await page.locator('#mihomo-import-input').fill(source);
  await page.locator('#mihomo-import-parse-btn').click();
  await expect(page.locator('#mihomo-import-review-btn')).toBeVisible();
}

test('review precedes commit, warns about editor changes, and goes back without parsing again', async ({ page }) => {
  let commits = 0;
  page.on('request', request => { if (request.url().includes('/import/commit')) commits++; });
  await setup(page);
  await expect(page.locator('#mihomo-import-save-btn')).toBeHidden();
  await page.locator('#mihomo-import-review-btn').click();
  await expect(page.locator('#mihomo-import-review')).toBeVisible();
  await expect(page.locator('#mihomo-import-input')).toBeHidden();
  await expect(page.locator('#mihomo-import-candidate-summary')).toContainText('1');
  await expect(page.locator('#mihomo-import-review-warning')).toContainText('несохранённые');
  expect(commits).toBe(0);
  await page.locator('#mihomo-import-review-back').click();
  await expect(page.locator('#mihomo-import-result-cards')).toBeVisible();
  await page.locator('#mihomo-import-review-btn').click();
  await expect(page.locator('#mihomo-import-review')).toBeVisible();
  expect(commits).toBe(0);
});

test('editor edit after review requires renewed confirmation without writing', async ({ page }) => {
  let commits = 0;
  await page.route('**/api/mihomo/import/commit', route => { commits++; return route.fulfill({ json: { ok: true, saved: true, revision: 'saved' } }); });
  await setup(page);
  await page.locator('#mihomo-import-review-btn').click();
  await expect(page.locator('#mihomo-import-review')).toBeVisible();
  await editor(page, CONFIG + '# new edit\n');
  await page.locator('#mihomo-import-save-btn').click();
  await expect(page.locator('#mihomo-import-action-status')).toContainText('измен');
  expect(commits).toBe(0);
});

test('failed process is not reported as applied and status survives close/reopen', async ({ page }) => {
  await page.route('**/api/mihomo/import/commit', route => route.fulfill({ status: 202, json: {
    ok: true, saved: true, revision: 'saved', backup: 'backup.yaml', restart_job_id: 'review-job',
  } }));
  await page.route('**/api/restart-job/review-job', route => route.fulfill({ json: {
    ok: true, status: 'finished', exit_code: 1, error: 'Restart failed', output: 'Restart failed',
  } }));
  await setup(page);
  await page.locator('#mihomo-import-review-btn').click();
  await page.locator('#mihomo-import-apply-btn').click();
  await expect(page.locator('#mihomo-import-action-status')).toContainText('применение не удалось');
  await expect(page.locator('#mihomo-import-action-status')).not.toContainText('Применено:');
  await page.locator('#mihomo-import-close-btn').click();
  const menu = page.locator('.xk-mihomo-menu');
  if (!await menu.evaluate(el => el.open)) await menu.locator('summary').click();
  await page.locator('#mihomo-import-node-btn').click();
  await expect(page.locator('#mihomo-import-action-status')).toContainText('применение не удалось');
});

test('draft defers registration until toolbar saves the matching nodes', async ({ page }) => {
  let registrations = 0;
  await page.route('**/api/mihomo/parse/xray-json', route => route.fulfill({ json: { ok: true, proxies: [
    { proxy_name: 'Subscription', proxy_yaml: '- name: Subscription\n  type: vless\n  server: example.com\n  port: 443\n  uuid: private\n' },
  ] } }));
  await page.route('**/api/mihomo/subscriptions/imported-xray', route => {
    registrations++; return route.fulfill({ json: { ok: true, subscription: { id: 'test' } } });
  });
  await page.route('**/api/mihomo-config', async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    return route.fulfill({ json: { ok: true, saved: true, revision: 'saved' } });
  });
  await setup(page, 'https://sub.example/subscription');
  await page.locator('#mihomo-import-review-btn').click();
  await page.locator('#mihomo-import-insert-btn').click();
  await expect(page.locator('#mihomo-import-modal')).toBeHidden();
  expect(registrations).toBe(0);
  await page.evaluate(async () => {
    const { getMihomoPanelApi } = await import('/static/js/features/mihomo_panel.js');
    await getMihomoPanelApi().saveConfig();
  });
  expect(registrations).toBe(1);
});

test('save marks the imported snapshot clean and does not repeat insertion on another save', async ({ page }) => {
  const commits = [];
  await page.route('**/api/mihomo/import/commit', route => {
    commits.push(route.request().postDataJSON());
    return route.fulfill({ json: { ok: true, saved: true, revision: 'saved' } });
  });
  await setup(page);
  await page.locator('#mihomo-import-review-btn').click();
  await page.locator('#mihomo-import-save-btn').click();
  await expect(page.locator('#mihomo-import-action-status')).toContainText('Файл сохранён');
  const dirty = await page.evaluate(async () => {
    const { getMihomoPanelApi } = await import('/static/js/features/mihomo_panel.js');
    return getMihomoPanelApi().isEditorDirty();
  });
  expect(dirty).toBe(false);
  await page.locator('#mihomo-import-save-btn').click();
  expect(commits).toHaveLength(1);
});

test('batch review uses one patch request for ten already parsed nodes', async ({ page }) => {
  let patches = 0;
  page.on('request', request => { if (/\/patch\/(apply_insert|apply_batch)/.test(request.url())) patches++; });
  await setup(page, Array.from({ length: 10 }, (_, i) => LINK.replace('#Review', `#Batch-${i}`)).join('\n'));
  await page.locator('#mihomo-import-review-btn').click();
  await expect(page.locator('#mihomo-import-review')).toBeVisible();
  expect(patches).toBe(1);
  await expect(page.locator('#mihomo-import-candidate-summary')).toContainText('10');
});

test('registration retry reads the latest saved file after nodes were removed', async ({ page }) => {
  let registrations = 0;
  await page.route('**/api/mihomo/parse/xray-json', route => route.fulfill({ json: { ok: true, proxies: [
    { proxy_name: 'Gone', proxy_yaml: '- name: Gone\n  type: direct\n' },
  ] } }));
  await page.route('**/api/mihomo/subscriptions/imported-xray', route => {
    registrations++; return route.fulfill({ status: 503, json: { ok: false, error: 'offline' } });
  });
  await page.route('**/api/mihomo/import/commit', route => route.fulfill({ json: { ok: true, saved: true, revision: 'imported' } }));
  await setup(page, 'https://sub.example/subscription');
  await page.locator('#mihomo-import-review-btn').click();
  await page.locator('#mihomo-import-save-btn').click();
  await expect(page.locator('#mihomo-import-retry-registration')).toBeVisible();
  expect(registrations).toBe(1);
  // Another writer saved a config with the imported nodes removed.
  await page.route('**/api/mihomo-config?baseline=1', route => route.fulfill({ json: {
    ok: true, content: CONFIG, revision: 'removed',
  } }));
  await page.locator('#mihomo-import-retry-registration').click();
  await expect(page.locator('#mihomo-import-recovery')).toBeHidden();
  expect(registrations).toBe(1);
});

test('recovery handles a saved file with queue failure after a lost first response', async ({ page }) => {
  let attempts = 0;
  await page.route('**/api/mihomo/import/commit', route => {
    attempts++;
    if (attempts === 1) return route.abort('failed');
    return route.fulfill({ status: 500, json: {
      ok: false, saved: true, revision: 'saved', backup: 'backup.yaml',
      code: 'restart_schedule_failed', error: 'config.yaml сохранён, но restart job не удалось поставить в очередь.',
    } });
  });
  await setup(page);
  await page.locator('#mihomo-import-review-btn').click();
  await page.locator('#mihomo-import-apply-btn').click();
  await expect(page.locator('#mihomo-import-resume')).toBeVisible();
  await page.locator('#mihomo-import-resume').click();
  await expect(page.locator('#mihomo-import-retry-apply')).toBeVisible();
  await expect(page.locator('#mihomo-import-action-status')).toContainText('Файл сохранён, применение не удалось');
  expect(attempts).toBe(2);
});

test('unknown toolbar restart can be monitored again from the import dialog', async ({ page }) => {
  await setup(page);
  await page.locator('#mihomo-import-close-btn').click();
  await page.route('**/api/mihomo-config?async=1', route => route.fulfill({ status: 202, json: {
    ok: true, saved: true, revision: 'saved', restart_job_id: 'toolbar-job',
  } }));
  await page.route('**/api/restart-job/toolbar-job', route => route.abort('failed'));
  await page.evaluate(async () => {
    const { getMihomoPanelApi } = await import('/static/js/features/mihomo_panel.js');
    await getMihomoPanelApi().saveAndRestart();
  });
  const registration = await page.evaluate(async () => {
    const { getMihomoConfigOperations } = await import('/static/js/features/mihomo_config_operations.js');
    return getMihomoConfigOperations().operation.registration;
  });
  expect(registration).toBeDefined();
  const menu = page.locator('.xk-mihomo-menu');
  if (!await menu.evaluate(el => el.open)) await menu.locator('summary').click();
  await page.locator('#mihomo-import-node-btn').click();
  await expect(page.locator('#mihomo-import-resume')).toBeVisible();
  await page.unroute('**/api/restart-job/toolbar-job');
  await page.route('**/api/restart-job/toolbar-job', route => route.fulfill({ json: { ok: true, status: 'finished', exit_code: 0 } }));
  await page.route('**/api/mihomo/import/runtime', route => route.fulfill({ json: { ok: true, running: true } }));
  await page.locator('#mihomo-import-resume').click();
  await expect(page.locator('#mihomo-import-action-status')).toContainText('Применено');
});

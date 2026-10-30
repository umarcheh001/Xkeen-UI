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
  await expect(page.locator('#mihomo-import-result-cards')).toHaveCount(0);
  await expect(page.locator('#mihomo-import-status')).toContainText('example.com:443');
  await page.locator('#mihomo-import-review-btn').click();
  await expect(page.locator('#mihomo-import-review')).toBeVisible();
  expect(commits).toBe(0);
});

for (const viewport of [{ width: 1000, height: 820 }, { width: 640, height: 480 }]) test(`review dropdowns remain inside clipping ancestors at ${viewport.width}x${viewport.height}`, async ({ page }) => {
  await page.setViewportSize(viewport);
  await setup(page, LINK.replace('?type=tcp#Review', '?type=tcp&security=reality&pbk=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&sid=1234#Review'));
  await page.locator('#mihomo-import-review-btn').click();
  await page.locator('#mihomo-import-fingerprint').selectOption('random');
  for (const key of ['fingerprint', 'x25519']) {
    await page.locator(`#mihomo-import-${key}-trigger`).click();
    expect(await page.locator(`#mihomo-import-${key}-menu`).evaluate(menu => {
      const item = menu.querySelector('[aria-selected="true"]').getBoundingClientRect();
      const container = menu.getBoundingClientRect();
      return item.top >= container.top && item.bottom <= container.bottom;
    })).toBe(true);
    const clipped = await page.locator(`#mihomo-import-${key}-menu`).evaluate(menu => {
      const box = menu.getBoundingClientRect();
      for (let p = menu.parentElement; p; p = p.parentElement) {
        if (!/(hidden|auto|scroll|clip)/.test(getComputedStyle(p).overflowY)) continue;
        const bounds = p.getBoundingClientRect();
        if (box.top < bounds.top - 1 || box.bottom > bounds.bottom + 1) return true;
      }
      return box.top < 0 || box.bottom > innerHeight;
    });
    expect(clipped).toBe(false);
    await page.locator(`#mihomo-import-${key}-menu [role="option"]`).last().focus();
    await page.keyboard.press('Enter');
    await expect(page.locator(`#mihomo-import-${key}-menu`)).toBeHidden();
    await page.locator(`#mihomo-import-${key}-menu`).evaluate(menu => { menu.scrollTop = 0; });
    await page.locator(`#mihomo-import-${key}-trigger`).click();
    const selectedVisible = await page.locator(`#mihomo-import-${key}-menu`).evaluate(menu => {
      const item = menu.querySelector('[aria-selected="true"]');
      const box = item.getBoundingClientRect();
      const container = menu.getBoundingClientRect();
      return box.top >= container.top && box.bottom <= container.bottom;
    });
    expect(selectedVisible).toBe(true);
    await page.keyboard.press('Escape');
  }
});

test('review applies fingerprint and ML-KEM choices to imported Reality nodes', async ({ page }) => {
  let committed;
  await page.route('**/api/mihomo/import/commit', route => {
    committed = route.request().postDataJSON();
    return route.fulfill({ json: { ok: true, saved: true, revision: 'saved' } });
  });
  const realityLink = LINK.replace('?type=tcp#Review', '?type=tcp&security=reality&pbk=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&sid=1234#Review');
  await setup(page, realityLink);
  await page.locator('#mihomo-import-review-btn').click();
  await expect(page.locator('#mihomo-import-fingerprint-trigger')).toContainText('Наследовать от источника');
  await page.locator('#mihomo-import-fingerprint-trigger').click();
  await expect(page.locator('#mihomo-import-fingerprint-menu')).toBeVisible();
  await page.locator('#mihomo-import-fingerprint-menu [data-mi-select-value="firefox"]').click();
  await expect(page.locator('#mihomo-import-fingerprint-trigger')).toContainText('firefox');
  await expect(page.locator('#mihomo-import-fingerprint-menu [data-mi-select-value="firefox"]')).toHaveAttribute('aria-selected', 'true');
  await page.locator('#mihomo-import-fingerprint').selectOption('firefox');
  await page.locator('#mihomo-import-x25519').selectOption('enable');
  await expect(page.locator('#mihomo-import-candidate-summary')).toContainText('фингерпринт: firefox');
  await expect(page.locator('#mihomo-import-candidate-summary')).toContainText('X25519MLKEM768: включить');
  await page.locator('#mihomo-import-save-btn').click();
  expect(committed.content).toContain('client-fingerprint: firefox');
  expect(committed.content).toContain('support-x25519mlkem768: true');
});

test('review lets a single node move to the start or replace a chosen existing node', async ({ page }) => {
  let committed;
  await page.route('**/api/mihomo/import/commit', route => {
    committed = route.request().postDataJSON();
    return route.fulfill({ json: { ok: true, saved: true, revision: 'saved' } });
  });
  await setup(page);
  await editor(page, CONFIG.replace('proxies: []', 'proxies:\n  - name: Existing\n    type: direct')
    .replace('proxies: [DIRECT]', 'proxies: [DIRECT, Existing]'));
  await page.locator('#mihomo-import-review-btn').click();
  const start = page.locator('[data-mi-placement="start"]');
  const replace = page.locator('[data-mi-placement="replace"]');
  await start.click();
  await expect(start).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#mihomo-import-candidate-summary')).toContainText('в начале');

  await replace.click();
  await expect(replace).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#mihomo-import-replace-target')).toHaveValue('Existing');
  await expect(page.locator('#mihomo-import-candidate-summary')).toContainText('Заменяемый узел: Existing');
  await page.locator('#mihomo-import-save-btn').click();
  expect(committed.content).toContain('name: Review');
  expect(committed.content).not.toContain('name: Existing');
  expect(committed.content).toContain('proxies: [DIRECT, "Review"]');
});

test('replacement requires one imported static node', async ({ page }) => {
  await setup(page, `${LINK}\n${LINK.replace('#Review', '#Second')}`);
  await page.locator('#mihomo-import-review-btn').click();
  await expect(page.locator('[data-mi-placement="replace"]')).toHaveAttribute('aria-disabled', 'true');
  await expect(page.locator('[data-mi-placement="end"]')).toHaveAttribute('aria-pressed', 'true');
});

test('YAML preview stays on the source step and review contains no technical diff', async ({ page }) => {
  await setup(page);
  await page.locator('#mihomo-import-preview-toggle').click();
  await expect(page.locator('#mihomo-import-preview-panel')).toBeVisible();
  await expect(page.locator('#mihomo-import-preview')).not.toHaveValue('');
  await page.locator('#mihomo-import-review-btn').click();
  const dialog = page.locator('#mihomo-import-modal');
  await expect(dialog.locator('[data-mi-review-view]')).toHaveCount(0);
  await expect(dialog.locator('.xk-mi-technical-disclosure')).toHaveCount(0);
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
    ok: true, status: 'finished', exit_code: 1, error: 'Restart failed', output: '\u001b[31mRestart failed\u001b[0m',
  } }));
  await setup(page);
  await page.locator('#mihomo-import-review-btn').click();
  await page.locator('#mihomo-import-apply-btn').click();
  await expect(page.locator('#mihomo-import-action-status')).toContainText('применение не удалось');
  await expect(page.locator('#mihomo-import-action-status')).not.toContainText('Применено:');
  await expect(page.locator('#mihomo-import-action-status')).not.toContainText('[31m');
  await expect(page.locator('#mihomo-import-action-status')).not.toContainText('[0m');
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
  await expect(page.locator('#mihomo-import-xray-refresh-note')).toContainText('«В черновик»');
  await expect(page.locator('#mihomo-import-xray-refresh-note')).not.toContainText('Вставить в конфиг');
  await page.locator('#mihomo-import-xray-interval').fill('12');
  await page.locator('#mihomo-import-xray-interval').dispatchEvent('change');
  await expect(page.locator('#mihomo-import-status')).toContainText('каждые 12 ч после сохранения');
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

test('editor restart status is not shown in the import dialog', async ({ page }) => {
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
  await expect(page.locator('#mihomo-import-action-status')).toBeHidden();
  await expect(page.locator('#mihomo-import-recovery')).toBeHidden();
});

test('successful editor apply log does not appear when opening the import dialog', async ({ page }) => {
  await setup(page);
  await page.locator('#mihomo-import-close-btn').click();
  await page.route('**/api/mihomo-config?async=1', route => route.fulfill({ status: 202, json: {
    ok: true, saved: true, revision: 'saved', restart_job_id: 'editor-job',
  } }));
  await page.route('**/api/restart-job/editor-job', route => route.fulfill({ json: {
    ok: true, status: 'finished', exit_code: 0, output: '\u001b[32mMihomo started\u001b[0m',
  } }));
  await page.route('**/api/mihomo/import/runtime', route => route.fulfill({ json: {
    ok: true, running: true, api_checked: true,
  } }));
  await page.evaluate(async () => {
    const { getMihomoPanelApi } = await import('/static/js/features/mihomo_panel.js');
    await getMihomoPanelApi().saveAndRestart();
  });
  const menu = page.locator('.xk-mihomo-menu');
  if (!await menu.evaluate(el => el.open)) await menu.locator('summary').click();
  await page.locator('#mihomo-import-node-btn').click();
  await expect(page.locator('#mihomo-import-action-status')).toBeHidden();
  await expect(page.locator('#mihomo-import-recovery')).toBeHidden();
});

test('HTML in a node name is displayed as text in review', async ({ page }) => {
  const name = '<img src=x onerror=alert(1)>';
  await setup(page, LINK.replace('#Review', `#${encodeURIComponent(name)}`));
  await expect(page.locator('#mihomo-import-result-cards')).toHaveCount(0);
  await page.locator('#mihomo-import-review-btn').click();
  await expect(page.locator('#mihomo-import-candidate-summary')).toContainText(name);
  await expect(page.locator('#mihomo-import-candidate-summary img')).toHaveCount(0);
});

test('import write endpoints require a session and a CSRF token', async ({ page, browser, baseURL }) => {
  await page.goto('/');
  const unauthenticated = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    for (const path of ['/api/mihomo/import/commit', '/api/mihomo/import/apply', '/api/mihomo/patch/apply_batch']) {
      const noSession = await unauthenticated.request.post(`${baseURL}${path}`, { data: {} });
      expect(noSession.status()).toBe(401);
      const noCsrf = await page.request.post(`${baseURL}${path}`, { data: {} });
      expect(noCsrf.status()).toBe(403);
      expect((await noCsrf.json()).error).toBe('csrf_failed');
    }
  } finally {
    await unauthenticated.close();
  }
});

test('review dialog supports keyboard focus cycle and return with reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await setup(page);
  await page.locator('#mihomo-import-review-btn').click();
  const dialog = page.getByRole('dialog', { name: 'Проверка изменений' });
  await expect(dialog).toBeVisible();
  await expect(page.locator('#mihomo-import-review-back')).toBeFocused();
  await page.locator('#mihomo-import-apply-btn').focus();
  await page.keyboard.press('Tab');
  await expect(page.locator('#mihomo-import-close-btn')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('#mihomo-import-apply-btn')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect.poll(() => page.evaluate(() => {
    const active = document.activeElement;
    return active?.id === 'mihomo-import-node-btn' || active === document.querySelector('.xk-mihomo-menu summary');
  })).toBe(true);
});

for (const theme of ['dark', 'light']) {
  test(`review stays operable at 640x480 in ${theme} theme`, async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 480 });
    await page.addInitScript(value => localStorage.setItem('xkeen-theme', value), theme);
    await setup(page);
    await page.locator('#mihomo-import-review-btn').click();
    await expect(page.getByRole('dialog', { name: 'Проверка изменений' })).toBeVisible();
    const apply = page.locator('#mihomo-import-apply-btn');
    await expect(apply).toBeVisible();
    const rect = await apply.boundingBox();
    expect(rect.x).toBeGreaterThanOrEqual(0);
    expect(rect.y).toBeGreaterThanOrEqual(0);
    expect(rect.x + rect.width).toBeLessThanOrEqual(640);
    expect(rect.y + rect.height).toBeLessThanOrEqual(480);
  });
}

test('review exposes its name, actions and operation status to accessibility APIs', async ({ page }) => {
  await setup(page);
  await page.locator('#mihomo-import-review-btn').click();
  const dialog = page.getByRole('dialog', { name: 'Проверка изменений' });
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  for (const name of ['Назад', 'В черновик', 'Сохранить', 'Сохранить и применить']) {
    await expect(dialog.getByRole('button', { name, exact: true })).toBeVisible();
  }
  await expect(page.locator('#mihomo-import-action-status')).toHaveAttribute('role', 'status');
  await expect(page.locator('#mihomo-import-action-status')).toHaveAttribute('aria-live', 'polite');
});

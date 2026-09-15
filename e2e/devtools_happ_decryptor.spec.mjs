import { test, expect } from '@playwright/test';

// DevTools → «Декриптор Happ». The API is mocked: the card must render the
// three states from the approved mockup and drive install and link check.

const ARM64 = 'happ-decrypt-universal-linux-arm64';
const PLATFORM = { arch: 'aarch64', opkg_arch: 'aarch64-3.10', endian: 'le', asset: ARM64, supported: true };

const READY = {
  path: '/opt/etc/xkeen-ui/bin/happ-decrypt-universal',
  kind: 'native',
  installed: true,
  version: 'happ-decrypt-universal v1.4.0 (8af0af5, 2026-09-15T10:00:00Z)',
  assets_dir: '/opt/etc/xkeen-ui/bin/happ-decrypt-universal.assets',
  keys: {
    formats: ['crypt', 'crypt2', 'crypt3', 'crypt4', 'crypt5'],
    crypt5_keys: { present: true, keys: 36, invalid: 0 },
    legacy_keys: { present: true, keys: 4, invalid: 0 },
  },
  keys_meta: {
    schema: 1,
    files: {
      'crypt5-keys.json': {
        source: 'manifest',
        repo: 'LeeeeT/happ-decryptor',
        commit: '5a05cfe59f45db8684be26077ce28979a3ee3208',
        installed_at: '2026-09-15T10:00:00Z',
      },
    },
  },
  platform: PLATFORM,
  cmd_override: false,
};

const MISSING = {
  path: READY.path,
  kind: 'missing',
  installed: false,
  version: null,
  assets_dir: READY.assets_dir,
  keys: null,
  keys_meta: null,
  platform: PLATFORM,
  cmd_override: false,
};

async function openCard(page) {
  await page.goto('/devtools#dt-happ-decryptor-card');
  await expect(page.locator('#dt-happ-decryptor-card')).toBeVisible();
}

test('happ decryptor card shows a ready engine with its key set', async ({ page }) => {
  await page.route('**/api/happ-decryptor/status', (route) => route.fulfill({ json: { ok: true, status: READY } }));

  await openCard(page);

  await expect(page.locator('#dt-happ-verdict')).toHaveText('Готов к расшифровке');
  await expect(page.locator('#dt-happ-engine')).toHaveText('v1.4.0');
  await expect(page.locator('#dt-happ-engine-sub')).toHaveText('arm64 · 8af0af5');
  await expect(page.locator('#dt-happ-formats code')).toHaveText(['crypt', 'crypt2', 'crypt3', 'crypt4', 'crypt5']);
  await expect(page.locator('#dt-happ-keys')).toHaveText('36 для crypt5 · 4 для crypt…crypt4');
  await expect(page.locator('#dt-happ-keyset')).toHaveText('5a05cfe');
  await expect(page.locator('#dt-happ-install')).toHaveText('Переустановить движок');
  await expect(page.locator('#dt-happ-update-keys')).toBeVisible();
  await expect(page.locator('#dt-happ-refresh')).toHaveText('Обновить');
  await expect(page.locator('#dt-happ-alert')).toBeHidden();
});

test('a local engine build does not repeat its commit', async ({ page }) => {
  const local = { ...READY, version: 'happ-decrypt-universal d1dbdfa4-local (d1dbdfa4, 2026-09-15T12:34:02Z)' };
  await page.route('**/api/happ-decryptor/status', (route) => route.fulfill({ json: { ok: true, status: local } }));

  await openCard(page);

  await expect(page.locator('#dt-happ-engine')).toHaveText('d1dbdfa4-local');
  await expect(page.locator('#dt-happ-engine-sub')).toHaveText('arm64');
});

test('installing from the card asks first and then shows the installed engine', async ({ page }) => {
  let status = MISSING;
  const posts = [];
  await page.route('**/api/happ-decryptor/status', (route) => route.fulfill({ json: { ok: true, status } }));
  await page.route('**/api/happ-decryptor/install', async (route) => {
    posts.push(route.request().postDataJSON());
    status = READY;
    await route.fulfill({
      json: {
        ok: true,
        engine: { version: READY.version },
        keys: {
          installed: ['crypt5-keys.json', 'legacy_keys.json'],
          manifest: { repo: 'LeeeeT/happ-decryptor', commit: '5a05cfe59f45', source: 'remote' },
        },
        status: READY,
      },
    });
  });

  await openCard(page);
  await expect(page.locator('#dt-happ-verdict')).toHaveText('Не установлен');
  await expect(page.locator('#dt-happ-engine')).toHaveText('не найден');
  await expect(page.locator('#dt-happ-arch')).toHaveText('arm64');
  await expect(page.locator('#dt-happ-alert')).toBeVisible();
  await expect(page.locator('#dt-happ-update-keys')).toBeHidden();

  await page.locator('#dt-happ-install').click();
  await expect(page.locator('#confirm-modal')).not.toHaveClass(/hidden/);
  await page.locator('#confirm-modal-ok-btn').click();

  await expect(page.locator('#dt-happ-verdict')).toHaveText('Готов к расшифровке');
  await expect(page.locator('#dt-happ-status')).toContainText('ключи: crypt5-keys.json, legacy_keys.json');
  expect(posts).toEqual([{}]);
});

test('checking a link without a key asks for new keys', async ({ page }) => {
  await page.route('**/api/happ-decryptor/status', (route) => route.fulfill({ json: { ok: true, status: READY } }));
  await page.route('**/api/happ-decryptor/check', (route) => route.fulfill({
    json: {
      ok: false,
      error: 'unknown_key',
      hint: 'Для этой ссылки нет ключа (маркер vdQx7r2p) — Happ выпустил новые ключи.',
      status: READY,
    },
  }));

  await openCard(page);
  await expect(page.locator('#dt-happ-verdict')).toHaveText('Готов к расшифровке');

  await page.locator('#dt-happ-check-box').evaluate((node) => { node.open = true; });
  await page.locator('#dt-happ-check-link').fill('happ://crypt5/vdfzAAAA');
  await page.locator('#dt-happ-check-run').click();

  await expect(page.locator('#dt-happ-check-result')).toContainText('маркер vdQx7r2p');
  await expect(page.locator('#dt-happ-verdict')).toHaveText('Нужны новые ключи');
  await expect(page.locator('#dt-happ-formats code').last()).toHaveClass(/dt-badge-warn/);
});

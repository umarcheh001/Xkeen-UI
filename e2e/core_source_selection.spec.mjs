import { test, expect, selectPanelView } from './fixtures.mjs';


const xrayProfiles = {
  ok: true,
  data: {
    engine_id: 'xray',
    platform: { machine: 'mipsel', opkg_arch: 'mipsel_24kc', endianness: 'le' },
    state: { selected_profile_id: 'official', installed_profile_id: 'official', last_status: 'idle' },
    profiles: [
      {
        profile_id: 'official', display_name: 'Официальный Xray', repo: 'XTLS/Xray-core', description: 'Базовая совместимость Xray.',
        release: { installable: true, stable: { tag: 'v26.3.27' }, asset: { name: 'Xray-linux-mips32le.zip' }, checksum: { sha256: 'a'.repeat(64) } },
      },
      {
        profile_id: 'uwuray', display_name: 'UwuRay', repo: 'MakostaDev/UwuRay', description: 'Альтернативная совместимость.',
        release: { installable: true, stable: { tag: 'v26.3.27-uwu' }, asset: { name: 'Xray-linux-mips32le.zip' }, checksum: { sha256: 'b'.repeat(64) } },
      },
    ],
  },
};


function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function mihomoProfiles() {
  return {
    ok: true,
    data: {
      engine_id: 'mihomo',
      platform: { machine: 'mipsel', opkg_arch: 'mipsel_24kc', endianness: 'le' },
      state: { selected_profile_id: 'official', installed_profile_id: 'official', last_status: 'idle' },
      profiles: [
        {
          profile_id: 'official', display_name: 'Официальный Mihomo', repo: 'MetaCubeX/mihomo', description: 'Базовая совместимость Mihomo.',
          release: { installable: true, stable: { tag: 'v1.19.32' }, asset: { name: 'mihomo-linux-mipsle-softfloat-v1.19.32.gz' }, checksum: { sha256: 'c'.repeat(64) } },
        },
        {
          profile_id: 'prizrak-core', display_name: 'Prizrak-Core', repo: 'legiz-ru/Prizrak-Core', description: 'Альтернативная сборка.',
          release: { installable: true, stable: { tag: 'v1.19.32-prizrak' }, asset: { name: 'prizrak-core-linux-mipsle-v1.19.32.gz' }, checksum: { sha256: 'd'.repeat(64) } },
        },
      ],
    },
  };
}


async function openView(page, view, viewport = { width: 1440, height: 900 }) {
  await page.setViewportSize(viewport);
  await page.goto('/');
  await selectPanelView(page, view);
  await expect(page.locator(`#view-${view}`)).toBeVisible();
}


async function openCoreManagement(page) {
  const trigger = page.locator('.xk-brand-service-trigger');
  await expect(trigger).toBeVisible();
  await trigger.click();

  const core = page.locator('#xkeen-core-text');
  await expect(core).toBeVisible();
  await expect(core).not.toHaveAttribute('aria-disabled', 'true');
  await core.click();
  await expect(page.locator('#core-modal')).toBeVisible();
}


test.describe('Curated core source selection', () => {
  test('the core dialog gives desktop descriptions room without losing the no-core workflow', async ({ page }) => {
    await page.route('**/api/xkeen/core', async (route) => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, cores: [], currentCore: '' }),
    }));

    await openView(page, 'routing');
    await openCoreManagement(page);

    const dialog = page.locator('#core-modal .xk-core-modal-content');
    const dialogBox = await dialog.boundingBox();
    expect(dialogBox?.width).toBeGreaterThanOrEqual(700);

    const xrayEngine = page.locator('#core-modal .xk-core-engine-row').filter({ hasText: 'Xray' });
    const mihomoEngine = page.locator('#core-modal .xk-core-engine-row').filter({ hasText: 'Mihomo' });
    const [xrayEngineBox, mihomoEngineBox] = await Promise.all([
      xrayEngine.boundingBox(),
      mihomoEngine.boundingBox(),
    ]);
    expect(Math.abs((xrayEngineBox?.y || 0) - (mihomoEngineBox?.y || 0))).toBeLessThan(2);
    expect((xrayEngineBox?.x || 0) + (xrayEngineBox?.width || 0)).toBeLessThan(mihomoEngineBox?.x || 0);

    const source = page.locator('#core-modal [data-core-source][data-core-engine="xray"]');
    const actions = source.locator('[data-core-source-action]');
    const [sourceBox, firstActionBox, secondActionBox] = await Promise.all([
      source.boundingBox(),
      actions.nth(0).boundingBox(),
      actions.nth(1).boundingBox(),
    ]);
    expect(sourceBox?.width).toBeGreaterThanOrEqual(660);
    expect(Math.abs((firstActionBox?.y || 0) - (secondActionBox?.y || 0))).toBeLessThan(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });

  test('Xray saves only the selected profile id and shows the verified artifact before apply', async ({ page }) => {
    let saved = null;
    let applied = null;
    await page.route('**/api/xray/core-profiles', async (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(xrayProfiles) }));
    await page.route('**/api/xray/core-source', async (route) => {
      saved = route.request().postDataJSON();
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, state: { selected_profile_id: 'uwuray' } }) });
    });
    await page.route('**/api/xray/core-install/prepare', async (route) => route.fulfill({
      contentType: 'application/json', body: JSON.stringify({
        ok: true,
        confirmation: { confirmation_id: 'xray-confirm', profile: xrayProfiles.data.profiles[1], release: xrayProfiles.data.profiles[1].release },
      }),
    }));
    await page.route('**/api/xray/core-install/apply', async (route) => {
      applied = route.request().postDataJSON();
      await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ ok: true, operation: { operation_id: 'xray-op' } }) });
    });
    await page.route('**/api/xray/core-install/status*', async (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, operation: { status: 'succeeded', phase: 'complete' } }) }));

    await openView(page, 'routing');
    await openCoreManagement(page);
    const card = page.locator('[data-core-source][data-core-engine="xray"]');
    await card.getByRole('button', { name: 'Источник' }).click();
    const sourceModal = page.locator('#xray-core-source-modal');
    await sourceModal.locator('input[value="uwuray"]').check();
    await sourceModal.getByRole('button', { name: 'Сохранить выбор' }).click();
    await expect.poll(() => saved).toEqual({ profile_id: 'uwuray' });
    await sourceModal.getByRole('button', { name: 'Отмена' }).click();
    await expect(sourceModal).toBeHidden();

    await card.getByRole('button', { name: 'Обновить' }).click();
    const confirmation = page.locator('#xray-core-install-modal');
    await expect(confirmation).toContainText('Xray-linux-mips32le.zip');
    await expect(confirmation).toContainText('b'.repeat(64));
    await confirmation.getByRole('button', { name: 'Установить' }).click();
    await expect.poll(() => applied).toEqual({ confirmation_id: 'xray-confirm' });
  });

  test('Mihomo owns its alternative source and has no mobile overflow', async ({ page }) => {
    let saved = null;
    const payload = mihomoProfiles();
    await page.route('**/api/mihomo/core-profiles', async (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(payload) }));
    await page.route('**/api/mihomo/core-source', async (route) => {
      saved = route.request().postDataJSON();
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, state: { selected_profile_id: 'prizrak-core' } }) });
    });

    await openView(page, 'mihomo', { width: 390, height: 844 });
    await openCoreManagement(page);
    const card = page.locator('[data-core-source][data-core-engine="mihomo"]');
    await card.getByRole('button', { name: 'Источник' }).click();
    const modal = page.locator('#mihomo-core-source-modal');
    await modal.locator('input[value="prizrak-core"]').check();
    await modal.getByRole('button', { name: 'Сохранить выбор' }).click();

    await expect.poll(() => saved).toEqual({ profile_id: 'prizrak-core' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });

  test('a rollback result remains visible on the Xray card', async ({ page }) => {
    let rolledBack = false;
    await page.route('**/api/xray/core-profiles', async (route) => {
      const payload = clone(xrayProfiles);
      if (rolledBack) {
        payload.data.state.last_status = 'rolled_back';
        payload.data.state.last_error = 'Конфигурация не прошла проверку';
      }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(payload) });
    });
    await page.route('**/api/xray/core-install/prepare', async (route) => route.fulfill({
      contentType: 'application/json', body: JSON.stringify({
        ok: true,
        confirmation: { confirmation_id: 'rollback-confirm', profile: xrayProfiles.data.profiles[0], release: xrayProfiles.data.profiles[0].release },
      }),
    }));
    await page.route('**/api/xray/core-install/apply', async (route) => route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ ok: true, operation: { operation_id: 'rollback-op' } }) }));
    await page.route('**/api/xray/core-install/status*', async (route) => {
      rolledBack = true;
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, operation: { status: 'rolled_back', phase: 'rolled_back', error: 'Конфигурация не прошла проверку' } }) });
    });

    await openView(page, 'routing');
    await openCoreManagement(page);
    const card = page.locator('[data-core-source][data-core-engine="xray"]');
    await card.getByRole('button', { name: 'Обновить' }).click();
    await page.locator('#xray-core-install-modal').getByRole('button', { name: 'Установить' }).click();
    await expect(card).toContainText('Откат: Конфигурация не прошла проверку');
  });
});

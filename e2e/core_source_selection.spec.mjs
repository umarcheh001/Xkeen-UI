import { test, expect, selectPanelView } from './fixtures.mjs';


const xrayProfiles = {
  ok: true,
  data: {
    engine_id: 'xray',
    platform: { machine: 'mipsel', opkg_arch: 'mipsel_24kc', endianness: 'le' },
    state: { selected_profile_id: 'official', installed_profile_id: 'official', last_status: 'idle', detected_version: '26.3.27' },
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


function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
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


async function openCoreManagement(page, engine = 'xray') {
  const trigger = page.locator('.xk-brand-service-trigger');
  await expect(trigger).toBeVisible();
  await trigger.click();

  // The engine switch of the service menu opens the core dialog on that engine.
  const core = page.locator(`#xk-mihomo-service-menu [data-xk-svc-core][data-core="${engine}"]`);
  await expect(core).toBeVisible();
  await expect(core).not.toHaveAttribute('aria-disabled', 'true');
  await core.click();
  await expect(page.locator('#core-modal')).toBeVisible();
}


test.describe('Curated core source selection', () => {
  test('opens the source dialog on the first click while profiles are still loading', async ({ page }) => {
    const profilesReady = deferred();
    await page.route('**/api/xray/core-profiles', async (route) => {
      await profilesReady.promise;
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(xrayProfiles) });
    });

    await openView(page, 'routing');
    await openCoreManagement(page);

    const card = page.locator('[data-core-source][data-core-engine="xray"]');
    const sourceModal = page.locator('#xray-core-source-modal');
    await card.getByRole('button', { name: 'Источник' }).click();
    await expect(sourceModal).toBeVisible({ timeout: 500 });

    profilesReady.resolve();
    await expect(sourceModal.getByRole('radio', { name: 'Официальный Xray' })).toBeVisible();
  });

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
    await sourceModal.getByRole('button', { name: 'Запомнить без установки' }).click();
    await expect.poll(() => saved).toEqual({ profile_id: 'uwuray' });
    await sourceModal.getByRole('button', { name: 'Закрыть выбор источника' }).click();
    await expect(sourceModal).toBeHidden();

    await card.getByRole('button', { name: 'Переустановить' }).click();
    const confirmation = page.locator('#xray-core-install-modal');
    await expect(confirmation).toContainText('Xray-linux-mips32le.zip');
    await expect(confirmation).toContainText('b'.repeat(64));
    await expect(confirmation.locator('[data-core-install-progress]')).toBeHidden();
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
    await openCoreManagement(page, 'mihomo');
    const card = page.locator('[data-core-source][data-core-engine="mihomo"]');
    await card.getByRole('button', { name: 'Источник' }).click();
    const modal = page.locator('#mihomo-core-source-modal');
    await modal.locator('input[value="prizrak-core"]').check();
    await modal.getByRole('button', { name: 'Запомнить без установки' }).click();

    await expect.poll(() => saved).toEqual({ profile_id: 'prizrak-core' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });

  test('renames the single card action for a selected fork and opens confirmation', async ({ page }) => {
    const payload = mihomoProfiles();
    payload.data.state.detected_version = '1.19.14';
    payload.data.state.selected_profile_id = 'prizrak-core';
    payload.data.state.installed_profile_id = 'official';
    let prepared = false;

    await page.route('**/api/mihomo/core-profiles', async (route) => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(payload),
    }));
    await page.route('**/api/mihomo/core-install/prepare', async (route) => {
      prepared = true;
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          confirmation: {
            confirmation_id: 'fork-confirm',
            profile: payload.data.profiles[1],
            release: payload.data.profiles[1].release,
          },
        }),
      });
    });

    await openView(page, 'mihomo');
    await openCoreManagement(page, 'mihomo');
    const card = page.locator('[data-core-source][data-core-engine="mihomo"]');
    const prepare = card.getByRole('button', { name: 'Установить Prizrak-Core' });
    await expect(card.locator('[data-core-source-status]')).toContainText('Выбран другой источник');
    await expect(prepare).toBeVisible();
    await expect(card.getByRole('button', { name: 'Проверить и установить' })).toHaveCount(0);
    await prepare.click();

    await expect.poll(() => prepared).toBe(true);
    await expect(page.locator('#mihomo-core-source-modal')).toBeHidden();
    await expect(page.locator('#mihomo-core-install-modal')).toBeVisible();
    await expect(page.locator('#mihomo-core-install-modal')).toContainText('prizrak-core-linux-mipsle-v1.19.32.gz');
  });

  test('source modal can save and prepare installation in one action', async ({ page }) => {
    const payload = mihomoProfiles();
    let saved = null;
    let prepared = false;

    await page.route('**/api/mihomo/core-profiles', async (route) => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(payload),
    }));
    await page.route('**/api/mihomo/core-source', async (route) => {
      saved = route.request().postDataJSON();
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, state: { selected_profile_id: 'prizrak-core' } }),
      });
    });
    await page.route('**/api/mihomo/core-install/prepare', async (route) => {
      prepared = true;
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          confirmation: {
            confirmation_id: 'fork-confirm',
            profile: payload.data.profiles[1],
            release: payload.data.profiles[1].release,
          },
        }),
      });
    });

    await openView(page, 'mihomo');
    await openCoreManagement(page, 'mihomo');
    const card = page.locator('[data-core-source][data-core-engine="mihomo"]');
    await card.getByRole('button', { name: 'Источник' }).click();
    const modal = page.locator('#mihomo-core-source-modal');
    await modal.locator('input[value="prizrak-core"]').check();
    await modal.getByRole('button', { name: 'Установить Prizrak-Core' }).click();

    await expect.poll(() => saved).toEqual({ profile_id: 'prizrak-core' });
    await expect.poll(() => prepared).toBe(true);
    await expect(modal).toBeHidden();
    await expect(page.locator('#mihomo-core-install-modal')).toBeVisible();
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
    await card.getByRole('button', { name: 'Переустановить' }).click();
    await page.locator('#xray-core-install-modal').getByRole('button', { name: 'Установить' }).click();
    await expect(card).toContainText('Откат: Конфигурация не прошла проверку');
  });

  test('a completed core install turns the busy install button into a close button', async ({ page }) => {
    await page.route('**/api/xray/core-profiles', async (route) => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(xrayProfiles),
    }));
    await page.route('**/api/xray/core-install/prepare', async (route) => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        confirmation: {
          confirmation_id: 'complete-confirm',
          profile: xrayProfiles.data.profiles[0],
          release: xrayProfiles.data.profiles[0].release,
        },
      }),
    }));
    await page.route('**/api/xray/core-install/apply', async (route) => route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, operation: { operation_id: 'complete-op' } }),
    }));
    await page.route('**/api/xray/core-install/status*', async (route) => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        operation: {
          operation_id: 'complete-op',
          status: 'succeeded',
          phase: 'complete',
          phase_label: 'Установка завершена',
          progress: 100,
        },
      }),
    }));

    await openView(page, 'routing');
    await openCoreManagement(page);
    await page.locator('[data-core-source][data-core-engine="xray"]')
      .getByRole('button', { name: 'Переустановить' }).click();

    const modal = page.locator('#xray-core-install-modal');
    const action = modal.locator('[data-core-source-action="apply"]');
    await action.click();

    await expect(action).toHaveText('Закрыть');
    await expect(action).toBeEnabled();
    await expect(action).not.toHaveClass(/is-working/);
    await expect(action).not.toHaveAttribute('aria-busy');
    await expect(action).toHaveAttribute('data-tooltip', 'Закрыть окно установки');

    await action.click();
    await expect(modal).toBeHidden();
  });

  test('the core card names the release state and what its button will do', async ({ page }) => {
    let payload = clone(xrayProfiles);
    await page.route('**/api/xray/core-profiles', async (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(payload) }));
    await openView(page, 'routing');
    await openCoreManagement(page);
    const card = page.locator('[data-core-source][data-core-engine="xray"]');
    const status = card.locator('[data-core-source-status] .xk-core-release');
    const action = card.locator('[data-core-source-action="prepare"]');

    // The installed version is the latest one.
    await expect(status).toHaveClass(/is-ok/);
    await expect(status).toContainText('Установлена последняя версия');
    await expect(action).toHaveText('Переустановить');
    await expect(action).toHaveClass(/btn-secondary/);

    // A newer release: the badge and the button say so.
    payload = clone(xrayProfiles);
    payload.data.profiles[0].release.stable.tag = 'v26.10.1';
    await card.getByRole('button', { name: 'Выбрать источник' }).click();
    await page.locator('#xray-core-source-modal').getByRole('button', { name: 'Закрыть выбор источника' }).click();
    await expect(status).toHaveClass(/is-update/);
    await expect(status).toContainText('26.3.27 → 26.10.1');
    await expect(action).toHaveText('Обновить до 26.10.1');
    await expect(action).toHaveClass(/btn-primary/);

    // The badge text sits on the line of its "Состояние" label.
    const [label, title] = await Promise.all([
      card.locator('.xk-core-source-facts dt').nth(3).boundingBox(),
      status.locator('.xk-core-release-title').boundingBox(),
    ]);
    expect(Math.abs((label.y + label.height / 2) - (title.y + title.height / 2))).toBeLessThanOrEqual(2);

    // The router runs a newer build than the source offers (the case of
    // official Xray before it followed pre-releases): no "latest" claim.
    payload = clone(xrayProfiles);
    payload.data.state.detected_version = '26.9.9';
    payload.data.state.installed_profile_id = null;
    payload.data.profiles[0].release.stable.prerelease = true;
    await card.getByRole('button', { name: 'Выбрать источник' }).click();
    await page.locator('#xray-core-source-modal').getByRole('button', { name: 'Закрыть выбор источника' }).click();
    await expect(status).toHaveClass(/is-info/);
    await expect(status).toContainText('Установлена версия новее источника');
    await expect(status).toContainText('в источнике v26.3.27 · предварительный');
    await expect(action).toHaveText('Установить 26.3.27');
    await expect(action).toHaveClass(/btn-secondary/);

    // No build for this router: a warning and a disabled button.
    payload = clone(xrayProfiles);
    payload.data.profiles[0].release = { installable: false, reason: 'asset_missing' };
    await card.getByRole('button', { name: 'Выбрать источник' }).click();
    await page.locator('#xray-core-source-modal').getByRole('button', { name: 'Закрыть выбор источника' }).click();
    await expect(status).toHaveClass(/is-warn/);
    await expect(status).toContainText('нет сборки для архитектуры этого роутера');
    await expect(action).toBeDisabled();
  });

  test('a stale installed tag does not offer an update to the running version', async ({ page }) => {
    let payload = clone(xrayProfiles);
    payload.data.state.detected_version = '26.10.31';
    payload.data.state.installed_release_tag = 'v26.10.17';
    payload.data.profiles[0].release.stable.tag = 'v26.10.31';
    await page.route('**/api/xray/core-profiles', async (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(payload) }));
    await openView(page, 'routing');
    await openCoreManagement(page);
    const card = page.locator('[data-core-source][data-core-engine="xray"]');
    const status = card.locator('[data-core-source-status] .xk-core-release');
    const action = card.locator('[data-core-source-action="prepare"]');

    await expect(status).toHaveClass(/is-ok/);
    await expect(status).toContainText('Установлена последняя версия');
    await expect(action).toHaveText('Переустановить');

    // A different build of the running version is still a real update.
    payload = clone(payload);
    payload.data.state.installed_release_tag = 'v26.10.31-uwu.1';
    payload.data.profiles[0].release.stable.tag = 'v26.10.31-uwu.2';
    await card.getByRole('button', { name: 'Выбрать источник' }).click();
    await page.locator('#xray-core-source-modal').getByRole('button', { name: 'Закрыть выбор источника' }).click();
    await expect(status).toHaveClass(/is-update/);
    await expect(status).toContainText('26.10.31-uwu.1 → 26.10.31-uwu.2');
    await expect(action).toHaveText('Обновить до 26.10.31-uwu.2');
  });

  test('source cards: the chosen one shows its file and names the install button', async ({ page }) => {
    let saved = null;
    await page.route('**/api/xray/core-profiles', async (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(xrayProfiles) }));
    await page.route('**/api/xray/core-source', async (route) => {
      saved = route.request().postDataJSON();
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });
    await openView(page, 'routing');
    await openCoreManagement(page);
    await page.locator('[data-core-source][data-core-engine="xray"]').getByRole('button', { name: 'Выбрать источник' }).click();
    const modal = page.locator('#xray-core-source-modal');
    const official = modal.locator('.xk-core-source-profile').filter({ has: page.locator('input[value="official"]') });
    const uwuray = modal.locator('.xk-core-source-profile').filter({ has: page.locator('input[value="uwuray"]') });

    await expect(official).toContainText('Установлен');
    await expect(uwuray).not.toContainText('Установлен');
    await expect(modal.locator('.xk-core-source-profile-details')).toHaveCount(1);
    await expect(official.locator('.xk-core-source-profile-details')).toHaveCount(1);
    await expect(modal.getByRole('button', { name: 'Установить v26.3.27' })).toBeVisible();

    // Picking another card moves the details and renames the button, and saves nothing.
    await modal.locator('input[value="uwuray"]').check();
    await expect(uwuray.locator('.xk-core-source-profile-details')).toHaveCount(1);
    await expect(official.locator('.xk-core-source-profile-details')).toHaveCount(0);
    await expect(modal.getByRole('button', { name: 'Установить UwuRay' })).toBeVisible();
    expect(saved).toBeNull();

    // Two equal buttons; the old Cancel and Restore buttons are gone.
    const buttons = modal.locator('.modal-actions button');
    await expect(buttons).toHaveCount(2);
    const [first, second] = await Promise.all([buttons.nth(0).boundingBox(), buttons.nth(1).boundingBox()]);
    expect(Math.abs(first.width - second.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(second.x - (first.x + first.width) - 12)).toBeLessThanOrEqual(1);
  });
  test('the official source shows its release channels as a switch in one card', async ({ page }) => {
    const payload = clone(xrayProfiles);
    payload.data.state = { selected_profile_id: 'official-prerelease', installed_profile_id: null, last_status: 'idle', detected_version: '26.9.9' };
    payload.data.profiles.splice(1, 0, {
      profile_id: 'official-prerelease', channel_of: 'official', display_name: 'Официальный Xray, предварительные', repo: 'XTLS/Xray-core',
      description: 'Базовая совместимость Xray.', risk_level: 'official',
      release: { installable: true, stable: { tag: 'v26.10.17', prerelease: true }, asset: { name: 'Xray-linux-mips32le.zip' }, checksum: { sha256: 'e'.repeat(64) } },
    });
    let saved = null;
    await page.route('**/api/xray/core-profiles', async (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(payload) }));
    await page.route('**/api/xray/core-source', async (route) => {
      saved = route.request().postDataJSON();
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });
    await openView(page, 'routing');
    await openCoreManagement(page);
    const card = page.locator('[data-core-source][data-core-engine="xray"]');
    // 26.9.9 on the router, v26.10.17 in the chosen channel: an update.
    await expect(card.locator('[data-core-source-status] .xk-core-release')).toContainText('26.9.9 → 26.10.17 · предварительный');

    await card.getByRole('button', { name: 'Выбрать источник' }).click();
    const modal = page.locator('#xray-core-source-modal');
    await expect(modal.locator('.xk-core-source-profile')).toHaveCount(2);
    const official = modal.locator('.xk-core-source-profile').first();
    await expect(official.locator('.xk-core-source-profile-head strong')).toHaveText('Официальный Xray');
    const stable = official.locator('[data-core-source-channel="official"]');
    const pre = official.locator('[data-core-source-channel="official-prerelease"]');
    await expect(pre).toHaveAttribute('aria-pressed', 'true');
    await expect(official).toContainText('v26.10.17');
    await expect(official.locator('.xk-core-source-profile-details')).toContainText('e'.repeat(64));
    await expect(modal.getByRole('button', { name: 'Установить v26.10.17' })).toBeVisible();

    await stable.click();
    await expect(stable).toHaveAttribute('aria-pressed', 'true');
    await expect(official.locator('.xk-core-source-profile-meta')).toContainText('v26.3.27');
    await expect(official.locator('.xk-core-source-profile-details')).toContainText('a'.repeat(64));
    await expect(modal.getByRole('button', { name: 'Установить v26.3.27' })).toBeVisible();
    expect(saved).toBeNull();
    await modal.getByRole('button', { name: 'Запомнить без установки' }).click();
    await expect.poll(() => saved).toEqual({ profile_id: 'official' });
  });

  test('a Mihomo alpha build is named by its commit and compared by it', async ({ page }) => {
    const payload = mihomoProfiles();
    payload.data.state = { selected_profile_id: 'official-prerelease', installed_profile_id: null, last_status: 'idle', detected_version: 'alpha-1a2b3c4' };
    payload.data.profiles.splice(1, 0, {
      profile_id: 'official-prerelease', channel_of: 'official', display_name: 'Официальный Mihomo, предварительные', repo: 'MetaCubeX/mihomo',
      description: 'Базовая совместимость Mihomo.', risk_level: 'official',
      release: { installable: true, stable: { tag: 'Prerelease-Alpha', prerelease: true, published_at: '2026-10-13T14:00:00Z' }, asset: { name: 'mihomo-linux-mipsle-softfloat-alpha-94b13ae.gz' }, checksum: { sha256: 'f'.repeat(64) } },
    });
    await page.route('**/api/mihomo/core-profiles', async (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(payload) }));
    await openView(page, 'mihomo');
    await openCoreManagement(page, 'mihomo');
    const card = page.locator('[data-core-source][data-core-engine="mihomo"]');
    await expect(card.locator('[data-core-source-status] .xk-core-release')).toContainText('alpha-1a2b3c4 → alpha-94b13ae');
    await expect(card.locator('[data-core-source-action="prepare"]')).toHaveText('Обновить до alpha-94b13ae');
    await card.getByRole('button', { name: 'Выбрать источник' }).click();
    const official = page.locator('#mihomo-core-source-modal .xk-core-source-profile').first();
    await expect(official.locator('[data-core-source-channel="official-prerelease"]')).toContainText('alpha-94b13ae');
    await expect(official.locator('.xk-core-source-profile-meta')).toContainText('alpha-94b13ae · 13.10.2026');
  });
});

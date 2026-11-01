import { test, expect, selectPanelView, openMihomoConfig } from './fixtures.mjs';

const CONFIG_BEFORE = [
  'mixed-port: 7890',
  'mode: rule',
  'proxies: []',
].join('\n');

const CONFIG_AFTER = [
  CONFIG_BEFORE,
  'dns:',
  '  enable: true',
  '  listen: 0.0.0.0:53',
].join('\n');

const DNS_OFF = {
  ok: true,
  enabled: false,
  prepared: false,
  partial: false,
  tampered: false,
  can_recover: false,
  can_enable: true,
  can_disable: false,
  active_core: 'mihomo',
  proxy_group: 'PROXY',
  dns_override: false,
  dns_present: false,
  dns_enabled: false,
  dns_listener_configured: false,
  listen: '0.0.0.0:53',
  mode: 'redir-host',
  blockers: [],
  watchdog: null,
  watchdog_settings: { enabled: true, interval: 30, fail_threshold: 3, restart_attempts: 2 },
};

const DNS_ON = {
  ...DNS_OFF,
  enabled: true,
  prepared: true,
  can_enable: false,
  can_disable: true,
  dns_override: true,
  dns_present: true,
  dns_enabled: true,
  dns_listener_configured: true,
};

async function openMihomoDns(page, {
  onConfig,
  onDns,
  initialStatus = DNS_OFF,
  initialConfig = CONFIG_BEFORE,
}) {
  await page.route('**/api/mihomo-config**', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, content: onConfig() }),
    });
  });

  await page.route('**/api/mihomo/dns', async (route) => {
    if (route.request().method() === 'POST') {
      onDns.posted = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, enabled: true, probe: { ok: true, latency_ms: 5 } }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(onDns.posted ? onDns.afterStatus : initialStatus),
    });
  });

  await page.goto('/');
  await selectPanelView(page, 'mihomo');
  await openMihomoConfig(page);

  const editor = page.locator('#mihomo-editor + .xkeen-cm6-host .cm-content');
  await expect(editor).toBeVisible();
  await page.locator('.xk-mihomo-menu summary').click();
  await page.locator('#mihomo-load-btn').click();
  await expect(editor).toContainText(initialConfig.split('\n')[0]);
  await page.locator('#mihomo-dns-btn').click();
  await expect(page.locator('#mihomo-dns-modal')).toBeVisible();
  return editor;
}

async function confirmEnable(page) {
  await page.locator('#mihomo-dns-apply').click();
  await expect(page.locator('#confirm-modal')).toBeVisible();
  await page.locator('#confirm-modal-ok-btn').click();
  await expect(page.locator('#toast-container .toast').filter({ hasText: 'Защищённый DNS включён' })).toBeVisible();
}

test('Mihomo DNS updates a clean editor without a page reload', async ({ page }) => {
  const state = { posted: false, configReads: 0 };
  state.afterStatus = DNS_ON;
  const editor = await openMihomoDns(page, {
    onConfig: () => {
      state.configReads += 1;
      return state.posted ? CONFIG_AFTER : CONFIG_BEFORE;
    },
    onDns: state,
  });

  await confirmEnable(page);

  await expect(editor).toContainText('dns:');
  expect(state.configReads).toBeGreaterThanOrEqual(2);
  await expect(page.locator('#toast-container .toast').filter({ hasText: 'Редактор не перезаписан' })).toHaveCount(0);
});

test('Mihomo DNS keeps a genuinely edited editor and explains why it was not replaced', async ({ page }) => {
  const state = { posted: false, configReads: 0 };
  state.afterStatus = DNS_ON;
  const editor = await openMihomoDns(page, {
    onConfig: () => {
      state.configReads += 1;
      return state.posted ? CONFIG_AFTER : CONFIG_BEFORE;
    },
    onDns: state,
  });

  await page.locator('#mihomo-dns-close').click();
  await expect(page.locator('#mihomo-dns-modal')).toBeHidden();
  await editor.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\n# local edit');

  await page.locator('#mihomo-dns-btn').click();
  await expect(page.locator('#mihomo-dns-modal')).toBeVisible();
  await confirmEnable(page);

  await expect(editor).toContainText('# local edit');
  await expect(page.locator('#toast-container .toast').filter({
    hasText: 'Редактор не перезаписан: в нём есть несохранённые изменения.',
  })).toBeVisible();
  expect(state.configReads).toBe(1);
  await expect(editor).not.toContainText('dns:');
});

test('Mihomo DNS does not mark the editor dirty after switching engines', async ({ page }) => {
  const state = { posted: false, configReads: 0 };
  state.afterStatus = DNS_ON;
  const editor = await openMihomoDns(page, {
    onConfig: () => {
      state.configReads += 1;
      return state.posted ? CONFIG_AFTER : CONFIG_BEFORE;
    },
    onDns: state,
  });

  const engine = page.locator('#mihomo-editor-engine-select');
  await engine.selectOption('monaco');
  await expect(page.locator('#mihomo-editor-monaco .monaco-editor').last()).toBeVisible();
  await engine.selectOption('codemirror');
  await expect(editor).toBeVisible();

  await confirmEnable(page);

  await expect(editor).toContainText('dns:');
  await expect(page.locator('#toast-container .toast').filter({ hasText: 'Редактор не перезаписан' })).toHaveCount(0);
});

test('Mihomo DNS updates a clean editor after disabling without a page reload', async ({ page }) => {
  const state = { posted: false, configReads: 0, afterStatus: DNS_OFF };
  const editor = await openMihomoDns(page, {
    initialStatus: DNS_ON,
    initialConfig: CONFIG_AFTER,
    onConfig: () => {
      state.configReads += 1;
      return state.posted ? CONFIG_BEFORE : CONFIG_AFTER;
    },
    onDns: state,
  });

  await page.locator('#mihomo-dns-apply').click();
  await expect(page.locator('#confirm-modal')).toBeVisible();
  await page.locator('#confirm-modal-ok-btn').click();

  await expect(page.locator('#toast-container .toast').filter({ hasText: 'DNS Mihomo отключён' })).toBeVisible();
  await expect(editor).not.toContainText('dns:');
  expect(state.configReads).toBeGreaterThanOrEqual(2);
  await expect(page.locator('#toast-container .toast').filter({ hasText: 'Редактор не перезаписан' })).toHaveCount(0);
});

import { test, expect } from './fixtures.mjs';
import { mkdirSync } from 'node:fs';

/* Screenshots of the shared port-53 guard as both windows now describe it. */

const SHOTS = process.env.XKEEN_GUARD_SHOTS_DIR || 'playwright-report/dns-guard';
mkdirSync(SHOTS, { recursive: true });

const WATCHDOG_SETTINGS = { enabled: true, interval: 30, fail_threshold: 3, restart_attempts: 2 };

const VLESS_BASE = {
  enabled: false,
  prepared: false,
  partial: false,
  can_enable: true,
  can_disable: false,
  active_core: 'xray',
  dns_override: false,
  blockers: [],
  upstreams: ['8.8.8.8'],
  local_resolvers: [],
  local_domains: [],
  default_local_domains: ['domain:lan'],
  zone_presets: { local: ['domain:lan'] },
  candidates: [],
  selected_targets: ['proxy'],
  default_target: 'proxy',
  choice_required: false,
  watchdog: null,
  watchdog_settings: WATCHDOG_SETTINGS,
};

const VLESS_ENABLED = {
  ...VLESS_BASE,
  enabled: true,
  can_enable: false,
  can_disable: true,
  dns_override: true,
  target: { tag: 'proxy', label: 'балансировщик proxy' },
};

const VLESS_RELEASED = {
  ...VLESS_BASE,
  can_enable: true,
  watchdog: {
    released_at: 1770000000,
    reason: 'xray не отвечает после 2 попыток перезапуска; DNS возвращён прошивке.',
  },
};

const MIHOMO_BASE = {
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
  watchdog_settings: WATCHDOG_SETTINGS,
};

const MIHOMO_ENABLED = {
  ...MIHOMO_BASE,
  enabled: true,
  prepared: true,
  can_enable: false,
  can_disable: true,
  dns_override: true,
  dns_present: true,
  dns_enabled: true,
  dns_listener_configured: true,
};

const MIHOMO_RELEASED = {
  ...MIHOMO_BASE,
  watchdog: {
    released_at: 1770000000,
    reason: 'mihomo не отвечает после 2 попыток перезапуска; DNS возвращён прошивке.',
  },
};

const MIHOMO_RULE_PROVIDER_STATUS = {
  ...MIHOMO_BASE,
  mode: 'fake-ip',
  can_enable: true,
  fake_ip_available: true,
  geodata: {
    enabled: false,
    geosite_configured: false,
    private_available: false,
    notice: 'GeoSite или доменный provider private не настроен — фильтр geosite:private работать не будет.',
    domain_providers: {
      'category_ru@domain': {
        configured: false,
        filter: 'rule-set:category_ru@domain',
        url: 'https://github.com/MetaCubeX/meta-rules-dat/raw/refs/heads/meta/geo/geosite/category-ru.mrs',
      },
      'geosite_private@domain': {
        configured: false,
        filter: 'rule-set:geosite_private@domain',
        url: 'https://github.com/MetaCubeX/meta-rules-dat/raw/refs/heads/meta/geo/geosite/private.mrs',
      },
    },
    rule_providers: {
      'category_ru@domain': {
        configured: false,
        filter: 'rule-set:category_ru@domain',
        url: 'https://github.com/MetaCubeX/meta-rules-dat/raw/refs/heads/meta/geo/geosite/category-ru.mrs',
      },
      'geosite_private@domain': {
        configured: false,
        filter: 'rule-set:geosite_private@domain',
        url: 'https://github.com/MetaCubeX/meta-rules-dat/raw/refs/heads/meta/geo/geosite/private.mrs',
      },
    },
  },
};

// Оба окна снимаются в обеих темах: тексты сторожа читают и там, и там.
const THEME = (process.env.XKEEN_GUARD_SHOTS_THEME === 'dark') ? 'dark' : 'light';

async function shoot(page, selector, name) {
  await page.locator(selector).screenshot({ path: `${SHOTS}/${name}-${THEME}.png` });
}

async function applyTheme(page) {
  await page.addInitScript((theme) => {
    try { localStorage.setItem('xkeen-theme', theme); } catch (error) {}
  }, THEME);
}

async function openVless(page, status) {
  await applyTheme(page);
  await page.route('**/api/routing/dns-over-vless', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(status) });
  });
  await page.addInitScript(() => localStorage.setItem('xk.routing.rules.open.v2', '1'));
  await page.goto('/');
  await expect(page.locator('#routing-dns-over-vless-btn')).toBeVisible();
  await page.locator('#routing-dns-over-vless-btn').click();
  await expect(page.locator('#routing-dns-over-vless-modal')).toBeVisible();
}

async function openMihomo(page, status) {
  await applyTheme(page);
  await page.route('**/api/mihomo/dns', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(status) });
  });
  await page.goto('/');
  await page.locator('.top-tab-btn[data-view="mihomo"]').click();
  await expect(page.locator('#view-mihomo')).toBeVisible();
  await page.locator('#mihomo-clash-tab-config').click();
  await expect(page.locator('#mihomo-dns-btn')).toBeVisible();
  await page.locator('#mihomo-dns-btn').click();
  await expect(page.locator('#mihomo-dns-modal')).toBeVisible();
}

test('DNS-over-VLESS: the guard is watching', async ({ page }) => {
  await openVless(page, VLESS_ENABLED);
  await expect(page.locator('#routing-dns-over-vless-details')).toContainText('Сторож следит');
  await shoot(page, '#routing-dns-over-vless-modal .modal-content', '1-vless-guard-watching');
});

test('DNS-over-VLESS: the guard handed DNS back', async ({ page }) => {
  await openVless(page, VLESS_RELEASED);
  await expect(page.locator('#routing-dns-over-vless-badge')).toHaveText('Снято сторожем');
  await shoot(page, '#routing-dns-over-vless-modal .modal-content', '2-vless-guard-released');
});

test('Mihomo DNS: the guard is watching', async ({ page }) => {
  await openMihomo(page, MIHOMO_ENABLED);
  await expect(page.locator('#mihomo-dns-details')).toContainText('Сторож следит');
  await shoot(page, '#mihomo-dns-modal .modal-content', '3-mihomo-guard-watching');
});

test('Mihomo DNS: the guard handed DNS back', async ({ page }) => {
  await openMihomo(page, MIHOMO_RELEASED);
  await expect(page.locator('#mihomo-dns-badge')).toHaveText('Снято сторожем');
  await shoot(page, '#mihomo-dns-modal .modal-content', '4-mihomo-guard-released');
});

test('Mihomo DNS: rule-provider buttons fill the fake-ip payload', async ({ page }) => {
  const status = structuredClone(MIHOMO_RULE_PROVIDER_STATUS);
  const postBodies = [];

  await openMihomo(page, status);
  await page.route('**/api/mihomo/dns', async (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      postBodies.push(body);
      status.enabled = true;
      status.can_enable = false;
      status.can_disable = true;
      status.dns_override = true;
      status.prepared = true;
      status.dns_present = true;
      status.dns_enabled = true;
      status.dns_listener_configured = true;
      await route.fulfill({
        json: {
          ok: true,
          enabled: true,
          proxy_group: 'PROXY',
          listen: '0.0.0.0:53',
          mode: 'fake-ip',
          fake_ip: body.fake_ip,
          rule_providers: body.rule_providers,
          probe: { ok: true, latency_ms: 17 },
        },
      });
      return;
    }
    await route.fallback();
  });

  await expect(page.locator('#mihomo-dns-rule-providers')).toBeVisible();
  await expect(page.locator('#mihomo-dns-provider-category-ru')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#mihomo-dns-provider-private')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#mihomo-dns-provider-category-ai')).toHaveAttribute('aria-pressed', 'true');

  await page.locator('#mihomo-dns-apply').click();
  await expect(page.locator('#confirm-modal')).toBeVisible();
  await page.locator('#confirm-modal-ok-btn').click();
  await expect.poll(() => postBodies.length).toBe(1);
  expect(postBodies[0].rule_providers).toEqual(['category_ru@domain', 'geosite_private@domain', 'category-ai@domain']);
  expect(postBodies[0].fake_ip.filters).toContain('rule-set:category_ru@domain');
  expect(postBodies[0].fake_ip.filters).toContain('rule-set:geosite_private@domain');
  expect(postBodies[0].fake_ip.filters).toContain('rule-set:category-ai@domain');
  expect(postBodies[0].fake_ip.filters).toContain('+.tsarea.tv');
});

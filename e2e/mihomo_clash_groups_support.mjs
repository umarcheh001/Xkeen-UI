import { expect } from './fixtures.mjs';

// Shared by the browser tests of the Mihomo groups workspace (mihomo_clash_groups_*.spec.mjs).

export function statusPayload() {
  return {
    ok: true,
    state: 'ready',
    schema_version: 1,
    core: { version: 'Mihomo Meta v1.19.29' },
    runtime: { mode: 'rule' },
    capabilities: { status: true, proxy_groups: true, proxy_select: true, proxy_unfix: true, proxy_delay: true, connection_disconnect: true },
  };
}


export function groupsPayload(now = 'node-a', fixed = '', includeReliabilityFixture = false) {
  return {
    ok: true,
    schema_version: 1,
    truncated: false,
    providers: [{ name: 'provider-one', type: 'Proxy', node_count: 1 }],
    groups: [
      {
        name: 'AUTO',
        type: 'Selector',
        icon: 'https://cdn.example.test/icons/auto.png',
        now,
        fixed,
        hidden: false,
        selectable: true,
        nodes: [
          {
            name: 'node-a', type: 'VLESS', alive: true, udp: true, provider: '', provider_candidates: [], delay_ms: 82,
            delay_history: [
              { measured_at: '2026-08-16T10:15:20Z', delay_ms: 79 },
              { measured_at: '2026-08-16T10:15:27Z', delay_ms: 82 },
            ],
            server: 'edge.example.test', port: 443, network: 'xhttp', security: 'tls', host: 'cdn.example.test', path: '/api/v2/',
          },
          { name: 'node-b', type: 'Trojan', alive: false, udp: true, provider: 'provider-one', provider_candidates: ['provider-one'], delay_ms: 999 },
          { name: 'DIRECT', type: 'Direct', alive: true, udp: true, provider: '', provider_candidates: [], delay_ms: null },
        ],
      },
      {
        name: 'HIDDEN',
        type: 'URLTest',
        now: 'hidden-node',
        fixed: 'hidden-node',
        hidden: true,
        selectable: true,
        nodes: [{ name: 'hidden-node', type: 'VLESS', alive: null, udp: null, provider: '', provider_candidates: [], delay_ms: null }],
      },
      ...(includeReliabilityFixture ? [{
        name: 'FALLBACK',
        type: 'Fallback',
        now: 'node-b',
        fixed: 'node-a',
        hidden: false,
        selectable: true,
        nodes: [
          { name: 'node-a', type: 'VLESS', alive: true, udp: true, provider: '', provider_candidates: [], delay_ms: 120 },
          { name: 'node-b', type: 'Trojan', alive: true, udp: true, provider: '', provider_candidates: [], delay_ms: 80 },
        ],
      }] : []),
    ],
  };
}


export function globalGroupPayload(now = 'AUTO') {
  return {
    name: 'GLOBAL',
    type: 'Selector',
    icon: '',
    now,
    fixed: '',
    hidden: false,
    selectable: true,
    node_count: 2,
    nodes_truncated: false,
    nodes: [
      { name: 'AUTO', type: 'Selector', alive: true, udp: true, provider: '', provider_candidates: [], delay_ms: null },
      { name: 'DIRECT', type: 'Direct', alive: true, udp: true, provider: '', provider_candidates: [], delay_ms: null },
    ],
  };
}


export function egressPayload(cached = false) {
  return {
    ok: true,
    schema_version: 1,
    route_scope: 'mihomo_proxy',
    lookup_host: 'ipapi.co',
    ip: '198.51.100.25',
    ip_version: 'IPv4',
    city: 'Helsinki',
    region: 'Uusimaa',
    country: 'Finland',
    country_code: 'FI',
    asn: 'AS64500',
    organization: 'Example Network',
    timezone: 'Europe/Helsinki',
    cached,
  };
}

export async function setHiddenGroupsVisible(page, visible = true) {
  const menu = page.locator('#xk-mihomo-parameters-menu');
  const input = menu.locator('#mihomo-clash-show-hidden');
  const switchControl = menu.locator('label.xk-mihomo-groups-hidden-toggle');
  const toolbar = page.locator('#view-mihomo .xk-mihomo-groups-toolbar');

  await expect(input).toBeAttached();
  // The header moves controls into the parameters popover before the
  // Mihomo control tab is ready. Wait for the explicit readiness state
  // instead of racing the temporary hidden controls.
  await expect(toolbar).toHaveAttribute('data-control-ready', 'true');
  if (!(await menu.isVisible())) {
    await page.locator('[aria-controls="xk-mihomo-parameters-menu"]').click();
    await expect(menu).toBeVisible();
  }
  await expect(switchControl).toBeVisible();
  if ((await input.isChecked()) !== visible) {
    await switchControl.click();
  }
  if (visible) {
    await expect(input).toBeChecked();
  } else {
    await expect(input).not.toBeChecked();
  }
}

export async function openMihomoGroupsMenu(page) {
  const menu = page.locator('#xk-mihomo-parameters-menu');
  if (!(await menu.isVisible())) {
    await page.locator('[aria-controls="xk-mihomo-parameters-menu"]').click();
    await expect(menu).toBeVisible();
  }
}

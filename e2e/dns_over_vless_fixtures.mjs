import { expect } from './fixtures.mjs';


function candidate(tag, extra = {}) {
  return {
    kind: 'outbound',
    tag,
    label: `прокси ${tag}`,
    selector: [],
    selector_count: 0,
    strategy_type: '',
    fallback_tag: '',
    fallback: { tag: '', kept: false, verdict: 'none', reason: 'одиночный прокси, резерва нет' },
    usable: true,
    reason: '',
    ...extra,
  };
}


// Общий снимок ответа /api/routing/dns-over-vless для тестов окна. Специфичные
// сценарии (Mihomo, обход, узел без резервных типов записей и т.д.) собирают
// свой объект поверх этого через `{ ...STATUS, ... }` прямо в спеке.
export const STATUS = {
  enabled: false,
  prepared: false,
  partial: false,
  can_enable: true,
  can_disable: false,
  active_core: 'xray',
  dns_override: false,
  blockers: [],
  upstreams: ['8.8.8.8'],
  default_upstreams: ['8.8.8.8'],
  local_resolvers: [],
  local_domains: [],
  default_local_domains: ['domain:lan'],
  zone_presets: { local: ['domain:lan'] },
  candidates: [
    {
      kind: 'balancer',
      tag: 'proxy',
      label: 'балансировщик proxy',
      selector: ['a', 'b'],
      selector_count: 2,
      strategy_type: 'leastPing',
      fallback_tag: 'direct',
      fallback: { tag: 'direct', kept: false, verdict: 'dropped', reason: 'Если все выбранные прокси разом откажут, DNS просто перестанет отвечать. В вашем балансировщике на такой случай стоит запасной путь в обход VPN, но для DNS панель его не использует: запросы пошли бы к провайдеру, и он снова видел бы, какие сайты вы открываете.' },
      usable: true,
      reason: '',
    },
    candidate('cdn.pecan.run--YYY_Netherlands.0005'),
    candidate('cdn.pecan.run--XXX_Germany.98.1016'),
    candidate('cdn.pecan.run--YYY_Sweden.e026'),
    candidate('cdn.pecan.run--ZZZ_Kazakhstan_02.a361', { usable: false, reason: 'нет рабочего selector' }),
  ],
  selected_targets: [],
  default_target: 'proxy',
  choice_required: true,
  watchdog: null,
  watchdog_settings: { enabled: true, interval: 30, fail_threshold: 3, restart_attempts: 2 },
};


// Открывает диалог DNS-over-VLESS с заданным (или дефолтным) снимком статуса.
// Общая точка входа для всех спеков этого окна: подменяет ответ API,
// раскрывает свёрнутую карточку правил и дожидается видимости модалки.
export async function openDialog(page, status = STATUS) {
  await page.route('**/api/routing/dns-over-vless', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(status) });
  });
  // The rules card ships collapsed and the dialog's button lives inside it.
  await page.addInitScript(() => localStorage.setItem('xk.routing.rules.open.v2', '1'));
  await page.goto('/');
  await expect(page.locator('#view-routing')).toBeVisible();
  await expect(page.locator('#routing-dns-over-vless-btn')).toBeVisible();
  await page.locator('#routing-dns-over-vless-btn').click();
  await expect(page.locator('#routing-dns-over-vless-modal')).toBeVisible();
  if (status === STATUS) await expect(page.locator('#routing-dns-over-vless-route')).toBeVisible();
}

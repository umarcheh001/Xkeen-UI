import { test, expect } from './fixtures.mjs';


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


const STATUS = {
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
  candidates: [
    {
      kind: 'balancer',
      tag: 'proxy',
      label: 'балансировщик proxy',
      selector: ['a', 'b'],
      selector_count: 2,
      strategy_type: 'leastPing',
      fallback_tag: 'direct',
      fallback: { tag: 'direct', kept: false, verdict: 'dropped', reason: 'резервный маршрут «direct» ведёт напрямую' },
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


async function openDialog(page) {
  await page.route('**/api/routing/dns-over-vless', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(STATUS) });
  });
  // The rules card ships collapsed and the dialog's button lives inside it.
  await page.addInitScript(() => localStorage.setItem('xk.routing.rules.open.v2', '1'));
  await page.goto('/');
  await expect(page.locator('#view-routing')).toBeVisible();
  await expect(page.locator('#routing-dns-over-vless-btn')).toBeVisible();
  await page.locator('#routing-dns-over-vless-btn').click();
  await expect(page.locator('#routing-dns-over-vless-modal')).toBeVisible();
  await expect(page.locator('#routing-dns-over-vless-route')).toBeVisible();
}


test('the dialog opens with its footer inside the frame and scrolls its body', async ({ page }) => {
  await openDialog(page);

  const geometry = await page.evaluate(() => {
    const content = document.querySelector('#routing-dns-over-vless-modal .modal-content');
    const body = document.querySelector('#routing-dns-over-vless-modal .routing-dns-over-vless-body');
    const actions = document.querySelector('#routing-dns-over-vless-modal .routing-dns-over-vless-actions');
    return {
      contentBottom: content.getBoundingClientRect().bottom,
      actionsBottom: actions.getBoundingClientRect().bottom,
      actionsHeight: actions.getBoundingClientRect().height,
      bodyOverflows: body.scrollHeight > body.clientHeight + 1,
      viewportHeight: window.innerHeight,
    };
  });

  expect(geometry.actionsHeight).toBeGreaterThan(0);
  // The footer used to be cut off by the grid overflowing its own max-height.
  expect(geometry.actionsBottom).toBeLessThanOrEqual(geometry.contentBottom + 1);
  expect(geometry.actionsBottom).toBeLessThanOrEqual(geometry.viewportHeight);
  expect(geometry.bodyOverflows).toBe(true);
  await expect(page.locator('#routing-dns-over-vless-apply')).toBeVisible();
});


test('a click ticks a proxy and the next click unticks it', async ({ page }) => {
  await openDialog(page);

  const picker = page.locator('#routing-dns-over-vless-target');
  const options = picker.locator('.routing-dns-over-vless-option');
  await expect(options).toHaveCount(5);
  // Single-target mode preselects the saved default.
  await expect(picker.locator('[data-tag="proxy"]')).toHaveAttribute('data-selected', '1');

  await page.locator('#routing-dns-over-vless-multi').check();
  await expect(picker).toHaveAttribute('data-mode', 'multi');
  // Balancers cannot be combined, so only plain proxies remain.
  await expect(options).toHaveCount(4);

  const first = picker.locator('[data-tag="cdn.pecan.run--YYY_Netherlands.0005"]');
  const second = picker.locator('[data-tag="cdn.pecan.run--XXX_Germany.98.1016"]');
  // Switching modes keeps one working default ticked instead of an empty list.
  await expect(first).toHaveAttribute('data-selected', '1');
  await expect(page.locator('#routing-dns-over-vless-target-count')).toHaveText('Отмечено 1 из 3');

  await second.click();
  await expect(first).toHaveAttribute('data-selected', '1');
  await expect(second).toHaveAttribute('data-selected', '1');
  await expect(page.locator('#routing-dns-over-vless-target-count')).toHaveText('Отмечено 2 из 3');
  await expect(page.locator('#routing-dns-over-vless-apply')).toBeEnabled();

  await second.click();
  await expect(first).toHaveAttribute('data-selected', '1');
  await expect(second).toHaveAttribute('data-selected', '0');
  await expect(page.locator('#routing-dns-over-vless-target-count')).toHaveText('Отмечено 1 из 3');
  await expect(page.locator('#routing-dns-over-vless-route-fallback')).toContainText('балансировки не будет');

  // An unusable candidate stays inert.
  const broken = picker.locator('[data-tag="cdn.pecan.run--ZZZ_Kazakhstan_02.a361"]');
  await expect(broken).toHaveAttribute('aria-disabled', 'true');
  // Playwright treats aria-disabled as disabled, so drive the click directly.
  await broken.click({ force: true });
  await expect(broken).toHaveAttribute('data-selected', '0');
});


test('bulk buttons fill and clear the selection, and an empty one blocks the action', async ({ page }) => {
  await openDialog(page);
  await page.locator('#routing-dns-over-vless-multi').check();

  await page.locator('#routing-dns-over-vless-target-all').click();
  await expect(page.locator('#routing-dns-over-vless-target-count')).toHaveText('Отмечено 3 из 3');
  await expect(page.locator('#routing-dns-over-vless-apply')).toBeEnabled();

  await page.locator('#routing-dns-over-vless-target-none').click();
  await expect(page.locator('#routing-dns-over-vless-target-count')).toHaveText('Отмечено 0 из 3');
  // Nothing ticked means no route to build: the action must stay closed.
  await expect(page.locator('#routing-dns-over-vless-apply')).toBeDisabled();
  await expect(page.locator('#routing-dns-over-vless-route-fallback')).toContainText('Отметьте хотя бы два прокси');
});


test('the list is operable from the keyboard', async ({ page }) => {
  await openDialog(page);
  await page.locator('#routing-dns-over-vless-multi').check();

  const picker = page.locator('#routing-dns-over-vless-target');
  await picker.locator('[data-tag="cdn.pecan.run--XXX_Germany.98.1016"]').focus();
  await page.keyboard.press('Space');
  await expect(picker.locator('[data-tag="cdn.pecan.run--XXX_Germany.98.1016"]')).toHaveAttribute('data-selected', '1');
  await expect(page.locator('#routing-dns-over-vless-target-count')).toHaveText('Отмечено 2 из 3');

  // The redraw must not lose the focused row, so the next arrow key moves on.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(picker.locator('[data-tag="cdn.pecan.run--YYY_Sweden.e026"]')).toHaveAttribute('data-selected', '1');
  await expect(page.locator('#routing-dns-over-vless-target-count')).toHaveText('Отмечено 3 из 3');
});

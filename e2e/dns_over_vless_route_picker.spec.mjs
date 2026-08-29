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


const MIHOMO_STATUS = {
  ...STATUS,
  active_core: 'mihomo',
  can_enable: false,
  blockers: ['Для активации переключите активное ядро на Xray.'],
  // Wording the universal guard actually writes when the core is switched.
  watchdog: { reason: 'Активно ядро mihomo, а защита DNS рассчитана на xray; перезапуски делу не помогут, DNS возвращён прошивке.' },
};


async function openDialog(page, status = STATUS) {
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


test('the dialog opens with its footer inside the frame and scrolls its body', async ({ page }) => {
  // A short viewport is the case that used to cut the footer off.
  await page.setViewportSize({ width: 1280, height: 700 });
  await openDialog(page);

  const geometry = await page.evaluate(() => {
    const content = document.querySelector('#routing-dns-over-vless-modal .modal-content');
    const body = document.querySelector('#routing-dns-over-vless-modal .routing-dns-over-vless-body');
    const actions = document.querySelector('#routing-dns-over-vless-modal .routing-dns-over-vless-actions');
    return {
      contentTop: content.getBoundingClientRect().top,
      contentHeight: content.getBoundingClientRect().height,
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
  // Pinned to the top and as tall as the screen allows.
  expect(geometry.contentTop).toBeLessThanOrEqual(20);
  expect(geometry.contentHeight).toBeGreaterThan(geometry.viewportHeight - 40);
  await expect(page.locator('#routing-dns-over-vless-apply')).toBeVisible();
});


test('with Mihomo running the dialog talks about Mihomo, not Xray', async ({ page }) => {
  await openDialog(page, MIHOMO_STATUS);

  await expect(page.locator('#routing-dns-over-vless-lead-title')).toContainText('Mihomo');
  await expect(page.locator('#routing-dns-over-vless-lead-text')).toContainText('вкладке Mihomo');
  // Mihomo has the same protection of its own, so nothing may read as "you
  // cannot have protected DNS".
  await expect(page.locator('#routing-dns-over-vless-modal')).not.toContainText('только с Xray');
  await expect(page.locator('#routing-dns-over-vless-modal')).not.toContainText('только для Xray');
  // The guard is one mechanism for both cores, so both windows announce it with
  // the same sentence and the same badge.
  await expect(page.locator('#routing-dns-over-vless-badge')).toHaveText('Снято сторожем');
  await expect(page.locator('#routing-dns-over-vless-status')).toContainText('Сторож вернул DNS роутеру');
  await expect(page.locator('#routing-dns-over-vless-status')).toContainText('вернув активным ядром Xray вместо Mihomo');
  // The guard's own reason is accurate, so it is shown as written.
  await expect(page.locator('#routing-dns-over-vless-status')).toContainText('перезапуски делу не помогут');
  // No point picking a route that cannot be applied under this core.
  await expect(page.locator('#routing-dns-over-vless-route')).toBeHidden();
  const apply = page.locator('#routing-dns-over-vless-apply');
  await expect(apply).toHaveText('Нужно ядро Xray');
  await expect(apply).toBeDisabled();
});


test('with Xray running the dialog keeps its Xray wording', async ({ page }) => {
  await openDialog(page);

  await expect(page.locator('#routing-dns-over-vless-lead-title')).toHaveText('DNS через защищённый туннель Xray');
  await expect(page.locator('#routing-dns-over-vless-status')).toContainText('конфигурация совместима');
  await expect(page.locator('#routing-dns-over-vless-apply')).toHaveText('Включить безопасно');
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


test('clicking the header leaves the dialog where it is, dragging still moves it', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 700 });
  await openDialog(page);

  const content = page.locator('#routing-dns-over-vless-modal .modal-content');
  const geometry = () => content.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return { top: Math.round(rect.top), left: Math.round(rect.left), height: Math.round(rect.height) };
  });

  const before = await geometry();
  const header = page.locator('#routing-dns-over-vless-modal .modal-header');
  const box = await header.boundingBox();
  if (!box) throw new Error('modal header has no bounding box');

  // A plain click used to freeze the dialog into fixed coordinates and drop its
  // max-height, so it grew to full content height and slid off screen.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.up();
  const afterClick = await geometry();
  expect(afterClick).toEqual(before);

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 30, { steps: 6 });
  await page.mouse.up();
  const afterDrag = await geometry();
  expect(afterDrag.left).toBeGreaterThan(before.left + 40);
});

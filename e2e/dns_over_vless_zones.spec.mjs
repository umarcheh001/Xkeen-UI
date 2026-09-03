import { test, expect } from './fixtures.mjs';
import { mockClients, openDialog, openZone, STATUS } from './dns_over_vless_fixtures.mjs';


const CLIENTS = {
  available: true,
  counts: { total: 25, reaches: 14, intercepted: 11 },
  clients: [
    { title: 'DIGUS-01', mac: 'aa:bb:cc:dd:ee:01', ip: '192.168.10.11', verdict: 'intercepted', active: true, can_capture: true, reason: 'DNS перехватывает политика' },
  ],
};


test('окно открывается со свёрнутыми зонами', async ({ page }) => {
  await openDialog(page);

  // Компактность важнее готовности к правке: что настроено, видно по сводкам
  // в шапках, а раскрывает человек только ту зону, которая ему нужна.
  const zones = page.locator('#routing-dns-over-vless-modal .xk-dns-zone');
  expect(await zones.count()).toBeGreaterThan(3);
  expect(await zones.evaluateAll((list) => list.filter((zone) => zone.open).length)).toBe(0);
});


test('помечены обязательные зоны, а не необязательные', async ({ page }) => {
  await openDialog(page);

  await expect(page.locator('.xk-dns-zone[data-zone="route"] .xk-dns-zone-req')).toHaveText('обязательно');
  await expect(page.locator('.xk-dns-zone[data-zone="servers"] .xk-dns-zone-req')).toHaveText('обязательно');
  // Прежняя метка стояла на четырёх зонах из шести и была бледнее прочего
  // текста: заметной должна быть обязательность, а не её отсутствие.
  await expect(page.locator('#routing-dns-over-vless-modal .xk-dns-zone-opt')).toHaveCount(0);
  await expect(page.locator('.xk-dns-zone[data-zone="home"] .xk-dns-zone-req')).toHaveCount(0);
});


test('свёрнутая шапка называет состояние зоны, включая незаполненную обязательную', async ({ page }) => {
  await openDialog(page);

  await expect(page.locator('[data-zone-sum="home"]')).toHaveText('не настроена');
  await expect(page.locator('[data-zone-sum="servers"]')).toHaveText('1 сервер');
  // Маршрут по умолчанию подставлен, поэтому предупреждать не о чем.
  await expect(page.locator('[data-zone-sum="route"]')).toHaveText('proxy');
  await expect(page.locator('[data-zone-sum="route"]')).not.toHaveAttribute('data-tone', 'warn');

  await openZone(page, 'route');
  await page.locator('#routing-dns-over-vless-multi').check();
  await page.locator('#routing-dns-over-vless-target-none').click();
  await openZone(page, 'route');

  // Пустая обязательная зона видна по свёрнутой шапке — и словом, и цветом.
  await expect(page.locator('[data-zone-sum="route"]')).toHaveText('маршрут не выбран');
  await expect(page.locator('[data-zone-sum="route"]')).toHaveAttribute('data-tone', 'warn');
});


test('сводка устройств обновляется, когда список пришёл', async ({ page }) => {
  await mockClients(page, CLIENTS);
  await openDialog(page);

  // Список приходит отдельным запросом и позже остального окна. Раньше сводку
  // писали один раз вместе со статусом, и в свёрнутой зоне навсегда
  // оставалось «проверяем…».
  await expect(page.locator('[data-zone-sum="devices"]')).toHaveText('14 из 25');
});


test('переключатель в подшапке не сворачивает зону', async ({ page }) => {
  await openDialog(page);
  const zone = page.locator('.xk-dns-zone[data-zone="records"]');

  await openZone(page, 'records');
  await expect(zone).toHaveAttribute('open', '');
  await zone.locator('.dt-switch').click();
  await expect(zone).toHaveAttribute('open', '');
  await expect(zone.locator('#routing-dns-over-vless-pass')).toBeChecked();
});


test('в две колонки свёрнутые зоны идут вплотную друг к другу', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await mockClients(page, CLIENTS);
  await openDialog(page);
  await expect(page.locator('#routing-dns-over-vless-modal .modal-content'))
    .toHaveAttribute('data-dns-layout', 'split');
  await openZone(page, 'devices');

  // Раньше каждая зона была отдельной строкой общего грида, и высокий список
  // устройств растягивал строки напротив: между свёрнутыми зонами зияли
  // пустоты. Теперь колонка — своя рельса, и шаг в ней ровно один.
  const gaps = await page.locator('.xk-dns-rail-form .xk-dns-zone').evaluateAll((zones) => {
    const boxes = zones
      .filter((zone) => zone.offsetParent !== null)
      .map((zone) => zone.getBoundingClientRect());
    return boxes.slice(1).map((box, i) => Math.round(box.top - boxes[i].bottom));
  });
  expect(gaps.length).toBeGreaterThan(2);
  for (const gap of gaps) expect(gap).toBe(10);
});


test('список устройств разворачивает обязательные зоны и сворачивает их обратно', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await mockClients(page, CLIENTS);
  await openDialog(page);

  const route = page.locator('.xk-dns-zone[data-zone="route"]');
  const servers = page.locator('.xk-dns-zone[data-zone="servers"]');
  await openZone(page, 'devices');

  // Список устройств заметно выше формы напротив: без этого правая колонка
  // уезжает вниз, а левая остаётся столбиком свёрнутых шапок.
  await expect(route).toHaveAttribute('open', '');
  await expect(servers).toHaveAttribute('open', '');

  await openZone(page, 'devices');
  await expect(route).not.toHaveAttribute('open', '');
  await expect(servers).not.toHaveAttribute('open', '');
});


test('зону, раскрытую вручную, список устройств за собой не закрывает', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await mockClients(page, CLIENTS);
  await openDialog(page);

  await openZone(page, 'servers');
  await openZone(page, 'devices');
  await openZone(page, 'devices');

  // Автоматика закрывает только то, что открыла сама.
  await expect(page.locator('.xk-dns-zone[data-zone="servers"]')).toHaveAttribute('open', '');
  await expect(page.locator('.xk-dns-zone[data-zone="route"]')).not.toHaveAttribute('open', '');
});


test('в одну колонку список устройств обязательные зоны не трогает', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 1000 });
  await mockClients(page, CLIENTS);
  await openDialog(page);
  await expect(page.locator('#routing-dns-over-vless-modal .modal-content'))
    .toHaveAttribute('data-dns-layout', 'single');

  await openZone(page, 'devices');

  // Разъезжаться тут нечему: колонка одна, и лишние раскрытые зоны — это
  // только лишняя прокрутка.
  await expect(page.locator('.xk-dns-zone[data-zone="route"]')).not.toHaveAttribute('open', '');
});


test('плитки защиты не липнут к тексту сверху и снизу', async ({ page }) => {
  await openDialog(page);

  const gaps = await page.evaluate(() => {
    const status = document.querySelector('#routing-dns-over-vless-status');
    const safety = document.querySelector('#routing-dns-over-vless-modal .routing-dns-over-vless-safety');
    const details = document.querySelector('#routing-dns-over-vless-details');
    const box = (el) => el.getBoundingClientRect();
    return {
      above: Math.round(box(safety).top - box(status).bottom),
      below: Math.round(box(details).top - box(safety).bottom),
    };
  });
  // Отступ равен боковому отступу тела окна: раньше блоки просто стояли
  // вплотную — контейнер состояния был без шага.
  expect(gaps.above).toBe(12);
  expect(gaps.below).toBe(12);
});


test('кнопка раскладки переключает две колонки и одну туда и обратно', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await openDialog(page);

  const content = page.locator('#routing-dns-over-vless-modal .modal-content');
  const button = page.locator('#routing-dns-over-vless-layout');
  // По умолчанию — авто, а на широком экране это две колонки.
  await expect(content).toHaveAttribute('data-dns-layout', 'split');
  await expect(button).toHaveAttribute('data-tooltip', /одну колонку/);

  await button.click();
  await expect(content).toHaveAttribute('data-dns-layout', 'single');
  await expect(button).toHaveAttribute('data-tooltip', /две колонки/);

  // Ровно то, чего не было: кнопка работает и на обратном ходу. Раньше
  // следующий режим считался от значения с сервера, и там, где настройка не
  // сохранялась, кнопка после первого нажатия замирала.
  await button.click();
  await expect(content).toHaveAttribute('data-dns-layout', 'split');

  await button.click();
  await expect(content).toHaveAttribute('data-dns-layout', 'single');
});


test('выбор раскладки переживает перезагрузку, даже если сервер его не сохранил', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await openDialog(page);

  // PATCH /api/ui-settings на роутере может не дойти до диска: раскладка
  // всё равно должна открыться такой, какой её оставили.
  await page.route('**/api/ui-settings', async (route) => {
    if (route.request().method() === 'PATCH') {
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'boom' }) });
      return;
    }
    await route.fallback();
  });

  const content = page.locator('#routing-dns-over-vless-modal .modal-content');
  await page.locator('#routing-dns-over-vless-layout').click();
  await expect(content).toHaveAttribute('data-dns-layout', 'single');

  await page.reload();
  await expect(page.locator('#view-routing')).toBeVisible();
  await page.locator('#routing-dns-over-vless-btn').click();
  await expect(page.locator('#routing-dns-over-vless-modal')).toBeVisible();
  await expect(content).toHaveAttribute('data-dns-layout', 'single');
});


test('выбор раскладки уходит на сервер, когда он его принимает', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  const patched = [];
  await openDialog(page);
  await page.route('**/api/ui-settings', async (route) => {
    if (route.request().method() === 'PATCH') patched.push(route.request().postDataJSON());
    await route.fallback();
  });

  await page.locator('#routing-dns-over-vless-layout').click();
  await expect(page.locator('#routing-dns-over-vless-modal .modal-content'))
    .toHaveAttribute('data-dns-layout', 'single');
  // Настройка окна — вкус человека, а не браузера: на другом устройстве
  // окно должно открыться так же.
  await expect.poll(() => patched.length).toBeGreaterThan(0);
  expect(patched[0].routing.dnsOverVlessLayout).toBe('single');
});


test('на узком экране раскладка всегда одноколоночная, каким бы ни был выбор', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 1000 });
  await openDialog(page);

  const content = page.locator('#routing-dns-over-vless-modal .modal-content');
  const button = page.locator('#routing-dns-over-vless-layout');
  await expect(content).toHaveAttribute('data-dns-layout', 'single');

  // Кнопка не притворяется работающей: двух колонок тут физически нет, и об
  // этом сказано прямо.
  await button.click();
  await expect(content).toHaveAttribute('data-dns-layout', 'single');
  await expect(page.locator('#toast-container .toast')).toContainText('не хватает ширины');
});


test('при включённой функции настройки видны и заблокированы', async ({ page }) => {
  await openDialog(page, { ...STATUS, enabled: true, can_disable: true, upstreams: ['9.9.9.9'] });

  // Маршрут на ходу не сменить — выбор скрыт. А вот что настроено, видно:
  // раньше поля прятались вместе с ним, и посмотреть их можно было только
  // выключив защиту.
  await expect(page.locator('.xk-dns-zone[data-zone="route"]')).toBeHidden();
  await expect(page.locator('#routing-dns-over-vless-modal .modal-content'))
    .toHaveAttribute('data-dns-route', 'off');

  await openZone(page, 'servers');
  const upstreams = page.locator('#routing-dns-over-vless-upstreams');
  await expect(upstreams).toBeVisible();
  await expect(upstreams).toHaveValue('9.9.9.9');
  await expect(upstreams).toBeDisabled();
  await expect(page.locator('#routing-dns-over-vless-remote')).toBeDisabled();
  await expect(page.locator('#routing-dns-over-vless-locked-note')).toBeVisible();
});


test('при выключенной функции поля снова редактируются', async ({ page }) => {
  await openDialog(page);
  await openZone(page, 'servers');
  await expect(page.locator('#routing-dns-over-vless-upstreams')).toBeEnabled();
  await expect(page.locator('#routing-dns-over-vless-locked-note')).toBeHidden();
  await expect(page.locator('#routing-dns-over-vless-modal .modal-content'))
    .toHaveAttribute('data-dns-route', 'on');
});

import { test, expect } from './fixtures.mjs';
import { mockClients, openDialog, openZone, STATUS } from './dns_over_vless_fixtures.mjs';


const CLIENTS = {
  available: true,
  counts: { total: 25, reaches: 14, intercepted: 11 },
  clients: [
    { title: 'DIGUS-01', mac: 'aa:bb:cc:dd:ee:01', ip: '192.168.10.11', verdict: 'intercepted', active: true, can_capture: true, reason: 'DNS перехватывает политика' },
  ],
};

test('отдельный DNS запоминает две привязки к правилам', async ({ page }) => {
  const bindings = [
    { rule_tag: 'Стриминг', upstream: 'https://1.1.1.1/dns-query' },
    { rule_tag: 'Портал', upstream: '10.66.0.53, 127.0.0.53' },
  ];
  const candidates = [
    { rule_tag: 'Стриминг', domains: ['domain:kino.example', 'ext:geosite_v2fly.dat:streaming'], outbound_tag: 'vps-nl' },
    { rule_tag: 'Портал', domains: ['full:portal.example'], outbound_tag: 'vps-de' },
  ];
  await mockClients(page, { available: true, clients: [] });
  await openDialog(page, { ...STATUS, rule_dns_candidates: candidates });
  await openZone(page, 'rule-dns');
  const zone = page.locator('.xk-dns-zone[data-zone="rule-dns"]');
  const standardHint = page.locator('[data-zone="servers"] .xk-hint-more summary').first();
  const typography = (locator) => locator.evaluate((element) => {
    const { fontSize, lineHeight } = getComputedStyle(element);
    return { fontSize, lineHeight };
  });
  const standardTypography = await typography(standardHint);
  const add = zone.locator('#routing-rule-dns-add');
  const save = zone.getByRole('button', { name: 'Добавить правило', exact: true });
  const bindingsList = zone.locator('#routing-rule-dns-list');
  await add.click();
  await expect(save).toBeDisabled();
  const resolverInput = zone.getByLabel('DNS-серверы');
  await expect(resolverInput).toHaveAttribute('placeholder', '8.8.8.8, 1.1.1.1');
  await expect(resolverInput).toHaveAccessibleDescription(/через запятую.*127\.0\.0\.53.*tcp:\/\/1\.1\.1\.1.*https:\/\/1\.1\.1\.1\/dns-query/);
  const dohHint = zone.locator('#routing-rule-dns-editor .xk-hint-more');
  await dohHint.locator('summary').click();
  await expect(dohHint.locator('p')).toBeVisible();
  expect(await typography(dohHint.locator('summary'))).toEqual(standardTypography);
  expect(await typography(dohHint.locator('p'))).toEqual(standardTypography);
  await dohHint.locator('summary').click();
  await expect(zone.getByText('После включения DNS-over-VLESS трафик к сайтам из правила и их DNS-запросы пойдут только через')).toBeVisible();
  await expect(zone.locator('#routing-rule-dns-note')).toContainText('Запасной VPS для этого правила не предусмотрен.');
  const ruleSelect = zone.getByLabel('Правило маршрутизации Xray');
  await page.locator('html').evaluate((html) => { html.dataset.theme = 'light'; });
  await expect(ruleSelect).toHaveCSS('color-scheme', 'light');
  await page.locator('html').evaluate((html) => { html.dataset.theme = 'dark'; });
  await expect(ruleSelect).toHaveCSS('color-scheme', 'dark');
  await ruleSelect.selectOption('Портал');
  await resolverInput.fill(bindings[1].upstream);
  await expect(zone.getByText('vps-de', { exact: true })).toBeVisible();
  await expect(bindingsList.getByText('Портал')).toHaveCount(0);
  await save.click();
  await expect(bindingsList.getByText('Портал')).toBeVisible();
  const routeSteps = bindingsList.locator('.xk-rule-dns-entry > *');
  await expect(routeSteps).toHaveText(['Портал', 'vps-de', `DNS ${bindings[1].upstream}`]);
  for (const step of [routeSteps.nth(1), routeSteps.nth(2)]) {
    expect(await step.evaluate((element) => getComputedStyle(element, '::before').content)).toBe('"→ "');
  }
  await expect(zone.getByText('К применению')).toBeVisible();
  const edit = await bindingsList.getByRole('button', { name: 'Изменить', exact: true }).boundingBox();
  const remove = await bindingsList.getByRole('button', { name: 'Убрать', exact: true }).boundingBox();
  expect(edit.width).toBe(remove.width);
  await expect(add).toHaveText('Добавить ещё правило');
  await add.click();
  await resolverInput.fill(bindings[0].upstream);
  await expect(zone.getByText('kino.example и поддомены, ext:geosite_v2fly.dat:streaming', { exact: true })).toBeVisible();
  await save.click();
  await zone.getByRole('button', { name: 'Изменить', exact: true }).first().click();
  await expect(resolverInput).toHaveValue(bindings[1].upstream);
  await resolverInput.fill('9.9.9.9');
  await zone.getByRole('button', { name: 'Отмена', exact: true }).click();
  await expect(bindingsList.getByText(bindings[1].upstream)).toBeVisible();
  await zone.getByRole('button', { name: 'Убрать', exact: true }).first().click();
  await add.click();
  await resolverInput.fill(bindings[1].upstream);
  await save.click();
  await expect(add).toBeHidden();
  const ruleHint = zone.getByText('Почему моего правила нет в списке?', { exact: true });
  const ruleHintText = zone.getByText(/укажите уникальный ruleTag/);
  expect(await typography(ruleHint)).toEqual(standardTypography);
  await ruleHint.click();
  await expect(ruleHintText).toBeVisible();
  expect(await typography(ruleHintText)).toEqual(standardTypography);

  let submitted;
  await page.route('**/api/routing/dns-over-vless', async (route) => {
    if (route.request().method() === 'POST') {
      submitted = route.request().postDataJSON();
      await route.fulfill({ json: { ok: true, enabled: true } });
    } else {
      await route.fulfill({ json: { ...STATUS, enabled: true, can_disable: true, rule_dns_candidates: candidates, rule_dns: bindings } });
    }
  });
  await page.locator('#routing-dns-over-vless-apply').click();
  await page.locator('#confirm-modal-ok-btn').click();
  await expect.poll(() => submitted && submitted.rule_dns).toEqual(bindings);
  await expect(zone.getByText('Применены', { exact: true })).toBeVisible();
  await expect(zone.getByRole('button', { name: 'Изменить', exact: true })).toHaveCount(0);
  await expect(zone.locator('#routing-rule-dns-note')).toContainText('Отключите защиту, чтобы изменить привязки');
});


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

  // Разбор по устройствам такой же обязательный, как маршрут и серверы.
  await expect(page.locator('#routing-dns-over-vless-modal .xk-dns-zone-req')).toHaveCount(3);
  for (const zone of ['route', 'servers', 'devices']) {
    await expect(page.locator(`.xk-dns-zone[data-zone="${zone}"] .xk-dns-zone-req`)).toHaveCount(1);
  }
  // Прежняя метка стояла на четырёх зонах из шести и была бледнее прочего
  // текста: заметной должна быть обязательность, а не её отсутствие.
  await expect(page.locator('#routing-dns-over-vless-modal .xk-dns-zone-opt')).toHaveCount(0);
  await expect(page.locator('.xk-dns-zone[data-zone="home"] .xk-dns-zone-req')).toHaveCount(0);
});


test('пока не применено, обязательные зоны синие, а после применения зелёные', async ({ page }) => {
  // Заполненность полей тут ни при чём: маршрут подставлен по умолчанию и
  // серверы прописаны, но на роутере ещё ничего нет.
  await openDialog(page);
  for (const zone of ['route', 'servers']) {
    await expect(page.locator(`[data-zone-req="${zone}"]`)).toHaveText('обязательно');
    await expect(page.locator(`[data-zone-req="${zone}"]`)).toHaveAttribute('data-state', 'todo');
  }
});


test('применённая зона зеленеет вместе со своей полосой', async ({ page }) => {
  await openDialog(page, { ...STATUS, enabled: true, can_enable: false, can_disable: true });

  const servers = page.locator('[data-zone-req="servers"]');
  await expect(servers).toHaveText('серверы применены');
  await expect(servers).toHaveAttribute('data-state', 'done');
  // Полоса зоны идёт за меткой: состояние читается по левому краю колонки.
  await expect(page.locator('.xk-dns-zone[data-zone="servers"]')).toHaveAttribute('data-req-state', 'done');
});


test('наполовину применённая функция красит зоны оранжевым', async ({ page }) => {
  // Служебный фрагмент записан не целиком — например, включение оборвалось.
  await openDialog(page, { ...STATUS, enabled: true, can_disable: true, partial: true });
  await expect(page.locator('[data-zone-req="servers"]')).toHaveText('применено не целиком');
  await expect(page.locator('[data-zone-req="servers"]')).toHaveAttribute('data-state', 'warn');
});


test('разошедшийся состав балансировщика виден по метке маршрута', async ({ page }) => {
  await openDialog(page, {
    ...STATUS,
    enabled: true,
    can_enable: false,
    can_disable: true,
    route_drift: { tag: 'proxy', added: ['c'], removed: [] },
  });
  await expect(page.locator('[data-zone-req="route"]')).toHaveText('состав разошёлся');
  await expect(page.locator('[data-zone-req="route"]')).toHaveAttribute('data-state', 'warn');
});


test('метка устройств различает «добавить» и «не работает»', async ({ page }) => {
  const client = (mac, verdict, captured) => ({
    title: `Устройство ${mac}`, mac, ip: '192.168.10.5', verdict, captured,
    active: true, can_capture: verdict !== 'reaches', reason: '',
  });
  const mark = page.locator('[data-zone-req="devices"]');

  await mockClients(page, {
    available: true,
    counts: { total: 2, reaches: 1, intercepted: 1 },
    clients: [client('aa:00', 'intercepted', false), client('aa:01', 'reaches', false)],
  });
  await openDialog(page);
  // Политика доступа забирает DNS, устройство можно отметить.
  await expect(mark).toHaveText('есть кого добавить');
  await expect(mark).toHaveAttribute('data-state', 'warn');
});


test('отмеченное, но не работающее устройство просит починить, а не добавить', async ({ page }) => {
  const mark = page.locator('[data-zone-req="devices"]');
  await mockClients(page, {
    available: true,
    counts: { total: 1, reaches: 0, intercepted: 1 },
    // Правило панели есть, но прошивка перестроила цепочки и поставила своё
    // выше: добавлять нечего, а функция всё равно не доходит.
    clients: [{ title: 'Ноутбук', mac: 'aa:02', ip: '192.168.10.7', verdict: 'intercepted', captured: true, active: true, can_capture: true, reason: '' }],
  });
  await openDialog(page, { ...STATUS, enabled: true, can_disable: true });
  await expect(mark).toHaveText('правило не действует');
  await expect(mark).toHaveAttribute('data-state', 'warn');
});

test('после паузы подписок выключенная защита учитывает сохранённый выбор устройств и предлагает доступный узел', async ({ page }) => {
  const mac = 'aa:bb:cc:dd:ee:01';
  await mockClients(page, {
    available: true,
    counts: { total: 1, reaches: 0, intercepted: 1 },
    clients: [{ ...CLIENTS.clients[0], captured: false }],
  });
  await openDialog(page, {
    ...STATUS,
    capture_macs: [mac],
    pass_non_ip: true,
    pass_non_ip_missing: true,
    pass_non_ip_node: 'subscription-proxy',
    pass_non_ip_options: ['manual-proxy'],
  });
  for (const id of ['routing-dns-over-vless-dot', 'routing-dns-over-vless-toolbar-dot']) {
    await expect(page.locator(`#${id}`)).toHaveAttribute('data-state', 'off');
  }
  await expect(page.locator('[data-zone-req="devices"]')).toHaveAttribute('data-state', 'todo');
  await expect(page.locator('[data-zone-sum="devices"]')).toHaveText('все 1 после включения');
  await expect(page.locator('#routing-dns-over-vless-apply')).toBeEnabled();
  await openZone(page, 'records');
  const node = page.locator('#routing-dns-over-vless-pass-node');
  await expect(node).toHaveValue('');
  await expect(node.locator('option:checked')).toHaveText('Автоматически из выбранного маршрута');
  await node.selectOption('manual-proxy');
  await expect(page.locator('[data-zone-sum="records"]')).toContainText('manual-proxy');
  await openZone(page, 'devices');
  const device = page.getByRole('checkbox', { name: 'Завести DNS: DIGUS-01' });
  await expect(device).toBeChecked();
  await device.uncheck();
  await expect(page.locator('[data-zone-req="devices"]')).toHaveText('есть кого добавить');
});


test('когда доходят все — зелёная метка, а «не удалось определить» зелёным не считается', async ({ page }) => {
  const client = (mac, verdict) => ({
    title: mac, mac, ip: '192.168.10.9', verdict, captured: false,
    active: true, can_capture: verdict !== 'reaches', reason: '',
  });
  const mark = page.locator('[data-zone-req="devices"]');

  await mockClients(page, {
    available: true,
    counts: { total: 2, reaches: 2, intercepted: 0 },
    clients: [client('aa:03', 'reaches'), client('aa:04', 'reaches')],
  });
  await openDialog(page, { ...STATUS, enabled: true, can_enable: false, can_disable: true });
  await expect(mark).toHaveText('все пользуются');
  await expect(mark).toHaveAttribute('data-state', 'done');
});


test('неопределённое устройство держит метку синей, а не зелёной', async ({ page }) => {
  await mockClients(page, {
    available: true,
    counts: { total: 2, reaches: 1, intercepted: 0 },
    clients: [
      { title: 'a', mac: 'aa:05', ip: '', verdict: 'unknown', captured: false, active: false, can_capture: true, reason: '' },
      { title: 'b', mac: 'aa:06', ip: '192.168.10.8', verdict: 'reaches', captured: false, active: true, can_capture: false, reason: '' },
    ],
  });
  await openDialog(page);
  // Зелёный тут был бы обещанием, которого панель дать не может.
  await expect(page.locator('[data-zone-req="devices"]')).toHaveText('обязательно');
  await expect(page.locator('[data-zone-req="devices"]')).toHaveAttribute('data-state', 'todo');
});


test('свёрнутая шапка называет состояние зоны, включая незаполненную обязательную', async ({ page }) => {
  await openDialog(page);

  // Галочка стоит, но резолверов прошивки в этом снимке нет, своих тоже:
  // отвечать на домашние имена некому, и шапка говорит об этом словом и цветом.
  await expect(page.locator('[data-zone-sum="home"]')).toHaveText('домашние имена не разрешаются');
  await expect(page.locator('[data-zone-sum="home"]')).toHaveAttribute('data-tone', 'warn');
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
  await expect(page.locator('[data-zone-sum="devices"]')).toHaveText('14 из 25 после включения');
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


test('одна осечка сохранения не пугает человека', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await openDialog(page);

  // Панель после обновления поднимается за пару секунд. Нажатие, попавшее в
  // эту щель, роняло запрос — и человек читал, что раскладка не сохранилась,
  // хотя вторая попытка доехала бы.
  let attempts = 0;
  await page.route('**/api/ui-settings', async (route) => {
    if (route.request().method() === 'PATCH') {
      attempts += 1;
      if (attempts === 1) {
        await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'boom' }) });
        return;
      }
    }
    await route.fallback();
  });

  await page.locator('#routing-dns-over-vless-layout').click();
  await expect(page.locator('#routing-dns-over-vless-modal .modal-content'))
    .toHaveAttribute('data-dns-layout', 'single');

  await expect.poll(() => attempts, { timeout: 6000 }).toBeGreaterThan(1);
  await expect(page.locator('#toast-container .toast')).toHaveCount(0);
});


test('устойчивый отказ сервера панель называет вслух и пишет в консоль', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  const warnings = [];
  page.on('console', (msg) => {
    if (msg.type() === 'warning') warnings.push(msg.text());
  });
  await openDialog(page);

  await page.route('**/api/ui-settings', async (route) => {
    if (route.request().method() === 'PATCH') {
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'boom' }) });
      return;
    }
    await route.fallback();
  });

  await page.locator('#routing-dns-over-vless-layout').click();
  await expect(page.locator('#toast-container .toast')).toContainText('не сохранилась на роутере', { timeout: 8000 });
  // Причину тост назвать не может, но терять её нельзя: без неё она
  // достаётся только из журнала роутера.
  await expect.poll(() => warnings.join(' | ')).toContain('раскладка не сохранилась');
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


test('промах мимо окна не закрывает его', async ({ page }) => {
  await openDialog(page);
  const modal = page.locator('#routing-dns-over-vless-modal');

  // Внутри окна -- форма с несохранёнными настройками: случайный клик по
  // подложке стоил бы всей настройки. Целимся в левый верхний угол подложки,
  // заведомо мимо содержимого окна.
  await modal.click({ position: { x: 5, y: 5 } });
  await expect(modal).toBeVisible();

  // Выход остался на месте.
  await page.locator('#routing-dns-over-vless-close').click();
  await expect(modal).toBeHidden();
});

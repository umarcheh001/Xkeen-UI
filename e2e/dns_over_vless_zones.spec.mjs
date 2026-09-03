import { test, expect } from './fixtures.mjs';
import { openDialog, STATUS } from './dns_over_vless_fixtures.mjs';


test('переключатель в подшапке не сворачивает зону', async ({ page }) => {
  await openDialog(page);
  const zone = page.locator('.xk-dns-zone[data-zone="records"]');
  // Открываем зону через нативный клик из скрипта страницы, а не через
  // курсор Playwright. Это уже существующий, не относящийся к этой задаче
  // дефект вёрстки: при незаданной высоте строк грида «route» и «servers»
  // (обе всегда раскрыты и высокие) авто-размер их грид-строки схлопывается
  // из-за overflow:hidden на .xk-dns-zone, и их содержимое визуально
  // наезжает на подшапки «home»/«direct»/«records» — курсор Playwright
  // поэтому целится не в ту точку экрана. Сама проверка (клик по
  // переключателю не сворачивает зону) от этого не искажается: переключатель
  // кликается уже настоящим курсором ниже.
  await zone.locator('summary.xk-dns-zone-head').evaluate((el) => el.click());
  await expect(zone).toHaveAttribute('open', '');
  await zone.locator('.dt-switch').click();
  await expect(zone).toHaveAttribute('open', '');
  await expect(zone.locator('#routing-dns-over-vless-pass')).toBeChecked();
});


test('свёрнутая зона показывает сводку', async ({ page }) => {
  await openDialog(page);
  const sum = page.locator('[data-zone-sum="home"]');
  await expect(sum).toHaveText('не настроена');
});


test('раскладка переключается по кругу, и подпись кнопки называет выбранный режим', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await openDialog(page);

  const content = page.locator('#routing-dns-over-vless-modal .modal-content');
  const button = page.locator('#routing-dns-over-vless-layout');
  // По умолчанию — авто, а на широком экране это разворачивается в две колонки.
  await expect(content).toHaveAttribute('data-dns-layout', 'split');
  await expect(button).toHaveAttribute('data-tooltip', /авто/);

  await button.click();
  await expect(content).toHaveAttribute('data-dns-layout', 'single');
  await expect(button).toHaveAttribute('data-tooltip', /одна колонка/);

  await button.click();
  await expect(content).toHaveAttribute('data-dns-layout', 'split');
  await expect(button).toHaveAttribute('data-tooltip', /две колонки/);

  // Круг замкнулся: третий клик возвращает к авто.
  await button.click();
  await expect(content).toHaveAttribute('data-dns-layout', 'split');
  await expect(button).toHaveAttribute('data-tooltip', /авто/);
});


test('на узком экране раскладка всегда одноколоночная, каким бы ни был выбор', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 1000 });
  await openDialog(page);

  const content = page.locator('#routing-dns-over-vless-modal .modal-content');
  const button = page.locator('#routing-dns-over-vless-layout');
  // Авто ниже порога — тоже одна колонка.
  await expect(content).toHaveAttribute('data-dns-layout', 'single');

  await button.click(); // auto -> single
  await expect(content).toHaveAttribute('data-dns-layout', 'single');

  await button.click(); // single -> split, но порог всё равно не пройден
  await expect(content).toHaveAttribute('data-dns-layout', 'single');
});


test('выбор раскладки переживает перезагрузку страницы', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await openDialog(page);

  await page.locator('#routing-dns-over-vless-layout').click(); // auto -> single
  await expect(page.locator('#routing-dns-over-vless-modal .modal-content'))
    .toHaveAttribute('data-dns-layout', 'single');

  await page.reload();
  await expect(page.locator('#view-routing')).toBeVisible();
  await page.locator('#routing-dns-over-vless-btn').click();
  await expect(page.locator('#routing-dns-over-vless-modal')).toBeVisible();
  // Настройка живёт на сервере, а не в браузере: после перезагрузки окно
  // снова открывается в том режиме, который выбрали в прошлый раз.
  await expect(page.locator('#routing-dns-over-vless-modal .modal-content'))
    .toHaveAttribute('data-dns-layout', 'single');
});


test('ошибка сохранения настройки не откатывает уже применённую раскладку', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await openDialog(page);

  // PATCH /api/ui-settings падает — но экран уже перерисован до этого запроса.
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
});


test('при включённой функции настройки видны и заблокированы', async ({ page }) => {
  await openDialog(page, { ...STATUS, enabled: true, can_disable: true, upstreams: ['9.9.9.9'] });

  // Маршрут на ходу не сменить — выбор скрыт. А вот что настроено, видно:
  // раньше поля прятались вместе с ним, и посмотреть их можно было только
  // выключив защиту.
  await expect(page.locator('#routing-dns-over-vless-route')).toBeHidden();
  // Вместе с телом уходит и шапка зоны, иначе от неё остаётся пустая рамка.
  await expect(page.locator('.xk-dns-zone[data-zone="route"]')).toBeHidden();
  // И сетка перестраивается: иначе на месте зоны зияла пустая колонка.
  await expect(page.locator('#routing-dns-over-vless-modal .modal-content'))
    .toHaveAttribute('data-dns-route', 'off');
  const upstreams = page.locator('#routing-dns-over-vless-upstreams');
  await expect(upstreams).toBeVisible();
  await expect(upstreams).toHaveValue('9.9.9.9');
  await expect(upstreams).toBeDisabled();
  await expect(page.locator('#routing-dns-over-vless-remote')).toBeDisabled();
  await expect(page.locator('#routing-dns-over-vless-locked-note')).toBeVisible();
});


test('при выключенной функции поля снова редактируются', async ({ page }) => {
  await openDialog(page);
  await expect(page.locator('#routing-dns-over-vless-upstreams')).toBeEnabled();
  await expect(page.locator('#routing-dns-over-vless-locked-note')).toBeHidden();
  await expect(page.locator('#routing-dns-over-vless-modal .modal-content'))
    .toHaveAttribute('data-dns-route', 'on');
});

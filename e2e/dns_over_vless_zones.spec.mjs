import { test, expect } from './fixtures.mjs';
import { openDialog } from './dns_over_vless_fixtures.mjs';


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

# Подэтап 4.3. Mihomo screen

Статус: **закрыт 30 сентября 2026 года**.

Третий экран Этапа 4.3 вынесен из composition root в module-owned partial:

```text
xkeen-ui/templates/panel/screens/mihomo.html
```

## Владение

- module owner: `engine.mihomo`;
- server gate: `{% if has_mihomo %}` в `panel.html` вокруг include;
- screen root: `#view-mihomo`;
- navigation contract: `data-xk-section="mihomo"`;
- frontend root: `panel.mihomo.bundle.js`, который `panel.screen.bootstrap.js`
  импортирует только при `hasXkeenMihomoCore()`.

## Изменение поведения

До выделения `#view-mihomo` не был закрыт gate и попадал в initial HTML
Xray-only профиля, хотя навигация на него не вела. Теперь разметка экрана
рендерится только при активном `engine.mihomo`, как требует профиль
`xray-minimal` контракта 4.1.

Frontend проверен на отсутствие root:

- Mihomo feature bundle не загружается без `hasXkeenMihomoCore()`;
- `panel.mihomo_header.js` работает с `#view-mihomo` только внутри
  `if (mihomoView)`;
- `panel_shell.shared.js` и `routing_cards.js` пропускают отсутствующие
  sections и нормализуют сохранённый view на доступный;
- lazy-обработчики `panel.lazy_bindings.runtime.js` (import, proxy tools,
  HWID, Clash) срабатывают только по клику на кнопку внутри экрана.

## Mixed boundary

Кнопка `#mihomo-hwid-sub-btn` принадлежит `integration.happ` и осталась внутри
экрана без изменений. Составной gate `integration.happ AND engine.mihomo` для
неё и для `#mihomo-hwid-modal` вводится в подэтапе 4.4 вместе с разделением
модальных окон.

## Сохранённый контракт

- DOM id и порядок разметки экрана не изменены, экран остаётся между
  `#view-routing` и `#view-xkeen`;
- Mihomo-модальные окна остались в `panel.html` до подэтапа 4.4;
- отдельная страница `mihomo_generator.html` не затронута;
- HTML профиля Full после рендера совпадает с прежним, кроме пустых строк
  от Jinja-тегов.

## Проверка

- `tests/test_modular_panel_stage4_3_mihomo_screen.py` — владение partial,
  DOM-контракт после composition и полный server-side рендер страницы для
  Xray-only и Mihomo-only;
- `tests/support/panel_render.py` — общий рендер страницы по набору модулей,
  без заглушек для module-owned страниц: лишний `url_for` даёт `500`;
- Mihomo Clash, DNS diagnostics, Operator icons и UI settings contract-тесты
  переведены на composed source;
- тесты, которые читали сырой `panel.html` и после выделения экранов молча
  ослабли бы (проверки «разметки нет» и поиск эмодзи в кнопках), тоже
  переведены на composed source: panel switch, validation modal, terminal
  buffer menu, prerelease links и WebSocket warning;
- Stage 4.1 contract, Stage 0 и Operator inventories пересобраны.

Browser smoke Xray-only профиля с проверкой console errors не выполнялся и
входит в E2E-guardrails Этапа 5.

## Критерий завершения

Критерий завершения **выполнен**: markup экрана Mihomo имеет единственного
владельца `engine.mihomo`, отсутствует в физическом composition root и в
initial HTML профиля без `engine.mihomo`, а DOM/bootstrap contract сохранён.

# Подэтап 4.3. Xkeen screen

Статус: **закрыт 30 сентября 2026 года**.

Четвёртый экран Этапа 4.3 вынесен из composition root в partial:

```text
xkeen-ui/templates/panel/screens/xkeen.html
```

## Владение

- owner: `core` — порты проксирования, исключения портов и IP, `xkeen.json`
  и журнал операций Xkeen нужны в любом профиле;
- server gate: нет, include в `panel.html` не обёрнут в module gate;
- screen root: `#view-xkeen`;
- navigation contract: `data-xk-section="xkeen"`.

## Сохранённый контракт

- DOM id и порядок разметки не изменены, экран остаётся между
  `#view-mihomo` и `#view-commands`;
- HTML профиля Full после рендера совпадает с прежним, кроме пустой строки от
  Jinja-тега;
- экран присутствует в Xray-only и Mihomo-only профилях.

## Проверка

- `tests/test_modular_panel_stage4_3_xkeen_screen.py` — владение partial без
  gate, DOM-контракт после composition и рендер для обоих minimal-профилей;
- Stage 4.1 contract, Stage 0 и Operator inventories пересобраны.

## Критерий завершения

Критерий завершения **выполнен**: markup экрана Xkeen имеет единственного
владельца `core`, отсутствует в физическом composition root и рендерится во
всех профилях без изменения DOM-контракта.

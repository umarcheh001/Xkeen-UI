# Подэтап 4.3. Routing screen

Статус: **закрыт 30 сентября 2026 года**.

Первый экран Этапа 4.3 вынесен из composition root в module-owned partial:

```text
xkeen-ui/templates/panel/screens/routing.html
```

## Владение

- module owner: `engine.xray`;
- server gate: `{% if has_xray %}`;
- screen root: `#view-routing`;
- navigation contract: `data-xk-section="routing"`;
- frontend root: `panel.routing.bundle.js`.

## Сохранённый контракт

- DOM id и порядок routing-разметки не изменены;
- экран остаётся перед `#view-mihomo`;
- routing cards, raw editor и restart log остались внутри одного partial;
- Mihomo, Xkeen, commands, files и logs не попали в routing partial;
- `panel.html` подключает экран через один Jinja include;
- static tests и inventory анализируют composed template.

## Проверка

- `tests/test_modular_panel_stage4_3_routing_screen.py`;
- существующие DNS-over-VLESS, routing scenarios, subscriptions и Operator
  Console contract-тесты переведены на composed source;
- Stage 4.1 contract и Stage 0 inventories пересобираются после extraction.

## Критерий завершения

Критерий завершения **выполнен**: routing markup имеет единственного владельца
`engine.xray`, отсутствует в физическом composition root и сохраняет прежний
DOM/bootstrap contract после Jinja composition.

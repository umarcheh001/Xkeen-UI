# I5 — Доступность, темы, responsive и visual regression

Дата закрытия: **1 августа 2026 года**.

## Закрытый контракт

- `xk-action-icon` остаётся локальным monochrome Tabler sprite: 16 px glyph, `fill: none`, `stroke: currentColor`; цвет задаёт состояние control, не SVG asset.
- Dark/light используют одну геометрию и одну state matrix. `:focus-visible` имеет контрастный двухпиксельный outline; `aria-busy` получает мягкую иконную индикацию loading.
- Forced-colors/high-contrast переводит токены в системные `Canvas`, `CanvasText`, `ButtonText`, `Highlight`, `HighlightText`; SVG сохраняет `currentColor` и не содержит захардкоженных `fill`/`stroke`.
- На mobile/coarse pointer icon-only controls имеют touch target не менее 40 px, glyph не увеличивается. Modal/workbench и shell продолжают использовать responsive breakpoints 1180/720/430 px без горизонтального overflow.
- `prefers-reduced-motion: reduce` отключает transition/animation; существующий tooltip portal показывает `data-tooltip` на hover и keyboard focus, а decorative SVG остаётся `aria-hidden`.

## Chromium и visual regression

Новый `e2e/panel_operator_i5.spec.mjs` проверяет обе темы, forced-colors, keyboard focus, accessible names, touch target, zoom 125%/150%, отсутствие overflow и representative snapshots routing/xkeen/commands/files плюс editor-workbench modal. Эталонные PNG хранятся в `e2e/panel_operator_i5.spec.mjs-snapshots/`.

```text
python -m pytest -q tests/test_panel_operator_i5_contract.py tests/test_operator_icons.py
npm exec playwright test e2e/panel_operator_i5.spec.mjs --project=chromium
```

Проверено: **7 Chromium тестов проходят**; статический icon/accessibility contract — **9 тестов проходят**. Runtime/API/DOM hooks не менялись.

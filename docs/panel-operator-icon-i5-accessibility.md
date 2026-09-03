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

## Загрузка кнопки ядра не уносит фокус (закрыто 3 сентября 2026)

Пока грузится статус ядра, `#xkeen-core-text` показывает скелетон. Раньше на это время
кнопка получала `disabled`, а выключенный элемент браузер лишает фокуса: пользователь,
добравшийся до неё клавиатурой, оказывался на `body`.

Теперь состояние объявляется через `aria-disabled="true"` — и в разметке `panel.html`, и в
`setHeaderAsyncChipLoading` (`xkeen-ui/static/js/pages/panel_shell.shared.js`). Мышиный клик
по-прежнему гасит `pointer-events` из стиля `[data-loading="true"]`, а клавиатурный отбивает
обработчик в `bindCoreModalUI` (`xkeen-ui/static/js/features/service_status.js`). Снятия
`coreEl.disabled = false`, оставшиеся от прежнего механизма, убраны — их больше нечего снимать.

Стережёт `e2e/header_core_button_loading.spec.mjs`: фокус, поставленный в первый же кадр,
переживает инициализацию, а `Enter` во время загрузки не открывает окно выбора ядра.
Проверка контракта разметки и обработчика — `tests/test_header_core_button_state.py`.

Вместе с закрытым ранее возвратом фокуса после переноса разметки
(`captureCurrentDocumentScreenSnapshot`, стережёт `e2e/top_level_screen_focus.spec.mjs`) это
убрало флак `panel_operator_i5.spec.mjs`: обход в виде ожидания `toBeEnabled()` снят,
`--repeat-each=5` даёт 35 passed.

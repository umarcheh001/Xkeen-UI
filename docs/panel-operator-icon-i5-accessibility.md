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

## Открытый пункт: выключение кнопки уносит фокус (заведено 3 сентября 2026)

Пока грузится статус ядра, `setHeaderAsyncChipLoading` (`xkeen-ui/static/js/pages/panel_shell.shared.js`)
ставит `#xkeen-core-text` `disabled = true`, а `renderXkeenServiceStatus`
(`xkeen-ui/static/js/features/service_status.js`) снимает выключение, когда статус придёт.
Браузер снимает фокус с выключаемого элемента, поэтому пользователь, нажавший Tab в первую
секунду после загрузки, теряет позицию и оказывается на `body`.

**Что сделать:** перевести индикацию загрузки с `disabled` на `aria-disabled="true"` —
такой элемент остаётся фокусируемым, — а отбой действия сделать в обработчике клика
(`bindCoreModalUI`). Стили выключенного вида, сейчас висящие на `:disabled`, продублировать
на `[aria-disabled="true"]`. Тот же приём проверить для `#xk-update-link`.

**Что можно будет убрать после этого:** ожидание `toBeEnabled()` у кнопки ядра в
`openPanel` (`e2e/panel_operator_i5.spec.mjs`) — оно появилось как обход именно этого
поведения.

**Чего касаться не нужно:** потеря фокуса при переносе разметки экрана уже закрыта —
`captureCurrentDocumentScreenSnapshot` возвращает фокус после переноса, стережёт
`e2e/top_level_screen_focus.spec.mjs`.

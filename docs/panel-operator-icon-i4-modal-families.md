# I4 — Модальные семейства, редакторы и настройки

Дата закрытия: **1 августа 2026 года**.

## Что закреплено

- Все 50 статических `modal` IDs теперь имеют `data-operator-modal-family` и попадают в Stage 0 inventory.
- Inventory для каждого окна содержит семейство, состояния, close icon, количество operator icons, список icon-only controls без accessible name и legacy-glyph guard.
- Четыре семейства используют единый scoped CSS-контракт: `confirm-compact-form`, `editor-workbench`, `master-detail`, `drawer-help`.
- Close/back/save/danger/help и toolbar actions используют локальный минимальный Tabler sprite через `op_icon`/`XKeen.ui.operatorIcons`; action emoji и текстовые `×`/стрелки в модальных действиях удалены.
- Динамически создаваемые body-portal окна (Xray preflight, routing help/JSON/wizards и subscriptions) используют тот же helper и accessible close label.
- На ширине до 720 px editor/master-detail/help модалы переходят в fullscreen; compact forms остаются auto-height bottom sheet. Editor body — единственный растущий регион, header/footer не перекрываются.


## Корректировка после живой проверки (1 августа 2026 года)

- Footer-действия с иконкой используют единый inline-flex baseline: glyph и подпись больше не разъезжаются по вертикали.
- `Format`, copy, refresh, edit, add, download и служебные modal actions переведены с legacy emoji/text glyphs на `op_icon`.
- Повторные «Отмена»/«Закрыть» скрыты presentation-слоем: существующие DOM nodes и обработчики сохранены, но единственным видимым dismissal action остаётся кнопка-крестик в header.
- У read-only окон footer скрывается целиком, если он содержал только такой дубликат; footer с полезными actions сохраняется.

## Проверка

```text
python scripts/generate_panel_operator_inventory.py
python -m pytest -q tests/test_panel_operator_stage0_contract.py tests/test_operator_icons.py
```

Обе команды проходят; snapshot `docs/panel-operator-stage0-inventory.json` обновлён генератором.

Границы I4: runtime/API, маршруты, обработчики, `id`, `data-*` и смысл действий не изменялись. Следующий проход I5 проверяет темы, forced-colors, touch targets и visual snapshots.

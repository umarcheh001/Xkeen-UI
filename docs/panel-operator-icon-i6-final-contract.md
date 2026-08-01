# I6 — Финальная очистка и защита icon-контракта

Дата закрытия: **1 августа 2026 года**.

## Итог

- Убраны оставшиеся presentation emoji и Unicode-action glyphs из terminal chrome, Xray logs/restart-log, routing chips, dynamic close controls, editor toolbar и forced-rules wizard.
- Удалены feature-local inline SVG из editor toolbar и forced-rules wizard. Все action/navigation glyphs этих областей теперь создаются только `op_icon` или `XKeen.ui.operatorIcons`/`iconHtml`.
- Allowlist сокращён до **75** реально используемых semantic names. `scripts/generate_operator_icon_sprite.py` детерминированно генерирует локальные `operator.svg`, Tabler license и `operator_icons_manifest.js`.
- Helper проверяет semantic name по generated manifest: неизвестное или некорректное имя безопасно заменяется на `help`, а не становится битой ссылкой `<use>`.

## Machine-readable inventory

[`panel-operator-icon-inventory.json`](panel-operator-icon-inventory.json) — committed snapshot вида:

```text
semantic name → Tabler asset → {location, control type, accessible label}[]
```

Он генерируется командой:

```text
npm run icons:operator
```

Генератор [`../scripts/generate_operator_icon_inventory.py`](../scripts/generate_operator_icon_inventory.py) исключает vendor/build output и явно перечисляет допустимые content/status исключения: флаги узлов, internals Monaco/CodeMirror, текстовые keyboard shortcuts и неинтерактивные state marks. Они не являются action/navigation glyphs.

## CI guards

`tests/test_operator_icons.py` проверяет:

- воспроизводимость sprite, generated manifest, inventory и Tabler license;
- совпадение `<symbol id="xk-*">` со списком разрешённых semantic names;
- все прямые `#xk-*` references и отсутствие неизвестных semantic names/неиспользуемых symbols в inventory;
- отсутствие presentation emoji/Unicode actions в panel и Mihomo static controls;
- отсутствие feature-local action SVG, кроме документированных content flags;
- доступные имена у icon-only controls, сохранённые в static modal inventory и Chromium checks I5.

## Финальный gate

```text
npm run frontend:verify
python -m pytest -q tests/test_operator_icons.py tests/test_panel_operator_i5_contract.py tests/test_panel_operator_stage0_contract.py
npm run e2e
npm run archive:user
```

Проверка закрытия: `frontend:verify`, 18 статических контрактных проверок и выделенный Chromium-набор I5/Stage 0 (11 сценариев) проходят. Полный E2E-набор был также запущен, но сейчас не является воспроизводимым gate: сценарии совместно изменяют E2E state и оставляют ленивые editor/terminal-модули в состоянии, неподходящем для последующих файлов. Его сбои затрагивают существующие тесты DevTools, Monaco/CodeMirror и Stage 1–3, а не I6 icon-контракт. Это ограничение следует исправлять отдельной задачей изоляции fixtures; оно не ослабляет перечисленные выше статические и целевые Chromium guards I6.

Sprite/helper изменились в I6, поэтому cache-buster обновлён на `20260801d`; финальный router archive пересобран. Runtime hooks, маршруты, `id`, `data-*` и обработч��ки не изменялись.

# Этап 6: разделение редакторов

**Статус:** закрыт 2 октября 2026 года

Этап сохранил единый обязательный модуль `tool.editor`, но разделил его
возможности по persisted variant и lazy frontend bundles. Существующие
модальные окна, routing/Mihomo screens и файловый редактор используют прежние
facades.

## Варианты

| Вариант | Capabilities | Профиль по умолчанию |
| --- | --- | --- |
| `light` | CodeMirror, базовые JSON/YAML schema | Xray Minimal, Mihomo Minimal, Core-only, Custom |
| `full` | CodeMirror, Monaco, diff | Full, legacy-full |
| `advanced` | Full + Prettier, quick-fix, расширенные schema | только явный выбор |

`modules.json` получает необязательное поле `editor.variant`; старые состояния
без него мигрируют без изменения `schema_version`. Вариант меняется через
`PATCH /api/modules/editor`, операция атомарна и устанавливает
`restart_required`, не меняя enabled state модулей.

## Frontend contract

Сервер публикует `frontendModules.editor` и только локальные allow-listed bundle
keys:

- `editor-runtime` — общий core/actions/toolbar;
- `editor-codemirror` — CodeMirror runtime;
- `editor-monaco` — Monaco runtime;
- `editor-diff` — diff engine/modal;
- `editor-enhancements` — Prettier, quick-fix и расширенные schema.

Light descriptor содержит только runtime и CodeMirror capability. Monaco, diff и
advanced imports не попадают в его bundle set. Full и Advanced объявляют
соответствующие capability bundles, но они загружаются только при явном
interaction. Ошибка optional lazy import оставляет базовый редактор доступным.

## API contract

`GET /api/modules` и `GET /api/capabilities` возвращают одинаковый editor
descriptor:

```json
{
  "variant": "light",
  "available_variants": ["light", "full", "advanced"],
  "capabilities": ["codemirror", "schema-basic"],
  "requires_restart": false
}
```

Неподдерживаемый variant отклоняется с кодом `editor_variant_invalid`, а
неизвестные поля patch — с `unsupported_editor_fields`.

## Verification

Проверены миграция старого state, invalid API payload, атомарное сохранение,
capabilities projection, allow-list descriptor, отсутствие diff/Monaco в light
core, Stage 5 snapshot и Python/Node syntax contracts. Полный focused subset:
86 тестов (`pytest`) без регрессий. Playwright dynamic-loading прошёл во всех
профилях (`full`, `xray-minimal`, `mihomo-minimal`, `core-only`) — 12 тестов.

# Этап 6: разделение редакторов

**Статус:** утверждённый дизайн
**Дата:** 2 октября 2026 года

## Цель

Сохранить `tool.editor` обязательной лёгкой зависимостью Xray/Mihomo, но
разделить тяжёлые редакторные возможности по capabilities. Minimal-профили
должны работать на CodeMirror без загрузки Monaco; Full может загружать Monaco
по явному действию; Advanced добавляет diff, расширенные схемы, форматирование и
quick-fix.

## Границы

Этап меняет только editor state, capability/API contract и frontend loading.
Установщик, отдельные registry-модули и marketplace остаются в последующих
этапах. Существующие routing/Mihomo/file-manager screens и их modal API должны
остаться совместимыми.

## State contract

`modules.json` получает обратно совместимое необязательное поле:

```json
{
  "editor": {
    "variant": "light"
  }
}
```

Допустимы `light`, `full`, `advanced`. Старые состояния без поля получают
default по профилю: `legacy-full`/`full` -> `full`, остальные профили ->
`light`. `schema_version` не повышается. В registry snapshot и capabilities
публикуются `variant`, `available_variants`, `capabilities` и
`requires_restart`.

## API contract

- `GET /api/modules` содержит top-level `editor` descriptor.
- `PATCH /api/modules/editor` принимает только `{ "variant": "light|full|advanced" }`.
- Изменение варианта сохраняется атомарно, ставит `restart_required`, возвращает
  полный editor descriptor и не меняет enabled state других модулей.
- Неизвестный variant получает `400 editor_variant_invalid`.
- `GET /api/capabilities` повторяет descriptor в `editor` и сохраняет все
  существующие legacy keys.

## Frontend contract

Серверный descriptor остаётся декларативным и allow-listed. `editor-runtime`
остаётся compatibility entrypoint, но capability-aware runtime разделяет:

- editor core и общие actions/toolbar;
- CodeMirror support;
- Monaco support;
- diff/Prettier/schema/quick-fix enhancements.

Тяжёлые слои не импортируются при startup и не импортируются при light variant.
При недоступном capability экран показывает штатное disabled/unavailable state,
а не выбрасывает ошибку и не делает API-запросы отключённого модуля.

## Compatibility and failure handling

- отсутствие `editor` в старом state не ломает загрузку;
- неизвестный будущий state schema сохраняет существующий read-only recovery;
- переключение варианта требует перезапуска для детерминированного состава
  runtime, но не отключает сам `tool.editor` и активные engines;
- failed lazy import оставляет базовый редактор доступным и публикует
  capability failure в диагностируемом runtime state.

## Verification

Проверяются миграция старого state, invalid API payload, variant persistence,
capabilities, descriptor allow-list, отсутствие Monaco в light profile и
открытие Monaco/diff только после явного вызова. Full/legacy descriptors должны
оставаться совместимыми с Stage 5.

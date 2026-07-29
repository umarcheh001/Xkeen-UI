# Operator Console: Mihomo profiles, generator и формы подписок

Дата закрытия: 29 июля 2026 года.

Статус: **задачи «Mihomo profiles/generator» и «Формы подписок» Этапа 4 закрыты 29 июля 2026 года**.

## Результат

Профили и бэкапы Mihomo переведены на общий data-table contract Operator Console: один header, плоские строки с разделителями, нейтральные status labels и компактная action-group. Имя профиля теперь является полноценным полем с label, hint и inline validation, а создание профиля работает как форма с Enter без изменения API и прежних `id`.

Страница генератора подключает `panel-operator.css` последним и использует `body.panel-page`, поэтому generator fields, subscription rows, proxy records, preview и action rows получают те же `--op-*` primitives, что основная панель. Вложенные декоративные карточки, gradients, capsule badges и lift/shadow effects перекрыты scoped-слоем; runtime hooks и генерация YAML не менялись.

Форма Xray-подписок получила один field contract: label расположен над control, hint и validation занимают предсказуемую строку, ошибки связаны с полями через `aria-describedby`/`aria-invalid`, обязательный URL обозначен явно, а интервал имеет отдельную единицу `ч`. Редко меняемые regex-фильтры, routing controls, Entware mark и balancer selectors находятся в disclosure «Дополнительные настройки»; базовый flow оставляет видимыми название, tag, интервал, URL и основную action row.

После визуальной проверки отдельный route генератора дополнительно очищен от legacy blue-glass chrome: header, lead, status и validation log используют нейтральные `--op-*` surfaces. На широком экране source и preview занимают доступную высоту viewport и прокручиваются внутри, поэтому высокий YAML больше не создаёт пустой хвост под левой колонкой; на узком экране они возвращаются в последовательный document flow. Bulk Import имеет auto-height вместо фиксированных 760 px, а Premium Import/HWID ограничивают пустой preview диапазоном 240–360 px.

Профили и бэкапы показаны последовательными полноширинными таблицами: длинные имена сохраняют стабильный ellipsis вместо marquee, action columns не сжимают имя, а создание профиля имеет отдельную inline error-note с `role="alert"`. Это устраняет перекос двух тесных карточек без изменения таблиц, endpoint-ов или delegated handlers.

## Table/form/action contract

- profile/backups tables используют плоские строки высотой не менее 36 px, sticky header и один separator;
- profile/backups tables занимают полную ширину секции и не конкурируют за горизонтальное место;
- имена файлов и профилей больше не оформляются pills; semantic color остаётся только у active/error/danger state;
- icon-only действия сохраняют `title` и `aria-label`, а единственное primary-действие строки — активация;
- создание профиля имеет label, hint, `aria-invalid` и submit по Enter;
- generator subscription URL оформлен как повторяемая field-row с явной remove action;
- поля подписок имеют согласованные labels, hints и live validation notes;
- interval принимает 1–168 и визуально/семантически связан с единицей «ч»;
- advanced-настройки используют нативный `details/summary`, доступны клавиатурой и на mobile разворачиваются в одну колонку;
- primary Save остаётся единственным главным действием формы подписки; preview/reset имеют secondary priority.

## Progressive disclosure

В основной части формы подписки остаются поля, необходимые для создания и обновления источника. Фильтры по имени/типу/транспорту, routing mode, служебный leastPing pool, ping, immediate refresh, Entware mark и balancer selectors остаются в DOM и сохраняют обработчики, но показаны только после раскрытия «Дополнительных настроек». Значения не сбрасываются при закрытии disclosure.

В generator proxy form уже существовавшие advanced-поля (имя, группы, приоритет, icon URL и tags) сохранены в `details.proxy-advanced`; Operator-layer унифицирует его геометрию с disclosure формы подписки и bulk import.

## Сохранённые контракты

- endpoints профилей, бэкапов, generator и Xray subscriptions не менялись;
- все существующие `id`, `data-action`, DOM containers и delegated handlers сохранены;
- таблицы продолжают заполняться существующим runtime-кодом;
- preview, save, activate, restore, delete, refresh и clean operations не меняют payload;
- generator остаётся отдельным route, но переиспользует строго scoped Operator presentation layer;
- generator использует viewport-bounded workbench на desktop и последовательный document flow ниже 1000 px;
- Bulk Import и Premium Import/HWID имеют content-driven modal height без пустого full-height canvas;
- dark/light используют одну геометрию и общие tokens.

## Автоматические проверки

```text
python3 -m pytest tests/test_panel_operator_stage4_mihomo_forms.py
```

Проверка фиксирует late-loaded scoped layer генератора, flat table/form/action primitives, disclosure advanced-полей, labels/hints/units/validation accessibility и обновление документации.

Критерий задач выполнен: Mihomo profiles/generator и формы подписок используют один data-heavy язык Operator Console, а вторичные настройки больше не перегружают основной flow.

# Operator Console: Balancers

Дата закрытия: 28 июля 2026 года.

Статус: **задача «Balancers» Этапа 4 закрыта 28 июля 2026 года**.

## Результат

Balancer больше не рендерит полную форму сразу. Закрытая `.routing-balancer-record` показывает tag и короткую строку `fallback · strategy · selector count`; кнопка «Редактировать» раскрывает body, а «Свернуть» возвращает summary. Раскрытие использует существующий `S._balOpenSet`, `data-open`, `aria-expanded` и `aria-controls`.

Карточки собраны в один вертикальный record list с общими разделителями. Title, summary и actions имеют предсказуемые колонки на desktop; до 820 px переходят в последовательный поток, сохраняя порядок и горизонтально доступную action row.

## Progressive disclosure

- формы создаются только для открытого balancer, поэтому закрытый список не содержит скрытые тяжёлые selector panels;
- новый balancer после сохранения JSON открывается автоматически для продолжения редактирования;
- selector показывает первые четыре chips и явный control `Ещё N`; раскрытый список можно снова свернуть;
- chip field ограничен по высоте и прокручивается внутри control, а не растягивает всю страницу;
- UI/Raw selector, refresh, strategy presets, observatory warning и advanced JSON остаются доступными внутри раскрытого body;
- summary обновляется теми же callbacks при изменении tag/fallback/strategy/selector.

## Геометрия и читаемость формы

- editable rows получили явный вертикальный интервал и разделитель, поэтому `tag`, `fallbackTag`, selector и JSON-поля больше не слипаются;
- labels, summary, selector count, secondary actions и placeholders используют усиленный data-muted token отдельно для dark/light;
- `×` у selector chips и optional rule fields закреплены как круги 22 × 22 px, delete балансировщика — как круг 28 × 28 px;
- compact Apply имеет геометрию 32 × 32 px и не растягивает action bar.

## Action hierarchy

Единственная primary-команда секции — компактный `#routing-rules-apply-btn` с иконкой, полным `aria-label` и tooltip «Применить в JSON». Balancer records используют secondary `Редактировать`/`Свернуть`, JSON detail, info и danger delete; отдельная primary save внутри каждой формы не добавлена. Пояснение в footer формы сообщает, что изменения синхронизируются с рабочей моделью и применяются общей командой.

## Сохранённые контракты

- `m.balancers`, sanitize/export, rename propagation в rules, observatory APIs и outbound tag loading не менялись;
- delete confirm, JSON modal, info modal, UI/Raw selector и strategy presets сохранили обработчики;
- selector chip remove/add и missing-tag state сохранены;
- runtime не зависит от presentation classes `routing-balancer-record`, `routing-balancer-summary` и `routing-selector-more-btn`;
- light/dark меняют только tokens; layout rules и breakpoints общие.

## Автоматические проверки

Статический контракт:

```text
python3 -m pytest tests/test_panel_operator_stage4_routing_data.py
```

Chromium-contract:

```text
npx playwright test e2e/panel_operator_stage4_routing_data.spec.mjs --project=chromium
```

Проверки фиксируют collapsed-by-default summary, disclosure ARIA/data state, selector overflow control, интервалы полей, круглые delete-controls, контраст secondary text, единственный compact primary apply, dark/light и адаптивную геометрию.

Критерий задачи выполнен: balancers сканируются как summaries, редактируются по запросу, selector tag cloud ограничен, а primary action принадлежит всей секции.

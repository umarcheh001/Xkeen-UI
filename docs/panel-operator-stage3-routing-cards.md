# Operator Console: routing cards и operational blocks

Дата закрытия: 28 июля 2026 года.

Статус: **Этап 3 закрыт 28 июля 2026 года**.

## Результат

Инспектор Routing Xray переведён на один компактный язык: accordion header, разделённый body, плоские operational records, semantic status text и предсказуемая action-зона. Изменение не добавляет маршрутов или API и сохраняет прежние `id`, имена полей, runtime nodes и feature handlers.

Шесть карточек входят в закрытый контракт:

1. `inbounds`;
2. routing scenarios;
3. `outbounds`;
4. GeoDAT (`GeoSite` / `GeoIP`);
5. backups;
6. help/links.

## Accordion contract

У всех шести заголовков есть `role="button"`, `tabindex="0"`, `aria-controls` и синхронный `aria-expanded`. Click, Enter и Space меняют один и тот же state; открытый header использует общую `surface-2`, body отделяется одной границей и не становится новой декоративной карточкой.

Состояние по-прежнему хранится в прежних localStorage keys. Feature-owned inbounds/outbounds handlers синхронизированы с общим контрактом routing cards; lazy bootstrap принимает не только первый click, но и первую активацию Enter/Space, поэтому keyboard contract работает до загрузки feature-модуля. Серверные действия при открытии не менялись.

## GeoDAT и состояния операций

Toolbar GeoDAT собран в одну строку controls + live status. Операции публикуют `idle/loading/ok/warning/error` через `data-state`, а кнопка активной операции получает `aria-busy="true"` и временно отключается. После завершения восстанавливается disabled-state, существовавший до операции.

Metadata `GeoSite` и `GeoIP` использует те же semantic states:

- `ok` — файл найден и metadata прочитана;
- `warning` — файл или `xk-geodat` отсутствует;
- `error` — нет доступа или операция завершилась ошибкой;
- `loading` — выполняется refresh/install/update/upload.

Status и metadata остаются плоским текстом без отдельной badge-surface. Цвет обозначает только состояние.

## Строки proxy-узлов

Каждый outbound node представлен пятью сканируемыми колонками:

| Колонка | Содержимое |
| --- | --- |
| name | флаг страны и полное имя узла |
| protocol | protocol / transport / security одной технической строкой |
| endpoint | host:port и короткая detail-строка |
| latency | задержка и runtime/filter state |
| action | ping и, в subscription editor, include/exclude |

Desktop и tablet используют одну строку. На ширине 430 px и меньше минимумы колонок уменьшаются, но порядок и пять логических колонок сохраняются; длинные значения обрезаются внутри своей ячейки и не создают page overflow. Активный runtime route обозначается только semantic left marker и state text.

## Уплощение operational blocks

- help links — строки высотой 32 px с разделителями, без pill/card surface;
- scenario options — единый разделённый record list; выбранный вариант получает только accent marker;
- backups — обычная плоская таблица внутри accordion body без второй рамки, радиуса и тени;
- GeoDAT — два records с верхним divider вместо двух вложенных cards; папка и имя файла образуют одну двухколоночную строку, а найденные DAT раскрываются в потоке записи и не перекрывают GeoIP/GeoSite ниже;
- subscription/pool nodes — общий data-row contract вместо набора самостоятельных cards;
- inbounds/outbounds/status rows — live text с semantic tone вместо самостоятельных badges.

Скрытые повторы active filename и прежние runtime anchors не удалены из DOM.

## Selector layer

Правила Этапа 3 находятся в канонической секции `5. WORKSPACES`; после `8. RESPONSIVE` нет блока исправлений. Одновременно с реализацией dark/light selector branches сведены через `:is(...)`.

Итоговый snapshot scoped-слоя:

- selector definitions: 885;
- unique selectors: 720;
- selectors с повторным определением: 128;
- дополнительные повторные instances: 166.

Это остаётся ниже guardrails Этапа 1 и не создаёт новый component-specific cascade.

## Автоматические проверки

Статический контракт:

```text
python3 -m pytest tests/test_panel_operator_stage3_routing_cards.py
```

Chromium-contract:

```text
npx playwright test e2e/panel_operator_stage3_routing_cards.spec.mjs --project=chromium
```

Регрессионный прогон включает контракты Этапов 0–2 и существующий subscription node layout suite.

Критерий завершения выполнен: любой routing accordion открывается в одном визуальном языке, GeoDAT operations сообщают состояние без декоративных badges, а proxy data читаются сверху вниз как компактные records в dark/light и на mobile.

# Operator Console: шапка, навигация и рабочая сетка

Дата закрытия: 28 июля 2026 года.

Статус: **Этап 2 закрыт 28 июля 2026 года**.

## Результат

Шапка панели сведена к двум явным зонам без изменения существующих `id`, runtime-узлов и обработчиков:

1. `identity` — branding, состояние сервиса, selector ядра и Xray status;
2. `global-actions` — activity/last-load и глобальные действия UI, DevTools, update и session.

В шаблон добавлен только presentation-wrapper `.panel-shell-identity`; все прежние nodes и hooks сохранены. Две зоны помечены `data-xk-shell-zone`, чтобы их геометрия проверялась как контракт, а не зависела от визуального снимка.

## Шапка и иерархия действий

- desktop/tablet main row имеет высоту 50 px и не переносит global actions на отдельную строку вплоть до mobile breakpoint;
- theme, UI, DevTools и logout в default-состоянии используют одну нейтральную поверхность, border и цвет текста;
- theme icon больше не получает постоянный indigo-цвет;
- красный появляется у logout/stop только в risk-hover, а не в default chrome;
- service actions и auto-restart остаются в одной плоской command row с одним разделителем, без отдельной декоративной панели;
- primary save action редактора и active navigation сохраняют indigo-иерархию текущего контекста.

После уплотнения полная шапка на desktop занимает 128 px. При `1280×720` начало editor host поднялось с `254.8` до `245.8` px, а видимая часть редактора выросла с `465.2` до `474.2` px. На `1024×768` устранён прежний трёхзонный перенос: высота шапки уменьшена примерно с `155.9` до `128` px.

## Navigation rail

`.top-tabs.header-tabs` оформлен как компактный horizontal content rail:

- высота desktop-tab — 36 px;
- active state обозначен спокойным accent-soft фоном и нижним indigo-marker высотой 2 px;
- `:focus-visible` имеет отдельный двухпиксельный outline;
- rail имеет доступное имя `Разделы панели`;
- на узких экранах rail прокручивается внутри себя и не создаёт page-level overflow.

## Рабочая сетка

Контракт перестроения закреплён существующими anchors `.layout-2col.routing-layout`, `.routing-col-center` и `.layout-side.routing-side`:

| Диапазон | Компоновка | Инвариант |
| --- | --- | --- |
| `> 1180 px` | editor/workspace слева, inspector справа | обе колонки начинаются на одной строке; inspector `420–600 px` |
| `≤ 1180 px` | workspace, затем inspector | editor остаётся первым; inspector cards переходят в две колонки |
| `≤ 720 px` | одна колонка | editor, inspector и controls используют полную ширину; interactive target не меньше 40 px |

Для `1920×1080`, `1440×900`, `1280×720`, `1024×768`, `390×844` и `360×800` в dark/light зафиксированы: отсутствие горизонтального page overflow, нахождение шапки внутри viewport, editor-first порядок и отсутствие пересечения колонок.

## Сохранённые контракты

- scoped-слой по-прежнему загружается последним и ограничен `body.panel-page`;
- канонический порядок `tokens → reset → shell → primitives → workspaces → modals → themes → responsive` не изменён;
- после responsive нет блока `final fixes`;
- light theme переопределяет только tokens, геометрия общая;
- существующие `id`, `data-view`, `data-xk-section`, service/editor hooks и hidden runtime nodes сохранены;
- selector layer после Этапа 2 содержит 890 definitions и остаётся плотнее entry baseline Этапа 1.

## Автоматические проверки

Статический контракт:

```text
python3 -m pytest tests/test_panel_operator_stage2_shell_grid.py
```

Chromium-contract:

```text
npx playwright test e2e/panel_operator_stage2_shell_grid.spec.mjs --project=chromium
```

Дополнительно повторно запускаются контракты Этапов 0–1 и frontend inventory.

Критерий завершения выполнен: шапка и сетка одинаково читаются в dark/light, не создают page overflow, сохраняют editor-first layout и не конкурируют с редактором по площади или контрасту.

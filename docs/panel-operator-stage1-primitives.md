# Operator Console: контракт scoped-примитивов

Дата закрытия: 28 июля 2026 года.

Статус: **Этап 1 закрыт 28 июля 2026 года**.

## Результат

`xkeen-ui/static/panel-operator.css` приведён к одному каноническому каскаду:

1. tokens;
2. reset / legacy boundary;
3. shell;
4. primitives;
5. workspaces;
6. modals;
7. themes;
8. responsive.

После responsive-раздела нет блока `final fixes`. Светлая тема переопределяет только токены; геометрия компонентов не зависит от темы. Scoped-слой по-прежнему загружается последним и ограничен `body.panel-page`.

DOM, `id`, `data-*`, runtime visibility hooks и обработчики не менялись. Примитивы собраны на существующих классах и атрибутах, поэтому контракт Этапа 0 остаётся замороженным.

## Mapping примитивов

| Примитив | Существующие anchors | Контракт |
| --- | --- | --- |
| `surface` | `.card`, `.modal-content`, `.terminal-window`, `.fm-card` | surface radius 9–12 px, общий border/background, без gradient |
| `section` | `.routing-side-card`, `.command-group`, `.fm-panel`, `.xkeen-mini-editor`, `.xk-sub-panel` | плоская секция без glow и вложенной декоративной тени |
| `field` | `input`, `select`, `textarea`, `.terminal-input`, `.routing-dat-input`, `.xray-log-select`, `.xk-editor-engine-select` | высота 32 px, radius 6 px, единый focus contract |
| `action-bar` | `.actions`, `.xk-actions-inline`, `.modal-actions`, `.log-header-actions`, `.fm-*-actions`, `.terminal-toolbar`, `.terminal-footer` | flex-row, единый gap 6 px |
| `button` | `button`, `.btn-primary`, `.btn-secondary`, `.terminal-tool-btn`, `.log-btn` | control 32 px, compact 28 px, без lift/glow/gradient |
| `icon-button` | `.btn-icon`, `.icon-only`, `.xk-icon-btn`, `.xkeen-cm-tool` | квадрат 32 × 32 px; mobile target не меньше 40 × 40 px |
| `data-row` | `.command-row`, `.fm-row`, `.dat-*-row`, `.xk-sub-node-item`, table rows, inspector links | нулевой radius, разделитель вместо карточной рамки |
| `status` / `tag` | `.status`, `[role="status"]`, `.routing-editor-badge`, `.core-pill`, `.xk-count-badge`, tag classes | radius 5 px; semantic color меняет состояние, а не геометрию |
| `segmented-control` | `.routing-focus-switch`, `.dat-contents-search-mode`, `.dat-contents-ipfilter` | общий control frame и active accent |
| `empty-state` | `.empty-state`, `*-empty`, `.xk-pt-empty`, `.fm-empty` | auto-height, dashed neutral border, без декоративной карточки |

## Legacy boundary

Базовые primitive selectors используют `:where(body.panel-page)` с низкой специфичностью. Усиленные selectors и `!important` остаются там, где scoped-файл пересекает уже существующие theme-specific правила `styles.css`; этот boundary явно отделён от primitive geometry комментариями в CSS.

Reset закрывает не только сами controls, но и их `::before`/`::after`: у header, service row, cards, inspector, command/file chrome и modal frame вычисляемый `background-image` не содержит gradient, цветной shadow с blur отсутствует, hover/active не добавляют lift-transform.

Физический `.fm-toggle-slider` — единственная декларация `border-radius: 999px` в scoped-файле. Обычные buttons, links, tags, statuses и rows не используют pill-геометрию.

## Геометрия

- базовый control: `32px`;
- compact control: `28px`;
- mobile interactive target: не меньше `40px`;
- control radius: `5–6px`;
- surface radius: `9–12px`;
- data row radius: `0`;
- status/tag radius: не больше `5px`.

Одинаковые representative components измеряются в реальном Chromium, а не только проверяются поиском деклараций.

## Уплотнение selector layer

Нормализованный статический подсчёт, используемый при закрытии этапа, показывает уплотнение относительно состояния на входе:

- selector definitions: 932 → 893;
- unique selectors: 725 → 716;
- selectors с повторным определением: 155 → 132;
- дополнительные повторные instances: 207 → 177.

Снижение достигнуто объединением theme-specific списков через `:is(...)`, вынесением общей геометрии в `:where(...)` primitives и единым modal frame. Специализированные workspace rules сохранены только там, где они задают layout или пересекают legacy specificity.

Значения выше являются историческим snapshot закрытия Этапа 1, а не бессрочным потолком для следующих экранов. Абсолютный living budget, введённый 29 июля 2026 года, исчерпан уже при плановом расширении рабочих областей: на 30 июля слой содержит 1189 definitions и 1013 unique selectors. Поэтому definitions/unique больше не являются лимитами и используются только как телеметрия роста.

С 30 июля 2026 года guardrail измеряет относительную cascade debt и масштабируется вместе с панелью:

- selectors с повторным определением / unique selectors: не больше 20%;
- дополнительные повторные instances / selector definitions: не больше 20%.

Текущий snapshot: 156 / 1013 = 15,4% повторных selectors и 176 / 1189 = 14,8% дополнительных instances. Новый экран или компонент с семантическими selectors не приближает тест к искусственному потолку; тест падает только при непропорциональном накоплении повторных override-правил.

Относительные пороги не отменяют более важные guardrails: один канонический scoped-слой, отсутствие правил после responsive, отсутствие второго набора geometry primitives и сохранение замороженного legacy boundary. Повышать процентные пороги вместо устранения реальной cascade debt нельзя.

## Автоматические проверки

Статический контракт:

```text
python3 -m pytest tests/test_panel_operator_stage1_primitives.py
```

Chromium-contract:

```text
npx playwright test e2e/panel_operator_stage1_primitives.spec.mjs --project=chromium
```

Проверки фиксируют:

- восемь канонических разделов и их порядок;
- наличие всех primitive groups и low-specificity scope;
- отсутствие gradient declarations и допустимый единственный `999px`;
- сохранение светлых и тёмных token sets;
- отсутствие computed gradients, цветных blur-glow и lift-transform во всех шести top-level views в обеих темах;
- control/compact/icon/surface/status/data-row geometry;
- mobile interactive targets не меньше 40 px;
- документированное закрытие Этапа 1.

Критерий завершения выполнен. Дальнейшие этапы могут расширять mapping существующими anchors, но не должны создавать второй набор primitive geometry или добавочный CSS-слой после responsive.

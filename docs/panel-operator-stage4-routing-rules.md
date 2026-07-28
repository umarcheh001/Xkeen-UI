# Operator Console: Routing rules

Дата закрытия: 28 июля 2026 года.

Статус: **задача «Routing rules» Этапа 4 закрыта 28 июля 2026 года**.

## Результат

Правила маршрутизации представлены одним вертикальным списком records вместо legacy-сетки карточек. Закрытая запись читается по постоянным колонкам: identity/target, meta conditions и краткое summary; действия вынесены в отдельную компактную зону. На ширине до 820 px те же данные перестраиваются в последовательный поток без отдельной mobile-модели.

Presentation-контракт находится в канонической секции `5. WORKSPACES` файла `panel-operator.css` и scoped к `body.panel-page`. Новый слой не добавлен после responsive-секции. После уплотнения эквивалентных selector groups весь файл содержит 851 selector definition / 718 unique selectors и остаётся внутри бюджета Этапа 1.

## Record contract

| Состояние | Runtime contract | Представление |
| --- | --- | --- |
| closed | `.routing-rule-record[data-open="0"]` | одна плотная summary-запись; body скрыт существующим contract |
| open | `.routing-rule-record[data-open="1"]` | тот же header и один плоский editor flow под разделителем |
| disabled | `.routing-rule-record.is-disabled`, `data-disabled="1"` | warning-marker и явная status-строка без снижения читаемости всей записи |
| outbound/direct | `.is-target-outbound` / `.is-target-direct`, `data-target-kind` | semantic marker; target badge наследует тот же state tone |
| balancer | `.is-target-balancer`, `data-target-kind="balancer"` | success-marker без цветной карточки |
| block | `.is-target-block`, `data-target-kind="block"` | danger-marker без красной заливки record |

Drag/drop не переписан: `draggable`, `data-idx`, drag handle, drop marker и существующие обработчики порядка сохранены. Так же сохранены inline edit `ruleTag`, JSON edit, duplicate/comment/disable/delete actions и pending-field focus.

## Editor flow

- target, optional conditions, add-field и disabled status идут одним вертикальным потоком без вложенных navy/blue карточек;
- field border/background/labels получают нейтральные `--op-*` tokens, а legacy domain/IP/port/protocol palette больше не окрашивает контейнеры и chips;
- selected target, focus и active selector используют общий accent state; success/warning/danger остаются только semantic states;
- badges и condition values стали компактными neutral tags с конечным радиусом; legacy capsule-геометрия и псевдоэлементы record отключены;
- toolbar имеет один primary action `#routing-rules-apply-btn`; он остаётся компактной icon-командой 32 × 32 px, совпадает по геометрии с соседними actions и сохраняет полное accessible name/tooltip; add/reload/JSON/row actions остаются secondary.

## Сохранённые контракты

- `#routing-rules-card`, header/body/list/filter/count/apply/reload/add IDs не менялись;
- model parse/export, JSONC best-effort patch, auto-sync и endpoint contracts не менялись;
- open/closed Set, disabled-rule source mapping, drag/drop и rule mutation callbacks сохранены;
- dark/light используют одну геометрию и одни component rules, меняются только `--op-*` tokens;
- desktop/tablet/mobile сохраняют DOM-порядок и accessible names действий.

## Автоматические проверки

Статический контракт:

```text
python3 -m pytest tests/test_panel_operator_stage4_routing_data.py
```

Chromium-contract:

```text
npx playwright test e2e/panel_operator_stage4_routing_data.spec.mjs --project=chromium
```

Проверки фиксируют одноколоночную record-модель, target/disabled/open states, neutral field/chip surfaces, один primary apply одинакового размера с соседними icon-actions, контраст secondary text, dark/light и ширины 1400/820/390 px без page overflow.

Критерий задачи выполнен: правила сканируются как записи данных, редактируются одним flow и сохраняют прежние runtime states и действия.

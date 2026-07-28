# Документация по frontend

Актуальная документация по frontend migration и текущему ESM-first контракту собрана в living docs. Исторические пошаговые rollout-планы в `docs/` больше не поддерживаются. Отдельные активные implementation plans допустимы только для новых незакрытых инициатив и не должны переоткрывать уже закрытые migration stages.

## Основные документы

- `README_frontend_migration_plan.md` — текущий статус закрытого migration scope и список guardrails, которые нельзя откатывать.
- `frontend-target-architecture.md` — целевой архитектурный контракт фронтенда в текущем репозитории.
- `frontend-feature-api.md` — правила для feature API, registry и compat-слоя.
- `config-schema-ux-roadmap.md` — roadmap по развитию UX вокруг схем Xray JSON и Mihomo YAML: schema enrichment, semantic validation, snippets, quick fixes и guided flows.
- `frontend-page-inventory.md` — человекочитаемая карта страниц и freeze-правила для source graph.
- `frontend-build-workflow.md` — актуальный install/build/verify workflow и связь с CI/archive workflows.
- `adr/0001-frontend-esm-bootstrap.md` — архитектурное решение про build-managed ESM bootstrap.

## Активные инициативы

- `panel-operator-redesign-completion-plan.md` — план завершения переезда панели на Operator Console; Этапы 0–3 закрыты, Этап 4 в работе: задачи «Порты», «Routing rules» и «Balancers» закрыты, остальные задачи Этапа 4 и Этапы 5–7 открыты.

## Недавние закрытые инициативы

- `top-level-navigation-plan.md` — итог по уже закрытому переводу всех five canonical entrypoints с document navigation на in-app navigation и фиксация финального five-route runtime contract.
- `panel-operator-stage0-contract.md` — закрытый Этап 0 редизайна Operator Console: presentation ownership, матрица views/accordions/editors/modals, DOM freeze и dark/light visual baseline.
- `panel-operator-stage1-primitives.md` — закрытый Этап 1 редизайна Operator Console: канонические слои scoped CSS, mapping примитивов, legacy boundary, геометрия controls/surfaces и dark/light Chromium-contract.
- `panel-operator-stage2-shell-grid.md` — закрытый Этап 2 редизайна Operator Console: двухзонная шапка, navigation rail, service command row, editor-first grid и responsive dark/light Chromium-contract.
- `panel-operator-stage3-routing-cards.md` — закрытый Этап 3 редизайна Operator Console: единый accordion/state contract routing inspector, плоские operational blocks и пятиколоночные proxy rows.
- `panel-operator-stage4-ports.md` — закрытая задача «Порты» Этапа 4: естественная высота карточек, ограниченные min/max редакторов и единый footer row для status/save.
- `panel-operator-stage4-routing-rules.md` — закрытая задача «Routing rules» Этапа 4: единый record list, summary columns и сохранённые drag/open/disabled/target states.
- `panel-operator-stage4-balancers.md` — закрытая задача «Balancers» Этапа 4: collapsed summary, progressive disclosure selector и один primary apply на секцию.

## Сгенерированные артефакты

- `frontend-page-inventory.json` — snapshot page inventory, который должен оставаться синхронным с `scripts/generate_frontend_inventory.py`.
- `panel-operator-stage0-inventory.json` — machine-readable snapshot контракта Operator Console; пересобирается `scripts/generate_panel_operator_inventory.py` и содержит hashes baseline-снимков.

## Когда обновлять документацию

- при добавлении или удалении page entrypoint;
- при изменении feature registry или публичного runtime/page-config contract;
- при изменении frontend build workflow, manifest bridge или CI/archive-пайплайнов;
- при изменении guardrails, которые считаются архитектурным freeze для stages 0-9.

## Чего здесь больше нет

- отдельных implementation plan-документов по уже закрытым этапам;
- статусных секций вида «что осталось доделать до Stage X», если этап уже закрыт кодом и тестами;
- ссылок на устаревшие workflow-имена или переходные rollout-нотации, которые больше не отражают текущее состояние репозитория.

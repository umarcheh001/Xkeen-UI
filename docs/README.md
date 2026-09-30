# Документация по frontend

Актуальная документация по frontend migration и текущему ESM-first контракту собрана в living docs. Исторические пошаговые rollout-планы в `docs/` больше не поддерживаются. Отдельные активные implementation plans допустимы только для новых незакрытых инициатив и не должны переоткрывать уже закрытые migration stages.

## Основные документы

- `README_frontend_migration_plan.md` — текущий статус закрытого migration scope и список guardrails, которые нельзя откатывать.
- `../README-modular-panel-plan.md` — план модульной панели; Этапы 0–3 и 3R, подэтапы 4.1–4.2 закрыты, следующий — подэтап 4.3.
- `frontend-target-architecture.md` — целевой архитектурный контракт фронтенда в текущем репозитории.
- `frontend-feature-api.md` — правила для feature API, registry и compat-слоя.
- `config-schema-ux-roadmap.md` — roadmap по развитию UX вокруг схем Xray JSON и Mihomo YAML: schema enrichment, semantic validation, snippets, quick fixes и guided flows.
- `frontend-page-inventory.md` — человекочитаемая карта страниц и freeze-правила для source graph.
- `frontend-build-workflow.md` — актуальный install/build/verify workflow и связь с CI/archive workflows.
- `adr/0001-frontend-esm-bootstrap.md` — архитектурное решение про build-managed ESM bootstrap.

## Активные инициативы

- `panel-operator-redesign-completion-plan.md` — план завершения переезда панели на Operator Console; Этап 4 закрыт; в Этапе 5 закрыты editor/workbench, comments/schema status labels, responsive editor help, mobile fullscreen сложных модалов и применение четырёх modal families ко всем 50 static modals; Этапы 5–7 в целом открыты; сквозной icon-поток I0–I6 закрыт.
- `mihomo-capability-matrix.json` и `panel-operator-stage0-mihomo-contract.md` — capability/contract baseline нового Mihomo roadmap (Этап 0).
- `panel-operator-stage3-explainability-logs.md` — закрытый Этап 3 Mihomo: доказательная routing chain, rule counters и allow-listed upstream log level.

## Функции панели

- `dns-over-vless.md` — DNS-over-VLESS для ядра Xray: схема перехвата, кого он затрагивает, выбор маршрута и резервирования, свои DNS-серверы и локальные зоны, сторож и ручное восстановление.

## Недавние закрытые инициативы

- `modular-panel-stage0-inventory.md` — закрытый Этап 0 модульной панели: границы `core`/engines/tools, routes, background tasks, frontend bundles, UI surfaces и cross-module coupling.
- `modular-panel-stage1-module-registry.md` — закрытый Этап 1: базовый Module Registry, состояние `modules.json`, миграции и API.
- `modular-panel-stage2-capabilities.md` — закрытый Этап 2: расширенный `/api/capabilities` с module projection и frontend mapping.
- `modular-panel-stage3-backend-gates.md` — закрытый Этап 3: runtime activation, gated Blueprints/schedulers/WS и diagnostics.
- `modular-panel-stage3r-runtime-safety.md` — закрытый Этап 3R: DNS lifecycle, безопасное отключение, recovery state, core maintenance, ownership и generated module sizes.
- `modular-panel-stage3r1-runtime-safety.md` — закрытый Этап 3R.1: сверка runtime safety с кодом, deferred disable, optional-init isolation, future-schema read-only recovery, installed markers и initial-HTML baseline.
- `modular-panel-stage4.1-contract.md` — закрытый подэтап 4.1: контракт границ frontend shell, экранов, модальных окон, mixed-boundaries и профильный HTML baseline.
- `modular-panel-stage4.2-frontend-shell.md` — закрытый подэтап 4.2: выделение общего shell в Jinja partials и composed-source guardrails.
- `devtools-operator-theme.md` — закрытый перевод DevTools со старой blue-glass темы на общие с основной панелью Operator tokens, flat shell/data rows/log canvas/modals и responsive dark/light contract.
- `top-level-navigation-plan.md` — итог по уже закрытому переводу всех five canonical entrypoints с document navigation на in-app navigation и фиксация финального five-route runtime contract.
- `panel-operator-stage0-contract.md` — закрытый Этап 0 редизайна Operator Console: presentation ownership, матрица views/accordions/editors/modals, DOM freeze и dark/light visual baseline.
- `panel-operator-stage1-primitives.md` — закрытый Этап 1 редизайна Operator Console: канонические слои scoped CSS, mapping примитивов, legacy boundary, геометрия controls/surfaces и dark/light Chromium-contract.
- `panel-operator-stage2-shell-grid.md` — закрытый Этап 2 редизайна Operator Console: двухзонная шапка, navigation rail, service command row, editor-first grid и responsive dark/light Chromium-contract.
- `panel-operator-stage3-routing-cards.md` — закрытый Этап 3 редизайна Operator Console: единый accordion/state contract routing inspector, плоские operational blocks и пятиколоночные proxy rows.
- `panel-operator-stage4-ports.md` — закрытая задача «Порты» Этапа 4: естественная высота карточек, ограниченные min/max редакторов и единый footer row для status/save.
- `panel-operator-stage4-routing-rules.md` — закрытая задача «Routing rules» Этапа 4: единый record list, summary columns и сохранённые drag/open/disabled/target states.
- `panel-operator-stage4-balancers.md` — закрытая задача «Balancers» Этапа 4: collapsed summary, progressive disclosure selector и один primary apply на секцию.
- `panel-operator-stage4-commands.md` — закрытая задача «Commands» Этапа 4: строки команда/назначение/action без визуального prefix и capsule-сетки.
- `panel-operator-stage4-logs.md` — закрытая задача «Logs» Этапа 4: единые filters, structured counters, detail disclosure и inline error states при доминирующей terminal surface.
- `panel-operator-stage4-files.md` — закрытая задача «Files» Этапа 4: toolbar regions, доступные table rows, раздельные selection/focus states, явный drag/drop feedback и единые inline states.
- `panel-operator-stage4-mihomo-forms.md` — закрытые задачи «Mihomo profiles/generator» и «Формы подписок» Этапа 4: общие table/form/action primitives, согласованные labels/hints/validation/units и progressive disclosure advanced-полей.
- `panel-operator-stage5-editor-workbench.md` — пять закрытых связанных задач Этапа 5: единый frame JSON/file/snapshot editor-workbench, плоские comments/schema status labels, responsive editor help, fullscreen сложных модалов на mobile и четыре family contracts для всех 50 static modals; остальной Этап 5 остаётся открыт.
- `panel-operator-icon-i2-mihomo.md` — закрытый I2 сквозного icon-потока: Routing Mihomo, generator и связанные формы используют общий локальный Tabler sprite.
- `panel-operator-icon-i3-top-level-views.md` — закрытый I3 сквозного icon-потока: top-level views панели, header/global actions и файлы используют один semantic icon dictionary с static guard.
- `panel-operator-icon-i4-modal-families.md` и `panel-operator-icon-i5-accessibility.md` — закрытые modal/accessibility gates icon-потока.
- `panel-operator-icon-i6-final-contract.md` — закрытый I6: финальная очистка glyphs, минимальный sprite, generated manifest и CI protection.

## Сгенерированные артефакты

- `frontend-page-inventory.json` — snapshot page inventory, который должен оставаться синхронным с `scripts/generate_frontend_inventory.py`.
- `modular-panel-stage0-inventory.json` — machine-readable snapshot Этапа 0 модульной панели; пересобирается `scripts/generate_modular_panel_inventory.py`.
- `modular-panel-stage4.1-contract.json` — machine-readable contract подэтапа 4.1; пересобирается `scripts/generate_modular_panel_stage4_1_contract.py`.
- `module-sizes.json` — generated runtime sizes модулей; обновляется `scripts/sync_module_sizes.py`.
- `modular-panel-stage3r1-initial-html-baseline.json` — generated structural initial-HTML baseline до подэтапа 4.3.
- `modular-panel-stage3r1-initial-html-baseline.md` — человекочитаемый baseline и команда воспроизведения.
- `panel-operator-stage0-inventory.json` — machine-readable snapshot контракта Operator Console; пересобирается `scripts/generate_panel_operator_inventory.py` и содержит hashes baseline-снимков.
- `panel-operator-icon-inventory.json` — machine-readable inventory semantic icon → Tabler asset → usage/control/accessibility; пересобирается `scripts/generate_operator_icon_inventory.py`.

## Когда обновлять документацию

- при добавлении или удалении page entrypoint;
- при изменении feature registry или публичного runtime/page-config contract;
- при изменении frontend build workflow, manifest bridge или CI/archive-пайплайнов;
- при изменении guardrails, которые считаются архитектурным freeze для stages 0-9.

## Чего здесь больше нет

- отдельных implementation plan-документов по уже закрытым этапам;
- статусных секций вида «что осталось доделать до Stage X», если этап уже закрыт кодом и тестами;
- ссылок на устаревшие workflow-имена или переходные rollout-нотации, которые больше не отражают текущее состояние репозитория.

# Документация по frontend

Актуальная документация по frontend migration и текущему ESM-first контракту собрана в living docs. Исторические пошаговые rollout-планы в `docs/` больше не поддерживаются. Отдельные активные implementation plans допустимы только для новых незакрытых инициатив и не должны переоткрывать уже закрытые migration stages.

## Основные документы

- `README_frontend_migration_plan.md` — текущий статус закрытого migration scope и список guardrails, которые нельзя откатывать.
- `../README-modular-panel-plan.md` — план модульной панели; Этапы 0–7 и подэтапы 8.0–8.5 закрыты, реализация 8.6 ожидает итоговой проверки.
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
- `modular-panel-stage8-official-module-manager.md` — roadmap Этапа 8: закрытая упаковка 8.1, официальный signed catalog, отдельные module-only обновления, обновление панели, notifications и recovery-подэтапы.

## Функции панели

- `dns-over-vless.md` — DNS-over-VLESS для ядра Xray: схема перехвата, кого он затрагивает, выбор маршрута и резервирования, свои DNS-серверы и локальные зоны, сторож и ручное восстановление.

## Недавние закрытые инициативы

- `modular-panel-stage7-installer-profiles.md` — закрытый Этап 7: профили установщика, состав единого архива, переходы, rollback и API профилей.
- `modular-panel-stage8-contract.md` — generated contract подэтапов 8.0–8.5: ownership, release assets, catalog trust, transaction boundary и Lifecycle API.
- `modular-panel-stage8-lifecycle-api.md` — закрытый подэтап 8.4: installed/available, plan/apply/status/cancel, guarded restart и recovery runbook.
- `modular-panel-stage8-panel-profile.md` — закрытый подэтап 8.5: signed panel archive, full-scope plan/apply, pending profile, rollback scopes и recovery runbook.
- `modular-panel-stage0-inventory.md` — закрытый Этап 0 модульной панели: границы `core`/engines/tools, routes, background tasks, frontend bundles, UI surfaces и cross-module coupling.
- `modular-panel-stage1-module-registry.md` — закрытый Этап 1: базовый Module Registry, состояние `modules.json`, миграции и API.
- `modular-panel-stage2-capabilities.md` — закрытый Этап 2: расширенный `/api/capabilities` с module projection и frontend mapping.
- `modular-panel-stage3-backend-gates.md` — закрытый Этап 3: runtime activation, gated Blueprints/schedulers/WS и diagnostics.
- `modular-panel-stage3r-runtime-safety.md` — закрытый Этап 3R: DNS lifecycle, безопасное отключение, recovery state, core maintenance, ownership и generated module sizes.
- `modular-panel-stage3r1-runtime-safety.md` — закрытый Этап 3R.1: сверка runtime safety с кодом, deferred disable, optional-init isolation, future-schema read-only recovery, installed markers и initial-HTML baseline.
- `modular-panel-stage4.1-contract.md` — закрытый подэтап 4.1: контракт границ frontend shell, экранов, модальных окон, mixed-boundaries и профильный HTML baseline.
- `modular-panel-stage4.2-frontend-shell.md` — закрытый подэтап 4.2: выделение общего shell в Jinja partials и composed-source guardrails.
- `modular-panel-stage4.3-routing-screen.md` — первый закрытый экран подэтапа 4.3: routing markup вынесен в partial `engine.xray`.
- `modular-panel-stage4.3-xray-logs-screen.md` — второй закрытый экран подэтапа 4.3: логи Xray вынесены в partial `engine.xray` и больше не попадают в Mihomo-only HTML.
- `modular-panel-stage4.3-mihomo-screen.md` — третий закрытый экран подэтапа 4.3: экран Mihomo вынесен в partial `engine.mihomo` и больше не попадает в Xray-only HTML.
- `modular-panel-stage4.3-xkeen-screen.md` — четвёртый закрытый экран подэтапа 4.3: core-owned экран Xkeen вынесен в partial без module gate.
- `modular-panel-stage4.4-modals.md` — закрытый подэтап 4.4: модальные окна и оверлей терминала разнесены по owner-partials с gates в composition root, составные gates HWID и редактора файлов, браузерный замер стилей до и после.
- `modular-panel-stage4.5-composition.md` — закрытый подэтап 4.5: server-side composition от active-module manifest, единый `page_context`, профильный HTML и allow-listed dynamic source resolver.
- `modular-panel-stage4.6-compatibility.md` — закрывающий подэтап 4.6: server-side compatibility matrix, Full/Legacy DOM-equivalence, составные modal owners и подтверждённое отсутствие монолита в entrypoint.
- `modular-panel-stage5-frontend-loading.md` — закрытый Этап 5: server descriptor, локальный dynamic-import allow-list, profile-aware bundles, lazy `xterm.css` и изолированные browser Network/WebSocket/console проверки.
- `modular-panel-stage6-editor-separation.md` — закрытый Этап 6: варианты editor `light/full/advanced`, persisted capability state, editor bundle allow-list и graceful fallback.
- `modular-panel-stage4.3-tool-screens.md` — экраны команд (`tool.terminal`) и файлов (`tool.files`) вынесены в partials; итоги browser smoke minimal-профилей и оставшиеся frontend-вызовы API выключенных модулей.
- `devtools-operator-theme.md` — закрытый перевод DevTools со старой blue-glass темы на общие с основной панелью Operator tokens, flat shell/data rows/log canvas/modals и responsive dark/light contract.
- `top-level-navigation-plan.md` — история закрытого перевода пяти исходных entrypoints и текущее расширение до шести маршрутов с `/modules`.
- `modular-panel-stage8-manager-ui.md` — операторский контракт core-owned менеджера модулей: план, применение, отмена, восстановление и границы доверия.
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
- `modular-panel-stage4.6-compatibility.json` — machine-readable compatibility contract закрытого Этапа 4; пересобирается `scripts/generate_modular_panel_stage4_6_compatibility.py`.
- `modular-panel-stage5-frontend-loading.json` — machine-readable contract закрытого Этапа 5; пересобирается `scripts/generate_modular_panel_stage5_frontend_loading.py`.
- `modular-panel-stage8-contract.json` — machine-readable contract закрытых подэтапов 8.0–8.4; пересобирается `scripts/generate_modular_panel_stage8_contract.py`.
- `../scripts/build_modular_panel_release.py` — deterministic builder panel/module archives, catalog, checksums и release metadata подэтапа 8.1.
- `../scripts/sign_modular_panel_catalog.py` — tag-only Ed25519 signer `catalog.json` и updater release metadata подэтапа 8.2.
- `superpowers/specs/2026-10-03-modular-panel-stage8-1-release-assets-design.md` и `superpowers/plans/2026-10-03-modular-panel-stage8-1-release-assets.md` — утверждённые design/implementation plan подэтапа 8.1.
- `superpowers/specs/2026-10-05-modular-panel-stage8-2-trust-catalog-design.md` и `superpowers/plans/2026-10-05-modular-panel-stage8-2-trust-catalog.md` — закрытый trust boundary, CI signing и клиент официального каталога подэтапа 8.2.
- `superpowers/specs/2026-10-06-modular-panel-stage8-4-lifecycle-api-design.md` и `superpowers/plans/2026-10-06-modular-panel-stage8-4-lifecycle-api.md` — design и implementation plan закрытого Lifecycle API 8.4.
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

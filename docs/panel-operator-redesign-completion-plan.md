# План завершения редизайна панели XKeen UI (Operator Console)

Дата актуализации: **7 сентября 2026 года**
Точка отсчёта: `main`, commit `340613e` (`fix: stabilize file manager workspace geometry`).

## 1. Итог аудита

Редизайн больше не находится в состоянии «Этап 4 в работе», как было записано в старой версии документа. Основной визуальный каркас и большая часть экранов уже переведены на Operator Console; после паузы в работе план нужно продолжать с финального интеграционного и acceptance-слоя, а не повторять Этапы 0–4.

### Что подтверждено в текущем дереве

- `panel-operator.css` подключается последним после legacy `styles.css`, terminal theme и `xterm.css`; текущий cache-buster панели — `20260907a`.
- `body.panel-page` остаётся границей стилей; `styles.css` не используется для новых panel-redesign правил.
- Stage 0 inventory пересобран после новых Mihomo/DNS/diagnostic surfaces: 6 top-level views, 12 disclosure-контрактов, 8 editor selectors, 53 modal IDs, 1271 уникальный DOM-id, 603 `data-*`, 166 hidden runtime nodes и 1195 JS-referenced template IDs.
- Inline-атрибутов 209: 66 state/visibility hooks, 140 presentation-geometry и 3 mixed; геометрия ещё не полностью вынесена из HTML.
- Scoped-слой вырос до 21 073 строк: по статическому grep в нём ещё около 3 679 `!important` и 424 `box-shadow` деклараций (часть — документированные legacy resets); это явный хвост cascade debt, а не повод добавлять ещё один override-блок.
- Operator icon pipeline закрыт: локальный минимальный Tabler sprite содержит 79 semantic icons; inventory не содержит неизвестных или неиспользуемых имён.
- Четыре modal family назначены всем 53 модальным окнам: 24 `confirm-compact-form`, 7 `editor-workbench`, 19 `master-detail`, 3 `drawer-help`.
- Текущий фронтенд — ESM/build-managed: 5 top-level routes (`panel`, `backups`, `devtools`, `xkeen`, `mihomo_generator`) и split/lazy bundles; это часть завершённой архитектурной миграции и не должно откатываться.
- После старого аудита добавлены и доведены: Clash API workspaces Mihomo (управление, соединения, правила, логи, конфигурация), resource monitor/diagnostics, DNS-over-VLESS и защищённый DNS Mihomo, rule-provider inspector, diff comparison workbench, обновлённые file-manager workspaces, DevTools ENV groups и новые mobile/viewport guardrails.

### Проверки, выполненные при актуализации

| Проверка | Результат |
| --- | --- |
| Operator static tests (Stage 0–5 и UI settings) | `53 passed` |
| `npm run frontend:verify` | успешно |
| Mihomo Clash targeted Playwright | `38 passed` |
| `PYTHONPATH=. pytest -q` | `1808 passed` |
| `npx playwright test e2e/panel_operator_ui.spec.mjs --project=chromium` | `6 passed` |
| Полный operator Playwright matrix | запускать в финальном gate после стабилизации всех fixtures; результаты не подменять targeted suite |

> Команда `pytest -q` без `PYTHONPATH=.` в текущем окружении падает на импорте `tests.support`; это проблема запуска/окружения, а не функциональный регресс. Канонический локальный запуск — `PYTHONPATH=. pytest -q`.

## 2. Цель финального результата

Панель должна выглядеть и работать как единая спокойная операторская консоль:

- рабочая область и редактор визуально важнее оболочки;
- графитовые поверхности, один indigo-акцент и semantic colors только для состояния/риска;
- данные представлены строками и компактными рабочими областями, а не вложенной мозаикой карточек;
- каждый экран имеет одинаковые action/field/status/empty/error primitives;
- модальные редакторы сохраняют header/editor/footer, а на mobile становятся рабочими fullscreen-потоками;
- persistent configuration остаётся в существующих YAML/JSON editors; runtime Mihomo остаётся рядом, но не дублирует редактор;
- API, маршруты, security boundaries, `id`, `data-*`, runtime DOM nodes и существующие обработчики не меняются ради визуального эффекта.

## 3. Зафиксированные правила, которые нельзя нарушать

1. Любые новые panel styles добавляются только в `xkeen-ui/static/panel-operator.css` и только под `body.panel-page`; DevTools использует свой последний `devtools-operator.css`.
2. Не удалять runtime DOM nodes и не переименовывать `id`, `data-*`, editor selectors или handler anchors без отдельного migration decision.
3. Inline `display:none`/`visibility` можно оставлять как state hook; presentation geometry переносить в scoped CSS.
4. Не создавать третий набор geometry primitives и не дописывать блок `final fixes` после responsive section.
5. Pill-форма допустима только для физического toggle или счётчика, а не для обычных action buttons, links, statuses и data rows.
6. Не возвращать градиенты, glass/blur, цветные glow, постоянный lift-transform или action-emoji.
7. Любое визуальное изменение закрывается статическим контрактом и реальным Chromium dark/light/mobile проверочным сценарием.
8. Любая новая runtime-функция Mihomo должна проходить backend security contract и не получать прямой browser-доступ к controller.

## 4. Статус потоков

| Поток | Статус сейчас | Что это означает |
| --- | --- | --- |
| Stage 0: inventory/DOM freeze | **закрыт, поддерживается** | snapshot нужно обновлять только при осознанном добавлении экранов/модалов |
| Stage 1: scoped primitives | **закрыт, требует debt cleanup** | базовые primitives есть, но cascade debt и `!important` ещё велики |
| Stage 2: header/navigation/grid | **закрыт, требует финального cross-screen gate** | геометрия работает; новые runtime/diagnostic surfaces должны быть включены в общий gate |
| Stage 3: routing cards | **закрыт** | Xray inspector и operational blocks используют общий contract |
| Stage 4: data-heavy workspaces | **закрыт функционально и визуально по targeted contracts** | Ports, rules, balancers, commands, logs, files, Mihomo forms/subscriptions закрыты; новые DNS/diagnostic/diff additions требуют финального прохода |
| Icon I0–I6 | **закрыт** | 79 локальных semantic icons и accessibility contract поддерживаются |
| Stage 5: editor/modal workbench | **частично закрыт** | общий frame и 53 family mappings есть; полный matrix реальных loaded/empty/error/narrow состояний ещё не принят |
| Stage 6: themes/responsive/a11y | **частично закрыт** | targeted checks зелёные, но нет единого acceptance всех новых экранов и zoom/long-copy matrix |
| Stage 7: visual regression/cleanup | **открыт** | нужен единый screenshot/computed-style/full-E2E gate и уборка остаточного legacy cascade |
| Mihomo Clash API | **локально реализован, hardware acceptance открыт** | PR 1–12 и локальные fake/Playwright contracts зелёные; нужны aarch64/mipsle, Unix/WS/no-gevent и mutation/performance проверки на роутере |

## 5. Новый поэтапный план до завершения

Этапы идут последовательно; внутри этапа допускаются параллельные feature-партии. Каждый этап должен закончиться зелёным статическим контрактом, targeted Chromium и обновлением документации/fixtures, если контракт изменился.

### Этап A. Восстановить единую baseline и заморозить текущую точку

**Цель:** сделать текущий `main` измеримым и не потерять уже сделанный прогресс.

Задачи:

- [ ] Запустить и сохранить полный актуальный operator Playwright matrix для всех top-level views, dark/light и viewport `1920×1080`, `1440×900`, `1280×720`, `1024×768`, `390×844`, `360×800`.
- [ ] Переснять representative screenshots не только Routing/Ports/Commands/Files, но и Mihomo runtime (5 subviews), generator, diagnostics/resource monitor, DNS-over-VLESS, protected DNS, diff-workbench и DevTools.
- [ ] Разделить baseline на `accepted`, `needs-review` и `hardware-only`; не принимать снимок только потому, что тест технически завершился.
- [ ] Прогнать inventory generator и зафиксировать committed diff: 53 modal IDs, 12 accordions, 8 engines, 79 icons, DOM/data/hidden counts.
- [ ] Исправить/документировать единый test bootstrap (`PYTHONPATH=.` для pytest) и убрать ложный красный сигнал от способа запуска.
- [ ] Зафиксировать список новых экранов/состояний, добавленных после 10 августа, как отдельные acceptance targets.

**Выход:** есть один reproducible baseline текущего `main`, от которого можно отличать регрессию от принятого улучшения.

### Этап B. Закрыть хвост Stage 5: все модальные и editor/workbench состояния

**Цель:** принять общий frame не только по CSS-контракту, а по реальным состояниям всех 53 окон.

Порядок:

1. `editor-workbench`: JSON, file/snapshot, routing templates, Mihomo import/HWID, SSH transfer, diff comparison;
2. `master-detail`: subscriptions/generator/pool, Mihomo proxy/provider/rules, DAT, UI settings, diagnostics/resource monitor, file-manager lists;
3. `drawer-help`: editor help, balancer help, terminal/file-manager help;
4. `confirm-compact-form`: core/confirm, DNS-over-VLESS/protected DNS, SSH and file-manager actions.

Задачи:

- [ ] Для каждого ID проверить `closed/open/loading/loaded/empty/error/narrow` по применимости; состояния, которые невозможно воспроизвести fixture-ом, пометить manual/hardware.
- [ ] Проверить: header/footer не исчезают, один scroll owner, editor/record list получает основную площадь, cancel/close/primary action доступны.
- [ ] Убрать оставшиеся presentation inline `width/max-width/min-height/gap/margin/padding`; visibility hooks оставить.
- [ ] Для DNS-over-VLESS и защищённого DNS отдельно проверить layouts 1/2 columns, collapsed zones, device selection/apply, disabled/error states и mobile action row.
- [ ] Для diff-workbench проверить CM6/Monaco, compare/merge actions, long files, error/empty states и portal overlays.
- [ ] Для file-manager проверить dialogs после обновлённой workspace geometry и сохранённого vertical resize.

**Выход:** все 53 modal IDs имеют принятую family-геометрию, нет перекрытия действий и искусственной пустоты.

### Этап C. Довести новые runtime/data-heavy поверхности до общей Operator грамматики

**Цель:** завершить визуальное выравнивание того, что появилось после старого плана.

Области:

- **Mihomo Clash:** Управление, Соединения, Правила, Логи, Конфигурация; compact status strip, disclosure groups, provider/rule inspector, empty/loading/error, mobile records.
- **Xray/Mihomo latency and selectors:** одинаковые state tones, country flags/semantic icons, fixed/auto/timeout/stale states, bounded batch progress.
- **Router diagnostics/resource monitor:** summary, charts/telemetry, interface/modem/traceroute panels, loading/error/empty and detail modals без dashboard-card explosion.
- **DNS-over-VLESS/protected DNS:** плоские named zones, progressive disclosure, direct-zone reset, device chooser/apply row, safety/error explanation, remembered one/two-column layout.
- **Mihomo generator/profiles/subscriptions:** table/form/action primitives, source validation, preview/error, no duplicate diagnostics panels.
- **Files/Commands/Logs/Settings/DevTools:** принять последние 7 сентября geometry/theme changes и убедиться, что локальные fixes не создали новый special-case cascade.

Задачи:

- [ ] Для каждой области составить короткую state matrix и один representative screenshot per theme/breakpoint.
- [ ] Свести повторяющиеся правила в существующие primitives; новые selectors добавлять семантическими и scoped.
- [ ] Проверить, что data-heavy lists используют внутренний scroll только там, где это нужно, а page/workspace viewport не получает двойной scroll.
- [ ] Проверить длинные русские строки, unknown/failed provider, no-device-map, stopped core, API security warning и partial data.

**Выход:** новые экраны не выглядят отдельными мини-продуктами и проходят тот же visual language gate, что Routing Xray.

### Этап D. Закрыть темы, responsive, accessibility и performance-профиль

**Цель:** одна иерархия в dark/light и рабочее поведение на слабых устройствах.

Задачи:

- [ ] Проверить dark/light для всех representative screens без theme-specific geometry; убрать остаточный navy/glass tint и холодные light glow.
- [ ] Прогнать breakpoints и высоты: `1920×1080`, `1440×900`, `1280×720`, `1024×768`, `390×844`, `360×800`, включая short-height editor/modal cases.
- [ ] Прогнать zoom 125%/150%, длинные русские строки, forced-colors/high-contrast, `prefers-reduced-motion`.
- [ ] Проверить keyboard order, `:focus-visible`, Escape/return-focus, tab/accordion/disclosure semantics, accessible names/tooltips icon-only controls.
- [ ] Проверить no page overflow, one scroll owner, visible primary action, touch targets ≥40 px на mobile.
- [ ] Снять MIPS/perf-lite profile: initial payload, lazy chunks, DOM nodes, polling/WS lifecycle, no hidden-screen traffic.
- [ ] Для Mihomo отдельно подтвердить bounded limits: connections, rules/providers, latency queue, log ring buffer, no listener duplication.

**Выход:** обе темы, увеличенный масштаб, клавиатура и слабый профиль не меняют смысловую иерархию и не ломают layout.

### Этап E. Убрать cascade debt и формализовать computed-style guardrails

**Цель:** превратить «последний CSS-слой» в поддерживаемую систему, а не в архив исключений.

Задачи:

- [ ] Разобрать `panel-operator.css` по каноническим секциям и объединить повторные selectors; не добавлять новый хвост после responsive.
- [ ] Снизить широкое применение `!important` там, где legacy conflict уже устранён; оставлять его только на документированной boundary.
- [ ] Проверить остаточные `999px`: разрешены только физический toggle и явно документированный compact counter; обычные rows/actions/statuses перевести на finite radius.
- [ ] Добавить computed-style guards для gradient/background-image, colored blur/glow, lift-transform, pill geometry и accidental `display:grid/flex` поверх hidden runtime nodes.
- [ ] Добавить guard на stylesheet order/scope для panel, generator и DevTools; generator cache-buster обновить с `20260811h` на актуальный revision после изменений.
- [ ] Не редактировать `styles.css` для panel-specific redesign; если legacy rule мешает, нейтрализовать его в scoped boundary и добавить regression test.

**Выход:** CSS имеет один владеющий слой, понятную debt-метрику и автоматические запреты на возврат старой визуальной системы.

### Этап F. Финальный функциональный и hardware acceptance

**Цель:** проверить, что финальная визуальная сборка не ломает рабочую панель и реальный Mihomo.

Локально до роутера:

- [ ] Полный `PYTHONPATH=. pytest -q`.
- [ ] `npm run frontend:verify` и `npm run archive:user`/router archive smoke.
- [ ] Полный Playwright: panel operator, stage 0–5, viewport scroll, top-level focus, DevTools, generator, DNS, diagnostics, diff и `npm run e2e:mihomo-clash`.
- [ ] Проверить frontend build manifest, generated icon sprite/inventory, Stage 0 inventory и git diff/checks.

На реальном роутере:

- [ ] Mihomo: aarch64 и mipsle; TCP+secret и Unix socket; gevent WebSocket и no-gevent HTTP fallback.
- [ ] Controller missing/stopped/restart, LAN/VPN loss/recovery, security warning and opt-in migration.
- [ ] Select/delay/group/provider collision, bounded visible batch, connections snapshot, disconnect one/all, rules/providers/logs.
- [ ] CPU/RAM/network/frame/DOM budgets на idle, 100 и 500 connections; задержки при массовой проверке.
- [ ] Реальный file manager resize/scroll, DNS-over-VLESS device apply, Mihomo DNS safety flow и modal focus/return-focus.
- [ ] Не сохранять в артефакты secret, host/IP, node names, raw rules/logs или пользовательский config.

**Выход:** локальный и router acceptance проходят на одной собранной версии, а functional regressions отделены от допустимой разницы снимков.

### Этап G. Release gate и закрытие редизайна

**Цель:** выпустить финальный результат и перевести документ из active plan в поддерживаемый contract/status.

Задачи:

- [ ] Утвердить final screenshots и отклонения от baseline с кратким обоснованием.
- [ ] Обновить cache-busters только после зелёных тестов: panel, generator, DevTools, icon sprite/build manifest.
- [ ] Пересобрать и проверить `xkeen-ui-routing.tar.gz`; проверить install/upgrade/rollback smoke.
- [ ] Обновить Stage 0 inventory, icon inventory, frontend-page inventory и связанные stage/Clash docs.
- [ ] Перенести оставшиеся открытые hardware/manual пункты в отдельный release checklist, если они не блокируют локальный визуальный DoD.
- [ ] После acceptance заменить статус этого файла на `ЗАВЕРШЁН`, оставить дату, commit и команды воспроизведения.

**Выход:** редизайн принят как единая версия панели, а не как набор локальных исправлений.

## 6. Матрица финальной визуальной проверки

Для каждого экрана проверить ready/loading/empty/error, если состояние существует; для modal — open/loaded/error/narrow.

| Поверхность | 1920×1080 | 1440×900 | 1280×720 | 1024×768 | 390×844 | 360×800 |
| --- | --- | --- | --- | --- | --- | --- |
| Routing Xray + inspector | dark/light | dark/light | dark/light | light | dark/light | light |
| Routing Mihomo + selectors | dark/light | dark/light | dark/light | light | dark/light | light |
| Mihomo connections/rules/logs | dark/light | dark/light | dark/light | light | dark/light | light |
| Ports/exceptions | dark/light | light | dark/light | light | dark/light | light |
| Commands / Files / Xray logs | dark/light | dark/light | light | light | dark/light | light |
| Mihomo generator/profiles/subscriptions | dark/light | dark/light | light | light | fullscreen | fullscreen |
| JSON/file/snapshot/diff editors | dark/light | dark/light | dark/light | light | fullscreen | fullscreen |
| DNS-over-VLESS / protected DNS | dark/light | dark/light | light | light | fullscreen | fullscreen |
| Router diagnostics/resource monitor | dark/light | dark/light | light | light | fullscreen/auto | fullscreen/auto |
| Settings/core/compact confirms | dark/light | dark/light | light | light | fullscreen/auto | fullscreen/auto |
| DevTools / ENV / logs | dark/light | dark/light | light | light | dark/light | light |

На каждой ячейке проверяются: page overflow, один scroll owner, primary action, close/cancel, focus-visible, keyboard path, no duplicate labels, no gradient/glow/pill у неподходящих элементов и отсутствие утечки runtime content в hidden state.

## 7. Definition of Done

Редизайн считается завершённым только если одновременно выполнены все пункты:

- [ ] current inventory и DOM/runtime contract обновлены и зелёные;
- [ ] panel/generator/DevTools scoped styles подключаются последними и не получают новых legacy redesign rules;
- [ ] все 6 top-level views, 5 routes, 53 modal IDs и 12 disclosures покрыты inventory;
- [ ] все 79 action/navigation icons используют локальный sprite и имеют доступный control contract;
- [ ] Stage 0–4 contracts, Stage 5 complete matrix, themes/responsive/a11y и visual regression suite зелёные;
- [ ] обычные actions/links/statuses/data rows не используют pill geometry, gradient, glass, glow или lift-transform;
- [ ] editors/workspaces имеют content-driven height, один scroll owner и доступные footer/actions;
- [ ] Mihomo runtime проходит local fake + real router acceptance, а hidden subviews не создают traffic;
- [ ] full Python, frontend build/verify, targeted/full E2E и archive smoke зелёные;
- [ ] финальные screenshots приняты для dark/light desktop/mobile, а все исключения задокументированы;
- [ ] cache-busters, manifests, inventories и release archive соответствуют одному commit.

## 8. Рекомендуемая последовательность партий

1. **Baseline / inventory / harness** (Этап A).
2. **Modal/editor completion** (Этап B).
3. **New runtime surfaces**: Mihomo, diagnostics, DNS, diff, files/DevTools (Этап C).
4. **Theme/responsive/a11y/perf** (Этап D).
5. **Cascade debt and computed-style guards** (Этап E).
6. **Functional + router acceptance** (Этап F).
7. **Release/archive/docs gate** (Этап G).

Каждая партия должна быть отдельным откатываемым commit/PR и завершаться своими static + Chromium + screenshot evidence. Не объединять все исправления в единый «финальный polish» коммит.

## 9. Связанные документы и источники истины

- [`panel-operator-stage0-contract.md`](panel-operator-stage0-contract.md) — DOM/runtime freeze и inventory contract;
- [`panel-operator-stage1-primitives.md`](panel-operator-stage1-primitives.md) — primitives/cascade contract;
- [`panel-operator-stage2-shell-grid.md`](panel-operator-stage2-shell-grid.md) — shell/navigation/grid;
- [`panel-operator-stage3-routing-cards.md`](panel-operator-stage3-routing-cards.md) — Routing inspector;
- [`panel-operator-stage4-ports.md`](panel-operator-stage4-ports.md), [`panel-operator-stage4-routing-rules.md`](panel-operator-stage4-routing-rules.md), [`panel-operator-stage4-balancers.md`](panel-operator-stage4-balancers.md), [`panel-operator-stage4-commands.md`](panel-operator-stage4-commands.md), [`panel-operator-stage4-logs.md`](panel-operator-stage4-logs.md), [`panel-operator-stage4-files.md`](panel-operator-stage4-files.md), [`panel-operator-stage4-mihomo-forms.md`](panel-operator-stage4-mihomo-forms.md`);
- [`panel-operator-stage5-editor-workbench.md`](panel-operator-stage5-editor-workbench.md) — editor/modal family contract;
- [`panel-operator-icon-i6-final-contract.md`](panel-operator-icon-i6-final-contract.md) — icon/accessibility/sprite contract;
- [`devtools-operator-theme.md`](devtools-operator-theme.md) — DevTools theme contract;
- [`README_clash_api_implementation_plan.md`](README_clash_api_implementation_plan.md) — Mihomo API/runtime security and router acceptance;
- [`frontend-page-inventory.md`](frontend-page-inventory.md) — ESM/build-managed page graph;
- [`top-level-navigation-plan.md`](top-level-navigation-plan.md), [`docs/frontend-target-architecture.md`](frontend-target-architecture.md) — top-level shell and frontend architecture.

## 10. Команды воспроизведения

```bash
# Baseline and inventory
python3 scripts/generate_panel_operator_inventory.py --root . --json-out /tmp/panel-operator-current-inventory.json
python3 scripts/generate_panel_operator_inventory.py --root . --json-out docs/panel-operator-stage0-inventory.json

# Static contracts
PYTHONPATH=. pytest -q tests/test_panel_operator_stage0_contract.py \
  tests/test_panel_operator_stage1_primitives.py \
  tests/test_panel_operator_stage2_shell_grid.py \
  tests/test_panel_operator_stage3_routing_cards.py \
  tests/test_panel_operator_stage4_ports.py \
  tests/test_panel_operator_stage4_routing_data.py \
  tests/test_panel_operator_stage4_files.py \
  tests/test_panel_operator_stage4_logs.py \
  tests/test_panel_operator_stage5_editors.py \
  tests/test_ui_settings_contextual_controls.py

# Build
npm run frontend:verify

# Mihomo targeted E2E
npm run e2e:mihomo-clash

# Full regression
PYTHONPATH=. pytest -q
npx playwright test
npm run archive:user
```

Последовательность команд для реального роутера и hardware checklist описана в [`README_clash_api_implementation_plan.md`](README_clash_api_implementation_plan.md), Этап 8. Секреты и пользовательские payload в репозиторий и screenshot artifacts не попадают.

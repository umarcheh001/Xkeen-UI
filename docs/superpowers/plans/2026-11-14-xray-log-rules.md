# Правила в логах Xray — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Показать подтверждённый ruleTag у access-записей без потери скорости пакетной отрисовки.

**Architecture:** Один существующий diagnostic-опрос, ограниченный индекс сессий и ожидающих access-записей; обновление метаданных по seq через существующий RAF. Сервер отдаёт признак тегов и ограниченный свежий diagnostic-хвост с признаками reset/skipped/caught_up.

**Tech Stack:** Python/Flask, native JS modules, Node tests, pytest, Playwright; без новых зависимостей.

**Spec:** docs/superpowers/specs/2026-11-14-xray-log-rules-design.md

## Global Constraints

- Видимость: есть непустой ruleTag в загружаемых JSON-фрагментах и info/debug, независимо от доменов.
- Не менять ruleTag конфигурации, уровень ядра, raw-логи; «—» при недостатке данных.
- Сохранить синхронную access-модель, виртуализацию и пакетный RAF; работа diagnostic ограничена.
- Пауза замораживает теги и экспорт; смена поколения инвалидирует незавершённые связи.
- LF. Тесты от Alex, Python с новым коротким basetemp вне Git. Перед e2e frontend:build.
- Без коммитов/пуша/тегов/установки: запрос относится к реализации, не выпуску.

## Review Focus

- Поздний второй кандидат не должен закрепить ошибочный тег: финализация после полного окна и проверка повторного endpoint.
- Sniffing/IPv6 не должны склеивать разные назначения: привязка по session и проверенные исходные endpoints.
- Быстрый truncate+regrow того же inode должен сбросить связи: проверка границы курсора.
- Отключённые домены не отключают правила; ошибки статуса не оставляют устаревший доступный индекс.
- Пауза/смена вкладки/поздний HTTP-ответ не размораживают строку и не засоряют новую сессию.

### Task 1: Сервер — доступность и diagnostic-курсор

**Files:** services/xray_log_api.py, services/xray_config_files.py (reuse only), routes/xray_logs.py; tests/test_xray_log_rules.py.

**Interfaces:** get_status() adds `has_rule_tags: bool | null`; diagnostic response adds `reset: bool`, `skipped: bool`, `caught_up: bool`; bounded existing cursor gains boundary verification. Existing ordinary tail responses remain compatible.

- [x] RED: assert status sees tags in arbitrary .json fragments but ignores JSONC/commented rules, refreshes after file changes and returns unknown on malformed JSON.
- [x] RED: diagnostic initial/append/overrun/truncate+regrow preserve bounded fresh suffix, complete lines, cursor boundary and reset/skipped/caught_up.
- [x] Implement cached presence scan using existing config dir and JSON loader; extend diagnostic-only cursor path without changing normal tail.
- [x] GREEN: `python -m pytest tests/test_xray_log_rules.py tests/test_xray_log_tail_memory.py tests/test_xray_logs_outbound_names.py -q`.

### Task 2: Ограниченный индекс и очередь diagnostic

**Files:** create static/js/features/xray_log_rules.js; tests/js/xray_log_rules.test.mjs.

**Interfaces:** `createXrayLogRuleIndex()` with `ingest(line)`, `lookup(parsedAccess, previousTag)`, `complete()`, `reset()`; `createXrayLogDiagnosticQueue({consume,onComplete,schedule,cancel,now})` with `push(lines,meta)`, `reset()`.

- [x] RED: exact tagged/untagged/default, intersecting sessions, wrong outbound, duplicate endpoint, timestamp window, sniffing original endpoint, IPv6, missing source/rule, reset, cache limits.
- [x] RED: queue yields between bounded chunks, completion waits for consumed lines, reset cancels stale work and overflow drops incomplete correlations.
- [x] Implement Map indices with max2048 sessions and TTL30s; matching window2s, no latest-wins. Complete uses caught-up wall time; no dynamic mutable endpoint lookup in frozen export.
- [x] GREEN: `node --import ./tests/js/xk_core_hooks.mjs --test tests/js/xray_log_rules.test.mjs`.

### Task 3: Метаданные и колонка view

**Files:** static/js/features/xray_log_view.js; e2e/panel_operator_stage4_logs.spec.mjs.

**Interfaces:** view `setRulesVisible(bool)`, `updateRules(lookup)`; assigned `record.ruleTag`, frozen pending metadata applied on resume. `updateRules` invalidates changed row html only and queues existing RAF.

- [x] RED: column placement/hidden old layout, escaped long tags/detail/TSV, paused tags/export, one RAF for several tag updates, trimmed row metadata removal.
- [x] Implement accepted mock layout and seq-local metadata invalidation; raw unchanged; mobile hides column but retains detail.
- [x] GREEN: frontend:build then targeted Playwright tests and existing frame regressions.

### Task 4: Общий diagnostic-потребитель контроллера

**Files:** static/js/features/xray_logs.js; e2e/panel_operator_stage4_logs.spec.mjs; relevant frontend contracts.

**Interfaces:** status updates eligibility; existing domain_hints request feeds bounded queue, ingests domains once and rules once; complete triggers view metadata update. Poll predicate domains OR eligible rules.

- [x] RED: tags shown with domains off; level/no-tags hide; late diagnostic/EOF attaches correct tag; paused data frozen; leaving/reset rejects late response; no second polling stream.
- [x] Implement generation token, reset on known restart/clear/file lifecycle, common queue and changed-only render; keep existing access batching.
- [x] GREEN: targeted e2e + JS + Python frontend contracts.

### Task 5: Проверки, скорость, ревью и перенос результата

**Files:** docs/xray-logs-screen.md, generated inventories, e2e/perf scratch scripts, .superpowers/sdd/2026-11-14-xray-log-rules/progress.md.

- [x] Run related JS/Python/e2e; full pytest via Git Bash with unique outside-Git basetemp; build before e2e.
- [x] A/B baseline and implementation with diagnostic stream at 5/50/500 events/s CPU1/4, 3 repeats; compare queue/DOM/long tasks and backlog; fix reproducible regressions.
- [x] Fresh independent whole-change review; fix important findings with RED/GREEN.
- [x] Refresh inventories through штатный генератор (new files may require staging; no commit), verify LF/diff, document measured limitations.
- [x] Transfer reviewed patch to primary pre-release working copy without committing; preserve unrelated watch/README files, verify build/related tests after transfer.
- [x] Update handoff/memory; report exact checks/remaining limits.

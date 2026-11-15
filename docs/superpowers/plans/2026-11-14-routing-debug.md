# Отладка маршрутизации Xray — план

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Временная отладка через webhook без debug и фонового определения правил вне режима.
**Architecture:** Один сервис состояния/конфигурации/ограниченного кеша; существующий Flask blueprint,
один пакетный клиентский опрос и текущая виртуальная таблица. Старый diagnostic-индекс остаётся
для доменов, не для ruleTag.
**Tech Stack:** Python/Flask/stdlib, существующие JSONC/atomic/transactions, JS/Playwright/Node.
**Spec:** docs/superpowers/specs/2026-11-14-routing-debug-design.md

## Global Constraints

- Минимум Xray26.3.27; неизвестная версия запрещает включение, off всегда доступен.
- Переключатель третий; default off, серверное сохранение; первая версия без сводки.
- Не менять условия/порядок/ruleTag/чужие webhook; не добавлять зависимости.
- Не менять роутер/не пушить/не выпускать; mirrors_watch и личный README не включать.
- Python-тесты от Alex с уникальным коротким basetemp вне Git; build перед e2e; LF.

## Review Focus

- Чужой webhook и редактирование правил во время отладки: не терять пользовательские данные.
- Отказ записи/check/restart: откат файлов и понятная ошибка, не ложный enabled.
- Поддельное/слишком большое событие/IPv6/повтор порта: отказ или прочерк.
- Стоп/пауза/новое поколение: никакого присвоения старых правил новым строкам.
- Приёмник недоступен/браузер закрыт/поток500с: ограниченные очереди и память.

### 1. База и сервис

Files: create services/xray_routing_debug.py, tests/test_xray_routing_debug.py;
reuse services/xray_transactions.py, services/io/atomic.py, helpers JSONC.
Interfaces: RoutingDebug(configs_dir,state_dir), status(), configure(wanted,logging,restart),
apply(logging), authorize(remote,token), ingest(rule_key,event), events().
- [x] Сохранить baseline производительности aaf5cd9e и контракты текущих тестов.
- [x] RED: floor/version unknown, defaultoff/сохранение без запуска, чужие hooks,
  откат нескольких файлов/ошибка restart, тела/события/2048/TTL/поколения.
- [x] GREEN: сервис и штатные атомарные записи/check_staged/JSONC; без внешних пакетов.

### 2. API и жизненный цикл

Files: routes/xray_logs.py, services/auth_setup.py, tests/test_xray_routing_debug.py.
Interfaces: status.routing_debug; POST routing-debug{enabled}; GET routing-debug/events;
POST routing-event/<rulekey> с X-Xkeen-Routing-Token.
- [x] RED: loopback+secret обязателен, остальные endpoint остаются session+CSRF;
  Пуск/Стоп один restart, настройка при none без restart, откат и status.
- [x] GREEN: встроить сервис blueprint/app.extensions, объединить с enable/disable.

### 3. Индекс событий и интерфейс

Files: static/js/features/xray_log_rules.js, xray_logs.js, xray_log_view.js,
templates/panel/screens/xray_logs.html; tests/js/xray_log_rules.test.mjs,
e2e/xray_log_rules.spec.mjs.
Interfaces: индекс webhook по полному tuple/времени; старый diagnostic индекс только domain;
существующий updateRules; серверная настройка switch/status.
- [x] RED: TCP/UDP/IPv6, повтор порта/неоднозначность/потери/поколение, warning;
  third/defaultoff/unsupported/statusfailure/pause/stop/две вкладки.
- [x] GREEN: переиспользовать bounded queue и общий опрос, убрать прежний fallback ruleTag.
- [x] Убедиться, что обычные подтверждённые домены и переключатель доменов сохранены.

### 4. Проверки, замеры и передача

Files: docs/xray-logs-screen.md, module-versions.json, генерируемые описи;
scratch .superpowers/sdd/2026-11-14-routing-debug/.
- [x] Native Xray direct/block при warning/debug, полученные/утраченные события,
  отказ/медленный приёмник; сравнение CPU/RSS/задержки.
- [x] JS, связанные Python, build+e2e, замеры браузера до/после0/50/500×CPU1/4.
- [x] Полный pytest по AGENTS, итоговые версии/описи/LF/diff.
- [x] Свежий read-only reviewer всей правки, исправить существенные замечания с RED/GREEN.
- [x] Передать результат, ограничения и память/handoff; без нового коммита/пуша/установки.

Проверки и ограничения: .superpowers/handoff.md; подробные результаты и замеры —
.superpowers/sdd/2026-11-14-routing-debug/progress.md и performance.md.
Полный pytest имел два Windows-архивных сбоя; оба файла прошли повторно на коротком
Temp (17 passed). Это не единый полный прогон с нулём падений. Коммита/пуша/установки нет.

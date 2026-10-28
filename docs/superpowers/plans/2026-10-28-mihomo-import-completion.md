# Завершение импорта Mihomo: план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** закрыть неполные требования этапа 6, затем измерить и устранить
подтверждённые проблемы производительности этапа 7.

**Architecture:** единый adapter операций для модала и главного редактора,
неизменяемый candidate и отдельный lifecycle регистрации/job. Существующие
парсеры, runtime helpers и публичные facade сохраняются.

**Tech Stack:** JavaScript ESM, Flask/Python, CodeMirror/Monaco, pytest,
Node test runner, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-28-mihomo-import-completion-design.md`

## Global Constraints

- Работать в `pre-release`; не пушить, не выпускать релиз, не менять роутеры.
- Production UI — после выбора макета владельцем; Operator tokens и SVG icons.
- JS: CRLF; Python: LF. Новое поведение — сначала падающий тест.
- Перед E2E: `npm.cmd run frontend:build`.
- Полный Python: `npm run test:py` из Git Bash; отдельные файлы через pytest.
- Не затрагивать существующие изменения `scripts/entware_mirrors_watch.json`
  и локальные незарегистрированные файлы.

## Review Focus

- Главный редактор меняется во время асинхронного patch или commit.
- Job endpoint ответил HTTP 200/ok, но процесс завершился с exit 1.
- Сохранение завершилось, а ответ потерян: повтор не должен повторять импорт.
- Часть registrations успешна, следующая отказала; повтор только неуспешных.
- Пользователь удалил импортированные узлы из черновика до toolbar save.

### Задача 1: воспроизведение и review UI

**Files:** `.superpowers/sdd/2026-10-28-mihomo-import-completion/`,
`xkeen-ui/templates/panel/modals/mihomo.html`,
`xkeen-ui/static/js/features/mihomo_import.js`,
`xkeen-ui/static/panel-operator.css`,
`e2e/mihomo_import_source_lifecycle.spec.mjs`.

**Interfaces:** review хранит candidate snapshot; финальное действие
получает только подтверждённый актуальный snapshot.

- [x] Получить screenshots настоящей панели и воспроизвести cached candidate.
- [x] Получить выбор макета владельцем: вариант А.
- [x] Добавить E2E: до подтверждения нет commit; изменение editor/profile
  требует нового review; старые правки видны до сохранения.
- [x] Запустить тесты, зафиксировать ожидаемые падения.
- [x] Реализовать review, возврат к настройкам без parse и раскрываемые
  сравнения «импорт»/«весь файл» на том же candidate.
- [x] Собрать frontend, повторить целевые E2E и проверить 390 px/dark/light.

### Задача 2: единая операция сохранения и файловая защита

**Files:** новый `xkeen-ui/static/js/features/mihomo_config_operations.js`,
`mihomo_import.js`, `mihomo_panel.js`, `xkeen-ui/routes/mihomo.py`,
новый `tests/js/mihomo_config_operations.test.mjs`,
`tests/test_mihomo_node_import_route.py`.

**Interfaces:** adapter принимает explicit content/restart/baseline и
возвращает saved revision, backup и job identity; блокировка общая.

- [x] Тестами закрепить stale/отсутствующую revision, изменение файла при
  validation, concurrent toolbar/modal, invalid candidate и backup failure.
- [x] Тестом закрепить повторный save после успеха без дублирования узлов.
- [x] Запустить до исправлений; подтвердить причины падений.
- [x] Подключить оба UI к общей операции, сверять snapshot перед записью,
  повторно проверять revision перед save и обновлять baseline после успеха.
- [x] Прогнать unit/route и E2E трёх финальных действий.

### Задача 3: pending registrations и targeted retry

**Files:** `mihomo_config_operations.js`, `mihomo_import.js`,
`mihomo_panel.js`, `tests/js/mihomo_config_operations.test.mjs`,
`e2e/mihomo_import_source_lifecycle.spec.mjs`.

**Interfaces:** snapshot несёт registration intents; успешное сохранение
подходящего content разрешает регистрацию, draft сам по себе — нет.

- [x] Добавить падающие тесты draft → toolbar save, cancelled/удалённые
  узлы, частичная регистрация и retry без повторного commit/restart.
- [x] Перенести metadata из mutable `_lastResult` в snapshot intents,
  хранить успешные/ожидающие registrations отдельно от DOM модала.
- [x] Реализовать повтор только неудачных регистраций и честный warning.
- [x] Проверить отсутствие side effects до save и повторных выдач Amnezia.

### Задача 4: job result, runtime и восстановление

**Files:** `mihomo_config_operations.js`, `mihomo_import.js`,
`xkeen-ui/routes/mihomo.py`, при необходимости `routes/service.py`,
`tests/test_mihomo_node_import_route.py`,
`tests/js/mihomo_config_operations.test.mjs`, lifecycle E2E.

**Interfaces:** сохранённая операция содержит job id и states
saved/applying/unknown/applied/apply-failed плюс registration warning.

- [x] Добавить падающие тесты ok:true + exit 1, status:error, pending,
  timeout/network loss, saved:true + queue failure, close/reopen и runtime down.
- [x] Проверять terminal status/exit/error, ограничить polling; хранить
  job identity вне modal state и восстанавливать наблюдение при открытии.
- [x] После успешного job проверить runtime; показать redacted log,
  backup и отдельно недоступность API. Retry не повторяет импорт.
- [x] Выполнить unit/route и E2E всех состояний восстановления.

### Задача 5: замеры и оптимизация этапа 7

**Files:** capture harness по образцу stage0, `mihomo_import.js`,
`xkeen-ui/routes/mihomo.py`, `services/mihomo_proxy_config.py`,
тесты routes/JS/E2E; новый `docs/mihomo-node-import-stage7.md`.

**Interfaces:** batch принимает уже распознанные outputs/current content/groups;
возвращает целый content и diagnostics; старый apply_insert совместим.

- [x] Измерить first-open/parse/candidate, HTTP count для 1/10/50 outputs
  и повторное открытие; сравнить с артефактами stage0.
- [x] При N-запросной подготовке добавить падающий batch-тест atomic failure,
  missing groups, quoted names и комментариев.
- [x] Реализовать один batch patch без повторного parse/fetch/issuance.
- [x] Проверить lazy editor/diff, cleanup timers/listeners/observers и
  явные ограничения размера без молчаливого обрезания импорта.
- [x] Повторить замеры, записать цифры до/после и ограничения измерений.

### Задача 6: итоговые проверки и документация

**Files:** исходный README-план, `docs/mihomo-node-import-stage6.md`,
`docs/mihomo-node-import-stage7.md`, generated inventories и progress.md.

- [x] Целевые pytest/Node, frontend build, lifecycle/layout E2E.
- [x] Полный `npm run test:py` из Bash, `frontend:verify:static`,
  `inventory:refresh`/`inventory:check`; падения классифицировать с baseline.
- [x] Просмотреть screenshots dark/light/390 px/короткая высота.
- [x] Обновить статусы по фактам, убрать устаревшую фразу про save/apply,
  зафиксировать ограничения и выполненные проверки.
- [x] Просмотреть итоговый diff и CRLF, сообщить результат владельцу.

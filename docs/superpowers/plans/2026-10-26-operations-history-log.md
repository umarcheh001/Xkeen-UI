# История операций модулей во вкладке «обновления» — план работ

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** DevTools → «Логи панели» вместо мёртвого update.log показывает вкладку «обновления»: каждая операция окна модулей (обновление и откат панели, установка, удаление и восстановление модуля, смена набора) — одна строка таблицы с итогом, длительностью, шагами исполнителя и свёрнутым выводом подготовки окружения.

**Architecture:** `write_status` при итоге операции дописывает её в `module-operations/history.jsonl` (последние 50). Вывод скрипта подготовки окружения копится в `module-operations/environment.log` текущей операции и попадает в запись истории. DevTools отдаёт `history.jsonl` под именем `updates`, разборщик логов панели читает его как JSON по строке.

**Tech Stack:** Python 3 (исполнитель операций, DevTools API), ES-модули (`panel_log_parser.js`, `panel_log_view.js`, `devtools/logs.js`), pytest, Playwright.

**Spec:** макеты https://claude.ai/artifact/NeVKPom9VKTsRjDRKJmmq3, вариант B (выбран 26.10.2026).

## Global Constraints

- Файл истории — `<state_dir>/module-operations/history.jsonl`, одна операция на строку, хранить последние **50**; одна операция (`operation_id`) — одна строка: повторная запись итога той же операции заменяет её.
- Вывод подготовки окружения — `<state_dir>/module-operations/environment.log`; в историю попадают последние **200** строк; файл очищается, когда начинается новая операция.
- Запись истории никогда не роняет операцию: ошибки записи глотаются, как сейчас у `write_status` в `finish`.
- Подписи (дословно): вкладка `обновления`; источники `Обновление панели`, `Откат панели`, `Установка модуля`, `Удаление модуля`, `Восстановление модуля`, `Смена набора модулей`; итоги `Панель обновлена до {v}`, `Панель откачена до {v}`, `Модуль «{name}» установлен|удалён|восстановлен`, `Набор модулей применён`; неудача — `Не выполнено: {причина}` (причина — `error` записи, иначе текст результата); свёрнутый вывод — `Вывод подготовки окружения · {n} строк`; пары подробностей — `Выпуск` (`{from} → {to}` или `{to}`), `Канал`, `Операция` (id).
- Старый update.log не удаляется и больше не показывается.
- Коммиты с `-c user.name="olmer2002" -c user.email="olmer2002@gmail.com"`, описи — `npm run inventory:refresh` после `git add`; JS с CRLF сохранять как есть.

## Review Focus

1. Итог одной операции пишется дважды (исполнитель, потом восстановление при загрузке панели) — в истории одна строка с последним итогом. Тест — задача 1 `test_same_operation_is_replaced_not_added`.
2. Испорченная строка в `history.jsonl` (обрыв записи) — остальные операции читаются, вкладка не пустеет. Тесты — задача 1 `test_broken_line_is_skipped`, задача 3 «испорченная строка пропускается».
3. Панель без единой операции — вкладки нет в шапке (файла нет), она в меню пустых. Тест — задача 2 `test_updates_target_points_to_history`.
4. Операция ещё идёт — в истории её нет, пока нет итога. Тест — задача 1 `test_running_status_is_not_history`.
5. Очень длинный вывод opkg — в историю идут последние 200 строк. Тест — задача 1 `test_environment_tail_is_limited`.

---

### Task 1: запись истории и вывода подготовки окружения

**Files:**
- Create: `xkeen-ui/services/module_transactions/history.py`
- Modify: `xkeen-ui/services/module_transactions/state.py` (`write_status`), `xkeen-ui/services/module_transactions/provision.py` (`build_provision`), `xkeen-ui/services/module_transactions/executor.py:179` (статус получает `source_version`), вызовы `build_provision` в `launcher.py:52` и `scripts/module_transaction.py:197,214`
- Test: `tests/test_module_operations_history.py`

**Interfaces:**
- Produces: `history_path(state_dir) -> Path`, `environment_log_path(state_dir) -> Path`, `record_history(state_dir, status: Mapping) -> None`, `read_history(state_dir) -> list[dict]`, константы `HISTORY_LIMIT = 50`, `ENVIRONMENT_TAIL = 200`.
- `write_status`: после записи статуса, если `result` не `None`/`running`/`idle` — `record_history`; если `result == "running"` и прежний статус был другой операции — удалить `environment.log`. Обе ветки в `try/except OSError`.
- Запись истории: поля статуса `operation_id, scope, operation, module_id, version, source_version, result, error_code, error, error_detail, failed_path, started_at, finished_at, log, warnings` + `module_name` (из `MODULE_DEFINITIONS`, если есть `module_id`) + `environment` (хвост `environment.log`). Файл переписывается целиком атомарно (`_atomic_write` из `services.io.atomic`).
- `build_provision(panel_root, *, target_version=None, module_id=None, log_path: Path | None = None)`: каждый вызов дописывает в `log_path` строку `=== {phase} ===` и вывод скрипта (и при успехе, и при отказе).

- [ ] **Step 1: тесты** `tests/test_module_operations_history.py`:
  - `test_terminal_status_is_recorded` — `write_status` с `result="committed"` → `read_history` = одна запись с `operation_id`, `log`, `source_version`.
  - `test_running_status_is_not_history` — `result="running"` → `read_history == []`.
  - `test_same_operation_is_replaced_not_added` — `rolled_back`, затем тот же id `committed` → одна запись, `result == "committed"`.
  - `test_history_keeps_last_50` — 55 разных итогов → 50 записей, первая — шестая по счёту.
  - `test_broken_line_is_skipped` — в файл дописана строка `{"oper` → `read_history` отдаёт остальные.
  - `test_environment_output_goes_with_the_operation` — `build_provision(..., log_path=...)` со скриптом, печатающим 3 строки → итог содержит `environment` с `=== apply ===` и этими строками.
  - `test_environment_tail_is_limited` — 500 строк вывода → в записи 200 последних.
  - `test_new_operation_clears_environment_log` — `running` новой операции удаляет `environment.log` прошлой.
  - `test_module_name_is_kept` — `module_id="tool.terminal"` → `module_name == "Терминал и команды"`.
- [ ] **Step 2:** `python -m pytest tests/test_module_operations_history.py -q` — падают (модуля нет).
- [ ] **Step 3:** реализовать; передать `log_path=environment_log_path(state_dir)` во все три вызова `build_provision`.
- [ ] **Step 4:** зелёные новые тесты и `tests/test_module_transaction*.py tests/test_module_lifecycle.py tests/test_panel_update_*.py`.
- [ ] **Step 5:** коммит `История операций модулей: итог каждой операции и вывод подготовки окружения сохраняются`.

### Task 2: DevTools отдаёт историю как лог `updates`

**Files:**
- Modify: `xkeen-ui/services/devtools/logs.py` (`_log_targets`, `list_logs` order)
- Test: тест DevTools-логов, где сейчас проверяется `update` (найти `grep -rn '"update"' tests | grep -i log`)

**Interfaces:**
- Цель `"updates"` → `history_path(Path(_ui_state_dir()))`; `"update"` из списка целей убрать; в `order` `"updates"` на месте `"update"`.

- [ ] **Step 1: тест** `test_updates_target_points_to_history`: в списке `list_logs()` есть `updates` с путём `.../module-operations/history.jsonl` и `exists=False` без файла; имени `update` нет.
- [ ] **Step 2:** запустить — падает.
- [ ] **Step 3:** реализовать.
- [ ] **Step 4:** зелёный тест и тесты DevTools-логов.
- [ ] **Step 5:** коммит вместе с задачей 3.

### Task 3: вкладка «обновления» в «Логах панели»

**Files:**
- Modify: `xkeen-ui/static/js/features/panel_log_parser.js` (`panelLogKind`, новая `buildOperations`, ветка в `buildPanelLogRecords`), `panel_log_view.js:291` (подпись свёрнутого вывода по виду), `devtools/logs.js:139,149` (подпись файла), шапка файла-комментария разборщика
- Test: `tests/test_panel_log_parser_js.py`, `e2e/devtools_panel_logs.spec.mjs`

**Interfaces:**
- `panelLogKind('updates') === 'operations'`; уровни для вида `operations` скрыты, как у `update` (`logs.js:348`).
- `buildOperations(lines)`: каждая непустая строка — `JSON.parse`, ошибка разбора — строка пропускается. Запись: `date/time` — местное время `started_at`; `level` — `ok` для `committed`, иначе `error`; `source`/`msg` — по Global Constraints; `dur` — из `finished_at - started_at` тем же видом, что `secondsBetween`; `kv` — `Выпуск`, `Канал` (если есть в записи), `Операция`; `steps` — `log` → `[ЧЧ:ММ:СС, подпись шага]` с подписями шагов окна модулей (`Подготовка`, `Загрузка архива`, `Проверка подписи и состава`, `Замена файлов`, `Запись состояния`, `Перезапуск панели`, `Проверка панели после перезапуска`, `Готово`, `Возврат прежних файлов`); `extra` — `environment`; `raw` — исходная строка.
- Подпись файла: `{ updates: 'обновления' }`, остальные — имя как сейчас.
- Подпись свёрнутого вывода: для вида `operations` — `Вывод подготовки окружения · {n} строк`.

- [ ] **Step 1: тесты.** В `test_panel_log_parser_js.py`: удачное обновление панели (источник, `Панель обновлена до 3.0.3-beta.6`, `Выпуск 3.0.3-beta.5 → 3.0.3-beta.6`, 8 шагов, `dur == '19 с'`), неудачное (`level == 'error'`, `msg` начинается с `Не выполнено: `), установка модуля по имени, испорченная строка пропускается. В `e2e/devtools_panel_logs.spec.mjs` тест `update.log is one row per run…` заменить на `обновления: одна строка на операцию, вывод подготовки свёрнут`: кнопка файла с текстом `обновления`, 2 строки, раскрытие показывает `Выпуск`, шаги и `Вывод подготовки окружения · 3 строк`.
- [ ] **Step 2:** `python -m pytest tests/test_panel_log_parser_js.py -q` и e2e-спек — падают.
- [ ] **Step 3:** реализовать.
- [ ] **Step 4:** `npm run frontend:build`, зелёные оба теста; полный `npm run test:py` и полный e2e.
- [ ] **Step 5:** коммит задач 2–3 `«Логи панели»: вкладка «обновления» показывает историю операций вместо update.log`.

### Task 3b: подписи файлов по-русски и журнал установки (решено 26.10.2026)

**Files:**
- Modify: `xkeen-ui/services/devtools/logs.py` (цели `install` → `<каталог логов>/../xkeen-ui-install.log`, `install-previous` → тот же путь + `.previous`; цель `xkeen-ui` убрать), `xkeen-ui/static/js/features/devtools/logs.js` (`renderFiles`), `xkeen-ui/templates/devtools.html:670` (блок меню), разборщик (`panelLogKind('install'…) === 'text'`)
- Test: тест DevTools-логов, `e2e/devtools_panel_logs.spec.mjs`

**Interfaces:**
- Подписи кнопок: `core` → `Панель`, `updates` → `Обновления`, `restart` → `Xkeen`, `install` → `Установка`, `access` → `Запросы`, `ws` → `WebSocket`, `stdout` → `Вывод`, `stderr` → `Ошибки процесса`; неизвестное имя — как есть. Во всплывающей подсказке — имя файла, размер, возраст, как сейчас.
- Части после ротации (`имя.N`) и `install-previous` в шапку не выходят никогда: в меню «⋯» блок `Более ранние записи`, подписи `{Подпись}, до {д мес.}` по `mtime` (например `Панель, до 20 окт.`) и `Предыдущая установка, {д мес.}`. Блок `Пустые логи` — как был.

- [ ] **Step 1: тесты.** Python: `test_install_logs_are_listed_and_old_notes_are_not` — `install` и `install-previous` в списке с путями `xkeen-ui-install.log[.previous]`, имени `xkeen-ui` нет. e2e: `кнопки файлов подписаны по-русски, ранние части — в меню` — кнопки `Панель`, `Обновления`, `Xkeen`; `core.1` есть в меню с текстом `Панель, до`, а не в шапке.
- [ ] **Step 2:** запустить — падают.
- [ ] **Step 3:** реализовать.
- [ ] **Step 4:** зелёные; полный pytest и e2e — вместе с задачей 3.
- [ ] **Step 5:** коммит отдельно: `«Логи панели»: подписи файлов по-русски, журнал установки вместо пометок установщика`.

### Task 4: приёмка

Исполнитель операции запускается из текущей панели (`launcher.py:34`), поэтому историю обновления пишет код той версии, с которой обновляются. Локальная сборка операций с модулями не делает, только обновление панели.

- [ ] **Step 1:** поставить сборку на 45.1, в `BUILD.json` понизить версию (как при приёмке 26.10), обновиться из окна модулей до выпуска.
- [ ] **Step 2:** по SSH проверить `module-operations/history.jsonl`: одна строка, итог `committed`, шаги, `source_version`, вывод подготовки окружения. Вкладку после такого обновления не видно (в выпуске её ещё нет) — смотреть её на бете с этой работой.
- [ ] **Step 3:** записать итог в память `project_panel_logs_redesign.md`.

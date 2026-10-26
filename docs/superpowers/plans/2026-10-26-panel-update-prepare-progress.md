# Подготовка обновления панели с ходом работы — план работ

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** после нажатия «Обновить до X.Y.Z» окно открывается сразу и одной полосой из семи шагов показывает подготовку (каталог, скачивание архива с мегабайтами, проверку), останавливается на «3 из 7» с планом и продолжает ту же полосу после «Обновить».

**Architecture:** подготовка плана `panel-update` становится фоновой задачей на сервере (`PanelUpdatePreparer`), окно её запускает, опрашивает и забирает готовый план. Ход скачивания идёт обратным вызовом из `download_verified_panel_archive`, отмена — исключением из него же. Проверка архива уходит из цикла gevent в пул потоков.

**Tech Stack:** Python 3 / Flask / gevent (`run_server.py`, `patch_all`), ES-модули без фреймворка, pytest (`npm run test:py`), Playwright.

**Spec:** этот файл (раздел «Решения») и макеты https://claude.ai/artifact/X7nYAV9tRZP46WEghFtvNs, раздел «Вариант C». Замер, из которого всё выросло, — память `project_panel_update_plan_wait.md`.

## Решения (утверждены 26.10.2026)

- Одно окно `#modules-plan-confirm`, одна полоса из существующих `PROGRESS_STEPS` (7 шагов). Подготовка проходит шаги 1–3 (`prepared` «Подготовка», `downloading` «Загрузка архива», `verifying` «Проверка подписи»).
- Остановка на подтверждении: полоса «3 из 7», первые три шага `done`, **тон `is-run` (фиолетовый)**, заголовок этапа «Готово к обновлению».
- После «Обновить» окно операции для `panel-update` не откатывается ниже «4 из 7»: ранние шаги исполнителя (сверка его копии архива) рисуются как пройденные.
- Крестик закрывает окно, подготовка на сервере продолжается; новое нажатие подхватывает идущую подготовку. «Отмена» прерывает скачивание и закрывает окно.
- Повторная подготовка с архивом в кэше: шаг «Загрузка архива» сразу `done`, подпись «Архив уже скачан».
- Ошибка: шаг, на котором сорвалось, — `failed`, тон `is-bad`, строка `describeLifecycleFailure(error)`, кнопки «Проверить снова» и «Закрыть».
- Подготовка плана для модулей, профиля и отката не меняется: остаётся синхронный `POST /api/modules/operations/plan`.

## Global Constraints

- Тексты (дословно):
  - описание окна во время подготовки: `Роутер скачивает выпуск с GitHub и проверяет его. Окно можно закрыть, подготовка продолжится.`
  - этап скачивания: `{скачано} из {всего} · {скорость}/с · осталось около {N} с`, например `7,1 из 12,0 МБ · 0,6 МБ/с · осталось около 9 с`; без скорости (первый опрос) — только `{скачано} из {всего}`;
  - этап «Подготовка»: `Проверка выпуска на GitHub`; этап проверки: `Осталось несколько секунд.`; архив из кэша: `Архив уже скачан`;
  - остановка: `Готово к обновлению`, подпись `Выпуск скачан и проверен за {N} с. Файлы панели пока не тронуты.`, из кэша — `Выпуск уже был скачан и проверен. Файлы панели пока не тронуты.`;
  - кнопки подготовки: `Отмена` и погашенная `Подготовка…`.
- Мегабайты — двоичные (1 МБ = 1048576 байт), один знак после запятой, запятая как разделитель: тот же счёт, что у `formatBytes` в `render.js`.
- Опрос подготовки — с тем же `pollMs`, что опрос операции (по умолчанию 1000 мс; e2e подставляет свой).
- JS-файлы панели хранятся с CRLF — править с сохранением концов строк (память `feedback_heredoc_backslash_patches`).
- Коммиты: `git -c user.name=… -c user.email=… commit`, без трейлеров; перед коммитом `npm run inventory:refresh` после `git add` (хук pre-commit сверяет описи). Не пушить без отмашки.
- Перед e2e обязателен `npm run frontend:build`; полный pytest — `npm run test:py` из Bash.

## Review Focus

1. Пользователь закрыл окно крестиком посреди скачивания и через 10 с снова нажал «Обновить до …» — окно открывается на текущем шаге той же подготовки, второго скачивания нет. Тест — задача 2 (`test_start_joins_running_job`) и задача 5 (e2e «повторное нажатие подхватывает»).
2. Две вкладки нажали одновременно — одна подготовка, оба окна видят один ход. Покрыто тем же `test_start_joins_running_job`.
3. Ушёл с экрана модулей во время подготовки — опрос останавливается, ошибок в консоли нет, задача на сервере доходит до конца. Тест — задача 5 (e2e «уход с экрана останавливает опрос»).
4. Панель сейчас актуальна (сервер вернул план с блокером `panel_version_current`) — окно закрывается, сводка показывает «обновлений нет», как сегодня. Тест — задача 5 (e2e «актуальная панель»).
5. Сеть оборвалась на опросе хода — окно не падает, следующий опрос продолжает; после трёх подряд неудач показывается ошибка в окне. Тест — задача 5 (e2e «сбой опроса»).

---

### Task 1: ход и отмена скачивания, вынос проверки из цикла gevent

**Files:**
- Create: `xkeen-ui/services/blocking.py`
- Modify: `xkeen-ui/services/module_catalog_client.py:688-760` (`download_verified_panel_archive`, `_download_verified_asset`)
- Modify: `xkeen-ui/services/module_lifecycle.py:440-510` (`_panel_archive`, `_checked_panel_archive`, `_read_panel_archive`)
- Test: `tests/test_module_catalog_client.py`, `tests/test_blocking.py`

**Interfaces:**
- Produces: `download_verified_panel_archive(snapshot, destination_dir, *, progress: Callable[[int], None] | None = None) -> Path` — `progress(written_bytes)` после каждого куска; исключение из `progress` прерывает скачивание, `.part` удаляется, исключение уходит наружу как есть.
- Produces: `run_blocking(fn: Callable[..., T], *args, **kwargs) -> T` в `services/blocking.py`: при `gevent.monkey.is_module_patched("threading")` — `gevent.get_hub().threadpool.apply(fn, args, kwargs)`, иначе прямой вызов.
- `_read_panel_archive` вызывает `validate_panel_archive` через `run_blocking`.

- [ ] **Step 1: тесты**

```python
# tests/test_module_catalog_client.py
def test_panel_archive_download_reports_cumulative_bytes(...):
    seen = []
    path = client.download_verified_panel_archive(snapshot, tmp_path / "in", progress=seen.append)
    assert seen == sorted(seen) and seen[-1] == path.stat().st_size

def test_panel_archive_download_stops_when_progress_raises(...):
    class Stop(Exception): pass
    def stop(n):
        if n > 0: raise Stop()
    with pytest.raises(Stop):
        client.download_verified_panel_archive(snapshot, tmp_path / "in", progress=stop)
    assert not list((tmp_path / "in").glob("*.part")) and not list((tmp_path / "in").glob(".*.part"))

# tests/test_blocking.py
def test_run_blocking_calls_directly_without_gevent(monkeypatch):
    monkeypatch.setattr(blocking, "_threading_patched", lambda: False)
    assert blocking.run_blocking(lambda a, b=0: a + b, 2, b=3) == 5

def test_run_blocking_uses_hub_threadpool_under_gevent(monkeypatch):
    calls = []
    hub = SimpleNamespace(threadpool=SimpleNamespace(apply=lambda fn, args, kwargs: calls.append((fn, args, kwargs)) or "pooled"))
    monkeypatch.setattr(blocking, "_threading_patched", lambda: True)
    monkeypatch.setattr(blocking, "_hub", lambda: hub)
    assert blocking.run_blocking(len, "abc") == "pooled" and calls[0][1] == ("abc",)
```

Тестовая транспортная заглушка из `test_module_catalog_client.py` должна отдавать архив хотя бы двумя кусками — если она пишет одним `write`, разбить.

- [ ] **Step 2:** `python -m pytest tests/test_module_catalog_client.py tests/test_blocking.py -q` — новые тесты падают.
- [ ] **Step 3:** реализовать. `progress` вызывать в `HashingWriter.write` после `written += len(chunk)`. В `services/blocking.py` вынести `_threading_patched()` и `_hub()` отдельными функциями, чтобы их можно было подменить в тесте. `_panel_archive(client, snapshot, progress=None)` передаёт `progress` в скачивание; `_checked_panel_archive(..., progress=None)` прокидывает его дальше.
- [ ] **Step 4:** те же тесты зелёные, плюс `python -m pytest tests/test_module_lifecycle.py tests/test_panel_update_*.py -q`.
- [ ] **Step 5:** коммит `Скачивание архива панели сообщает ход и отменяется, проверка архива не держит цикл gevent`.

### Task 2: фоновая подготовка плана обновления панели

**Files:**
- Create: `xkeen-ui/services/panel_update_prepare.py`
- Modify: `xkeen-ui/services/module_lifecycle.py` (`plan`, `_plan_and_payload`, `_full_scope_plan_and_payload` получают `progress`)
- Test: `tests/test_panel_update_prepare.py`

**Interfaces:**
- Consumes: `progress`-параметр задачи 1.
- Produces: `ModuleLifecycleService.plan(operation, module_id=None, *, progress: PrepareSink | None = None) -> dict`, где `PrepareSink = Callable[[str, int, int], None]`, вызывается как `sink(phase, done_bytes, total_bytes)` с `phase` из `"catalog" | "downloading" | "cached" | "verifying"`. `"catalog"` — перед `get_catalog`; `"cached"` — архив взят из кэша; `"downloading"` — на каждом куске (`total_bytes` = `size` из дескриптора каталога); `"verifying"` — перед `validate_panel_archive`.
- Produces: `class PanelUpdatePreparer(service, *, clock=time.time, spawn=None)` с методами:
  - `start() -> dict` — запускает подготовку или возвращает идущую;
  - `status(prepare_id: str) -> dict`;
  - `cancel(prepare_id: str) -> dict`.
  Все три отдают снимок `{"prepare_id", "state": "running"|"ready"|"failed"|"cancelled", "phase", "downloaded_bytes", "total_bytes", "cached": bool, "started_at", "finished_at", "plan": dict|None, "error": {"code","message"}|None}`. Неизвестный id — `ModuleLifecycleError("panel_prepare_unknown", ..., status=404)`. `spawn` по умолчанию — `threading.Thread(target=..., daemon=True, name="panel-update-prepare").start`.
- Хранится только последняя задача. `start()` при `state == "running"` возвращает её; иначе начинает новую.
- Отмена: `cancel()` ставит флаг; sink на следующем куске бросает `PanelPrepareCancelled` (внутреннее исключение модуля). Задача ловит его, вызывает `service._drop_archive_cache()` и уходит в `cancelled`. Отмена уже закончившейся задачи ничего не делает и возвращает её снимок.
- Сбой: `ModuleLifecycleError` → `error = {code, message}`; любое другое исключение → `{"code": "panel_prepare_failed", "message": "panel update could not be prepared"}` плюс запись в лог.

- [ ] **Step 1: тесты** (`spawn=lambda fn: fn()` — синхронно; сервис через `make_service` из `test_module_lifecycle.py`, вынесенный в общий хелпер или импортированный)

```python
def test_prepare_reports_phases_and_returns_the_plan(tmp_path):
    snap = preparer.start()
    assert snap["state"] == "ready" and snap["plan"]["target_version"] == "2.11.0"
    assert phases[0] == "catalog" and "downloading" in phases and phases[-1] == "verifying"
    assert snap["downloaded_bytes"] == snap["total_bytes"] > 0

def test_prepare_with_cached_archive_skips_download(tmp_path):
    preparer.start(); snap = preparer.start()
    assert snap["cached"] is True and "downloading" not in second_run_phases

def test_cancel_during_download_drops_partial_archive(tmp_path):
    # заглушка скачивания вызывает preparer.cancel(id) на первом куске
    assert snap["state"] == "cancelled" and not any(service.archive_cache_dir.glob("*"))

def test_start_joins_running_job(tmp_path):
    # spawn сохраняет target и не запускает
    first = preparer.start(); second = preparer.start()
    assert first["prepare_id"] == second["prepare_id"] and spawned == 1

def test_prepare_failure_keeps_lifecycle_error_code(tmp_path):
    assert snap["state"] == "failed" and snap["error"]["code"] == "catalog_archive_unavailable"

def test_status_of_unknown_prepare_is_404(tmp_path):
    with pytest.raises(ModuleLifecycleError) as e: preparer.status("nope")
    assert e.value.status == 404 and e.value.code == "panel_prepare_unknown"

def test_current_panel_is_ready_with_blocker_plan(tmp_path):
    assert snap["state"] == "ready" and snap["plan"]["blockers"][0]["code"] == "panel_version_current"
```

- [ ] **Step 2:** `python -m pytest tests/test_panel_update_prepare.py -q` — падают (модуля нет).
- [ ] **Step 3:** реализовать. Состояние задачи — под `threading.Lock`; снимок отдавать копией. `local_demo` идёт через `service.plan` как есть: sink просто не вызывается, и задача сразу `ready`.
- [ ] **Step 4:** зелёные `tests/test_panel_update_prepare.py tests/test_module_lifecycle.py`.
- [ ] **Step 5:** коммит `Подготовка плана обновления панели — фоновая задача с этапами и отменой`.

### Task 3: ручки подготовки

**Files:**
- Modify: `xkeen-ui/routes/modules.py` (рядом с `api_modules_operation_plan`, строка ~275), `xkeen-ui/routes/__init__.py:172` (создать `PanelUpdatePreparer(lifecycle_service)` и передать в блюпринт тем же путём, что `lifecycle_service`)
- Test: `tests/test_module_lifecycle_routes.py`

**Interfaces:**
- `POST /api/modules/panel/prepare` → `200 {"ok": true, **snapshot}`; тело пустое, лишние поля — `400 unsupported_lifecycle_fields` через `lifecycle_body(allowed=set(), required=set())`.
- `GET /api/modules/panel/prepare/<prepare_id>` → `200 {"ok": true, **snapshot}` / `404 panel_prepare_unknown`.
- `POST /api/modules/panel/prepare/<prepare_id>/cancel` → `200 {"ok": true, **snapshot}`.
- Ответы — через `lifecycle_response` (единый перевод `ModuleLifecycleError`).

- [ ] **Step 1: тесты** — `test_panel_prepare_routes_start_poll_and_cancel` (подставной preparer записывает вызовы, проверяются коды и `prepare_id` в ответах), `test_panel_prepare_unknown_is_404`, `test_panel_prepare_rejects_body_fields`.
- [ ] **Step 2:** `python -m pytest tests/test_module_lifecycle_routes.py -q` — новые падают.
- [ ] **Step 3:** реализовать ручки.
- [ ] **Step 4:** зелёные `tests/test_module_lifecycle_routes.py`, затем `npm run test:py` целиком (сторожевые тесты описей и маршрутов могут потребовать `npm run inventory:refresh`).
- [ ] **Step 5:** коммит `Ручки подготовки обновления панели: запуск, ход, отмена`.

### Task 4: окно — подготовка, остановка на «3 из 7», продолжение полосы

**Files:**
- Modify: `xkeen-ui/static/js/features/module_manager/api.js` (три метода)
- Modify: `xkeen-ui/static/js/features/module_manager/render.js` (`progressBox` → общий отрисовщик; `renderPrepareDialog`; `renderPlan` с `prepared`; зажим в `renderOperationDialog`)
- Modify: `xkeen-ui/static/js/features/module_manager/controller.js` (`requestPlan` для `panel-update`, опрос подготовки, `recheckPlan`, уход с экрана)

**Interfaces:**
- Consumes: ручки задачи 3, снимок из задачи 2.
- Produces (api.js): `startPanelPrepare()`, `loadPanelPrepare(id)`, `cancelPanelPrepare(id)`.
- Produces (render.js):
  - `renderPrepareDialog(dialog, snapshot, { speed = null } = {})` — `speed` в байтах/с считает контроллер по двум последним опросам;
  - `renderPlan(dialog, plan, names, { editorChange, prepared = null })`, где `prepared = { seconds: number, cached: boolean } | null`: для `panel-update` с `prepared` под планом рисуется полоса «3 из 7», тон `is-run`, этап «Готово к обновлению».
- Соответствие фаз шагам: `catalog` → индекс 0, `downloading` → 1 (доля полосы `(1 + downloaded/total) / 7`), `cached` → 1 сразу `done`, переход к 2 с подписью «Архив уже скачан», `verifying` → 2. При `failed` шаг текущей фазы — `failed`, тон `is-bad`.
- `renderOperationDialog`: при `status.operation === 'panel-update'` и `result === 'running'` пройденное считается как `Math.max(stepIndex(status.step), 3)`; этап — подпись этого шага.
- Контроллер: `dialogMode` получает значение `'prepare'`. В этом режиме `closePlan` по крестику или Esc закрывает окно и останавливает опрос, на сервере ничего не отменяет. Кнопка «Отмена» зовёт `cancelPanelPrepare`, потом закрывает окно. На `ready` дальше работает существующая ветка `requestPlan` (`panel_version_current` → `state.update`, иначе `renderPlan` с `prepared`). `recheckPlan` для `panel-update` снова идёт через подготовку. Три подряд сбоя опроса — `renderPlanError` с `describeLifecycleFailure`, остальные сбои молча ждут следующего опроса.

- [ ] **Step 1:** реализовать api.js и render.js. `progressBox` разделить на сбор данных о шагах и общий отрисовщик `stepsBox({ phase, note, count, share, stateOf, tone })`; `progressBox` и подготовка строятся на нём.
- [ ] **Step 2:** реализовать контроллер.
- [ ] **Step 3:** `npm run frontend:build` — без ошибок, затем `npx playwright test e2e/modules_manager_summary.spec.mjs e2e/modules_manager_screen.spec.mjs e2e/modules_manager_operations.spec.mjs --workers=1`. Сейчас эти спеки подставляют `**/api/modules/operations/plan` для `panel-update` и упадут — это ожидаемо, их переводит задача 5.
- [ ] **Step 4:** коммит вместе с задачей 5 (окно без переведённых спеков в ветку не идёт).

### Task 5: e2e — новое окно и перевод старых спеков

**Files:**
- Modify: `e2e/modules_manager_support.mjs` — `installPanelPrepareRoutes(page, { steps, plan, onCancel })`: `steps` — массив снимков, которые по очереди отдаёт `GET …/prepare/<id>`, последний повторяется; `POST …/prepare` отдаёт первый.
- Create: `e2e/modules_panel_update_prepare.spec.mjs`
- Modify: спеки, где `panel-update` шёл через `operations/plan`: `modules_manager_summary.spec.mjs`, `modules_manager_screen.spec.mjs`, `modules_manager_operations.spec.mjs`, `modules_manager_recovery.spec.mjs`, `notification_center.spec.mjs` (найти по `grep -n "panelUpdatePlan\|panel-update" e2e/*.mjs`).

- [ ] **Step 1: новые тесты** в `modules_panel_update_prepare.spec.mjs`:
  - `окно открывается сразу и показывает загрузку` — до ответа `ready`: диалог «Обновить панель до 2.11.0» виден, `output` = `2 из 7`, текст содержит `из 12,0 МБ`, кнопка `Подготовка…` погашена;
  - `остановка на подтверждении` — после `ready`: `2.10.0 → 2.11.0`, `Готово к обновлению`, `3 из 7`, у `.modules-plan-progress-box` класс `is-run`, кнопка `Обновить` активна;
  - `архив из кэша` — снимок с `cached: true`: `Выпуск уже был скачан и проверен.`;
  - `Отмена зовёт отмену и закрывает окно` — `onCancel` вызван один раз, диалог скрыт;
  - `повторное нажатие подхватывает подготовку` — крестик, снова кнопка: `POST /prepare` вызван дважды, `prepare_id` тот же, окно на том же шаге;
  - `ошибка на шаге` — снимок `failed` на `downloading`: второй `li` с `data-state="failed"`, видна кнопка `Проверить снова`;
  - `актуальная панель` — `ready` с блокером `panel_version_current`: диалог закрыт, сводка как в существующем тесте `checks the signed catalog…`;
  - `уход с экрана останавливает опрос` — переход на `/devtools`, счётчик `GET /prepare/<id>` не растёт 2 с;
  - `сбой опроса` — один ответ 500 посреди шагов, окно доходит до `ready`;
  - `операция не откатывается ниже 4 из 7` — после «Обновить» статус `running` со `step: "downloading"`: `output` = `4 из 7`.
- [ ] **Step 2:** перевести старые спеки на `installPanelPrepareRoutes` (снимок `ready` с `panelUpdatePlan`).
- [ ] **Step 3:** `npm run frontend:build`, затем `npx playwright test e2e/modules_panel_update_prepare.spec.mjs e2e/modules_manager_*.spec.mjs e2e/notification_center.spec.mjs --workers=1` — все зелёные.
- [ ] **Step 4:** полный e2e (ориентир из памяти: 0 failed при 12 skipped) и `npm run test:py`.
- [ ] **Step 5:** коммит задач 4–5: `Окно обновления панели показывает подготовку одной полосой и останавливается на подтверждении`.

### Task 6: приёмка на 45.1

- [ ] **Step 1:** сверить `git log <версия роутера>..HEAD` на чужие коммиты (память `feedback_check_foreign_commits_before_router_install`), поставить сборку на 45.1.
- [ ] **Step 2:** чтобы было что обновлять, переключить канал или поставить сборку на версию ниже последнего выпуска. Проверить вживую: окно сразу, мегабайты растут, «3 из 7» фиолетовым, крестик и повторное нажатие, «Отмена» посреди скачивания (кэш пуст: `ls <update_dir>/<PANEL_ARCHIVE_CACHE_DIRNAME>`), второе нажатие с архивом в кэше.
- [ ] **Step 3:** пока идёт проверка архива, во второй вкладке открыть DevTools — страница отвечает без секундной паузы.
- [ ] **Step 4:** записать итог в память `project_panel_update_plan_wait.md`.

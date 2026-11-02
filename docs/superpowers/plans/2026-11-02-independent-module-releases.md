# Независимый выпуск модулей: план работ

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** выпускать и обновлять `tool.advanced-diagnostics` отдельно от панели: подписанный каталог у выпуска панели, транзакция `update`, кнопка «Обновить», проверяемый CI выпуск.

**Architecture:** граница core и модуля на фронте идёт через постоянные имена в importmap, поэтому файлы core не зависят от хэшей модуля. Каталог `module-updates.json` лежит в GitHub Release панели `V` и подходит только ей. Запись каталога несёт список файлов модуля, а на роутере фактическая принадлежность складывается из карты панели и `module-ownership-overrides.json`.

**Tech Stack:** Python 3.11 (Flask, cryptography), Vite, Playwright, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-01-independent-module-releases-design.md`

**Границы плана:** шаги 1–7 спецификации. Шаг 8 — остановка и разговор с владельцем. Шаг 9 здесь не расписан: что отделять дальше, зависит от шага 8. Xray и Mihomo в этот план не входят.

## Global Constraints

- Рабочая ветка `pre-release`, rebase запрещён, автор коммита: `git -c user.name="olmer2002" -c user.email="olmer2002@gmail.com" commit -m "..."`, без трейлеров, сообщения по-русски, без слова «Happ».
- Не пушить, не ставить теги и не выпускать без явной просьбы владельца. Установка на роутер — только по отдельной команде; пароль спросить у владельца и нигде не записывать.
- Новая правка начинается с падающего теста. Файлы фронта — CRLF, Python — LF. Скрипты с обратными слэшами кладутся файлом, не heredoc.
- Перед e2e обязательно `npm run frontend:build`. Полный pytest — `npm run test:py`. Описи — только `npm run inventory:refresh`, вручную не сливать.
- Вид окна меняется только после макетов с настоящей панели и выбора владельца.
- Подпись: Ed25519, ключ `release-2026`, тот же конверт, что у `catalog.json.sig`. URL строит клиент через `official_release_asset_url`; ветки и пользовательские адреса запрещены.
- Каталог свежий 86400 секунд, устаревший используется только при сбое транспорта. 404 — нормальное состояние «обновлений нет».
- Стартовая версия каждого модуля — `1.0.0`. У `core` своей версии нет.
- Теги `module-<id>-X.Y.Z`, ветки `module/<id>-<версия>`. Бет модулей нет, отзыва выпуска нет, выбора старой версии нет.
- Локальные сборки (`<тег>+local.<sha>`) только смотрят, операций над модулями не выполняют.
- Python-код, который работает при восстановлении после сбоя (`plan_from_json`, журнал), не импортирует `cryptography` на верхнем уровне.

## Уточнения спецификации после сверки с кодом

Спецификация молчит об этих местах или расходится с кодом. Решения приняты здесь, владельцу стоит их проверить.

1. **`catalog.json` не меняется.** `validate_catalog_document` требует `entry["version"] == release`, а старые панели читают каталог новых выпусков при `panel-update`. Значит, записи выпуска сохраняют версию панели, а версия модуля берётся из `module-versions.json` панели. Сравнение `update_available` идёт только между версиями модулей.
2. **Запись `module-updates.json` — полная запись каталога плюс `ownership`.** В примере спецификации нет `channel`, `panel_api`, `module_api`, а `_validate_manifest` их сверяет. `ownership` нужен, чтобы план знал файлы до скачивания: `executor.py` сверяет их с архивом.
3. **`repair` и `install` могут привести модуль к новой версии.** Если установлена базовая версия, а в каталоге есть обновление, `repair` кладёт новейшую запись и записывает версию, как `update`. Иначе спецификация («берут именно её») давала бы новые файлы при старой записи о версии.
4. **Если установленная версия выше, чем запись, которую удалось получить, `install` и `repair` отказывают** с кодом `module_update_catalog_unavailable`. Иначе при сбое сети `repair` молча откатил бы правку.
5. **Переустановка из `install.sh` очищает `module-ownership-overrides.json`** и версии. Спецификация говорит только про базовые версии установщика, но старые overrides указывали бы на удалённые файлы.
6. **`profile-transition` работает по фактической принадлежности.** Сейчас `installed_panel_listing` читает только карту панели. С ней смена профиля посчитала бы обновлённые файлы лишними и вернула старые.
7. **Копия `module-versions.json` кладётся в архив при сборке и на диске разработки не появляется,** как `module-ownership.json`. Без неё панель показывает `1.0.0`.
8. **`xk-core/*` делается как механизм, но список пуст:** окно диагностики не импортирует core. Первая запись появится с первым модулем, которому она нужна.
9. **Сбой проверки каталога обновлений не ломает экран модулей.** Загрузка `module-updates.json` и подписи не атомарна, поэтому несовпадение подписи при получении с сети отвечает кэшем или «обновлений нет» и показывает `stale_reason`. Такой документ не принимается.
10. **Модуль, добавленный при смене профиля, ставится базовой версией из архива панели.** После этого экран предлагает обновление.

## Review Focus

- `repair` без сети на обновлённом модуле: правка не откатывается, пользователь видит отказ (задача 8).
- Переустановка `install.sh` поверх обновлённого модуля: панель открывается, overrides пусты, версии базовые (задача 9).
- Обрыв питания посреди `update` и восстановление при загрузке, в том числе журнал старой панели без новых полей `Plan` (задача 10).
- Выключенный модуль получает обновление и остаётся выключенным, а importmap его не содержит (задачи 4 и 10).
- Публикация каталога в момент чтения: `.json` и `.sig` разных публикаций, 404 подписи — экран работает, документ не принят, `serial` не меняется (задача 7).

---

## Этап 1. Версии модулей (шаг 1 спецификации)

### Task 1: `module-versions.json` и чтение версий

**Files:**
- Create: `module-versions.json`, `xkeen-ui/services/module_versions.py`, `tests/test_module_versions.py`
- Modify: `xkeen-ui/services/module_registry.py`, `scripts/build_modular_panel_release.py` (`_panel_members`, `build_panel_archive`, `_KNOWN_PACKAGE_FILES`), `scripts/build_user_archive.py`, `xkeen-ui/scripts/module_profile_install.py` (`STATE_FILES` не меняется, файл копируется как `module-ownership.json`)

**Interfaces:**
- Produces: `MODULE_VERSIONS_FILENAME = "module-versions.json"`, `BASE_MODULE_VERSION = "1.0.0"`; `read_panel_module_versions(panel_root: Path) -> dict[str, str]`; `read_installed_module_versions(state_dir: Path, panel_root: Path) -> dict[str, str]`.
- Формат `module-installed.json`: к `{"schema_version": 1, "modules": {...}}` добавляется необязательный ключ `"versions": {"<id>": "X.Y.Z"}`. `read_installed_modules` его не читает и работать продолжает.

- [ ] **Step 1: Написать падающие тесты**

```python
def test_module_versions_file_covers_every_module_except_core():
    data = json.loads((REPO / "module-versions.json").read_text(encoding="utf-8"))
    assert set(data) == set(MODULE_IDS) - {"core"}
    assert set(data.values()) == {"1.0.0"}

def test_missing_copy_reads_base_version(tmp_path):
    assert read_panel_module_versions(tmp_path)["tool.files"] == "1.0.0"

def test_installed_version_wins_over_panel_copy(tmp_path):
    write_json(tmp_path / "module-versions.json", {"tool.files": "1.0.0"})
    write_json(tmp_path / "module-installed.json", {"schema_version": 1, "modules": {"tool.files": True}, "versions": {"tool.files": "1.0.3"}})
    assert read_installed_module_versions(tmp_path, tmp_path)["tool.files"] == "1.0.3"

def test_panel_archive_carries_generated_copy(tmp_path):
    # собрать маленькое дерево через build_panel_archive и прочитать член xkeen-ui/module-versions.json
    ...

def test_registry_reports_installed_version(tmp_path):
    # реестр на дереве с versions: tool.files == 1.0.3, версия core равна версии панели
    ...
```

- [ ] **Step 2:** `python -m pytest tests/test_module_versions.py -q` — падает на отсутствии модуля.
- [ ] **Step 3: Реализовать.** `read_panel_module_versions` при отсутствии или порче файла возвращает базовую версию для всех id. Выдача реестра заменяет `version` на установленную, а у `core` ставит версию панели из `BUILD.json`. Константа `REGISTRY_VERSION` остаётся как версия формата реестра в поле `registry_version`, в `MODULE_DEFINITIONS` она больше не значит версию модуля. Копия добавляется в архивы байтами из корня репозитория, как `OWNERSHIP_MAP_FILENAME`.
- [ ] **Step 4:** тесты зелёные, `python -m pytest tests/test_module_registry.py tests/test_build_user_archive_ownership_map.py tests/test_modular_panel_ownership_map.py -q` зелёные.
- [ ] **Step 5: Commit** — «Своя версия у каждого модуля: module-versions.json и версия установленного модуля».

### Task 2: Версия на экране и контракт этапа 8

**Files:**
- Modify: `xkeen-ui/services/module_lifecycle.py` (`available`, `installed`), `xkeen-ui/static/js/features/module_manager/render.js`, `scripts/generate_modular_panel_stage8_contract.py`, `docs/modular-panel-stage8-contract.md`, `docs/modular-panel-stage8-contract.json`
- Test: `tests/test_module_lifecycle.py`, `tests/test_modular_panel_stage8_contract.py`, `tests/test_module_manager_ui.py`

**Interfaces:**
- Produces: каждая запись `available()["modules"]` получает `module_version: str` и `installed_version: str | None`. Поле `version` остаётся версией записи каталога.

- [ ] **Step 1: Тест:** запись `available()` при каталоге выпуска `3.1.0` даёт `version == "3.1.0"`, `module_version == "1.0.0"`; контракт больше не содержит `equal to the installed panel release` и фразу про «всегда `false`».
- [ ] **Step 2:** тесты падают.
- [ ] **Step 3:** обновить `available()`, в `render.js` показывать `module_version`, поправить генератор и перегенерировать контракт.
- [ ] **Step 4:** тесты зелёные, `npx playwright test e2e/modules_manager_screen.spec.mjs e2e/modules_manager_summary.spec.mjs` зелёные после `npm run frontend:build`.
- [ ] **Step 5: Commit** — «Версия модуля на экране модулей и в контракте этапа 8».

## Этап 2. Граница диагностики (шаг 2)

### Task 3: DevTools переходит в core

**Files:**
- Modify: `xkeen-ui/scripts/module_profile_install.py` (`owner`, `INSTALL_MARKERS`), `scripts/build_modular_panel_release.py` (`_PACKAGE_OWNER_OVERRIDES`), `xkeen-ui/services/module_registry.py` (`_MODULE_INSTALL_MARKERS`, описание модуля и `core`), `xkeen-ui/routes/pages.py:366-402,604`, `xkeen-ui/routes/devtools.py` (импорт `system_resources_history.zones`)
- Test: `tests/test_modular_panel_ownership_map.py`, `tests/test_module_registry.py`, новый `tests/test_diagnostics_module_boundary.py`, `e2e/devtools_panel_summary.spec.mjs`

**Interfaces:**
- Produces: новые метки `tool.advanced-diagnostics` — `routes/system_resources.py` и `static/js/features/resource_monitor.js` (в `_MODULE_INSTALL_MARKERS` с префиксом `xkeen-ui/`).
- `core.frontend_bundles` дополняется `devtools-page`, `core.navigation_views` — `devtools`; у модуля `frontend_bundles=("diagnostics-panel",)`, `navigation_views=()`.

- [ ] **Step 1: Падающие тесты**

```python
def test_devtools_page_belongs_to_core():
    for path in ("templates/devtools.html", "static/js/pages/devtools.entry.js", "static/js/features/devtools/update.js", "routes/devtools.py"):
        assert owner(path) == "core"

def test_diagnostics_window_belongs_to_module():
    for path in ("static/js/features/resource_monitor.js", "static/js/features/resource_monitor/dashboard.js",
                 "routes/system_resources.py", "services/system_resources_history/collector.py",
                 "templates/panel/modals/diagnostics.html"):
        assert owner(path) == "tool.advanced-diagnostics"

def test_shared_diagnostics_services_stay_in_core():
    ownership = build_module_ownership(REPO)
    for path in ("services/router_diagnostics.py", "services/system_resources.py", "services/system_resources_history/sensors.py"):
        assert path in ownership["core"]

def test_devtools_page_opens_without_diagnostics_module(app_without_diagnostics):
    response = app_without_diagnostics.get("/devtools")
    assert response.status_code == 200

def test_panel_links_devtools_without_diagnostics_module(app_without_diagnostics):
    config = panel_page_config(app_without_diagnostics)
    assert "devtools" in config["sections"]["supported"]
    assert config["flags"]["hasDiagnostics"] is False
```

Имена `sections.supported` и `flags.hasDiagnostics` сверить с `pages.py:384-402` при написании теста. Фикстура `app_without_diagnostics`: приложение с `modules.json`, где модуль выключен.

- [ ] **Step 2:** тесты падают.
- [ ] **Step 3: Реализовать.** В `owner()` убрать все ветки `devtools` → модуль (фронт-сборка, `static/js/`, `templates/`), добавить токен `resource_monitor` в ветку `frontend-build` и в `static/js/`. `templates/panel/slots/resource_monitor_unavailable.html` остаётся в core: он показывает заглушку без модуля. `services/router_diagnostics.py`, `services/system_resources.py`, `services/system_resources_history/sensors.py` записать в `_PACKAGE_OWNER_OVERRIDES` как core и в исключения `owner()`. В `pages.py` маршрут `/devtools` и секция `devtools` становятся безусловными. Импорт `zones` в `routes/devtools.py` остаётся ленивым и обёрнут так, что без модуля отвечает пустым списком зон. Новое описание модуля: «Окно диагностики роутера: графики, история и события.»
- [ ] **Step 4:** `npm run test:py` зелёный; `npm run frontend:build`, затем `npx playwright test e2e/devtools_panel_summary.spec.mjs e2e/router_resource_dashboard.spec.mjs` зелёные.
- [ ] **Step 5:** `npm run inventory:refresh`. **Commit** — «DevTools переходит в core, модуль диагностики — окно и сбор истории».

### Task 4: Importmap и отдельный проход сборки

**Files:**
- Create: `vite.module.config.mjs`, `scripts/build_frontend_modules.mjs`, `xkeen-ui/services/frontend_importmap.py`, `tests/test_frontend_importmap.py`
- Modify: `vite.config.mjs`, `package.json` (`frontend:build`), `scripts/verify_frontend_build.mjs`, `xkeen-ui/templates/_codemirror6_importmap.html`, `xkeen-ui/routes/ui_assets.py` (`_IMMUTABLE_ASSET_ROOTS`, глобал шаблона), `xkeen-ui/static/js/pages/panel.diagnostics.bundle.js`, `xkeen-ui/scripts/module_profile_install.py` (`owner`, `_frontend_files`), `scripts/build_user_archive.py` (проверить, что `.gz` появляются в `modules/`)
- Test: `tests/test_frontend_importmap.py`, `tests/test_modular_panel_ownership_map.py`, `e2e/router_resource_dashboard.spec.mjs`

**Interfaces:**
- Produces: `SEPARATE_MODULES = {"tool.advanced-diagnostics": {"entry": "js/features/resource_monitor.js"}}` в `vite.module.config.mjs`.
- `build_module_importmap(panel_root: Path, active_module_ids: Iterable[str] | None) -> dict[str, str]`: ключи `xk-module/<id>`, значения — пути от `static/`. Манифест — `static/frontend-build/.vite/module.<id>.json`, файл — запись с `isEntry: true`, результат `frontend-build/modules/<id>/<файл>`. Кэш по `(путь, st_mtime_ns)`.
- `build_core_importmap(manifest: Mapping[str, Any], public_entries: Mapping[str, str]) -> dict[str, str]`: ключи `xk-core/<путь>`.
- `SOURCE_FALLBACKS = {"tool.advanced-diagnostics": "js/features/resource_monitor.js"}` — используется, когда манифеста нет, а исходник есть: панель умеет работать без сборки (мост `frontend_page_entry_url`).

- [ ] **Step 1: Падающие тесты**

```python
def test_importmap_lists_active_built_module(tmp_path):
    lay_module_manifest(tmp_path, "tool.advanced-diagnostics", "resource_monitor-AbCd1234.js")
    assert build_module_importmap(tmp_path, {"core", "tool.advanced-diagnostics"}) == {
        "xk-module/tool.advanced-diagnostics": "frontend-build/modules/tool.advanced-diagnostics/resource_monitor-AbCd1234.js",
    }

def test_switched_off_module_is_absent(tmp_path):
    lay_module_manifest(tmp_path, "tool.advanced-diagnostics", "resource_monitor-AbCd1234.js")
    assert build_module_importmap(tmp_path, {"core"}) == {}

def test_removed_module_is_absent_without_error(tmp_path):
    assert build_module_importmap(tmp_path, {"core", "tool.advanced-diagnostics"}) == {}

def test_source_fallback_without_build(tmp_path):
    (tmp_path / "static/js/features").mkdir(parents=True)
    (tmp_path / "static/js/features/resource_monitor.js").write_text("", encoding="utf-8")
    assert build_module_importmap(tmp_path, {"tool.advanced-diagnostics"}) == {
        "xk-module/tool.advanced-diagnostics": "js/features/resource_monitor.js",
    }

def test_module_assets_are_immutable():
    assert is_hashed_build_asset_filename("frontend-build/modules/tool.advanced-diagnostics/resource_monitor-AbCd1234.js")

def test_module_build_files_belong_to_module():
    assert owner("static/frontend-build/modules/tool.advanced-diagnostics/x-AbCd1234.js") == "tool.advanced-diagnostics"
    assert owner("static/frontend-build/.vite/module.tool.advanced-diagnostics.json") == "tool.advanced-diagnostics"
    assert owner("static/frontend-build/.vite/manifest.build.json") == "core"

def test_rendered_importmap_is_valid_json(client):
    html = client.get("/").get_data(as_text=True)
    assert json.loads(extract_importmap(html))["imports"]["xk-module/tool.advanced-diagnostics"].endswith(".js")
```

- [ ] **Step 2:** тесты падают.
- [ ] **Step 3: Реализовать сборку.** `vite.config.mjs`: `isExternalImport` дополнительно принимает `/^xk-module\//`. Добавить пустой `CORE_PUBLIC_ENTRIES = {}`. `vite.module.config.mjs` читает `XK_MODULE_ID`, берёт вход из `SEPARATE_MODULES`, считает внешними `xk-core/*`, `xk-module/*` и `EXTERNAL_IMPORT_SPECIFIERS` (вынести общий список экспортом), `outDir` — `static/frontend-build/modules/<id>/`, `emptyOutDir: true`, манифест пишет внутрь `outDir`. `build_frontend_modules.mjs` запускает проход для каждого модуля и переносит манифест в `static/frontend-build/.vite/module.<id>.json`. В `frontend:build` он идёт сразу после `vite build`, до `sync_frontend_build_manifest.py`.
- [ ] **Step 4: Реализовать подключение.** Вставить строки в существующий блок `_codemirror6_importmap.html` так, чтобы JSON остался верным; шаблон получает функцию через `add_template_global`. Активные модули берутся из реестра запроса, как в `pages.py`. `panel.diagnostics.bundle.js`: `const mod = await import('xk-module/tool.advanced-diagnostics');`. `_IMMUTABLE_ASSET_ROOTS` дополняется `f"{_BUILD_DIRNAME}/modules/"`. `rebuild_frontend_manifests` и `_MANIFEST_PATHS` не меняются.
- [ ] **Step 5: Проверка.** `npm run frontend:build`; `npm run archive:user:skip-build` и в архиве есть `modules/tool.advanced-diagnostics/*.js` с `.gz`. Затем два раза: правка строки в `resource_monitor/view.js`, сборка, сравнение деревьев `static/frontend-build` — вне `modules/tool.advanced-diagnostics/` и `.vite/module.tool.advanced-diagnostics.json` отличий 0. Правку откатить.
- [ ] **Step 6:** `npx playwright test e2e/router_resource_dashboard.spec.mjs e2e/resource_monitor_charts.spec.mjs e2e/resource_monitor_visibility.spec.mjs e2e/resource_monitor_perf.spec.mjs` зелёные, `npm run test:py` зелёный.
- [ ] **Step 7:** `npm run inventory:refresh`. **Commit** — «Окно диагностики собирается отдельно и подключается через importmap».

### Task 5: Сторожа границы и отсутствие модуля

**Files:**
- Create: `tests/test_module_boundaries.py`, `e2e/diagnostics_module_absent.spec.mjs`
- Modify: `e2e/panel_module_load_recovery.spec.mjs`

**Interfaces:**
- Consumes: `owner`, `SEPARATE_MODULES` (таблица дублируется в тесте чтением `vite.module.config.mjs` регуляркой).

- [ ] **Step 1: Тесты**

```python
def test_no_static_import_crosses_a_separated_module_boundary():
    # обойти static/js и frontend-build: файл core не импортирует статически файлы модуля,
    # файл модуля не импортирует статически файлы core и chunk-имена assets/*
    assert offenders == []

def test_core_contains_no_module_marked_files():
    # файлы core с признаками resource_monitor/system_resources_history; исключения перечислены явно:
    assert offenders - ALLOWED == set()
    assert ALLOWED == {"templates/panel/slots/resource_monitor_unavailable.html",
                       "services/system_resources.py", "services/system_resources_history/sensors.py",
                       "services/router_diagnostics.py"}
```

E2E: при выключенном модуле (стенд с `modules.json`, где `tool.advanced-diagnostics` выключен; образец разных наборов модулей — `e2e/file_manager_terminal_controls.spec.mjs`) `/` и `/devtools` открываются, в консоли нет ошибки `xk-module`, входа в окно нет. В `panel_module_load_recovery` — случай: файл модуля отдаёт 404, показано сообщение с кнопками «Повторить» и «Обновить страницу».

- [ ] **Step 2:** проверить, что сторожа ловят нарушение: временно добавить статический импорт `resource_monitor.js` в файл core, тест падает, правку убрать.
- [ ] **Step 3:** `npm run frontend:build`, `npx playwright test e2e/diagnostics_module_absent.spec.mjs e2e/panel_module_load_recovery.spec.mjs` зелёные.
- [ ] **Step 4: Commit** — «Сторожа границы модуля и работа панели без окна диагностики».

**Контрольная точка:** шаги 1–2 выходят в обычной версии панели. Перед продолжением — полный e2e и `npm run test:py`, итог владельцу.

## Этап 3. Каталог обновлений (шаг 3)

### Task 6: Проверка документа `module-updates.json`

**Files:**
- Modify: `xkeen-ui/services/module_package_contract.py`
- Test: `tests/test_module_package_contract.py`

**Interfaces:**
- Produces: `MODULE_UPDATES_KIND = "xkeen-module-updates"`; `validate_module_updates_document(document, *, panel_version: str, signing_key_id: str, trusted_signing_key_ids, core_version: str | None = None) -> dict[str, Any]` возвращает `{"kind", "schema_version", "panel_version", "serial", "modules"}`; каждая запись — результат `validate_catalog_entry` плюс `ownership: list[str]`.

- [ ] **Step 1: Падающие тесты** — по одному на отказ, коды:

| Вход | Код |
|---|---|
| `kind` не тот (подпись другого документа) | `module_updates_kind_invalid` |
| `schema_version != 1` | `module_updates_schema_unsupported` |
| `panel_version` не равна установленной | `module_updates_panel_mismatch` |
| `serial` не целое, `bool` или `< 1` | `module_updates_serial_invalid` |
| две записи одного модуля | `catalog_module_duplicate` |
| `min_core != panel_version` | `module_updates_min_core_invalid` |
| `entry.signing_key_id` не равен ключу подписи | `catalog_signing_key_mismatch` |
| `ownership` пуст, содержит `../`, `install.sh`, путь `hooks/` | `manifest_path_unsafe` или `manifest_hook_forbidden` |
| модуль `core` | `module_updates_core_forbidden` |

И успешный случай с минимальным документом.

- [ ] **Step 2:** тесты падают.
- [ ] **Step 3:** реализовать через `validate_catalog_entry` (архитектуру не передавать: она проверяется в плане для одного модуля) и `_safe_relative_path`.
- [ ] **Step 4:** тесты зелёные.
- [ ] **Step 5: Commit** — «Проверка подписанного каталога обновлений модулей».

### Task 7: Клиент каталога обновлений

**Files:**
- Modify: `xkeen-ui/services/module_catalog_client.py`
- Test: `tests/test_module_catalog_client.py`

**Interfaces:**
- Produces: `CatalogAssetNotFound(CatalogTransportError)` с кодом `catalog_asset_not_found` — транспорт бросает его на HTTP 404.
- `ModuleUpdatesSnapshot` (frozen dataclass): `document: Mapping`, `document_bytes: bytes`, `signature_bytes: bytes`, `panel_version: str`, `fetched_at: float`, `freshness: Literal["fresh", "stale"]`, `stale_reason: str | None`.
- `ModuleCatalogClient.get_module_updates(panel_version: str, *, force_refresh: bool = False) -> ModuleUpdatesSnapshot | None`.
- `ModuleCatalogClient.get_effective_catalog(release_version: str, *, force_refresh: bool = False) -> CatalogSnapshot`: снимок выпуска, в котором записи модулей заменены новейшими записями каталога обновлений.
- Отдельная функция `merge_module_updates(catalog: Mapping, updates: Mapping | None) -> dict`: заменённая запись получает несигнированный признак `"update_entry": True`.
- Файлы кэша: `module-catalog/module-updates-<версия>.json`, запись об отсутствии — `module-catalog/module-updates-<версия>.none.json`.

- [ ] **Step 1: Падающие тесты**

```python
def test_404_means_no_updates_and_is_remembered(transport): ...       # None, второй вызов без запроса
def test_valid_document_is_cached_and_served_fresh(transport): ...
def test_transport_failure_serves_stale_cache(transport): ...         # freshness == "stale"
def test_lower_serial_is_refused_and_cache_stays(transport): ...      # stale_reason == "module_updates_rollback"
def test_signature_mismatch_from_network_keeps_cache(transport): ...  # stale_reason == "catalog_signature_invalid"
def test_signature_404_keeps_cache(transport): ...                    # публикация в процессе
def test_tampered_cache_is_dropped(transport): ...                    # повторная загрузка
def test_clock_behind_never_counts_as_fresh(transport): ...
def test_prune_removes_other_panels_updates(transport): ...
def test_merge_replaces_one_module_and_keeps_others(): ...
def test_effective_catalog_keeps_release_version_for_download_url(transport): ...
def test_catalog_json_404_is_still_transport_failure_for_get_catalog(transport): ...
```

- [ ] **Step 2:** тесты падают.
- [ ] **Step 3: Реализовать.** Запись `.none.json` живёт как свежий кэш, 86400 секунд, и не отменяет уже проверенный кэш. `serial` кэша — нижняя граница; меньший отвергается, больший заменяет запись. Сбой проверки с сети возвращает кэш со `stale_reason`; без кэша — `None`. `_prune_release_catalogs` чистит и файлы `module-updates-<версия>*`, оставляя запущенную панель.
- [ ] **Step 4:** тесты зелёные.
- [ ] **Step 5: Commit** — «Клиент каталога обновлений: кэш, serial и отказоустойчивое чтение».

### Task 8: Новейшая запись для `install`, `repair` и экрана

**Files:**
- Modify: `xkeen-ui/services/module_transactions/plan.py` (`Plan`, `build_plan`, `plan_from_json`), `xkeen-ui/services/module_transactions/executor.py:240-264`, `xkeen-ui/services/module_lifecycle.py` (`_release_context`, `available`, `installed`)
- Test: `tests/test_module_transactions_plan.py`, `tests/test_module_transactions_executor.py`, `tests/test_module_lifecycle.py`

**Interfaces:**
- Consumes: `get_effective_catalog`, `read_installed_module_versions`.
- Produces: новые поля `Plan` в конце, со значениями по умолчанию: `module_version: str | None = None`, `module_files: tuple[str, ...] | None = None`. `plan_from_json` читает их через `.get`, так что журнал старой панели остаётся читаемым.
- `available()`: `update_available: bool`, `update_stale_reason: str | None`.

- [ ] **Step 1: Падающие тесты**

```python
def test_update_entry_is_accepted_though_version_differs_from_panel(tree): ...
def test_release_entry_with_foreign_version_is_still_refused(tree): ...       # module_version_mismatch
def test_repair_lays_newest_entry_and_records_version(tree): ...
def test_repair_refuses_when_installed_is_newer_than_entry(tree):
    # установлено 1.0.3, каталог обновлений недоступен
    with pytest.raises(ModuleTransactionError) as caught: build_plan("repair", ...)
    assert caught.value.code == "module_update_catalog_unavailable"
def test_install_after_remove_takes_newest_entry(tree): ...
def test_update_available_compares_module_versions(service): ...              # 1.0.1 > 1.0.0, панель 3.1.0 не участвует
def test_local_build_never_offers_update(service): ...
def test_executor_uses_effective_catalog_for_module_scope(tree): ...
def test_plan_from_old_journal_has_no_module_version(): ...
```

- [ ] **Step 2:** тесты падают.
- [ ] **Step 3: Реализовать.** `_release_context` для операций берёт `get_effective_catalog`, для `read_only` — обычный каталог. В `build_plan` проверка `entry["version"] != version` пропускается при `entry.get("update_entry") is True`. Версия цели: `entry["version"]` у записи обновления, иначе `read_panel_module_versions(panel_root)[module_id]`. Проверка отказа — сравнение цели с установленной версией через `compare_semver`. В `executor` для `scope == "module"` вместо `get_release_catalog` вызывается `get_effective_catalog`; при расхождении остаётся `module_version_mismatch`.
- [ ] **Step 4:** тесты зелёные, `npm run test:py` зелёный.
- [ ] **Step 5: Commit** — «Обновлённая запись каталога для установки, починки и экрана модулей».

## Этап 4. Операция `update` (шаг 4)

### Task 9: Фактическая принадлежность файлов

**Files:**
- Create: `xkeen-ui/services/module_transactions/ownership_overrides.py`, `tests/test_module_ownership_overrides.py`
- Modify: `xkeen-ui/services/module_transactions/plan.py` (`STATE_FILES`, `build_plan`, `installed_panel_listing`), `xkeen-ui/services/module_profile_plan.py` (`STATE_FILENAMES`), `xkeen-ui/scripts/module_profile_install.py` (`STATE_FILES`, очистка), `xkeen-ui/services/panel_service_data.py`, `xkeen-ui/services/module_transactions/install_state.py`

**Interfaces:**
- Produces: `OVERRIDES_FILENAME = "module-ownership-overrides.json"`, формат `{"schema_version": 1, "modules": {"<id>": ["<путь>", ...]}}`.
- `read_overrides(state_dir: Path) -> dict[str, tuple[str, ...]]`: испорченный файл даёт `module_ownership_unavailable`, нет файла — пустой словарь.
- `effective_ownership(panel_root: Path, state_dir: Path) -> OwnershipMap`: запись заменяет список файлов модуля целиком; `frontend` не меняется.
- `installed_panel_listing(panel_root: Path, state_dir: Path | None = None)`: при `state_dir` листинг строится по фактической принадлежности.

- [ ] **Step 1: Падающие тесты**

```python
def test_override_replaces_module_files(tree): ...
def test_override_claiming_core_file_is_a_conflict(tree): ...             # module_ownership_conflict
def test_override_claiming_user_file_is_a_conflict(tree): ...
def test_broken_override_file_is_refused(tree): ...
def test_profile_transition_keeps_updated_module(tree):
    # модуль обновлён, запрошен профиль, где он остаётся: files_remove и files_add не содержат его файлов
def test_profile_transition_dropping_module_clears_its_override(tree): ...
def test_panel_update_clears_overrides_and_versions(tree): ...
def test_installer_clears_overrides_and_versions(tree): ...               # module_profile_install на дереве с overrides
def test_overrides_file_is_never_user_owned_or_payload(tree): ...
```

- [ ] **Step 2:** тесты падают.
- [ ] **Step 3: Реализовать.** `state_file_updates`: для `scope == "panel"` пишет пустой `modules` в overrides, а `module-installed.json` без `versions`; для `scope == "profile"` сохраняет записи оставшихся модулей и удаляет записи ушедших. Пустая запись вместо удаления файла: журнал откатывает только запись. Установщик приводит файл к пустому виду и не переносит `versions`.
- [ ] **Step 4:** тесты зелёные, `python -m pytest tests/test_module_profile_plan.py tests/test_module_transactions_real_tree.py tests/test_panel_update_real_tree.py -q` зелёные.
- [ ] **Step 5: Commit** — «Фактическая принадлежность файлов модуля: overrides для всех операций».

### Task 10: Транзакция `update`

**Files:**
- Modify: `xkeen-ui/services/module_transactions/plan.py` (`OPERATIONS`, `build_plan`), `xkeen-ui/services/module_transactions/install_state.py` (`state_file_updates`), `xkeen-ui/services/module_lifecycle.py` (`_validate_operation`, `_lifecycle_actions`, `_PLAN_BLOCKERS`), `xkeen-ui/routes/modules.py`
- Test: `tests/test_module_transactions_plan.py`, `tests/test_module_transactions_executor.py`, `tests/test_module_transactions_real_tree.py`, `tests/test_module_transactions_journal.py`, `tests/test_module_lifecycle_routes.py`

**Interfaces:**
- Consumes: `effective_ownership`, поля `Plan` из задачи 8.
- Produces: `OPERATIONS = ("install", "repair", "remove", "update")`; код отказа `module_update_not_available` (блокер плана); `_lifecycle_actions(module_id, installed, update_available=False)` добавляет `"update"`.

- [ ] **Step 1: Падающие тесты**

```python
def test_update_plan_removes_old_files_and_adds_new(tree):
    plan = build_plan("update", "tool.advanced-diagnostics", ...)
    assert plan.files_add == tuple(sorted(NEW_FILES))
    assert plan.files_remove == tuple(sorted(OLD_FILES - NEW_FILES))
    assert plan.module_version == "1.0.1"

def test_update_without_newer_entry_is_blocked(tree): ...                 # module_update_not_available
def test_update_of_not_installed_module_is_refused(tree): ...             # module_not_installed
def test_update_keeps_switch_and_profile_label(tree):
    # выключенный модуль остаётся выключенным, modules.json.profile не становится custom
def test_update_writes_version_override_and_managed_paths(tree): ...
def test_failed_health_restores_files_version_and_overrides(tree): ...
def test_power_loss_mid_update_recovers_at_boot(tree): ...
def test_editor_module_can_be_updated(tree): ...                          # tool.editor: update разрешён наряду с repair
def test_update_does_not_install_packages(tree): ...
def test_entry_claiming_foreign_file_is_a_conflict(tree): ...
def test_route_accepts_update_and_rejects_core(client): ...
```

- [ ] **Step 2:** тесты падают.
- [ ] **Step 3: Реализовать.** Цель: `tuple(sorted(entry["ownership"]))` у записи обновления, иначе файлы модуля по `effective_ownership`. `files_remove` — файлы текущей версии, которых нет в цели. Занятое место считается по существующей формуле. `_REPAIR_ONLY_MODULES` разрешает `repair` и `update`, в `plan.py` и `_validate_operation` одинаково. `state_file_updates` для `install`, `repair`, `update` с `plan.module_version` возвращает `module-installed.json` с `versions` и overrides с `plan.module_files`; `repair` базовой записью при отсутствии версии по-прежнему возвращает `{}`. Для `update` не менять `profile`, `enabled`, `install-profile.json`; `install-managed.json` обновлять. `remove` очищает запись модуля в overrides и `versions`.
- [ ] **Step 4:** тесты зелёные, `npm run test:py` зелёный.
- [ ] **Step 5: Commit** — «Операция обновления одного модуля с журналом и откатом».

### Task 11: Переходы со старых панелей

**Files:**
- Create: `tests/test_module_update_transitions.py`
- Modify: при необходимости `xkeen-ui/services/module_profile_plan.py`, `xkeen-ui/services/panel_package_contract.py`

**Interfaces:**
- Consumes: архив последнего стабильного выпуска, собранный фикстурой из текущего `git` тега; проверка идёт на файлах `panel_package_contract.py` и `module_transactions/plan.py` этого тега, извлечённых через `git show`.

- [ ] **Step 1: Тесты**

```python
def test_old_panel_accepts_new_archive(old_code, new_archive): ...        # validate_panel_archive старого кода
def test_old_panel_reads_new_catalog(old_code, new_catalog): ...          # catalog.json без новых полей
def test_profile_without_diagnostics_gets_devtools_after_update(old_tree, new_archive): ...
def test_profile_with_diagnostics_keeps_module_and_new_marker(old_tree, new_archive): ...
def test_module_switch_survives_panel_update(old_tree, new_archive): ...
def test_serial_floor_does_not_carry_over_to_next_panel(tree): ...
def test_rollback_is_not_offered_after_module_update(tree): ...
```

- [ ] **Step 2:** запустить, чинить найденное. Тест, упавший на старом коде, значит, что новый архив ломает обновление со старой панели: это стоп, обсудить с владельцем, старый код уже не изменить.
- [ ] **Step 3:** `npm run test:py` зелёный.
- [ ] **Step 4: Commit** — «Тесты перехода со старых панелей на панель с разрезом модулей».

## Этап 5. Интерфейс (шаг 5)

### Task 12: Макеты

- [ ] **Step 1:** снять с настоящей панели (e2e-стенд с подменой `/api/modules/available`) страницу модулей: модуль без обновления, с обновлением, окно операции `update`, ошибка каталога. Варианты положить в скретчпад.
- [ ] **Step 2:** показать владельцу текстом с рекомендацией. **Стоп до выбора.** Без выбора задача 13 не начинается.

### Task 13: Кнопка «Обновить» и уведомления

**Files:**
- Modify: `xkeen-ui/static/js/features/module_manager/render.js` и соседние файлы окна операции, `xkeen-ui/services/module_lifecycle.py` (`notification_catalog`), `xkeen-ui/services/notification_center.py`
- Test: `tests/test_module_manager_ui.py`, новый `e2e/modules_manager_update.spec.mjs`

**Interfaces:**
- Consumes: `available()`: `update_available`, `module_version`, `installed_version`, `update_stale_reason`; действие `update` в `lifecycle_actions`.
- Produces: тип уведомления `module_update_available` с полями `module_id`, `version`.

Конкретная вёрстка определяется выбранным макетом; поведение зафиксировано.

- [ ] **Step 1: E2E-тесты:** при `update_available` видны обе версии и кнопка «Обновить»; нажатие показывает окно операции как у `repair` и завершается успехом; без обновления кнопки нет; локальная сборка кнопку не показывает; `stale_reason` не мешает работе экрана; центр уведомлений показывает запись один раз и не повторяет после обновления.
- [ ] **Step 2:** тесты падают, затем реализация по макету.
- [ ] **Step 3:** `npm run frontend:build`, `npx playwright test e2e/modules_manager_update.spec.mjs e2e/modules_manager_operations.spec.mjs e2e/modules_manager_recovery.spec.mjs` зелёные. CRLF в изменённых JS сохранён.
- [ ] **Step 4: Commit** — «Обновление модуля из страницы модулей и уведомление о нём».

## Этап 6. Выпуск модуля (шаг 6)

### Task 14: Проверки выпуска

**Files:**
- Create: `scripts/check_module_release.py`, `tests/test_check_module_release.py`

**Interfaces:**
- Produces чистые функции, возвращающие список нарушений:
  - `parse_module_tag(tag: str) -> tuple[str, str]`, формат `module-<id>-X.Y.Z`;
  - `check_tag_version(tag, versions: Mapping[str, str], issued: Sequence[str]) -> list[str]`;
  - `find_panel_tag(tags_reachable: Sequence[str]) -> str`, ближайший предок `v*`;
  - `check_latest_in_channel(panel_tag, published: Sequence[str]) -> list[str]`, стабильные и беты отдельно;
  - `check_changed_paths(changed: Iterable[str], module_files: Collection[str]) -> list[str]`, вне модуля разрешены `module-versions.json`, `tests/`, `e2e/`, `docs/`;
  - `compare_with_panel_archive(build_root: Path, panel_archive: Path, module_id: str) -> list[str]`.
- `main` запускает их по порядку и завершается с кодом 1 при первом нарушении. Сообщение «правка требует выпуска панели» для `check_changed_paths` и `compare_with_panel_archive` — штатный исход.

- [ ] **Step 1: Падающие тесты**

```python
def test_tag_must_match_versions_file(): ...
def test_version_must_exceed_issued(): ...
def test_beta_panel_is_latest_only_among_betas(): ...
def test_older_panel_is_refused(): ...
def test_core_change_is_refused_and_tests_are_allowed(): ...
def test_module_versions_file_is_allowed_outside_module(): ...
def test_byte_difference_in_core_is_reported(tmp_path): ...
def test_neighbour_module_difference_is_reported(tmp_path): ...
def test_ownership_may_differ_only_in_released_module(tmp_path): ...
def test_sizes_may_differ_only_in_released_module(tmp_path): ...
def test_ignored_files_are_not_compared(tmp_path):
    # BUILD.json, module-versions.json, retired-files.json, scripts/entware_mirrors.txt
def test_unknown_new_file_stops_release(tmp_path): ...
```

- [ ] **Step 2:** тесты падают.
- [ ] **Step 3:** реализовать. `IGNORED = {"BUILD.json", "module-versions.json", "retired-files.json", "scripts/entware_mirrors.txt"}`, `SEMANTIC = {"module-ownership.json", "module-sizes.json"}`.
- [ ] **Step 4:** тесты зелёные.
- [ ] **Step 5: Commit** — «Проверки выпуска модуля».

### Task 15: Сборка каталога и `release-module.yml`

**Files:**
- Create: `scripts/build_module_update.py`, `tests/test_build_module_update.py`, `.github/workflows/release-module.yml`
- Modify: `scripts/sign_modular_panel_catalog.py` (если нужен только путь `--catalog`, не менять), `RELEASING.md`, `.claude/skills/git-sync/SKILL.md`, `scripts/e2e_gate.py`, `tests/test_e2e_gate.py`

**Interfaces:**
- Produces: `build_module_update(root: Path, output_dir: Path, *, module_id: str, version: str, panel_version: str, channel: str, previous: Mapping | None, epoch: int) -> Path`: собирает архив через `build_module_archive(..., min_core=panel_version)`, пишет `.sha256`, `module-updates.json` и `release-metadata.json` со списком ассетов.
- Подпись: `python scripts/sign_modular_panel_catalog.py --catalog <dir>/module-updates.json --metadata <dir>/release-metadata.json --key-id release-2026 --private-key-env XKEEN_RELEASE_ED25519_PRIVATE_KEY` даёт `module-updates.json.sig`.
- `e2e_gate.RELEASE_TAG` принимает `refs/tags/v\d` и `refs/tags/module-`.

- [ ] **Step 1: Падающие тесты:** новый документ с `previous` имеет `serial + 1` и заменяет запись только этого модуля; записи других модулей сохраняются; первый выпуск получает `serial == 1`; документ проходит `validate_module_updates_document`; архив проходит `validate_module_archive`; `min_core == panel_version`; `pre-push` без отметки не пускает `module-tool.files-1.0.1`.
- [ ] **Step 2:** тесты падают.
- [ ] **Step 3: Реализовать скрипт и workflow.** Запуск: `on: push: tags: ["module-*"]`, `concurrency: { group: module-release, cancel-in-progress: false }`. Шаги повторяют `build-user-archive.yml`: Python 3.11, Node 20, `npm ci`, `npm run frontend:build`, pytest. Затем скачать архив панели `V`, запустить `check_module_release.py`, скачать и проверить прежний `module-updates.json` подписью, собрать, подписать, выгрузить `gh release upload "$V" --clobber` в порядке: архив и `.sha256`, затем `module-updates.json`, затем `.sig`. Секрет подписи передаётся только шагу подписи.
- [ ] **Step 4:** описать в `RELEASING.md` и `git-sync` процедуру из спецификации: ветка от тега `V`, подъём версии, `npm run e2e:gate`, тег, вливание ветки в `pre-release` через `git merge`.
- [ ] **Step 5:** тесты зелёные; workflow пройден `python -c "import yaml; yaml.safe_load(open('.github/workflows/release-module.yml', encoding='utf-8'))"`.
- [ ] **Step 6: Commit** — «Выпуск модуля: сборка каталога, workflow и порядок в RELEASING».

### Task 16: Проверки при выпуске панели

**Files:**
- Create: `scripts/check_module_versions_for_release.py`, `tests/test_check_module_versions_for_release.py`
- Modify: `.github/workflows/build-user-archive.yml` (шаг после «Check release tag order», только для `refs/tags/v`)

**Interfaces:**
- Produces: `missing_merges(versions: Mapping[str, str], module_tags: Sequence[str]) -> list[str]`; `unbumped_modules(changed: Iterable[str], ownership: Mapping[str, Sequence[str]], old_versions, new_versions) -> list[str]`.

- [ ] **Step 1: Падающие тесты:** версия ниже выданного тега `module-<id>-*` — нарушение («забытое вливание»); исходники модуля менялись без подъёма версии — модуль в списке; изменение только сгенерированных файлов сборки не считается; панель без тегов модулей проходит.
- [ ] **Step 2:** тесты падают.
- [ ] **Step 3:** реализовать, подключить в workflow, сравнение от предыдущего тега `v*` своего канала.
- [ ] **Step 4:** тесты зелёные, `npm run test:py` зелёный.
- [ ] **Step 5: Commit** — «Проверка версий модулей при выпуске панели».

## Этап 7. Приёмка (шаг 7)

### Task 17: Полный цикл на настоящем выпуске

Задача выполняется только по отдельной отмашке владельца на каждый пункт: пуш, тег беты, тег модуля, установка на роутер, пароль.

- [ ] **Step 1:** полный `npm run e2e:gate` и `npm run test:py`, итог с выводом.
- [ ] **Step 2:** бета панели с разрезом; панель-предшественник на тестовом роутере обновляется на неё штатной кнопкой.
- [ ] **Step 3:** видимая правка в окне диагностики, ветка `module/tool.advanced-diagnostics-1.0.1` от тега беты, тег модуля, CI опубликовал четыре файла.
- [ ] **Step 4:** на роутере панель показывает обновление, «Обновить» проходит, окно показывает правку, `BUILD.json`, core и другие модули не изменились (сверка sha256 до и после).
- [ ] **Step 5:** отказ по здоровью вызывает откат: версия, overrides и файлы прежние.
- [ ] **Step 6:** смена профиля и `repair` не откатывают правку; следующий выпуск панели чистит overrides и несёт модуль с поднятой версией.
- [ ] **Step 7:** отключённый модуль, удаление и установка назад.
- [ ] **Step 8:** запись итогов в память и `.superpowers/handoff.md`.

### Шаг 8: остановка

Разговор с владельцем: пользуемся ли отдельными выпусками на деле. Отделение следующих модулей — новый план после этого разговора. Xray и Mihomo потребуют наполнить `CORE_PUBLIC_ENTRIES` и перевести 12 статических импортов core → Mihomo.

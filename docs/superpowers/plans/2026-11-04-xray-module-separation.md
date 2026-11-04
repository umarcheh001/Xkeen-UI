# Отделение модуля Xray: план работ

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** фронт `engine.xray` собирается отдельно от core, и его можно выпускать отдельным модулем, как диагностику.

**Architecture:** core зовёт Xray только через `xk-module/engine.xray` и общий мостик `module_parts.js`. Xray зовёт core
только по постоянным именам `xk-core/<путь>`, их подставляет importmap. Работа идёт тремя шагами, каждый коммит
зелёный: вход и мостик внутри сборки core, затем `xk-core` в исходниках, затем отдельная сборка.

**Tech Stack:** Vite (rolldown), Flask/Jinja, Python 3.11, Playwright, node:test.

**Spec:** `docs/superpowers/specs/2026-11-01-independent-module-releases-design.md`, раздел «Отделение Xray
(дополнение 04.11.2026)». Образец — проба в `../XKEEN-UI-PROBE-XRAY` (незакоммиченный diff), память
`project_xray_module_separation_probe.md`.

## Global Constraints

- Ветка `pre-release`, rebase запрещён, автор: `git -c user.name="olmer2002" -c user.email="olmer2002@gmail.com" commit -m "..."`,
  без трейлеров, сообщения по-русски, без слова «Happ».
- Не пушить, не ставить теги, не выпускать и не ставить на роутер без явной просьбы владельца.
- Новая правка начинается с падающего теста. Все файлы — LF (`git ls-files --eol`); Python пишет файлы `'wb'` или `newline=''`.
- Перед e2e — `npm run frontend:build`. Полный pytest — `npm run test:py`. Описи — `npm run inventory:refresh`, руками не сливать.
- `npm run frontend:build` остаётся единственной командой сборки.
- Вид окон не меняется.
- Python-код не меняется, кроме `services/frontend_importmap.py`, `routes/ui_assets.py`, `scripts/build_modular_panel_release.py`
  (`_PACKAGE_OWNER_OVERRIDES`), `xkeen-ui/scripts/module_profile_install.py` (`owner()` для `frontend-build/`) и тестов.
- Части модуля Xray (ровно этот набор): `bundle`, `routing`, `routing_cards`, `routing_shell`, `routing_templates`,
  `inbounds`, `outbounds`, `xray_logs`, `xray_preflight_modal`, `github`, `dat_contents`.

## Review Focus

- Профиль `mihomo-minimal`: панель и DevTools открываются без запросов к `xk-module/engine.xray` и без ошибок в консоли (задача 5).
- Общее состояние core одно на core и модуль: importmap ведёт `xk-core/<путь>` ровно в тот файл, который грузят чанки core (задача 3).
- Кнопки core, которые зовут Xray до открытия экрана Xray: импорт из GitHub, окно содержимого `.dat`, окно проверки Xray
  из журнала перезапуска, сохранение inbounds/outbounds из JSON-редактора, шаблоны маршрутизации (задача 2).
- Файл модуля пропал во время обновления: сообщение только с «Обновить страницу», без бесконечного «Повторить» (задача 4).
- Панель без сборки (разработка из исходников): `xk-core/` и `xk-module/engine.xray` ведут в `static/js` (задачи 3 и 4).

---

### Task 1: сторож границ по карте пакета

**Files:**
- Modify: `tests/test_module_boundaries.py`, `scripts/build_modular_panel_release.py` (`_PACKAGE_OWNER_OVERRIDES`)

**Interfaces:**
- Produces: `package_owner(path: str) -> str` в `tests/test_module_boundaries.py` — владелец по
  `builder.build_module_ownership(ROOT)` (`editor-full` → `tool.editor`, неизвестный файл → `core`), закэширован.

- [ ] **Step 1: падающий тест** `test_logs_shell_belongs_to_xray`: `package_owner("static/js/pages/logs_shell.shared.js") == "engine.xray"`;
  `test_package_owner_follows_overrides`: `package_owner("static/js/features/github.js") == "engine.xray"` и
  `package_owner("static/js/features/xray_log_line_class.js") == "core"`.
- [ ] **Step 2:** `python -m pytest tests/test_module_boundaries.py -q` — FAIL на `logs_shell`.
- [ ] **Step 3:** в `_PACKAGE_OWNER_OVERRIDES` добавить `"static/js/pages/logs_shell.shared.js": "engine.xray"` (комментарий:
  оболочка экрана логов Xray). В `test_no_static_import_crosses_a_separated_module_boundary` заменить `owner()` на
  `package_owner()`.
- [ ] **Step 4:** `python -m pytest tests/test_module_boundaries.py tests/test_modular_panel_release_builder.py -q` — PASS.
- [ ] **Step 5:** `npm run inventory:refresh`, коммит «Сторож границ модулей берёт владельцев из карты пакета; оболочка логов Xray — в модуле Xray».

### Task 2: вход Xray и мостик `module_parts.js` внутри сборки core

**Files:**
- Create: `xkeen-ui/static/js/features/module_parts.js`, `xkeen-ui/static/js/pages/xray.module.entry.js`, `tests/js/module_parts.test.mjs`
- Move: `xkeen-ui/static/js/pages/panel.routing.bundle.js` → `xkeen-ui/static/js/pages/xray.module.bundle.js` (`git mv`)
- Create (на старом месте): `xkeen-ui/static/js/pages/panel.routing.bundle.js` — загрузчик
- Modify: `features/backups.js`, `ui/json_editor_modal.js`, `features/restart_log.js`, `ui/spinner_fetch.js`,
  `pages/panel.lazy_bindings.runtime.js` (`routingTemplates`, `github`), `runtime/lazy_runtime.js` (`datContents`);
  удалить мёртвый `features/index.js`. `features/github.js` и `ui/dat_contents_modal.js` по карте пакета уже в Xray —
  их прямые импорты Xray остаются
- Modify tests: `tests/test_frontend_migration_guardrails.py`, `tests/test_frontend_runtime_hotfixes.py`
- Modify: `module-versions.json` (`engine.xray` 1.0.2, `tool.backups` 1.0.1, `tool.editor` 1.0.1)

**Interfaces:**
- Produces (`module_parts.js`):
  `loadModulePart(moduleId: string, part: string): Promise<object>`,
  `loadedModulePart(moduleId: string, part: string): object | null`,
  `rememberModulePart(moduleId: string, part: string, mod: object): void`.
  Таблица `MODULE_ENTRIES = { 'engine.xray': () => import('../pages/xray.module.entry.js') }`, для тестов
  `__setModuleEntriesForTest(table)`; `loadModulePart` берёт вход и зовёт его `load(part)`. Неизвестный модуль —
  отклонённый промис с `Error('module is not separate: <id>')`. В задаче 4 значение меняется на `import('xk-module/engine.xray')`.
- Produces (`xray.module.entry.js`): `XRAY_MODULE_PARTS` (замороженный объект части → фабрика импорта; `github` грузит
  `features/github.js`, затем `features/compat/github.js`, как сейчас `panel.lazy_bindings.runtime.js`),
  `load(part: string): Promise<object>` — грузит часть и зовёт `rememberModulePart('engine.xray', part, mod)`;
  неизвестная часть — отклонённый промис; `activate(context): Promise<object>` — грузит `bundle`, затем
  `routing`, `routing_cards`, `routing_shell` (бандл берёт их статически; так их видит core) и возвращает `bundle.activate(context)`.
- Produces (`panel.routing.bundle.js`): `activate(context)` → `import('./xray.module.entry.js').then((entry) => entry.activate(context))`.
  Ключ `panel-routing` и `BUNDLE_SOURCES` в `panel.module_loader.js` не меняются.

- [ ] **Step 1: падающие тесты.** `tests/js/module_parts.test.mjs` (node:test, вход подменяется через внедряемую таблицу
  `__setModuleEntriesForTest(table)`): загруженная часть видна через `loadedModulePart`; неизвестный модуль отклоняется;
  до загрузки `loadedModulePart` даёт `null`. В `test_frontend_migration_guardrails.py` ожидаемые фрагменты меняются на
  `loadModulePart('engine.xray', 'routing_templates')`, `loadModulePart('engine.xray', 'xray_preflight_modal')` и т. д.;
  тест `routing_compat_bridges` смотрит в `xray.module.bundle.js`. В `test_frontend_runtime_hotfixes.py` — то же для `help_docs.js`.
  Новый тест в `test_module_boundaries.py`: `test_core_reaches_xray_only_through_module_parts` — ни один файл core
  (по `package_owner`) не содержит `import(` с путём к файлу `engine.xray`, кроме `module_parts.js` и `panel.routing.bundle.js`.
- [ ] **Step 2:** `python -m pytest tests/test_frontend_migration_guardrails.py tests/test_frontend_runtime_hotfixes.py tests/test_module_boundaries.py -q`
  и `node --test tests/js/module_parts.test.mjs` — FAIL.
- [ ] **Step 3:** код по Interfaces. Каждый `import()` файла Xray в core становится `loadModulePart('engine.xray', <часть>)`
  с тем же разбором результата; `spinner_fetch.js` — классический IIFE, берёт мостик через `import('../features/module_parts.js')`.
- [ ] **Step 4:** тесты шага 2 — PASS; `npm run frontend:build`; `npx playwright test e2e/panel_operator_xray_preflight.spec.mjs
  e2e/panel_operator_stage4_routing_data.spec.mjs e2e/routing_schema.spec.mjs e2e/outbounds_header_first_click.spec.mjs
  e2e/panel_module_load_recovery.spec.mjs` — 0 failed.
- [ ] **Step 5: e2e Review Focus 3** — в `e2e/xray_module_parts.spec.mjs`: на свежей странице, не открывая экран Xray,
  (а) окно проверки Xray открывается из журнала перезапуска, (б) сохранение outbounds из JSON-редактора обновляет карточку,
  (в) кнопка шаблонов маршрутизации открывает окно. Ошибок в консоли нет. PASS.
- [ ] **Step 6:** `npm run test:py`, `npm run inventory:refresh`, коммит «Xray: вход модуля с частями по требованию, core зовёт его через общий мостик module_parts; версии Xray 1.0.2, резервных копий и редакторов 1.0.1».

### Task 3: `xk-core` в исходниках Xray

**Files:**
- Modify: все файлы `engine.xray` в `static/js`, импортирующие core (по пробе 37 импортов к 20 файлам; список — сторож шага 1)
- Modify: `vite.config.mjs`, `xkeen-ui/services/frontend_importmap.py`, `xkeen-ui/routes/ui_assets.py`
- Create: `tests/js/xk_core_hooks.mjs`, `tests/js/xk_core_resolve.mjs`, `tests/support/node_js.py`
- Modify: тесты, запускающие `node` на файлах Xray (`grep -ln '"node"' tests/*.py` пересечь с файлами Xray:
  `test_routing_scenarios_runtime.py`, `test_routing_jsonc_preserve_disabled_rules.py`, `test_dns_over_vless*.py` и др.),
  `tests/test_frontend_importmap.py`

**Interfaces:**
- Produces (`vite.config.mjs`): `export function collectCorePublicPaths(root: string): string[]` — все `xk-core/<путь>`
  из `static/js/**/*.js` (без `vendor/npm`), уникальные, отсортированные, путь без префикса. `CORE_PUBLIC_ENTRIES` —
  `{ ['xk-core-' + sha1(path).slice(0, 10)]: absPath }`. `isExternalImport` признаёт `xk-core/`. `preserveEntrySignatures: 'strict'`.
- Produces (`frontend_importmap.py`): `build_core_public_importmap(panel_root: Path) -> dict[str, str]` — для каждого
  `isEntry`-входа `manifest.build.json` с ключом `js/...` даёт `xk-core/<ключ>` → `frontend-build/<file>`; без
  манифеста — `{"xk-core/": ""}` (префикс на корень `static/`). `frontend_module_importmap()` добавляет его записи;
  пустая цель превращается в `url_for("static", filename="")`, то есть `/static/`.
- Produces (`tests/support/node_js.py`): `NODE_MODULE_COMMAND: tuple[str, ...] = ("node", "--import", <file URL xk_core_hooks.mjs>, "--input-type=module")`.

- [ ] **Step 1: падающие тесты.** `test_frontend_importmap.py`: `test_core_public_entries_are_mapped_to_built_files`
  (манифест с `js/features/xkeen_runtime.js` → `xk-core/js/features/xkeen_runtime.js` = `frontend-build/assets/<file>`),
  `test_core_prefix_without_build` (нет манифеста → `{"xk-core/": ""}`, в шаблоне `/static/`). `test_module_boundaries.py`:
  `test_xray_sources_reach_core_only_by_public_name` — у файлов `engine.xray` нет относительных импортов к файлам
  не-`engine.xray` (статических и `import()`); `test_core_public_surface_belongs_to_core` — каждый путь из
  `collectCorePublicPaths` существует и принадлежит core и по `package_owner`, и по `owner()`;
  `test_core_public_surface_is_listed` — поверхность равна явному списку `CORE_PUBLIC_SURFACE` в тесте (20 путей пробы,
  уточнить по факту). Review Focus 2: `test_importmap_targets_are_the_chunks_core_loads` — после сборки каждая цель
  `xk-core/*` равна `file` того же входа в `manifest.build.json`, и ни один файл `assets/` не встречается дважды под разными именами.
- [ ] **Step 2:** `python -m pytest tests/test_frontend_importmap.py tests/test_module_boundaries.py -q` — FAIL.
- [ ] **Step 3:** код по Interfaces; импорты Xray переписать на `xk-core/<путь от static>` (`?v=` у core-путей убрать).
  Хуки node: `resolve(specifier)` с префиксом `xk-core/` → `pathToFileURL(<repo>/xkeen-ui/static/<остаток>)`. Все запуски
  `node` в тестах на файлах Xray — через `NODE_MODULE_COMMAND`; `tests/js/*.test.mjs` запускать с `--import ./tests/js/xk_core_hooks.mjs`.
- [ ] **Step 4:** тесты шага 2 — PASS; `npm run frontend:build`; e2e набора задачи 2 и `e2e/xray_module_parts.spec.mjs` — 0 failed.
- [ ] **Step 5:** `npm run test:py`, `npm run inventory:refresh`, коммит «Xray берёт общий код core по постоянным именам xk-core; core публикует их входами сборки, importmap подставляет файлы».

### Task 4: отдельная сборка Xray

**Files:**
- Modify: `vite.module.config.mjs` (`SEPARATE_MODULES`), `xkeen-ui/static/js/features/module_parts.js`,
  `xkeen-ui/static/js/pages/panel.routing.bundle.js`, `xkeen-ui/services/frontend_importmap.py` (`SOURCE_FALLBACKS`),
  `xkeen-ui/scripts/module_profile_install.py` (`owner()`, ветка `static/frontend-build/`)
- Modify tests: `tests/test_module_boundaries.py`, `tests/test_frontend_importmap.py`, `e2e/panel_module_load_recovery.spec.mjs`

**Interfaces:**
- Consumes: `module_parts.js` (задача 2), `collectCorePublicPaths` (задача 3).
- Produces: `SEPARATE_MODULES['engine.xray'] = { entry: 'js/pages/xray.module.entry.js' }`;
  `SOURCE_FALLBACKS['engine.xray'] = 'js/pages/xray.module.entry.js'`;
  `MODULE_ENTRIES['engine.xray'] = () => import('xk-module/engine.xray')`; `panel.routing.bundle.js`:
  `activate(context)` → `import('xk-module/engine.xray').then((entry) => entry.activate(context))`.

- [ ] **Step 1: падающие тесты.** `test_separate_modules_table_is_read` ждёт оба модуля;
  `test_xray_build_has_only_its_directory` — в `manifest.build.json` нет `src` с владельцем `engine.xray`;
  `test_build_files_of_xray_names_are_core_outside_the_module` — `owner("static/frontend-build/assets/panel.routing.bundle-X.js") == "core"`,
  `owner("static/frontend-build/assets/xk-core-0123456789-X.js") == "core"`,
  `owner("static/frontend-build/modules/engine.xray/routing-X.js") == "engine.xray"`, правила Mihomo не тронуты;
  `test_frontend_importmap.py`: `engine.xray` в карте при активном модуле, нет — при выключенном.
  E2E Review Focus 4 в `panel_module_load_recovery.spec.mjs`: файл `frontend-build/modules/engine.xray/*.js` отвечает 404
  → сообщение с «Обновить страницу», без «Повторить».
- [ ] **Step 2:** pytest этих файлов — FAIL.
- [ ] **Step 3:** код по Interfaces. В `owner()` для `static/frontend-build/` снять токены `panel.routing.bundle` и
  `xray`/`routing`/`inbounds`/`outbounds`: файлы Xray есть только в `modules/engine.xray/`.
- [ ] **Step 4:** `npm run frontend:build`; pytest шага 2 — PASS; `npx playwright test e2e/panel_module_load_recovery.spec.mjs e2e/xray_module_parts.spec.mjs` — 0 failed.
- [ ] **Step 5: замер изоляции** (как в пробе, журналом в `.superpowers/sdd/2026-11-04-xray-module-separation/progress.md`):
  снимок sha256 `frontend-build` без `.gz/.br`; строка в `features/routing.js` → вне `modules/engine.xray/` и
  `.vite/module.engine.xray.json` 0 изменённых файлов; строка в `features/xkeen_runtime.js` → 0 изменённых файлов модуля;
  правки откатить.
- [ ] **Step 6:** `npm run test:py`, `npm run inventory:refresh`, коммит «Xray собирается отдельным модулем: правка Xray не меняет файлов core, правка core не меняет файлов Xray».

### Task 5: панель без Xray и выключенный модуль

**Files:**
- Create: `e2e/xray_module_absent.spec.mjs`
- Modify: `tests/test_installer_profile_frontend_closure.py`, `tests/test_module_packages_over_installer_profiles.py`

**Interfaces:**
- Consumes: профиль e2e `XKEEN_E2E_MODULE_PROFILE` (как в `e2e/diagnostics_module_absent.spec.mjs`).

- [ ] **Step 1: тесты.** `xray_module_absent.spec.mjs` с таблицей `HAS_XRAY = { full: true, 'xray-minimal': true, 'mihomo-minimal': false, 'core-only': false }`:
  `/` и `/devtools` открываются; в консоли нет ошибок с `xk-module`; нет ответов ≥ 400 на `frontend-build/modules/`;
  без Xray в importmap нет `xk-module/engine.xray`, а сеть ни разу не запрашивала `modules/engine.xray/`.
  pytest: `test_mihomo_minimal_profile_has_no_xray_module_files` — установленный `mihomo-minimal` не содержит
  `frontend-build/modules/engine.xray/` и `.vite/module.engine.xray.json`, но содержит все цели `xk-core/*`.
- [ ] **Step 2:** `npx playwright test e2e/xray_module_absent.spec.mjs` при `XKEEN_E2E_MODULE_PROFILE=mihomo-minimal`, `xray-minimal` и `full`;
  pytest новых тестов. Падение — чинить код, не тест.
- [ ] **Step 3:** всё PASS; коммит «Панель без модуля Xray не обращается к нему: e2e профилей и проверка установленных файлов».

### Task 6: проверка выпуска Xray и документы

**Files:**
- Modify: `tests/test_module_release_inventory_chain.py`, `RELEASING.md`, `.claude/skills/git-sync/SKILL.md` (если в нём перечислены отделённые модули)

- [ ] **Step 1: падающий тест.** `test_module_change_with_refreshed_inventory_passes_both_release_checks` параметризовать
  `(MODULE, MODULE_FILE)`: диагностика и `("engine.xray", "xkeen-ui/static/js/features/xray_logs.js")`. Для Xray те же
  утверждения: `check_changed_paths` пуст, размеры соседей не меняются, правка `xkeen-ui/app.py` даёт `NEEDS_PANEL`.
- [ ] **Step 2:** `python -m pytest tests/test_module_release_inventory_chain.py -q` — новый случай FAIL или PASS; если
  PASS сразу, проверить, что тест действительно трогает файл Xray (утверждение `SIZES in changed`).
- [ ] **Step 3:** при падении — правка в `scripts/check_module_release.py` по выводу. В `RELEASING.md`, раздел «Выпуск
  одного модуля»: Xray выпускается отдельно, первый выпуск — только от панели, которая несёт разрез; поверхность `xk-core` —
  граница, её правка — выпуск панели.
- [ ] **Step 4:** PASS; коммит «Проверка выпуска модуля покрывает Xray; RELEASING: отдельный выпуск Xray».

### Task 7: итоговая проверка

- [ ] **Step 1:** `npm run test:py` — 0 failed (журнал в `.superpowers/`, в отчёт — итоговая строка).
- [ ] **Step 2:** `npm run e2e:gate` — 0 failed после повтора; отметка создана.
- [ ] **Step 3:** `npm run archive:user:skip-build`; в архиве есть `static/frontend-build/modules/engine.xray/`,
  `.vite/module.engine.xray.json`; размер JS сборки против `HEAD` до задачи 1 — в журнал (ориентир пробы +0,8 %).
- [ ] **Step 4:** обновить память `project_xray_module_separation_probe.md` (статус, хэши), `MEMORY.md`, `.superpowers/handoff.md`.
  Остановиться: пуш, бета, первый тег `module-engine.xray-*` и роутер — только по слову владельца.

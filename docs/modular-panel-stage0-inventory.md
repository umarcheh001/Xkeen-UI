# Этап 0. Инвентаризация модульной панели Xkeen UI

Статус: **Этап 0 закрыт 29 сентября 2026 года**.

Машинно-читаемый источник истины:

- `docs/modular-panel-stage0-inventory.json`

Генератор:

- `scripts/generate_modular_panel_inventory.py`

Пересборка:

```powershell
python .\scripts\generate_modular_panel_inventory.py --root .
```

## Границы Stage 0

Опись фиксирует текущее состояние, но пока не включает/выключает модули. Каталог будущих модулей ограничен официальным репозиторием `umarcheh001/Xkeen-UI`; произвольные внешние плагины в scope не входят.

Для каждой учтённой единицы JSON хранит обязательные поля:

- `module_id`;
- `kind`;
- `path`;
- `depends_on`;
- `starts_background_task`;
- `registers_routes`;
- `frontend_bundle`;
- `system_requirements`;
- `removable`.

## Сводка модулей

| Module ID | Единиц | Размер | Routes | Background | UI surfaces | Removable |
|---|---:|---:|---:|---:|---:|---|
| `core` | 497 | 6.51 МБ | 104 | 4 | 35 | нет |
| `engine.xray` | 134 | 3.60 МБ | 60 | 3 | 14 | да |
| `engine.mihomo` | 128 | 2.93 МБ | 89 | 4 | 6 | да |
| `tool.editor` | 25 | 813.5 КБ | 0 | 0 | 2 | да |
| `tool.terminal` | 49 | 496.5 КБ | 2 | 2 | 2 | да |
| `tool.files` | 85 | 976.0 КБ | 43 | 1 | 1 | да |
| `tool.backups` | 12 | 112.6 КБ | 17 | 0 | 1 | да |
| `integration.happ` | 22 | 306.5 КБ | 5 | 0 | 1 | да |
| `tool.advanced-diagnostics` | 25 | 585.1 КБ | 8 | 0 | 2 | да |

## Backend routes и регистрация

- Endpoint declarations: **328**.
- Файлов с route decorators/WS dispatch: **54**.
- Точек регистрации: **30**.

Текущее исключение — RemoteFS регистрируется по capability. FS/FileOps защищены `try/except`, но это ещё не пользовательские module gates. Xray, Mihomo, terminal-related и большая часть tool routes сейчас подключаются eagerly.

## Фоновые задачи

| ID | Module | Launcher | Текущий gate |
|---|---|---|---|
| `core.network_executor` | `core` | `ThreadPoolExecutor(NET_EXECUTOR)` | executor exists at import; workers start on submitted network work |
| `core.github_index_fetch` | `core` | `NET_EXECUTOR.submit(_github_fetch_index_items)` | on config catalog request |
| `core.memory_guard` | `core` | `start_memory_guard` | always after server start |
| `terminal.pty_cleanup` | `tool.terminal` | `start_pty_cleanup_loop` | GEVENT_AVAILABLE |
| `xray.subscription_scheduler` | `engine.xray` | `services.xray_subscriptions.start_subscription_scheduler` | always; failure is non-fatal |
| `xray.latency_jobs` | `engine.xray` | `ThreadPoolExecutor(_EXECUTOR)` | on Xray latency/probe request |
| `mihomo.subscription_scheduler` | `engine.mihomo` | `services.mihomo_subscriptions.start_subscription_scheduler` | always; failure is non-fatal |
| `dns.shared_guard` | `engine.xray` | `services.dns_guard.start_guard` | always; coordinates Xray and Mihomo; failure is non-fatal |
| `commands.background_jobs` | `tool.terminal` | `threading.Thread(_run_command_job)` | on command request |
| `cores.background_refresh` | `core` | `threading.Thread(_refresh_cache_in_background)` | on stale cache request |
| `mihomo.clash_telemetry_workers` | `engine.mihomo` | `TelemetryManager worker threads` | on telemetry subscription |
| `mihomo.clash_parallel_snapshot` | `engine.mihomo` | `ThreadPoolExecutor for parallel controller requests` | inside selected Clash API requests |
| `mihomo.traffic_sampler` | `engine.mihomo` | `TrafficAnalyticsSampler thread` | when traffic analytics is started |
| `files.worker_queue` | `tool.files` | `file operation worker threads` | when file operations runtime is used |

## Frontend и UI surfaces

- Canonical/top-level страниц: **5**.
- Вкладок `data-view` в `panel.html`: **6**.
- Статических modal containers в `panel.html`: **53**.
- Нормализованный UTF-8 размер `panel.html`: **1.2 КБ**.

Уже существующие границы, пригодные для модульной загрузки:

- `panel-core` → `xkeen-ui/static/js/pages/panel.entry.js`; файлов: 277; modules: `core`, `engine.mihomo`, `engine.xray`, `integration.happ`, `tool.advanced-diagnostics`, `tool.backups`, `tool.editor`, `tool.files`, `tool.terminal`.
- `panel-routing` → `xkeen-ui/static/js/pages/panel.routing.bundle.js`; файлов: 67; modules: `core`, `engine.xray`, `integration.happ`, `tool.backups`, `tool.editor`.
- `panel-mihomo` → `xkeen-ui/static/js/pages/panel.mihomo.bundle.js`; файлов: 23; modules: `core`, `engine.mihomo`, `engine.xray`, `tool.editor`.
- `terminal-lazy` → `xkeen-ui/static/js/pages/terminal.lazy.entry.js`; файлов: 177; modules: `core`, `engine.mihomo`, `engine.xray`, `integration.happ`, `tool.advanced-diagnostics`, `tool.backups`, `tool.editor`, `tool.files`, `tool.terminal`.
- `file-manager-lazy` → `xkeen-ui/static/js/pages/file_manager.lazy.entry.js`; файлов: 34; modules: `core`, `tool.files`.
- `backups-page` → `xkeen-ui/static/js/pages/backups.entry.js`; файлов: 277; modules: `core`, `engine.mihomo`, `engine.xray`, `integration.happ`, `tool.advanced-diagnostics`, `tool.backups`, `tool.editor`, `tool.files`, `tool.terminal`.
- `devtools-page` → `xkeen-ui/static/js/pages/devtools.entry.js`; файлов: 277; modules: `core`, `engine.mihomo`, `engine.xray`, `integration.happ`, `tool.advanced-diagnostics`, `tool.backups`, `tool.editor`, `tool.files`, `tool.terminal`.
- `xkeen-page` → `xkeen-ui/static/js/pages/xkeen.entry.js`; файлов: 277; modules: `core`, `engine.mihomo`, `engine.xray`, `integration.happ`, `tool.advanced-diagnostics`, `tool.backups`, `tool.editor`, `tool.files`, `tool.terminal`.
- `mihomo-generator-page` → `xkeen-ui/static/js/pages/mihomo_generator.entry.js`; файлов: 277; modules: `core`, `engine.mihomo`, `engine.xray`, `integration.happ`, `tool.advanced-diagnostics`, `tool.backups`, `tool.editor`, `tool.files`, `tool.terminal`.

## Обнаруженные архитектурные связи

| From | To | Units | Примеры |
|---|---|---:|---|
| `core` | `engine.mihomo` | 17 | `xkeen-ui/app_factory.py`<br>`xkeen-ui/run_server.py`<br>`xkeen-ui/routes/__init__.py` |
| `core` | `engine.xray` | 34 | `xkeen-ui/app.py`<br>`xkeen-ui/app_factory.py`<br>`xkeen-ui/routes/__init__.py` |
| `core` | `integration.happ` | 5 | `xkeen-ui/routes/__init__.py`<br>`tests/test_check_keys_upstream.py`<br>`tests/test_module_backend_gates.py` |
| `core` | `tool.advanced-diagnostics` | 8 | `xkeen-ui/routes/__init__.py`<br>`xkeen-ui/services/router_modem_control.py`<br>`tests/test_devtools_env_whitelist.py` |
| `core` | `tool.backups` | 10 | `xkeen-ui/app_factory.py`<br>`xkeen-ui/routes/__init__.py`<br>`tests/test_backup_path_hardening.py` |
| `core` | `tool.editor` | 10 | `xkeen-ui/static/js/pages/panel.editor.bundle.js`<br>`xkeen-ui/static/js/pages/panel.editor.codemirror.bundle.js`<br>`xkeen-ui/static/js/pages/panel.editor.diff.bundle.js` |
| `core` | `tool.files` | 9 | `xkeen-ui/app_factory.py`<br>`xkeen-ui/routes/__init__.py`<br>`tests/test_filemanager_trash_policy.py` |
| `core` | `tool.terminal` | 16 | `xkeen-ui/app.py`<br>`xkeen-ui/app_factory.py`<br>`xkeen-ui/run_server.py` |
| `engine.mihomo` | `core` | 128 | `xkeen-ui/bootstrap_mihomo_env.py`<br>`xkeen-ui/mihomo_config_generator.py`<br>`xkeen-ui/mihomo_server_core.py` |
| `engine.mihomo` | `engine.xray` | 6 | `xkeen-ui/routes/mihomo.py`<br>`xkeen-ui/services/mihomo_clash_devices.py`<br>`xkeen-ui/services/mihomo_clash_dto.py` |
| `engine.mihomo` | `integration.happ` | 3 | `xkeen-ui/routes/mihomo.py`<br>`xkeen-ui/services/mihomo_subscriptions.py`<br>`xkeen-ui/static/js/features/mihomo_import.js` |
| `engine.mihomo` | `tool.advanced-diagnostics` | 1 | `xkeen-ui/routes/mihomo_clash.py` |
| `engine.mihomo` | `tool.backups` | 1 | `xkeen-ui/routes/mihomo.py` |
| `engine.mihomo` | `tool.editor` | 128 | `xkeen-ui/bootstrap_mihomo_env.py`<br>`xkeen-ui/mihomo_config_generator.py`<br>`xkeen-ui/mihomo_server_core.py` |
| `engine.mihomo` | `tool.terminal` | 3 | `xkeen-ui/routes/mihomo.py`<br>`xkeen-ui/services/mihomo_dns.py`<br>`xkeen-ui/services/mihomo_runtime.py` |
| `engine.xray` | `core` | 134 | `xkeen-ui/routes/routing/__init__.py`<br>`xkeen-ui/routes/routing/blueprint.py`<br>`xkeen-ui/routes/routing/config.py` |
| `engine.xray` | `engine.mihomo` | 1 | `xkeen-ui/services/xray_subscriptions.py` |
| `engine.xray` | `integration.happ` | 2 | `xkeen-ui/services/xray_subscriptions.py`<br>`xkeen-ui/static/js/features/outbounds.js` |
| `engine.xray` | `tool.backups` | 2 | `xkeen-ui/routes/routing/config.py`<br>`xkeen-ui/routes/xray_configs.py` |
| `engine.xray` | `tool.editor` | 134 | `xkeen-ui/routes/routing/__init__.py`<br>`xkeen-ui/routes/routing/blueprint.py`<br>`xkeen-ui/routes/routing/config.py` |
| `engine.xray` | `tool.files` | 3 | `xkeen-ui/routes/routing/dat.py`<br>`xkeen-ui/routes/routing/dat_files.py`<br>`xkeen-ui/services/geodat/runner.py` |
| `engine.xray` | `tool.terminal` | 2 | `xkeen-ui/routes/routing/config.py`<br>`xkeen-ui/routes/xray_configs.py` |
| `integration.happ` | `core` | 22 | `xkeen-ui/routes/happ_decryptor.py`<br>`xkeen-ui/services/happ_decryptor/__init__.py`<br>`xkeen-ui/services/happ_decryptor/engine.py` |
| `integration.happ` | `engine.mihomo` | 2 | `xkeen-ui/services/mihomo_hwid_sub.py`<br>`xkeen-ui/static/js/features/mihomo_hwid_sub.js` |
| `integration.happ` | `engine.xray` | 2 | `xkeen-ui/services/happ_decryptor/engine.py`<br>`xkeen-ui/services/mihomo_hwid_sub.py` |
| `integration.happ` | `tool.advanced-diagnostics` | 2 | `tests/test_happ_decryptor_env.py`<br>`xkeen-ui/static/js/features/devtools/happ_decryptor.js` |
| `tool.advanced-diagnostics` | `core` | 25 | `xkeen-ui/routes/system_resources.py`<br>`xkeen-ui/services/devtools/__init__.py`<br>`xkeen-ui/services/devtools/common.py` |
| `tool.advanced-diagnostics` | `engine.mihomo` | 1 | `xkeen-ui/static/js/pages/devtools.entry.js` |
| `tool.advanced-diagnostics` | `engine.xray` | 2 | `xkeen-ui/services/devtools/logs.py`<br>`xkeen-ui/static/js/features/devtools/logs.js` |
| `tool.advanced-diagnostics` | `integration.happ` | 2 | `xkeen-ui/services/devtools/env.py`<br>`xkeen-ui/static/js/pages/devtools.screen.bootstrap.js` |
| `tool.advanced-diagnostics` | `tool.editor` | 1 | `xkeen-ui/static/js/pages/devtools.screen.bootstrap.js` |
| `tool.advanced-diagnostics` | `tool.terminal` | 1 | `xkeen-ui/services/devtools/env.py` |
| `tool.backups` | `core` | 12 | `xkeen-ui/routes/backups.py`<br>`xkeen-ui/services/mihomo_backups.py`<br>`xkeen-ui/services/xray_backups.py` |
| `tool.backups` | `engine.mihomo` | 2 | `xkeen-ui/services/mihomo_backups.py`<br>`xkeen-ui/static/js/pages/backups.entry.js` |
| `tool.backups` | `engine.xray` | 2 | `xkeen-ui/routes/backups.py`<br>`xkeen-ui/static/js/features/backups.js` |
| `tool.backups` | `tool.editor` | 1 | `xkeen-ui/static/js/pages/backups.screen.bootstrap.js` |
| `tool.editor` | `core` | 25 | `xkeen-ui/static/js/pages/codemirror6.shared.js`<br>`xkeen-ui/static/js/pages/editor.shared.js`<br>`xkeen-ui/static/js/pages/editor_monaco.shared.js` |
| `tool.editor` | `engine.xray` | 2 | `xkeen-ui/static/js/ui/dat_contents_modal.js`<br>`xkeen-ui/static/js/ui/json_editor_modal.js` |
| `tool.files` | `core` | 85 | `xkeen-ui/routes/fileops/__init__.py`<br>`xkeen-ui/routes/fileops/blueprint.py`<br>`xkeen-ui/routes/fileops/endpoints_http.py` |
| `tool.files` | `engine.xray` | 1 | `xkeen-ui/routes/fs/endpoints_transfer.py` |
| `tool.files` | `tool.backups` | 1 | `xkeen-ui/routes/fs/blueprint.py` |
| `tool.terminal` | `core` | 49 | `xkeen-ui/routes/commands.py`<br>`xkeen-ui/services/command_jobs.py`<br>`xkeen-ui/services/ws_pty.py` |

## Ключевые выводы

### `all-blueprints-mostly-eager`

Большинство Blueprint регистрируется без пользовательских module gates.

Следующий шаг: Этап 4: разделить frontend shell и экраны.

### `mihomo-startup-is-eager`

Mihomo scheduler запускается из app_factory независимо от выбранного пользовательского профиля.

Следующий шаг: Этап 3: запускать только при enabled engine.mihomo.

### `panel-template-is-monolithic`

Главный panel.html одновременно владеет surface всех будущих модулей.

Следующий шаг: Этап 4: template partials и module composition.

### `core-couples-to-optional-modules`

Core сейчас импортирует код будущих отключаемых модулей.

Следующий шаг: Этапы 4/5: сохранить frontend module boundaries.

### `frontend-split-is-useful-baseline`

Routing, Mihomo, terminal и file manager уже имеют отдельные ESM roots.

Следующий шаг: Этап 5: привязать import() к enabled modules.

### `optional-tools-have-large-owned-scope`

Terminal, files, editor и diagnostics можно отделять независимо от engine-профиля.

Следующий шаг: Этапы 4, 5 и 6.

## Решения о границах модулей

- `core` остаётся единственным неудаляемым модулем.
- `engine.xray` и `engine.mihomo` независимы на уровне профиля, но текущий код ещё содержит прямые связи.
- `tool.editor`, `tool.terminal`, `tool.files`, `tool.backups` и `tool.advanced-diagnostics` считаются отдельными отключаемыми областями.
- Happ вынесен в `integration.happ`, хотя сейчас часть UI и API находится внутри Mihomo flows.
- Общий DNS guard отмечен как Xray-owned mixed boundary; до Stage 3 его нужно разделить или превратить в registry hook без зависимости core от engine.

## Критерий завершения

Критерий завершения **выполнен**:

- routes/Blueprint нанесены на карту;
- services и background tasks нанесены на карту;
- frontend entrypoints/bundles/features нанесены на карту;
- templates, panel views и modals нанесены на карту;
- CSS, editor schemas, tests и configuration assets включены в unit inventory;
- для каждой учтённой единицы определён будущий `module_id`;
- выявлены current gates и cross-module coupling;
- snapshot защищён тестом на синхронность с генератором.

Следующий этап: **Этап 4 — разделение frontend shell и экранов**.

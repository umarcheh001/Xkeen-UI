# Этап 3. Backend gates

**Статус:** закрыт 29 сентября 2026 года.

Этап 3 переводит backend с eager-регистрации на composition по активному
набору Module Registry. Отключённый модуль не регистрирует свой Blueprint,
не запускает module-owned startup tasks и не импортируется из центрального
реестра маршрутов.

## Активация

`ModuleRegistry.runtime_activation()` формирует набор
`active_module_ids` перед созданием Flask-приложения.

- `legacy-full` сохраняет совместимость старых установок: все прежние
  поставляемые модули активируются как раньше;
- custom-профиль использует включённые модули после проверки зависимостей и
  обязательных системных требований;
- `core` всегда активен;
- snapshot активного набора хранится в
  `UI_STATE_DIR/module-runtime.json`.

`/api/modules` и `/api/capabilities` возвращают
`runtime_gates_active: true` для запущенного приложения.

## Gated области

- `engine.xray`: routing/config/subscription/log Blueprint, mobile routing
  API, Xray subscription scheduler, DNS migration и DNS guard;
- `engine.mihomo`: Mihomo Blueprint, Clash API/cache/telemetry, Mihomo
  subscriptions scheduler и Mihomo WebSocket handlers;
- `integration.happ`: Happ decryptor API;
- `tool.terminal`: command API, PTY/command WebSocket handlers и PTY cleanup;
- `tool.files`: FS, RemoteFS, FileOps и USB storage;
- `tool.advanced-diagnostics`: DevTools, system resources и DevTools WS;
- `tool.backups`: backup Blueprint.

Общие core routes — auth, settings, registry, capabilities, service-control,
config exchange и cores status — остаются зарегистрированными.

## Поведение отключённых модулей

Маршруты отключённых Blueprint не регистрируются и отвечают стандартным
`404`. Это исключает случайные `500` при запросах к Mihomo/Xray/terminal/files
после отключения модуля.

`run_server.py` выбирает WebSocket handler только для активного владельца.
Для совместимости с существующим static import-contract service imports
сохраняются, но Mihomo WS, PTY и Xray log handlers не выбираются и не
выполняются для отключённых модулей.

Gated Mihomo markup и Mihomo-specific backend API отсутствуют в
Xray-only profile. Полное разделение frontend entrypoints выполняется на
Этапе 4/5, чтобы не нарушить действующий frontend static-contract.

## Проверка

- `tests/test_module_backend_gates.py` проверяет Xray-only и Mihomo-only
  composition, отсутствие отключённых route groups и runtime flags;
- `tests/test_module_registry.py` проверяет legacy-full и custom activation;
- snapshot Этапа 0 пересобран и защищён синхронным test guard;
- targeted backend tests и Ruff проходят.

Критерий готовности Этапа 3: **выполнен**.

Следующий этап: **Этап 4 — разделение frontend shell и экранов**.

# План модульной архитектуры панели Xkeen UI

**Статус:** Этапы 0, 1, 2, 3, 3R, 3R.1, 4 и 5 закрыты;
следующий — Этап 6<br>
**Дата:** 1 октября 2026 года
**Область:** облегчение панели, профили установки и официальный каталог модулей

**Текущий прогресс:** Этапы 0–3 и 3R, подэтапы 4.1, 4.2 и 4.3 закрыты;
Этап 3R.1 и baseline initial HTML закрыты; в подэтапе 4.3 все шесть экранов
вынесены в module-owned partials, minimal-профили открываются без console
errors. В подэтапе 4.4 все модальные окна разнесены по владельцам. В
подэтапе 4.5 server composition переведена на allow-listed active-module
manifest и единый `page_context`. Подэтап 4.6 закрепил server-rendered
совместимость профилей, удаление монолитной screen/modal-разметки и ownership
составных modal. Этап 4 закрыт. Этап 5 динамической frontend-загрузки также
закрыт 1 октября 2026 года; следующий — Этап 6.

Историческая отметка подэтапа composition: **Этап 4 закрыт; следующий — Этап 5**.

## 1. Цель проекта

Сделать панель Xkeen UI модульной, чтобы пользователь устанавливал только нужный функционал:

- вариант только с Xray;
- вариант только с Mihomo;
- вариант с обоими ядрами;
- минимальный или расширенный набор инструментов;
- возможность позже включать, отключать, устанавливать и удалять официальные модули.

Главная цель — не просто скрыть ненужные вкладки, а не загружать и не запускать неиспользуемый код:

- не регистрировать ненужные backend-маршруты;
- не запускать ненужные фоновые задачи;
- не загружать лишние frontend-бандлы;
- не показывать лишние разделы интерфейса;
- уменьшить расход памяти, время запуска и сложность панели.

## 2. Важное ограничение каталога модулей

На первом этапе каталог модулей **не будет произвольным marketplace**.

Единственным источником модулей будет официальный репозиторий Xkeen UI:

```text
https://github.com/umarcheh001/Xkeen-UI
```

Это означает:

- не поддерживаем установку модулей из любых GitHub-репозиториев;
- не выполняем произвольные install-скрипты сторонних авторов;
- не принимаем пользовательские URL архивов;
- не добавляем сторонние репозитории в интерфейс;
- каталог и версии модулей контролируются проектом Xkeen UI;
- совместимость модулей проверяется вместе с релизом панели.

В будущем отдельный marketplace можно рассмотреть отдельно, но он не входит в текущий план.

## 3. Принцип архитектуры

Предлагаемая модель:

```text
Xkeen UI Core
├── engine.xray
├── engine.mihomo
├── tool.editor*
├── tool.terminal
├── tool.files
├── tool.backups
├── tool.advanced-diagnostics
└── integration.happ
```

`tool.editor` со звёздочкой — не полностью независимый runtime-модуль:
`engine.xray` и `engine.mihomo` требуют его базовый вариант. Поэтому в
профилях он управляется как обязательная frontend-комплектация (`light/full`),
а не как произвольно отключаемая backend-возможность.

### 3.1. Ядро панели

В ядре остаются только функции, необходимые для запуска и управления панелью:

- авторизация;
- базовый web-shell;
- общие настройки;
- capabilities и module registry;
- управление сервисом панели;
- самообновление панели;
- core.log и базовая диагностика;
- общий журнал операций;
- механизм резервного копирования и аварийного снятия сетевой защиты;
- менеджер модулей;
- обработка ошибок и режим восстановления;
- общий lifecycle DNS-защиты: сторож, owner-state и release при остановке
  сервиса любого активного ядра.

Ядро не должно напрямую зависеть от Mihomo, файлового менеджера или терминала.
Для DNS-защиты core использует provider hooks активных ядер, но сам lifecycle
не должен находиться под gate только одного `engine.xray`.

### 3.2. Модуль Xray

`engine.xray`:

- routing;
- inbounds;
- outbounds;
- конфигурации Xray;
- Xray subscriptions;
- Xray logs;
- preflight-проверки;
- DNS-over-VLESS;
- geodat;
- Xray-схемы, подсказки и quick-fix редактора.

Xray предоставляет core свои DNS/provider hooks. Общий сторож и снятие
защиты принадлежат core и должны работать также в Xray-only и Mihomo-only
профилях.

### 3.3. Модуль Mihomo

`engine.mihomo`:

- конфигурация Mihomo;
- Clash API;
- группы, прокси и подключения;
- Mihomo DNS;
- генератор конфигурации;
- импорт конфигураций;
- HWID/Happ subscriptions;
- инструменты прокси;
- telemetry и traffic analytics;
- интеграция с Zashboard.

Mihomo предоставляет provider hooks для общего DNS lifecycle. Наличие
`engine.mihomo` без `engine.xray` не должно превращать API снятия защиты
в заглушку.

### 3.4. Инструмент редактора

`tool.editor`:

- CodeMirror;
- Monaco;
- JSON/YAML редакторы;
- схемы и валидация;
- форматирование;
- diff-viewer;
- подсказки и quick-fix.

`tool.editor` должен иметь варианты комплектации:

- лёгкий режим: только CodeMirror;
- расширенный режим: CodeMirror и Monaco;
- отдельные optional-возможности editor (Monaco, diff, quick-fix) отключены.

Полностью отключить базовый editor нельзя, если активен хотя бы один engine:
оба engine используют editor как зависимость. В registry это должно быть
выражено через обязательную зависимость `editor.light`, а не через
недостижимый сценарий `tool.editor = disabled`.

### 3.5. Терминал

`tool.terminal`:

- WebSocket;
- PTY;
- xterm;
- command jobs;
- shell policy;
- потоковые логи.

Если терминал отключён или системная среда не поддерживает PTY, основная панель должна продолжать работать.

### 3.6. Файловый менеджер

`tool.files`:

- локальный файловый менеджер;
- загрузка и скачивание;
- архивы;
- удалённая файловая система;
- file operations;
- USB/storage helpers, если они относятся к файловым сценариям.

### 3.7. Интеграция Happ и общие subscription helpers

`integration.happ` сейчас смешивает два разных слоя:

- runtime helpers (`happ_links`, `happ_payloads`), которые
  `xray_subscriptions` и Mihomo subscriptions импортируют напрямую, в обход
  module gates;
- опциональные API/UI декриптора, проверки и HWID flows.

**Решение:** общие subscription helpers (`happ_links`, `happ_payloads`)
переносятся во владение core (inventory, owner map, будущий состав пакета).
`integration.happ` оставляет только API/UI декриптора и HWID. Иначе удаление
файлов модуля на Этапах 7–8 сломает Xray subscriptions, хотя профиль
Xray Minimal этот модуль не содержит.

HWID-модалка и кнопка принадлежат `integration.happ`, но имеют смысл только
при `engine.mihomo`: для них нужен составной gate
`integration.happ AND engine.mihomo` (см. подэтап 4.4).

**Обязательное требование владельца проекта:** всё, что видит пользователь,
должно быть нейтральным и не называть стороннее приложение и декриптор.
Это относится к отображаемому имени и описанию модуля в `/api/modules`,
`/api/capabilities` и будущем разделе «Модули», к текстам ошибок, профилей
и установщика. Рабочая формулировка: «Утилита ссылок подписок». Внутренний
`module_id` `integration.happ` может остаться до отдельного решения о
переименовании, но в UI не показывается.

### 3.8. Резервные копии и расширенная диагностика

Механизм создания и хранения backup остаётся частью core, потому что он нужен
для rollback, обновлений и безопасного отключения модулей. `tool.backups`
содержит только отдельную страницу и API просмотра/восстановления.

`tool.advanced-diagnostics` содержит расширенные DevTools, router diagnostics и
служебные инструменты. Самообновление панели, `core.log` и будущий менеджер
модулей должны принадлежать core, иначе отключение диагностики лишает
пользователя управления панелью.

## 4. Состояния модулей

Каждый модуль должен иметь понятное состояние:

| Состояние | Значение |
|---|---|
| `not_installed` | Файлы модуля отсутствуют |
| `installed` | Отдельный boolean-признак наличия файлов модуля, не runtime-состояние |
| `enabled` | Backend, frontend и фоновые задачи активны |
| `disabled` | Модуль установлен, но пользователь его отключил |
| `unavailable` | Модуль установлен, но не выполнены системные зависимости |
| `failed` | Последняя инициализация завершилась ошибкой |

Для API нужен единый формат:

```json
{
  "id": "engine.mihomo",
  "installed": true,
  "enabled": false,
  "available": true,
  "version": "1.0.0",
  "reason": "user_disabled",
  "requires_restart": true
}
```

Наличие бинарника не должно автоматически означать включённый пользовательский модуль. Нужно разделять:

- обнаружен ли компонент;
- установлен ли модуль панели;
- включил ли его пользователь;
- доступен ли он в текущей среде.

## 5. Профили установки

### 5.1. Xray Minimal

Включает:

- ядро панели (включая общие subscription helpers, см. §3.7);
- `engine.xray`;
- `tool.editor` в режиме `light`;
- core-механизм backup и базовой диагностики.

Не включает:

- Mihomo;
- Clash API;
- Mihomo генератор;
- терминал;
- файловый менеджер;
- страницу `tool.backups`, если она не выбрана отдельно;
- Monaco и расширенные инструменты.

### 5.2. Mihomo Minimal

Включает:

- ядро панели;
- `engine.mihomo`;
- `tool.editor` в режиме `light`;
- core-механизм backup и базовой диагностики.

Не включает неиспользуемые Xray-разделы и инструменты. Если Mihomo flow
использует Happ/HWID API, подключается соответствующий слой
`integration.happ`.

### 5.3. Full

Включает:

- Xray;
- Mihomo;
- терминал;
- файловый менеджер;
- расширенный редактор;
- расширенную диагностику;
- дополнительные интеграции.

### 5.4. Custom

Пользователь выбирает модули вручную. Интерфейс должен показывать:

- размер модуля;
- зависимости;
- конфликты;
- необходимость перезапуска;
- функции, которые станут недоступны после отключения.

### 5.4.1. Идентификаторы профилей

Названия профилей в плане, коде и контракте 4.1 должны совпадать. Канонические
id: `legacy-full`, `full`, `xray-minimal`, `mihomo-minimal`, `custom`.
Контракт 4.1 и baseline 3R.1.6 переведены на канонические id 30 сентября
2026 года (baseline снят на коммите со старыми `xray-only`/`mihomo-only`,
генератор сопоставляет их при пересборке). Пресеты профилей хранятся в
registry, а не только в документации; пресеты и атомарный переход между
профилями реализуются в Этапе 7.

Переход между профилями выполняется одной атомарной операцией
(`POST /api/modules/profile`), а не цепочкой PATCH: промежуточные состояния
могут быть недопустимы (например, временно без engine). Ответ на любое
изменение (PATCH или профиль) содержит diff «что станет активным / неактивным
после перезапуска», включая модули, которые выпадут из-за невыполненных
системных требований при уходе из `legacy-full`.

### 5.5. Совместимость со старыми установками

Существующие пользователи не должны потерять функциональность после обновления.

Правило миграции:

- старые установки автоматически переходят в профиль `Full` или `Legacy`;
- текущий набор доступных функций сохраняется;
- пользователь сможет перейти на минимальный профиль позже;
- перед отключением модуля создаётся резервная копия настроек;
- конфигурации Xray и Mihomo не удаляются автоматически при отключении модуля.

### 5.6. Безопасное отключение активных компонентов

Операция disable/install/remove не может выполняться только по проверке
статических зависимостей. Перед изменением состояния нужно проверить:

- активное ядро и владельца сервиса;
- включённую DNS-защиту и наличие managed interception rules;
- запущенные scheduler/WS/PTY workers;
- зависимые модули и pending restart.

Если выключение оставит сеть без владельца или без корректного release,
API отвечает `409` с машинным кодом вроде `dns_protection_active` или
`active_core_module`. Альтернативный путь — сначала выполнить безопасное
снятие защиты и только затем принять изменение состояния.

«Активное ядро» — это ядро, которое **сейчас запущено** xkeen (источник —
`cores_status`), а не модуль из runtime activation текущего процесса. Иначе
в Full-профиле нельзя отключить даже неработающий Mihomo, и переход
Full → Xray Minimal невозможен.

Изменение состояния вступает в силу только после перезапуска, поэтому
проверка в момент PATCH недостаточна: между PATCH и рестартом можно включить
DNS-защиту или переключить ядро. Проверка повторяется при старте
(`initialize_for_startup`); если отложенное отключение стало опасным, модуль
остаётся активным на время текущего процесса, а причина
(`deferred_disable_blocked`) видна в `/api/modules` и пишется в `core.log`.
Выбор пользователя в state при этом не меняется.

## 6. Этапы работ

## Этап 0. Инвентаризация текущей панели — закрыт

Статус этапа: **закрыт 29 сентября 2026 года**.

Артефакты:

- `docs/modular-panel-stage0-inventory.json` — machine-readable snapshot;
- `docs/modular-panel-stage0-inventory.md` — человекочитаемый контракт и выводы;
- `scripts/generate_modular_panel_inventory.py` — воспроизводимый генератор;
- `tests/test_modular_panel_stage0_inventory.py` — guardrails синхронности и полноты.

Пересборка:

```powershell
python .\scripts\generate_modular_panel_inventory.py --root .
```

### Задачи

Составить машинно-читаемую карту функциональности:

- Python routes и Blueprint;
- services;
- фоновые задачи и scheduler;
- frontend entrypoints;
- frontend feature-модули;
- HTML-секции и модальные окна;
- CSS;
- схемы редакторов;
- системные зависимости;
- тесты;
- файлы конфигурации;
- зависимости между компонентами.

Для каждой единицы определить:

```text
module_id
kind
path
depends_on
starts_background_task
registers_routes
frontend_bundle
system_requirements
removable
```

### Первичные области анализа

- `xkeen-ui/routes/__init__.py`;
- `xkeen-ui/app_factory.py`;
- `xkeen-ui/routes/pages.py`;
- `xkeen-ui/services/capabilities.py`;
- `xkeen-ui/templates/panel.html`;
- `xkeen-ui/static/js/pages/panel.entry.js`;
- `xkeen-ui/static/js/pages/panel.routing.bundle.js`;
- `xkeen-ui/static/js/pages/panel.mihomo.bundle.js`;
- `xkeen-ui/static/js/features/`;
- существующий `/api/capabilities`.

### Результат

Результат зафиксирован в:

- `docs/modular-panel-stage0-inventory.json`;
- `docs/modular-panel-stage0-inventory.md`.

Опись покрывает routes/Blueprint, services, фоновые механизмы, frontend roots/features,
templates, CSS, editor schemas, backend/E2E tests и configuration assets. Для каждой
учтённой единицы определены будущий `module_id`, зависимости, routes, background role,
frontend bundle, системные требования и возможность удаления.

### Критерий готовности

Критерий готовности: **выполнен**.

Для каждой вкладки, API, фоновой задачи и крупного frontend-модуля определён будущий
пакет. Snapshot автоматически пересобирается и сравнивается с committed-версией в тестах.

## Этап 1. Базовый Module Registry — закрыт

Статус этапа: **закрыт 29 сентября 2026 года**.

### Задачи

Задача выполнена. Создан реестр модулей:

- стабильный `module_id`;
- отображаемое имя;
- описание;
- версия;
- зависимости;
- конфликты;
- системные требования;
- размер;
- возможность отключения;
- необходимость перезапуска;
- версия API;
- текущий статус.

Добавлено хранение активного набора в UI state:

```text
UI_STATE_DIR/modules.json
```

Предусмотрены schema v1 и миграции. Реализация и контракт зафиксированы в
`docs/modular-panel-stage1-module-registry.md`.

### Набор идентификаторов

```text
core
engine.xray
engine.mihomo
tool.editor
tool.terminal
tool.files
tool.backups
integration.happ
tool.advanced-diagnostics
```

### API

Добавлен отдельный стабильный API:

```text
GET  /api/modules
GET  /api/modules/<module_id>
PATCH /api/modules/<module_id>
POST /api/modules/<module_id>/enable
POST /api/modules/<module_id>/disable
```

На этом этапе операции могут только менять конфигурацию и просить перезапуск. Фактическое удаление файлов пока не нужно.

### Реализовано

- `xkeen-ui/services/module_registry.py` — статический реестр, статусы,
  зависимости, системные требования, schema v1 и миграции;
- `xkeen-ui/routes/modules.py` — стабильный API `/api/modules`;
- `UI_STATE_DIR/modules.json` — атомарное сохранение выбранного набора;
- `tests/test_module_registry.py` — unit/API/миграционные guardrails.

На этом этапе runtime-gates намеренно выключены:
`runtime_gates_active: false`. Поэтому существующая регистрация backend,
загрузка frontend и фоновые задачи не меняют поведение панели.

### Критерий готовности

Критерий готовности: **выполнен**.

Панель показывает полный реестр, определяет эффективный набор модулей,
сохраняет enable/disable в версионируемом состоянии и выполняет это без
изменения текущего runtime-поведения.

## Этап 2. Расширение capabilities — закрыт

Статус этапа: **закрыт 29 сентября 2026 года**.

### Задачи

Задача выполнена. Расширен существующий `/api/capabilities` без изменения
старого формата:

```json
{
  "runtime": {},
  "cores": {},
  "terminal": {},
  "remoteFs": {},
  "modules": {
    "core": {},
    "engine.xray": {},
    "engine.mihomo": {},
    "tool.editor": {},
    "tool.terminal": {},
    "tool.files": {}
  }
}
```

Разделить:

- capabilities среды;
- установленные модули;
- включённые модули;
- фактическую доступность;
- причину недоступности.

Реализация и контракт зафиксированы в
`docs/modular-panel-stage2-capabilities.md`.

### Критерий готовности

Критерий готовности: **выполнен**.

Frontend получает через capabilities полный module projection с состояниями,
причинами, зависимостями и mapping `frontend.bundles`/`navigation_views`.
Runtime-gates пока выключены (`runtime_gates_active: false`); их включение
относится к Этапу 3.

## Этап 3. Backend gates — закрыт

Статус этапа: **закрыт 29 сентября 2026 года**.

### Задачи

Задача выполнена. Регистрация backend-возможностей переведена с
безусловной на composition активных модулей.

В первую очередь вынести под gates:

- Mihomo Blueprint;
- Mihomo Clash API;
- Mihomo subscriptions scheduler;
- Mihomo cache и telemetry;
- Xray subscriptions scheduler;
- DNS guard;
- terminal/WebSocket/PTY;
- FS, RemoteFS и FileOps;
- storage/USB helpers;
- расширенные DevTools.

Нужен безопасный порядок запуска:

1. загрузить registry;
2. определить профиль;
3. проверить зависимости;
4. активировать модули;
5. зарегистрировать их routes;
6. запустить их фоновые задачи;
7. записать результат в диагностику.

### Важное правило

Если `engine.mihomo` выключен:

- Mihomo scheduler не запускается;
- Mihomo-specific Blueprint не регистрируется;
- Mihomo API-запросы не выполняются;
- Xray и core продолжают работать.

Требование «Mihomo frontend-бандлы не загружаются» относится к Этапу 5 и
проверяется там в browser Network; закрытие Этапа 3 его не покрывает.

### Отключённые API

Для отключённых модулей нужен предсказуемый ответ:

- `404`, если route не зарегистрирован;
- либо `501 module_not_enabled`, если нужен общий compatibility endpoint.

Нельзя допускать случайных `500` из-за отсутствующей зависимости.

### Критерий готовности

Критерий готовности: **выполнен**.

Xray-only и Mihomo-only composition покрыты тестами: отключённые Blueprint
не регистрируются, module-owned scheduler и WebSocket handlers не запускаются,
а `/api/modules` и `/api/capabilities` показывают активный runtime набор.
Реализация и полный контракт: `docs/modular-panel-stage3-backend-gates.md`.

## Этап 3R. Runtime safety hardening после review

**Статус:** закрыт 29 сентября 2026 года.

Этап 3 закрыл базовую регистрацию gates, но повторная проверка текущего кода
выявила cross-module случаи, которые нельзя оставлять на усмотрение профиля.
Этап 3R не отменяет закрытие Этапа 3, а дополняет его эксплуатационными
гарантиями.

Артефакт контракта: `docs/modular-panel-stage3r-runtime-safety.md`.
Generated size metadata: `xkeen-ui/module-sizes.json`, обновляется
`scripts/sync_module_sizes.py`.

### 3R.1. Общий lifecycle DNS-защиты

- вынести `dns_guard`, `dns_stop_status` и `dns_stop_release` из
  `engine.xray`-only gate в core-owned lifecycle;
- активировать сторож, если включено хотя бы одно ядро, Xray или Mihomo;
- передавать engine-specific provider hooks через явный интерфейс;
- покрыть Mihomo-only сценарий: остановка Mihomo, возврат DNS и повторный
  запуск не оставляют сеть без resolver;
- сохранять owner-state и audit trail при установке/снятии защиты.

### 3R.2. Безопасное изменение состояния модулей

`ModuleRegistry.set_enabled()` сейчас проверяет зависимости и конфликты, но
этого недостаточно для работающей сети. Перед disable/remove нужно проверять:

- является ли модуль владельцем активного ядра;
- включена ли DNS-over-VLESS/interception-защита;
- есть ли активные scheduler, WebSocket, PTY или file workers;
- не требуется ли сначала безопасный release и restart.

Запрещённые операции должны отвечать `409` с машинным кодом
`dns_protection_active`, `active_core_module` или эквивалентным стабильным
кодом. Нельзя оставлять конфигурацию активной, а владельца выключать.

### 3R.3. Core-owned maintenance

Пересмотреть границу `tool.advanced-diagnostics`:

- самообновление панели;
- чтение `core.log`;
- базовая диагностика;
- менеджер модулей;
- recovery/safe-mode UI

должны работать без `tool.advanced-diagnostics`. В DevTools остаются только
расширенные диагностика, router diagnostics и developer-oriented инструменты.
Blueprint и frontend route для maintenance нужно разделить на core-owned и
optional advanced части.

### 3R.4. Runtime state и восстановление

- `is_runtime_active()` должен читать зафиксированный `_runtime_activation`
  текущего процесса, а не заново вычислять состояние с диска после PATCH;
- повреждённый `modules.json` сохранять как `modules.json.bad` с timestamp,
  писать событие в `core.log` и переходить в безопасный `legacy-full`;
- неизвестную новую schema version нельзя молча сводить к v1 с потерей полей:
  нужен read-only fallback, миграция или явный recovery error;
- документировать аварийный режим `legacy-full`: переменная окружения
  `XKEEN_UI_MODULE_SAFE_MODE=legacy-full`, CLI/SSH-путь и условия выхода из
  safe mode;
- state migration должна иметь отдельные тесты для битого файла, неизвестной
  версии и отката панели на старую версию.

### 3R.5. Исправление ownership и зависимостей

- `integration.happ` не должен зависеть только от `engine.mihomo`, если
  `xray_subscriptions` импортирует `happ_links`; нужен `any-of` contract или
  перенос общих helpers в core;
- `tool.editor` оставить обязательной зависимостью активного engine с
  вариантами `light/full`, но не обещать недостижимое полное отключение;
- в core оставить backup primitives, а в `tool.backups` — страницу и API
  просмотра/восстановления;
- зарегистрированные Blueprint, scheduler и WS handler должны иметь одного
  явного владельца из registry.

### 3R.6. Inventory и метрики

Проблема с `CRLF` из review для текущего генератора уже устранена:
`generate_modular_panel_inventory.py` считает canonical UTF-8 text size.
Остаётся убрать ручную связанность размеров:

- не использовать `size_bytes` из `ModuleRegistry` как независимый источник;
- генерировать package/module sizes на build из фактического состава;
- snapshot-тестом проверять структуру, ownership, routes и background tasks;
- числовые размеры проверять как build artifact или отдельным reproducible
  расчётом, а не править вручную в нескольких местах.

### 3R.7. Что из review уже неактуально

Два замечания из исходного review не переносятся как отдельные баги:

- текущий inventory generator уже считает canonical UTF-8 text size, поэтому
  исходная ошибка `425384 → 430990` из-за `CRLF` не воспроизводится в текущем
  состоянии;
- frontend bootstrap уже проверяет `pageConfig.flags.hasMihomo` и
  `hasXray` перед загрузкой соответствующих feature bundles, а подэтап 4.1
  добавил server-side gate для optional DevTools links.

Это не отменяет Stage 5: нужны E2E/network guardrails, доказывающие отсутствие
чужих бандлов, DOM roots и API-вызовов во всех minimal-профилях.

### Критерий готовности 3R

Этап 3R закрыт. Реализовано:

1. Mihomo-only DNS lifecycle проходит тест остановки и восстановления;
2. опасное отключение активного engine возвращает `409`;
3. self-update, `core.log`, recovery и module manager доступны без advanced
   diagnostics;
4. state corruption/new-schema rollback оставляет backup и запись в журнале;
5. Happ, editor и backup ownership отражены в registry и профилях;
6. есть owner guard для каждого Blueprint, scheduler и WS handler;
7. размеры модулей загружаются из generated `module-sizes.json`, а не
   редактируются вручную в `ModuleRegistry`.

Сверка с кодом 30 сентября 2026 года показала, что пункты 2, 4, 5 и 6
выполнены частично: см. Этап 3R.1.

## Этап 3R.1. Доработка runtime safety по сверке с кодом

**Статус:** закрыт 30 сентября 2026 года.

Этап 3R.1 завершает сверку runtime safety с фактическим кодом ветки и закрывает
расхождения, выявленные после review.

Артефакты:

- `docs/modular-panel-stage3r1-runtime-safety.md` — итоговый safety-контракт;
- `docs/modular-panel-stage3r1-initial-html-baseline.md` — baseline initial HTML;
- `docs/modular-panel-stage3r1-initial-html-baseline.json` — machine-readable baseline;
- `scripts/generate_modular_panel_stage3r1_baseline.py` — генератор baseline;
- `tests/test_modular_panel_stage3r1.py` — guardrails этапа.

### 3R.1.1. Семантика «активного ядра» и deferred disable

`module_change_guard` проверяет `services.cores.detect_running_core()`, а не
только список `active_module_ids` процесса. Поэтому:

- работающий engine нельзя отключить — API возвращает `409 active_core_module`;
- неработающий engine в Full-профиле можно отключить;
- при старте отключённый engine, который фактически продолжает работать,
  остаётся активным только в текущем процессе: в `/api/modules` он виден как
  `enabled=false`, `effective_enabled=true`,
  `blocked_reason=deferred_disable_blocked`, событие пишется в `core.log`.
  Выбор пользователя в `modules.json` не меняется, поэтому отключение
  применяется при первом старте без работающего ядра; вместе с engine
  удерживаются и его зависимости;
- проверка владельца DNS выполняется до изменения registry state.

Изменение профиля применяется после штатного restart; workers не остаются
активными в старом процессе.

### 3R.1.2. Изоляция ошибок инициализации

Ошибка optional-модуля не останавливает core:

- factory ошибки всех optional-модулей (Xray, Mihomo, утилита ссылок,
  backups, terminal, advanced diagnostics, files) перехватываются на границе
  регистрации; blueprints модуля сначала создаются все, затем регистрируются,
  поэтому упавший модуль не остаётся зарегистрированным наполовину;
- ошибки scheduler также перехватываются на startup;
- `ModuleRegistry.record_initialization_failure()` сохраняет `last_error`;
- `last_error` описывает только предыдущий процесс: `initialize_for_startup()`
  стирает его, и каждый старт — новая попытка инициализации. Иначе разовый
  сбой (например, расписания подписок) навсегда выключал модуль в любом
  профиле, кроме `legacy-full`, а `enable` его не возвращал;
- module projection показывает `status=failed`;
- `/api/modules`, recovery и core routes продолжают работать.

### 3R.1.3. Совместимость `modules.json` при откате

Неизвестная future schema работает в read-only режиме:

- исходный файл не перезаписывается, в том числе записью `last_error`
  (ошибка инициализации в этом режиме хранится только в памяти процесса);
- создаётся `modules.json.bad.<timestamp>` — одна копия за процесс, а не при
  каждом чтении состояния;
- runtime использует безопасный legacy-full projection;
- попытка записи отвечает `409 state_schema_newer`;
- corrupt state получает recovery backup и `recovery_reason`.

### 3R.1.4. `installed` из фактических файлов

Registry учитывает `module-installed.json` и file markers модулей. Safe mode,
legacy-full и аварийный fallback при недоступном state активируют только
реально установленные модули. Удалённый пакет
`engine.mihomo` не импортируется и не попадает в runtime active set.

### 3R.1.5. Ownership и registry

- `happ_links`/`happ_payloads` классифицируются как core-owned shared helpers;
- Blueprint owner map и WS handler owner map опубликованы из
  `services.module_registry`, а не дублируются в route layer;
- неизвестный зарегистрированный Blueprint попадает в
  `app.extensions["xkeen.module_owner_errors"]`;
- `tool.editor.can_disable` динамически становится `false`, пока активен
  хотя бы один engine;
- `integration.happ` использует нейтральные name/description («Утилита ссылок
  подписок») и нейтральный id системного требования
  `subscription-link-utility`, зависит от core; признак установки — собственные
  файлы модуля, а не core-owned `happ_links`;
- `tool.advanced-diagnostics` больше не заявляет self-update как собственную
  функцию; maintenance API остаётся core-owned.

### 3R.1.6. Baseline до изменений initial HTML

До подэтапа 4.3 сохранён structural initial-HTML baseline для `legacy-full`,
`full`, `xray-minimal` и `mihomo-minimal`:

- сохранены raw/composed SHA-256, размер, line count и DOM id count;
- зафиксированы ожидаемые screens, navigation sections и modal composition;
- воспроизведение выполняется командой из baseline-документа.

### Критерий готовности 3R.1

Этап 3R.1 **закрыт**: active-core semantics, deferred disable, optional-init
isolation, future-schema recovery, installed markers, ownership registry,
neutral module metadata и initial-HTML baseline реализованы и защищены тестами.

## Этап 4. Разделение frontend shell и экранов

**Статус:** в работе; подэтапы 4.1–4.5 закрыты, следующий — подэтап 4.6.
Всего шесть последовательных подэтапов.

Этап 4 отвечает за **серверную композицию HTML** и границы шаблонов. Он не
должен одновременно решать задачу ленивой загрузки JavaScript/CSS: проверка
бандлов, `import()` и отсутствие frontend API-вызовов относятся к Этапу 5.
Такое разделение позволяет выносить разметку небольшими безопасными порциями,
не меняя поведение уже работающих экранов.

### Целевая структура шаблонов

`panel.html` остаётся совместимой точкой входа и composition root, а монолитная
разметка постепенно переносится в отдельные partials:

```text
xkeen-ui/templates/
├── panel.html                         # совместимый entrypoint/composition root
└── panel/
    ├── macros.html                    # общий op_icon
    ├── shell.html                     # общий каркас страницы
    ├── head.html                      # title, CSS и общие head-assets
    ├── header.html                    # header, статус и глобальные действия
    ├── navigation.html                # вкладки и navigation views
    ├── page_config.html               # page config и runtime flags
    ├── screens/
    │   ├── routing.html
    │   ├── mihomo.html
    │   ├── xkeen.html
    │   ├── xray_logs.html
    │   ├── commands.html
    │   └── files.html
    └── modals/
        ├── shared.html
        ├── diagnostics.html
        ├── editor.html
        ├── routing.html
        ├── mihomo.html
        ├── happ.html
        ├── commands.html
        └── files.html
```

Названия partials являются целевой схемой, а не требованием создать все файлы
одним коммитом. Если часть модального окна или asset используется несколькими
модулями, она остаётся в `shared.html` до тех пор, пока для неё не появится
один явный владелец.

### Подэтап 4.1. Контракт границ shell, экранов и модальных окон

**Статус:** закрыт 29 сентября 2026 года.

Артефакты:

- `docs/modular-panel-stage4.1-contract.md` — человекочитаемый контракт;
- `docs/modular-panel-stage4.1-contract.json` — machine-readable contract;
- `scripts/generate_modular_panel_stage4_1_contract.py` — воспроизводимый
  генератор;
- `tests/test_modular_panel_stage4_1_contract.py` — guardrails синхронности,
  профилей и документации.

Сначала зафиксировать карту разбиения до переноса разметки:

- выделить в `panel.html` общий shell, navigation, экраны и модальные окна;
- сопоставить каждый блок с `module_id` из Module Registry;
- определить владельца для общих блоков, `data-*`-атрибутов, DOM id и
  page-context переменных;
- отдельно отметить mixed-boundaries, которые пока нельзя вынести без
  изменения поведения;
- зафиксировать порядок include и зависимости между partials;
- определить список DOM id и API-контрактов, которые должны остаться
  неизменными.

**Результат подэтапа:**

- таблица `partial → module_id → DOM/API dependencies`;
- целевой порядок рендеринга shell и screens;
- перечень shared-блоков и временных mixed-boundaries;
- baseline для сравнения Full, Legacy, Xray-only и Mihomo-only HTML.

**Критерий готовности 4.1:** **выполнен**. Для каждого крупного блока
текущего `panel.html` определено место в целевой структуре и владелец; спорные
зависимости явно зафиксированы, а не скрыты внутри нового partial. Baseline
профилей и список DOM/API-якорей защищены тестом синхронности.

### Подэтап 4.2. Выделение общего frontend shell

Вынести только общую часть страницы, не меняя содержимое экранов:

- `<head>`, общие CSS и host/theme bootstrap;
- авторизацию и logout-контрол;
- header, branding и статус сервиса;
- глобальные действия, resource summary и обновление панели;
- глобальный spinner и общие уведомления;
- корневой контейнер приложения;
- navigation и page config;
- общие modal-контейнеры, которые не принадлежат отдельному модулю.

На этом подэтапе разрешается оставить `panel.html` тонким composition root,
который подключает `panel/shell.html`. Нельзя одновременно переименовывать
DOM id, менять `data-xk-*`/`data-view`-контракт или переносить screen-specific
разметку в shell.

**Статус:** закрыт 29 сентября 2026 года.

Артефакты:

- `docs/modular-panel-stage4.2-frontend-shell.md` — контракт выделенного shell;
- `scripts/panel_template_source.py` — resolver состава Jinja partials для
  static inventory;
- `tests/test_modular_panel_stage4_2_shell.py` — guardrails composition root,
  DOM-контракта и Jinja compile.

Реализация:

- `panel/head.html` и `panel/page_config.html` владеют `<head>` и canonical
  page config;
- `panel/shell.html` владеет `<body>`, startup fail-open, spinner, root
  container и global controls;
- `panel/header.html` владеет branding, service status, summary и actions;
- `panel/navigation.html` владеет top-level navigation;
- `panel.html` сохраняет screens, modals, footer и entrypoint scripts до
  следующих подэтапов.

Static inventory и contract-тесты анализируют composed source через
`scripts/panel_template_source.py`, поэтому split не ослабляет существующие
DOM/API guardrails.

**Критерий готовности 4.2:** **выполнен**. После рендера Full/Legacy профиль
сохраняет текущий shell, все существующие селекторы и page-level bootstrap
продолжают работать, а screen-specific markup не дублируется в shell.

### Подэтап 4.3. Выделение экранов по модульным границам

**Статус:** закрыт 30 сентября 2026 года.

Routing screen: **закрыт 30 сентября 2026 года**.

Артефакты:

- `docs/modular-panel-stage4.3-routing-screen.md`;
- `xkeen-ui/templates/panel/screens/routing.html`;
- `tests/test_modular_panel_stage4_3_routing_screen.py`.

Xray logs screen: **закрыт 30 сентября 2026 года**.

Артефакты:

- `docs/modular-panel-stage4.3-xray-logs-screen.md`;
- `xkeen-ui/templates/panel/screens/xray_logs.html`;
- `tests/test_modular_panel_stage4_3_xray_logs_screen.py`.

До выделения `#view-xray-logs` не был закрыт gate и попадал в initial HTML
Mihomo-only профиля; теперь он рендерится только при `engine.xray`.

Mihomo screen: **закрыт 30 сентября 2026 года**.

Артефакты:

- `docs/modular-panel-stage4.3-mihomo-screen.md`;
- `xkeen-ui/templates/panel/screens/mihomo.html`;
- `tests/test_modular_panel_stage4_3_mihomo_screen.py`;
- `tests/support/panel_render.py` — общий server-side рендер страницы по
  набору модулей.

До выделения `#view-mihomo` тоже не был закрыт gate и попадал в initial HTML
Xray-only профиля; теперь он рендерится только при `engine.mihomo`. Кнопка
HWID (`integration.happ`) осталась внутри экрана до составного gate 4.4.

Xkeen screen: **закрыт 30 сентября 2026 года**.

Артефакты:

- `docs/modular-panel-stage4.3-xkeen-screen.md`;
- `xkeen-ui/templates/panel/screens/xkeen.html`;
- `tests/test_modular_panel_stage4_3_xkeen_screen.py`.

Экран принадлежит core и подключается без module gate.

Commands и Files screens: **закрыты 30 сентября 2026 года**.

Артефакты:

- `docs/modular-panel-stage4.3-tool-screens.md`;
- `xkeen-ui/templates/panel/screens/commands.html`;
- `xkeen-ui/templates/panel/screens/files.html`;
- `tests/test_modular_panel_stage4_3_tool_screens.py`.

Строка статуса и обновления ядер осталась в экране команд (`tool.terminal`):
обновление выполняется через каталог команд терминала.

**Browser smoke 30 сентября 2026 года** (E2E-стенд, профили через
`modules.json`): в Full, Xray-minimal и Mihomo-minimal рендерятся только свои
экраны, все видимые вкладки открываются, набор ошибок Xray-minimal совпадает с
baseline до выделения экранов. Оставшиеся `404` были frontend-вызовами API
выключенных модулей и устранены до закрытия 4.3:

- сводка ресурсов в header (`#xk-resource-monitor`) опрашивает
  `/api/system/*` модуля `tool.advanced-diagnostics` и теперь рендерится под
  `{% if has_diagnostics %}`; без корня `initResourceMonitor()` не запускает
  опрос;
- карточка GeoIP/GeoSite (`engine.xray`) использовала `/api/fs/stat-batch`,
  `/api/fs/list`, `/api/fs/upload` и `/api/fs/download` модуля `tool.files`.
  Теперь у неё собственные `/api/routing/dat/stat`, `/files`, `/upload` и
  `/download` (`routes/routing/dat_files.py`): только `.dat`, та же allowlist,
  что у `/api/routing/dat/update`, загрузка потоком с лимитом
  `XKEEN_MAX_DAT_MB`. Загрузка и скачивание DAT больше не ломаются в профиле
  без файлового менеджера.

Повторный smoke: в Xray-minimal и Mihomo-minimal нет ни одного `4xx/5xx`;
единственные ошибки консоли — handshake `/ws/events`, который на Windows-стенде
без `gevent-websocket` не работает и в Full.

Остаётся backend-связь для Этапа 7: `routes/routing/dat.py` и `dat_files.py`
(`engine.xray`) импортируют `services/fs_common/local.py`, а `dat.py` ещё и
`services/filemanager/metadata.py`; по inventory оба принадлежат `tool.files`.
При удалении файлов модуля их нужно оставить или перевести в core.

Последовательно вынести разметку экранов в partials:

1. `routing.html` — `engine.xray` — **выполнено**;
2. `xray_logs.html` — `engine.xray` — **выполнено**;
3. `mihomo.html` — `engine.mihomo` — **выполнено**;
4. `xkeen.html` — core-owned Xkeen screen — **выполнено**;
5. `commands.html` — `tool.terminal` — **выполнено**;
6. `files.html` — `tool.files` — **выполнено**.

Для каждого экрана:

- сохранить корневой `id`, `data-xk-section`, `data-view` и порядок DOM;
- передавать только необходимые template variables;
- не импортировать backend-модули ради рендера HTML;
- не переносить в экран разметку другого владельца;
- ставить gate **только в composition root** (`panel.html`, вокруг
  `include`) по `active_module_ids`/готовому capability flag; сам partial
  условий на модуль не содержит — так 4.5 не придётся вычищать gates из
  каждого экрана;
- оставить отдельную страницу `mihomo_generator.html` вне `panel`-экрана,
  потому что она уже имеет собственный page entrypoint.

Переносить экраны нужно по одному, после каждого шага проверяя Full и
соответствующий minimal-профиль. Не следует в рамках этого подэтапа менять
frontend entrypoints или переводить скрипты на `import()` — это задача Этапа 5.

Удаление screen markup опережает Этап 5: JS экрана может по-прежнему
загружаться через static imports. Поэтому для каждого убранного экрана нужно
убедиться, что его JS не инициализируется без DOM root (проверка
`pageConfig.flags` или null-safe init), и прогнать smoke minimal-профиля без
console errors.

**Критерий готовности 4.3:** каждый перечисленный экран рендерится из
собственного partial, его DOM id и bootstrap-контракт сохранены, при
отключённом module_id его screen markup отсутствует в HTML-ответе, а
minimal-профиль открывается без console errors.

### Подэтап 4.4. Разделение модальных окон и module-owned markup

**Статус:** закрыт 30 сентября 2026 года.

Артефакты:

- `docs/modular-panel-stage4.4-modals.md`;
- `xkeen-ui/templates/panel/modals/*.html` — `diagnostics`, `routing`,
  `commands`, `shared`, `mihomo`, `happ`, `files`, `files_editor`, `editor`;
- `tests/test_modular_panel_stage4_4_modals.py`.

Все 53 модальных окна и оверлей терминала вынесены из `panel.html`, который
стал тонким composition root. Составные gates: HWID —
`has_happ and has_mihomo`, редактор файлового менеджера —
`has_files and has_editor`. Кнопка HWID внутри экрана Mihomo обёрнута в
`{% if has_happ %}` — единственное module-условие внутри screen partial.
Окна `fm-*` отнесены к `tool.files`, `ssh-*` — к `tool.terminal`. Проверено
браузерным замером вычисленных стилей всех 54 окон до и после переноса
(совпадают) и smoke Full/Xray-minimal/Mihomo-minimal.

Разнести статические модальные окна по владельцам:

- shared — только действительно общие подтверждения, уведомления и
  контейнеры shell;
- routing — редактор и диагностика Xray routing;
- mihomo — Clash, DNS, telemetry и Mihomo forms;
- commands — command/job/terminal flows;
- files — file manager, remote FS, USB и file operations.

Для каждого modal partial:

- сохранить `id`, `aria-*`, `data-modal-key` и связанные trigger selectors;
- проверить, что все кнопки и формы остаются внутри правильного module gate;
- не оставлять в `shared.html` скрытую разметку отключаемого модуля;
- не создавать дубликаты modal id при совместном рендере нескольких экранов;
- отдельно проверить модальные окна, которые открываются из lazy feature-кода;
- для markup, которому нужны два модуля, использовать составной gate
  (например, HWID: `integration.happ AND engine.mihomo`; editor-модалка
  файлового менеджера: `tool.files AND tool.editor`); составные gates
  перечислить в контракте 4.1.

**Критерий готовности 4.4:** модальные окна присутствуют только у своего
владельца или в общем shell, а отключение `engine.xray`, `engine.mihomo`,
`tool.terminal` или `tool.files` удаляет соответствующий modal markup из
initial HTML без поломки shared-контейнеров.

### Подэтап 4.5. Composition по активному набору модулей

**Статус:** закрыт 1 октября 2026 года.

Артефакты:

- `docs/modular-panel-stage4.5-composition.md` — закрывающий контракт,
  профильная матрица и границы следующего этапа;
- `xkeen-ui/routes/pages.py` — ordered allow-listed manifest и
  `_build_panel_page_context(active_module_ids)`;
- `scripts/panel_template_source.py` — каталог dynamic composition includes;
- `tests/test_modular_panel_stage4_5_composition.py` — выбор поверхностей,
  Legacy fallback, profile HTML и документационный guardrail.

Выполнено: shell-slots, navigation, screens и modals выбираются по owners из
одного manifest. `None` activation сохраняет Legacy/Full fallback; составные
owners HWID и редактора файлов заданы явно. Static inventory раскрывает только
allow-listed dynamic partials и сверяется с runtime manifest.

Собрать partials через единый composition root:

1. получить уже рассчитанный в Этапе 3 `active_module_ids`;
2. передать в шаблоны единый `page_context`;
3. отрендерить shell и только разрешённые navigation views;
4. подключить screen и modal partials по владельцу;
5. не дублировать module-gates в десятках несвязанных мест;
6. сохранить Legacy/Full как безопасный fallback для старых установок.

Правило подэтапа: серверный HTML должен быть недоступен отключённому модулю
даже если пользователь вручную открыл старую вкладку или в браузере остался
старый `localStorage`-state. В таком случае должен отображаться только
поддерживаемый shell/navigation без чужого screen markup.

**Критерий готовности 4.5:** **выполнен**. Для Xray-only, Mihomo-only, Full,
Legacy и core-only рендерится корректный состав shell/screens/modals;
отсутствуют лишние navigation buttons, screen roots и module-owned modal ids;
HTML не содержит случайных `500` из-за отсутствующей template-переменной.

### Подэтап 4.6. Совместимость, тесты и удаление монолита

**Статус:** закрыт 1 октября 2026 года.

Артефакты:

- `docs/modular-panel-stage4.6-compatibility.md` — результат, профильная
  матрица и границы Stage 5;
- `docs/modular-panel-stage4.6-compatibility.json` — воспроизводимый
  compatibility contract;
- `scripts/generate_modular_panel_stage4_6_compatibility.py` — генератор
  снимка;
- `tests/test_modular_panel_stage4_6_compatibility.py` — server-side
  profile/Legacy guardrails.

Выполнено: Full/Legacy сравниваются по полному публичному DOM-контракту;
Xray-minimal, Mihomo-minimal, core-only и пустой active set проверяются на
отсутствие отключённых screen/modal/shell surfaces. `panel.html` не содержит
screen-specific или modal markup, поэтому отдельное удаление дубликатов не
потребовалось. Контракт 4.1 теперь получает `owner_requirements` modal из
runtime composition manifest: `fm-editor-modal` корректно требует
`tool.files AND tool.editor` и не числится доступной в минимальных профилях.

**Критерий готовности 4.6:** **выполнен**. Все экраны и module-owned modals
имеют единственного владельца, `panel.html` больше не содержит монолитной
screen-specific разметки, а тесты защищают состав HTML и legacy-совместимость.

### Общий критерий готовности Этапа 4

Этап 4 считается выполненным, когда:

- общий shell отделён от screen-specific markup;
- экраны и модальные окна собраны из module-owned partials;
- Xray-only и Mihomo-only ответы не содержат HTML отключённых модулей;
- Full и Legacy сохраняют текущую функциональность и DOM-контракт;
- composition использует единый active-module/page-context contract;
- серверные тесты защищают HTML composition и не зависят от порядка
  выполнения frontend-скриптов.

**Статус Этапа 4:** **выполнен 1 октября 2026 года**.

Проверки, которые были закрыты в Этапе 5:

- отсутствие ненужных JS-бандлов в Network;
- динамический `import()` по Module Registry;
- ленивое подключение module-owned CSS;
- запрет frontend API-вызовов до загрузки соответствующего модуля.

## Этап 5. Динамическая frontend-загрузка — закрыт

**Статус:** выполнен 1 октября 2026 года.

Итоговый machine-readable contract: `docs/modular-panel-stage5-frontend-loading.json`.
Человекочитаемое описание и матрица профилей:
`docs/modular-panel-stage5-frontend-loading.md`.

### Задачи

Сюда же переходит требование Этапа 3 «Mihomo frontend-бандлы не
загружаются».

Использовать уже существующее разделение:

- `panel.routing.bundle.js`;
- `panel.mihomo.bundle.js`;
- ESM entrypoints;
- `import()` и build-managed loaders.

Перевести загрузку на module registry:

```text
core
  └── panel shell

engine.xray
  └── routing bundle

engine.mihomo
  └── Mihomo bundle

tool.terminal
  └── terminal lazy entry

tool.files
  └── file manager lazy entry
```

Не использовать шаблонные цепочки legacy script tags для оркестрации модулей.
Текущие conditional `import()` для Xray/Mihomo сохранить как промежуточный
baseline, но убрать оставшиеся static imports, которые подтягивают optional
код через `panel-core`, `panel.mihomo_header` или shared compatibility layers.

Smoke 4.3 (30 сентября 2026 года) нашёл и закрыл два frontend-вызова API
выключенных модулей (resource summary и карточка GeoIP/GeoSite). Этап 5
должен закрепить это E2E-guardrails для всех профилей.

Для каждого optional frontend-модуля зафиксировать:

- условие загрузки по `pageConfig`/Module Registry;
- список собственных DOM roots;
- список разрешённых API/WS endpoints;
- поведение при отсутствии markup или backend route;
- отсутствие console errors и error-toast от ожидаемого `module_not_enabled`.

### Критерий готовности

На Xray-only профиле браузер не загружает Mihomo-бандлы, Mihomo DOM roots и
Mihomo API/WS; на Mihomo-only профиле не загружает Xray-specific части.
То же правило действует для terminal, files, diagnostics и editor optional
variants. Проверка выполняется в browser Network/Console, а не только по
наличию `import()` в исходнике.

**Критерий готовности Этапа 5: выполнен.** Flask публикует версионированный
`frontendModules` descriptor, panel-local loader использует фиксированный
allow-list локальных `import()`-фабрик, а inactive/missing-root границы
возвращают no-op. Xray, Mihomo, terminal, files, diagnostics и editor
загружаются только по активному профилю и surface; `xterm.css` стал первым
module-owned lazy stylesheet. `styles.css` и `panel-operator.css` намеренно
остались shared compatibility CSS. Изолированный E2E fixture записывает
`modules.json` до запуска Flask и проверяет Network/WebSocket/console для
Full, Xray Minimal, Mihomo Minimal и Core-only, не затрагивая рабочий стенд.

## Этап 6. Разделение редакторов

### Задачи

Разделить:

- базовый JSON/YAML редактор;
- CodeMirror;
- Monaco;
- схемы;
- Prettier;
- diff-viewer;
- quick-fix;
- дополнительные подсказки.

Добавить profile-aware загрузку вариантов editor:

- Minimal — CodeMirror;
- Full — CodeMirror + Monaco;
- Advanced — все редакторные инструменты.

Вариант editor (`light/full/advanced`) добавляется в state как новое
обратно-совместимое поле по правилу 3R.1.3, без повышения `schema_version`.

Базовый editor остаётся обязательной зависимостью активных engines. Отключать
можно только тяжёлые optional-возможности (`Monaco`, diff, quick-fix и
дополнительные схемы), причём UI должен сообщать, какая возможность
недоступна, а не ломать весь экран.

### Критерий готовности

В минимальной установке редактор работает с меньшим набором зависимостей и не загружает Monaco до явного выбора пользователя.

## Этап 7. Профили установщика

### Задачи

Добавить выбор профиля в установщик:

- Xray Minimal;
- Mihomo Minimal;
- Full;
- Custom.

Профиль должен записываться в конфигурацию установки и передаваться панели при первом запуске.

Нужно предусмотреть:

- обновление Full-установки;
- обновление минимальной установки;
- переход между профилями;
- восстановление после неудачного обновления;
- сохранение пользовательских конфигураций;
- проверку свободного места;
- резервную копию активного профиля;
- состав пакета по профилю, включая module-owned backend/frontend/assets;
- удаление или quarantine файлов модуля, отключённого в новом профиле;
- очистку устаревших `.gz`, manifest и generated assets после перехода;
- запрет самообновлению возвращать выключенный модуль без явного выбора;
- единый архив панели как первый production-вариант; отдельные архивы модулей
  оставить на следующий цикл;
- пресеты профилей (`full`, `xray-minimal`, `mihomo-minimal`) в registry и
  атомарный `POST /api/modules/profile` с diff «что станет активным /
  неактивным после перезапуска» (§5.4.1) — их используют установщик и
  раздел «Модули» Этапа 8.

Предусловие: закрыт пункт 3R.1.4 (`installed` из фактических файлов), иначе
safe mode и recovery после удаления файлов модуля роняют панель при старте.

### Критерий готовности

Новая установка может быть выполнена без ненужных модулей, а существующая установка обновляется без потери функций.

## Этап 8. Менеджер официальных модулей

### Задачи

Добавить core-owned раздел «Модули» в maintenance UI панели. Он не должен
зависеть от `tool.advanced-diagnostics`; расширенные сведения можно открыть
через DevTools, если этот модуль установлен.

Раздел должен показывать:

- установленные модули;
- доступные официальные модули;
- включение и выключение;
- установка;
- удаление;
- обновление;
- размер;
- зависимости;
- состояние;
- журнал операции;
- кнопка перезапуска.

### Источник каталога

Каталог должен загружаться только из официального репозитория Xkeen UI.

Возможные варианты размещения:

1. индекс в GitHub Releases;
2. JSON-манифест в официальном репозитории;
3. release asset с индексом и архивами модулей;
4. единый архив панели с выбранными компонентами.

На первом этапе использовать официальный индекс и release assets только из
репозитория Xkeen UI. SHA-256 проверяет целостность загрузки, но не
подлинность источника, поэтому production-контракт должен включать
подпись индекса/манифеста и проверку подписи архива либо доверенного
подписанного release asset. Нужны политика ключей, ротация ключа и отказ
при неизвестной подписи.

### Manifest модуля

Пример:

```json
{
  "id": "tool.files",
  "name": "Файловый менеджер",
  "version": "1.0.0",
  "panel_api": "1",
  "requires": ["core"],
  "conflicts": [],
  "requires_restart": true,
  "archive": "xkeen-module-files-1.0.0.tar.gz",
  "sha256": "...",
  "signature": "...",
  "signing_key_id": "...",
  "size": 123456
}
```

### Безопасность установки

Порядок установки:

1. получить индекс только с официального источника;
2. проверить HTTPS и допустимый host;
3. проверить совместимость с версией core/API;
4. скачать архив во временную директорию;
5. проверить размер, SHA-256 и подпись;
6. распаковать во временную директорию;
7. проверить manifest;
8. создать backup;
9. выполнить атомарную замену;
10. обновить registry;
11. перезапустить сервис;
12. проверить состояние;
13. при ошибке выполнить rollback.

Шаги 12–13 не может выполнять сам процесс панели: если новый модуль роняет
старт, откатывать некому. Проверку после рестарта и rollback выполняет
внешний участник — init-скрипт или отдельный сторож: он ждёт готовности HTTP
за ограниченное время и при неудаче возвращает backup и перезапускает
предыдущую версию.

Произвольные shell-скрипты из архива на первом этапе не выполняются.

### Удаление

Перед удалением:

- проверить зависимости других модулей;
- предупредить пользователя;
- создать backup;
- выключить модуль;
- потребовать перезапуск;
- сохранить пользовательские данные;
- не удалять конфигурации ядер без отдельного подтверждения.

`core` удалить нельзя.

### Критерий готовности

Пользователь может безопасно установить или отключить официальный модуль Xkeen UI и восстановиться после ошибки.

## Этап 9. Тестирование и миграции

### Backend

Добавить тесты на:

- реестр модулей;
- миграции конфигурации;
- зависимости;
- конфликты;
- Mihomo-only DNS guard и release при остановке;
- запрет отключения активного core/engine с кодом `409`;
- повреждённый `modules.json`;
- неизвестную версию schema и rollback на старую панель;
- `is_runtime_active()` против frozen runtime activation;
- owner mapping для каждого Blueprint, scheduler и WS handler;
- core-owned self-update, `core.log` и module manager;
- `integration.happ` в Xray-only subscription flow;
- Xray-only;
- Mihomo-only;
- Full;
- отключённый terminal;
- отключённый file manager;
- недоступный PTY;
- отсутствующий Mihomo;
- ошибку инициализации модуля;
- повторный запуск;
- rollback.

### Frontend

Добавить E2E-проверки:

- меню соответствует активным модулям;
- неактивные бандлы не загружаются;
- отключённый раздел не делает API-запросы;
- Xray-only и Mihomo-only не загружают чужие screen/module roots;
- Xray-only и Mihomo-only не регистрируют чужие API-вызовы;
- переключение профиля требует перезапуск;
- ошибка модуля не блокирует core;
- старые установки сохраняют прежнюю навигацию.

### Установщик

Проверить:

- чистую установку;
- обновление старой Full-установки;
- установку Xray Minimal;
- установку Mihomo Minimal;
- переход Minimal → Full;
- отключение модуля;
- восстановление после прерванной установки;
- обновление с удалением отключённых файлов и старых `.gz`;
- недостаток свободного места;
- повреждённый архив;
- неверную или неподписанную подпись release asset;
- несовместимую версию API.

## Этап 10. Оптимизация размера и запуска

После функциональной стабилизации измерить:

- размер установочного архива;
- размер распакованной панели;
- время запуска сервиса;
- RSS-память;
- количество импортированных Python-модулей;
- количество frontend-запросов;
- размер initial HTML;
- размер загруженного JS;
- количество фоновых задач.

Baseline до оптимизации снимается в пункте 3R.1.6 — до подэтапа 4.3
(исходно планировался параллельно с 3R, но не был снят). Для `legacy-full/full`,
Xray Minimal и Mihomo Minimal:

- RSS после старта;
- время до готовности HTTP и frontend shell;
- количество импортированных Python-модулей;
- зарегистрированные Blueprint, scheduler и WS handlers;
- размер initial HTML;
- network requests и загруженные JS-бандлы.

Оптимизацию выполнять по результатам измерений, а не только по размеру архива.

Ожидаемые эффекты:

- Xray-only не запускает Mihomo-код;
- Mihomo-only не загружает Xray UI;
- terminal и file manager не занимают ресурсы без установки;
- Monaco и дополнительные редакторные зависимости грузятся лениво;
- меньше initial HTML и JS;
- проще диагностика ошибок.

## 7. Рекомендуемый порядок реализации

Реализовывать изменения лучше в таком порядке:

1. инвентаризация;
2. module registry;
3. расширение capabilities;
4. backend gates;
5. Этап 3R: runtime safety hardening;
5a. Этап 3R.1: доработка runtime safety и baseline-метрики (блокирует релиз
    и подэтап 4.3);
6. Этап 4.1: контракт границ shell, экранов и модальных окон;
7. Этап 4.2: выделение общего frontend shell;
8. Этап 4.3: выделение экранов по модульным границам;
9. Этап 4.4: разделение модальных окон и module-owned markup;
10. Этап 4.5: composition по активному набору модулей;
11. Этап 4.6: совместимость, тесты и удаление монолита;
12. динамическая загрузка frontend-модулей;
13. разделение редакторов и вариантов editor light/full;
14. профили установщика, состав пакета и безопасное обновление;
15. core-owned менеджер официальных модулей;
16. удаление/установка и rollback;
17. тестирование профилей и миграций;
18. baseline-метрики и оптимизация;
19. документация и релиз.

Нельзя начинать с удаления файлов или с marketplace. Сначала должны появиться:

- стабильный registry;
- обратная совместимость;
- runtime safety и recovery;
- тесты профилей;
- безопасная миграция;
- понятный API модулей.

## 8. Что не входит в первый релиз

В первый релиз модульной архитектуры не включаем:

- произвольные сторонние репозитории;
- пользовательские плагины с произвольным кодом;
- установку shell-скриптов из внешних архивов;
- hot-unload Python Blueprint без перезапуска;
- автоматическое удаление конфигураций ядер;
- независимые циклы обновления для каждого небольшого frontend-файла;
- marketplace с публикацией сторонних разработчиков.

## 9. Критерии успеха проекта

Проект можно считать успешным, если:

1. Xray-only установка не запускает Mihomo-specific backend и frontend.
2. Mihomo-only установка не показывает и не загружает Xray-only разделы.
3. Terminal и file manager можно не устанавливать.
4. Старые установки продолжают работать без ручной миграции.
5. Отключение модуля не удаляет пользовательские конфигурации.
6. Любая установка и операция над модулем может быть отменена через backup/rollback.
7. Каталог модулей обращается только к официальному репозиторию Xkeen UI.
8. Повреждённый или несовместимый модуль не может заменить рабочий.
9. Ошибка необязательного модуля не останавливает ядро панели.
10. Размер и время запуска минимальной установки заметно меньше Full-профиля.
11. Mihomo-only и Xray-only корректно запускают и снимают общий DNS lifecycle.
12. Нельзя отключить активное ядро или владельца сетевой защиты без `409` и
    безопасного release.
13. Повреждённый state-файл сохраняется для диагностики, а recovery не теряет
    пользовательский выбор без записи в журнале.
14. Обновление не возвращает выключенные модули и удаляет устаревшие assets.
15. Каталог и архивы проверяются не только по SHA-256, но и по доверенной
    подписи.

## 10. Итоговое решение

Для Xkeen UI оптимальна модель:

> **стабильное ядро панели + модули Xray/Mihomo и инструменты + профили установки + официальный каталог модулей только из репозитория Xkeen UI.**

Сначала реализуем модульный registry и профили внутри текущего репозитория. После стабилизации границ модулей добавим официальный каталог, установку, отключение, удаление и rollback.

Такой порядок позволит облегчить панель без резкого переписывания проекта и без риска превратить установку расширений в небезопасный запуск произвольного кода.

## 11. Актуализация по внешнему review от 29 сентября 2026 года

Review было выполнено по коммиту `82a0df9e`, поэтому каждое замечание повторно
сверено с текущим состоянием репозитория.

Приняты и добавлены в план:

- core-owned DNS lifecycle и Mihomo-only release;
- `409` для опасного отключения активного engine/сетевой защиты;
- перенос self-update, `core.log`, recovery и module manager из optional
  DevTools в core maintenance;
- пересмотр зависимости `integration.happ`;
- editor как обязательный `light` и optional `full/advanced`;
- backup primitives в core, UI/API восстановления в `tool.backups`;
- frozen runtime activation, backup битого state и safe mode;
- profile-aware update/cleanup `.gz`;
- подписи release assets;
- owner registry и smoke/E2E для Full, Xray-only и Mihomo-only;
- baseline-метрики до оптимизации.

Уже исправлено или не воспроизводится в текущем коде:

- inventory size уже нормализуется по canonical UTF-8, поэтому Windows CRLF
  не меняет snapshot;
- Xray/Mihomo feature bundles уже имеют conditional loading по `pageConfig`;
  остаётся закрепить это browser/E2E guardrails и убрать transitive static
  imports optional-кода.

## 12. Сверка плана с кодом от 30 сентября 2026 года

Все расхождения таблицы ниже закрыты в Этапе 3R.1; таблица сохранена как audit trail.

План повторно сверен с кодом ветки `codex/modular-panel-testing`
(`092739ec`). Найденные расхождения:

| № | Расхождение | Где исправляется |
|---|---|---|
| 1 | `409 active_core_module` срабатывал на любой runtime-активный engine: в Full нельзя было отключить неработающий Mihomo | Исправлено в 3R.1.1 |
| 2 | Guard проверял только момент PATCH, а изменение применяется при рестарте | Исправлено в 3R.1.1 |
| 3 | `installed` всегда `True`; safe mode/recovery активировали весь `MODULE_IDS` | Исправлено в 3R.1.4 |
| 4 | Ошибка регистрации optional-модуля роняла панель; `failed`/`last_error` никто не писал | Исправлено в 3R.1.2 |
| 5 | Неизвестная schema перезаписывалась `legacy-full` | Исправлено в 3R.1.3 |
| 6 | `happ_links` имел engine-specific ownership при shared Xray/Mihomo import | Исправлено в 3R.1.5 |
| 7 | Варианты editor `light/full` в registry не отражены | 3R.1.5 и Этап 6 |
| 8 | Gates в каждом экране (4.3) противоречат единому composition root (4.5) | подэтап 4.3 |
| 9 | Удаление screen markup в 4.3 опережает снятие static imports в Этапе 5 | подэтап 4.3 |
| 10 | Baseline-метрики «параллельно с 3R» не были сняты | Исправлено в 3R.1.6 |
| 11 | Имена профилей в плане, коде и контракте 4.1 различаются; переход между профилями возможен только цепочкой PATCH | Имена — исправлено 30.09.2026; пресеты и `POST /api/modules/profile` — Этап 7 |
| 12 | Rollback после рестарта не может выполнять сам процесс панели | Этап 8 |
| 13 | Owner map захардкожен в `routes/__init__.py`, WS handlers не учтены | 3R.1.5 |
| 14 | Требование «frontend-бандлы не загружаются» стояло в закрытом Этапе 3 | Этапы 3 и 5 |
| 15 | Имя и описание модуля в UI называют стороннее приложение; владелец требует нейтральных формулировок | §3.7, 3R.1.5 |

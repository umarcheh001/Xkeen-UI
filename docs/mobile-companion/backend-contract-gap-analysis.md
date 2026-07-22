# Xkeen-UI Mobile Companion Backend Contract Gap Analysis

Status: working analysis
Updated: 2026-07-16

## Цель

Определить, какие части текущего backend surface уже пригодны для Android companion, а где нам нужен отдельный mobile contract вместо прямого использования web-oriented API.

Важно: mobile roadmap теперь включает не только quick-control сценарии, но и постепенный перенос части сложных web-поверхностей. Первый глубокий модуль начинается с `Routing Xray`, затем идут `Routing Mihomo`, отдельные Mihomo-инструменты, partial `DevTools`, а позже и controlled `Commands`/`Files`. `Mihomo Generator` в Android не переносится.

## Краткий вывод

Текущий backend уже дает почти все необходимые доменные возможности, а Android-клиент переиспользует read-only и service-control endpoint'ы напрямую. Для auth/session и первого routing validate slice уже есть versioned namespace `/api/mobile/v1`, но агрегированного ready/actions контракта всё еще нет. Главные проблемы теперь в смешанной гранулярности endpoint'ов, неоднородном формате ответов и отсутствии единой модели долгих операций.

Рекомендуемое направление: оставить существующие web endpoints как есть и добавить тонкий adapter layer наподобие `/api/mobile/v1/*`, который агрегирует текущие сервисы в мобильные use cases.

## Практический статус на 2026-07-16

Этот gap analysis теперь опирается на уже существующий Android baseline в `android-companion/`. На стороне клиента уже есть рабочий Compose shell с фазами `Launching`, `Connections`, `Pair/Login`, `Ready`, capability-aware вкладками `Xray`, `Mihomo`, `Ports`, `Shell` и контекстными drawer-разделами.

Клиент больше не является demo-only: подключены auth/session bootstrap, `GET /api/xkeen/core`, `GET /api/routing/fragments`, revision-aware `GET /api/mobile/v1/xray/routing/document`, real service actions, полный routing `validate/save/apply` и `GET /api/mobile/v1/logs`. После service write Android перечитывает runtime state. После routing write Android принимает published/saved document state только из backend response; independent SHA-256 revisions защищают внешний edit и stale server draft. Logs используют отдельный cursor-based mobile contract; terminal пока не опирается на полноценный mobile contract.

Первый practical block теперь закрыт в репозитории. Следующая работа — не расширять старый shell случайными web adapters, а выбирать следующий отдельный mobile contract slice:

- закрыто: `bootstrap` и alpha session bootstrap/login/restore;
- частично закрыто compatibility adapter'ом: safe service actions; агрегированный ready-workspace/action contract всё еще нужен;
- закрыто для первого safe editor slice: selected Xray routing `document/validate/save/apply` с JSONC preflight, отдельным server draft, optimistic concurrency и restart rollback;
- durable offline persistence logs и terminal/PTY transport;
- optional server preview/diff для `Routing Xray`.

## Что уже можно переиспользовать

| Область | Текущий surface | Оценка для mobile | Что делать |
| --- | --- | --- | --- |
| Auth and setup | `GET /api/auth/status`, `POST /api/auth/login`, `POST /api/auth/logout`, `POST /api/auth/setup` | Логика есть, но UX browser-oriented | Переиспользовать backend auth services, но не тащить текущую cookie+CSRF схему в UI без адаптера |
| Capabilities | `GET /api/capabilities` | Хорошая база для feature gating | Сохранить и встроить в mobile bootstrap/dashboard |
| Service control | `GET /api/xkeen/status`, `GET /api/xkeen/core`, `GET /api/cores/status`, `GET /api/cores/versions`, `GET /api/cores/updates`, `POST /api/xkeen/start`, `POST /api/xkeen/stop`, `POST /api/xkeen/core`, `POST /api/restart`, `POST /api/restart-xkeen` | Quick actions уже используются Android-клиентом через единый port и server reread | Сохранить compatibility adapter; позже обернуть в агрегированный ready summary/action contract с operation semantics |
| Logs and streams | mobile `GET /api/mobile/v1/logs`; legacy `GET /api/xray-logs`, `GET /api/xray-logs/status`, `GET /api/restart-log`, WebSocket surfaces | Xray history/live закрыты cursor polling contract'ом; terminal/web streams остаются web-oriented | Сохранить mobile logs contract; отдельно проектировать PTY/terminal и при необходимости persistent log archive |
| Xray routing workflows | `GET /api/routing/fragments`, mobile `document/validate/save/apply` и existing Xray preflight/backup/restart services | Первый editor-like mobile модуль полностью backend-backed; server draft и published state разделены revision tokens | Сохранить write/conflict contract; при необходимости добавить отдельный server preview/diff use case |
| Mihomo workflows | Routing endpoints, read-only `/api/mihomo-templates` / `/api/mihomo-template`, draft-only `/api/mihomo/node/import-draft` и точечные utility endpoints | Routing, выбор шаблона и нативный импорт узла подключены; полная поверхность по-прежнему слишком широка | Следующим slice переносить `HWID`; `Zashboard UI` открывать внешним браузером, а профили, каталог подписок, бэкапы и генератор не переносить |
| Backups | `GET /api/backups`, `POST /api/backup`, `POST /api/restore`, `POST /api/delete-backup` и related endpoints | Полезно, но рискованно для мобильного UX | Перенести в V1.1 или пускать в V1 только после отдельного safety gate |
| UI settings | `GET/PATCH /api/ui-settings` | Ограниченно полезно | Использовать только если реально нужен мобильный app-level toggle |
| Advanced config editors | `GET/POST /api/inbounds`, `GET/POST /api/outbounds`, другие Xray/Mihomo editor endpoints | Не подходит для прямого mobile parity, но важно для расширения | Не переносить как raw editor parity; строить отдельные mobile editor flows, начиная с `Routing Xray`, затем routing-related Mihomo сценариями |
| FS, RemoteFS, PTY, DevTools | `/api/fs/*`, `/api/remotefs/*`, `/api/fileops/*`, terminal/log devtools surfaces | Не подходит для V1 в полном виде, но часть сценариев имеет ценность | Вводить через granular mobile scopes и отдельные controlled surfaces |

## Текущие backend особенности, которые особенно важны для mobile

- Защита завязана на session cookie и CSRF.
- Для `/api/*` и `/ws/*` есть distinct состояния `428 not_configured`, `401 unauthorized`, `403 csrf_failed`.
- Streaming использует web socket tokens и web-oriented scopes.
- Мобильному клиенту пришлось бы знать слишком много про внутреннюю структуру web routes, если использовать их напрямую.

## Главные разрывы

### 1. Auth and pairing gap

Мобильное приложение не должно копировать браузерный UX с cookie-сессией, CSRF и промежуточными редирект-ожиданиями. Даже если для alpha мы временно используем текущую auth-модель, V1 должен получить mobile-friendly bootstrap и понятный session lifecycle.

Что нужно:

- Явный mobile bootstrap endpoint.
- Решение по session creation: либо controlled session bootstrap поверх текущей auth logic, либо device/pairing token flow.
- Понятный ответ на вопрос, как приложение восстанавливает сессию после перезапуска и как обрабатывает истечение авторизации.

### 2. Endpoint granularity gap

Сейчас полезные данные размазаны по нескольким route groups. Для мобильного dashboard это создает лишние round trips и хрупкую клиентскую сборку состояния.

Что нужно:

- Aggregated `bootstrap` endpoint.
- Aggregated `ready workspace summary` endpoint.
- Небольшой набор action endpoints, отражающих реальные мобильные use cases.

### 3. Response consistency gap

Разные части API могут возвращать разные формы успеха, ошибки и статусных payloads. Для мобильного клиента это повышает сложность обработки edge cases.

Что нужно:

- Единый envelope для mobile contract.
- Стабильные error codes.
- Явные признаки retryable/non-retryable ошибок.

### 4. Long-running operations gap

Часть операций может занимать заметное время или порождать промежуточные состояния. На мобильном нельзя полагаться на то, что пользователь будет держать экран открытым и вручную обновлять статус.

Что нужно:

- Единая модель `operation_id`.
- Polling endpoint или event stream для статуса операции.
- Ясный terminal state: `pending`, `running`, `succeeded`, `failed`, `cancelled`.

### 5. Streaming and lifecycle gap

Логи и live updates в Android живут в другом lifecycle-контексте, чем в браузере. Нам нужен контракт, который нормально переживает background/foreground и reconnect.

Что нужно:

- Единый mobile streaming protocol для логов.
- Понятные правила reconnect и replay window.
- Разделение "live tail" и "recent history".

### 6. Editor semantics gap

Если в приложении появляется `Routing Xray`, а затем `Routing Mihomo`, нам недостаточно просто "отдать файл и принять файл обратно". Первый stateful validate slice уже реализован, но мобильному редактору всё ещё нужны server preview, conflict detection и apply semantics.

Что нужно:

- Документированная модель `draft` и `published` состояния.
- Уже готово: CSRF-protected `validate` endpoint с `200 / valid: false` для domain-invalid JSONC/preflight и structured diagnostics.
- Остались endpoints для `preview`, `save`, `apply`.
- Сохранить семантические diagnostics, а не только raw syntax errors.
- Явный способ сообщать о конфликте версий или внешних изменениях файла.

### 7. Terminal and file safety gap

Терминал и файловый менеджер на телефоне полезны, но это самые рискованные поверхности с точки зрения случайных действий и злоупотребления полномочиями.

Что нужно:

- Granular scopes для terminal и files отдельно от базовой mobile session.
- Read-only режимы там, где это возможно.
- Path and action guards, auditability и понятные destructive confirms.
- Ограничение raw low-level операций до тех случаев, где они действительно оправданы.

### 8. Capability and permission granularity gap

По мере расширения mobile app нам уже недостаточно общего ответа "`feature available`". Нужны флаги и permissions по конкретным advanced modules.

Что нужно:

- Capability flags уровня `routingEditor`, `mihomoTemplates`, `mihomoNode`, `mihomoHwid`, `zashboardUi`, `devtoolsPartial`, `terminal`, `files`.
- Разделение read/write/execute permission levels.
- Возможность backend-side отключать целые advanced surfaces для конкретной инсталляции.

### 9. Safety gap

Веб-панель допускает более широкий набор действий. В mobile companion нужно заранее отделить безопасные быстрые действия от опасных low-level workflows.

Что нужно:

- Каталог разрешенных quick actions.
- Явные confirm steps для рискованных операций.
- Возможность backend-side маркировать действия как запрещенные или требующие подтверждения.

### 10. Versioning gap

Существующие web endpoints исторически развивались для UI, а не как отдельный public mobile contract. Нам нужна предсказуемая compat story.

Что нужно:

- Versioned namespace для mobile.
- Contract tests.
- Документированные compat guarantees хотя бы в пределах `v1`.

### 11. Observability gap

Если мобильный клиент не может объяснить, почему действие не выполнилось, приложение быстро теряет доверие пользователя.

Что нужно:

- Correlation id или аналог для диагностирования запросов.
- Ясные machine-readable error codes.
- Read-only diagnostics summary для последних операций.

## Рекомендуемый mobile contract

Ниже не финальная спецификация, а рекомендуемый shape для Phase 1.

### Core endpoints

- `GET /api/mobile/v1/bootstrap`
- `GET /api/mobile/v1/ready`
- `POST /api/mobile/v1/session` или `POST /api/mobile/v1/pair`
- `DELETE /api/mobile/v1/session`
- `POST /api/mobile/v1/service/actions`
- `GET /api/mobile/v1/logs/sources`
- `POST /api/mobile/v1/logs/stream-token` или альтернативный streaming bootstrap
- `GET /api/mobile/v1/xray/routing/cards`
- `GET /api/mobile/v1/xray/routing/documents/{id}`
- `POST /api/mobile/v1/xray/routing/validate` — реализован: selected fragment + raw JSONC, temporary-confdir Xray preflight, no persistent config/DAT-asset write
- `POST /api/mobile/v1/xray/routing/preview`
- `PUT /api/mobile/v1/xray/routing/documents/{id}`
- `POST /api/mobile/v1/xray/routing/apply`
- `GET /api/mobile/v1/operations/{id}`

### Expansion endpoints after V1

- `GET /api/mobile/v1/mihomo/routing/cards`
- `GET /api/mobile/v1/mihomo/routing/documents/{id}`
- `POST /api/mobile/v1/mihomo/routing/validate`
- `POST /api/mobile/v1/mihomo/routing/preview`
- `PUT /api/mobile/v1/mihomo/routing/documents/{id}`
- `GET /api/mobile/v1/devtools/summary`
- `GET /api/mobile/v1/devtools/operations/recent`
- `POST /api/mobile/v1/terminal/sessions`
- `DELETE /api/mobile/v1/terminal/sessions/{id}`
- `GET /api/mobile/v1/files/tree`
- `POST /api/mobile/v1/files/read`
- `POST /api/mobile/v1/files/write`

### Optional V1.1 / later endpoints

- `GET /api/mobile/v1/backups`
- `POST /api/mobile/v1/backups/create`
- `POST /api/mobile/v1/backups/restore`
- `GET /api/mobile/v1/diagnostics/recent`

## Рекомендуемая форма ответа

```json
{
  "ok": true,
  "data": {},
  "meta": {
    "api_version": "mobile-v1"
  }
}
```

```json
{
  "ok": false,
  "error": {
    "code": "unauthorized",
    "message": "Authentication required",
    "retryable": false
  }
}
```

Если следующая операция будет асинхронной, ответ должен либо сразу содержать terminal state, либо возвращать `operation_id` с понятным способом узнать дальнейший прогресс.

## Что не нужно делать

- Не переписывать существующий web backend под mobile целиком.
- Не дублировать доменную логику только ради нового namespace.
- Не включать terminal, files, devtools и editor flows в mobile contract без поэтапного включения, capability flags и safety-модели.
- Не полагаться на прямой вызов десятков legacy/web endpoints из Android UI.
- Не проектировать mobile API под конкретную стороннюю библиотеку редактора, терминала или файлового дерева.
- Не переносить desktop split-pane и raw file-editing semantics в Android 1:1 только потому, что они уже есть в web UI.

## Практический итог для реализации

Backend уже достаточно богат по возможностям, чтобы мобильное приложение не начиналось с нуля. Первый устойчивый mobile contract теперь покрывает auth, service actions, controlled `Routing Xray` и Xray logs. Дальше нужно сохранять тот же подход: не превращать Android в набор browser-route adapters, а вводить editor/devtools/terminal/files отдельными versioned slices с capability granularity и contract tests.

С учетом `android-companion` это означает следующее: UI baseline и mobile contract для auth, writes и Xray streams уже проверены автоматизированно; product sign-off ждёт согласованный backend/APK device rollout, а дальнейшее расширение начинается с отдельного safety-reviewed slice.

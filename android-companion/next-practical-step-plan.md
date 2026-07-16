# Xkeen Mobile Companion Next Practical Step Plan

Status: stages 1-7 completed, stage 8 next
Updated: 2026-07-16

## Зачем нужен этот план

Разложить ближайший большой переход от demo-only baseline к реальному mobile companion на маленькие этапы, которые можно брать по одному и мержить без потери рабочей сборки.

Фокус этого плана:

- реальный `transport`, `auth/session` и восстановление сессии;
- persistence для подключений и секретов;
- backend-backed `Routing Xray validate / save / apply`;
- write-safe service actions, core switch и reliable logs transport.

## Общие правила выполнения

- Каждый этап должен оставлять `android-companion/` в собираемом состоянии.
- Каждый этап лучше выполнять отдельным PR или как минимум отдельным логическим changeset.
- Пока не закрыты `transport/auth/persistence/write` слои, не расширяем scope новыми экранами.
- Если backend mobile namespace `/api/mobile/v1/*` еще не готов, Android-интерфейсы все равно проектируем уже под этот shape, а прямые web-endpoint'ы используем только как временный adapter.
- После каждого этапа минимум одна проверка остается обязательной:

```powershell
cd android-companion
.\gradlew.bat testDebugUnitTest assembleDebug
```

## Этап 1. Подготовить архитектурный seam вместо demo-only controller

Статус: завершено 2026-07-13

Что сделали:

- `DemoCompanionController` заменен на `CompanionController`, который получает зависимости через `CompanionControllerDependencies`.
- Side effects вынесены в отдельные порты `ConnectionsPort`, `SessionPort`, `ServiceActionsPort`, `RoutingWritePort`, `LogsPort`; time/journal helper оставлен отдельно в `CompanionJournalPort`.
- `CompanionController` больше не создает `LogEntry` напрямую: controller-события тоже проходят через `LogsPort`, а значит log transport и policy хранения можно будет заменить без роста reducer-логики.
- Текущее поведение сохранено через demo/fake реализации, поэтому UI-поток не менялся.
- `XrayConfigSource` и `CoreStatusSource` переведены на общий `CompanionHttpTransport`, а не держат network-логику разрозненно.
- Добавлены unit tests для seam-based controller wiring и общего transport path.

Что считаем закрытым:

- текущее UI-поведение визуально не меняется;
- controller/reducer-логика тестируется отдельно от сети и storage;
- реальные реализации теперь можно подключать без роста `CompanionController`, включая будущий logs transport.

## Этап 2. Сохранение подключений между запусками

Статус: завершено 2026-07-13

Что сделали:

- Добавлен `PersistedConnectionsPort` с app-private хранилищем на `SharedPreferences`; snapshot содержит список узлов, последний выбранный `id`, `status` и `lastSeen`.
- `Launching` загружает persisted snapshot, а `CompanionUiState` больше не заполняется через `demoConnections()`; demo-список удален.
- `Connections` поддерживает создание, повторный выбор и редактирование сохраненного узла. При редактировании сохраняются стабильный `id`, позиция в списке и metadata состояния.
- Изменения статуса после demo `Pair/Login` и `disconnect` проходят обратно через `ConnectionsPort` и переживают пересоздание процесса.
- Формат чтения устойчив к поврежденным строкам и неизвестному выбранному `id`; добавлены unit tests с пересозданием persistence-порта.
- Видимые данные подключения отделены от будущих секретов: пароль, cookie и token в этот snapshot не записываются. Наличие сохраненного `Configured` metadata не считается разрешением на автоматический вход.

Изначальный scope:

- Добавить локальное хранилище для списка подключений, выбранного узла и базового metadata состояния.
- Убрать зависимость от `demoConnections()` как источника истины при старте приложения.
- Поддержать безопасное редактирование и повторный выбор уже сохраненного узла.

Готово, когда:

- после перезапуска приложения список узлов не теряется;
- `Launching` и `Connections` работают уже с persisted данными, а не только с in-memory state.

Что считаем закрытым:

- после cold start список, metadata и последний выбранный узел восстанавливаются из локального хранилища;
- добавление и редактирование сразу записываются в storage, а повторный выбор не создает дубликат;
- автоматическое восстановление доверенной сессии сознательно остается за этапом 5: secure session material уже есть, но нужен реальный backend bootstrap и проверка его валидности.

## Этап 3. Secure storage для session-материала

Статус: завершено 2026-07-15

Что сделали:

- Добавлены `SessionMaterial` и `StoredSessionMaterial`, изолированные от snapshot видимых `Connection`: хранятся только access/refresh token, cookie header, CSRF token и marker `trustedForRestore`; пароль в эту модель не попадает.
- Добавлен per-connection `SessionMaterialStore` с `loadTrusted()`, поэтому сохраненный узел со статусом `Configured` сам по себе не разрешает cold-start restore.
- Для Android работает `AndroidKeystoreSessionMaterialStorage`: весь payload шифруется AES-GCM, ключ неэкспортируемый и создается в Android Keystore; в app-private `SharedPreferences` не записываются raw token/cookie/CSRF. Поврежденный ciphertext или недоступный ключ приводят к очистке unusable record.
- Backup приложения выключен (`android:allowBackup="false"`), чтобы session payload не попадал в резервную копию вместе с локальными данными приложения.
- Текущий `DemoSessionPort` проходит через тот же storage boundary с синтетическим случайным secret, но всегда пишет `trustedForRestore = false`; это не дает demo flow случайно стать автоматической авторизацией.
- Logout очищает material только выбранного узла; после успешного login пароль очищается и из `CompanionUiState`.
- Добавлены unit tests на пересоздание store, trusted/untrusted marker, выборочное очищение, malformed records и отсутствие пароля в payload.

Политика восстановления:

- Этап 5 пытается восстановить только запись выбранного узла, которую вернул `loadTrusted()`, и подтверждает ее на backend.
- Повторный вход нужен при отсутствии записи, `trustedForRestore = false`, повреждении ciphertext/сбросе Android Keystore, а также при истекшей или отозванной серверной авторизации.
- Обычное сохраненное подключение и сохраненный статус `Configured` не являются доказательством действующей сессии.

Что делаем:

- Отделить видимые данные подключения от чувствительных session/token/cookie данных.
- Подключить secure storage wrapper для секретов и флага доверенного восстановления.
- Явно описать, что именно мы умеем восстанавливать автоматически, а что требует повторного входа.

Готово, когда:

- секреты не живут только в памяти процесса;
- можно безопасно отличить обычное сохраненное подключение от доверенной восстанавливаемой сессии.

## Этап 4. Единый transport и нормальная ошибка-семантика — завершен 2026-07-15

Что делаем:

- Ввести один HTTP transport слой с нормализацией `baseUrl`, timeout, common headers и auth hooks.
- Нормализовать ошибки `401`, `403`, `428`, HTML login page, offline и timeout в понятные app-level состояния.
- Перевести существующие read-only запросы `core` и `routing` на этот единый client path.

Сделано:

- `CompanionHttpTransport` нормализует и проверяет `baseUrl`, использует единые headers, configurable timeout и auth hook с безопасным приоритетом над request headers.
- `401`, `403`, `428`, HTML login page, offline и timeout превращаются в `CompanionTransportFailureKind`; `core` показывает ошибку в dashboard, diagnostics и logs, а `routing` — в своем retryable load state.
- `WebPanelCoreStatusSource` и `WebPanelXrayConfigSource` больше не содержат собственной HTTP/HTML error-логики и получают только успешный не-HTML response.
- Добавлены unit tests на URL/header contract, error classification и сквозное отображение transport failure в controller.

Готово, когда:

- приложение одинаково обрабатывает transport/auth ошибки во всех сетевых местах;
- нет нескольких разрозненных реализаций GET-запросов с разной логикой ошибок.

## Этап 5. Реальный Pair/Login и восстановление сессии

Статус: завершено 2026-07-16

Детальная точка приемки: [stage-5-closure-checklist.md](stage-5-closure-checklist.md).

Этап закрывается только после выполнения всех пунктов:

- [x] Backend mobile session contract предоставляет `GET /api/mobile/v1/bootstrap`, `POST /api/mobile/v1/session` и `DELETE /api/mobile/v1/session` с browser-compatible cookie + CSRF session.
- [x] Реальный `MobileSessionPort` заменяет demo session flow; `Pair/Login` вызывает suspend-методы из coroutine и не использует `pairDemoDevice`.
- [x] Cookie и CSRF лежат только в Android Keystore-backed per-connection storage; пароль не сохраняется.
- [x] Только server-validated trusted restore переводит `Launching -> Ready`; `Configured` metadata не является авторизацией.
- [x] Logout предсказуемо удаляет local material выбранного узла, а `401` из `Ready` очищает его и возвращает пользователя в `Pair/Login`.
- [x] Session material выбирается по `connectionId`, а auth hook дополнительно сверяет normalised `baseUrl`, поэтому два профиля с одинаковым URL изолированы.
- [x] Добавлены backend contract tests и Android unit tests для session contract, restore, logout, expiry/401 и connection isolation.
- [x] При отсутствии, повреждении или недоверенности session material у выбранного узла `Launching` сразу делает явный fallback в `Pair/Login` (не в общий `Connections` list); при отсутствии выбранного узла открывается `Connections`.
- [x] Обязательная verification green: на 2026-07-16 backend contract suite прошел (`3 passed`), а `testDebugUnitTest assembleDebug` завершился успешно.

Ограничение alpha: используется browser-compatible cookie+CSRF session. Device pairing, refresh-token lifecycle и полноценный mobile-native auth contract намеренно остаются последующими этапами.

Post-stage hotfix 2026-07-16:

- Проверка реального узла выявила несовместимость развернутой версии: `/api/auth/status` возвращал рабочее состояние auth, но `/api/mobile/v1/bootstrap` до входа отвечал `401 unauthorized`.
- `MobileSessionPort` теперь распознает именно отсутствие открытого mobile handshake и безопасно переключается на существующий web auth API с получением CSRF/cookie; явная ошибка `invalid_credentials` не запускает второй запрос и не расходует лишнюю попытку rate limit.
- `Pair/Login` упрощен до автоматической проверки подключения и одной кнопки входа; добавлены вертикальные поля, показ пароля и keyboard submit.

Post-stage editor UX hardening 2026-07-16:

- Compose `BasicTextField`, полный список номеров строк и ручной drag-scroll заменены внутренней нативной Android text surface без изменения палитры и общего layout рабочего экрана.
- Большие routing-документы получили виртуализированный gutter, инерционный скроллинг, быстрый скроллбар и подсветку только видимой области с буфером.
- Нативные двойной/длинный тап сохраняют системные cut/copy/paste/select-all; добавлены ограниченная incremental undo/redo history, выделение и дублирование строки, прямой переход к строке и расширенный cursor status.
- Follow-up по проверке на реальном устройстве: включен soft wrap без горизонтального скроллинга, gutter и tab stop уплотнены, а нижний editor padding при открытой клавиатуре уменьшен без изменения общей палитры/layout.

## Этап 6. Backend-backed service actions и core switch

Статус: завершено 2026-07-16

Детальная точка приемки: [stage-6-closure-checklist.md](stage-6-closure-checklist.md).

Что сделано:

- Production composition переведен с `DemoServiceActionsPort` на `WebPanelServiceActionsPort`: `start`, `stop`, `restart` и смена ядра вызывают реальные CSRF-protected backend endpoint'ы.
- Успешный POST больше не меняет dashboard сам по себе: клиент перечитывает `GET /api/xkeen/status` и `GET /api/xkeen/core`, проверяет ожидаемый runtime state и только затем публикует `Success`.
- Добавлено единое состояние `Idle / Pending / Success / Failure`, глобальная result surface, явная ошибка в dashboard/diagnostics/logs и блокировка повторных service/core действий во время запроса.
- Confirm dialog запускает suspend-operation из coroutine; core dialog остается в pending/error flow и закрывается автоматически только после server-confirmed success.
- Для потенциально долгого core switch используется отдельный action transport с read timeout 90 секунд; обычные read/session запросы сохраняют прежние timeout'ы.
- Если write завершается ошибкой, controller по возможности перечитывает service/core snapshot с сервера, но не превращает этот refresh в ложный success исходной операции.
- Добавлены unit tests на endpoint/payload contract, parsing, mismatch между принятым POST и runtime state, pending/repeat guard, success/failure и server-backed dashboard refresh.

Device follow-up 2026-07-16:

- Исправлена гонка Mihomo → Xray: первый status reread мог вернуть переходное `stopped / Xray`, хотя перезапуск успешно завершался следом. `WebPanelServiceActionsPort` теперь делает bounded polling server snapshot до 16 попыток с интервалом 1 секунду и публикует success только после `running` с выбранным ядром.
- Core dialog остаётся единственной поверхностью pending/failure для переключения ядра, поэтому одна ошибка больше не дублируется одновременно в modal и глобальном banner.
- Глобальный success banner получил непрозрачный dark-green container и контрастный текст вместо наложения полупрозрачного зелёного слоя на редактор.
- Добавлен regression test переходного `stopped / Xray -> running / Xray`.

Что делаем:

- Заменить локальные `start`, `stop`, `restart` и `switchCore` на реальные backend-вызовы.
- Добавить состояние `pending / success / failure` и защиту от повторных нажатий.
- После завершения действия обновлять dashboard и active core из сервера, а не из локального предположения.

Готово, когда:

- confirm dialog запускает реальную операцию;
- UI показывает результат сервера и не сообщает об успехе раньше времени;
- ошибки action flow выглядят так же явно, как ошибки чтения.

## Этап 7. Routing Xray: сначала реальный validate

Статус: реализация и пакет готовы 2026-07-16; ожидается повторная приемка на реальном узле после обновления backend

Детальная точка приемки: [stage-7-closure-checklist.md](stage-7-closure-checklist.md).

Что сделано:

- Добавлен versioned, authenticated и CSRF-protected `POST /api/mobile/v1/xray/routing/validate`; он принимает имя выбранного fragment и raw JSONC draft, работает во temporary confdir и не выполняет persistent save/restart/DAT-asset sync.
- Backend использует тот же temporary-confdir Xray preflight, что и существующий routing save, но domain-invalid syntax/semantic/preflight result возвращает как HTTP `200` с `data.valid = false` и structured diagnostics.
- Production Android composition получила `RoutingValidationPort` / `WebPanelRoutingValidationPort` с отдельным `90 s` action transport; `validate` теперь выполняется из coroutine и делает реальный round-trip.
- `RoutingValidation` разделяет local JSONC syntax, server и transport diagnostics (`source`, `severity`, `code`, message, optional hint/phase/path/line/column); активная editor surface показывает их раздельно.
- Добавлены `Validating`, repeat guard и stale-result guard: новый draft или другой документ не могут получить поздний результат старого запроса.
- Добавлены backend contract и Android unit tests для payload/parsing, syntax/preflight diagnostics, CSRF/auth, body limit, `401` fallback и stale/repeat behavior.
- Первый device smoke-test обнаружил rollout mismatch: новый APK обращался к старому Xkeen UI, поэтому сервер вернул `404`. Актуальный `xkeen-ui-routing.tar.gz` пересобран с validate endpoint; Android отдельно распознаёт такой `404` как `validation_endpoint_unavailable` и предлагает обновить backend.

Что делаем:

- Подключить серверную валидацию для выбранного routing-документа.
- Разделить локальные syntax issues и ответы backend validation.
- Вернуть в UI структурированные diagnostics, чтобы `validate` перестал быть demo-проверкой строки.

Готово, когда:

- кнопка `validate` делает реальный round-trip;
- ответ сервера отражается в `RoutingValidation`, а не подменяется локальной эвристикой.

Что считаем закрытым:

- [x] Кнопка `validate` делает authenticated CSRF real round-trip для выбранного routing-документа.
- [x] Локальные syntax issues не подменяют backend ответ и остаются отдельным structured source в UI.
- [x] Server diagnostics отражаются в `RoutingValidation`, включая machine-readable code и доступную location/hint metadata.
- [x] Ошибка сети, timeout и невалидный ответ не публикуют ложный success; `401` возвращает к стандартному `Pair/Login` flow этапа 5.
- [x] Backend и Android verification пройдены 2026-07-16.
- [ ] После установки согласованных backend-архива и APK реальный узел возвращает server-confirmed validation result вместо `404`.

## Этап 8. Routing Xray: затем save/apply и conflict handling

Статус: завершено 2026-07-16

Детальная точка приемки: [stage-8-closure-checklist.md](stage-8-closure-checklist.md).

Что сделано:

- Добавлены authenticated/CSRF-protected mobile endpoints `GET /api/mobile/v1/xray/routing/document`, `POST /api/mobile/v1/xray/routing/save` и `POST /api/mobile/v1/xray/routing/apply`.
- `document` возвращает раздельные `published` и `saved` snapshots с SHA-256 revision tokens, content/timestamps и явным `conflict`, если server draft основан на устаревшей published revision.
- `save` повторно выполняет read-only Xray preflight и хранит проверенный draft отдельно в app-private `mobile-routing-drafts`; live Xray fragment и сервис при этом не меняются.
- `apply` принимает только revision уже сохранённого server draft, повторяет preflight, создаёт существующие Xray backup snapshots, атомарно пишет clean JSON + JSONC sidecar и публикует success только после подтверждённого restart xkeen. При failed restart прежние файлы восстанавливаются, а draft сохраняется для повторной попытки.
- Optimistic concurrency проверяет независимо `published_revision` и `saved_revision`: внешний апдейт live-файла, stale mobile draft и mismatch saved/published возвращаются как HTTP `409` с актуальным server snapshot.
- Production Android composition переведена с `DemoRoutingWritePort` на `WebPanelRoutingWritePort`; локальный document state после `save/apply` обновляется только содержимым backend response.
- Добавлен отдельный `RoutingWritePhase.Conflict`: conflict не маскируется под invalid validation, сохраняет локальный editor text, показывает server revision metadata и блокирует слепой apply.
- Save/apply получили coroutine pending/repeat guards. Если текст меняется во время запроса, подтверждённый server snapshot сохраняется, но новый локальный текст остаётся `Dirty` и требует повторного validate.
- Добавлены backend contract tests на save-without-apply, exact saved apply, external update, stale draft, saved/published mismatch, CSRF и rollback при failed restart; Android tests покрывают payload/parsing, typed `409`, server-only state adoption и controller conflict state.

Критерии закрытия:

- [x] `save` и `apply` не создают ложное локальное ощущение успеха: save подтверждает отдельный server draft, apply — запись и restart.
- [x] Внешний апдейт, stale saved revision и mismatch saved/published выявляются backend revision model до перезаписи.
- [x] После write локальные published/saved metadata приходят только из backend response.
- [x] Conflict имеет отдельное пользовательское состояние с кодом и сообщением, не общую validation error.
- [x] Backend и полный Android unit suite пройдены 2026-07-16.
- [ ] На реальном узле установить согласованные backend archive и APK и пройти device smoke-test `load -> edit -> validate -> save -> apply`, а затем внешний конфликт.

Rollout dependency: APK этого этапа требует backend с новыми mobile routing endpoints. Старый Xkeen UI вернёт `404`, и приложение покажет инструкцию обновить backend вместо локального success.

## Этап 9. Logs transport и reconnect behavior

Что делаем:

- Подключить реальную историю логов и live transport.
- Явно описать режимы `connected`, `reconnecting`, `auth required`, `disconnected`.
- Переживать `background -> foreground` и временный разрыв сети без разрушения UI-состояния.

Готово, когда:

- `Логи Xray` и связанные diagnostics больше не зависят от demo entries;
- reconnect ведет себя предсказуемо и не требует ручного "перезапуска экрана".

## Этап 10. Финальная шлифовка и приемка текущего блока

Что делаем:

- Добавить unit tests для transport parsing, session restore, persisted connections, action flows и routing conflicts.
- Прогнать ручные сценарии: cold start, restore trusted session, expired auth, offline node, failed action, routing conflict, logs reconnect.
- Обновить `android-companion/README.md`, когда эти пункты перестанут быть demo-only.

Готово, когда:

- базовый shell живет уже на реальных transport/session/write слоях;
- `README` больше не говорит, что `Pair/Login`, service actions и `Routing Xray save/apply` остаются demo-only;
- текущий practical step можно считать закрытым и двигаться дальше к следующему slice.

## Точки входа в код

С высокой вероятностью основная работа начнется вокруг этих файлов:

- `app/src/main/java/io/xkeen/mobile/app/CompanionController.kt`
- `app/src/main/java/io/xkeen/mobile/app/CompanionControllerDependencies.kt`
- `app/src/main/java/io/xkeen/mobile/app/CompanionHttpTransport.kt`
- `app/src/main/java/io/xkeen/mobile/app/CompanionModels.kt`
- `app/src/main/java/io/xkeen/mobile/app/XrayConfigSource.kt`
- `app/src/main/java/io/xkeen/mobile/app/CoreStatusSource.kt`

Новые реальные реализации логично держать рядом с ними в том же `io.xkeen.mobile.app`, пока не станет очевидна необходимость выносить их в отдельные `data` / `domain` пакеты.

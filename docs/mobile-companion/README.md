# Xkeen-UI Mobile Companion

Status: active implementation baseline
Updated: 2026-07-16

Этот каталог фиксирует актуальное состояние Android companion-приложения для Xkeen-UI и связанные с ним продуктовые и технические решения. Документы ниже считаются living docs и должны совпадать с фактическим состоянием `android-companion/`.

## Текущий статус на 2026-07-16

Инициатива уже давно вышла из стадии "поднять проект". В репозитории есть рабочий Android-проект `android-companion/`, и локальная проверка `.\gradlew.bat testDebugUnitTest assembleDebug` снова прошла успешно `2026-07-16`.

Что это означает на практике:

- приложение уже проходит через `Launching`, `Connections`, `Pair/Login` и `Ready`-workspace;
- ready-состояние больше не соответствует раннему shell `Dashboard / Logs / More`;
- текущий рабочий shell capability-aware и использует вкладки `Xray`, `Mihomo`, `Ports`, `Shell`;
- наличие вкладок и drawer-разделов зависит от списка установленных ядер, который приходит из `GET /api/xkeen/core`;
- первый реальный backend slice уже подключён для чтения: `GET /api/xkeen/core`, `GET /api/routing/fragments`, `GET /api/routing?file=...`;
- все существующие read-only вызовы проходят через единый Android transport с безопасной нормализацией base URL, timeout/common headers/auth hook и типизированными состояниями auth, setup, offline и timeout;
- вход предпочитает `/api/mobile/v1/*`, но совместим и с установленными версиями, где mobile handshake еще отвечает `401`: в этом случае session adapter прозрачно использует `/api/auth/status` и CSRF-protected `/api/auth/login`, не сохраняя пароль;
- экран входа автоматически проверяет узел и показывает один основной путь: логин, пароль и `Войти`;
- список подключений, базовый metadata state и последний выбранный узел уже переживают перезапуск приложения через app-private storage;
- самый глубокий модуль сейчас это `Routing Xray`: он читает реальные routing-документы, выполняет server Xray preflight для raw JSONC draft и даёт полноэкранный editor-flow с нативными Android-жестами и быстрым скроллингом больших файлов;
- Этап 5 закрыт: secure storage session-материала, real alpha auth/session bootstrap, server-validated restore, explicit `Pair/Login` fallback и backend/Android verification готовы;
- Этап 6 закрыт: `start`, `stop`, `restart` и core switch используют реальные CSRF-protected backend POST endpoint'ы, имеют `pending/success/failure`, блокируют повторный запуск и обновляют service/core state только после серверного reread.
- Реализация и пакет этапа 7 готовы: `Routing Xray validate` использует CSRF-protected `POST /api/mobile/v1/xray/routing/validate`, real temporary-confdir Xray preflight и structured server diagnostics без persistent save/restart/DAT-asset-sync side effect. Финальная отметка ожидает повторного device smoke-test после совместного обновления backend и APK; первый тест с новым APK и старым backend корректно выявил rollout mismatch через HTTP `404`.

Этап 8 закрыл backend write/conflict contract для Routing Xray: load возвращает published/saved revisions, save хранит отдельный server draft, apply атомарно публикует exact saved revision и подтверждает restart, а stale/external updates возвращают отдельный conflict state.
Этап 9 закрыл первый stream transport: `GET /api/mobile/v1/logs` отдает Xray history и cursor-based incremental updates. Android запускает foreground-scoped transport, явно показывает `connected/reconnecting/auth required/disconnected` и сохраняет UI/history при background -> foreground. Детальная приемка: [stage-9-closure-checklist.md](../../android-companion/stage-9-closure-checklist.md). Controller использует dependency seam через `ConnectionsPort`, `SessionPort`, `ServiceActionsPort`, `RoutingValidationPort`, `RoutingWritePort`, `LogsPort` и `LogsTransportPort`; production implementation теперь есть и у logs transport.

Этап 10 закрыл repository hardening: новая или восстановленная сессия сначала показывает нейтральное состояние, затем получает service/core/routing только из server snapshot; cached routing другого узла не переносится. Итоговая acceptance matrix и честно отделённый real-device rollout: [stage-10-closure-checklist.md](../../android-companion/stage-10-closure-checklist.md).

## Связанные документы

- [App skeleton](app-skeleton.md)
- [Roadmap](roadmap.md)
- [Backend contract gap analysis](backend-contract-gap-analysis.md)
- [Stage 5 closure checklist](../../android-companion/stage-5-closure-checklist.md)
- [Stage 6 closure checklist](../../android-companion/stage-6-closure-checklist.md)
- [Stage 7 closure checklist](../../android-companion/stage-7-closure-checklist.md)
- [Stage 8 closure checklist](../../android-companion/stage-8-closure-checklist.md)

## Назначение

Мобильная web-версия панели не дала достаточно надёжного UX для повседневного управления. Вместо дальнейших точечных правок мобильного браузерного интерфейса проект движется к отдельному Android-приложению, сфокусированному на быстрых и безопасных сценариях управления Xkeen-UI с телефона.

Companion при этом рассматривается не как урезанный "пульт навсегда", а как база для постепенного переноса в Android ценных web-модулей. Первый глубокий перенос уже начат с `Routing Xray`, дальше в приоритете остаются `Routing Mihomo`, точечные Mihomo-инструменты, partial `DevTools`, а затем controlled `Commands` и `Files`. `Mihomo Generator` остаётся только в веб-панели.

## North Star

Пользователь на Android должен иметь возможность открыть приложение в локальной сети или через доверенный VPN, быстро понять состояние Xkeen-UI и выполнить частые безопасные действия без необходимости открывать десктопный браузер.

## Исходная точка на 2026-07-13

- Веб-панель остаётся основной административной поверхностью.
- Backend уже содержит полезные API-группы для auth, capabilities, service control, logs, Mihomo/Xray и backups.
- Текущий API в основном рассчитан на браузерную сессию с cookie и CSRF, а не на мобильный клиент.
- Полный перенос всей веб-функциональности в mobile не является ни быстрым, ни желательным первым шагом.
- В репозитории уже есть working Android baseline в `android-companion/`, который сочетает живой Compose shell, capability-aware navigation и частичную read-only интеграцию с backend.

## Принципы продукта

- Companion, а не full parity: мобильное приложение покрывает частые и безопасные сценарии, а не весь админский surface.
- Android first: в первой итерации проектируем и реализуем только Android-клиент.
- Existing backend first: по возможности переиспользуем текущие backend services и добавляем тонкий mobile-слой, а не переписываем доменную логику.
- Local-first trust boundary: приложение не должно толкать нас к публичной экспозиции панели в интернет.
- Safe actions first: сначала даём быстрые действия с понятным эффектом и подтверждением, а не сложные редакторы.
- Capability-driven UI: мобильный клиент показывает только те разделы и действия, которые действительно доступны на конкретной инсталляции.
- Progressive surface migration: сложные web-модули переносим в Android поэтапно, начиная с наиболее ценных мобильных поверхностей.
- Dense mobile UI: никаких растянутых pill-кнопок и web-like пустот; делаем компактные действия, иконки, мини-текст и плотные списки.

## Рабочие технологические допущения

- Базовое направление: Kotlin + Jetpack Compose.
- Networking: HTTP API и отдельный lifecycle-aware contract для логов и событий.
- Storage: видимые данные подключения хранятся в app-private storage. Session token/cookie/CSRF и trusted-restore marker хранятся отдельным encrypted payload с неэкспортируемым ключом Android Keystore; пароль не сохраняется вообще.
- Архитектурное допущение: web endpoints остаются совместимыми для браузера, а mobile получает отдельный контракт поверх существующего service layer.

## Текущее implementation baseline

Подробный shell и визуальные правила вынесены в [app-skeleton.md](app-skeleton.md). На уровне фактического проекта сейчас важно фиксировать следующее:

- `Connections` и `Pair/Login` уже являются частью рабочего потока приложения; список узлов, metadata и последний выбор сохраняются между запусками.
- Per-connection `SessionMaterialStore` уже хранит session material отдельно от `Connection`; обычный `Configured` metadata status не равен доверенной восстанавливаемой сессии.
- `MobileSessionPort` использует `GET /api/mobile/v1/bootstrap`, `POST/DELETE /api/mobile/v1/session`; он сохраняет только cookie+CSRF для выбранного connection и подтверждает restore на сервере.
- `Ready` строится вокруг единого workspace, а не вокруг старой карты `Dashboard / Logs / More`.
- Нижняя навигация использует `Xray`, `Mihomo`, `Ports`, `Shell` и скрывает недоступные capability slices.
- Drawer перестраивается под выбранную рабочую зону и активные ядра.
- `WebPanelServiceActionsPort` выполняет реальные service/core POST-запросы и после них перечитывает `/api/xkeen/status` и `/api/xkeen/core`; controller не публикует success по локальному предположению.
- `Routing Xray` уже читает реальные backend-документы и использует `WebPanelRoutingValidationPort`: `validate` отправляет raw JSONC на `/api/mobile/v1/xray/routing/validate`, показывает pending/repeat guard и получает server Xray diagnostics отдельно от local syntax/transport feedback.
- `Shell` содержит журнал событий приложения и рабочий терминал.
- Остальные секции в основном служат placeholder-границами для следующего контракта и следующих модулей.

## V1: что именно должно уметь приложение

### Реализовано сейчас

- Ручное добавление, persisted-редактирование и повторный выбор инстанса с восстановлением списка после cold start.
- Capability-aware workspace с безопасными действиями `start`, `stop`, `restart` через confirm state.
- Загрузка доступных ядер через `GET /api/xkeen/core`.
- Read-only загрузка Xray routing-фрагментов и содержимого документов через те же endpoint'ы, что использует веб-панель.
- Реальная server-backed validation routing draft с temporary-confdir Xray preflight, structured diagnostics и безопасным stale/repeat guard; полноэкранный редактор больших файлов, переключение между документами и подсветка JSON/JSONC видимой области.
- Защищенное per-connection хранение access/refresh token, cookie header, CSRF token и marker `trustedForRestore`; пароль очищается после успешного login, а logout удаляет material только активного узла.
- Backend-backed `start`, `stop`, `restart` и core switch с confirm dialog, единым `pending/success/failure` состоянием, repeat guard и server-confirmed dashboard/core snapshot.

### Ещё не завершает MVP

- Этап 5 закрыт: выбранный узел без `loadTrusted()`-record при cold start сразу попадает в `Pair/Login`, а отсутствие выбранного узла по-прежнему ведет в `Connections`.
- Сохраненный status подключения является только metadata и не используется как разрешение на автоматический вход.
- `Routing Xray load/validate/save/apply` server-backed; backend и APK должны обновляться согласованно, после чего остаётся device smoke-test write/conflict flow.
- `Логи Xray` используют реальную server history и cursor-based live transport с bounded reconnect. Terminal/PTY transport всё ещё остаётся отдельным последующим slice.
- Большая часть Mihomo и Ports поверхностей пока только обозначает следующий модульный срез.

### Post-MVP / V1.1

- Backups: просмотр списка, создание и restore с дополнительными safeguards.
- Read-only diagnostics history и operation timeline.
- Push/local notifications для деградации сервиса или завершения долгих операций.
- Более удобное обнаружение локальных инстансов.
- Точечные Mihomo-инструменты `Шаблоны`, `Узел`, `HWID` и `Zashboard UI` по отдельным безопасным контрактам.

### Out of scope for V1

- Полный перенос всего web UI в мобильное приложение за один релиз.
- Full parity для PTY, файлового менеджера, RemoteFS и DevTools.
- Полный редактор всех Xray/Mihomo документов без staged rollout.
- Перенос `Mihomo Generator` из веб-панели.
- Облачный relay, публичная интернет-экспозиция и iOS-клиент.

## Актуальная карта экранов

1. `Launching` / restore
2. `Connections`
3. `Pair/Login`
4. `Ready` workspace
5. Вкладка `Xray` с drawer-секциями для routing и связанных Xray-срезов
6. Вкладка `Mihomo` с Mihomo-срезами, если ядро доступно
7. Вкладка `Ports`
8. Вкладка `Shell`

Эта карта уже отражает текущее приложение. Старое описание через `Dashboard`, `Logs` и `More` больше не является source of truth.

## Порядок расширения после текущего baseline

- `Routing Mihomo` как следующий глубокий routing-модуль.
- `Шаблоны`, `Узел`, `HWID` и `Zashboard UI` как отдельные Mihomo-срезы с собственными контрактами.
- Partial `DevTools` для diagnostic summary и targeted utilities.
- Controlled `Commands` и `Files` только после отдельной safety-модели и granular permissions.

## Критерий успеха инициативы

Инициатива считается удачной, если Android-приложение реально убирает необходимость открывать мобильный браузер для частых сценариев контроля, а затем позволяет постепенно переносить в мобильную среду ценные сложные модули без попытки одномоментно клонировать весь web UI.

## Как обновлять этот набор документов

- Этот файл обновляется при изменении продуктовых границ, платформенных допущений или screen map.
- `roadmap.md` обновляется при изменении фаз, очередности работ и exit criteria.
- `backend-contract-gap-analysis.md` обновляется всякий раз, когда меняется взгляд на mobile API contract или появляется новая фактическая backend-интеграция в Android.
- `app-skeleton.md` обновляется каждый раз, когда фактический `android-companion` получает новые работающие screen/flow slices или меняет shell-навигацию.

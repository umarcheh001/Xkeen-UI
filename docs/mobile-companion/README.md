# Xkeen-UI Mobile Companion

Status: active implementation baseline
Updated: 2026-07-13

Этот каталог фиксирует актуальное состояние Android companion-приложения для Xkeen-UI и связанные с ним продуктовые и технические решения. Документы ниже считаются living docs и должны совпадать с фактическим состоянием `android-companion/`.

## Текущий статус на 2026-07-13

Инициатива уже давно вышла из стадии "поднять проект". В репозитории есть рабочий Android-проект `android-companion/`, и локальная проверка `.\gradlew.bat testDebugUnitTest assembleDebug` снова прошла успешно `2026-07-13`.

Что это означает на практике:

- приложение уже проходит через `Launching`, `Connections`, `Pair/Login` и `Ready`-workspace;
- ready-состояние больше не соответствует раннему shell `Dashboard / Logs / More`;
- текущий рабочий shell capability-aware и использует вкладки `Xray`, `Mihomo`, `Ports`, `Shell`, `Generator`;
- наличие вкладок и drawer-разделов зависит от списка установленных ядер, который приходит из `GET /api/xkeen/core`;
- первый реальный backend slice уже подключён для чтения: `GET /api/xkeen/core`, `GET /api/routing/fragments`, `GET /api/routing?file=...`;
- самый глубокий модуль сейчас это `Routing Xray`: он уже читает реальные routing-документы и даёт локальный editor-flow поверх них;
- auth/session, secure storage, сервисные POST-действия, запись routing draft и большая часть не-Xray модулей всё ещё остаются незавершёнными.

Главный технический разрыв сейчас не в создании Android UI, а в переходе от in-memory controller к реальному transport, session model и write-safe mobile contract.
При этом базовый controller уже переведен на dependency seam через `ConnectionsPort`, `SessionPort`, `ServiceActionsPort`, `RoutingWritePort` и `LogsPort`, так что следующий шаг теперь в замене demo-адаптеров, а не в повторном переписывании UI-flow.

## Связанные документы

- [App skeleton](app-skeleton.md)
- [Roadmap](roadmap.md)
- [Backend contract gap analysis](backend-contract-gap-analysis.md)

## Назначение

Мобильная web-версия панели не дала достаточно надёжного UX для повседневного управления. Вместо дальнейших точечных правок мобильного браузерного интерфейса проект движется к отдельному Android-приложению, сфокусированному на быстрых и безопасных сценариях управления Xkeen-UI с телефона.

Companion при этом рассматривается не как урезанный "пульт навсегда", а как база для постепенного переноса в Android ценных web-модулей. Первый глубокий перенос уже начат с `Routing Xray`, дальше в приоритете остаются `Routing Mihomo`, отдельные части `Mihomo Generator`, partial `DevTools`, а затем controlled `Commands` и `Files`.

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
- Secure storage: данные подключений и токены должны храниться только в защищённом локальном хранилище Android.
- Архитектурное допущение: web endpoints остаются совместимыми для браузера, а mobile получает отдельный контракт поверх существующего service layer.

## Текущее implementation baseline

Подробный shell и визуальные правила вынесены в [app-skeleton.md](app-skeleton.md). На уровне фактического проекта сейчас важно фиксировать следующее:

- `Connections` и `Pair/Login` уже являются частью рабочего потока приложения.
- `Ready` строится вокруг единого workspace, а не вокруг старой карты `Dashboard / Logs / More`.
- Нижняя навигация использует `Xray`, `Mihomo`, `Ports`, `Shell`, `Generator` и скрывает недоступные capability slices.
- Drawer перестраивается под выбранную рабочую зону и активные ядра.
- `Routing Xray` уже читает реальные backend-документы и остаётся первым глубоким editor-like модулем.
- `Shell` содержит интерактивные demo-поверхности для команд и терминала.
- Остальные секции в основном служат placeholder-границами для следующего контракта и следующих модулей.

## V1: что именно должно уметь приложение

### Реализовано сейчас

- Ручное добавление инстанса и переход по базовому onboarding flow.
- Capability-aware workspace с безопасными действиями `start`, `stop`, `restart` через confirm state.
- Загрузка доступных ядер через `GET /api/xkeen/core`.
- Read-only загрузка Xray routing-фрагментов и содержимого документов через те же endpoint'ы, что использует веб-панель.
- Локальная валидация routing draft, полноэкранный редактор, переключение между документами и подсветка JSON/JSONC.

### Ещё не завершает MVP

- Нет реального auth/session bootstrap и secure storage.
- Нет persisted connections и устойчивого restore behavior поверх настоящего transport.
- `start`, `stop`, `restart`, переключение `Core`, `save` и `apply` пока не доходят до backend POST-endpoint'ов.
- Controller-события уже идут через `LogsPort`, но настоящего logs streaming и reconnect behavior все еще нет.
- Большая часть Mihomo, Ports и Generator поверхностей пока только обозначает следующий модульный срез.

### Post-MVP / V1.1

- Backups: просмотр списка, создание и restore с дополнительными safeguards.
- Read-only diagnostics history и operation timeline.
- Push/local notifications для деградации сервиса или завершения долгих операций.
- Более удобное обнаружение локальных инстансов.
- Read-only или compact-action срез для Mihomo profile/status workflows там, где он реально нужен на телефоне.

### Out of scope for V1

- Полный перенос всего web UI в мобильное приложение за один релиз.
- Full parity для PTY, файлового менеджера, RemoteFS и DevTools.
- Полный редактор всех Xray/Mihomo документов и генераторов без staged rollout.
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
9. Вкладка `Generator`, если Mihomo доступен

Эта карта уже отражает текущее приложение. Старое описание через `Dashboard`, `Logs` и `More` больше не является source of truth.

## Порядок расширения после текущего baseline

- `Routing Mihomo` как следующий глубокий routing-модуль.
- `Mihomo Generator` как набор отдельных card-like flows, а не полный desktop parity.
- Partial `DevTools` для diagnostic summary и targeted utilities.
- Controlled `Commands` и `Files` только после отдельной safety-модели и granular permissions.

## Критерий успеха инициативы

Инициатива считается удачной, если Android-приложение реально убирает необходимость открывать мобильный браузер для частых сценариев контроля, а затем позволяет постепенно переносить в мобильную среду ценные сложные модули без попытки одномоментно клонировать весь web UI.

## Как обновлять этот набор документов

- Этот файл обновляется при изменении продуктовых границ, платформенных допущений или screen map.
- `roadmap.md` обновляется при изменении фаз, очередности работ и exit criteria.
- `backend-contract-gap-analysis.md` обновляется всякий раз, когда меняется взгляд на mobile API contract или появляется новая фактическая backend-интеграция в Android.
- `app-skeleton.md` обновляется каждый раз, когда фактический `android-companion` получает новые работающие screen/flow slices или меняет shell-навигацию.

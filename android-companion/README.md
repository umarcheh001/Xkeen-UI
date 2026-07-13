# Xkeen Mobile Companion

Android companion-приложение для Xkeen-UI. Каталог `android-companion/` уже является рабочим implementation baseline, а не пустым skeleton: проект собирается, проходит unit tests и содержит живой Compose shell с частичной backend-интеграцией.

## Текущее состояние на 2026-07-13

- Приложение проходит через фазы `Launching`, `Connections`, `Pair/Login` и `Ready`.
- На `Launching` приложение загружает из app-private storage список узлов, их базовый metadata state и последний выбранный узел, после чего открывает `Connections`.
- `Connections` поддерживает ручное добавление инстанса по `name` и `baseUrl`, повторный выбор и безопасное редактирование уже сохраненного узла без смены его `id` и metadata.
- Сохраненный `Configured` status сам по себе не открывает `Ready`: автоматический вход появится только вместе с отдельным secure session restore.
- `Pair/Login` уже существует как экран и часть основного потока, но пока работает в demo-режиме без реального auth/session transport.
- `Ready`-состояние построено как capability-aware workspace с компактной верхней панелью, отдельной кнопкой `Core` и безопасными действиями `start`, `stop`, `restart` через confirm dialog.

## Текущая навигация

- Нижняя панель использует пользовательские вкладки `Xray`, `Mihomo`, `Ports`, `Shell`, `Generator`.
- Вкладка `Xray` показывается только при наличии Xray.
- Вкладки `Mihomo` и `Generator` показываются только при наличии Mihomo.
- `Ports` и `Shell` доступны всегда.
- Активная вкладка и набор drawer-разделов перестраиваются под состав установленных ядер.

Контекстный drawer сейчас устроен так:

- `Xray`: `Роутинг Xray`, `Подписки Xray`, `Режим Inbounds`, `Прокси / Outbounds`, `DAT-файлы GeoIP / GeoSite`, `Логи Xray`
- `Mihomo`: `Роутинг Mihomo`, `Профили и подписки`, `Прокси-провайдеры`, `Группы прокси`, `Правила Mihomo`, `Генератор Mihomo`
- `Ports`: `Порты и исключения`, `Порты Xray`, `Порты Mihomo`, `Исключения маршрутизации`
- `Shell`: `Команды`, `Терминал`, `История команд`
- `Generator`: `Генератор Mihomo`, `Профили генератора`, `Шаблоны`

По факту интерактивны уже сейчас:

- `Routing Xray`
- `Shell -> Команды`
- `Shell -> Терминал`

Остальные разделы пока отрисованы как placeholder-срезы под следующий backend contract.

## Что уже подключено к backend

- `GET /api/xkeen/core` загружает список установленных ядер и автоматически скрывает недоступные вкладки и drawer-секции.
- `GET /api/routing/fragments` загружает список Xray routing-документов.
- `GET /api/routing?file=...` загружает содержимое выбранного routing-документа.
- Эти read-only запросы уже идут через общий `CompanionHttpTransport`, поэтому `Core` и `Routing Xray` больше не держат разрозненный HTTP-код.
- Если backend вместо JSON возвращает HTML-страницу логина, приложение показывает явную ошибку transport/auth, а не пытается тихо разобрать неверный ответ.

## Архитектурный seam

- `DemoCompanionController` заменен на `CompanionController`, который зависит от `CompanionControllerDependencies`, а не от жестко пришитых demo-side effects.
- Для следующего слоя выделены отдельные порты: `ConnectionsPort`, `SessionPort`, `ServiceActionsPort`, `RoutingWritePort`, `LogsPort`; time/journal helper живет отдельно в `CompanionJournalPort`.
- `CompanionController` больше не собирает `LogEntry` вручную: запись controller-событий идет через `LogsPort`, поэтому транспорт логов и policy хранения можно будет заменить без роста reducer-логики.
- `ConnectionsPort` уже переведен на реальный app-private persistence; `SessionPort`, `ServiceActionsPort`, `RoutingWritePort` и `LogsPort` пока используют demo-адаптеры.
- Логика controller/reducer теперь тестируется отдельно от transport и storage seam.

## Локальное хранение подключений

- `PersistedConnectionsPort` хранит versioned snapshot в приватных `SharedPreferences` приложения.
- В snapshot входят только видимые данные: `id`, `name`, `baseUrl`, `status`, `lastSeen` и `selectedConnectionId`.
- Пароли, cookie, token и иной session material туда не записываются.
- Поврежденная запись пропускается при чтении, а неизвестный `selectedConnectionId` сбрасывается без падения приложения.
- Unit tests проверяют восстановление после пересоздания порта, сохранение metadata и стабильный `id` при редактировании.

## Routing Xray

- Это самый глубокий реализованный модуль в проекте.
- Редактор полноэкранный, с номерами строк и подсветкой JSON/JSONC.
- Поддерживаются `.json` и `.jsonc`, а также заголовки `x-xkeen-jsonc` и `x-xkeen-jsonc-using`.
- Длинные горизонтальные свайпы перелистывают документы; короткие движения остаются за редактированием и прокруткой.
- Панель действий включает `edit`, `validate`, `revert`, `save`, `apply`.
- `save` и `apply` уже идут через отдельный `RoutingWritePort`, но пока закрыты demo-реализацией. Реальная серверная запись еще не подключена.
- `validate` пока остается локальной проверкой редактора и еще не переведен на backend round-trip.

## Техническая база

- Android Gradle Plugin `8.8.2`
- Kotlin `2.0.21`
- `compileSdk 36`
- `targetSdk 36`
- `minSdk 28`
- Java/Kotlin target `17`
- Версия приложения `0.1.0`

## Как открыть

1. Открой каталог `android-companion/` в Android Studio.
2. Дождись Gradle sync.
3. Запусти конфигурацию `app` на эмуляторе или устройстве.

## Локальная проверка

```powershell
cd android-companion
.\gradlew.bat testDebugUnitTest assembleDebug
```

Эта команда завершилась успешно в текущем репозитории `2026-07-13`.

## Осознанно не переносим из веб-панели

- Карточка **«Сценарий маршрутизации»** остаётся только в веб-панели. В мобильном приложении для неё не планируются отдельный экран, пункт меню или отдельный API-flow.

## Что пока остаётся demo-only

- `Pair/Login` уже отделен в `SessionPort`, но сам порт пока работает через demo auth/session flow.
- Пароли, token/cookie и trusted-restore marker пока не сохраняются в secure storage; это следующий отдельный этап.
- `start`, `stop`, `restart` и переключение `Core` уже вынесены в `ServiceActionsPort`, но пока меняют только локальный state и не вызывают POST-endpoint'ы.
- `Routing Xray` читает документы с сервера, но `validate` еще локальный, а `save/apply` пока работают через demo `RoutingWritePort`, а не через backend.
- Controller-события уже проходят через `LogsPort`, но настоящего logs streaming, PTY transport, reconnect behavior и offline persistence пока нет.
- Большая часть разделов `Mihomo`, `Ports` и `Generator` пока остаётся placeholder-поверхностями.

## Следующий практический шаг

- Подключить secure storage для session material и trusted-restore marker поверх уже выделенного `SessionPort`.
- Довести `Pair/Login` до реального auth/session transport и trusted session restore.
- Заменить demo-адаптеры `ServiceActionsPort`, `RoutingWritePort` и `LogsPort` на backend-backed реализации.

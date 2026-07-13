# Xkeen Mobile Companion

Android companion-приложение для Xkeen-UI. Каталог `android-companion/` уже является рабочим implementation baseline, а не пустым skeleton: проект собирается, проходит unit tests и содержит живой Compose shell с частичной backend-интеграцией.

## Текущее состояние на 2026-07-13

- Приложение проходит через фазы `Launching`, `Connections`, `Pair/Login` и `Ready`.
- При наличии доверенного demo-подключения launch пытается восстановить его сразу и открыть рабочее пространство без повторного онбординга.
- `Connections` поддерживает ручное добавление инстанса по `name` и `baseUrl`, а также выбор уже добавленных узлов из in-memory списка.
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
- Если backend вместо JSON возвращает HTML-страницу логина, приложение показывает явную ошибку transport/auth, а не пытается тихо разобрать неверный ответ.

## Routing Xray

- Это самый глубокий реализованный модуль в проекте.
- Редактор полноэкранный, с номерами строк и подсветкой JSON/JSONC.
- Поддерживаются `.json` и `.jsonc`, а также заголовки `x-xkeen-jsonc` и `x-xkeen-jsonc-using`.
- Длинные горизонтальные свайпы перелистывают документы; короткие движения остаются за редактированием и прокруткой.
- Панель действий включает `edit`, `validate`, `revert`, `save`, `apply`.
- `validate`, `save` и `apply` пока остаются локальной/demo-логикой. Реальная серверная запись ещё не подключена.

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

- `Pair/Login` ещё не подключён к реальному auth/session слою.
- Данные подключений и секретов не сохраняются в secure storage.
- `start`, `stop`, `restart` и переключение `Core` пока меняют только локальный state и не вызывают POST-endpoint'ы.
- `Routing Xray` читает документы с сервера, но `validate`, `save`, `apply` пока не отправляют изменения обратно в backend.
- Нет настоящего logs streaming, PTY transport, reconnect behavior и offline persistence.
- Большая часть разделов `Mihomo`, `Ports` и `Generator` пока остаётся placeholder-поверхностями.

## Следующий практический шаг

- Заменить in-memory controller на реальный transport, auth/session layer и persisted connections.
- Довести `Routing Xray` от read-only интеграции до backend-backed `validate` / `save` / `apply`.
- Подключить write-safe контракты для service actions, core switch и журналов.

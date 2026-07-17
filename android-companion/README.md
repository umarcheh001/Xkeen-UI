# Xkeen Mobile Companion

Android companion-приложение для Xkeen-UI. Каталог `android-companion/` уже является рабочим implementation baseline, а не пустым skeleton: проект собирается, проходит unit tests и содержит живой Compose shell с частичной backend-интеграцией.

## Текущее состояние на 2026-07-16

- Приложение проходит через фазы `Launching`, `Connections`, `Pair/Login` и `Ready`.
- На `Launching` приложение загружает из app-private storage список узлов, их базовый metadata state и последний выбранный узел; trusted material выбранного узла проверяется server bootstrap до открытия `Ready`.
- `Connections` поддерживает ручное добавление инстанса по `name` и `baseUrl`, повторный выбор и безопасное редактирование уже сохраненного узла без смены его `id` и metadata.
- Сохраненный `Configured` status сам по себе не открывает `Ready`: marker доверенного восстановления хранится отдельно, а авторизация подтверждается backend bootstrap.
- `Pair/Login` работает через реальный `MobileSessionPort`: сначала используется `GET /api/mobile/v1/bootstrap` и `POST/DELETE /api/mobile/v1/session`. Если установленный Xkeen UI еще закрывает mobile handshake ответом старой версии, приложение автоматически и без перехода в браузер использует совместимый `/api/auth/status` + CSRF-protected `/api/auth/login` flow.
- Экран входа проверяет узел автоматически и оставляет пользователю одно основное действие: ввести данные веб-панели и нажать `Войти`. Логин и пароль расположены вертикально, пароль можно показать, а клавиша `Done` запускает вход.
- `Ready`-состояние построено как capability-aware workspace с компактной верхней панелью, отдельной кнопкой `Core` и безопасными действиями `start`, `stop`, `restart` через confirm dialog.
- `start`, `stop`, `restart` и смена `Core` выполняются реальным `WebPanelServiceActionsPort`; успех показывается только после повторного чтения runtime/core state с сервера.
- Подтверждение service/core action использует bounded polling: переходный snapshot во время перезапуска (в частности `stopped / Xray` при Mihomo → Xray) не считается немедленной ошибкой. Клиент ждёт server-confirmed целевое состояние до 15 секунд, не подменяя его локальным success.

Этапы 5 и 6 закрыты 2026-07-16; приемка зафиксирована в [stage-5-closure-checklist.md](stage-5-closure-checklist.md) и [stage-6-closure-checklist.md](stage-6-closure-checklist.md). Service/core actions теперь backend-backed и server-confirmed. Реализация и пакет этапа 7 готовы, но финальная отметка требует повторного smoke-test на узле после совместного обновления Xkeen UI и APK; детали находятся в [stage-7-closure-checklist.md](stage-7-closure-checklist.md).

Этап 8 реализован и документирован в [stage-8-closure-checklist.md](stage-8-closure-checklist.md); финальная operational отметка требует device smoke-test согласованных backend archive и APK.

Этап 9 реализован и документирован в [stage-9-closure-checklist.md](stage-9-closure-checklist.md). `Логи Xray` используют authenticated mobile history/live contract с cursor-based reconnect; финальная operational отметка требует device smoke-test согласованных backend archive и APK.

Этап 10 завершил repository hardening и automated acceptance: после login/restore workspace начинает с нейтрального состояния и принимает service/core/routing metadata только после server reads. Итоговая матрица проверок и оставшийся device rollout описаны в [stage-10-closure-checklist.md](stage-10-closure-checklist.md).

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
- `Прокси / Outbounds`
- `Shell -> Команды`
- `Shell -> Терминал`

Остальные разделы пока отрисованы как placeholder-срезы под следующий backend contract.

## Что уже подключено к backend

- `GET /api/xkeen/core` загружает список установленных ядер и автоматически скрывает недоступные вкладки и drawer-секции.
- `GET /api/routing/fragments` загружает список Xray routing-документов.
- `GET /api/mobile/v1/xray/routing/document?document=...` загружает единый server-authoritative snapshot выбранного routing-документа: published content/revision, сохранённый server draft и conflict metadata.
- `POST /api/mobile/v1/xray/routing/validate` принимает raw JSONC draft выбранного документа и запускает read-only server Xray preflight; invalid draft возвращает structured diagnostics без persistent config save, restart или DAT-asset sync side effect.
- `POST /api/mobile/v1/xray/routing/save` сохраняет проверенный draft отдельно от live Xray fragment; `POST /api/mobile/v1/xray/routing/apply` применяет exact saved revision и подтверждает restart xkeen.
- `GET /api/mobile/v1/logs` возвращает Xray `error`/`access` history и инкрементальные записи по per-source opaque cursor. Android пользуется этим контрактом для live logs, а не web WebSocket endpoint'ами.
- `POST /api/xkeen/start`, `POST /api/xkeen/stop`, `POST /api/restart` и `POST /api/xkeen/core` выполняют service/core actions; после каждого принятого POST приложение сверяет результат через `GET /api/xkeen/status` и `GET /api/xkeen/core`.
- Эти read-only запросы идут через единый `CompanionHttpTransport`: он нормализует безопасный `baseUrl`, добавляет common headers, применяет timeout и оставляет seam для session auth headers. Validate и service actions используют отдельный `90 s` transport, потому что server Xray preflight может быть долгим.
- `401`, `403`, `428`, HTML login page, offline и timeout переводятся в типизированные app-level ошибки. `Core` отражает их в dashboard, diagnostics и logs, а `Routing Xray` — в retryable load state.
- Во время core switch pending/failure показывается внутри modal без дублирующего глобального сообщения; после подтверждённого успеха modal закрывается и появляется одна непрозрачная контрастная success-карточка.

## Архитектурный seam

- `DemoCompanionController` заменен на `CompanionController`, который зависит от `CompanionControllerDependencies`, а не от жестко пришитых demo-side effects.
- Для следующего слоя выделены отдельные порты: `ConnectionsPort`, `SessionPort`, `ServiceActionsPort`, `RoutingValidationPort`, `RoutingWritePort`, `LogsPort`; time/journal helper живет отдельно в `CompanionJournalPort`.
- `CompanionController` больше не собирает `LogEntry` вручную: запись controller-событий идет через `LogsPort`, поэтому транспорт логов и policy хранения можно будет заменить без роста reducer-логики.
- `ConnectionsPort`, `SessionPort`, `ServiceActionsPort`, `RoutingValidationPort`, `RoutingWritePort` и `LogsTransportPort` имеют production implementations. `LogsPort` сохраняет только локальную policy controller-событий.
- Логика controller/reducer теперь тестируется отдельно от transport и storage seam.

## Локальное хранение подключений

- `PersistedConnectionsPort` хранит versioned snapshot в приватных `SharedPreferences` приложения.
- В snapshot входят только видимые данные: `id`, `name`, `baseUrl`, `status`, `lastSeen` и `selectedConnectionId`.
- Пароли, cookie, token и иной session material туда не записываются.
- Поврежденная запись пропускается при чтении, а неизвестный `selectedConnectionId` сбрасывается без падения приложения.
- Unit tests проверяют восстановление после пересоздания порта, сохранение metadata и стабильный `id` при редактировании.

## Защищенный session material

- `SessionMaterial` хранит только access/refresh token, cookie header и CSRF token; пароль и видимые поля `Connection` в него не входят.
- Для каждого `connectionId` `SessionMaterialStore` хранит отдельную запись и явно отличает ее от записи, разрешенной для восстановления, через `trustedForRestore` / `loadTrusted()`.
- Android-реализация шифрует единый payload AES-GCM; неэкспортируемый ключ создается в Android Keystore. В app-private `SharedPreferences` попадает только ciphertext, а не raw token/cookie/CSRF.
- Поврежденный ciphertext или недоступный ключ очищают unusable payload. Backup выключен через `android:allowBackup="false"`.
- Пароль не записывается в storage и после успешного входа очищается из UI-state. Logout очищает material только активного узла.
- Текущий demo flow сохраняет лишь случайный синтетический secret с `trustedForRestore = false`, поэтому он не может превратиться в автоматическую авторизацию.

### Политика automatic restore

Приложение пытается восстановить только `loadTrusted()`-record выбранного узла и подтверждает его на backend. Повторный вход требуется при отсутствии marker, поврежденном payload/сбросе Keystore, а также при истекшей или отозванной серверной сессии. Само наличие сохраненного подключения или статуса `Configured` не является доверенной сессией.

## Routing Xray

- Это самый глубокий реализованный модуль в проекте.
- Редактор полноэкранный и рассчитан на большие routing-файлы: нативная Android text surface, виртуализированные номера строк, инерционный вертикальный скроллинг и перетаскиваемый быстрый скроллбар.
- Двойной тап выделяет слово, длинный тап открывает системные действия `вырезать / копировать / вставить / выделить всё`; дополнительное меню содержит undo/redo, выделение и дублирование строки, переход к строке.
- Длинные строки мягко переносятся по ширине экрана без горизонтального скроллинга; продолжения не получают ложных номеров строк. Компактный gutter и tab stop оставляют больше ширины коду, а статус показывает число символов, слов, строк и позицию курсора.
- Подсветка JSON/JSONC сохраняет прежнюю цветовую схему; в больших документах она ограничивается видимой областью с буфером, чтобы скроллинг не зависел от количества строк.
- Поддерживаются `.json` и `.jsonc`, а также заголовки `x-xkeen-jsonc` и `x-xkeen-jsonc-using`.
- Панель действий включает `edit`, `validate`, `revert`, `save`, `apply`.
- `validate` делает реальный authenticated/CSRF backend round-trip через `POST /api/mobile/v1/xray/routing/validate`. Backend запускает Xray preflight только во temporary confdir: routing-файл и DAT symlink assets не меняются, сервис не перезапускается.
- Validate endpoint добавлен одновременно в backend и Android-клиент, поэтому один новый APK недостаточен: на роутере должен быть установлен актуальный `xkeen-ui-routing.tar.gz`. Старый backend отвечает `404`; приложение показывает для этого отдельный код `validation_endpoint_unavailable` и инструкцию обновить Xkeen UI.
- Локальный JSONC syntax feedback, server Xray diagnostics и transport error хранятся отдельно. Diagnostics содержат source/severity/code/message и при наличии line/column/path/hint; active editor показывает их под текстом.
- Во время проверки виден `Validating`, повторный tap заблокирован, а поздний ответ не может примениться к измененному или переключенному документу. `401` очищает session material выбранного узла и возвращает к `Pair/Login`.
- `save` и `apply` используют production `WebPanelRoutingWritePort`. Оба запроса передают ожидаемые SHA-256 tokens для published и saved revision; внешний edit, stale draft и saved/published mismatch получают HTTP `409`, отдельный `Conflict` UI state и актуальный server snapshot.
- `save` выполняет server preflight, но хранит draft в app-private backend state без изменения live fragment и без restart. `apply` повторяет preflight, создаёт backup snapshots, атомарно пишет clean JSON + JSONC sidecar и считается успешным только после restart confirmation; при failed restart backend восстанавливает прежние файлы.
- После `save/apply` published/saved content, revision и timestamps принимаются только из backend response. Локальные изменения, сделанные пока запрос был in flight, не теряются и снова требуют validate.

## Техническая база

- Android Gradle Plugin `8.8.2`
- Kotlin `2.0.21`
- `compileSdk 36`
- `targetSdk 36`
- `minSdk 28`
- Java/Kotlin target `17`
- Версия приложения `0.2.1`

## Прокси / Outbounds

- Мобильный экран поддерживает создание proxy-пула из готовых одиночных `vless://`, `trojan://`, `vmess://`, `ss://` и `hy2://`-ссылок.
- Ввод принимает форматы `url`, `tag | url` и `tag = url`. Каждая строка локально проходит preview и normalize до отправки на сервер; чувствительные данные не сохраняются на устройстве.
- Сохранение использует серверный safe flow с backup и атомарной записью. По умолчанию новые tag добавляются или обновляются; полная замена текущего пула требует отдельного явного переключателя и подтверждения.
- Подписки и автоматическая генерация пула остаются отдельным последующим этапом.

## Как открыть

1. Открой каталог `android-companion/` в Android Studio.
2. Дождись Gradle sync.
3. Запусти конфигурацию `app` на эмуляторе или устройстве.

## Локальная проверка

```powershell
cd android-companion
.\gradlew.bat testDebugUnitTest assembleDebug
```

Эта команда завершилась успешно в текущем репозитории `2026-07-16`.

## Осознанно не переносим из веб-панели

- Карточка **«Сценарий маршрутизации»** остаётся только в веб-панели. В мобильном приложении для неё не планируются отдельный экран, пункт меню или отдельный API-flow.
- Веб-мини-генератор, который пошагово собирает proxy-ссылку из отдельных параметров и подсказок, в Android не переносится. Мобильный workflow принимает только готовые одиночные proxy-ссылки и формирует из них пул.

## За границами закрытого блока

- `Routing Xray` полностью backend-backed для `load/validate/save/apply`; для device rollout одновременно нужны актуальный backend archive и APK.
- Реальный Xray logs history/live transport и reconnect behavior уже подключены. PTY transport и durable offline persistence логов пока не входят в scope.
- Большая часть разделов `Mihomo`, `Ports` и `Generator` пока остаётся placeholder-поверхностями.

## После текущего блока

- На согласованных backend archive и APK пройти device acceptance из [stage-10-closure-checklist.md](stage-10-closure-checklist.md).
- Следующий новый product slice после acceptance: controlled PTY/terminal transport или отдельный Mihomo workflow — оба требуют отдельного mobile contract и safety scope.

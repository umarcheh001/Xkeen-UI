# Xkeen Mobile Companion

Android companion-приложение для Xkeen-UI. Каталог `android-companion/` уже является рабочим implementation baseline, а не пустым skeleton: проект собирается, проходит unit tests и содержит живой Compose shell с частичной backend-интеграцией.

## Текущее состояние на 2026-07-22

- Приложение проходит через фазы `Launching`, `Connections`, `Pair/Login` и `Ready`.
- На `Launching` приложение загружает из app-private storage список узлов, их базовый metadata state и последний выбранный узел; trusted material выбранного узла проверяется server bootstrap до открытия `Ready`.
- `Connections` поддерживает ручное добавление инстанса по `name` и `baseUrl`, повторный выбор и безопасное редактирование уже сохраненного узла без смены его `id` и metadata.
- Сохраненный `Configured` status сам по себе не открывает `Ready`: marker доверенного восстановления хранится отдельно, а авторизация подтверждается backend bootstrap.
- `Pair/Login` работает через реальный `MobileSessionPort`: сначала используется `GET /api/mobile/v1/bootstrap` и `POST/DELETE /api/mobile/v1/session`. Если установленный Xkeen UI еще закрывает mobile handshake ответом старой версии, приложение автоматически и без перехода в браузер использует совместимый `/api/auth/status` + CSRF-protected `/api/auth/login` flow.
- При удалённом доступе через защищённый KeenDNS-прокси transport отличает Digest challenge Keenetic от `401` Xkeen UI. Экран последовательно запрашивает учётную запись Keenetic, продолжает исходный API-запрос с Digest authorization и только затем показывает отдельный вход Xkeen UI.
- Экран входа проверяет узел автоматически. Локальный сценарий сразу показывает Xkeen UI; удалённый — только необходимые этапы `Keenetic → Xkeen UI`. Логин и пароль расположены вертикально, пароль можно показать, а клавиша `Done` запускает текущий этап.
- `Ready`-состояние построено как capability-aware workspace с компактной верхней панелью, отдельной кнопкой `Core` и безопасными действиями `start`, `stop`, `restart` через confirm dialog.
- `start`, `stop`, `restart` и смена `Core` выполняются реальным `WebPanelServiceActionsPort`; успех показывается только после повторного чтения runtime/core state с сервера.
- Подтверждение service/core action использует bounded polling: переходный snapshot во время перезапуска (в частности `stopped / Xray` при Mihomo → Xray) не считается немедленной ошибкой. Клиент ждёт server-confirmed целевое состояние до 15 секунд, не подменяя его локальным success.

Этапы 5 и 6 закрыты 2026-07-16; приемка зафиксирована в [stage-5-closure-checklist.md](stage-5-closure-checklist.md) и [stage-6-closure-checklist.md](stage-6-closure-checklist.md). Service/core actions теперь backend-backed и server-confirmed. Реализация и пакет этапа 7 готовы, но финальная отметка требует повторного smoke-test на узле после совместного обновления Xkeen UI и APK; детали находятся в [stage-7-closure-checklist.md](stage-7-closure-checklist.md).

Этап 8 реализован и документирован в [stage-8-closure-checklist.md](stage-8-closure-checklist.md); финальная operational отметка требует device smoke-test согласованных backend archive и APK.

Этап 9 реализован и документирован в [stage-9-closure-checklist.md](stage-9-closure-checklist.md). `Логи Xray` используют authenticated mobile history/live contract с cursor-based reconnect; финальная operational отметка требует device smoke-test согласованных backend archive и APK.

Этап 10 завершил repository hardening и automated acceptance: после login/restore workspace начинает с нейтрального состояния и принимает service/core/routing metadata только после server reads. Итоговая матрица проверок и оставшийся device rollout описаны в [stage-10-closure-checklist.md](stage-10-closure-checklist.md).

## Текущая навигация

- Нижняя панель использует пользовательские вкладки `Xray`, `Mihomo`, `Ports`, `Shell`.
- Вкладка `Xray` показывается только при наличии Xray.
- Вкладка `Mihomo` показывается только при наличии Mihomo.
- `Ports` и `Shell` доступны всегда.
- Активная вкладка и набор drawer-разделов перестраиваются под состав установленных ядер.

Контекстный drawer сейчас устроен так:

- `Xray`: `Роутинг Xray`, `Подписки Xray`, `Режим Inbounds`, `Прокси / Outbounds`, `DAT-файлы GeoIP / GeoSite`, `Логи Xray`
- `Mihomo`: `Роутинг Mihomo`, `Шаблоны`, `Узел`, `HWID`, `Zashboard UI`
- `Ports`: `Порты и исключения`
- `Shell`: `Журнал`, `Терминал`

По факту интерактивны уже сейчас:

- `Routing Xray`
- `Роутинг Mihomo`
- `Шаблоны Mihomo`
- `Zashboard UI` (системный браузер)
- `Подписки Xray`
- `Прокси / Outbounds`
- `DAT-файлы GeoIP / GeoSite`
- `Логи Xray`
- `Shell -> Журнал`
- `Shell -> Терминал`

Остальные разделы пока отрисованы как placeholder-срезы под следующий backend contract.

## Что уже подключено к backend

- `GET /api/xkeen/core` загружает список установленных ядер и автоматически скрывает недоступные вкладки и drawer-секции.
- `GET /api/routing/fragments` загружает список Xray routing-документов.
- `GET /api/mobile/v1/xray/routing/document?document=...` загружает единый server-authoritative snapshot выбранного routing-документа: published content/revision, сохранённый server draft и conflict metadata.
- `POST /api/mobile/v1/xray/routing/validate` принимает raw JSONC draft выбранного документа и запускает read-only server Xray preflight; invalid draft возвращает structured diagnostics без persistent config save, restart или DAT-asset sync side effect.
- `POST /api/mobile/v1/xray/routing/save` сохраняет проверенный draft отдельно от live Xray fragment; `POST /api/mobile/v1/xray/routing/apply` применяет exact saved revision и подтверждает restart xkeen.
- `GET /api/mihomo-config`, `POST /api/mihomo/validate_raw`, `POST /api/mihomo/save_raw` и `POST /api/mihomo/restart_raw` образуют YAML workflow активного профиля Mihomo. Непроверенный или изменённый после проверки текст нельзя сохранить; restart требует отдельного подтверждения.
- `GET /api/mihomo-templates` и `GET /api/mihomo-template` загружают список YAML-шаблонов и показывают preview. Загрузка шаблона меняет только мобильный draft; серверный `config.yaml` меняется лишь через обычный validate/save workflow.
- `POST /api/ws-token` выдаёт одноразовый токен с областью `pty`, после чего локальная xterm.js-поверхность подключается к `/ws/pty`. PTY session id сохраняется отдельно для каждого узла; новый экран заново получает buffered output, а reconnect той же поверхности продолжает replay с последнего показанного sequence.
- `GET/POST /api/xray/subscriptions` загружает список подписок Xray и сохраняет новую или изменённую запись; `POST /api/xray/subscriptions/preview` получает серверный preview узлов без сохранения, записи fragment, изменения routing/observatory или restart.
- `POST /api/xray/subscriptions/<id>/refresh` и `POST /api/xray/subscriptions/refresh-due` явно обновляют одну подписку или только просроченные; `DELETE /api/xray/subscriptions/<id>` удаляет managed fragment и безопасно пересобирает связанный runtime state.
- `POST /api/xray/subscriptions/<id>/nodes/ping` проверяет отдельный узел подписки. Параметры restart и удаления managed-файла передаются явно, а разрушительные действия подтверждаются в приложении.
- `GET /api/fs/list`, `GET /api/routing/dat/tags`, `GET /api/routing/dat/tag`, `GET /api/routing/dat/search` и `POST /api/routing/dat/lookup` образуют read-only мобильный DAT Explorer. Он автоматически находит GeoIP / GeoSite файлы, показывает теги, страницы элементов и серверный поиск, но не обновляет файлы и не меняет routing.
- `GET /api/mobile/v1/logs` возвращает Xray `error`/`access` history и инкрементальные записи по per-source opaque cursor. Android пользуется этим контрактом для live logs, а не web WebSocket endpoint'ами.
- Нативный просмотрщик логов разделяет `access.log` и `error.log`, фильтрует уровни, поддерживает локальный текстовый/RE2 Regex-поиск, паузу, follow-tail, ограниченное копирование и компактный раскрываемый список. Polling работает только пока открыт раздел логов; история и cursor сохраняются при уходе с экрана.
- `POST /api/xkeen/start`, `POST /api/xkeen/stop`, `POST /api/restart` и `POST /api/xkeen/core` выполняют service/core actions; после каждого принятого POST приложение сверяет результат через `GET /api/xkeen/status` и `GET /api/xkeen/core`.
- Эти read-only запросы идут через единый `CompanionHttpTransport`: он нормализует безопасный `baseUrl`, добавляет common headers, применяет timeout и оставляет seam для session auth headers. Validate и service actions используют отдельный `90 s` transport, потому что server Xray preflight может быть долгим.
- Keenetic Digest challenge, `401`, `403`, `428`, HTML login page, offline и timeout переводятся в отдельные типизированные app-level состояния. `Core` отражает их в dashboard, diagnostics и logs, а `Routing Xray` — в retryable load state.
- Во время core switch pending/failure показывается внутри modal без дублирующего глобального сообщения; после подтверждённого успеха modal закрывается и появляется одна непрозрачная контрастная success-карточка.

## Архитектурный seam

- `DemoCompanionController` заменен на `CompanionController`, который зависит от `CompanionControllerDependencies`, а не от жестко пришитых demo-side effects.
- Для backend-слоя выделены отдельные порты, включая `ConnectionsPort`, `SessionPort`, `ServiceActionsPort`, `RoutingValidationPort`, `RoutingWritePort`, `MihomoConfigPort`, `TerminalPort` и `LogsPort`; time/journal helper живет отдельно в `CompanionJournalPort`.
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
- Учётные данные Keenetic также не сохраняются: они существуют только в памяти процесса для повторной Digest-авторизации удалённых API-запросов. После перезапуска приложения защищённый KeenDNS-узел попросит вход Keenetic снова, не удаляя доверенную сессию Xkeen UI.
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

## Роутинг Mihomo

- Активный `config.yaml` редактируется той же нативной Android text surface, что и JSONC: номера строк, быстрый скролл, поиск, переход к строке, системное выделение и работа с большими файлами сохранены.
- YAML имеет отдельную подсветку ключей, строк, чисел, boolean/null, anchors/tags и комментариев. Локальная подсветка не считается валидатором: авторитетный результат приходит только от `mihomo -t` на сервере.
- Отдельной команды форматирования YAML в мобильном редакторе пока нет.
- Рабочий цикл разделён на `загрузить → изменить → проверить → сохранить` или `применить`. Любое изменение текста сбрасывает подтверждение проверки; `Применить` дополнительно подтверждает restart.
- Полная оболочка Acode не встроена. Не переносятся Cordova/plugin runtime, файловый менеджер, marketplace, LSP и общий IDE shell.

## Шаблоны и Zashboard UI

- Раздел `Шаблоны` показывает YAML-файлы из `/opt/etc/mihomo/templates`, загружает выбранный шаблон в прокручиваемый preview и передаёт его в редактор `config.yaml` только после подтверждения. Preview можно закрыть без изменения редактора.
- Создание, переименование и удаление шаблонов не добавлены в мобильный экран: актуальная веб-поверхность предоставляет выбор существующего шаблона, а backend не имеет delete endpoint.
- Пункт `Zashboard UI` не создаёт внутренний WebView: он открывает системный браузер напрямую на Mihomo-порту `http://<адрес Xkeen-узла>:9090/ui` (для стандартного адреса роутера — `http://192.168.1.1:9090/ui`).

## Терминал

- Экран `Shell → Терминал` использует локально упакованный xterm.js только как VT/ANSI renderer и input surface; команды выполняются на подключённом Xkeen-узле через существующий server PTY.
- Поддерживаются resize, scrollback, поиск, очистка экрана, `Ctrl+C`, новая сессия, bounded reconnect и replay по sequence без Termux/AXS на телефоне.
- Панель действий и строка быстрых клавиш используют те же компактные размеры, что и редактор Xray; renderer стартует только после появления ненулевого размера WebView.
- Одноразовый WS token запрашивается через тот же authenticated/CSRF transport, что и остальные действия. WebView никогда не загружает удалённую HTML-страницу и не получает session cookie/token Xkeen UI.
- Использованные xterm.js assets и граница заимствования описаны в [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

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

## Подписки Xray

- Мобильный экран служит компактной оперативной поверхностью: показывает список и состояние подписок, позволяет создать или изменить источник, выполнить preview, обновить одну подписку или все просроченные, проверить узел и удалить подписку с подтверждением.
- Поддерживаются HTTP(S)-источники с share-ссылками, base64 payload и Xray JSON outbounds. Preview выполняется на сервере без сохранения подписки, изменения конфигурации или restart.
- Сохранение и генерация разделены: сначала сохраняется запись подписки, а managed fragment `04_outbounds.<tag>.json` создаётся только при явном обновлении либо по расписанию. Интервал по умолчанию — `24` часа; рекомендация провайдера показывается отдельно и не заменяет выбранное значение.
- Generated fragment управляется backend и будет пересобран при следующем refresh. Удаление может удалить fragment и пересобрать routing/observatory, поэтому приложение всегда запрашивает подтверждение.
- Ссылка подписки остаётся только в оперативном состоянии экрана и backend-запросе: приложение не сохраняет её в локальном storage и не выводит целиком в журнал.

### Мобильная граница

- Android не повторяет desktop-модальное окно и его постоянные справочные блоки. На экране остаются короткие подписи, компактные карточки и основные безопасные действия.
- Краткие пояснения к интервалу, generated fragment, ping и влиянию удаления открываются через кнопки справки во всплывающем окне.
- Подробная диагностика refresh, большой обзор состава fragment и редкие экспертные настройки routing/balancers остаются в веб-панели. Полная справка по workflow подписок находится в корневом `README.md` проекта.

## DAT Explorer GeoIP / GeoSite

- Раздел построен как компактный мобильный просмотрщик: выбор `GeoSite` / `GeoIP`, обнаруженного DAT-файла, фильтр тегов и отдельный экран содержимого выбранного тега.
- Поиск значения проверяет домен или IP сразу по тегам выбранного файла. Внутри тега доступен серверный поиск по всему содержимому, постраничный просмотр и быстрый фильтр IPv4 / IPv6 для GeoIP.
- Android намеренно не переносит веб-карточку управления DAT: здесь нет URL, upload/download, установки `xk-geodat`, обновления файла и вставки selector в routing. Если `xk-geodat` отсутствует, приложение показывает короткую инструкцию выполнить установку в веб-панели.

## Как открыть

1. Открой каталог `android-companion/` в Android Studio.
2. Дождись Gradle sync.
3. Запусти конфигурацию `app` на эмуляторе или устройстве.

## Локальная проверка

```powershell
cd android-companion
.\gradlew.bat testDebugUnitTest assembleDebug
```

Эта команда завершилась успешно в текущем репозитории `2026-07-20`.

## Осознанно не переносим из веб-панели

- Карточка **«Сценарий маршрутизации»** остаётся только в веб-панели. В мобильном приложении для неё не планируются отдельный экран, пункт меню или отдельный API-flow.
- **Mihomo Generator** остаётся только в веб-панели: отдельная вкладка и все мобильные placeholder-разделы генератора удалены.
- Профили, подписки и бэкапы Mihomo остаются в веб-панели. Отдельные мобильные разделы для proxy-providers, групп прокси и правил также не планируются: при необходимости они редактируются в общем YAML.
- Веб-мини-генератор, который пошагово собирает proxy-ссылку из отдельных параметров и подсказок, в Android не переносится. Мобильный workflow принимает только готовые одиночные proxy-ссылки и формирует из них пул.

## За границами закрытого блока

- `Routing Xray` полностью backend-backed для `load/validate/save/apply`; для device rollout одновременно нужны актуальный backend archive и APK.
- Реальный Xray logs history/live transport и reconnect behavior уже подключены. PTY transport также подключён; durable offline persistence логов по-прежнему не входит в scope.
- `Роутинг Mihomo` и `Шаблоны` backend-backed, а `Zashboard UI` работает как внешнее браузерное действие. Из разделов Mihomo заглушками пока остаются только `Узел` и `HWID`.

## После текущего блока

- На согласованных backend archive и APK пройти device acceptance из [stage-10-closure-checklist.md](stage-10-closure-checklist.md).
- Следующий product slice после acceptance: один из точечных Mihomo-инструментов либо общий файловый workflow для ограниченного набора конфигураций.

# Xkeen-UI Mobile Companion App Skeleton

Status: implementation baseline active
Updated: 2026-07-16

## Зачем нужен этот документ

Этот файл фиксирует фактический shell Android-приложения: какие состояния и поверхности уже существуют, как сейчас устроена навигация, и где проходит граница между рабочими backend-чтениями и demo-only поведением.

## Текущий статус реализации

`android-companion/` уже является работающим Android Studio / Gradle проектом. Локальная проверка `.\gradlew.bat testDebugUnitTest assembleDebug` снова прошла успешно `2026-07-16`.

Что реально реализовано в baseline:

- `Launching` с загрузкой persisted списка подключений и последнего выбранного узла;
- `Connections` с ручным добавлением, повторным выбором и редактированием инстанса по `name` и `baseUrl`;
- `Pair/Login` как отдельная фаза приложения;
- Реальный alpha session flow: `/api/mobile/v1/bootstrap`, login/logout, Keystore-only cookie+CSRF storage, server-validated restore в `Ready` и explicit fallback в `Pair/Login` для отсутствующей, истекшей или невалидной сессии;
- `Ready`-workspace с компактной верхней панелью, confirm-based server-backed `start` / `stop` / `restart` и кнопкой `Core`;
- capability-aware нижняя навигация `Xray`, `Mihomo`, `Ports`, `Shell`, `Generator`;
- capability-aware drawer с разделами под каждую рабочую зону;
- read-only интеграция `GET /api/xkeen/core`;
- read-only список `GET /api/routing/fragments` и revision-aware document snapshot `GET /api/mobile/v1/xray/routing/document`;
- полноэкранный `Routing Xray` editor-flow с JSON/JSONC подсветкой, номерами строк, свайпами между документами и real server-backed `validate/save/apply`;
- интерактивные demo-поверхности `Shell -> Команды` и `Shell -> Терминал`.

Что пока сознательно не завершено:

- PTY transport и durable offline persistence логов;
- большая часть Mihomo, Ports и Generator модулей.

## Визуальное направление

Приложение не копирует web-панель 1:1. Ориентиром остаётся плотный Android-native ритм: компактные списки, короткие подписи, явные иконки действий и минимум декоративной пустоты.

### Обязательные UI-правила

- Не использовать растянутые pill-кнопки на всю ширину, если действие можно показать компактнее.
- Не строить экран вокруг больших пустых зон и декоративных растяжек между блоками.
- Основные действия показывать через маленькие кнопки, icon buttons и короткие подписи.
- Secondary text держать коротким: состояние, активный файл, источник, последнее событие.
- Для статусов использовать короткие chips и локальные status blocks, а не длинные web-tabs.
- Вместо desktop split-pane использовать один столбец, локальные панели действий, drawer и modal surfaces.
- Любой экран должен оставаться аккуратным на обычной ширине Android-телефона без ощущения "растянутого сайта".

## Актуальный shell приложения

Текущий shell больше не описывается старой схемой `Home / Routing / Logs / More`. Фактическая карта такова:

1. `Launching`
2. `Connections`
3. `Pair/Login`
4. `Ready`

Внутри `Ready` используется одна рабочая оболочка с capability-aware вкладками:

- `Xray`, если доступен Xray
- `Mihomo`, если доступен Mihomo
- `Ports`, всегда
- `Shell`, всегда
- `Generator`, если доступен Mihomo

Контекстный drawer сейчас раскладывается так:

- `Xray`: `Роутинг Xray`, `Подписки Xray`, `Режим Inbounds`, `Прокси / Outbounds`, `DAT-файлы GeoIP / GeoSite`, `Логи Xray`
- `Mihomo`: `Роутинг Mihomo`, `Профили и подписки`, `Прокси-провайдеры`, `Группы прокси`, `Правила Mihomo`, `Генератор Mihomo`
- `Ports`: `Порты и исключения`, `Порты Xray`, `Порты Mihomo`, `Исключения маршрутизации`
- `Shell`: `Команды`, `Терминал`, `История команд`
- `Generator`: `Генератор Mihomo`, `Профили генератора`, `Шаблоны`

Подключения и авторизация по-прежнему живут как отдельный onboarding до входа в `Ready`.

## Главные пользовательские сценарии

### 1. Connections / Pairing

- Добавление инстанса вручную.
- Загрузка списка, metadata и последнего выбранного узла из app-private storage после cold start.
- Выбор и редактирование уже добавленного узла со стабильным `id`.
- Переход в `Pair/Login`.
- Понятная граница между persisted видимыми данными и готовыми Keystore-only cookie/CSRF session material.
- Сохраненный `Configured` status не дает автоматический вход: trusted record подтверждается серверным bootstrap; отсутствие, повреждение, expiry или server-invalid session material явно возвращают в `Pair/Login`.

### 2. Ready workspace

- Компактная верхняя панель с активным подключением и выбранным core.
- Безопасные действия `start`, `stop`, `restart` через confirm dialog.
- Выбор core через отдельный диалог.
- Перестройка вкладок и drawer в зависимости от доступных ядер.

### 3. Routing Xray

Это первый глубокий модуль приложения и текущий главный editor-like slice.

Что уже работает:

- загрузка списка routing-документов;
- загрузка удалённого содержимого выбранного документа;
- JSON/JSONC подсветка и номера строк;
- длинные горизонтальные свайпы между документами;
- `POST /api/mobile/v1/xray/routing/validate` с real temporary-confdir Xray preflight без persistent save/restart/DAT-asset-sync side effect;
- отдельные local syntax, server и transport diagnostics с source/severity/code/location metadata;
- `Validating`, repeat guard и защита от позднего результата для измененного draft;
- отдельный server draft, SHA-256 published/saved revisions и backend-backed `save/apply`;
- отдельный conflict state для external update, stale draft и saved/published mismatch;
- действия `edit`, `validate`, `revert`, `save`, `apply`;

Что ещё не подключено:

- серверный preview/diff;
- device rollout/smoke-test согласованной пары backend + APK для write/conflict flow.

### 4. Shell

- `Команды` и `Терминал` уже интерактивны как demo-поверхности.
- Они помогают проверить плотность и ритм будущих command-like сценариев.
- Это ещё не полноценный PTY contract и не production-ready shell transport.

### 5. Mihomo / Ports / Generator

- Эти зоны уже присутствуют в навигации как capability-aware slices.
- Сейчас они в основном выступают как placeholder-контракт для следующих модулей.
- Их наличие важно, потому что архитектура уже тестирует не один экран, а расширяемый workspace под разные ядра и сценарии.

## Базовые состояния приложения

- `launching`
- `connections`
- `pair/login`
- `ready`
- `pending action confirm`
- `routing loading`
- `routing validating`
- `routing validation failed`
- `transport/auth error`

Состояния должны оставаться короткими и локальными. Мы избегаем длинных web-style banners там, где достаточно компактного status block или отдельного placeholder-экрана.

## Первый практический deliverable

Текущий baseline уже закрыл первый полезный deliverable на уровне shell и поведения:

- onboarding через `Connections` и `Pair/Login`;
- ready-workspace с capability-aware навигацией;
- server-confirmed safe actions `start` / `stop` / `restart`;
- первый реальный backend read-slice для ядер и `Routing Xray`;
- первый editor-like модуль с server-backed Xray validate, structured diagnostics и управлением draft state;
- persisted connections с повторным выбором и безопасным редактированием.

Routing write/conflict и real Xray logs transport уже закрыты. Следующий рубеж — финальная приемка текущего блока и отдельный PTY/terminal transport.

Если этот набор не работает удобно с телефона, остальные advanced-модули переносить рано.

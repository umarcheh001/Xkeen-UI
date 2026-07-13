# Xkeen-UI Mobile Companion Roadmap

Status: phase 2 active
Updated: 2026-07-13

Даты намеренно не проставлены. Сначала нам нужно закрыть product scope, security assumptions и backend contract, а уже потом оценивать сроки.

## Текущее состояние на 2026-07-13

- `Phase 0` по сути закрыла стартовую документацию, screen map и compact-mobile guardrails.
- `Phase 2` идет фактически: в репозитории есть `android-companion/` с рабочим Compose baseline и экранным циклом `Launching -> Connections -> Pair/Login -> Ready`.
- Android-клиент подтвержденно собирается командой `.\gradlew.bat testDebugUnitTest assembleDebug`.
- В `Ready` workspace уже есть capability-aware нижняя навигация `Xray`, `Mihomo`, `Ports`, `Shell`, `Generator` и контекстные drawer-разделы.
- Уже подключены первые read-only backend flows: `GET /api/xkeen/core`, `GET /api/routing/fragments`, `GET /api/routing?file=...`.
- Уже подключен app-private persistence списка узлов, базового metadata и последнего выбранного подключения; cold start больше не зависит от demo-списка.
- Следующий главный узкий участок остается на стыке `Phase 1` и `Phase 2`: mobile contract, auth/session, secure storage, backend-backed write/apply actions и реальный logs/terminal transport.

## Phase 0 - Discovery and scope freeze

### Цель

Согласовать, что именно мы строим в первой версии, какие сценарии покрываем, и какой security/transport baseline считаем приемлемым.

### Работы

- Зафиксировать North Star, MVP scope и out-of-scope.
- Подтвердить Android-first направление и базовый tech stack.
- Зафиксировать стартовый app shell и визуальные правила для compact Android UI.
- Разобрать текущий backend surface и выделить mobile-specific contract.
- Выбрать направление auth/pairing.
- Согласовать список high-risk actions, требующих дополнительных подтверждений.
- Утвердить порядок переноса сложных модулей: сначала `Routing Xray`, затем `Routing Mihomo`, `Mihomo Generator`, partial `DevTools`, `Commands`, `Files`.
- Провести первичный аудит community/open-source библиотек и зафиксировать license/security критерии.
- Зафиксировать acceptance criteria для V1.

### Exit criteria

- Эта документация утверждена как source of truth для реализации.
- Есть список MVP user flows.
- Есть решение по mobile auth strategy или как минимум утвержденный alpha fallback.
- Есть backlog Phase 1 по backend mobile foundation.

## Phase 1 - Backend mobile foundation

### Цель

Подготовить backend так, чтобы Android-клиент опирался на компактный, предсказуемый и versioned контракт, а не на произвольный набор browser-oriented endpoints.

### Работы

- Ввести namespace уровня `/api/mobile/v1/*`.
- Добавить bootstrap endpoint со state сводкой: auth/setup, version, capabilities, instance metadata.
- Добавить ready-workspace summary endpoint для агрегированной сводки статусов и quick actions.
- Нормализовать error model и response envelopes для mobile contract.
- Определить модель long-running operations и status polling.
- Определить streaming contract для логов и live events.
- Заложить capability/permission model для будущих editor/devtools/terminal/files surfaces.
- Выделить паттерны `validate`, `preview`, `apply`, `draft`, `operation_id` для editor-like сценариев.
- Добавить contract tests для mobile endpoints.

### Exit criteria

- Android-клиент может получать bootstrap и ready-workspace summary без знания внутренней структуры web API.
- Все mobile endpoints имеют стабильную схему ответов.
- Есть тесты на compat для базовых сценариев.
- Web UI не ломается и не зависит от mobile contract.

## Phase 2 - Android app foundation

### Цель

Собрать базовый Android shell, чтобы мы могли подключаться к dev instance, проходить auth flow и держать жизнеспособное состояние приложения.

### Работы

- Уже сделано: создан Android-проект и базовая Compose app architecture.
- Уже сделано: добавлены navigation shell и минимальная design system основа.
- Уже сделано: зафиксированы компактные UI-паттерны: icon buttons, короткие labels, плотные списки, отсутствие растянутых pill-кнопок.
- Уже сделано: добавлен connection setup screen с ручным добавлением инстанса.
- Уже сделано: подготовлены базовые loading/state surfaces, lifecycle `Launching -> Connections -> Pair/Login -> Ready` и capability-aware shell.
- Уже сделано: в `Ready` используются нижние вкладки `Xray`, `Mihomo`, `Ports`, `Shell`, `Generator`, а содержимое drawer зависит от доступных core/capabilities.
- Уже сделано: заложена pluggable-структура под дальнейшие module slices, включая рабочий `Routing Xray` read/edit baseline и demo shell surfaces.
- Уже сделано: подключены первые backend reads для active core и Xray routing documents.
- Уже сделано: реализовано локальное хранение списка подключений, последнего выбора и базового metadata с безопасным редактированием.
- Еще осталось: реализовать secure storage для session material и trusted-restore marker.
- Еще осталось: реализовать network client, auth/session layer и reconnect behavior.
- Еще осталось: довести backend-backed `save/apply/service actions`, logs transport и terminal transport.
- Еще осталось: проверить подход к оберткам над open-source editor/log/terminal компонентами без ранней жесткой привязки.

### Exit criteria

- Приложение собирается и запускается на целевых Android-устройствах.
- Можно добавить Xkeen-UI инстанс и дойти до состояния `Ready` без браузерного fallback.
- Сессия и данные подключения переживают перезапуск приложения корректно.
- Базовые состояния UI выглядят предсказуемо и не требуют web fallback.

Первый критерий, persistence данных подключения и часть второго уже закрыты; phase нельзя считать завершенной до появления secure session/network слоев и backend-backed write/stream flows.

## Phase 3 - MVP feature slices

### Цель

Закрыть минимальный набор пользовательских сценариев, ради которых приложение вообще имеет смысл.

### Работы

- Ready workspace summary slice: сводка статуса, capabilities, core/runtime indicators.
- Service actions slice: `start`, `stop`, `restart`, restart related actions с подтверждениями и результатом.
- Logs slice: просмотр live/log history с фильтрацией и надежным reconnect behavior.
- Routing Xray slice: список routing entry points, active document state, `validate`, `preview`, `save`, `apply` для ограниченного безопасного сценария поверх уже работающего read/edit baseline.
- Read-only diagnostics slice там, где это повышает предсказуемость быстрых действий.
- Подготовка UX и contract foundations для следующих routing/editor модулей без попытки сразу повторить desktop layout.

### Exit criteria

- Пользователь может с телефона открыть `Ready` workspace, понять состояние Xkeen-UI и выполнить основные safe actions.
- Пользователь может пройти controlled сценарий `Routing Xray` без возврата в мобильный браузер.
- Ошибки сети, auth и backend отражаются явно и без "тихих" провалов.
- Quick control не требует перехода в мобильный браузер для базовых сценариев.
- Все MVP flows проходят ручную приемку на реальных устройствах.

## Phase 4 - Beta hardening

### Цель

Сделать приложение устойчивым к реальным сетевым и UX-сценариям, а не только к happy path.

### Работы

- Проверить security review и threat assumptions.
- Доработать offline/disconnected/retry behavior.
- Упростить тексты ошибок и подтверждений.
- Проверить долгие операции, race conditions и повторные нажатия.
- Провести ручной тестовый прогон по device matrix.
- Решить, входит ли backups slice в финальный V1, или переносится в V1.1.

### Exit criteria

- Нет известных критичных сценариев, где приложение оставляет пользователя в неясном состоянии.
- Безопасные действия защищены от случайного повторного запуска.
- Приложение стабильно работает в локальной сети и через доверенный VPN.
- Есть итоговое решение по feature freeze для релиза.

## Phase 5 - Release and V1.1 backlog

### Цель

Подготовить релиз, документацию и следующую очередь развития без размывания уже согласованного MVP.

### Работы

- Подготовить release notes и user-facing onboarding.
- Финализировать app settings, about и diagnostics surfaces.
- Сформировать V1.1 backlog на основе реального использования.
- Решить, какие Mihomo status/profile сценарии действительно нужны как следующий компактный mobile slice.
- Зафиксировать пост-релизные backend улучшения, если они остались за рамками MVP.

### Exit criteria

- Есть релизный build и короткий onboarding для пользователя.
- MVP scope закрыт без скрытого хвоста обязательных работ.
- V1.1 backlog отделен от релизного критического пути.

## Phase 6 - Expansion waves after V1

### Цель

Переносить в Android более сложные web-модули по одному смысловому слою, а не повторять весь web UI за один этап.

### Wave 6A - Routing Mihomo

- Перенести карточку `Routing Mihomo` как отдельный модуль приложения.
- Добавить read-only routing state, затем `validate`, `preview`, `save`, `apply`.
- Определить, где достаточно code editor, а где нужны guided editor controls.

### Wave 6B - Mihomo Generator

- Выделить самые ценные сценарии генератора и перенести их как отдельные экраны/карточки.
- Поддержать preview/generate/apply flows без полного клонирования desktop layout.
- Переиспользовать community/open-source tooling для editor/diff/preview, где это экономит время.

### Wave 6C - Partial DevTools

- Добавить diagnostics summary, operation traces, targeted log utilities.
- Оставить вне Android те devtools-поверхности, которые требуют широкого desktop context или небезопасны на мобильном.

### Wave 6D - Commands and Files

- Начать с read-only и tightly-scoped сценариев.
- Затем добавить controlled terminal sessions и файловые операции с auditability и granular permissions.
- Не включать произвольные destructive workflows без отдельного decision gate.

### Exit criteria

- Каждая волна имеет отдельный product scope, contract и acceptance criteria.
- Расширение не ломает базовый V1 shell и не тянет весь web surface "по инерции".
- Использование внешних библиотек задокументировано и обернуто adapter-слоем.

## Главные риски

- Auth может стать главным источником задержки, если мы поздно определимся с mobile-friendly моделью.
- Если тянуть в V1 файловые операции, терминал или полноценные desktop-like редакторы, инициатива быстро распухнет.
- Прямое использование browser-oriented endpoints из Android без адаптера создаст хрупкий клиент и дорогую поддержку.
- Streaming/logs на мобильном требуют отдельной проработки reconnect и lifecycle behavior.
- Backup restore на телефоне полезен, но требует очень аккуратной safety-модели.
- Даже `Routing Xray` может быстро выйти за пределы "простого companion", если пытаться повторить web editor 1:1.
- Open-source зависимости уменьшают объем работ, но добавляют license, supply-chain и maintenance риски.
- Если перетащить в Compose web-like широкие кнопки и пустые layout-полосы, мобильный UX снова получится неестественным.

## Как снижать риски

- Закрыть auth decision в Phase 0 или в самом начале Phase 1.
- Жестко держать companion scope и не обещать full parity.
- Добавить versioned mobile contract и contract tests раньше, чем UI начнет разрастаться.
- Считать offline/disconnect state частью MVP quality, а не полировкой "на потом".
- Отдельно проводить decision gate по backup workflows.
- Ограничить `Routing Xray` безопасным staged flow вместо полного raw editor parity.
- Каждый advanced module включать отдельной волной с собственной safety-проверкой.
- Держать compact-mobile guardrails на уровне design system и screen review.
- Все внешние библиотеки пропускать через единые license/security/replaceability criteria.

## Acceptance criteria for V1

- С холодного старта пользователь может дойти до `Ready` workspace и понять состояние инстанса без открытия браузера.
- Частые действия управления сервисом выполняются прозрачно, с понятным подтверждением результата.
- Пользователь может открыть `Routing Xray`, пройти `validate` / `preview` / `save` / `apply` для ограниченного сценария и остаться в понятной safety-модели.
- Приложение не открывает опасные low-level surfaces вроде PTY, файлового менеджера или произвольных raw editor flows без отдельного decision gate.
- Mobile contract versioned и покрыт тестами на совместимость.
- V1 не требует публичной интернет-экспозиции Xkeen-UI.

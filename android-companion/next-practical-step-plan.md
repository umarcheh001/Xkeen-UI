# Xkeen Mobile Companion Next Practical Step Plan

Status: stage 1 completed, stage 2 next
Updated: 2026-07-13

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

Что делаем:

- Добавить локальное хранилище для списка подключений, выбранного узла и базового metadata состояния.
- Убрать зависимость от `demoConnections()` как источника истины при старте приложения.
- Поддержать безопасное редактирование и повторный выбор уже сохраненного узла.

Готово, когда:

- после перезапуска приложения список узлов не теряется;
- `Launching` и `Connections` работают уже с persisted данными, а не только с in-memory state.

## Этап 3. Secure storage для session-материала

Что делаем:

- Отделить видимые данные подключения от чувствительных session/token/cookie данных.
- Подключить secure storage wrapper для секретов и флага доверенного восстановления.
- Явно описать, что именно мы умеем восстанавливать автоматически, а что требует повторного входа.

Готово, когда:

- секреты не живут только в памяти процесса;
- можно безопасно отличить обычное сохраненное подключение от доверенной восстанавливаемой сессии.

## Этап 4. Единый transport и нормальная ошибка-семантика

Что делаем:

- Ввести один HTTP transport слой с нормализацией `baseUrl`, timeout, common headers и auth hooks.
- Нормализовать ошибки `401`, `403`, `428`, HTML login page, offline и timeout в понятные app-level состояния.
- Перевести существующие read-only запросы `core` и `routing` на этот единый client path.

Готово, когда:

- приложение одинаково обрабатывает transport/auth ошибки во всех сетевых местах;
- нет нескольких разрозненных реализаций GET-запросов с разной логикой ошибок.

## Этап 5. Реальный Pair/Login и восстановление сессии

Что делаем:

- Подключить `Pair/Login` к реальному session bootstrap flow.
- На старте проверять, можно ли восстановить последнюю trusted session без показа demo-сценария.
- Добавить предсказуемый выход из сессии и обработку истечения авторизации.

Готово, когда:

- `Launching -> Ready` проходит через реальную сессию, если она еще валидна;
- при истекшей авторизации пользователь получает явный возврат в auth flow, а не тихую поломку.

## Этап 6. Backend-backed service actions и core switch

Что делаем:

- Заменить локальные `start`, `stop`, `restart` и `switchCore` на реальные backend-вызовы.
- Добавить состояние `pending / success / failure` и защиту от повторных нажатий.
- После завершения действия обновлять dashboard и active core из сервера, а не из локального предположения.

Готово, когда:

- confirm dialog запускает реальную операцию;
- UI показывает результат сервера и не сообщает об успехе раньше времени;
- ошибки action flow выглядят так же явно, как ошибки чтения.

## Этап 7. Routing Xray: сначала реальный validate

Что делаем:

- Подключить серверную валидацию для выбранного routing-документа.
- Разделить локальные syntax issues и ответы backend validation.
- Вернуть в UI структурированные diagnostics, чтобы `validate` перестал быть demo-проверкой строки.

Готово, когда:

- кнопка `validate` делает реальный round-trip;
- ответ сервера отражается в `RoutingValidation`, а не подменяется локальной эвристикой.

## Этап 8. Routing Xray: затем save/apply и conflict handling

Что делаем:

- Подключить серверное `save` и `apply` для routing-документов.
- Добавить revision/conflict модель: внешний апдейт файла, stale draft, mismatch между saved и published состоянием.
- После `save` и `apply` обновлять локальный document state только из backend-ответа.

Готово, когда:

- `save` и `apply` больше не создают ложное локальное ощущение успеха;
- при конфликте пользователь видит отдельное состояние, а не общую "ошибку валидации".

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

# Xkeen Mobile Companion

Стартовый Android skeleton для companion-приложения Xkeen-UI. Базовый проект уже собирается через Gradle wrapper и служит рабочей площадкой для дальнейшего подключения mobile backend contract.

## Что уже есть

- Jetpack Compose shell с состояниями `launch`, `Connections`, `Pair/Login` и основным editor-first workspace.
- Demo coordinator в памяти без реального backend, чтобы можно было открыть приложение и пройти весь основной поток на устройстве.
- Экран подключений с ручным добавлением инстанса, проверкой доступности и переходом в pair/login flow.
- Компактная верхняя панель с отдельной кнопкой `Core` и безопасными действиями `start`, `stop`, `restart` через confirm state; имя файла показывается только в панели редактора.
- Полноэкранный редактор `Routing Xray` с номерами строк, подсветкой JSON/JSONC, быстрыми действиями `validate`, `save`, `apply`, `revert` и строкой состояния.
- Длинные горизонтальные свайпы перелистывают Xray-конфиги; короткие движения остаются за редактированием и прокруткой содержимого.
- Read-only загрузка списка и содержимого Xray-конфигов через те же endpoint, что использует веб-панель: `GET /api/routing/fragments` и `GET /api/routing?file=...`. При недоступном demo-узле редактор сохраняет локальные демонстрационные данные.
- Logs screen с live/recent переключением и компактными фильтрами.
- Нижнее переключение рабочих зон `Xray`, `Mihomo`, `Ports`, `Shell`, `Generator`; Xray и demo-shell уже интерактивны, остальные зоны обозначают следующий контракт.
- Контекстный drawer для каждой рабочей зоны: у Xray доступны роутинг, подписки, Inbounds, Outbounds, DAT-файлы и логи; у Mihomo — роутинг, профили, провайдеры, группы, правила и генератор.
- Диалог `Core` в стиле основной панели с выбором Xray/Mihomo, защитой от повторного применения текущего ядра и демонстрацией перезапуска после переключения.
- Состав установленных ядер загружается через `GET /api/xkeen/core`: вкладки, drawer, порты и генератор автоматически скрывают функции отсутствующего Xray или Mihomo.
- При наличии доверенного demo-подключения launch восстанавливает его сразу и открывает редактор; список узлов доступен через пункт `Подключения` в drawer.
- Базовая структура под дальнейшее подключение mobile API contract и замены demo state на реальные data layers.

## Как открыть

1. Открой каталог `android-companion/` в Android Studio.
2. Дождись Gradle sync.
3. Запусти конфигурацию `app` на эмуляторе или устройстве.

## Локальная сборка

```powershell
cd android-companion
.\gradlew.bat testDebugUnitTest assembleDebug
```

Команда выше уже проходила успешно в текущем репозитории, включая unit test для базовой валидации draft-потока.

## Осознанно не переносим из веб-панели

- Карточка **«Сценарий маршрутизации»** остаётся только в веб-панели. В мобильном приложении не будет отдельного пункта меню, экрана или API-flow для этого сценария.

## Текущие ограничения

- Нет общего backend transport, auth/session и secure storage; пока подключены read-контракты списка ядер и Xray-конфигов.
- Данные подключения, dashboard state, logs и запись routing draft пока demo-only. Серверные конфиги загружаются для чтения, но `POST /api/routing` ещё не вызывается.
- Переключение `Core` пока меняет demo-state; запись через `POST /api/xkeen/core` будет подключена вместе с реальным transport/auth layer.
- Нет offline persistence и reconnect behavior поверх настоящего network layer.

## Ближайшие следующие шаги

- Подключить реальный mobile bootstrap/dashboard contract вместо demo coordinator.
- Добавить storage для подключений и секретов, затем вынести auth/session и общий network transport в отдельные repositories и use cases.
- Дополнить read-интеграцию `Routing Xray` авторизованной записью, backend validation/preview и безопасным apply через `POST /api/routing`.
- Подключить реальный logs transport с lifecycle-safe reconnect behavior.

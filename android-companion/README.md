# Xkeen Mobile Companion

Стартовый Android skeleton для companion-приложения Xkeen-UI. Базовый проект уже собирается через Gradle wrapper и служит рабочей площадкой для дальнейшего подключения mobile backend contract.

## Что уже есть

- Jetpack Compose shell с состояниями `launch`, `Connections`, `Pair/Login` и основным editor-first workspace.
- Demo coordinator в памяти без реального backend, чтобы можно было открыть приложение и пройти весь основной поток на устройстве.
- Экран подключений с ручным добавлением инстанса, проверкой доступности и переходом в pair/login flow.
- Компактная верхняя панель с текущим конфигом и безопасными действиями `start`, `stop`, `restart` через confirm state.
- Полноэкранный редактор `Routing Xray` с номерами строк, подсветкой JSON, быстрыми действиями `validate`, `save`, `apply`, `revert` и строкой состояния.
- Logs screen с live/recent переключением и компактными фильтрами.
- Нижнее переключение рабочих зон `Xray`, `Mihomo`, `Ports`, `Shell`, `Generator`; Xray и demo-shell уже интерактивны, остальные зоны обозначают следующий контракт.
- Контекстный drawer для каждой рабочей зоны: у Xray доступны роутинг, подписки, Inbounds, сценарии, Outbounds, DAT-файлы и логи; у Mihomo — роутинг, профили, провайдеры, группы, правила и генератор.
- Диалог `Core` в стиле основной панели с выбором Xray/Mihomo, защитой от повторного применения текущего ядра и демонстрацией перезапуска после переключения.
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

## Текущие ограничения

- Нет реального backend transport, auth/session и secure storage.
- Данные подключения, dashboard state, logs и routing draft пока полностью demo-only.
- Переключение `Core` пока меняет demo-state; вызовы `GET/POST /api/xkeen/core` будут подключены вместе с реальным transport/auth layer.
- Нет offline persistence и reconnect behavior поверх настоящего network layer.

## Ближайшие следующие шаги

- Подключить реальный mobile bootstrap/dashboard contract вместо demo coordinator.
- Добавить storage для подключений и секретов, затем вынести auth/session/network в отдельные repositories и use cases.
- Заменить demo `Routing Xray` flow на backend-backed draft/validate/preview/apply contract.
- Подключить реальный logs transport с lifecycle-safe reconnect behavior.

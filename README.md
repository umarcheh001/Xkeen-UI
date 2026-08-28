# Xkeen UI

`Xkeen UI` — веб-панель и Android-приложение для управления XKeen, Xray и Mihomo на роутерах Keenetic с Entware.

> Используйте панель и приложение только в локальной сети или через доверенный VPN. Не публикуйте панель напрямую в интернет.

## Веб-панель

- **Xray:** редакторы Routing, Inbounds и Outbounds, JSON/JSONC, подписки, proxy pools, observatory/leastPing, проверка конфигурации и резервные копии.
- **Mihomo:** встроенный operator runtime (статус, группы, соединения, rules/providers/logs), YAML-редактор, профили и безопасные Unix-first шаблоны; Zashboard остаётся optional external tool.
- **Редакторы:** локальные CodeMirror 6 и Monaco, schema-assist, autocomplete, snippets, semantic validation и quick fixes без CDN.
- **Управление:** запуск, остановка и перезапуск XKeen, переключение ядра, версии, обновления, команды и PTY-терминал.
- **Логи:** live-логи Xray и сервисов с фильтрацией и диагностикой.
- **Файлы:** двухпанельный файловый менеджер, архивы, права, checksum и Remote FS через SFTP/FTP/FTPS.
- **DAT:** управление GeoIP/GeoSite, просмотр тегов и интеграция с `xk-geodat`.
- **DevTools:** настройки панели, диагностика окружения и self-update.

Все основные frontend-ассеты входят в релиз. Node.js и внешние CDN на роутере не нужны.

## Android-приложение · Beta

Нативное приложение для Android 9+ переносит основные сценарии панели в компактный мобильный интерфейс:

- безопасное подключение к Xkeen UI и хранение сессии через Android Keystore;
- статус сервиса, переключение Xray/Mihomo, запуск, остановка и перезапуск;
- Xray Routing, Inbounds, Outbounds, подписки, DAT и логи;
- Mihomo YAML, шаблоны, добавление узлов, HWID-подписки и Zashboard;
- порты и исключения, журнал и мобильный PTY-терминал.

Beta APK публикуется в [GitHub Releases](https://github.com/umarcheh001/Xkeen-UI/releases) как `xkeen-mobile-beta.apk`. Для корректной работы используйте приложение вместе с актуальной версией панели.

Приложение также само проверяет GitHub Releases при запуске. Перед открытием системного установщика оно требует парный `.sha256`, проверяет контрольную сумму, package/version APK и тот же Android signing certificate. Проверка доступна и до входа в роутер — на экране подключений. Android может один раз попросить разрешить установку из Xkeen Mobile.

Установка через ADB:

```sh
curl -fL -o xkeen-mobile-beta.apk "https://github.com/umarcheh001/Xkeen-UI/releases/latest/download/xkeen-mobile-beta.apk"
adb install -r xkeen-mobile-beta.apk
```

При установке вручную с телефона разрешите установку приложений из выбранного браузера или файлового менеджера.

## Состав релиза

- `xkeen-ui-routing.tar.gz` — установочный архив панели;
- `xkeen-ui-routing.tar.gz.sha256` — контрольная сумма архива;
- `xkeen-mobile-beta.apk` — Android beta;
- `xkeen-mobile-beta.apk.sha256` — контрольная сумма APK;
- `xk-geodat-linux-*` — бинарники DAT-инструмента для поддерживаемых архитектур.

## Установка панели

### Архив уже на роутере

```sh
cd /opt
tar -xzf xkeen-ui-routing.tar.gz
cd xkeen-ui
sh install.sh
```

### Онлайн-установка из GitHub Releases

```sh
cd /opt
curl -fL -o xkeen-ui-routing.tar.gz "https://github.com/umarcheh001/Xkeen-UI/releases/latest/download/xkeen-ui-routing.tar.gz"
tar -xzf xkeen-ui-routing.tar.gz
cd xkeen-ui
sh install.sh
```

Установщик проверяет или устанавливает Python 3, Flask, WebSocket-зависимости, `lftp`, init-скрипт и при необходимости `xk-geodat`. Порт выбирается автоматически: `8088`, затем `8091`, затем диапазон `8100-8199`.

### Восстановление после `bad marshal data`

Ошибка вида `ValueError: bad marshal data` в `/opt/lib/python3.x/...` означает, что Python не может прочитать скомпилированный файл стандартной библиотеки (`.pyc`). Строка `frontend-build cleanup` перед traceback показывает только первый шаг установщика, которому понадобился новый процесс Python; frontend-файлы не являются причиной ошибки.

Сначала проверьте запуск со свежим отдельным кэшем, не удаляя файлы Entware:

```sh
mkdir -p /tmp/xkeen-ui-pycache
PYTHONPYCACHEPREFIX=/tmp/xkeen-ui-pycache \
  /opt/bin/python3 -c 'import json, re; print("Python OK")'
```

Если команда напечатала `Python OK`, временно поднимите панель так:

```sh
PYTHONPYCACHEPREFIX=/tmp/xkeen-ui-pycache \
  /opt/etc/init.d/S99xkeen-ui-umarcheh001 restart
```

Для старого init-скрипта можно сохранить обход до переустановки панели:

```sh
printf "\nexport PYTHONPYCACHEPREFIX='/tmp/xkeen-ui-pycache'\n" \
  >> /opt/etc/xkeen-ui/devtools.env
/opt/etc/init.d/S99xkeen-ui-umarcheh001 restart
```

После установки версии с исправлением отдельный кэш включается самим установщиком, self-update runner и init-скриптом. Если даже проверочная команда с `PYTHONPYCACHEPREFIX` падает, повреждён уже не только кэш: проверьте ошибки накопителя/файловой системы и переустановите пакет стандартной библиотеки Python через Entware. Перед продолжением сохраните `/opt/etc/xkeen-ui`, пользовательские конфиги Xray и Mihomo.

### Безопасность Mihomo controller

Новые встроенные шаблоны используют `external-controller-unix: ./mihomo-api.sock`: Clash API не открывается в LAN, а веб-панель обращается к socket через same-origin backend facade. Существующий `config.yaml` установщик **не переписывает**, чтобы обновление панели не меняло пользовательский YAML без согласия.

Вручную дописывать параметр не обязательно. При первом открытии **Mihomo → Управление** панель проверяет активный конфиг. Если controller отсутствует, появится карточка **«Mihomo API ещё не настроен»** с кнопкой **«Настроить автоматически»**. Панель подготовит preview, добавит рекомендуемый Unix socket после подтверждения, выполнит `mihomo -t`, создаст backup, сохранит конфиг и по умолчанию предложит нужный перезапуск Mihomo.

Такой же помощник исправляет `external-controller: 0.0.0.0:9090` без `secret`. До подтверждения `config.yaml` не меняется; для rollback используйте созданный Mihomo backup. В YAML-редакторе наведение на `external-controller-unix` показывает назначение, рекомендуемое значение и предупреждение из Mihomo JSON Schema.

Unix socket — рекомендуемый режим. Совместимый вариант — `127.0.0.1:9090` с автоматически сгенерированным непустым `secret`; пароль панели для этого не переиспользуется. Zashboard требует browser-reachable controller и потому должен включаться отдельно, с аутентификацией и только в доверенной LAN/VPN.

## Установка xk-geodat

`xk-geodat` добавляет просмотр GeoIP/GeoSite, список тегов, поиск и вставку значений в Routing. Панель работает и без него, но DAT-возможности будут ограничены.

Поддерживаются `arm64/aarch64` и `mipsle/mipsel`. Установить бинарник можно через установщик панели, карточку DAT в UI или вручную через SSH.

Для `arm64 / aarch64`:

```sh
mkdir -p /opt/etc/xkeen-ui/bin
curl -fL -o /opt/etc/xkeen-ui/bin/xk-geodat "https://github.com/umarcheh001/Xkeen-UI/releases/latest/download/xk-geodat-linux-arm64"
chmod +x /opt/etc/xkeen-ui/bin/xk-geodat
/opt/etc/xkeen-ui/bin/xk-geodat --help
```

Для `mipsle / mipsel`:

```sh
mkdir -p /opt/etc/xkeen-ui/bin
curl -fL -o /opt/etc/xkeen-ui/bin/xk-geodat "https://github.com/umarcheh001/Xkeen-UI/releases/latest/download/xk-geodat-linux-mipsle"
chmod +x /opt/etc/xkeen-ui/bin/xk-geodat
/opt/etc/xkeen-ui/bin/xk-geodat --help
```

## Доступ к панели

```text
http://<IP_роутера>:<порт>/
```

Логи панели:

- `/opt/var/log/xkeen-ui.log`
- `/opt/var/log/xkeen-ui/`

## URL Xray-подписок

Обычные Xray-подписки принимают публичные `https://` и `http://` URL. Локальные и private-адреса, в том числе адреса в редиректах, по умолчанию заблокированы. Чтобы принудительно принимать только HTTPS, задайте `XKEEN_SUBSCRIPTION_ALLOW_HTTP=0`; доступ к private-адресам требует отдельного явного `XKEEN_SUBSCRIPTION_ALLOW_PRIVATE_HOSTS=1`.

## Автообновление Xray-подписок

Фоновый планировщик обновляет подписки, у которых подошёл срок, и перезапускает ядро **один раз на всю пачку**, а не на каждую подписку. Подписки, срок которых наступит в ближайшие 5 минут, подтягиваются в ту же пачку — после этого их расписания выравниваются и дальше они обновляются вместе сами.

Переменные окружения:

- `XKEEN_SUBSCRIPTIONS_SCHEDULER=0` — полностью отключить фоновое автообновление.
- `XKEEN_SUBSCRIPTIONS_SCHEDULER_TICK` — период опроса в секундах (по умолчанию `60`, диапазон 15–3600).
- `XKEEN_SUBSCRIPTIONS_LOOKAHEAD_SEC` — окно подтягивания «почти созревших» подписок в секундах (по умолчанию `300`, максимум `3600`). `0` отключает подтягивание. Окно работает только тогда, когда хотя бы одна подписка уже реально созрела, поэтому расписание не уезжает вперёд само по себе.
- `XKEEN_SUBSCRIPTIONS_RESTART_BATCH=0` — вернуть старое поведение: отдельный перезапуск ядра на каждую обновлённую подписку.

Для подписок Mihomo работает та же логика с собственными переменными: `XKEEN_MIHOMO_SUBSCRIPTIONS_SCHEDULER`, `XKEEN_MIHOMO_SUBSCRIPTIONS_SCHEDULER_TICK`, `XKEEN_MIHOMO_SUBSCRIPTIONS_LOOKAHEAD_SEC`, `XKEEN_MIHOMO_SUBSCRIPTIONS_RESTART_BATCH`.

## Сторож DNS-over-VLESS

Пока DNS-over-VLESS включён, порт 53 принадлежит Xray, поэтому фоновый сторож следит за ядром и, если оно не поднимается, возвращает DNS прошивке. Подробности — в [docs/dns-over-vless.md](docs/dns-over-vless.md).

Переменные окружения:

- `XKEEN_DNS_OVER_VLESS_WATCHDOG=0` — не запускать сторожа. При отказе ядра сеть останется без DNS до ручного вмешательства.
- `XKEEN_DNS_OVER_VLESS_WATCHDOG_INTERVAL` — период проверки в секундах (по умолчанию `30`, диапазон 5–3600).
- `XKEEN_DNS_OVER_VLESS_WATCHDOG_FAILS` — сколько сбоев подряд считать отказом (по умолчанию `3`, диапазон 1–100).
- `XKEEN_DNS_OVER_VLESS_WATCHDOG_RESTARTS` — сколько раз пробовать перезапустить ядро перед возвратом DNS прошивке (по умолчанию `2`, диапазон 0–20; `0` — отдать сразу).

Значения читаются при старте панели, поэтому после правки её нужно перезапустить.

## Управление сервисом

```sh
/opt/etc/init.d/S99xkeen-ui-umarcheh001 start
/opt/etc/init.d/S99xkeen-ui-umarcheh001 stop
/opt/etc/init.d/S99xkeen-ui-umarcheh001 restart
/opt/etc/init.d/S99xkeen-ui-umarcheh001 status
```

На старых установках init-скрипт может оставаться по пути `/opt/etc/init.d/S99xkeen-ui`.

## Сброс логина и пароля

По умолчанию данные авторизации находятся в `/opt/etc/xkeen-ui/auth.json`.

```sh
/opt/etc/init.d/S99xkeen-ui-umarcheh001 stop
rm -f /opt/etc/xkeen-ui/auth.json
/opt/etc/init.d/S99xkeen-ui-umarcheh001 start
```

После этого панель снова предложит создать логин и пароль. При переопределении `XKEEN_UI_STATE_DIR` файл `auth.json` находится в указанной директории.

## Полное удаление

Быстро удалить панель:

```sh
sh /opt/etc/xkeen-ui/uninstall.sh
```

Дополнительная очистка:

```sh
rm -rf /opt/var/log/xkeen-ui
rm -f /opt/var/log/xkeen-ui.log
rm -f /opt/var/run/xkeen-ui.pid
rm -f /opt/bin/sysmon
rm -f /opt/bin/entware-backup
rm -rf /opt/etc/xray/configs/backups
```

Удаление установленных панелью шаблонов Mihomo:

```sh
rm -f /opt/etc/mihomo/templates/custom.yaml
rm -f /opt/etc/mihomo/templates/zkeen.yaml
```

Если зависимости больше не используются другими сервисами:

```sh
/opt/bin/python3 -m pip uninstall -y flask gevent gevent-websocket || true
opkg remove lftp || true
opkg remove python3-pip || true
opkg remove python3 || true
```

> Удаляйте общие зависимости только если уверены, что они не нужны другим приложениям на роутере.

## Для разработки

Пересобрать frontend:

```sh
npm run frontend:build
```

Собрать пользовательский архив:

```sh
npm run archive:user
```

Проверить и собрать Android-приложение:

```sh
cd android-companion
./gradlew testDebugUnitTest assembleDebug
```

## Лицензии и сторонние компоненты

CodeMirror, Monaco, xterm.js и другие сторонние компоненты поставляются локально вместе с соответствующими лицензиями. Подробная техническая документация находится в каталоге [`docs`](docs/).

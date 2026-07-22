# Xkeen UI

`Xkeen UI` — веб-панель и Android-приложение для управления XKeen, Xray и Mihomo на роутерах Keenetic с Entware.

> Используйте панель и приложение только в локальной сети или через доверенный VPN. Не публикуйте панель напрямую в интернет.

## Веб-панель

- **Xray:** редакторы Routing, Inbounds и Outbounds, JSON/JSONC, подписки, proxy pools, observatory/leastPing, проверка конфигурации и резервные копии.
- **Mihomo:** YAML-редактор, профили и шаблоны, импорт узлов и подписок, HWID-provider, генератор конфигурации и запуск Zashboard.
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

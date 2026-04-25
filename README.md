# Xkeen UI

`Xkeen UI` — веб-панель для роутеров Keenetic с Entware, Xray, Mihomo и XKeen.

Это уже не "лёгкая минимальная панель" из ранних версий проекта. Сейчас `Xkeen UI` — это единый интерфейс для управления конфигами, сервисами, логами, файлами, DAT-файлами и вспомогательными инструментами вокруг Xray/Mihomo.

> Панель рассчитана на локальную сеть. Не публикуйте её напрямую в интернет без отдельной защиты доступа.

## Что умеет

- Xray: редакторы `routing / inbounds / outbounds`, поддержка `json/jsonc`, Xray subscriptions, observatory/leastPing workflow, schema-assist, preflight-проверка, backups и snapshots.
- Mihomo: профили, шаблоны, импорт/экспорт, генератор конфигов, запуск Mihomo UI.
- Команды и терминал: каталог команд XKeen, shell/PTY-терминал, live-логи.
- Файлы: двухпанельный файловый менеджер, upload/download, архивы, права, checksum, корзина.
- Remote FS: SFTP/FTP/FTPS через `lftp`.
- DAT: управление `GeoIP / GeoSite`, просмотр содержимого и интеграция с `xk-geodat`.
- DevTools: локальные UI-настройки, диагностика, self-update и сервисные переключатели.

## Локальные редакторы

В панели используются два локальных движка редактора:

- `CodeMirror 6`
- `Monaco`

Оба поставляются прямо в релизе панели, через локальные `static/vendor` и `static/frontend-build`. Для работы редакторов роутеру не нужны CDN и не нужен Node.js.

Переключение движка доступно в основных редакторах панели, включая:

- главный JSON-редактор Xray;
- Routing Mihomo;
- редактор в файловом менеджере;
- Mihomo Generator;
- preview-редакторы и часть модальных окон.

Если кратко:

- `CodeMirror` обычно удобен как более простой и быстрый встроенный редактор;
- `Monaco` полезен там, где нужен более "IDE-подобный" режим работы.

## Schema-assist в редакторах

В основных редакторах панели работает локальный schema-driven UX без внешних CDN:

- Xray: JSON Schema для `routing`, `inbounds`, `outbounds` и полного конфига;
- Mihomo: YAML Schema для `config.yaml`;
- hover-подсказки по полям;
- autocomplete и task-oriented snippets;
- semantic validation поверх схемы;
- quick fixes для типовых ошибок;
- beginner-mode с explain-first подсказками;
- expert-mode, который полностью отключает schema-assist и скрывает кнопку `Quick fix`.

Что это даёт на практике:

- в `05_routing.json`, `03_inbounds.json`, `04_outbounds*.json` и `config.yaml` панель умеет подсказывать допустимые поля и значения;
- ошибки показываются не только как "битый JSON/YAML", но и как конфигурационные проблемы уровня Xray/Mihomo;
- часть типовых проблем можно исправить кнопкой `Quick fix`;
- режим `Эксперт` оставляет только базовый редактор без схем, сниппетов и автодополнения.

Настройки этого слоя лежат в `UI settings -> Редактор`:

- `Показывать всплывающие подсказки редактора` — включено по умолчанию;
- `Режим новичка в подсказках` — включён по умолчанию;
- `Эксперт` — по умолчанию выключен.

## Подписки Xray

Подписки Xray управляются из карточки `Прокси (04_outbounds.json)`.

Чтобы открыть окно подписок:

1. откройте секцию `Прокси (04_outbounds.json)`;
2. нажмите кнопку `Подписки Xray`;
3. заполните форму источника и сохраните подписку.

Что умеет подписка:

- принимает HTTP(S) URL;
- понимает share-ссылки, base64-подписки и Xray JSON outbounds;
- создаёт отдельный managed fragment вида `04_outbounds.<tag>.json`;
- при необходимости пишет JSONC sidecar для удобного просмотра в редакторе;
- может добавлять generated tags в `07_observatory.json` для `leastPing`;
- может синхронизировать routing с пулом подписки через `05_routing.json`.

### Как добавить

В форме подписки доступны основные поля:

- `Название` — произвольное имя в списке;
- `Tag prefix` — префикс для generated outbound tags;
- `URL` — ссылка на подписку;
- фильтры `Имя / Тип / Транспорт` — позволяют оставить только нужные узлы;
- `Авто` — включает плановое автообновление;
- `Пинг` — добавляет generated tags в `07_observatory.json` для `leastPing`;
- `Обновить сразу` — сразу скачивает подписку и создаёт fragment после сохранения;
- `Применение`:
  - `Безопасно` — синхронизирует leastPing/fallback-пул, но не трогает явные правила на `vless-reality`;
  - `Жёстко · pool` — переводит auto-правила пула на общий `balancerTag`.

После сохранения панель:

- создаёт `04_outbounds.<tag>.json`;
- при включённом `Пинг` обновляет `07_observatory.json`;
- при нужном режиме применения синхронизирует `05_routing.json`;
- может сразу перезапустить `xkeen`, если в панели включён авто-перезапуск.

> Generated `04_outbounds.<tag>.json` — это managed-файл панели. После следующего refresh подписки он будет пересобран заново.

### Как обновлять

Есть три основных сценария:

- кнопка `Обновить` у конкретной подписки — скачать её прямо сейчас и пересобрать fragment;
- кнопка `Обновить due` — обновить только те подписки, у которых уже наступило `next update`;
- автообновление по интервалу из формы.

Особенности:

- локальный интервал задаётся в часах, от `1` до `168`;
- значение по умолчанию — `24` часа;
- рекомендация провайдера по `profile-update-interval` показывается как подсказка, но не перезаписывает ваш выбранный интервал;
- справа можно посмотреть состав generated fragment, transport/protocol узлов и запустить `Пинг всех узлов`.

### Как удалить

Удаление подписки делает не только удаление записи из списка:

- удаляется сама подписка из состояния панели;
- удаляется generated fragment `04_outbounds.<tag>.json` и его sidecar;
- routing и observatory пересобираются из оставшихся подписок;
- если подписок больше не осталось, панель старается вернуть `05_routing.json` и `07_observatory.json` к состоянию до подписок.

Это сделано специально, чтобы после удаления подписки не оставались "висячие" selector/balancer/observatory хвосты.

## Что входит в релиз

Основной установочный артефакт:

- `xkeen-ui-routing.tar.gz`

Обычно релизный архив уже содержит готовые `static/frontend-build` и `static/vendor`, поэтому роутеру не нужен Node.js для установки панели.

Дополнительно в релизах могут публиковаться бинарники `xk-geodat` для поддерживаемых архитектур.

## Установка

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

Установщик:

- проверяет или ставит `python3`;
- ставит `Flask`;
- по возможности ставит `gevent/gevent-websocket` для WebSocket-сценариев;
- ставит `lftp` для файлового менеджера;
- регистрирует сервис `/opt/etc/init.d/S99xkeen-ui`;
- выбирает свободный порт: `8088`, затем `8091`, затем диапазон `8100-8199`;
- очищает устаревшие файлы в `static/frontend-build` при обновлении;
- может предложить установить `xk-geodat`.

## Установка xk-geodat

`xk-geodat` нужен для расширенной работы с DAT-файлами:

- просмотр содержимого `GeoIP / GeoSite`;
- список тегов и быстрый поиск;
- вставка значений в правила routing из UI.

Без `xk-geodat` панель работает, но DAT-функции будут урезаны.

Поддерживаемые архитектуры:

- `arm64 / aarch64`
- `mipsle / mipsel`

### Через установщик панели

Во время установки `install.sh` может предложить поставить `xk-geodat` автоматически.

### Через UI

Рекомендуемый вариант: открыть карточку `DAT GeoIP / GeoSite` в панели и поставить бинарник:

- из GitHub Releases;
- или из локального файла, если GitHub на роутере недоступен.

### Через SSH вручную

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
/opt/etc/init.d/S99xkeen-ui start
/opt/etc/init.d/S99xkeen-ui stop
/opt/etc/init.d/S99xkeen-ui restart
/opt/etc/init.d/S99xkeen-ui status
```

## Сбросить логин/пароль

По умолчанию данные авторизации лежат в `/opt/etc/xkeen-ui/auth.json`.

Сбросить доступ можно так:

```sh
/opt/etc/init.d/S99xkeen-ui stop
rm -f /opt/etc/xkeen-ui/auth.json
/opt/etc/init.d/S99xkeen-ui start
```

После этого панель снова предложит пройти первичную настройку логина и пароля.

Если вы переопределяли `XKEEN_UI_STATE_DIR`, файл `auth.json` будет лежать в этой директории.

## Полное удаление и очистка

### Быстро удалить панель

```sh
sh /opt/etc/xkeen-ui/uninstall.sh
```

Это удалит:

- файлы панели из `/opt/etc/xkeen-ui`;
- init-скрипт `/opt/etc/init.d/S99xkeen-ui`;
- PID-файл панели.

### Дополнительная очистка

Если нужно убрать следы полностью, можно отдельно удалить:

```sh
rm -rf /opt/var/log/xkeen-ui
rm -f /opt/var/log/xkeen-ui.log
rm -f /opt/var/run/xkeen-ui.pid
rm -f /opt/bin/sysmon
rm -f /opt/bin/entware-backup
rm -rf /opt/etc/xray/configs/backups
```

Если больше не нужны шаблоны, поставленные панелью:

```sh
rm -f /opt/etc/mihomo/templates/custom.yaml
rm -f /opt/etc/mihomo/templates/zkeen.yaml
```

Если зависимости ставились только ради панели и не используются другими сервисами:

```sh
/opt/bin/python3 -m pip uninstall -y flask gevent gevent-websocket || true
opkg remove lftp || true
opkg remove python3-pip || true
opkg remove python3 || true
```

> Этот шаг делайте только если уверены, что эти пакеты не нужны другим сервисам на роутере.

## Для разработки

Пересобрать фронтенд:

```sh
npm run frontend:build
```

Собрать пользовательский архив для установки:

```sh
npm run archive:user
```

## Примечания

- WebSocket-функции используются там, где это возможно; на слабых устройствах часть сценариев может работать через fallback.
- Все основные фронтенд-ассеты поставляются локально, без зависимости от CDN.
- Проект ориентирован на реальную эксплуатацию на Keenetic/Entware, а не на "демо-оболочку" вокруг пары конфигов.

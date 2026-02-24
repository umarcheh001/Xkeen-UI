# 🚀 Xkeen UI — веб‑панель для XKeen на Keenetic (Entware)

**Xkeen UI** — лёгкая веб‑панель для роутеров **Keenetic** с **Entware**.  
Позволяет управлять конфигами **Xray / Mihomo**, сервисами **XKeen**, логами, бэкапами/снапшотами, файлами (двухпанельный менеджер), а также — работать с **DAT GeoIP/GeoSite** (теги, поиск, копирование, “в правило”).

> ⚠️ Панель рассчитана на домашнюю сеть. Не публикуй её в интернет. Используй пароль и при необходимости ограничивай доступ (ACL / Firewall / VPN).

---

## 🔥 Что нового / ключевые фичи

### 🧩 Xray Routing / конфиги
- Редактор конфигов Xray (inbounds / outbounds / routing) + поддержка `*.jsonc` (комментарии).
- **Шаблоны роутинга** (routing templates) и удобное автосоздание/подстановка.
- **Бэкапы и снапшоты конфигов Xray**:
  - *History* (timestamp) — ручные/по действию записи.
  - *Snapshots* по имени файла (например `07_observatory.json`) — хранит **предыдущую** версию файла перед перезаписью (как “откат”).

### 🗂️ DAT GeoIP / GeoSite
- Загрузка/обновление DAT файлов.
- Просмотр содержимого: список тегов, поиск, просмотр элементов, copy `geosite:TAG` / `geoip:TAG`.
- Кнопка **«В правило»** (добавить выбранный тег прямо в routing‑правило) — без ручного копипаста.

> Просмотр “Содержимого” DAT и быстрые действия работают через отдельный бинарник **xk-geodat** (см. ниже).

### 📦 Бэкапы Xray конфигов (UI)
- Отдельная страница/карточка управления бэкапами: список, просмотр, восстановление, удаление.
- Авто‑снапшоты перед перезаписью конфигов (как безопасный rollback).

### 📜 Логи / терминал / файловый менеджер
- Live‑логи Xray: WebSocket (если доступно) или HTTP‑polling fallback.
- Терминал: “Command Runner” + интерактивный PTY (xterm.js), если WebSocket доступен.
- Двухпанельный файловый менеджер, архивирование/распаковка, jobs с прогрессом.
- Remote File Manager (опционально) через `lftp`.

---

## 🧱 Что входит в релиз (Assets)

В **GitHub Releases** обычно лежат:
- `xkeen-ui-routing.tar.gz` — установочный архив панели.
- `xk-geodat-linux-arm64` — бинарник xk-geodat для **arm64/aarch64**.
- `xk-geodat-linux-mipsle` — бинарник xk-geodat для **mipsle (GOMIPS=softfloat)**.
- `SHA256SUMS` — контрольные суммы для бинарников xk-geodat (если включён workflow).

---

## 🧠 Зачем нужен xk-geodat (и почему это отдельный бинарник)

`xk-geodat` — маленькая утилита‑парсер DAT, которая:
- читает `geosite*.dat` / `geoip*.dat`,
- показывает теги, считает элементы, даёт быстрый поиск,
- помогает UI показывать “Содержимое” и делать кнопку **«В правило»**.

Без `xk-geodat` панель будет работать, но **просмотр содержимого DAT и быстрые действия будут ограничены/отключены**.

Поддерживаемые архитектуры:
- ✅ `arm64/aarch64`
- ✅ `mipsle` **softfloat**
- ❌ другие — не собираются в этом проекте

---

## 📦 Установка панели (SSH)

### Вариант A — архив уже на роутере
```sh
cd /opt
tar -xzf xkeen-ui-routing.tar.gz
cd xkeen-ui
sh install.sh
```

### Вариант B — скачать из Releases и поставить
```sh
cd /opt \
  && curl -fL -o xkeen-ui-routing.tar.gz "https://github.com/umarcheh001/Xkeen-UI/releases/latest/download/xkeen-ui-routing.tar.gz" \
  && tar -xzf xkeen-ui-routing.tar.gz \
  && sh xkeen-ui/install.sh
```

### Что делает `install.sh`
- ставит/проверяет **python3** (Entware) и **python3-pip**;
- через `pip` ставит **Flask** (обязательно) и (опционально) **gevent + gevent-websocket** для WebSocket функций;
- ставит `lftp` (для Remote File Manager);
- выбирает порт (обычно **8088**, затем **8091**, затем диапазон **8100–8199**);
- ставит панель в `/opt/etc/xkeen-ui`, создаёт `/opt/etc/init.d/S99xkeen-ui` и запускает сервис;
- при **первой** установке делает авто‑бэкап базовых конфигов Xray в `/opt/etc/xray/configs/backups`;
- (опционально) предлагает поставить **xk-geodat** (чтобы работали DAT “Содержимое” и “В правило”).

---

## 🌐 Доступ к панели
```text
http://<IP_роутера>:<порт>/
```

Логи панели:
- install‑лог: `/opt/var/log/xkeen-ui.log`
- runtime‑логи: `/opt/var/log/xkeen-ui/` (stdout/stderr и др.)

---

## 🧑‍💻 Управление сервисом (SSH)
```sh
/opt/etc/init.d/S99xkeen-ui start
/opt/etc/init.d/S99xkeen-ui stop
/opt/etc/init.d/S99xkeen-ui restart
/opt/etc/init.d/S99xkeen-ui status
```

---

## 🧩 Установка xk-geodat

### 1) Через панель (рекомендуется)
Открой **Routing Xray → DAT-файлы GeoIP / GeoSite**:

- Кнопка **xk-geodat** — поставит/обновит из GitHub Releases (latest).
- Кнопка **⬆︎** — установить **из файла** (если GitHub блокируется или ты тестируешь свой бинарник).

После установки в карточке DAT появятся функции “Содержимое” и “В правило”.

### 2) Через SSH (ручной способ)
Скачать и положить в директорию панели:
```sh
mkdir -p /opt/etc/xkeen-ui/bin
curl -fL -o /opt/etc/xkeen-ui/bin/xk-geodat "https://github.com/umarcheh001/Xkeen-UI/releases/latest/download/xk-geodat-linux-<arch>"
chmod +x /opt/etc/xkeen-ui/bin/xk-geodat
/opt/etc/xkeen-ui/bin/xk-geodat --help
```

Где `<arch>`:
- `arm64` для arm64/aarch64
- `mipsle` для mipsle softfloat

### 3) Проверка SHA256 (если есть SHA256SUMS)
```sh
cd /tmp
curl -fL -O "https://github.com/umarcheh001/Xkeen-UI/releases/latest/download/SHA256SUMS"
sha256sum /opt/etc/xkeen-ui/bin/xk-geodat
# сравни хеш с соответствующей строкой в SHA256SUMS
```

> Встроенный установщик xk-geodat делает “мягкую” проверку: если SHA256SUMS доступен — проверит, если нет — продолжит установку с предупреждением.

---

## 🧰 Полезные переменные окружения

### Общие
- `XKEEN_UI_STATE_DIR` — где хранить состояние UI (auth/secret/настройки)
- `XKEEN_UI_SECRET_KEY` — ключ сессий (если нужно фиксировать вручную)
- `XKEEN_ALLOW_SHELL` — разрешить произвольные команды в Command Runner (`1`/`0`)
- `XKEEN_XRAY_LOG_TZ_OFFSET` — смещение времени логов (часы), по умолчанию `3`
- `XKEEN_LOG_DIR` — переопределить директорию runtime‑логов панели (по умолчанию `/opt/var/log/xkeen-ui`)
- `XKEEN_UI_ENV_FILE` — файл с переменными окружения для сервиса (по умолчанию `/opt/etc/xkeen-ui/devtools.env`)

### Файловый менеджер / Remote FM
- `XKEEN_TRASH_DIR` — путь к корзине (local)
- `XKEEN_TRASH_MAX_GB` / `XKEEN_TRASH_MAX_BYTES` — лимит корзины
- `XKEEN_REMOTEFM_ENABLE` — включить Remote File Manager (`1`/`0`)
- `XKEEN_REMOTEFM_MAX_UPLOAD_MB` — лимит upload для remote
- `XKEEN_REMOTEFM_SESSION_TTL` — TTL remote сессий

### xk-geodat (если нужно руками/для тестов)
- `XKEEN_GEODAT_BIN` — путь установки бинарника (по умолчанию `/opt/etc/xkeen-ui/bin/xk-geodat`)
- `XKEEN_GEODAT_INSTALL` — `1` установить без вопросов / `0` пропустить установку
- `XKEEN_GEODAT_URL` — полный URL на бинарник (переопределяет latest)
- `XKEEN_GEODAT_TAG` — скачать из конкретного релиза (tag)
- `XKEEN_GEODAT_ASSET` — имя ассета (если нужно переопределить авто‑детект)
- `XKEEN_GEODAT_LOCAL` — установить из локального файла
- `XKEEN_GEODAT_SHA256SUMS_URL` — URL до `SHA256SUMS` (если нужен кастом)

---

## 🧹 Удаление / очистка

### Быстрое удаление панели (без трогания зависимостей)
```sh
sh /opt/etc/xkeen-ui/uninstall.sh
```

Удаление логов (опционально):
```sh
rm -rf /opt/var/log/xkeen-ui
rm -f /opt/var/log/xkeen-ui.log
rm -f /opt/var/run/xkeen-ui.pid
```

> `uninstall.sh` удаляет **файлы панели** и init‑скрипт, но **не удаляет** Python/Flask/gevent/lftp и не трогает конфиги Xray/Mihomo.

### Что ещё могла поставить панель (и как удалить полностью)
> ⚠️ Делай это только если уверен, что у тебя **нет других** сервисов на Python/Flask/gevent/lftp в Entware.

1) Удалить wrapper `sysmon` (панель ставит его в `/opt/bin/sysmon`, если в архиве был `tools/sysmon_keenetic.sh`):
```sh
rm -f /opt/bin/sysmon
```

2) Удалить шаблоны (если хочешь убрать именно “поставленные панелью”):
```sh
rm -f /opt/etc/mihomo/templates/custom.yaml
rm -f /opt/etc/mihomo/templates/zkeen.yaml
# Xray templates обычно безопасно оставлять (они не перезаписываются и могли быть донастроены).
```

3) Удалить бэкапы/снапшоты (если они не нужны):
```sh
rm -rf /opt/etc/xray/configs/backups
```

4) Удалить Python pip‑пакеты, которые ставил install.sh:
```sh
/opt/bin/python3 -m pip uninstall -y flask gevent gevent-websocket || true
```

5) Удалить Entware пакеты (если они ставились только ради панели):
```sh
opkg remove lftp || true
opkg remove python3-pip || true
opkg remove python3 || true
```

Проверить, что установлено:
```sh
opkg list-installed | grep -E 'python3|python3-pip|lftp' || true
/opt/bin/python3 -m pip list 2>/dev/null | grep -Ei 'flask|gevent' || true
```

---

## 🛠️ Troubleshooting

### WebSocket (PTY / live‑логи) не работает
- На некоторых устройствах `gevent` может не собраться (особенно mips/mipsel). Тогда панель автоматически перейдёт на **HTTP‑polling** для логов, а PTY‑терминал может быть недоступен.

### GitHub блокируется на роутере
- Самый простой путь: скачать `xk-geodat-linux-<arch>` на ПК и поставить **через UI кнопкой “⬆︎ из файла”**.

### Сбросить логин/пароль
```sh
/opt/etc/init.d/S99xkeen-ui stop
rm -f /opt/etc/xkeen-ui/auth.json
/opt/etc/init.d/S99xkeen-ui start
```

---

## 📝 Примечания
- Все фронтенд библиотеки (CodeMirror, xterm.js и т.д.) поставляются локально — панель не зависит от CDN.
- Проект ориентирован на Keenetic/Entware и старается не ломать пользовательские конфиги/шаблоны (шаблоны Xray не перезаписываются).
---

![xkeen-ui-demo](https://github.com/user-attachments/assets/f2f6649c-2e9b-49a2-9cd8-f855fbd55084)



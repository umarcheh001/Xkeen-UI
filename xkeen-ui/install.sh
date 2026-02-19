#!/bin/sh
set -e

UI_DIR="/opt/etc/xkeen-ui"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
INIT_DIR="/opt/etc/init.d"
INIT_SCRIPT="$INIT_DIR/S99xkeen-ui"
PYTHON_BIN="/opt/bin/python3"
LOG_DIR="/opt/var/log"
RUN_DIR="/opt/var/run"

# JSONC sidecar-dir для "сырого" текста с комментариями (routing/inbounds/outbounds).
# Должен лежать ВНЕ /opt/etc/xray/configs, иначе некоторые сборки Xray могут
# начать подхватывать *.jsonc из -confdir и ломать правила.
# (По умолчанию: /opt/etc/xkeen-ui/xray-jsonc)
JSONC_DIR_DEFAULT="$UI_DIR/xray-jsonc"

# Если это апгрейд и пользователь уже сохранял env overrides через DevTools,
# подтянем XKEEN_XRAY_JSONC_DIR (только если не задано явно в окружении).
if [ -z "${XKEEN_XRAY_JSONC_DIR:-}" ] && [ -f "$UI_DIR/devtools.env" ]; then
  # shellcheck disable=SC1090
  . "$UI_DIR/devtools.env" 2>/dev/null || true
fi

JSONC_DIR="${XKEEN_XRAY_JSONC_DIR:-$JSONC_DIR_DEFAULT}"
if [ -z "$JSONC_DIR" ]; then
  JSONC_DIR="$JSONC_DIR_DEFAULT"
fi

# Определяем архитектуру устройства, чтобы решить, устанавливать ли gevent
ARCH="$(uname -m 2>/dev/null || echo unknown)"
WANT_GEVENT=1
case "$ARCH" in
  mipsel*|mips*)
    # На слабых MIPS/MIPSEL-роутерах сборка gevent/greenlet часто не проходит.
    # В этом случае панель будет работать через HTTP-пуллинг без gevent.
    WANT_GEVENT=0
    ;;
esac

MIHOMO_TEMPLATES_DIR="/opt/etc/mihomo/templates"
SRC_MIHOMO_TEMPLATES="$SRC_DIR/opt/etc/mihomo/templates"

# Шаблоны Xray (Routing)
XRAY_ROUTING_TEMPLATES_DIR="$UI_DIR/templates/routing"
SRC_XRAY_ROUTING_TEMPLATES="$SRC_DIR/opt/etc/xray/templates/routing"

# Шаблоны Xray (Observatory)
XRAY_OBSERVATORY_TEMPLATES_DIR="$UI_DIR/templates/observatory"
SRC_XRAY_OBSERVATORY_TEMPLATES="$SRC_DIR/opt/etc/xray/templates/observatory"

# Файлы/директории Xray (используются панелью, но сами не трогаются)
#
# В некоторых сборках/профилях части конфига могут называться иначе.
# Например для Hysteria2 используются *_hys2.json:
#   03_inbounds_hys2.json / 04_outbounds_hys2.json / 05_routing_hys2.json
#
XRAY_CONFIG_DIR="/opt/etc/xray/configs"

# DAT-файлы GeoIP/GeoSite
# Xray обычно ищет assets относительно директории бинарника (например /opt/sbin).
# При использовании синтаксиса ext:<file>.dat:<list> удобнее хранить DAT в /opt/etc/xray/dat,
# но тогда нужно обеспечить доступность файлов для Xray.
# Решение: делаем symlink всех *.dat из /opt/etc/xray/dat в /opt/sbin (если возможно).
XRAY_DAT_DIR="/opt/etc/xray/dat"
XRAY_BIN_DIR="/opt/sbin"

pick_xray_file() {
  DEF="$1"
  ALT="$2"
  if [ -f "$XRAY_CONFIG_DIR/$DEF" ]; then
    echo "$XRAY_CONFIG_DIR/$DEF"
    return 0
  fi
  if [ -f "$XRAY_CONFIG_DIR/$ALT" ]; then
    echo "$XRAY_CONFIG_DIR/$ALT"
    return 0
  fi
  # default for new installs
  echo "$XRAY_CONFIG_DIR/$DEF"
}

ROUTING_FILE="$(pick_xray_file 05_routing.json 05_routing_hys2.json)"
INBOUNDS_FILE="$(pick_xray_file 03_inbounds.json 03_inbounds_hys2.json)"
OUTBOUNDS_FILE="$(pick_xray_file 04_outbounds.json 04_outbounds_hys2.json)"
BACKUP_DIR="$XRAY_CONFIG_DIR/backups"

DEFAULT_PORT=8088
ALT_PORT=8091

echo "========================================"
echo "  Xkeen Web UI — УСТАНОВКА"
echo "========================================"

# --- Python3 ---

if [ ! -x "$PYTHON_BIN" ]; then
  echo "[*] Python3 не найден по пути $PYTHON_BIN."
  echo "[*] Пытаюсь установить python3 через Entware (opkg)..."

  if command -v opkg >/dev/null 2>&1; then
    OPKG_BIN="$(command -v opkg)"
  elif [ -x "/opt/bin/opkg" ]; then
    OPKG_BIN="/opt/bin/opkg"
  else
    echo "[!] Не найден пакетный менеджер opkg Entware."
    echo "    Установи Entware и python3 вручную, затем запусти установщик ещё раз."
    exit 1
  fi

  if ! "$OPKG_BIN" update; then
    echo "[!] Не удалось выполнить 'opkg update'."
    exit 1
  fi

  if ! "$OPKG_BIN" install python3; then
    echo "[!] Установка python3 через opkg завершилась с ошибкой."
    exit 1
  fi
fi

if [ ! -x "$PYTHON_BIN" ]; then
  echo "[!] Python3 по пути $PYTHON_BIN не найден даже после установки."
  exit 1
fi

# --- Flask + gevent ---

echo "[*] Проверяю наличие Flask/gevent для Python3..."

# Flask обязателен, gevent/geventwebsocket — опциональны (только для WebSocket-логов)

NEED_FLASK=0
NEED_GEVENT=0

# Проверяем flask
if ! "$PYTHON_BIN" -c "import flask" >/dev/null 2>&1; then
  NEED_FLASK=1
fi


# Проверяем gevent и geventwebsocket (только если архитектура позволяет)
if [ "$WANT_GEVENT" -eq 1 ]; then
  for MOD in gevent geventwebsocket; do
    if ! "$PYTHON_BIN" -c "import $MOD" >/dev/null 2>&1; then
      NEED_GEVENT=1
      break
    fi
  done
else
  echo "[*] Архитектура $ARCH: пропускаю установку gevent/gevent-websocket, будет использован HTTP-пулинг."
fi

if [ "$NEED_FLASK" -eq 1 ] || [ "$NEED_GEVENT" -eq 1 ]; then
  echo "[*] Flask и/или gevent не найдены. Пытаюсь установить зависимости через Entware и pip..."

  if command -v opkg >/dev/null 2>&1; then
    OPKG_BIN="$(command -v opkg)"
  elif [ -x "/opt/bin/opkg" ]; then
    OPKG_BIN="/opt/bin/opkg"
  else
    echo "[!] Не найден пакетный менеджер opkg Entware."
    echo "    Поставь зависимости вручную:"
    echo "      opkg update && opkg install python3 python3-pip"
    if [ "$WANT_GEVENT" -eq 1 ]; then
      echo "      $PYTHON_BIN -m pip install --upgrade pip flask gevent gevent-websocket"
    else
      echo "      $PYTHON_BIN -m pip install --upgrade pip flask"
    fi
    echo "    После этого запусти установщик ещё раз."
    exit 1
  fi

  if ! "$OPKG_BIN" update; then
    echo "[!] Не удалось выполнить 'opkg update' при установке зависимостей."
    exit 1
  fi

  if ! "$OPKG_BIN" install python3 python3-pip; then
    echo "[!] Установка python3 и python3-pip через opkg завершилась с ошибкой."
    exit 1
  fi

  # pip может не суметь собрать gevent/gevent-websocket на слабых роутерах (mipsel),
  # поэтому ошибка здесь НЕ фатальная — продолжаем установку без WebSocket.
  PIP_PKGS="flask"
  if [ "$WANT_GEVENT" -eq 1 ]; then
    PIP_PKGS="$PIP_PKGS gevent gevent-websocket"
  fi
  if ! "$PYTHON_BIN" -m pip install --upgrade pip $PIP_PKGS; then
    echo "[!] Не удалось полностью установить Flask и/или gevent через pip."
    echo "    Продолжаю установку, но WebSocket может быть недоступен."
  fi
fi

# Финальная проверка: flask обязателен
if ! "$PYTHON_BIN" -c "import flask" >/dev/null 2>&1; then
  echo "[!] Модуль flask по-прежнему не виден из $PYTHON_BIN."
  echo "    Без него панель не запустится. Завершаю установку."
  exit 1
fi

# gevent/geventwebsocket — опциональны: предупреждаем, но НЕ падаем
if [ "$WANT_GEVENT" -eq 1 ]; then
  MISSING_GEVENT=""
  for MOD in gevent geventwebsocket; do
    if ! "$PYTHON_BIN" -c "import $MOD" >/dev/null 2>&1; then
      if [ -z "$MISSING_GEVENT" ]; then
        MISSING_GEVENT="$MOD"
      else
        MISSING_GEVENT="$MISSING_GEVENT $MOD"
      fi
    fi
  done

  if [ -n "$MISSING_GEVENT" ]; then
    echo "[!] Следующие модули gevent недоступны: $MISSING_GEVENT"
    echo "    Продолжаю установку без WebSocket; логи Xray будут отображаться через HTTP-пулинг."
  else
    echo "[*] Flask и gevent найдены, WebSocket для логов Xray будет использован."
  fi
else
  echo "[*] gevent/gevent-websocket не устанавливались для архитектуры $ARCH."
  echo "    Логи Xray будут отображаться через HTTP-пулинг."
fi

echo "[*] Python-зависимости в порядке."


# --- lftp (для файлового менеджера) ---

echo "[*] Проверяю наличие lftp для файлового менеджера..."

if ! command -v lftp >/dev/null 2>&1; then
  echo "[*] lftp не найден. Пытаюсь установить lftp через Entware (opkg)..."

  if command -v opkg >/dev/null 2>&1; then
    OPKG_BIN="$(command -v opkg)"
  elif [ -x "/opt/bin/opkg" ]; then
    OPKG_BIN="/opt/bin/opkg"
  else
    echo "[!] Не найден пакетный менеджер opkg Entware."
    echo "    Установи Entware и lftp вручную, затем запусти установщик ещё раз."
    exit 1
  fi

  if ! "$OPKG_BIN" update; then
    echo "[!] Не удалось выполнить 'opkg update' при установке lftp."
    exit 1
  fi

  if ! "$OPKG_BIN" install lftp; then
    echo "[!] Установка lftp через opkg завершилась с ошибкой."
    exit 1
  fi
fi

if ! command -v lftp >/dev/null 2>&1; then
  echo "[!] lftp не найден даже после установки."
  exit 1
fi


# --- Функции ---

is_port_in_use() {
  PORT_CHECK="$1"
  if command -v netstat >/dev/null 2>&1; then
    netstat -tln 2>/dev/null | awk '{print $4}' | grep -q ":${PORT_CHECK}$"
  else
    # Если netstat недоступен, считаем, что порт свободен
    return 1
  fi
}

backup_config_file() {
  SRC="$1"
  NAME="$(basename "$SRC")"

  if [ ! -f "$SRC" ]; then
    echo "[*] Файл $SRC не найден, пропускаю бэкап."
    return 0
  fi

  mkdir -p "$BACKUP_DIR"

  if command -v date >/dev/null 2>&1; then
    TS="$(date +%Y%m%d-%H%M%S 2>/dev/null || date 2>/dev/null || echo "no-date")"
  else
    TS="no-date"
  fi

  DEST="$BACKUP_DIR/${NAME}.auto-backup-${TS}"
  cp "$SRC" "$DEST"
  echo "[*] Создан бэкап: $SRC -> $DEST"
  echo "[backup] $SRC -> $DEST" >> "$LOG_DIR/xkeen-ui.log"
}

migrate_legacy_jsonc_files() {
  # Best-effort миграция legacy *.jsonc из XRAY_CONFIG_DIR -> JSONC_DIR.
  # Основная миграция также запускается при старте приложения, но здесь делаем
  # это заранее, чтобы не оставлять *.jsonc в -confdir Xray.

  if [ ! -d "$XRAY_CONFIG_DIR" ]; then
    return 0
  fi

  # Создаём JSONC_DIR (может быть переопределён через XKEEN_XRAY_JSONC_DIR)
  mkdir -p "$JSONC_DIR" 2>/dev/null || true

  # Проверяем, есть ли что переносить
  if ! find "$XRAY_CONFIG_DIR" -maxdepth 1 -type f -name '*.jsonc' 2>/dev/null | grep -q .; then
    return 0
  fi

  echo "[*] Найдены legacy *.jsonc в $XRAY_CONFIG_DIR — переношу в $JSONC_DIR..."

  MOVED=0
  ARCHIVED=0

  for src in "$XRAY_CONFIG_DIR"/*.jsonc; do
    [ -f "$src" ] || continue
    base="$(basename "$src")"
    dest="$JSONC_DIR/$base"

    TS="$(date +%Y%m%d-%H%M%S 2>/dev/null || echo no-date)"

    if [ -f "$dest" ]; then
      SRC_TS="$(stat -c %Y "$src" 2>/dev/null || stat -f %m "$src" 2>/dev/null || echo 0)"
      DST_TS="$(stat -c %Y "$dest" 2>/dev/null || stat -f %m "$dest" 2>/dev/null || echo 0)"

      if [ "$SRC_TS" -gt "$DST_TS" ]; then
        # src новее — делаем dest old и переносим src как основной
        mv "$dest" "$dest.old-$TS" 2>/dev/null || {
          cp "$dest" "$dest.old-$TS" 2>/dev/null || true
          rm -f "$dest" 2>/dev/null || true
        }
        mv "$src" "$dest" 2>/dev/null || {
          cp "$src" "$dest" 2>/dev/null || true
          rm -f "$src" 2>/dev/null || true
        }
        MOVED=$((MOVED + 1))
      else
        # dest новее — сохраняем src как old в JSONC_DIR
        mv "$src" "$dest.old-$TS" 2>/dev/null || {
          cp "$src" "$dest.old-$TS" 2>/dev/null || true
          rm -f "$src" 2>/dev/null || true
        }
        ARCHIVED=$((ARCHIVED + 1))
      fi
    else
      mv "$src" "$dest" 2>/dev/null || {
        cp "$src" "$dest" 2>/dev/null || true
        rm -f "$src" 2>/dev/null || true
      }
      MOVED=$((MOVED + 1))
    fi
  done

  echo "[*] JSONC миграция (install): перемещено=$MOVED, архивировано=$ARCHIVED."
  echo "[install] JSONC миграция: moved=$MOVED archived=$ARCHIVED jsonc_dir=$JSONC_DIR" >> "$LOG_DIR/xkeen-ui.log"

  # Если что-то осталось (например, из-за прав) — предупредим.
  if find "$XRAY_CONFIG_DIR" -maxdepth 1 -type f -name '*.jsonc' 2>/dev/null | grep -q .; then
    echo "[!] Внимание: в $XRAY_CONFIG_DIR всё ещё есть *.jsonc. Проверь права/перенеси вручную."
  fi
}

# --- Определяем существующую установку и её порт ---

EXISTING_APP="$UI_DIR/app.py"
EXISTING_RUN="$UI_DIR/run_server.py"
EXISTING_PORT=""
FIRST_INSTALL="yes"

if [ -f "$EXISTING_APP" ] || [ -f "$EXISTING_RUN" ]; then
  FIRST_INSTALL="no"
fi

# 1) Пробуем вытащить порт из run_server.py (WSGIServer(("0.0.0.0", PORT ...))
if [ -f "$EXISTING_RUN" ]; then
  EXISTING_PORT=$(grep -E '"0\.0\.0\.0",[[:space:]]*[0-9]+' "$EXISTING_RUN" 2>/dev/null | \
    sed -E 's/.*"0\.0\.0\.0",[[:space:]]*([0-9]+).*/\1/' | tail -n 1 || true)
fi

# 2) Если не нашлось, пробуем старый способ — из app.py (app.run(... port=PORT ...))
if [ -z "$EXISTING_PORT" ] && [ -f "$EXISTING_APP" ]; then
  EXISTING_PORT=$(grep -E 'app.run\(.*port *= *[0-9]+' "$EXISTING_APP" 2>/dev/null | \
    sed -E 's/.*port *= *([0-9]+).*/\1/' | tail -n 1 || true)
fi

if [ -n "$EXISTING_PORT" ]; then
  PANEL_PORT="$EXISTING_PORT"
  USE_EXISTING=1

  # Если порт занят, проверяем, не нашей ли панелью (чтобы при переустановке не менять порт)
  if is_port_in_use "$PANEL_PORT"; then
    OUR_PANEL=0
    PID_FILE="$RUN_DIR/xkeen-ui.pid"

    # 1) Проверка по PID-файлу
    if [ -f "$PID_FILE" ]; then
      PID="$(cat "$PID_FILE" 2>/dev/null || true)"
      if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
        if [ -r "/proc/$PID/cmdline" ]; then
          CMDLINE="$(tr '\000' ' ' < "/proc/$PID/cmdline" 2>/dev/null || true)"
          echo "$CMDLINE" | grep -Eq "$UI_DIR/run_server.py|$UI_DIR/app.py" && OUR_PANEL=1
        else
          # Если /proc недоступен, считаем, что PID относится к нашей панели
          OUR_PANEL=1
        fi
      fi
    fi

    # 2) Страховка: поиск процесса по командной строке (если PID-файл отсутствует/некорректен)
    if [ "$OUR_PANEL" -eq 0 ] && command -v ps >/dev/null 2>&1; then
      ps w 2>/dev/null | grep -v grep | grep -Eq "$UI_DIR/run_server.py|$UI_DIR/app.py" && OUR_PANEL=1
    fi

    if [ "$OUR_PANEL" -ne 1 ]; then
      echo "[*] Обнаружена существующая установка, но порт $PANEL_PORT занят другим процессом. Выбираю новый порт..."
      USE_EXISTING=0
    fi
  fi

  if [ "$USE_EXISTING" -eq 1 ]; then
    echo "[*] Обнаружена существующая установка, сохраняю порт: $PANEL_PORT"
    echo "[install] Текущий порт панели: $PANEL_PORT" >> "$LOG_DIR/xkeen-ui.log"
  fi
fi

if [ -z "$EXISTING_PORT" ] || [ "${USE_EXISTING:-0}" -eq 0 ]; then
  # Выбираем порт заново (первая установка или не удалось прочитать порт / порт занят другим сервисом)
  PANEL_PORT="$DEFAULT_PORT"
  if is_port_in_use "$PANEL_PORT"; then
    echo "[*] Порт $PANEL_PORT уже занят, пробую $ALT_PORT..."
    PANEL_PORT="$ALT_PORT"
    if is_port_in_use "$PANEL_PORT"; then
      echo "[*] Порт $ALT_PORT тоже занят, ищу свободный порт в диапазоне 8100–8199..."
      PANEL_PORT=""
      PORT_CANDIDATE=8100
      while [ "$PORT_CANDIDATE" -le 8199 ]; do
        if ! is_port_in_use "$PORT_CANDIDATE"; then
          PANEL_PORT="$PORT_CANDIDATE"
          break
        fi
        PORT_CANDIDATE=$((PORT_CANDIDATE + 1))
      done

      if [ -z "$PANEL_PORT" ]; then
        echo "[!] Не удалось найти свободный порт в диапазоне 8100–8199."
        exit 1
      fi
    fi
  fi
  echo "[*] Выбран порт панели: $PANEL_PORT"
  echo "[install] Текущий порт панели: $PANEL_PORT" >> "$LOG_DIR/xkeen-ui.log"
fi

# --- Бэкапы Xray на самой первой установке ---

if [ "$FIRST_INSTALL" = "yes" ]; then
  echo "[*] Первая установка: создаю бэкапы конфигов Xray в $BACKUP_DIR..."
  backup_config_file "$ROUTING_FILE"
  backup_config_file "$INBOUNDS_FILE"
  backup_config_file "$OUTBOUNDS_FILE"
else
  echo "[*] Это не первая установка, автоматические бэкапы конфигов пропущены."
fi

# --- Копирование файлов панели ---

echo "[*] Создаю директории..."
mkdir -p "$UI_DIR" "$INIT_DIR" "$LOG_DIR" "$RUN_DIR" "$BACKUP_DIR" "$JSONC_DIR"

# Этап 7 (install/upgrade): гарантируем наличие отдельного каталога для JSONC
# и пытаемся убрать legacy *.jsonc из XRAY_CONFIG_DIR.
migrate_legacy_jsonc_files || true

echo "[*] Копирую файлы панели в $UI_DIR..."
if command -v rsync >/dev/null 2>&1; then
  rsync -a "$SRC_DIR"/ "$UI_DIR"/ --exclude "install.sh"
else
  cp -r "$SRC_DIR"/* "$UI_DIR"/ 2>/dev/null || true
  cp -r "$SRC_DIR"/.[!.]* "$UI_DIR"/ 2>/dev/null || true
  rm -f "$UI_DIR/install.sh"
fi

# --- BUILD.json (версия/сборка) ---
#
# Небольшой файл с метаданными сборки, который отображается в DevTools.
# Используется также для будущего self-update из GitHub.
#
# Параметры можно передать через окружение (например, при сборке релиза):
#   XKEEN_UI_UPDATE_REPO, XKEEN_UI_UPDATE_CHANNEL, XKEEN_UI_VERSION, XKEEN_UI_COMMIT

json_escape() {
  # minimal JSON string escape
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

extract_json_field() {
  # extract "field": "value" from a small JSON file without jq
  _field="$1"
  _file="$2"
  [ -f "$_file" ] || return 0
  grep -o "\"$_field\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" "$_file" 2>/dev/null \
    | head -n 1 \
    | sed -E 's/.*:[[:space:]]*\"([^\"]*)\".*/\1/' \
    || true
}

OLD_BUILD="$UI_DIR/BUILD.json"
OLD_VERSION=""
OLD_COMMIT=""
OLD_REPO=""
OLD_CHANNEL=""
if [ -f "$OLD_BUILD" ]; then
  OLD_VERSION="$(extract_json_field version "$OLD_BUILD")"
  OLD_COMMIT="$(extract_json_field commit "$OLD_BUILD")"
  OLD_REPO="$(extract_json_field repo "$OLD_BUILD")"
  OLD_CHANNEL="$(extract_json_field channel "$OLD_BUILD")"
fi

BUILD_REPO="${XKEEN_UI_UPDATE_REPO:-${OLD_REPO:-umarcheh001/Xkeen-UI}}"
BUILD_CHANNEL="${XKEEN_UI_UPDATE_CHANNEL:-${OLD_CHANNEL:-stable}}"
BUILD_VERSION="${XKEEN_UI_VERSION:-$OLD_VERSION}"
BUILD_COMMIT="${XKEEN_UI_COMMIT:-$OLD_COMMIT}"
BUILD_UTC="$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date +"%Y-%m-%dT%H:%M:%SZ")"

TMP_BUILD="$UI_DIR/.BUILD.json.tmp"
{
  echo "{" 
  echo "  \"repo\": \"$(json_escape "$BUILD_REPO")\","
  echo "  \"channel\": \"$(json_escape "$BUILD_CHANNEL")\","
  if [ -n "$BUILD_VERSION" ]; then
    echo "  \"version\": \"$(json_escape "$BUILD_VERSION")\","
  else
    echo "  \"version\": null,"
  fi
  if [ -n "$BUILD_COMMIT" ]; then
    echo "  \"commit\": \"$(json_escape "$BUILD_COMMIT")\","
  else
    echo "  \"commit\": null,"
  fi
  echo "  \"built_utc\": \"$(json_escape "$BUILD_UTC")\","
  echo "  \"source\": \"install.sh\","
  echo "  \"artifact\": null"
  echo "}"
} > "$TMP_BUILD" 2>/dev/null || true

if [ -s "$TMP_BUILD" ]; then
  mv -f "$TMP_BUILD" "$UI_DIR/BUILD.json" 2>/dev/null || true
fi

echo "[*] Проверяю наличие локальных файлов xterm для веб-терминала..."
XTERM_DIR="$UI_DIR/static/xterm"
XTERM_MISSING=0

for f in xterm.js xterm-addon-fit.js xterm.css; do
  if [ ! -f "$XTERM_DIR/$f" ]; then
    echo "[!] Не найден файл: $XTERM_DIR/$f"
    XTERM_MISSING=1
  fi
done

if [ "$XTERM_MISSING" -ne 0 ]; then
  echo "[!] Критическая ошибка: отсутствуют один или несколько файлов xterm для терминала в веб-панели."
  echo "    Убедись, что архив с панелью содержит каталог static/xterm"
  echo "    с файлами xterm.js, xterm-addon-fit.js и xterm.css, и запусти установку снова."
  exit 1
fi

# --- Sysmon wrapper ---
# Make `sysmon` available inside interactive PTY shell sessions.
SYS_MON_SRC="$UI_DIR/tools/sysmon_keenetic.sh"
SYS_MON_BIN="/opt/bin/sysmon"

if [ -f "$SYS_MON_SRC" ]; then
  echo "[*] Устанавливаю sysmon в $SYS_MON_BIN..."
  cat > "$SYS_MON_BIN" <<'EOF'
#!/bin/sh
# sysmon — XKeen router monitor
SCRIPT="/opt/etc/xkeen-ui/tools/sysmon_keenetic.sh"
if [ ! -f "$SCRIPT" ]; then
  echo "sysmon: script not found: $SCRIPT" >&2
  exit 127
fi
exec sh "$SCRIPT" "$@"
EOF
  chmod +x "$SYS_MON_BIN" 2>/dev/null || true
  chmod +x "$SYS_MON_SRC" 2>/dev/null || true
else
  echo "[*] sysmon: скрипт не найден в $SYS_MON_SRC (пропуск)"
fi


cleanup_legacy_xray_templates() {
  # Некоторые версии xkeen/xray могут подхватывать *.jsonc из /opt/etc/xray (recursive scan)
  # и из-за этого зависать/не стартовать. Начиная с этого релиза шаблоны живут в $UI_DIR/templates/*.
  # Поэтому аккуратно убираем ТОЛЬКО наши встроенные шаблоны из /opt/etc/xray/templates/*.

  LEGACY_ROOT="/opt/etc/xray/templates"
  [ -d "$LEGACY_ROOT" ] || return 0

  # remove built-in routing templates by name
  for f in \
    "$LEGACY_ROOT/routing/05_routing_base.jsonc" \
    "$LEGACY_ROOT/routing/05_routing_zkeen_only.jsonc" \
    "$LEGACY_ROOT/routing/05_routing_all_proxy_except_ru.jsonc" \
    "$LEGACY_ROOT/routing/.xkeen_seeded" \
    "$LEGACY_ROOT/observatory/07_observatory_base.jsonc" \
    "$LEGACY_ROOT/observatory/.xkeen_seeded" \
    ; do
    [ -f "$f" ] && rm -f "$f" 2>/dev/null || true
  done

  # Try to prune empty dirs (best-effort)
  rmdir "$LEGACY_ROOT/routing" 2>/dev/null || true
  rmdir "$LEGACY_ROOT/observatory" 2>/dev/null || true
  rmdir "$LEGACY_ROOT" 2>/dev/null || true
}

# Убираем legacy шаблоны из /opt/etc/xray/templates (если они были установлены ранее)
cleanup_legacy_xray_templates


# --- Шаблоны Mihomo ---

if [ -d "$SRC_MIHOMO_TEMPLATES" ]; then
  echo "[*] Устанавливаю шаблон Mihomo в $MIHOMO_TEMPLATES_DIR..."
  mkdir -p "$MIHOMO_TEMPLATES_DIR"

  for old in config_2.yaml umarcheh001.yaml; do
    if [ -f "$MIHOMO_TEMPLATES_DIR/$old" ]; then
      rm -f "$MIHOMO_TEMPLATES_DIR/$old" && echo "[*] Удалён старый шаблон $old"
    fi
  done

  SRC_CUSTOM="$SRC_MIHOMO_TEMPLATES/custom.yaml"
  if [ -f "$SRC_CUSTOM" ]; then
    cp -f "$SRC_CUSTOM" "$MIHOMO_TEMPLATES_DIR/custom.yaml"
    echo "[*] Установлен шаблон custom.yaml в $MIHOMO_TEMPLATES_DIR"
  else
    echo "[!] Не найден шаблон custom.yaml в $SRC_MIHOMO_TEMPLATES"
  fi
  SRC_ZKEEN="$SRC_MIHOMO_TEMPLATES/zkeen.yaml"
  if [ -f "$SRC_ZKEEN" ]; then
    cp -f "$SRC_ZKEEN" "$MIHOMO_TEMPLATES_DIR/zkeen.yaml"
    echo "[*] Установлен шаблон zkeen.yaml в $MIHOMO_TEMPLATES_DIR"
  else
    echo "[!] Не найден шаблон zkeen.yaml в $SRC_MIHOMO_TEMPLATES"
  fi
fi

# --- Шаблоны Xray (Routing) ---

if [ -d "$SRC_XRAY_ROUTING_TEMPLATES" ]; then
  echo "[*] Устанавливаю шаблоны роутинга Xray в $XRAY_ROUTING_TEMPLATES_DIR..."
  mkdir -p "$XRAY_ROUTING_TEMPLATES_DIR"

  # Не перезаписываем существующие файлы пользователя.
  for f in "$SRC_XRAY_ROUTING_TEMPLATES"/*.json "$SRC_XRAY_ROUTING_TEMPLATES"/*.jsonc; do
    [ -f "$f" ] || continue
    base="$(basename "$f")"
    if [ ! -f "$XRAY_ROUTING_TEMPLATES_DIR/$base" ]; then
      cp -f "$f" "$XRAY_ROUTING_TEMPLATES_DIR/$base"
      echo "[*] + $base"
    fi
  done
else
  echo "[*] Шаблоны роутинга Xray не найдены в архиве (пропуск)"
fi

# --- Шаблоны Xray (Observatory) ---

if [ -d "$SRC_XRAY_OBSERVATORY_TEMPLATES" ]; then
  echo "[*] Устанавливаю шаблоны observatory Xray в $XRAY_OBSERVATORY_TEMPLATES_DIR..."
  mkdir -p "$XRAY_OBSERVATORY_TEMPLATES_DIR"

  # Не перезаписываем существующие файлы пользователя.
  for f in "$SRC_XRAY_OBSERVATORY_TEMPLATES"/*.json "$SRC_XRAY_OBSERVATORY_TEMPLATES"/*.jsonc; do
    [ -f "$f" ] || continue
    base="$(basename "$f")"
    if [ ! -f "$XRAY_OBSERVATORY_TEMPLATES_DIR/$base" ]; then
      cp -f "$f" "$XRAY_OBSERVATORY_TEMPLATES_DIR/$base"
      echo "[*] + $base"
    fi
  done
else
  echo "[*] Шаблоны observatory Xray не найдены в архиве (пропуск)"
fi

# --- Compat fix: обеспечить доступность DAT-файлов для Xray (ext:*.dat:...) ---

# В шаблонах/правилах панели часто используется синтаксис ext:<имя>.dat:<список>.
# В этом режиме Xray ищет файл по имени в директории assets (часто рядом с бинарником).
# Панель, в свою очередь, хранит/обновляет DAT по умолчанию в $XRAY_DAT_DIR.
# Чтобы не заставлять пользователя переносить файлы вручную — создаём symlink в $XRAY_BIN_DIR.

if [ -d "$XRAY_DAT_DIR" ] && [ -d "$XRAY_BIN_DIR" ]; then
  echo "[*] Xray DAT: создаю symlink *.dat из $XRAY_DAT_DIR в $XRAY_BIN_DIR (для ext:... )"
  for f in "$XRAY_DAT_DIR"/*.dat; do
    # Resolve symlinks in dat dir so /opt/sbin points to the real file.
    # (BusyBox usually supports `readlink -f`, but keep fallback.)
    src="$f"
    if command -v readlink >/dev/null 2>&1; then
      src="$(readlink -f "$f" 2>/dev/null || echo "$f")"
    fi
    [ -f "$src" ] || continue
    base="$(basename "$f")"
    # Не затираем реальные файлы (на всякий случай), только ссылки.
    if [ -e "$XRAY_BIN_DIR/$base" ] && [ ! -L "$XRAY_BIN_DIR/$base" ]; then
      continue
    fi
    ln -sf "$src" "$XRAY_BIN_DIR/$base" 2>/dev/null || true
  done
fi

# --- Compat fix: удалить отсутствующие geosite-списки из routing (xray) ---

# Некоторые GeoSite датасеты (например v2fly) не содержат отдельных списков типа whatsapp-ads.
# Если такие строки попали в /opt/etc/xray/configs/05_routing*.json, Xray не стартует.
# В старых версиях панели этого списка не было. Исправляем мягко и только точечно.

if [ -n "$ROUTING_FILE" ] && [ -f "$ROUTING_FILE" ] && grep -q 'ext:geosite_v2fly.dat:whatsapp-ads' "$ROUTING_FILE" 2>/dev/null; then
  echo "[*] Compat: удаляю ext:geosite_v2fly.dat:whatsapp-ads из $ROUTING_FILE (иначе Xray не стартует)"
  ROUTING_FILE="$ROUTING_FILE" $PYTHON_BIN - <<'PYFIX' || true
import json, os, sys
path = os.environ.get('ROUTING_FILE')
if not path or not os.path.exists(path):
    sys.exit(0)
try:
    raw = open(path, 'r', encoding='utf-8', errors='replace').read()
    data = json.loads(raw)
except Exception:
    # Если файл не JSON (или с комментариями) — не трогаем
    sys.exit(0)
TARGET = 'ext:geosite_v2fly.dat:whatsapp-ads'
changed = False

def walk(x):
    global changed
    if isinstance(x, list):
        out = []
        for i in x:
            if i == TARGET:
                changed = True
                continue
            out.append(walk(i))
        return out
    if isinstance(x, dict):
        return {k: walk(v) for k, v in x.items()}
    return x

new = walk(data)
if changed:
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(new, f, ensure_ascii=False, indent=2)
        f.write('\n')
    os.replace(tmp, path)
PYFIX
fi

# --- Обновление порта в run_server.py / app.py ---

RUN_SERVER="$UI_DIR/run_server.py"
APP_FILE="$UI_DIR/app.py"

echo "[*] Обновляю порт в run_server.py / app.py..."
UPDATED=0

# run_server.py (текущая версия панели)
if [ -f "$RUN_SERVER" ]; then
  CHANGED_RUN=0

  # Обновляем порт в ("0.0.0.0", PORT) — может быть на новой строке, поэтому ищем просто кортеж
  if grep -q '"0\.0\.0\.0",[[:space:]]*[0-9]\+' "$RUN_SERVER"; then
    if sed -i -E "s/(\"0\.0\.0\.0\",[[:space:]]*)[0-9]+/\1${PANEL_PORT}/g" "$RUN_SERVER"; then
      CHANGED_RUN=1
    fi
  fi

  # Обновляем fallback app.run(... port=PORT) внутри run_server.py (если есть)
  if grep -q 'app\.run' "$RUN_SERVER"; then
    if sed -i -E "s/(app\.run\([^)]*port[[:space:]]*=[[:space:]]*)[0-9]+/\1${PANEL_PORT}/g" "$RUN_SERVER"; then
      CHANGED_RUN=1
    fi
  fi

  if [ "$CHANGED_RUN" -eq 1 ]; then
    echo "[*] Порт в run_server.py обновлён на $PANEL_PORT."
    UPDATED=1
  fi
fi

# app.py (для старых версий, где запуск был через app.run)
if [ -f "$APP_FILE" ] && grep -q 'app\.run' "$APP_FILE"; then
  if sed -i -E "s/(app\.run\([^)]*port[[:space:]]*=[[:space:]]*)[0-9]+/\1${PANEL_PORT}/g" "$APP_FILE"; then
    echo "[*] Порт в app.py обновлён на $PANEL_PORT."
    UPDATED=1
  fi
fi

if [ "$UPDATED" -eq 0 ]; then
  echo "[!] Внимание: не удалось автоматически изменить порт ни в run_server.py, ни в app.py."
  echo "    Порт может остаться по умолчанию, проверь файлы вручную."
fi

# --- Optional: xk-geodat (DAT GeoIP/GeoSite: "Содержимое" и "В routing") ---
if [ -f "$SRC_DIR/scripts/install_xk_geodat.sh" ]; then
  echo "[*] (Опционально) Устанавливаю xk-geodat для DAT GeoIP/GeoSite..."
  sh "$SRC_DIR/scripts/install_xk_geodat.sh" || true
fi

# --- Init-скрипт ---

echo "[*] Создаю init-скрипт $INIT_SCRIPT..."

cat > "$INIT_SCRIPT" << 'EOF'
#!/bin/sh

ENABLED=yes
UI_DIR="/opt/etc/xkeen-ui"
PYTHON_BIN="/opt/bin/python3"
RUN_SERVER="$UI_DIR/run_server.py"
APP_PY="$UI_DIR/app.py"

LOG_DIR_DEFAULT="/opt/var/log/xkeen-ui"
LOG_DIR="$LOG_DIR_DEFAULT"
STDOUT_LOG="$LOG_DIR/stdout.log"
STDERR_LOG="$LOG_DIR/stderr.log"
PID_FILE="/opt/var/run/xkeen-ui.pid"

start_service() {
  if [ ! -x "$PYTHON_BIN" ]; then
    echo "python3 не найден по пути $PYTHON_BIN"
    return 1
  fi

  TARGET=""
  if [ -f "$RUN_SERVER" ]; then
    TARGET="$RUN_SERVER"
  elif [ -f "$APP_PY" ]; then
    TARGET="$APP_PY"
  else
    echo "Не найден ни run_server.py, ни app.py в $UI_DIR"
    return 1
  fi

  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "Сервис уже запущен (PID $(cat "$PID_FILE"))."
    return 0
  fi

  echo "Запуск Xkeen Web UI..."
  export MIHOMO_ROOT="/opt/etc/mihomo"
  export MIHOMO_VALIDATE_CMD='/opt/sbin/mihomo -t -d {root} -f {config}'
  export PYTHONUNBUFFERED=1

  # Optional env overrides persisted by DevTools
  ENV_FILE_DEFAULT="$UI_DIR/devtools.env"
  ENV_FILE="${XKEEN_UI_ENV_FILE:-$ENV_FILE_DEFAULT}"
  if [ -f "$ENV_FILE" ]; then
    # shellcheck disable=SC1090
    . "$ENV_FILE"
  fi

  # Re-resolve log dir after env overrides (DevTools can set XKEEN_LOG_DIR)
  LOG_DIR="${XKEEN_LOG_DIR:-$LOG_DIR_DEFAULT}"
  STDOUT_LOG="$LOG_DIR/stdout.log"
  STDERR_LOG="$LOG_DIR/stderr.log"
  mkdir -p "$LOG_DIR" 2>/dev/null || true

  nohup "$PYTHON_BIN" "$TARGET" >> "$STDOUT_LOG" 2>> "$STDERR_LOG" &
  echo $! > "$PID_FILE"
  echo "Запущено, PID $(cat "$PID_FILE")."
}

stop_service() {
  if [ -f "$PID_FILE" ]; then
    PID="$(cat "$PID_FILE")"
    if kill -0 "$PID" 2>/dev/null; then
      echo "Останавливаю Xkeen Web UI (PID $PID)..."
      kill "$PID" 2>/dev/null || true
      sleep 1
      if kill -0 "$PID" 2>/dev/null; then
        echo "Принудительное завершение процесса $PID..."
        kill -9 "$PID" 2>/dev/null || true
      fi
    fi
    rm -f "$PID_FILE"
  else
    pkill -f "$RUN_SERVER" 2>/dev/null || pkill -f "$APP_PY" 2>/dev/null || true
  fi
}

status_service() {
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "Xkeen Web UI запущен, PID $(cat "$PID_FILE")."
    return 0
  fi
  echo "Xkeen Web UI не запущен."
  return 1
}

case "$1" in
  start)
    start_service
    ;;
  stop)
    stop_service
    ;;
  restart)
    stop_service
    sleep 1
    start_service
    ;;
  status)
    status_service
    ;;
  *)
    echo "Использование: $0 {start|stop|restart|status}"
    exit 1
    ;;
esac

exit 0
EOF

chmod +x "$INIT_SCRIPT"

echo "[*] Запускаю сервис..."
"$INIT_SCRIPT" restart || true

echo "========================================"
echo "  ✔ Xkeen Web UI установлен"
echo "========================================"
PANEL_URL="http://<IP_роутера>:${PANEL_PORT}/"
printf '\033[1;32mОткрой в браузере:  %s\033[0m\n' "$PANEL_URL"
echo "Текущий порт панели: $PANEL_PORT"
echo "Файлы UI:           $UI_DIR"
echo "Init script:        $INIT_SCRIPT"
echo "Логи (install):     $LOG_DIR/xkeen-ui.log"
echo "Логи (runtime):     /opt/var/log/xkeen-ui/core.log (и access.log/ws.log)"
echo "========================================"

# --- ОЧИСТКА УСТАНОВОЧНЫХ ФАЙЛОВ ---

INSTALL_SRC_DIR="$SRC_DIR"
INSTALL_PARENT_DIR="$(dirname "$INSTALL_SRC_DIR")"

echo "[*] Очищаю установочные файлы..."

if [ -n "$INSTALL_PARENT_DIR" ] && [ -d "$INSTALL_PARENT_DIR" ]; then
  for ARCH in "$INSTALL_PARENT_DIR"/xkeen-ui*.tar.gz "$INSTALL_PARENT_DIR"/xkeen-ui-*.tar.gz; do
    [ -f "$ARCH" ] || continue
    echo "[*] Удаляю архив: $ARCH"
    rm -f "$ARCH" || echo "[!] Не удалось удалить архив $ARCH"
  done
fi

if [ "$INSTALL_SRC_DIR" != "$UI_DIR" ] && [ -d "$INSTALL_SRC_DIR" ]; then
  echo "[*] Удаляю временную директорию установки: $INSTALL_SRC_DIR"
  cd / || cd "$UI_DIR" || true
  rm -rf "$INSTALL_SRC_DIR" || echo "[!] Не удалось удалить директорию $INSTALL_SRC_DIR"
fi

#!/bin/sh
set -e

UI_DIR="/opt/etc/xkeen-ui"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
INIT_DIR="/opt/etc/init.d"
INIT_SCRIPT="$INIT_DIR/S99xkeen-ui"
PYTHON_BIN="/opt/bin/python3"
LOG_DIR="/opt/var/log"
RUN_DIR="/opt/var/run"

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

# Файлы/директории Xray (используются панелью, но сами не трогаются)
ROUTING_FILE="/opt/etc/xray/configs/05_routing.json"
INBOUNDS_FILE="/opt/etc/xray/configs/03_inbounds.json"
OUTBOUNDS_FILE="/opt/etc/xray/configs/04_outbounds.json"
BACKUP_DIR="/opt/etc/xray/configs/backups"

DEFAULT_PORT=8088
ALT_PORT=8091

# Максимальное количество попыток выполнения opkg. Если переменная не задана извне — используется значение по умолчанию (3)
: "${OPKG_MAX_RETRIES:=3}"

# Задержка в секундах между повторными попытками opkg. Используется только при неудачной попытке, по умолчанию 5 секунд
: "${OPKG_RETRY_DELAY:=5}"

echo "========================================"
echo "  Xkeen Web UI — УСТАНОВКА"
echo "========================================"

# --- OPKG ---
opkg_retry() {
  OPKG_ACTION="$1"   # Действие opkg: install / update / remove / upgrade
  shift              # Убираем действие из аргументов

  if [ -z "${OPKG_BIN:-}" ]; then
    echo "[!] OPKG_BIN не задан для opkg_retry." >&2
    return 1
  fi

  if [ -z "$OPKG_ACTION" ]; then
    echo "[!] Не указано действие opkg." >&2
    return 2
  fi

  local TRY=1     # Номер текущей попытки
  local RC=0      # Код возврата последнего вызова opkg
  local OUTPUT    # Захваченный stdout+stderr opkg для логирования и проксирования


  while [ "$TRY" -le "$OPKG_MAX_RETRIES" ]; do
    OUTPUT="$("$OPKG_BIN" "$OPKG_ACTION" "$@" 2>&1)"
    RC=$?

    if [ "$RC" -eq 0 ]; then
      printf '%s\n' "$OUTPUT"
      return 0
    fi

    # Если есть текст ошибки opkg - выводим его
    [ -n "$OUTPUT" ] && printf '%s\n' "$OUTPUT" >&2

    if [ "$TRY" -lt "$OPKG_MAX_RETRIES" ]; then
      echo "[!] Повтор через ${OPKG_RETRY_DELAY}с (rc=$RC, попытка $TRY/$OPKG_MAX_RETRIES)..." >&2
      sleep "$OPKG_RETRY_DELAY" 2>/dev/null || true
    fi

    TRY=$((TRY + 1))
  done

  return "$RC"
}

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

  if ! opkg_retry update; then
    echo "[!] Не удалось выполнить 'opkg update'."
    exit 1
  fi

  if ! opkg_retry install python3; then
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

  if ! opkg_retry update; then
    echo "[!] Не удалось выполнить 'opkg update' при установке зависимостей."
    exit 1
  fi

  if ! opkg_retry install python3 python3-pip; then
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

  if ! opkg_retry update; then
    echo "[!] Не удалось выполнить 'opkg update' при установке lftp."
    exit 1
  fi

  if ! opkg_retry install lftp; then
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
    netstat -tln 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]${PORT_CHECK}$"
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

# --- Создание директорий ---
echo "[*] Создаю директории..."
mkdir -p "$UI_DIR" "$INIT_DIR" "$LOG_DIR" "$RUN_DIR" "$BACKUP_DIR"

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

echo "[*] Копирую файлы панели в $UI_DIR..."
if command -v rsync >/dev/null 2>&1; then
  rsync -a "$SRC_DIR"/ "$UI_DIR"/ --exclude "install.sh"
else
  cp -r "$SRC_DIR"/* "$UI_DIR"/ 2>/dev/null || true
  cp -r "$SRC_DIR"/.[!.]* "$UI_DIR"/ 2>/dev/null || true
  rm -f "$UI_DIR/install.sh"
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

for ARCHIVE in "$INSTALL_PARENT_DIR"/xkeen-ui*.tar.gz "$INSTALL_PARENT_DIR"/xkeen-ui-*.tar.gz; do
  [ -f "$ARCHIVE" ] || continue
  echo "[*] Удаляю архив: $ARCHIVE"
  rm -f "$ARCHIVE" || echo "[!] Не удалось удалить архив $ARCHIVE"
done

if [ "$INSTALL_SRC_DIR" != "$UI_DIR" ] && [ -d "$INSTALL_SRC_DIR" ]; then
  echo "[*] Удаляю временную директорию установки: $INSTALL_SRC_DIR"
  cd / || cd "$UI_DIR" || true
  rm -rf "$INSTALL_SRC_DIR" || echo "[!] Не удалось удалить директорию $INSTALL_SRC_DIR"
fi

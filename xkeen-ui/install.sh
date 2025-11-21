#!/bin/sh
set -e

UI_DIR="/opt/etc/xkeen-ui"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
INIT_DIR="/opt/etc/init.d"
INIT_SCRIPT="$INIT_DIR/S99xkeen-ui"
PYTHON_BIN="/opt/bin/python3"
LOG_DIR="/opt/var/log"
RUN_DIR="/opt/var/run"

MIHOMO_TEMPLATES_DIR="/opt/etc/mihomo/templates"
SRC_MIHOMO_TEMPLATES="$SRC_DIR/opt/etc/mihomo/templates"

# Файлы/директории Xray (используются панелью, но сами не трогаются)
ROUTING_FILE="/opt/etc/xray/configs/05_routing.json"
INBOUNDS_FILE="/opt/etc/xray/configs/03_inbounds.json"
OUTBOUNDS_FILE="/opt/etc/xray/configs/04_outbounds.json"
BACKUP_DIR="/opt/etc/xray/configs/backups"

DEFAULT_PORT=8088
ALT_PORT=8091

echo "========================================"
echo "  Xkeen Web UI — УСТАНОВКА"
echo "========================================"

# Проверка наличия Python + автоустановка через Entware при отсутствии
if [ ! -x "$PYTHON_BIN" ]; then
  echo "[*] Python3 не найден по пути $PYTHON_BIN."
  echo "[*] Пытаюсь установить python3 через Entware (opkg)..."

  # Пытаемся найти opkg
  if command -v opkg >/dev/null 2>&1; then
    OPKG_BIN="$(command -v opkg)"
  elif [ -x "/opt/bin/opkg" ]; then
    OPKG_BIN="/opt/bin/opkg"
  else
    echo "[!] Не найден пакетный менеджер opkg Entware."
    echo "    Установи Entware и python3 вручную, затем запусти установщик ещё раз."
    exit 1
  fi

  # Обновляем списки пакетов и ставим python3
  if ! "$OPKG_BIN" update; then
    echo "[!] Не удалось выполнить 'opkg update'."
    echo "    Проверь подключение к интернету и репозитории Entware."
    exit 1
  fi

  if ! "$OPKG_BIN" install python3; then
    echo "[!] Установка python3 через opkg завершилась с ошибкой."
    echo "    Попробуй установить python3 вручную, затем перезапусти установщик."
    exit 1
  fi
fi

# Финальная проверка, что python3 появился
if [ ! -x "$PYTHON_BIN" ]; then
  echo "[!] Python3 по пути $PYTHON_BIN не найден даже после установки."
  echo "    Проверь установку python3 в Entware и путь к бинарнику."
  exit 1
fi

# Функция проверки использования порта
is_port_in_use() {
  PORT_CHECK="$1"
  if command -v netstat >/dev/null 2>&1; then
    netstat -tln 2>/dev/null | awk '{print $4}' | grep -q ":${PORT_CHECK}$"
  else
    # Если netstat недоступен, считаем, что порт свободен
    return 1
  fi
}

# Функция создания бэкапа конфиг-файла
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

# Пытаемся обнаружить уже установленную панель и её порт
EXISTING_APP="$UI_DIR/app.py"
EXISTING_PORT=""
FIRST_INSTALL="no"

if [ -f "$EXISTING_APP" ]; then
  EXISTING_PORT=$(grep -E 'app.run\(.*port *= *[0-9]+' "$EXISTING_APP" 2>/dev/null | \
    sed -E 's/.*port *= *([0-9]+).*/\1/' | tail -n 1 || true)
else
  FIRST_INSTALL="yes"
fi

if [ -n "$EXISTING_PORT" ]; then
  PANEL_PORT="$EXISTING_PORT"
  echo "[*] Обнаружена существующая установка, сохраняю порт: $PANEL_PORT"
  echo "[install] Текущий порт панели: $PANEL_PORT" >> "$LOG_DIR/xkeen-ui.log"
else
  # Выбираем порт заново (первая установка или не удалось прочитать порт)
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
        echo "    Установщик не может автоматически подобрать порт."
        exit 1
      fi
    fi
  fi
  echo "[*] Выбран порт панели: $PANEL_PORT"
  echo "[install] Текущий порт панели: $PANEL_PORT" >> "$LOG_DIR/xkeen-ui.log"
fi

# На самой первой установке делаем автоматические бэкапы конфигов Xray
if [ "$FIRST_INSTALL" = "yes" ]; then
  echo "[*] Первая установка: создаю бэкапы конфигов Xray в $BACKUP_DIR..."
  backup_config_file "$ROUTING_FILE"
  backup_config_file "$INBOUNDS_FILE"
  backup_config_file "$OUTBOUNDS_FILE"
else
  echo "[*] Это не первая установка, автоматические бэкапы конфигов пропущены."
fi

echo "[*] Создаю директории..."
mkdir -p "$UI_DIR" "$INIT_DIR" "$LOG_DIR" "$RUN_DIR" "$BACKUP_DIR"

echo "[*] Копирую файлы панели в $UI_DIR..."
# Копируем всё содержимое каталога xkeen-ui, кроме самого install.sh (чтобы не путать)
if command -v rsync >/dev/null 2>&1; then
  rsync -a "$SRC_DIR"/ "$UI_DIR"/ --exclude "install.sh"
else
  cp -r "$SRC_DIR"/* "$UI_DIR"/ 2>/dev/null || true
  cp -r "$SRC_DIR"/.[!.]* "$UI_DIR"/ 2>/dev/null || true
  rm -f "$UI_DIR/install.sh"
fi

# Если вместе с панелью пришли шаблоны Mihomo — скопируем их в системный каталог,
# не перезаписывая уже существующие.
if [ -d "$SRC_MIHOMO_TEMPLATES" ]; then
  echo "[*] Обновляю шаблоны Mihomo в $MIHOMO_TEMPLATES_DIR..."
  mkdir -p "$MIHOMO_TEMPLATES_DIR"
  for f in "$SRC_MIHOMO_TEMPLATES"/*.yaml "$SRC_MIHOMO_TEMPLATES"/*.yml; do
    [ -e "$f" ] || continue
    base=$(basename "$f")
    dest="$MIHOMO_TEMPLATES_DIR/$base"
    if [ -f "$dest" ]; then
      echo "[*] Шаблон $base уже существует, пропускаю."
    else
      cp "$f" "$dest"
      echo "[*] Скопирован шаблон $base в $MIHOMO_TEMPLATES_DIR"
    fi
  done
fi


APP_FILE="$UI_DIR/app.py"

if [ ! -f "$APP_FILE" ]; then
  echo "[!] Не найден app.py в $APP_FILE"
  exit 1
fi

echo "[*] Обновляю порт в app.py..."
# Меняем порт только если в файле есть app.run(...)
if grep -q 'app.run' "$APP_FILE"; then
  # Универсальная замена числа после port=
  sed -i -E "s/(app.run\([^)]*port *= *)[0-9]+/\1${PANEL_PORT}/" "$APP_FILE"
else
  echo "[!] Внимание: не удалось найти 'app.run' в app.py"
  echo "    Порт может остаться по умолчанию, проверь вручную."
fi

echo "[*] Создаю init-скрипт $INIT_SCRIPT..."

cat > "$INIT_SCRIPT" << 'EOF'
#!/bin/sh

ENABLED=yes
UI_DIR="/opt/etc/xkeen-ui"
PYTHON_BIN="/opt/bin/python3"
APP_PY="$UI_DIR/app.py"
LOG_FILE="/opt/var/log/xkeen-ui.log"
PID_FILE="/opt/var/run/xkeen-ui.pid"

start_service() {
  if [ ! -x "$PYTHON_BIN" ]; then
    echo "python3 не найден по пути $PYTHON_BIN"
    return 1
  fi

  if [ ! -f "$APP_PY" ]; then
    echo "app.py не найден по пути $APP_PY"
    return 1
  fi

  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "Сервис уже запущен (PID $(cat "$PID_FILE"))."
    return 0
  fi

  echo "Запуск Xkeen Web UI..."
  nohup "$PYTHON_BIN" "$APP_PY" >> "$LOG_FILE" 2>&1 &
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
    pkill -f "$APP_PY" 2>/dev/null || true
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
echo "Логи:               $LOG_DIR/xkeen-ui.log"
echo "========================================"

# --- ОЧИСТКА УСТАНОВОЧНЫХ ФАЙЛОВ ---

INSTALL_SRC_DIR="$SRC_DIR"
INSTALL_PARENT_DIR="$(dirname "$INSTALL_SRC_DIR")"

echo "[*] Очищаю установочные файлы..."

# Удаляем архив(ы) вида xkeen-ui*.tar.gz / xkeen-ui-*.tar.gz в родительской директории установщика
if [ -n "$INSTALL_PARENT_DIR" ] && [ -d "$INSTALL_PARENT_DIR" ]; then
  for ARCH in "$INSTALL_PARENT_DIR"/xkeen-ui*.tar.gz "$INSTALL_PARENT_DIR"/xkeen-ui-*.tar.gz; do
    [ -f "$ARCH" ] || continue
    echo "[*] Удаляю архив: $ARCH"
    rm -f "$ARCH" || echo "[!] Не удалось удалить архив $ARCH"
  done
fi

# Удаляем исходную директорию с установщиком, если это не рабочая директория панели
if [ "$INSTALL_SRC_DIR" != "$UI_DIR" ] && [ -d "$INSTALL_SRC_DIR" ]; then
  echo "[*] Удаляю временную директорию установки: $INSTALL_SRC_DIR"
  # Меняем текущую директорию, чтобы можно было удалить INSTALL_SRC_DIR
  cd / || cd "$UI_DIR" || true
  rm -rf "$INSTALL_SRC_DIR" || echo "[!] Не удалось удалить директорию $INSTALL_SRC_DIR"
fi

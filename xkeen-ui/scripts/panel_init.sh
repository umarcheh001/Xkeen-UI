#!/bin/sh

# Xkeen UI dedicated init script.
XKEEN_UI_INIT_OWNER="umarcheh001/Xkeen-UI"
ENABLED=yes
UI_DIR="/opt/etc/xkeen-ui"
PYTHON_BIN="/opt/bin/python3"
RUN_SERVER="$UI_DIR/run_server.py"
APP_PY="$UI_DIR/app.py"
PANEL_PORT="__XKEEN_UI_PORT__"
PYTHONPYCACHEPREFIX="${XKEEN_UI_PYTHONPYCACHEPREFIX:-/tmp/xkeen-ui-pycache}"

LOG_DIR_DEFAULT="/opt/var/log/xkeen-ui"
LOG_DIR="$LOG_DIR_DEFAULT"
STDOUT_LOG="$LOG_DIR/stdout.log"
STDERR_LOG="$LOG_DIR/stderr.log"
PID_FILE="/opt/var/run/xkeen-ui.pid"

audit_boot() {
  # Lightweight diagnostic log so users can debug boot-time autostart failures
  # without re-running install.sh. Survives reboot, no rotation (small file).
  echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> /opt/var/log/xkeen-ui-boot.log 2>/dev/null || true
}

warm_bytecode_cache() {
  # Кэш байткода живёт в PYTHONPYCACHEPREFIX, то есть в tmpfs, и перезагрузка
  # роутера стирает его целиком. Импорты у панели ленивые, поэтому часть
  # компиляции 226 модулей достаётся первому человеку, открывшему страницу
  # (замер на ARMv8: 2,9 с вхолодную против 0,23 с с готовым кэшем; на слабых
  # роутерах кратно больше). Догоняем это фоном, пока страницу ещё не открыли.
  #
  # Прогрев только ускоряет и не имеет права помешать запуску: любая его
  # неудача гасится, а сам он уходит в фон и уступает процессор панели.
  NICE_BIN=""
  command -v nice >/dev/null 2>&1 && NICE_BIN="nice -n 19"
  (
    $NICE_BIN "$PYTHON_BIN" -m compileall -q "$UI_DIR" >/dev/null 2>&1       && audit_boot "[start] bytecode cache warmed"       || audit_boot "[start] bytecode warmup skipped (non-fatal)"
  # Перенаправлять надо всю подоболочку, а не только compileall: фоновая
  # задача наследует stdout/stderr родителя и держит их открытыми, а тогда
  # rc.unslung при загрузке ждёт конца компиляции вместо мгновенного возврата.
  ) > /dev/null 2>&1 < /dev/null &
}

start_service() {
  # Entware's rc.unslung calls S99 scripts very early at boot, before
  # /opt/etc/profile has been sourced for the user shell. Pull it in so
  # PATH/LD_LIBRARY_PATH point at /opt/{bin,sbin,lib} and Python's native
  # extensions can dlopen() Entware libraries.
  [ -f "/opt/etc/profile" ] && . /opt/etc/profile >/dev/null 2>&1 || true
  # Bypass potentially truncated Entware stdlib bytecode after interrupted
  # upgrades. Keep the cache in a writable, panel-specific directory.
  export PYTHONPYCACHEPREFIX
  mkdir -p "$PYTHONPYCACHEPREFIX" 2>/dev/null || true
  case ":$PATH:" in
    *":/opt/bin:"*) ;;
    *) PATH="/opt/bin:/opt/sbin:$PATH"; export PATH ;;
  esac

  # Make sure runtime dirs exist before we touch them. /opt/var/run can be
  # missing on a fresh Entware install, which would silently lose the PID
  # file and make every subsequent stop/restart a no-op.
  mkdir -p "/opt/var/run" "/opt/var/log" 2>/dev/null || true

  audit_boot "[start] begin (caller=$(ps -o comm= -p $PPID 2>/dev/null), arg=${1:-start})"

  # USB-mounted /opt sometimes lags the init.d invocation by a few seconds
  # on Keenetic. Wait up to 30s for python3 instead of failing immediately.
  i=0
  while [ ! -x "$PYTHON_BIN" ] && [ "$i" -lt 30 ]; do
    sleep 1
    i=$((i + 1))
  done
  if [ ! -x "$PYTHON_BIN" ]; then
    audit_boot "[start] abort: python3 missing at $PYTHON_BIN after ${i}s"
    echo "python3 не найден по пути $PYTHON_BIN"
    return 1
  fi
  [ "$i" -gt 0 ] && audit_boot "[start] python3 became available after ${i}s wait"

  # Wait for the target script for the same reason.
  TARGET=""
  j=0
  while [ -z "$TARGET" ] && [ "$j" -lt 30 ]; do
    if [ -f "$RUN_SERVER" ]; then
      TARGET="$RUN_SERVER"
    elif [ -f "$APP_PY" ]; then
      TARGET="$APP_PY"
    else
      sleep 1
      j=$((j + 1))
    fi
  done
  if [ -z "$TARGET" ]; then
    audit_boot "[start] abort: neither $RUN_SERVER nor $APP_PY exists after ${j}s"
    echo "Не найден ни run_server.py, ни app.py в $UI_DIR"
    return 1
  fi
  [ "$j" -gt 0 ] && audit_boot "[start] target became available after ${j}s wait"
  audit_boot "[start] target=$TARGET"

  # >>> module-operation-recovery
  # Установку или удаление модуля ведёт отдельный процесс. Если он погиб
  # посреди работы (пропало питание), часть файлов панели уже заменена, и
  # вернуть прежние некому, кроме нас: делаем это до запуска панели. Пока
  # операция жива (она сама перезапускает панель через этот скрипт),
  # recover ничего не трогает. Без незавершённой операции это одна
  # проверка каталога — Python не стартует, загрузка не замедляется.
  MODULE_TX_ROOT="$UI_DIR.module-transactions"
  if [ -d "$MODULE_TX_ROOT" ] && [ -n "$(ls -A "$MODULE_TX_ROOT" 2>/dev/null)" ] \
      && [ -f "$UI_DIR/scripts/module_transaction.py" ]; then
    audit_boot "[start] unfinished module operation found, recovering"
    # Ждём не дольше двух минут: зависший накопитель не должен оставить
    # роутер без панели и задержать остальные скрипты загрузки. Прерванный
    # возврат файлов безопасен — следующий запуск продолжит его с начала.
    "$PYTHON_BIN" "$UI_DIR/scripts/module_transaction.py" recover \
      --panel-root "$UI_DIR" --state-dir "$UI_DIR" >/dev/null 2>&1 &
    MODULE_TX_PID=$!
    MODULE_TX_WAIT=0
    MODULE_TX_LIMIT="${XKEEN_UI_MODULE_TX_RECOVER_TIMEOUT:-120}"
    while kill -0 "$MODULE_TX_PID" 2>/dev/null && [ "$MODULE_TX_WAIT" -lt "$MODULE_TX_LIMIT" ]; do
      sleep 1
      MODULE_TX_WAIT=$((MODULE_TX_WAIT + 1))
    done
    if kill -0 "$MODULE_TX_PID" 2>/dev/null; then
      kill -9 "$MODULE_TX_PID" 2>/dev/null || true
      audit_boot "[start] module operation recovery timed out after ${MODULE_TX_WAIT}s (non-fatal)"
    fi
    wait "$MODULE_TX_PID" 2>/dev/null \
      || audit_boot "[start] module operation recovery did not finish cleanly (non-fatal)"
  fi
  # <<< module-operation-recovery

  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE" 2>/dev/null)" 2>/dev/null; then
    audit_boot "[start] already running, PID $(cat "$PID_FILE")"
    echo "Сервис уже запущен (PID $(cat "$PID_FILE"))."
    return 0
  fi

  # Stale PID file from a previous boot — clean it up so status/stop work.
  if [ -f "$PID_FILE" ]; then
    audit_boot "[start] removing stale pid file (was $(cat "$PID_FILE" 2>/dev/null))"
    rm -f "$PID_FILE"
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

  # Keep the selected installer port stable across updates even when
  # run_server.py reads it from env instead of a hard-coded literal.
  export XKEEN_UI_PORT="${XKEEN_UI_PORT:-$PANEL_PORT}"

  # Re-resolve log dir after env overrides (DevTools can set XKEEN_LOG_DIR).
  # Fall back to /tmp if the chosen dir is not writable — otherwise the
  # nohup redirect below silently drops both stdout and stderr.
  LOG_DIR="${XKEEN_LOG_DIR:-$LOG_DIR_DEFAULT}"
  if ! mkdir -p "$LOG_DIR" 2>/dev/null; then
    audit_boot "[start] mkdir $LOG_DIR failed, falling back to /tmp"
    LOG_DIR="/tmp"
  fi
  STDOUT_LOG="$LOG_DIR/stdout.log"
  STDERR_LOG="$LOG_DIR/stderr.log"

  if ! command -v nohup >/dev/null 2>&1; then
    audit_boot "[start] nohup missing, attempting opkg install coreutils-nohup"
    echo "Команда nohup не найдена. Пытаюсь установить пакет coreutils-nohup..."
    if command -v opkg >/dev/null 2>&1; then
      opkg update || true
      if ! opkg install coreutils-nohup; then
        audit_boot "[start] opkg install coreutils-nohup failed"
        echo "Не удалось установить coreutils-nohup автоматически."
        echo "Установите пакет вручную: opkg install coreutils-nohup"
        return 1
      fi
      if ! command -v nohup >/dev/null 2>&1; then
        audit_boot "[start] nohup still missing after opkg install"
        echo "Пакет coreutils-nohup установлен, но команда nohup по-прежнему недоступна."
        echo "Проверьте PATH или установите пакет вручную: opkg install coreutils-nohup"
        return 1
      fi
    else
      audit_boot "[start] nohup missing and opkg unavailable"
      echo "Команда nohup не найдена, и opkg недоступен для автоустановки."
      echo "Установите пакет вручную: opkg install coreutils-nohup"
      return 1
    fi
  fi

  audit_boot "[start] spawn: $PYTHON_BIN $TARGET (port=$XKEEN_UI_PORT, log=$LOG_DIR)"
  # `< /dev/null` keeps Python detached from the controlling tty so it
  # survives even when rc.unslung's stdin is closed mid-boot.
  nohup "$PYTHON_BIN" "$TARGET" >> "$STDOUT_LOG" 2>> "$STDERR_LOG" < /dev/null &
  CHILD_PID=$!
  echo "$CHILD_PID" > "$PID_FILE" 2>/dev/null || true

  # Catch the common case where Python imports fail at boot (e.g. gevent's
  # native extension can't find Entware libs). Without this check we'd
  # report success even though the panel never bound to its port.
  sleep 1
  if kill -0 "$CHILD_PID" 2>/dev/null; then
    audit_boot "[start] OK, PID $CHILD_PID"
    warm_bytecode_cache
    echo "Запущено, PID $CHILD_PID."
    return 0
  else
    audit_boot "[start] child PID $CHILD_PID died within 1s; tail $STDERR_LOG for cause"
    echo "Не удалось запустить процесс. Смотри логи: $STDERR_LOG"
    rm -f "$PID_FILE"
    return 1
  fi
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

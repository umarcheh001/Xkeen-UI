#!/bin/sh
set -e

UI_DIR="/opt/etc/xkeen-ui"
INIT_SCRIPT_DEFAULT="/opt/etc/init.d/S99xkeen-ui-umarcheh001"
LEGACY_INIT_SCRIPT="/opt/etc/init.d/S99xkeen-ui"
INIT_SCRIPT="${XKEEN_UI_INIT_SCRIPT:-$INIT_SCRIPT_DEFAULT}"
LOG_DIR="/opt/var/log/xkeen-ui"
CORE_LOG="$LOG_DIR/core.log"
ACCESS_LOG="$LOG_DIR/access.log"
WS_LOG="$LOG_DIR/ws.log"
RUN_PID="/opt/var/run/xkeen-ui.pid"
RESTART_LOG="/opt/etc/xkeen-ui/restart.log"

is_our_ui_init_script() {
  _path="$1"
  [ -n "$_path" ] || return 1
  [ -f "$_path" ] || return 1

  if grep -q 'XKEEN_UI_INIT_OWNER="umarcheh001/Xkeen-UI"' "$_path" 2>/dev/null; then
    return 0
  fi

  if grep -q 'UI_DIR="/opt/etc/xkeen-ui"' "$_path" 2>/dev/null; then
    if grep -q 'RUN_SERVER="\$UI_DIR/run_server.py"' "$_path" 2>/dev/null || \
       grep -q 'APP_PY="\$UI_DIR/app.py"' "$_path" 2>/dev/null; then
      return 0
    fi
  fi

  return 1
}

resolve_our_ui_init_script() {
  if [ -x "$INIT_SCRIPT" ] && is_our_ui_init_script "$INIT_SCRIPT"; then
    echo "$INIT_SCRIPT"
    return 0
  fi
  if [ "$INIT_SCRIPT_DEFAULT" != "$INIT_SCRIPT" ] && [ -x "$INIT_SCRIPT_DEFAULT" ] && is_our_ui_init_script "$INIT_SCRIPT_DEFAULT"; then
    echo "$INIT_SCRIPT_DEFAULT"
    return 0
  fi
  if [ "$LEGACY_INIT_SCRIPT" != "$INIT_SCRIPT" ] && [ -x "$LEGACY_INIT_SCRIPT" ] && is_our_ui_init_script "$LEGACY_INIT_SCRIPT"; then
    echo "$LEGACY_INIT_SCRIPT"
    return 0
  fi
  return 1
}

echo "========================================"
echo "  Xkeen Web UI — УДАЛЕНИЕ"
echo "========================================"

ACTIVE_INIT_SCRIPT="$(resolve_our_ui_init_script || true)"
if [ -n "$ACTIVE_INIT_SCRIPT" ] && [ -x "$ACTIVE_INIT_SCRIPT" ]; then
  echo "[*] Останавливаю сервис..."
  "$ACTIVE_INIT_SCRIPT" stop || true
fi

if [ -f "$RUN_PID" ]; then
  PID="$(cat "$RUN_PID" 2>/dev/null || true)"
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    echo "[*] Останавливаю процесс по PID-файлу..."
    kill "$PID" 2>/dev/null || true
    sleep 1
    if kill -0 "$PID" 2>/dev/null; then
      kill -9 "$PID" 2>/dev/null || true
    fi
  fi
fi

echo "[*] Удаляю файлы UI..."
rm -rf "$UI_DIR"

echo "[*] Удаляю init-скрипт..."
for script in "$INIT_SCRIPT" "$INIT_SCRIPT_DEFAULT" "$LEGACY_INIT_SCRIPT"; do
  [ -n "$script" ] || continue
  [ -f "$script" ] || continue
  if is_our_ui_init_script "$script"; then
    rm -f "$script" 2>/dev/null || true
  fi
done

echo "[*] Удаляю PID (по желанию)..."
rm -f "$RUN_PID"

echo "[*] При необходимости можно удалить логи и журнал перезапуска вручную:"
echo "    $CORE_LOG"
echo "    $ACCESS_LOG"
echo "    $WS_LOG"
echo "    $RESTART_LOG"

echo "========================================"
echo "  ✔ Xkeen Web UI удалён"
echo "========================================"

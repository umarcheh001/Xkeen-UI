#!/bin/sh
set -e

UI_DIR="/opt/etc/xkeen-ui"
INIT_SCRIPT="/opt/etc/init.d/S99xkeen-ui"
LOG_DIR="/opt/var/log/xkeen-ui"
CORE_LOG="$LOG_DIR/core.log"
ACCESS_LOG="$LOG_DIR/access.log"
WS_LOG="$LOG_DIR/ws.log"
RUN_PID="/opt/var/run/xkeen-ui.pid"
RESTART_LOG="/opt/etc/xkeen-ui/restart.log"

echo "========================================"
echo "  Xkeen Web UI — УДАЛЕНИЕ"
echo "========================================"

if [ -x "$INIT_SCRIPT" ]; then
  echo "[*] Останавливаю сервис..."
  "$INIT_SCRIPT" stop || true
fi

echo "[*] Удаляю файлы UI..."
rm -rf "$UI_DIR"

echo "[*] Удаляю init-скрипт..."
rm -f "$INIT_SCRIPT"

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

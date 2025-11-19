#!/bin/sh
set -e

UI_DIR="/opt/etc/xkeen-ui"
INIT_SCRIPT="/opt/etc/init.d/S99xkeen-ui"
LOG_FILE="/opt/var/log/xkeen-ui.log"
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

echo "[*] При необходимости можно удалить лог и журнал перезапуска вручную:"
echo "    $LOG_FILE"
echo "    $RESTART_LOG"

echo "========================================"
echo "  ✔ Xkeen Web UI удалён"
echo "========================================"

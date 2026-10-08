#!/bin/sh
set -e

# Удаление панели Xkeen UI. После него на роутере не остаётся ничего, что
# принадлежит панели: ни файлов, ни службы, ни команд в /opt/bin, ни журналов,
# ни служебных каталогов в /opt/var и /tmp.
#
# Не трогается то, чем пользуются Xray, Mihomo и сам роутер: их конфиги и
# резервные копии конфигов, DAT-файлы и ссылки на них, пакеты Entware и Python.
# Корзина файлового менеджера и резервные копии конфигов — данные владельца:
# они остаются, пока удаление не запущено с ключом --purge.
#
#   sh uninstall.sh            убрать панель
#   sh uninstall.sh --purge    убрать панель, корзину и резервные копии конфигов

# Для проверок: все пути ниже строятся от этого корня (на роутере он пуст).
ROOT="${XKEEN_UI_UNINSTALL_ROOT:-}"

UI_DIR="$ROOT/opt/etc/xkeen-ui"
INIT_SCRIPT_DEFAULT="$ROOT/opt/etc/init.d/S99xkeen-ui-umarcheh001"
LEGACY_INIT_SCRIPT="$ROOT/opt/etc/init.d/S99xkeen-ui"
INIT_SCRIPT="${XKEEN_UI_INIT_SCRIPT:-$INIT_SCRIPT_DEFAULT}"
VAR_LOG="$ROOT/opt/var/log"
LOG_DIR_DEFAULT="$VAR_LOG/xkeen-ui"
RUN_PID="$ROOT/opt/var/run/xkeen-ui.pid"
BIN_DIR="$ROOT/opt/bin"
TMP_DIR="$ROOT/tmp"
STATE_DIR_DEFAULT="$ROOT/opt/var/lib/xkeen-ui"
BACKUP_DIR_DEFAULT="$ROOT/opt/var/backups/xkeen-ui"
TRASH_DIR_DEFAULT="$ROOT/opt/var/trash"
MIHOMO_TEMPLATES_DIR="$ROOT/opt/etc/mihomo/templates"
XRAY_BACKUP_DIR="$ROOT/opt/etc/xray/configs/backups"

PURGE=0
for arg in "$@"; do
  case "$arg" in
    --purge) PURGE=1 ;;
  esac
done
[ "${XKEEN_UI_UNINSTALL_PURGE:-0}" = "1" ] && PURGE=1

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

env_setting() {
  # Значение переменной из devtools.env панели: владелец мог перенести журналы
  # и служебные каталоги в другое место. Файл не исполняется, только читается.
  [ -f "$UI_DIR/devtools.env" ] || return 0
  sed -n "s/^[[:space:]]*\(export[[:space:]][[:space:]]*\)\{0,1\}$1=[\"']\{0,1\}\([^\"']*\)[\"']\{0,1\}[[:space:]]*$/\2/p" \
    "$UI_DIR/devtools.env" 2>/dev/null | tail -n 1
}

remove_tree() {
  # Каталог со всем содержимым; пустое имя и корень не принимаются.
  case "$1" in
    ''|/|"$ROOT"|"$ROOT/") return 0 ;;
  esac
  [ -e "$1" ] || [ -L "$1" ] || return 0
  rm -rf "$1" 2>/dev/null || echo "[!] Не удалось удалить $1"
}

remove_moved_dir() {
  # Каталог, который владелец перенёс настройкой. Чужое место не стираем
  # целиком: удаляется только каталог, в имени которого есть имя панели.
  [ -n "$1" ] || return 0
  [ "$1" = "$2" ] && return 0
  case "$1" in
    *xkeen-ui*) remove_tree "$ROOT$1" ;;
    *) LEFT="$LEFT
    $1 (перенесённый каталог панели: в имени нет xkeen-ui, проверьте вручную)" ;;
  esac
}

LEFT=""

echo "========================================"
echo "  Xkeen Web UI — УДАЛЕНИЕ"
echo "========================================"

# Куда владелец перенёс каталоги панели — читаем, пока файл настроек ещё цел.
CUSTOM_LOG_DIR="$(env_setting XKEEN_LOG_DIR)"
CUSTOM_UPDATE_DIR="$(env_setting XKEEN_UI_UPDATE_DIR)"
CUSTOM_BACKUP_DIR="$(env_setting XKEEN_UI_BACKUP_DIR)"
CUSTOM_REMOTEFS_DIR="$(env_setting XKEEN_REMOTEFM_STATE_DIR)"
CUSTOM_TRASH_DIR="$(env_setting XKEEN_TRASH_DIR)"
CUSTOM_PYCACHE_DIR="$(env_setting XKEEN_UI_PYTHONPYCACHEPREFIX)"

ACTIVE_INIT_SCRIPT="$(resolve_our_ui_init_script || true)"
if [ -n "$ACTIVE_INIT_SCRIPT" ] && [ -x "$ACTIVE_INIT_SCRIPT" ] && [ -z "$ROOT" ]; then
  echo "[*] Останавливаю сервис..."
  "$ACTIVE_INIT_SCRIPT" stop || true
fi

if [ -f "$RUN_PID" ] && [ -z "$ROOT" ]; then
  PID="$(cat "$RUN_PID" 2>/dev/null || true)"
  # Номер из файла переживает перезагрузку и может достаться чужому процессу.
  case "$PID" in
    ''|*[!0-9]*) PID="" ;;
  esac
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null \
      && tr '\000' ' ' < "/proc/$PID/cmdline" 2>/dev/null | grep -q "$UI_DIR/"; then
    echo "[*] Останавливаю процесс по PID-файлу..."
    kill "$PID" 2>/dev/null || true
    sleep 1
    if kill -0 "$PID" 2>/dev/null; then
      kill -9 "$PID" 2>/dev/null || true
    fi
  fi
fi

echo "[*] Удаляю команды панели из /opt/bin..."
# Обёртку узнаём по тому, что она запускает скрипт из каталога панели:
# одноимённую чужую команду не трогаем.
for command in sysmon entware-backup storage-dashboard io-monitor device-locks memory-check version-check backup-monitor; do
  wrapper="$BIN_DIR/$command"
  [ -f "$wrapper" ] || continue
  if grep -q '^SCRIPT=".*/xkeen-ui/tools/' "$wrapper" 2>/dev/null; then
    rm -f "$wrapper" 2>/dev/null || echo "[!] Не удалось удалить $wrapper"
  fi
done

echo "[*] Удаляю встроенные шаблоны Mihomo..."
# Только те, что совпадают с шаблонами панели: изменённый или свой шаблон
# владельца остаётся.
BUNDLED_MIHOMO_TEMPLATES="$UI_DIR/opt/etc/mihomo/templates"
if [ -d "$BUNDLED_MIHOMO_TEMPLATES" ] && [ -d "$MIHOMO_TEMPLATES_DIR" ]; then
  for bundled in "$BUNDLED_MIHOMO_TEMPLATES"/*; do
    [ -f "$bundled" ] || continue
    installed="$MIHOMO_TEMPLATES_DIR/$(basename "$bundled")"
    if [ -f "$installed" ] && cmp -s "$bundled" "$installed" 2>/dev/null; then
      rm -f "$installed" 2>/dev/null || true
    fi
  done
  rmdir "$MIHOMO_TEMPLATES_DIR" 2>/dev/null || true
  if [ -d "$MIHOMO_TEMPLATES_DIR" ]; then
    LEFT="$LEFT
    $MIHOMO_TEMPLATES_DIR (шаблоны Mihomo, изменённые или добавленные вами)"
  fi
fi

echo "[*] Удаляю файлы UI..."
remove_tree "$UI_DIR"
# Копии незавершённой операции с модулем и прежние файлы после установки
# лежат рядом с панелью.
remove_tree "$UI_DIR.module-transactions"
for leftover in "$UI_DIR".profile-transaction-* "$(dirname "$UI_DIR")"/xkeen-profile-*; do
  [ -e "$leftover" ] && remove_tree "$leftover"
done

echo "[*] Удаляю init-скрипт..."
for script in "$INIT_SCRIPT" "$INIT_SCRIPT_DEFAULT" "$LEGACY_INIT_SCRIPT"; do
  [ -n "$script" ] || continue
  [ -f "$script" ] || continue
  if is_our_ui_init_script "$script"; then
    rm -f "$script" 2>/dev/null || true
  fi
done
rm -f "$RUN_PID" 2>/dev/null || true

echo "[*] Удаляю журналы..."
remove_tree "$LOG_DIR_DEFAULT"
rm -f "$VAR_LOG/xkeen-ui.log" "$VAR_LOG/xkeen-ui-boot.log" 2>/dev/null || true
for log in "$VAR_LOG"/xkeen-ui.log.* "$VAR_LOG"/xkeen-ui-install.log*; do
  [ -f "$log" ] && rm -f "$log" 2>/dev/null
done
if [ -n "$CUSTOM_LOG_DIR" ] && [ "$ROOT$CUSTOM_LOG_DIR" != "$LOG_DIR_DEFAULT" ]; then
  case "$CUSTOM_LOG_DIR" in
    *xkeen-ui*) remove_tree "$ROOT$CUSTOM_LOG_DIR" ;;
    *)
      # Общий каталог журналов: убираем только файлы панели по их именам.
      for name in core access ws stdout stderr; do
        for log in "$ROOT$CUSTOM_LOG_DIR/$name.log" "$ROOT$CUSTOM_LOG_DIR/$name.log".*; do
          [ -f "$log" ] && rm -f "$log" 2>/dev/null
        done
      done
      ;;
  esac
fi

echo "[*] Удаляю служебные каталоги..."
# Состояние обновлений, скачанный архив панели, настройки удалённых дисков.
remove_tree "$STATE_DIR_DEFAULT"
# Резервные копии самой панели, сделанные при обновлениях.
remove_tree "$BACKUP_DIR_DEFAULT"
remove_moved_dir "$CUSTOM_UPDATE_DIR" "/opt/var/lib/xkeen-ui/update"
remove_moved_dir "$CUSTOM_BACKUP_DIR" "/opt/var/backups/xkeen-ui"
remove_moved_dir "$CUSTOM_REMOTEFS_DIR" "/opt/var/lib/xkeen-ui/remotefs"
remove_moved_dir "$CUSTOM_PYCACHE_DIR" "/tmp/xkeen-ui-pycache"
for leftover in "$TMP_DIR"/xkeen-ui-pycache "$TMP_DIR"/xkeen-ui-update* "$TMP_DIR"/xkeen-ui-backups \
    "$TMP_DIR"/xkeen-ui-remotefs "$TMP_DIR"/xkeen-init-*; do
  [ -e "$leftover" ] && remove_tree "$leftover"
done

# --- Данные владельца ---
TRASH_DIR="$TRASH_DIR_DEFAULT"
[ -n "$CUSTOM_TRASH_DIR" ] && TRASH_DIR="$ROOT$CUSTOM_TRASH_DIR"
if [ "$PURGE" = "1" ]; then
  echo "[*] Удаляю корзину файлового менеджера и резервные копии конфигов..."
  case "$TRASH_DIR" in
    "$TRASH_DIR_DEFAULT"|*xkeen-ui*) remove_tree "$TRASH_DIR" ;;
    *) [ -d "$TRASH_DIR" ] && LEFT="$LEFT
    $TRASH_DIR (корзина перенесена: в имени нет xkeen-ui, проверьте вручную)" ;;
  esac
  remove_tree "$XRAY_BACKUP_DIR"
else
  [ -d "$TRASH_DIR" ] && LEFT="$LEFT
    $TRASH_DIR (корзина файлового менеджера)"
  [ -d "$XRAY_BACKUP_DIR" ] && LEFT="$LEFT
    $XRAY_BACKUP_DIR (резервные копии конфигов Xray)"
fi

if [ -n "$LEFT" ]; then
  echo "[*] Оставлено — это ваши данные, а не файлы панели:$LEFT"
  [ "$PURGE" = "1" ] || echo "    Если они не нужны, удалите эти каталоги вручную."
fi
echo "[*] Конфиги Xray и Mihomo, DAT-файлы, пакеты Entware и Python не тронуты."

echo "========================================"
echo "  ✔ Xkeen Web UI удалён"
echo "========================================"

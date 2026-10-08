#!/bin/sh
set -e

# Удаление панели Xkeen UI. После него на роутере не остаётся ничего, что
# принадлежит панели: ни файлов, ни службы, ни команд в /opt/bin, ни журналов,
# ни служебных каталогов в /opt/var и /tmp. Защита DNS (DNS-over-VLESS или DNS
# Mihomo), если она включена, перед удалением выключается — иначе в роутере
# осталась бы настройка, которую некому вернуть.
#
# Что делать с данными владельца, скрипт спрашивает:
#   начисто       — убрать и их: настройки и пароль панели, подписки, ключи,
#                   корзину файлового менеджера, резервные копии конфигов и
#                   библиотеки Python, которые ставила сама панель;
#   только панель — данные остаются и подхватываются следующей установкой.
#
# Не трогается то, чем пользуются Xray, Mihomo и сам роутер: их рабочие
# конфиги, DAT-файлы и ссылки на них, пакеты Entware.
#
#   sh uninstall.sh              спросить, что делать с данными
#   sh uninstall.sh --purge      убрать всё начисто
#   sh uninstall.sh --keep-data  убрать только панель
#   sh uninstall.sh --force      удалять, даже если защиту DNS выключить не удалось
#
# Без терминала и без ключа данные остаются.

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
MIHOMO_BACKUP_DIR="$ROOT/opt/etc/mihomo/backup"
PYTHON_BIN="${PYTHON_BIN:-/opt/bin/python3}"
MIHOMO_TEMPLATES_DIR="$ROOT/opt/etc/mihomo/templates"
XRAY_BACKUP_DIR="$ROOT/opt/etc/xray/configs/backups"

PURGE=""
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --purge) PURGE=1 ;;
    --keep-data) PURGE=0 ;;
    --force) FORCE=1 ;;
  esac
done
if [ -z "$PURGE" ]; then
  case "${XKEEN_UI_UNINSTALL_PURGE:-}" in
    1) PURGE=1 ;;
    0) PURGE=0 ;;
  esac
fi

ask_what_to_remove() {
  # Ответ читается с терминала. Непонятный ответ переспрашивается; после трёх
  # попыток данные остаются: их можно удалить позже, а вернуть нельзя.
  _aw_try=0
  while [ "$_aw_try" -lt 3 ]; do
    echo "Что удалить?"
    echo "  1) Всё начисто: панель и её данные — настройки и пароль, подписки, ключи,"
    echo "     корзину файлового менеджера, резервные копии конфигов"
    echo "  2) Только панель: данные останутся и подхватятся при следующей установке"
    printf 'Выбор [1/2]: '
    read -r _aw_answer || _aw_answer=""
    case "$_aw_answer" in
      1) PURGE=1; return 0 ;;
      2) PURGE=0; return 0 ;;
    esac
    _aw_try=$((_aw_try + 1))
    echo "Нужно ввести 1 или 2."
  done
  echo "[*] Ответ не получен — данные оставлены."
  PURGE=0
}

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

if [ -z "$PURGE" ]; then
  if [ -t 0 ] || [ "${XKEEN_UI_UNINSTALL_ASK:-0}" = "1" ]; then
    ask_what_to_remove
  else
    PURGE=0
  fi
fi

panel_is_ancestor() {
  # Запущен ли скрипт из терминала самой панели. Тогда остановка панели
  # закрывает терминал, а вместе с ним гибнет и всё, что в нём запущено.
  [ "${XKEEN_UI_UNINSTALL_UNDER_PANEL:-}" = "1" ] && return 0
  [ -z "$ROOT" ] || return 1
  _pa_pid=$$
  _pa_depth=0
  while [ "$_pa_pid" -gt 1 ] 2>/dev/null && [ "$_pa_depth" -lt 32 ]; do
    _pa_stat="$(cat "/proc/$_pa_pid/stat" 2>/dev/null)" || return 1
    _pa_after="${_pa_stat##*) }"
    _pa_parent="${_pa_after#* }"
    _pa_parent="${_pa_parent%% *}"
    case "$_pa_parent" in
      ''|*[!0-9]*) return 1 ;;
    esac
    if tr '\000' ' ' < "/proc/$_pa_parent/cmdline" 2>/dev/null | grep -q "$UI_DIR/"; then
      return 0
    fi
    _pa_pid="$_pa_parent"
    _pa_depth=$((_pa_depth + 1))
  done
  return 1
}

if [ "${XKEEN_UI_UNINSTALL_DETACHED:-0}" != "1" ] && [ -x "$PYTHON_BIN" ] && panel_is_ancestor; then
  # Продолжаем отдельным процессом в своём сеансе: его остановка панели не
  # заденет. Копия скрипта нужна потому, что сам он лежит в каталоге панели.
  DETACHED_SCRIPT="$TMP_DIR/xkeen-ui-uninstall.sh"
  DETACHED_LOG="$TMP_DIR/xkeen-ui-uninstall.log"
  mkdir -p "$TMP_DIR" 2>/dev/null || true
  if cp -f "$0" "$DETACHED_SCRIPT" 2>/dev/null; then
    echo "[*] Удаление запущено из терминала панели: панель сейчас остановится, и терминал закроется."
    echo "    Удаление продолжится само. Чем оно закончилось: $DETACHED_LOG"
    FORCE_FLAG=""
    [ "$FORCE" -eq 1 ] && FORCE_FLAG="--force"
    XKEEN_UI_UNINSTALL_DETACHED=1 XKEEN_UI_UNINSTALL_PURGE="$PURGE" "$PYTHON_BIN" -c \
      'import os, sys; os.setsid(); os.execv("/bin/sh", ["sh"] + sys.argv[1:])' \
      "$DETACHED_SCRIPT" $FORCE_FLAG > "$DETACHED_LOG" 2>&1 < /dev/null &
    exit 0
  fi
fi

# Список библиотек Python, которые ставила сама панель, лежит в её каталоге.
PIP_RECORD="$UI_DIR/var/pip-installed-by-panel.txt"
PIP_INSTALLED_BY_PANEL=""
if [ -f "$PIP_RECORD" ]; then
  PIP_INSTALLED_BY_PANEL="$(grep -E '^[A-Za-z0-9][A-Za-z0-9._-]*$' "$PIP_RECORD" 2>/dev/null | sort -u | tr '\n' ' ')"
fi

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

# Защита DNS держит настройку роутера и кусок конфига ядра. Снимаем её кодом
# самой панели, пока он ещё на месте. Панель к этому моменту остановлена: её
# сторож DNS не должен вмешаться посреди выключения.
RELEASE_SCRIPT="$UI_DIR/scripts/release_router_settings.py"
if [ -f "$RELEASE_SCRIPT" ] && [ -x "$PYTHON_BIN" ]; then
  echo "[*] Проверяю защиту DNS..."
  RELEASE_OK=1
  (
    # Те же настройки, с которыми работала панель: служба автозапуска задаёт
    # их перед стартом, файл настроек владельца — поверх.
    export MIHOMO_ROOT="/opt/etc/mihomo"
    export MIHOMO_VALIDATE_CMD='/opt/sbin/mihomo -t -d {root} -f {config}'
    export PATH="/opt/bin:/opt/sbin:$PATH"
    if [ -f "$UI_DIR/devtools.env" ]; then
      . "$UI_DIR/devtools.env" >/dev/null 2>&1 || true
    fi
    "$PYTHON_BIN" "$RELEASE_SCRIPT"
  ) || RELEASE_OK=0
  if [ "$RELEASE_OK" -ne 1 ] && [ "$FORCE" -ne 1 ]; then
    echo "[!] Удаление остановлено: с включённой защитой DNS устройства останутся без имён сайтов."
    echo "    Выключите её в панели (окно DNS) и запустите удаление снова."
    echo "    Удалить всё равно: sh uninstall.sh --force"
    if [ -n "$ACTIVE_INIT_SCRIPT" ] && [ -x "$ACTIVE_INIT_SCRIPT" ] && [ -z "$ROOT" ]; then
      "$ACTIVE_INIT_SCRIPT" start >/dev/null 2>&1 || true
    fi
    exit 1
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

strip_panel_program() {
  # Убрать из каталога панели программу и оставить данные владельца:
  # настройки, пароль, подписки, ключи, исходники конфигов с комментариями,
  # собственные шаблоны. Следующая установка положит программу рядом с ними.
  for kind in routing observatory; do
    for bundled in "$UI_DIR/opt/etc/xray/templates/$kind"/*; do
      [ -f "$bundled" ] || continue
      copy="$UI_DIR/templates/$kind/$(basename "$bundled")"
      if [ -f "$copy" ] && cmp -s "$bundled" "$copy" 2>/dev/null; then
        rm -f "$copy" 2>/dev/null || true
      fi
    done
  done
  for entry in "$UI_DIR"/templates/* "$UI_DIR"/templates/.[!.]*; do
    [ -e "$entry" ] || continue
    case "$(basename "$entry")" in
      routing|observatory) ;;
      *) remove_tree "$entry" ;;
    esac
  done
  for name in core middleware routes services static tools utils scripts opt module-operations module-catalog; do
    remove_tree "$UI_DIR/$name"
  done
  for file in "$UI_DIR"/*.py "$UI_DIR"/*.sh "$UI_DIR"/bin/xk-geodat*; do
    if [ -f "$file" ]; then
      rm -f "$file" 2>/dev/null || true
    fi
  done
  for name in BUILD.json install-managed.json module-installed.json install-profile.json \
      module-ownership.json module-sizes.json restart.log; do
    rm -f "$UI_DIR/$name" 2>/dev/null || true
  done
  find "$UI_DIR" -name __pycache__ -type d -prune -exec rm -rf {} \; 2>/dev/null || true
  find "$UI_DIR" -depth -type d -exec rmdir {} \; 2>/dev/null || true
}

echo "[*] Удаляю файлы UI..."
if [ "$PURGE" = "1" ]; then
  remove_tree "$UI_DIR"
elif [ -d "$UI_DIR" ]; then
  strip_panel_program
  if [ -d "$UI_DIR" ]; then
    LEFT="$LEFT
    $UI_DIR (настройки и пароль панели, подписки, ключи, ваши шаблоны)"
  fi
fi
# Копии незавершённой операции с модулем и прежние файлы после установки
# лежат рядом с панелью.
remove_tree "$UI_DIR.module-transactions"
remove_tree "$UI_DIR.previous-version"
remove_tree "$UI_DIR.previous-version.old"
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
# Состояние обновлений и скачанный архив панели — всегда; сохранённые
# подключения к удалённым дискам — данные владельца.
if [ "$PURGE" = "1" ]; then
  remove_tree "$STATE_DIR_DEFAULT"
else
  for entry in "$STATE_DIR_DEFAULT"/* "$STATE_DIR_DEFAULT"/.[!.]*; do
    [ -e "$entry" ] || continue
    [ "$(basename "$entry")" = "remotefs" ] || remove_tree "$entry"
  done
  rmdir "$STATE_DIR_DEFAULT" 2>/dev/null || true
  if [ -d "$STATE_DIR_DEFAULT/remotefs" ]; then
    LEFT="$LEFT
    $STATE_DIR_DEFAULT/remotefs (сохранённые подключения файлового менеджера)"
  fi
fi
# Резервные копии самой панели, сделанные при обновлениях.
remove_tree "$BACKUP_DIR_DEFAULT"
remove_moved_dir "$CUSTOM_UPDATE_DIR" "/opt/var/lib/xkeen-ui/update"
remove_moved_dir "$CUSTOM_BACKUP_DIR" "/opt/var/backups/xkeen-ui"
if [ "$PURGE" = "1" ]; then
  remove_moved_dir "$CUSTOM_REMOTEFS_DIR" "/opt/var/lib/xkeen-ui/remotefs"
fi
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
  remove_tree "$MIHOMO_BACKUP_DIR"
  if [ -n "$PIP_INSTALLED_BY_PANEL" ] && [ -x "$PYTHON_BIN" ]; then
    echo "[*] Удаляю библиотеки Python, которые ставила панель: $PIP_INSTALLED_BY_PANEL"
    # shellcheck disable=SC2086
    "$PYTHON_BIN" -m pip uninstall -y $PIP_INSTALLED_BY_PANEL >/dev/null 2>&1 \
      || echo "[!] Не все библиотеки удалось удалить; проверьте: $PYTHON_BIN -m pip list"
  fi
else
  [ -d "$TRASH_DIR" ] && LEFT="$LEFT
    $TRASH_DIR (корзина файлового менеджера)"
  [ -d "$XRAY_BACKUP_DIR" ] && LEFT="$LEFT
    $XRAY_BACKUP_DIR (резервные копии конфигов Xray)"
  [ -d "$MIHOMO_BACKUP_DIR" ] && LEFT="$LEFT
    $MIHOMO_BACKUP_DIR (резервные копии конфига Mihomo)"
  [ -n "$PIP_INSTALLED_BY_PANEL" ] && LEFT="$LEFT
    библиотеки Python, которые ставила панель: $PIP_INSTALLED_BY_PANEL"
fi

if [ -n "$LEFT" ]; then
  echo "[*] Оставлено:$LEFT"
  if [ "$PURGE" != "1" ]; then
    echo "    Следующая установка панели это подхватит. Чтобы убрать и это, запустите"
    echo "    удаление с ключом --purge (до него — пока скрипт ещё на месте) или удалите перечисленное вручную."
  fi
fi
echo "[*] Рабочие конфиги Xray и Mihomo, DAT-файлы и пакеты Entware не тронуты."

# Копия скрипта, с которой продолжалось удаление из терминала панели.
if [ "${XKEEN_UI_UNINSTALL_DETACHED:-0}" = "1" ]; then
  case "$0" in
    "$TMP_DIR"/xkeen-ui-uninstall.sh) rm -f "$0" 2>/dev/null || true ;;
  esac
fi

echo "========================================"
echo "  ✔ Xkeen Web UI удалён"
echo "========================================"

#!/bin/sh
# ═══════════════════════════════════════════════════════════════
#  device_lock_detector.sh — Детектор блокировок устройств
#  Показывает, какие процессы удерживают диск/раздел,
#  мешая безопасному извлечению или форматированию.
#  Адаптировано из проекта Flashkeen.
#
#  Использование:
#    device_lock_detector.sh              — проверить все диски
#    device_lock_detector.sh /dev/sda1    — проверить конкретный
#    device_lock_detector.sh --mountpoint /opt — по точке монтирования
#
#  Совместимость: BusyBox ash / POSIX sh
#  Зависимости: fuser (опционально), /proc/mounts
# ═══════════════════════════════════════════════════════════════

# --- Цвета ---
NC='\033[0m'
RED='\033[0;31m'
GRN='\033[0;32m'
YLW='\033[0;33m'
CYN='\033[0;36m'
B_RED='\033[1;31m'
B_GRN='\033[1;32m'
B_YLW='\033[1;33m'
B_CYN='\033[1;36m'
B_WHT='\033[1;37m'
PROC_MOUNTS_FILE="${XKEEN_PROC_MOUNTS_FILE:-/proc/mounts}"

_out() { printf '%b\n' "$*"; }
has_cmd() { command -v "$1" >/dev/null 2>&1; }
pid_is_listed() {
  case " $1 " in
    *" $2 "*) return 0 ;;
  esac
  return 1
}

# --- Получить имя процесса по PID ---
get_process_name() {
  pid="$1"
  if [ -r "/proc/$pid/comm" ]; then
    cat "/proc/$pid/comm" 2>/dev/null
  elif [ -r "/proc/$pid/cmdline" ]; then
    tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | awk '{print $1}'
  else
    printf '???'
  fi
}

# --- Получить командную строку процесса ---
get_process_cmdline() {
  pid="$1"
  if [ -r "/proc/$pid/cmdline" ]; then
    cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null)
    # Обрезаем до 60 символов
    printf '%.60s' "$cmd"
  else
    printf '-'
  fi
}

# --- Получить владельца процесса ---
get_process_user() {
  pid="$1"
  if [ -r "/proc/$pid/status" ]; then
    uid=$(awk '/^Uid:/ {print $2; exit}' "/proc/$pid/status" 2>/dev/null)
    case "$uid" in
      0) printf 'root' ;;
      *) printf 'uid:%s' "$uid" ;;
    esac
  else
    printf '?'
  fi
}

print_lock_pid() {
  icon="$1"
  pid="$2"

  pname=$(get_process_name "$pid")
  pcmd=$(get_process_cmdline "$pid")
  puser=$(get_process_user "$pid")
  printf "  %b ${B_WHT}PID %-7s${NC} ${YLW}%-12s${NC} ${CYN}%-6s${NC} %s\n" \
    "$icon" "$pid" "$pname" "$puser" "$pcmd"
}

get_device_mountpoints() {
  dev="$1"
  [ -n "$dev" ] || return 0

  awk -v dev="$dev" '
    function rank(mp) {
      if (mp ~ /^\/tmp\/mnt\//) return 0
      if (mp ~ /^\/media\//) return 1
      if (mp ~ /^\/mnt\//) return 2
      if (mp == "/opt") return 9
      return 5
    }

    $1 == dev && !seen[$2]++ {
      print rank($2) "\t" $2
    }
  ' "$PROC_MOUNTS_FILE" 2>/dev/null | sort -n | cut -f2-
}

get_device_mountpoints_label() {
  dev="$1"
  mountpoints=$(get_device_mountpoints "$dev")
  label=""

  while IFS= read -r mp; do
    [ -n "$mp" ] || continue
    if [ -n "$label" ]; then
      label="$label, $mp"
    else
      label="$mp"
    fi
  done <<EOF
$mountpoints
EOF

  printf '%s' "$label"
}

# --- Проверка блокировок устройства ---
check_device_locks() {
  dev="$1"
  found=0
  seen_pids=""
  mountpoints=$(get_device_mountpoints "$dev")

  # 1) Прямая проверка устройства через fuser
  if has_cmd fuser; then
    direct_pids=$(fuser "$dev" 2>/dev/null | tr -s '[:space:]' ' ' | sed 's/^ //; s/ $//')
    if [ -n "$direct_pids" ]; then
      for pid in $direct_pids; do
        pid_is_listed "$seen_pids" "$pid" && continue
        seen_pids="$seen_pids $pid"
        found=1
        print_lock_pid "${B_RED}●${NC}" "$pid"
      done
    fi
  fi

  # 2) Проверка точки монтирования (fuser -m)
  if [ -n "$mountpoints" ] && has_cmd fuser; then
    while IFS= read -r mp; do
      [ -n "$mp" ] || continue
      pids_m=$(fuser -m "$mp" 2>/dev/null | tr -s '[:space:]' ' ' | sed 's/^ //; s/ $//')
      [ -n "$pids_m" ] || continue
      for pid in $pids_m; do
        pid_is_listed "$seen_pids" "$pid" && continue
        seen_pids="$seen_pids $pid"
        found=1
        print_lock_pid "${B_YLW}○${NC}" "$pid"
      done
    done <<EOF
$mountpoints
EOF
  fi

  # 3) Фолбэк без fuser — через /proc/*/fd
  if ! has_cmd fuser && [ -n "$mountpoints" ]; then
    while IFS= read -r mp; do
      [ -n "$mp" ] || continue
      for proc_dir in /proc/[0-9]*; do
        pid=$(basename "$proc_dir")
        [ -d "$proc_dir/fd" ] || continue
        # Проверяем, есть ли открытые файлы на этой точке монтирования
        if ls -la "$proc_dir/fd" 2>/dev/null | grep -q "$mp"; then
          pid_is_listed "$seen_pids" "$pid" && continue
          seen_pids="$seen_pids $pid"
          found=1
          print_lock_pid "${YLW}◌${NC}" "$pid"
        fi
      done
    done <<EOF
$mountpoints
EOF
  fi

  return $((1 - found))
}

# --- Проверка по точке монтирования ---
check_mountpoint_locks() {
  mp="$1"
  found=0
  seen_pids=""

  if has_cmd fuser; then
    pids=$(fuser -m "$mp" 2>/dev/null | tr -s '[:space:]' ' ' | sed 's/^ //; s/ $//')
    if [ -n "$pids" ]; then
      for pid in $pids; do
        pid_is_listed "$seen_pids" "$pid" && continue
        seen_pids="$seen_pids $pid"
        found=1
        print_lock_pid "${B_RED}●${NC}" "$pid"
      done
    fi
  else
    _out "  ${YLW}fuser не установлен — установите: opkg install fuser${NC}"
  fi

  return $((1 - found))
}

# --- Собрать все смонтированные устройства ---
get_mounted_devices() {
  awk '$1 ~ /^\/dev\/(sd|mmcblk|nvme)/ && !seen[$1]++ { print $1 }' "$PROC_MOUNTS_FILE" 2>/dev/null
}

# --- Секция ---
section_header() {
  name="$1"
  color="${2:-$B_CYN}"
  bar="══════════════════════════════════════════════════════"
  _out ""
  _out "${color}╔${bar}╗${NC}"
  _out "${color}║${NC}   ${color}${name}\033[56G${color}║${NC}"
  _out "${color}╚${bar}╝${NC}"
}

# --- Проверка всех устройств ---
check_all_devices() {
  section_header "БЛОКИРОВКИ УСТРОЙСТВ" "$B_YLW"
  _out ""

  if ! has_cmd fuser; then
    _out "  ${YLW}Внимание: fuser не найден. Установите: opkg install psmisc${NC}"
    _out "  ${YLW}Используется фолбэк через /proc — результат может быть неполным${NC}"
    _out ""
  fi

  mounted=$(get_mounted_devices)
  if [ -z "$mounted" ]; then
    _out "  ${GRN}Нет смонтированных блочных устройств${NC}"
    return
  fi

  total_locks=0

  while IFS= read -r dev; do
    [ -z "$dev" ] && continue
    dev_name=$(basename "$dev")
    mountpoints_label=$(get_device_mountpoints_label "$dev")
    [ -n "$mountpoints_label" ] || mountpoints_label="-"
    _out "  ${B_WHT}━━━ ${dev_name} (${mountpoints_label}) ━━━${NC}"

    if check_device_locks "$dev"; then
      total_locks=$((total_locks + 1))
    else
      _out "  ${B_GRN}✓ Нет блокировок${NC}"
    fi
    _out ""
  done <<EOF
$mounted
EOF

  _out "  ${B_WHT}Обозначения:${NC}"
  _out "  ${B_RED}●${NC} Прямая блокировка устройства"
  _out "  ${B_YLW}○${NC} Открытые файлы на точке монтирования"
  _out "  ${YLW}◌${NC} Обнаружено через /proc (фолбэк)"
}

# --- Точка входа ---
main() {
  case "$1" in
    --mountpoint|-m)
      if [ -z "$2" ]; then
        _out "${RED}Укажите точку монтирования${NC}"
        return 1
      fi
      section_header "БЛОКИРОВКИ: $2" "$B_YLW"
      _out ""
      if check_mountpoint_locks "$2"; then
        :
      else
        _out "  ${B_GRN}✓ Нет блокировок${NC}"
      fi
      ;;
    --help|-h)
      _out "Использование: device_lock_detector.sh [устройство | --mountpoint путь]"
      _out "  Без аргументов    Проверить все смонтированные устройства"
      _out "  /dev/sda1         Проверить конкретное устройство"
      _out "  --mountpoint /opt Проверить по точке монтирования"
      _out "  --help            Эта справка"
      ;;
    /dev/*)
      section_header "БЛОКИРОВКИ: $(basename "$1")" "$B_YLW"
      _out ""
      if check_device_locks "$1"; then
        :
      else
        _out "  ${B_GRN}✓ Нет блокировок${NC}"
      fi
      ;;
    "")
      check_all_devices
      ;;
    *)
      _out "${RED}Неизвестный аргумент: $1${NC}"
      _out "Используйте --help для справки"
      return 1
      ;;
  esac
  _out ""
}

main "$@"

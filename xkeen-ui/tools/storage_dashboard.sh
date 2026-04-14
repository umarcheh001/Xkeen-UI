#!/bin/sh
# ═══════════════════════════════════════════════════════════════
#  storage_dashboard.sh — Дашборд хранилища для Xkeen UI
#  Показывает таблицу разделов: устройство, метка, размер,
#  свободное место, тип FS, статус монтирования.
#  Адаптировано из проекта Flashkeen.
#
#  Совместимость: BusyBox ash / POSIX sh
#  Зависимости: blkid (опционально), df, awk
# ═══════════════════════════════════════════════════════════════

# --- Цвета ---
NC='\033[0m'
RED='\033[0;31m'
GRN='\033[0;32m'
YLW='\033[0;33m'
BLU='\033[0;34m'
CYN='\033[0;36m'
WHT='\033[0;37m'
B_RED='\033[1;31m'
B_GRN='\033[1;32m'
B_YLW='\033[1;33m'
B_BLU='\033[1;34m'
B_CYN='\033[1;36m'
B_WHT='\033[1;37m'

# --- Утилиты ---
_out() { printf '%b\n' "$*"; }

has_cmd() { command -v "$1" >/dev/null 2>&1; }

# Форматирование размера KB → человекочитаемый
format_size_kb() {
  kb="$1"
  if [ "$kb" -ge 1048576 ] 2>/dev/null; then
    # GB
    awk -v k="$kb" 'BEGIN{
      g=k/1024/1024
      if(g>=100) printf "%d ГБ", int(g)
      else if(g>=10) printf "%.1f ГБ", g
      else printf "%.2f ГБ", g
    }'
  elif [ "$kb" -ge 1024 ] 2>/dev/null; then
    # MB
    awk -v k="$kb" 'BEGIN{
      m=k/1024
      if(m>=100) printf "%d МБ", int(m)
      else printf "%.1f МБ", m
    }'
  else
    printf '%s КБ' "$kb"
  fi
}

# Получить поле из blkid (LABEL, UUID, TYPE) — совместимо с BusyBox
# BusyBox blkid может не поддерживать -s/-o, поэтому всегда парсим полный вывод
_blkid_field() {
  dev="$1"; field="$2"
  if has_cmd blkid; then
    blkid "$dev" 2>/dev/null | sed -n "s/.* ${field}=\"\\([^\"]*\\)\".*/\\1/p"
  fi
}

# Получить тип FS для устройства
get_fs_type() {
  dev="$1"
  fs=$(_blkid_field "$dev" "TYPE")
  # Фолбэк — /proc/mounts
  if [ -z "$fs" ]; then
    fs=$(awk -v d="$dev" '$1==d {print $3; exit}' /proc/mounts 2>/dev/null)
  fi
  printf '%s' "${fs:-???}"
}

# Получить метку раздела
get_label() {
  dev="$1"
  label=$(_blkid_field "$dev" "LABEL")
  printf '%s' "${label:--}"
}

# Проверка: смонтирован ли раздел
is_mounted() {
  dev="$1"
  # Прямая проверка
  if awk -v d="$dev" '$1==d {found=1; exit} END{exit found?0:1}' /proc/mounts 2>/dev/null; then
    return 0
  fi
  # Проверка по UUID (Keenetic может монтировать по UUID)
  dev_uuid=$(_blkid_field "$dev" "UUID")
  if [ -n "$dev_uuid" ]; then
    if awk -v u="UUID=$dev_uuid" '$1==u {found=1; exit} END{exit found?0:1}' /proc/mounts 2>/dev/null; then
      return 0
    fi
  fi
  return 1
}

# Получить точку монтирования
get_mountpoint() {
  dev="$1"
  mp=$(awk -v d="$dev" '$1==d {print $2; exit}' /proc/mounts 2>/dev/null)
  if [ -z "$mp" ]; then
    dev_uuid=$(_blkid_field "$dev" "UUID")
    if [ -n "$dev_uuid" ]; then
      mp=$(awk -v u="UUID=$dev_uuid" '$1==u {print $2; exit}' /proc/mounts 2>/dev/null)
    fi
  fi
  printf '%s' "$mp"
}

# Прогресс-бар использования диска
usage_bar() {
  pct="$1"
  width=20
  filled=$((pct * width / 100))
  empty=$((width - filled))

  # Цвет по уровню заполненности
  if [ "$pct" -ge 90 ] 2>/dev/null; then
    bar_color="$B_RED"
  elif [ "$pct" -ge 70 ] 2>/dev/null; then
    bar_color="$B_YLW"
  else
    bar_color="$B_GRN"
  fi

  printf '%b[' "$bar_color"
  i=0; while [ "$i" -lt "$filled" ]; do printf '█'; i=$((i+1)); done
  i=0; while [ "$i" -lt "$empty" ]; do printf '░'; i=$((i+1)); done
  printf ']%b %d%%' "$NC" "$pct"
}

# Собрать список блочных устройств (разделов)
get_block_devices() {
  # /proc/partitions содержит все разделы
  if [ -r /proc/partitions ]; then
    awk 'NR>2 && $4 ~ /^(sd|mmcblk|nvme)[a-z0-9]*[0-9]+$/ {print "/dev/"$4}' /proc/partitions 2>/dev/null | sort
  fi
}

# --- Секция заголовка ---
section_header() {
  name="$1"
  color="${2:-$B_CYN}"
  bar="══════════════════════════════════════════════════════"
  _out ""
  _out "${color}╔${bar}╗${NC}"
  _out "${color}║${NC}   ${color}${name}\033[56G${color}║${NC}"
  _out "${color}╚${bar}╝${NC}"
}

# --- Главная: вывод дашборда ---
print_storage_dashboard() {
  section_header "ХРАНИЛИЩЕ" "$B_CYN"

  devices=$(get_block_devices)
  if [ -z "$devices" ]; then
    _out "  ${YLW}Блочные устройства не найдены${NC}"
    return
  fi

  # Заголовок таблицы
  _out ""
  printf "  ${B_WHT}%-12s %-10s %-8s %-10s %-10s %-8s %-6s${NC}\n" \
    "УСТРОЙСТВО" "МЕТКА" "ТИП FS" "РАЗМЕР" "СВОБОДНО" "ИСПОЛЬ." "СТАТУС"
  _out "  ${CYN}────────── ────────── ──────── ────────── ────────── ──────── ──────${NC}"

  echo "$devices" | while IFS= read -r dev; do
    [ -z "$dev" ] && continue

    label=$(get_label "$dev")
    fs=$(get_fs_type "$dev")

    if is_mounted "$dev"; then
      mp=$(get_mountpoint "$dev")
      status="${B_GRN}▲ ОК${NC}"

      # Получаем размеры из df
      df_line=$(df -kP "$mp" 2>/dev/null | awk 'NR==2')
      if [ -n "$df_line" ]; then
        total_kb=$(echo "$df_line" | awk '{print $2}')
        used_kb=$(echo "$df_line" | awk '{print $3}')
        avail_kb=$(echo "$df_line" | awk '{print $4}')
        pct=$(echo "$df_line" | awk '{gsub(/%/,""); print $5}')

        total_h=$(format_size_kb "$total_kb")
        avail_h=$(format_size_kb "$avail_kb")
        pct_str="${pct}%"
      else
        total_h="—"
        avail_h="—"
        pct_str="—"
      fi
    else
      status="${RED}▼ НЕТ${NC}"
      total_h="—"
      avail_h="—"
      pct_str="—"
    fi

    # Обрезаем длинные имена
    dev_short=$(basename "$dev")
    label_short=$(printf '%.10s' "$label")

    printf "  %-12s %-10s %-8s %-10s %-10s %-8s %b\n" \
      "$dev_short" "$label_short" "$fs" "$total_h" "$avail_h" "$pct_str" "$status"
  done

  # Визуализация использования для смонтированных
  _out ""
  _out "  ${B_WHT}Использование дисков:${NC}"
  echo "$devices" | while IFS= read -r dev; do
    [ -z "$dev" ] && continue
    is_mounted "$dev" || continue
    mp=$(get_mountpoint "$dev")
    df_line=$(df -kP "$mp" 2>/dev/null | awk 'NR==2')
    [ -z "$df_line" ] && continue
    pct=$(echo "$df_line" | awk '{gsub(/%/,""); print $5}')
    dev_short=$(basename "$dev")
    label=$(get_label "$dev")
    [ "$label" = "-" ] && label="$dev_short"
    printf '  %-12s ' "$label"
    usage_bar "$pct"
    printf '\n'
  done
}

# --- Сводка swap ---
print_swap_info() {
  if [ ! -r /proc/swaps ]; then
    return
  fi
  swap_count=$(awk 'NR>1 {c++} END{print c+0}' /proc/swaps 2>/dev/null)
  if [ "$swap_count" -gt 0 ]; then
    _out ""
    _out "  ${B_WHT}Swap:${NC}"
    awk 'NR>1 {
      name=$1; type=$2; size=$3; used=$4
      sz_mb=int(size/1024)
      us_mb=int(used/1024)
      pct=(size>0) ? int(used*100/size) : 0
      printf "  %-20s  %s  %dМБ/%dМБ (%d%%)\n", name, type, us_mb, sz_mb, pct
    }' /proc/swaps
  else
    _out ""
    _out "  ${YLW}Swap не настроен${NC}"
  fi
}

# --- Точка входа ---
main() {
  print_storage_dashboard
  print_swap_info
  _out ""
}

main "$@"

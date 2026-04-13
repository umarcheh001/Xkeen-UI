#!/bin/sh
# ═══════════════════════════════════════════════════════════════
#  io_monitor.sh — Мониторинг I/O дисков в реальном времени
#  Показывает скорость чтения/записи для всех блочных устройств.
#  Адаптировано из проекта Flashkeen.
#
#  Использование:
#    io_monitor.sh              — однократный снимок (2 сек)
#    io_monitor.sh --live       — непрерывный мониторинг (Ctrl+C)
#    io_monitor.sh --live 5     — обновление каждые 5 секунд
#    io_monitor.sh --device sda — только конкретное устройство
#
#  Совместимость: BusyBox ash / POSIX sh
#  Зависимости: /proc/diskstats, awk
# ═══════════════════════════════════════════════════════════════

# --- Цвета ---
NC='\033[0m'
RED='\033[0;31m'
GRN='\033[0;32m'
YLW='\033[0;33m'
CYN='\033[0;36m'
B_GRN='\033[1;32m'
B_YLW='\033[1;33m'
B_CYN='\033[1;36m'
B_WHT='\033[1;37m'

_out() { printf '%b\n' "$*"; }

# --- Форматирование скорости ---
format_speed() {
  bytes="$1"
  if [ "$bytes" -ge 1073741824 ] 2>/dev/null; then
    awk -v b="$bytes" 'BEGIN{printf "%.2f ГБ/с", b/1073741824}'
  elif [ "$bytes" -ge 1048576 ] 2>/dev/null; then
    awk -v b="$bytes" 'BEGIN{printf "%.2f МБ/с", b/1048576}'
  elif [ "$bytes" -ge 1024 ] 2>/dev/null; then
    awk -v b="$bytes" 'BEGIN{printf "%.1f КБ/с", b/1024}'
  else
    printf '%d Б/с' "$bytes"
  fi
}

# --- Получить базовое имя диска (sda1 → sda, mmcblk0p1 → mmcblk0) ---
get_disk_base() {
  name="$1"
  echo "$name" | sed 's/p[0-9]*$//; s/[0-9]*$//'
}

# --- Получить список дисков из /proc/diskstats ---
get_disk_list() {
  filter="$1"
  if [ -n "$filter" ]; then
    awk -v f="$filter" '$3==f {print $3}' /proc/diskstats 2>/dev/null
  else
    # Только целые диски (sd*, mmcblk*), без разделов
    awk '$3 ~ /^(sd[a-z]+|mmcblk[0-9]+|nvme[0-9]+n[0-9]+)$/ {print $3}' /proc/diskstats 2>/dev/null | sort -u
  fi
}

# --- Прочитать секторы чтения/записи из /proc/diskstats ---
# Формат: major minor name rd_ios rd_merge rd_sect rd_tick wr_ios wr_merge wr_sect wr_tick ...
# Поля: $6 = секторы прочитано, $10 = секторы записано
read_disk_stats() {
  disk="$1"
  awk -v d="$disk" '$3==d {print $6, $10; exit}' /proc/diskstats 2>/dev/null
}

# --- Получить метку/точку монтирования для отображения ---
get_disk_info() {
  disk="$1"
  # Попробуем найти точку монтирования любого раздела этого диска
  mp=""
  for part in $(awk -v d="$disk" '$3 ~ "^"d {print $3}' /proc/diskstats 2>/dev/null); do
    mp=$(awk -v d="/dev/$part" '$1==d {print $2; exit}' /proc/mounts 2>/dev/null)
    [ -n "$mp" ] && break
  done
  printf '%s' "${mp:--}"
}

# --- Цвет по активности ---
speed_color() {
  bytes="$1"
  if [ "$bytes" -ge 10485760 ] 2>/dev/null; then
    printf '%s' "$B_YLW"  # > 10 МБ/с — жёлтый
  elif [ "$bytes" -gt 0 ] 2>/dev/null; then
    printf '%s' "$B_GRN"  # активность — зелёный
  else
    printf '%s' "$NC"     # нет активности
  fi
}

# --- Однократный снимок I/O ---
snapshot_io() {
  interval="${1:-2}"
  filter="$2"

  disks=$(get_disk_list "$filter")
  if [ -z "$disks" ]; then
    _out "  ${YLW}Диски не найдены${NC}"
    return 1
  fi

  # Первое чтение
  for disk in $disks; do
    stats=$(read_disk_stats "$disk")
    rd_sect=$(echo "$stats" | awk '{print $1}')
    wr_sect=$(echo "$stats" | awk '{print $2}')
    eval "prev_rd_${disk}=${rd_sect:-0}"
    eval "prev_wr_${disk}=${wr_sect:-0}"
  done

  sleep "$interval"

  # Второе чтение + расчёт
  _out ""
  printf "  ${B_WHT}%-10s %-14s %-16s %-16s %-10s${NC}\n" \
    "ДИСК" "МОНТИРОВАНИЕ" "ЧТЕНИЕ" "ЗАПИСЬ" "ИТОГО"
  _out "  ${CYN}────────── ────────────── ──────────────── ──────────────── ──────────${NC}"

  for disk in $disks; do
    stats=$(read_disk_stats "$disk")
    rd_sect=$(echo "$stats" | awk '{print $1}')
    wr_sect=$(echo "$stats" | awk '{print $2}')

    eval "p_rd=\$prev_rd_${disk}"
    eval "p_wr=\$prev_wr_${disk}"

    d_rd=$((${rd_sect:-0} - ${p_rd:-0}))
    d_wr=$((${wr_sect:-0} - ${p_wr:-0}))
    [ "$d_rd" -lt 0 ] 2>/dev/null && d_rd=0
    [ "$d_wr" -lt 0 ] 2>/dev/null && d_wr=0

    # Секторы → байты (1 сектор = 512 байт), делим на интервал
    rd_bps=$((d_rd * 512 / interval))
    wr_bps=$((d_wr * 512 / interval))
    total_bps=$((rd_bps + wr_bps))

    mp=$(get_disk_info "$disk")
    mp_short=$(printf '%.14s' "$mp")

    rd_color=$(speed_color "$rd_bps")
    wr_color=$(speed_color "$wr_bps")

    rd_str=$(format_speed "$rd_bps")
    wr_str=$(format_speed "$wr_bps")
    tot_str=$(format_speed "$total_bps")

    printf "  %-10s %-14s ${rd_color}%-16s${NC} ${wr_color}%-16s${NC} %-10s\n" \
      "$disk" "$mp_short" "$rd_str" "$wr_str" "$tot_str"
  done
}

# --- Живой мониторинг ---
live_monitor() {
  interval="${1:-2}"
  filter="$2"

  trap 'printf "\033[?25h"; exit 0' INT TERM
  printf '\033[?25l'  # Скрыть курсор

  while true; do
    printf '\033[2J\033[H'  # Очистить экран
    _out "${B_CYN}═══ I/O Мониторинг (обновление каждые ${interval}с, Ctrl+C для выхода) ═══${NC}"
    _out "  $(date '+%H:%M:%S')"
    snapshot_io "$interval" "$filter"
    _out ""
  done
}

# --- Точка входа ---
main() {
  mode="snapshot"
  interval=2
  device=""

  while [ $# -gt 0 ]; do
    case "$1" in
      --live|-l)
        mode="live"
        if [ -n "$2" ] && [ "$2" -gt 0 ] 2>/dev/null; then
          interval="$2"; shift
        fi
        ;;
      --device|-d)
        device="$2"; shift
        ;;
      --help|-h)
        _out "Использование: io_monitor.sh [--live [секунды]] [--device имя_диска]"
        _out "  --live, -l      Непрерывный мониторинг"
        _out "  --device, -d    Фильтр по устройству (напр. sda)"
        _out "  --help, -h      Эта справка"
        return 0
        ;;
      *) ;;
    esac
    shift
  done

  if [ ! -r /proc/diskstats ]; then
    _out "${RED}Ошибка: /proc/diskstats недоступен${NC}"
    return 1
  fi

  case "$mode" in
    live) live_monitor "$interval" "$device" ;;
    *)    snapshot_io "$interval" "$device" ;;
  esac
}

main "$@"

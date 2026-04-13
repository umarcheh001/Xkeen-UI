#!/bin/sh
# ═══════════════════════════════════════════════════════════════
#  memory_check.sh — Диагностика памяти и swap
#  Подробный отчёт: RAM, буферы, кэш, swap, предупреждения.
#  Адаптировано из проекта Flashkeen.
#
#  Использование:
#    memory_check.sh            — полный отчёт
#    memory_check.sh --short    — краткий статус (одна строка)
#    memory_check.sh --json     — вывод в формате key=value
#
#  Совместимость: BusyBox ash / POSIX sh
#  Зависимости: /proc/meminfo, /proc/swaps
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

_out() { printf '%b\n' "$*"; }

# --- Чтение /proc/meminfo ---
read_meminfo() {
  if [ ! -r /proc/meminfo ]; then
    _out "${RED}Ошибка: /proc/meminfo недоступен${NC}"
    return 1
  fi

  MEM_TOTAL=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)
  MEM_FREE=$(awk '/^MemFree:/ {print $2}' /proc/meminfo)
  MEM_AVAILABLE=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)
  MEM_BUFFERS=$(awk '/^Buffers:/ {print $2}' /proc/meminfo)
  MEM_CACHED=$(awk '/^Cached:/ {print $2}' /proc/meminfo)
  MEM_SLAB=$(awk '/^Slab:/ {print $2}' /proc/meminfo)
  MEM_SRECLAIMABLE=$(awk '/^SReclaimable:/ {print $2}' /proc/meminfo)
  MEM_SUNRECLAIM=$(awk '/^SUnreclaim:/ {print $2}' /proc/meminfo)
  MEM_SHMEM=$(awk '/^Shmem:/ {print $2}' /proc/meminfo)

  SWAP_TOTAL=$(awk '/^SwapTotal:/ {print $2}' /proc/meminfo)
  SWAP_FREE=$(awk '/^SwapFree:/ {print $2}' /proc/meminfo)
  SWAP_CACHED=$(awk '/^SwapCached:/ {print $2}' /proc/meminfo)

  # Вычисляемые значения
  MEM_USED=$((MEM_TOTAL - MEM_FREE - MEM_BUFFERS - ${MEM_CACHED:-0}))
  [ "$MEM_USED" -lt 0 ] 2>/dev/null && MEM_USED=$((MEM_TOTAL - MEM_FREE))

  # MemAvailable — более точная метрика (ядро 3.14+)
  [ -z "$MEM_AVAILABLE" ] && MEM_AVAILABLE=$((MEM_FREE + MEM_BUFFERS + ${MEM_CACHED:-0}))

  SWAP_USED=$((${SWAP_TOTAL:-0} - ${SWAP_FREE:-0}))
}

# --- Форматирование KB → MB/GB ---
fmt_mb() {
  kb="$1"
  awk -v k="${kb:-0}" 'BEGIN{
    m=k/1024
    if(m>=1024) printf "%.1f ГБ", m/1024
    else printf "%d МБ", int(m)
  }'
}

# --- Прогресс-бар ---
bar() {
  pct="$1"
  width=25
  filled=$((pct * width / 100))
  empty=$((width - filled))

  if [ "$pct" -ge 90 ] 2>/dev/null; then
    c="$B_RED"
  elif [ "$pct" -ge 70 ] 2>/dev/null; then
    c="$B_YLW"
  else
    c="$B_GRN"
  fi

  printf '%b[' "$c"
  i=0; while [ "$i" -lt "$filled" ]; do printf '█'; i=$((i+1)); done
  i=0; while [ "$i" -lt "$empty" ]; do printf '░'; i=$((i+1)); done
  printf ']%b %d%%' "$NC" "$pct"
}

# --- Секция ---
section_header() {
  name="$1"
  color="${2:-$B_CYN}"
  bar_line="══════════════════════════════════════════════════════"
  _out ""
  _out "${color}╔${bar_line}╗${NC}"
  _out "${color}║${NC}   ${color}${name}\033[56G${color}║${NC}"
  _out "${color}╚${bar_line}╝${NC}"
}

# --- Оценка состояния ---
assess_health() {
  mem_pct=$((MEM_USED * 100 / MEM_TOTAL))
  avail_mb=$((MEM_AVAILABLE / 1024))
  has_swap=0
  [ "${SWAP_TOTAL:-0}" -gt 0 ] 2>/dev/null && has_swap=1

  warnings=""
  status="OK"

  # Критически мало памяти: <50 МБ доступно
  if [ "$avail_mb" -lt 50 ] 2>/dev/null; then
    status="CRITICAL"
    warnings="${warnings}\n  ${B_RED}▲ КРИТИЧНО: Доступно менее 50 МБ памяти!${NC}"
  # Мало памяти: <120 МБ доступно и нет swap
  elif [ "$avail_mb" -lt 120 ] 2>/dev/null && [ "$has_swap" -eq 0 ]; then
    status="WARNING"
    warnings="${warnings}\n  ${B_YLW}▲ Мало памяти (${avail_mb} МБ) и swap не настроен${NC}"
    warnings="${warnings}\n  ${YLW}  Рекомендуется создать swap-файл или swap-раздел${NC}"
  # Мало памяти: <120 МБ, но есть swap
  elif [ "$avail_mb" -lt 120 ] 2>/dev/null; then
    status="WARNING"
    warnings="${warnings}\n  ${B_YLW}▲ Мало памяти (${avail_mb} МБ), но swap активен${NC}"
  fi

  # Swap используется активно
  if [ "$has_swap" -eq 1 ] && [ "${SWAP_USED:-0}" -gt 0 ] 2>/dev/null; then
    swap_pct=$((SWAP_USED * 100 / SWAP_TOTAL))
    if [ "$swap_pct" -ge 80 ] 2>/dev/null; then
      [ "$status" = "OK" ] && status="WARNING"
      warnings="${warnings}\n  ${B_YLW}▲ Swap заполнен на ${swap_pct}% — система может тормозить${NC}"
    fi
  fi

  # Нет swap вообще
  if [ "$has_swap" -eq 0 ] && [ "$avail_mb" -lt 256 ] 2>/dev/null; then
    warnings="${warnings}\n  ${YLW}ℹ Swap не настроен. Для стабильности рекомендуется создать swap${NC}"
  fi

  # Slab слишком большой (>30% RAM)
  if [ -n "$MEM_SLAB" ] && [ "$MEM_SLAB" -gt 0 ] 2>/dev/null; then
    slab_pct=$((MEM_SLAB * 100 / MEM_TOTAL))
    if [ "$slab_pct" -ge 30 ] 2>/dev/null; then
      warnings="${warnings}\n  ${YLW}ℹ Slab занимает ${slab_pct}% RAM ($(fmt_mb "$MEM_SLAB")) — возможна фрагментация${NC}"
    fi
  fi
}

# --- Полный отчёт ---
print_full_report() {
  read_meminfo || return 1
  assess_health

  section_header "ПАМЯТЬ И SWAP" "$B_CYN"
  _out ""

  mem_pct=$((MEM_USED * 100 / MEM_TOTAL))
  avail_pct=$((MEM_AVAILABLE * 100 / MEM_TOTAL))

  # Общий статус
  case "$status" in
    CRITICAL) _out "  Статус: ${B_RED}● КРИТИЧНО${NC}" ;;
    WARNING)  _out "  Статус: ${B_YLW}● ВНИМАНИЕ${NC}" ;;
    OK)       _out "  Статус: ${B_GRN}● ОК${NC}" ;;
  esac
  _out ""

  # RAM
  _out "  ${B_WHT}── RAM ──${NC}"
  printf '  Использование:  '
  bar "$mem_pct"
  printf '\n'
  _out "  Всего:          $(fmt_mb "$MEM_TOTAL")"
  _out "  Использовано:   $(fmt_mb "$MEM_USED")"
  _out "  Доступно:       ${B_WHT}$(fmt_mb "$MEM_AVAILABLE")${NC}"
  _out "  Свободно:       $(fmt_mb "$MEM_FREE")"
  _out "  Буферы:         $(fmt_mb "${MEM_BUFFERS:-0}")"
  _out "  Кэш:            $(fmt_mb "${MEM_CACHED:-0}")"
  [ -n "$MEM_SLAB" ] && _out "  Slab:            $(fmt_mb "$MEM_SLAB")"
  [ -n "$MEM_SHMEM" ] && _out "  Shared:          $(fmt_mb "$MEM_SHMEM")"

  # Swap
  _out ""
  _out "  ${B_WHT}── SWAP ──${NC}"
  if [ "${SWAP_TOTAL:-0}" -gt 0 ] 2>/dev/null; then
    swap_pct=$((SWAP_USED * 100 / SWAP_TOTAL))
    printf '  Использование:  '
    bar "$swap_pct"
    printf '\n'
    _out "  Всего:          $(fmt_mb "$SWAP_TOTAL")"
    _out "  Использовано:   $(fmt_mb "$SWAP_USED")"
    _out "  Свободно:       $(fmt_mb "$SWAP_FREE")"
    [ -n "$SWAP_CACHED" ] && _out "  Кэш swap:       $(fmt_mb "$SWAP_CACHED")"

    # Детали из /proc/swaps
    if [ -r /proc/swaps ]; then
      _out ""
      _out "  ${B_WHT}Swap устройства:${NC}"
      awk 'NR>1 {
        name=$1; type=$2; sz=$3; used=$4; prio=$5
        sz_mb=int(sz/1024)
        us_mb=int(used/1024)
        printf "  %-24s %s  %dМБ/%dМБ  приоритет:%s\n", name, type, us_mb, sz_mb, prio
      }' /proc/swaps
    fi
  else
    _out "  ${YLW}Swap не настроен${NC}"
  fi

  # Предупреждения
  if [ -n "$warnings" ]; then
    _out ""
    _out "  ${B_WHT}── ПРЕДУПРЕЖДЕНИЯ ──${NC}"
    printf '%b\n' "$warnings"
  fi

  # Топ процессов по памяти
  _out ""
  _out "  ${B_WHT}── ТОП-5 по памяти ──${NC}"
  if [ -d /proc ]; then
    # Собираем RSS из /proc/*/status
    (
      for p in /proc/[0-9]*; do
        pid=$(basename "$p")
        [ -r "$p/status" ] || continue
        rss=$(awk '/^VmRSS:/ {print $2}' "$p/status" 2>/dev/null)
        [ -n "$rss" ] && [ "$rss" -gt 0 ] 2>/dev/null || continue
        name=$(cat "$p/comm" 2>/dev/null || echo '?')
        printf '%d %s %s\n' "$rss" "$pid" "$name"
      done
    ) | sort -rn | head -5 | while read -r rss pid name; do
      rss_mb=$((rss / 1024))
      pct=$((rss * 100 / MEM_TOTAL))
      printf "  ${B_WHT}%-16s${NC} PID:%-6s  %4d МБ  (%d%%)\n" "$name" "$pid" "$rss_mb" "$pct"
    done
  fi
}

# --- Краткий статус ---
print_short() {
  read_meminfo || return 1
  assess_health

  mem_pct=$((MEM_USED * 100 / MEM_TOTAL))
  avail_h=$(fmt_mb "$MEM_AVAILABLE")

  case "$status" in
    CRITICAL) printf "${B_RED}●${NC} " ;;
    WARNING)  printf "${B_YLW}●${NC} " ;;
    OK)       printf "${B_GRN}●${NC} " ;;
  esac

  printf "RAM: %d%% (доступно %s)" "$mem_pct" "$avail_h"

  if [ "${SWAP_TOTAL:-0}" -gt 0 ] 2>/dev/null; then
    swap_pct=$((SWAP_USED * 100 / SWAP_TOTAL))
    printf " | Swap: %d%%" "$swap_pct"
  else
    printf " | Swap: нет"
  fi
  printf '\n'
}

# --- Key=value вывод ---
print_kv() {
  read_meminfo || return 1
  assess_health

  printf 'mem_total_kb=%s\n' "$MEM_TOTAL"
  printf 'mem_used_kb=%s\n' "$MEM_USED"
  printf 'mem_available_kb=%s\n' "$MEM_AVAILABLE"
  printf 'mem_free_kb=%s\n' "$MEM_FREE"
  printf 'mem_buffers_kb=%s\n' "${MEM_BUFFERS:-0}"
  printf 'mem_cached_kb=%s\n' "${MEM_CACHED:-0}"
  printf 'swap_total_kb=%s\n' "${SWAP_TOTAL:-0}"
  printf 'swap_used_kb=%s\n' "${SWAP_USED:-0}"
  printf 'swap_free_kb=%s\n' "${SWAP_FREE:-0}"
  printf 'status=%s\n' "$status"
}

# --- Точка входа ---
main() {
  case "$1" in
    --short|-s) print_short ;;
    --json|-j)  print_kv ;;
    --help|-h)
      _out "Использование: memory_check.sh [--short | --json | --help]"
      _out "  Без аргументов   Полный отчёт с визуализацией"
      _out "  --short, -s      Одна строка со статусом"
      _out "  --json, -j       Вывод key=value для парсинга"
      _out "  --help, -h       Эта справка"
      ;;
    *)
      print_full_report
      _out ""
      ;;
  esac
}

main "$@"

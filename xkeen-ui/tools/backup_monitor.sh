#!/bin/sh
# ═══════════════════════════════════════════════════════════════
#  backup_monitor.sh — Расширенный мониторинг бэкапа Entware
#  Отслеживает прогресс создания бэкапа в реальном времени:
#  размер архива, скорость записи, ETA, I/O диска.
#  Адаптировано из проекта Flashkeen.
#
#  Использование:
#    backup_monitor.sh <путь_к_директории> [шаблон]
#      — мониторит рост файлов, подходящих под шаблон
#    backup_monitor.sh --status
#      — показать состояние последнего бэкапа
#
#  Совместимость: BusyBox ash / POSIX sh
#  Зависимости: /proc/diskstats (опционально)
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

STATE_DIR="/opt/var/lib/xkeen-ui"
STATE_FILE="$STATE_DIR/backup.state"

_out() { printf '%b\n' "$*"; }
has_cmd() { command -v "$1" >/dev/null 2>&1; }

# --- Форматирование размера ---
format_size() {
  bytes="$1"
  if [ "$bytes" -ge 1073741824 ] 2>/dev/null; then
    awk -v b="$bytes" 'BEGIN{printf "%.2f ГБ", b/1073741824}'
  elif [ "$bytes" -ge 1048576 ] 2>/dev/null; then
    awk -v b="$bytes" 'BEGIN{printf "%.2f МБ", b/1048576}'
  elif [ "$bytes" -ge 1024 ] 2>/dev/null; then
    awk -v b="$bytes" 'BEGIN{printf "%.1f КБ", b/1024}'
  else
    printf '%d Б' "${bytes:-0}"
  fi
}

# --- Форматирование скорости ---
format_speed() {
  bps="$1"
  if [ "$bps" -ge 1048576 ] 2>/dev/null; then
    awk -v b="$bps" 'BEGIN{printf "%.2f МБ/с", b/1048576}'
  elif [ "$bps" -ge 1024 ] 2>/dev/null; then
    awk -v b="$bps" 'BEGIN{printf "%.1f КБ/с", b/1024}'
  else
    printf '%d Б/с' "${bps:-0}"
  fi
}

# --- Форматирование времени ---
format_time() {
  secs="$1"
  if [ "$secs" -ge 3600 ] 2>/dev/null; then
    h=$((secs / 3600))
    m=$(((secs % 3600) / 60))
    s=$((secs % 60))
    printf '%dч %02dм %02dс' "$h" "$m" "$s"
  elif [ "$secs" -ge 60 ] 2>/dev/null; then
    m=$((secs / 60))
    s=$((secs % 60))
    printf '%dм %02dс' "$m" "$s"
  else
    printf '%dс' "${secs:-0}"
  fi
}

# --- Прогресс-бар ---
progress_bar() {
  current="$1"
  estimated_total="$2"  # Может быть 0 (неизвестно)
  width=30

  if [ "$estimated_total" -gt 0 ] 2>/dev/null; then
    pct=$((current * 100 / estimated_total))
    [ "$pct" -gt 100 ] && pct=100
    filled=$((pct * width / 100))
  else
    # Анимированный индикатор без известного размера
    pct=-1
    tick=$((current % (width * 2)))
    if [ "$tick" -ge "$width" ]; then
      pos=$((width * 2 - tick))
    else
      pos=$tick
    fi
    filled=$pos
  fi

  empty=$((width - filled))

  printf "${B_CYN}["
  i=0; while [ "$i" -lt "$filled" ]; do printf '█'; i=$((i+1)); done
  i=0; while [ "$i" -lt "$empty" ]; do printf '░'; i=$((i+1)); done
  printf ']'

  if [ "$pct" -ge 0 ] 2>/dev/null; then
    printf " %d%%" "$pct"
  else
    printf " ..."
  fi
  printf "${NC}"
}

# --- Сохранить состояние ---
save_state() {
  mkdir -p "$STATE_DIR" 2>/dev/null
  cat > "$STATE_FILE" <<EOF
state=$1
file=$2
start_ts=$3
current_size=$4
speed_bps=$5
elapsed=$6
timestamp=$(date +%s 2>/dev/null)
EOF
}

# --- Прочитать состояние ---
read_state() {
  if [ -f "$STATE_FILE" ]; then
    . "$STATE_FILE"
    return 0
  fi
  return 1
}

# --- Найти растущий файл бэкапа ---
find_backup_file() {
  dir="$1"
  pattern="${2:-*_entware_backup_*.tar.gz}"
  # Самый новый файл, подходящий под шаблон
  newest=""
  newest_ts=0
  for f in "$dir"/$pattern; do
    [ -f "$f" ] || continue
    # Используем ls -l для получения времени
    f_ts=$(stat -c '%Y' "$f" 2>/dev/null || stat -f '%m' "$f" 2>/dev/null || echo "0")
    if [ "$f_ts" -gt "$newest_ts" ] 2>/dev/null; then
      newest_ts="$f_ts"
      newest="$f"
    fi
  done
  printf '%s' "$newest"
}

# --- Получить размер /opt (источник бэкапа) для оценки ---
estimate_source_size() {
  if has_cmd du; then
    du -sk /opt 2>/dev/null | awk '{print $1 * 1024}'
  else
    echo "0"
  fi
}

# --- Мониторинг бэкапа в реальном времени ---
monitor_backup() {
  dir="$1"
  pattern="${2:-*_entware_backup_*.tar.gz}"
  interval="${3:-2}"

  if [ ! -d "$dir" ]; then
    _out "${RED}Ошибка: директория $dir не найдена${NC}"
    return 1
  fi

  _out "${B_CYN}═══ Мониторинг бэкапа ═══${NC}"
  _out "  Директория: ${CYN}$dir${NC}"
  _out "  Шаблон:     ${CYN}$pattern${NC}"
  _out ""

  # Оценка размера источника (сжатый будет ~30-60% от оригинала)
  src_size=$(estimate_source_size)
  est_compressed=$((src_size * 40 / 100))  # ~40% сжатие
  [ "$est_compressed" -eq 0 ] 2>/dev/null && est_compressed=0

  _out "  ${YLW}Ожидаю начало бэкапа...${NC}"

  start_ts=$(date +%s 2>/dev/null)
  prev_size=0
  tick=0
  stale_count=0

  trap 'printf "\033[?25h\n"; save_state "interrupted" "" "$start_ts" "$prev_size" "0" "0"; exit 0' INT TERM
  printf '\033[?25l'  # Скрыть курсор

  while true; do
    backup_file=$(find_backup_file "$dir" "$pattern")

    if [ -z "$backup_file" ]; then
      tick=$((tick + 1))
      if [ "$tick" -gt 150 ]; then  # 5 минут (150 * 2с)
        printf '\033[?25h'
        _out "\n  ${RED}Таймаут: файл бэкапа не появился за 5 минут${NC}"
        save_state "timeout" "" "$start_ts" "0" "0" "0"
        return 1
      fi
      sleep "$interval"
      continue
    fi

    # Файл найден
    cur_size=$(stat -c '%s' "$backup_file" 2>/dev/null || wc -c < "$backup_file" 2>/dev/null || echo "0")
    cur_size=$((cur_size + 0))

    now_ts=$(date +%s 2>/dev/null)
    elapsed=$((now_ts - start_ts))
    [ "$elapsed" -eq 0 ] && elapsed=1

    # Дельта за интервал
    delta=$((cur_size - prev_size))
    speed_bps=$((delta / interval))
    avg_speed=$((cur_size / elapsed))

    # ETA
    eta="—"
    if [ "$avg_speed" -gt 0 ] 2>/dev/null && [ "$est_compressed" -gt 0 ] 2>/dev/null; then
      remaining=$((est_compressed - cur_size))
      [ "$remaining" -lt 0 ] && remaining=0
      eta_sec=$((remaining / avg_speed))
      eta=$(format_time "$eta_sec")
    fi

    # Детект завершения: размер не меняется 3 итерации подряд
    if [ "$delta" -eq 0 ] && [ "$cur_size" -gt 0 ] 2>/dev/null; then
      stale_count=$((stale_count + 1))
    else
      stale_count=0
    fi

    # Вывод (перезапись строки)
    printf '\r\033[K'
    printf '  '
    progress_bar "$cur_size" "$est_compressed"
    printf '  %s' "$(format_size "$cur_size")"
    printf '  %s' "$(format_speed "$speed_bps")"
    printf '  ⏱ %s' "$(format_time "$elapsed")"
    [ "$eta" != "—" ] && printf '  ETA: %s' "$eta"

    save_state "running" "$backup_file" "$start_ts" "$cur_size" "$speed_bps" "$elapsed"

    prev_size="$cur_size"

    # Завершение: файл не растёт 3 цикла (6 секунд)
    if [ "$stale_count" -ge 3 ] && [ "$cur_size" -gt 100 ] 2>/dev/null; then
      printf '\033[?25h'
      _out ""
      _out ""
      _out "  ${B_GRN}✓ Бэкап завершён${NC}"
      _out "  Файл:     $(basename "$backup_file")"
      _out "  Размер:   $(format_size "$cur_size")"
      _out "  Время:    $(format_time "$elapsed")"
      _out "  Скорость: $(format_speed "$avg_speed") (средняя)"
      save_state "done" "$backup_file" "$start_ts" "$cur_size" "$avg_speed" "$elapsed"
      return 0
    fi

    sleep "$interval"
  done
}

# --- Показать статус ---
show_status() {
  if ! read_state; then
    _out "  ${YLW}Нет данных о бэкапе${NC}"
    return
  fi

  _out "${B_CYN}═══ Статус бэкапа ═══${NC}"
  _out ""

  case "$state" in
    running)
      _out "  Статус:   ${B_YLW}● В процессе${NC}"
      ;;
    done)
      _out "  Статус:   ${B_GRN}● Завершён${NC}"
      ;;
    interrupted)
      _out "  Статус:   ${B_RED}● Прерван${NC}"
      ;;
    timeout)
      _out "  Статус:   ${B_RED}● Таймаут${NC}"
      ;;
    *)
      _out "  Статус:   ${YLW}● Неизвестен ($state)${NC}"
      ;;
  esac

  [ -n "$file" ] && _out "  Файл:     $(basename "$file")"
  [ -n "$current_size" ] && [ "$current_size" -gt 0 ] 2>/dev/null && \
    _out "  Размер:   $(format_size "$current_size")"
  [ -n "$speed_bps" ] && [ "$speed_bps" -gt 0 ] 2>/dev/null && \
    _out "  Скорость: $(format_speed "$speed_bps")"
  [ -n "$elapsed" ] && [ "$elapsed" -gt 0 ] 2>/dev/null && \
    _out "  Время:    $(format_time "$elapsed")"

  if [ -n "$timestamp" ]; then
    now=$(date +%s 2>/dev/null)
    ago=$((now - timestamp))
    _out "  Обновлено: $(format_time "$ago") назад"
  fi
}

# --- Список бэкапов ---
list_backups() {
  dir="${1:-/opt}"

  _out "${B_CYN}═══ Существующие бэкапы ═══${NC}"
  _out ""

  found=0
  # Ищем на всех подключённых дисках
  for mp in $(awk '$1 ~ /^\/dev\/(sd|mmcblk)/ {print $2}' /proc/mounts 2>/dev/null) /opt; do
    for f in "$mp"/*_entware_backup_*.tar.gz; do
      [ -f "$f" ] || continue
      found=$((found + 1))
      fsize=$(stat -c '%s' "$f" 2>/dev/null || wc -c < "$f" 2>/dev/null || echo "0")
      fdate=$(stat -c '%y' "$f" 2>/dev/null | cut -d. -f1 || echo "?")
      fname=$(basename "$f")

      # Проверяем валидность архива (быстро)
      if tar -tzf "$f" >/dev/null 2>&1; then
        valid="${B_GRN}✓${NC}"
      else
        valid="${B_RED}✗${NC}"
      fi

      printf "  %b %-45s %10s  %s\n" "$valid" "$fname" "$(format_size "$fsize")" "$fdate"
    done
  done

  if [ "$found" -eq 0 ]; then
    _out "  ${YLW}Бэкапы не найдены${NC}"
  else
    _out ""
    _out "  ${B_WHT}Всего: ${found} бэкап(ов)${NC}"
    _out "  ${GRN}✓${NC} — архив валиден  ${RED}✗${NC} — архив повреждён"
  fi
}

# --- Точка входа ---
main() {
  case "$1" in
    --status|-s)
      show_status
      ;;
    --list|-l)
      list_backups "$2"
      ;;
    --help|-h)
      _out "Использование: backup_monitor.sh [опции]"
      _out "  <директория> [шаблон]  Мониторить бэкап в реальном времени"
      _out "  --status, -s           Показать статус последнего бэкапа"
      _out "  --list, -l [dir]       Список существующих бэкапов"
      _out "  --help, -h             Эта справка"
      ;;
    "")
      # Без аргументов — показать список + статус
      list_backups
      _out ""
      show_status
      ;;
    *)
      if [ -d "$1" ]; then
        monitor_backup "$1" "${2:-*_entware_backup_*.tar.gz}" "${3:-2}"
      else
        _out "${RED}Ошибка: $1 не является директорией${NC}"
        return 1
      fi
      ;;
  esac
  _out ""
}

main "$@"

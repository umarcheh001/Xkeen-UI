#!/bin/sh
# backup_monitor.sh - monitor backup artifacts and inspect existing items.

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

STATE_DIR="${XKEEN_UI_STATE_DIR:-/opt/var/lib/xkeen-ui}"
STATE_FILE="$STATE_DIR/backup.state"
SCAN_ROOTS_OVERRIDE="${XKEEN_BACKUP_MONITOR_PATHS:-}"
LOCAL_BACKUP_DIR="${XKEEN_LOCAL_BACKUP_DIR:-/opt/backups}"
XRAY_BACKUP_DIR="${XKEEN_XRAY_BACKUP_DIR:-/opt/etc/xray/configs/backups}"
MIHOMO_ROOT_DIR="${MIHOMO_ROOT:-/opt/etc/mihomo}"
MIHOMO_BACKUP_DIR="${XKEEN_MIHOMO_BACKUP_DIR:-$MIHOMO_ROOT_DIR/backup}"

SCANNED_LATEST_FILE=""
SCANNED_LATEST_SIZE=0
SCANNED_LATEST_DATE=""
SCANNED_LATEST_EPOCH=0
SCANNED_LATEST_VALID="unknown"
SCANNED_LATEST_KIND="unknown"
SCANNED_TOTAL_BACKUPS=0

_out() { printf '%b\n' "$*"; }
has_cmd() { command -v "$1" >/dev/null 2>&1; }

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

progress_bar() {
  current="$1"
  total="$2"
  width="${3:-24}"

  if [ "$total" -le 0 ] 2>/dev/null; then
    total=1
  fi

  pct=$((current * 100 / total))
  [ "$pct" -gt 100 ] && pct=100
  filled=$((pct * width / 100))
  empty=$((width - filled))

  printf "${B_CYN}["
  i=0
  while [ "$i" -lt "$filled" ]; do
    printf '█'
    i=$((i + 1))
  done
  i=0
  while [ "$i" -lt "$empty" ]; do
    printf '░'
    i=$((i + 1))
  done
  printf '] %d%%%s' "$pct" "$NC"
}

spinner_frame() {
  case $(( $1 % 4 )) in
    0) printf '|' ;;
    1) printf '/' ;;
    2) printf '-' ;;
    3) printf '\\' ;;
  esac
}

sleep_brief() {
  sleep 0.2 2>/dev/null || sleep 1
}

clear_progress_line() {
  printf '\r\033[K' >&2 2>/dev/null || true
}

print_task_progress() {
  current="$1"
  total="$2"
  label="$3"

  clear_progress_line
  printf '  ' >&2
  progress_bar "$current" "$total" >&2
  printf ' %s' "$label" >&2
}

make_tmp_file() {
  suffix="${1:-tmp}"
  tmp=$(mktemp "/tmp/xk_backup_monitor.${suffix}.XXXXXX" 2>/dev/null)
  if [ -z "$tmp" ]; then
    tmp="/tmp/xk_backup_monitor.${suffix}.$$"
    : > "$tmp" 2>/dev/null || true
  fi
  printf '%s' "$tmp"
}

get_file_size() {
  file="$1"
  size=$(stat -c '%s' "$file" 2>/dev/null || stat -f '%z' "$file" 2>/dev/null)
  [ -n "$size" ] || size=$(wc -c < "$file" 2>/dev/null || echo "0")
  printf '%s' "${size:-0}"
}

get_path_size() {
  path="$1"
  if [ -d "$path" ]; then
    size_kb=$(du -sk "$path" 2>/dev/null | awk 'NR==1{print $1+0}')
    printf '%s' "$(( (${size_kb:-0} + 0) * 1024 ))"
    return 0
  fi
  get_file_size "$path"
}

get_file_mtime_epoch() {
  file="$1"
  ts=$(stat -c '%Y' "$file" 2>/dev/null || stat -f '%m' "$file" 2>/dev/null)
  printf '%s' "${ts:-0}"
}

get_file_mtime_text() {
  file="$1"
  txt=$(stat -c '%y' "$file" 2>/dev/null | cut -d. -f1)
  if [ -z "$txt" ]; then
    txt=$(date -r "$file" '+%Y-%m-%d %H:%M:%S' 2>/dev/null)
  fi
  [ -n "$txt" ] || txt="?"
  printf '%s' "$txt"
}

get_backup_kind() {
  path="$1"
  name=$(basename "$path" 2>/dev/null)
  lower=$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]')

  if [ -d "$path" ]; then
    case "$lower" in
      *configs*xray*) printf 'xray-config-dir' ;;
      *configs*mihomo*) printf 'mihomo-config-dir' ;;
      *) printf 'backup-dir' ;;
    esac
    return 0
  fi

  case "$lower" in
    *.tar.gz)
      case "$lower" in
        *entware*backup*) printf 'entware-archive' ;;
        *) printf 'archive' ;;
      esac
      ;;
    *.json|*.jsonc)
      printf 'xray-config-file'
      ;;
    *.yaml|*.yml)
      printf 'mihomo-config-file'
      ;;
    *)
      printf ''
      ;;
  esac
}

backup_kind_label() {
  case "$1" in
    entware-archive) printf 'Entware архив' ;;
    archive) printf 'Архив' ;;
    xray-config-dir) printf 'Xray конфиг-бэкап' ;;
    mihomo-config-dir) printf 'Mihomo конфиг-бэкап' ;;
    backup-dir) printf 'Каталог бэкапа' ;;
    xray-config-file) printf 'Xray snapshot' ;;
    mihomo-config-file) printf 'Mihomo backup' ;;
    *) printf 'Бэкап' ;;
  esac
}

backup_check_text() {
  valid="$1"
  kind="$2"

  case "$valid:$kind" in
    ok:entware-archive|ok:archive)
      printf 'архив валиден'
      ;;
    broken:entware-archive|broken:archive)
      printf 'архив повреждён'
      ;;
    ok:xray-config-dir|ok:mihomo-config-dir|ok:backup-dir)
      printf 'каталог доступен'
      ;;
    broken:xray-config-dir|broken:mihomo-config-dir|broken:backup-dir)
      printf 'каталог пуст или недоступен'
      ;;
    ok:xray-config-file|ok:mihomo-config-file)
      printf 'файл найден'
      ;;
    broken:xray-config-file|broken:mihomo-config-file)
      printf 'файл пуст или повреждён'
      ;;
    *)
      printf 'не проверялся'
      ;;
  esac
}

ensure_state_dir() {
  mkdir -p "$STATE_DIR" 2>/dev/null || true
}

save_state() {
  ensure_state_dir
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

read_state() {
  if [ -f "$STATE_FILE" ]; then
    . "$STATE_FILE"
    return 0
  fi
  return 1
}

find_backup_file() {
  dir="$1"
  pattern="${2:-*_entware_backup_*.tar.gz}"
  newest=""
  newest_ts=0

  for f in "$dir"/$pattern; do
    [ -f "$f" ] || continue
    f_ts=$(get_file_mtime_epoch "$f")
    if [ "$f_ts" -gt "$newest_ts" ] 2>/dev/null; then
      newest_ts="$f_ts"
      newest="$f"
    fi
  done

  printf '%s' "$newest"
}

estimate_source_size() {
  if has_cmd du; then
    du -sk /opt 2>/dev/null | awk '{print $1 * 1024}'
  else
    echo "0"
  fi
}

collect_scan_roots() {
  explicit_dir="$1"

  if [ -n "$explicit_dir" ] && [ -d "$explicit_dir" ]; then
    printf '%s\n' "$explicit_dir"
    return 0
  fi

  if [ -n "$SCAN_ROOTS_OVERRIDE" ]; then
    printf '%s\n' "$SCAN_ROOTS_OVERRIDE" | tr ':;' '\n' | awk 'NF && !seen[$0]++ { print $0 }'
    return 0
  fi

  {
    awk '$1 ~ /^\/dev\/(sd|mmcblk)/ {print $2}' /proc/mounts 2>/dev/null
    [ -d /storage ] && printf '/storage\n'
    [ -d /opt ] && printf '/opt\n'
    [ -d /tmp ] && printf '/tmp\n'
    [ -d "$LOCAL_BACKUP_DIR" ] && printf '%s\n' "$LOCAL_BACKUP_DIR"
    [ -d "$XRAY_BACKUP_DIR" ] && printf '%s\n' "$XRAY_BACKUP_DIR"
    [ -d "$MIHOMO_BACKUP_DIR" ] && printf '%s\n' "$MIHOMO_BACKUP_DIR"
  } | awk 'NF && !seen[$0]++ { print $0 }'
}

count_lines() {
  file="$1"
  [ -f "$file" ] || {
    printf '0'
    return 0
  }
  awk 'NF {count++} END {print count + 0}' "$file"
}

append_backup_entry() {
  raw_file="$1"
  path="$2"

  [ -e "$path" ] || return 0

  kind=$(get_backup_kind "$path")
  [ -n "$kind" ] || return 0

  printf '%s\t%s\t%s\n' "$(get_file_mtime_epoch "$path")" "$kind" "$path" >> "$raw_file"
}

scan_backup_dir() {
  raw_file="$1"
  dir="$2"

  [ -d "$dir" ] || return 0

  for f in "$dir"/*entware*backup*.tar.gz; do
    append_backup_entry "$raw_file" "$f"
  done

  for f in "$dir"/*configs*xray* "$dir"/*configs*mihomo*; do
    append_backup_entry "$raw_file" "$f"
  done

  case "$dir" in
    "$XRAY_BACKUP_DIR")
      for f in "$dir"/*.json "$dir"/*.jsonc; do
        append_backup_entry "$raw_file" "$f"
      done
      ;;
    "$MIHOMO_BACKUP_DIR")
      for f in "$dir"/*.yaml "$dir"/*.yml; do
        append_backup_entry "$raw_file" "$f"
      done
      ;;
  esac
}

scan_backup_index() {
  target_dir="$1"
  show_progress="${2:-0}"
  roots_file=$(make_tmp_file roots)
  raw_file=$(make_tmp_file raw)
  sorted_file=$(make_tmp_file sorted)

  collect_scan_roots "$target_dir" > "$roots_file"
  total_roots=$(count_lines "$roots_file")
  idx=0
  : > "$raw_file"

  while IFS= read -r root; do
    [ -n "$root" ] || continue
    idx=$((idx + 1))
    if [ "$show_progress" = "1" ]; then
      print_task_progress "$idx" "$total_roots" "Сканирую раздел: $root"
    fi
    scan_backup_dir "$raw_file" "$root"
    scan_backup_dir "$raw_file" "$root/backups"
    scan_backup_dir "$raw_file" "$root/backup"
  done < "$roots_file"

  if [ "$show_progress" = "1" ]; then
    clear_progress_line
  fi

  if [ -s "$raw_file" ]; then
    sort -t "$(printf '\t')" -k1,1nr "$raw_file" | awk -F '\t' '!seen[$3]++ { print $0 }' > "$sorted_file"
  else
    : > "$sorted_file"
  fi

  rm -f "$roots_file" "$raw_file" 2>/dev/null || true
  printf '%s' "$sorted_file"
}

validate_archive_with_spinner() {
  file="$1"
  current="$2"
  total="$3"

  tar -tzf "$file" >/dev/null 2>&1 &
  pid=$!
  spin=0

  while kill -0 "$pid" 2>/dev/null; do
    frame=$(spinner_frame "$spin")
    print_task_progress "$current" "$total" "Проверяю ${frame} $(basename "$file")"
    sleep_brief
    spin=$((spin + 1))
  done

  wait "$pid"
  rc=$?
  clear_progress_line
  return "$rc"
}

validate_backup_item() {
  file="$1"
  kind="$2"
  current="$3"
  total="$4"

  case "$kind" in
    entware-archive|archive)
      validate_archive_with_spinner "$file" "$current" "$total"
      ;;
    xray-config-dir|mihomo-config-dir|backup-dir)
      [ -d "$file" ] || return 1
      ls -A "$file" >/dev/null 2>&1
      ;;
    xray-config-file|mihomo-config-file)
      [ -s "$file" ]
      ;;
    *)
      [ -e "$file" ]
      ;;
  esac
}

cache_latest_backup() {
  latest_file="$1"
  latest_valid="$2"
  latest_kind="$3"

  [ -n "$latest_file" ] || return 0

  SCANNED_LATEST_FILE="$latest_file"
  SCANNED_LATEST_SIZE=$(get_path_size "$latest_file")
  SCANNED_LATEST_DATE=$(get_file_mtime_text "$latest_file")
  SCANNED_LATEST_EPOCH=$(get_file_mtime_epoch "$latest_file")
  SCANNED_LATEST_VALID="$latest_valid"
  SCANNED_LATEST_KIND="$latest_kind"
}

scan_latest_backup() {
  target_dir="$1"
  show_progress="${2:-0}"

  SCANNED_LATEST_FILE=""
  SCANNED_LATEST_SIZE=0
  SCANNED_LATEST_DATE=""
  SCANNED_LATEST_EPOCH=0
  SCANNED_LATEST_VALID="unknown"
  SCANNED_LATEST_KIND="unknown"
  SCANNED_TOTAL_BACKUPS=0

  index_file=$(scan_backup_index "$target_dir" "$show_progress")
  if [ ! -s "$index_file" ]; then
    rm -f "$index_file" 2>/dev/null || true
    return 1
  fi

  SCANNED_TOTAL_BACKUPS=$(count_lines "$index_file")

  IFS="$(printf '\t')" read -r _latest_epoch latest_kind latest_file < "$index_file"
  rm -f "$index_file" 2>/dev/null || true

  [ -n "$latest_file" ] || return 1

  if validate_backup_item "$latest_file" "$latest_kind" 1 1; then
    latest_valid="ok"
  else
    latest_valid="broken"
  fi

  cache_latest_backup "$latest_file" "$latest_valid" "$latest_kind"
  return 0
}

print_scanned_status() {
  [ -n "$SCANNED_LATEST_FILE" ] || {
    _out "  ${YLW}Нет данных о бэкапе${NC}"
    return 0
  }

  _out "${B_CYN}═══ Статус бэкапа ═══${NC}"
  _out ""
  _out "  Статус:     ${B_GRN}● Найден бэкап${NC}"
  _out "  Тип:        $(backup_kind_label "$SCANNED_LATEST_KIND")"
  _out "  Объект:     $(basename "$SCANNED_LATEST_FILE")"
  _out "  Раздел:     $(dirname "$SCANNED_LATEST_FILE")"
  _out "  Размер:     $(format_size "$SCANNED_LATEST_SIZE")"
  _out "  Изменён:    $SCANNED_LATEST_DATE"

  case "$SCANNED_LATEST_VALID" in
    ok)
      _out "  Проверка:   ${B_GRN}✓ $(backup_check_text "$SCANNED_LATEST_VALID" "$SCANNED_LATEST_KIND")${NC}"
      ;;
    broken)
      _out "  Проверка:   ${B_RED}✗ $(backup_check_text "$SCANNED_LATEST_VALID" "$SCANNED_LATEST_KIND")${NC}"
      ;;
    *)
      _out "  Проверка:   ${YLW}$(backup_check_text "$SCANNED_LATEST_VALID" "$SCANNED_LATEST_KIND")${NC}"
      ;;
  esac

  [ "$SCANNED_TOTAL_BACKUPS" -gt 0 ] 2>/dev/null && \
    _out "  Найдено:    ${SCANNED_TOTAL_BACKUPS} архив(ов)"
}

print_state_status() {
  _out "${B_CYN}═══ Статус бэкапа ═══${NC}"
  _out ""

  case "$state" in
    running)
      _out "  Статус:     ${B_YLW}● В процессе${NC}"
      ;;
    done)
      _out "  Статус:     ${B_GRN}● Завершён${NC}"
      ;;
    interrupted)
      _out "  Статус:     ${B_RED}● Прерван${NC}"
      ;;
    timeout)
      _out "  Статус:     ${B_RED}● Таймаут${NC}"
      ;;
    *)
      _out "  Статус:     ${YLW}● Неизвестен ($state)${NC}"
      ;;
  esac

  [ -n "$file" ] && _out "  Файл:       $(basename "$file")"
  [ -n "$file" ] && [ -f "$file" ] && _out "  Раздел:     $(dirname "$file")"
  [ -n "$current_size" ] && [ "$current_size" -gt 0 ] 2>/dev/null && \
    _out "  Размер:     $(format_size "$current_size")"
  [ -n "$speed_bps" ] && [ "$speed_bps" -gt 0 ] 2>/dev/null && \
    _out "  Скорость:   $(format_speed "$speed_bps")"
  [ -n "$elapsed" ] && [ "$elapsed" -gt 0 ] 2>/dev/null && \
    _out "  Время:      $(format_time "$elapsed")"

  if [ -n "$timestamp" ]; then
    now=$(date +%s 2>/dev/null)
    ago=$((now - timestamp))
    [ "$ago" -lt 0 ] && ago=0
    _out "  Обновлено:  $(format_time "$ago") назад"
  fi
}

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

  src_size=$(estimate_source_size)
  est_compressed=$((src_size * 40 / 100))
  [ "$est_compressed" -eq 0 ] 2>/dev/null && est_compressed=0

  _out "  ${YLW}Ожидаю начало бэкапа...${NC}"

  start_ts=$(date +%s 2>/dev/null)
  prev_size=0
  tick=0
  stale_count=0

  trap 'printf "\033[?25h\n"; save_state "interrupted" "" "$start_ts" "$prev_size" "0" "0"; exit 0' INT TERM
  printf '\033[?25l'

  while true; do
    backup_file=$(find_backup_file "$dir" "$pattern")

    if [ -z "$backup_file" ]; then
      tick=$((tick + 1))
      if [ "$tick" -gt 150 ]; then
        printf '\033[?25h'
        _out "\n  ${RED}Таймаут: файл бэкапа не появился за 5 минут${NC}"
        save_state "timeout" "" "$start_ts" "0" "0" "0"
        return 1
      fi
      sleep "$interval"
      continue
    fi

    cur_size=$(get_file_size "$backup_file")
    cur_size=$((cur_size + 0))

    now_ts=$(date +%s 2>/dev/null)
    elapsed=$((now_ts - start_ts))
    [ "$elapsed" -eq 0 ] && elapsed=1

    delta=$((cur_size - prev_size))
    speed_bps=$((delta / interval))
    avg_speed=$((cur_size / elapsed))

    eta="—"
    if [ "$avg_speed" -gt 0 ] 2>/dev/null && [ "$est_compressed" -gt 0 ] 2>/dev/null; then
      remaining=$((est_compressed - cur_size))
      [ "$remaining" -lt 0 ] && remaining=0
      eta_sec=$((remaining / avg_speed))
      eta=$(format_time "$eta_sec")
    fi

    if [ "$delta" -eq 0 ] && [ "$cur_size" -gt 0 ] 2>/dev/null; then
      stale_count=$((stale_count + 1))
    else
      stale_count=0
    fi

    printf '\r\033[K'
    printf '  '
    progress_bar "$cur_size" "$est_compressed" 30
    printf '  %s' "$(format_size "$cur_size")"
    printf '  %s' "$(format_speed "$speed_bps")"
    printf '  ⏱ %s' "$(format_time "$elapsed")"
    [ "$eta" != "—" ] && printf '  ETA: %s' "$eta"

    save_state "running" "$backup_file" "$start_ts" "$cur_size" "$speed_bps" "$elapsed"
    prev_size="$cur_size"

    if [ "$stale_count" -ge 3 ] && [ "$cur_size" -gt 100 ] 2>/dev/null; then
      printf '\033[?25h'
      _out ""
      _out ""
      _out "  ${B_GRN}✓ Бэкап завершён${NC}"
      _out "  Файл:       $(basename "$backup_file")"
      _out "  Размер:     $(format_size "$cur_size")"
      _out "  Время:      $(format_time "$elapsed")"
      _out "  Скорость:   $(format_speed "$avg_speed") (средняя)"
      save_state "done" "$backup_file" "$start_ts" "$cur_size" "$avg_speed" "$elapsed"
      return 0
    fi

    sleep "$interval"
  done
}

list_backups() {
  dir="$1"
  _out "${B_CYN}═══ Существующие бэкапы ═══${NC}"
  _out ""

  SCANNED_LATEST_FILE=""
  SCANNED_LATEST_SIZE=0
  SCANNED_LATEST_DATE=""
  SCANNED_LATEST_EPOCH=0
  SCANNED_LATEST_VALID="unknown"
  SCANNED_LATEST_KIND="unknown"
  SCANNED_TOTAL_BACKUPS=0

  index_file=$(scan_backup_index "$dir" 1)
  found=$(count_lines "$index_file")
  SCANNED_TOTAL_BACKUPS="$found"

  if [ "$found" -eq 0 ] 2>/dev/null; then
    rm -f "$index_file" 2>/dev/null || true
    _out "  ${YLW}Бэкапы не найдены${NC}"
    return 0
  fi

  results_file=$(make_tmp_file results)
  idx=0

  while IFS="$(printf '\t')" read -r _epoch kind f; do
    [ -e "$f" ] || continue
    idx=$((idx + 1))
    fname=$(basename "$f")
    fsize=$(get_path_size "$f")
    fdate=$(get_file_mtime_text "$f")

    if validate_backup_item "$f" "$kind" "$idx" "$found"; then
      valid_mark="${B_GRN}✓${NC}"
      valid_state="ok"
    else
      valid_mark="${B_RED}✗${NC}"
      valid_state="broken"
    fi

    if [ "$idx" -eq 1 ]; then
      cache_latest_backup "$f" "$valid_state" "$kind"
    fi

    printf "  %b [%-18s] %-40s %10s  %s\n" \
      "$valid_mark" \
      "$(backup_kind_label "$kind")" \
      "$fname" \
      "$(format_size "$fsize")" \
      "$fdate" >> "$results_file"
  done < "$index_file"

  clear_progress_line
  cat "$results_file"
  _out ""
  _out "  ${B_WHT}Всего: ${found} бэкап(ов)${NC}"
  _out "  ${GRN}✓${NC} — объект доступен  ${RED}✗${NC} — объект повреждён или пуст"

  rm -f "$index_file" "$results_file" 2>/dev/null || true
}

show_status() {
  target_dir="$1"
  state_loaded=0

  if read_state && [ -n "$state" ]; then
    state_loaded=1
  fi

  if [ -z "$SCANNED_LATEST_FILE" ]; then
    scan_latest_backup "$target_dir" 1
  fi

  if [ "$state_loaded" -eq 1 ] && [ -n "$file" ] && [ -f "$file" ]; then
    latest_epoch="${SCANNED_LATEST_EPOCH:-0}"
    state_epoch="${timestamp:-0}"

    if [ -n "$SCANNED_LATEST_FILE" ] && { [ "$SCANNED_LATEST_FILE" != "$file" ] || [ "$latest_epoch" -gt "$state_epoch" ] 2>/dev/null; }; then
      print_scanned_status
      return 0
    fi

    print_state_status
    return 0
  fi

  if [ -n "$SCANNED_LATEST_FILE" ]; then
    print_scanned_status
    return 0
  fi

  if [ "$state_loaded" -eq 1 ]; then
    print_state_status
    return 0
  fi

  _out "  ${YLW}Нет данных о бэкапе${NC}"
}

main() {
  case "$1" in
    --status|-s)
      show_status "$2"
      ;;
    --list|-l)
      list_backups "$2"
      ;;
    --help|-h)
      _out "Использование: backup_monitor.sh [опции]"
      _out "  <директория> [шаблон]    Мониторить бэкап в реальном времени"
      _out "  --status, -s [dir]       Показать статус последнего бэкапа"
      _out "  --list, -l [dir]         Список существующих бэкапов"
      _out "  --help, -h               Эта справка"
      ;;
    "")
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

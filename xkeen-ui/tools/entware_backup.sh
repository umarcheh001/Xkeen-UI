#!/bin/sh
# Backup Entware (/opt) to a tar.gz archive.
# UI helper for XKeen UI command card.
# Can be run from Interactive Shell:
#   sh /opt/etc/xkeen-ui/tools/entware_backup.sh
# or via wrapper:
#   entware-backup
#
# Features (adapted from Flashkeen):
#   - Real-time speed/size monitor during archiving
#   - Free space check before backup
#   - Archive validation after creation
#   - Cleanup of failed/broken backups
#   - Precise size formatting (e.g. 8.2 MB)
#   - Summary line: size, time, speed

export LD_LIBRARY_PATH=/lib:/usr/lib:${LD_LIBRARY_PATH}

RED='\033[1;31m'
GREEN='\033[1;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

TMP_DIR="/tmp"
OPT_DIR="/opt"
STORAGE_DIR="/storage"
LOCAL_BACKUP_DIR="${XKEEN_LOCAL_BACKUP_DIR:-/opt/backups}"
DATE="$(date +%Y-%m-%d_%H-%M)"
PACKAGES_LIST="tar libacl"
STATE_DIR="${XKEEN_UI_STATE_DIR:-/opt/var/lib/xkeen-ui}"
STATE_FILE="$STATE_DIR/backup.state"
PROC_MOUNTS_FILE="${XKEEN_PROC_MOUNTS_FILE:-/proc/mounts}"

# --- Globals for backup monitor ---
BACKUP_MONITOR_PID=""
BACKUP_MONITOR_STATE_FILE=""
BACKUP_START_TS=""
LAST_BACKUP_FINAL_BYTES=0
LAST_BACKUP_ELAPSED=0
LAST_BACKUP_AVG_SPEED_BPS=0

# ---------------------------------------------------------------------------
#  Formatting helpers
# ---------------------------------------------------------------------------

print_message() {
  message="$1"
  color="${2:-$NC}"
  border=$(printf '%0.s-' $(seq 1 $((${#message} + 2))))
  printf "${color}\n+${border}+\n| ${message} |\n+${border}+\n${NC}\n"
}

# Precise size formatting with decimals (adapted from flashkeen format_size_backup).
format_size_precise() {
  bytes="$1"
  kib=$((bytes / 1024))

  if [ "$kib" -ge 1048576 ] 2>/dev/null; then
    # >= 1 GB
    awk -v k="$kib" 'BEGIN{ printf "%.1f GB", k/1024/1024 }'
  elif [ "$kib" -ge 1024 ] 2>/dev/null; then
    # >= 1 MB
    awk -v k="$kib" 'BEGIN{ printf "%.1f MB", k/1024 }'
  else
    printf "%d KB" "$kib"
  fi
}

# Legacy format_size for drive selection display (used/total).
format_size() {
  used=$1
  total=$2
  used_mb=$((used / 1024 / 1024))
  total_mb=$((total / 1024 / 1024))
  if [ "$total_mb" -ge 1024 ]; then
    total_gb=$((total / 1024 / 1024 / 1024))
    if [ "$used_mb" -lt 1024 ]; then
      printf "%d MB / %d GB" "$used_mb" "$total_gb"
    else
      used_gb=$((used / 1024 / 1024 / 1024))
      printf "%d / %d GB" "$used_gb" "$total_gb"
    fi
  else
    printf "%d / %d MB" "$used_mb" "$total_mb"
  fi
}

# Format elapsed seconds as HH:MM:SS.
format_elapsed() {
  s="$1"
  h=$((s / 3600))
  m=$(((s % 3600) / 60))
  sec=$((s % 60))
  printf "%02d:%02d:%02d" "$h" "$m" "$sec"
}

get_file_size_bytes() {
  file="$1"
  size=$(stat -c %s "$file" 2>/dev/null || true)
  [ -z "$size" ] && size=$(stat -f %z "$file" 2>/dev/null || true)
  if [ -z "$size" ]; then
    size_kib=$(du -sk "$file" 2>/dev/null | awk 'NR==1{print $1+0}')
    [ -n "$size_kib" ] || size_kib=0
    size=$((size_kib * 1024))
  fi
  printf "%s" "${size:-0}"
}

ensure_state_dir() {
  mkdir -p "$STATE_DIR" 2>/dev/null || true
}

save_last_backup_state() {
  backup_file="$1"
  start_ts="$2"
  current_size="$3"
  speed_bps="$4"
  elapsed="$5"

  [ -n "$backup_file" ] || return 0
  ensure_state_dir

  cat > "$STATE_FILE" <<EOF
state=done
file=$backup_file
start_ts=$start_ts
current_size=$current_size
speed_bps=$speed_bps
elapsed=$elapsed
timestamp=$(date +%s 2>/dev/null)
EOF
}

# ---------------------------------------------------------------------------
#  Backup monitor — real-time speed & size (adapted from flashkeen)
# ---------------------------------------------------------------------------

start_backup_monitor() {
  monitor_dir="$1"
  monitor_glob="$2"
  monitor_max_sec="${3:-1800}"
  [ -n "$monitor_glob" ] || monitor_glob="*.tar.gz"

  stop_backup_monitor 2>/dev/null

  BACKUP_START_TS=$(date +%s 2>/dev/null)
  BACKUP_MONITOR_STATE_FILE="/tmp/entware_backup_monitor_state.$$"
  : > "$BACKUP_MONITOR_STATE_FILE" 2>/dev/null || true

  (
    elapsed=0
    last_file=""
    last_kib=0
    idle_ticks=0
    while [ "$elapsed" -lt "$monitor_max_sec" ] 2>/dev/null; do
      latest=""
      if [ -n "$monitor_dir" ] && [ -d "$monitor_dir" ]; then
        latest=$(ls -1t "$monitor_dir"/$monitor_glob 2>/dev/null | awk 'NR==1{print; exit}')
      fi

      if [ -n "$latest" ] && [ -f "$latest" ]; then
        cur_bytes=$(get_file_size_bytes "$latest")
        cur_kib=$((cur_bytes / 1024))

        if [ "$latest" != "$last_file" ]; then
          last_file="$latest"
          last_kib="$cur_kib"
          idle_ticks=0
        else
          d_kib=$((cur_kib - last_kib))
          [ "$d_kib" -lt 0 ] 2>/dev/null && d_kib=0

          speed=$(awk -v k="$d_kib" 'BEGIN{ printf "%.2f", k/1024 }')
          done_h=$(format_size_precise $((cur_kib * 1024)))
          printf "\r\033[K  Скорость: %s MB/s | Размер: %s" "$speed" "$done_h" 2>/dev/null || true

          printf "latest=%s\ncur_kib=%s\n" "$latest" "$cur_kib" > "$BACKUP_MONITOR_STATE_FILE" 2>/dev/null || true

          if [ "$d_kib" -gt 0 ] 2>/dev/null; then
            idle_ticks=0
          else
            idle_ticks=$((idle_ticks + 1))
          fi
          last_kib="$cur_kib"
        fi
      fi

      [ "$idle_ticks" -ge 40 ] 2>/dev/null && break
      sleep 1
      elapsed=$((elapsed + 1))
    done
  ) &
  BACKUP_MONITOR_PID=$!
  return 0
}

stop_backup_monitor() {
  if [ -n "$BACKUP_MONITOR_PID" ] && kill -0 "$BACKUP_MONITOR_PID" 2>/dev/null; then
    kill "$BACKUP_MONITOR_PID" 2>/dev/null || true
    wait "$BACKUP_MONITOR_PID" 2>/dev/null || true
  fi
  # Clear the monitor line.
  printf "\r\033[K" 2>/dev/null || true
  BACKUP_MONITOR_PID=""
}

# Print summary line after backup completes.
print_backup_summary() {
  backup_file="$1"
  start_ts="$2"
  end_ts=$(date +%s 2>/dev/null)
  [ -n "$end_ts" ] || end_ts="$start_ts"

  elapsed=$((end_ts - start_ts))
  [ "$elapsed" -le 0 ] 2>/dev/null && elapsed=1

  final_bytes=$(get_file_size_bytes "$backup_file")
  avg_speed_bps=$((final_bytes / elapsed))
  size_h=$(format_size_precise "$final_bytes")
  elapsed_h=$(format_elapsed "$elapsed")
  speed=$(awk -v b="$avg_speed_bps" 'BEGIN{ printf "%.1f", b/1024/1024 }')

  LAST_BACKUP_FINAL_BYTES="$final_bytes"
  LAST_BACKUP_ELAPSED="$elapsed"
  LAST_BACKUP_AVG_SPEED_BPS="$avg_speed_bps"

  printf "${GREEN}  Итого: %s за %s (средняя скорость %s MB/s)${NC}\n" "$size_h" "$elapsed_h" "$speed"
}

# ---------------------------------------------------------------------------
#  Free space check (adapted from flashkeen)
# ---------------------------------------------------------------------------

# Estimate /opt size in KB and check if target has enough free space.
check_free_space() {
  target_dir="$1"
  opt_size_kb=$(du -sk "$OPT_DIR" 2>/dev/null | awk '{print $1}')
  [ -n "$opt_size_kb" ] || opt_size_kb=0

  # Compressed archive is typically 30-60% of source; require at least 70% as safety margin.
  required_kb=$(awk -v s="$opt_size_kb" 'BEGIN{ printf "%d", s * 0.7 }')

  free_kb=$(df -kP "$target_dir" 2>/dev/null | awk 'NR==2 {print $4}')
  [ -n "$free_kb" ] || free_kb=0

  if [ "$free_kb" -lt "$required_kb" ] 2>/dev/null; then
    free_h=$(format_size_precise $((free_kb * 1024)))
    req_h=$(format_size_precise $((required_kb * 1024)))
    print_message "Недостаточно места: свободно $free_h, требуется ~$req_h" "$RED"
    return 1
  fi
  return 0
}

# ---------------------------------------------------------------------------
#  Archive validation (check archive integrity after creation)
# ---------------------------------------------------------------------------

validate_archive() {
  archive="$1"
  [ -f "$archive" ] || return 1

  # Quick integrity check: list contents without extracting.
  if ! tar -tzf "$archive" >/dev/null 2>&1; then
    return 1
  fi

  # Verify Entware signatures: expect at least bin, etc, lib, sbin.
  sig_count=0
  for sig in bin etc lib sbin usr var; do
    if tar -tzf "$archive" 2>/dev/null | grep -q "^\./$sig/"; then
      sig_count=$((sig_count + 1))
    fi
  done

  if [ "$sig_count" -lt 4 ]; then
    return 1
  fi
  return 0
}

# ---------------------------------------------------------------------------
#  Cleanup of failed/broken backups (adapted from flashkeen keensnap_offer_delete_failed_backup_dirs)
# ---------------------------------------------------------------------------

cleanup_failed_backups() {
  backup_dir="$1"
  start_ts="$2"
  [ -n "$backup_dir" ] || return 0
  [ -d "$backup_dir" ] || return 0

  found=""
  for f in "$backup_dir"/*_entware_backup_*.tar.gz; do
    [ -f "$f" ] || continue
    # Check if file was created during this session (after start_ts).
    f_mtime=$(stat -c %Y "$f" 2>/dev/null || true)
    [ -z "$f_mtime" ] && f_mtime=$(stat -f %m "$f" 2>/dev/null || true)
    [ -n "$f_mtime" ] || continue
    [ "$f_mtime" -ge "$start_ts" ] 2>/dev/null || continue

    # Check if it's a broken archive (zero-size or fails validation).
    f_size=$(stat -c %s "$f" 2>/dev/null || true)
    [ -z "$f_size" ] && f_size=0
    if [ "$f_size" -lt 100 ] 2>/dev/null || ! tar -tzf "$f" >/dev/null 2>&1; then
      found="$found $f"
    fi
  done

  [ -n "$found" ] || return 0

  printf "${YELLOW}Обнаружены повреждённые/пустые бэкапы:${NC}\n"
  for f in $found; do
    printf "  - %s\n" "$(basename "$f")"
  done

  printf "\nУдалить их? [y/N]: "
  if ! read -r ans; then
    echo ""
    return 0
  fi
  case "$ans" in
    y|Y|д|Д)
      for f in $found; do
        rm -f "$f" 2>/dev/null && printf "  Удалён: %s\n" "$(basename "$f")"
      done
      ;;
  esac
  return 0
}

# ---------------------------------------------------------------------------
#  RCI helpers (Keenetic router API)
# ---------------------------------------------------------------------------

rci_request() {
  endpoint="$1"
  curl -fsS "http://localhost:79/rci/$endpoint" 2>/dev/null
}

rci_parse() {
  command="$1"
  curl -fsS -H "Content-Type: application/json" \
    -d "[{\"parse\":\"$command\"}]" \
    "http://localhost:79/rci/" 2>/dev/null
}

# ---------------------------------------------------------------------------
#  Drive info & selection
# ---------------------------------------------------------------------------

get_internal_storage_size() {
  ls_json=$(rci_request "ls")
  free=$(echo "$ls_json" | grep -A10 '"storage:"' | grep '"free":' | head -1 | grep -o '[0-9]\+')
  total=$(echo "$ls_json" | grep -A10 '"storage:"' | grep '"total":' | head -1 | grep -o '[0-9]\+')
  if [ -n "$free" ] && [ -n "$total" ]; then
    used=$((total - free))
    format_size "$used" "$total"
    return
  fi
  echo "—"
}

get_architecture() {
  arch=$(opkg print-architecture | grep -oE 'mips-3|mipsel-3|aarch64-3' | head -n 1)
  case "$arch" in
    "mips-3") echo "mips" ;;
    "mipsel-3") echo "mipsel" ;;
    "aarch64-3") echo "aarch64" ;;
    *) echo "unknown_arch" ;;
  esac
}

packages_checker() {
  packages="$1"
  missing=""
  installed=$(opkg list-installed 2>/dev/null)

  for pkg in $packages; do
    if ! echo "$installed" | grep -q "^$pkg "; then
      missing="$missing $pkg"
    fi
  done

  if [ -n "$missing" ]; then
    print_message "Устанавливаем:$missing" "$GREEN"
    opkg update >/dev/null 2>&1
    opkg install $missing
    echo ""
  fi
}

select_drive_extract_value() {
  echo "$1" | cut -d ':' -f2- | sed 's/^[[:space:]]*//; s/[",]//g'
}

select_drive_reset_partition() {
  in_partition=0
  uuid=""
  label=""
  fstype=""
  total_bytes=""
  free_bytes=""
}

select_drive_reset_media() {
  media_found=1
  media_is_usb=0
  current_manufacturer=""
  select_drive_reset_partition
}

select_drive_add_partition() {
  used_bytes=0

  if [ "$(echo "$fstype" | tr '[:upper:]' '[:lower:]')" = "swap" ]; then
    select_drive_reset_partition
    return
  fi

  echo "$total_bytes" | grep -qE '^[0-9]+$' || total_bytes=0
  echo "$free_bytes" | grep -qE '^[0-9]+$' || free_bytes=0

  used_bytes=$((total_bytes - free_bytes))
  [ "$used_bytes" -lt 0 ] && used_bytes=0

  if [ -n "$label" ]; then
    display_name="$label"
  elif [ -n "$current_manufacturer" ]; then
    display_name="$current_manufacturer"
  else
    display_name="Unknown"
  fi

  fstype_upper=$(echo "$fstype" | tr '[:lower:]' '[:upper:]')
  echo "$index. $display_name ($fstype_upper, $(format_size "$used_bytes" "$total_bytes"))"
  uuids="$uuids $uuid"
  index=$((index + 1))
  select_drive_reset_partition
}

get_path_usage_label() {
  path="$1"
  line=$(df -kP "$path" 2>/dev/null | awk 'NR==2 {print $2 "\t" $4}')
  [ -n "$line" ] || {
    echo "—"
    return 0
  }

  total_kb=$(echo "$line" | awk -F '\t' '{print $1 + 0}')
  free_kb=$(echo "$line" | awk -F '\t' '{print $2 + 0}')
  used_bytes=$(((total_kb - free_kb) * 1024))
  total_bytes=$((total_kb * 1024))

  format_size "$used_bytes" "$total_bytes"
}

select_drive_add_option() {
  option_path="$1"
  option_label="$2"

  [ -n "$option_path" ] || return 0
  [ -d "$option_path" ] || return 0

  echo "$index. $option_label"
  DRIVE_OPTIONS="${DRIVE_OPTIONS}${index}|$option_path
"
  index=$((index + 1))
}

get_usb_candidate_devices() {
  awk '$1 ~ /^\/dev\/(sd|mmcblk|nvme)/ && !seen[$1]++ { print $1 }' "$PROC_MOUNTS_FILE" 2>/dev/null
}

get_usb_device_mount_row() {
  device="$1"
  [ -n "$device" ] || return 0

  awk -v dev="$device" -v opt_dir="$OPT_DIR" '
    function rank(mp) {
      if (mp ~ /^\/tmp\/mnt\//) return 0
      if (mp ~ /^\/media\//) return 1
      if (mp ~ /^\/mnt\//) return 2
      if (mp == opt_dir) return 9
      return 5
    }

    $1 == dev && !seen[$2]++ {
      print rank($2) "\t" $2 "\t" $3
    }
  ' "$PROC_MOUNTS_FILE" 2>/dev/null | sort -n | awk -F '\t' 'NR == 1 { print $2 "\t" $3 }'
}

select_drive_add_usb_options() {
  candidate_devices=$(get_usb_candidate_devices)
  [ -n "$candidate_devices" ] || return 0

  while IFS= read -r device; do
    [ -n "$device" ] || continue
    mount_row=$(get_usb_device_mount_row "$device")
    mount_point=$(printf '%s' "$mount_row" | awk -F '\t' 'NR==1 {print $1}')
    fs_type=$(printf '%s' "$mount_row" | awk -F '\t' 'NR==1 {print $2}')

    [ -d "$mount_point" ] || continue
    [ "$mount_point" = "$STORAGE_DIR" ] && continue

    # Метка раздела из blkid (BusyBox-совместимый парсинг)
    disk_label=""
    if command -v blkid >/dev/null 2>&1 && [ -n "$device" ]; then
      disk_label=$(blkid "$device" 2>/dev/null | sed -n 's/.* LABEL="\([^"]*\)".*/\1/p')
    fi
    mount_name="${disk_label:-$(basename "$mount_point")}"

    fs_label=$(printf '%s' "$fs_type" | tr '[:lower:]' '[:upper:]')
    select_drive_add_option \
      "$mount_point" \
      "USB: $mount_name ($fs_label, $(get_path_usage_label "$mount_point"))"
  done <<EOF2
$candidate_devices
EOF2
}

select_drive() {
  message="$1"

  index=0
  DRIVE_OPTIONS=""
  mkdir -p "$LOCAL_BACKUP_DIR" 2>/dev/null || true

  echo "00. Выход"
  [ -d "$STORAGE_DIR" ] && \
    select_drive_add_option "$STORAGE_DIR" "Встроенное хранилище ($(get_path_usage_label "$STORAGE_DIR"))"
  select_drive_add_option "$LOCAL_BACKUP_DIR" "Локальная папка бэкапов ($(get_path_usage_label "$LOCAL_BACKUP_DIR"))"
  select_drive_add_usb_options

  [ -n "$DRIVE_OPTIONS" ] || {
    print_message "Не найдено доступных путей для бэкапа" "$RED"
    return 1
  }

  echo ""
  if ! read -r -p "$message " choice; then
    echo ""
    exit 0
  fi
  choice=$(echo "$choice" | tr -d ' \n\r')
  echo ""

  case "$choice" in
    00)
      print_message "Выход из entware-backup" "$YELLOW"
      exit 0
      ;;
    *)
      selected_drive=$(printf '%s' "$DRIVE_OPTIONS" | awk -F '|' -v choice="$choice" '$1 == choice { print $2; exit }')
      if [ -z "$selected_drive" ]; then
        print_message "Неверный выбор" "$RED"
        return 1
      fi
      ;;
  esac

  return 0
}

# ---------------------------------------------------------------------------
#  Main backup function
# ---------------------------------------------------------------------------

backup_entware() {
  [ -d "$OPT_DIR" ] || {
    print_message "Каталог $OPT_DIR не найден" "$RED"
    exit 1
  }

  packages_checker "$PACKAGES_LIST"

  if ! select_drive "Выберите накопитель для бэкапа Entware:"; then
    exit 1
  fi

  [ -n "$selected_drive" ] || {
    print_message "Накопитель не выбран" "$RED"
    exit 1
  }

  mkdir -p "$selected_drive" 2>/dev/null || true

  # --- Check free space before starting ---
  if ! check_free_space "$selected_drive"; then
    exit 1
  fi

  backup_file="$selected_drive/$(get_architecture)_entware_backup_$DATE.tar.gz"
  bn=$(basename "$backup_file")
  session_start_ts=$(date +%s 2>/dev/null)
  [ -n "$session_start_ts" ] || session_start_ts=0

  print_message "Создаю бэкап Entware" "$CYAN"
  printf "  Архив: %s\n" "$bn"
  printf "  Назначение: %s\n\n" "$selected_drive"

  # --- Start real-time monitor ---
  start_backup_monitor "$selected_drive" "*_entware_backup_*.tar.gz"

  # Build exclude list: skip old backups, current backup, and temp/cache files
  excl=""
  # Exclude all previous entware backup archives anywhere under /opt
  for old_bak in "$OPT_DIR"/*_entware_backup_*.tar.gz; do
    [ -f "$old_bak" ] || continue
    old_bn=$(basename "$old_bak")
    excl="$excl --exclude=./$old_bn"
  done
  # Also check selected_drive — it may be inside /opt (e.g. /opt/mnt/...)
  for old_bak in "$selected_drive"/*_entware_backup_*.tar.gz; do
    [ -f "$old_bak" ] || continue
    # Convert to path relative to OPT_DIR
    rel="${old_bak#$OPT_DIR/}"
    excl="$excl --exclude=./$rel"
  done
  # Exclude current backup filename (safety)
  excl="$excl --exclude=$bn"
  # Exclude common temp/cache that shouldn't be in backup
  excl="$excl --exclude=./tmp/*"
  excl="$excl --exclude=./var/cache/opkg"
  excl="$excl --exclude=./var/run/*"
  excl="$excl --exclude=./var/lock/*"

  tar_output=$(eval tar cvzf \"\$backup_file\" -C \"\$OPT_DIR\" $excl . 2>&1)
  rc=$?
  log_operation=$(echo "$tar_output" | tail -n 4)

  # --- Stop monitor ---
  stop_backup_monitor

  if [ "$rc" -ne 0 ] || echo "$log_operation" | grep -iq "error\|no space left on device"; then
    print_message "Ошибка при создании бэкапа" "$RED"
    [ -n "$log_operation" ] && echo "$log_operation"

    # Offer to clean up failed backup
    cleanup_failed_backups "$selected_drive" "$session_start_ts"
    exit 1
  fi

  # --- Validate archive integrity ---
  printf "  Проверяю целостность архива..."
  if validate_archive "$backup_file"; then
    printf " OK\n"
  else
    printf " ОШИБКА\n"
    print_message "Архив повреждён или не содержит структуру Entware" "$RED"
    cleanup_failed_backups "$selected_drive" "$session_start_ts"
    exit 1
  fi

  # --- Print summary ---
  print_backup_summary "$backup_file" "$session_start_ts"
  save_last_backup_state \
    "$backup_file" \
    "$session_start_ts" \
    "$LAST_BACKUP_FINAL_BYTES" \
    "$LAST_BACKUP_AVG_SPEED_BPS" \
    "$LAST_BACKUP_ELAPSED"
  echo ""
  print_message "Бэкап успешно сохранён в $backup_file" "$GREEN"
}

# ---------------------------------------------------------------------------
#  Cleanup handler
# ---------------------------------------------------------------------------

cleanup() {
  rc=$?
  stop_backup_monitor 2>/dev/null
  [ -n "$BACKUP_MONITOR_STATE_FILE" ] && rm -f "$BACKUP_MONITOR_STATE_FILE" 2>/dev/null
  exit "$rc"
}

trap cleanup HUP INT TERM EXIT
backup_entware

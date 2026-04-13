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
DATE="$(date +%Y-%m-%d_%H-%M)"
PACKAGES_LIST="tar libacl"

# --- Globals for backup monitor ---
BACKUP_MONITOR_PID=""
BACKUP_MONITOR_STATE_FILE=""
BACKUP_START_TS=""

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
        # Get current size in bytes via stat, fallback to du.
        cur_bytes=$(stat -c %s "$latest" 2>/dev/null || true)
        [ -z "$cur_bytes" ] && cur_bytes=$(stat -f %z "$latest" 2>/dev/null || true)
        if [ -n "$cur_bytes" ] 2>/dev/null; then
          cur_kib=$((cur_bytes / 1024))
        else
          cur_kib=$(du -sk "$latest" 2>/dev/null | awk 'NR==1{print $1+0}')
          [ -n "$cur_kib" ] || cur_kib=0
        fi

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

  # Get final size
  final_bytes=$(stat -c %s "$backup_file" 2>/dev/null || true)
  [ -z "$final_bytes" ] && final_bytes=$(stat -f %z "$backup_file" 2>/dev/null || true)
  if [ -z "$final_bytes" ]; then
    final_kib=$(du -sk "$backup_file" 2>/dev/null | awk 'NR==1{print $1+0}')
    [ -n "$final_kib" ] || final_kib=0
    final_bytes=$((final_kib * 1024))
  fi

  size_h=$(format_size_precise "$final_bytes")
  elapsed_h=$(format_elapsed "$elapsed")
  speed=$(awk -v b="$final_bytes" -v s="$elapsed" 'BEGIN{
    if (s <= 0) s = 1;
    printf "%.1f", (b/1024/1024)/s;
  }')

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
  curl -s "http://localhost:79/rci/$endpoint"
}

rci_parse() {
  command="$1"
  curl -fsS -H "Content-Type: application/json" \
    -d "[{\"parse\":\"$command\"}]" \
    "http://localhost:79/rci/"
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

select_drive() {
  message="$1"

  uuids=""
  index=2
  media_found=0
  media_is_usb=0
  media_output=$(rci_parse "show media")
  current_manufacturer=""
  select_drive_reset_partition

  if [ -z "$media_output" ]; then
    print_message "Не удалось получить список накопителей" "$RED"
    return 1
  fi

  echo "00. Выход"
  echo "0. Временное хранилище (tmp)"
  echo "1. Встроенное хранилище ($(get_internal_storage_size))"

  while IFS= read -r line; do
    value=$(select_drive_extract_value "$line")
    case "$line" in
      *"\"Media"*"\":"* | *"name: Media"*)
        select_drive_reset_media
        ;;
      *"\"bus\":"* | *"bus:"*)
        if [ "$media_found" = "1" ] && [ "$value" = "usb" ]; then
          media_is_usb=1
        fi
        ;;
      *"\"manufacturer\":"* | *"manufacturer:"*)
        if [ "$media_found" = "1" ]; then
          current_manufacturer="$value"
        fi
        ;;
      *"\"uuid\":"* | *"uuid:"*)
        if [ "$media_found" = "1" ] && [ "$media_is_usb" = "1" ]; then
          select_drive_reset_partition
          in_partition=1
          uuid="$value"
        fi
        ;;
      *"\"label\":"* | *"label:"*)
        [ "$in_partition" = "1" ] && label="$value"
        ;;
      *"\"fstype\":"* | *"fstype:"*)
        [ "$in_partition" = "1" ] && fstype="$value"
        ;;
      *"\"total\":"* | *"total:"*)
        [ "$in_partition" = "1" ] && total_bytes="$value"
        ;;
      *"\"free\":"* | *"free:"*)
        if [ "$in_partition" = "1" ]; then
          free_bytes="$value"
          select_drive_add_partition
        fi
        ;;
    esac
  done <<EOF2
$media_output
EOF2

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
    0) selected_drive="$TMP_DIR" ;;
    1) selected_drive="$STORAGE_DIR" ;;
    *)
      if [ -n "$uuids" ]; then
        selected_drive=$(echo "$uuids" | awk -v choice="$choice" '{split($0, a, " "); print a[choice-1]}')
        if [ -z "$selected_drive" ]; then
          print_message "Неверный выбор" "$RED"
          return 1
        fi
        selected_drive="/tmp/mnt/$selected_drive"
      else
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

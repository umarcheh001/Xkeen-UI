#!/bin/sh
# Backup Entware (/opt) to a tar.gz archive.
# UI helper for XKeen UI command card.
# Can be run from Interactive Shell:
#   sh /opt/etc/xkeen-ui/tools/entware_backup.sh
# or via wrapper:
#   entware-backup

export LD_LIBRARY_PATH=/lib:/usr/lib:${LD_LIBRARY_PATH}

RED='\033[1;31m'
GREEN='\033[1;32m'
CYAN='\033[0;36m'
NC='\033[0m'

TMP_DIR="/tmp"
OPT_DIR="/opt"
STORAGE_DIR="/storage"
DATE="$(date +%Y-%m-%d_%H-%M)"
PACKAGES_LIST="tar libacl"

print_message() {
  local message="$1"
  local color="${2:-$NC}"
  local border
  border=$(printf '%0.s-' $(seq 1 $((${#message} + 2))))
  printf "${color}\n+${border}+\n| ${message} |\n+${border}+\n${NC}\n"
}

spinner_start() {
  SPINNER_MSG="$1"
  local spin='|/-\\' i=0
  echo -n "[ ] $SPINNER_MSG"
  (
    while :; do
      i=$(((i + 1) % 4))
      printf "\r[%s] %s" "${spin:$i:1}" "$SPINNER_MSG"
      usleep 100000
    done
  ) &
  SPINNER_PID=$!
}

spinner_stop() {
  local rc=${1:-0}
  if [ -n "$SPINNER_PID" ]; then
    kill "$SPINNER_PID" 2>/dev/null
    wait "$SPINNER_PID" 2>/dev/null
    unset SPINNER_PID
  fi
  if [ "$rc" -eq 0 ]; then
    printf "\r[✔] %s\n" "$SPINNER_MSG"
  else
    printf "\r[✖] %s\n" "$SPINNER_MSG"
  fi
}

rci_request() {
  local endpoint="$1"
  curl -s "http://localhost:79/rci/$endpoint"
}

rci_parse() {
  local command="$1"
  curl -fsS -H "Content-Type: application/json" \
    -d "[{\"parse\":\"$command\"}]" \
    "http://localhost:79/rci/"
}

format_size() {
  local used=$1
  local total=$2
  local used_mb=$((used / 1024 / 1024))
  local total_mb=$((total / 1024 / 1024))
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

get_internal_storage_size() {
  local ls_json free total used
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
  local packages="$1"
  local missing=""
  local installed
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
  local used_bytes display_name fstype_upper

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
  local message="$1"
  local value

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

backup_entware() {
  local backup_file tar_output rc log_operation

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
  backup_file="$selected_drive/$(get_architecture)_entware_backup_$DATE.tar.gz"

  spinner_start "Выполняю бэкап Entware"
  tar_output=$(tar cvzf "$backup_file" -C "$OPT_DIR" --exclude="$(basename "$backup_file")" . 2>&1)
  rc=$?
  log_operation=$(echo "$tar_output" | tail -n 4)

  if [ "$rc" -ne 0 ] || echo "$log_operation" | grep -iq "error\|no space left on device"; then
    spinner_stop 1
    print_message "Ошибка при создании бэкапа" "$RED"
    [ -n "$log_operation" ] && echo "$log_operation"
    exit 1
  fi

  spinner_stop 0
  print_message "Бэкап успешно сохранён в $backup_file" "$GREEN"
}

cleanup() {
  rc=$?
  if [ -n "$SPINNER_PID" ]; then
    kill "$SPINNER_PID" 2>/dev/null
    wait "$SPINNER_PID" 2>/dev/null
    printf "\r\n"
    unset SPINNER_PID
  fi
  exit "$rc"
}

trap cleanup HUP INT TERM EXIT
backup_entware

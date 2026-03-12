#!/bin/sh
# xkeen-ui: System monitor for Keenetic/Entware-like routers (busybox-friendly)
#
# Usage (inside router):
#   sh /opt/etc/xkeen-ui/tools/sysmon_keenetic.sh
# Options:
#   --short     меньше вывода
#   --full      больше диагностики (top, подробные логи)
#   --no-color  отключить ANSI цвета
#   --json      машиночитаемый вывод (best-effort)
# Env:
#   LOG=/opt/var/log/sysmon.txt     append output to file
#   MODE=short|default|full         same as flags

LOG="${LOG:-}"
MODE="${MODE:-default}"
NO_COLOR=0
AS_JSON=0

while [ $# -gt 0 ]; do
  case "$1" in
    --short|short) MODE="short";;
    --full|full) MODE="full";;
    --no-color) NO_COLOR=1;;
    --json) AS_JSON=1;;
    -h|--help)
      echo "sysmon: sh /opt/etc/xkeen-ui/tools/sysmon_keenetic.sh [--short|--full] [--no-color] [--json]";
      exit 0
      ;;
  esac
  shift
done

have() { command -v "$1" >/dev/null 2>&1; }

# --- Keenetic RCI helpers (borrowed from KeenKit, trimmed; no firmware/OTA actions) ---
rci_request() {
  # Usage: rci_request "show/version"
  # Returns raw JSON or empty string. Works with curl/wget.
  ep="$1"
  [ -z "$ep" ] && return 1
  url="http://127.0.0.1:79/rci/${ep}"
  if have curl; then
    curl -fsS --max-time 2 "$url" 2>/dev/null
    return $?
  fi
  if have wget; then
    wget -q -T 2 -O - "$url" 2>/dev/null
    return $?
  fi
  return 1
}

rci_json_str() {
  # Extract "key": "value" from a one-level JSON snippet (best-effort).
  # Usage: rci_json_str "$json" key
  j="$1"; k="$2"
  [ -z "$j" ] || [ -z "$k" ] && { echo ""; return 1; }
  printf '%s' "$j" | grep -o "\"$k\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" 2>/dev/null | head -n1 | cut -d'"' -f4
}

rci_json_num() {
  # Extract "key": "123" OR "key": 123
  j="$1"; k="$2"
  [ -z "$j" ] || [ -z "$k" ] && { echo ""; return 1; }
  v="$(printf '%s' "$j" | grep -o "\"$k\"[[:space:]]*:[[:space:]]*\"*[0-9]\+\"*" 2>/dev/null | head -n1 | grep -o '[0-9]\+' 2>/dev/null)"
  printf '%s' "$v"
}

get_device_name() {
  j="$(rci_request "show/version" 2>/dev/null || true)"
  rci_json_str "$j" device
}

get_fw_title() {
  j="$(rci_request "show/version" 2>/dev/null || true)"
  rci_json_str "$j" title
}

get_hw_id() {
  j="$(rci_request "show/version" 2>/dev/null || true)"
  rci_json_str "$j" hw_id
}

get_uptime_rci() {
  j="$(rci_request "show/system" 2>/dev/null || true)"
  rci_json_num "$j" uptime
}

get_ram_usage_rci() {
  # Returns "used / total MB" from show/system memory field if present.
  j="$(rci_request "show/system" 2>/dev/null || true)"
  mem="$(rci_json_str "$j" memory 2>/dev/null || true)"

  case "$mem" in
    */*)
      used="${mem%%/*}"
      total="${mem##*/}"
      ;;
    *)
      used=""; total=""
      ;;
  esac
  case "$used" in ''|*[!0-9]*) used="";; esac
  case "$total" in ''|*[!0-9]*) total="";; esac
  [ -n "$used" ] && [ -n "$total" ] || return 1
  [ "$total" -gt 0 ] 2>/dev/null || return 1

  # Keenetic/RCI may return KB or bytes depending on firmware/build.
  if [ "$total" -ge 100000000 ] 2>/dev/null; then
    # bytes -> MiB
    um=$((used/1048576))
    tm=$((total/1048576))
  else
    # KB -> MiB
    um=$((used/1024))
    tm=$((total/1024))
  fi

  echo "${um} / ${tm} MB"
  return 0
}


get_boot_current() {
  # Dual image slot if present (0/1). Not all devices have it.
  if [ -r /proc/dual_image/boot_current ]; then
    v="$(cat /proc/dual_image/boot_current 2>/dev/null | tr -d '\r\n')"
    case "$v" in 0|1) echo "$v"; return 0;; esac
  fi
  echo ""
  return 1
}

get_arch_short() {
  # KeenKit-style arch label
  if command -v opkg >/dev/null 2>&1; then
    a="$(opkg print-architecture 2>/dev/null | grep -oE 'aarch64-3|mipsel-3|mips-3' | head -n1 || true)"
    case "$a" in
      aarch64-3) echo "aarch64"; return 0;;
      mipsel-3)  echo "mipsel";  return 0;;
      mips-3)    echo "mips";    return 0;;
    esac
  fi
  uname -m 2>/dev/null | sed 's/-.*//' || true
}


get_cpu_soc() {
  # Try to extract SoC id from NDM libs (fast, but optional).
  # Falls back to /proc/cpuinfo model name later.
  if have strings && [ -r /lib/libndmMwsController.so ]; then
    soc="$(strings /lib/libndmMwsController.so 2>/dev/null | grep -Eo 'EN[0-9]{2,6}[A-Za-z0-9_-]*|MT[0-9]{3,6}[A-Za-z0-9_-]*|IPQ[0-9]{3,6}[A-Za-z0-9_-]*' | head -n1)"
    [ -n "$soc" ] && { echo "$soc"; return 0; }
  fi
  echo ""
  return 1
}

get_radio_temp_c() {
  # Usage: get_radio_temp_c WifiMaster0
  r="$1"
  [ -z "$r" ] && { echo ""; return 1; }
  j="$(rci_request "show/interface/${r}" 2>/dev/null || true)"
  t="$(rci_json_num "$j" temperature 2>/dev/null || true)"
  case "$t" in ''|*[!0-9]*) echo ""; return 1;; esac
  echo "$t"
  return 0
}

get_wifi_temps_summary() {
  # Returns "Wi-Fi: 2.4G 55°C, 5G 62°C" (best-effort)
  t0="$(get_radio_temp_c WifiMaster0 2>/dev/null || true)"
  t1="$(get_radio_temp_c WifiMaster1 2>/dev/null || true)"
  msg=""
  if [ -n "$t0" ]; then msg="2.4G ${t0}°C"; fi
  if [ -n "$t1" ]; then
    [ -n "$msg" ] && msg="${msg}, "
    msg="${msg}5G ${t1}°C"
  fi
  [ -n "$msg" ] && printf 'Wi-Fi: %s' "$msg"
}

get_modem_info() {
  command -v ndmc >/dev/null 2>&1 || return 0

  # collect modem interfaces (UsbQmiN / UsbLteN)
  ifaces="$(ndmc -c "show interface" 2>/dev/null | awk '
    /^[[:space:]]*id:[[:space:]]*Usb(Qmi|Lte)[0-9]+/ {print $2}
  ' | sort -u)"

  [ -z "$ifaces" ] && return 0

  out=""
  for iface in $ifaces; do
    info="$(ndmc -c "show interface $iface" 2>/dev/null)" || continue

    plugged="$(printf '%s\n' "$info" | awk -F': ' '/^[[:space:]]*plugged:/ {print $2; exit}')"
    [ "$plugged" = "no" ] && continue

    # take the LAST "product:" (on some devices there are multiple occurrences)
    product="$(printf '%s\n' "$info" | awk -F': ' '/^[[:space:]]*product:/ {p=$2} END{print p}')"
    [ -z "$product" ] && product="$iface"

    # parse all carrier blocks (including inactive ones) -> B<band>@<bw> МГц
    bands="$(printf '%s\n' "$info" | awk '
      BEGIN{out=""; incar=0; band=""; bw=""}
      /^[[:space:]]*carrier, id =/ {incar=1; band=""; bw=""; next}
      incar && /^[[:space:]]*band:/ {band=$2; next}
      incar && /^[[:space:]]*bandwidth:/ {
        bw=$2
        if (band != "" && bw != "") {
          key="B" band "@" bw " МГц"
          if (!(key in seen)) {
            seen[key]=1
            if (out != "") out=out " + "
            out=out key
          }
        }
        incar=0
        next
      }
      END{print out}
    ')"

    # fallback: single band/bandwidth (older firmwares)
    if [ -z "$bands" ]; then
      bands="$(printf '%s\n' "$info" | awk '
        /^[[:space:]]*band:/ {band=$2}
        /^[[:space:]]*bandwidth:/ {bw=$2}
        END{ if (band != "" && bw != "") print "B" band "@" bw " МГц"; else print "" }
      ')"
    fi

    line="$product"
    [ -n "$bands" ] && line="$line | $bands"

    if [ -z "$out" ]; then
      out="$line"
    else
      out="$out\n$line"
    fi
  done

  [ -n "$out" ] && printf '%b\n' "$out"
  return 0
}



list_modem_ifaces() {
  # Return list of modem interface names (space-separated): UsbQmi0 UsbQmi1 ...
  have ndmc || return 1
  ndmc -c "show interface" 2>/dev/null \
    | tr -d '\r' \
    | grep -oE 'Usb(Qmi|Mbim|Ndis|Lte|Eth|Modem|Cdc|Rndis|Ras|Serial)[0-9]+' \
    | sort -u
}

get_iface_state_ndmc() {
  # $1 = interface name (ndm). prints: up|down|"" (best-effort)
  ifc="$1"
  [ -z "$ifc" ] && { echo ""; return 1; }
  have ndmc || { echo ""; return 1; }
  out="$(ndmc -c "show interface $ifc" 2>/dev/null | tr -d '\r' || true)"
  st="$(printf '%s\n' "$out" | awk '
    {
      k=tolower($1); gsub(/:$/, "", k);
      if ((k=="state" || k=="link") && NF>=2) { print $2; exit; }
    }')"
  st_l="$(printf '%s' "$st" | tr 'A-Z' 'a-z')"
  case "$st_l" in
    up|down) echo "$st_l"; return 0;;
  esac
  echo ""
  return 1
}

get_modem_details() {
  # $1 = modem iface (UsbQmi0 ...). prints compact details for UI.
  ifc="$1"
  [ -z "$ifc" ] && { echo ""; return 1; }
  have ndmc || { echo ""; return 1; }

  out="$(ndmc -c "show interface $ifc" 2>/dev/null | tr -d '\r' || true)"
  [ -z "$out" ] && { echo ""; return 1; }

  # Keys vary by firmware/case. Try several common ones.
  product="$(printf '%s\n' "$out" | awk -F': ' '
    {
      k=tolower($1)
      if (k=="model" || k=="product") { print $2; exit }
    }')"
  tech="$(printf '%s\n' "$out" | awk -F': ' '
    {
      k=tolower($1)
      if (k=="technology" || k=="tech") { print $2; exit }
    }')"
  oper="$(printf '%s\n' "$out" | awk -F': ' '
    {
      k=tolower($1)
      if (k=="operator" || k=="provider" || k=="network") { print $2; exit }
    }')"
  sig="$(printf '%s\n' "$out" | awk -F': ' '
    {
      k=tolower($1)
      if (k=="signal level" || k=="signal" || k=="rssi" || k=="rsrp" || k=="rsrq" || k=="sinr") {
        if (k=="signal level" || k=="signal") { print $2; exit }
        else { print toupper($1) ": " $2; exit }
      }
    }')"

  # Extra: LTE band if present (nice-to-have, compact)
  band="$(printf '%s\n' "$out" | awk -F': ' '
    {
      k=tolower($1)
      if (k=="band") { print $2; exit }
    }')"

  line=""
  [ -n "$product" ] && line="$product"
  [ -n "$tech" ] && line="${line}${line:+ | }${tech}"
  [ -n "$oper" ] && line="${line}${line:+ | }${oper}"
  [ -n "$band" ] && line="${line}${line:+ | }B${band}"
  [ -n "$sig" ] && line="${line}${line:+ | }${sig}"

  echo "$line"
  return 0
}

guess_wan_modem() {
  # $1 = WAN linux iface (e.g., qmi_br1). prints modem iface name (UsbQmiX) if can be inferred.
  wan="$1"
  [ -z "$wan" ] && { echo ""; return 1; }
  have ndmc || { echo ""; return 1; }

  # 1) Try to find modem directly in WAN interface description.
  out="$(ndmc -c "show interface $wan" 2>/dev/null | tr -d '\r' || true)"
  m="$(printf '%s\n' "$out" | grep -oE 'Usb(Qmi|Mbim|Ndis|Lte|Eth)[0-9]+' | head -n1 || true)"
  [ -n "$m" ] && { echo "$m"; return 0; }

  # 2) Otherwise, try reverse lookup: pick modem whose "show interface" mentions WAN name.
  for ifc in $(list_modem_ifaces 2>/dev/null); do
    outm="$(ndmc -c "show interface $ifc" 2>/dev/null | tr -d '\r' || true)"
    echo "$outm" | grep -q "$wan" || continue
    echo "$ifc"
    return 0
  done

  echo ""
  return 1
}




get_opkg_storage_rci() {
  # Returns "used/total" for OPKG disk (best-effort, requires RCI).
  jdisk="$(rci_request "show/sc/opkg/disk" 2>/dev/null || true)"
  disk="$(rci_json_str "$jdisk" disk 2>/dev/null || true)"
  disk="${disk%/}"
  disk="${disk%:}"
  [ -z "$disk" ] && { echo ""; return 1; }

  jls="$(rci_request "ls" 2>/dev/null || true)"
  # Cheap parse: just search free/total near the disk name
  free="$(printf '%s\n' "$jls" | grep -A12 "\"${disk}\"" 2>/dev/null | grep -o '"free"[[:space:]]*:[[:space:]]*[0-9]\+' 2>/dev/null | head -n1 | grep -o '[0-9]\+')"
  total="$(printf '%s\n' "$jls" | grep -A12 "\"${disk}\"" 2>/dev/null | grep -o '"total"[[:space:]]*:[[:space:]]*[0-9]\+' 2>/dev/null | head -n1 | grep -o '[0-9]\+')"
  case "$free" in ''|*[!0-9]*) free="";; esac
  case "$total" in ''|*[!0-9]*) total="";; esac
  if [ -n "$free" ] && [ -n "$total" ] && [ "$total" -gt 0 ] 2>/dev/null; then
    used=$((total - free))
    [ "$used" -lt 0 ] 2>/dev/null && used=0
    echo "$(human_bytes "$used")/$(human_bytes "$total")"
    return 0
  fi
  echo ""
  return 1
}

print_device_summary() {
  section "УСТРОЙСТВО"

  label_w=13
  _kv() {
    k="$1"; v="$2"
    [ -n "$v" ] || return 0
    pad="$(printf "%-${label_w}s" "$k")"
    _out "${CYAN}${pad}${NC}  $v"
  }

  model_line="$(get_device_model_line 2>/dev/null || true)"
  [ -z "$model_line" ] && model_line="$(get_model 2>/dev/null || true)"

  soc="$(get_cpu_soc 2>/dev/null || true)"
  arch="$(get_arch_short 2>/dev/null || true)"
  wifi_max="$(get_wifi_temp_max_c 2>/dev/null || true)"
  cput="$(read_temp_c 2>/dev/null || true)"

  ramr="$(get_ram_usage_rci 2>/dev/null || true)"
  [ -z "$ramr" ] && ramr="$(get_ram_usage 2>/dev/null || true)"

  opkg="$(get_opkg_storage 2>/dev/null || true)"
  up="$(get_uptime_human 2>/dev/null || true)"

  modem_lines="$(get_modem_info 2>/dev/null || true)"

  _kv "Модель:" "$model_line"

  proc_line="$soc"
  [ -n "$arch" ] && proc_line="$proc_line ($arch)"
  [ -n "$wifi_max" ] && proc_line="$proc_line | Wi-Fi: ${wifi_max}°C"
  [ -n "$cput" ] && proc_line="$proc_line | CPU: ${cput}°C"
  _kv "Процессор:" "$proc_line"

  if [ -n "$modem_lines" ]; then
    first_line="$(printf '%s\n' "$modem_lines" | head -n 1)"
    rest="$(printf '%s\n' "$modem_lines" | tail -n +2)"
    _kv "Модем:" "$first_line"
    if [ -n "$rest" ]; then
      indent="$(printf "%-${label_w}s" "")"
      printf '%s\n' "$rest" | while IFS= read -r l; do
        [ -n "$l" ] || continue
        _out "${CYAN}${indent}${NC}  $l"
      done
    fi
  fi

  _kv "ОЗУ:" "$ramr"
  _kv "OPKG:" "$opkg"
  _kv "Время работы:" "$up"

  _out ""
}



# Colors only when stdout is a TTY
if [ "$NO_COLOR" -eq 0 ] && [ -t 1 ]; then
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[1;33m'
  CYAN='\033[0;36m'
  DIM='\033[2m'
  NC='\033[0m'
else
  RED=''; GREEN=''; YELLOW=''; CYAN=''; DIM=''; NC=''
fi

_ts() { date '+%H:%M:%S' 2>/dev/null || echo '??:??:??'; }
_out() {
  # Use printf for portable escape handling (dash/busybox differences).
  if [ -n "$LOG" ]; then
    if have tee; then
      printf '%b\n' "$1" | tee -a "$LOG"
    else
      printf '%b\n' "$1" >> "$LOG"
      printf '%b\n' "$1"
    fi
  else
    printf '%b\n' "$1"
  fi
}
log() { _out "$(_ts) - $1"; }

WARN_N=0
CRIT_N=0
ok()   { log "${GREEN}OK: $1${NC}"; }
warn() { WARN_N=$((WARN_N+1)); log "${YELLOW}WARNING: $1${NC}"; }
crit() { CRIT_N=$((CRIT_N+1)); log "${RED}CRITICAL: $1${NC}"; }

na()   { log "${DIM}— $1${NC}"; }

hdr() {
  _out "========================================"
  _out "МОНИТОРИНГ РОУТЕРА: $(hostname 2>/dev/null || echo router)"
  _out "Время: $(date 2>/dev/null || echo '')"
  _out "Режим: ${CYAN}${MODE}${NC}"
  _out "========================================"
}

fmt_uptime() {
  s="$1"
  [ -z "$s" ] && { echo 'неизвестно'; return; }
  d=$((s/86400))
  h=$(((s%86400)/3600))
  m=$(((s%3600)/60))
  if [ "$d" -gt 0 ]; then
    echo "${d}d ${h}h ${m}m"
  elif [ "$h" -gt 0 ]; then
    echo "${h}h ${m}m"
  else
    echo "${m}m"
  fi
}

human_kb() {
  # 1K blocks -> K/M/G (with 1 decimal). BusyBox-friendly (no floats).
  kb="$1"
  [ -z "$kb" ] && { echo "?"; return; }
  case "$kb" in
    ''|*[!0-9]*) echo "?"; return;;
  esac
  if [ "$kb" -ge 1048576 ] 2>/dev/null; then
    g10=$((kb * 10 / 1048576))
    echo "$((g10/10)).$((g10%10))G"
  elif [ "$kb" -ge 1024 ] 2>/dev/null; then
    m10=$((kb * 10 / 1024))
    echo "$((m10/10)).$((m10%10))M"
  else
    echo "${kb}K"
  fi
}

human_bytes() {
  b="$1"
  [ -z "$b" ] && { echo "?"; return; }
  case "$b" in
    ''|*[!0-9]*) echo "?"; return;;
  esac
  # bytes -> K/M/G (1 decimal)
  if [ "$b" -ge 1073741824 ] 2>/dev/null; then
    g10=$((b * 10 / 1073741824))
    echo "$((g10/10)).$((g10%10))G"
  elif [ "$b" -ge 1048576 ] 2>/dev/null; then
    m10=$((b * 10 / 1048576))
    echo "$((m10/10)).$((m10%10))M"
  elif [ "$b" -ge 1024 ] 2>/dev/null; then
    k10=$((b * 10 / 1024))
    echo "$((k10/10)).$((k10%10))K"
  else
    echo "${b}B"
  fi
}

read_temp_c() {
  for p in /sys/class/thermal/thermal_zone*/temp /sys/devices/virtual/thermal/thermal_zone*/temp; do
    [ -r "$p" ] || continue
    v="$(cat "$p" 2>/dev/null | tr -d '\r\n')"
    case "$v" in
      ''|*[!0-9]*) continue;;
    esac
    if [ "$v" -ge 1000 ] 2>/dev/null; then
      echo $((v/1000))
    else
      echo "$v"
    fi
    return 0
  done
  return 1
}

cpu_usage_pct() {
  # Best-effort CPU usage over ~1s from /proc/stat.
  [ -r /proc/stat ] || return 1
  r1="$(awk '/^cpu /{print $2" "$3" "$4" "$5" "$6" "$7" "$8" "$9" "$10" "$11; exit}' /proc/stat 2>/dev/null)"
  [ -z "$r1" ] && return 1
  # shellcheck disable=SC2086
  set -- $r1
  u1=$1; n1=$2; s1=$3; i1=$4; io1=$5; ir1=$6; so1=$7; st1=${8:-0}
  t1=$((u1+n1+s1+i1+io1+ir1+so1+st1))
  id1=$((i1+io1))

  sleep 1 2>/dev/null || true

  r2="$(awk '/^cpu /{print $2" "$3" "$4" "$5" "$6" "$7" "$8" "$9" "$10" "$11; exit}' /proc/stat 2>/dev/null)"
  [ -z "$r2" ] && return 1
  # shellcheck disable=SC2086
  set -- $r2
  u2=$1; n2=$2; s2=$3; i2=$4; io2=$5; ir2=$6; so2=$7; st2=${8:-0}
  t2=$((u2+n2+s2+i2+io2+ir2+so2+st2))
  id2=$((i2+io2))

  dt=$((t2 - t1))
  did=$((id2 - id1))
  [ "$dt" -le 0 ] && return 1
  used=$(( (dt - did) * 100 / dt ))
  echo "$used"
  return 0
}

check_df() {
  mp="$1"
  label="$2"

  mdev=""; fstype=""; mopts=""; rwro=""
  if [ -r /proc/mounts ]; then
    mi="$(awk -v mp="$mp" '$2==mp {print $1" "$3" "$4; exit}' /proc/mounts 2>/dev/null)"
    mdev="${mi%% *}"
    rest="${mi#* }"
    fstype="${rest%% *}"
    mopts="${rest#* }"
    [ "$rest" = "$fstype" ] && mopts=""
    if echo ",${mopts}," | grep -q ",ro," 2>/dev/null; then
      rwro="ro"
    else
      rwro="rw"
    fi
  fi

  df_line="$(df -Pk "$mp" 2>/dev/null | awk 'NR==2 {print $1" "$2" "$3" "$4" "$5}')"
  [ -z "$df_line" ] && return 1
  # shellcheck disable=SC2086
  set -- $df_line
  total_k="$2"; used_k="$3"; avail_k="$4"; use_raw="$5"
  use="$(printf '%s' "$use_raw" | tr -d '%')"
  [ -z "$use" ] && return 1

  used_h="$(human_kb "$used_k")"
  total_h="$(human_kb "$total_k")"
  avail_h="$(human_kb "$avail_k")"

  fs_tag=""
  if [ -n "$fstype" ]; then
    fs_tag="$fstype"
    [ -n "$rwro" ] && fs_tag="$fs_tag,$rwro"
    if [ -n "$mdev" ]; then
      case "$mdev" in
        /dev/*)
          dev_short="${mdev##*/}"
          [ -n "$dev_short" ] && fs_tag="$fs_tag,$dev_short"
          ;;
      esac
    fi
  fi
  [ -n "$fs_tag" ] && fs_tag=" [${fs_tag}]"
  details="${use}% (исп.: ${used_h}/${total_h}, свободно: ${avail_h})${fs_tag}"

  # rootfs read-only is expected on many Keenetic devices
  if [ "$mp" = "/" ]; then
    if echo ",${mopts}," | grep -q ",ro," 2>/dev/null || echo "$fstype" | grep -Eq '^(squashfs|cramfs|romfs|rootfs)$' 2>/dev/null; then
      extra=""
      [ -n "$fstype" ] && extra="$fstype"
      [ -n "$mopts" ] && extra="$extra${extra:+, }$mopts"
      [ -n "$extra" ] && extra=" ($extra)"
      ok "${label}: ${details} — rootfs read-only${extra}, это нормально"
      return 0
    fi
  fi

  if [ "$use" -ge 95 ] 2>/dev/null; then
    crit "${label}: ${details}"
  elif [ "$use" -ge 85 ] 2>/dev/null; then
    warn "${label}: ${details}"
  else
    ok "${label}: ${details}"
  fi
}

check_inodes() {
  mp="$1"
  label="$2"
  out="$(df -Pi "$mp" 2>/dev/null | awk 'NR==2 {print $2" "$3" "$4" "$5}')"
  [ -z "$out" ] && return 0
  # shellcheck disable=SC2086
  set -- $out
  total_i="$1"; used_i="$2"; avail_i="$3"; use_raw="$4"
  use="$(printf '%s' "$use_raw" | tr -d '%')"
  [ -z "$use" ] && return 0
  details="${use}% (inode: ${used_i}/${total_i}, свободно: ${avail_i})"
  if [ "$use" -ge 95 ] 2>/dev/null; then
    crit "${label} inode: ${details}"
  elif [ "$use" -ge 85 ] 2>/dev/null; then
    warn "${label} inode: ${details}"
  else
    [ "$MODE" = "short" ] || ok "${label} inode: ${details}"
  fi
}

check_proc() {
  proc="$1"
  label="$2"
  if pidof "$proc" >/dev/null 2>&1; then
    log "${GREEN}✓ ${label} (${proc}) работает${NC}"
    return 0
  fi
  if ps 2>/dev/null | grep -v grep | grep -q "[[:space:]]$proc\([[:space:]]\|$\)"; then
    log "${GREEN}✓ ${label} (${proc}) работает${NC}"
    return 0
  fi
  log "${YELLOW}✗ ${label} (${proc}) не найден${NC}"
  return 1
}

check_proc_contains() {
  needle="$1"
  label="$2"
  if ps w 2>/dev/null | grep -v grep | grep -q "$needle"; then
    log "${GREEN}✓ ${label} (${needle}) работает${NC}"
    return 0
  fi
  log "${YELLOW}✗ ${label} (${needle}) не найден${NC}"
  return 1
}



is_running() {
  proc="$1"
  pidof "$proc" >/dev/null 2>&1 && return 0
  ps 2>/dev/null | grep -v grep | grep -q "[[:space:]]$proc\([[:space:]]\|$\)" && return 0
  return 1
}

is_running_contains() {
  needle="$1"
  ps w 2>/dev/null | grep -v grep | grep -q "$needle" && return 0
  return 1
}

ping_stats() {
  # Returns: "<loss>% loss, avg <ms> ms"
  # Works with BusyBox ping and iputils ping variants.
  target="$1"
  c="${2:-3}"
  w="${3:-1}"

  out="$(ping -c "$c" -W "$w" "$target" 2>/dev/null)"
  [ -z "$out" ] && return 1

  # loss: supports both "packet loss" and other variants
  loss="$(printf '%s\n' "$out" | awk -F',' '/packet loss/ {gsub(/%/,"",$3); gsub(/[^0-9]/,"",$3); print $3; exit}')"
  [ -z "$loss" ] && loss="$(printf '%s\n' "$out" | awk '/loss/ && /%/ {for(i=1;i<=NF;i++){if($i ~ /%/){gsub(/%/,"",$i); gsub(/[^0-9]/,"",$i); print $i; exit}}}')"

  # avg: parse the "min/avg/max" line robustly
  avg="$(printf '%s\n' "$out" | awk -F'=' '/min\/avg\/max/ {
      s=$2;
      sub(/^[[:space:]]*/,"",s);
      sub(/[[:space:]]*ms.*$/, "", s);
      n=split(s,a,"/");
      if(n>=2){print a[2]; exit}
    }')"
  [ -z "$avg" ] && avg="-"

  case "$loss" in ''|*[!0-9]*) return 1;; esac

  # ensure avg has no trailing "ms"
  avg="${avg% ms}"; avg="${avg%ms}"

  echo "${loss}% loss, avg ${avg} ms"
  return 0
}


dns_test() {
  domain="$1"
  if have nslookup; then
    nslookup "$domain" 2>/dev/null | grep -Eiq 'Address:|Name:' && return 0
    return 1
  fi
  if have getent; then
    getent hosts "$domain" >/dev/null 2>&1 && return 0
    return 1
  fi
  return 2
}

http_test() {
  url="$1"
  if have curl; then
    curl -fsI --max-time 4 "$url" >/dev/null 2>&1 && return 0
    return 1
  fi
  if have wget; then
    wget -q -T 4 --spider "$url" >/dev/null 2>&1 && return 0
    return 1
  fi
  return 2
}

get_route_info() {
  # prints: via=<gw> dev=<if> src=<ip>
  if have ip; then
    rg="$(ip route get 8.8.8.8 2>/dev/null | head -n1)"
    [ -n "$rg" ] || return 1
    via="$(printf '%s\n' "$rg" | awk '{for(i=1;i<=NF;i++) if($i=="via"){print $(i+1); exit}}')"
    dev="$(printf '%s\n' "$rg" | awk '{for(i=1;i<=NF;i++) if($i=="dev"){print $(i+1); exit}}')"
    src="$(printf '%s\n' "$rg" | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')"
    [ -z "$via" ] && via="$(ip route 2>/dev/null | awk '/^default/ {print $3; exit}')"
    [ -z "$dev" ] && dev="$(ip route 2>/dev/null | awk '/^default/ {print $5; exit}')"
    printf 'via=%s dev=%s src=%s\n' "${via:-}" "${dev:-}" "${src:-}"
    return 0
  fi
  return 1
}

iface_stat() {
  # iface_stat eth0 rx_errors
  ifc="$1"; key="$2"
  p="/sys/class/net/$ifc/statistics/$key"
  [ -r "$p" ] || { echo ""; return 1; }
  cat "$p" 2>/dev/null | tr -d '\r\n'
}

conntrack_usage() {
  c=""; m=""
  [ -r /proc/sys/net/netfilter/nf_conntrack_count ] && c="$(cat /proc/sys/net/netfilter/nf_conntrack_count 2>/dev/null | tr -d '\r\n')"
  [ -r /proc/sys/net/netfilter/nf_conntrack_max ] && m="$(cat /proc/sys/net/netfilter/nf_conntrack_max 2>/dev/null | tr -d '\r\n')"
  case "$c" in ''|*[!0-9]*) return 1;; esac
  case "$m" in ''|*[!0-9]*) return 1;; esac
  [ "$m" -le 0 ] && return 1
  pct=$((c * 100 / m))
  echo "$c $m $pct"
  return 0
}

# --- JSON helpers (best-effort) ---
json_escape() {
  # escape backslash and quotes, keep it simple
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

JSON_KV=""
json_add() {
  k="$1"; v="$2"; t="$3" # t: s|n|b
  [ -z "$k" ] && return 0
  if [ -n "$JSON_KV" ]; then JSON_KV="$JSON_KV,"; fi
  case "$t" in
    n|b) JSON_KV="$JSON_KV\"$k\":$v";;
    *) JSON_KV="$JSON_KV\"$k\":\"$(json_escape "$v")\"";;
  esac
}


# --- process snapshot helpers (full mode) ---
proc_rss_kb() {
  # VmRSS in kB
  pid="$1"
  [ -r "/proc/$pid/status" ] || { echo 0; return 1; }
  awk '/^VmRSS:/ {print $2; exit}' "/proc/$pid/status" 2>/dev/null | tr -d '\r\n'
}

proc_cmd() {
  pid="$1"
  # Prefer cmdline; fall back to comm (kernel threads)
  if [ -r "/proc/$pid/cmdline" ]; then
    cmd="$(tr '\000' ' ' < "/proc/$pid/cmdline" 2>/dev/null | sed 's/[[:space:]]\+$//')"
  else
    cmd=""
  fi
  if [ -z "$cmd" ] && [ -r "/proc/$pid/comm" ]; then
    c="$(cat "/proc/$pid/comm" 2>/dev/null | tr -d '\r\n')"
    [ -n "$c" ] && cmd="[$c]"
  fi
  [ -z "$cmd" ] && cmd="[$pid]"
  # Trim very long commands for readability (with ellipsis)
  # ASCII-only truncation (BusyBox-friendly).
  max=120
  printf '%s' "$cmd" | awk -v m="$max" '{ if (length($0) > m) print substr($0, 1, m-3) "..."; else print $0 }'
}

proc_stat_cpu_ticks() {
  # output: "<pid> <ticks>" for each pid in /proc
  # robust parsing of /proc/<pid>/stat with comm in parentheses
  for d in /proc/[0-9]*; do
    pid="${d##*/}"
    [ -r "$d/stat" ] || continue
    awk '{
      pid=$1;
      m=match($0, /\) /);
      if(m==0) next;
      rest=substr($0, RSTART+2);
      split(rest,a," ");
      ut=a[12]; st=a[13];
      if(ut==""||st=="") next;
      print pid, ut+st;
    }' "$d/stat" 2>/dev/null
  done
}

proc_total_cpu_ticks() {
  # total jiffies over all CPUs
  awk '/^cpu / {s=0; for(i=2;i<=NF;i++) s+=$i; print s; exit}' /proc/stat 2>/dev/null
}

proc_top_cpu() {
  # Top by CPU usage over ~1s sample (overall % across all cores)
  tmp1="/tmp/sysmon_cpu1.$$"
  tmp2="/tmp/sysmon_cpu2.$$"
  tmpd="/tmp/sysmon_cpud.$$"
  self_pid="$$"
  total1="$(proc_total_cpu_ticks)"
  proc_stat_cpu_ticks > "$tmp1" 2>/dev/null

  sleep 1 2>/dev/null || true

  total2="$(proc_total_cpu_ticks)"
  proc_stat_cpu_ticks > "$tmp2" 2>/dev/null

  # compute deltas
  td=$((total2 - total1))
  if [ "$td" -le 0 ] 2>/dev/null; then
    rm -f "$tmp1" "$tmp2" "$tmpd" 2>/dev/null
    return 1
  fi

  awk 'NR==FNR {a[$1]=$2; next} {
        pid=$1; t=$2; d=t-a[pid];
        if(d>0) print pid, d;
      }' "$tmp1" "$tmp2" 2>/dev/null | sort -k2,2nr | head -n 30 > "$tmpd" 2>/dev/null

  _out "${DIM}CPU (≈1s sample), top 10 (CPU% = доля времени всех ядер)${NC}"
  _out "${DIM}PID   CPU%  RSS(MB)  COMMAND${NC}"

  shown=0
  while IFS=' ' read -r pid d; do
    [ -n "$pid" ] || continue
    # Skip this sysmon run (and best-effort skip other sysmon instances)
    [ "$pid" = "$self_pid" ] && continue
    pct=$((d * 100 / td))
    rss="$(proc_rss_kb "$pid" 2>/dev/null || echo 0)"
    case "$rss" in ''|*[!0-9]*) rss=0;; esac
    rssm=$((rss/1024))
    cmd="$(proc_cmd "$pid")"
    case "$cmd" in *sysmon_keenetic.sh*) continue;; esac
    _out "${DIM}$(printf '%-5s %-5s %-7s %s' "$pid" "${pct}%" "${rssm}M" "$cmd")${NC}"
    shown=$((shown+1))
    [ "$shown" -ge 10 ] && break
  done < "$tmpd"

  rm -f "$tmp1" "$tmp2" "$tmpd" 2>/dev/null
  return 0
}

proc_top_mem() {
  # Top by RSS (VmRSS) snapshot
  tmpm="/tmp/sysmon_mem.$$"
  self_pid="$$"
  for d in /proc/[0-9]*; do
    pid="${d##*/}"
    rss="$(proc_rss_kb "$pid" 2>/dev/null)"
    case "$rss" in ''|*[!0-9]*) rss=0;; esac
    [ "$rss" -gt 0 ] 2>/dev/null || continue
    echo "$pid $rss"
  done | sort -k2,2nr | head -n 30 > "$tmpm" 2>/dev/null

  _out "${DIM}RAM (RSS), top 10 snapshot${NC}"
  _out "${DIM}PID   RSS(MB)  COMMAND${NC}"

  shown=0
  while IFS=' ' read -r pid rss; do
    [ -n "$pid" ] || continue
    [ "$pid" = "$self_pid" ] && continue
    case "$rss" in ''|*[!0-9]*) rss=0;; esac
    rssm=$((rss/1024))
    cmd="$(proc_cmd "$pid")"
    case "$cmd" in *sysmon_keenetic.sh*) continue;; esac
    _out "${DIM}$(printf '%-5s %-7s %s' "$pid" "${rssm}M" "$cmd")${NC}"
    shown=$((shown+1))
    [ "$shown" -ge 10 ] && break
  done < "$tmpm"

  rm -f "$tmpm" 2>/dev/null
  return 0
}

proc_top_full() {
  # Prefer our stable /proc based lists; fall back to top/ps if needed.
  if proc_top_cpu 2>/dev/null; then
    _out ""
    proc_top_mem 2>/dev/null || true
    return 0
  fi

  if have top; then
    # Fallback: filter out the 'top -bn1' line (it is our own)
    top -bn1 2>/dev/null | grep -v 'top -bn1' | head -n 25 | while IFS= read -r l; do _out "${DIM}${l}${NC}"; done
    return 0
  fi

  ps w 2>/dev/null | head -n 30 | while IFS= read -r l; do _out "${DIM}${l}${NC}"; done
  return 0
}

# -------------------

START_TS="$(date +%s 2>/dev/null || echo '')"

hdr

# 0) УСТРОЙСТВО (best-effort)
_out "=== УСТРОЙСТВО ==="
print_device_summary 2>/dev/null || true
_out ""

# 1) ДИСКИ
_out "=== ДИСКИ ==="
check_df /opt "/opt" || true
check_inodes /opt "/opt" || true
check_df /tmp "/tmp" || true
check_df / "/" || true

# 2) ПАМЯТЬ
_out "=== ПАМЯТЬ ==="
if [ -r /proc/meminfo ]; then
  total="$(awk '/MemTotal/ {print $2}' /proc/meminfo 2>/dev/null)"
  avail="$(awk '/MemAvailable/ {print $2}' /proc/meminfo 2>/dev/null)"
  free="$(awk '/MemFree/ {print $2}' /proc/meminfo 2>/dev/null)"
  cached="$(awk '/^Cached:/ {print $2}' /proc/meminfo 2>/dev/null)"
  buffers="$(awk '/^Buffers:/ {print $2}' /proc/meminfo 2>/dev/null)"
  slab="$(awk '/^Slab:/ {print $2}' /proc/meminfo 2>/dev/null)"
  swt="$(awk '/SwapTotal/ {print $2}' /proc/meminfo 2>/dev/null)"
  swf="$(awk '/SwapFree/ {print $2}' /proc/meminfo 2>/dev/null)"

  [ -z "$avail" ] && avail="$free"

  if [ -n "$total" ] && [ -n "$avail" ]; then
    used=$((total - avail))
    pct=$((used * 100 / total))

    used_m=$((used/1024))
    total_m=$((total/1024))
    avail_m=$((avail/1024))

    msg="Память: ${pct}% (исп.: ${used_m}M/${total_m}M, доступно: ${avail_m}M)"

    if [ "$pct" -ge 95 ] 2>/dev/null; then
      crit "$msg"
    elif [ "$pct" -ge 85 ] 2>/dev/null; then
      warn "$msg"
    else
      ok "$msg"
    fi

    json_add mem_total_kb "$total" n
    json_add mem_avail_kb "$avail" n
    json_add mem_used_pct "$pct" n

    if [ "$MODE" != "short" ]; then
      [ -n "$cached" ] && log "${DIM}Cached: $((cached/1024))M${NC}"
      [ -n "$buffers" ] && log "${DIM}Buffers: $((buffers/1024))M${NC}"
      [ -n "$slab" ] && log "${DIM}Slab: $((slab/1024))M${NC}"
    fi

    if [ -n "$swt" ] && [ "$swt" -gt 0 ] 2>/dev/null; then
      swu=$((swt - swf))
      swp=$((swu * 100 / swt))
      log "Swap: ${swp}% (исп.: $((swu/1024))M/$((swt/1024))M, свободно: $((swf/1024))M)"
      json_add swap_total_kb "$swt" n
      json_add swap_used_pct "$swp" n
    fi
  else
    warn "Не удалось прочитать /proc/meminfo"
  fi
else
  warn "/proc/meminfo отсутствует"
fi

# 3) CPU
_out "=== CPU ==="
cores="$(grep -c '^processor' /proc/cpuinfo 2>/dev/null)"
[ -z "$cores" ] && cores=1
load=""; [ -r /proc/loadavg ] && load="$(cut -d' ' -f1 /proc/loadavg 2>/dev/null)"
[ -n "$load" ] && log "Load: ${CYAN}${load}${NC} (ядер: ${cores})" || log "Load: неизвестно (ядер: ${cores})"

cpuu="$(cpu_usage_pct 2>/dev/null || true)"
if [ -n "$cpuu" ]; then
  if [ "$cpuu" -ge 95 ] 2>/dev/null; then
    crit "CPU usage: ${cpuu}%"
  elif [ "$cpuu" -ge 85 ] 2>/dev/null; then
    warn "CPU usage: ${cpuu}%"
  else
    [ "$MODE" = "short" ] || ok "CPU usage: ${cpuu}%"
  fi
  json_add cpu_used_pct "$cpuu" n
fi

tc="$(read_temp_c 2>/dev/null || true)"
if [ -n "$tc" ]; then
  if [ "$tc" -ge 85 ] 2>/dev/null; then
    crit "Температура: ${tc}°C"
  elif [ "$tc" -ge 75 ] 2>/dev/null; then
    warn "Температура: ${tc}°C"
  else
    log "Температура: ${CYAN}${tc}°C${NC}"
  fi
  json_add temp_c "$tc" n
fi

# 4) СЕТЬ
_out "=== СЕТЬ ==="
ri="$(get_route_info 2>/dev/null || true)"
GW=""; IFACE=""; SRCIP=""
if [ -n "$ri" ]; then
  GW="$(printf '%s\n' "$ri" | awk -F' ' '{for(i=1;i<=NF;i++){split($i,a,"="); if(a[1]=="via"){print a[2]}}}')"
  IFACE="$(printf '%s\n' "$ri" | awk -F' ' '{for(i=1;i<=NF;i++){split($i,a,"="); if(a[1]=="dev"){print a[2]}}}')"
  SRCIP="$(printf '%s\n' "$ri" | awk -F' ' '{for(i=1;i<=NF;i++){split($i,a,"="); if(a[1]=="src"){print a[2]}}}')"
fi

if [ -n "$GW" ]; then
  log "Шлюз: ${CYAN}${GW}${NC}"
else
  log "Шлюз: неизвестно"
fi
[ -n "$IFACE" ] && log "Интерфейс: ${CYAN}${IFACE}${NC}${SRCIP:+, src ${SRCIP}}"

# Map active WAN interface to modem (best-effort)
WAN_MODEM="$(guess_wan_modem "$IFACE" 2>/dev/null || true)"
WAN_MODEM_DETAILS=""
if [ -n "$WAN_MODEM" ]; then
  log "WAN↔модем: ${CYAN}${IFACE}${NC} → ${CYAN}${WAN_MODEM}${NC}"
  WAN_MODEM_DETAILS="$(get_modem_details "$WAN_MODEM" 2>/dev/null || true)"
  if [ "$MODE" = "full" ]; then
    [ -n "$WAN_MODEM_DETAILS" ] && log "Модем (активный): ${CYAN}${WAN_MODEM_DETAILS}${NC}"
  fi
fi

# JSON
[ -n "$IFACE" ] && json_add wan_iface "$IFACE" s
[ -n "$GW" ] && json_add wan_gw "$GW" s
[ -n "$SRCIP" ] && json_add wan_src "$SRCIP" s
[ -n "$WAN_MODEM" ] && json_add wan_modem "$WAN_MODEM" s
[ -n "$WAN_MODEM_DETAILS" ] && json_add wan_modem_details "$WAN_MODEM_DETAILS" s

# DNS servers
if [ -r /etc/resolv.conf ]; then
  dns="$(awk '/^nameserver[ \t]+/ {print $2}' /etc/resolv.conf 2>/dev/null | head -n 2 | tr '\n' ' ' | sed 's/[[:space:]]\+$//')"
  [ -n "$dns" ] && log "DNS: ${CYAN}${dns}${NC}"
fi

# ICMP
p8="$(ping_stats 8.8.8.8 3 1 2>/dev/null || true)"
if [ -n "$p8" ]; then
  loss="$(printf '%s' "$p8" | awk '{print $1}' | tr -d '%')"
  if [ "$loss" -ge 100 ] 2>/dev/null; then
    crit "Интернет (ICMP): 8.8.8.8 — ${p8}"
  elif [ "$loss" -ge 34 ] 2>/dev/null; then
    warn "Интернет (ICMP): 8.8.8.8 — ${p8}"
  else
    ok "Интернет (ICMP): 8.8.8.8 — ${p8}"
  fi
  json_add ping_loss_pct "$loss" n
else
  warn "Интернет (ICMP): 8.8.8.8 — нет ответа"
fi

# DNS resolve
DNS_DOMAIN="${DNS_DOMAIN:-keenetic.com}"
dns_test "$DNS_DOMAIN"; drc=$?
if [ "$drc" -eq 0 ]; then
  ok "DNS: резолв ${DNS_DOMAIN}"
elif [ "$drc" -eq 2 ]; then
  [ "$MODE" = "short" ] || log "DNS: проверка недоступна (нет nslookup/getent)"
else
  warn "DNS: не резолвит ${DNS_DOMAIN}"
fi

# HTTP/HTTPS check
HTTP_URL="${HTTP_URL:-https://connectivitycheck.gstatic.com/generate_204}"
http_test "$HTTP_URL"; hrc=$?
if [ "$hrc" -eq 0 ]; then
  ok "Интернет (HTTPS): ${HTTP_URL}"
elif [ "$hrc" -eq 2 ]; then
  [ "$MODE" = "short" ] || log "Интернет (HTTPS): проверка недоступна (нет curl/wget)"
else
  warn "Интернет (HTTPS): нет ответа/ошибка (${HTTP_URL})"
fi

# IPv6 (best-effort)
if have ip; then
  if ip -6 route show default 2>/dev/null | grep -q '^default'; then
    if ping -6 -c 1 -W 1 2606:4700:4700::1111 >/dev/null 2>&1; then
      [ "$MODE" = "short" ] || ok "IPv6: есть default route + ping"
    else
      [ "$MODE" = "short" ] || warn "IPv6: default route есть, ping не проходит"
    fi
  fi
fi

# Интерфейсные ошибки
if [ -n "$IFACE" ] && [ -d "/sys/class/net/$IFACE" ]; then
  _out "=== ИНТЕРФЕЙСЫ ==="
  st="$(cat "/sys/class/net/$IFACE/operstate" 2>/dev/null | tr -d '\r\n')"
  [ -n "$st" ] && log "${IFACE}: state ${CYAN}${st}${NC}"

  rxerr="$(iface_stat "$IFACE" rx_errors 2>/dev/null || echo '')"
  rxdrp="$(iface_stat "$IFACE" rx_dropped 2>/dev/null || echo '')"
  txerr="$(iface_stat "$IFACE" tx_errors 2>/dev/null || echo '')"
  txdrp="$(iface_stat "$IFACE" tx_dropped 2>/dev/null || echo '')"

  # treat any non-zero as warning (can tune later)
  bad=0
  for v in "$rxerr" "$rxdrp" "$txerr" "$txdrp"; do
    case "$v" in ''|*[!0-9]*) v=0;; esac
    [ "$v" -gt 0 ] 2>/dev/null && bad=1
  done
  if [ "$bad" -eq 1 ]; then
    warn "${IFACE} ошибки: rx_err=${rxerr:-0}, rx_drop=${rxdrp:-0}, tx_err=${txerr:-0}, tx_drop=${txdrp:-0}"
  else
    [ "$MODE" = "short" ] || ok "${IFACE} ошибки: rx_err=0, rx_drop=0, tx_err=0, tx_drop=0"
  fi

  # Traffic counters + speed (1s sample, full mode)
  rx_b="$(iface_stat "$IFACE" rx_bytes 2>/dev/null || echo '')"
  tx_b="$(iface_stat "$IFACE" tx_bytes 2>/dev/null || echo '')"
  case "$rx_b" in ''|*[!0-9]*) rx_b="";; esac
  case "$tx_b" in ''|*[!0-9]*) tx_b="";; esac
  if [ -n "$rx_b" ] && [ -n "$tx_b" ]; then
    [ "$MODE" = "short" ] || log "Трафик: RX ${CYAN}$(human_bytes "$rx_b")${NC}, TX ${CYAN}$(human_bytes "$tx_b")${NC}"
    json_add iface "$IFACE" s
    json_add iface_rx_bytes "$rx_b" n
    json_add iface_tx_bytes "$tx_b" n

    if [ "$MODE" = "full" ]; then
      rx1="$rx_b"; tx1="$tx_b"
      sleep 1 2>/dev/null || true
      rx2="$(iface_stat "$IFACE" rx_bytes 2>/dev/null || echo '')"
      tx2="$(iface_stat "$IFACE" tx_bytes 2>/dev/null || echo '')"
      case "$rx2" in ''|*[!0-9]*) rx2="$rx1";; esac
      case "$tx2" in ''|*[!0-9]*) tx2="$tx1";; esac

      drx=$((rx2 - rx1))
      dtx=$((tx2 - tx1))
      [ "$drx" -lt 0 ] 2>/dev/null && drx=0
      [ "$dtx" -lt 0 ] 2>/dev/null && dtx=0

      # KB/s with 1 decimal (x10), rounded
      # (bytes_per_sec * 10 + 512) / 1024  ->  KiB/s with 1 decimal
      rx_k10=$(((drx * 10 + 512) / 1024))
      tx_k10=$(((dtx * 10 + 512) / 1024))
      rx_ki=$((rx_k10 / 10)); rx_kf=$((rx_k10 % 10))
      tx_ki=$((tx_k10 / 10)); tx_kf=$((tx_k10 % 10))

      # Mbit/s with 1 decimal (x10): (bytes*8*10)/1e6, rounded
      # Add 500000 for rounding at the 0.1 Mbit/s place.
      rx_m10=$(((drx * 80 + 500000) / 1000000))
      tx_m10=$(((dtx * 80 + 500000) / 1000000))
      rx_mi=$((rx_m10 / 10)); rx_mf=$((rx_m10 % 10))
      tx_mi=$((tx_m10 / 10)); tx_mf=$((tx_m10 % 10))

      log "Скорость (≈1s): RX ${CYAN}${rx_ki}.${rx_kf}${NC} KB/s (${rx_mi}.${rx_mf} Mbit/s), TX ${CYAN}${tx_ki}.${tx_kf}${NC} KB/s (${tx_mi}.${tx_mf} Mbit/s)"
      # Keep both bytes/sec and bits/sec in JSON (backward/forward friendly)
      json_add iface_rx_Bps "$drx" n
      json_add iface_tx_Bps "$dtx" n
      json_add iface_rx_bps "$((drx * 8))" n
      json_add iface_tx_bps "$((dtx * 8))" n
      json_add iface_rx_kBps "$((drx / 1024))" n
      json_add iface_tx_kBps "$((dtx / 1024))" n
    fi
  fi

fi

# Conntrack
ct="$(conntrack_usage 2>/dev/null || true)"
if [ -n "$ct" ]; then
  _out "=== CONNTRACK ==="
  # shellcheck disable=SC2086
  set -- $ct
  ctc="$1"; ctm="$2"; ctp="$3"
  if [ "$ctp" -ge 95 ] 2>/dev/null; then
    crit "Таблица соединений: ${ctp}% (${ctc}/${ctm})"
  elif [ "$ctp" -ge 85 ] 2>/dev/null; then
    warn "Таблица соединений: ${ctp}% (${ctc}/${ctm})"
  else
    [ "$MODE" = "short" ] || ok "Таблица соединений: ${ctp}% (${ctc}/${ctm})"
  fi
  json_add conntrack_count "$ctc" n
  json_add conntrack_max "$ctm" n
  json_add conntrack_pct "$ctp" n
fi

# 5) СЛУЖБЫ/ПРОЦЕССЫ
_out "=== СЛУЖБЫ ==="

# SSH: Keenetic обычно использует dropbear, sshd может отсутствовать — это нормально.
if is_running dropbear; then
  check_proc dropbear "SSH" || true
  na "SSH (sshd) не используется (dropbear)"
else
  check_proc dropbear "SSH" || true
  check_proc sshd "SSH" || true
fi

# cron: чаще всего используется crond, бинарник cron может отсутствовать — это нормально.
if is_running crond; then
  check_proc crond "cron" || true
  na "cron (cron) не используется (crond)"
else
  check_proc crond "cron" || true
  check_proc cron "cron" || true
fi

# DNS: dnsmasq на Keenetic может отсутствовать (NDM/https_dns_proxy). Если DNS-резолв работает — это ок.
if is_running dnsmasq; then
  check_proc dnsmasq "dnsmasq" || true
else
  if is_running https_dns_proxy || is_running ndm; then
    na "dnsmasq не используется (NDM/https_dns_proxy)"
  else
    check_proc dnsmasq "dnsmasq" || true
  fi
fi

# NTP: может быть встроен в NDM; отдельный ntpd/chronyd не обязателен.
if is_running ntpd; then
  check_proc ntpd "ntpd" || true
elif is_running chronyd; then
  check_proc chronyd "chronyd" || true
else
  y="$(date +%Y 2>/dev/null || echo 0)"
  case "$y" in ''|*[!0-9]*) y=0;; esac
  if is_running ndm && [ "$y" -ge 2020 ] 2>/dev/null; then
    na "ntpd не используется (синхронизация времени встроена в NDM)"
  else
    # Не фатально, но полезно знать
    [ "$MODE" = "short" ] || warn "NTP: ntpd/chronyd не найден (время может быть не синхронизировано)"
  fi
fi

# Остальные сервисы (по наличию процесса)
check_proc xray "xray" || true
check_proc mihomo "mihomo" || true

# xkeen-ui server (best-effort: run_server.py)
check_proc_contains "xkeen-ui" "xkeen-ui" || true
check_proc_contains "run_server.py" "xkeen-ui" || true

# 6) ПРОЦЕССЫ (TOP) — только full
if [ "$MODE" = "full" ]; then
  _out "=== TOP (процессы) ==="
  proc_top_full 2>/dev/null || true
fi

# 7) ЛОГИ (best-effort)
_out "=== ЛОГИ ==="
LOGSRC=""
if have logread; then
  LOGSRC="logread"
  LOGTEXT="$(logread -l 300 2>/dev/null)"
elif have dmesg; then
  LOGSRC="dmesg"
  LOGTEXT="$(dmesg 2>/dev/null | tail -n 300)"
else
  LOGTEXT=""
fi

if [ -z "$LOGTEXT" ]; then
  warn "Логи недоступны (нет logread/dmesg или нет прав)"
else
  # patterns
  p_oom='(oom|Out of memory|Killed process)'
  p_disk='(EXT4-fs error|Buffer I/O error|I/O error|SCSI error|usb .*reset|reset high-speed|FAT-fs|XFS.*error)'
  p_crash='(panic|Oops|BUG:|watchdog|soft lockup|hard lockup|segfault)'
  p_therm='(thermal|overheat|throttl|temperature.*(high|critical))'

  found=0

  if printf '%s\n' "$LOGTEXT" | grep -Ei "$p_crash" >/dev/null 2>&1; then
    found=1
    crit "В логах (${LOGSRC}) есть признаки падения ядра/краша"
    printf '%s\n' "$LOGTEXT" | grep -Ei "$p_crash" | tail -n 5 | while IFS= read -r l; do _out "  ${RED}${l}${NC}"; done
  fi

  if printf '%s\n' "$LOGTEXT" | grep -Ei "$p_oom" >/dev/null 2>&1; then
    found=1
    warn "В логах (${LOGSRC}) есть OOM/убитые процессы"
    printf '%s\n' "$LOGTEXT" | grep -Ei "$p_oom" | tail -n 5 | while IFS= read -r l; do _out "  ${YELLOW}${l}${NC}"; done
  fi

  if printf '%s\n' "$LOGTEXT" | grep -Ei "$p_disk" >/dev/null 2>&1; then
    found=1
    warn "В логах (${LOGSRC}) есть ошибки диска/USB/FS"
    printf '%s\n' "$LOGTEXT" | grep -Ei "$p_disk" | tail -n 5 | while IFS= read -r l; do _out "  ${YELLOW}${l}${NC}"; done
  fi

  if [ "$MODE" = "full" ] && printf '%s\n' "$LOGTEXT" | grep -Ei "$p_therm" >/dev/null 2>&1; then
    found=1
    warn "В логах (${LOGSRC}) есть события температуры/троттлинга"
    printf '%s\n' "$LOGTEXT" | grep -Ei "$p_therm" | tail -n 5 | while IFS= read -r l; do _out "  ${YELLOW}${l}${NC}"; done
  fi

  if [ "$found" -eq 0 ]; then
    ok "Ошибок в логах не найдено (${LOGSRC})"
  fi
fi

# 8) ИНФОРМАЦИЯ
_out "=== ИНФОРМАЦИЯ ==="
if [ -r /proc/uptime ]; then
  up_s="$(cut -d. -f1 /proc/uptime 2>/dev/null)"
  log "Аптайм: $(fmt_uptime "$up_s")"
  json_add uptime_s "$up_s" n
else
  log "Аптайм: неизвестно"
fi
log "Kernel: $(uname -r 2>/dev/null || uname 2>/dev/null || echo 'unknown')"

model=""
if [ -r /proc/device-tree/model ]; then
  model="$(tr -d '\000' < /proc/device-tree/model 2>/dev/null)"
fi
[ -z "$model" ] && model="$(awk -F: '/model name/ {gsub(/^ +/,"",$2); print $2; exit}' /proc/cpuinfo 2>/dev/null)"
[ -n "$model" ] && log "Модель: $model" && json_add model "$model" s

if have ndmc; then
  ver="$(ndmc -c 'show version' 2>/dev/null | head -n 3 | tr '\n' ' ' | sed 's/[[:space:]]\+/ /g; s/[[:space:]]\+$//')"
  [ -n "$ver" ] && log "NDM: ${DIM}${ver}${NC}" && json_add ndm "$ver" s
fi

# 9) ИТОГО
DUR=""
if [ -n "$START_TS" ] && have date; then
  end="$(date +%s 2>/dev/null || echo '')"
  case "$end" in ''|*[!0-9]*) end="";; esac
  case "$START_TS" in ''|*[!0-9]*) START_TS="";; esac
  if [ -n "$end" ] && [ -n "$START_TS" ] && [ "$end" -ge "$START_TS" ] 2>/dev/null; then
    DUR=$((end - START_TS))
  fi
fi

_out "========================================"
if [ "$CRIT_N" -gt 0 ] 2>/dev/null; then
  _out "ИТОГО: ${RED}${CRIT_N} крит.${NC}, ${YELLOW}${WARN_N} предупрежд.${NC}${DUR:+, время: ${DUR}s}"
  EXIT_CODE=2
elif [ "$WARN_N" -gt 0 ] 2>/dev/null; then
  _out "ИТОГО: ${YELLOW}${WARN_N} предупрежд.${NC}${DUR:+, время: ${DUR}s}"
  EXIT_CODE=1
else
  _out "ИТОГО: ${GREEN}всё OK${NC}${DUR:+, время: ${DUR}s}"
  EXIT_CODE=0
fi
_out "Подсказка: sysmon --short | sysmon --full | sysmon --json  (в веб-терминале)"
_out "========================================"

if [ "$AS_JSON" -eq 1 ]; then
  # Minimal JSON payload. It is printed AFTER human output to preserve backward compatibility.
  json_add warn_count "$WARN_N" n
  json_add crit_count "$CRIT_N" n
  json_add exit_code "$EXIT_CODE" n
  _out "{${JSON_KV}}"
fi

exit "$EXIT_CODE"

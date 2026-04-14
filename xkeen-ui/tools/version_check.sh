#!/bin/sh
# version_check.sh - Check local versions of Xkeen components and list
# installed Entware packages.

NC='\033[0m'
RED='\033[0;31m'
GRN='\033[0;32m'
YLW='\033[0;33m'
CYN='\033[0;36m'
B_RED='\033[1;31m'
B_GRN='\033[1;32m'
B_YLW='\033[1;33m'
B_BLU='\033[1;34m'
B_CYN='\033[1;36m'
B_WHT='\033[1;37m'

_out() { printf '%b\n' "$*"; }
has_cmd() { command -v "$1" >/dev/null 2>&1; }

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd)
if [ -n "$SCRIPT_DIR" ]; then
  UI_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." 2>/dev/null && pwd)
else
  UI_DIR=""
fi
[ -n "$UI_DIR" ] || UI_DIR="/opt/etc/xkeen-ui"

CACHE_DIR="${XKEEN_UI_CACHE_DIR:-/opt/var/cache/xkeen-ui}"
CACHE_SCHEMA="${XKEEN_UI_CACHE_NS:-v2}"
CACHE_TTL=43200

ensure_cache_dir() {
  [ -d "$CACHE_DIR" ] || mkdir -p "$CACHE_DIR" 2>/dev/null
}

http_get() {
  url="$1"
  timeout="${2:-10}"

  if has_cmd curl; then
    curl -fsL --connect-timeout 4 --max-time "$timeout" "$url" 2>/dev/null
  elif has_cmd wget; then
    wget -q -O - --timeout="$timeout" "$url" 2>/dev/null
  else
    return 1
  fi
}

read_cache() {
  key="$1"
  cache_file="$CACHE_DIR/${CACHE_SCHEMA}_${key}"
  [ -f "$cache_file" ] || return 1

  if has_cmd stat; then
    file_ts=$(stat -c '%Y' "$cache_file" 2>/dev/null || stat -f '%m' "$cache_file" 2>/dev/null)
    now_ts=$(date +%s 2>/dev/null)
    if [ -n "$file_ts" ] && [ -n "$now_ts" ]; then
      age=$((now_ts - file_ts))
      [ "$age" -gt "$CACHE_TTL" ] && return 1
    fi
  fi

  cat "$cache_file" 2>/dev/null
}

write_cache() {
  key="$1"
  value="$2"
  ensure_cache_dir
  printf '%s' "$value" > "$CACHE_DIR/${CACHE_SCHEMA}_${key}" 2>/dev/null
}

trim_text() {
  printf '%s\n' "$1" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//'
}

extract_version() {
  printf '%s\n' "$1" | awk '
    match($0, /[0-9]+(\.[0-9]+)+/) {
      print substr($0, RSTART, RLENGTH)
      exit
    }
  '
}

extract_version_with_suffix() {
  printf '%s\n' "$1" | awk '
    match($0, /[0-9]+(\.[0-9]+)+([[:space:]]+[[:alnum:]_.-]+)*/) {
      print substr($0, RSTART, RLENGTH)
      exit
    }
  '
}

json_field() {
  key="$1"
  file="$2"
  [ -f "$file" ] || return 1
  sed -n "s/.*\"$key\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$file" 2>/dev/null | head -n 1
}

compare_versions() {
  ver_a=$(extract_version "$1")
  ver_b=$(extract_version "$2")

  if [ -z "$ver_a" ] || [ -z "$ver_b" ]; then
    printf '0'
    return 0
  fi

  awk -v a="$ver_a" -v b="$ver_b" '
    BEGIN {
      na = split(a, A, ".")
      nb = split(b, B, ".")
      max = (na > nb ? na : nb)

      for (i = 1; i <= max; i++) {
        va = (i <= na ? A[i] + 0 : 0)
        vb = (i <= nb ? B[i] + 0 : 0)

        if (va < vb) {
          print -1
          exit
        }
        if (va > vb) {
          print 1
          exit
        }
      }

      print 0
    }
  '
}

build_info_candidates() {
  printf '%s\n' \
    "$UI_DIR/BUILD.json" \
    "/opt/etc/xkeen-ui/BUILD.json" \
    "/opt/share/www/custom/xkeen-ui/BUILD.json"
}

panel_metadata_candidates() {
  printf '%s\n' \
    "$UI_DIR/package.json" \
    "/opt/etc/xkeen-ui/package.json" \
    "/opt/share/www/custom/xkeen-ui/package.json" \
    "$UI_DIR/version.txt" \
    "/opt/etc/xkeen-ui/version.txt" \
    "/opt/share/www/custom/xkeen-ui/version.txt"
}

get_github_latest() {
  repo="$1"
  cache_key="github_$(printf '%s' "$repo" | tr '/:' '__')"

  cached=$(read_cache "$cache_key")
  if [ -n "$cached" ]; then
    printf '%s' "$cached"
    return 0
  fi

  json=$(http_get "https://api.github.com/repos/${repo}/releases/latest" 12)
  if [ -n "$json" ]; then
    tag=$(printf '%s' "$json" | tr ',' '\n' | \
      sed -n 's/^[[:space:]]*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' | \
      awk 'NR==1{print; exit}')
    ver=$(extract_version "$tag")
    if [ -n "$ver" ]; then
      write_cache "$cache_key" "$ver"
      printf '%s' "$ver"
      return 0
    fi
  fi

  json=$(http_get "https://api.github.com/repos/${repo}/tags?per_page=1" 12)
  if [ -n "$json" ]; then
    tag=$(printf '%s' "$json" | tr ',' '\n' | \
      sed -n 's/^[[:space:]]*"name":[[:space:]]*"\([^"]*\)".*/\1/p' | \
      awk 'NR==1{print; exit}')
    ver=$(extract_version "$tag")
    if [ -n "$ver" ]; then
      write_cache "$cache_key" "$ver"
      printf '%s' "$ver"
      return 0
    fi
  fi

  return 1
}

get_local_xkeen_version() {
  line=""
  display=""

  if has_cmd xkeen; then
    line=$(xkeen -v 2>/dev/null | head -n 1)
    [ -z "$line" ] && line=$(xkeen --version 2>/dev/null | head -n 1)
  fi

  if [ -z "$line" ] && [ -x /opt/sbin/xkeen ]; then
    line=$(/opt/sbin/xkeen -v 2>/dev/null | head -n 1)
    [ -z "$line" ] && line=$(/opt/sbin/xkeen --version 2>/dev/null | head -n 1)
  fi

  if [ -n "$line" ]; then
    display=$(printf '%s\n' "$line" | sed 's/[[:space:]]*(.*$//')
    display=$(extract_version_with_suffix "$display")
    display=$(trim_text "$display")
    [ -n "$display" ] && {
      printf '%s' "$display"
      return 0
    }
  fi

  if [ -r /opt/sbin/xkeen ] && head -n 1 /opt/sbin/xkeen 2>/dev/null | grep -q '^#!'; then
    display=$(sed -n "s/^[[:space:]]*XKEEN_VERSION=[\"']\([^\"']*\)[\"'].*/\1/p" /opt/sbin/xkeen 2>/dev/null | head -n 1)
    display=$(trim_text "$display")
    [ -n "$display" ] && {
      printf '%s' "$display"
      return 0
    }
  fi

  return 1
}

get_local_xkeen_ui_version() {
  for f in $(build_info_candidates); do
    ver=$(json_field version "$f")
    ver=$(extract_version "$ver")
    [ -n "$ver" ] && {
      printf '%s' "$ver"
      return 0
    }
  done

  for f in $(panel_metadata_candidates); do
    case "$f" in
      *.json)
        ver=$(json_field version "$f")
        ver=$(extract_version "$ver")
        ;;
      *)
        ver=$(head -n 1 "$f" 2>/dev/null)
        ver=$(extract_version "$ver")
        ;;
    esac

    [ -n "$ver" ] && {
      printf '%s' "$ver"
      return 0
    }
  done

  return 1
}

get_local_xkeen_ui_repo() {
  if [ -n "$XKEEN_UI_UPDATE_REPO" ]; then
    printf '%s' "$XKEEN_UI_UPDATE_REPO"
    return 0
  fi

  for f in $(build_info_candidates); do
    repo=$(json_field repo "$f")
    repo=$(trim_text "$repo")
    [ -n "$repo" ] && {
      printf '%s' "$repo"
      return 0
    }
  done

  printf '%s' "umarcheh001/Xkeen-UI"
}

get_local_xray_version() {
  line=""

  if has_cmd xray; then
    line=$(xray version 2>/dev/null | head -n 1)
  fi

  if [ -z "$line" ] && [ -x /opt/bin/xray ]; then
    line=$(/opt/bin/xray version 2>/dev/null | head -n 1)
  fi

  ver=$(extract_version "$line")
  [ -n "$ver" ] && {
    printf '%s' "$ver"
    return 0
  }

  return 1
}

get_local_mihomo_version() {
  line=""

  if has_cmd mihomo; then
    line=$(mihomo -v 2>/dev/null | head -n 1)
  fi

  if [ -z "$line" ] && [ -x /opt/bin/mihomo ]; then
    line=$(/opt/bin/mihomo -v 2>/dev/null | head -n 1)
  fi

  ver=$(extract_version "$line")
  [ -n "$ver" ] && {
    printf '%s' "$ver"
    return 0
  }

  return 1
}

get_kernel_version() {
  ver=$(uname -r 2>/dev/null)
  [ -n "$ver" ] && {
    printf '%s' "$ver"
    return 0
  }

  return 1
}

get_firmware_version() {
  fw=""

  if has_cmd curl; then
    json=$(curl -fsL --connect-timeout 2 --max-time 5 "http://localhost:79/rci/show/version" 2>/dev/null)
    if [ -n "$json" ]; then
      fw=$(printf '%s' "$json" | tr ',' '\n' | \
        sed -n 's/^[[:space:]]*"title"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | \
        awk 'NR==1{print; exit}')
    fi
  fi

  if [ -z "$fw" ] && has_cmd ndmc; then
    fw=$(ndmc -c 'show version' 2>/dev/null | awk -F': ' '/title/ {print $2; exit}')
  fi

  [ -n "$fw" ] && {
    printf '%s' "$fw"
    return 0
  }

  return 1
}

get_entware_package_count() {
  if ! has_cmd opkg; then
    return 1
  fi

  count=$(opkg list-installed 2>/dev/null | wc -l | tr -d ' ')
  [ -n "$count" ] && {
    printf '%s' "$count"
    return 0
  }

  return 1
}

get_entware_packages() {
  if ! has_cmd opkg; then
    return 1
  fi

  opkg list-installed 2>/dev/null | \
    awk -F ' - ' '
      NF >= 2 {
        name = $1
        ver = $2
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", name)
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", ver)

        if (name != "") {
          if (ver == "") ver = "-"
          print name "\t" ver
        }
      }
    ' | sort
}

section_header() {
  title="$1"
  color="${2:-$B_CYN}"
  bar="══════════════════════════════════════════════════════"

  _out ""
  _out "${color}╔${bar}╗${NC}"
  _out "${color}║${NC}   ${color}${title}\033[56G${color}║${NC}"
  _out "${color}╚${bar}╝${NC}"
}

print_local_line() {
  label="$1"
  value="$2"

  [ -n "$value" ] || return 0
  printf "  ${B_WHT}%-16s${NC} ${CYN}%s${NC}\n" "$label" "$value"
}

print_component() {
  name="$1"
  local_ver="$2"
  remote_ver="$3"

  if [ -z "$local_ver" ]; then
    printf "  ${B_WHT}%-16s${NC} ${YLW}не установлен${NC}\n" "$name"
    return 0
  fi

  if [ -z "$remote_ver" ]; then
    printf "  ${B_WHT}%-16s${NC} ${CYN}%s${NC}  ${YLW}(нет данных о последней)${NC}\n" "$name" "$local_ver"
    return 0
  fi

  cmp=$(compare_versions "$local_ver" "$remote_ver")

  if [ "$cmp" -lt 0 ] 2>/dev/null; then
    printf "  ${B_WHT}%-16s${NC} ${CYN}%s${NC}  ->  ${B_GRN}%s${NC}  ${B_YLW}обновление доступно${NC}\n" \
      "$name" "$local_ver" "$remote_ver"
  else
    printf "  ${B_WHT}%-16s${NC} ${B_GRN}%s${NC}  ${GRN}актуально${NC}\n" \
      "$name" "$local_ver"
  fi
}

normalize_component() {
  value=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')

  case "$value" in
    ""|all)
      printf '%s' ""
      ;;
    ui|panel|panel-ui|xkeen_ui|xkeenui)
      printf '%s' "xkeen-ui"
      ;;
    packages|package|pkg|pkgs|opkg)
      printf '%s' "entware"
      ;;
    xkeen|xkeen-ui|xray|mihomo|system|entware)
      printf '%s' "$value"
      ;;
    *)
      printf '%s' "$value"
      ;;
  esac
}

want_component() {
  selected="$1"
  target="$2"

  [ -z "$selected" ] && return 0
  [ "$selected" = "$target" ] && return 0
  return 1
}

needs_remote_versions() {
  selected="$1"

  case "$selected" in
    ""|xkeen|xkeen-ui|xray|mihomo)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

show_versions_section() {
  offline="$1"
  selected="$2"

  show_versions=0
  for item in system xkeen xkeen-ui xray mihomo; do
    if want_component "$selected" "$item"; then
      show_versions=1
      break
    fi
  done

  [ "$show_versions" = "1" ] || return 0

  section_header "ВЕРСИИ КОМПОНЕНТОВ" "$B_CYN"
  _out ""

  if want_component "$selected" "system"; then
    fw=$(get_firmware_version)
    kern=$(get_kernel_version)
    print_local_line "Прошивка" "$fw"
    print_local_line "Ядро" "$kern"

    if [ -n "$fw" ] || [ -n "$kern" ]; then
      _out ""
    fi
  fi

  if want_component "$selected" "xkeen"; then
    local_v=$(get_local_xkeen_version)
    remote_v=""
    if [ "$offline" != "1" ]; then
      remote_v=$(get_github_latest "jameszeroX/XKeen")
    fi
    print_component "xkeen" "$local_v" "$remote_v"
  fi

  if want_component "$selected" "xkeen-ui"; then
    local_v=$(get_local_xkeen_ui_version)
    remote_v=""
    panel_repo=$(get_local_xkeen_ui_repo)
    if [ "$offline" != "1" ] && [ -n "$panel_repo" ]; then
      remote_v=$(get_github_latest "$panel_repo")
    fi
    print_component "xkeen-ui" "$local_v" "$remote_v"
  fi

  if want_component "$selected" "xray"; then
    local_v=$(get_local_xray_version)
    remote_v=""
    if [ "$offline" != "1" ]; then
      remote_v=$(get_github_latest "XTLS/Xray-core")
    fi
    print_component "xray" "$local_v" "$remote_v"
  fi

  if want_component "$selected" "mihomo"; then
    local_v=$(get_local_mihomo_version)
    remote_v=""
    if [ "$offline" != "1" ]; then
      remote_v=$(get_github_latest "MetaCubeX/mihomo")
    fi
    print_component "mihomo" "$local_v" "$remote_v"
  fi

  if [ "$offline" != "1" ]; then
    _out ""
    _out "  ${CYN}Кэш версий: ${CACHE_DIR} (TTL: $((CACHE_TTL / 3600))ч)${NC}"
  fi
}

show_entware_section() {
  selected="$1"

  if ! want_component "$selected" "entware"; then
    return 0
  fi

  section_header "ПАКЕТЫ ENTWARE" "$B_BLU"

  if ! has_cmd opkg; then
    _out "  ${YLW}opkg не найден — Entware не установлен или недоступен.${NC}"
    return 0
  fi

  count=$(get_entware_package_count)
  [ -n "$count" ] || count="0"
  printf "  ${B_WHT}%-16s${NC} ${CYN}%s${NC}\n" "Установлено" "$count"

  packages=$(get_entware_packages)
  if [ -z "$packages" ]; then
    _out ""
    _out "  ${YLW}Список пакетов пуст или недоступен.${NC}"
    return 0
  fi

  _out ""
  printf '%s\n' "$packages" | while IFS="$(printf '\t')" read -r name version; do
    [ -n "$name" ] || continue
    printf "  ${B_WHT}%-24s${NC} ${CYN}%s${NC}\n" "$name" "$version"
  done
}

check_all() {
  offline="$1"
  selected="$2"

  show_versions_section "$offline" "$selected"
  show_entware_section "$selected"
  _out ""
}

main() {
  offline=0
  selected=""

  while [ $# -gt 0 ]; do
    case "$1" in
      --offline|-o)
        offline=1
        ;;
      --component|-c)
        selected="$2"
        shift
        ;;
      --clear-cache)
        rm -rf "$CACHE_DIR" 2>/dev/null
        _out "${GRN}Кэш очищен${NC}"
        return 0
        ;;
      --help|-h)
        _out "Использование: version_check.sh [опции]"
        _out "  Без аргументов            Проверить версии и пакеты Entware"
        _out "  --offline, -o             Без обращения к GitHub"
        _out "  --component, -c ИМЯ       Один компонент: xkeen, xkeen-ui, xray, mihomo, system, entware"
        _out "  --clear-cache             Очистить кэш версий"
        _out "  --help, -h                Эта справка"
        return 0
        ;;
      *)
        ;;
    esac
    shift
  done

  selected=$(normalize_component "$selected")

  case "$selected" in
    ""|xkeen|xkeen-ui|xray|mihomo|system|entware)
      ;;
    *)
      _out "${B_RED}Неизвестный компонент: ${selected}${NC}"
      _out "Доступно: xkeen, xkeen-ui, xray, mihomo, system, entware"
      return 1
      ;;
  esac

  if [ "$offline" != "1" ] && needs_remote_versions "$selected" && ! has_cmd curl && ! has_cmd wget; then
    _out "${YLW}Внимание: curl и wget не найдены — онлайн-проверка недоступна.${NC}"
    offline=1
  fi

  check_all "$offline" "$selected"
}

main "$@"

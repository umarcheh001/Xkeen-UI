#!/bin/sh
# ═══════════════════════════════════════════════════════════════
#  version_check.sh — Проверка версий компонентов Xkeen UI
#  Сравнивает текущие и последние версии: xkeen, xkeen-ui,
#  xray, mihomo, Entware, ядро.
#  Адаптировано из проекта Flashkeen.
#
#  Использование:
#    version_check.sh              — проверить все компоненты
#    version_check.sh --component xkeen — проверить конкретный
#    version_check.sh --offline    — без обращения к GitHub
#
#  Совместимость: BusyBox ash / POSIX sh
#  Зависимости: curl или wget (для онлайн-проверки)
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
has_cmd() { command -v "$1" >/dev/null 2>&1; }

# --- Кэш-директория ---
CACHE_DIR="/opt/var/cache/xkeen-ui"
CACHE_TTL=43200  # 12 часов в секундах

ensure_cache_dir() {
  [ -d "$CACHE_DIR" ] || mkdir -p "$CACHE_DIR" 2>/dev/null
}

# --- HTTP-запрос (curl/wget) ---
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

# --- Кэширование ---
read_cache() {
  key="$1"
  cache_file="$CACHE_DIR/$key"
  [ -f "$cache_file" ] || return 1

  # Проверяем TTL
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
  printf '%s' "$value" > "$CACHE_DIR/$key" 2>/dev/null
}

# --- Извлечение числовой версии ---
extract_version() {
  printf '%s' "$1" | sed -n 's/[^0-9]*\([0-9][0-9.]*\).*/\1/p'
}

# --- Сравнение версий: a.b.c → число ---
version_to_int() {
  ver="$1"
  major=$(printf '%s' "$ver" | awk -F. '{print $1+0}')
  minor=$(printf '%s' "$ver" | awk -F. '{print $2+0}')
  patch=$(printf '%s' "$ver" | awk -F. '{print $3+0}')
  printf '%d' $((major * 1000000 + minor * 1000 + patch))
}

# --- Получить последнюю версию с GitHub ---
get_github_latest() {
  repo="$1"
  cache_key="github_$(echo "$repo" | tr '/' '_')"

  # Попытка из кэша
  cached=$(read_cache "$cache_key")
  if [ -n "$cached" ]; then
    printf '%s' "$cached"
    return 0
  fi

  # API запрос: releases/latest
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

  # Фолбэк: tags API
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

# --- Локальные версии ---
get_local_xkeen_version() {
  if [ -f /opt/sbin/xkeen ]; then
    ver=$(grep -m1 'XKEEN_VERSION=' /opt/sbin/xkeen 2>/dev/null | sed 's/.*=//; s/"//g; s/'"'"'//g')
    [ -n "$ver" ] && { printf '%s' "$ver"; return 0; }
    # Альтернатива
    ver=$(/opt/sbin/xkeen --version 2>/dev/null | head -1)
    ver=$(extract_version "$ver")
    [ -n "$ver" ] && { printf '%s' "$ver"; return 0; }
  fi
  return 1
}

get_local_xkeen_ui_version() {
  for f in /opt/share/www/custom/xkeen-ui/version.txt \
           /opt/share/www/custom/xkeen-ui/package.json; do
    if [ -f "$f" ]; then
      ver=$(extract_version "$(head -1 "$f" 2>/dev/null)")
      [ -n "$ver" ] && { printf '%s' "$ver"; return 0; }
    fi
  done
  return 1
}

get_local_xray_version() {
  if has_cmd xray; then
    ver=$(xray version 2>/dev/null | head -1)
    ver=$(extract_version "$ver")
    [ -n "$ver" ] && { printf '%s' "$ver"; return 0; }
  fi
  return 1
}

get_local_mihomo_version() {
  if has_cmd mihomo; then
    ver=$(mihomo -v 2>/dev/null | head -1)
    ver=$(extract_version "$ver")
    [ -n "$ver" ] && { printf '%s' "$ver"; return 0; }
  fi
  return 1
}

get_kernel_version() {
  ver=$(uname -r 2>/dev/null)
  [ -n "$ver" ] && { printf '%s' "$ver"; return 0; }
  return 1
}

get_entware_version() {
  if has_cmd opkg; then
    ver=$(opkg --version 2>/dev/null | head -1)
    ver=$(extract_version "$ver")
    [ -n "$ver" ] && { printf '%s' "$ver"; return 0; }
  fi
  return 1
}

get_firmware_version() {
  # Keenetic RCI API
  fw=""
  if has_cmd curl; then
    json=$(curl -fsL --connect-timeout 2 --max-time 5 "http://localhost:79/rci/show/version" 2>/dev/null)
    if [ -n "$json" ]; then
      fw=$(printf '%s' "$json" | tr ',' '\n' | \
        sed -n 's/^[[:space:]]*"title"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | \
        awk 'NR==1{print; exit}')
    fi
  fi
  # Фолбэк: ndmc
  if [ -z "$fw" ] && has_cmd ndmc; then
    fw=$(ndmc -c 'show version' 2>/dev/null | awk -F': ' '/title/ {print $2; exit}')
  fi
  [ -n "$fw" ] && { printf '%s' "$fw"; return 0; }
  return 1
}

# --- Секция ---
section_header() {
  name="$1"
  color="${2:-$B_CYN}"
  bar="══════════════════════════════════════════════════════"
  _out ""
  _out "${color}╔${bar}╗${NC}"
  _out "${color}║${NC}   ${color}${name}\033[56G${color}║${NC}"
  _out "${color}╚${bar}╝${NC}"
}

# --- Форматированная строка компонента ---
print_component() {
  name="$1"
  local_ver="$2"
  remote_ver="$3"
  repo="$4"

  if [ -z "$local_ver" ]; then
    printf "  ${B_WHT}%-16s${NC} ${YLW}не установлен${NC}\n" "$name"
    return
  fi

  if [ -z "$remote_ver" ]; then
    printf "  ${B_WHT}%-16s${NC} ${CYN}%s${NC}  ${YLW}(нет данных о последней)${NC}\n" "$name" "$local_ver"
    return
  fi

  local_int=$(version_to_int "$local_ver")
  remote_int=$(version_to_int "$remote_ver")

  if [ "$remote_int" -gt "$local_int" ] 2>/dev/null; then
    printf "  ${B_WHT}%-16s${NC} ${CYN}%s${NC}  →  ${B_GRN}%s${NC}  ${B_YLW}⬆ обновление доступно${NC}\n" \
      "$name" "$local_ver" "$remote_ver"
  else
    printf "  ${B_WHT}%-16s${NC} ${B_GRN}%s${NC}  ${GRN}✓ актуально${NC}\n" \
      "$name" "$local_ver"
  fi
}

# --- Полная проверка ---
check_all() {
  offline="$1"
  section_header "ВЕРСИИ КОМПОНЕНТОВ" "$B_BLU"
  _out ""

  # Прошивка (только локально)
  fw=$(get_firmware_version)
  if [ -n "$fw" ]; then
    printf "  ${B_WHT}%-16s${NC} ${CYN}%s${NC}\n" "Прошивка" "$fw"
  fi

  # Ядро (только локально)
  kern=$(get_kernel_version)
  if [ -n "$kern" ]; then
    printf "  ${B_WHT}%-16s${NC} ${CYN}%s${NC}\n" "Ядро" "$kern"
  fi

  _out ""

  # Компоненты с онлайн-проверкой
  components="xkeen:Jakomnom/xkeen
xkeen-ui:Flavor585/xkeen-ui
xray:XTLS/Xray-core
mihomo:MetaCubeX/mihomo"

  echo "$components" | while IFS=: read -r comp repo; do
    [ -z "$comp" ] && continue

    # Локальная версия
    case "$comp" in
      xkeen)    local_v=$(get_local_xkeen_version) ;;
      xkeen-ui) local_v=$(get_local_xkeen_ui_version) ;;
      xray)     local_v=$(get_local_xray_version) ;;
      mihomo)   local_v=$(get_local_mihomo_version) ;;
      *)        local_v="" ;;
    esac

    # Удалённая версия
    remote_v=""
    if [ "$offline" != "1" ] && [ -n "$repo" ]; then
      remote_v=$(get_github_latest "$repo")
    fi

    print_component "$comp" "$local_v" "$remote_v" "$repo"
  done

  # Entware (только локально)
  ent=$(get_entware_version)
  if [ -n "$ent" ]; then
    printf "  ${B_WHT}%-16s${NC} ${CYN}%s${NC}\n" "opkg" "$ent"
  fi

  # Информация о кэше
  if [ "$offline" != "1" ]; then
    _out ""
    _out "  ${CYN}Кэш версий: ${CACHE_DIR} (TTL: $((CACHE_TTL/3600))ч)${NC}"
  fi
}

# --- Точка входа ---
main() {
  offline=0
  component=""

  while [ $# -gt 0 ]; do
    case "$1" in
      --offline|-o) offline=1 ;;
      --component|-c) component="$2"; shift ;;
      --clear-cache)
        rm -rf "$CACHE_DIR" 2>/dev/null
        _out "${GRN}Кэш очищен${NC}"
        return 0
        ;;
      --help|-h)
        _out "Использование: version_check.sh [опции]"
        _out "  Без аргументов         Проверить все компоненты"
        _out "  --offline, -o          Без обращения к GitHub"
        _out "  --component, -c ИМЯ    Проверить конкретный компонент"
        _out "  --clear-cache          Очистить кэш версий"
        _out "  --help, -h             Эта справка"
        return 0
        ;;
      *) ;;
    esac
    shift
  done

  if ! has_cmd curl && ! has_cmd wget; then
    _out "${YLW}Внимание: curl и wget не найдены — онлайн-проверка невозможна${NC}"
    offline=1
  fi

  check_all "$offline"
  _out ""
}

main "$@"

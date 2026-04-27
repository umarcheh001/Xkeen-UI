#!/bin/sh
set -e

UI_DIR="/opt/etc/xkeen-ui"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
INIT_DIR="/opt/etc/init.d"
INIT_SCRIPT="$INIT_DIR/S99xkeen-ui"
PYTHON_BIN="/opt/bin/python3"
LOG_DIR="/opt/var/log"
RUN_DIR="/opt/var/run"

# JSONC sidecar-dir для "сырого" текста с комментариями (routing/inbounds/outbounds).
# Должен лежать ВНЕ /opt/etc/xray/configs, иначе некоторые сборки Xray могут
# начать подхватывать *.jsonc из -confdir и ломать правила.
# (По умолчанию: /opt/etc/xkeen-ui/xray-jsonc)
JSONC_DIR_DEFAULT="$UI_DIR/xray-jsonc"

# Если это апгрейд и пользователь уже сохранял env overrides через DevTools,
# подтянем XKEEN_XRAY_JSONC_DIR (только если не задано явно в окружении).
if [ -z "${XKEEN_XRAY_JSONC_DIR:-}" ] && [ -f "$UI_DIR/devtools.env" ]; then
  # shellcheck disable=SC1090
  . "$UI_DIR/devtools.env" 2>/dev/null || true
fi

JSONC_DIR="${XKEEN_XRAY_JSONC_DIR:-$JSONC_DIR_DEFAULT}"
if [ -z "$JSONC_DIR" ]; then
  JSONC_DIR="$JSONC_DIR_DEFAULT"
fi

# Определяем архитектуру устройства, чтобы решить, устанавливать ли gevent
ARCH="$(uname -m 2>/dev/null || echo unknown)"
WANT_GEVENT=1
GEVENT_PIP_SPEC="${XKEEN_GEVENT_PIP_SPEC:-gevent}"
GEVENT_PIN_REASON=""
case "$ARCH" in
  mipsel*|mips*)
    # На слабых MIPS/MIPSEL-роутерах сборка gevent/greenlet часто не проходит.
    # В этом случае панель будет работать через HTTP-пуллинг без gevent.
    WANT_GEVENT=0
    ;;
  aarch64|arm64)
    # Для части Entware/aarch64 устройств gevent 26.x не подбирает совместимый
    # wheel и падает в source-build, где обычно нет C compiler.
    if [ -z "${XKEEN_GEVENT_PIP_SPEC:-}" ]; then
      GEVENT_PIP_SPEC="gevent<26"
      GEVENT_PIN_REASON="совместимость wheel на Entware/aarch64"
    fi
    ;;
esac

MIHOMO_TEMPLATES_DIR="/opt/etc/mihomo/templates"
SRC_MIHOMO_TEMPLATES="$SRC_DIR/opt/etc/mihomo/templates"

# Шаблоны Xray (Routing)
XRAY_ROUTING_TEMPLATES_DIR="$UI_DIR/templates/routing"
SRC_XRAY_ROUTING_TEMPLATES="$SRC_DIR/opt/etc/xray/templates/routing"

# Шаблоны Xray (Observatory)
XRAY_OBSERVATORY_TEMPLATES_DIR="$UI_DIR/templates/observatory"
SRC_XRAY_OBSERVATORY_TEMPLATES="$SRC_DIR/opt/etc/xray/templates/observatory"

# Файлы/директории Xray (используются панелью, но сами не трогаются)
#
# В некоторых сборках/профилях части конфига могут называться иначе.
# Например для Hysteria2 используются *_hys2.json:
#   03_inbounds_hys2.json / 04_outbounds_hys2.json / 05_routing_hys2.json
#
XRAY_CONFIG_DIR="/opt/etc/xray/configs"

# DAT-файлы GeoIP/GeoSite
# Xray обычно ищет assets относительно директории бинарника (например /opt/sbin).
# При использовании синтаксиса ext:<file>.dat:<list> удобнее хранить DAT в /opt/etc/xray/dat,
# но тогда нужно обеспечить доступность файлов для Xray.
# Решение: делаем symlink всех *.dat из /opt/etc/xray/dat в /opt/sbin (если возможно).
XRAY_DAT_DIR="/opt/etc/xray/dat"
XRAY_BIN_DIR="/opt/sbin"

pick_xray_file() {
  DEF="$1"
  ALT="$2"
  if [ -f "$XRAY_CONFIG_DIR/$DEF" ]; then
    echo "$XRAY_CONFIG_DIR/$DEF"
    return 0
  fi
  if [ -f "$XRAY_CONFIG_DIR/$ALT" ]; then
    echo "$XRAY_CONFIG_DIR/$ALT"
    return 0
  fi
  # default for new installs
  echo "$XRAY_CONFIG_DIR/$DEF"
}

ROUTING_FILE="$(pick_xray_file 05_routing.json 05_routing_hys2.json)"
INBOUNDS_FILE="$(pick_xray_file 03_inbounds.json 03_inbounds_hys2.json)"
OUTBOUNDS_FILE="$(pick_xray_file 04_outbounds.json 04_outbounds_hys2.json)"
BACKUP_DIR="$XRAY_CONFIG_DIR/backups"

DEFAULT_PORT=8088
ALT_PORT=8091
PIP_PRIMARY_INDEX_DEFAULT="https://pypi.org/simple"
PIP_FALLBACK_INDEX_DEFAULT="https://mirrors.aliyun.com/pypi/simple/"

append_pip_index_candidate() {
  URL="$1"
  [ -n "$URL" ] || return 0

  case " $PIP_INDEX_CANDIDATES " in
    *" $URL "*) return 0 ;;
  esac

  if [ -n "${PIP_INDEX_CANDIDATES:-}" ]; then
    PIP_INDEX_CANDIDATES="$PIP_INDEX_CANDIDATES $URL"
  else
    PIP_INDEX_CANDIDATES="$URL"
  fi
}

build_pip_index_candidates() {
  PIP_INDEX_CANDIDATES=""
  append_pip_index_candidate "${XKEEN_PIP_INDEX_URL:-}"
  append_pip_index_candidate "$PIP_PRIMARY_INDEX_DEFAULT"
  append_pip_index_candidate "${XKEEN_PIP_FALLBACK_INDEX_URL:-$PIP_FALLBACK_INDEX_DEFAULT}"
}

print_pip_index_candidates() {
  build_pip_index_candidates
  echo "[*] pip index fallback order: $PIP_INDEX_CANDIDATES"
}

pip_install_with_fallback() {
  PHASE="$1"
  shift

  build_pip_index_candidates
  if [ -z "${PIP_INDEX_CANDIDATES:-}" ]; then
    echo "[!] [$PHASE] Не задан ни один pip index URL."
    return 1
  fi

  LAST_STATUS=1
  for INDEX_URL in $PIP_INDEX_CANDIDATES; do
    [ -n "$INDEX_URL" ] || continue

    echo "[*] [$PHASE] pip install через индекс: $INDEX_URL"
    if "$PYTHON_BIN" -m pip install \
      --upgrade \
      --index-url "$INDEX_URL" \
      --default-timeout "${XKEEN_PIP_TIMEOUT:-60}" \
      "$@"; then
      echo "[*] [$PHASE] pip install успешно через: $INDEX_URL"
      return 0
    fi

    LAST_STATUS=$?
    echo "[!] [$PHASE] pip install не удался через: $INDEX_URL"
  done

  return "$LAST_STATUS"
}

echo "========================================"
echo "  Xkeen Web UI — УСТАНОВКА"
echo "========================================"

# --- Python3 ---

if [ ! -x "$PYTHON_BIN" ]; then
  echo "[*] Python3 не найден по пути $PYTHON_BIN."
  echo "[*] Пытаюсь установить python3 через Entware (opkg)..."

  if command -v opkg >/dev/null 2>&1; then
    OPKG_BIN="$(command -v opkg)"
  elif [ -x "/opt/bin/opkg" ]; then
    OPKG_BIN="/opt/bin/opkg"
  else
    echo "[!] Не найден пакетный менеджер opkg Entware."
    echo "    Установи Entware и python3 вручную, затем запусти установщик ещё раз."
    exit 1
  fi

  if ! "$OPKG_BIN" update; then
    echo "[!] Не удалось выполнить 'opkg update'."
    exit 1
  fi

  if ! "$OPKG_BIN" install python3; then
    echo "[!] Установка python3 через opkg завершилась с ошибкой."
    exit 1
  fi
fi

if [ ! -x "$PYTHON_BIN" ]; then
  echo "[!] Python3 по пути $PYTHON_BIN не найден даже после установки."
  exit 1
fi

# --- Flask + gevent ---

echo "[*] Проверяю наличие Flask/gevent для Python3..."

# Flask обязателен, gevent/geventwebsocket — опциональны (только для WebSocket-логов)

NEED_FLASK=0
NEED_GEVENT=0

# Проверяем flask
if ! "$PYTHON_BIN" -c "import flask" >/dev/null 2>&1; then
  NEED_FLASK=1
fi


# Проверяем gevent и geventwebsocket (только если архитектура позволяет)
if [ "$WANT_GEVENT" -eq 1 ]; then
  for MOD in gevent geventwebsocket; do
    if ! "$PYTHON_BIN" -c "import $MOD" >/dev/null 2>&1; then
      NEED_GEVENT=1
      break
    fi
  done
else
  echo "[*] Архитектура $ARCH: пропускаю установку gevent/gevent-websocket, будет использован HTTP-пулинг."
fi

if [ "$NEED_FLASK" -eq 1 ] || [ "$NEED_GEVENT" -eq 1 ]; then
  echo "[*] Flask и/или gevent не найдены. Пытаюсь установить зависимости через Entware и pip..."

  if command -v opkg >/dev/null 2>&1; then
    OPKG_BIN="$(command -v opkg)"
  elif [ -x "/opt/bin/opkg" ]; then
    OPKG_BIN="/opt/bin/opkg"
  else
    echo "[!] Не найден пакетный менеджер opkg Entware."
    echo "    Поставь зависимости вручную:"
    echo "      opkg update && opkg install python3 python3-pip"
    echo "      export XKEEN_PIP_INDEX_URL=${XKEEN_PIP_INDEX_URL:-$PIP_FALLBACK_INDEX_DEFAULT}"
    echo "      export XKEEN_GEVENT_PIP_SPEC=${XKEEN_GEVENT_PIP_SPEC:-$GEVENT_PIP_SPEC}"
    if [ "$WANT_GEVENT" -eq 1 ]; then
      echo "      $PYTHON_BIN -m pip install --upgrade --index-url \"\$XKEEN_PIP_INDEX_URL\" pip setuptools wheel"
      echo "      $PYTHON_BIN -m pip install --upgrade --index-url \"\$XKEEN_PIP_INDEX_URL\" flask"
      echo "      $PYTHON_BIN -m pip install --upgrade --index-url \"\$XKEEN_PIP_INDEX_URL\" \"\$XKEEN_GEVENT_PIP_SPEC\" gevent-websocket"
    else
      echo "      $PYTHON_BIN -m pip install --upgrade --index-url \"\$XKEEN_PIP_INDEX_URL\" pip setuptools wheel"
      echo "      $PYTHON_BIN -m pip install --upgrade --index-url \"\$XKEEN_PIP_INDEX_URL\" flask"
    fi
    echo "    После этого запусти установщик ещё раз."
    exit 1
  fi

  if ! "$OPKG_BIN" update; then
    echo "[!] Не удалось выполнить 'opkg update' при установке зависимостей."
    exit 1
  fi

  if ! "$OPKG_BIN" install python3 python3-pip; then
    echo "[!] Установка python3 и python3-pip через opkg завершилась с ошибкой."
    exit 1
  fi

  # Auto-repair python3-pip if an Entware update left it structurally broken.
  # Symptom: opkg reports "Package python3-pip ... is up to date" but
  # `python3 -m pip` raises ModuleNotFoundError: No module named 'pip'.
  # opkg install is idempotent — it won't re-extract files for an already
  # "installed" package, so we have to remove first to force a clean reinstall.
  if ! "$PYTHON_BIN" -m pip --version >/dev/null 2>&1; then
    echo "[!] python3-pip установлен пакетом, но модуль pip недоступен (часто после обновления Entware)."
    echo "[*] Автоматический ремонт: opkg remove python3-pip -> opkg update -> opkg install python3-pip..."
    "$OPKG_BIN" remove python3-pip >/dev/null 2>&1 || true
    "$OPKG_BIN" update >/dev/null 2>&1 || true
    if ! "$OPKG_BIN" install python3-pip; then
      echo "[!] Не удалось переустановить python3-pip через opkg."
      echo "    Выполни вручную и запусти установщик ещё раз:"
      echo "      opkg remove python3-pip && opkg update && opkg install python3-pip"
      exit 1
    fi
    if ! "$PYTHON_BIN" -m pip --version >/dev/null 2>&1; then
      echo "[!] python3-pip переустановлен, но модуль pip всё ещё недоступен из $PYTHON_BIN."
      echo "    Выполни вручную и запусти установщик ещё раз:"
      echo "      opkg remove python3-pip && opkg update && opkg install python3-pip"
      exit 1
    fi
    echo "[*] python3-pip успешно восстановлен."
  fi

  print_pip_index_candidates

  if ! pip_install_with_fallback "bootstrap" pip setuptools wheel; then
    echo "[!] Не удалось обновить pip/setuptools/wheel через доступные индексы."
    echo "    Продолжаю установку с текущим pip."
  fi

  if [ "$NEED_FLASK" -eq 1 ]; then
    if ! pip_install_with_fallback "flask" flask; then
      echo "[!] Не удалось установить Flask через доступные pip-индексы."
      echo "    Можно повторить установку с зеркалом вручную, например:"
      echo "      XKEEN_PIP_INDEX_URL=$PIP_FALLBACK_INDEX_DEFAULT sh install.sh"
      exit 1
    fi
  else
    echo "[*] Flask уже доступен из $PYTHON_BIN, отдельная pip-установка не требуется."
  fi

  # pip может не суметь собрать gevent/gevent-websocket на слабых роутерах,
  # поэтому ошибка здесь НЕ фатальная — продолжаем установку без WebSocket.
  if [ "$WANT_GEVENT" -eq 1 ]; then
    if [ -n "$GEVENT_PIN_REASON" ]; then
      echo "[*] Архитектура $ARCH: использую '$GEVENT_PIP_SPEC' ($GEVENT_PIN_REASON)."
    fi
    if ! pip_install_with_fallback "gevent" "$GEVENT_PIP_SPEC" gevent-websocket; then
      echo "[!] Не удалось полностью установить gevent/gevent-websocket через pip."
      echo "    Продолжаю установку, но WebSocket может быть недоступен."
      echo "    При необходимости можно повторить отдельно с зеркалом:"
      echo "      XKEEN_PIP_INDEX_URL=$PIP_FALLBACK_INDEX_DEFAULT XKEEN_GEVENT_PIP_SPEC=$GEVENT_PIP_SPEC $PYTHON_BIN -m pip install --upgrade \"\$XKEEN_GEVENT_PIP_SPEC\" gevent-websocket"
    fi
  fi
fi

# Финальная проверка: flask обязателен
if ! "$PYTHON_BIN" -c "import flask" >/dev/null 2>&1; then
  echo "[!] Модуль flask по-прежнему не виден из $PYTHON_BIN."
  echo "    Без него панель не запустится. Завершаю установку."
  exit 1
fi

# gevent/geventwebsocket — опциональны: предупреждаем, но НЕ падаем
if [ "$WANT_GEVENT" -eq 1 ]; then
  MISSING_GEVENT=""
  for MOD in gevent geventwebsocket; do
    if ! "$PYTHON_BIN" -c "import $MOD" >/dev/null 2>&1; then
      if [ -z "$MISSING_GEVENT" ]; then
        MISSING_GEVENT="$MOD"
      else
        MISSING_GEVENT="$MISSING_GEVENT $MOD"
      fi
    fi
  done

  if [ -n "$MISSING_GEVENT" ]; then
    echo "[!] Следующие модули gevent недоступны: $MISSING_GEVENT"
    echo "    Продолжаю установку без WebSocket; логи Xray будут отображаться через HTTP-пулинг."
  else
    echo "[*] Flask и gevent найдены, WebSocket для логов Xray будет использован."
  fi
else
  echo "[*] gevent/gevent-websocket не устанавливались для архитектуры $ARCH."
  echo "    Логи Xray будут отображаться через HTTP-пулинг."
fi

echo "[*] Python-зависимости в порядке."


# --- lftp (для файлового менеджера) ---

echo "[*] Проверяю наличие lftp для файлового менеджера..."

if ! command -v lftp >/dev/null 2>&1; then
  echo "[*] lftp не найден. Пытаюсь установить lftp через Entware (opkg)..."

  if command -v opkg >/dev/null 2>&1; then
    OPKG_BIN="$(command -v opkg)"
  elif [ -x "/opt/bin/opkg" ]; then
    OPKG_BIN="/opt/bin/opkg"
  else
    echo "[!] Не найден пакетный менеджер opkg Entware."
    echo "    Установи Entware и lftp вручную, затем запусти установщик ещё раз."
    exit 1
  fi

  if ! "$OPKG_BIN" update; then
    echo "[!] Не удалось выполнить 'opkg update' при установке lftp."
    exit 1
  fi

  if ! "$OPKG_BIN" install lftp; then
    echo "[!] Установка lftp через opkg завершилась с ошибкой."
    exit 1
  fi
fi

if ! command -v lftp >/dev/null 2>&1; then
  echo "[!] lftp не найден даже после установки."
  exit 1
fi


# --- sysmon: утилиты для расширенной диагностики (coreutils-df, procps-ng-free, procps-ng-uptime) ---

echo "[*] Проверяю утилиты для системного монитора (sysmon)..."

SYSMON_PKGS=""
# coreutils-df — для df -h с человекочитаемыми размерами
command -v df >/dev/null 2>&1 && df -h / >/dev/null 2>&1 || SYSMON_PKGS="$SYSMON_PKGS coreutils-df"
# procps-ng-free — для free -h --mega (подробная информация об ОЗУ/Swap)
command -v free >/dev/null 2>&1 && free -h >/dev/null 2>&1 || SYSMON_PKGS="$SYSMON_PKGS procps-ng-free"
# procps-ng-uptime — для uptime -p (человекочитаемый аптайм)
command -v uptime >/dev/null 2>&1 && uptime -p >/dev/null 2>&1 || SYSMON_PKGS="$SYSMON_PKGS procps-ng-uptime"

if [ -n "$SYSMON_PKGS" ]; then
  echo "[*] Устанавливаю пакеты для sysmon:$SYSMON_PKGS"
  if command -v opkg >/dev/null 2>&1; then
    OPKG_BIN="$(command -v opkg)"
  elif [ -x "/opt/bin/opkg" ]; then
    OPKG_BIN="/opt/bin/opkg"
  fi
  if [ -n "$OPKG_BIN" ]; then
    "$OPKG_BIN" update >/dev/null 2>&1 || true
    # shellcheck disable=SC2086
    "$OPKG_BIN" install $SYSMON_PKGS 2>/dev/null || \
      echo "[!] Не все пакеты sysmon удалось установить (некритично, sysmon будет работать с фолбэками)."
  else
    echo "[!] opkg не найден — пропускаю установку пакетов sysmon."
    echo "    Для полного вывода sysmon установи вручную: opkg install$SYSMON_PKGS"
  fi
else
  echo "[*] Утилиты sysmon уже установлены."
fi


# --- Функции ---

is_port_in_use() {
  PORT_CHECK="$1"
  if command -v netstat >/dev/null 2>&1; then
    netstat -tln 2>/dev/null | awk '{print $4}' | grep -q ":${PORT_CHECK}$"
  else
    # Если netstat недоступен, считаем, что порт свободен
    return 1
  fi
}

backup_config_file() {
  SRC="$1"
  NAME="$(basename "$SRC")"

  if [ ! -f "$SRC" ]; then
    echo "[*] Файл $SRC не найден, пропускаю бэкап."
    return 0
  fi

  mkdir -p "$BACKUP_DIR"

  if command -v date >/dev/null 2>&1; then
    TS="$(date +%Y%m%d-%H%M%S 2>/dev/null || date 2>/dev/null || echo "no-date")"
  else
    TS="no-date"
  fi

  DEST="$BACKUP_DIR/${NAME}.auto-backup-${TS}"
  cp "$SRC" "$DEST"
  echo "[*] Создан бэкап: $SRC -> $DEST"
  echo "[backup] $SRC -> $DEST" >> "$LOG_DIR/xkeen-ui.log"
}

migrate_legacy_jsonc_files() {
  # Best-effort миграция legacy *.jsonc из XRAY_CONFIG_DIR -> JSONC_DIR.
  # Основная миграция также запускается при старте приложения, но здесь делаем
  # это заранее, чтобы не оставлять *.jsonc в -confdir Xray.

  if [ ! -d "$XRAY_CONFIG_DIR" ]; then
    return 0
  fi

  # Создаём JSONC_DIR (может быть переопределён через XKEEN_XRAY_JSONC_DIR)
  mkdir -p "$JSONC_DIR" 2>/dev/null || true

  # Проверяем, есть ли что переносить
  if ! find "$XRAY_CONFIG_DIR" -maxdepth 1 -type f -name '*.jsonc' 2>/dev/null | grep -q .; then
    return 0
  fi

  echo "[*] Найдены legacy *.jsonc в $XRAY_CONFIG_DIR — переношу в $JSONC_DIR..."

  MOVED=0
  ARCHIVED=0

  for src in "$XRAY_CONFIG_DIR"/*.jsonc; do
    [ -f "$src" ] || continue
    base="$(basename "$src")"
    dest="$JSONC_DIR/$base"

    TS="$(date +%Y%m%d-%H%M%S 2>/dev/null || echo no-date)"

    if [ -f "$dest" ]; then
      SRC_TS="$(stat -c %Y "$src" 2>/dev/null || stat -f %m "$src" 2>/dev/null || echo 0)"
      DST_TS="$(stat -c %Y "$dest" 2>/dev/null || stat -f %m "$dest" 2>/dev/null || echo 0)"

      if [ "$SRC_TS" -gt "$DST_TS" ]; then
        # src новее — делаем dest old и переносим src как основной
        mv "$dest" "$dest.old-$TS" 2>/dev/null || {
          cp "$dest" "$dest.old-$TS" 2>/dev/null || true
          rm -f "$dest" 2>/dev/null || true
        }
        mv "$src" "$dest" 2>/dev/null || {
          cp "$src" "$dest" 2>/dev/null || true
          rm -f "$src" 2>/dev/null || true
        }
        MOVED=$((MOVED + 1))
      else
        # dest новее — сохраняем src как old в JSONC_DIR
        mv "$src" "$dest.old-$TS" 2>/dev/null || {
          cp "$src" "$dest.old-$TS" 2>/dev/null || true
          rm -f "$src" 2>/dev/null || true
        }
        ARCHIVED=$((ARCHIVED + 1))
      fi
    else
      mv "$src" "$dest" 2>/dev/null || {
        cp "$src" "$dest" 2>/dev/null || true
        rm -f "$src" 2>/dev/null || true
      }
      MOVED=$((MOVED + 1))
    fi
  done

  echo "[*] JSONC миграция (install): перемещено=$MOVED, архивировано=$ARCHIVED."
  echo "[install] JSONC миграция: moved=$MOVED archived=$ARCHIVED jsonc_dir=$JSONC_DIR" >> "$LOG_DIR/xkeen-ui.log"

  # Если что-то осталось (например, из-за прав) — предупредим.
  if find "$XRAY_CONFIG_DIR" -maxdepth 1 -type f -name '*.jsonc' 2>/dev/null | grep -q .; then
    echo "[!] Внимание: в $XRAY_CONFIG_DIR всё ещё есть *.jsonc. Проверь права/перенеси вручную."
  fi
}

# --- Определяем существующую установку и её порт ---

cleanup_frontend_build_dir() {
  BUILD_DIR="$1"
  [ -n "$BUILD_DIR" ] || return 0
  [ -d "$BUILD_DIR" ] || return 0

  BRIDGE_MANIFEST="$BUILD_DIR/.vite/manifest.json"
  RAW_MANIFEST="$BUILD_DIR/.vite/manifest.build.json"

  if [ ! -f "$BRIDGE_MANIFEST" ] && [ ! -f "$RAW_MANIFEST" ]; then
    echo "[*] frontend-build cleanup: manifest files not found in $BUILD_DIR, skip."
    return 0
  fi

  echo "[*] frontend-build cleanup: pruning stale generated files in $BUILD_DIR..."

  CLEANUP_OUTPUT="$(
    FRONTEND_BUILD_DIR="$BUILD_DIR" \
    FRONTEND_BUILD_BRIDGE_MANIFEST="$BRIDGE_MANIFEST" \
    FRONTEND_BUILD_RAW_MANIFEST="$RAW_MANIFEST" \
    "$PYTHON_BIN" - <<'PY'
import json
from pathlib import Path
import os

build_dir = Path(os.environ.get("FRONTEND_BUILD_DIR", "")).resolve()
bridge_manifest = Path(os.environ.get("FRONTEND_BUILD_BRIDGE_MANIFEST", ""))
raw_manifest = Path(os.environ.get("FRONTEND_BUILD_RAW_MANIFEST", ""))


def normalize_rel(value):
    text = str(value or "").strip().replace("\\", "/").lstrip("/")
    return text or None


def keep_rel(keep, value):
    rel = normalize_rel(value)
    if rel:
        keep.add(rel)


def load_manifest(path, keep, errors):
    if not path.is_file():
        return False
    try:
        rel = path.resolve().relative_to(build_dir).as_posix()
        keep.add(rel)
    except Exception:
        pass
    try:
        with path.open("r", encoding="utf-8") as fh:
            payload = json.load(fh)
    except Exception as exc:
        errors.append(f"{path.name}: {exc}")
        return False
    if not isinstance(payload, dict):
        errors.append(f"{path.name}: root is not a JSON object")
        return False
    for item in payload.values():
        if not isinstance(item, dict):
            continue
        keep_rel(keep, item.get("file"))
        for key in ("imports", "dynamicImports", "css", "assets"):
            value = item.get(key)
            if isinstance(value, list):
                for entry in value:
                    keep_rel(keep, entry)
    return True


if not build_dir.exists() or not build_dir.is_dir():
    print("skip:build_dir_missing")
    raise SystemExit(0)

keep = set()
errors = []
loaded_any = False

for wrapper in build_dir.glob("assets/*-bridge.js"):
    try:
        keep.add(wrapper.relative_to(build_dir).as_posix())
    except Exception:
        pass

for manifest in (bridge_manifest, raw_manifest):
    if load_manifest(manifest, keep, errors):
        loaded_any = True

if not loaded_any:
    print("skip:no_valid_manifest")
    if errors:
        print("errors=" + " | ".join(errors[:10]))
    raise SystemExit(0)

deleted = []

for path in sorted(build_dir.rglob("*"), key=lambda p: len(p.parts), reverse=True):
    try:
        if path.is_dir():
            continue
        rel = path.relative_to(build_dir).as_posix()
        if rel in keep:
            continue
        path.unlink()
        deleted.append(rel)
    except Exception as exc:
        errors.append(f"{path}: {exc}")

for path in sorted(build_dir.rglob("*"), key=lambda p: len(p.parts), reverse=True):
    try:
        if path.is_dir() and path != build_dir:
            try:
                next(path.iterdir())
            except StopIteration:
                path.rmdir()
    except Exception:
        pass

print(f"kept={len(keep)} deleted={len(deleted)}")
if deleted:
    print("deleted_list=" + ",".join(deleted[:20]))
if errors:
    print("errors=" + " | ".join(errors[:10]))
PY
  )"

  CLEANUP_STATUS=$?
  if [ "$CLEANUP_STATUS" -ne 0 ]; then
    echo "[!] frontend-build cleanup failed for $BUILD_DIR (exit $CLEANUP_STATUS). Keeping files as-is."
    return 0
  fi

  if [ -n "$CLEANUP_OUTPUT" ]; then
    echo "$CLEANUP_OUTPUT" | while IFS= read -r line; do
      [ -n "$line" ] || continue
      echo "[*] frontend-build cleanup: $line"
    done
  fi
}

extract_env_numeric_field() {
  # extract export KEY='1234' / export KEY=1234 from devtools.env-like files
  _field="$1"
  _file="$2"
  [ -f "$_file" ] || return 0
  grep -E "^[[:space:]]*export[[:space:]]+${_field}=['\"]?[0-9]+['\"]?[[:space:]]*$" "$_file" 2>/dev/null \
    | tail -n 1 \
    | sed -E "s/^[[:space:]]*export[[:space:]]+${_field}=['\"]?([0-9]+)['\"]?[[:space:]]*$/\\1/" \
    || true
}

extract_run_server_port() {
  _file="$1"
  [ -f "$_file" ] || return 0
  "$PYTHON_BIN" - "$_file" <<'PY'
import re
import sys
from pathlib import Path

path = sys.argv[1]
try:
    text = Path(path).read_text(encoding="utf-8", errors="replace")
except Exception:
    raise SystemExit(0)

patterns = [
    r'XKEEN_UI_PORT["\']\)\s*or\s*["\']([0-9]{2,5})["\']',
    r'XKEEN_UI_PORT["\']\)\s*or\s*([0-9]{2,5})',
    r'"0\.0\.0\.0",\s*([0-9]{2,5})',
    r'app\.run\([^)]*port\s*=\s*([0-9]{2,5})',
]

for pattern in patterns:
    match = re.search(pattern, text, flags=re.MULTILINE)
    if not match:
        continue
    try:
        port = int(match.group(1))
    except Exception:
        continue
    if 1 <= port <= 65535:
        print(port)
        raise SystemExit(0)
PY
}

write_env_numeric_field() {
  _file="$1"
  _field="$2"
  _value="$3"
  [ -n "$_field" ] || return 0
  [ -n "$_value" ] || return 0
  "$PYTHON_BIN" - "$_file" "$_field" "$_value" <<'PY'
import os
import re
import sys

path = sys.argv[1]
key = sys.argv[2]
value = sys.argv[3]

try:
    port = int(str(value).strip())
except Exception:
    raise SystemExit(0)

if port < 1 or port > 65535:
    raise SystemExit(0)

lines = []
if os.path.isfile(path):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            lines = fh.readlines()
    except Exception:
        lines = []

pattern = re.compile(r"^[ \t]*export[ \t]+" + re.escape(key) + r"=.*$")
entry = f"export {key}='{port}'\n"
updated = False
out = []
for line in lines:
    if pattern.match(line):
        if not updated:
            out.append(entry)
            updated = True
        continue
    out.append(line)

if not updated:
    if out and not out[-1].endswith("\n"):
        out[-1] += "\n"
    if out and out[-1].strip():
        out.append("\n")
    out.append(entry)

os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
tmp = path + ".tmp"
with open(tmp, "w", encoding="utf-8") as fh:
    fh.writelines(out)
os.replace(tmp, path)
PY
}

EXISTING_APP="$UI_DIR/app.py"
EXISTING_RUN="$UI_DIR/run_server.py"
EXISTING_ENV_FILE="$UI_DIR/devtools.env"
EXISTING_PORT=""
FIRST_INSTALL="yes"

if [ -f "$EXISTING_APP" ] || [ -f "$EXISTING_RUN" ] || [ -f "$EXISTING_ENV_FILE" ]; then
  FIRST_INSTALL="no"
fi

# 1) Пробуем вытащить порт из run_server.py (WSGIServer(("0.0.0.0", PORT ...))
if [ -z "$EXISTING_PORT" ] && [ -n "${XKEEN_UI_PORT:-}" ]; then
  EXISTING_PORT="$XKEEN_UI_PORT"
fi

if [ -z "$EXISTING_PORT" ] && [ -f "$EXISTING_ENV_FILE" ]; then
  EXISTING_PORT="$(extract_env_numeric_field "XKEEN_UI_PORT" "$EXISTING_ENV_FILE")"
fi

if [ -z "$EXISTING_PORT" ] && [ -f "$EXISTING_RUN" ]; then
  EXISTING_PORT="$(extract_run_server_port "$EXISTING_RUN")"
fi

if [ -z "$EXISTING_PORT" ] && [ -f "$EXISTING_RUN" ]; then
  EXISTING_PORT=$(grep -E '"0\.0\.0\.0",[[:space:]]*[0-9]+' "$EXISTING_RUN" 2>/dev/null | \
    sed -E 's/.*"0\.0\.0\.0",[[:space:]]*([0-9]+).*/\1/' | tail -n 1 || true)
fi

# 2) Если не нашлось, пробуем старый способ — из app.py (app.run(... port=PORT ...))
if [ -z "$EXISTING_PORT" ] && [ -f "$EXISTING_APP" ]; then
  EXISTING_PORT=$(grep -E 'app.run\(.*port *= *[0-9]+' "$EXISTING_APP" 2>/dev/null | \
    sed -E 's/.*port *= *([0-9]+).*/\1/' | tail -n 1 || true)
fi

if [ -n "$EXISTING_PORT" ]; then
  PANEL_PORT="$EXISTING_PORT"
  USE_EXISTING=1

  # Если порт занят, проверяем, не нашей ли панелью (чтобы при переустановке не менять порт)
  if is_port_in_use "$PANEL_PORT"; then
    OUR_PANEL=0
    PID_FILE="$RUN_DIR/xkeen-ui.pid"

    # 1) Проверка по PID-файлу
    if [ -f "$PID_FILE" ]; then
      PID="$(cat "$PID_FILE" 2>/dev/null || true)"
      if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
        if [ -r "/proc/$PID/cmdline" ]; then
          CMDLINE="$(tr '\000' ' ' < "/proc/$PID/cmdline" 2>/dev/null || true)"
          echo "$CMDLINE" | grep -Eq "$UI_DIR/run_server.py|$UI_DIR/app.py" && OUR_PANEL=1
        else
          # Если /proc недоступен, считаем, что PID относится к нашей панели
          OUR_PANEL=1
        fi
      fi
    fi

    # 2) Страховка: поиск процесса по командной строке (если PID-файл отсутствует/некорректен)
    if [ "$OUR_PANEL" -eq 0 ] && command -v ps >/dev/null 2>&1; then
      ps w 2>/dev/null | grep -v grep | grep -Eq "$UI_DIR/run_server.py|$UI_DIR/app.py" && OUR_PANEL=1
    fi

    if [ "$OUR_PANEL" -ne 1 ]; then
      echo "[*] Обнаружена существующая установка, но порт $PANEL_PORT занят другим процессом. Выбираю новый порт..."
      USE_EXISTING=0
    fi
  fi

  if [ "$USE_EXISTING" -eq 1 ]; then
    echo "[*] Обнаружена существующая установка, сохраняю порт: $PANEL_PORT"
    echo "[install] Текущий порт панели: $PANEL_PORT" >> "$LOG_DIR/xkeen-ui.log"
  fi
fi

if [ -z "$EXISTING_PORT" ] || [ "${USE_EXISTING:-0}" -eq 0 ]; then
  # Выбираем порт заново (первая установка или не удалось прочитать порт / порт занят другим сервисом)
  PANEL_PORT="$DEFAULT_PORT"
  if is_port_in_use "$PANEL_PORT"; then
    echo "[*] Порт $PANEL_PORT уже занят, пробую $ALT_PORT..."
    PANEL_PORT="$ALT_PORT"
    if is_port_in_use "$PANEL_PORT"; then
      echo "[*] Порт $ALT_PORT тоже занят, ищу свободный порт в диапазоне 8100–8199..."
      PANEL_PORT=""
      PORT_CANDIDATE=8100
      while [ "$PORT_CANDIDATE" -le 8199 ]; do
        if ! is_port_in_use "$PORT_CANDIDATE"; then
          PANEL_PORT="$PORT_CANDIDATE"
          break
        fi
        PORT_CANDIDATE=$((PORT_CANDIDATE + 1))
      done

      if [ -z "$PANEL_PORT" ]; then
        echo "[!] Не удалось найти свободный порт в диапазоне 8100–8199."
        exit 1
      fi
    fi
  fi
  echo "[*] Выбран порт панели: $PANEL_PORT"
  echo "[install] Текущий порт панели: $PANEL_PORT" >> "$LOG_DIR/xkeen-ui.log"
fi

# --- Бэкапы Xray на самой первой установке ---

echo "[*] Сохраняю порт панели в $EXISTING_ENV_FILE (XKEEN_UI_PORT=$PANEL_PORT)..."
write_env_numeric_field "$EXISTING_ENV_FILE" "XKEEN_UI_PORT" "$PANEL_PORT"

if [ "$FIRST_INSTALL" = "yes" ]; then
  echo "[*] Первая установка: создаю бэкапы конфигов Xray в $BACKUP_DIR..."
  backup_config_file "$ROUTING_FILE"
  backup_config_file "$INBOUNDS_FILE"
  backup_config_file "$OUTBOUNDS_FILE"
else
  echo "[*] Это не первая установка, автоматические бэкапы конфигов пропущены."
fi

# --- Копирование файлов панели ---

echo "[*] Создаю директории..."
mkdir -p "$UI_DIR" "$INIT_DIR" "$LOG_DIR" "$RUN_DIR" "$BACKUP_DIR" "$JSONC_DIR"

# Этап 7 (install/upgrade): гарантируем наличие отдельного каталога для JSONC
# и пытаемся убрать legacy *.jsonc из XRAY_CONFIG_DIR.
migrate_legacy_jsonc_files || true

echo "[*] Копирую файлы панели в $UI_DIR..."
if command -v rsync >/dev/null 2>&1; then
  rsync -a "$SRC_DIR"/ "$UI_DIR"/ --exclude "install.sh"
else
  cp -r "$SRC_DIR"/* "$UI_DIR"/ 2>/dev/null || true
  cp -r "$SRC_DIR"/.[!.]* "$UI_DIR"/ 2>/dev/null || true
  rm -f "$UI_DIR/install.sh"
fi

# --- BUILD.json (версия/сборка) ---
#
# Небольшой файл с метаданными сборки, который отображается в DevTools.
# Используется также для будущего self-update из GitHub.
#
# Параметры можно передать через окружение (например, при сборке релиза):
#   XKEEN_UI_UPDATE_REPO, XKEEN_UI_UPDATE_CHANNEL, XKEEN_UI_VERSION, XKEEN_UI_COMMIT

cleanup_frontend_build_dir "$UI_DIR/static/frontend-build"

json_escape() {
  # minimal JSON string escape
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

extract_json_field() {
  # extract "field": "value" from a small JSON file without jq
  _field="$1"
  _file="$2"
  [ -f "$_file" ] || return 0
  grep -o "\"$_field\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" "$_file" 2>/dev/null \
    | head -n 1 \
    | sed -E 's/.*:[[:space:]]*\"([^\"]*)\".*/\1/' \
    || true
}

OLD_BUILD="$UI_DIR/BUILD.json"
OLD_VERSION=""
OLD_COMMIT=""
OLD_REPO=""
OLD_CHANNEL=""
if [ -f "$OLD_BUILD" ]; then
  OLD_VERSION="$(extract_json_field version "$OLD_BUILD")"
  OLD_COMMIT="$(extract_json_field commit "$OLD_BUILD")"
  OLD_REPO="$(extract_json_field repo "$OLD_BUILD")"
  OLD_CHANNEL="$(extract_json_field channel "$OLD_BUILD")"
fi

BUILD_REPO="${XKEEN_UI_UPDATE_REPO:-${OLD_REPO:-umarcheh001/Xkeen-UI}}"
BUILD_CHANNEL="${XKEEN_UI_UPDATE_CHANNEL:-${OLD_CHANNEL:-stable}}"
BUILD_VERSION="${XKEEN_UI_VERSION:-$OLD_VERSION}"
BUILD_COMMIT="${XKEEN_UI_COMMIT:-$OLD_COMMIT}"
BUILD_UTC="$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date +"%Y-%m-%dT%H:%M:%SZ")"

TMP_BUILD="$UI_DIR/.BUILD.json.tmp"
{
  echo "{" 
  echo "  \"repo\": \"$(json_escape "$BUILD_REPO")\","
  echo "  \"channel\": \"$(json_escape "$BUILD_CHANNEL")\","
  if [ -n "$BUILD_VERSION" ]; then
    echo "  \"version\": \"$(json_escape "$BUILD_VERSION")\","
  else
    echo "  \"version\": null,"
  fi
  if [ -n "$BUILD_COMMIT" ]; then
    echo "  \"commit\": \"$(json_escape "$BUILD_COMMIT")\","
  else
    echo "  \"commit\": null,"
  fi
  echo "  \"built_utc\": \"$(json_escape "$BUILD_UTC")\","
  echo "  \"source\": \"install.sh\","
  echo "  \"artifact\": null"
  echo "}"
} > "$TMP_BUILD" 2>/dev/null || true

if [ -s "$TMP_BUILD" ]; then
  mv -f "$TMP_BUILD" "$UI_DIR/BUILD.json" 2>/dev/null || true
fi

echo "[*] Проверяю наличие локальных файлов xterm для веб-терминала..."
XTERM_DIR="$UI_DIR/static/xterm"
XTERM_MISSING=0

for f in xterm.js xterm-addon-fit.js xterm.css; do
  if [ ! -f "$XTERM_DIR/$f" ]; then
    echo "[!] Не найден файл: $XTERM_DIR/$f"
    XTERM_MISSING=1
  fi
done

if [ "$XTERM_MISSING" -ne 0 ]; then
  echo "[!] Критическая ошибка: отсутствуют один или несколько файлов xterm для терминала в веб-панели."
  echo "    Убедись, что архив с панелью содержит каталог static/xterm"
  echo "    с файлами xterm.js, xterm-addon-fit.js и xterm.css, и запусти установку снова."
  exit 1
fi

# --- Sysmon wrapper ---
# Make `sysmon` available inside interactive PTY shell sessions.
SYS_MON_SRC="$UI_DIR/tools/sysmon_keenetic.sh"
SYS_MON_BIN="/opt/bin/sysmon"

if [ -f "$SYS_MON_SRC" ]; then
  echo "[*] Устанавливаю sysmon в $SYS_MON_BIN..."
  cat > "$SYS_MON_BIN" <<'EOF'
#!/bin/sh
# sysmon — XKeen router monitor
SCRIPT="/opt/etc/xkeen-ui/tools/sysmon_keenetic.sh"
if [ ! -f "$SCRIPT" ]; then
  echo "sysmon: script not found: $SCRIPT" >&2
  exit 127
fi
exec sh "$SCRIPT" "$@"
EOF
  chmod +x "$SYS_MON_BIN" 2>/dev/null || true
  chmod +x "$SYS_MON_SRC" 2>/dev/null || true
else
  echo "[*] sysmon: скрипт не найден в $SYS_MON_SRC (пропуск)"
fi

# --- Entware backup wrapper ---
ENTWARE_BACKUP_SRC="$UI_DIR/tools/entware_backup.sh"
ENTWARE_BACKUP_BIN="/opt/bin/entware-backup"

if [ -f "$ENTWARE_BACKUP_SRC" ]; then
  echo "[*] Устанавливаю entware-backup в $ENTWARE_BACKUP_BIN..."
  cat > "$ENTWARE_BACKUP_BIN" <<'EOF'
#!/bin/sh
SCRIPT="/opt/etc/xkeen-ui/tools/entware_backup.sh"
if [ ! -f "$SCRIPT" ]; then
  echo "entware-backup: script not found: $SCRIPT" >&2
  exit 127
fi
exec sh "$SCRIPT" "$@"
EOF
  chmod +x "$ENTWARE_BACKUP_BIN" 2>/dev/null || true
  chmod +x "$ENTWARE_BACKUP_SRC" 2>/dev/null || true
else
  echo "[*] entware-backup: скрипт не найден в $ENTWARE_BACKUP_SRC (пропуск)"
fi

# --- Storage dashboard wrapper ---
_STORAGE_DASH_SRC="$UI_DIR/tools/storage_dashboard.sh"
_STORAGE_DASH_BIN="/opt/bin/storage-dashboard"

if [ -f "$_STORAGE_DASH_SRC" ]; then
  echo "[*] Устанавливаю storage-dashboard в $_STORAGE_DASH_BIN..."
  cat > "$_STORAGE_DASH_BIN" <<'EOF'
#!/bin/sh
SCRIPT="/opt/etc/xkeen-ui/tools/storage_dashboard.sh"
if [ ! -f "$SCRIPT" ]; then
  echo "storage-dashboard: script not found: $SCRIPT" >&2
  exit 127
fi
exec sh "$SCRIPT" "$@"
EOF
  chmod +x "$_STORAGE_DASH_BIN" 2>/dev/null || true
  chmod +x "$_STORAGE_DASH_SRC" 2>/dev/null || true
else
  echo "[*] storage-dashboard: скрипт не найден в $_STORAGE_DASH_SRC (пропуск)"
fi

# --- Cleanup removed legacy io-monitor utility ---
_IO_MON_SRC="$UI_DIR/tools/io_monitor.sh"
_IO_MON_BIN="/opt/bin/io-monitor"

if [ -f "$_IO_MON_BIN" ] || [ -f "$_IO_MON_SRC" ]; then
  echo "[*] Удаляю legacy io-monitor..."
  rm -f "$_IO_MON_BIN" "$_IO_MON_SRC" 2>/dev/null || true
fi

# --- Device lock detector wrapper ---
_DEV_LOCK_SRC="$UI_DIR/tools/device_lock_detector.sh"
_DEV_LOCK_BIN="/opt/bin/device-locks"

if [ -f "$_DEV_LOCK_SRC" ]; then
  echo "[*] Устанавливаю device-locks в $_DEV_LOCK_BIN..."
  cat > "$_DEV_LOCK_BIN" <<'EOF'
#!/bin/sh
SCRIPT="/opt/etc/xkeen-ui/tools/device_lock_detector.sh"
if [ ! -f "$SCRIPT" ]; then
  echo "device-locks: script not found: $SCRIPT" >&2
  exit 127
fi
exec sh "$SCRIPT" "$@"
EOF
  chmod +x "$_DEV_LOCK_BIN" 2>/dev/null || true
  chmod +x "$_DEV_LOCK_SRC" 2>/dev/null || true
else
  echo "[*] device-locks: скрипт не найден в $_DEV_LOCK_SRC (пропуск)"
fi

# --- Memory check wrapper ---
_MEM_CHECK_SRC="$UI_DIR/tools/memory_check.sh"
_MEM_CHECK_BIN="/opt/bin/memory-check"

if [ -f "$_MEM_CHECK_SRC" ]; then
  echo "[*] Устанавливаю memory-check в $_MEM_CHECK_BIN..."
  cat > "$_MEM_CHECK_BIN" <<'EOF'
#!/bin/sh
SCRIPT="/opt/etc/xkeen-ui/tools/memory_check.sh"
if [ ! -f "$SCRIPT" ]; then
  echo "memory-check: script not found: $SCRIPT" >&2
  exit 127
fi
exec sh "$SCRIPT" "$@"
EOF
  chmod +x "$_MEM_CHECK_BIN" 2>/dev/null || true
  chmod +x "$_MEM_CHECK_SRC" 2>/dev/null || true
else
  echo "[*] memory-check: скрипт не найден в $_MEM_CHECK_SRC (пропуск)"
fi

# --- Version check wrapper ---
_VER_CHECK_SRC="$UI_DIR/tools/version_check.sh"
_VER_CHECK_BIN="/opt/bin/version-check"

if [ -f "$_VER_CHECK_SRC" ]; then
  echo "[*] Устанавливаю version-check в $_VER_CHECK_BIN..."
  cat > "$_VER_CHECK_BIN" <<'EOF'
#!/bin/sh
SCRIPT="/opt/etc/xkeen-ui/tools/version_check.sh"
if [ ! -f "$SCRIPT" ]; then
  echo "version-check: script not found: $SCRIPT" >&2
  exit 127
fi
exec sh "$SCRIPT" "$@"
EOF
  chmod +x "$_VER_CHECK_BIN" 2>/dev/null || true
  chmod +x "$_VER_CHECK_SRC" 2>/dev/null || true
else
  echo "[*] version-check: скрипт не найден в $_VER_CHECK_SRC (пропуск)"
fi

# --- Backup monitor wrapper ---
_BKUP_MON_SRC="$UI_DIR/tools/backup_monitor.sh"
_BKUP_MON_BIN="/opt/bin/backup-monitor"

if [ -f "$_BKUP_MON_SRC" ]; then
  echo "[*] Устанавливаю backup-monitor в $_BKUP_MON_BIN..."
  cat > "$_BKUP_MON_BIN" <<'EOF'
#!/bin/sh
SCRIPT="/opt/etc/xkeen-ui/tools/backup_monitor.sh"
if [ ! -f "$SCRIPT" ]; then
  echo "backup-monitor: script not found: $SCRIPT" >&2
  exit 127
fi
exec sh "$SCRIPT" "$@"
EOF
  chmod +x "$_BKUP_MON_BIN" 2>/dev/null || true
  chmod +x "$_BKUP_MON_SRC" 2>/dev/null || true
else
  echo "[*] backup-monitor: скрипт не найден в $_BKUP_MON_SRC (пропуск)"
fi


cleanup_legacy_xray_templates() {
  # Некоторые версии xkeen/xray могут подхватывать *.jsonc из /opt/etc/xray (recursive scan)
  # и из-за этого зависать/не стартовать. Начиная с этого релиза шаблоны живут в $UI_DIR/templates/*.
  # Поэтому аккуратно убираем ТОЛЬКО наши встроенные шаблоны из /opt/etc/xray/templates/*.

  LEGACY_ROOT="/opt/etc/xray/templates"
  [ -d "$LEGACY_ROOT" ] || return 0

  # remove built-in routing templates by name
  for f in \
    "$LEGACY_ROOT/routing/05_routing_base.jsonc" \
    "$LEGACY_ROOT/routing/05_routing_zkeen_only.jsonc" \
    "$LEGACY_ROOT/routing/05_routing_all_proxy_except_ru.jsonc" \
    "$LEGACY_ROOT/routing/.xkeen_seeded" \
    "$LEGACY_ROOT/observatory/07_observatory_base.jsonc" \
    "$LEGACY_ROOT/observatory/.xkeen_seeded" \
    ; do
    [ -f "$f" ] && rm -f "$f" 2>/dev/null || true
  done

  # Try to prune empty dirs (best-effort)
  rmdir "$LEGACY_ROOT/routing" 2>/dev/null || true
  rmdir "$LEGACY_ROOT/observatory" 2>/dev/null || true
  rmdir "$LEGACY_ROOT" 2>/dev/null || true
}

# Убираем legacy шаблоны из /opt/etc/xray/templates (если они были установлены ранее)
cleanup_legacy_xray_templates


# --- Шаблоны Mihomo ---

if [ -d "$SRC_MIHOMO_TEMPLATES" ]; then
  echo "[*] Устанавливаю шаблон Mihomo в $MIHOMO_TEMPLATES_DIR..."
  mkdir -p "$MIHOMO_TEMPLATES_DIR"

  for old in config_2.yaml umarcheh001.yaml; do
    if [ -f "$MIHOMO_TEMPLATES_DIR/$old" ]; then
      rm -f "$MIHOMO_TEMPLATES_DIR/$old" && echo "[*] Удалён старый шаблон $old"
    fi
  done

  SRC_CUSTOM="$SRC_MIHOMO_TEMPLATES/custom.yaml"
  if [ -f "$SRC_CUSTOM" ]; then
    cp -f "$SRC_CUSTOM" "$MIHOMO_TEMPLATES_DIR/custom.yaml"
    echo "[*] Установлен шаблон custom.yaml в $MIHOMO_TEMPLATES_DIR"
  else
    echo "[!] Не найден шаблон custom.yaml в $SRC_MIHOMO_TEMPLATES"
  fi
  SRC_ZKEEN="$SRC_MIHOMO_TEMPLATES/zkeen.yaml"
  if [ -f "$SRC_ZKEEN" ]; then
    cp -f "$SRC_ZKEEN" "$MIHOMO_TEMPLATES_DIR/zkeen.yaml"
    echo "[*] Установлен шаблон zkeen.yaml в $MIHOMO_TEMPLATES_DIR"
  else
    echo "[!] Не найден шаблон zkeen.yaml в $SRC_MIHOMO_TEMPLATES"
  fi

  # HWID subscription template (из внешнего проекта)
  SRC_HWID_TPL="$SRC_MIHOMO_TEMPLATES/hwid_subscription_template.yaml"
  if [ -f "$SRC_HWID_TPL" ]; then
    cp -f "$SRC_HWID_TPL" "$MIHOMO_TEMPLATES_DIR/hwid_subscription_template.yaml"
    echo "[*] Установлен шаблон hwid_subscription_template.yaml в $MIHOMO_TEMPLATES_DIR"
  fi
fi

# --- Шаблоны Xray (Routing) ---

if [ -d "$SRC_XRAY_ROUTING_TEMPLATES" ]; then
  echo "[*] Устанавливаю шаблоны роутинга Xray в $XRAY_ROUTING_TEMPLATES_DIR..."
  mkdir -p "$XRAY_ROUTING_TEMPLATES_DIR"

  # Не перезаписываем существующие файлы пользователя.
  for f in "$SRC_XRAY_ROUTING_TEMPLATES"/*.json "$SRC_XRAY_ROUTING_TEMPLATES"/*.jsonc; do
    [ -f "$f" ] || continue
    base="$(basename "$f")"
    if [ ! -f "$XRAY_ROUTING_TEMPLATES_DIR/$base" ]; then
      cp -f "$f" "$XRAY_ROUTING_TEMPLATES_DIR/$base"
      echo "[*] + $base"
    fi
  done
else
  echo "[*] Шаблоны роутинга Xray не найдены в архиве (пропуск)"
fi

# --- Шаблоны Xray (Observatory) ---

if [ -d "$SRC_XRAY_OBSERVATORY_TEMPLATES" ]; then
  echo "[*] Устанавливаю шаблоны observatory Xray в $XRAY_OBSERVATORY_TEMPLATES_DIR..."
  mkdir -p "$XRAY_OBSERVATORY_TEMPLATES_DIR"

  # Не перезаписываем существующие файлы пользователя.
  for f in "$SRC_XRAY_OBSERVATORY_TEMPLATES"/*.json "$SRC_XRAY_OBSERVATORY_TEMPLATES"/*.jsonc; do
    [ -f "$f" ] || continue
    base="$(basename "$f")"
    if [ ! -f "$XRAY_OBSERVATORY_TEMPLATES_DIR/$base" ]; then
      cp -f "$f" "$XRAY_OBSERVATORY_TEMPLATES_DIR/$base"
      echo "[*] + $base"
    fi
  done
else
  echo "[*] Шаблоны observatory Xray не найдены в архиве (пропуск)"
fi

# --- Compat fix: обеспечить доступность DAT-файлов для Xray (ext:*.dat:...) ---

# В шаблонах/правилах панели часто используется синтаксис ext:<имя>.dat:<список>.
# В этом режиме Xray ищет файл по имени в директории assets (часто рядом с бинарником).
# Панель, в свою очередь, хранит/обновляет DAT по умолчанию в $XRAY_DAT_DIR.
# Чтобы не заставлять пользователя переносить файлы вручную — создаём symlink в $XRAY_BIN_DIR.

if [ -d "$XRAY_DAT_DIR" ] && [ -d "$XRAY_BIN_DIR" ]; then
  echo "[*] Xray DAT: создаю symlink *.dat из $XRAY_DAT_DIR в $XRAY_BIN_DIR (для ext:... )"
  for f in "$XRAY_DAT_DIR"/*.dat; do
    # Resolve symlinks in dat dir so /opt/sbin points to the real file.
    # (BusyBox usually supports `readlink -f`, but keep fallback.)
    src="$f"
    if command -v readlink >/dev/null 2>&1; then
      src="$(readlink -f "$f" 2>/dev/null || echo "$f")"
    fi
    [ -f "$src" ] || continue
    base="$(basename "$f")"
    # Не затираем реальные файлы (на всякий случай), только ссылки.
    if [ -e "$XRAY_BIN_DIR/$base" ] && [ ! -L "$XRAY_BIN_DIR/$base" ]; then
      continue
    fi
    ln -sf "$src" "$XRAY_BIN_DIR/$base" 2>/dev/null || true
  done
fi

# --- Compat fix: удалить отсутствующие geosite-списки из routing (xray) ---

# Некоторые GeoSite датасеты (например v2fly) не содержат отдельных списков типа whatsapp-ads.
# Если такие строки попали в /opt/etc/xray/configs/05_routing*.json, Xray не стартует.
# В старых версиях панели этого списка не было. Исправляем мягко и только точечно.

if [ -n "$ROUTING_FILE" ] && [ -f "$ROUTING_FILE" ] && grep -q 'ext:geosite_v2fly.dat:whatsapp-ads' "$ROUTING_FILE" 2>/dev/null; then
  echo "[*] Compat: удаляю ext:geosite_v2fly.dat:whatsapp-ads из $ROUTING_FILE (иначе Xray не стартует)"
  ROUTING_FILE="$ROUTING_FILE" $PYTHON_BIN - <<'PYFIX' || true
import json, os, sys
path = os.environ.get('ROUTING_FILE')
if not path or not os.path.exists(path):
    sys.exit(0)
try:
    raw = open(path, 'r', encoding='utf-8', errors='replace').read()
    data = json.loads(raw)
except Exception:
    # Если файл не JSON (или с комментариями) — не трогаем
    sys.exit(0)
TARGET = 'ext:geosite_v2fly.dat:whatsapp-ads'
changed = False

def walk(x):
    global changed
    if isinstance(x, list):
        out = []
        for i in x:
            if i == TARGET:
                changed = True
                continue
            out.append(walk(i))
        return out
    if isinstance(x, dict):
        return {k: walk(v) for k, v in x.items()}
    return x

new = walk(data)
if changed:
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(new, f, ensure_ascii=False, indent=2)
        f.write('\n')
    os.replace(tmp, path)
PYFIX
fi

# --- Обновление порта в run_server.py / app.py ---

RUN_SERVER="$UI_DIR/run_server.py"
APP_FILE="$UI_DIR/app.py"

echo "[*] Обновляю порт в run_server.py / app.py..."
UPDATED=0

# run_server.py (текущая версия панели)
if [ -f "$RUN_SERVER" ]; then
  CHANGED_RUN=0

  # Обновляем порт в ("0.0.0.0", PORT) — может быть на новой строке, поэтому ищем просто кортеж
  if grep -q '"0\.0\.0\.0",[[:space:]]*[0-9]\+' "$RUN_SERVER"; then
    if sed -i -E "s/(\"0\.0\.0\.0\",[[:space:]]*)[0-9]+/\1${PANEL_PORT}/g" "$RUN_SERVER"; then
      CHANGED_RUN=1
    fi
  fi

  # Обновляем fallback app.run(... port=PORT) внутри run_server.py (если есть)
  if grep -q 'app\.run' "$RUN_SERVER"; then
    if sed -i -E "s/(app\.run\([^)]*port[[:space:]]*=[[:space:]]*)[0-9]+/\1${PANEL_PORT}/g" "$RUN_SERVER"; then
      CHANGED_RUN=1
    fi
  fi

  if [ "$CHANGED_RUN" -eq 1 ]; then
    echo "[*] Порт в run_server.py обновлён на $PANEL_PORT."
    UPDATED=1
  fi
fi

# app.py (для старых версий, где запуск был через app.run)
if [ -f "$APP_FILE" ] && grep -q 'app\.run' "$APP_FILE"; then
  if sed -i -E "s/(app\.run\([^)]*port[[:space:]]*=[[:space:]]*)[0-9]+/\1${PANEL_PORT}/g" "$APP_FILE"; then
    echo "[*] Порт в app.py обновлён на $PANEL_PORT."
    UPDATED=1
  fi
fi

if [ "$UPDATED" -eq 0 ]; then
  echo "[!] Внимание: не удалось автоматически изменить порт ни в run_server.py, ни в app.py."
  echo "    Порт может остаться по умолчанию, проверь файлы вручную."
fi

# --- Optional: xk-geodat (DAT GeoIP/GeoSite: "Содержимое" и "В routing") ---
if [ -f "$SRC_DIR/scripts/install_xk_geodat.sh" ]; then
  echo "[*] (Опционально) Устанавливаю xk-geodat для DAT GeoIP/GeoSite..."
  sh "$SRC_DIR/scripts/install_xk_geodat.sh" || true
fi

# --- Init-скрипт ---

echo "[*] Создаю init-скрипт $INIT_SCRIPT..."

cat > "$INIT_SCRIPT" << 'EOF'
#!/bin/sh

ENABLED=yes
UI_DIR="/opt/etc/xkeen-ui"
PYTHON_BIN="/opt/bin/python3"
RUN_SERVER="$UI_DIR/run_server.py"
APP_PY="$UI_DIR/app.py"
PANEL_PORT="__XKEEN_UI_PORT__"

LOG_DIR_DEFAULT="/opt/var/log/xkeen-ui"
LOG_DIR="$LOG_DIR_DEFAULT"
STDOUT_LOG="$LOG_DIR/stdout.log"
STDERR_LOG="$LOG_DIR/stderr.log"
PID_FILE="/opt/var/run/xkeen-ui.pid"

audit_boot() {
  # Lightweight diagnostic log so users can debug boot-time autostart failures
  # without re-running install.sh. Survives reboot, no rotation (small file).
  echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> /opt/var/log/xkeen-ui-boot.log 2>/dev/null || true
}

start_service() {
  # Entware's rc.unslung calls S99 scripts very early at boot, before
  # /opt/etc/profile has been sourced for the user shell. Pull it in so
  # PATH/LD_LIBRARY_PATH point at /opt/{bin,sbin,lib} and Python's native
  # extensions can dlopen() Entware libraries.
  [ -f "/opt/etc/profile" ] && . /opt/etc/profile >/dev/null 2>&1 || true
  case ":$PATH:" in
    *":/opt/bin:"*) ;;
    *) PATH="/opt/bin:/opt/sbin:$PATH"; export PATH ;;
  esac

  # Make sure runtime dirs exist before we touch them. /opt/var/run can be
  # missing on a fresh Entware install, which would silently lose the PID
  # file and make every subsequent stop/restart a no-op.
  mkdir -p "/opt/var/run" "/opt/var/log" 2>/dev/null || true

  audit_boot "[start] begin (caller=$(ps -o comm= -p $PPID 2>/dev/null), arg=${1:-start})"

  # USB-mounted /opt sometimes lags the init.d invocation by a few seconds
  # on Keenetic. Wait up to 30s for python3 instead of failing immediately.
  i=0
  while [ ! -x "$PYTHON_BIN" ] && [ "$i" -lt 30 ]; do
    sleep 1
    i=$((i + 1))
  done
  if [ ! -x "$PYTHON_BIN" ]; then
    audit_boot "[start] abort: python3 missing at $PYTHON_BIN after ${i}s"
    echo "python3 не найден по пути $PYTHON_BIN"
    return 1
  fi
  [ "$i" -gt 0 ] && audit_boot "[start] python3 became available after ${i}s wait"

  # Wait for the target script for the same reason.
  TARGET=""
  j=0
  while [ -z "$TARGET" ] && [ "$j" -lt 30 ]; do
    if [ -f "$RUN_SERVER" ]; then
      TARGET="$RUN_SERVER"
    elif [ -f "$APP_PY" ]; then
      TARGET="$APP_PY"
    else
      sleep 1
      j=$((j + 1))
    fi
  done
  if [ -z "$TARGET" ]; then
    audit_boot "[start] abort: neither $RUN_SERVER nor $APP_PY exists after ${j}s"
    echo "Не найден ни run_server.py, ни app.py в $UI_DIR"
    return 1
  fi
  [ "$j" -gt 0 ] && audit_boot "[start] target became available after ${j}s wait"
  audit_boot "[start] target=$TARGET"

  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE" 2>/dev/null)" 2>/dev/null; then
    audit_boot "[start] already running, PID $(cat "$PID_FILE")"
    echo "Сервис уже запущен (PID $(cat "$PID_FILE"))."
    return 0
  fi

  # Stale PID file from a previous boot — clean it up so status/stop work.
  if [ -f "$PID_FILE" ]; then
    audit_boot "[start] removing stale pid file (was $(cat "$PID_FILE" 2>/dev/null))"
    rm -f "$PID_FILE"
  fi

  echo "Запуск Xkeen Web UI..."
  export MIHOMO_ROOT="/opt/etc/mihomo"
  export MIHOMO_VALIDATE_CMD='/opt/sbin/mihomo -t -d {root} -f {config}'
  export PYTHONUNBUFFERED=1

  # Optional env overrides persisted by DevTools
  ENV_FILE_DEFAULT="$UI_DIR/devtools.env"
  ENV_FILE="${XKEEN_UI_ENV_FILE:-$ENV_FILE_DEFAULT}"
  if [ -f "$ENV_FILE" ]; then
    # shellcheck disable=SC1090
    . "$ENV_FILE"
  fi

  # Keep the selected installer port stable across updates even when
  # run_server.py reads it from env instead of a hard-coded literal.
  export XKEEN_UI_PORT="${XKEEN_UI_PORT:-$PANEL_PORT}"

  # Re-resolve log dir after env overrides (DevTools can set XKEEN_LOG_DIR).
  # Fall back to /tmp if the chosen dir is not writable — otherwise the
  # nohup redirect below silently drops both stdout and stderr.
  LOG_DIR="${XKEEN_LOG_DIR:-$LOG_DIR_DEFAULT}"
  if ! mkdir -p "$LOG_DIR" 2>/dev/null; then
    audit_boot "[start] mkdir $LOG_DIR failed, falling back to /tmp"
    LOG_DIR="/tmp"
  fi
  STDOUT_LOG="$LOG_DIR/stdout.log"
  STDERR_LOG="$LOG_DIR/stderr.log"

  if ! command -v nohup >/dev/null 2>&1; then
    audit_boot "[start] nohup missing, attempting opkg install coreutils-nohup"
    echo "Команда nohup не найдена. Пытаюсь установить пакет coreutils-nohup..."
    if command -v opkg >/dev/null 2>&1; then
      opkg update || true
      if ! opkg install coreutils-nohup; then
        audit_boot "[start] opkg install coreutils-nohup failed"
        echo "Не удалось установить coreutils-nohup автоматически."
        echo "Установите пакет вручную: opkg install coreutils-nohup"
        return 1
      fi
      if ! command -v nohup >/dev/null 2>&1; then
        audit_boot "[start] nohup still missing after opkg install"
        echo "Пакет coreutils-nohup установлен, но команда nohup по-прежнему недоступна."
        echo "Проверьте PATH или установите пакет вручную: opkg install coreutils-nohup"
        return 1
      fi
    else
      audit_boot "[start] nohup missing and opkg unavailable"
      echo "Команда nohup не найдена, и opkg недоступен для автоустановки."
      echo "Установите пакет вручную: opkg install coreutils-nohup"
      return 1
    fi
  fi

  audit_boot "[start] spawn: $PYTHON_BIN $TARGET (port=$XKEEN_UI_PORT, log=$LOG_DIR)"
  # `< /dev/null` keeps Python detached from the controlling tty so it
  # survives even when rc.unslung's stdin is closed mid-boot.
  nohup "$PYTHON_BIN" "$TARGET" >> "$STDOUT_LOG" 2>> "$STDERR_LOG" < /dev/null &
  CHILD_PID=$!
  echo "$CHILD_PID" > "$PID_FILE" 2>/dev/null || true

  # Catch the common case where Python imports fail at boot (e.g. gevent's
  # native extension can't find Entware libs). Without this check we'd
  # report success even though the panel never bound to its port.
  sleep 1
  if kill -0 "$CHILD_PID" 2>/dev/null; then
    audit_boot "[start] OK, PID $CHILD_PID"
    echo "Запущено, PID $CHILD_PID."
    return 0
  else
    audit_boot "[start] child PID $CHILD_PID died within 1s; tail $STDERR_LOG for cause"
    echo "Не удалось запустить процесс. Смотри логи: $STDERR_LOG"
    rm -f "$PID_FILE"
    return 1
  fi
}

stop_service() {
  if [ -f "$PID_FILE" ]; then
    PID="$(cat "$PID_FILE")"
    if kill -0 "$PID" 2>/dev/null; then
      echo "Останавливаю Xkeen Web UI (PID $PID)..."
      kill "$PID" 2>/dev/null || true
      sleep 1
      if kill -0 "$PID" 2>/dev/null; then
        echo "Принудительное завершение процесса $PID..."
        kill -9 "$PID" 2>/dev/null || true
      fi
    fi
    rm -f "$PID_FILE"
  else
    pkill -f "$RUN_SERVER" 2>/dev/null || pkill -f "$APP_PY" 2>/dev/null || true
  fi
}

status_service() {
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "Xkeen Web UI запущен, PID $(cat "$PID_FILE")."
    return 0
  fi
  echo "Xkeen Web UI не запущен."
  return 1
}

case "$1" in
  start)
    start_service
    ;;
  stop)
    stop_service
    ;;
  restart)
    stop_service
    sleep 1
    start_service
    ;;
  status)
    status_service
    ;;
  *)
    echo "Использование: $0 {start|stop|restart|status}"
    exit 1
    ;;
esac

exit 0
EOF

if grep -q "__XKEEN_UI_PORT__" "$INIT_SCRIPT" 2>/dev/null; then
  sed -i -E "s/__XKEEN_UI_PORT__/${PANEL_PORT}/g" "$INIT_SCRIPT" || true
fi

chmod +x "$INIT_SCRIPT"

echo "[*] Запускаю сервис..."
"$INIT_SCRIPT" restart || true

echo "========================================"
echo "  ✔ Xkeen Web UI установлен"
echo "========================================"
PANEL_URL="http://<IP_роутера>:${PANEL_PORT}/"
printf '\033[1;32mОткрой в браузере:  %s\033[0m\n' "$PANEL_URL"
echo "Текущий порт панели: $PANEL_PORT"
echo "Файлы UI:           $UI_DIR"
echo "Init script:        $INIT_SCRIPT"
echo "Логи (install):     $LOG_DIR/xkeen-ui.log"
echo "Логи (runtime):     /opt/var/log/xkeen-ui/core.log (и access.log/ws.log)"
echo "========================================"

# --- ОЧИСТКА УСТАНОВОЧНЫХ ФАЙЛОВ ---

INSTALL_SRC_DIR="$SRC_DIR"
INSTALL_PARENT_DIR="$(dirname "$INSTALL_SRC_DIR")"

echo "[*] Очищаю установочные файлы..."

if [ -n "$INSTALL_PARENT_DIR" ] && [ -d "$INSTALL_PARENT_DIR" ]; then
  for ARCH in "$INSTALL_PARENT_DIR"/xkeen-ui*.tar.gz "$INSTALL_PARENT_DIR"/xkeen-ui-*.tar.gz; do
    [ -f "$ARCH" ] || continue
    echo "[*] Удаляю архив: $ARCH"
    rm -f "$ARCH" || echo "[!] Не удалось удалить архив $ARCH"
  done
fi

if [ "$INSTALL_SRC_DIR" != "$UI_DIR" ] && [ -d "$INSTALL_SRC_DIR" ]; then
  echo "[*] Удаляю временную директорию установки: $INSTALL_SRC_DIR"
  cd / || cd "$UI_DIR" || true
  rm -rf "$INSTALL_SRC_DIR" || echo "[!] Не удалось удалить директорию $INSTALL_SRC_DIR"
fi

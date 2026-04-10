#!/bin/sh
# Xkeen-UI self-update runner (stable GitHub Releases / main tarball)
#
# Ручной запуск:
#   sh /opt/etc/xkeen-ui/scripts/update_xkeen_ui.sh
#
# Настройки через env:
#   XKEEN_UI_UPDATE_REPO=umarcheh001/Xkeen-UI
#   XKEEN_UI_UPDATE_CHANNEL=stable   # stable | main
#   XKEEN_UI_UPDATE_BRANCH=main      # used when channel=main
#   XKEEN_UI_UPDATE_ASSET_NAME=xkeen-ui-routing.tar.gz
#   XKEEN_UI_UPDATE_DIR=/opt/var/lib/xkeen-ui/update
#   XKEEN_UI_BACKUP_DIR=/opt/var/backups/xkeen-ui
#   XKEEN_UI_BACKUP_KEEP=1
#
# Важно:
# - Скрипт пишет лог и status.json в update-dir.
# - Делает backup текущего /opt/etc/xkeen-ui перед установкой.
# - Для JSON использует python3 (как самый надёжный способ без jq).

set -eu

UI_DIR="/opt/etc/xkeen-ui"

REPO="${XKEEN_UI_UPDATE_REPO:-umarcheh001/Xkeen-UI}"
CHANNEL="${XKEEN_UI_UPDATE_CHANNEL:-stable}"
ASSET_NAME="${XKEEN_UI_UPDATE_ASSET_NAME:-}"
ACTION="${XKEEN_UI_UPDATE_ACTION:-update}"
API_BASE="${XKEEN_UI_GITHUB_API_BASE:-https://api.github.com}"
ASSET_URL_OVERRIDE="${XKEEN_UI_UPDATE_ASSET_URL:-}"
TAG_OVERRIDE="${XKEEN_UI_UPDATE_TAG:-}"
SHA_URL_OVERRIDE="${XKEEN_UI_UPDATE_SHA_URL:-}"
SHA_KIND_OVERRIDE="${XKEEN_UI_UPDATE_SHA_KIND:-}"


BACKUP_KEEP="1"  # hard limit: keep only ONE UI backup

# --- Security/limits ---
# Allowed download hosts (comma-separated).
#
# NOTE: GitHub release assets are served via a 302 redirect from github.com to
# release-assets.githubusercontent.com (a time-limited signed URL). If this host
# is not in the allow-list, the Python progress downloader will reject the
# redirect and fall back to curl/wget.
ALLOW_HOSTS_RAW="${XKEEN_UI_UPDATE_ALLOW_HOSTS:-github.com,release-assets.githubusercontent.com,objects.githubusercontent.com,codeload.github.com}"
ALLOW_HTTP="${XKEEN_UI_UPDATE_ALLOW_HTTP:-0}"

# Timeouts
CONNECT_TIMEOUT="${XKEEN_UI_UPDATE_CONNECT_TIMEOUT:-10}"
DOWNLOAD_TIMEOUT="${XKEEN_UI_UPDATE_DOWNLOAD_TIMEOUT:-300}"
API_TIMEOUT="${XKEEN_UI_UPDATE_API_TIMEOUT:-10}"

# Size limits (bytes)
MAX_BYTES="${XKEEN_UI_UPDATE_MAX_BYTES:-62914560}"            # 60 MiB
MAX_CHECKSUM_BYTES="${XKEEN_UI_UPDATE_MAX_CHECKSUM_BYTES:-1048576}"  # 1 MiB

# SHA policy
SHA_STRICT="${XKEEN_UI_UPDATE_SHA_STRICT:-1}"     # 1: fail if checksum file exists but no matching entry
REQUIRE_SHA="${XKEEN_UI_UPDATE_REQUIRE_SHA:-0}"   # 1: require checksum for stable channel

now_utc() {
  # busybox date поддерживает -u
  date -u "+%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date "+%Y-%m-%dT%H:%M:%SZ"
}

pick_python() {
  if command -v python3 >/dev/null 2>&1; then
    echo "python3"
    return
  fi
  if command -v /opt/bin/python3 >/dev/null 2>&1; then
    echo "/opt/bin/python3"
    return
  fi
  if command -v python >/dev/null 2>&1; then
    echo "python"
    return
  fi
  echo ""
}

PY="$(pick_python)"
if [ -z "$PY" ]; then
  echo "[!] python3/python не найден. Нужен для работы с GitHub API и JSON." >&2
  exit 1
fi

is_writable_dir() {
  d="$1"
  [ -d "$d" ] || return 1
  touch "$d/.w" 2>/dev/null && rm -f "$d/.w" 2>/dev/null
}

ensure_dir() {
  d="$1"
  if [ ! -d "$d" ]; then
    mkdir -p "$d" 2>/dev/null || return 1
  fi
  is_writable_dir "$d"
}

pick_update_dir() {
  if [ -n "${XKEEN_UI_UPDATE_DIR:-}" ]; then
    echo "$XKEEN_UI_UPDATE_DIR"
    return
  fi

  # приоритет: /opt/var/lib/... (роутер) -> /opt/var/log/... -> UI_DIR fallback -> /tmp
  for d in \
    "/opt/var/lib/xkeen-ui/update" \
    "/opt/var/log/xkeen-ui/update" \
    "$UI_DIR/var/lib/xkeen-ui/update" \
    "/tmp/xkeen-ui-update"; do
    if ensure_dir "$d"; then
      echo "$d"
      return
    fi
  done

  echo "/tmp/xkeen-ui-update"
}

pick_backup_dir() {
  if [ -n "${XKEEN_UI_BACKUP_DIR:-}" ]; then
    echo "$XKEEN_UI_BACKUP_DIR"
    return
  fi

  for d in \
    "/opt/var/backups/xkeen-ui" \
    "$UI_DIR/var/backups/xkeen-ui" \
    "/tmp/xkeen-ui-backups"; do
    if ensure_dir "$d"; then
      echo "$d"
      return
    fi
  done
  echo "/tmp/xkeen-ui-backups"
}

UPDATE_DIR="$(pick_update_dir)"
BACKUP_DIR="$(pick_backup_dir)"

STATUS_FILE="$UPDATE_DIR/status.json"
LOCK_FILE="$UPDATE_DIR/lock"
LOG_FILE="$UPDATE_DIR/update.log"

log() {
  msg="$*"
  ts="$(now_utc)"
  # Пишем и в stdout (для ручного запуска), и в файл.
  echo "[$ts] $msg" | tee -a "$LOG_FILE"
}

write_status() {
  state="$1"; step="$2"; message="$3"; err="${4:-}"
  # Пишем атомарно через python (tmp + rename). Схема совместима с services/self_update/state.py.
  "$PY" - "$STATUS_FILE" "$state" "$step" "$message" "$err" <<'PY'
import json, os, sys, time

path = sys.argv[1]
state = sys.argv[2]
step = sys.argv[3]
message = sys.argv[4]
err = sys.argv[5] if len(sys.argv) > 5 else ""

now = time.time()

base = {
  "state": state,
  "step": step,
  "progress": None,
  "created_ts": None,
  "started_ts": None,
  "finished_ts": None,
  "error": None,
  "pid": os.getpid(),
  "op": os.environ.get("XKEEN_UI_UPDATE_ACTION") or "update",
  # дополнительные поля (UI может показывать):
  "message": message,
  "updated_ts": now,
}

old = {}
try:
  with open(path, "r", encoding="utf-8") as f:
    old = json.load(f)
except Exception:
  old = {}

if isinstance(old, dict):
  # сохраняем timestamps
  if old.get("created_ts"):
    base["created_ts"] = old.get("created_ts")
  if old.get("started_ts"):
    base["started_ts"] = old.get("started_ts")

if not base["created_ts"]:
  base["created_ts"] = now

if state == "running":
  if not base["started_ts"]:
    base["started_ts"] = now
elif state in ("done", "failed"):
  # фиксируем завершение
  base["finished_ts"] = now
  if state == "failed":
    base["error"] = err or message or "update failed"

tmp = path + ".tmp"
os.makedirs(os.path.dirname(path), exist_ok=True)
with open(tmp, "w", encoding="utf-8") as f:
  json.dump(base, f, ensure_ascii=False, indent=2)
os.replace(tmp, path)
PY
}

acquire_lock() {
  # Если lock уже создан внешним процессом (например, backend API),
  # то мы просто "забираем" его на себя (перезаписываем pid) и продолжаем.
  if [ "${XKEEN_UI_LOCK_PRECREATED:-}" = "1" ]; then
    "$PY" - "$LOCK_FILE" <<'PY'
import json, os, sys, time
p = sys.argv[1]
created_ts = time.time()
try:
  with open(p, 'r', encoding='utf-8') as f:
    d = json.load(f)
  if isinstance(d, dict) and d.get('created_ts'):
    try:
      created_ts = float(d.get('created_ts'))
    except Exception:
      pass
except Exception:
  pass

d = {"pid": os.getpid(), "created_ts": created_ts}
tmp = p + ".tmp"
os.makedirs(os.path.dirname(p), exist_ok=True)
with open(tmp, 'w', encoding='utf-8') as f:
  json.dump(d, f, ensure_ascii=False, indent=2)
os.replace(tmp, p)
PY
    return 0
  fi

  if [ -f "$LOCK_FILE" ]; then
    # если PID жив — не стартуем
    lp="$($PY - "$LOCK_FILE" <<'PY'
import json, sys
p = sys.argv[1]
try:
  with open(p, 'r', encoding='utf-8') as f:
    d = json.load(f)
  pid = d.get('pid') if isinstance(d, dict) else None
  print(pid or "")
except Exception:
  print("")
PY
)"
    if [ -n "$lp" ] && kill -0 "$lp" 2>/dev/null; then
      log "[!] Lock существует (pid=$lp). Обновление уже выполняется?"
      return 1
    fi
  fi

  # Пишем JSON lock (совместимо с services/self_update/state.py)
  "$PY" - "$LOCK_FILE" <<'PY'
import json, os, sys, time
p = sys.argv[1]
d = {"pid": os.getpid(), "created_ts": time.time()}
tmp = p + ".tmp"
os.makedirs(os.path.dirname(p), exist_ok=True)
with open(tmp, 'w', encoding='utf-8') as f:
  json.dump(d, f, ensure_ascii=False, indent=2)
os.replace(tmp, p)
PY
  return 0
}

release_lock() {
  rm -f "$LOCK_FILE" 2>/dev/null || true
}

cleanup() {
  # best-effort cleanup
  release_lock
}

trap cleanup EXIT INT TERM

download() {
  url="$1"; out="$2"; max_bytes="${3:-}"; label="${4:-file}"; show_progress="${5:-0}"

  # --- allow-list check (scheme + host) ---
  if ! "$PY" - "$url" "$ALLOW_HOSTS_RAW" "$ALLOW_HTTP" <<'PY'
import sys
from urllib.parse import urlparse

url = sys.argv[1]
hosts = [h.strip().lower() for h in (sys.argv[2] or '').split(',') if h.strip()]
allow_http = (sys.argv[3] or '0').strip() == '1'
p = urlparse(url)

if p.scheme not in ('https', 'http'):
    print('bad_scheme')
    sys.exit(1)
if p.scheme == 'http' and not allow_http:
    print('http_not_allowed')
    sys.exit(1)
host = (p.hostname or '').lower()
if not host:
    print('no_host')
    sys.exit(1)

ok = False
for h in hosts:
    if host == h or host.endswith('.' + h):
        ok = True
        break
if not ok:
    print('host_not_allowed:' + host)
    sys.exit(1)

print('ok')
sys.exit(0)
PY
  then
    why="$($PY - "$url" "$ALLOW_HOSTS_RAW" "$ALLOW_HTTP" <<'PY'
import sys
from urllib.parse import urlparse
url=sys.argv[1]
hosts=[h.strip().lower() for h in (sys.argv[2] or '').split(',') if h.strip()]
allow_http=(sys.argv[3] or '0').strip()=='1'
p=urlparse(url)
if p.scheme not in ('https','http'):
    print('bad_scheme')
    sys.exit(0)
if p.scheme=='http' and not allow_http:
    print('http_not_allowed')
    sys.exit(0)
host=(p.hostname or '').lower()
if not host:
    print('no_host')
    sys.exit(0)
ok=False
for h in hosts:
    if host==h or host.endswith('.'+h):
        ok=True; break
if not ok:
    print('host_not_allowed:'+host)
else:
    print('ok')
PY
)"
    log "[!] Blocked download URL ($label): $url ($why)"
    return 3
  fi

  # --- download ---
  # If requested, try Python downloader with live progress updates into status.json.
  # Falls back to curl/wget if Python download fails (e.g. SSL/cert issues).
  if [ "$show_progress" = "1" ]; then
    if "$PY" - "$url" "$out" "$STATUS_FILE" "$label" "${max_bytes:-0}" "$ALLOW_HOSTS_RAW" "$ALLOW_HTTP" "$CONNECT_TIMEOUT" "$DOWNLOAD_TIMEOUT" 2>>"$LOG_FILE" <<'PY'
import json, os, sys, time, math
from urllib.parse import urlparse
import urllib.request
import urllib.error

url = sys.argv[1]
out_path = sys.argv[2]
status_path = sys.argv[3]
label = sys.argv[4]
try:
    max_bytes = int(float(sys.argv[5] or 0))
except Exception:
    max_bytes = 0
allow_hosts_raw = sys.argv[6] or ""
allow_http = (sys.argv[7] or "0").strip() == "1"
try:
    connect_timeout = float(sys.argv[8] or 10.0)
except Exception:
    connect_timeout = 10.0
try:
    total_timeout = float(sys.argv[9] or 300.0)
except Exception:
    total_timeout = 300.0

hosts = [h.strip().lower() for h in allow_hosts_raw.split(",") if h.strip()]

def is_allowed(u: str) -> bool:
    try:
        p = urlparse(u)
        if p.scheme not in ("https", "http"):
            return False
        if p.scheme == "http" and not allow_http:
            return False
        host = (p.hostname or "").lower()
        if not host:
            return False
        for h in hosts:
            if host == h or host.endswith("." + h):
                return True
        return False
    except Exception:
        return False

if not is_allowed(url):
    sys.stderr.write("blocked_url\n")
    sys.exit(3)

class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not is_allowed(newurl):
            raise urllib.error.URLError("redirect_not_allowed:" + str(newurl))
        return super().redirect_request(req, fp, code, msg, headers, newurl)

opener = urllib.request.build_opener(SafeRedirect)

def read_status():
    try:
        with open(status_path, "r", encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}

def write_status_patch(patch: dict):
    # atomic write with merge
    d = read_status()
    if not isinstance(d, dict):
        d = {}
    d.update(patch)
    d.setdefault("state", "running")
    d.setdefault("step", "download")
    d.setdefault("created_ts", time.time())
    d.setdefault("started_ts", time.time())
    d["updated_ts"] = time.time()
    tmp = status_path + ".tmp"
    os.makedirs(os.path.dirname(status_path) or ".", exist_ok=True)
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False, indent=2)
    os.replace(tmp, status_path)

# Start request
req = urllib.request.Request(url, headers={"User-Agent": "xkeen-ui-updater"})
start = time.time()
last_emit = 0.0
last_bytes = 0
last_t = start

try:
    with opener.open(req, timeout=connect_timeout) as resp:
        # Determine total size if available
        total = 0
        try:
            cl = resp.headers.get("Content-Length")
            if cl:
                total = int(cl)
        except Exception:
            total = 0

        # Prepare output dir
        os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
        tmp_out = out_path + ".part"

        done = 0
        # initial progress
        write_status_patch({"step": "download", "message": "Downloading " + label,
                           "progress": {"phase": "download", "label": label, "bytes_done": 0, "bytes_total": total or 0, "pct": 0}})
        with open(tmp_out, "wb") as f:
            while True:
                if total_timeout and (time.time() - start) > total_timeout:
                    raise TimeoutError("download_timeout")
                chunk = resp.read(128 * 1024)
                if not chunk:
                    break
                f.write(chunk)
                done += len(chunk)

                if max_bytes and done > max_bytes:
                    raise ValueError("too_large")

                now = time.time()
                emit = False
                if (now - last_emit) >= 0.35:
                    emit = True
                elif done - last_bytes >= 512 * 1024:
                    emit = True

                if emit:
                    dt = max(1e-6, now - last_t)
                    speed = (done - last_bytes) / dt
                    eta = 0
                    if total and speed > 1:
                        eta = max(0, int((total - done) / speed))
                    pct = int((done / total) * 100) if total else 0
                    write_status_patch({"progress": {"phase": "download", "label": label,
                                                     "bytes_done": done, "bytes_total": total or 0,
                                                     "pct": pct, "speed_bps": speed, "eta_sec": eta}})
                    last_emit = now
                    last_bytes = done
                    last_t = now

        os.replace(tmp_out, out_path)

        # final emit
        pct = 100 if total and done >= total else (int((done / total) * 100) if total else 0)
        write_status_patch({"progress": {"phase": "download", "label": label,
                                         "bytes_done": done, "bytes_total": total or 0,
                                         "pct": pct}})
except Exception as e:
    # cleanup partial
    try:
        if os.path.exists(out_path + ".part"):
            os.remove(out_path + ".part")
    except Exception:
        pass
    sys.stderr.write(str(e)[:200] + "\n")
    sys.exit(11)

sys.exit(0)
PY
    then
      # Downloaded by Python with progress; continue.
      return 0
    else
      log "[!] Python progress download failed; falling back to curl/wget."
      # fall through
    fi
  fi

  if command -v curl >/dev/null 2>&1; then
    # -f: fail on HTTP errors, -L: follow redirects
    curl -f -L --connect-timeout "$CONNECT_TIMEOUT" --max-time "$DOWNLOAD_TIMEOUT" -A "xkeen-ui-updater" -o "$out" "$url" >>"$LOG_FILE" 2>&1
  elif command -v wget >/dev/null 2>&1; then
    # BusyBox wget: --timeout is seconds (connect + read), no redirect limit.
    wget -O "$out" --timeout="$DOWNLOAD_TIMEOUT" "$url" >>"$LOG_FILE" 2>&1
  else
    log "[!] Не найден curl/wget для скачивания."
    return 1
  fi

  # --- size check ---
  if [ -n "$max_bytes" ] && [ -f "$out" ]; then
    sz="$($PY - "$out" <<'PY'
import os, sys
try:
  print(os.path.getsize(sys.argv[1]))
except Exception:
  print(0)
PY
)"
    case "$sz" in
      ''|*[!0-9]*) sz=0 ;;
    esac
    if [ "$sz" -gt "$max_bytes" ]; then
      log "[!] Downloaded $label is too large: ${sz} bytes (limit=${max_bytes})"
      return 4
    fi
  fi

  return 0
}

find_install_sh() {
  root="$1"
  # Ищем install.sh не глубже 6 уровней
  find "$root" -maxdepth 6 -type f -name install.sh 2>/dev/null | head -n 1
}

tar_safe_check() {
  tarball="$1"
  "$PY" - "$tarball" <<'PY'
import os
import sys
import tarfile

p = sys.argv[1]

try:
    tf = tarfile.open(p, 'r:*')
except Exception as e:
    print('error:open:' + str(e))
    sys.exit(2)

members = tf.getmembers()
if len(members) > 20000:
    print('error:too_many_members')
    sys.exit(3)

def bad_path(name: str) -> bool:
    if not name:
        return True
    if name.startswith('/') or name.startswith('\\'):
        return True
    norm = os.path.normpath(name)
    # normpath can return '.' for empty paths
    if norm == '..' or norm.startswith('..' + os.sep):
        return True
    if '/..' in norm.replace('\\','/'):
        return True
    return False

for m in members:
    n = m.name or ''
    if bad_path(n):
        print('error:bad_member:' + n)
        sys.exit(4)
    if m.issym() or m.islnk():
        ln = m.linkname or ''
        if bad_path(ln):
            print('error:bad_link:' + n + '->' + ln)
            sys.exit(5)

print('ok')
sys.exit(0)
PY
}

trim_backups() {
  keep="$1"
  # Оставляем $keep самых свежих *.tgz
  # Busybox: ls -1t поддерживается обычно.
  i=0
  for f in $(ls -1t "$BACKUP_DIR"/xkeen-ui-*.tgz 2>/dev/null || true); do
    i=$((i+1))
    if [ "$i" -gt "$keep" ]; then
      rm -f "$f" 2>/dev/null || true
    fi
  done
}

if [ "$ACTION" != "rollback" ]; then
  if [ "$CHANNEL" != "stable" ] && [ "$CHANNEL" != "main" ]; then
    echo "[!] Unsupported channel: $CHANNEL (use stable or main)." >&2
    exit 1
  fi
fi

mkdir -p "$UPDATE_DIR" "$BACKUP_DIR" 2>/dev/null || true

# Каждая операция обновления должна иметь «свой» лог.
# Раньше update.log копился бесконечно (append), и в UI всегда показывалась
# большая история. Сбрасываем лог на старте, а предыдущий (если был) сохраняем
# как update.prev.log для диагностики.
if [ -f "$LOG_FILE" ] && [ -s "$LOG_FILE" ]; then
  mv -f "$LOG_FILE" "$UPDATE_DIR/update.prev.log" 2>/dev/null || true
fi
: >"$LOG_FILE" 2>/dev/null || true

log "=== Xkeen-UI updater start ==="
log "repo=$REPO channel=$CHANNEL action=$ACTION update_dir=$UPDATE_DIR backup_dir=$BACKUP_DIR"

if ! acquire_lock; then
  write_status "failed" "lock" "Lock already exists" "lock already exists"
  exit 2
fi

write_status "running" "init" "Starting"

# --- Rollback flow ---
if [ "$ACTION" = "rollback" ]; then
  write_status "running" "rollback_select" "Selecting backup"
  ts="$(date -u +%Y%m%d-%H%M%S 2>/dev/null || date +%Y%m%d-%H%M%S)"

  rb_file="${XKEEN_UI_ROLLBACK_FILE:-}"
  backup_pick=""
  if [ -n "$rb_file" ] && [ -f "$rb_file" ]; then
    backup_pick="$rb_file"
  else
    backup_pick="$(ls -1t "$BACKUP_DIR"/xkeen-ui-*.tgz 2>/dev/null | head -n 1 || true)"
  fi

  if [ -z "$backup_pick" ] || [ ! -f "$backup_pick" ]; then
    log "[!] Backup not found in $BACKUP_DIR"
    write_status "failed" "rollback_select" "Backup not found" "backup not found"
    exit 20
  fi

  log "[*] Rollback from: $backup_pick"

  write_status "running" "rollback_stop" "Stopping UI service"
  if [ -x "/opt/etc/init.d/S99xkeen-ui" ]; then
    /opt/etc/init.d/S99xkeen-ui stop >>"$LOG_FILE" 2>&1 || true
  fi

  write_status "running" "rollback_restore" "Restoring backup"
  cur_mv=""
  if [ -d "$UI_DIR" ]; then
    cur_mv="$UI_DIR.rollback-current-$ts"
    log "[*] Moving current UI dir to: $cur_mv"
    mv "$UI_DIR" "$cur_mv" >>"$LOG_FILE" 2>&1 || {
      log "[!] Failed to move current UI dir"
      write_status "failed" "rollback_restore" "Failed to move current dir" "move failed"
      exit 21
    }
  fi

  base_dir="$(dirname "$UI_DIR")"
  mkdir -p "$base_dir" 2>/dev/null || true

  if tar -xzf "$backup_pick" -C "$base_dir" >>"$LOG_FILE" 2>&1; then
    log "[*] Backup extracted"
  else
    log "[!] Failed to extract backup"
    # Try to revert to previous directory if extraction failed
    if [ -n "$cur_mv" ] && [ -d "$cur_mv" ]; then
      rm -rf "$UI_DIR" 2>/dev/null || true
      mv "$cur_mv" "$UI_DIR" 2>/dev/null || true
    fi
    write_status "failed" "rollback_restore" "Extract failed" "extract failed"
    exit 22
  fi

  write_status "running" "restart" "Restarting UI service"
  if [ -x "/opt/etc/init.d/S99xkeen-ui" ]; then
    log "[*] Restarting service via init.d..."
    /opt/etc/init.d/S99xkeen-ui restart >>"$LOG_FILE" 2>&1 || true
  else
    log "[*] init.d script not found; please restart UI service manually"
  fi

  if [ -n "$cur_mv" ] && [ -d "$cur_mv" ]; then
    keep_cur="${XKEEN_UI_ROLLBACK_KEEP_CURRENT:-0}"
    if [ "$keep_cur" = "1" ]; then
      log "[*] Kept previous UI dir at: $cur_mv"
    else
      rm -rf "$cur_mv" >>"$LOG_FILE" 2>&1 || true
      log "[*] Removed previous UI dir: $cur_mv"
    fi
  fi

  write_status "done" "done" "Rollback completed"
  log "=== Xkeen-UI rollback done ==="
  exit 0
fi

# 1) Backup
write_status "running" "backup" "Creating backup"
ts="$(date -u +%Y%m%d-%H%M%S 2>/dev/null || date +%Y%m%d-%H%M%S)"
backup_file="$BACKUP_DIR/xkeen-ui-$ts.tgz"
if [ -d "$UI_DIR" ]; then
  log "[*] Backup: $backup_file"
  if tar \
    --exclude='*pycache*' \
    --exclude='*.pyc' \
    --exclude='*.pyo' \
    -czf "$backup_file" \
    -C "$(dirname "$UI_DIR")" \
    "$(basename "$UI_DIR")" >>"$LOG_FILE" 2>&1; then
    trim_backups "$BACKUP_KEEP"
  else
    rm -f "$backup_file" 2>/dev/null || true
    log "[!] Backup failed"
    write_status "failed" "backup" "Backup failed" "backup failed"
    exit 18
  fi
else
  log "[!] UI_DIR ($UI_DIR) не найден. Backup пропущен."
fi

# 2) Resolve latest (stable release asset OR main tarball)
write_status "running" "check_latest" "Fetching latest info"

COMMIT=""
COMMIT_AT=""
BRANCH="${XKEEN_UI_UPDATE_BRANCH:-}"

if [ "$CHANNEL" = "main" ]; then
  if [ -n "$ASSET_URL_OVERRIDE" ]; then
    log "[*] Using override tarball URL: $ASSET_URL_OVERRIDE"
    ASSET_URL="$ASSET_URL_OVERRIDE"
    if [ -z "$ASSET_NAME" ]; then
      ASSET_NAME="$($PY - "$ASSET_URL_OVERRIDE" <<'PY'
import sys
from urllib.parse import urlparse
u = sys.argv[1]
p = urlparse(u)
path = (p.path or '').rstrip('/')
nm = path.split('/')[-1] if path else ''
print(nm or 'xkeen-ui.tar.gz')
PY
)"
    fi
    TAG="${TAG_OVERRIDE:-main@override}"
    SHA_URL="${SHA_URL_OVERRIDE:-}"
    SHA_KIND="${SHA_KIND_OVERRIDE:-}"
    log "[*] Tarball URL: $ASSET_URL"
  else
    log "[*] Fetching latest commit (tarball) from GitHub API..."

  MAIN_OUT="$($PY - "$API_BASE" "$REPO" "${BRANCH:-}" "$API_TIMEOUT" <<'PYMAIN'
import json, sys, urllib.request, urllib.error

api_base = sys.argv[1].rstrip('/')
repo = sys.argv[2]
branch_in = (sys.argv[3] or '').strip() or None
timeout = float(sys.argv[4] or 10)

headers = {"User-Agent": "xkeen-ui-updater", "Accept": "application/vnd.github+json"}

# Determine default branch (best-effort)
default_branch = None
try:
    req = urllib.request.Request(f"{api_base}/repos/{repo}", headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        repo_data = json.loads(r.read().decode('utf-8', 'replace'))
    if isinstance(repo_data, dict):
        default_branch = repo_data.get('default_branch') or None
except Exception:
    default_branch = None

branch = branch_in or default_branch or 'main'

# Try requested/default branch first, then fall back to main/master
tried = []
commit_data = None
for b in [branch, 'main', 'master']:
    b = (b or '').strip()
    if not b or b in tried:
        continue
    tried.append(b)
    try:
        req = urllib.request.Request(f"{api_base}/repos/{repo}/commits/{b}", headers=headers)
        with urllib.request.urlopen(req, timeout=timeout) as r:
            commit_data = json.loads(r.read().decode('utf-8', 'replace'))
        if isinstance(commit_data, dict) and commit_data.get('sha'):
            branch = b
            break
    except urllib.error.HTTPError:
        continue
    except Exception:
        continue

if not isinstance(commit_data, dict) or not commit_data.get('sha'):
    sys.stderr.write('commit_not_found\n')
    sys.exit(10)

sha = str(commit_data.get('sha'))
commit = commit_data.get('commit') or {}
committer = commit.get('committer') or {}
committed_at = str(committer.get('date') or '')
message = str(commit.get('message') or '').splitlines()[0] if commit.get('message') else ''
html_url = str(commit_data.get('html_url') or '')

# Use codeload for a direct tarball without GitHub UI wrappers.
tarball_url = f"https://codeload.github.com/{repo}/tar.gz/{sha}"

print(branch)
print(sha)
print(committed_at)
print(tarball_url)
print(html_url)
print(message)
PYMAIN
)" || {
    rc=$?
    log "[!] Не удалось получить latest commit (rc=$rc)."
    write_status "failed" "check_latest" "Failed to fetch latest commit" "failed to fetch latest commit"
    exit 3
  }

  BRANCH="$(printf '%s\n' "$MAIN_OUT" | sed -n '1p')"
  COMMIT="$(printf '%s\n' "$MAIN_OUT" | sed -n '2p')"
  COMMIT_AT="$(printf '%s\n' "$MAIN_OUT" | sed -n '3p')"
  ASSET_URL="$(printf '%s\n' "$MAIN_OUT" | sed -n '4p')"
  COMMIT_HTML="$(printf '%s\n' "$MAIN_OUT" | sed -n '5p')"
  COMMIT_MSG="$(printf '%s\n' "$MAIN_OUT" | sed -n '6p')"

  SHORT_SHA="$(printf '%s' "$COMMIT" | cut -c1-7)"
  if [ -z "$SHORT_SHA" ]; then SHORT_SHA="unknown"; fi
  if [ -z "$BRANCH" ]; then BRANCH="main"; fi

  ASSET_NAME="xkeen-ui-${BRANCH}-${SHORT_SHA}.tar.gz"
  TAG="${BRANCH}@${SHORT_SHA}"
  SHA_URL=""
  SHA_KIND=""

  log "[*] Latest commit: ${COMMIT:-<unknown>} (branch=${BRANCH})"
  if [ -n "$COMMIT_AT" ]; then log "[*] Committed at: $COMMIT_AT"; fi
  if [ -n "$COMMIT_HTML" ]; then log "[*] Commit: $COMMIT_HTML"; fi
  if [ -n "$COMMIT_MSG" ]; then log "[*] Message: $COMMIT_MSG"; fi
  log "[*] Tarball URL: $ASSET_URL"
  fi

else
write_status "running" "check_latest" "Fetching latest release info"
if [ -n "$ASSET_URL_OVERRIDE" ]; then
  log "[*] Using override asset URL: $ASSET_URL_OVERRIDE"
  if [ -z "$ASSET_NAME" ]; then
    ASSET_NAME="$($PY - "$ASSET_URL_OVERRIDE" <<'PY'
import sys
from urllib.parse import urlparse
u = sys.argv[1]
p = urlparse(u)
path = (p.path or '').rstrip('/')
nm = path.split('/')[-1] if path else ''
print(nm or 'xkeen-ui.tar.gz')
PY
)"
  fi
  LATEST_OUT="$(printf '%s\n%s\n%s\n%s\n%s\n' "${TAG_OVERRIDE:-}" "${ASSET_NAME:-}" "$ASSET_URL_OVERRIDE" "${SHA_URL_OVERRIDE:-}" "${SHA_KIND_OVERRIDE:-}")"
else
  log "[*] Fetching latest release from GitHub API..."

ASSET_CANDIDATES=""
if [ -n "$ASSET_NAME" ]; then
  # user override + safe fallbacks
  if [ "$ASSET_NAME" = "xkeen-ui.tar.gz" ]; then
    ASSET_CANDIDATES="$ASSET_NAME xkeen-ui-routing.tar.gz"
  elif [ "$ASSET_NAME" = "xkeen-ui-routing.tar.gz" ]; then
    ASSET_CANDIDATES="$ASSET_NAME xkeen-ui.tar.gz"
  else
    ASSET_CANDIDATES="$ASSET_NAME xkeen-ui-routing.tar.gz xkeen-ui.tar.gz"
  fi
else
  # default project convention first
  ASSET_CANDIDATES="xkeen-ui-routing.tar.gz xkeen-ui.tar.gz"
fi

ERR_TMP="$UPDATE_DIR/.gh_latest.err.$$"
LATEST_OUT=""
if ! LATEST_OUT="$($PY - "$API_BASE" "$REPO" "$API_TIMEOUT" $ASSET_CANDIDATES 2>"$ERR_TMP" <<'PY'
import json, sys, urllib.request, urllib.error

api_base = sys.argv[1].rstrip('/')
repo = sys.argv[2]
timeout = float(sys.argv[3] or 10)
asset_names = [a for a in sys.argv[4:] if a]
url = f"{api_base}/repos/{repo}/releases/latest"

req = urllib.request.Request(url, headers={"User-Agent": "xkeen-ui-updater", "Accept": "application/vnd.github+json"})
try:
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = json.loads(r.read().decode("utf-8", "replace"))
except urllib.error.HTTPError as e:
    sys.stderr.write(f"HTTPError {e.code}: {e.reason}\n")
    sys.exit(10)
except Exception as e:
    sys.stderr.write(str(e) + "\n")
    sys.exit(11)

tag = data.get("tag_name") or ""
assets = data.get("assets") or []

# Build name->url map
name_to_url = {}
for a in assets:
    try:
        n = a.get("name") or ""
        dl = a.get("browser_download_url") or ""
        if n and dl:
            name_to_url[str(n)] = str(dl)
    except Exception:
        pass

picked_name = ""
asset_url = ""
sha_url = ""
sha_kind = ""

def pick_sha(asset_name: str):
    if not asset_name:
        return "", ""
    cand = [
        asset_name + ".sha256",
        asset_name + ".sha256.txt",
        asset_name + ".sha256sum",
        asset_name + ".sha256sum.txt",
        asset_name + ".sha",
        asset_name + ".sha.txt",
    ]
    for suf in (".tar.gz", ".tgz", ".tar", ".zip"):
        if asset_name.endswith(suf):
            base = asset_name[: -len(suf)]
            cand += [
                base + ".sha256",
                base + ".sha256.txt",
                base + ".sha256sum",
                base + ".sha",
            ]
            break
    for nm in cand:
        u = name_to_url.get(nm)
        if u:
            return u, "sidecar"

    for nm in (
        "SHA256SUMS",
        "SHA256SUMS.txt",
        "sha256sums",
        "sha256sums.txt",
        "checksums.txt",
        "checksums.sha256",
        "checksums",
    ):
        u = name_to_url.get(nm)
        if u:
            return u, "manifest"

    return "", ""

for nm in asset_names:
    dl = name_to_url.get(nm) or ""
    if dl:
        picked_name = nm
        asset_url = dl
        sha_url, sha_kind = pick_sha(nm)
        break

print(tag)
print(picked_name)
print(asset_url)
print(sha_url)
print(sha_kind)

PY
)"; then
  rc=$?
  err_line="$($PY - "$ERR_TMP" <<'PY'
import sys
p = sys.argv[1]
try:
  with open(p, "r", encoding="utf-8", errors="replace") as f:
    lines = f.read().splitlines()
  print(lines[-1] if lines else "")
except Exception:
  print("")
PY
)"
  log "[!] GitHub API latest release failed (rc=$rc): ${err_line:-<no details>}"
  log "[*] Trying fallback via github.com/releases/latest..."
  if ! LATEST_OUT="$($PY - "$REPO" "$API_TIMEOUT" $ASSET_CANDIDATES 2>"$ERR_TMP" <<'PY'
import re, sys, urllib.request, urllib.error

repo = sys.argv[1]
timeout = float(sys.argv[2] or 10)
asset_names = [a for a in sys.argv[3:] if a]

ua = {"User-Agent": "xkeen-ui-updater"}

def url_ok(u: str) -> bool:
    try:
        req = urllib.request.Request(u, headers={**ua, "Range": "bytes=0-0"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            st = int(getattr(r, "status", 200) or 200)
            return st < 400
    except urllib.error.HTTPError as e:
        try:
            if int(getattr(e, "code", 0) or 0) in (301, 302, 303, 307, 308):
                return True
        except Exception:
            pass
        return False
    except Exception:
        return False

# Resolve tag best-effort (not required for /releases/latest/download)
tag = ""
try:
    req = urllib.request.Request(f"https://github.com/{repo}/releases/latest", headers=ua)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        final = r.geturl() or ""
    m = re.search(r"/tag/([^/?#]+)", final)
    if m:
        tag = m.group(1)
except Exception:
    tag = ""

def pick_sha(asset_name: str):
    if not asset_name:
        return "", ""
    cand = [
        asset_name + ".sha256",
        asset_name + ".sha256.txt",
        asset_name + ".sha256sum",
        asset_name + ".sha256sum.txt",
        asset_name + ".sha",
        asset_name + ".sha.txt",
    ]
    for suf in (".tar.gz", ".tgz", ".tar", ".zip"):
        if asset_name.endswith(suf):
            base = asset_name[: -len(suf)]
            cand += [
                base + ".sha256",
                base + ".sha256.txt",
                base + ".sha256sum",
                base + ".sha",
            ]
            break
    for nm in cand:
        u = f"https://github.com/{repo}/releases/latest/download/{nm}"
        if url_ok(u):
            return u, "sidecar"
    for nm in (
        "SHA256SUMS",
        "SHA256SUMS.txt",
        "sha256sums",
        "sha256sums.txt",
        "checksums.txt",
        "checksums.sha256",
        "checksums",
    ):
        u = f"https://github.com/{repo}/releases/latest/download/{nm}"
        if url_ok(u):
            return u, "manifest"
    return "", ""

picked = ""
asset_url = ""
sha_url = ""
sha_kind = ""

for nm in asset_names:
    u = f"https://github.com/{repo}/releases/latest/download/{nm}"
    if url_ok(u):
        picked = nm
        asset_url = u
        sha_url, sha_kind = pick_sha(nm)
        break

if not asset_url:
    sys.stderr.write("asset_not_found\n")
    sys.exit(12)

print(tag)
print(picked)
print(asset_url)
print(sha_url)
print(sha_kind)
PY
)"; then
    rc2=$?
    err_line2="$($PY - "$ERR_TMP" <<'PY'
import sys
p = sys.argv[1]
try:
  with open(p, "r", encoding="utf-8", errors="replace") as f:
    lines = f.read().splitlines()
  print(lines[-1] if lines else "")
except Exception:
  print("")
PY
)"
    rm -f "$ERR_TMP" 2>/dev/null || true
    log "[!] Fallback latest release lookup failed (rc=$rc2): ${err_line2:-<no details>}"
    write_status "failed" "check_latest" "Failed to fetch latest release" "failed to fetch latest release: ${err_line2:-rc=$rc2}"
    exit 3
  fi
fi
rm -f "$ERR_TMP" 2>/dev/null || true

fi
TAG="$(printf '%s\n' "$LATEST_OUT" | sed -n '1p')"
PICKED_NAME="$(printf '%s\n' "$LATEST_OUT" | sed -n '2p')"
ASSET_URL="$(printf '%s\n' "$LATEST_OUT" | sed -n '3p')"
SHA_URL="$(printf '%s\n' "$LATEST_OUT" | sed -n '4p')"
SHA_KIND="$(printf '%s\n' "$LATEST_OUT" | sed -n '5p')"

# backward compatibility (older updater output had only 4 lines)
if [ -n "$SHA_URL" ] && [ -z "$SHA_KIND" ]; then
  SHA_KIND="sidecar"
fi

if [ -n "$PICKED_NAME" ]; then
  ASSET_NAME="$PICKED_NAME"
fi

if [ -z "$ASSET_URL" ]; then
  log "[!] В latest release не найден asset. Кандидаты: $ASSET_CANDIDATES"
  write_status "failed" "check_latest" "Release asset not found" "release asset not found"
  exit 4
fi

log "[*] Latest tag: ${TAG:-<unknown>}"
log "[*] Asset URL: $ASSET_URL"

fi

# Policy: optionally require checksum for stable channel
if [ "$CHANNEL" = "stable" ] && [ "$REQUIRE_SHA" = "1" ] && [ -z "${SHA_URL:-}" ]; then
  log "[!] Checksum is required (XKEEN_UI_UPDATE_REQUIRE_SHA=1), but sha file was not found in release assets."
  write_status "failed" "check_latest" "Checksum required but missing" "checksum missing"
  exit 4
fi

# 3) Download
write_status "running" "download" "Downloading release asset"

WORK_DIR=""
if command -v mktemp >/dev/null 2>&1; then
  WORK_DIR="$(mktemp -d /tmp/xkeen-ui-update.XXXXXX 2>/dev/null || true)"
fi
if [ -z "$WORK_DIR" ]; then
  WORK_DIR="/tmp/xkeen-ui-update-$$"
  mkdir -p "$WORK_DIR" 2>/dev/null || true
fi

TARBALL="$WORK_DIR/$ASSET_NAME"
log "[*] Downloading to: $TARBALL"
if ! download "$ASSET_URL" "$TARBALL" "$MAX_BYTES" "asset" "1"; then
  log "[!] Download failed."
  write_status "failed" "download" "Download failed" "download failed"
  exit 5
fi

# 4) Verify (best-effort)
# Поддерживаем несколько схем контрольных сумм:
#   - sidecar: <asset>.sha256 / <asset>.sha / ...
#   - manifest: SHA256SUMS / checksums.txt (где есть строки для разных файлов)
# Проверка мягкая: если checksum-файл есть, но в нём нет строки для нашего архива —
# не падаем, а просто предупреждаем.

if [ -n "$SHA_URL" ]; then
  write_status "running" "verify" "Verifying SHA256"
  SHA_LOCAL="$WORK_DIR/checksums"
  log "[*] Downloading checksum (${SHA_KIND:-sidecar}): $SHA_URL"
  if download "$SHA_URL" "$SHA_LOCAL" "$MAX_CHECKSUM_BYTES" "checksum"; then
    VERIFY_OUT="$($PY - "$TARBALL" "$SHA_LOCAL" "$ASSET_NAME" "${SHA_KIND:-sidecar}" "$STATUS_FILE" <<'PY'
import hashlib
import os
import re
import sys
import json
import time


tarball = sys.argv[1]
checksum_path = sys.argv[2]
asset_name = sys.argv[3]
kind = (sys.argv[4] or 'sidecar').strip().lower()
status_path = sys.argv[5]


def read_text(path: str) -> str:
    with open(path, 'r', encoding='utf-8', errors='replace') as f:
        return f.read()


def pick_expected_from_sidecar(txt: str) -> str:
    # Accept: "<hash>", "<hash> <file>", "SHA256 (file) = <hash>"
    m = re.search(r"([0-9a-fA-F]{64})", txt)
    return m.group(1).lower() if m else ''


def norm_filename(fn: str) -> str:
    fn = (fn or '').strip()
    if fn.startswith('*'):
        fn = fn[1:]
    if fn.startswith('./'):
        fn = fn[2:]
    return fn


def pick_expected_from_manifest(txt: str, wanted: str) -> str:
    wanted = (wanted or '').strip()
    if not wanted:
        return ''

    for line in txt.splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue

        # OpenSSL style: SHA256 (file) = hash
        m = re.match(r"^SHA256\s*\((.+?)\)\s*=\s*([0-9a-fA-F]{64})\s*$", line)
        if m:
            fn = norm_filename(m.group(1))
            if fn == wanted or fn.endswith('/' + wanted):
                return m.group(2).lower()
            continue

        # GNU coreutils style: hash  filename
        m = re.match(r"^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$", line)
        if m:
            h = m.group(1).lower()
            fn = norm_filename(m.group(2))
            if fn == wanted or fn.endswith('/' + wanted):
                return h

    # If file contains a single hash without filename, accept it.
    return pick_expected_from_sidecar(txt)


def read_status() -> dict:
    try:
        with open(status_path, 'r', encoding='utf-8') as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def write_status_patch(patch: dict):
    d = read_status()
    if not isinstance(d, dict):
        d = {}
    d.update(patch)
    d.setdefault('state', 'running')
    d.setdefault('step', 'verify')
    d.setdefault('created_ts', time.time())
    d.setdefault('started_ts', time.time())
    d['updated_ts'] = time.time()

    tmp = status_path + '.tmp'
    os.makedirs(os.path.dirname(status_path) or '.', exist_ok=True)
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(d, f, ensure_ascii=False, indent=2)
    os.replace(tmp, status_path)


def fmt_msg(done: int, total: int) -> str:
    mib = done / (1024 * 1024)
    if total > 0:
        tm = total / (1024 * 1024)
        return f'Verifying SHA256 ({mib:.1f} / {tm:.1f} MiB)'
    return f'Verifying SHA256 ({mib:.1f} MiB)'


def main():
    # Read checksum file
    try:
        txt = read_text(checksum_path)
    except Exception as e:
        print(f'error: cannot read checksum file: {e}')
        return 9

    expected = ''
    if kind == 'manifest':
        expected = pick_expected_from_manifest(txt, asset_name)
    else:
        expected = pick_expected_from_sidecar(txt)

    if not expected:
        # no entry for file
        try:
            total = os.path.getsize(tarball)
        except Exception:
            total = 0
        write_status_patch({
            'state': 'running',
            'step': 'verify',
            'message': 'Checksum has no entry for asset',
            'progress': {
                'phase': 'verify',
                'label': 'sha256',
                'bytes_done': 0,
                'bytes_total': total,
                'pct': 0,
            }
        })
        print('skip: no hash entry for asset')
        return 3

    # Hash tarball with progress
    h = hashlib.sha256()
    try:
        total = os.path.getsize(tarball)
    except Exception:
        total = 0

    start = time.time()
    last_emit = 0.0
    last_bytes = 0
    last_t = start
    done = 0

    write_status_patch({
        'state': 'running',
        'step': 'verify',
        'message': 'Verifying SHA256',
        'progress': {
            'phase': 'verify',
            'label': 'sha256',
            'bytes_done': 0,
            'bytes_total': total,
            'pct': 0,
        }
    })

    try:
        with open(tarball, 'rb') as f:
            while True:
                b = f.read(1024 * 1024)
                if not b:
                    break
                h.update(b)
                done += len(b)

                now = time.time()
                emit = False
                if (now - last_emit) >= 0.35:
                    emit = True
                elif done - last_bytes >= 8 * 1024 * 1024:
                    emit = True

                if emit:
                    dt = max(1e-6, now - last_t)
                    speed = (done - last_bytes) / dt
                    eta = 0
                    if total and speed > 1:
                        eta = max(0, int((total - done) / speed))
                    pct = int((done / total) * 100) if total else 0
                    write_status_patch({
                        'message': fmt_msg(done, total),
                        'progress': {
                            'phase': 'verify',
                            'label': 'sha256',
                            'bytes_done': done,
                            'bytes_total': total,
                            'pct': pct,
                            'speed_bps': speed,
                            'eta_sec': eta,
                        }
                    })
                    last_emit = now
                    last_bytes = done
                    last_t = now

    except Exception as e:
        print(f'error: cannot hash tarball: {e}')
        return 9

    actual = h.hexdigest().lower()

    # Final progress
    pct = 100 if total and done >= total else (int((done / total) * 100) if total else 0)
    write_status_patch({
        'message': fmt_msg(done, total),
        'progress': {
            'phase': 'verify',
            'label': 'sha256',
            'bytes_done': done,
            'bytes_total': total,
            'pct': pct,
        }
    })

    if actual == expected.lower():
        print('ok')
        return 0

    print(f'mismatch expected={expected.lower()} actual={actual}')
    return 5


if __name__ == '__main__':
    sys.exit(main())

PY
)" || rc=$?; rc=${rc:-0}

    if [ "$rc" -eq 0 ]; then
      log "[*] SHA256 OK"
    elif [ "$rc" -eq 3 ]; then
      if [ "$SHA_STRICT" = "1" ]; then
        log "[!] Checksum файл найден, но в нём нет строки для $ASSET_NAME (strict mode)"
        write_status "failed" "verify" "Checksum has no entry for asset" "checksum entry missing"
        exit 6
      else
        log "[!] Checksum файл найден, но в нём нет строки для $ASSET_NAME; проверку пропускаем"
      fi
    elif [ "$rc" -eq 5 ]; then
      log "[!] SHA256 mismatch: $VERIFY_OUT"
      write_status "failed" "verify" "SHA256 mismatch" "sha256 mismatch"
      exit 6
    else
      log "[!] Verify error (rc=$rc): $VERIFY_OUT"
      log "[!] Проверку SHA256 пропускаем"
    fi
  else
    log "[!] Failed to download checksum"
    if [ "$SHA_STRICT" = "1" ] && [ "$CHANNEL" = "stable" ]; then
      write_status "failed" "verify" "Checksum download failed" "checksum download failed"
      exit 6
    else
      log "[!] Проверку SHA256 пропускаем"
    fi
  fi
else
  log "[*] checksum not provided; skip verify"
fi


# 5) Extract
write_status "running" "extract" "Extracting archive"
log "[*] Extracting tarball..."
TAR_CHECK_OUT="$(tar_safe_check "$TARBALL" 2>&1)" || TAR_CHECK_RC=$?; TAR_CHECK_RC=${TAR_CHECK_RC:-0}
if [ "$TAR_CHECK_RC" -ne 0 ]; then
  log "[!] Unsafe or invalid archive: $TAR_CHECK_OUT"
  write_status "failed" "extract" "Unsafe archive" "unsafe archive"
  exit 7
fi
if ! "$PY" - "$TARBALL" "$WORK_DIR" "$STATUS_FILE" 2>>"$LOG_FILE" <<'PY'
import json
import os
import sys
import tarfile
import time
import tempfile


tarball = sys.argv[1]
dest = sys.argv[2]
status_path = sys.argv[3]


def read_status():
    try:
        with open(status_path, 'r', encoding='utf-8') as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def write_patch(patch: dict):
    d = read_status()
    if not isinstance(d, dict):
        d = {}
    d.update(patch)
    d.setdefault('state', 'running')
    d.setdefault('step', 'extract')
    now = time.time()
    d.setdefault('created_ts', now)
    d.setdefault('started_ts', now)
    d['updated_ts'] = now
    tmp = status_path + '.tmp'
    os.makedirs(os.path.dirname(status_path) or '.', exist_ok=True)
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(d, f, ensure_ascii=False, indent=2)
    os.replace(tmp, status_path)


def bad_path(name: str) -> bool:
    if not name:
        return True
    if name.startswith('/') or name.startswith('\\'):
        return True
    norm = os.path.normpath(name)
    if norm == '..' or norm.startswith('..' + os.sep):
        return True
    parts = norm.replace('\\', '/').split('/')
    if '..' in parts:
        return True
    return False


def safe_join(base: str, name: str) -> str:
    base = os.path.realpath(base)
    out = os.path.normpath(os.path.join(base, name))
    if out == base:
        return out
    if not out.startswith(base + os.sep):
        raise RuntimeError('bad_member_path')
    return out


def ensure_no_symlink_parent(path: str, base: str):
    base = os.path.realpath(base)
    path = os.path.realpath(os.path.dirname(path))
    if path == base:
        return
    rel = os.path.relpath(path, base)
    parts = [] if rel in ('.', '') else rel.split(os.sep)
    cur = base
    for part in parts:
        cur = os.path.join(cur, part)
        try:
            if os.path.islink(cur):
                raise RuntimeError('symlink_traversal')
        except OSError:
            # if we can't stat - treat as unsafe
            raise RuntimeError('symlink_check_failed')


def apply_attrs(path: str, m: tarfile.TarInfo):
    try:
        mode = int(m.mode or 0) & 0o7777
        if mode:
            os.chmod(path, mode)
    except Exception:
        pass
    try:
        mt = float(m.mtime or 0)
        if mt > 0:
            os.utime(path, (mt, mt), follow_symlinks=False)
    except Exception:
        # follow_symlinks may not exist on older builds
        try:
            mt = float(m.mtime or 0)
            if mt > 0:
                os.utime(path, (mt, mt))
        except Exception:
            pass


# Begin
write_patch({'step': 'extract', 'message': 'Extracting archive', 'progress': {'phase': 'extract', 'label': 'extract', 'files_done': 0, 'files_total': 0, 'bytes_done': 0, 'bytes_total': 0, 'pct': 0}})

with tarfile.open(tarball, 'r:*') as tf:
    members = tf.getmembers()

    # Validate members
    for m in members:
        n = (m.name or '').strip()
        if bad_path(n):
            raise RuntimeError('bad_member:' + n)
        if m.issym() or m.islnk():
            ln = (m.linkname or '').strip()
            if bad_path(ln):
                raise RuntimeError('bad_link:' + n + '->' + ln)
        if m.ischr() or m.isblk() or m.isfifo() or m.isdev():
            raise RuntimeError('unsupported_type:' + n)

    files_total = 0
    bytes_total = 0
    for m in members:
        if m.isdir():
            continue
        if m.isfile():
            files_total += 1
            try:
                bytes_total += int(m.size or 0)
            except Exception:
                pass
        elif m.issym() or m.islnk():
            files_total += 1

    bytes_done = 0
    files_done = 0

    start = time.time()
    last_emit = 0.0
    last_bytes = 0
    last_files = 0
    last_t = start

    def emit(force: bool = False):
        global last_emit, last_bytes, last_files, last_t
        now = time.time()
        if not force and (now - last_emit) < 0.35:
            return

        # speed/eta based on bytes when possible, else on files
        speed = 0.0
        eta = 0
        pct = 0
        dt = max(1e-6, now - last_t)
        if bytes_total > 0:
            speed = (bytes_done - last_bytes) / dt
            if speed > 1:
                eta = max(0, int((bytes_total - bytes_done) / speed))
            pct = int((bytes_done / bytes_total) * 100) if bytes_total else 0
        elif files_total > 0:
            speed = (files_done - last_files) / dt
            if speed > 0:
                eta = max(0, int((files_total - files_done) / speed))
            pct = int((files_done / files_total) * 100)

        write_patch({
            'progress': {
                'phase': 'extract',
                'label': 'extract',
                'files_done': files_done,
                'files_total': files_total,
                'bytes_done': bytes_done,
                'bytes_total': bytes_total,
                'pct': pct,
                'speed_bps': speed,
                'eta_sec': eta,
            }
        })
        last_emit = now
        last_bytes = bytes_done
        last_files = files_done
        last_t = now

    # initial
    emit(force=True)

    for m in members:
        name = (m.name or '').strip()
        out_path = safe_join(dest, name)

        if m.isdir():
            os.makedirs(out_path, exist_ok=True)
            ensure_no_symlink_parent(out_path, dest)
            apply_attrs(out_path, m)
            continue

        parent = os.path.dirname(out_path)
        os.makedirs(parent, exist_ok=True)
        ensure_no_symlink_parent(out_path, dest)

        if m.issym():
            try:
                if os.path.lexists(out_path):
                    os.remove(out_path)
            except Exception:
                pass
            os.symlink(m.linkname, out_path)
            files_done += 1
            emit()
            continue

        if m.islnk():
            # hardlink to another path inside the archive
            target = safe_join(dest, m.linkname)
            ensure_no_symlink_parent(target, dest)
            try:
                if os.path.lexists(out_path):
                    os.remove(out_path)
            except Exception:
                pass
            os.link(target, out_path)
            files_done += 1
            emit()
            continue

        if m.isfile():
            fobj = tf.extractfile(m)
            if fobj is None:
                raise RuntimeError('cannot_extract:' + name)

            fd, tmp_path = tempfile.mkstemp(prefix='.xk_extract_', suffix='.tmp', dir=parent)
            try:
                with os.fdopen(fd, 'wb') as out:
                    while True:
                        buf = fobj.read(128 * 1024)
                        if not buf:
                            break
                        out.write(buf)
                        bytes_done += len(buf)
                        # emit more often for large files
                        if (bytes_done - last_bytes) >= 512 * 1024:
                            emit()
                os.replace(tmp_path, out_path)
            finally:
                try:
                    if os.path.exists(tmp_path):
                        os.remove(tmp_path)
                except Exception:
                    pass

            apply_attrs(out_path, m)
            files_done += 1
            emit()
            continue

    emit(force=True)

sys.exit(0)
PY
then
  log "[!] Failed to extract archive"
  write_status "failed" "extract" "Extract failed" "extract failed"
  exit 7
fi

INSTALL_SH="$(find_install_sh "$WORK_DIR")"
if [ -z "$INSTALL_SH" ] || [ ! -f "$INSTALL_SH" ]; then
  log "[!] install.sh не найден в распакованном архиве."
  write_status "failed" "extract" "install.sh not found" "install.sh not found"
  exit 7
fi

# 6) Install
write_status "running" "install" "Running install.sh"
log "[*] Running installer: $INSTALL_SH"

INSTALL_DIR="$(cd "$(dirname "$INSTALL_SH")" && pwd)"
(
  cd "$INSTALL_DIR"
  XKEEN_UI_UPDATE_REPO="$REPO" \
  XKEEN_UI_UPDATE_CHANNEL="$CHANNEL" \
  XKEEN_UI_UPDATE_BRANCH="${BRANCH:-}" \
  XKEEN_UI_VERSION="${TAG:-}" \
  XKEEN_UI_COMMIT="${COMMIT:-}" \
  sh "$INSTALL_SH"
) >>"$LOG_FILE" 2>&1 || {
  log "[!] install.sh failed"
  write_status "failed" "install" "install.sh failed" "install.sh failed"
  exit 8
}

# 7) Restart (best-effort)
write_status "running" "restart" "Restarting UI service"
if [ -x "/opt/etc/init.d/S99xkeen-ui" ]; then
  log "[*] Restarting service via init.d..."
  /opt/etc/init.d/S99xkeen-ui restart >>"$LOG_FILE" 2>&1 || true
else
  log "[*] init.d script not found; assume install.sh restarted service"
fi

# 8) Done
write_status "done" "done" "Update completed"
log "=== Xkeen-UI updater done ==="

exit 0

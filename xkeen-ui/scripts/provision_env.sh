#!/bin/sh
# Приведение окружения панели: работа, которая должна быть сделана после любой
# смены версии и лежит вне каталога панели — команды в /opt/bin, шаблоны,
# поправки совместимости.
#
# Файл подключается через `.`, а не запускается: install.sh вызывает его
# функции между шагами своего экрана. Здесь нет ни вопросов, ни рисования —
# только работа и строки для журнала (stdout вызывающего). Так ту же работу
# сможет выполнять обновление из панели, у которого терминала нет вовсе.
#
# Пути берутся из переменных вызывающего; значения ниже — для запуска без них.

: "${UI_DIR:=/opt/etc/xkeen-ui}"
: "${PYTHON_BIN:=/opt/bin/python3}"
PROVISION_BIN_DIR="${XKEEN_UI_BIN_DIR:-/opt/bin}"

# --- Команды в /opt/bin -----------------------------------------------------
# Утилиты панели лежат в $UI_DIR/tools. Чтобы их можно было вызвать по имени из
# терминала, в /opt/bin кладётся короткая обёртка. Утилиты нет (её модуль не
# установлен) — нет и команды.

provision_command_wrapper() {
  _pw_command="$1"
  _pw_source="$UI_DIR/tools/$2"
  _pw_target="$PROVISION_BIN_DIR/$_pw_command"

  if [ ! -f "$_pw_source" ]; then
    echo "[*] $_pw_command: скрипт не найден в $_pw_source (пропуск)"
    return 0
  fi

  echo "[*] Устанавливаю $_pw_command в $_pw_target..."
  {
    printf '%s\n' '#!/bin/sh'
    printf 'SCRIPT="%s"\n' "$_pw_source"
    printf '%s\n' 'if [ ! -f "$SCRIPT" ]; then'
    printf '  echo "%s: script not found: $SCRIPT" >&2\n' "$_pw_command"
    printf '%s\n' '  exit 127'
    printf '%s\n' 'fi'
    printf '%s\n' 'exec sh "$SCRIPT" "$@"'
  } > "$_pw_target"
  chmod +x "$_pw_target" 2>/dev/null || true
  chmod +x "$_pw_source" 2>/dev/null || true
}

provision_command_wrappers() {
  provision_command_wrapper sysmon sysmon_keenetic.sh
  provision_command_wrapper entware-backup entware_backup.sh
  provision_command_wrapper storage-dashboard storage_dashboard.sh

  # io-monitor из панели убран: снимаем и команду, и её скрипт.
  if [ -f "$PROVISION_BIN_DIR/io-monitor" ] || [ -f "$UI_DIR/tools/io_monitor.sh" ]; then
    echo "[*] Удаляю legacy io-monitor..."
    rm -f "$PROVISION_BIN_DIR/io-monitor" "$UI_DIR/tools/io_monitor.sh" 2>/dev/null || true
  fi

  provision_command_wrapper device-locks device_lock_detector.sh
  provision_command_wrapper memory-check memory_check.sh
  provision_command_wrapper version-check version_check.sh
  provision_command_wrapper backup-monitor backup_monitor.sh
}

# --- Шаблоны ----------------------------------------------------------------

same_ignoring_cr() {
  # Локальный архив, собранный на Windows, везёт шаблоны с CRLF, релизный — с LF.
  # Такая разница — не правка пользователя, и копия под неё не нужна.
  [ -f "$1" ] && [ -f "$2" ] || return 1
  [ "$(tr -d '\r' < "$1" | md5sum | cut -d' ' -f1)" = "$(tr -d '\r' < "$2" | md5sum | cut -d' ' -f1)" ]
}

sync_bundled_template_dir() {
  src_dir="$1"
  dest_dir="$2"
  label="$3"

  if [ ! -d "$src_dir" ]; then
    echo "[*] Шаблоны $label не найдены в архиве (пропуск)"
    return 0
  fi

  echo "[*] Устанавливаю шаблоны $label в $dest_dir..."
  mkdir -p "$dest_dir"

  if command -v date >/dev/null 2>&1; then
    TS="$(date +%Y%m%d-%H%M%S 2>/dev/null || date 2>/dev/null || echo "no-date")"
  else
    TS="no-date"
  fi

  for f in "$src_dir"/*.json "$src_dir"/*.jsonc; do
    [ -f "$f" ] || continue
    base="$(basename "$f")"
    dest="$dest_dir/$base"

    if [ -f "$dest" ] && cmp -s "$f" "$dest" 2>/dev/null; then
      continue
    fi

    if same_ignoring_cr "$f" "$dest"; then
      :
    elif [ -f "$dest" ]; then
      cp -f "$dest" "$dest.dist-$TS" 2>/dev/null || true
      echo "[*] ~ обновляю built-in шаблон $base (backup: $base.dist-$TS)"
    else
      echo "[*] + $base"
    fi

    cp -f "$f" "$dest"
  done
}

cleanup_legacy_xray_templates() {
  # Некоторые версии xkeen/xray могут подхватывать *.jsonc из /opt/etc/xray (recursive scan)
  # и из-за этого зависать/не стартовать. Начиная с этого релиза шаблоны живут в $UI_DIR/templates/*.
  # Поэтому аккуратно убираем ТОЛЬКО наши встроенные шаблоны из /opt/etc/xray/templates/*.

  LEGACY_ROOT="${1:-/opt/etc/xray/templates}"
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

provision_mihomo_templates() {
  # $1 — откуда брать шаблоны (архив или каталог панели), $2 — куда класть.
  _pm_src="$1"
  _pm_dest="$2"

  echo "[*] Устанавливаю шаблон Mihomo в $_pm_dest..."
  mkdir -p "$_pm_dest"

  for old in config_2.yaml umarcheh001.yaml; do
    if [ -f "$_pm_dest/$old" ]; then
      rm -f "$_pm_dest/$old" && echo "[*] Удалён старый шаблон $old"
    fi
  done

  for _pm_name in custom.yaml zkeen.yaml; do
    if [ -f "$_pm_src/$_pm_name" ]; then
      cp -f "$_pm_src/$_pm_name" "$_pm_dest/$_pm_name"
      echo "[*] Установлен шаблон $_pm_name в $_pm_dest"
    else
      echo "[!] Не найден шаблон $_pm_name в $_pm_src"
    fi
  done

  # HWID subscription template (из внешнего проекта)
  if [ -f "$_pm_src/template.yaml" ]; then
    cp -f "$_pm_src/template.yaml" "$_pm_dest/template.yaml"
    rm -f "$_pm_dest/hwid_subscription_template.yaml"
    echo "[*] Установлен шаблон template.yaml в $_pm_dest"
  fi
}

# --- Совместимость ----------------------------------------------------------

provision_xray_dat_links() {
  # В шаблонах и правилах панели используется синтаксис ext:<имя>.dat:<список>.
  # Xray ищет такой файл рядом со своим бинарником, а панель хранит DAT в
  # отдельном каталоге — поэтому рядом с ядром кладутся ссылки.
  # $1 — каталог DAT, $2 — каталог ядра.
  _pd_dat="$1"
  _pd_bin="$2"

  [ -d "$_pd_dat" ] && [ -d "$_pd_bin" ] || return 0

  echo "[*] Xray DAT: создаю symlink *.dat из $_pd_dat в $_pd_bin (для ext:... )"
  for f in "$_pd_dat"/*.dat; do
    # Resolve symlinks in dat dir so /opt/sbin points to the real file.
    # (BusyBox usually supports `readlink -f`, but keep fallback.)
    src="$f"
    if command -v readlink >/dev/null 2>&1; then
      src="$(readlink -f "$f" 2>/dev/null || echo "$f")"
    fi
    [ -f "$src" ] || continue
    base="$(basename "$f")"
    # Не затираем реальные файлы (на всякий случай), только ссылки.
    if [ -e "$_pd_bin/$base" ] && [ ! -L "$_pd_bin/$base" ]; then
      continue
    fi
    ln -sf "$src" "$_pd_bin/$base" 2>/dev/null || true
  done
}

provision_routing_compat() {
  # Некоторые GeoSite датасеты (например v2fly) не содержат отдельных списков типа whatsapp-ads.
  # Если такие строки попали в /opt/etc/xray/configs/05_routing*.json, Xray не стартует.
  # В старых версиях панели этого списка не было. Исправляем мягко и только точечно.
  # $1 — файл routing.
  _pr_file="$1"

  [ -n "$_pr_file" ] && [ -f "$_pr_file" ] || return 0
  grep -q 'ext:geosite_v2fly.dat:whatsapp-ads' "$_pr_file" 2>/dev/null || return 0

  echo "[*] Compat: удаляю ext:geosite_v2fly.dat:whatsapp-ads из $_pr_file (иначе Xray не стартует)"
  ROUTING_FILE="$_pr_file" "$PYTHON_BIN" - <<'PYFIX' || true
import json, os, sys
path = os.environ.get('ROUTING_FILE')
if not path or not os.path.exists(path):
    sys.exit(0)
try:
    raw = open(path, 'r', encoding='utf-8', errors='replace').read()
    data = json.loads(raw)
except Exception:
    # The file is not plain JSON (or has comments): leave it alone.
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
}

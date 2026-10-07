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

# --- BUILD.json -------------------------------------------------------------
# Небольшой файл с метаданными сборки: его показывает DevTools и по нему панель
# решает, есть ли обновление.

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

extract_json_bare() {
  # extract "field": <literal> (true/false/null/number) — values without quotes
  _field="$1"
  _file="$2"
  [ -f "$_file" ] || return 0
  grep -o "\"$_field\"[[:space:]]*:[[:space:]]*[A-Za-z0-9._-]*" "$_file" 2>/dev/null \
    | head -n 1 \
    | sed -E 's/.*:[[:space:]]*//' \
    || true
}

provision_build_json() {
  # $1 — BUILD.json устанавливаемой сборки (штамп кладёт build_user_archive.py),
  # $2 — BUILD.json установленной панели, он же переписывается.
  #
  # Штамп — версия, коммит, сумма дерева — принадлежит сборке и берётся из неё.
  # Раскладка файлов этот файл не кладёт: он не принадлежит ни одному модулю,
  # и без чтения из архива панель продолжала бы называть себя прежней версией.
  # Репозиторий и канал обновлений выбирает владелец — они берутся из панели.
  #
  # base_commit — коммит, с которого началась упаковка, а не тот, что внутри архива:
  # релиз собирается ДО коммита, поэтому рабочее дерево обычно уже впереди. В таком
  # случае dirty=true, commit не заполняется, а version несёт суффикс -dirty.
  # Опознать сборку точно можно только по tree_sha256.
  #
  # Параметры можно передать через окружение (например, при сборке релиза):
  #   XKEEN_UI_UPDATE_REPO, XKEEN_UI_UPDATE_CHANNEL, XKEEN_UI_VERSION, XKEEN_UI_COMMIT
  _pb_target="$2"
  _pb_stamp="$1"
  [ -f "$_pb_stamp" ] || _pb_stamp="$_pb_target"

  _pb_version="$(extract_json_field version "$_pb_stamp")"
  _pb_commit="$(extract_json_field commit "$_pb_stamp")"
  _pb_base_commit="$(extract_json_field base_commit "$_pb_stamp")"
  _pb_tree_sha="$(extract_json_field tree_sha256 "$_pb_stamp")"
  _pb_dirty="$(extract_json_bare dirty "$_pb_stamp")"
  _pb_repo="$(extract_json_field repo "$_pb_target")"
  _pb_channel="$(extract_json_field channel "$_pb_target")"

  _pb_repo="${XKEEN_UI_UPDATE_REPO:-${_pb_repo:-umarcheh001/Xkeen-UI}}"
  _pb_channel="${XKEEN_UI_UPDATE_CHANNEL:-${_pb_channel:-stable}}"
  _pb_version="${XKEEN_UI_VERSION:-$_pb_version}"
  _pb_commit="${XKEEN_UI_COMMIT:-$_pb_commit}"
  case "$_pb_dirty" in
    true|false) ;;
    *)          _pb_dirty="" ;;
  esac
  _pb_utc="$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date +"%Y-%m-%dT%H:%M:%SZ")"

  _pb_tmp="$(dirname "$_pb_target")/.BUILD.json.tmp"
  {
    echo "{"
    echo "  \"repo\": \"$(json_escape "$_pb_repo")\","
    echo "  \"channel\": \"$(json_escape "$_pb_channel")\","
    if [ -n "$_pb_version" ]; then
      echo "  \"version\": \"$(json_escape "$_pb_version")\","
    else
      echo "  \"version\": null,"
    fi
    if [ -n "$_pb_commit" ]; then
      echo "  \"commit\": \"$(json_escape "$_pb_commit")\","
    else
      echo "  \"commit\": null,"
    fi
    if [ -n "$_pb_base_commit" ]; then
      echo "  \"base_commit\": \"$(json_escape "$_pb_base_commit")\","
    else
      echo "  \"base_commit\": null,"
    fi
    if [ -n "$_pb_dirty" ]; then
      echo "  \"dirty\": $_pb_dirty,"
    else
      echo "  \"dirty\": null,"
    fi
    if [ -n "$_pb_tree_sha" ]; then
      echo "  \"tree_sha256\": \"$(json_escape "$_pb_tree_sha")\","
    else
      echo "  \"tree_sha256\": null,"
    fi
    echo "  \"built_utc\": \"$(json_escape "$_pb_utc")\","
    echo "  \"source\": \"install.sh\","
    echo "  \"artifact\": null"
    echo "}"
  } > "$_pb_tmp" 2>/dev/null || true

  if [ -s "$_pb_tmp" ]; then
    mv -f "$_pb_tmp" "$_pb_target" 2>/dev/null || true
  fi
}

# --- Служба автозапуска -----------------------------------------------------

provision_init_script() {
  # $1 — текст службы (scripts/panel_init.sh), $2 — куда ставить, $3 — порт панели.
  #
  # Прежняя служба заменяется одним переименованием: что бы ни случилось
  # посреди записи, в init.d лежит либо прежний скрипт целиком, либо новый.
  # Ошибка здесь не глотается — без службы панель не переживёт перезагрузку.
  _pi_template="$1"
  _pi_target="$2"
  _pi_port="$3"
  _pi_new="$_pi_target.xk-new"

  if [ ! -f "$_pi_template" ]; then
    echo "[!] Не найден текст службы автозапуска: $_pi_template"
    return 1
  fi
  case "$_pi_port" in
    ''|*[!0-9]*)
      echo "[!] Порт панели для службы автозапуска не задан: '$_pi_port'"
      return 1
      ;;
  esac

  if ! sed "s/__XKEEN_UI_PORT__/$_pi_port/g" "$_pi_template" > "$_pi_new" || [ ! -s "$_pi_new" ]; then
    rm -f "$_pi_new" 2>/dev/null || true
    echo "[!] Не удалось подготовить службу автозапуска $_pi_target"
    return 1
  fi
  chmod +x "$_pi_new"
  if ! mv -f "$_pi_new" "$_pi_target"; then
    rm -f "$_pi_new" 2>/dev/null || true
    return 1
  fi
}

# --- Пакеты Entware ---------------------------------------------------------
# `opkg update` качает списки пакетов с зеркала из настроек роутера и ждёт его
# без ограничения. Зеркало, которое то отвечает, то нет, подвешивало установку
# на десять минут без единой строки на экране. Здесь у запроса есть предел
# времени, а если зеркало не ответило — списки берутся один раз с официального
# источника через временный файл настроек. Настройки роутера не меняются.
#
#   XKEEN_OPKG_UPDATE_TIMEOUT — предел ожидания, секунд (по умолчанию 120)
#   XKEEN_OPKG_FALLBACK=0     — не обращаться к официальному источнику
#   XKEEN_OPKG_CONF           — файл настроек opkg (по умолчанию /opt/etc/opkg.conf)

PROVISION_OPKG_OFFICIAL="${XKEEN_OPKG_OFFICIAL_URL:-http://bin.entware.net}"
PROVISION_OPKG_CONF=""
PROVISION_OPKG_TMP=""
PROVISION_ERROR=""

provision_fail() {
  # Причина остановки для того, кто вызвал: он решает, как её показать.
  PROVISION_ERROR="$1"
  echo "[!] $1"
}

provision_kill_children() {
  # Снять процессы, запущенные процессом $1. На роутере нет ни pkill, ни
  # `ps -o`, поэтому родитель читается из /proc/<pid>/stat: после имени в
  # скобках идут состояние и номер родителя.
  _pk_parent="$1"
  for _pk_stat in /proc/[0-9]*/stat; do
    [ -r "$_pk_stat" ] || continue
    _pk_line="$(cat "$_pk_stat" 2>/dev/null)" || continue
    _pk_child="${_pk_line%% *}"
    _pk_after_name="${_pk_line##*) }"
    _pk_ppid="${_pk_after_name#* }"
    _pk_ppid="${_pk_ppid%% *}"
    [ "$_pk_ppid" = "$_pk_parent" ] || continue
    # opkg запускает wget через оболочку: снимать надо и внуков. В подоболочке,
    # чтобы вложенный обход не затёр переменные этого.
    ( provision_kill_children "$_pk_child" )
    kill "$_pk_child" 2>/dev/null || true
  done
}

provision_run_limited() {
  # $1 — предел в секундах, дальше команда. Код 124 — не уложилась в срок.
  _pl_limit="$1"
  shift
  "$@" &
  _pl_pid=$!
  _pl_waited=0
  while kill -0 "$_pl_pid" 2>/dev/null; do
    if [ "$_pl_waited" -ge "$_pl_limit" ]; then
      # Сначала те, кого команда запустила сама: opkg ждёт свой wget, и без
      # этого тот остался бы висеть до собственного предела.
      # Команду сперва замораживаем: иначе, пока снимается один её потомок,
      # она успевает запустить следующего (opkg переходит к следующему
      # источнику), и тот остаётся сиротой.
      kill -STOP "$_pl_pid" 2>/dev/null || true
      provision_kill_children "$_pl_pid"
      kill "$_pl_pid" 2>/dev/null || true
      kill -CONT "$_pl_pid" 2>/dev/null || true
      sleep 1
      kill -9 "$_pl_pid" 2>/dev/null || true
      wait "$_pl_pid" 2>/dev/null || true
      return 124
    fi
    sleep 1
    _pl_waited=$((_pl_waited + 1))
  done
  wait "$_pl_pid"
}

provision_opkg() {
  # opkg с тем источником, который ответил на provision_opkg_update.
  if [ -n "$PROVISION_OPKG_CONF" ]; then
    "$OPKG_BIN" -f "$PROVISION_OPKG_CONF" "$@"
  else
    "$OPKG_BIN" "$@"
  fi
}

provision_opkg_sources() {
  # Откуда opkg берёт пакеты — для сообщения, которое поймёт владелец роутера.
  sed -n 's/^src\/gz[[:space:]][[:space:]]*[^[:space:]]*[[:space:]][[:space:]]*//p' "$1" 2>/dev/null | tr '\n' ' '
}

provision_opkg_official_conf() {
  # $1 — настройки роутера, $2 — куда записать те же настройки с официальным
  # источником. Каталог архитектуры (aarch64-k3.10, mipsel-k3.4 …) и всё за ним
  # остаются как есть: меняется только то, что стоит перед ними.
  _pc_source="$1"
  _pc_target="$2"
  _pc_lists="$(dirname "$_pc_target")/lists"
  mkdir -p "$_pc_lists" || return 1
  sed -E \
    -e "s#^(src/gz[[:space:]]+[^[:space:]]+[[:space:]]+)[a-z]+://.*/((aarch64|armv5|armv7|mips|mipsel|x64)[^/[:space:]]*-k[0-9.]+(/[^[:space:]]*)?)[[:space:]]*\$#\\1$PROVISION_OPKG_OFFICIAL/\\2#" \
    -e "s#^lists_dir[[:space:]]+([^[:space:]]+)[[:space:]]+.*\$#lists_dir \\1 $_pc_lists#" \
    "$_pc_source" > "$_pc_target" || return 1
  grep -q "^src/gz[[:space:]].*$PROVISION_OPKG_OFFICIAL/" "$_pc_target"
}

provision_file_mtime() {
  date -r "$1" +%s 2>/dev/null || stat -c %Y "$1" 2>/dev/null || echo 0
}

provision_opkg_main_list_fresh() {
  # $1 — настройки opkg, $2 — время (секунды), раньше которого список старый.
  # Получен ли список основного источника — первого `src/gz` в настройках.
  #
  # Код возврата `opkg update` на это не отвечает: он ненулевой, если не
  # ответил ЛЮБОЙ источник, включая сторонние, которые владелец добавил рядом
  # (на роутерах встречаются источники по https, которых wget прошивки не
  # умеет). Основной список при этом получен, и пакеты ставить можно.
  _pm_conf="$1"
  _pm_since="$2"
  _pm_name="$(sed -n 's/^src\/gz[[:space:]][[:space:]]*\([^[:space:]]*\)[[:space:]].*/\1/p' "$_pm_conf" 2>/dev/null | head -n 1)"
  _pm_dir="$(sed -n 's/^lists_dir[[:space:]][[:space:]]*[^[:space:]]*[[:space:]][[:space:]]*\([^[:space:]]*\).*/\1/p' "$_pm_conf" 2>/dev/null | head -n 1)"
  [ -n "$_pm_name" ] && [ -n "$_pm_dir" ] || return 1
  [ -s "$_pm_dir/$_pm_name" ] || return 1
  [ "$(provision_file_mtime "$_pm_dir/$_pm_name")" -ge "$_pm_since" ]
}

provision_opkg_update() {
  # Обновить списки пакетов. 0 — списки есть (с зеркала роутера или с
  # официального источника, тогда PROVISION_OPKG_CONF указывает на временные
  # настройки и provision_opkg ими пользуется).
  _pu_conf="${XKEEN_OPKG_CONF:-/opt/etc/opkg.conf}"
  _pu_limit="${XKEEN_OPKG_UPDATE_TIMEOUT:-120}"
  case "$_pu_limit" in
    ''|*[!0-9]*) _pu_limit=120 ;;
  esac

  PROVISION_OPKG_CONF=""
  _pu_status=0
  _pu_started="$(date +%s 2>/dev/null || echo 0)"
  provision_run_limited "$_pu_limit" "$OPKG_BIN" update || _pu_status=$?
  [ "$_pu_status" -eq 0 ] && return 0
  if provision_opkg_main_list_fresh "$_pu_conf" "$_pu_started"; then
    echo "[*] Часть источников пакетов не ответила, но основной список Entware получен."
    return 0
  fi

  _pu_sources="$(provision_opkg_sources "$_pu_conf")"
  if [ "$_pu_status" -eq 124 ]; then
    echo "[!] Источник пакетов Entware не ответил за $_pu_limit с: $_pu_sources"
  else
    echo "[!] Не удалось получить список пакетов Entware (код $_pu_status): $_pu_sources"
  fi

  if [ "${XKEEN_OPKG_FALLBACK:-1}" = "0" ]; then
    echo "[*] Обращение к официальному источнику Entware отключено (XKEEN_OPKG_FALLBACK=0)."
    return 1
  fi
  if [ ! -f "$_pu_conf" ] || grep -q "^src/gz[[:space:]].*$PROVISION_OPKG_OFFICIAL/" "$_pu_conf" 2>/dev/null; then
    # Это и был официальный источник: второй раз спрашивать некого.
    return 1
  fi

  PROVISION_OPKG_TMP="${TMPDIR:-/tmp}/xkeen-opkg-$$"
  rm -rf "$PROVISION_OPKG_TMP" 2>/dev/null || true
  if ! mkdir -p "$PROVISION_OPKG_TMP" || ! provision_opkg_official_conf "$_pu_conf" "$PROVISION_OPKG_TMP/opkg.conf"; then
    provision_opkg_cleanup
    return 1
  fi

  echo "[*] Беру список пакетов с официального источника $PROVISION_OPKG_OFFICIAL (настройки роутера не меняются)..."
  _pu_status=0
  _pu_started="$(date +%s 2>/dev/null || echo 0)"
  provision_run_limited "$_pu_limit" "$OPKG_BIN" -f "$PROVISION_OPKG_TMP/opkg.conf" update || _pu_status=$?
  if [ "$_pu_status" -ne 0 ] && ! provision_opkg_main_list_fresh "$PROVISION_OPKG_TMP/opkg.conf" "$_pu_started"; then
    echo "[!] Официальный источник Entware тоже не ответил."
    provision_opkg_cleanup
    return 1
  fi
  PROVISION_OPKG_CONF="$PROVISION_OPKG_TMP/opkg.conf"
  return 0
}

provision_opkg_cleanup() {
  [ -n "$PROVISION_OPKG_TMP" ] && rm -rf "$PROVISION_OPKG_TMP" 2>/dev/null || true
  PROVISION_OPKG_TMP=""
  PROVISION_OPKG_CONF=""
}

# --- Библиотеки Python ------------------------------------------------------
# Панели нужны flask и cryptography; gevent — по возможности (без него нет
# WebSocket, панель работает через опрос). Сначала пакеты Entware: они собраны
# под каждую архитектуру роутеров; затем pip с запасными индексами.

PIP_PRIMARY_INDEX_DEFAULT="https://pypi.org/simple"
PIP_FALLBACK_INDEX_DEFAULT="https://mirrors.aliyun.com/pypi/simple/"
PIP_HTTP_FALLBACK_INDEX_DEFAULT="http://mirrors.aliyun.com/pypi/simple/"
PIP_HTTP_EXTRA_INDEX_DEFAULT="http://mirror.yandex.ru/pypi/simple/"
PIP_TRUSTED_HOSTS_DEFAULT="mirrors.aliyun.com mirror.yandex.ru"
PIP_REPAIR_ATTEMPTED=0

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

python_ssl_available() {
  [ -x "$PYTHON_BIN" ] || return 1
  "$PYTHON_BIN" -c "import ssl" >/dev/null 2>&1
}

build_pip_index_candidates() {
  PIP_INDEX_CANDIDATES=""
  append_pip_index_candidate "${XKEEN_PIP_INDEX_URL:-}"
  if python_ssl_available; then
    append_pip_index_candidate "$PIP_PRIMARY_INDEX_DEFAULT"
    append_pip_index_candidate "${XKEEN_PIP_FALLBACK_INDEX_URL:-$PIP_FALLBACK_INDEX_DEFAULT}"
  else
    append_pip_index_candidate "${XKEEN_PIP_HTTP_INDEX_URL:-$PIP_HTTP_FALLBACK_INDEX_DEFAULT}"
    append_pip_index_candidate "${XKEEN_PIP_HTTP_EXTRA_INDEX_URL:-$PIP_HTTP_EXTRA_INDEX_DEFAULT}"
    append_pip_index_candidate "${XKEEN_PIP_FALLBACK_INDEX_URL:-}"
  fi
}

append_pip_trusted_host_candidate() {
  HOST="$1"
  [ -n "$HOST" ] || return 0

  case "$HOST" in
    *[!A-Za-z0-9._-]*) return 0 ;;
  esac

  case " $PIP_TRUSTED_HOST_CANDIDATES " in
    *" $HOST "*) return 0 ;;
  esac

  if [ -n "${PIP_TRUSTED_HOST_CANDIDATES:-}" ]; then
    PIP_TRUSTED_HOST_CANDIDATES="$PIP_TRUSTED_HOST_CANDIDATES $HOST"
  else
    PIP_TRUSTED_HOST_CANDIDATES="$HOST"
  fi
}

pip_index_host() {
  URL="$1"
  case "$URL" in
    http://*|https://*)
      HOST="${URL#*://}"
      HOST="${HOST%%/*}"
      HOST="${HOST%%:*}"
      echo "$HOST"
      ;;
  esac
}

build_pip_trusted_host_candidates() {
  PIP_TRUSTED_HOST_CANDIDATES=""
  HAS_HTTP_PIP_INDEX=0

  if [ -n "${XKEEN_PIP_TRUSTED_HOSTS:-}" ]; then
    for HOST in $XKEEN_PIP_TRUSTED_HOSTS; do
      append_pip_trusted_host_candidate "$HOST"
    done
  fi

  for INDEX_URL in $PIP_INDEX_CANDIDATES; do
    case "$INDEX_URL" in
      http://*)
        HAS_HTTP_PIP_INDEX=1
        append_pip_trusted_host_candidate "$(pip_index_host "$INDEX_URL")"
        ;;
    esac
  done

  if [ "$HAS_HTTP_PIP_INDEX" -eq 1 ]; then
    for HOST in $PIP_TRUSTED_HOSTS_DEFAULT; do
      append_pip_trusted_host_candidate "$HOST"
    done
  fi
}

build_pip_trusted_host_args() {
  build_pip_trusted_host_candidates
  PIP_TRUSTED_HOST_ARGS=""
  for HOST in $PIP_TRUSTED_HOST_CANDIDATES; do
    PIP_TRUSTED_HOST_ARGS="$PIP_TRUSTED_HOST_ARGS --trusted-host $HOST"
  done
}

print_pip_index_candidates() {
  build_pip_index_candidates
  echo "[*] pip index fallback order: $PIP_INDEX_CANDIDATES"
  build_pip_trusted_host_candidates
  if [ -n "${PIP_TRUSTED_HOST_CANDIDATES:-}" ]; then
    echo "[*] pip trusted-host fallback: $PIP_TRUSTED_HOST_CANDIDATES"
  fi
}

ensure_opkg_bin() {
  if [ -n "${OPKG_BIN:-}" ] && [ -x "$OPKG_BIN" ]; then
    return 0
  fi

  if command -v opkg >/dev/null 2>&1; then
    OPKG_BIN="$(command -v opkg)"
    return 0
  fi

  if [ -x "/opt/bin/opkg" ]; then
    OPKG_BIN="/opt/bin/opkg"
    return 0
  fi

  return 1
}

repair_python3_pip_package() {
  REPAIR_REASON="$1"

  if [ "${PIP_REPAIR_ATTEMPTED:-0}" -eq 1 ]; then
    echo "[!] Ремонт python3-pip уже выполнялся, повторно не запускаю."
    return 1
  fi
  PIP_REPAIR_ATTEMPTED=1

  if ! ensure_opkg_bin; then
    echo "[!] Не найден opkg для автоматического ремонта python3-pip."
    return 1
  fi

  echo "[!] python3-pip выглядит поврежденным: $REPAIR_REASON"
  echo "[*] Автоматический ремонт: opkg remove python3-pip -> opkg update -> opkg install python3-pip..."
  "$OPKG_BIN" remove python3-pip >/dev/null 2>&1 || true
  provision_opkg_update >/dev/null 2>&1 || true
  if ! provision_opkg install python3-pip; then
    echo "[!] Не удалось переустановить python3-pip через opkg."
    return 1
  fi

  if ! "$PYTHON_BIN" -m pip --version >/dev/null 2>&1; then
    echo "[!] python3-pip переустановлен, но модуль pip всё ещё недоступен из $PYTHON_BIN."
    return 1
  fi

  echo "[*] python3-pip успешно восстановлен."
  return 0
}

pip_failure_needs_repair() {
  PIP_ERROR_LOG="$1"
  [ -f "$PIP_ERROR_LOG" ] || return 1

  # Entware can keep stale pip files after Python package upgrades. In that
  # state `pip --version` may work, but every network install crashes while
  # building the SSL truststore/certifi context.
  grep -Fq "load_verify_locations(certifi.where())" "$PIP_ERROR_LOG" && return 0
  grep -Fq "/pip/_vendor/truststore/" "$PIP_ERROR_LOG" && return 0
  grep -Fq "No module named 'pip'" "$PIP_ERROR_LOG" && return 0
  grep -Fq 'No module named "pip"' "$PIP_ERROR_LOG" && return 0
  return 1
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
  build_pip_trusted_host_args
  for INDEX_URL in $PIP_INDEX_CANDIDATES; do
    [ -n "$INDEX_URL" ] || continue

    echo "[*] [$PHASE] pip install через индекс: $INDEX_URL"
    PIP_LOG="${TMPDIR:-/tmp}/xkeen-pip-$PHASE-$$.log"
    rm -f "$PIP_LOG" 2>/dev/null || true

    if "$PYTHON_BIN" -m pip install \
      --upgrade \
      --index-url "$INDEX_URL" \
      $PIP_TRUSTED_HOST_ARGS \
      --default-timeout "${XKEEN_PIP_TIMEOUT:-60}" \
      "$@" >"$PIP_LOG" 2>&1; then
      cat "$PIP_LOG"
      rm -f "$PIP_LOG" 2>/dev/null || true
      echo "[*] [$PHASE] pip install успешно через: $INDEX_URL"
      return 0
    else
      LAST_STATUS=$?
    fi

    cat "$PIP_LOG"
    if pip_failure_needs_repair "$PIP_LOG"; then
      if repair_python3_pip_package "pip падает при SSL truststore/certifi или модуль pip поврежден"; then
        echo "[*] [$PHASE] Повторяю pip install после ремонта python3-pip: $INDEX_URL"
        rm -f "$PIP_LOG" 2>/dev/null || true
        if "$PYTHON_BIN" -m pip install \
          --upgrade \
          --index-url "$INDEX_URL" \
          $PIP_TRUSTED_HOST_ARGS \
          --default-timeout "${XKEEN_PIP_TIMEOUT:-60}" \
          "$@" >"$PIP_LOG" 2>&1; then
          cat "$PIP_LOG"
          rm -f "$PIP_LOG" 2>/dev/null || true
          echo "[*] [$PHASE] pip install успешно через: $INDEX_URL"
          return 0
        else
          LAST_STATUS=$?
          cat "$PIP_LOG"
        fi
      fi
    fi

    rm -f "$PIP_LOG" 2>/dev/null || true
    echo "[!] [$PHASE] pip install не удался через: $INDEX_URL"
  done

  return "$LAST_STATUS"
}

# Битую распаковку колеса не видно ни в `pip list`, ни в `pip check`: метаданные
# целы, pip считает пакет установленным и на `pip install` отвечает «Requirement
# already satisfied». Падает только импорт. Отличаем «не установлен» от
# «установлен криво» — лечится это по-разному.
python_module_installed_but_broken() {
  MOD="$1"
  PKG="$2"

  "$PYTHON_BIN" -c "import $MOD" >/dev/null 2>&1 && return 1
  "$PYTHON_BIN" -m pip show "$PKG" >/dev/null 2>&1 || return 1
  return 0
}

# Сверяет файлы пакета с его dist-info/RECORD и называет потерянные файлы.
# Именно так ловится обрезанное при распаковке имя .so.
verify_python_package_files() {
  INTEGRITY_CHECKER=""
  for CANDIDATE in "$SRC_DIR/scripts/check_pydeps_integrity.py" "$UI_DIR/scripts/check_pydeps_integrity.py"; do
    if [ -f "$CANDIDATE" ]; then
      INTEGRITY_CHECKER="$CANDIDATE"
      break
    fi
  done

  [ -n "$INTEGRITY_CHECKER" ] || return 0

  "$PYTHON_BIN" "$INTEGRITY_CHECKER" "$@" 2>&1 || return 1
  return 0
}

provision_python_libs_check() {
  # Что из нужного уже есть: выставляет NEED_FLASK, NEED_CRYPTOGRAPHY, NEED_GEVENT.

  echo "[*] Проверяю наличие Flask/cryptography/gevent для Python3..."

  # Flask и cryptography обязательны; gevent/geventwebsocket — опциональны (WebSocket-логи).

  NEED_FLASK=0
  NEED_CRYPTOGRAPHY=0
  NEED_GEVENT=0

  # Проверяем flask
  if ! "$PYTHON_BIN" -c "import flask" >/dev/null 2>&1; then
    NEED_FLASK=1
  fi

  # Проверяем cryptography: она образует fail-closed trust boundary каталога модулей.
  if ! "$PYTHON_BIN" -c "import cryptography" >/dev/null 2>&1; then
    NEED_CRYPTOGRAPHY=1
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
}

provision_python_libs_install() {
  # Доставить недостающее и проверить итог. Ненулевой код — панель не
  # запустится; причина в PROVISION_ERROR. WS_VERDICT говорит, есть ли gevent.
  PROVISION_ERROR=""
  PROVISION_OPKG_OFFLINE=0
  if [ "$NEED_FLASK" -eq 1 ] || [ "$NEED_CRYPTOGRAPHY" -eq 1 ] || [ "$NEED_GEVENT" -eq 1 ]; then
    echo "[*] Flask, cryptography и/или gevent не найдены. Пытаюсь установить зависимости через Entware и pip..."

    if command -v opkg >/dev/null 2>&1; then
      OPKG_BIN="$(command -v opkg)"
    elif [ -x "/opt/bin/opkg" ]; then
      OPKG_BIN="/opt/bin/opkg"
    else
      echo "[!] Не найден пакетный менеджер opkg Entware."
      echo "    Поставь зависимости вручную:"
      echo "      opkg update && opkg install python3 python3-pip python3-cryptography"
      echo "      export XKEEN_PIP_INDEX_URL=${XKEEN_PIP_INDEX_URL:-$PIP_FALLBACK_INDEX_DEFAULT}"
      echo "      export XKEEN_GEVENT_PIP_SPEC=${XKEEN_GEVENT_PIP_SPEC:-$GEVENT_PIP_SPEC}"
      if [ "$WANT_GEVENT" -eq 1 ]; then
        echo "      $PYTHON_BIN -m pip install --upgrade --index-url \"\$XKEEN_PIP_INDEX_URL\" pip setuptools wheel"
      echo "      $PYTHON_BIN -m pip install --upgrade --index-url \"\$XKEEN_PIP_INDEX_URL\" flask cryptography"
        echo "      $PYTHON_BIN -m pip install --upgrade --index-url \"\$XKEEN_PIP_INDEX_URL\" \"\$XKEEN_GEVENT_PIP_SPEC\" gevent-websocket"
      else
        echo "      $PYTHON_BIN -m pip install --upgrade --index-url \"\$XKEEN_PIP_INDEX_URL\" pip setuptools wheel"
        echo "      $PYTHON_BIN -m pip install --upgrade --index-url \"\$XKEEN_PIP_INDEX_URL\" flask cryptography"
      fi
      echo "    После этого запусти установщик ещё раз."
      provision_fail "Не найден Entware (opkg), необходимый для Python-зависимостей."
      return 1
    fi

    if ! provision_opkg_update; then
      echo "[!] Не удалось выполнить 'opkg update' при установке зависимостей."
      # Недоступный Entware — не конец: то, чего не хватает, можно взять через
      # pip, если он уже есть. Тогда у opkg дальше ничего не просим.
      if "$PYTHON_BIN" -m pip --version >/dev/null 2>&1; then
        echo "[*] Entware недоступен, но pip работает: ставлю библиотеки через pip."
        PROVISION_OPKG_OFFLINE=1
      else
        provision_fail "Источник пакетов Entware не отвечает, а pip на роутере не установлен. Проверьте интернет-соединение и адрес источника в /opt/etc/opkg.conf."
        return 1
      fi
    fi

    if [ "$PROVISION_OPKG_OFFLINE" -eq 0 ] && ! provision_opkg install python3 python3-pip; then
      echo "[!] Установка python3 и python3-pip через opkg завершилась с ошибкой."
      provision_fail "Не удалось установить python3-pip через Entware."
      return 1
    fi

    # Auto-repair python3-pip if an Entware update left it structurally broken.
    if ! "$PYTHON_BIN" -m pip --version >/dev/null 2>&1; then
      if ! repair_python3_pip_package "pip --version failed after Entware package install"; then
        echo "[!] Не удалось автоматически восстановить python3-pip."
        echo "    Выполни вручную и запусти установщик ещё раз:"
        echo "      opkg remove python3-pip && opkg update && opkg install python3-pip"
        provision_fail "Python pip повреждён и не восстановился автоматически."
        return 1
      fi
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
        provision_fail "Не удалось загрузить Flask. Проверьте интернет-соединение или pip-зеркало."
        return 1
      fi
    else
      echo "[*] Flask уже доступен из $PYTHON_BIN, отдельная pip-установка не требуется."
    fi

    if [ "$NEED_CRYPTOGRAPHY" -eq 1 ]; then
      # Сначала пакет Entware: он собран под каждую архитектуру роутеров. В PyPI
      # готовых сборок cryptography под MIPS нет, и pip пошёл бы собирать её из
      # исходников, для чего на роутере нужен Rust.
      if [ "$PROVISION_OPKG_OFFLINE" -eq 0 ] && provision_opkg install python3-cryptography && "$PYTHON_BIN" -c "import cryptography" >/dev/null 2>&1; then
        echo "[*] cryptography установлена пакетом Entware python3-cryptography."
      elif ! pip_install_with_fallback "cryptography" cryptography; then
        echo "[!] Не удалось установить cryptography ни пакетом Entware, ни через доступные pip-индексы."
        echo "    Без неё каталог модулей нельзя проверить безопасно."
        provision_fail "Не удалось загрузить cryptography. Проверьте интернет-соединение или pip-зеркало."
        return 1
      fi
    else
      echo "[*] cryptography уже доступна из $PYTHON_BIN, отдельная pip-установка не требуется."
    fi

    # pip может не суметь собрать gevent/gevent-websocket на слабых роутерах,
    # поэтому ошибка здесь НЕ фатальная — продолжаем установку без WebSocket.
    if [ "$WANT_GEVENT" -eq 1 ]; then
      if [ -n "$GEVENT_PIN_REASON" ]; then
        echo "[*] Архитектура $ARCH: использую '$GEVENT_PIP_SPEC' ($GEVENT_PIN_REASON)."
      fi

      # Обычный `pip install` тут бесполезен: он ответит «Requirement already
      # satisfied» и ничего не починит.
      if python_module_installed_but_broken gevent gevent ||        python_module_installed_but_broken geventwebsocket gevent-websocket; then
        log_install "[!] gevent числится установленным, но не импортируется — установка повреждена."
        verify_python_package_files gevent gevent-websocket || true
        log_install "[*] Переустанавливаю его принудительно (--force-reinstall)."
        if ! pip_install_with_fallback "gevent-repair" --force-reinstall --no-deps "$GEVENT_PIP_SPEC" gevent-websocket; then
          log_install "[!] Принудительная переустановка gevent/gevent-websocket не удалась."
        fi
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
    provision_fail "Flask установлен некорректно, поэтому панель не сможет запуститься."
    return 1
  fi

  if ! "$PYTHON_BIN" -c "import cryptography" >/dev/null 2>&1; then
    echo "[!] Модуль cryptography по-прежнему не виден из $PYTHON_BIN."
    echo "    Без него каталог модулей нельзя проверить безопасно. Завершаю установку."
    provision_fail "cryptography установлен некорректно, поэтому каталог модулей нельзя проверить."
    return 1
  fi

  # gevent/geventwebsocket — опциональны: предупреждаем, но НЕ падаем.
  # Вердикт запоминаем, чтобы напечатать его в итоге установки — предупреждение
  # посреди вывода никто не читает.
  WS_VERDICT="off"
  WS_VERDICT_REASON="архитектура $ARCH: gevent не устанавливался"
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
      WS_VERDICT="off"
      WS_VERDICT_REASON="не импортируются модули: $MISSING_GEVENT"
      echo "[!] Следующие модули gevent недоступны: $MISSING_GEVENT"
      echo "    Продолжаю установку без WebSocket; логи Xray будут отображаться через HTTP-пулинг."
      echo "[*] Проверяю, не повреждена ли распаковка пакетов..."
      verify_python_package_files gevent gevent-websocket || true
    else
      WS_VERDICT="on"
      WS_VERDICT_REASON=""
      echo "[*] Flask и gevent найдены, WebSocket для логов Xray будет использован."
    fi
  else
    echo "[*] gevent/gevent-websocket не устанавливались для архитектуры $ARCH."
    echo "    Логи Xray будут отображаться через HTTP-пулинг."
  fi

  echo "[*] Python-зависимости в порядке."
}

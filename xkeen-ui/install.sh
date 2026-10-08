#!/bin/sh
set -e

UI_DIR="/opt/etc/xkeen-ui"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
INIT_DIR="/opt/etc/init.d"
INIT_SCRIPT_DEFAULT="$INIT_DIR/S99xkeen-ui-umarcheh001"
LEGACY_INIT_SCRIPT="$INIT_DIR/S99xkeen-ui"
INIT_SCRIPT="${XKEEN_UI_INIT_SCRIPT:-$INIT_SCRIPT_DEFAULT}"
PYTHON_BIN="/opt/bin/python3"
LOG_DIR="/opt/var/log"
RUN_DIR="/opt/var/run"
INSTALL_LOG="${XKEEN_INSTALL_LOG:-/opt/var/log/xkeen-ui-install.log}"

# The terminal is the installer's UI; stdout/stderr below are the diagnostic
# channel. Keep the screen concise while preserving every useful detail.
exec 3>&1
INSTALL_UI_FD=3
INSTALL_FINISHED=0
INSTALL_STAGE="Подготовка"
INSTALL_ERROR_HINT=""
INSTALL_CURRENT_ACTION="Подготовка"

UI_RESET=""
UI_BOLD=""
UI_DIM=""
UI_CYAN=""
UI_GREEN=""
UI_YELLOW=""
UI_RED=""
UI_HEADER_RIGHT=""
if [ -t "$INSTALL_UI_FD" ] && [ "${TERM:-dumb}" != "dumb" ] && [ -z "${NO_COLOR:-}" ]; then
  UI_ESC="$(printf '\033')"
  UI_RESET="${UI_ESC}[0m"
  UI_BOLD="${UI_ESC}[1m"
  UI_DIM="${UI_ESC}[2m"
  UI_CYAN="${UI_ESC}[1;36m"
  UI_GREEN="${UI_ESC}[1;32m"
  UI_YELLOW="${UI_ESC}[1;33m"
  UI_RED="${UI_ESC}[1;31m"
  # Same approach as sysmon: pin the right border to a terminal column.
  UI_HEADER_RIGHT="${UI_ESC}[44G"
fi

ui_header() {
  UI_HEADER_BAR="════════════════════════════════════════"
  printf '\n%b  ╔%s╗%b\n' "$UI_CYAN" "$UI_HEADER_BAR" "$UI_RESET" >&3 2>/dev/null || true
  if [ -n "$UI_HEADER_RIGHT" ]; then
    printf '%b  ║%b  %bXK / XKEEN UI%b%b%b║%b\n' \
      "$UI_CYAN" "$UI_RESET" "$UI_BOLD" "$UI_RESET" "$UI_HEADER_RIGHT" "$UI_CYAN" "$UI_RESET" >&3 2>/dev/null || true
    printf '%b  ║%b     ROUTER CONTROL%b%b║%b\n' \
      "$UI_CYAN" "$UI_RESET" "$UI_HEADER_RIGHT" "$UI_CYAN" "$UI_RESET" >&3 2>/dev/null || true
  else
    printf '%b  ║%b  %-38s%b║%b\n' "$UI_CYAN" "$UI_RESET" "XK / XKEEN UI" "$UI_CYAN" "$UI_RESET" >&3 2>/dev/null || true
    printf '%b  ║%b  %-38s%b║%b\n' "$UI_CYAN" "$UI_RESET" "   ROUTER CONTROL" "$UI_CYAN" "$UI_RESET" >&3 2>/dev/null || true
  fi
  printf '%b  ╚%s╝%b\n\n' "$UI_CYAN" "$UI_HEADER_BAR" "$UI_RESET" >&3 2>/dev/null || true
}

# Любая обычная строка сначала гасит нижний блок прогресса, иначе две руки
# пишут в один терминал и вывод рвётся. Пока прогресса нет, это пустые вызовы.
ui_stage() {
  INSTALL_STAGE="$2"
  ui_hold; ui_sticky_clear
  printf '  %b%s%b  %s\n' "$UI_CYAN" "$1" "$UI_RESET" "$2" >&3 2>/dev/null || true
  ui_release
}

ui_info() {
  ui_hold; ui_sticky_clear
  printf '      %s\n' "$*" >&3 2>/dev/null || true
  ui_sticky_draw; ui_release
}

ui_success() {
  ui_hold; ui_sticky_clear
  printf '%b  ✓%b  %s\n' "$UI_GREEN" "$UI_RESET" "$*" >&3 2>/dev/null || true
  ui_sticky_draw; ui_release
}

ui_warning() {
  ui_hold; ui_sticky_clear
  printf '%b  !%b  %s\n' "$UI_YELLOW" "$UI_RESET" "$*" >&3 2>/dev/null || true
  ui_sticky_draw; ui_release
}

ui_error() {
  ui_hold; ui_sticky_clear
  printf '\n%b  ×  %s%b\n' "$UI_RED" "$*" "$UI_RESET" >&3 2>/dev/null || true
  ui_release
}

# --- ui-progress: begin --------------------------------------------------
# Ход установки. Шаги с галочками говорят, что уже сделано; нижний блок из
# двух строк — что процесс жив: спиннер, имя текущего шага, его таймер и
# шкала из квадратов (один квадрат — один шаг, группы разделены по этапам).
#
# Рисовать поверх строк можно только в настоящем терминале. Если вывод
# перехвачен (curl | sh в файл, запуск из панели), нижний блок не печатается
# вовсе, а шаги идут обычными строками: «→ шаг…» и «✓ шаг · 12 с».

UI_PLAN="2 4 2 4 3"          # сколько шагов в каждом из пяти этапов
UI_STEP_TOTAL=15             # сумма UI_PLAN; держится сторожевым тестом
UI_STEP_DONE=0               # закрытых шагов
UI_STEP_CURRENT=0            # номер идущего шага, 0 — ни одного
UI_STAGE_NO=0
UI_STAGE_LEFT=0
UI_STEP_LABEL=""
UI_STEP_AT=0
UI_RUN_AT=0
UI_TICKER=""
UI_TICKER_FILE=""
UI_STATE_FILE=""
UI_STICKY=0
UI_SPIN_N=0
: "${UI_PROGRESS_TTY:=0}"

ui_now() {
  date '+%s' 2>/dev/null || echo 0
}

ui_since() {
  _ui_from="$1"
  _ui_sec=$(( $(ui_now) - _ui_from ))
  [ "$_ui_sec" -lt 0 ] && _ui_sec=0
  if [ "$_ui_sec" -lt 60 ]; then
    printf '%s с' "$_ui_sec"
  else
    _ui_m=$(( _ui_sec / 60 ))
    _ui_s=$(( _ui_sec % 60 ))
    if [ "$_ui_s" -eq 0 ]; then
      printf '%s м' "$_ui_m"
    else
      printf '%s м %s с' "$_ui_m" "$_ui_s"
    fi
  fi
}

ui_clock() {
  _ui_sec=$(( $(ui_now) - ${1:-$UI_RUN_AT} ))
  [ "$_ui_sec" -lt 0 ] && _ui_sec=0
  printf '%02d:%02d' $(( _ui_sec / 60 )) $(( _ui_sec % 60 ))
}

# Шкала: пройденные шаги — залитый квадрат, текущий — обведённый, остальные
# пустые. Между этапами двойной пробел, чтобы были видны их границы.
# Печатает в стандартный вывод: шкала — часть кадра, а кадр собирается целиком.
ui_squares() {
  _ui_done="$1"
  _ui_cur="$2"
  _ui_idx=0
  _ui_first_group=1
  for _ui_count in $UI_PLAN; do
    [ "$_ui_first_group" -eq 1 ] || printf '  '
    _ui_first_group=0
    _ui_i=0
    while [ "$_ui_i" -lt "$_ui_count" ]; do
      _ui_idx=$(( _ui_idx + 1 ))
      [ "$_ui_i" -eq 0 ] || printf ' '
      if [ "$_ui_idx" -le "$_ui_done" ]; then
        printf '%b■%b' "$UI_CYAN" "$UI_RESET"
      elif [ "$_ui_idx" -eq "$_ui_cur" ]; then
        printf '%b▣%b' "$UI_YELLOW" "$UI_RESET"
      else
        printf '%b□%b' "$UI_DIM" "$UI_RESET"
      fi
      _ui_i=$(( _ui_i + 1 ))
    done
  done
}

# Кадр спиннера выбирается перебором, а не вырезкой из строки: `cut -c` на
# роутере считает байты, а не символы, и режет трёхбайтовый символ пополам.
ui_spin_frame() {
  case $(( UI_SPIN_N % 10 )) in
    0) printf '⠋' ;;
    1) printf '⠙' ;;
    2) printf '⠹' ;;
    3) printf '⠸' ;;
    4) printf '⠼' ;;
    5) printf '⠴' ;;
    6) printf '⠦' ;;
    7) printf '⠧' ;;
    8) printf '⠇' ;;
    *) printf '⠏' ;;
  esac
}

# Снимок состояния для тикера: он читает файл на каждом тике, поэтому видит
# свежие шаги, а не те, что были на момент его запуска. Через переменные это не
# передать: фоновый процесс уносит копию и больше её не обновляет.
ui_state_write() {
  [ -n "$UI_STATE_FILE" ] || return 0
  {
    printf '%s %s %s %s %s\n' "$UI_STEP_DONE" "$UI_STEP_CURRENT" "$UI_STAGE_NO" "$UI_RUN_AT" "$UI_STEP_AT"
    printf '%s\n' "$UI_STEP_LABEL"
  } > "$UI_STATE_FILE" 2>/dev/null || true
}

# Нижний блок: две строки, курсор остаётся в начале первой из них.
#
# Кадр собирается целиком и уходит в терминал одной записью. Раньше он
# печатался по частям, и заморозка тикера посреди кадра оставляла курсор на
# второй строке блока: установщик печатал свою строку поверх шкалы, а после
# разморозки тикер дорисовывал хвост старого кадра уже поверх новых строк.
ui_sticky_draw() {
  [ "$UI_PROGRESS_TTY" -eq 1 ] || return 0
  [ -n "$UI_STATE_FILE" ] && [ -f "$UI_STATE_FILE" ] || return 0
  { read -r _ui_nums; read -r _ui_label; } < "$UI_STATE_FILE" 2>/dev/null || return 0
  # Шага нет — блоку на экране делать нечего. Тикер так убирает кадр, который
  # успел собрать до заморозки и напечатал уже после закрытия шага.
  [ -n "$_ui_label" ] || { ui_sticky_clear; return 0; }
  set -- $_ui_nums
  [ $# -ge 5 ] || return 0
  _ui_done="$1"; _ui_cur="$2"; _ui_stage="$3"; _ui_run="$4"; _ui_step_at="$5"
  UI_SPIN_N=$(( UI_SPIN_N + 1 ))
  _ui_picture="$(
    printf '\r\033[K  %b%s%b  %s  %b%s%b\n' \
      "$UI_CYAN" "$(ui_spin_frame)" "$UI_RESET" "$_ui_label" \
      "$UI_DIM" "$(ui_since "$_ui_step_at")" "$UI_RESET"
    printf '\033[K  '
    ui_squares "$_ui_done" "$_ui_cur"
    printf '  %s/%s  %bэтап %s/5  ·  всего %s%b\033[1A\r' \
      "$_ui_done" "$UI_STEP_TOTAL" \
      "$UI_DIM" "$_ui_stage" "$(ui_clock "$_ui_run")" "$UI_RESET"
  )"
  printf '%s' "$_ui_picture" >&"$INSTALL_UI_FD" 2>/dev/null || true
  UI_STICKY=1
}

# Пока тикер жив, блок гасится всегда, а не только когда его рисовал сам
# установщик: кадр мог напечатать тикер, и установщик об этом не знает.
ui_sticky_clear() {
  [ "$UI_STICKY" -eq 1 ] || [ -n "$UI_TICKER" ] || return 0
  printf '\r\033[K\n\033[K\033[1A\r' >&"$INSTALL_UI_FD" 2>/dev/null || true
  UI_STICKY=0
}

# Тикер живёт отдельным процессом: пока установщик ждёт долгую команду, сам он
# ничего нарисовать не может. На время печати обычных строк тикер замораживается
# сигналом STOP, иначе две руки пишут в один терминал и вывод рвётся.
ui_ticker_start() {
  [ "$UI_PROGRESS_TTY" -eq 1 ] || return 0
  [ -n "$UI_TICKER" ] && return 0
  ui_ticker_loop &
  UI_TICKER=$!
}

ui_ticker_loop() {
  # Второе условие — против осиротевшего тикера: если установщика убили жёстко,
  # файл-флаг останется, и без этой проверки процесс писал бы в мёртвый терминал.
  while [ -f "$UI_TICKER_FILE" ] && kill -0 "$UI_OWNER_PID" 2>/dev/null; do
    ui_sticky_draw
    sleep 1
  done
}

ui_hold() {
  [ -n "$UI_TICKER" ] && kill -STOP "$UI_TICKER" 2>/dev/null || true
}

ui_release() {
  [ -n "$UI_TICKER" ] && kill -CONT "$UI_TICKER" 2>/dev/null || true
}

# Печать обычной строки: гасим нижний блок, печатаем, рисуем блок заново.
ui_line() {
  ui_hold
  ui_sticky_clear
  printf '%b\n' "$*" >&"$INSTALL_UI_FD" 2>/dev/null || true
  ui_sticky_draw
  ui_release
}

# Prompts must temporarily own the terminal: the progress ticker otherwise
# redraws its sticky block over the user's menu and typed answer.
ui_input_begin() {
  ui_hold
  ui_sticky_clear
}

ui_input_end() {
  ui_sticky_draw
  ui_release
}

ui_progress_start() {
  UI_RUN_AT=$(ui_now)
  UI_OWNER_PID=$$
  if [ -n "$UI_RESET" ]; then
    UI_PROGRESS_TTY=1
  fi
  if [ "$UI_PROGRESS_TTY" -eq 1 ]; then
    UI_TICKER_FILE="${TMPDIR:-/tmp}/xkeen-ui-progress.$$"
    UI_STATE_FILE="${TMPDIR:-/tmp}/xkeen-ui-progress-state.$$"
    : > "$UI_TICKER_FILE" 2>/dev/null || UI_PROGRESS_TTY=0
    : > "$UI_STATE_FILE" 2>/dev/null || UI_PROGRESS_TTY=0
    printf '\033[?25l' >&"$INSTALL_UI_FD" 2>/dev/null || true
  fi
}

ui_progress_stop() {
  if [ -n "$UI_TICKER" ]; then
    kill -CONT "$UI_TICKER" 2>/dev/null || true
    rm -f "$UI_TICKER_FILE" 2>/dev/null || true
    kill "$UI_TICKER" 2>/dev/null || true
    wait "$UI_TICKER" 2>/dev/null || true
    UI_TICKER=""
    # Последний кадр тикер мог напечатать уже после просьбы остановиться.
    UI_STICKY=1
  fi
  if [ "$UI_PROGRESS_TTY" -eq 1 ]; then
    ui_sticky_clear
    printf '\033[?25h' >&"$INSTALL_UI_FD" 2>/dev/null || true
  fi
  UI_STEP_LABEL=""
  if [ -n "$UI_STATE_FILE" ]; then
    rm -f "$UI_STATE_FILE" 2>/dev/null || true
    UI_STATE_FILE=""
  fi
}

# Этап объявляет, сколько в нём шагов: знаменатель шкалы честный, а сторожевой
# тест следит, чтобы обещание совпадало с числом ui_step внутри этапа.
ui_stage_plan() {
  UI_STAGE_NO=$(( UI_STAGE_NO + 1 ))
  UI_STAGE_LEFT="$1"
  ui_state_write
}

ui_step() {
  INSTALL_CURRENT_ACTION="$1"
  UI_STEP_LABEL="$1"
  UI_STEP_AT=$(ui_now)
  UI_STEP_CURRENT=$(( UI_STEP_DONE + 1 ))
  ui_state_write
  if [ "$UI_PROGRESS_TTY" -eq 1 ]; then
    ui_ticker_start
    ui_hold
    ui_sticky_draw
    ui_release
  else
    printf '      →  %s…\n' "$UI_STEP_LABEL" >&"$INSTALL_UI_FD" 2>/dev/null || true
  fi
}

ui_step_close() {
  _ui_mark="$1"
  _ui_color="$2"
  _ui_tail="$3"
  UI_STEP_DONE=$(( UI_STEP_DONE + 1 ))
  UI_STEP_CURRENT=0
  _ui_closed="$UI_STEP_LABEL"
  UI_STEP_LABEL=""
  ui_state_write
  UI_STEP_LABEL="$_ui_closed"
  ui_hold
  ui_sticky_clear
  printf '%b      %s%b  %s  %b%s%b\n' \
    "$_ui_color" "$_ui_mark" "$UI_RESET" "$UI_STEP_LABEL" \
    "$UI_DIM" "$_ui_tail" "$UI_RESET" >&"$INSTALL_UI_FD" 2>/dev/null || true
  UI_STEP_LABEL=""
  ui_release
}

ui_step_done() {
  ui_step_close "✓" "$UI_GREEN" "$(ui_since "$UI_STEP_AT")"
}

ui_step_skip() {
  ui_step_close "✓" "$UI_DIM" "$1"
}

ui_step_warn() {
  ui_step_close "!" "$UI_YELLOW" "$1"
}
# --- ui-progress: end ----------------------------------------------------

# Обычное terminal echo оставляет ответ видимым во время набора. После Enter
# перерисовываем строку с цветом ответа, не меняя настройки терминала.
#
# Ответ, не похожий ни на «да», ни на «нет» (опечатка, буква в другой
# раскладке), согласием не считается: вопрос задаётся снова.
ui_confirm_default_yes() {
  _ui_prompt="$1"
  UI_CONFIRM_ANSWER=""
  _ui_slips=0

  while :; do
    printf '      %s [%bY%b/%bn%b]: ' \
      "$_ui_prompt" "$UI_GREEN" "$UI_RESET" "$UI_YELLOW" "$UI_RESET" >&3 2>/dev/null || true
    IFS= read -r UI_CONFIRM_ANSWER < /dev/tty || UI_CONFIRM_ANSWER=""
    _ui_understood=1
    case "$UI_CONFIRM_ANSWER" in
      y|Y|yes|YES|Yes|д|Д|да|ДА|Да|n|N|no|NO|No|н|Н|нет|НЕТ|Нет|'') ;;
      *) _ui_understood=0 ;;
    esac
    if [ -n "$UI_RESET" ]; then
      # read already moved to the next line after Enter. Move back, clear that
      # prompt row and write the result in its semantic colour.
      printf '%b[1A\r%b[2K      %s [%bY%b/%bn%b]: ' \
        "$UI_ESC" "$UI_ESC" "$_ui_prompt" "$UI_GREEN" "$UI_RESET" "$UI_YELLOW" "$UI_RESET" >&3 2>/dev/null || true
      case "$UI_CONFIRM_ANSWER" in
        y|Y|yes|YES|Yes|д|Д|да|ДА|Да)
          printf '%b%s%b' "$UI_GREEN" "$UI_CONFIRM_ANSWER" "$UI_RESET" >&3 2>/dev/null || true
          ;;
        n|N|no|NO|No|н|Н|нет|НЕТ|Нет)
          printf '%b%s%b' "$UI_YELLOW" "$UI_CONFIRM_ANSWER" "$UI_RESET" >&3 2>/dev/null || true
          ;;
        '')
          printf '%bY%b' "$UI_GREEN" "$UI_RESET" >&3 2>/dev/null || true
          ;;
        *)
          printf '%b%s%b' "$UI_YELLOW" "$UI_CONFIRM_ANSWER" "$UI_RESET" >&3 2>/dev/null || true
          ;;
      esac
    fi
    printf '\n' >&3 2>/dev/null || true
    [ "$_ui_understood" -eq 1 ] && break

    _ui_slips=$((_ui_slips + 1))
    if [ "$_ui_slips" -ge 3 ]; then
      # Спрашивать без конца нельзя, но и молча выбирать за человека — тоже.
      UI_CONFIRM_ANSWER=""
      printf '      %bОтвет не распознан — оставляю вариант по умолчанию: да.%b\n' \
        "$UI_YELLOW" "$UI_RESET" >&3 2>/dev/null || true
      break
    fi
    printf '      %bНе понял ответ. Введите y (да) или n (нет); просто Enter — да.%b\n' \
      "$UI_YELLOW" "$UI_RESET" >&3 2>/dev/null || true
  done
}

choose_geodat_option() {
  case "${XKEEN_GEODAT_INSTALL:-}" in
    1)
      GEODAT_OPTION="1"
      XKEEN_GEODAT_INSTALL="$GEODAT_OPTION"
      export XKEEN_GEODAT_INSTALL
      printf '  %bДополнение:%b  просмотрщик DAT будет установлен\n' "$UI_DIM" "$UI_RESET" >&3 2>/dev/null || true
      return 0
      ;;
    0)
      GEODAT_OPTION="0"
      XKEEN_GEODAT_INSTALL="$GEODAT_OPTION"
      export XKEEN_GEODAT_INSTALL
      printf '  %bДополнение:%b  просмотрщик DAT пропущен\n' "$UI_DIM" "$UI_RESET" >&3 2>/dev/null || true
      return 0
      ;;
  esac

  # Preserve the historical behavior for unattended installs: xk-geodat is on.
  GEODAT_OPTION="1"
  if [ -t 0 ] && [ -r /dev/tty ]; then
    printf '  %bДополнение%b   Просмотрщик DAT-файлов\n' "$UI_BOLD" "$UI_RESET" >&3 2>/dev/null || true
    ui_info "Показывает содержимое GeoIP/GeoSite и помогает добавлять теги."
    ui_confirm_default_yes "Установить xk-geodat?"
    case "$UI_CONFIRM_ANSWER" in
      n|N|no|NO|No|н|Н|нет|НЕТ|Нет) GEODAT_OPTION="0" ;;
    esac
  fi
  XKEEN_GEODAT_INSTALL="$GEODAT_OPTION"
  export XKEEN_GEODAT_INSTALL
}

choose_happ_option() {
  case "${XKEEN_HAPP_DECRYPTOR_INSTALL:-}" in
    1)
      HAPP_OPTION="1"
      XKEEN_HAPP_DECRYPTOR_INSTALL="$HAPP_OPTION"
      export XKEEN_HAPP_DECRYPTOR_INSTALL
      printf '  %bДополнение:%b  режим разработчика для подписок включён\n' "$UI_DIM" "$UI_RESET" >&3 2>/dev/null || true
      return 0
      ;;
    0)
      HAPP_OPTION="0"
      XKEEN_HAPP_DECRYPTOR_INSTALL="$HAPP_OPTION"
      export XKEEN_HAPP_DECRYPTOR_INSTALL
      printf '  %bДополнение:%b  режим разработчика для подписок пропущен\n' "$UI_DIM" "$UI_RESET" >&3 2>/dev/null || true
      return 0
      ;;
  esac

  HAPP_OPTION="1"
  if [ -t 0 ] && [ -r /dev/tty ]; then
    printf '  %bДополнение%b   Режим разработчика для подписок\n' "$UI_BOLD" "$UI_RESET" >&3 2>/dev/null || true
    ui_info "Расширенная обработка ссылок при импорте подписок."
    ui_info "Компоненты загрузятся с GitHub."
    ui_confirm_default_yes "Установить?"
    case "$UI_CONFIRM_ANSWER" in
      n|N|no|NO|No|н|Н|нет|НЕТ|Нет) HAPP_OPTION="0" ;;
    esac
  fi
  XKEEN_HAPP_DECRYPTOR_INSTALL="$HAPP_OPTION"
  export XKEEN_HAPP_DECRYPTOR_INSTALL
}

choose_panel_profile() {
  INSTALL_PROFILE_HELPER="$SRC_DIR/scripts/module_profile_install.py"
  [ -f "$INSTALL_PROFILE_HELPER" ] || fail_install "В архиве нет helper профилей установки."
  PROFILE_INPUT_ACTIVE=0
  PROFILE_CHOICE="${XKEEN_UI_INSTALL_PROFILE:-}"
  PROFILE_APPLY_OPTIONS=""
  PROFILE_KEEP_SWITCHES=0
  if [ -z "$PROFILE_CHOICE" ] && [ -z "${XKEEN_UI_INSTALL_MODULES:-}" ] && [ -d "$UI_DIR" ]; then
    # Профиль не задан: ставим то, что уже установлено (или то, что владелец
    # запросил и ещё не применил). Переключатели модулей не читаем и не
    # трогаем: выключенный модуль обновляется вместе со всеми и остаётся
    # выключенным, убрать его с накопителя можно только явным действием.
    PROFILE_CURRENT="$("$PYTHON_BIN" "$INSTALL_PROFILE_HELPER" current --target "$UI_DIR" 2>/dev/null || true)"
    PROFILE_CHOICE="$(printf '%s\n' "$PROFILE_CURRENT" | sed -n 's/^profile=//p')"
    if [ -n "$PROFILE_CHOICE" ]; then
      PROFILE_KEEP_SWITCHES=1
      PROFILE_APPLY_OPTIONS="--keep-switches"
      PROFILE_CURRENT_VARIANT="$(printf '%s\n' "$PROFILE_CURRENT" | sed -n 's/^variant=//p')"
      case "$PROFILE_CURRENT_VARIANT" in
        light|full|advanced) PROFILE_APPLY_OPTIONS="$PROFILE_APPLY_OPTIONS --editor-variant $PROFILE_CURRENT_VARIANT" ;;
      esac
      if [ "$PROFILE_CHOICE" = "custom" ]; then
        XKEEN_UI_INSTALL_MODULES="$(printf '%s\n' "$PROFILE_CURRENT" | sed -n 's/^modules=//p')"
      fi
    fi
  fi
  if [ -z "$PROFILE_CHOICE" ] && [ -f "$UI_DIR/modules.json" ]; then
    PROFILE_CHOICE="$("$PYTHON_BIN" - "$UI_DIR/modules.json" <<'PY'
import json
import sys
try:
    with open(sys.argv[1], encoding="utf-8") as handle:
        print(json.load(handle).get("profile", ""))
except (OSError, ValueError, TypeError):
    pass
PY
)"
  fi
  if [ -z "$PROFILE_CHOICE" ] && [ -t 0 ] && [ -r /dev/tty ]; then
    # The profile prompt runs while the stage ticker is active. Stop and clear
    # the ticker before reading so it cannot overwrite the menu or the answer.
    ui_input_begin
    PROFILE_INPUT_ACTIVE=1
    printf '  %bПрофиль панели%b\n' "$UI_BOLD" "$UI_RESET" >&3 2>/dev/null || true
    printf '      1) Full\n' >&3 2>/dev/null || true
    printf '      2) Xray Minimal\n' >&3 2>/dev/null || true
    printf '      3) Mihomo Minimal\n' >&3 2>/dev/null || true
    printf '      4) Custom\n' >&3 2>/dev/null || true
    while :; do
      printf '      Выбор [1]: ' >&3 2>/dev/null || true
      IFS= read -r PROFILE_ANSWER < /dev/tty || PROFILE_ANSWER=""
      case "$PROFILE_ANSWER" in
        ''|1) PROFILE_CHOICE="full"; break ;;
        2) PROFILE_CHOICE="xray-minimal"; break ;;
        3) PROFILE_CHOICE="mihomo-minimal"; break ;;
        4) PROFILE_CHOICE="custom"; break ;;
        *)
          printf '      Введите число от 1 до 4.\n' >&3 2>/dev/null || true
          ;;
      esac
    done
  fi
  [ -n "$PROFILE_CHOICE" ] || PROFILE_CHOICE="full"
  case "$PROFILE_CHOICE" in
    legacy-full|full|xray-minimal|mihomo-minimal|custom) ;;
    *) fail_install "Неизвестный профиль: $PROFILE_CHOICE" ;;
  esac
  if [ "$PROFILE_CHOICE" = "custom" ] && [ -z "${XKEEN_UI_INSTALL_MODULES:-}" ]; then
    if [ -f "$UI_DIR/modules.json" ]; then
      XKEEN_UI_INSTALL_MODULES="$("$PYTHON_BIN" - "$UI_DIR/modules.json" <<'PY'
import json
import sys
try:
    with open(sys.argv[1], encoding="utf-8") as handle:
        state = json.load(handle)
    print(",".join(module for module, item in state.get("modules", {}).items() if item.get("enabled")))
except (OSError, ValueError, TypeError, AttributeError):
    pass
PY
)"
    fi
    if [ -z "${XKEEN_UI_INSTALL_MODULES:-}" ] && [ -t 0 ] && [ -r /dev/tty ]; then
      if [ "$PROFILE_INPUT_ACTIVE" -ne 1 ]; then
        ui_input_begin
        PROFILE_INPUT_ACTIVE=1
      fi
      ui_info "Модули: core, engine.xray, engine.mihomo, tool.editor, tool.terminal, tool.files, tool.backups, integration.happ, tool.advanced-diagnostics"
      printf '      ID через запятую: ' >&3 2>/dev/null || true
      IFS= read -r XKEEN_UI_INSTALL_MODULES < /dev/tty || XKEEN_UI_INSTALL_MODULES=""
    fi
    [ -n "${XKEEN_UI_INSTALL_MODULES:-}" ] || fail_install "Для Custom задайте XKEEN_UI_INSTALL_MODULES."
  fi
  XKEEN_UI_INSTALL_PROFILE="$PROFILE_CHOICE"
  export XKEEN_UI_INSTALL_PROFILE XKEEN_UI_INSTALL_MODULES
  if [ "$PROFILE_INPUT_ACTIVE" -eq 1 ]; then
    ui_input_end
  fi
  ui_line "$(printf '  %bПрофиль:%b     %s' "$UI_DIM" "$UI_RESET" "$PROFILE_CHOICE")"
}

profile_has_module() {
  case "$PROFILE_CHOICE" in
    full|legacy-full) return 0 ;;
    xray-minimal) [ "$1" = "core" ] || [ "$1" = "engine.xray" ] || [ "$1" = "tool.editor" ] ;;
    mihomo-minimal) [ "$1" = "core" ] || [ "$1" = "engine.mihomo" ] || [ "$1" = "tool.editor" ] ;;
    custom) case ",$XKEEN_UI_INSTALL_MODULES," in *",$1,"*) return 0 ;; *) return 1 ;; esac ;;
    *) return 1 ;;
  esac
}

fail_install() {
  INSTALL_ERROR_HINT="$1"
  exit "${2:-1}"
}

installer_on_exit() {
  INSTALL_STATUS="$1"
  trap - 0
  provision_opkg_cleanup 2>/dev/null || true
  ui_progress_stop
  if [ "$INSTALL_STATUS" -ne 0 ] && [ "$INSTALL_FINISHED" -ne 1 ]; then
    log_install "[!] Установка остановлена: код $INSTALL_STATUS, этап: $INSTALL_STAGE, действие: ${INSTALL_CURRENT_ACTION:-не определено}."
    if [ "${PROFILE_TRANSACTION_ACTIVE:-0}" -eq 1 ] && [ -f "$PROFILE_TRANSACTION/transaction.json" ]; then
      "$PYTHON_BIN" "$INSTALL_PROFILE_HELPER" rollback --transaction "$PROFILE_TRANSACTION" || true
      [ -x "${INIT_SCRIPT:-}" ] && "$INIT_SCRIPT" restart 3>&- || true
      PROFILE_TRANSACTION_ACTIVE=0
    fi
    ui_error "Установка остановлена"
    if [ -n "$INSTALL_ERROR_HINT" ]; then
      ui_info "$INSTALL_ERROR_HINT"
    else
      ui_info "Не удалось завершить этап: $INSTALL_STAGE."
    fi
    ui_info "Последнее действие: ${INSTALL_CURRENT_ACTION:-не определено} (код $INSTALL_STATUS)."
    ui_info "Подробности: $INSTALL_LOG"
    printf '\n' >&3 2>/dev/null || true
  fi
}

installer_on_interrupt() {
  INSTALL_ERROR_HINT="Операция прервана пользователем."
  exit 130
}

prepare_install_log() {
  INSTALL_LOG_PARENT="$(dirname "$INSTALL_LOG")"
  if ! mkdir -p "$INSTALL_LOG_PARENT" 2>/dev/null || ! touch "$INSTALL_LOG" 2>/dev/null; then
    INSTALL_LOG="${TMPDIR:-/tmp}/xkeen-ui-install.log"
    touch "$INSTALL_LOG" 2>/dev/null || return 0
  fi
  if [ -s "$INSTALL_LOG" ]; then
    mv -f "$INSTALL_LOG" "$INSTALL_LOG.previous" 2>/dev/null || : > "$INSTALL_LOG"
  fi
  printf '===== Xkeen UI install: %s =====\n' "$(date '+%Y-%m-%d %H:%M:%S' 2>/dev/null || echo '?')" > "$INSTALL_LOG"
  exec >> "$INSTALL_LOG" 2>&1
}

# Important events use timestamps in the diagnostic log. User-facing output
# is emitted only through ui_* helpers on descriptor 3.
log_install() {
  printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S' 2>/dev/null || echo '?')" "$*" >> "$INSTALL_LOG" 2>/dev/null || true
}

prepare_install_log
trap 'installer_on_exit $?' 0
ui_progress_start
trap 'installer_on_interrupt' HUP INT TERM

# Работа, общая для установки и обновления из панели, живёт в одном файле.
PROVISION_LIB="$SRC_DIR/scripts/provision_env.sh"
[ -f "$PROVISION_LIB" ] || fail_install "Установочный архив повреждён: нет scripts/provision_env.sh."
. "$PROVISION_LIB"

if [ -f "$UI_DIR/app.py" ] || [ -f "$UI_DIR/run_server.py" ]; then
  INSTALL_MODE="Обновление"
else
  INSTALL_MODE="Новая установка"
fi

ui_header
printf '  %bРежим:%b       %s\n' "$UI_DIM" "$UI_RESET" "$INSTALL_MODE" >&3 2>/dev/null || true
printf '  %bАрхитектура:%b %s\n' "$UI_DIM" "$UI_RESET" "$(uname -m 2>/dev/null || echo unknown)" >&3 2>/dev/null || true
choose_geodat_option
choose_happ_option
printf '\n' >&3 2>/dev/null || true
ui_stage "01/05" "Проверка окружения"
ui_stage_plan 2
ui_step "Служба панели и каталоги"

# Never reuse Entware's shared __pycache__. A power loss or interrupted package
# upgrade can leave a stdlib .pyc truncated; Python then fails before the UI
# process can start ("bad marshal data"). A private cache also keeps installer
# and panel bytecode isolated from package-manager state.
PYTHONPYCACHEPREFIX="${XKEEN_UI_PYTHONPYCACHEPREFIX:-/tmp/xkeen-ui-pycache}"
export PYTHONPYCACHEPREFIX
mkdir -p "$PYTHONPYCACHEPREFIX" 2>/dev/null || true

assert_safe_ui_init_target() {
  _path="$1"
  [ -n "$_path" ] || return 0
  [ -e "$_path" ] || return 0

  if is_our_ui_init_script "$_path"; then
    return 0
  fi

  echo "[!] init-скрипт уже существует и не похож на Xkeen UI: $_path"
  echo "    Установщик прерывает запись, чтобы не перезаписать чужую панель."
  echo "    Используй XKEEN_UI_INIT_SCRIPT с отдельным именем, если нужен кастомный путь."
  return 1
}

if ! assert_safe_ui_init_target "$INIT_SCRIPT"; then
  fail_install "Путь $INIT_SCRIPT уже занят чужим init-скриптом. Укажите другой путь через XKEEN_UI_INIT_SCRIPT."
fi

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
ui_step_done
ui_step "Модель роутера и архитектура"
provision_gevent_policy

MIHOMO_ROOT="/opt/etc/mihomo"
MIHOMO_CONFIG_FILE="$MIHOMO_ROOT/config.yaml"
MIHOMO_PROFILES_DIR="$MIHOMO_ROOT/profiles"
MIHOMO_TEMPLATES_DIR="$MIHOMO_ROOT/templates"
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
ui_step_done
ui_success "Устройство распознано"
echo "========================================"
echo "  Xkeen Web UI — УСТАНОВКА"
echo "========================================"
ui_stage "02/05" "Подготовка компонентов"
ui_stage_plan 4
ui_step "Python 3"

# --- Python3 ---

if [ ! -x "$PYTHON_BIN" ]; then
  ui_info "Устанавливаю Python 3 через Entware..."
  echo "[*] Python3 не найден по пути $PYTHON_BIN."
  echo "[*] Пытаюсь установить python3 через Entware (opkg)..."

  if command -v opkg >/dev/null 2>&1; then
    OPKG_BIN="$(command -v opkg)"
  elif [ -x "/opt/bin/opkg" ]; then
    OPKG_BIN="/opt/bin/opkg"
  else
    echo "[!] Не найден пакетный менеджер opkg Entware."
    echo "    Установи Entware и python3 вручную, затем запусти установщик ещё раз."
    fail_install "Не найден Entware (opkg). Установите Entware и повторите запуск."
  fi

  if ! provision_opkg_update; then
    echo "[!] Не удалось выполнить 'opkg update'."
    fail_install "Entware не смог обновить список пакетов. Проверьте интернет-соединение."
  fi

  if ! provision_opkg install python3; then
    echo "[!] Установка python3 через opkg завершилась с ошибкой."
    fail_install "Не удалось установить Python 3 через Entware."
  fi
fi

if [ ! -x "$PYTHON_BIN" ]; then
  echo "[!] Python3 по пути $PYTHON_BIN не найден даже после установки."
  fail_install "Python 3 не найден после установки."
fi

provision_python_libs_check

ui_step_done
ui_step "Библиотеки панели"
if [ "$NEED_FLASK" -eq 1 ] || [ "$NEED_CRYPTOGRAPHY" -eq 1 ] || [ "$NEED_GEVENT" -eq 1 ]; then
  ui_info "Настраиваю Python-зависимости панели..."
fi
provision_python_libs_install || fail_install "${PROVISION_ERROR:-Не удалось подготовить библиотеки панели.}"
choose_panel_profile


# --- lftp (для файлового менеджера) ---

ui_step_done
ui_step "Файловый менеджер"
if profile_has_module tool.files; then
  command -v lftp >/dev/null 2>&1 || ui_info "Добавляю файловый менеджер..."
  provision_file_manager || fail_install "${PROVISION_ERROR:-Не удалось подготовить файловый менеджер.}"
fi


# --- sysmon: утилиты для расширенной диагностики (coreutils-df, procps-ng-free, procps-ng-uptime) ---

ui_step_done
ui_step "Утилиты системного монитора"
provision_sysmon_utils

ui_step_done
ui_success "Системные компоненты готовы"


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
  SKIPPED=0

  for src in "$XRAY_CONFIG_DIR"/*.jsonc; do
    [ -f "$src" ] || continue
    base="$(basename "$src")"
    main_json="${src%?}"
    if [ ! -f "$main_json" ]; then
      echo "[*] JSONC миграция: пропускаю $base — рядом нет основного ${base%?}"
      SKIPPED=$((SKIPPED + 1))
      continue
    fi
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

  echo "[*] JSONC миграция (install): перемещено=$MOVED, архивировано=$ARCHIVED, пропущено=$SKIPPED."
  echo "[install] JSONC миграция: moved=$MOVED archived=$ARCHIVED skipped=$SKIPPED jsonc_dir=$JSONC_DIR" >> "$LOG_DIR/xkeen-ui.log"

  REMAINING_PAIRED=0
  for src in "$XRAY_CONFIG_DIR"/*.jsonc; do
    [ -f "$src" ] || continue
    [ -f "${src%?}" ] && REMAINING_PAIRED=1
  done

  # Если sidecar остался рядом с основным .json (например, из-за прав) — предупредим.
  if [ "$REMAINING_PAIRED" -eq 1 ]; then
    echo "[!] Внимание: в $XRAY_CONFIG_DIR всё ещё есть *.jsonc. Проверь права/перенеси вручную."
  elif [ "$SKIPPED" -gt 0 ]; then
    echo "[*] JSONC миграция: оставлены пользовательские *.jsonc без соседнего .json."
  fi
}

# --- Определяем существующую установку и её порт ---

drop_previous_precompressed() {
  STATIC_DIR="$1"
  [ -n "$STATIC_DIR" ] || return 0
  [ -d "$STATIC_DIR" ] || return 0

  if DROP_OUTPUT="$(
      PRECOMPRESSED_STATIC_DIR="$STATIC_DIR" "$PYTHON_BIN" - <<'PY'
import os
from pathlib import Path

# ASCII only in this block: it runs as `python3 -`, where a non-UTF-8 locale
# would turn a Cyrillic comment into a syntax error.
#
# Every .gz under static belongs to the previous install. The new package
# brings its own (or none, like a CI release), and neither `cp -r` nor
# `rsync -a` removes leftovers. A leftover .gz would then be pulled forward
# by align_precompressed_mtimes and served instead of the new source.
root = Path(os.environ.get("PRECOMPRESSED_STATIC_DIR", ""))
if not root.is_dir():
    print("skip:static_dir_missing")
    raise SystemExit(0)

dropped = 0
for packed in root.rglob("*.gz"):
    try:
        if packed.is_file() and not packed.is_symlink():
            packed.unlink()
            dropped += 1
    except OSError:
        continue

print(f"dropped={dropped}")
PY
  )"; then
    DROP_STATUS=0
  else
    DROP_STATUS=$?
  fi

  if [ "$DROP_STATUS" -ne 0 ]; then
    echo "[!] previous precompressed copies were not removed from $STATIC_DIR (exit $DROP_STATUS)."
  elif [ -n "$DROP_OUTPUT" ]; then
    echo "[*] previous precompressed copies: $DROP_OUTPUT"
  fi

  return 0
}

align_precompressed_mtimes() {
  STATIC_DIR="$1"
  [ -n "$STATIC_DIR" ] || return 0
  [ -d "$STATIC_DIR" ] || return 0

  if ALIGN_OUTPUT="$(
      PRECOMPRESSED_STATIC_DIR="$STATIC_DIR"       "$PYTHON_BIN" - <<'PY'
import os
from pathlib import Path

# ASCII only in this block: it runs as `python3 -`, where a non-UTF-8 locale
# would turn a Cyrillic comment into a syntax error.
root = Path(os.environ.get("PRECOMPRESSED_STATIC_DIR", ""))
if not root.is_dir():
    print("skip:static_dir_missing")
    raise SystemExit(0)

aligned = 0
for packed in root.rglob("*.gz"):
    source = packed.with_name(packed.name[:-3])
    try:
        if not source.is_file() or not packed.is_file():
            continue
        src_mtime = source.stat().st_mtime
        if packed.stat().st_mtime >= src_mtime:
            continue
        # Without rsync the tree is copied with `cp -r`, which stamps each file
        # with the moment it was written. A large source can land a second
        # after its own .gz, and the serving guard then reads that as "source
        # edited after packing" and quietly drops the compressed copy.
        os.utime(packed, (src_mtime, src_mtime))
        aligned += 1
    except OSError:
        continue

print(f"aligned={aligned}")
PY
  )"; then
    ALIGN_STATUS=0
  else
    ALIGN_STATUS=$?
  fi

  if [ "$ALIGN_STATUS" -ne 0 ]; then
    echo "[!] precompressed mtime alignment failed for $STATIC_DIR (exit $ALIGN_STATUS). Keeping files as-is."
  elif [ -n "$ALIGN_OUTPUT" ]; then
    echo "[*] precompressed mtimes: $ALIGN_OUTPUT"
  fi

  return 0
}

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

  if CLEANUP_OUTPUT="$(
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

# Precompressed siblings are produced by the archive builder and never appear
# in a vite manifest. Without this the cleanup wipes every .gz of the compiled
# bundle and the panel serves it uncompressed. Orphans are still pruned: a .gz
# survives only next to a file that survives itself.
# ASCII only in this block: it runs as `python3 -`, where a non-UTF-8 locale
# would turn a Cyrillic comment into a syntax error.
keep |= {rel + ".gz" for rel in keep}

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
  )"; then
    CLEANUP_STATUS=0
  else
    CLEANUP_STATUS=$?
  fi
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

ui_stage "03/05" "Настройка панели"
ui_stage_plan 2
ui_step "Порт панели"

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
        fail_install "Не найден свободный порт для панели (проверены 8088, 8091 и 8100–8199)."
      fi
    fi
  fi
  echo "[*] Выбран порт панели: $PANEL_PORT"
  echo "[install] Текущий порт панели: $PANEL_PORT" >> "$LOG_DIR/xkeen-ui.log"
fi
ui_info "Порт панели: $PANEL_PORT"

# --- Бэкапы Xray на самой первой установке ---

echo "[*] Сохраняю порт панели в $EXISTING_ENV_FILE (XKEEN_UI_PORT=$PANEL_PORT)..."
write_env_numeric_field "$EXISTING_ENV_FILE" "XKEEN_UI_PORT" "$PANEL_PORT"

ui_step_done
ui_step "Настройки прошлой установки"
if [ "$FIRST_INSTALL" = "yes" ]; then
  echo "[*] Первая установка: создаю бэкапы конфигов Xray в $BACKUP_DIR..."
  backup_config_file "$ROUTING_FILE"
  backup_config_file "$INBOUNDS_FILE"
  backup_config_file "$OUTBOUNDS_FILE"
else
  echo "[*] Это не первая установка, автоматические бэкапы конфигов пропущены."
fi

# Пользовательский Mihomo config и профили принадлежат XKeen, а не панели.
# Старые архивы панели могли содержать opt/etc/mihomo с демонстрационными
# файлами; никогда не позволяем обновлению UI затереть действующую настройку.
MIHOMO_PRESERVE_DIR=""
if [ -e "$MIHOMO_CONFIG_FILE" ] || [ -d "$MIHOMO_PROFILES_DIR" ]; then
  MIHOMO_PRESERVE_DIR="$(mktemp -d /tmp/xkeen-ui-mihomo.XXXXXX 2>/dev/null || true)"
  if [ -n "$MIHOMO_PRESERVE_DIR" ]; then
    [ -e "$MIHOMO_CONFIG_FILE" ] && cp -L "$MIHOMO_CONFIG_FILE" "$MIHOMO_PRESERVE_DIR/config.yaml" 2>/dev/null || true
    [ -d "$MIHOMO_PROFILES_DIR" ] && cp -a "$MIHOMO_PROFILES_DIR" "$MIHOMO_PRESERVE_DIR/profiles" 2>/dev/null || true
    echo "[*] Временно сохраняю активный Mihomo config и пользовательские профили."
  fi
fi

# --- Копирование файлов панели ---

ui_step_done
ui_success "Параметры панели подготовлены"
ui_stage "04/05" "Установка файлов"
ui_stage_plan 4
ui_step "Каталоги и файлы панели"
echo "[*] Создаю директории..."
mkdir -p "$UI_DIR" "$INIT_DIR" "$LOG_DIR" "$RUN_DIR" "$BACKUP_DIR" "$JSONC_DIR"

# Этап 7 (install/upgrade): гарантируем наличие отдельного каталога для JSONC
# и пытаемся убрать legacy *.jsonc из XRAY_CONFIG_DIR.
migrate_legacy_jsonc_files || true

# Незавершённая установка модуля (её процесс погиб) оставляет часть файлов
# заменённой. Сначала возвращаем прежние: раскладывать профиль поверх смеси
# двух состояний нельзя. Если вернуть не удалось, ниже профиль всё равно
# перезапишет все управляемые файлы из архива.
if [ -d "$UI_DIR.module-transactions" ] && [ -f "$UI_DIR/scripts/module_transaction.py" ]; then
  # Живую операцию не ждём и не прерываем: она сама перезапускает панель и
  # при неудаче возвращает прежние файлы — поверх этого раскладывать нельзя.
  # Отказ безопасен: до этой строки установщик файлов панели не менял.
  # Прежняя версия скрипта команды busy не знает и отвечает кодом 2.
  MODULE_TX_BUSY=0
  "$PYTHON_BIN" "$UI_DIR/scripts/module_transaction.py" busy --panel-root "$UI_DIR" >/dev/null 2>&1 \
    || MODULE_TX_BUSY=$?
  if [ "$MODULE_TX_BUSY" -eq 3 ]; then
    fail_install "Сейчас идёт установка или удаление модуля панели. Дождитесь её завершения и запустите установку снова."
  fi
  echo "[*] Завершаю прерванную операцию с модулем..."
  "$PYTHON_BIN" "$UI_DIR/scripts/module_transaction.py" recover --panel-root "$UI_DIR" --state-dir "$UI_DIR" \
    || echo "[!] Прерванную операцию с модулем не удалось отменить; файлы панели будут перезаписаны из архива."
fi

echo "[*] Копирую файлы панели в $UI_DIR..."
PROFILE_TRANSACTION="$UI_DIR.profile-transaction-$$"
# Флаг ставится до копирования: сигнал, пришедший во время работы helper,
# оболочка обрабатывает уже после него, и без флага новые файлы остались бы
# без отката.
PROFILE_TRANSACTION_ACTIVE=1
if ! "$PYTHON_BIN" "$INSTALL_PROFILE_HELPER" apply \
    --source "$SRC_DIR" --target "$UI_DIR" --profile "$PROFILE_CHOICE" \
    --module-ids "${XKEEN_UI_INSTALL_MODULES:-}" --transaction "$PROFILE_TRANSACTION" \
    $PROFILE_APPLY_OPTIONS; then
  # Helper сам вернул прежние файлы; панель при этом не перезапускаем.
  PROFILE_TRANSACTION_ACTIVE=0
  fail_install "Не удалось применить профиль установки. Проверьте свободное место и журнал."
fi

if [ -n "$MIHOMO_PRESERVE_DIR" ] && [ -d "$MIHOMO_PRESERVE_DIR" ]; then
  mkdir -p "$MIHOMO_ROOT"
  if [ -e "$MIHOMO_PRESERVE_DIR/config.yaml" ]; then
    if [ -L "$MIHOMO_CONFIG_FILE" ]; then
      MIHOMO_ACTIVE_TARGET="$(readlink -f "$MIHOMO_CONFIG_FILE" 2>/dev/null || true)"
      [ -n "$MIHOMO_ACTIVE_TARGET" ] && cp "$MIHOMO_PRESERVE_DIR/config.yaml" "$MIHOMO_ACTIVE_TARGET" 2>/dev/null || true
    else
      cp "$MIHOMO_PRESERVE_DIR/config.yaml" "$MIHOMO_CONFIG_FILE" 2>/dev/null || true
    fi
  fi
  if [ -d "$MIHOMO_PRESERVE_DIR/profiles" ]; then
    rm -rf "$MIHOMO_PROFILES_DIR" 2>/dev/null || true
    cp -a "$MIHOMO_PRESERVE_DIR/profiles" "$MIHOMO_PROFILES_DIR" 2>/dev/null || true
  fi
  rm -rf "$MIHOMO_PRESERVE_DIR" 2>/dev/null || true
  echo "[*] Активный Mihomo config и пользовательские профили сохранены."
fi

cleanup_frontend_build_dir "$UI_DIR/static/frontend-build"
align_precompressed_mtimes "$UI_DIR/static"

# --- BUILD.json (версия/сборка) ---
# Штамп сборки берётся из устанавливаемого архива, выбор владельца — из панели.
provision_build_json "$SRC_DIR/BUILD.json" "$UI_DIR/BUILD.json"

# Скрипт удаления не принадлежит ни одному модулю, раскладка профиля его не кладёт.
provision_uninstall_script "$SRC_DIR/uninstall.sh" "$UI_DIR/uninstall.sh"

ui_step_done
ui_step "Терминал и редактор кода"
if profile_has_module tool.terminal; then
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
    fail_install "Установочный архив повреждён: отсутствуют файлы веб-терминала."
  fi
fi

# --- Команды панели в /opt/bin (sysmon, entware-backup и другие) ---
provision_command_wrappers

# Убираем legacy шаблоны из /opt/etc/xray/templates (если они были установлены ранее).
# Эта уборка не влияет на работоспособность новой панели.
if ! cleanup_legacy_xray_templates; then
  log_install "[!] Не удалось очистить legacy-шаблоны Xray; установка продолжается."
  ui_warning "Не удалось очистить старые шаблоны Xray; установка продолжается."
fi


# --- Шаблоны Mihomo ---

ui_step_done
ui_step "Шаблоны Mihomo и Xray"
if profile_has_module engine.mihomo && [ -d "$SRC_MIHOMO_TEMPLATES" ]; then
  provision_mihomo_templates "$SRC_MIHOMO_TEMPLATES" "$MIHOMO_TEMPLATES_DIR"
fi

# --- Шаблоны Xray (Routing / Observatory) ---

# Обновляем только встроенные шаблоны, которые пришли в архиве.
# Кастомные файлы пользователя с другими именами не трогаем.
if profile_has_module engine.xray; then
  sync_bundled_template_dir "$SRC_XRAY_ROUTING_TEMPLATES" "$XRAY_ROUTING_TEMPLATES_DIR" "роутинга Xray"
  sync_bundled_template_dir "$SRC_XRAY_OBSERVATORY_TEMPLATES" "$XRAY_OBSERVATORY_TEMPLATES_DIR" "observatory Xray"
fi

# --- Compat fix: обеспечить доступность DAT-файлов для Xray (ext:*.dat:...) ---

# В шаблонах/правилах панели часто используется синтаксис ext:<имя>.dat:<список>.
# В этом режиме Xray ищет файл по имени в директории assets (часто рядом с бинарником).
# Панель, в свою очередь, хранит/обновляет DAT по умолчанию в $XRAY_DAT_DIR.
# Чтобы не заставлять пользователя переносить файлы вручную — создаём symlink в $XRAY_BIN_DIR.

ui_step_done
ui_step "Списки GeoIP и GeoSite"
provision_xray_dat_links "$XRAY_DAT_DIR" "$XRAY_BIN_DIR"

# --- Compat fix: удалить отсутствующие geosite-списки из routing (xray) ---
provision_routing_compat "$ROUTING_FILE"

# --- Optional: xk-geodat (DAT GeoIP/GeoSite: "Содержимое" и "В routing") ---
GEODAT_VERDICT="skip"
if profile_has_module engine.xray && [ "${GEODAT_OPTION:-1}" = "1" ]; then
  if [ -f "$SRC_DIR/scripts/install_xk_geodat.sh" ]; then
    echo "[*] (Опционально) Устанавливаю xk-geodat для DAT GeoIP/GeoSite..."
    if sh "$SRC_DIR/scripts/install_xk_geodat.sh"; then
      GEODAT_VERDICT="on"
    else
      GEODAT_VERDICT="off"
    fi
  else
    GEODAT_VERDICT="off"
    echo "[!] Установщик xk-geodat не найден в архиве."
  fi
fi

# --- Optional: декриптор ссылок Happ (happ://crypt…) ---
# Запускается копия из $UI_DIR: движок и ключи ложатся в $UI_DIR/bin рядом с панелью.
# Ключи Happ скачиваются только после явного «да» — без терминала шаг пропускается.
if profile_has_module integration.happ && [ -f "$UI_DIR/scripts/install_happ_decryptor.py" ]; then
  "$PYTHON_BIN" "$UI_DIR/scripts/install_happ_decryptor.py" || true
fi

# --- Init-скрипт ---

ui_step_done
ui_success "Основные файлы установлены"
ui_stage "05/05" "Запуск и проверка"
ui_stage_plan 3
ui_step "Служба автозапуска"
echo "[*] Создаю init-скрипт $INIT_SCRIPT..."

# Текст службы лежит отдельным файлом: тот же файл ставит обновление из панели.
provision_init_script "$SRC_DIR/scripts/panel_init.sh" "$INIT_SCRIPT" "$PANEL_PORT"

if [ "$INIT_SCRIPT" != "$LEGACY_INIT_SCRIPT" ] && [ -e "$LEGACY_INIT_SCRIPT" ] && is_our_ui_init_script "$LEGACY_INIT_SCRIPT"; then
  echo "[*] Удаляю legacy init-скрипт $LEGACY_INIT_SCRIPT, чтобы не конфликтовать с другими панелями..."
  rm -f "$LEGACY_INIT_SCRIPT" 2>/dev/null || true
fi

ui_step_done
ui_step "Запуск сервиса"
echo "[*] Запускаю сервис..."
if ! "$INIT_SCRIPT" restart 3>&- || ! "$INIT_SCRIPT" status 3>&-; then
  fail_install "Сервис Xkeen UI не запустился. Проверьте журнал запуска панели."
fi
"$PYTHON_BIN" "$INSTALL_PROFILE_HELPER" commit --transaction "$PROFILE_TRANSACTION"
PROFILE_TRANSACTION_ACTIVE=0
# Панель поднялась на файлах из архива: копии прерванной операции с модулем
# больше не нужны и не должны блокировать следующие. Заодно закрываем её
# запись о ходе: иначе панель вечно показывала бы «выполняется».
if [ -f "$UI_DIR/scripts/module_transaction.py" ]; then
  "$PYTHON_BIN" "$UI_DIR/scripts/module_transaction.py" forget --panel-root "$UI_DIR" --state-dir "$UI_DIR" \
    >/dev/null 2>&1 || true
fi
rm -rf "$UI_DIR.module-transactions"

log_install "[=] Итог установки:"
ui_step_done
if [ "$WS_VERDICT" = "on" ]; then
  log_install "[=] WebSocket: ВКЛ — доступен полноценный терминал (PTY) и потоковые логи Xray."
else
  log_install "[=] WebSocket: ВЫКЛ — $WS_VERDICT_REASON."
  log_install "[=] Терминал останется в lite-режиме, логи Xray — через HTTP-пулинг."
  log_install "[=] Проверить пакеты: $PYTHON_BIN $UI_DIR/scripts/check_pydeps_integrity.py gevent gevent-websocket"
fi
log_install "[=] Подробности установки: $INSTALL_LOG"

# --- ОЧИСТКА УСТАНОВОЧНЫХ ФАЙЛОВ ---

INSTALL_SRC_DIR="$SRC_DIR"
INSTALL_PARENT_DIR="$(dirname "$INSTALL_SRC_DIR")"

ui_step "Уборка установочных файлов"
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

ui_step_done
ui_progress_stop
PANEL_IP="$(ip -4 addr show br0 2>/dev/null | sed -n 's/.*inet \([0-9.]*\).*/\1/p' | head -n 1 || true)"
[ -n "$PANEL_IP" ] || PANEL_IP="<IP_роутера>"
PANEL_URL="http://${PANEL_IP}:${PANEL_PORT}/"

printf '\n' >&3 2>/dev/null || true
if [ "$INSTALL_MODE" = "Обновление" ]; then
  ui_success "Xkeen UI обновлена и запущена"
else
  ui_success "Xkeen UI установлена и запущена"
fi
printf '      %bОткрыть:%b  %b%s%b\n' "$UI_BOLD" "$UI_RESET" "$UI_CYAN" "$PANEL_URL" "$UI_RESET" >&3 2>/dev/null || true

if [ "$WS_VERDICT" != "on" ]; then
  ui_warning "Терминал работает в lite-режиме: $WS_VERDICT_REASON."
fi
if [ "$GEODAT_VERDICT" = "off" ]; then
  ui_warning "xk-geodat не установился; основная панель продолжит работать."
fi
if [ "${HAPP_OPTION:-0}" = "1" ] && [ ! -x "$UI_DIR/bin/happ-decrypt-universal" ]; then
  ui_warning "Режим разработчика для подписок не установился; его можно добавить позже из DevTools."
fi

printf '      %bДиагностика:%b %s\n\n' "$UI_DIM" "$UI_RESET" "$INSTALL_LOG" >&3 2>/dev/null || true
INSTALL_FINISHED=1

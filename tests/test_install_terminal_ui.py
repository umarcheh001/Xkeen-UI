from __future__ import annotations

import shlex
import shutil
import subprocess
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
INSTALLER = ROOT / "xkeen-ui" / "install.sh"
DEV_REQUIREMENTS = ROOT / "requirements-dev.txt"


def _text() -> str:
    return INSTALLER.read_text(encoding="utf-8")


def _shell() -> str:
    shell = shutil.which("sh")
    if shell is None:
        pytest.skip("для проверки установщика нужна POSIX-оболочка sh")
    return shell


def _function(name: str) -> str:
    text = _text()
    start = text.index(name + "() {")
    return text[start:text.index("\n}\n", start) + 3]


def _require_gnu_script() -> str:
    script_bin = shutil.which("script")
    if script_bin is None:
        pytest.skip("для pseudo-TTY проверки нужна команда script")
    probe = subprocess.run([script_bin, "-qec", "true", "/dev/null"], capture_output=True, text=True, check=False)
    if probe.returncode != 0:
        pytest.skip("для pseudo-TTY проверки нужен GNU script с поддержкой -c")
    return script_bin


def test_installer_is_valid_posix_shell_syntax():
    proc = subprocess.run(["sh", "-n", str(INSTALLER)], capture_output=True, text=True)

    assert proc.returncode == 0, proc.stderr


def test_installer_treats_catalog_signature_verification_as_required_dependency():
    requirements = DEV_REQUIREMENTS.read_text(encoding="utf-8")
    installer = _text()

    assert any(line.startswith("cryptography") for line in requirements.splitlines())
    assert "NEED_CRYPTOGRAPHY=0" in installer
    assert '"$PYTHON_BIN" -c "import cryptography"' in installer
    assert 'pip_install_with_fallback "cryptography" cryptography' in installer
    assert 'fail_install "cryptography установлен некорректно' in installer


def test_installer_keeps_terminal_output_separate_from_diagnostics():
    text = _text()

    assert "exec 3>&1" in text
    assert 'exec >> "$INSTALL_LOG" 2>&1' in text
    assert 'ui_header() {' in text
    assert 'ui_error "Установка остановлена"' in text
    assert 'ui_info "Подробности: $INSTALL_LOG"' in text
    assert text.index('exec >> "$INSTALL_LOG" 2>&1') < text.index('echo "  Xkeen Web UI — УСТАНОВКА"')


def test_installer_terminal_ui_has_compact_named_stages():
    text = _text()

    expected = (
        'ui_stage "01/05" "Проверка окружения"',
        'ui_stage "02/05" "Подготовка компонентов"',
        'ui_stage "03/05" "Настройка панели"',
        'ui_stage "04/05" "Установка файлов"',
        'ui_stage "05/05" "Запуск и проверка"',
    )
    positions = [text.index(stage) for stage in expected]

    assert positions == sorted(positions)
    assert 'XK / XKEEN UI' in text
    assert 'ROUTER CONTROL' in text
    assert 'UI_HEADER_RIGHT="${UI_ESC}[44G"' in text
    assert '╔%s╗' in text
    assert '╚%s╝' in text


def test_installer_exposes_optional_component_choices_without_child_prompt_noise():
    text = _text()

    assert 'choose_geodat_option() {' in text
    assert 'Просмотрщик DAT-файлов' in text
    assert 'ui_confirm_default_yes() {' in text
    assert 'ui_confirm_default_yes "Установить xk-geodat?"' in text
    assert 'GEODAT_OPTION="1"' in text
    assert 'export XKEEN_GEODAT_INSTALL' in text
    assert 'if profile_has_module engine.xray && [ "${GEODAT_OPTION:-1}" = "1" ]; then' in text
    assert 'choose_happ_option() {' in text
    assert 'Режим разработчика для подписок' in text
    assert 'Компоненты загрузятся с GitHub.' in text
    assert 'ui_confirm_default_yes "Установить?"' in text
    happ = text[text.index('choose_happ_option() {'):text.index('\n}\n', text.index('choose_happ_option() {'))]
    assert 'HAPP_OPTION="1"\n  if [ -t 0 ]' in happ
    assert 'n|N|no|NO|No|н|Н|нет|НЕТ|Нет) HAPP_OPTION="0"' in happ
    assert '[y/N]' not in happ
    assert 'export XKEEN_HAPP_DECRYPTOR_INSTALL' in text


def test_installer_keeps_confirmation_input_visible_and_colours_final_answer():
    text = _text()

    prompt = text[text.index('ui_confirm_default_yes() {'):text.index('\n}\n', text.index('ui_confirm_default_yes() {'))]
    assert 'stty -echo' not in prompt
    assert 'IFS= read -r UI_CONFIRM_ANSWER < /dev/tty' in prompt
    assert "'      %s [%bY%b/%bn%b]: '" in prompt
    assert '"$UI_GREEN" "$UI_RESET" "$UI_YELLOW" "$UI_RESET"' in prompt
    assert "printf '%b%s%b' \"$UI_GREEN\" \"$UI_CONFIRM_ANSWER\"" in prompt
    assert "printf '%b%s%b' \"$UI_YELLOW\" \"$UI_CONFIRM_ANSWER\"" in prompt
    assert "printf '%b[1A\\r%b[2K      %s" in prompt
    assert '"$UI_ESC" "$UI_ESC" "$_ui_prompt"' in prompt
    assert 'UI_CONFIRM_ANSWER' in prompt
    assert 'printf \'      %bОткрыть:%b  %b%s%b\\n\'' in text
    assert '"$UI_CYAN" "$PANEL_URL" "$UI_RESET"' in text


def test_interrupt_handler_does_not_leave_terminal_echo_disabled():
    text = _text()

    assert 'stty -echo' not in text
    assert 'UI_CONFIRM_STTY_MODE' not in text
    assert 'installer_on_interrupt() {' in text
    assert "trap 'installer_on_interrupt' HUP INT TERM" in text


def test_profile_status_uses_sticky_safe_output_while_progress_ticker_is_active():
    text = _text()

    profile_body = text[text.index('choose_panel_profile() {'):text.index('\n}\n', text.index('choose_panel_profile() {'))]
    assert 'ui_line "$(printf \'  %bПрофиль:%b     %s\'' in profile_body
    assert "printf '  %bПрофиль:%b     %s\\n'" not in profile_body


def test_profile_status_renders_without_literal_quotes():
    """The interactive installer must show a clean profile status line."""

    script = "\n".join(
        (
            "set -e",
            f"SRC_DIR={shlex.quote(str(ROOT / 'xkeen-ui'))}",
            "UI_DIR=/tmp/xkeen-profile-status-missing",
            "PYTHON_BIN=python3",
            'UI_DIM=""',
            'UI_RESET=""',
            "ui_line() { printf '%s\\n' \"$1\"; }",
            "XKEEN_UI_INSTALL_PROFILE=full",
            _function("choose_panel_profile"),
            "choose_panel_profile",
        )
    )
    proc = subprocess.run([_shell(), "-c", script], capture_output=True, text=True)

    assert proc.returncode == 0, proc.stderr
    assert proc.stdout == "  Профиль:     full\n"


def test_profile_menu_pauses_progress_and_accepts_numbered_choice():
    """The profile prompt must own the TTY while the progress ticker is active."""

    script_bin = _require_gnu_script()

    events = Path("profile-menu-events.log")
    script = "\n".join(
        (
            "set -eu",
            "exec 3>&1",
            f"SRC_DIR={shlex.quote(str(ROOT / 'xkeen-ui'))}",
            "UI_DIR=/tmp/xkeen-profile-menu-missing",
            "PYTHON_BIN=python3",
            'UI_DIM=""',
            'UI_RESET=""',
            'UI_BOLD=""',
            'UI_PROGRESS_TTY=1',
            'UI_TICKER=123',
            f"EVENTS={shlex.quote(str(events))}",
            ": > \"$EVENTS\"",
            'ui_hold() { printf "hold\\n" >> "$EVENTS"; }',
            'ui_release() { printf "release\\n" >> "$EVENTS"; }',
            'ui_sticky_clear() { printf "clear\\n" >> "$EVENTS"; }',
            'ui_sticky_draw() { printf "draw\\n" >> "$EVENTS"; }',
            'ui_info() { printf "info:%s\\n" "$1" >&3; }',
            'ui_line() { printf "line:%s\\n" "$1" >> "$EVENTS"; }',
            'fail_install() { printf "fail:%s\\n" "$1" >> "$EVENTS"; exit 1; }',
            _function("ui_input_begin"),
            _function("ui_input_end"),
            _function("choose_panel_profile"),
            "choose_panel_profile",
            'printf "chosen:%s\\n" "$PROFILE_CHOICE" >> "$EVENTS"',
            'cat "$EVENTS"',
        )
    )
    try:
        proc = subprocess.run(
            [script_bin, "-qec", f"sh -c {shlex.quote(script)}", "/dev/null"],
            input="3\n",
            capture_output=True,
            text=True,
            check=False,
        )
    finally:
        events.unlink(missing_ok=True)

    output = proc.stdout.replace("\r\n", "\n")
    assert proc.returncode == 0, proc.stderr
    assert output.count("1) Full") == 1
    assert output.count("2) Xray Minimal") == 1
    assert output.count("3) Mihomo Minimal") == 1
    assert output.count("4) Custom") == 1
    assert "chosen:mihomo-minimal" in output
    assert "hold\nclear\ndraw\nrelease\n" in output


def test_custom_profile_keeps_progress_paused_until_modules_are_entered():
    """Custom module input must stay above the ticker after choosing profile 4."""

    script_bin = _require_gnu_script()

    events = Path("custom-profile-menu-events.log")
    script = "\n".join(
        (
            "set -eu",
            "exec 3>&1",
            f"SRC_DIR={shlex.quote(str(ROOT / 'xkeen-ui'))}",
            "UI_DIR=/tmp/xkeen-custom-profile-menu-missing",
            "PYTHON_BIN=python3",
            'UI_DIM=""',
            'UI_RESET=""',
            'UI_BOLD=""',
            'UI_PROGRESS_TTY=1',
            'UI_TICKER=123',
            f"EVENTS={shlex.quote(str(events))}",
            ": > \"$EVENTS\"",
            'ui_hold() { printf "hold\\n" >> "$EVENTS"; }',
            'ui_release() { printf "release\\n" >> "$EVENTS"; }',
            'ui_sticky_clear() { printf "clear\\n" >> "$EVENTS"; }',
            'ui_sticky_draw() { printf "draw\\n" >> "$EVENTS"; }',
            'ui_info() { printf "info:%s\\n" "$1" >> "$EVENTS"; }',
            'ui_line() { printf "line:%s\\n" "$1" >> "$EVENTS"; }',
            'fail_install() { printf "fail:%s\\n" "$1" >> "$EVENTS"; exit 1; }',
            _function("ui_input_begin"),
            _function("ui_input_end"),
            _function("choose_panel_profile"),
            "choose_panel_profile",
            'printf "chosen:%s modules:%s\\n" "$PROFILE_CHOICE" "$XKEEN_UI_INSTALL_MODULES" >> "$EVENTS"',
            'cat "$EVENTS"',
        )
    )
    try:
        proc = subprocess.run(
            [script_bin, "-qec", f"sh -c {shlex.quote(script)}", "/dev/null"],
            input="4\ncore,tool.files\n",
            capture_output=True,
            text=True,
            check=False,
        )
    finally:
        events.unlink(missing_ok=True)

    output = proc.stdout.replace("\r\n", "\n")
    assert proc.returncode == 0, proc.stderr
    assert "4) Custom" in output
    assert "ID через запятую:" in output
    assert "hold\nclear\ninfo:Модули:" in output
    assert "draw\nrelease\nline:  Профиль:     custom" in output
    assert "chosen:custom modules:core,tool.files" in output


def test_legacy_template_cleanup_uses_requested_directory_and_ignores_nonempty_dirs(tmp_path):
    """Legacy cleanup cannot abort an update when a user file keeps a dir nonempty."""

    legacy = tmp_path / "templates"
    routing = legacy / "routing"
    observatory = legacy / "observatory"
    routing.mkdir(parents=True)
    observatory.mkdir()
    bundled = routing / "05_routing_base.jsonc"
    foreign = routing / "user-template.jsonc"
    bundled.write_text("bundled", encoding="utf-8")
    foreign.write_text("user", encoding="utf-8")

    script = "\n".join(
        (
            "set -e",
            _function("cleanup_legacy_xray_templates"),
            f"cleanup_legacy_xray_templates {shlex.quote(str(legacy))}",
        )
    )
    proc = subprocess.run([_shell(), "-c", script], capture_output=True, text=True)

    assert proc.returncode == 0, proc.stderr
    assert not bundled.exists()
    assert foreign.read_text(encoding="utf-8") == "user"


def test_unexpected_installer_exit_reports_the_last_action_and_exit_code():
    text = _text()
    progress = text[text.index("ui_step() {"):text.index("\n}\n", text.index("ui_step() {"))]
    trap_body = text[text.index("installer_on_exit() {"):text.index("\n}\n", text.index("installer_on_exit() {"))]

    assert 'INSTALL_CURRENT_ACTION="$1"' in progress
    assert 'log_install "[!] Установка остановлена: код $INSTALL_STATUS' in trap_body
    assert 'ui_info "Последнее действие: ${INSTALL_CURRENT_ACTION:-не определено} (код $INSTALL_STATUS)."' in trap_body
    assert "if ! cleanup_legacy_xray_templates; then" in text


def test_installer_only_reports_success_after_service_health_check():
    text = _text()

    health_check = 'if ! "$INIT_SCRIPT" restart 3>&- || ! "$INIT_SCRIPT" status 3>&-; then'
    success = 'ui_success "Xkeen UI установлена и запущена"'

    assert health_check in text
    assert '"$INIT_SCRIPT" restart || true' not in text
    assert 'restart 3>&-' in text, "the detached service must not inherit the terminal UI descriptor"
    assert text.index(health_check) < text.index(success)
    assert 'INSTALL_FINISHED=1' in text

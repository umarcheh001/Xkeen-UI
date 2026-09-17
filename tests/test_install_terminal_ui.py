from __future__ import annotations

import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
INSTALLER = ROOT / "xkeen-ui" / "install.sh"


def _text() -> str:
    return INSTALLER.read_text(encoding="utf-8")


def test_installer_is_valid_posix_shell_syntax():
    proc = subprocess.run(["sh", "-n", str(INSTALLER)], capture_output=True, text=True)

    assert proc.returncode == 0, proc.stderr


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
    assert 'Установить xk-geodat? [Y/n]:' in text
    assert 'GEODAT_OPTION="1"' in text
    assert 'export XKEEN_GEODAT_INSTALL' in text
    assert 'if [ "${GEODAT_OPTION:-1}" = "1" ]; then' in text
    assert 'choose_happ_option() {' in text
    assert 'Режим разработчика для подписок' in text
    assert 'Компоненты загрузятся с GitHub.' in text
    assert 'Установить? [y/N]:' in text
    assert 'export XKEEN_HAPP_DECRYPTOR_INSTALL' in text


def test_installer_only_reports_success_after_service_health_check():
    text = _text()

    health_check = 'if ! "$INIT_SCRIPT" restart 3>&- || ! "$INIT_SCRIPT" status 3>&-; then'
    success = 'ui_success "Xkeen UI установлена и запущена"'

    assert health_check in text
    assert '"$INIT_SCRIPT" restart || true' not in text
    assert 'restart 3>&-' in text, "the detached service must not inherit the terminal UI descriptor"
    assert text.index(health_check) < text.index(success)
    assert 'INSTALL_FINISHED=1' in text

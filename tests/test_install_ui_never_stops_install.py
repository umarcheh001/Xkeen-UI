"""Сбой печати в терминал не останавливает установку.

Установщик работает в режиме «любая ошибка — стоп», а экран для него — обычный
файл: запись в него может не удаться (терминал по сети не успел принять вывод,
сеанс оборвался). Оболочка роутера сообщает об этом только кодом возврата, без
единой строки в журнале. Так установка у пользователя остановилась на заголовке
этапа «Установка файлов», не тронув ни одного файла.
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
INSTALLER = ROOT / "xkeen-ui" / "install.sh"
UI_BEGIN = "ui_header() {"
UI_END = "# --- ui-progress: end"
SCREEN = re.compile(r'>&(3|"\$INSTALL_UI_FD")')
GUARDED = re.compile(r'>&(3|"\$INSTALL_UI_FD") 2>/dev/null \|\| true$')


def _ui_code() -> str:
    text = INSTALLER.read_text(encoding="utf-8")
    return text[text.index(UI_BEGIN) : text.index(UI_END)]


@pytest.mark.parametrize("tty", ["0", "1"])
def test_a_screen_that_refuses_output_does_not_abort_the_script(tty, tmp_path):
    if not Path("/dev/full").exists() and subprocess.run(
        ["sh", "-c", "test -e /dev/full"], capture_output=True
    ).returncode != 0:
        pytest.skip("no /dev/full here")
    script = "\n".join(
        [
            "set -e",
            'UI_RESET=""; UI_BOLD=""; UI_DIM=""; UI_CYAN=""; UI_GREEN=""; UI_YELLOW=""; UI_RED=""',
            'UI_HEADER_RIGHT=""; INSTALL_STAGE=""; INSTALL_CURRENT_ACTION=""',
            "INSTALL_UI_FD=3",
            # Каждая запись на такой экран заканчивается ошибкой.
            "exec 3>/dev/full",
            f"UI_PROGRESS_TTY={tty}",
            _ui_code(),
            "ui_progress_start",
            "ui_header",
            'ui_stage "04/05" "files"',
            "ui_stage_plan 2",
            'ui_step "first"',
            'ui_info "info"; ui_success "ok"; ui_warning "careful"; ui_line "line"',
            "ui_step_done",
            'ui_step "second"',
            'ui_step_skip "skipped"',
            'ui_error "stopped"',
            "ui_progress_stop",
            "echo survived",
        ]
    )

    # Файлом, а не аргументом: в блоке есть кириллица и псевдографика, которые
    # командная строка Windows до оболочки не доносит.
    path = tmp_path / "ui.sh"
    path.write_bytes(script.encode("utf-8"))

    proc = subprocess.run(["sh", path.as_posix()], capture_output=True, text=True, encoding="utf-8")

    assert proc.returncode == 0, proc.stderr
    assert proc.stdout.strip().endswith("survived")


def test_every_write_to_the_screen_is_allowed_to_fail():
    unguarded = [
        f"{number}: {line.strip()}"
        for number, line in enumerate(INSTALLER.read_text(encoding="utf-8").splitlines(), start=1)
        if SCREEN.search(line) and not line.lstrip().startswith("#") and "exec 3>&1" not in line
        and not GUARDED.search(line.rstrip())
    ]

    assert unguarded == []

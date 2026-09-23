"""Прогресс установки: шаги с галочками и шкала из квадратов.

Блок помощников в install.sh обрамлён маркерами, поэтому его можно вынуть и
выполнить отдельно — без запуска самого установщика. Так проверяется не текст
скрипта, а поведение: что печатается на экран при перехваченном выводе и как
выглядит шкала.
"""

from __future__ import annotations

import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
INSTALLER = ROOT / "xkeen-ui" / "install.sh"

BEGIN = "# --- ui-progress: begin"
END = "# --- ui-progress: end"

ESC = "\033"


def _text() -> str:
    return INSTALLER.read_text(encoding="utf-8")


def _block() -> str:
    text = _text()
    start = text.index(BEGIN)
    end = text.index(END)
    return text[start:end]


def _run(body: str, tty: str = "0") -> str:
    """Выполнить кусок сценария поверх блока прогресса и вернуть вывод экрана."""

    script = "\n".join(
        [
            "set -e",
            'UI_RESET=""',
            'UI_BOLD=""',
            'UI_DIM=""',
            'UI_CYAN=""',
            'UI_GREEN=""',
            'UI_YELLOW=""',
            'UI_RED=""',
            "INSTALL_UI_FD=3",
            "exec 3>&1",
            f"UI_PROGRESS_TTY={tty}",
            _block(),
            body,
        ]
    )
    proc = subprocess.run(
        ["sh", "-c", script], capture_output=True, text=True, encoding="utf-8"
    )
    assert proc.returncode == 0, proc.stderr
    return proc.stdout


def test_progress_block_is_marked_and_self_contained():
    text = _text()

    assert BEGIN in text
    assert END in text
    assert text.index(BEGIN) < text.index(END)

    block = _block()
    # Блок не должен звать остальной установщик: иначе его нельзя вынуть и
    # проверить, а сторож ниже начнёт врать.
    for foreign in ("ui_info", "ui_success", "fail_install", "log_install"):
        assert foreign + " " not in block, foreign


def test_steps_are_announced_and_closed_with_duration():
    out = _run(
        """
        ui_progress_start
        ui_stage_plan 2
        ui_step "flask"
        ui_step_done
        ui_step "gevent"
        ui_step_done
        """
    )

    assert "→  flask…" in out
    assert "✓  flask" in out
    assert "→  gevent…" in out
    assert "✓  gevent" in out
    # Длительность приписывается к закрытому шагу.
    assert " с" in out.split("✓  flask")[1].splitlines()[0]


def test_skipped_step_still_closes_the_square():
    out = _run(
        """
        ui_progress_start
        ui_stage_plan 2
        ui_step "python3"
        ui_step_skip "уже установлен"
        ui_step "flask"
        ui_step_done
        """
    )

    assert "уже установлен" in out
    assert out.count("✓") == 2


def test_squares_show_done_current_and_pending():
    out = _run(
        """
        UI_PLAN="2 3"
        UI_STEP_DONE=3
        UI_STEP_CURRENT=4
        ui_squares
        printf '\\n'
        """
    )

    line = out.strip()
    assert line.count("■") == 3, line
    assert line.count("▣") == 1, line
    assert line.count("□") == 1, line
    # Группы этапов разделены двойным пробелом, шаги внутри группы — одинарным.
    assert "  " in line


def test_captured_output_keeps_plain_lines_without_escapes():
    out = _run(
        """
        ui_progress_start
        ui_stage_plan 1
        ui_step "распаковка"
        ui_step_done
        ui_progress_stop
        """
    )

    assert ESC not in out
    assert "\r" not in out


def test_ticker_is_stopped_from_the_exit_trap():
    text = _text()

    trap_body = text[text.index("installer_on_exit() {"):]
    trap_body = trap_body[: trap_body.index("\n}\n")]
    assert "ui_progress_stop" in trap_body


def test_every_stage_declares_a_plan_matching_its_steps():
    text = _text()

    # Куски скрипта между ui_stage: в каждом должен стоять план и ровно
    # столько ui_step, сколько он обещает.
    chunks = text.split('ui_stage "')[1:]
    assert len(chunks) == 5

    for chunk in chunks:
        head = chunk[: chunk.index('"')]
        body = chunk
        assert "ui_stage_plan " in body, head
        promised = int(body.split("ui_stage_plan ")[1].split()[0])
        actual = body.count("\nui_step ") + body.count("  ui_step ") + body.count("    ui_step ")
        assert actual == promised, f"{head}: обещано {promised}, шагов {actual}"


def test_rich_mode_draws_the_sticky_block_and_cleans_up_after_itself():
    """В терминале внизу живёт блок из двух строк, и после остановки его нет."""

    out = _run(
        """
        UI_CYAN="<c>"; UI_DIM="<d>"; UI_GREEN="<g>"; UI_YELLOW="<y>"; UI_RESET="<r>"
        ui_progress_start
        ui_stage_plan 2
        ui_step "gevent"
        sleep 2
        ui_step_done
        ui_progress_stop
        printf 'после блока\n' >&3
        [ -f "$UI_TICKER_FILE" ] && printf 'ФАЙЛ ОСТАЛСЯ\n' >&3
        exit 0
        """,
        tty="1",
    )

    # Спиннер и шкала нарисованы, курсор спрятан и возвращён.
    assert "gevent" in out
    assert "■" in out or "▣" in out
    assert ESC + "[?25l" in out
    assert ESC + "[?25h" in out
    # Блок убирает себя: последняя видимая строка — та, что напечатали после него.
    assert out.rstrip().endswith("после блока")
    assert "ФАЙЛ ОСТАЛСЯ" not in out


def test_ticker_redraws_while_a_long_step_runs():
    """Пока шаг идёт, таймер тикает сам — это и есть признак «не зависло»."""

    out = _run(
        """
        ui_progress_start
        ui_stage_plan 1
        ui_step "долгий шаг"
        sleep 3
        ui_step_done
        ui_progress_stop
        """,
        tty="1",
    )

    # За три секунды блок перерисовался несколько раз: кадры спиннера сменились.
    frames = sum(out.count(ch) for ch in "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏")
    assert frames >= 3, frames

    # И ни один кадр не развалился на части: вырезка по байтам ломает UTF-8.
    assert "\xa0" not in repr(out)


def test_plain_lines_erase_the_sticky_block_before_printing():
    """ui_info и соседи печатают только поверх погашенного блока прогресса."""

    text = _text()
    closing = "\n}\n"

    for name in ("ui_stage", "ui_info", "ui_success", "ui_warning", "ui_error"):
        body = text[text.index(name + "() {"):]
        body = body[: body.index(closing)]
        assert "ui_hold" in body, name
        assert "ui_sticky_clear" in body, name
        assert "ui_release" in body, name

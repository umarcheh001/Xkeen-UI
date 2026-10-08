"""Нижний блок прогресса не рвёт экран установки.

Блок рисует отдельный процесс, и на время печати обычных строк установщик его
замораживает. Кадр печатался по частям — три десятка записей в терминал, — и
заморозка посреди кадра оставляла курсор не там, где его ждал установщик:
строка шага ложилась поверх шкалы, а после разморозки хвост старого кадра
дорисовывался поверх новых строк. На роутере это выглядело как обрывки шкалы и
спиннера между шагами.

Здесь вывод установщика проигрывается на маленьком «экране», который понимает
те же управляющие последовательности, и проверяется, что на нём осталось.
"""

from __future__ import annotations

import re
import subprocess
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
INSTALLER = ROOT / "xkeen-ui" / "install.sh"

BEGIN = "# --- ui-progress: begin"
END = "# --- ui-progress: end"

BLOCK_MARKS = "■▣□⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
TOKEN = re.compile(r"\033\[\?25[lh]|\033\[K|\033\[2K|\033\[1A|\r|\n|[^\033\r\n]+|\033", re.S)


def _block() -> str:
    text = INSTALLER.read_text(encoding="utf-8")
    return text[text.index(BEGIN):text.index(END)]


def _screen(stream: str) -> list[str]:
    """Что осталось бы на экране терминала после такого вывода."""

    rows: list[list[str]] = [[]]
    row = col = 0
    for token in TOKEN.findall(stream):
        if token == "\r":
            col = 0
        elif token == "\n":
            row += 1
            col = 0
            if row == len(rows):
                rows.append([])
        elif token == "\033[1A":
            row = max(0, row - 1)
        elif token == "\033[K":
            del rows[row][col:]
        elif token == "\033[2K":
            rows[row] = []
        elif token.startswith("\033"):
            continue
        else:
            line = rows[row]
            for char in token:
                if col < len(line):
                    line[col] = char
                else:
                    line.extend(" " * (col - len(line)))
                    line.append(char)
                col += 1
    return [text for text in ("".join(line).rstrip() for line in rows) if text]


def _run(body: str) -> str:
    script = "\n".join(
        [
            "set -e",
            'UI_RESET=""; UI_BOLD=""; UI_DIM=""; UI_CYAN=""; UI_GREEN=""; UI_YELLOW=""; UI_RED=""',
            "INSTALL_UI_FD=3",
            "exec 3>&1",
            "UI_PROGRESS_TTY=1",
            _block(),
            body,
        ]
    )
    with tempfile.TemporaryDirectory() as folder:
        path = Path(folder) / "progress.sh"
        path.write_bytes(script.encode("utf-8"))
        # Байтами: текстовый режим подменил бы возврат каретки переводом строки.
        proc = subprocess.run(["sh", path.as_posix()], capture_output=True, timeout=120)
    assert proc.returncode == 0, proc.stderr.decode("utf-8", "replace")
    return proc.stdout.decode("utf-8")


# Часть кадра считается долго: так заморозка заведомо застаёт тикер за работой
# над кадром, а не между кадрами.
SLOW_FRAME = """
ui_clock() { sleep 1; printf '00:01'; }
"""


def test_the_screen_emulator_understands_the_block():
    # Сам «экран» должен убирать блок так же, как терминал: иначе проверки ниже
    # ничего не значат.
    stream = "\r\033[K  ⠋  шаг  1 с\n\033[K  ■ □  0/2\033[1A\r" + "\r\033[K\n\033[K\033[1A\r" + "      ✓  шаг  1 с\n"

    assert _screen(stream) == ["      ✓  шаг  1 с"]


def test_a_frame_goes_to_the_terminal_in_one_piece():
    out = _run(
        """
        ui_progress_start
        ui_stage_plan 1
        ui_step "шаг"
        ui_progress_stop
        """
    )

    # Кадр — одна запись: от очистки первой строки до возврата курсора на неё.
    frames = re.findall(r"\r\033\[K  .  шаг[^\r]*\033\[1A\r", out)
    assert frames, repr(out)
    assert all(frame.count("\n") == 1 for frame in frames)

    text = INSTALLER.read_text(encoding="utf-8")
    draw = text[text.index("ui_sticky_draw() {"):]
    draw = draw[: draw.index("\n}\n")]
    # Одна запись в терминал на кадр: части кадра собираются до печати.
    assert draw.count('>&"$INSTALL_UI_FD"') == 1, draw


def test_steps_closed_while_the_ticker_is_busy_leave_a_clean_screen():
    out = _run(
        SLOW_FRAME
        + """
        ui_progress_start
        ui_stage_plan 3
        for name in первый второй третий; do
          ui_step "$name"
          sleep 1
          ui_step_close "✓" "" "готово"
        done
        sleep 3
        ui_progress_stop
        printf 'конец\\n' >&3
        """
    )

    assert _screen(out) == [
        "      ✓  первый  готово",
        "      ✓  второй  готово",
        "      ✓  третий  готово",
        "конец",
    ], _screen(out)


def test_plain_lines_between_steps_stay_whole():
    out = _run(
        SLOW_FRAME
        + """
        ui_progress_start
        ui_stage_plan 2
        ui_step "первый"
        sleep 1
        ui_line "строка посреди шага"
        sleep 1
        ui_step_close "✓" "" "готово"
        sleep 2
        ui_line "строка между шагами"
        ui_step "второй"
        sleep 1
        ui_step_close "✓" "" "готово"
        ui_progress_stop
        """
    )

    screen = _screen(out)
    assert screen == [
        "строка посреди шага",
        "      ✓  первый  готово",
        "строка между шагами",
        "      ✓  второй  готово",
    ], screen
    assert not [line for line in screen if any(mark in line for mark in BLOCK_MARKS)]

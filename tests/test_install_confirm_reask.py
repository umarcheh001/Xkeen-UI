"""Непонятный ответ на вопрос установщика — не согласие.

Вопросы «Установить? [Y/n]» принимали за «да» всё, что не похоже на «нет»:
опечатку, букву в другой раскладке, случайный символ. Человек, нажавший «и»,
получал дополнение, которого не выбирал, и нигде об этом не узнавал. Теперь
установщик переспрашивает, а если ответа так и не понял — говорит, что выбрал.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
INSTALLER = ROOT / "xkeen-ui" / "install.sh"


def _confirm_function() -> str:
    text = INSTALLER.read_text(encoding="utf-8")
    start = text.index("ui_confirm_default_yes() {")
    body = text[start:text.index("\n}\n", start) + 3]
    # В проверке ответы приходят со стандартного ввода, а не с терминала.
    assert "< /dev/tty" in body
    return body.replace(" < /dev/tty", "")


def _ask(tmp_path: Path, answers: str) -> tuple[str, str]:
    script = tmp_path / "ask.sh"
    # Файлом, а не через `sh -c`: длинный сценарий с кириллицей на Windows до
    # оболочки не доходит.
    script.write_bytes(
        "\n".join(
            [
                "set -e",
                "exec 3>&1",
                'UI_GREEN=""; UI_YELLOW=""; UI_RESET=""; UI_ESC=""',
                _confirm_function(),
                'ui_confirm_default_yes "Установить?"',
                'echo "answer=[$UI_CONFIRM_ANSWER]"',
                "",
            ]
        ).encode("utf-8")
    )
    proc = subprocess.run(
        ["sh", script.as_posix()], input=answers.encode("utf-8"), capture_output=True, check=False
    )
    out = proc.stdout.decode("utf-8", "replace")
    assert proc.returncode == 0, out + proc.stderr.decode("utf-8", "replace")
    return out.rsplit("answer=[", 1)[1].split("]", 1)[0], out


@pytest.mark.parametrize("answer", ["y", "Y", "да", "Д", "n", "N", "нет", "Н", ""])
def test_a_clear_answer_is_taken_at_once(tmp_path, answer):
    got, out = _ask(tmp_path, answer + "\n")

    assert got == answer
    assert out.count("Установить?") == 1


def test_an_answer_that_is_neither_yes_nor_no_is_asked_again(tmp_path):
    got, out = _ask(tmp_path, "и\nn\n")

    assert got == "n"
    assert out.count("Установить?") == 2
    # Человеку сказано, чего от него ждут.
    assert "y" in out.split("Установить?")[1] and "n" in out.split("Установить?")[1]


def test_enter_after_a_slip_still_means_the_offered_choice(tmp_path):
    got, out = _ask(tmp_path, "и\n\n")

    assert got == ""
    assert out.count("Установить?") == 2


def test_after_several_slips_the_installer_says_what_it_chose(tmp_path):
    got, out = _ask(tmp_path, "и\nи\nи\nи\nи\n")

    # Бесконечно спрашивать нельзя: выбирается предложенный вариант, но не молча.
    assert got == ""
    assert out.count("Установить?") == 3
    assert "по умолчанию" in out


def test_a_closed_terminal_does_not_hang_the_question(tmp_path):
    got, out = _ask(tmp_path, "")

    assert got == ""
    assert out.count("Установить?") == 1

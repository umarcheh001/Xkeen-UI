"""Непонятный ответ на вопрос установщика — не согласие.

Вопросы «Установить? [Y/n]» принимали за «да» всё, что не похоже на «нет»:
опечатку, букву в другой раскладке, случайный символ. Человек, нажавший «и»,
получал дополнение, которого не выбирал, и нигде об этом не узнавал. Теперь
установщик переспрашивает до получения явного ответа.

Интерактивный вопрос требует явного ответа, в том числе после ошибок и Enter.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
INSTALLER = ROOT / "xkeen-ui" / "install.sh"


def _confirm_function() -> str:
    text = INSTALLER.read_text(encoding="utf-8")
    start = text.index("ui_confirm_kind() {")
    body = text[start:text.index("\n}\n", text.index("ui_confirm() {", start)) + 3]
    # В проверке ответы приходят со стандартного ввода, а не с терминала.
    assert "< /dev/tty" in body
    return body.replace(" < /dev/tty", "")


def _ask(tmp_path: Path, answers: str, default: str = "y", expect_failure: bool = False) -> tuple[str, str, str]:
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
                f'ui_confirm {default} "Установить?"',
                'echo "answer=[$UI_CONFIRM_ANSWER] yes=[$UI_CONFIRM_YES]"',
                "",
            ]
        ).encode("utf-8")
    )
    proc = subprocess.run(
        ["sh", script.as_posix()], input=answers.encode("utf-8"), capture_output=True, check=False
    )
    out = proc.stdout.decode("utf-8", "replace")
    if expect_failure:
        assert proc.returncode != 0
        return "", "", out
    assert proc.returncode == 0, out + proc.stderr.decode("utf-8", "replace")
    tail = out.rsplit("answer=[", 1)[1]
    answer = tail.split("]", 1)[0]
    yes = tail.split("yes=[", 1)[1].split("]", 1)[0]
    return answer, yes, out


@pytest.mark.parametrize(
    "answer, yes",
    [
        ("y", "1"), ("Y", "1"), ("yes", "1"), ("YES", "1"), ("yEs", "1"),
        ("да", "1"), ("Да", "1"), ("ДА", "1"), ("д", "1"), ("Д", "1"),
        ("n", "0"), ("N", "0"), ("no", "0"), ("No", "0"),
        ("нет", "0"), ("Нет", "0"), ("НЕТ", "0"), ("н", "0"), ("Н", "0"),
    ],
)
def test_a_clear_answer_is_taken_at_once(tmp_path, answer, yes):
    got, got_yes, out = _ask(tmp_path, answer + "\n")

    assert got == answer
    assert got_yes == yes
    assert out.count("Установить?") == 1


@pytest.mark.parametrize("answer", ["т"])
def test_a_single_cyrillic_letter_is_asked_again_with_a_layout_hint(tmp_path, answer):
    """Нераспознанная кириллица вызывает подсказку о раскладке."""
    got, yes, out = _ask(tmp_path, answer + "\ny\n", default="n")

    assert got == "y"
    assert yes == "1"
    assert out.count("Установить?") == 2
    assert "русская раскладка" in out


def test_a_latin_slip_gets_no_layout_hint(tmp_path):
    _got, _yes, out = _ask(tmp_path, "q\nn\n")

    assert "Не понял ответ" in out
    assert "раскладка" not in out


@pytest.mark.parametrize(
    "default, answer, yes",
    [
        ("y", "n", "0"),
        ("y", "ДА", "1"),
        ("n", "y", "1"),
        ("n", "Да", "1"),
        ("n", "нет", "0"),
    ],
)
def test_a_clear_answer_is_independent_of_the_previous_default(tmp_path, default, answer, yes):
    _got, got_yes, _out = _ask(tmp_path, answer + "\n", default=default)

    assert got_yes == yes


def test_the_prompt_does_not_offer_an_implicit_choice(tmp_path):
    _got, _yes, out = _ask(tmp_path, "n\n")
    assert "[y/n]" in out


def test_an_answer_that_is_neither_yes_nor_no_is_asked_again(tmp_path):
    got, _yes, out = _ask(tmp_path, "и\nn\n")

    assert got == "n"
    assert out.count("Установить?") == 2
    # Человеку сказано, чего от него ждут.
    assert "y" in out.split("Установить?")[1] and "n" in out.split("Установить?")[1]


def test_a_closed_terminal_does_not_hang_the_question(tmp_path):
    _got, _yes, out = _ask(tmp_path, "", default="n", expect_failure=True)
    assert out.count("Установить?") == 1


@pytest.mark.parametrize("default", ["y", "n"])
def test_enter_requires_an_explicit_answer(tmp_path, default):
    got, yes, out = _ask(tmp_path, "\n\nn\n", default=default)
    assert (got, yes) == ("n", "0")
    assert out.count("Установить?") == 3


def test_repeated_invalid_answers_do_not_select_a_default(tmp_path):
    got, yes, out = _ask(tmp_path, "q\nq\nq\nq\ny\n", default="n")
    assert (got, yes) == ("y", "1")
    assert out.count("Установить?") == 5


def _geodat_choice(tmp_path: Path, verdict: str) -> str:
    text = INSTALLER.read_text(encoding="utf-8")
    start = text.index("choose_geodat_option() {")
    body = text[start:text.index("\n}\n", start) + 3]
    src = tmp_path / "src"
    (src / "scripts").mkdir(parents=True)
    (src / "scripts" / "install_xk_geodat.sh").write_bytes(
        ('[ "$XKEEN_GEODAT_CHECK_ONLY" = "1" ] || exit 9\necho "xk-geodat: noise"\necho "%s"\n' % verdict).encode()
    )
    script = tmp_path / "choose.sh"
    script.write_bytes(
        "\n".join(
            [
                "exec 3>&1",
                'UI_DIM=""; UI_BOLD=""; UI_RESET=""',
                f'SRC_DIR="{src.as_posix()}"',
                body,
                "choose_geodat_option",
                'echo "option=[$GEODAT_OPTION]"',
                "",
            ]
        ).encode("utf-8")
    )
    # Без терминала: так установщик запускают из скриптов и обновления.
    proc = subprocess.run(["sh", script.as_posix()], stdin=subprocess.DEVNULL, capture_output=True, check=False)
    out = proc.stdout.decode("utf-8", "replace")
    assert proc.returncode == 0, out + proc.stderr.decode("utf-8", "replace")
    return out.rsplit("option=[", 1)[1].split("]", 1)[0]


@pytest.mark.parametrize("verdict, option", [("same", "0"), ("differs", "1"), ("missing", "1"), ("unknown", "1")])
def test_a_dat_viewer_equal_to_the_release_is_not_reinstalled_by_default(tmp_path, verdict, option):
    assert _geodat_choice(tmp_path, verdict) == option

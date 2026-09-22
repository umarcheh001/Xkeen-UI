"""Разбор JSONC: поведение и скорость.

Профиль на роутере 23.09.2026 показал, что `/api/routing/dns-over-vless`
тратит ~150 мс из своих 273 мс на удаление комментариев: функция шла по файлу
посимвольно и складывала каждый символ в список (217 876 вызовов list.append на
три запроса). Читается три десятка конфигов на запрос, и тот же разбор стоит за
каждым чтением конфигов в панели.

Здесь две группы проверок. Первая фиксирует поведение по краям — комментарии
внутри строк, экранирование, незакрытые блоки; менять его при ускорении
нельзя, конфиги пользователей не должны разъехаться. Вторая следит, чтобы
разбор оставался быстрым.
"""

from __future__ import annotations

import json
import time

import pytest

from utils.jsonc import strip_json_comments_text


def _loads(text: str):
    return json.loads(strip_json_comments_text(text))


class TestComments:
    def test_line_comment_is_removed(self) -> None:
        assert _loads('{"a": 1} // хвост') == {"a": 1}

    def test_hash_comment_is_removed(self) -> None:
        assert _loads('{"a": 1} # хвост') == {"a": 1}

    def test_block_comment_is_removed(self) -> None:
        assert _loads('{"a": /* посередине */ 1}') == {"a": 1}

    def test_multiline_block_comment_is_removed(self) -> None:
        assert _loads('{\n/* первая\nвторая */\n"a": 1}') == {"a": 1}

    def test_comment_between_every_token(self) -> None:
        text = '{ // раз\n"a" /* два */ : # три\n 1 }'
        assert _loads(text) == {"a": 1}


class TestStringsAreUntouched:
    """Внутри строки комментарий — это текст, а не комментарий."""

    def test_double_slash_inside_string_survives(self) -> None:
        assert _loads('{"url": "https://example.com"}') == {"url": "https://example.com"}

    def test_hash_inside_string_survives(self) -> None:
        assert _loads('{"tag": "a#b"}') == {"tag": "a#b"}

    def test_block_opener_inside_string_survives(self) -> None:
        assert _loads('{"tag": "a/*b*/c"}') == {"tag": "a/*b*/c"}

    def test_escaped_quote_does_not_end_the_string(self) -> None:
        assert _loads(r'{"tag": "a\"//b"}') == {"tag": 'a"//b'}

    def test_escaped_backslash_ends_the_string(self) -> None:
        assert _loads(r'{"tag": "a\\", "b": 1}') == {"tag": "a\\", "b": 1}

    def test_newline_escape_inside_string(self) -> None:
        assert _loads(r'{"tag": "a\nb"}') == {"tag": "a\nb"}


class TestEdges:
    def test_none_becomes_empty_text(self) -> None:
        assert strip_json_comments_text(None) == ""

    def test_non_string_is_coerced(self) -> None:
        assert strip_json_comments_text(123) == "123"

    def test_empty_text_stays_empty(self) -> None:
        assert strip_json_comments_text("") == ""

    def test_unterminated_block_comment_eats_the_tail(self) -> None:
        assert strip_json_comments_text('{"a": 1} /* хвост без конца').strip() == '{"a": 1}'

    def test_unterminated_string_is_kept_as_is(self) -> None:
        assert strip_json_comments_text('{"a": "не закрыта') == '{"a": "не закрыта'

    def test_line_comment_at_the_very_end_without_newline(self) -> None:
        assert strip_json_comments_text('{"a": 1} //').strip() == '{"a": 1}'

    def test_text_without_comments_is_returned_unchanged(self) -> None:
        text = '{\n  "a": [1, 2, 3],\n  "b": {"c": "d"}\n}\n'
        assert strip_json_comments_text(text) == text

    def test_line_breaks_are_preserved_for_line_numbers(self) -> None:
        """Номера строк в сообщениях об ошибках должны оставаться прежними."""

        text = '{\n// комментарий\n"a": 1\n}'
        assert strip_json_comments_text(text).count("\n") == text.count("\n")


def _char_by_char(s: str) -> str:
    """Прежний посимвольный разбор — эталон, от которого мы ушли.

    Нужен как мерка на той же машине: абсолютные мегабайты в секунду скачут
    от загрузки машины, и порог по ним даёт ложные падения в полном прогоне.
    """

    res: list[str] = []
    in_string = False
    escape = False
    i = 0
    length = len(s)
    while i < length:
        ch = s[i]
        if in_string:
            res.append(ch)
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
            i += 1
            continue
        if ch == '"':
            in_string = True
            res.append(ch)
            i += 1
            continue
        if ch == "/" and i + 1 < length and s[i + 1] == "/":
            i += 2
            while i < length and s[i] != "\n":
                i += 1
            continue
        if ch == "#":
            i += 1
            while i < length and s[i] != "\n":
                i += 1
            continue
        if ch == "/" and i + 1 < length and s[i + 1] == "*":
            i += 2
            while i + 1 < length and not (s[i] == "*" and s[i + 1] == "/"):
                i += 1
            i += 2
            continue
        res.append(ch)
        i += 1
    return "".join(res)


def _best_seconds(fn, payload: str, repeats: int = 3) -> float:
    best = None
    for _ in range(repeats):
        started = time.perf_counter()
        fn(payload)
        elapsed = time.perf_counter() - started
        best = elapsed if best is None else min(best, elapsed)
    return float(best)


def test_stripping_beats_the_char_by_char_walk() -> None:
    """Сторож от возврата к посимвольному проходу: он стоил панели ~90 мс на запрос."""

    chunk = json.dumps({"rules": [{"tag": f"proxy-{i}", "url": f"https://h{i}/p"} for i in range(200)]})
    payload = ("// заголовок\n" + chunk + " /* хвост */\n") * 40

    assert strip_json_comments_text(payload) == _char_by_char(payload)

    ratio = _best_seconds(_char_by_char, payload) / _best_seconds(strip_json_comments_text, payload)

    assert ratio >= 1.3, f"ускорение всего в {ratio:.2f} раза"

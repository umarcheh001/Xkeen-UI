"""JSONC helpers (JSON + comments).

This module provides:
- strip_json_comments_text: remove //, # and /* */ comments outside strings.
- format_jsonc_text: best-effort formatter that keeps comments and reindents.

Implementation is dependency-free and intentionally conservative.
"""

from __future__ import annotations

import re

# Символы, с которых может начаться строка или комментарий.
_SPECIAL_RE = re.compile(r'["/#]')


def strip_json_comments_text(s: str) -> str:
    """Удаляем //, # и /* */ комментарии вне строк."""
    if s is None:
        return ""
    if not isinstance(s, str):
        try:
            s = str(s)
        except Exception:
            return ""

    # Посимвольный проход стоил панели полторы сотни миллисекунд на запрос:
    # конфигов читается три десятка, и каждый символ уходил в list.append.
    # Поэтому прыгаем сразу к ближайшему значимому символу и копируем куски
    # целиком — поведение прежнее, работа идёт срезами.
    if not _SPECIAL_RE.search(s):
        return s

    res: list[str] = []
    i = 0
    length = len(s)

    while i < length:
        match = _SPECIAL_RE.search(s, i)
        if match is None:
            res.append(s[i:])
            break

        pos = match.start()
        if pos > i:
            res.append(s[i:pos])
        i = pos
        ch = s[i]

        if ch == '"':
            # Экранированная кавычка строку не закрывает, а `\` экранирует
            # сам себя — поэтому шагаем через пару символов.
            j = i + 1
            while True:
                quote = s.find('"', j)
                if quote < 0:
                    # Незакрытая строка: хвост уходит как есть, как и раньше.
                    j = length
                    break
                backslashes = 0
                probe = quote - 1
                while probe > i and s[probe] == "\\":
                    backslashes += 1
                    probe -= 1
                j = quote + 1
                # Нечётное число слэшей экранирует кавычку — строка продолжается.
                if backslashes % 2 == 0:
                    break
            res.append(s[i:j])
            i = j
            continue

        if ch == "#" or (ch == "/" and i + 1 < length and s[i + 1] == "/"):
            # Перевод строки остаётся на месте: по нему считаются номера строк.
            newline = s.find("\n", i)
            i = length if newline < 0 else newline
            continue

        if ch == "/" and i + 1 < length and s[i + 1] == "*":
            # Незакрытый блок съедает хвост — так было и раньше.
            closing = s.find("*/", i + 2)
            i = length if closing < 0 else closing + 2
            continue

        # Одиночная косая черта — обычный символ.
        res.append(ch)
        i += 1

    return "".join(res)


def format_jsonc_text(src: str, indent_size: int = 2) -> str:
    """Best-effort formatter for JSONC (JSON + comments).

    - Keeps //, # and /* */ comments.
    - Reindents based on bracket nesting.
    - Does not try to reorder/normalize values; it only normalizes whitespace.

    This is intentionally conservative and dependency-free (no jsbeautifier).
    """
    if src is None:
        src = ""
    if not isinstance(src, str):
        try:
            src = str(src)
        except Exception:
            src = ""

    s = src
    n = len(s)
    i = 0

    out: list[str] = []
    lvl = 0
    in_str = False
    esc = False
    in_line_comment = False
    in_block_comment = False
    at_line_start = True

    def _append(txt: str) -> None:
        out.append(txt)

    def _trim_trailing_ws() -> None:
        # remove trailing spaces/tabs at buffer end
        while out:
            t = out[-1]
            if not t:
                out.pop()
                continue
            if t.endswith(" ") or t.endswith("\t"):
                out[-1] = t.rstrip(" \t")
                if out[-1] == "":
                    out.pop()
                continue
            break

    def _newline() -> None:
        nonlocal at_line_start
        _trim_trailing_ws()
        _append("\n")
        at_line_start = True

    def _indent() -> None:
        nonlocal at_line_start
        if at_line_start:
            _append(" " * max(0, lvl) * indent_size)
            at_line_start = False

    def _peek_next_sig(pos: int) -> tuple[int, str]:
        """Return (index, char) of next significant non-ws char, skipping whitespace only.

        We purposely do NOT skip comments here: if there is a comment between
        open and close braces, the structure is not 'empty' for formatting.
        """
        j = pos
        while j < n and s[j] in (" ", "\t", "\r", "\n"):
            j += 1
        return j, (s[j] if j < n else "")

    def _read_line_comment(start: int) -> tuple[int, str]:
        j = start
        # consume until newline (newline char is NOT consumed)
        while j < n and s[j] != "\n":
            j += 1
        return j, s[start:j]

    def _read_bare_token(start: int) -> tuple[int, str]:
        j = start
        while j < n:
            ch2 = s[j]
            if ch2 in (" ", "\t", "\r", "\n", "{", "}", "[", "]", ":", ","):
                break
            # comments start
            if ch2 == "#":
                break
            if ch2 == "/" and j + 1 < n and s[j + 1] in ("/", "*"):
                break
            j += 1
        return j, s[start:j]

    while i < n:
        ch = s[i]

        # Inside string
        if in_str:
            _append(ch)
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            i += 1
            continue

        # Line comment (// or #)
        if in_line_comment:
            if ch == "\n":
                in_line_comment = False
                _newline()
                i += 1
                continue
            _append(ch)
            i += 1
            continue

        # Block comment (/* */)
        if in_block_comment:
            _append(ch)
            if ch == "\n":
                # Keep multi-line comments readable by re-indenting next line
                at_line_start = True
                _indent()
            if ch == "*" and i + 1 < n and s[i + 1] == "/":
                _append("/")
                i += 2
                in_block_comment = False
                continue
            i += 1
            continue

        # Skip whitespace outside strings/comments
        if ch in (" ", "\t", "\r", "\n"):
            i += 1
            continue

        # Start of string
        if ch == '"':
            _indent()
            in_str = True
            _append(ch)
            i += 1
            continue

        # Start of comments
        if ch == "#":
            _indent()
            in_line_comment = True
            j, txt = _read_line_comment(i)
            _append(txt)
            i = j
            continue
        if ch == "/" and i + 1 < n and s[i + 1] == "/":
            _indent()
            in_line_comment = True
            j, txt = _read_line_comment(i)
            _append(txt)
            i = j
            continue
        if ch == "/" and i + 1 < n and s[i + 1] == "*":
            _indent()
            in_block_comment = True
            _append("/*")
            i += 2
            continue

        # Structural tokens
        if ch in ("{", "["):
            _indent()
            j, nxt = _peek_next_sig(i + 1)
            close = "}" if ch == "{" else "]"
            if nxt == close:
                _append(ch)
                _append(close)
                i = j + 1
                at_line_start = False
                continue
            _append(ch)
            lvl += 1
            _newline()
            i += 1
            continue

        if ch in ("}", "]"):
            lvl = max(0, lvl - 1)
            if not at_line_start:
                _newline()
            _indent()
            _append(ch)
            at_line_start = False
            i += 1
            continue

        if ch == ",":
            _append(",")
            _newline()
            i += 1
            continue

        if ch == ":":
            _append(": ")
            at_line_start = False
            i += 1
            continue

        # Bare token (numbers, true/false/null, identifiers)
        _indent()
        j, tok = _read_bare_token(i)
        _append(tok)
        at_line_start = False
        i = j

    text_out = "".join(out)
    if text_out and not text_out.endswith("\n"):
        text_out += "\n"
    return text_out

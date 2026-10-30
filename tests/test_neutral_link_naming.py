"""В текстах для пользователя нет слова «Happ»: только «Утилита ссылок подписок».

Схема ссылки happ://, значения User-Agent и имена переменных остаются: пользователь их
вводит или настраивает, а переименование сломало бы уже настроенные роутеры.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
XKEEN = ROOT / "xkeen-ui"

SOURCES = [
    ROOT / "README.md",
    XKEEN / "install.sh",
    *sorted((XKEEN / "routes").rglob("*.py")),
    *sorted((XKEEN / "services").rglob("*.py")),
    *sorted((XKEEN / "static/js/features").rglob("*.js")),
    *sorted((XKEEN / "templates").rglob("*.html")),
]
COMMENT = re.compile(r"^\s*(#(?!\s*---)|//|\*|/\*)")
RUSSIAN = re.compile(r"[А-Яа-яЁё]")
WORD = re.compile(r"\bHapp\b(?!/\d)")
BARE_TITLE = re.compile(r"""["']Happ["']""")


def test_user_texts_do_not_name_the_app():
    found = []
    for path in SOURCES:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        for number, line in enumerate(lines, 1):
            if COMMENT.match(line) and "install.sh" not in path.name:
                continue
            if (RUSSIAN.search(line) and WORD.search(line)) or BARE_TITLE.search(line):
                found.append(f"{path.relative_to(ROOT)}:{number}")
    assert not found, "\n".join(found)

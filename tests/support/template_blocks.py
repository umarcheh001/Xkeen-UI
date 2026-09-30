"""Order-independent slicing of panel markup for contract tests."""

from __future__ import annotations

import re


def element_markup(html: str, element_id: str) -> str:
    """Return the ``<div id=...>`` element with its balanced children.

    Contract tests used to slice a modal up to the id of the next modal; that
    breaks whenever partials change the order of unrelated modals.
    """

    match = re.search(r'<div(?=[\s>])[^>]*\bid="' + re.escape(element_id) + r'"', html)
    if match is None:
        raise ValueError(f"element #{element_id} not found")
    start = match.start()
    depth = 0
    for tag in re.finditer(r"<div(?=[\s>])|</div>", html[start:]):
        depth += 1 if tag.group(0).startswith("<div") else -1
        if depth == 0:
            return html[start : start + tag.end()]
    raise ValueError(f"element #{element_id} is not closed")

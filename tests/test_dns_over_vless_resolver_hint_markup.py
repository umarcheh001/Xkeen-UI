"""Под полем локального DNS есть место для найденного адреса.

Порт резолвера прошивки пользователю знать неоткуда, поэтому панель его
показывает и предлагает подставить одной кнопкой.
"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HTML = (ROOT / "xkeen-ui/templates/panel.html").read_text(encoding="utf-8")


def test_hint_and_button_exist():
    assert 'id="routing-dns-over-vless-local-hint"' in HTML
    assert 'id="routing-dns-over-vless-local-hint-text"' in HTML
    assert 'id="routing-dns-over-vless-local-apply"' in HTML


def test_hint_sits_next_to_the_local_field():
    field = HTML.index('id="routing-dns-over-vless-local"')
    hint = HTML.index('id="routing-dns-over-vless-local-hint"')
    # Подсказка идёт сразу за полем, а не в другой зоне окна.
    assert 0 < hint - field < 600


def test_button_is_a_button_not_a_link():
    marker = HTML.index('id="routing-dns-over-vless-local-apply"')
    tag = HTML.rindex("<", 0, marker)
    assert HTML[tag:marker].startswith("<button")

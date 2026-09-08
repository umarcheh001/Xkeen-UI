"""Рядом с настройкой резолвера прошивки есть место для найденного адреса.

Порт прошивке раздаёт порядок создания политик доступа, знать его человеку
неоткуда и вписывать не нужно: панель находит адрес сама. Но видеть, что
именно нашлось — и узнать, если найденное разошлось с записанным, — человек
должен: до часовой самопочинки домашние имена молчат.
"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HTML = (ROOT / "xkeen-ui/templates/panel.html").read_text(encoding="utf-8")


def test_hint_exists():
    assert 'id="routing-dns-over-vless-local-hint"' in HTML
    assert 'id="routing-dns-over-vless-local-hint-text"' in HTML


def test_hint_sits_next_to_the_firmware_switch():
    switch = HTML.index('id="routing-dns-over-vless-firmware"')
    hint = HTML.index('id="routing-dns-over-vless-local-hint"')
    # Подсказка относится к настройке прошивки, а не к полю своих резолверов.
    assert 0 < hint - switch < 600


def test_nothing_offers_to_type_the_firmware_address_by_hand():
    """Кнопки «Подставить» больше нет — и не должно быть.

    Вписанный руками адрес прошивки стал бы «своим»: часовой сторож такие не
    трогает, и уехавший порт остался бы молча сломанным.
    """
    assert 'id="routing-dns-over-vless-local-apply"' not in HTML

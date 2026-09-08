"""Карточка объясняет, что нашла панель, и предупреждает о расхождении."""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
JS = (ROOT / "xkeen-ui/static/js/features/routing_cards/rules/dns_over_vless.js").read_text(
    encoding="utf-8"
)


def _function_body(name: str) -> str:
    marker = f"function {name}("
    assert marker in JS
    body = JS[JS.index(marker) :]
    idx = body.find("\n  function ", 10)
    return body if idx == -1 else body[:idx]


def test_dom_map_knows_the_new_elements():
    assert "routing-dns-over-vless-local-hint" in JS
    assert "routing-dns-over-vless-firmware" in JS


def test_hint_is_rendered_from_the_status_field():
    assert "firmware_resolvers" in JS


def test_the_hint_hides_when_the_firmware_resolver_is_switched_off():
    """Отказавшемуся рассказывать про найденные порты незачем."""
    body = _function_body("renderLocalHint")
    assert "DOM.firmware" in body
    assert "classList.add('hidden')" in body


def test_a_moved_port_is_reported_against_what_is_applied():
    """Расхождение считается по записанному в конфигурацию, а не по полю.

    Свой резолвер в поле никогда не совпадёт с портами прошивки, и сравнение
    с ним показывало бы предупреждение всем, у кого есть домашний DNS.
    """
    body = _function_body("renderLocalHint")
    assert "firmware_resolvers_applied" in body


def test_a_firmware_resolver_that_could_not_be_written_is_reported():
    """Найдено, но не записано — это не «всё в порядке».

    Так бывает, когда адрес петли занят группой «мимо туннеля»: панель
    уступает явной настройке, и молчание здесь читалось бы как работающие
    домашние имена.
    """
    body = _function_body("renderLocalHint")
    assert "data.enabled" in body or "enabled" in body
    assert "не записан" in body or "не задействован" in body

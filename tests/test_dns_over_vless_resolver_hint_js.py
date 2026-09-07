"""Карточка объясняет, что нашла панель, и предупреждает о расхождении."""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
JS = (ROOT / "xkeen-ui/static/js/features/routing_cards/rules/dns_over_vless.js").read_text(
    encoding="utf-8"
)


def test_dom_map_knows_the_new_elements():
    assert "routing-dns-over-vless-local-hint" in JS
    assert "routing-dns-over-vless-local-apply" in JS


def test_hint_is_rendered_from_the_status_field():
    assert "firmware_resolvers" in JS


def _function_body(name: str) -> str:
    marker = f"function {name}("
    assert marker in JS
    start = JS.index(marker)
    body = JS[start:]
    next_marker = "\n  function "
    idx = body.find(next_marker, 10)
    if idx == -1:
        return body
    return body[:idx]


def test_button_fills_the_field():
    body = _function_body("renderLocalHint")
    # Кнопка вписывает найденное в поле и помечает его тронутым, иначе
    # следующий ответ статуса затрёт подставленное значение.
    assert "dataset.touched" in body

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


def test_local_resolver_is_not_sent_unconditionally():
    """Пока поле пустое и его не трогали, ключ local_resolver слать нельзя —
    иначе сервер понимает "" как осознанный отказ и ветка автоподстановки
    резолвера прошивки (критерий 2 спеки) никогда не срабатывает.

    Проверяем это не по наличию слова "touched" в файле вообще (оно уже
    встречается по другим поводам), а по тому, что присваивание
    ``settings.local_resolver`` внутри dnsSettings() обусловлено именно
    признаком "тронуто" — рядом с местом присваивания, а не где-то ещё.
    """
    body = _function_body("dnsSettings")
    marker = "settings.local_resolver ="
    assert marker in body
    idx = body.index(marker)
    context = body[max(0, idx - 200) : idx]
    assert "touched" in context, (
        "local_resolver должен уходить на сервер только когда поле тронуто "
        "или в нём что-то вписано; безусловная отправка воскрешает баг с "
        "пустым полем, которое сервер принимает за явную очистку"
    )

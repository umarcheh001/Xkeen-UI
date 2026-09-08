"""Окно спрашивает про резолвер прошивки галочкой, а не пустым полем.

Прежде решение принималось стиранием адреса, происхождения которого человек
не понимал: по окну нельзя было проверить, работают домашние имена или нет.
Теперь это отдельная настройка, а поле рядом — только под свои резолверы.
"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HTML = (ROOT / "xkeen-ui/templates/panel.html").read_text(encoding="utf-8")
JS = (ROOT / "xkeen-ui/static/js/features/routing_cards/rules/dns_over_vless.js").read_text(
    encoding="utf-8"
)


def _function_body(name: str) -> str:
    marker = f"function {name}("
    assert marker in JS, name
    body = JS[JS.index(marker) :]
    idx = body.find("\n  function ", 10)
    return body if idx == -1 else body[:idx]


def test_the_zone_has_a_checkbox_for_the_firmware_resolver():
    assert 'id="routing-dns-over-vless-firmware"' in HTML
    marker = HTML.index('id="routing-dns-over-vless-firmware"')
    tag = HTML.rindex("<", 0, marker)
    assert 'type="checkbox"' in HTML[tag : marker + 200]


def test_the_checkbox_sits_in_the_home_zone_above_the_field():
    zone = HTML.index('data-zone="home"')
    checkbox = HTML.index('id="routing-dns-over-vless-firmware"')
    field = HTML.index('id="routing-dns-over-vless-local"')
    assert zone < checkbox < field


def test_the_decision_is_always_sent():
    """Галочка — состояние, а не событие: сервер должен знать её всегда."""
    body = _function_body("dnsSettings")
    assert "settings.use_firmware_resolver =" in body


def test_the_field_now_speaks_for_itself():
    """Поле хранит только свои резолверы, поэтому уходит как есть.

    Прежняя оговорка «шлём, только если тронуто» существовала ровно затем,
    чтобы отличить незаполненное поле от отказа. Отказ переехал в галочку, и
    пустое поле снова значит просто «своих резолверов нет».
    """
    body = _function_body("dnsSettings")
    marker = "settings.local_resolver ="
    assert marker in body
    context = body[max(0, body.index(marker) - 200) : body.index(marker)]
    assert "touched" not in context


def test_zones_are_offered_when_the_firmware_answers_them():
    """Список зон нужен и без своих резолверов: их обслуживает прошивка."""
    body = _function_body("renderDnsFields")
    assert "use_firmware_resolver" in body or "firmwareOn" in body


def test_the_summary_counts_the_firmware_resolver():
    body = _function_body("zoneSummary")
    assert "use_firmware_resolver" in body


def test_the_checkbox_is_locked_with_the_rest_of_the_fields():
    """Менять настройку на ходу нельзя — как и все поля этого окна."""
    body = _function_body("setFieldsLocked")
    assert "DOM.firmware" in body


def test_resetting_the_window_restores_the_default_not_a_refusal():
    """«Сбросить настройки» — это возврат к умолчанию панели.

    Остальные переключатели окна по умолчанию сняты, этот — нет: сброс,
    гасящий его заодно со всеми, тихо ломал бы домашние имена.
    """
    body = _function_body("resetFields")
    assert "DOM.firmware" in body
    idx = body.index("DOM.firmware")
    assert "checked = false" not in body[idx : idx + 200]


def test_the_touched_mark_is_cleared_with_the_other_fields():
    """Иначе тронутая галочка навсегда перестаёт обновляться с сервера."""
    marker = "delete field.dataset.touched"
    assert marker in JS
    block = JS[max(0, JS.index(marker) - 500) : JS.index(marker)]
    assert "DOM.firmware" in block

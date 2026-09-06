"""Область «DNS для доменов мимо туннеля» должна выключаться очисткой полей.

Жалоба 06.09.2026: стереть в этой области адреса DNS, или список доменов, или
всё сразу и включить функцию — панель отвечает «Для доменов мимо туннеля укажите
и адреса DNS, и список доменов».

Причин было две, и обе на фронте:

* список доменов уходил на сервер только при непустом поле резолверов, поэтому
  после очистки адресов бэкенд подставлял прежние домены из сохранённого
  состояния, видел половину настройки и падал в `direct_incomplete`;
* строка со списком доменов пряталась, пока поле резолверов пустое, — стереть
  домены руками было уже нельзя.

Вместе это делало выключение области невозможным через интерфейс.
"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
JS = (ROOT / "xkeen-ui/static/js/features/routing_cards/rules/dns_over_vless.js").read_text(
    encoding="utf-8"
)
HTML = (ROOT / "xkeen-ui/templates/panel.html").read_text(encoding="utf-8")


def _block(start: str, until: str) -> str:
    head = JS.index(start)
    return JS[head : JS.index(until, head)]


# --- A: симметричная отправка полей -------------------------------------------------


def test_domain_list_is_sent_even_when_the_resolver_field_was_cleared():
    body = _block("function dnsSettings() {", "async function postAction(")

    assert "if (directZones && settings.direct_resolver)" not in body
    assert "settings.direct_domains = String(directZones.value || '').trim();" in body


def test_clearing_both_direct_fields_turns_the_area_off_instead_of_reviving_stored_domains():
    body = _block("function dnsSettings() {", "async function postAction(")

    # Оба поля уходят на сервер безусловно: пустая пара — это «область не
    # используется», а не «поле не трогали, возьми прежнее значение».
    direct_line = "if (direct) settings.direct_resolver = String(direct.value || '').trim();"
    domains_line = "if (directZones) settings.direct_domains"
    assert direct_line in body
    assert domains_line in body


# --- B: выключение области явным действием ------------------------------------------


def test_direct_zone_offers_a_control_that_switches_the_whole_area_off():
    assert 'id="routing-dns-over-vless-direct-clear"' in HTML
    assert "Не использовать эту область" in HTML


def test_clear_control_is_wired_and_wipes_both_direct_fields():
    assert "directClear: 'routing-dns-over-vless-direct-clear'" in JS
    assert "function clearDirectZone()" in JS

    body = _block("function clearDirectZone()", "\n  function ")
    assert "direct.value = ''" in body
    assert "directZones.value = ''" in body
    # Без метки «поле трогали» следующий рендер вернёт в поля прежние значения.
    assert "dataset.touched = '1'" in body


def test_domain_list_stays_visible_while_it_still_holds_domains():
    body = _block("function renderDnsFields(", "function renderPassHealth(")

    assert "const directHasDomains" in body
    assert "!hasDirect && !directHasDomains" in body

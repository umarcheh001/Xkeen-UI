"""Настройки окна DNS-over-VLESS видны и при включённой функции.

Менять маршрут на ходу и правда нельзя, а вот читать настройки и готовить их
к следующему включению — можно. Раньше поля прятались вместе с выбором
маршрута, и посмотреть, что настроено, выходило только выключив защиту.
"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
JS = (ROOT / "xkeen-ui/static/js/features/routing_cards/rules/dns_over_vless.js").read_text(encoding="utf-8")


def _body(name: str, until: str) -> str:
    return JS[JS.index(name):JS.index(until)]


def test_route_visibility_no_longer_hides_the_whole_form():
    body = _body("function renderRoute(data) {", "function parseZones(")
    # Прячется только зона маршрута; поля живут в соседних зонах и остаются.
    assert "fieldsLocked" in body or "setFieldsLocked" in body


def test_locked_fields_are_disabled_not_hidden():
    assert "function setFieldsLocked(" in JS
    block = _body("function setFieldsLocked(", "\n  function renderDnsFields(")
    assert ".disabled =" in block
    assert "classList.add('hidden')" not in block


def test_locked_state_survives_the_field_render():
    # renderDnsFields вызывается сразу после renderRoute и заново расставляет
    # disabled по всем полям. Не загляни он во флаг — блокировка гасла бы на
    # следующей строке после того, как её поставили.
    block = _body("function renderDnsFields(", "function renderPassHealth(")
    assert "fieldsLocked" in block
    assert "disabled = busy;" not in block


def test_locked_note_lives_in_the_template():
    template = (ROOT / "xkeen-ui/templates/panel.html").read_text(encoding="utf-8")
    assert 'id="routing-dns-over-vless-locked-note"' in template


def test_hidden_route_takes_its_zone_header_along():
    # Прятать одно тело мало: над ним остаётся шапка «Маршрут для
    # DNS-запросов» — пустая рамка на весь ряд сетки.
    body = _body("function renderRoute(data) {", "function parseZones(")
    assert "closest('.xk-dns-zone')" in body


def test_hidden_route_leaves_no_gap_behind_it():
    # Раньше каждая зона занимала свою ячейку грида, и спрятанная оставляла в
    # левой колонке пустое место -- под этот случай держали отдельную
    # раскладку. Теперь колонка это рельса-флексбокс, и спрятанная зона просто
    # выпадает из потока: чинить нечего.
    body = _body("function renderRoute(data) {", "function parseZones(")
    assert "dataset.dnsRoute" in body
    css = (ROOT / "xkeen-ui/static/panel-operator.css").read_text(encoding="utf-8")
    assert '[data-dns-route="off"]' not in css
    block = css[css.index("body.panel-page .xk-dns-rail {"):]
    block = block[:block.index("}")]
    assert "flex-direction: column" in block

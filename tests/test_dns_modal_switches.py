from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CSS = (ROOT / "xkeen-ui/static/panel-operator.css").read_text(encoding="utf-8")
TEMPLATE = (ROOT / "xkeen-ui/templates/panel.html").read_text(encoding="utf-8")


def modal(modal_id: str) -> str:
    """Разметка одного модального окна — от его корня до следующего.

    Резать фиксированным числом символов нельзя: окно Mihomo длиннее 30 КБ,
    и переключатели из его хвоста молча выпали бы из проверки.
    """
    start = TEMPLATE.index('<div id="%s"' % modal_id)
    tail = re.search(r'\n<div id="[a-z0-9-]+-modal"', TEMPLATE[start + 10:])
    return TEMPLATE[start:start + 10 + tail.start()] if tail else TEMPLATE[start:]


def test_bare_switch_drops_the_toolbar_chip():
    start = CSS.index("body.panel-page .dt-switch.xk-switch-bare {")
    block = CSS[start:CSS.index("}", start)]
    # Чип задан в базовом .dt-switch (styles.css) и снимается целиком,
    # иначе от таблетки остаётся половина: фон без рамки или наоборот.
    for fragment in ("padding: 0", "border: 0", "background: none", "border-radius: 0"):
        assert fragment in block, fragment


def test_bare_switch_does_not_touch_the_shared_primitive():
    # Снять чип у всех .dt-switch нельзя: класс живёт в панелях инструментов
    # и в routing-side-card, где таблетка уместна.
    assert "body.panel-page .dt-switch {" not in CSS
    assert "body.panel-page .xk-mini-switch {" not in CSS


def test_mihomo_dns_switches_are_bare_too():
    body = modal("mihomo-dns-modal")
    found = list(re.finditer(r'<label class="dt-switch[^"]*"', body))
    assert found, "в окне не осталось ни одного переключателя — проверка ослепла"
    for switch in found:
        assert "xk-switch-bare" in switch.group(0), switch.group(0)


def test_side_card_switches_keep_the_chip():
    # routing-side-card остаётся с таблеткой: там она уместна.
    assert ".routing-side-card .xk-mini-switch" in CSS

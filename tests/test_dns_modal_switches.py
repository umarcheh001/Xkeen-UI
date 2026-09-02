from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CSS = (ROOT / "xkeen-ui/static/panel-operator.css").read_text(encoding="utf-8")


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

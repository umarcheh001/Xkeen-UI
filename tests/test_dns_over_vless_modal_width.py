from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CSS = (ROOT / "xkeen-ui/static/panel-operator.css").read_text(encoding="utf-8")
TEMPLATE = (ROOT / "xkeen-ui/templates/panel.html").read_text(encoding="utf-8")

VLESS = TEMPLATE[
    TEMPLATE.index('<div id="routing-dns-over-vless-modal"') : TEMPLATE.index('<div id="mihomo-dns-modal"')
]
MIHOMO = TEMPLATE[TEMPLATE.index('<div id="mihomo-dns-modal"') :][:4000]


def split_rule() -> str:
    # Первое вхождение -- основное правило; второе живёт в медиазапросе для
    # узких экранов, где двух колонок нет вовсе.
    start = CSS.index('body.panel-page [data-dns-layout="split"] .routing-dns-over-vless-body {')
    return CSS[start : CSS.index("}", start)]


def test_frame_grows_with_the_screen_instead_of_standing_at_1160():
    # Окно упиралось в 1160 px и на широком экране занимало меньше половины
    # его ширины: строки дробились там, где места было вдоволь.
    assert "--xk-modal-width: clamp(1160px, 92vw, 1440px)" in CSS
    assert "xk-modal-width-fluid-1440" in VLESS
    assert "xk-modal-width-1160" not in VLESS


def test_mihomo_frame_stops_earlier():
    # У Mihomo контролов меньше: на 1440 вторая колонка пустеет.
    assert "--xk-modal-width: clamp(1160px, 92vw, 1280px)" in CSS
    assert "xk-modal-width-fluid-1280" in MIHOMO
    assert "xk-modal-width-1160" not in MIHOMO


def test_no_screen_gets_a_narrower_window_than_before():
    # Нижняя граница обеих формул равна прежней ширине, поэтому там, где
    # 92vw меньше её, окно остаётся ровно таким же, как было.
    for line in CSS.splitlines():
        if "clamp(1160px, 92vw," in line:
            assert "clamp(1160px," in line, line


def test_split_columns_are_equal():
    # Пропорция 1.25:1 читалась как «одна колонка шире другой»: рамки зон
    # слева подчёркивали разницу.
    rule = split_rule()
    assert "grid-template-columns: minmax(0, 1fr) minmax(0, 1fr)" in rule
    assert "1.25fr" not in rule


def test_split_columns_are_separated_by_a_visible_gutter():
    # На прежних 10 px рельсы выглядели слипшимися, когда стали шире.
    assert "gap: 10px 18px" in split_rule()

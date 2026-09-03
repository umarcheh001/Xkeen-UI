from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CSS = (ROOT / "xkeen-ui/static/panel-operator.css").read_text(encoding="utf-8")
TEMPLATE = (ROOT / "xkeen-ui/templates/panel.html").read_text(encoding="utf-8")
MODAL = TEMPLATE[TEMPLATE.index('<div id="routing-dns-over-vless-modal"'):TEMPLATE.index('<div id="mihomo-dns-modal"')]


def test_modal_starts_in_a_known_layout():
    assert 'data-dns-layout="single"' in MODAL
    # Ширина берётся из существующего размера системы, а не заводится своя.
    assert "xk-modal-width-1160" in MODAL


def test_both_layouts_are_declared():
    assert '[data-dns-layout="single"] .routing-dns-over-vless-body {' in CSS
    assert '[data-dns-layout="split"] .routing-dns-over-vless-body {' in CSS


def test_narrow_screens_collapse_to_one_column():
    start = CSS.index("@media (max-width: 1100px)")
    block = CSS[start:start + 600]
    assert 'data-dns-layout="split"' in block
    assert "grid-template-areas" in block

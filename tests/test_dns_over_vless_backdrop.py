"""Окно DNS-over-VLESS не закрывается от промаха мимо него.

Внутри — форма с несохранёнными настройками: случайный клик по подложке стоил
бы всей настройки. Закрывают окно крестик, «Отмена» и Escape.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
JS = (ROOT / "xkeen-ui/static/js/features/routing_cards/rules/dns_over_vless.js").read_text(encoding="utf-8")
TEMPLATE = (ROOT / "xkeen-ui/templates/panel.html").read_text(encoding="utf-8")

MODAL = re.search(r'<div id="routing-dns-over-vless-modal"[^>]*>', TEMPLATE)


def test_markup_turns_off_the_shared_backdrop_close():
    assert MODAL is not None, "разметка окна не найдена"
    assert 'data-modal-backdrop-close="0"' in MODAL.group(0)


def test_window_has_no_own_backdrop_handler():
    # Свой обработчик закрывал окно в обход общего механизма, поэтому одного
    # атрибута в разметке мало.
    assert "event.target === modal" not in JS
    assert "e.target === modal" not in JS


def test_close_controls_are_still_wired():
    assert "DOM.close, DOM.cancel" in JS
    assert 'id="routing-dns-over-vless-close"' in TEMPLATE

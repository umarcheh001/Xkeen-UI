"""Состояние кнопки ядра в шапке объявляется без `disabled`.

Выключенный элемент браузер лишает фокуса, поэтому загрузка помечается
`aria-disabled`, а действие отбивает обработчик клика.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = (ROOT / "xkeen-ui/templates/panel.html").read_text(encoding="utf-8")
SHELL = (ROOT / "xkeen-ui/static/js/pages/panel_shell.shared.js").read_text(encoding="utf-8")
STATUS = (ROOT / "xkeen-ui/static/js/features/service_status.js").read_text(encoding="utf-8")


def core_button() -> str:
    start = TEMPLATE.index('id="xkeen-core-text"')
    return TEMPLATE[TEMPLATE.rindex("<button", 0, start):TEMPLATE.index("</button>", start)]


def test_markup_declares_loading_state_consistently():
    button = core_button()
    # Разметка приезжает со скелетоном, значит и недоступность объявляется
    # сразу: иначе первый кадр обещает действие, которого ещё нет.
    assert 'data-loading="true"' in button
    assert 'aria-disabled="true"' in button
    assert "disabled" not in re.sub(r'aria-disabled="true"', "", button)


def test_loading_indicator_does_not_use_disabled():
    block = SHELL[SHELL.index("function setHeaderAsyncChipLoading("):]
    block = block[:block.index("\n  function ")]
    assert "aria-disabled" in block
    assert ".disabled = true" not in block


def test_click_handler_refuses_while_loading():
    block = STATUS[STATUS.index("function bindCoreModalUI("):]
    block = block[:block.index("openXkeenCoreModal();") + len("openXkeenCoreModal();")]
    # Мышь гасит pointer-events, клавиатура доходит до обработчика.
    assert "aria-disabled" in block

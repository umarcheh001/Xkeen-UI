"""Состояние кнопки ядра в шапке объявляется без `disabled`.

Выключенный элемент браузер лишает фокуса, поэтому загрузка помечается
`aria-disabled`, а действие отбивает обработчик клика.
"""

from __future__ import annotations

import re
from pathlib import Path

from scripts.panel_template_source import compose_panel_template

ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = compose_panel_template(ROOT)
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


def test_one_engine_keeps_the_core_management_entry_point_visible():
    button = core_button()
    # Даже с одним установленным движком в этом модале доступны источники
    # сборок и установка форков. Скрывать точку входа можно лишь без Xray и
    # Mihomo вообще, а не при отсутствии второго ядра для переключения.
    assert "{% if not (has_xray or has_mihomo) %}" in button


def test_single_core_modal_points_to_fork_installation_controls():
    branch_start = STATUS.index("if (cores.length < 2) {")
    branch_end = STATUS.index("        setCoreModalStatus('', 'hint');", branch_start)
    branch = STATUS[branch_start:branch_end]

    assert "Ниже можно выбрать форк или обновить текущую сборку." in branch

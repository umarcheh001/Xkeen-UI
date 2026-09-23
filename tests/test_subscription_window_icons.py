"""Кнопки окон подписок носят иконку с подписью, и глифы не повторяются.

Разметка кнопок живёт в двух местах: окно Xray собирается шаблонной строкой в
``outbounds.js``, окно Mihomo — обычным Jinja-шаблоном. Сторож держит оба, иначе
одно окно уезжает вперёд другого.

Отдельно проверяется, что три кнопки Mihomo носят разные глифы: раньше все они
были ``refresh``, и иконка не различала действия.
"""

from __future__ import annotations

import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OUTBOUNDS_JS = ROOT / "xkeen-ui" / "static" / "js" / "features" / "outbounds.js"
MIHOMO_HTML = ROOT / "xkeen-ui" / "templates" / "mihomo_generator.html"
ICON_MANIFEST = ROOT / "xkeen-ui" / "static" / "js" / "ui" / "operator_icons_manifest.js"

# Кнопка -> глиф. Подпись остаётся: это действия списка, а не тесная форма.
XRAY_BUTTONS = {
    "outbounds-subscriptions-refresh-due-btn": "refresh",
    "outbounds-subscriptions-align-btn": "normalize",
    "outbounds-subscriptions-nodes-show-hidden": "preview",
}

MIHOMO_BUTTONS = {
    "reloadMihomoManagedSubsBtn": "list-details",
    "refreshMihomoManagedDueBtn": "refresh",
    "alignMihomoManagedScheduleBtn": "normalize",
}


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _known_icons() -> set[str]:
    return set(re.findall(r'"([a-z0-9-]+)"', _read(ICON_MANIFEST)))


def _button_html(src: str, button_id: str) -> str:
    """Кусок разметки от начала тега кнопки до её закрытия."""
    start = src.index(f'id="{button_id}"')
    open_at = src.rindex("<button", 0, start)
    close_at = src.index("</button>", open_at)
    return src[open_at:close_at]


def test_every_named_glyph_exists_in_the_sprite():
    known = _known_icons()
    for name in list(XRAY_BUTTONS.values()) + list(MIHOMO_BUTTONS.values()):
        assert name in known, f"глифа {name} нет в спрайте"


def test_xray_list_buttons_carry_icon_and_label():
    src = _read(OUTBOUNDS_JS)
    for button_id, icon in XRAY_BUTTONS.items():
        html = _button_html(src, button_id)
        assert f"iconHtml('{icon}')" in html, f"{button_id}: ждали глиф {icon}"
        assert "xk-action-label" in html, f"{button_id}: подпись должна остаться видимой"


def test_mihomo_buttons_carry_icon_and_label():
    html = _read(MIHOMO_HTML)
    for button_id, icon in MIHOMO_BUTTONS.items():
        markup = _button_html(html, button_id)
        assert f"op_icon('{icon}')" in markup, f"{button_id}: ждали глиф {icon}"
        assert "xk-action-label" in markup, f"{button_id}: подпись должна остаться видимой"


def test_mihomo_buttons_do_not_share_one_glyph():
    html = _read(MIHOMO_HTML)
    used = [
        re.search(r"op_icon\('([a-z0-9-]+)'\)", _button_html(html, button_id)).group(1)
        for button_id in MIHOMO_BUTTONS
    ]
    assert len(set(used)) == len(used), f"глифы повторяются: {used}"


# Кнопки формы живут не в разметке: subsDecorateActionButtons() переписывает их
# после вставки в icon-only чипы. Глиф каждой берём оттуда.
FORM_BUTTONS = {
    "resetBtn": "broom",
    "saveBtn": "save",
    "previewBtn": "download",
}


def _form_glyph(src: str, variable: str) -> str:
    at = src.index(f"{variable}.innerHTML = iconHtml(")
    return re.search(r"iconHtml\('([a-z0-9-]+)'", src[at:]).group(1)


def test_xray_form_buttons_keep_their_own_glyphs():
    src = _read(OUTBOUNDS_JS)
    for variable, icon in FORM_BUTTONS.items():
        assert _form_glyph(src, variable) == icon, f"{variable}: ждали глиф {icon}"


def test_no_two_buttons_of_the_xray_window_share_a_glyph():
    """Кнопка без подписи опознаётся только по глифу.

    Ловит буквальный повтор одного имени — такой, какой был в окне Mihomo
    с тремя ``refresh``. Близкие по виду, но разные глифы (``restore`` рядом с
    ``refresh`` — два кольца со стрелкой) сюда не попадают: от них держит закреплённая
    раскладка выше.
    """
    src = _read(OUTBOUNDS_JS)
    used = [_form_glyph(src, variable) for variable in FORM_BUTTONS]
    used += [
        re.search(r"iconHtml\('([a-z0-9-]+)'\)", _button_html(src, button_id)).group(1)
        for button_id in XRAY_BUTTONS
    ]
    duplicates = {name for name in used if used.count(name) > 1}
    assert not duplicates, f"глифы повторяются в одном окне: {sorted(duplicates)}"

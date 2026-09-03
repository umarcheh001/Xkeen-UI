from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
JS = (ROOT / "xkeen-ui/static/js/features/routing_cards/rules/dns_over_vless.js").read_text(encoding="utf-8")
TEMPLATE = (ROOT / "xkeen-ui/templates/panel.html").read_text(encoding="utf-8")


def test_header_has_a_layout_button():
    assert 'id="routing-dns-over-vless-layout"' in TEMPLATE


def test_layout_modes_are_the_three_agreed_ones():
    assert "LAYOUT_MODES" in JS
    for mode in ("'auto'", "'single'", "'split'"):
        assert mode in JS, mode


def test_preference_travels_through_ui_settings():
    # Вкус у человека один на все машины, поэтому выбор уходит на сервер.
    assert "XKeen.ui.settings" in JS
    assert "dnsOverVlessLayout" in JS


def test_choice_survives_a_server_that_did_not_save_it():
    # ...но на роутере запись настроек может не дойти до диска. Тогда окно всё
    # равно открывается таким, каким его оставили: браузер помнит выбор сам, а
    # о несохранении панель говорит вслух, а не молчит.
    assert "LAYOUT_STORAGE_KEY" in JS
    assert "localStorage.setItem(LAYOUT_STORAGE_KEY" in JS
    assert "не сохранилась на роутере" in JS


def test_next_layout_is_computed_from_the_screen_not_from_the_saved_value():
    # Кнопка переключала раскладку ровно один раз: следующий режим считался от
    # значения с сервера, и там, где оно не сохранялось, она замирала.
    assert "cycleLayout" not in JS
    body = JS[JS.index("function toggleLayout()"):]
    body = body[:body.index(chr(10) + "  }")]
    assert "currentLayout()" in body


def test_auto_resolves_by_width():
    assert "1100" in JS

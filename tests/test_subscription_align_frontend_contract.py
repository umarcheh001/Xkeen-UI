"""Кнопка выравнивания и переименование «Обновить due» в обоих окнах.

Подсказка кнопки живёт сразу в двух атрибутах: ``title`` переносится в
``data-tooltip`` один раз при миграции, поэтому правка только одного из них
тихо теряется. Сторож держит оба.
"""

from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OUTBOUNDS_JS = ROOT / "xkeen-ui" / "static" / "js" / "features" / "outbounds.js"
MIHOMO_HTML = ROOT / "xkeen-ui" / "templates" / "mihomo_generator.html"
MIHOMO_JS = ROOT / "xkeen-ui" / "static" / "js" / "features" / "mihomo_generator.js"


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_xray_window_offers_the_alignment_button():
    src = _read(OUTBOUNDS_JS)

    assert 'id="outbounds-subscriptions-align-btn"' in src
    assert ">Выровнять расписание<" in src
    assert 'title="Выровнять расписание"' in src
    assert 'data-tooltip="Свести время следующего обновления всех подписок к одному моменту' in src
    assert "/api/xray/subscriptions/align-schedule" in src
    assert "?dry=1" in src


def test_mihomo_window_offers_the_alignment_button():
    html = _read(MIHOMO_HTML)
    js = _read(MIHOMO_JS)

    assert 'id="alignMihomoManagedScheduleBtn"' in html
    assert "Выровнять расписание" in html
    assert 'data-tooltip="Свести время следующего обновления всех подписок к одному моменту' in html
    assert "/api/mihomo/subscriptions/align-schedule" in js
    assert "?dry=1" in js
    # Гасим кнопку, когда сводить нечего, — так же, как в окне Xray.
    assert "alignManagedScheduleBtn.disabled" in js


def test_due_button_no_longer_speaks_english():
    """«due» — слово из кода, а не из языка пользователя панели."""
    outbounds = _read(OUTBOUNDS_JS)
    html = _read(MIHOMO_HTML)

    assert "Обновить due" not in outbounds
    assert "Обновить due" not in html
    assert ">Обновить просроченные<" in outbounds
    assert "Обновить просроченные" in html
    assert 'title="Обновить просроченные"' in outbounds


def test_alignment_dialog_states_what_will_and_will_not_happen():
    """Диалог обязан сказать, что скачивания и перезапуска не будет."""
    src = _read(OUTBOUNDS_JS)

    assert "Подписки не скачиваются, ядро не перезапускается." in src
    assert "Самый большой сдвиг" in src
    assert "просрочены" in src


def test_overdue_line_agrees_with_the_number_it_reports():
    """«1 подписку просрочены» — счётчик обязан согласоваться со словами."""
    for path in (OUTBOUNDS_JS, MIHOMO_JS):
        src = _read(path)
        assert "подписка просрочена" in src, path
        assert "подписки просрочены" in src, path
        assert "подписок просрочены" in src, path

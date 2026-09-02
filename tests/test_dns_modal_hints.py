# tests/test_dns_modal_hints.py
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = (ROOT / "xkeen-ui/templates/panel.html").read_text(encoding="utf-8")

START = '<div id="routing-dns-over-vless-modal"'
END = '<div id="mihomo-dns-modal"'
MODAL = TEMPLATE[TEMPLATE.index(START):TEMPLATE.index(END)]

# Фразы, ради которых подсказки и писались. Если хоть одна пропала при
# переносе под «Подробнее» — объяснение потеряно, а не свёрнуто.
KEPT = (
    "имя хоста пришлось бы разрешать",
    "127.0.0.1:41100",
    "geoip:private",
    "Встроенный DNS Xray отвечает только на A и AAAA",
    "балансировщик указать нельзя",
    "перестают действовать DNS-фильтры прошивки",
    "заворачивает на собственный резолвер",
    "Эти запросы увидит провайдер",
)


def test_no_explanation_is_lost():
    for phrase in KEPT:
        assert phrase in MODAL, phrase


def test_long_explanations_live_under_a_disclosure():
    assert MODAL.count('<details class="xk-hint-more">') >= 6
    assert MODAL.count("<summary>Подробнее</summary>") == MODAL.count('<details class="xk-hint-more">')


def test_visible_part_of_a_hint_stays_short():
    # Видимая часть — одна строка «что сюда вписывать». Всё длинное уезжает
    # под раскрывашку, иначе окно снова превращается в четыре страницы текста.
    for hint in re.findall(r'<p class="modal-hint[^"]*"[^>]*>(.*?)(?=<details|</p>)', MODAL, re.S):
        visible = re.sub(r"<[^>]+>", "", hint).strip()
        assert len(visible) <= 200, visible[:80]

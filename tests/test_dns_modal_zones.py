# tests/test_dns_modal_zones.py
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = (ROOT / "xkeen-ui/templates/panel.html").read_text(encoding="utf-8")
MODAL = TEMPLATE[TEMPLATE.index('<div id="routing-dns-over-vless-modal"'):TEMPLATE.index('<div id="mihomo-dns-modal"')]

ZONES = ("route", "servers", "home", "direct", "records", "devices")

# Полный список id окна. Модуль dns_over_vless.js адресует их через плоскую
# карту DOM, поэтому перекладывать узлы можно, а терять id — нет.
IDS = (
    "badge", "lead-title", "lead-text", "status", "details", "route", "target",
    "target-tools", "target-count", "target-all", "target-none", "route-fallback",
    "multi", "multi-row", "upstreams", "remote", "local", "zones", "zones-row",
    "zone-presets", "direct", "direct-zones", "direct-zones-row",
    "direct-from-rules", "pass", "pass-row", "pass-node", "pass-health",
    "clients", "clients-summary", "clients-list", "capture", "reset",
)


def test_every_id_survives_the_rework():
    for name in IDS:
        assert f'id="routing-dns-over-vless-{name}"' in MODAL, name


def test_six_zones_exist():
    for zone in ZONES:
        assert f'<details class="xk-dns-zone" data-zone="{zone}"' in MODAL, zone


def test_no_zone_is_open_in_the_markup():
    # Окно открывается компактным: все зоны свёрнуты, а что в них -- видно по
    # сводке в шапке. Раскрывает человек только ту зону, которая ему нужна.
    for zone in ZONES:
        block = MODAL[MODAL.index(f'data-zone="{zone}"'):]
        assert block[:80].find(" open") == -1, zone


def test_required_zones_are_the_marked_ones():
    # Прежняя метка «необязательно» стояла на четырёх зонах из шести и была
    # бледнее прочего текста. Помечаем наоборот -- обязательные. Разбор по
    # устройствам такой же обязательный: без ответа на вопрос «а до кого
    # функция вообще доходит» включение остаётся наполовину слепым.
    assert "xk-dns-zone-opt" not in MODAL
    for zone in ("route", "servers", "devices"):
        start = MODAL.index(f'data-zone="{zone}"')
        head = MODAL[start:MODAL.index("</summary>", start)]
        assert 'data-required="1"' in MODAL[start - 60:start + 60], zone
        assert f'data-zone-req="{zone}"' in head, zone
        assert ">обязательно</span>" in head, zone
    for zone in ("home", "direct", "records"):
        start = MODAL.index(f'data-zone="{zone}"')
        head = MODAL[start:MODAL.index("</summary>", start)]
        assert "xk-dns-zone-req" not in head, zone


def test_every_zone_carries_a_summary_slot():
    for zone in ZONES:
        start = MODAL.index(f'data-zone="{zone}"')
        head = MODAL[start:MODAL.index("</summary>", start)]
        assert f'data-zone-sum="{zone}"' in head, zone


def test_zones_live_in_two_rails():
    # В две колонки рельсы -- это столбцы, в одну они просто идут друг за
    # другом. Раскладку решает CSS, поэтому разметка одна на оба случая.
    form = MODAL.index('class="xk-dns-rail xk-dns-rail-form"')
    side = MODAL.index('class="xk-dns-rail xk-dns-rail-side"')
    assert form < side
    for zone in ("route", "servers", "home", "direct", "records"):
        assert form < MODAL.index(f'data-zone="{zone}"') < side, zone
    assert MODAL.index('data-zone="devices"') > side
    assert MODAL.index('class="routing-dns-over-vless-foot"') > side


def test_section_switches_sit_in_the_subheader():
    for zone, switch in (("records", "pass"), ("devices", "capture")):
        start = MODAL.index(f'data-zone="{zone}"')
        head = MODAL[start:MODAL.index("</summary>", start)]
        assert f'id="routing-dns-over-vless-{switch}"' in head, zone
        assert "xk-switch-bare" in head, zone


def test_flag_switch_is_bare_too():
    start = MODAL.index('id="routing-dns-over-vless-remote"')
    label = MODAL[MODAL.rindex("<label", 0, start):start]
    assert "xk-switch-bare" in label

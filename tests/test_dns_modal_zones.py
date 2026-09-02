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


def test_required_zones_are_open_and_optional_are_not():
    for zone in ("route", "servers"):
        block = MODAL[MODAL.index(f'data-zone="{zone}"'):]
        assert block[:80].find(" open") != -1, zone
    for zone in ("home", "direct", "records", "devices"):
        block = MODAL[MODAL.index(f'data-zone="{zone}"'):]
        assert block[:80].find(" open") == -1, zone


def test_optional_zones_are_labelled_and_carry_a_summary_slot():
    for zone in ("home", "direct", "records", "devices"):
        start = MODAL.index(f'data-zone="{zone}"')
        head = MODAL[start:MODAL.index("</summary>", start)]
        assert '<span class="xk-dns-zone-opt">необязательно</span>' in head, zone
        assert f'data-zone-sum="{zone}"' in head, zone


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

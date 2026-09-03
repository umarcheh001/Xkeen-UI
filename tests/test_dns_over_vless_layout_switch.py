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
    # Вкус у человека один на все машины, поэтому не localStorage.
    assert "XKeen.ui.settings" in JS
    assert "dnsOverVlessLayout" in JS
    assert "localStorage" not in JS


def test_auto_resolves_by_width():
    assert "1100" in JS

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
JS = (ROOT / "xkeen-ui/static/js/features/routing_cards/rules/dns_over_vless.js").read_text(encoding="utf-8")


def test_summaries_are_rendered_for_every_optional_zone():
    assert "function renderZoneSummaries(" in JS
    for zone in ("home", "direct", "records", "devices"):
        assert f'"{zone}"' in JS or f"'{zone}'" in JS, zone


def test_summaries_are_refreshed_from_render():
    body = JS[JS.index("function render(data) {"):]
    assert "renderZoneSummaries(" in body[:body.index("\n  function ")]


def test_switch_click_does_not_fold_the_zone():
    # Переключатель живёт в <summary>; без гашения всплытия нажатие на слайдер
    # свернуло бы зону вместе с включением настройки.
    assert "stopPropagation" in JS
    assert "xk-dns-zone-head" in JS

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CSS = (ROOT / "xkeen-ui/static/panel-operator.css").read_text(encoding="utf-8")
TEMPLATE = (ROOT / "xkeen-ui/templates/panel.html").read_text(encoding="utf-8")
MODAL = TEMPLATE[
    TEMPLATE.index('<div id="mihomo-dns-modal"'):
    TEMPLATE.index('<div id="inbounds-apply-modal"')
]


def test_mihomo_dns_uses_the_shared_compact_modal_width():
    assert "xk-modal-width-1160" in MODAL
    assert "--xk-modal-width: 2200px" not in CSS
    assert "width: 70vw" not in CSS


def test_mihomo_dns_has_named_settings_and_diagnostics_columns():
    assert 'class="mihomo-dns-settings"' in MODAL
    assert 'class="routing-dns-over-vless-state mihomo-dns-state"' in MODAL
    assert 'data-zone="mihomo-route"' in MODAL
    assert 'data-zone="mihomo-fake"' in MODAL
    assert 'class="routing-dns-over-vless-foot mihomo-dns-foot"' in MODAL
    assert '"route state"' in CSS
    assert '"fake  fake"' in CSS


def test_fake_ip_fields_are_content_sized_instead_of_stretched_cards():
    start = CSS.index("body.panel-page #mihomo-dns-modal .mihomo-dns-fake-body {")
    block = CSS[start:CSS.index("}", start)]
    assert "align-items: start" in block
    assert '"core filters sources"' in block
    assert "align-items: stretch" not in block


def test_mihomo_dns_collapses_to_one_column_on_narrow_screens():
    start = CSS.index("@media (max-width: 1100px)", CSS.index(".mihomo-dns-body"))
    block = CSS[start:start + 600]
    assert 'grid-template-areas: "lead" "state" "route" "fake" "foot"' in block


def test_existing_runtime_hooks_remain_inside_the_modal():
    for element_id in (
        "mihomo-dns-status",
        "mihomo-dns-details",
        "mihomo-dns-mode",
        "mihomo-dns-mode-hint",
        "mihomo-dns-fake-options",
        "mihomo-dns-fake-range",
        "mihomo-dns-fake-filter-mode",
        "mihomo-dns-fake-filters",
        "mihomo-dns-proxy-group",
        "mihomo-dns-selector-enable",
        "mihomo-dns-geodata-enable",
        "mihomo-dns-rule-providers",
    ):
        assert f'id="{element_id}"' in MODAL, element_id

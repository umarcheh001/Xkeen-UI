from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def _read(rel_path: str) -> str:
    return (ROOT / rel_path).read_text(encoding="utf-8")


def test_xray_subscription_form_exposes_regex_filters_and_payload_fields():
    outbounds_src = _read("xkeen-ui/static/js/features/outbounds.js")

    assert "nameFilter: 'outbounds-subscriptions-name-filter'" in outbounds_src
    assert "typeFilter: 'outbounds-subscriptions-type-filter'" in outbounds_src
    assert "Фильтр имени (regex)" in outbounds_src
    assert "Фильтр типа (regex)" in outbounds_src
    assert "name_filter: String(($(SUB_IDS.nameFilter) && $(SUB_IDS.nameFilter).value) || '').trim()," in outbounds_src
    assert "type_filter: String(($(SUB_IDS.typeFilter) && $(SUB_IDS.typeFilter).value) || '').trim()," in outbounds_src
    assert "function subsFilterSummary(sub) {" in outbounds_src
    assert "data.filtered_out_count" in outbounds_src

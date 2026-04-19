from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def _read(rel_path: str) -> str:
    return (ROOT / rel_path).read_text(encoding="utf-8")


def test_xray_subscription_form_exposes_regex_filters_and_payload_fields():
    outbounds_src = _read("xkeen-ui/static/js/features/outbounds.js")

    assert "nameFilter: 'outbounds-subscriptions-name-filter'" in outbounds_src
    assert "typeFilter: 'outbounds-subscriptions-type-filter'" in outbounds_src
    assert '<span class="xk-pool-fieldlabel">Имя</span>' in outbounds_src
    assert '<span class="xk-pool-fieldlabel">Тип</span>' in outbounds_src
    assert '<span class="xk-pool-fieldlabel">Транспорт</span>' in outbounds_src
    assert 'xk-sub-filter-field xk-sub-span-4' in outbounds_src
    assert 'class="xk-sub-span-5"' in outbounds_src
    assert 'class="xk-sub-span-4"' in outbounds_src
    assert 'class="xk-sub-span-3"' in outbounds_src
    assert "name_filter: String(($(SUB_IDS.nameFilter) && $(SUB_IDS.nameFilter).value) || '').trim()," in outbounds_src
    assert "type_filter: String(($(SUB_IDS.typeFilter) && $(SUB_IDS.typeFilter).value) || '').trim()," in outbounds_src
    assert "function subsFilterSummary(sub) {" in outbounds_src
    assert "data.filtered_out_count" in outbounds_src


def test_xray_subscription_modal_exposes_transport_preview_and_manual_exclusions():
    outbounds_src = _read("xkeen-ui/static/js/features/outbounds.js")
    styles_src = _read("xkeen-ui/static/styles.css")

    assert 'data-modal-nodrag="1"' in outbounds_src
    assert 'data-modal-noresize="1"' in outbounds_src
    assert "transportFilter: 'outbounds-subscriptions-transport-filter'" in outbounds_src
    assert "excludedKeys: 'outbounds-subscriptions-excluded-keys'" in outbounds_src
    assert "nodesPanel: 'outbounds-subscriptions-nodes-panel'" in outbounds_src
    assert "nodesList: 'outbounds-subscriptions-nodes-list'" in outbounds_src
    assert "nodesSummary: 'outbounds-subscriptions-nodes-summary'" in outbounds_src
    assert "transport_filter: String(($(SUB_IDS.transportFilter) && $(SUB_IDS.transportFilter).value) || '').trim()," in outbounds_src
    assert "excluded_node_keys: subsGetExcludedKeysValue()," in outbounds_src
    assert "function subsRenderNodeList() {" in outbounds_src
    assert "function subsApplyModalGeometry() {" in outbounds_src
    assert "function subsTransportFilterText(transport, protocol) {" in outbounds_src
    assert "function subsProtocolFilterText(protocol) {" in outbounds_src
    assert "xk-sub-node-toggle" in outbounds_src
    assert "btn-danger btn-compact xk-sub-node-toggle" in outbounds_src
    assert "xk-sub-node-toggle-restore" in outbounds_src
    assert ".xk-sub-node-list" in styles_src
    assert ".xk-sub-modal {" in styles_src
    assert "grid-template-columns: repeat(2, minmax(0, 1fr));" in styles_src
    assert "grid-template-columns: repeat(12, minmax(0, 1fr));" in styles_src
    assert ".xk-sub-span-5" in styles_src
    assert ".xk-sub-filter-field .xk-pool-fieldlabel" in styles_src
    assert ".xk-sub-node-pill-transport" in styles_src
    assert ".xk-sub-table tbody tr.is-selected" in styles_src

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

    assert 'delete modal.dataset.modalRemember;' in outbounds_src
    assert 'delete modal.dataset.modalNopos;' in outbounds_src
    assert 'delete modal.dataset.modalNodrag;' in outbounds_src
    assert "transportFilter: 'outbounds-subscriptions-transport-filter'" in outbounds_src
    assert "excludedKeys: 'outbounds-subscriptions-excluded-keys'" in outbounds_src
    assert "nodesPanel: 'outbounds-subscriptions-nodes-panel'" in outbounds_src
    assert "nodesList: 'outbounds-subscriptions-nodes-list'" in outbounds_src
    assert "nodesSummary: 'outbounds-subscriptions-nodes-summary'" in outbounds_src
    assert "transport_filter: String(($(SUB_IDS.transportFilter) && $(SUB_IDS.transportFilter).value) || '').trim()," in outbounds_src
    assert "excluded_node_keys: subsGetExcludedKeysValue()," in outbounds_src
    assert "function subsRenderNodeList() {" in outbounds_src
    assert "function subsSyncModalLayout() {" in outbounds_src
    assert "function subsDecorateActionButtons(modal) {" in outbounds_src
    assert "function subsTransportFilterText(transport, protocol) {" in outbounds_src
    assert "function subsProtocolFilterText(protocol) {" in outbounds_src
    assert "function subsNodeLatencyEntry(sub, nodeKey) {" in outbounds_src
    assert "function subsProbeNode(subId, nodeKey) {" in outbounds_src
    assert "function subsPingAllTooltipText(sub, hasPingable) {" in outbounds_src
    assert "class=\"xk-sub-file-badge\">JSON</span>" in outbounds_src
    assert "xk-sub-list-action xk-sub-list-action-refresh xk-sub-refresh" in outbounds_src
    assert "xk-sub-list-action xk-sub-list-action-delete xk-sub-delete" in outbounds_src
    assert "Array.from(tbody.querySelectorAll('.xk-sub-file-link')).forEach((btn) => {" in outbounds_src
    assert "xk-sub-open" not in outbounds_src
    assert "xk-sub-edit" not in outbounds_src
    assert "/nodes/ping" in outbounds_src
    assert "/nodes/ping-bulk" in outbounds_src
    assert "xk-sub-node-ping" in outbounds_src
    assert "xk-sub-node-latency" in outbounds_src
    assert "btn.setAttribute('data-tooltip', tooltip);" in outbounds_src
    assert "btn.disabled = false;" in outbounds_src
    assert "Нет активных узлов в generated fragment." in outbounds_src
    assert "Tag prefix" in outbounds_src
    assert "xk-sub-node-toggle" in outbounds_src
    assert "resetBtn.classList.add('xk-sub-icon-btn');" in outbounds_src
    assert "saveBtn.classList.add('xk-sub-icon-btn');" in outbounds_src
    assert "xk-visually-hidden" in outbounds_src
    assert "&#10133;" in outbounds_src
    assert "&#128190;" in outbounds_src
    assert "btn-danger btn-compact xk-sub-node-toggle" in outbounds_src
    assert "xk-sub-node-toggle-restore" in outbounds_src
    assert ".xk-sub-node-list" in styles_src
    assert ".xk-sub-modal {" in styles_src
    assert ".xk-sub-modal.xk-sub-modal-compact .xk-sub-grid" in styles_src
    assert "#outbounds-subscriptions-modal .modal-body {" in styles_src
    assert "const isUserSized = !!(content.dataset && content.dataset.xkDragged === '1');" in outbounds_src
    assert "const maxReadableWidth = viewportWidth > 0" in outbounds_src
    assert "const maxViewportWidth = viewportWidth > 0" in outbounds_src
    assert "const clampWidth = isUserSized ? maxViewportWidth : maxReadableWidth;" in outbounds_src
    assert "content.style.maxWidth = `${Math.round(clampWidth)}px`;" in outbounds_src
    assert ".xk-sub-brief,\n.xk-sub-grid,\n.xk-sub-node-panel,\n#outbounds-subscriptions-modal .modal-actions {" not in styles_src
    assert ".xk-sub-grid {" in styles_src
    assert "flex: 0 0 auto;" in styles_src
    assert "overflow: hidden;" in styles_src
    assert "min-height: 220px;" in styles_src
    assert ".xk-sub-icon-btn.btn-compact {" in styles_src
    assert "flex-wrap: nowrap;" in styles_src
    assert "min-height: 88px;" in styles_src
    assert ".xk-sub-list-panel {" in styles_src
    assert ".xk-sub-file-badge {" in styles_src
    assert ".xk-sub-list-action {" in styles_src
    assert ".xk-sub-file-link {" in styles_src
    assert ".xk-sub-node-latency {" in styles_src
    assert ".xk-sub-node-ping.btn-compact" in styles_src
    assert "@keyframes xk-sub-node-ping-pulse" in styles_src
    assert "display: inline-flex;" in styles_src
    assert ".xk-sub-node-main {" in styles_src
    assert "gap: 7px;" in styles_src
    assert "width: min(96vw, 1080px) !important;" not in styles_src
    assert "max-width: 1080px !important;" not in styles_src
    assert "grid-template-columns: repeat(2, minmax(0, 1fr));" in styles_src
    assert "grid-template-columns: repeat(12, minmax(0, 1fr));" in styles_src
    assert ".xk-sub-span-5" in styles_src
    assert ".xk-sub-filter-field .xk-pool-fieldlabel" in styles_src
    assert ".xk-sub-node-pill-transport" in styles_src
    assert ".xk-sub-table tbody tr.is-selected" in styles_src

from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def _read(rel_path: str) -> str:
    return (ROOT / rel_path).read_text(encoding="utf-8")


def test_xray_subscription_form_exposes_regex_filters_and_payload_fields():
    outbounds_src = _read("xkeen-ui/static/js/features/outbounds.js")

    assert "nameFilter: 'outbounds-subscriptions-name-filter'" in outbounds_src
    assert "typeFilter: 'outbounds-subscriptions-type-filter'" in outbounds_src
    assert "routingMode: 'outbounds-subscriptions-routing-mode'" in outbounds_src
    assert '<span class="xk-pool-fieldlabel">Имя</span>' in outbounds_src
    assert '<span class="xk-pool-fieldlabel">Тип</span>' in outbounds_src
    assert '<span class="xk-pool-fieldlabel">Транспорт</span>' in outbounds_src
    assert '<span class="xk-pool-fieldlabel">Обновлять, ч</span>' in outbounds_src
    assert "const SUB_DEFAULT_INTERVAL_HOURS = 24;" in outbounds_src
    assert "xk-sub-interval-note" in outbounds_src
    assert "function subsIntervalSummary(sub) {" in outbounds_src
    assert "profile_update_interval_hours" in outbounds_src
    assert 'xk-sub-filter-field xk-sub-span-4' in outbounds_src
    assert 'class="xk-sub-span-5"' in outbounds_src
    assert 'class="xk-sub-span-4"' in outbounds_src
    assert 'class="xk-sub-span-3 xk-sub-interval-field"' in outbounds_src
    assert "name_filter: String(($(SUB_IDS.nameFilter) && $(SUB_IDS.nameFilter).value) || '').trim()," in outbounds_src
    assert "type_filter: String(($(SUB_IDS.typeFilter) && $(SUB_IDS.typeFilter).value) || '').trim()," in outbounds_src
    assert "routing_mode: String(($(SUB_IDS.routingMode) && $(SUB_IDS.routingMode).value) || 'safe-fallback').trim() || 'safe-fallback'," in outbounds_src
    assert "function subsFilterSummary(sub) {" in outbounds_src
    assert "data.filtered_out_count" in outbounds_src


def test_outbounds_proxy_pool_uses_fragment_summary_without_hiding_pool_button():
    outbounds_src = _read("xkeen-ui/static/js/features/outbounds.js")
    styles_src = _read("xkeen-ui/static/styles.css")

    assert "function setOutboundsSummaryFragmentMode(mode, fileName, summary) {" in outbounds_src
    assert "body.classList.toggle('xk-outbounds-pool-fragment', normalizedMode === 'pool');" in outbounds_src
    assert "function isPoolGeneratedText(text) {" in outbounds_src
    assert "isPoolGeneratedText(data && data.text)" in outbounds_src
    assert "outbounds-load-pool-fragment" in outbounds_src
    assert "Пул прокси загружен:" in outbounds_src
    assert "#outbounds-body.xk-outbounds-summary-fragment #outbounds-save-btn" in styles_src
    assert "#outbounds-body.xk-outbounds-subscription-fragment #outbounds-pool-btn" in styles_src
    assert "#outbounds-body.xk-outbounds-summary-fragment #outbounds-pool-btn" not in styles_src


def test_outbounds_card_exposes_current_proxy_nodes_and_ping_controls():
    template_src = _read("xkeen-ui/templates/panel.html")
    outbounds_src = _read("xkeen-ui/static/js/features/outbounds.js")
    styles_src = _read("xkeen-ui/static/styles.css")
    routes_src = _read("xkeen-ui/routes/xray_configs.py")

    assert 'id="outbounds-nodes-panel"' in template_src
    assert 'id="outbounds-nodes-pingall"' in template_src
    assert 'id="outbounds-nodes-list"' in template_src
    assert "OUTBOUND_NODE_IDS" in outbounds_src
    assert "function refreshOutboundsNodes(visible) {" in outbounds_src
    assert "function outboundsProbeNode(nodeKey) {" in outbounds_src
    assert "function outboundsProbeAllNodes() {" in outbounds_src
    assert "/api/xray/outbounds/nodes" in outbounds_src
    assert "/api/xray/outbounds/nodes/ping" in routes_src
    assert "/api/xray/outbounds/nodes/ping-bulk" in routes_src
    assert ".xk-outbounds-node-panel {" in styles_src
    assert ".xk-outbounds-node-list" in styles_src
    assert ".xk-outbounds-node-panel {\n  flex: 1 1 auto;" in styles_src
    assert ".xk-outbounds-node-panel {\n  flex: 1 1 auto;\n  margin: 10px 0 12px;\n  overflow: hidden;" in styles_src
    assert ".xk-outbounds-node-list {\n  grid-template-columns: 1fr;\n  gap: 8px;\n  min-height: 0;\n  max-height: min(36vh, 320px);\n  overflow: auto;" in styles_src


def test_outbounds_pool_nodes_relayout_after_card_open_and_async_load():
    outbounds_src = _read("xkeen-ui/static/js/features/outbounds.js")
    config_shell_src = _read("xkeen-ui/static/js/pages/config_shell.shared.js")
    panel_runtime_src = _read("xkeen-ui/static/js/pages/panel.view_runtime.js")

    assert "let _outboundsNodeLayoutSeq = 0;" in outbounds_src
    assert "function outboundsCanRelayoutNodeList() {" in outbounds_src
    assert "function scheduleOutboundsNodeListLayout() {" in outbounds_src
    assert "function onShow(opts) {" in outbounds_src
    assert "try { requestAnimationFrame(run); } catch (e) { setTimeout(run, 0); }" in outbounds_src
    assert "setTimeout(run, 60);" in outbounds_src
    assert "setTimeout(run, 180);" in outbounds_src
    assert "if (visible !== false && hasNodes) scheduleOutboundsNodeListLayout();" in outbounds_src
    assert "if (willOpen) scheduleOutboundsNodeListLayout();" in outbounds_src
    assert "setTimeout(rerunLayout, 120);" in outbounds_src
    assert "setTimeout(rerunLayout, 260);" in outbounds_src
    assert "onShow," in outbounds_src
    assert "export function onShowOutbounds(...args) {" in outbounds_src
    assert "if (typeof api.onShow === 'function') {" in config_shell_src
    assert "safe(() => configShell.activateOutboundsView({ reason: 'tab' }));" in panel_runtime_src


def test_xray_subscription_modal_exposes_transport_preview_and_manual_exclusions():
    outbounds_src = _read("xkeen-ui/static/js/features/outbounds.js")
    styles_src = _read("xkeen-ui/static/styles.css")

    assert 'delete modal.dataset.modalRemember;' in outbounds_src
    assert 'delete modal.dataset.modalNopos;' in outbounds_src
    assert 'delete modal.dataset.modalNodrag;' in outbounds_src
    assert "transportFilter: 'outbounds-subscriptions-transport-filter'" in outbounds_src
    assert "routingMode: 'outbounds-subscriptions-routing-mode'" in outbounds_src
    assert "excludedKeys: 'outbounds-subscriptions-excluded-keys'" in outbounds_src
    assert "nodesPanel: 'outbounds-subscriptions-nodes-panel'" in outbounds_src
    assert "nodesList: 'outbounds-subscriptions-nodes-list'" in outbounds_src
    assert "nodesSummary: 'outbounds-subscriptions-nodes-summary'" in outbounds_src
    assert "transport_filter: String(($(SUB_IDS.transportFilter) && $(SUB_IDS.transportFilter).value) || '').trim()," in outbounds_src
    assert "routing_mode: String(($(SUB_IDS.routingMode) && $(SUB_IDS.routingMode).value) || 'safe-fallback').trim() || 'safe-fallback'," in outbounds_src
    assert "excluded_node_keys: state.excluded_node_keys.slice()," in outbounds_src
    assert "function subsRenderNodeList() {" in outbounds_src
    assert "function subsSyncModalLayout() {" in outbounds_src
    assert "function subsDecorateActionButtons(modal) {" in outbounds_src
    assert "function subsTransportFilterText(transport, protocol) {" in outbounds_src
    assert "function subsProtocolFilterText(protocol) {" in outbounds_src
    assert "xk-sub-update-note" in outbounds_src
    assert "Автообновление" in outbounds_src
    assert "LeastPing и generated fragments" in outbounds_src
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
    assert "xk-sub-pingall-spinner" in outbounds_src
    assert "xk-sub-pingall-glyph" in outbounds_src
    assert "const connectionSummary = [endpoint, detail].filter(Boolean).join(' · ');" in outbounds_src
    assert "data-tooltip=\"${connectionSummaryHtml}\"" in outbounds_src
    assert "btn.setAttribute('data-tooltip', tooltip);" in outbounds_src
    assert "btn.setAttribute('aria-busy', 'true');" in outbounds_src
    assert "btn.removeAttribute('aria-busy');" in outbounds_src
    assert "btn.disabled = false;" in outbounds_src
    assert "Нет активных узлов в generated fragment." in outbounds_src
    assert "Tag prefix" in outbounds_src
    assert "имя будет сгенерировано автоматически при сохранении" in outbounds_src
    assert "префикс будет сгенерирован автоматически при сохранении" in outbounds_src
    assert "xk-sub-node-toggle" in outbounds_src
    assert "resetBtn.classList.add('xk-sub-icon-btn');" in outbounds_src
    assert "saveBtn.classList.add('xk-sub-icon-btn');" in outbounds_src
    assert "xk-visually-hidden" in outbounds_src
    assert "&#10133;" in outbounds_src
    assert "&#128190;" in outbounds_src
    assert "btn-danger btn-compact xk-sub-node-toggle" in outbounds_src
    assert "xk-sub-node-toggle-restore" in outbounds_src
    assert "outbounds-subscriptions-routing-mode" in outbounds_src
    assert "Жёстко · pool" in outbounds_src
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
    assert "min-height: 220px;" in styles_src
    assert ".xk-sub-icon-btn.btn-compact {" in styles_src
    assert ".xk-sub-pingall-spinner {" in styles_src
    assert ".xk-sub-icon-btn.btn-compact.is-busy {" in styles_src
    assert "@keyframes xk-sub-pingall-spin" in styles_src
    assert ".xk-sub-routing-mode {" in styles_src
    assert ".xk-sub-inline-label {" in styles_src
    assert "flex-wrap: nowrap;" in styles_src
    assert "min-height: 0;" in styles_src
    assert ".xk-sub-list-panel {" in styles_src
    assert ".xk-sub-node-panel {\n  flex: 1 1 auto;" in styles_src
    assert ".xk-sub-node-panel {\n  flex: 1 1 auto;\n  margin-top: 0;\n  min-height: 0;\n  overflow: hidden;" in styles_src
    assert ".xk-sub-node-list {\n  display: grid;\n  grid-template-columns: repeat(2, minmax(0, 1fr));" in styles_src
    assert "#outbounds-subscriptions-modal .xk-sub-node-panel {\n  flex: 0 0 auto;\n  overflow: visible;" in styles_src
    assert ".xk-sub-file-badge {" in styles_src
    assert ".xk-sub-list-action {" in styles_src
    assert ".xk-sub-file-link {" in styles_src
    assert "#outbounds-subscriptions-nodes-list {" in styles_src
    assert ".xk-sub-node-latency {" in styles_src
    assert ".xk-sub-node-ping.btn-compact" in styles_src
    assert "@keyframes xk-sub-node-ping-pulse" in styles_src
    assert "display: inline-flex;" in styles_src
    assert ".xk-sub-node-main {" in styles_src
    assert "gap: 6px;" in styles_src
    assert "#outbounds-subscriptions-nodes-list {\n  grid-template-columns: repeat(auto-fit, minmax(min(100%, 272px), 1fr));\n  gap: 10px;\n  padding: 8px;\n  flex: 0 0 auto;\n  max-height: none;\n  overflow: visible;" in styles_src
    assert "width: min(96vw, 1080px) !important;" not in styles_src
    assert "max-width: 1080px !important;" not in styles_src
    assert "grid-template-columns: repeat(12, minmax(0, 1fr));" in styles_src
    assert "white-space: nowrap;" in styles_src
    assert "text-overflow: ellipsis;" in styles_src
    assert ".xk-sub-span-5" in styles_src
    assert ".xk-sub-filter-field .xk-pool-fieldlabel" in styles_src
    assert ".xk-sub-interval-note {" in styles_src
    assert ".xk-sub-update-note {" in styles_src
    assert ".xk-sub-update-title {" in styles_src
    assert ".xk-sub-node-pill-transport" in styles_src
    assert ".xk-sub-table tbody tr.is-selected" in styles_src


def test_xray_subscription_modal_protects_drafts_and_explains_autofill():
    outbounds_src = _read("xkeen-ui/static/js/features/outbounds.js")
    styles_src = _read("xkeen-ui/static/styles.css")
    modal_src = _read("xkeen-ui/static/js/ui/modal.js")

    assert "nameNote: 'outbounds-subscriptions-name-note'" in outbounds_src
    assert "tagNote: 'outbounds-subscriptions-tag-note'" in outbounds_src
    assert "urlNote: 'outbounds-subscriptions-url-note'" in outbounds_src
    assert "intervalNote: 'outbounds-subscriptions-interval-note'" in outbounds_src
    assert "intervalApply: 'outbounds-subscriptions-interval-apply-btn'" in outbounds_src
    assert "nameFilterNote: 'outbounds-subscriptions-name-filter-note'" in outbounds_src
    assert "typeFilterNote: 'outbounds-subscriptions-type-filter-note'" in outbounds_src
    assert "transportFilterNote: 'outbounds-subscriptions-transport-filter-note'" in outbounds_src
    assert "function subsResolveDraftDefaults(formState) {" in outbounds_src
    assert "function subsValidateFormState(formState) {" in outbounds_src
    assert "function subsProviderIntervalHours(formState) {" in outbounds_src
    assert "function subsSyncIntervalRecommendation(formState, validation) {" in outbounds_src
    assert "function subsSyncSubscriptionFormState() {" in outbounds_src
    assert "function subsConfirmDiscardDraft(opts) {" in outbounds_src
    assert "function subsRestoreBaseline(options) {" in outbounds_src
    assert "window.confirm(subsBuildDiscardConfirmText(confirmOptions))" in outbounds_src
    assert 'class="xk-sub-url-action"' in outbounds_src
    assert 'class="xk-pool-fieldlabel xk-sub-url-action-label"' in outbounds_src
    assert 'id="outbounds-subscriptions-interval-apply-btn"' in outbounds_src
    assert 'class="xk-sub-span-3 xk-sub-interval-field"' in outbounds_src
    assert 'class="xk-sub-interval-inline"' in outbounds_src
    assert "saveBtn.disabled = !validation.valid || _subscriptionSaveBusy;" in outbounds_src
    assert "previewBtn.disabled = !validation.valid || _subscriptionPreviewBusy;" in outbounds_src
    assert "badge.textContent = _subscriptionPreview" in outbounds_src
    assert "Есть правки · нажми «Сохранить»" in outbounds_src
    assert "Пустое поле сохранит текущее имя:" in outbounds_src
    assert "Пустое поле сохранит текущий prefix:" in outbounds_src
    assert "Оставь поле пустым, и имя появится после ввода URL." in outbounds_src
    assert "После сохранения будет использован prefix:" in outbounds_src
    assert "applyBtn.textContent = canApply ? `${providerHours} ч` : '';" in outbounds_src
    assert "Рекомендовано: ${providerHours} ч" in outbounds_src
    assert "Принять рекомендацию провайдера: обновлять подписку каждые ${providerHours} ч." in outbounds_src
    assert "applyBtn.classList.add('is-provider');" in outbounds_src
    assert "profileUpdateIntervalHours: Number(data.profile_update_interval_hours || 0)," in outbounds_src
    assert "Интервал обновления установлен по рекомендации провайдера:" in outbounds_src
    assert "Закрыть окно подписок и потерять текущий черновик?" in outbounds_src
    assert "Очистить форму подписки и потерять текущий черновик?" in outbounds_src
    assert "Обновить due-подписки и потерять текущий черновик формы?" in outbounds_src
    assert "Удалить подписку и потерять текущий черновик формы?" in outbounds_src
    assert "Некорректный regex для" in outbounds_src
    assert ".xk-sub-field-note {" in styles_src
    assert ".xk-sub-field-note.is-error {" in styles_src
    assert ".xk-sub-interval-apply {" in styles_src
    assert ".xk-sub-interval-apply.is-provider {" in styles_src
    assert ".xk-sub-interval-inline {" in styles_src
    assert ".xk-sub-interval-field .xk-sub-interval-inline .xray-log-filter {" in styles_src
    assert ".xk-sub-interval-note-inline {" in styles_src
    assert ".xk-sub-icon-btn.btn-compact.is-dirty {" in styles_src
    assert ".xk-sub-form .xk-sub-url-action {" in styles_src
    assert ".xk-sub-form .xk-sub-url-action-label {" in styles_src
    assert ".xk-sub-form .xk-sub-url-row {\n  display: grid;\n  grid-template-columns: minmax(0, 1fr) auto;" in styles_src
    assert "const floor = isConfirm ? Math.max(Z_BASE + 40, 130) : Z_BASE;" in modal_src

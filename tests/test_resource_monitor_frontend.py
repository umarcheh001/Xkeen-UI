from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / "xkeen-ui/templates/panel.html"
SCRIPT = ROOT / "xkeen-ui/static/js/features/resource_monitor.js"
CSS = ROOT / "xkeen-ui/static/panel-operator.css"


def test_resource_monitor_opens_diagnostic_dashboard_from_header():
    template = TEMPLATE.read_text(encoding="utf-8")
    script = SCRIPT.read_text(encoding="utf-8")
    css = CSS.read_text(encoding="utf-8")

    assert 'id="xk-resource-monitor"' in template
    assert 'data-resource-dashboard-target="xk-resource-dashboard-modal"' in template
    assert 'id="xk-resource-dashboard-modal"' in template
    assert 'class="modal hidden xk-resource-dashboard-modal"' in template
    assert 'data-operator-modal-family="master-detail"' in template
    for element_id in (
        "xk-resource-chart-cpu",
        "xk-resource-chart-memory",
        "xk-resource-chart-network",
        "xk-resource-dashboard-refresh",
        "xk-internet-health",
        "xk-internet-check-dns-row",
        "xk-dns-guidance",
        "xk-conntrack-panel",
        "xk-interface-rows",
        "xk-interface-panel",
        "xk-process-panel",
        "xk-process-action",
        "xk-clients-panel",
        "xk-clients-action",
        "xk-client-rows",
        "xk-channel-panel",
        "xk-channel-action",
        "xk-channel-trace",
        "xk-channel-trace-result",
        "xk-channel-trace-title",
        "xk-channel-trace-note",
        "xk-channel-trace-hops",
        "xk-lte-panel",
        "xk-lte-action",
        "xk-lte-modems",
        "xk-incidents-list",
        "xk-system-details",
    ):
        assert f'id="{element_id}"' in template
    assert 'data-dns-toggle="false"' in template
    assert 'aria-controls="xk-dns-guidance"' in template
    assert 'hidden aria-hidden="true"' in template
    assert "Ошибки DNS (DoH/DoT)" in template
    assert "Подробности — в журнале диагностики Keenetic." in template
    assert "Проблемные подключения" not in template
    assert "Что можно сделать" not in template
    assert "Графики показывают нагрузку роутера, а причина указана в блоке DNS ниже" not in script
    assert "Графики ниже показывают ресурсы роутера, но не определяют доступность DNS-upstream" not in template
    assert 'xk-collapsible-panel' in template
    assert 'class="btn-secondary xk-toggle-button" id="xk-channel-trace"' in template
    for tooltip in (
        "Шлюз — первый узел провайдера.",
        "DNS преобразует имена сайтов в IP-адреса.",
        "Captive portal — страница авторизации сети",
    ):
        assert tooltip in template
    for fragment in (
        "setDashboardOpen(true)",
        "data-resource-range",
        "MAX_HISTORY = 360",
        "MAX_HISTORY = 17280",
        "drawCharts",
        "receive_bytes_per_second",
        "PROCESS_ENDPOINT = \"/api/system/processes\"",
        "CLIENTS_ENDPOINT = \"/api/system/router/clients\"",
        "LTE_ENDPOINT = \"/api/system/router/lte\"",
        "CHANNEL_ENDPOINT = \"/api/system/router/channel-check\"",
        "renderRouterDiagnostics",
        "dns_diagnostics",
        "Ошибка DoH/DoT",
        "syncDnsGuidanceState",
        "toggleDnsGuidance",
        "Проблема с зашифрованным DNS",
        "formatOptionalBitRate",
        'value === true ? "Нет перехвата"',
        "loadProcesses",
        "loadClients",
        "loadLte",
        'Array.isArray(payload?.items)',
        "runChannelCheck",
        "setProcessAction",
        'setProcessAction("retry", "Повторить")',
        "activateProcessAction",
        'interfaceFilter = "active"',
        'data-interface-filter',
        'slice(0, 24)',
        'ctx.createLinearGradient',
        'traceSmoothLine',
        'data-chart-toggle',
        'pointermove',
        'percentile(values, 95)',
        'load_1m) || 0) / cores',
        'setPressedGroup',
        'setRefreshBusy',
        'syncCollapsiblePanelState',
        'COLLAPSIBLE_PANEL_SELECTOR = "details.xk-collapsible-panel"',
        'bindCollapsiblePanelState',
        'document.addEventListener(\n    "toggle"',
        'mutation.addedNodes.forEach(syncCollapsiblePanels)',
        'observe(document.documentElement, { childList: true, subtree: true })',
        'aria-pressed',
        'aria-busy',
        'xk-channel-trace-output',
        'payload?.trace_summary',
        'payload?.trace_hops',
        'data-tooltip',
        'toggleInterfaceErrorDetails',
        'appendInterfaceErrorCell',
        'xk-resource-interface-chip',
    ):
        assert fragment in script
    for fragment in (
        ".xk-resource-dashboard-content",
        ".xk-resource-overview",
        ".xk-resource-chart-card",
        ".xk-resource-chart-tooltip",
        ".xk-resource-chart-stats",
        '[aria-pressed="true"]',
        "#xk-resource-dashboard-refresh.is-busy",
        ".xk-resource-health",
        ".xk-router-diagnostics",
        ".xk-dns-guidance",
        ".xk-dns-guidance-dot",
        ".xk-resource-table",
        ".xk-process-panel",
        ".xk-process-button",
        ".xk-resource-stage2-grid",
        ".xk-collapsible-panel",
        ".xk-stage2-action",
        ".xk-toggle-button",
        'content: "Вкл.";',
        ".xk-channel-trace-summary",
        ".xk-channel-trace-technical",
        ".xk-incident-row",
        "flex-flow: column nowrap",
        ".xk-interface-errors",
        'background: transparent !important;',
        ".xk-interface-error-detail",
        ".xk-resource-detail-wide",
        ".xk-resource-interface-chip",
    ):
        assert fragment in css

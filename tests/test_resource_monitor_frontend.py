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
        "xk-conntrack-panel",
        "xk-interface-rows",
        "xk-process-panel",
        "xk-process-action",
        "xk-clients-panel",
        "xk-clients-action",
        "xk-client-rows",
        "xk-channel-panel",
        "xk-channel-action",
        "xk-channel-trace",
        "xk-lte-panel",
        "xk-lte-action",
        "xk-incidents-list",
    ):
        assert f'id="{element_id}"' in template
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
        "formatOptionalBitRate",
        'value === true ? "Нет перехвата"',
        "loadProcesses",
        "loadClients",
        "loadLte",
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
        'aria-pressed',
        'aria-busy',
        'xk-channel-trace-output',
        'data-tooltip',
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
        ".xk-resource-table",
        ".xk-process-panel",
        ".xk-process-button",
        ".xk-resource-stage2-grid",
        ".xk-stage2-action",
        ".xk-incident-row",
        "flex-flow: column nowrap",
    ):
        assert fragment in css

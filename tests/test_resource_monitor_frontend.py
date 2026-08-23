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
    ):
        assert f'id="{element_id}"' in template
    for fragment in (
        "setDashboardOpen(true)",
        "data-resource-range",
        "MAX_HISTORY = 360",
        "drawCharts",
        "receive_bytes_per_second",
        "PROCESS_ENDPOINT = \"/api/system/processes\"",
        "renderRouterDiagnostics",
        "loadProcesses",
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
    ):
        assert fragment in script
    for fragment in (
        ".xk-resource-dashboard-content",
        ".xk-resource-overview",
        ".xk-resource-chart-card",
        ".xk-resource-chart-tooltip",
        ".xk-resource-chart-stats",
        ".xk-resource-health",
        ".xk-router-diagnostics",
        ".xk-resource-table",
        ".xk-process-panel",
        ".xk-process-button",
    ):
        assert fragment in css

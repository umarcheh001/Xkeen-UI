from __future__ import annotations

from pathlib import Path

from scripts.panel_template_source import compose_panel_template


ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = compose_panel_template(ROOT)
SCRIPT = ROOT / "xkeen-ui/static/js/features/resource_monitor.js"
MODEL = ROOT / "xkeen-ui/static/js/features/resource_monitor_model.js"
CSS = ROOT / "xkeen-ui/static/panel-operator.css"


def test_resource_monitor_opens_diagnostic_dashboard_from_header():
    template = TEMPLATE
    script = SCRIPT.read_text(encoding="utf-8")
    css = CSS.read_text(encoding="utf-8")

    assert 'id="xk-resource-monitor"' in template
    assert 'data-resource-dashboard-target="xk-resource-dashboard-modal"' in template
    assert 'id="xk-resource-dashboard-modal"' in template
    assert 'class="modal hidden xk-resource-dashboard-modal"' in template
    assert 'data-operator-modal-family="master-detail"' in template
    for element_id in (
        "xk-resource-export",
        "xk-resource-dashboard-view",
        "xk-resource-more",
        "xk-resource-more-menu",
        "xk-resource-dashboard-refresh",
    ):
        assert f'id="{element_id}"' in template
    # the old light-DOM sections are gone: the window is drawn inside its shadow root
    for gone_id in ("xk-system-details", "xk-resource-detail-cores", "xk-resource-detail-interfaces", "xk-internet-health", "xk-conntrack-panel", "xk-dns-guidance", "xk-resource-health"):
        assert f'id="{gone_id}"' not in template
    assert "Проблемные подключения" not in template
    assert "Что можно сделать" not in template
    assert "Графики показывают нагрузку роутера, а причина указана в блоке DNS ниже" not in script
    assert "Графики ниже показывают ресурсы роутера, но не определяют доступность DNS-upstream" not in template
    assert 'xk-collapsible-panel' not in template
    # the tool sections moved into the window's shadow root (resource_monitor/tools.js)
    for gone in ("xk-clients-panel", "xk-channel-panel", "xk-lte-panel", "xk-incidents-list", "xk-interface-panel", "xk-process-panel", "xk-dashboard-tools"):
        assert f'id="{gone}"' not in template
    for fragment in (
        "setDashboardOpen(true)",
        "loadProcesses",
        "loadClients",
        "loadLte",
        "runChannelCheck",
        'setRefreshBusy',
        'aria-busy',
        'data-tooltip',
    ):
        assert fragment in script
    # what drew the old light-DOM window is gone with it
    for gone in (
        "renderDashboard",
        "renderInternet",
        "renderConntrack",
        "renderRouterDiagnostics",
        "DNS_DIAGNOSTICS_ENDPOINT",
        "dns-diagnostics",
        "syncDnsGuidanceState",
        "toggleDnsGuidance",
        "loadDnsDiagnostics",
        "dnsDiagnosticsLoaded",
        "resourceHealth",
        "xk-resource-detail",
        "xk-internet-",
        "xk-conntrack-",
        "xk-resource-health",
        "xk-resource-interface-chip",
        "bindCollapsiblePanelState",
        "syncCollapsiblePanelState",
        "HIDDEN_POLL_MS",
    ):
        assert gone not in script
    # the header monitor asks for nothing while the tab is hidden
    assert "document.hidden" in script
    assert "Math.max(HIDDEN" not in script
    for name in ("loadProcesses", "loadClients", "loadLte", "runChannelCheck"):
        assert f"{name}: () => loadDashboardTool(" in script
    for gone in ("fetch(CLIENTS_ENDPOINT", "async function loadLte", "async function loadProcesses", "renderInterfaces", "renderClients", "renderLte"):
        assert gone not in script
    model = MODEL.read_text(encoding="utf-8")
    for gone in ("Проблема с зашифрованным DNS", "resourceHealth", "selectClients", "nearestPointIndex"):
        assert gone not in model
    assert "buildResourceSnapshot" in model
    # the history, the polling and the charts of the window live in resource_monitor/dashboard.js
    for removed in ("selectHistory", "historyGaps", "drawCharts", "MAX_HISTORY", "rangeMinutes", "CHARTS"):
        assert removed not in script
    assert 'from "./resource_monitor/dashboard.js"' in script
    assert "openDashboard()" in script and "closeDashboard()" in script and "exportDashboardSnapshot()" in script
    assert 'id="xk-dashboard-history"' not in template
    assert 'id="xk-resource-dashboard-view"' in template
    # what the header monitor and the window's frame still need
    for fragment in (
        ".xk-resource-monitor",
        ".xk-resource-meter",
        ".xk-resource-dashboard-content",
        ".xk-resource-dashboard-header",
        ".xk-resource-dashboard-body",
        ".xk-resource-more-menu",
        "#xk-resource-dashboard-view",
        "#xk-resource-dashboard-refresh.is-busy",
        "flex-flow: column nowrap",
    ):
        assert fragment in css
    # the styles of the old light-DOM window were removed with it (the new one styles itself in its shadow root)
    for gone in (
        ".xk-resource-overview",
        ".xk-resource-chart",
        ".xk-dashboard-",
        ".xk-conntrack",
        ".xk-internet-",
        ".xk-resource-health",
        ".xk-router-diagnostics",
        ".xk-dns-guidance",
        ".xk-resource-table",
        ".xk-process-",
        ".xk-resource-stage2-grid",
        ".xk-stage2-",
        ".xk-collapsible-panel",
        ".xk-toggle-button",
        ".xk-channel-",
        ".xk-incident-row",
        ".xk-interface-",
        ".xk-lte-",
        ".xk-resource-detail-wide",
        ".xk-resource-interface-chip",
        ".xk-history-guide",
        ".xk-load-explanation",
        ".xk-clients-actions",
        ".xk-resource-range",
    ):
        assert gone not in css


TOOLS = ROOT / "xkeen-ui/static/js/features/resource_monitor"


def test_lte_modem_controls_keep_probe_but_explain_reset_is_disabled():
    script = (TOOLS / "tool_modems.js").read_text(encoding="utf-8")
    css = CSS.read_text(encoding="utf-8")

    assert "data-probe=" in script
    assert "Проверить управление" in script
    assert "Перезапуск из панели отключён" in script
    assert 'data-lte-action="reset"' not in script
    assert "/reset" not in script
    assert "operationId" not in script
    assert "pollLteOperation" not in script
    assert ".xk-lte-controls" not in css


def test_lte_modem_mutations_send_the_shared_csrf_header():
    request_body = (TOOLS / "tools_net.js").read_text(encoding="utf-8")

    assert "coreHttp?.withCSRF" in request_body
    assert 'coreHttp.withCSRF(requestInit, requestInit.method || "GET")' in request_body
    assert 'meta[name="csrf-token"]' in request_body
    assert 'headers.has("X-CSRF-Token")' in request_body
    assert 'headers.set("X-CSRF-Token", token)' in request_body
    assert 'method: "POST"' in (TOOLS / "tool_modems.js").read_text(encoding="utf-8")


def test_tool_tabs_use_the_same_endpoints_and_escape_server_strings():
    sources = {name: (TOOLS / name).read_text(encoding="utf-8") for name in ("tool_devices.js", "tool_ping.js", "tool_procs.js", "tool_modems.js", "tool_events.js")}
    assert '"/api/system/router/clients"' in sources["tool_devices.js"]
    assert '"/api/system/router/channel-check"' in sources["tool_ping.js"]
    assert '"/api/system/processes"' in sources["tool_procs.js"]
    assert '"/api/system/router/lte"' in sources["tool_modems.js"]
    assert '"/api/system/events"' in sources["tool_events.js"]
    for name, text in sources.items():
        assert "esc(" in text, name
    # the IMEI is masked before it reaches the page
    assert "maskImei(item.imei)" in sources["tool_modems.js"]
    assert "item.imei}" not in sources["tool_modems.js"]

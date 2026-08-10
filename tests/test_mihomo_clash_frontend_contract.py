from __future__ import annotations

import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / "xkeen-ui" / "templates" / "panel.html"
CSS = ROOT / "xkeen-ui" / "static" / "panel-operator.css"
FEATURE = ROOT / "xkeen-ui" / "static" / "js" / "features" / "mihomo_clash" / "index.js"
CLIENT = ROOT / "xkeen-ui" / "static" / "js" / "features" / "mihomo_clash" / "client.js"
STATE = ROOT / "xkeen-ui" / "static" / "js" / "features" / "mihomo_clash" / "state.js"
GROUPS = ROOT / "xkeen-ui" / "static" / "js" / "features" / "mihomo_clash" / "groups.js"
CONNECTIONS = ROOT / "xkeen-ui" / "static" / "js" / "features" / "mihomo_clash" / "connections.js"
RULES = ROOT / "xkeen-ui" / "static" / "js" / "features" / "mihomo_clash" / "rules.js"
LOGS = ROOT / "xkeen-ui" / "static" / "js" / "features" / "mihomo_clash" / "logs.js"
LAZY = ROOT / "xkeen-ui" / "static" / "js" / "pages" / "panel.lazy_bindings.runtime.js"
VIEW_RUNTIME = ROOT / "xkeen-ui" / "static" / "js" / "pages" / "panel.view_runtime.js"
INVENTORY = ROOT / "docs" / "panel-operator-icon-inventory.json"


def _text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _mihomo_markup() -> str:
    panel = _text(TEMPLATE)
    return panel[panel.index('<div id="view-mihomo"') : panel.index('<div id="view-xkeen"')]


def test_workspace_shell_preserves_existing_mihomo_editor_ids_inside_config_subview():
    markup = _mihomo_markup()
    assert 'role="tablist" aria-label="Рабочая область Mihomo"' in markup
    for subview in ("control", "connections", "rules", "logs", "config"):
        assert f'data-mihomo-clash-subview="{subview}"' in markup
    assert 'data-mihomo-clash-panel="config"' in markup

    for existing_id in (
        "mihomo-body",
        "mihomo-editor",
        "mihomo-editor-monaco",
        "mihomo-save-btn",
        "mihomo-save-restart-btn",
        "mihomo-profiles-link",
        "mihomo-profiles-panel",
    ):
        assert markup.count(f'id="{existing_id}"') == 1

    config_start = markup.index('id="mihomo-clash-panel-config"')
    assert markup.index('id="mihomo-body"') > config_start
    assert markup.index('xk-mihomo-log-card') > config_start


def test_workspace_uses_operator_sprite_and_has_no_raw_emoji():
    markup = _mihomo_markup()
    for icon in ("dashboard", "transfer", "list-details", "settings", "refresh", "loading"):
        assert f"op_icon('{icon}')" in markup
    assert not re.search(r"[\U0001F300-\U0001FAFF]", markup)

    inventory = json.loads(_text(INVENTORY))
    usage = [entry for item in inventory["items"] for entry in item.get("usage", [])]
    assert any(entry.get("location", "").startswith("xkeen-ui/templates/panel.html:") for entry in usage)


def test_mihomo_clash_feature_is_lazy_and_not_in_eager_feature_registry():
    lazy = _text(LAZY)
    eager = _text(ROOT / "xkeen-ui" / "static" / "js" / "features" / "index.js")
    runtime = _text(VIEW_RUNTIME)

    assert "mihomoClash: {" in lazy
    assert "import('../features/mihomo_clash/index.js')" in lazy
    assert "ensurePanelLazyFeature('mihomoClash')" in runtime
    assert "getPanelLazyFeatureApi('mihomoClash')" in runtime
    assert "getMihomoClashFeatureApi()" in runtime
    assert "mihomoClash" not in eager
    assert "const mihomoClashTrigger = raw.closest('[data-mihomo-clash-subview], [data-mihomo-clash-action]');" in lazy
    assert "fireDeferredClick(mihomoClashTrigger);" in lazy


def test_workspace_lifecycle_aborts_network_outside_runtime_subviews():
    feature = _text(FEATURE)
    client = _text(CLIENT)

    for fragment in (
        "export function activateMihomoClashWorkspace",
        "export function deactivateMihomoClashWorkspace",
        "export function activateMihomoClashSubview",
        "document.addEventListener('visibilitychange'",
        "abortStatusRequest();",
        "currentSubview === 'config'",
        "if (!active || currentSubview === 'config' || !visible) return false;",
    ):
        assert fragment in feature
    assert "'/api/mihomo/clash/status'" in client
    assert "timeoutMs: 5000" in client
    assert "retry: 0" in client


def test_workspace_status_matrix_and_accessibility_contract_are_explicit():
    state = _text(STATE)
    markup = _mihomo_markup()
    css = _text(CSS)

    for status in (
        "loading",
        "ready",
        "controller_missing",
        "not_configured",
        "blocked",
        "core_stopped",
        "unauthorized",
        "paused",
        "error",
    ):
        assert f"{status}:" in state
    for fragment in (
        'role="status" aria-live="polite" aria-atomic="true"',
        'role="tabpanel"',
        'aria-disabled',
        'aria-busy',
        '.xk-mihomo-runtime-panel[hidden]',
        '.xk-mihomo-config-subview[hidden]',
        'prefers-reduced-motion: reduce',
        '@media (max-width: 820px)',
        '@media (max-width: 480px)',
    ):
        assert fragment in markup or fragment in css or fragment in _text(FEATURE)


def test_security_warning_and_opt_in_migration_contract_are_explicit():
    markup = _mihomo_markup()
    feature = _text(FEATURE)
    client = _text(CLIENT)
    css = _text(CSS)

    for fragment in (
        'id="mihomo-clash-security-warning"',
        'id="mihomo-clash-assistant-title"',
        'id="mihomo-clash-assistant-value"',
        'id="mihomo-clash-assistant-button"',
        'Настроить автоматически',
        'data-mihomo-clash-action="migration-preview"',
        'id="mihomo-clash-migration-preview"',
        'id="mihomo-clash-migration-restart"',
        'data-mihomo-clash-action="migration-apply"',
        "payload?.security?.migration_required",
        "payload?.security?.setup_required",
        "external-controller-unix: ./mihomo-api.sock",
        "restart.checked = nextAssistantKind === 'setup'",
        "previewMihomoClashMigration",
        "applyMihomoClashMigration",
        "confirmed: true",
        ".xk-mihomo-security-warning[hidden]",
    ):
        assert fragment in markup or fragment in feature or fragment in client or fragment in css

    assert "window.confirm(" in feature


def test_groups_ui_has_compact_filter_select_and_bounded_delay_contract():
    markup = _mihomo_markup()
    client = _text(CLIENT)
    groups = _text(GROUPS)
    css = _text(CSS)

    for fragment in (
            'id="mihomo-clash-groups-filter"',
            'id="mihomo-clash-show-hidden"',
            'class="dt-switch xk-mihomo-groups-hidden-toggle"',
            'dt-switch-slider',
            'data-mihomo-delay-visible',
            "fetchMihomoClashGroups",
        "selectMihomoClashProxy",
        "testMihomoClashDelay",
        "MAX_DELAY_CONCURRENCY = 3",
        "MAX_BUSY_RETRIES = 4",
        "MAX_DELAY_BATCH_ITEMS = 24",
        "DELAY_BATCH_CADENCE_MS = 180",
        "provider-proxy",
        "groupNodeQueue",
        "is-pending",
        "selection = { group, node }",
        ".xk-mihomo-node-row.is-current",
        "background: var(--op-accent-soft);",
    ):
        assert fragment in markup or fragment in client or fragment in groups or fragment in css

    assert "optimistic" not in groups.lower()
    assert "encodeURIComponent" in client


def test_groups_start_collapsed_and_keep_labelled_actions_on_one_baseline():
    markup = _mihomo_markup()
    groups = _text(GROUPS)
    css = _text(CSS)

    assert "for (const group of groups()) collapsedGroups.add(group.name);" in groups
    assert 'id="mihomo-clash-groups-collapse"' in markup
    assert ".xk-mihomo-groups-collapse" in css
    assert "display: inline-flex !important;" in css
    assert "> span:not(.xk-action-icon)" in css


def test_groups_toolbar_has_no_manual_refresh_action():
    markup = _mihomo_markup()
    groups = _text(GROUPS)

    assert 'data-mihomo-groups-refresh' not in markup
    assert 'data-mihomo-groups-refresh' not in groups


def test_runtime_status_strip_avoids_redundant_branding_and_ready_state_retry():
    markup = _mihomo_markup()
    index = _text(FEATURE.parent / "index.js")

    assert 'id="mihomo-clash-status-retry"' not in markup
    assert 'id="mihomo-clash-status-label" class="xk-mihomo-status-label" data-mihomo-clash-action="retry"' in markup
    assert 'Mihomo ${version}' not in index
    assert "version || 'Версия —'" in index
    assert "is-retry-suggested" in index


def test_expanded_group_uses_dense_node_grid_without_duplicate_state_column():
    markup = _mihomo_markup()
    groups = _text(GROUPS)
    css = _text(CSS)

    assert 'class="xk-mihomo-node-head"' not in groups
    assert 'class="xk-mihomo-node-alive"' not in groups
    assert 'title="${escapeHtml(node.name)}"' not in groups
    assert 'title="${escapeHtml(meta)}"' not in groups
    assert 'xk-mihomo-group-current' not in groups
    assert 'xk-mihomo-node-marker' not in groups
    assert 'class="xk-mihomo-node-probe' in groups
    assert "iconHtml('server-off')" in groups
    assert 'data-tooltip="Проверить задержку"' not in groups
    assert 'data-tooltip-silent="1"' in groups
    assert "${collapsed ? '' : `<button type=\"button\" class=\"btn-secondary xk-mihomo-group-test\"" in groups
    assert 'setMessage(' not in groups
    assert 'mihomo-clash-groups-message' not in markup
    assert 'aria-label="${escapeHtml(probeLabel)}"' in groups
    assert "iconHtml('loading')" in groups
    assert "delaySucceeded ? delayTone(delay)" in groups
    assert "node.alive === false ? 'failed'" in groups
    assert "node.alive === true" in groups
    assert 'grid-template-columns: repeat(auto-fill, minmax(min(100%, 232px), 1fr));' in css
    assert 'grid-auto-rows: minmax(72px, auto);' in css
    assert 'border-radius: var(--op-control-radius);' in css
    assert 'background: var(--op-editor);' in css
    assert '.xk-mihomo-node-delay::before' not in css
    assert '.xk-mihomo-node-row.is-current::before' not in css
    assert 'background: var(--op-accent-soft);' in css
    assert 'body.panel-page .xk-mihomo-node-unavailable' in css
    assert 'body.panel-page .xk-mihomo-node-probe:focus-visible' in css
    assert 'xk-sub-pingall-spin' in css


def test_groups_lifecycle_stops_load_and_delay_work_outside_control_view():
    feature = _text(FEATURE)
    groups = _text(GROUPS)
    for fragment in (
        "activateMihomoClashGroups();",
        "deactivateMihomoClashGroups();",
        "abortLoad();",
        "cancelDelayQueue();",
        "if (!active) return false;",
    ):
        assert fragment in feature or fragment in groups


def test_connections_ui_has_live_fallback_overview_and_guarded_actions():
    markup = _mihomo_markup()
    client = _text(CLIENT)
    feature = _text(FEATURE)
    connections = _text(CONNECTIONS)
    css = _text(CSS)

    for fragment in (
        'id="mihomo-clash-connections-filter"',
        'id="mihomo-clash-connections-network"',
        'id="mihomo-clash-connections-active-tab"',
        'id="mihomo-clash-connections-closed-tab"',
        'id="mihomo-clash-closed-clear"',
        'id="mihomo-clash-disconnect-all"',
        'id="mihomo-clash-connection-inspector"',
        "requestMihomoClashWsToken",
        "scope: 'mihomo-clash'",
        "HTTP_FALLBACK_INTERVAL_MS = 2000",
        "MAX_RECONNECT_DELAY_MS = 15000",
        "PAGE_SIZE = 100",
        "MAX_CLOSED_CONNECTIONS = 300",
        "rememberClosedConnections",
        "next.truncated !== true",
        "data-mihomo-connection-sort",
        "data-mihomo-connection-filter",
        "data-mihomo-connection-copy",
        "navigator.clipboard.writeText",
        "disconnectMihomoClashConnection",
        "disconnectAllMihomoClashConnections",
        "confirmMihomoAction",
        'title="Завершить соединение"',
        "activateMihomoClashConnections",
        "deactivateMihomoClashConnections",
        '.xk-mihomo-connections-table',
        'class="xk-mihomo-device-name"',
        '.xk-mihomo-connection-close:hover:not(:disabled)',
        'background: var(--op-danger-soft) !important;',
        'content: attr(data-label);',
    ):
        assert fragment in markup or fragment in client or fragment in feature or fragment in connections or fragment in css

    assert "snapshot.connections =" not in connections
    assert "Строка исчезнет после подтверждённого snapshot" in connections


def test_connections_lifecycle_stops_socket_polling_and_requests_when_hidden():
    feature = _text(FEATURE)
    connections = _text(CONNECTIONS)
    for fragment in (
        "deactivateMihomoClashConnections();",
        "clearScheduled(); abortRequest(); closeSocket();",
        "if (!active || runGeneration !== generation)",
        "document.addEventListener('visibilitychange'",
    ):
        assert fragment in feature or fragment in connections


def test_rules_providers_and_logs_have_bounded_on_demand_contract():
    markup = _mihomo_markup()
    client = _text(CLIENT)
    feature = _text(FEATURE)
    rules = _text(RULES)
    logs = _text(LOGS)
    state = _text(STATE)
    css = _text(CSS)

    for fragment in (
        'id="mihomo-clash-panel-rules"',
        'id="mihomo-clash-rules-filter"',
        'id="mihomo-clash-provider-kind"',
        'id="mihomo-clash-tab-logs"',
        'data-mihomo-clash-subview="logs"',
        'id="mihomo-clash-panel-logs"',
        'id="mihomo-clash-logs"',
        "fetchMihomoClashRules",
        "fetchMihomoClashProviders",
        "updateMihomoClashProvider",
        "healthcheckMihomoClashProvider",
        "invalidateMihomoClashGroups",
        "mihomoClashLogsWsUrl",
        "MAX_RULE_ROWS = 300",
        "MAX_LOG_ROWS = 500",
        "annotatedLogText",
        "row?.devices",
        "requestMihomoClashWsToken",
        "scope: 'mihomo-clash-logs'",
        "deactivateMihomoClashRules();",
        "deactivateMihomoClashLogs();",
        ".xk-mihomo-rules-layout",
        ".xk-mihomo-logs-workspace",
        ".xk-mihomo-device-name",
    ):
        assert fragment in markup or fragment in client or fragment in feature or fragment in rules or fragment in logs or fragment in css

    assert "if (value === 'rules') return 'control';" not in state
    assert "if (value === 'logs') return 'control';" not in state
    assert 'id="mihomo-clash-logs-open"' not in markup
    assert 'id="mihomo-clash-logs-drawer"' not in markup
    assert 'aria-disabled="true" title="Просмотр правил' not in markup
    assert "PATCH /rules" not in client
    assert "PATCH /configs" not in client


def test_connection_inspector_cross_links_to_rules_without_persistent_mutation():
    markup = _mihomo_markup()
    connections = _text(CONNECTIONS)
    feature = _text(FEATURE)

    assert 'id="mihomo-clash-connection-rule-link"' in markup
    assert "xkeen:mihomo-clash-open-rule" in connections
    assert "focusMihomoClashRule" in feature

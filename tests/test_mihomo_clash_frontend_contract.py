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
    for subview in ("control", "connections", "rules", "config"):
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
        'aria-disabled="true"',
        'aria-busy',
        '.xk-mihomo-runtime-panel[hidden]',
        '.xk-mihomo-config-subview[hidden]',
        'prefers-reduced-motion: reduce',
        '@media (max-width: 820px)',
        '@media (max-width: 480px)',
    ):
        assert fragment in markup or fragment in css or fragment in _text(FEATURE)


def test_groups_ui_has_compact_filter_select_and_bounded_delay_contract():
    markup = _mihomo_markup()
    client = _text(CLIENT)
    groups = _text(GROUPS)
    css = _text(CSS)

    for fragment in (
        'id="mihomo-clash-groups-filter"',
        'id="mihomo-clash-show-hidden"',
        'data-mihomo-delay-visible',
        'data-mihomo-delay-cancel',
        "fetchMihomoClashGroups",
        "selectMihomoClashProxy",
        "testMihomoClashDelay",
        "MAX_DELAY_CONCURRENCY = 3",
        "MAX_BUSY_RETRIES = 20",
        "provider-proxy",
        "cancelDelayQueue",
        "selection = { group, node }",
        ".xk-mihomo-node-row.is-current::before",
    ):
        assert fragment in markup or fragment in client or fragment in groups or fragment in css

    assert "optimistic" not in groups.lower()
    assert "encodeURIComponent" in client


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

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]


def _run_node_json(script: str) -> object:
    if shutil.which("node") is None:
        pytest.skip("node is not available in this environment")

    result = subprocess.run(
        ["node", "--input-type=module"],
        input=script,
        capture_output=True,
        cwd=str(ROOT),
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )

    assert result.returncode == 0, result.stdout + result.stderr
    return json.loads(result.stdout.strip())


def test_mobile_whitelist_scenario_adds_managed_rules_and_balancer():
    payload = _run_node_json(
        """
import {
  ROUTING_SCENARIO_MOBILE_WHITELIST,
  applyRoutingScenarioText,
  detectRoutingScenarioFromText,
} from './xkeen-ui/static/js/ui/routing_scenarios.js';

const source = JSON.stringify({
  routing: {
    domainStrategy: 'IPIfNonMatch',
    rules: [
      { type: 'field', ruleTag: 'manual_blocked', outboundTag: 'proxy', domain: ['ext:geosite_v2fly.dat:youtube'] },
      { type: 'field', ruleTag: 'manual_match', outboundTag: 'direct' },
    ],
    balancers: [
      { tag: 'proxy', selector: ['my_proxy', 'reserve_proxy'], strategy: { type: 'leastPing' }, fallbackTag: 'direct' },
    ],
  },
}, null, 2);

const result = applyRoutingScenarioText(source, ROUTING_SCENARIO_MOBILE_WHITELIST);
const parsed = JSON.parse(result.text);
console.log(JSON.stringify({
  mode: detectRoutingScenarioFromText(result.text),
  firstRule: parsed.routing.rules[0],
  blockedDomains: parsed.routing.rules.find((rule) => rule.ruleTag === 'xk_scenario_mobile_whitelist_blocked_domains_main'),
  fallbackMain: parsed.routing.rules.find((rule) => rule.ruleTag === 'xk_scenario_mobile_whitelist_fallback_from_main'),
  fallbackReserve: parsed.routing.rules.find((rule) => rule.ruleTag === 'xk_scenario_mobile_whitelist_fallback_from_reserve'),
  manualRuleIndex: parsed.routing.rules.findIndex((rule) => rule.ruleTag === 'manual_blocked'),
  defaultDirectIndex: parsed.routing.rules.findIndex((rule) => rule.ruleTag === 'xk_scenario_mobile_whitelist_default_direct'),
  firstBalancer: parsed.routing.balancers[0],
  secondBalancer: parsed.routing.balancers[1],
  thirdBalancer: parsed.routing.balancers[2],
}));
"""
    )

    assert payload["mode"] == "mobile-whitelist"
    assert payload["firstRule"]["ruleTag"] == "xk_scenario_mobile_whitelist_direct_private"
    assert payload["blockedDomains"]["balancerTag"] == "balancer_main"
    assert payload["fallbackMain"]["inboundTag"] == ["from_balancer_main"]
    assert payload["fallbackMain"]["balancerTag"] == "balancer_reserv"
    assert payload["fallbackReserve"]["inboundTag"] == ["from_balancer_reserv"]
    assert payload["fallbackReserve"]["balancerTag"] == "balancer_white_list"
    assert payload["manualRuleIndex"] > 0
    assert payload["defaultDirectIndex"] > payload["manualRuleIndex"]
    assert payload["firstBalancer"]["tag"] == "balancer_main"
    assert payload["firstBalancer"]["selector"] == ["my_proxy"]
    assert payload["firstBalancer"]["fallbackTag"] == "loopback_to_reserv"
    assert payload["secondBalancer"]["tag"] == "balancer_reserv"
    assert payload["secondBalancer"]["selector"] == ["reserve_proxy"]
    assert payload["secondBalancer"]["fallbackTag"] == "loopback_to_white"
    assert payload["thirdBalancer"]["tag"] == "balancer_white_list"
    assert payload["thirdBalancer"]["selector"] == ["white_list"]


def test_mobile_whitelist_preflight_reports_pool_and_subscription_risks():
    payload = _run_node_json(
        """
import {
  analyzeRoutingScenarioPreflight,
  formatRoutingScenarioPreflightMessage,
} from './xkeen-ui/static/js/ui/routing_scenarios.js';

const ready = analyzeRoutingScenarioPreflight({
  outboundTags: ['direct', 'my_proxy--A', 'reserve_proxy--A', 'white_list--A', 'white_list--B', 'loopback_to_reserv', 'loopback_to_white'],
  subscriptions: [
    { id: 'white_list', tag: 'white_list', routing_auto_rule: false, last_tags: ['white_list--A'] },
  ],
});
const risky = analyzeRoutingScenarioPreflight({
  outboundTags: ['my_proxy--A', 'reserve_proxy--A', 'white_list--A', 'loopback_to_reserv', 'loopback_to_white'],
  subscriptions: [
    { id: 'white_list', tag: 'white_list', routing_auto_rule: true, last_tags: ['white_list--A'] },
  ],
});
const missing = analyzeRoutingScenarioPreflight({
  outboundTags: ['direct', 'main_vps'],
  subscriptions: [],
});

console.log(JSON.stringify({
  ready,
  readyMessage: formatRoutingScenarioPreflightMessage(ready),
  risky,
  riskyMessage: formatRoutingScenarioPreflightMessage(risky),
  missing,
  missingMessage: formatRoutingScenarioPreflightMessage(missing),
}));
"""
    )

    assert payload["ready"]["outboundCount"] == 2
    assert payload["ready"]["autoRuleSubscriptions"] == []
    assert payload["readyMessage"]["tone"] == "success"
    assert "Цепочка найдена" in payload["readyMessage"]["message"]
    assert "white_list=2" in payload["readyMessage"]["message"]
    assert "Авто-routing подписки выключен." in payload["readyMessage"]["message"]

    assert payload["risky"]["outboundCount"] == 1
    assert payload["risky"]["autoRuleSubscriptions"][0]["tag"] == "white_list"
    assert payload["riskyMessage"]["tone"] == "warning"
    assert "авто-правило routing" in payload["riskyMessage"]["message"]

    assert payload["missing"]["outboundCount"] == 0
    assert payload["missingMessage"]["tone"] == "error"
    assert "В цепочке не найдены" in payload["missingMessage"]["message"]


def test_normal_scenario_removes_only_managed_mobile_whitelist_block():
    payload = _run_node_json(
        """
import {
  ROUTING_SCENARIO_MOBILE_WHITELIST,
  ROUTING_SCENARIO_NORMAL,
  applyRoutingScenarioText,
  detectRoutingScenarioFromText,
} from './xkeen-ui/static/js/ui/routing_scenarios.js';

const source = JSON.stringify({
  routing: {
    rules: [
      { type: 'field', ruleTag: 'manual_ru', outboundTag: 'direct', domain: ['ext:geosite_v2fly.dat:category-ru'] },
    ],
    balancers: [
      { tag: 'proxy', selector: ['my_proxy'], strategy: { type: 'leastPing' }, fallbackTag: 'direct' },
    ],
  },
}, null, 2);

const mobile = applyRoutingScenarioText(source, ROUTING_SCENARIO_MOBILE_WHITELIST);
const normal = applyRoutingScenarioText(mobile.text, ROUTING_SCENARIO_NORMAL);
const parsed = JSON.parse(normal.text);
console.log(JSON.stringify({
  mode: detectRoutingScenarioFromText(normal.text),
  rules: parsed.routing.rules,
  balancers: parsed.routing.balancers,
}));
"""
    )

    assert payload["mode"] == "normal"
    assert [rule["ruleTag"] for rule in payload["rules"]] == ["manual_ru"]
    assert [balancer["tag"] for balancer in payload["balancers"]] == ["proxy"]


def test_routing_scenario_switcher_is_wired_into_panel():
    template = (ROOT / "xkeen-ui/templates/panel.html").read_text(encoding="utf-8")
    routing_src = (ROOT / "xkeen-ui/static/js/features/routing.js").read_text(encoding="utf-8")
    settings_src = (ROOT / "xkeen-ui/static/js/ui/settings.js").read_text(encoding="utf-8")
    settings_panel_src = (ROOT / "xkeen-ui/static/js/ui/settings_panel.js").read_text(encoding="utf-8")
    styles = (ROOT / "xkeen-ui/static/styles.css").read_text(encoding="utf-8")

    assert 'id="routing-scenario-normal"' in template
    assert 'id="routing-scenario-mobile"' in template
    assert 'id="routing-scenario-apply-btn"' in template
    assert 'id="routing-scenario-arrow"' in template
    assert "routing-scenario-help-popover" in template
    assert "Как это работает" in template
    assert "reserve_proxy--..." in template
    assert "white_list--..." in template
    assert 'aria-controls="routing-scenario-body"' in template
    assert 'id="routing-scenario-body" style="display:none;"' in template
    assert "routing-side-card--scenario" in template

    assert "applyRoutingScenarioText" in routing_src
    assert "function wireRoutingScenarioSwitcher()" in routing_src
    assert "function wireRoutingScenarioCollapse()" in routing_src
    assert "function loadRoutingScenarioPreflight(options)" in routing_src
    assert "'/api/xray/outbound-tags?all=1'" in routing_src
    assert "'/api/xray/subscriptions'" in routing_src
    assert "formatRoutingScenarioPreflightMessage(preflight)" in routing_src
    assert "xk.routing.scenario.open.v1" in routing_src
    assert "ROUTING_SCENARIO_MAIN_BALANCER_TAG" in routing_src
    assert "ROUTING_SCENARIO_RESERVE_BALANCER_TAG" in routing_src
    assert "ROUTING_SCENARIO_WHITE_LIST_BALANCER_TAG" in routing_src
    assert "xkeen:routing-editor-content" in routing_src
    assert "function applyRoutingScenarioCardSetting(settingsSnapshot)" in routing_src
    assert "xk.routing.scenario.visibility.fix.v1" in routing_src
    assert "let _routingScenarioSettingVisible = null;" in routing_src
    assert "const firstKnownVisibleSetting = _routingScenarioSettingVisible === null && settingVisible === true;" in routing_src
    assert "const becameVisibleBySetting = _routingScenarioSettingVisible === false && settingVisible === true;" in routing_src
    assert "_storeGet(ROUTING_SCENARIO_OPEN_KEY) === '0'" in routing_src
    assert "_storeGet(ROUTING_SCENARIO_VISIBILITY_FIX_KEY) !== '1'" in routing_src
    assert "setRoutingScenarioCardOpen(true);" in routing_src
    assert "_storeSet(ROUTING_SCENARIO_OPEN_KEY, '1');" in routing_src
    assert "_storeSet(ROUTING_SCENARIO_VISIBILITY_FIX_KEY, '1');" in routing_src
    assert "card.dataset.xkUiSettingVisible = settingVisible ? '1' : '0';" in routing_src
    assert "try { delete card.dataset.xkPrevDisplay; } catch (e0) {}" in routing_src
    assert "document.addEventListener('xkeen:ui-settings-changed'" in routing_src
    assert "try { applyRoutingScenarioCardSetting(); } catch (e) {}" in routing_src
    assert "routing.showScenarioCard" in settings_panel_src
    assert "Показывать карточку «Сценарий маршрутизации»" in settings_panel_src
    assert "showScenarioCard: true" in settings_src

    assert "body.panel-page .routing-side-card--scenario" in styles
    assert "body.panel-page .routing-side-card--scenario .commands-header h2" in styles
    assert "body.panel-page .routing-scenario-help-row" in styles
    assert "body.panel-page .routing-scenario-help-panel ul" in styles
    assert ".routing-scenario-status.is-success" in styles


def test_routing_dat_card_uses_shared_sidebar_collapse_style():
    template = (ROOT / "xkeen-ui/templates/panel.html").read_text(encoding="utf-8")
    styles = (ROOT / "xkeen-ui/static/styles.css").read_text(encoding="utf-8")

    assert 'class="card routing-dat-card routing-side-card"' in template
    assert 'id="routing-dat-arrow"' in template
    assert "body.panel-page .routing-side-card .commands-header h2" in styles
    assert "body.panel-page .routing-side-card .commands-header > span:last-child" in styles

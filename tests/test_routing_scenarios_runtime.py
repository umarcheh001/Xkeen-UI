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
      { tag: 'proxy', selector: ['my_proxy', 'vni_hosting'], strategy: { type: 'leastPing' }, fallbackTag: 'direct' },
    ],
  },
}, null, 2);

const result = applyRoutingScenarioText(source, ROUTING_SCENARIO_MOBILE_WHITELIST);
const parsed = JSON.parse(result.text);
console.log(JSON.stringify({
  mode: detectRoutingScenarioFromText(result.text),
  firstRule: parsed.routing.rules[0],
  catchAll: parsed.routing.rules.find((rule) => rule.ruleTag === 'xk_scenario_mobile_whitelist_catch_all'),
  manualRuleIndex: parsed.routing.rules.findIndex((rule) => rule.ruleTag === 'manual_blocked'),
  firstBalancer: parsed.routing.balancers[0],
}));
"""
    )

    assert payload["mode"] == "mobile-whitelist"
    assert payload["firstRule"]["ruleTag"] == "xk_scenario_mobile_whitelist_direct_private"
    assert payload["catchAll"]["balancerTag"] == "xk_mobile_whitelist"
    assert payload["catchAll"]["network"] == "tcp,udp"
    assert payload["manualRuleIndex"] > 0
    assert payload["firstBalancer"]["tag"] == "xk_mobile_whitelist"
    assert payload["firstBalancer"]["selector"] == ["white_list"]
    assert payload["firstBalancer"]["fallbackTag"] == "block"


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
    styles = (ROOT / "xkeen-ui/static/styles.css").read_text(encoding="utf-8")

    assert 'id="routing-scenario-normal"' in template
    assert 'id="routing-scenario-mobile"' in template
    assert 'id="routing-scenario-apply-btn"' in template
    assert 'id="routing-scenario-arrow"' in template
    assert 'aria-controls="routing-scenario-body"' in template
    assert 'id="routing-scenario-body" style="display:none;"' in template
    assert "routing-side-card--scenario" in template

    assert "applyRoutingScenarioText" in routing_src
    assert "function wireRoutingScenarioSwitcher()" in routing_src
    assert "function wireRoutingScenarioCollapse()" in routing_src
    assert "xk.routing.scenario.open.v1" in routing_src
    assert "ROUTING_SCENARIO_MOBILE_BALANCER_TAG" in routing_src
    assert "xkeen:routing-editor-content" in routing_src

    assert "body.panel-page .routing-side-card--scenario" in styles
    assert "body.panel-page .routing-side-card--scenario .commands-header h2" in styles
    assert ".routing-scenario-status.is-success" in styles

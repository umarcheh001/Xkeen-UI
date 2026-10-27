from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]


def run_model(code: str):
    if not shutil.which("node"):
        pytest.skip("node is unavailable")
    result = subprocess.run(
        ["node", "--input-type=module"],
        input=(
            "import * as model from './xkeen-ui/static/js/features/resource_monitor_model.js';\n"
            "const { metricNumber, nearestPointIndex, resourceHealth, buildResourceSnapshot, selectClients } = model;\n"
            + code
        ),
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=False,
    )
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def test_absent_metrics_never_turn_into_zero():
    assert run_model(
        "console.log(JSON.stringify([null, undefined, '', false, 'oops', -1, Infinity, 0, '0', 12.5].map(metricNumber)));"
    ) == [None, None, None, None, None, None, None, 0, 0, 12.5]


def test_the_browser_side_history_helpers_are_gone():
    # the history lives on the router now (GET /api/system/history); nothing keeps a copy in the tab
    assert run_model(
        "console.log(JSON.stringify(['selectHistory', 'historyGaps', 'gapAtTime', 'collectionGap'].map(name => name in model)));"
    ) == [False, False, False, False]


def test_nearest_point_still_finds_the_closest_timestamp():
    assert run_model("""
const points = [0, 5, 15, 300, 330, 600].map(at => ({at}));
console.log(JSON.stringify([0, 301, 580].map(at => nearestPointIndex(points, at))));
""") == [0, 3, 5]


def test_health_uses_connection_and_conntrack_and_preserves_unknown_state():
    result = run_model("""
const normal = {
  cpu: {percent: 5}, memory: {percent: 45},
  router: {internet: {available: true, internet: true, gateway: true, dns: true, captive: true}},
};
console.log(JSON.stringify({
  normal: resourceHealth(normal),
  missing: resourceHealth({cpu: {percent: 1}, memory: {percent: 1}}),
  stale: resourceHealth({...normal, router: {...normal.router, freshness: {state: 'stale'}}}),
  conntrack: resourceHealth({...normal, router: {...normal.router, conntrack: {available: true, percent: 96}}}),
  captive: resourceHealth({...normal, router: {internet: {...normal.router.internet, captive: false}}}),
  dns: resourceHealth(normal, {state: 'error'}),
}));
""")
    assert result["normal"]["tone"] == "normal"
    assert result["missing"]["tone"] == "unknown"
    assert result["stale"]["tone"] == "unknown"
    assert result["conntrack"]["tone"] == "danger"
    assert "Conntrack" in result["conntrack"]["note"]
    assert "авторизация" in result["captive"]["note"]
    assert result["dns"]["title"] == "Проблема с зашифрованным DNS"


def test_snapshot_has_explicit_allowlist_and_the_new_history_columns():
    result = run_model("""
const summary = {
  ts: 600, uptime_s: 90, secret: 'TOKEN',
  cards: {
    cpu: {value: 19, zone: 0, text: 'PRIVATE text'},
    memory: {value: 47, programs_bytes: 5, cache_bytes: 3, free_bytes: 2, total_bytes: 10},
    link: {up_percent: 2, down_percent: 6, up_mbps: 1.1, down_mbps: 5.8, label: 'PRIVATE provider'},
  },
  router: {internet: {address: '192.0.2.1'}, clients: [{mac: 'secret'}]},
};
const hardware = {
  cores: 3, identity: {model: 'PRIVATE model'},
  temperatures: [{id: 'cpu', label: 'PRIVATE label', value_c: 54, sensors: [{name: 'x', value_c: 1}]}],
  storage: {percent: 18, path: '/secret/path', total_bytes: 8},
  conntrack: {count: 3, max: 9, percent: 33, address: '192.0.2.9'},
  ports: [{label: 'WAN', description: 'PRIVATE provider'}],
};
const history = {
  start: 0, step_s: 60,
  metrics: {
    cpu: {avg: [1, null], max: [2, null]},
    'link_up:PrivateIface': {avg: [3], max: [4]},
    'rate_down:PrivateIface': {avg: [5], max: [6]},
  },
  links: [{id: 'PrivateIface', label: 'PRIVATE provider', primary: true, tariff: {up_mbps: 50, down_mbps: 100}}],
};
console.log(JSON.stringify(buildResourceSnapshot(summary, hardware, history, '1h', true)));
""")
    text = json.dumps(result)
    for private in ["TOKEN", "PRIVATE", "/secret/path", "192.0.2.", "PrivateIface", "router", "secret", "mac"]:
        assert private not in text
    assert result["schema_version"] == 2 and result["range"] == "1h" and result["stale"] is True
    assert result["now"]["cpu_percent"] == 19
    assert result["now"]["link"]["down_mbps"] == 5.8
    assert result["hardware"]["storage"]["percent"] == 18
    assert result["hardware"]["temperatures"] == [{"id": "cpu", "value_c": 54}]
    assert result["history"]["cpu"] == {"avg": [1, None], "max": [2, None]}
    link = result["history"]["links"][0]
    assert link["primary"] is True and link["tariff"] == {"up_mbps": 50, "down_mbps": 100}
    assert link["up_percent"]["avg"] == [3] and link["down_mbps"]["max"] == [6]


def test_clients_toggle_uses_cached_full_list_and_keeps_top_five_limit():
    result = run_model("""
const items = Array.from({length: 12}, (_, index) => ({name: `client-${index}`}));
const payload = {items, top: items.slice(0, 5)};
console.log(JSON.stringify({
  top: selectClients(payload, false).length,
  all: selectClients(payload, true).length,
  absent: selectClients(null, true),
  bounded: selectClients({items: Array(120).fill({})}, true).length,
}));
""")
    assert result == {"top": 5, "all": 12, "absent": [], "bounded": 100}

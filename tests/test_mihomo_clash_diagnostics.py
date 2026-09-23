from __future__ import annotations

import pytest

from services.mihomo_clash_diagnostics import (
    build_trace_result,
    normalize_trace_domain,
)


def test_trace_domain_normalizes_url_without_accepting_paths():
    assert normalize_trace_domain("https://GitHub.com/openai") == "github.com"
    assert normalize_trace_domain("example.test:443") == "example.test"


@pytest.mark.parametrize("value", ["", "http://", "bad host", "-bad.test", "bad-.test"])
def test_trace_domain_rejects_invalid_values(value):
    with pytest.raises(ValueError):
        normalize_trace_domain(value)


def test_trace_matches_domain_suffix_and_resolves_proxy_chain():
    result = build_trace_result(
        domain="api.github.com",
        dns_payload={"Answer": [{"type": 1, "data": "140.82.121.5"}]},
        rules_payload={
            "rules": [
                {"type": "Domain", "payload": "example.test", "proxy": "DIRECT"},
                {"type": "DomainSuffix", "payload": "github.com", "proxy": "AUTO"},
                {"type": "Match", "payload": "", "proxy": "DIRECT"},
            ]
        },
        proxies_payload={
            "proxies": {
                "AUTO": {"type": "Selector", "now": "node-a", "all": ["node-a"]},
                "node-a": {"type": "VLESS"},
            }
        },
    )

    assert result["ok"] is True
    assert result["matched_rule"]["type"] == "DOMAIN-SUFFIX"
    assert result["route"]["chain"] == ["AUTO", "node-a"]
    assert result["route"]["leaf_type"] == "VLESS"
    assert [step["result"] for step in result["steps"]] == ["skip", "match"]


def test_trace_marks_ruleset_as_unknown_instead_of_guessing():
    result = build_trace_result(
        domain="example.test",
        dns_payload={"Answer": [{"data": "192.0.2.10"}]},
        rules_payload={
            "rules": [
                {"type": "RuleSet", "payload": "custom", "proxy": "AUTO"},
                {"type": "Match", "payload": "", "proxy": "DIRECT"},
            ]
        },
        proxies_payload={"proxies": {"DIRECT": {"type": "Direct"}}},
    )

    assert result["matched_rule"]["type"] == "RULE-SET"
    assert result["matched_rule"]["result"] == "unknown"
    assert result["steps"][0]["result"] == "unknown"
    assert result["route"]["policy"] == "AUTO"
    assert result["route"]["chain"] == []


def test_trace_evaluates_rulesets_and_composite_or_with_configured_matcher():
    outcomes = {
        "adlist@domain": ("skip", "Rule-provider «adlist@domain»: совпадений нет."),
        "quic@inline": ("skip", "Rule-provider «quic@inline»: тип соединения не совпал."),
        "github@domain": ("match", "Rule-provider «github@domain»: домен найден."),
        "google@domain": ("match", "Rule-provider «google@domain»: домен найден."),
        "google@ipcidr": ("skip", "Rule-provider «google@ipcidr»: IP отсутствует."),
    }

    def matcher(name, _domain, _addresses):
        return outcomes[name]

    proxies = {
        "proxies": {
            "GitHub": {"type": "Selector", "now": "PASS"},
            "Google": {"type": "Selector", "now": "PASS"},
            "PASS": {"type": "Pass"},
        }
    }
    github = build_trace_result(
        domain="github.com",
        dns_payload={"Answer": [{"data": "140.82.121.4"}]},
        rules_payload={
            "rules": [
                {"type": "RuleSet", "payload": "adlist@domain", "proxy": "REJECT"},
                {"type": "RuleSet", "payload": "quic@inline", "proxy": "REJECT"},
                {"type": "RuleSet", "payload": "github@domain", "proxy": "GitHub"},
            ]
        },
        proxies_payload=proxies,
        rule_set_matcher=matcher,
    )
    google = build_trace_result(
        domain="google.com",
        dns_payload={"Answer": [{"data": "142.251.142.206"}]},
        rules_payload={
            "rules": [
                {
                    "type": "OR",
                    "payload": "((RuleSet,google@domain) || (RuleSet,google@ipcidr))",
                    "proxy": "Google",
                }
            ]
        },
        proxies_payload=proxies,
        rule_set_matcher=matcher,
    )

    assert [step["result"] for step in github["steps"]] == ["skip", "skip", "match"]
    assert github["route"]["chain"] == ["GitHub", "PASS"]
    assert google["matched_rule"]["result"] == "match"
    assert google["route"]["chain"] == ["Google", "PASS"]

"""Сохранённый выбор узлов не копится для правил, которых больше нет."""

from __future__ import annotations


def test_choice_for_a_rule_that_no_longer_exists_is_dropped():
    from services import xray_subscriptions as subs

    choices = {
        "VPS_US": {"subscription_id": "alpha", "node_key": "us-1"},
        "VPS_NL": {"subscription_id": "alpha", "node_key": "nl-1"},
        "GONE": {"subscription_id": "alpha", "node_key": "old-1"},
    }
    routing = {"rules": [{"type": "field", "ruleTag": "ai", "outboundTag": "VPS_US"}]}
    journal = {"rules": [{
        "tag": "streaming", "to_kind": "outboundTag", "target": {"outboundTag": "VPS_NL"},
    }]}

    pruned = subs._prune_route_mappings(choices, routing, journal)

    assert set(pruned) == {"VPS_US", "VPS_NL"}


def test_journal_keeps_the_choice_after_a_pause_returned_the_rule():
    """Правило на паузе снова смотрит на свой сервер: выбор обязан дождаться возобновления."""
    from services import xray_subscriptions as subs

    choices = {"VPS_US": {"subscription_id": "alpha", "node_key": "us-1"}}
    routing = {"rules": [{"type": "field", "ruleTag": "ai", "outboundTag": "VPS_US"}]}
    journal = {"rules": []}

    assert subs._prune_route_mappings(choices, routing, journal) == choices


def test_prune_ignores_empty_tags():
    from services import xray_subscriptions as subs

    routing = {"rules": [{"type": "field"}]}
    assert subs._prune_route_mappings({"": {"a": "b"}}, routing, {}) == {}

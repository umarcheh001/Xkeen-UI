"""Журнал вытеснения: возвращается ровно то, что панель убрала у владельца."""

from __future__ import annotations

import copy
import json

from services import xray_subscription_displacement as disp


POOL = "proxy"
SERVICE_RULE = "xk_auto_leastPing"


def _rules() -> list:
    return [
        {"type": "field", "domain": ["geosite:youtube"], "outboundTag": "vless-reality"},
        {"type": "field", "ruleTag": "work", "ip": ["10.0.0.0/8"], "balancerTag": "fast_web_balancer"},
        {"type": "field", "domain": ["geosite:private"], "outboundTag": "direct"},
    ]


def test_retargeted_rules_come_back_to_where_they_pointed():
    journal: dict = {}
    rules = _rules()
    original = copy.deepcopy(rules)

    assert disp.retarget_rule(journal, rules, rules[0], POOL) is True
    assert disp.retarget_rule(journal, rules, rules[1], POOL) is True

    assert rules[0]["balancerTag"] == POOL and "outboundTag" not in rules[0]
    assert rules[0]["ruleTag"].startswith(disp.RULE_STAMP_PREFIX)
    assert rules[1]["ruleTag"] == "work"

    skipped = disp.return_rules(journal, rules)

    assert skipped == []
    assert rules == original
    assert disp.is_empty(journal)


def test_the_journal_survives_json_and_a_reordered_rule_list():
    journal: dict = {}
    rules = _rules()
    original = copy.deepcopy(rules)
    disp.retarget_rule(journal, rules, rules[0], POOL)
    disp.retarget_rule(journal, rules, rules[1], POOL)

    journal = disp.normalize(json.loads(json.dumps(journal)))
    rules = json.loads(json.dumps(rules))
    rules.reverse()

    assert disp.return_rules(journal, rules) == []
    assert rules == list(reversed(original))


def test_a_rule_already_on_the_pool_is_not_journaled_twice():
    journal: dict = {}
    rules = _rules()
    disp.retarget_rule(journal, rules, rules[0], POOL)

    assert disp.retarget_rule(journal, rules, rules[0], POOL) is False
    assert len(journal["rules"]) == 1


def test_a_target_changed_by_the_owner_during_the_mode_is_the_one_that_returns():
    journal: dict = {}
    rules = _rules()
    disp.retarget_rule(journal, rules, rules[1], POOL)
    # Владелец сам перевёл правило на другой сервер; следующий проход режима
    # снова переводит его на пул.
    rules[1].pop("balancerTag")
    rules[1]["outboundTag"] = "my-new-server"
    disp.retarget_rule(journal, rules, rules[1], POOL)

    disp.return_rules(journal, rules)

    assert rules[1]["outboundTag"] == "my-new-server"
    assert "balancerTag" not in rules[1]


def test_a_rule_the_owner_removed_is_skipped_and_reported():
    journal: dict = {}
    rules = _rules()
    disp.retarget_rule(journal, rules, rules[1], POOL)
    rules.pop(1)

    skipped = disp.return_rules(journal, rules)

    assert skipped == [{"kind": "rule", "name": "work", "reason": "removed"}]
    assert disp.is_empty(journal)


def test_a_rule_the_owner_repointed_keeps_his_target_but_loses_our_stamp():
    journal: dict = {}
    rules = _rules()
    disp.retarget_rule(journal, rules, rules[0], POOL)
    stamp = rules[0]["ruleTag"]
    rules[0]["balancerTag"] = "heavy_load_balancer"

    skipped = disp.return_rules(journal, rules)

    assert skipped == [{"kind": "rule", "name": stamp, "reason": "changed"}]
    assert rules[0]["balancerTag"] == "heavy_load_balancer"
    assert "ruleTag" not in rules[0]


def test_two_rules_with_the_same_owner_tag_each_get_their_own_target_back():
    journal: dict = {}
    rules = [
        {"type": "field", "ruleTag": "dup", "domain": ["a.example"], "outboundTag": "one"},
        {"type": "field", "ruleTag": "dup", "domain": ["b.example"], "outboundTag": "two"},
    ]
    original = copy.deepcopy(rules)
    for rule in rules:
        disp.retarget_rule(journal, rules, rule, POOL)

    disp.return_rules(journal, rules)

    assert rules == original


def test_a_taken_over_catch_all_returns_in_place_of_the_service_rule():
    journal: dict = {}
    catch_all = {"type": "field", "inboundTag": ["redirect", "tproxy"], "outboundTag": "vless-reality"}
    rules = [{"type": "field", "domain": ["geosite:private"], "outboundTag": "direct"}, copy.deepcopy(catch_all)]

    assert disp.take_over_rule(journal, rules[1], 1, SERVICE_RULE) is True
    rules[1] = {"type": "field", "network": "tcp,udp", "balancerTag": POOL, "ruleTag": SERVICE_RULE}

    assert disp.return_taken_rules(journal, rules, SERVICE_RULE) == []
    assert rules[1] == catch_all
    assert len(rules) == 2


def test_the_service_rule_itself_is_never_journaled():
    journal: dict = {}
    service = {"type": "field", "balancerTag": POOL, "ruleTag": SERVICE_RULE}

    assert disp.take_over_rule(journal, service, 0, SERVICE_RULE) is False
    assert disp.is_empty(journal)


def test_a_taken_rule_returns_to_its_old_place_when_the_service_rule_is_gone():
    journal: dict = {}
    catch_all = {"type": "field", "inboundTag": ["redirect"], "outboundTag": "vless-reality"}
    disp.take_over_rule(journal, catch_all, 1, SERVICE_RULE)
    rules = [{"type": "field", "outboundTag": "direct", "domain": ["x"]}, {"type": "field", "outboundTag": "block", "domain": ["y"]}]

    disp.return_taken_rules(journal, rules, SERVICE_RULE)

    assert rules[1] == catch_all
    assert len(rules) == 3


def test_removed_balancers_and_outbounds_return_to_their_places():
    journal: dict = {}
    balancers = [{"tag": "a", "selector": ["x"]}, {"tag": POOL, "selector": ["sub--"]}, {"tag": "b", "selector": ["y"]}]
    outbounds = [{"tag": "vless-reality", "protocol": "vless"}, {"tag": "direct", "protocol": "freedom"}, {"tag": "second", "protocol": "trojan"}]
    balancers_before = copy.deepcopy(balancers)
    outbounds_before = copy.deepcopy(outbounds)

    disp.remove_balancer(journal, balancers, 2)
    disp.remove_balancer(journal, balancers, 0)
    disp.remove_outbound(journal, outbounds, 2)
    disp.remove_outbound(journal, outbounds, 0)
    assert [item["tag"] for item in balancers] == [POOL]
    assert [item["tag"] for item in outbounds] == ["direct"]
    assert disp.has_outbounds(journal)

    journal = disp.normalize(json.loads(json.dumps(journal)))
    assert disp.return_balancers(journal, balancers) == []
    assert disp.return_outbounds(journal, outbounds) == []

    assert balancers == balancers_before
    assert outbounds == outbounds_before
    assert disp.is_empty(journal)


def test_an_object_the_owner_put_back_himself_is_not_overwritten():
    journal: dict = {}
    outbounds = [{"tag": "vless-reality", "protocol": "vless", "settings": {"old": True}}, {"tag": "direct"}]
    disp.remove_outbound(journal, outbounds, 0)
    outbounds.insert(0, {"tag": "vless-reality", "protocol": "vless", "settings": {"new": True}})

    skipped = disp.return_outbounds(journal, outbounds)

    assert skipped == [{"kind": "outbound", "name": "vless-reality", "reason": "exists"}]
    assert outbounds[0]["settings"] == {"new": True}
    assert len(outbounds) == 2


def test_an_object_removed_twice_is_remembered_in_its_latest_form():
    journal: dict = {}
    outbounds = [{"tag": "mine", "v": 1}]
    disp.remove_outbound(journal, outbounds, 0)
    outbounds.append({"tag": "mine", "v": 2})
    disp.remove_outbound(journal, outbounds, 0)

    disp.return_outbounds(journal, outbounds)

    assert outbounds == [{"tag": "mine", "v": 2}]


def test_owner_selector_terms_come_back_ahead_of_what_is_there_now():
    journal: dict = {}
    balancers = [{"tag": "fast_web_balancer", "selector": ["sub--"]}]
    disp.displace_selector_terms(journal, "fast_web_balancer", ["vless-reality", "second"])
    # Дописано владельцем уже во время режима и убрано следующим проходом.
    disp.displace_selector_terms(journal, "fast_web_balancer", ["second", "third"])

    assert disp.return_selectors(journal, balancers) == []

    assert balancers[0]["selector"] == ["vless-reality", "second", "third", "sub--"]
    assert disp.is_empty(journal)


def test_a_selector_whose_balancer_is_gone_is_reported():
    journal: dict = {}
    disp.displace_selector_terms(journal, "gone", ["x"])

    assert disp.return_selectors(journal, []) == [{"kind": "selector", "name": "gone", "reason": "removed"}]


def test_observatory_subjects_and_plain_section_are_remembered_once():
    journal: dict = {}
    disp.displace_subjects(journal, ["vless-reality"])
    disp.displace_subjects(journal, ["vless-reality", "second"])
    disp.remember_plain_observatory(journal, "07_observatory.json", {"probeInterval": "60s"})
    disp.remember_plain_observatory(journal, "07_observatory.json", {"probeInterval": "1s"})

    journal = disp.normalize(json.loads(json.dumps(journal)))

    assert disp.plain_observatory(journal) == {"file": "07_observatory.json", "section": {"probeInterval": "60s"}}
    assert disp.take_subjects(journal) == ["vless-reality", "second"]
    assert disp.take_subjects(journal) == []
    disp.forget_plain_observatory(journal)
    assert disp.is_empty(journal)


def test_normalize_drops_rubbish():
    assert disp.normalize(None) == {}
    assert disp.normalize({"rules": "nope", "selectors": {"": ["x"], "t": []}, "observatory": {"subjects": []}}) == {}


def test_a_returned_rule_reads_exactly_as_the_owner_wrote_it():
    journal: dict = {}
    rules = [{"type": "field", "outboundTag": "vless-reality", "domain": ["geosite:youtube"], "ruleTag": "yt"}]
    before = json.dumps(rules)
    disp.retarget_rule(journal, rules, rules[0], POOL)
    assert list(rules[0]) == ["type", "balancerTag", "domain", "ruleTag"]

    disp.return_rules(journal, rules)

    assert json.dumps(rules) == before

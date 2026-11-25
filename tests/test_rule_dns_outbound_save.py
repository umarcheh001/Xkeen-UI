"""Проверка сохранения outbounds не должна путать группу транспортов с пропавшим выходом.

Группа транспортов распознаётся только вместе с routing: в служебном файле
tail лежит лишь loopback, а признак группы — её правило и балансировщик.
Проверка собирала runtime с пустым routing, поэтому любая DNS-привязка к
группе выглядела как ссылка на удалённый выход, и панель отказывалась
сохранять несвязанные файлы.
"""

from __future__ import annotations

import json

import pytest

from services import dns_over_vless as dov
from services import xray_transport_groups as transport_groups


def _write(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")


@pytest.fixture
def configs(tmp_path):
    group = transport_groups.tag_for("rule-out")
    configs_dir = tmp_path / "configs"
    _write(configs_dir / "05_outbounds.json", {"outbounds": [
        {"tag": "node-1", "protocol": "vless", "settings": {}},
        {"tag": "direct", "protocol": "freedom"},
    ]})
    _write(configs_dir / transport_groups.OUTBOUNDS_FILE, {"outbounds": [
        {"tag": group, "protocol": "loopback", "settings": {"inboundTag": group}},
        {"tag": transport_groups.BLOCK, "protocol": "blackhole"},
    ]})
    _write(configs_dir / "05_routing.json", {"routing": {
        "rules": [transport_groups.dispatch_rule(group)],
        "balancers": [{
            "tag": group,
            "selector": ["node-1"],
            "fallbackTag": transport_groups.BLOCK,
            "strategy": {"type": "leastLoad", "settings": {"expected": 1, "tolerance": 0.5}},
        }],
    }})
    _write(configs_dir / "06_observatory.json", {"burstObservatory": {"subjectSelector": ["node-"]}})
    return configs_dir, group


def test_a_transport_group_counts_as_a_live_outbound(configs, tmp_path):
    configs_dir, group = configs
    state_dir = tmp_path / "state"
    dov._save_state(str(state_dir), {
        "enabled": True,
        "rule_dns": [{
            "rule_tag": "ai",
            "domains": ["domain:example.com"],
            "outbound_tag": group,
            "upstream": "8.8.8.8",
        }],
    })

    # Saving an unrelated outbounds file must not be refused just because the
    # binding points at a group.
    dov.validate_rule_dns_outbound_save(
        str(configs_dir), str(state_dir), str(configs_dir / "05_outbounds.json"),
        {"outbounds": [{"tag": "node-1", "protocol": "vless", "settings": {}}]},
    )


def test_a_removed_outbound_is_still_refused(configs, tmp_path):
    configs_dir, group = configs
    state_dir = tmp_path / "state"
    dov._save_state(str(state_dir), {
        "enabled": True,
        "rule_dns": [{
            "rule_tag": "ai",
            "domains": ["domain:example.com"],
            "outbound_tag": "node-1",
            "upstream": "8.8.8.8",
        }],
    })

    with pytest.raises(dov.DnsOverVlessError):
        dov.validate_rule_dns_outbound_save(
            str(configs_dir), str(state_dir), str(configs_dir / "05_outbounds.json"),
            {"outbounds": [{"tag": "direct", "protocol": "freedom"}]},
        )

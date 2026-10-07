"""Удалить все подписки разом и вернуться к своим серверам."""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from tests.test_subscription_pause_dns import Rig


@pytest.fixture
def rig(tmp_path: Path, monkeypatch) -> Rig:
    return Rig(tmp_path, monkeypatch)


def _delete_all(rig: Rig, **extra):
    return rig.pause_mod.delete_all(
        **rig.paths, snapshot=lambda _path: None, restart_xkeen=rig._restart, **extra
    )


def _subscriptions(rig: Rig) -> list:
    return rig.bench.subs.list_subscriptions(str(rig.bench.state))


def _leftovers(rig: Rig) -> list[str]:
    in_configs = [name for name in os.listdir(rig.bench.xray) if "alpha" in name or "beta" in name]
    return sorted(in_configs + rig.bench.set_aside())


def test_delete_all_returns_configs_to_own_servers_with_one_restart(rig: Rig):
    own = rig.bench.config_files()
    rig.bench.add("alpha")
    rig.bench.add("beta")

    result = _delete_all(rig)

    assert result["ok"] is True
    assert result["deleted"] == 2
    assert result["paused"] is False
    assert rig.restarts == ["xray-subscriptions-delete-all"]
    assert _subscriptions(rig) == []
    assert rig.bench.config_files() == own
    assert [name for name in os.listdir(rig.bench.jsonc) if "alpha" in name or "beta" in name] == []
    state = rig.bench.subs.load_subscription_state(str(rig.bench.state))
    assert rig.bench.subs.MANAGED_BASELINES_KEY not in state
    assert not (rig.bench.state / rig.pause_mod.RECORD_FILENAME).exists()


def test_delete_all_from_pause_needs_no_restart(rig: Rig):
    rig.bench.add("alpha")
    rig.bench.add("beta")
    rig.pause()
    rig.restarts.clear()

    result = _delete_all(rig)

    assert result["deleted"] == 2
    assert result["restarts"] == 0
    assert rig.restarts == []
    assert _subscriptions(rig) == []
    assert _leftovers(rig) == []
    assert not (rig.bench.state / rig.pause_mod.RECORD_FILENAME).exists()


def test_delete_all_moves_dns_off_the_subscription_pool(rig: Rig):
    rig.bench.add("alpha")
    rig.dns_on("proxy")

    result = _delete_all(rig)

    assert result["dns"]["action"] == "moved"
    assert result["dns"]["to"] == ["vless-reality"]
    assert rig.dns() == {"enabled": True, "selection": ["vless-reality"]}
    assert _subscriptions(rig) == []
    assert _leftovers(rig) == []


def test_delete_all_asks_for_dns_route_before_deleting_anything(tmp_path: Path, monkeypatch):
    rig = Rig(tmp_path, monkeypatch, own=("home-nl", "home-de"))
    rig.bench.add("alpha")
    rig.dns_on("proxy")
    before = rig.bench.config_files()

    with pytest.raises(rig.pause_mod.PauseError) as caught:
        _delete_all(rig)

    assert caught.value.code == "dns_target_choice_required"
    assert [item["id"] for item in _subscriptions(rig)] == ["alpha"]
    assert rig.bench.config_files() == before
    assert rig.restarts == []

    result = _delete_all(rig, dns_target="home-nl")

    assert result["deleted"] == 1
    assert rig.dns() == {"enabled": True, "selection": ["home-nl"]}


def test_delete_all_with_nothing_to_delete_is_a_no_op(rig: Rig):
    result = _delete_all(rig)

    assert result["ok"] is True
    assert result["deleted"] == 0
    assert result["changed"] is False
    assert rig.restarts == []


def test_delete_all_tells_what_it_did_not_put_back(rig: Rig):
    rig.bench.add("alpha", routing_mode="subscription-only")
    path = rig.bench.xray / "04_outbounds.json"
    outbounds = json.loads(path.read_text(encoding="utf-8"))
    outbounds["outbounds"].insert(0, {"tag": "vless-reality", "protocol": "vless", "settings": {"mine": True}})
    path.write_text(json.dumps(outbounds, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    result = _delete_all(rig)

    assert result["deleted"] == 1
    assert {"kind": "outbound", "name": "vless-reality", "reason": "exists"} in result["skipped"]
    assert "сервер «vless-reality»" in result["warning"]


def test_delete_all_keeps_the_notice_under_its_own_name(rig: Rig):
    rig.bench.add("alpha", routing_mode="subscription-only")
    path = rig.bench.xray / "04_outbounds.json"
    outbounds = json.loads(path.read_text(encoding="utf-8"))
    outbounds["outbounds"].insert(0, {"tag": "vless-reality", "protocol": "vless", "settings": {"mine": True}})
    path.write_text(json.dumps(outbounds, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    result = _delete_all(rig)

    notice = rig.pause_mod.last_notice(str(rig.bench.state))
    assert notice["action"] == "delete_all"
    assert notice["warning"] == result["warning"]

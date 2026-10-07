"""Пауза подписок и DNS-over-VLESS: DNS не должен остаться на узлах, которых больше нет."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from tests.test_xray_subscriptions_pause import Bench, _meaning


def _own(*tags: str) -> dict:
    servers = [
        {
            "tag": tag,
            "protocol": "vless",
            "settings": {
                "vnext": [
                    {"address": f"{tag}.example.com", "port": 443, "users": [{"id": "user", "encryption": "none"}]}
                ]
            },
        }
        for tag in tags
    ]
    return {"outbounds": servers + [{"tag": "direct", "protocol": "freedom"}, {"tag": "block", "protocol": "blackhole"}]}


class Rig:
    """Стенд подписок плюс подставной роутер для DNS-over-VLESS."""

    def __init__(self, tmp_path: Path, monkeypatch, own: tuple[str, ...] = ("vless-reality",)):
        from services import dns_over_vless as dov
        from services import subscription_pause as pause

        self.dov = dov
        self.pause_mod = pause
        self.bench = Bench(tmp_path, monkeypatch, own_outbounds=_own(*own))
        (self.bench.xray / "03_inbounds.json").write_text(
            json.dumps(
                {
                    "inbounds": [
                        {"tag": "redirect", "port": 61219, "protocol": "dokodemo-door"},
                        {"tag": "tproxy", "port": 61220, "protocol": "dokodemo-door"},
                    ]
                }
            ),
            encoding="utf-8",
        )
        self.routing = self.bench.xray / "05_routing.json"
        self.restarts: list[str] = []
        self.override = False
        self.probes: list[bool] = []

        monkeypatch.setattr(dov, "jsonc_path_for", lambda path: str(self.bench.jsonc / (Path(path).name + "c")))
        monkeypatch.setattr(dov, "detect_running_core", lambda: "xray")
        monkeypatch.setattr(dov, "_dns_override_status", lambda: (self.override, "test"))
        monkeypatch.setattr(dov, "_set_dns_override", self._set_override)
        monkeypatch.setattr(dov, "_stage_and_test", lambda *_a, **_k: {"ok": True})
        monkeypatch.setattr(dov, "_wait_for_xray", lambda *_a, **_k: True)
        monkeypatch.setattr(dov, "_wait_for_port_53", lambda *_a, **_k: True)
        monkeypatch.setattr(dov, "_dns_probe", self._probe)
        monkeypatch.setattr(dov, "_xray_binary", lambda: "/opt/sbin/xray")
        monkeypatch.setattr(dov.firmware_resolvers, "discover", lambda: [])
        monkeypatch.setattr(dov.dns_client_capture, "ensure", lambda _macs: {"changed": False})
        monkeypatch.setattr(dov.dns_client_capture, "remove", lambda: False)
        monkeypatch.setattr(dov.dns_client_capture, "status", lambda: {})

    def _set_override(self, enabled: bool) -> None:
        self.override = bool(enabled)

    def _probe(self, *_a, **_k) -> dict:
        ok = self.probes.pop(0) if self.probes else True
        return {"ok": ok, "error": "" if ok else "timeout"}

    def _restart(self, source: str = "api") -> bool:
        self.restarts.append(source)
        return True

    @property
    def paths(self) -> dict:
        return {
            "ui_state_dir": str(self.bench.state),
            "xray_configs_dir": str(self.bench.xray),
            "routing_file": str(self.routing),
        }

    def dns_on(self, target) -> None:
        self.dov.apply_action(
            "enable",
            configs_dir=str(self.bench.xray),
            routing_file=str(self.routing),
            ui_state_dir=str(self.bench.state),
            restart_xkeen=self._restart,
            target_tag=target,
        )
        self.restarts.clear()

    def dns(self) -> dict:
        state = self.dov._load_state(str(self.bench.state))
        return {"enabled": bool(state.get("enabled")), "selection": self.dov._stored_selection(state)}

    def pause(self, **extra):
        return self.pause_mod.pause_all(
            **self.paths, snapshot=lambda _path: None, restart_xkeen=self._restart, **extra
        )

    def resume(self, **extra):
        return self.pause_mod.resume_all(
            **self.paths, snapshot=lambda _path: None, restart_xkeen=self._restart, **extra
        )

    def plan(self):
        return self.pause_mod.plan(**self.paths)


@pytest.fixture
def rig(tmp_path: Path, monkeypatch) -> Rig:
    return Rig(tmp_path, monkeypatch)


def test_without_dns_over_vless_pause_is_one_restart(rig: Rig):
    rig.bench.add("alpha")

    result = rig.pause()

    assert result["ok"] is True
    assert result["paused"] is True
    assert result["dns"]["action"] == "none"
    assert rig.restarts == ["xray-subscriptions-pause"]
    assert rig.bench.sub("alpha")["paused"] is True

    rig.restarts.clear()
    back = rig.resume()

    assert back["paused"] is False
    assert rig.restarts == ["xray-subscriptions-resume"]
    assert rig.bench.sub("alpha")["paused"] is False


def test_dns_on_own_server_is_left_alone(rig: Rig):
    rig.bench.add("alpha")
    rig.dns_on("vless-reality")
    assert rig.plan()["dns"]["outcome"] == "keep"

    result = rig.pause()

    assert result["dns"]["action"] == "kept"
    assert rig.restarts == ["xray-subscriptions-pause"]
    assert rig.dns() == {"enabled": True, "selection": ["vless-reality"]}


def test_dns_on_subscription_pool_moves_to_the_only_own_server_and_back(rig: Rig):
    rig.bench.add("alpha")
    rig.dns_on("proxy")
    active = rig.bench.config_files()
    plan = rig.plan()
    assert plan["dns"]["outcome"] == "retarget"
    assert plan["dns"]["to"] == {"tag": "vless-reality", "kind": "outbound"}
    assert plan["dns"]["restarts"] == 2

    result = rig.pause()

    assert result["dns"] == {
        "action": "moved",
        "from": ["proxy"],
        "to": ["vless-reality"],
        "restored": False,
    }
    assert rig.restarts == ["dns-over-vless", "dns-over-vless"]
    assert rig.dns() == {"enabled": True, "selection": ["vless-reality"]}
    assert rig.bench.sub("alpha")["paused"] is True

    rig.restarts.clear()
    assert rig.plan()["dns"]["outcome"] == "restore"
    back = rig.resume()

    assert back["dns"] == {
        "action": "moved",
        "from": ["vless-reality"],
        "to": ["proxy"],
        "restored": True,
    }
    assert rig.dns() == {"enabled": True, "selection": ["proxy"]}
    assert _meaning(rig.bench.config_files()) == _meaning(active)


def test_without_own_servers_dns_is_switched_off_and_comes_back_on_resume(tmp_path: Path, monkeypatch):
    rig = Rig(tmp_path, monkeypatch, own=())
    rig.bench.add("alpha")
    rig.dns_on("proxy")
    assert rig.plan()["dns"]["outcome"] == "disable"

    result = rig.pause()

    assert result["dns"]["action"] == "disabled"
    assert rig.dns()["enabled"] is False
    assert rig.override is False

    back = rig.resume()

    assert back["dns"]["action"] == "enabled"
    assert back["dns"]["restored"] is True
    assert rig.dns() == {"enabled": True, "selection": ["proxy"]}
    assert rig.override is True


def test_several_own_servers_ask_before_anything_is_touched(tmp_path: Path, monkeypatch):
    rig = Rig(tmp_path, monkeypatch, own=("home-nl", "home-de"))
    rig.bench.add("alpha")
    rig.dns_on("proxy")
    before = rig.bench.config_files()
    plan = rig.plan()
    assert plan["dns"]["outcome"] == "choose"
    assert [item["tag"] for item in plan["dns"]["candidates"]] == ["home-nl", "home-de"]

    with pytest.raises(rig.pause_mod.PauseError) as caught:
        rig.pause()

    assert caught.value.code == "dns_target_choice_required"
    assert [item["tag"] for item in caught.value.details["candidates"]] == ["home-nl", "home-de"]
    assert rig.restarts == []
    assert rig.bench.config_files() == before
    assert rig.bench.sub("alpha")["paused"] is False

    result = rig.pause(dns_target="home-de")

    assert result["dns"]["to"] == ["home-de"]
    assert rig.dns() == {"enabled": True, "selection": ["home-de"]}


def test_failed_dns_switch_undoes_the_pause(rig: Rig):
    rig.bench.add("alpha")
    rig.dns_on("proxy")
    active = rig.bench.config_files()
    # Новый маршрут не отвечает, прежний — отвечает.
    rig.probes = [False, True]

    with pytest.raises(rig.pause_mod.PauseError) as caught:
        rig.pause()

    assert caught.value.code == "dns_switch_failed"
    assert caught.value.details["rolled_back"] is True
    assert rig.bench.sub("alpha")["paused"] is False
    assert rig.dns() == {"enabled": True, "selection": ["proxy"]}
    assert _meaning(rig.bench.config_files()) == _meaning(active)


def test_dns_changed_by_hand_during_pause_is_not_moved_back(tmp_path: Path, monkeypatch):
    rig = Rig(tmp_path, monkeypatch, own=("home-nl", "home-de"))
    rig.bench.add("alpha")
    rig.dns_on("proxy")
    rig.pause(dns_target="home-nl")
    # Хозяин сам перевёл DNS на другой свой сервер.
    rig.dov.apply_action("disable", configs_dir=str(rig.bench.xray), routing_file=str(rig.routing),
                         ui_state_dir=str(rig.bench.state), restart_xkeen=rig._restart)
    rig.dns_on("home-de")
    assert rig.plan()["dns"]["outcome"] == "keep"

    back = rig.resume()

    assert back["dns"]["action"] == "kept"
    assert rig.dns() == {"enabled": True, "selection": ["home-de"]}
    assert rig.restarts == ["xray-subscriptions-resume"]


def test_plan_changes_nothing(rig: Rig):
    rig.bench.add("alpha")
    rig.dns_on("proxy")
    before = rig.bench.config_files()
    state_before = (rig.bench.state / "xray_subscriptions.json").read_text(encoding="utf-8")

    plan = rig.plan()

    assert plan["paused"] is False
    assert plan["total"] == 1
    assert plan["dns"]["from"] == [{"tag": "proxy", "kind": "balancer"}]
    assert rig.bench.config_files() == before
    assert (rig.bench.state / "xray_subscriptions.json").read_text(encoding="utf-8") == state_before
    assert rig.restarts == []


def test_dns_on_owners_balancer_stays_on_it_and_follows_its_members(tmp_path: Path, monkeypatch):
    """Свой балансировщик с префиксом: на паузе в нём свои серверы, без паузы — узлы подписки."""
    rig = Rig(tmp_path, monkeypatch, own=("home-nl", "home-de"))
    routing = json.loads(rig.routing.read_text(encoding="utf-8"))
    routing["routing"]["balancers"] = [
        {"tag": "my-pool", "selector": ["home-"], "strategy": {"type": "leastPing"}, "fallbackTag": "direct"}
    ]
    routing["routing"]["rules"] = [{"type": "field", "inboundTag": ["redirect", "tproxy"], "balancerTag": "my-pool"}]
    rig.routing.write_text(json.dumps(routing, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    rig.bench.add("alpha", routing_mode="subscription-only", routing_balancer_tags=["my-pool"])
    rig.dns_on("my-pool")
    active = rig.bench.config_files()
    assert rig.dov._find_managed_clone(json.loads(active["05_routing.json"]))["selector"] == ["alpha"]

    plan = rig.plan()
    assert plan["dns"]["outcome"] == "resync"
    assert plan["dns"]["from"] == [{"tag": "my-pool", "kind": "balancer"}]

    result = rig.pause()

    assert result["dns"]["action"] == "resynced"
    assert rig.dns() == {"enabled": True, "selection": ["my-pool"]}
    paused_routing = json.loads(rig.routing.read_text(encoding="utf-8"))
    assert rig.dov._find_managed_clone(paused_routing)["selector"] == ["home-"]

    back = rig.resume()

    assert back["dns"]["action"] == "resynced"
    assert rig.dns() == {"enabled": True, "selection": ["my-pool"]}
    assert _meaning(rig.bench.config_files()) == _meaning(active)


def test_owners_balancer_is_offered_first_when_dns_has_to_move(tmp_path: Path, monkeypatch):
    rig = Rig(tmp_path, monkeypatch, own=("home-nl", "home-de"))
    routing = json.loads(rig.routing.read_text(encoding="utf-8"))
    routing["routing"]["balancers"] = [
        {"tag": "my-pool", "selector": ["home-"], "strategy": {"type": "leastPing"}, "fallbackTag": "direct"}
    ]
    rig.routing.write_text(json.dumps(routing, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    rig.bench.add("alpha")
    rig.dns_on("proxy")

    plan = rig.plan()

    assert plan["dns"]["outcome"] == "choose"
    assert plan["dns"]["candidates"] == [
        {"tag": "my-pool", "kind": "balancer"},
        {"tag": "home-nl", "kind": "outbound"},
        {"tag": "home-de", "kind": "outbound"},
    ]

    result = rig.pause(dns_target="my-pool")

    assert result["dns"]["to"] == ["my-pool"]
    assert rig.dns() == {"enabled": True, "selection": ["my-pool"]}


def _put_own_server_back_by_hand(rig: Rig) -> None:
    path = rig.bench.xray / "04_outbounds.json"
    outbounds = json.loads(path.read_text(encoding="utf-8"))
    outbounds["outbounds"].insert(0, {"tag": "vless-reality", "protocol": "vless", "settings": {"mine": True}})
    path.write_text(json.dumps(outbounds, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def test_pause_tells_what_it_did_not_put_back(rig: Rig):
    rig.bench.add("alpha", routing_mode="subscription-only")
    _put_own_server_back_by_hand(rig)

    result = rig.pause()

    assert result["ok"] is True
    assert {"kind": "outbound", "name": "vless-reality", "reason": "exists"} in result["skipped"]
    assert "сервер «vless-reality»" in result["warning"]


def test_pause_with_everything_returned_has_nothing_to_tell(rig: Rig):
    rig.bench.add("alpha", routing_mode="subscription-only")

    result = rig.pause()

    assert result["skipped"] == []
    assert result["warning"] == ""


def test_what_was_not_put_back_is_kept_for_a_window_that_lost_the_answer(rig: Rig):
    rig.bench.add("alpha", routing_mode="subscription-only")
    _put_own_server_back_by_hand(rig)

    result = rig.pause()

    notice = rig.pause_mod.last_notice(str(rig.bench.state))
    assert notice["action"] == "pause"
    assert notice["warning"] == result["warning"]
    assert notice["skipped"] == result["skipped"]


def test_a_clean_switch_leaves_no_stale_notice(rig: Rig):
    rig.bench.add("alpha", routing_mode="subscription-only")
    _put_own_server_back_by_hand(rig)
    rig.pause()

    rig.resume()

    assert rig.pause_mod.last_notice(str(rig.bench.state)) == {}

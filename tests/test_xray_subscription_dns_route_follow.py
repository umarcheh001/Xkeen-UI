"""Подписка, меняя балансировщик владельца, ведёт за собой копию DNS-over-VLESS.

`xk-dns-over-vless` — слепок балансировщика на момент включения функции. Без
достройки добавленная подписка в DNS не участвовала бы, а удалённая оставляла бы
в копии узлы, которых больше нет.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from services import dns_over_vless as dns
from services import xray_subscriptions as subs

SOURCE = "mine"
SUB_ID = "newsub"


def _write(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _vless(name: str) -> str:
    return (
        "vless://user@example.com:443"
        "?type=tcp&security=reality&sni=edge.example.com&pbk=pubkey&encryption=none"
        f"#{name}"
    )


@pytest.fixture()
def stand(tmp_path: Path, monkeypatch):
    """Свой прокси, балансировщик на нём и включённый по нему DNS-over-VLESS."""
    state = tmp_path / "state"
    configs = tmp_path / "xray" / "configs"
    jsonc = tmp_path / "jsonc"
    state.mkdir()
    configs.mkdir(parents=True)
    jsonc.mkdir()

    sidecar = lambda path: str(jsonc / (Path(path).name + "c"))  # noqa: E731
    monkeypatch.setattr(subs, "jsonc_path_for", sidecar)
    monkeypatch.setattr(dns, "jsonc_path_for", sidecar)
    monkeypatch.setattr(subs, "ensure_xray_jsonc_dir", lambda: None)
    monkeypatch.setattr(subs, "fetch_subscription_body", lambda url: (_vless("Fresh node"), {}))
    monkeypatch.setenv("XKEEN_SUBSCRIPTIONS_PREFLIGHT", "0")

    _write(
        configs / "04_outbounds.json",
        {"outbounds": [{"tag": "direct", "protocol": "freedom"}, {"tag": "my_proxy_1", "protocol": "vless"}]},
    )
    routing_path = configs / "05_routing.json"
    routing = {
        "routing": {
            "rules": [],
            "balancers": [{"tag": SOURCE, "selector": ["my_proxy"], "strategy": {"type": "random"}}],
        }
    }
    target = dns._select_target(dns._collect_runtime(str(configs), routing), SOURCE, routing)
    _write(configs / dns.MANAGED_FRAGMENT, dns._managed_fragment())
    _write(routing_path, dns._build_enabled_routing(routing, target))
    _write(state / dns.STATE_FILENAME, {"enabled": True, "target": {"source": SOURCE}})
    return state, configs, routing_path


def _balancer(routing_path: Path, tag: str) -> dict:
    routing = json.loads(routing_path.read_text(encoding="utf-8"))
    return next(item for item in routing["routing"]["balancers"] if item["tag"] == tag)


def _add_subscription(state: Path, configs: Path, restarts: list) -> dict:
    subs.upsert_subscription(
        str(state),
        {
            "id": SUB_ID,
            "name": SUB_ID,
            "tag": SUB_ID,
            "url": "https://example.com/sub/new",
            "enabled": True,
            "ping_enabled": False,
            "routing_balancer_tags": [SOURCE],
        },
    )
    return subs.refresh_subscription(
        str(state),
        SUB_ID,
        xray_configs_dir=str(configs),
        restart=True,
        restart_xkeen=lambda **kwargs: restarts.append(kwargs) or True,
    )


def test_added_subscription_reaches_the_dns_route_in_one_restart(stand):
    state, configs, routing_path = stand
    assert _balancer(routing_path, dns.BALANCER_TAG)["selector"] == ["my_proxy"]
    restarts: list = []

    result = _add_subscription(state, configs, restarts)

    source = _balancer(routing_path, SOURCE)["selector"]
    assert len(source) == 2, source
    assert _balancer(routing_path, dns.BALANCER_TAG)["selector"] == source
    # Достройка идёт внутри той же операции: перезапуск один, подписочный.
    assert len(restarts) == 1
    stored = subs.list_subscriptions(str(state))[0]
    assert any("Маршрут DNS-over-VLESS обновлён" in text for text in stored["last_warnings"])
    assert result["ok"] is True


def test_deleted_subscription_leaves_the_dns_route(stand):
    state, configs, routing_path = stand
    _add_subscription(state, configs, [])
    restarts: list = []

    result = subs.delete_subscription(
        str(state),
        SUB_ID,
        xray_configs_dir=str(configs),
        restart_xkeen=lambda **kwargs: restarts.append(kwargs) or True,
    )

    assert _balancer(routing_path, SOURCE)["selector"] == ["my_proxy"]
    assert _balancer(routing_path, dns.BALANCER_TAG)["selector"] == ["my_proxy"]
    assert len(restarts) == 1
    assert "Маршрут DNS-over-VLESS обновлён" in result["warning"]


@pytest.mark.parametrize("legacy", [False, True])
def test_deleted_subscription_replaces_its_non_ip_node_in_the_same_restart(stand, legacy):
    state, configs, routing_path = stand
    _add_subscription(state, configs, [])
    runtime = dns._collect_runtime(str(configs), json.loads(routing_path.read_text(encoding="utf-8")))
    node = next(item["tag"] for item in dns._proxy_outbounds(runtime) if item["tag"].startswith(SUB_ID))
    fragment = dns._managed_fragment(["9.9.9.9"], pass_node=node, legacy_route=legacy, hosts={"local.test": "192.0.2.1"})
    _write(configs / dns.MANAGED_FRAGMENT, fragment)
    _write(state / dns.STATE_FILENAME, {
        "enabled": True, "target": {"source": SOURCE}, "original_dns_override": False,
        "pass_non_ip": True, "pass_non_ip_node": node,
        "pass_non_ip_health": {"ok": False, "node": node, "exhausted": True, "checked_at": 1},
    })
    restarts = []

    result = subs.delete_subscription(str(state), SUB_ID, xray_configs_dir=str(configs),
                                      restart_xkeen=lambda **kw: restarts.append(kw) or True)

    assert _balancer(routing_path, dns.BALANCER_TAG)["selector"] == ["my_proxy"], result["warning"]
    saved = json.loads((state / dns.STATE_FILENAME).read_text(encoding="utf-8"))
    assert saved["pass_non_ip_node"] == "my_proxy_1"
    assert saved["original_dns_override"] is False
    assert "pass_non_ip_health" not in saved
    written = json.loads((configs / dns.MANAGED_FRAGMENT).read_text(encoding="utf-8"))
    assert written == dns._managed_fragment(["9.9.9.9"], pass_node="my_proxy_1", legacy_route=legacy,
                                           hosts={"local.test": "192.0.2.1"})
    assert len(restarts) == 1


def test_route_built_from_another_balancer_is_not_touched(stand):
    state, configs, routing_path = stand
    # DNS идёт через другой балансировщик: подписка, отмеченная в `mine`, его не касается.
    routing = json.loads(routing_path.read_text(encoding="utf-8"))
    routing["routing"]["balancers"].insert(
        0, {"tag": "other", "selector": ["my_proxy"], "strategy": {"type": "random"}}
    )
    _write(routing_path, routing)
    _write(state / dns.STATE_FILENAME, {"enabled": True, "target": {"source": "other"}})

    _add_subscription(state, configs, [])

    assert _balancer(routing_path, dns.BALANCER_TAG)["selector"] == ["my_proxy"]
    stored = subs.list_subscriptions(str(state))[0]
    assert not any("DNS-over-VLESS" in text for text in stored.get("last_warnings") or [])


def test_rejected_subscription_delete_restores_the_dns_state_with_the_configuration(stand, monkeypatch):
    state, configs, routing = stand
    _add_subscription(state, configs, [])
    runtime = dns._collect_runtime(str(configs), json.loads(routing.read_text(encoding="utf-8")))
    node = next(item["tag"] for item in dns._proxy_outbounds(runtime) if item["tag"].startswith(SUB_ID))
    _write(configs / dns.MANAGED_FRAGMENT, dns._managed_fragment(pass_node=node))
    _write(state / dns.STATE_FILENAME, {"enabled": True, "target": {"source": SOURCE},
                                      "pass_non_ip": True, "pass_non_ip_node": node})
    watched = [state / dns.STATE_FILENAME, Path(subs.subscription_state_path(str(state))),
               *configs.glob("*.json")]
    before = {path: path.read_bytes() for path in watched}
    monkeypatch.setattr(subs, "_check_live_config", lambda _: {
        "ok": any(item["id"] == SUB_ID for item in subs.list_subscriptions(str(state))),
        "details": "reject deletion only",
    })

    with pytest.raises(subs.SubscriptionConfigRejected):
        subs.delete_subscription(str(state), SUB_ID, xray_configs_dir=str(configs))

    assert all(path.read_bytes() == data for path, data in before.items())


def test_a_failed_follow_is_reported_and_does_not_stop_the_subscription(stand, monkeypatch):
    state, configs, routing_path = stand

    def boom(**_kwargs):
        raise RuntimeError("disk")

    monkeypatch.setattr(dns, "follow_source_route", boom)

    result = _add_subscription(state, configs, [])

    assert result["ok"] is True
    stored = subs.list_subscriptions(str(state))[0]
    assert any("Не удалось обновить маршрут DNS-over-VLESS" in text for text in stored["last_warnings"])

"""Схемы редакторов сверены с исходниками ядер 18.09.2026.

Источники (ветки Meta и Alpha у Mihomo дают одинаковые списки):
- Mihomo: `adapter/parser.go` (ParseProxy), `adapter/outboundgroup/parser.go`;
- Xray-core: `infra/conf/transport_internet.go` (транспорты, sockopt),
  `infra/conf/freedom.go` (domainStrategy исходящего freedom).

Тесты держат перечисления в схемах вровень с тем, что ядро действительно умеет:
лишнее значение — подсказка конфига, который ядро не запустит, недостающее —
ложная ошибка в редакторе на рабочем конфиге.
"""

from __future__ import annotations

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCHEMAS = ROOT / "xkeen-ui/static/schemas"
MIHOMO = SCHEMAS / "mihomo-config.schema.json"
XRAY_SCHEMAS = (
    SCHEMAS / "xray-config.schema.json",
    SCHEMAS / "xray-inbounds.schema.json",
    SCHEMAS / "xray-outbounds.schema.json",
    SCHEMAS / "xray-routing.schema.json",
)

# adapter/parser.go, switch по proxyType — все 28 веток.
MIHOMO_PROXY_TYPES = {
    "ss", "ssr", "socks5", "http", "vmess", "vless", "snell", "trojan",
    "hysteria", "hysteria2", "wireguard", "tuic", "shadowquic", "gost-relay",
    "direct", "dns", "reject", "rematch", "ssh", "mieru", "anytls", "sudoku",
    "masque", "trusttunnel", "openvpn", "tailscale", "zerotier", "easytier",
}

# Типы, которые никуда не звонят: встроенные обработчики и mesh-сети.
MIHOMO_SERVERLESS_TYPES = {
    "direct", "dns", "reject", "rematch", "tailscale", "zerotier", "easytier",
}

# listener/parse.go, switch по типу listener — все 20 веток.
MIHOMO_LISTENER_TYPES = {
    "socks", "http", "tproxy", "redir", "mixed", "tunnel", "tun",
    "shadowsocks", "snell", "vmess", "vless", "trojan", "hysteria2",
    "hysteria2-realm", "tuic", "shadowquic", "anytls", "mieru", "sudoku",
    "trusttunnel",
}

# infra/conf/freedom.go и docs sockopt: полный набор стратегий.
XRAY_DOMAIN_STRATEGIES = {
    "AsIs",
    "UseIP", "UseIPv4", "UseIPv6", "UseIPv4v6", "UseIPv6v4",
    "ForceIP", "ForceIPv4", "ForceIPv6", "ForceIPv4v6", "ForceIPv6v4",
}

# TransportProtocol.Build(): удалены из ядра, конфиг с ними не поднимется.
XRAY_REMOVED_NETWORKS = {"http", "quic", "h2", "h3"}


def _load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def test_mihomo_proxy_types_cover_every_type_the_core_parses():
    proxy = _load(MIHOMO)["definitions"]["proxy"]
    types = set(proxy["properties"]["type"]["enum"])

    assert types == MIHOMO_PROXY_TYPES


def test_mihomo_asks_for_server_and_port_only_from_types_that_dial_out():
    proxy = _load(MIHOMO)["definitions"]["proxy"]

    rules = [
        rule for rule in proxy["allOf"]
        if rule.get("then", {}).get("required") == ["server", "port"]
    ]
    assert len(rules) == 1, "условие про server/port должно быть ровно одно"

    excluded = set(rules[0]["if"]["properties"]["type"]["not"]["enum"])
    # Безсерверные типы плюс mieru: у него порт бывает диапазоном, поэтому
    # требование server/port для него вынесено в собственное правило.
    assert excluded == MIHOMO_SERVERLESS_TYPES | {"mieru"}


def test_mihomo_proxy_groups_drop_the_relay_type_removed_from_the_core():
    group = _load(MIHOMO)["definitions"]["proxyGroup"]

    assert "relay" not in group["properties"]["type"]["enum"]


def test_xray_transports_do_not_offer_networks_removed_from_the_core():
    for path in XRAY_SCHEMAS:
        stream = _load(path)["definitions"]["streamSettings"]["properties"]
        for field in ("network", "method"):
            if field not in stream:
                continue
            stale = set(stream[field].get("enum", [])) & XRAY_REMOVED_NETWORKS
            assert not stale, f"{path.name}: {field} предлагает {sorted(stale)}"


def test_xray_domain_strategies_cover_every_value_the_core_accepts():
    for path in XRAY_SCHEMAS:
        defs = _load(path)["definitions"]
        sockopt = defs["streamSettings"]["properties"]["sockopt"]["properties"]
        assert set(sockopt["domainStrategy"]["enum"]) == XRAY_DOMAIN_STRATEGIES, path.name

        outbound = defs["outbound"]["properties"]["domainStrategy"]
        assert set(outbound["enum"]) == XRAY_DOMAIN_STRATEGIES, path.name


def test_mihomo_listener_types_cover_every_inbound_the_core_starts():
    listeners = _load(MIHOMO)["properties"]["listeners"]["items"]

    assert set(listeners["properties"]["type"]["enum"]) == MIHOMO_LISTENER_TYPES


def _proxy_rule(proxy: dict, proxy_type: str) -> dict:
    """Условие allOf, навешенное ровно на этот тип прокси."""
    for rule in proxy["allOf"]:
        cond = rule.get("if", {}).get("properties", {}).get("type", {})
        if cond.get("const") == proxy_type:
            return rule["then"]
    raise AssertionError(f"нет правила для типа {proxy_type}")


def test_mihomo_new_protocols_got_their_required_fields():
    proxy = _load(MIHOMO)["definitions"]["proxy"]

    assert _proxy_rule(proxy, "sudoku")["required"] == ["key"]
    assert _proxy_rule(proxy, "shadowquic")["required"] == ["username", "password"]
    assert _proxy_rule(proxy, "masque")["required"] == ["private-key", "public-key"]
    assert _proxy_rule(proxy, "easytier")["required"] == ["network-name"]
    assert _proxy_rule(proxy, "zerotier")["required"] == ["network"]

    # У mieru порт задаётся либо `port`, либо диапазоном `port-range`.
    mieru = _proxy_rule(proxy, "mieru")
    assert mieru["required"] == ["server"]
    assert {"required": ["port-range"]} in mieru["anyOf"]


def test_mihomo_fields_with_shared_names_are_split_by_proxy_type():
    """`network` и `peers` значат разное у разных типов — общего ограничения быть не может."""
    proxy = _load(MIHOMO)["definitions"]["proxy"]

    # Общий enum транспортов снят: у ZeroTier тут идентификатор сети.
    assert "enum" not in proxy["properties"]["network"]
    # ...но для VMess/VLESS/Trojan список транспортов остаётся в силе.
    transports = [
        rule for rule in proxy["allOf"]
        if rule.get("if", {}).get("properties", {}).get("type", {}).get("enum") == ["vmess", "vless", "trojan"]
    ]
    assert len(transports) == 1
    assert "xhttp" in transports[0]["then"]["properties"]["network"]["enum"]

    # peers: объекты у WireGuard, строки-URI у EasyTier.
    assert _proxy_rule(proxy, "wireguard")["properties"]["peers"]["items"] == {
        "$ref": "#/definitions/wireGuardPeer"
    }
    assert _proxy_rule(proxy, "easytier")["properties"]["peers"]["items"] == {"type": "string"}


def test_mihomo_describes_the_fields_of_the_new_protocols():
    props = _load(MIHOMO)["definitions"]["proxy"]["properties"]

    expected = {
        "port-range", "transport", "multiplexing", "handshake-mode",     # mieru
        "aead-method", "padding-min", "padding-max", "httpmask",         # sudoku
        "handshake-timeout",                                             # masque
        "quic-versions", "udp-over-stream", "zero-rtt", "cwnd",          # shadowquic
        "forward", "mux",                                                # gost-relay
        "identity-secret", "planet", "physical-mtu", "orbit",            # zerotier
        "network-name", "network-secret", "ipv4", "exit-nodes",          # easytier
    }
    assert expected <= set(props)

    # Каждое описанное поле объясняет себя по-русски, а не висит пустым.
    for name in expected:
        assert props[name].get("description"), name

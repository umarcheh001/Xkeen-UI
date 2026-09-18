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
    assert excluded == MIHOMO_SERVERLESS_TYPES


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

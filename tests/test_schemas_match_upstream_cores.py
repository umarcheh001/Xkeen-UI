"""Схемы редакторов сверены с исходниками Mihomo и Prizrak-Core.

Источники (ветки Meta и Alpha у Mihomo дают одинаковые списки):
- Mihomo: `adapter/parser.go` (ParseProxy), `adapter/outboundgroup/parser.go`;
- Prizrak-Core: `adapter/parser.go` (тип `freedom`);
- Xray-core: `infra/conf/transport_internet.go` (транспорты, sockopt),
  `infra/conf/freedom.go` (domainStrategy исходящего freedom).

Тесты держат перечисления в схемах вровень с тем, что ядро действительно умеет:
расширения форка учитываются отдельно от базового Mihomo.
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
PRIZRAK_PROXY_TYPES = {"freedom"}

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

    assert types == MIHOMO_PROXY_TYPES | PRIZRAK_PROXY_TYPES


def test_mihomo_schema_covers_snell_v6_fields():
    schema = _load(MIHOMO)
    props = schema["definitions"]["proxy"]["properties"]
    assert props["psk"]["type"] == "string"
    assert 6 in props["version"]["examples"]
    assert {"default", "unshaped", "unsafe-raw"} <= set(props["mode"]["examples"])


def test_mihomo_listener_schema_offers_shadowsocks_users_mapping():
    listeners = _load(MIHOMO)["properties"]["listeners"]["items"]["properties"]
    assert {"type": "object", "additionalProperties": {"type": "string"}} in listeners["users"]["anyOf"]


def test_mihomo_schema_describes_current_tls_transport_options():
    props = _load(MIHOMO)["definitions"]["proxy"]["properties"]
    assert {"username", "password"} <= props["jls-opts"]["properties"].keys()
    assert {"password", "version"} <= props["shadow-tls-opts"]["properties"].keys()
    assert {"password", "version-hint", "restls-script"} <= props["restls-opts"]["properties"].keys()
    assert {"primary-key", "transport-layer-padding"} <= props["tlsmirror-opts"]["properties"].keys()
    assert {"base-nanoseconds", "uniform-random-multiplier-nanoseconds"} <= props["tlsmirror-opts"]["properties"]["defer-instance-derived-write-time"]["properties"].keys()
    assert {"realm-id", "server-url", "stun-servers"} <= props["realm-opts"]["properties"].keys()
    mekya = props["mekya-opts"]["properties"]
    assert {"h2-pool-size", "kcp", "packet-writing-buffer"} <= mekya.keys()
    assert {"uplink-capacity", "downlink-capacity"} <= mekya["kcp"]["properties"].keys()


def test_mihomo_schema_covers_additional_upstream_proxy_fields():
    props = _load(MIHOMO)["definitions"]["proxy"]["properties"]
    assert {
        "auth-str", "authenticated-length", "client-metadata", "disable-reuse",
        "disable-sni", "fast-open", "heartbeat-interval", "hop-interval", "host-key",
        "host-key-algorithms", "idle-session-check-interval", "idle-session-timeout",
        "min-idle-session", "obfs", "obfs-opts", "obfs-password", "ports", "protocol",
        "reduce-rtt", "reuse", "udp-mtu", "udp-over-tcp", "udp-over-tcp-version",
        "udp-relay-mode", "xudp", "packet-addr", "target-rematch-name", "target-sub-rule",
        "comp-lzo", "data-ciphers", "data-ciphers-fallback", "disable-kcp-input",
        "disable-quic-input", "down-speed", "up-speed", "global-padding", "headers",
        "http-mask", "http-mask-host", "http-mask-mode", "http-mask-multiplex", "http-mask-tls",
        "initial-connection-receive-window", "initial-stream-receive-window",
        "max-connection-receive-window", "max-stream-receive-window", "key-direction",
        "mapped-listeners", "max-udp-relay-packet-size", "mekya-opts", "obfs-max-packet-size",
        "obfs-min-packet-size", "obfs-param", "obfs-protocol", "path-root", "peer-info",
        "ping", "ping-restart", "private-key-passphrase", "protocol-param", "realm-opts",
        "remote-trace-level", "remote-trace-target", "request-timeout", "ss-opts", "tls-auth",
        "tls-crypt-v2", "token", "tran-window", "udp-over-stream-version", "uri", "ws-headers",
    } <= props.keys()


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
    assert excluded == MIHOMO_SERVERLESS_TYPES | {"mieru"} | PRIZRAK_PROXY_TYPES


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


def test_xray_schemas_support_xdrive_transport():
    for path in XRAY_SCHEMAS:
        stream = _load(path)["definitions"]["streamSettings"]["properties"]
        assert "xdrive" in stream["network"]["enum"], path.name
        assert "xdrive" in stream["method"]["enum"], path.name
        settings = stream["xdriveSettings"]["properties"]
        assert {"service", "remoteFolder", "secrets", "s3", "template", "xmux"} <= settings.keys(), path.name


def test_xray_schemas_cover_current_stream_config_fields():
    for path in XRAY_SCHEMAS:
        stream = _load(path)["definitions"]["streamSettings"]["properties"]
        assert {"address", "port", "splithttpSettings", "masqueSettings", "hysteriaSettings", "finalmask"} <= stream.keys(), path.name
        assert "masque" in stream["method"]["enum"], path.name
        assert "masque" in stream["network"]["enum"], path.name


def test_xray_schemas_cover_current_reality_tls_and_outbound_fields():
    for path in XRAY_SCHEMAS:
        definitions = _load(path)["definitions"]
        stream = definitions["streamSettings"]["properties"]
        assert {"masterKeyLog", "type"} <= stream["realitySettings"]["properties"].keys(), path.name
        assert "useSystemCA" in stream["tlsSettings"]["properties"], path.name
        assert "targetStrategy" in definitions["outbound"]["properties"], path.name
        sockopt = stream["sockopt"]["properties"]
        assert {"acceptProxyProtocol", "tcpCongestion", "tcpWindowClamp", "tcpMaxSeg", "penetrate", "tcpUserTimeout", "customSockopt", "addressPortStrategy", "happyEyeballs", "trustedXForwardedFor"} <= sockopt.keys(), path.name
        assert set(sockopt["tcpFastOpen"]["type"]) == {"boolean", "integer"}


def test_xray_schemas_offer_masque_protocol():
    for path in XRAY_SCHEMAS:
        defs = _load(path)["definitions"]
        assert "masque" in defs["inbound"]["properties"]["protocol"]["enum"], path.name
        assert "masque" in defs["outbound"]["properties"]["protocol"]["enum"], path.name


def test_xray_schemas_cover_current_dns_and_routing_fields():
    full = _load(SCHEMAS / "xray-config.schema.json")
    dns = full["properties"]["dns"]["properties"]
    assert {"script", "serveStale", "serveExpiredTTL", "enableParallelQuery", "useSystemHosts"} <= dns.keys()
    assert "script" in full["properties"]["routing"]["properties"]
    routing = _load(SCHEMAS / "xray-routing.schema.json")["anyOf"]
    assert "script" in routing[0]["properties"]["routing"]["properties"]
    assert "script" in routing[1]["properties"]


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


def test_mihomo_openvpn_does_not_require_optional_tls_crypt():
    proxy = _load(MIHOMO)["definitions"]["proxy"]
    rule = _proxy_rule(proxy, "openvpn")
    assert "tls-crypt" not in rule["required"]
    assert {"AES-128-CBC", "AES-256-CBC", "CHACHA20-POLY1305"} <= set(rule["properties"]["cipher"]["enum"])
    assert {"MD5", "SHA1", "SHA384", "SHA512"} <= set(rule["properties"]["auth"]["enum"])


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


def test_mihomo_xhttp_session_fields_cover_current_core():
    definitions = _load(MIHOMO)["definitions"]
    for name in ("xhttpOpts", "xhttpDownloadSettings"):
        assert {"session-length", "session-table"} <= definitions[name]["properties"].keys()


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

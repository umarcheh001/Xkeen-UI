from services.mihomo_node_import import (
    build_mihomo_node_draft,
    proxy_group_names,
)
from services.mihomo_proxy_parsers import ProxyParseResult


BASE_CONFIG = """\
mixed-port: 7890
proxies: []
proxy-groups:
  - name: Main
    type: select
    proxies:
      - DIRECT
  - name: Auto
    type: url-test
    proxies: [DIRECT]
rules:
  - MATCH,Main
"""


def test_proxy_group_names_preserve_document_order():
    assert proxy_group_names(BASE_CONFIG) == ["Main", "Auto"]


def test_direct_node_is_inserted_into_draft_and_selected_group():
    result = build_mihomo_node_draft(
        content=BASE_CONFIG,
        source=(
            "vless://11111111-1111-1111-1111-111111111111@example.com:443"
            "?encryption=none&security=tls&type=ws#Mobile"
        ),
        mode="auto",
        groups=["Main"],
    )

    assert result.inserted_names == ("Mobile",)
    assert result.inserted_kind == "proxy"
    assert "  - name: Mobile\n" in result.content
    assert "      - \"Mobile\"\n" in result.content
    highlighted = result.content[result.highlight_start : result.highlight_end]
    assert highlighted.startswith("  - name: Mobile")
    assert "proxy-groups:" not in highlighted


def test_duplicate_node_name_gets_unique_suffix():
    source = (
        "vless://11111111-1111-1111-1111-111111111111@example.com:443"
        "?encryption=none&security=tls&type=tcp#Mobile"
    )
    first = build_mihomo_node_draft(content=BASE_CONFIG, source=source, mode="proxy")
    second = build_mihomo_node_draft(content=first.content, source=source, mode="proxy")

    assert second.inserted_names == ("Mobile_2",)
    assert "  - name: Mobile_2\n" in second.content


def test_xray_subscription_inserts_every_returned_proxy():
    calls = []

    def parse_subscription(url, existing_names):
        calls.append((url, tuple(existing_names)))
        return (
            [
                ProxyParseResult("Node A", "- name: 'Node A'\n  type: vless\n"),
                ProxyParseResult("Node B", "- name: 'Node B'\n  type: vless\n"),
            ],
            3,
        )

    result = build_mihomo_node_draft(
        content=BASE_CONFIG,
        source="https://subscription.example/xray",
        mode="subscription",
        groups=["Main", "Auto"],
        xray_subscription_parser=parse_subscription,
    )

    assert calls == [("https://subscription.example/xray", ())]
    assert result.inserted_names == ("Node A", "Node B")
    assert result.skipped_count == 3
    assert result.content.count("type: vless") == 2
    highlighted = result.content[result.highlight_start : result.highlight_end]
    assert "Node A" in highlighted
    assert "Node B" in highlighted


def test_regular_subscription_falls_back_to_proxy_provider():
    result = build_mihomo_node_draft(
        content=BASE_CONFIG,
        source="https://provider.example/clash.yaml",
        mode="auto",
        xray_subscription_parser=lambda _url, _names: None,
        provider_url_factory=lambda _url: "http://127.0.0.1:8088/mihomo/provider.yaml?url=safe",
    )

    assert result.inserted_names == ("provider.example",)
    assert result.inserted_kind == "provider"
    assert "proxy-providers:\n  provider.example:" in result.content
    assert "url: 'http://127.0.0.1:8088/mihomo/provider.yaml?url=safe'" in result.content
    highlighted = result.content[result.highlight_start : result.highlight_end]
    assert highlighted.startswith("  provider.example:")


def test_provider_target_can_supply_required_request_headers():
    result = build_mihomo_node_draft(
        content=BASE_CONFIG,
        source="https://provider.example/clash.yaml",
        mode="subscription",
        xray_subscription_parser=lambda _url, _names: None,
        provider_url_factory=lambda url: (url, {"User-Agent": ["Mihomo", "Xkeen"]}),
    )

    assert "    header:\n      User-Agent:\n        - Mihomo\n        - Xkeen\n" in result.content


def test_proxy_mode_rejects_subscription_url():
    try:
        build_mihomo_node_draft(
            content=BASE_CONFIG,
            source="https://provider.example/subscription",
            mode="proxy",
        )
    except ValueError as exc:
        assert "Подписка" in str(exc)
    else:
        raise AssertionError("subscription URL must not be accepted in proxy mode")


def test_auto_mode_detects_wireguard_config_as_one_source():
    source = """\
[Interface]
PrivateKey = private-key
Address = 10.0.0.2/32

[Peer]
PublicKey = public-key
Endpoint = vpn.example:51820
AllowedIPs = 0.0.0.0/0
"""
    result = build_mihomo_node_draft(content=BASE_CONFIG, source=source, mode="auto")

    assert result.inserted_kind == "proxy"
    assert len(result.inserted_names) == 1
    assert "type: wireguard" in result.content


def test_line_import_keeps_valid_nodes_and_counts_invalid_lines():
    source = "\n".join(
        [
            "not-a-proxy",
            (
                "vless://11111111-1111-1111-1111-111111111111@example.com:443"
                "?encryption=none&security=tls&type=tcp#Valid"
            ),
        ]
    )
    result = build_mihomo_node_draft(content=BASE_CONFIG, source=source, mode="auto")

    assert result.inserted_names == ("Valid",)
    assert result.skipped_count == 1


def test_non_empty_flow_style_proxies_are_rejected_without_corruption():
    content = "proxies: [{name: Existing, type: direct}]\nrules: []\n"
    try:
        build_mihomo_node_draft(
            content=content,
            source=(
                "vless://11111111-1111-1111-1111-111111111111@example.com:443"
                "?encryption=none&type=tcp#New"
            ),
            mode="proxy",
        )
    except ValueError as exc:
        assert "блочный формат" in str(exc)
    else:
        raise AssertionError("non-empty flow-style proxies must be rejected")


def test_escaped_yaml_name_gets_correct_highlight_range():
    result = build_mihomo_node_draft(
        content=BASE_CONFIG,
        source=(
            "vless://11111111-1111-1111-1111-111111111111@example.com:443"
            "?encryption=none&type=tcp#Bob%27s%20node"
        ),
        mode="proxy",
    )

    highlighted = result.content[result.highlight_start : result.highlight_end]
    assert highlighted.startswith("  - name: 'Bob''s node'")


def test_non_empty_flow_style_providers_are_rejected_without_corruption():
    content = "proxies: []\nproxy-providers: {old: {type: http}}\nrules: []\n"
    try:
        build_mihomo_node_draft(
            content=content,
            source="https://provider.example/sub",
            mode="subscription",
            xray_subscription_parser=lambda _url, _names: None,
        )
    except ValueError as exc:
        assert "proxy-providers" in str(exc)
        assert "блочный формат" in str(exc)
    else:
        raise AssertionError("non-empty flow-style providers must be rejected")

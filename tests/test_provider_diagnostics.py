import io
import json
import socket

import pytest
from flask import Flask

from routes.provider_diagnostics import create_provider_diagnostics_blueprint
from services.provider_diagnostics import (
    compare_public_dns,
    current_mihomo_targets,
    current_xray_targets,
    lookup_public_lists,
    make_target,
    parse_source,
    probe_target,
)


def test_saved_xray_and_mihomo_targets_are_read_without_credentials(tmp_path):
    configs = tmp_path / "xray"
    configs.mkdir()
    (configs / "04_outbounds.json").write_text(
        '''{
          // server from a saved fragment
          "outbounds": [
            {"tag":"A", "protocol":"vless", "settings":{"vnext":[{"address":"edge.example", "port":443, "users":[{"id":"secret"}]}]}},
            {"tag":"Direct", "protocol":"freedom"}
          ]
        }''',
        encoding="utf-8",
    )
    mihomo = tmp_path / "config.yaml"
    mihomo.write_text(
        '''proxies:
  - name: Edge
    type: vless
    server: edge.example
    port: 443
  - name: UDP
    type: hysteria2
    server: udp.example
    port: 8443
proxy-providers:
  main:
    type: http
    url: https://provider.example/sub?token=secret
    path: ./proxy_providers/main.yaml
''', encoding="utf-8",
    )
    (tmp_path / "proxy_providers").mkdir()
    (tmp_path / "proxy_providers" / "main.yaml").write_text(
        "proxies:\n  - name: Cached\n    type: trojan\n    server: cached.example\n    port: 443\n",
        encoding="utf-8",
    )

    xray = current_xray_targets(str(configs))
    mihomo_targets = current_mihomo_targets(str(mihomo))
    assert [(item["name"], item["host"], item["port"]) for item in xray] == [("A", "edge.example", 443)]
    assert [(item["host"], item["network"]) for item in mihomo_targets] == [
        ("edge.example", "tcp"), ("udp.example", "udp"), ("provider.example", "tcp"),
        ("cached.example", "tcp"),
    ]
    assert "secret" not in json.dumps(xray + mihomo_targets)


def test_manual_addresses_and_share_links_use_existing_parsers():
    plain = parse_source("example.com\n203.0.113.10:8443\n[2001:db8::1]:443")
    assert [(item["host"], item["port"]) for item in plain["targets"]] == [
        ("example.com", 443), ("203.0.113.10", 8443), ("2001:db8::1", 443),
    ]
    link = "vless://11111111-1111-1111-1111-111111111111@edge.example:443?encryption=none&security=tls&type=ws#Edge"
    result = parse_source(link)
    assert len(result["targets"]) == 1
    assert result["targets"][0]["host"] == "edge.example"
    assert "11111111" not in json.dumps(result)


def test_subscription_fetch_is_one_level_and_does_not_echo_url(monkeypatch):
    from services import xray_subscriptions

    calls = []

    def fetch(url):
        calls.append(url)
        return "example.org\n198.51.100.8:443", {}, {}

    monkeypatch.setattr(xray_subscriptions, "fetch_subscription_body_for_xray", fetch)
    result = parse_source("https://provider.example/sub?token=private")
    assert calls == ["https://provider.example/sub?token=private"]
    assert [item["host"] for item in result["targets"]] == ["example.org", "198.51.100.8"]
    assert "private" not in json.dumps(result)


def test_amnezia_key_uses_existing_importer_without_returning_key(monkeypatch):
    from services import amnezia_premium, mihomo_proxy_parsers

    monkeypatch.setattr(amnezia_premium, "import_connection_key", lambda value: "[Interface]\n[Peer]\n")
    monkeypatch.setattr(
        mihomo_proxy_parsers,
        "parse_wireguard",
        lambda value: mihomo_proxy_parsers.ProxyParseResult(
            name="AWG", yaml="  - name: AWG\n    type: wireguard\n    server: awg.example\n    port: 51820\n"
        ),
    )
    result = parse_source("vpn://private-key")
    assert result["targets"][0]["host"] == "awg.example"
    assert result["targets"][0]["network"] == "udp"
    assert "private-key" not in json.dumps(result)


def test_tailscale_source_reports_that_there_is_no_fixed_endpoint():
    result = parse_source("tailscale://node.example?auth-key=tskey-secret")
    assert result["targets"] == []
    assert "Tailscale" in result["warnings"][0]
    assert "tskey-secret" not in json.dumps(result)


def test_tcp_probe_succeeds_and_udp_is_explicitly_unverified():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        port = listener.getsockname()[1]
        result = probe_target(make_target("127.0.0.1", port))
    assert result["status"] == "reachable"
    assert result["tcp_ms"] >= 0
    udp = probe_target(make_target("127.0.0.1", 51820, network="udp"))
    assert udp["status"] == "udp_unknown"
    assert "блокиров" not in udp["message"]


def test_public_dns_comparison_is_opt_in_and_rejects_local_names(monkeypatch):
    from services import provider_diagnostics

    monkeypatch.setattr(provider_diagnostics.socket, "getaddrinfo", lambda *args, **kwargs: [
        (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("198.51.100.10", 0)),
    ])
    monkeypatch.setattr(provider_diagnostics, "urlopen", lambda *args, **kwargs: io.BytesIO(
        b'{"Status":0,"Answer":[{"type":1,"data":"203.0.113.20"}]}'
    ))
    result = compare_public_dns({"host": "edge.example.org"})
    assert result == {
        "host": "edge.example.org", "status": "ok", "local": ["198.51.100.10"],
        "public": ["203.0.113.20"], "local_error": False, "different": True,
    }
    monkeypatch.setattr(provider_diagnostics.socket, "getaddrinfo", lambda *args, **kwargs: (_ for _ in ()).throw(socket.gaierror("no local DNS")))
    no_local_dns = compare_public_dns({"host": "edge.example.org"})
    assert no_local_dns["local_error"] is True
    assert no_local_dns["public"] == ["203.0.113.20"]
    assert no_local_dns["different"] is False
    with pytest.raises(ValueError, match="Локальное имя"):
        compare_public_dns({"host": "router.local"})


def test_public_list_lookup_returns_bounded_network_evidence(monkeypatch):
    from services import provider_diagnostics

    requests = []

    def fetch(request, timeout):
        requests.append((request.full_url, timeout))
        return io.BytesIO(json.dumps({
            "blocked": True,
            "rkn_domain": "edge.example.org",
            "blocked_subnets": ["203.0.113.0/24"],
            "cdn_providers": {"cloudflare": [{"cidr": "104.16.0.0/13"}]},
            "ips": ["203.0.113.10"],
            "geo": {"organisation": "Example Hosting", "asn": "AS64500", "location": "RU"},
            "id": "private-query-token",
        }).encode("utf-8"))

    monkeypatch.setattr(provider_diagnostics, "urlopen", fetch)
    result = lookup_public_lists({"host": "edge.example.org"})
    assert requests == [("https://cheburcheck.ru/api/v1/check?target=edge.example.org", 5)]
    assert result["listed"] is True
    assert result["registry_domain"] == "edge.example.org"
    assert result["cdn_providers"] == [{"name": "cloudflare", "networks": ["104.16.0.0/13"]}]
    assert result["asn"] == "AS64500"
    assert "private-query-token" not in json.dumps(result)
    with pytest.raises(ValueError, match="Локальный IP"):
        lookup_public_lists({"host": "192.168.1.1"})
    with pytest.raises(ValueError, match="Локальное имя"):
        lookup_public_lists({"host": "router.local"})
    assert len(requests) == 1


@pytest.mark.parametrize("host,port", [("http://bad.example", 443), ("example.com", 0), ("example.com", 65536)])
def test_invalid_target_is_rejected(host, port):
    with pytest.raises(ValueError):
        make_target(host, port)


def test_api_exposes_saved_targets_and_checks_input(tmp_path):
    configs = tmp_path / "configs"
    configs.mkdir()
    (configs / "04_outbounds.json").write_text('{"outbounds":[]}', encoding="utf-8")
    app = Flask(__name__)
    app.register_blueprint(create_provider_diagnostics_blueprint(
        xray_configs_dir=str(configs), mihomo_config_file=str(tmp_path / "missing.yaml"),
    ))
    client = app.test_client()
    assert client.get("/api/provider-diagnostics/targets?core=xray").json["targets"] == []
    assert client.post("/api/provider-diagnostics/parse", json={"source": "example.com"}).json["targets"][0]["host"] == "example.com"
    assert client.post("/api/provider-diagnostics/probe", json={"host": "bad host", "port": 443}).status_code == 400
    assert client.post("/api/provider-diagnostics/dns-compare", json={"host": "router.local"}).status_code == 400
    assert client.post("/api/provider-diagnostics/public-lists", json={"host": "192.168.1.1"}).status_code == 400

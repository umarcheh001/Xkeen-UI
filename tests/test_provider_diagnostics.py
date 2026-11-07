import io
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import socket
import ssl
import subprocess
import sys
import threading

import pytest
from flask import Flask

from routes.provider_diagnostics import create_provider_diagnostics_blueprint
from services.provider_diagnostics import (
    compare_public_dns,
    compare_resource_paths,
    compare_tls_path,
    current_mihomo_targets,
    current_xray_targets,
    lookup_public_lists,
    make_target,
    parse_source,
    probe_target,
    read_current_xray_targets,
    mihomo_text_targets,
    xray_outbound_targets,
)


@pytest.fixture
def direct_route(monkeypatch):
    from services import provider_diagnostics

    monkeypatch.setattr(provider_diagnostics, "_xkeen_direct_mark", lambda: 0)


@pytest.mark.parametrize(("with_sni", "without_sni", "control", "registry", "expected"), [
    ("tls_error", "tls_ok", "tls_ok", False, "tls_sni_filtering"),
    ("tls_timeout", "tls_ok", "tls_ok", False, "tls_sni_filtering"),
    ("timeout", "timeout", "tls_ok", False, "server_unresponsive"),
    ("tcp_timeout", "tcp_timeout", "tls_ok", False, "server_unresponsive"),
    ("tls_error", "tls_ok", "timeout", False, "undetermined"),
    ("tls_ok", "tls_ok", "tls_ok", True, "undetermined"),
])
def test_comparative_tls_verdicts(monkeypatch, direct_route, with_sni, without_sni, control, registry, expected):
    from services import provider_diagnostics

    address = (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("198.51.100.30", 443))
    monkeypatch.setattr(provider_diagnostics.socket, "getaddrinfo", lambda *_args, **_kwargs: [address])
    seen = []

    def attempt(item, *, server_name, bypass_mark=0):
        seen.append((item[4][0], server_name))
        if item[4][0] == "1.1.1.1":
            return control
        return with_sni if server_name else without_sni

    monkeypatch.setattr(provider_diagnostics, "_tls_comparison_attempt", attempt)
    monkeypatch.setattr(provider_diagnostics, "lookup_public_lists", lambda raw: {
        "status": "ok", "listed": registry, "registry_domain": raw["host"] if registry else "", "blocked_subnets": [],
    })
    result = compare_tls_path(make_target("edge.example.org", 443, tls=True, sni="front.example.org"))
    assert result["verdict"] == expected
    assert result["registry"]["listed"] is registry
    assert result["target_ip"] == "198.51.100.30"
    expected_rounds = 1 if with_sni == "tls_ok" else 2
    assert seen == [("1.1.1.1", "cloudflare-dns.com"), *(
        [("198.51.100.30", "front.example.org"), ("198.51.100.30", None)] * expected_rounds
    )]


@pytest.mark.parametrize(("second_with", "second_without", "expected", "confidence", "reason"), [
    ("tls_error", "tls_ok", "tls_sni_filtering", "medium", "consistent_sni_pattern"),
    ("tls_ok", "tls_error", "undetermined", "low", "different_ip_results"),
])
def test_comparative_tls_repeats_across_distinct_ips(monkeypatch, direct_route, second_with, second_without, expected, confidence, reason):
    from services import provider_diagnostics as diagnostics

    addresses = [
        (socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 443))
        for ip in ("198.51.100.30", "198.51.100.30", "198.51.100.31", "198.51.100.32")
    ]
    monkeypatch.setattr(diagnostics.socket, "getaddrinfo", lambda *_args, **_kwargs: addresses)
    attempts = []

    def attempt(address, *, server_name, bypass_mark=0):
        ip = address[4][0]
        attempts.append((ip, server_name))
        if ip == "1.1.1.1":
            return "tls_ok"
        if ip == "198.51.100.30":
            return "tls_error" if server_name else "tls_ok"
        return second_with if server_name else second_without

    monkeypatch.setattr(diagnostics, "_tls_comparison_attempt", attempt)
    monkeypatch.setattr(diagnostics, "lookup_public_lists", lambda _raw: {"status": "unavailable"})
    result = diagnostics.compare_tls_path(make_target("edge.example.org", 443, tls=True, sni="front.example.org"))

    assert result["verdict"] == expected
    assert result["confidence"] == confidence
    assert result["reason"] == reason
    assert result["rounds_per_ip"] == 2
    assert [item["ip"] for item in result["address_results"]] == ["198.51.100.30", "198.51.100.31"]
    assert len(result["address_results"][0]["with_sni"]) == len(result["address_results"][0]["without_sni"]) == 2
    expected_second_rounds = 2 if second_with != "tls_ok" else 1
    assert len(result["address_results"][1]["with_sni"]) == len(result["address_results"][1]["without_sni"]) == expected_second_rounds
    assert len(attempts) == 1 + 4 + 2 * expected_second_rounds
    assert not any(ip == "198.51.100.32" for ip, _ in attempts)


def test_comparative_tls_without_sni_failure_is_not_filtering(monkeypatch, direct_route):
    from services import provider_diagnostics as diagnostics

    address = (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("198.51.100.30", 443))
    monkeypatch.setattr(diagnostics.socket, "getaddrinfo", lambda *_args, **_kwargs: [address])
    monkeypatch.setattr(diagnostics, "_tls_comparison_attempt", lambda _address, *, server_name, bypass_mark=0: "tls_ok" if server_name else "tls_error")
    monkeypatch.setattr(diagnostics, "lookup_public_lists", lambda _raw: {"status": "unavailable"})

    result = diagnostics.compare_tls_path(make_target("edge.example.org", 443, tls=True, sni="front.example.org"))
    assert result["verdict"] == "undetermined"
    assert result["address_results"][0]["pattern"] == "tls_reachable"


def test_comparative_tls_stops_after_healthy_first_ip(monkeypatch, direct_route):
    from services import provider_diagnostics as diagnostics

    addresses = [
        (socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 443))
        for ip in ("198.51.100.30", "198.51.100.31")
    ]
    monkeypatch.setattr(diagnostics.socket, "getaddrinfo", lambda *_args, **_kwargs: addresses)
    attempts = []

    def attempt(address, *, server_name, bypass_mark=0):
        attempts.append((address[4][0], server_name, bypass_mark))
        return "tls_ok"

    monkeypatch.setattr(diagnostics, "_tls_comparison_attempt", attempt)
    monkeypatch.setattr(diagnostics, "lookup_public_lists", lambda _raw: {"status": "skipped"})
    result = diagnostics.compare_tls_path(make_target("edge.example.org", 443, tls=True, sni="front.example.org"))
    assert result["attempts_total"] == 3
    assert result["rounds_per_ip"] == 1
    assert [item["ip"] for item in result["address_results"]] == ["198.51.100.30"]
    assert all(ip != "198.51.100.31" for ip, _, _ in attempts)


def test_comparative_tls_refuses_unverified_route(monkeypatch):
    from services import provider_diagnostics as diagnostics

    monkeypatch.setattr(diagnostics, "_xkeen_direct_mark", lambda: None)
    monkeypatch.setattr(diagnostics, "_tls_comparison_attempt", lambda *_args, **_kwargs: pytest.fail("must not connect"))
    result = diagnostics.compare_tls_path(make_target("edge.example.org", 443, tls=True, sni="front.example.org"))
    assert result["status"] == "route_unverified"


def test_comparative_tls_requires_public_dns_evidence_for_dns_verdict(monkeypatch, direct_route):
    from services import provider_diagnostics

    monkeypatch.setattr(provider_diagnostics.socket, "getaddrinfo", lambda *_args, **_kwargs: (_ for _ in ()).throw(socket.gaierror("failed")))
    monkeypatch.setattr(provider_diagnostics, "_tls_comparison_attempt", lambda *_args, **_kwargs: "tls_ok")
    monkeypatch.setattr(provider_diagnostics, "lookup_public_lists", lambda *_args: {"status": "unavailable"})
    monkeypatch.setattr(provider_diagnostics, "compare_public_dns", lambda *_args: {"status": "ok", "public": ["198.51.100.30"]})
    raw = make_target("edge.example.org", 443, tls=True)
    result = compare_tls_path(raw)
    assert result["verdict"] == "dns_failure"
    assert result["trials"] == {"with_sni": [], "without_sni": []}
    monkeypatch.setattr(provider_diagnostics, "compare_public_dns", lambda *_args: {"status": "unavailable"})
    assert compare_tls_path(raw)["verdict"] == "undetermined"
    with pytest.raises(ValueError, match="стандартного TLS"):
        compare_tls_path(make_target("edge.example.org", 443, tls_mode="reality"))


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


def test_saved_xray_targets_include_all_files_after_first_24(tmp_path):
    configs = tmp_path / "xray"
    configs.mkdir()
    (configs / "04_outbounds.json").write_text('{"outbounds":[]}', encoding="utf-8")
    counts = {"04_outbounds.auth.quattro-cloud.ru.json": 107,
              "04_outbounds.cdn.pecan.run-2.json": 17,
              "04_outbounds.cdn.pecan.run.json": 17}
    for filename, count in counts.items():
        outbounds = [{"tag": f"{filename}-{index}", "protocol": "vless",
                      "settings": {"vnext": [{"address": "shared.example.org", "port": 443}]}}
                     for index in range(count)]
        (configs / filename).write_text(json.dumps({"outbounds": outbounds}), encoding="utf-8")

    result = read_current_xray_targets(str(configs))
    assert result["has_more"] is False
    assert len(result["targets"]) == 141
    assert {source: sum(item["source"] == source for item in result["targets"]) for source in counts} == counts
    assert len({item["name"] for item in result["targets"]}) == 141


def test_saved_xray_targets_load_all_pages_across_files(tmp_path):
    configs = tmp_path / "xray"
    configs.mkdir()
    for source in ("04_outbounds.a.json", "04_outbounds.b.json", "04_outbounds.c.json"):
        outbounds = [{"tag": f"{source}-{index}", "protocol": "vless",
                      "settings": {"vnext": [{"address": f"edge-{index}.example.org", "port": 443}]}}
                     for index in range(90)]
        (configs / source).write_text(json.dumps({"outbounds": outbounds}), encoding="utf-8")

    first = read_current_xray_targets(str(configs))
    second = read_current_xray_targets(str(configs), offset=first["next_offset"])
    assert len(first["targets"]) == 200
    assert first["has_more"] is True
    assert first["next_offset"] == 200
    assert len(second["targets"]) == 70
    assert second["has_more"] is False
    assert second["next_offset"] == 270
    all_targets = first["targets"] + second["targets"]
    assert {source: sum(item["source"] == source for item in all_targets)
            for source in ("04_outbounds.a.json", "04_outbounds.b.json", "04_outbounds.c.json")} == {
                "04_outbounds.a.json": 90, "04_outbounds.b.json": 90, "04_outbounds.c.json": 90,
            }


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


def test_xray_targets_keep_tls_sni_and_distinct_security_modes():
    def outbound(tag, security, sni):
        return {
            "tag": tag, "protocol": "vless",
            "settings": {"vnext": [{"address": "198.51.100.10", "port": 443}]},
            "streamSettings": {"security": security, ("realitySettings" if security == "reality" else "tlsSettings"): {"serverName": sni, "allowInsecure": tag == "TLS B"}},
        }

    targets = xray_outbound_targets({"outbounds": [
        outbound("TLS A", "tls", "front-a.example.org"),
        outbound("TLS B", "tls", "front-b.example.org"),
        outbound("Reality", "reality", "front-c.example.org"),
    ]})
    assert [(item["tls_mode"], item["sni"], item["tls"]) for item in targets] == [
        ("standard", "front-a.example.org", True),
        ("standard", "front-b.example.org", True),
        ("reality", "front-c.example.org", False),
    ]
    assert "publicKey" not in json.dumps(targets)
    assert [item["verify_tls"] for item in targets] == [True, False, True]


@pytest.mark.parametrize("without_yaml", [False, True])
def test_mihomo_targets_keep_tls_sni_with_or_without_yaml(monkeypatch, without_yaml):
    if without_yaml:
        monkeypatch.setitem(sys.modules, "yaml", None)
    text = """proxies:
  - name: TLS
    type: vless
    server: 198.51.100.20
    port: 443
    tls: true
    servername: front.example.org
    skip-cert-verify: true
  - name: Reality
    type: vless
    server: reality.example.org
    port: 443
    tls: true
    sni: reality-front.example.org
    reality-opts:
      public-key: secret
"""
    targets = mihomo_text_targets(text)
    assert [(item["tls_mode"], item["sni"], item["tls"]) for item in targets] == [
        ("standard", "front.example.org", True),
        ("reality", "reality-front.example.org", False),
    ]
    assert "secret" not in json.dumps(targets)
    assert [item["verify_tls"] for item in targets] == [False, True]


def test_subscription_fetch_is_one_level_and_does_not_echo_url(monkeypatch):
    from services import xray_subscriptions

    calls = []

    def fetch(url, **kwargs):
        calls.append(url)
        assert kwargs == {"timeout_seconds": 6, "max_request_variants": 2}
        return "example.org\n198.51.100.8:443", {}, {}

    monkeypatch.setattr(xray_subscriptions, "fetch_subscription_body_for_xray", fetch)
    result = parse_source("https://provider.example/sub?token=private")
    assert calls == ["https://provider.example/sub?token=private"]
    assert [item["host"] for item in result["targets"]] == ["example.org", "198.51.100.8"]
    assert "private" not in json.dumps(result)


def test_manual_subscription_keeps_107_servers_and_no_secret(monkeypatch):
    from services import xray_subscriptions

    links = "\n".join(
        f"vless://11111111-1111-1111-1111-111111111111@node-{index}.example:443?security=tls#Node-{index}"
        for index in range(107)
    )
    monkeypatch.setattr(
        xray_subscriptions, "fetch_subscription_body_for_xray",
        lambda _url, **_kwargs: (links, {}, {"warnings": []}),
    )
    result = parse_source("https://provider.example/subscription/private-token#My nodes")
    assert len(result["targets"]) == 107
    assert result["truncated"] is False
    assert result["targets"][-1]["host"] == "node-106.example"
    assert "private-token" not in json.dumps(result)


def test_manual_proxy_probe_uses_cached_outbound_without_exposing_credentials(monkeypatch, tmp_path):
    from services import xray_subscriptions

    seen = []
    monkeypatch.setattr(xray_subscriptions, "_find_xray_binary", lambda: "/usr/bin/xray")

    def fake_probe(*, xray_bin, targets, probe_url, timeout_value, concurrency):
        seen.append(targets[0]["outbound"])
        assert xray_bin == "/usr/bin/xray"
        assert probe_url == "https://www.gstatic.com/generate_204"
        return {"diagnostics": {"delay_ms": 86}}

    monkeypatch.setattr(xray_subscriptions, "_probe_outbounds_batch", fake_probe)
    app = Flask(__name__)
    app.register_blueprint(create_provider_diagnostics_blueprint(
        xray_configs_dir=str(tmp_path), mihomo_config_file=str(tmp_path / "mihomo.yaml")
    ))
    client = app.test_client()
    link = "vless://11111111-1111-1111-1111-111111111111@edge.example:443?encryption=none&security=tls#Private"
    parsed = client.post("/api/provider-diagnostics/parse", json={"source": link})
    assert parsed.status_code == 200
    target = parsed.json["targets"][0]
    assert target["proxy_ref"] and target["proxy_index"] == 0
    assert "11111111-1111" not in parsed.get_data(as_text=True)
    checked = client.post("/api/provider-diagnostics/proxy-probe", json={
        "ref": target["proxy_ref"], "index": target["proxy_index"],
    })
    assert checked.json["result"]["status"] == "ok"
    assert checked.json["result"]["delay_ms"] == 86
    assert "11111111-1111" not in checked.get_data(as_text=True)
    assert seen[0]["settings"]["vnext"][0]["users"][0]["id"] == "11111111-1111-1111-1111-111111111111"
    stale = client.post("/api/provider-diagnostics/proxy-probe", json={"ref": "invalid", "index": 0})
    assert stale.status_code == 400


def test_saved_xray_target_offers_proxy_probe_without_credentials(tmp_path):
    configs = tmp_path / "xray"
    configs.mkdir()
    (configs / "04_outbounds.json").write_text(json.dumps({"outbounds": [{
        "tag": "Private", "protocol": "vless", "settings": {"vnext": [{
            "address": "edge.example", "port": 443, "users": [{"id": "private-uuid"}],
        }]},
    }]}), encoding="utf-8")
    app = Flask(__name__)
    app.register_blueprint(create_provider_diagnostics_blueprint(
        xray_configs_dir=str(configs), mihomo_config_file=str(tmp_path / "mihomo.yaml")
    ))
    response = app.test_client().get("/api/provider-diagnostics/targets?core=xray")
    assert response.status_code == 200
    assert response.json["targets"][0]["proxy_ref"]
    assert response.json["targets"][0]["proxy_index"] == 0
    assert "private-uuid" not in response.get_data(as_text=True)


@pytest.mark.parametrize("without_yaml", [False, True])
def test_saved_mihomo_target_offers_proxy_probe_without_credentials(monkeypatch, tmp_path, without_yaml):
    from services import provider_diagnostics

    if without_yaml:
        monkeypatch.setitem(sys.modules, "yaml", None)
    config = tmp_path / "config.yaml"
    config.write_text(
        "proxies:\n  - name: Private\n    type: vless\n    server: edge.example\n"
        "    port: 443\n    uuid: private-uuid\n    tls: true\n"
        "    reality-opts:\n      public-key: private-key\n",
        encoding="utf-8",
    )
    seen = []
    monkeypatch.setattr(provider_diagnostics, "_probe_mihomo_proxy", lambda entry: seen.append(entry) or {
        "status": "ok", "delay_ms": 42, "message": "Прокси работает.",
    })
    app = Flask(__name__)
    app.register_blueprint(create_provider_diagnostics_blueprint(
        xray_configs_dir=str(tmp_path), mihomo_config_file=str(config)
    ))
    client = app.test_client()
    response = client.get("/api/provider-diagnostics/targets?core=mihomo")
    assert response.status_code == 200
    target = response.json["targets"][0]
    assert target["proxy_ref"] and target["proxy_index"] == 0
    assert target["proxy_engine"] == "mihomo"
    assert "private-uuid" not in response.get_data(as_text=True)
    assert "private-key" not in response.get_data(as_text=True)
    checked = client.post("/api/provider-diagnostics/proxy-probe", json={
        "ref": target["proxy_ref"], "index": target["proxy_index"],
    })
    assert checked.json["result"]["status"] == "ok"
    assert seen[0]["_diagnostics_engine"] == "mihomo"
    assert "private-uuid" in json.dumps(seen[0])


def test_manual_mihomo_link_uses_mihomo_proxy_context(tmp_path):
    app = Flask(__name__)
    app.register_blueprint(create_provider_diagnostics_blueprint(
        xray_configs_dir=str(tmp_path), mihomo_config_file=str(tmp_path / "config.yaml")
    ))
    link = "vless://11111111-1111-1111-1111-111111111111@edge.example:443?encryption=none&security=tls#Private"
    response = app.test_client().post("/api/provider-diagnostics/parse", json={
        "source": link, "core": "mihomo",
    })
    assert response.status_code == 200
    target = response.json["targets"][0]
    assert target["proxy_engine"] == "mihomo"
    assert target["proxy_ref"] and target["proxy_index"] == 0
    assert "11111111-1111" not in response.get_data(as_text=True)


@pytest.mark.parametrize(("direct", "proxy", "listed", "expected"), [
    ({"status": "http_response", "http_status": 200}, {"status": "http_response", "http_status": 200}, True, "both_reachable"),
    ({"status": "http_response", "http_status": 301}, {"status": "http_response", "http_status": 301}, True, "both_redirects"),
    ({"status": "tls_timeout"}, {"status": "http_response", "http_status": 301}, True, "proxy_redirect_only"),
    ({"status": "tcp_error"}, {"status": "http_response", "http_status": 200}, False, "proxy_only"),
    ({"status": "http_response", "http_status": 451, "block_page_hint": True}, {"status": "http_response", "http_status": 200}, True, "direct_block_page"),
    ({"status": "http_response", "http_status": 403}, {"status": "http_response", "http_status": 200}, False, "different_response"),
])
def test_resource_comparison_separates_network_and_registry(monkeypatch, direct, proxy, listed, expected):
    from services import provider_diagnostics as diagnostics

    address = (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 443))
    monkeypatch.setattr(diagnostics, "_resource_addresses", lambda host, port: [address])
    monkeypatch.setattr(diagnostics, "_xkeen_direct_mark", lambda: 0)
    monkeypatch.setattr(diagnostics, "_resource_http_request", lambda _parts, *, address, bypass_mark=0: direct)
    monkeypatch.setattr(diagnostics, "_resource_via_proxy", lambda _entry, _parts, address: proxy)
    monkeypatch.setattr(diagnostics, "lookup_public_lists", lambda _raw: {
        "status": "ok", "listed": listed, "registry_domain": "kino.watch" if listed else "",
    })
    ref = diagnostics.register_proxy_context([{"protocol": "freedom", "settings": {"secret": "private"}}], 1)
    result = compare_resource_paths({"url": "https://kino.watch/path?token=private", "ref": ref, "index": 0})
    assert result["network"]["verdict"] == expected
    assert result["registry"]["listed"] is listed
    assert "private" not in json.dumps(result)


def test_resource_comparison_rejects_local_and_mixed_dns(monkeypatch):
    from services import provider_diagnostics as diagnostics

    for url in ("http://127.0.0.1/", "http://localhost/", "http://user:pass@kino.watch/"):
        with pytest.raises(ValueError):
            diagnostics._resource_url(url)
    assert diagnostics._resource_url("https://kino.watch/страница")[3] == "/%D1%81%D1%82%D1%80%D0%B0%D0%BD%D0%B8%D1%86%D0%B0"
    monkeypatch.setattr(diagnostics.socket, "getaddrinfo", lambda *_args, **_kwargs: [
        (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 443)),
        (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 443)),
    ])
    with pytest.raises(ValueError, match="локальный"):
        diagnostics._resource_addresses("kino.watch", 443)


def test_resource_comparison_uses_public_dns_after_local_failure(monkeypatch):
    from services import provider_diagnostics as diagnostics

    monkeypatch.setattr(diagnostics, "_resource_addresses", lambda _host, _port: [])
    monkeypatch.setattr(diagnostics, "compare_public_dns", lambda _raw: {
        "status": "ok", "public": ["8.8.8.8"],
    })
    seen = []

    def request(_parts, *, address, bypass_mark=0):
        seen.append(address[4][0])
        return {"status": "http_response", "http_status": 200, "connected_ip": address[4][0]}

    def via_proxy(_entry, _parts, address):
        seen.append(address[4][0])
        return {"status": "http_response", "http_status": 200, "connected_ip": address[4][0]}

    monkeypatch.setattr(diagnostics, "_resource_http_request", request)
    monkeypatch.setattr(diagnostics, "_xkeen_direct_mark", lambda: 0)
    monkeypatch.setattr(diagnostics, "_resource_via_proxy", via_proxy)
    monkeypatch.setattr(diagnostics, "lookup_public_lists", lambda _raw: {"status": "unavailable"})
    ref = diagnostics.register_proxy_context([{"protocol": "freedom"}], 1)
    result = diagnostics.compare_resource_paths({"url": "https://kino.watch/", "ref": ref, "index": 0})
    assert seen == ["8.8.8.8", "8.8.8.8"]
    assert result["network"]["verdict"] == "local_dns_failure"
    assert result["direct"]["dns_source"] == "public_fallback"


@pytest.mark.parametrize(("output_rules", "chain_rules", "expected"), [
    ("-P OUTPUT ACCEPT\n", "", 0),
    ("-A OUTPUT -p tcp -m conntrack ! --ctstate INVALID -m comment --comment xkeen_rule -j xkeen_out\n", "-A xkeen_out -m mark --mark 0xff -m comment --comment xkeen_rule -j RETURN\n-A xkeen_out -p tcp -m comment --comment xkeen_rule -j REDIRECT --to-ports 5000\n", 0xff),
    ("-A OUTPUT -p tcp -j xkeen_out\n", "-A xkeen_out -p tcp -j REDIRECT --to-ports 5000\n", None),
    ("-A OUTPUT -p tcp -j xkeen_out\n", "-A xkeen_out -p tcp -j REDIRECT --to-ports 5000\n-A xkeen_out -m mark --mark 0xff -j RETURN\n", None),
])
def test_resource_direct_mark_requires_early_firewall_exclusion(monkeypatch, output_rules, chain_rules, expected):
    from services import provider_diagnostics as diagnostics

    monkeypatch.setattr(diagnostics.sys, "platform", "linux")

    def run(args, **_kwargs):
        return subprocess.CompletedProcess(args, 0, output_rules if args[-1] == "OUTPUT" else chain_rules, "")

    monkeypatch.setattr(diagnostics.subprocess, "run", run)
    assert diagnostics._xkeen_direct_mark() == expected


def test_resource_direct_probe_refuses_to_fall_back_when_socket_mark_fails(monkeypatch):
    from services import provider_diagnostics as diagnostics

    class UnmarkedSocket:
        def settimeout(self, _value):
            pass

        def setsockopt(self, *_args):
            raise PermissionError("SO_MARK denied")

        def connect(self, _endpoint):
            pytest.fail("unmarked socket must not connect")

        def close(self):
            pass

    monkeypatch.setattr(diagnostics.socket, "socket", lambda *_args: UnmarkedSocket())
    address = (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 443))
    result = diagnostics._resource_http_request(("https", "kino.watch", 443, "/"), address=address, bypass_mark=0xff)
    assert result["status"] == "route_unverified"


def test_resource_direct_probe_marks_socket_before_connect(monkeypatch):
    from services import provider_diagnostics as diagnostics

    events = []

    class MarkedSocket:
        def settimeout(self, _value):
            pass

        def setsockopt(self, level, option, value):
            events.append(("mark", level, option, value))

        def connect(self, endpoint):
            events.append(("connect", endpoint))
            raise ConnectionRefusedError

        def close(self):
            pass

    monkeypatch.setattr(diagnostics.socket, "socket", lambda *_args: MarkedSocket())
    address = (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 443))
    result = diagnostics._resource_http_request(("https", "kino.watch", 443, "/"), address=address, bypass_mark=0xff)
    assert result["status"] == "tcp_error"
    assert events == [
        ("mark", socket.SOL_SOCKET, getattr(socket, "SO_MARK", 36), 0xff),
        ("connect", ("8.8.8.8", 443)),
    ]


def test_resource_direct_probe_reports_tls_timeout(monkeypatch):
    from services import provider_diagnostics as diagnostics

    class TimeoutContext:
        def wrap_socket(self, *_args, **_kwargs):
            raise TimeoutError

    monkeypatch.setattr(diagnostics.ssl, "create_default_context", lambda: TimeoutContext())
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        address = (socket.AF_INET, socket.SOCK_STREAM, 6, "", listener.getsockname())
        result = diagnostics._resource_http_request(("https", "kino.watch", 443, "/"), address=address)
    assert result["status"] == "tls_timeout"


def test_resource_comparison_does_not_claim_proxy_only_when_direct_route_is_unverified(monkeypatch):
    from services import provider_diagnostics as diagnostics

    address = (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 443))
    monkeypatch.setattr(diagnostics, "_resource_addresses", lambda _host, _port: [address])
    monkeypatch.setattr(diagnostics, "_xkeen_direct_mark", lambda: None)
    monkeypatch.setattr(diagnostics, "_resource_http_request", lambda *_args, **_kwargs: pytest.fail("unverified direct path must not connect"))
    monkeypatch.setattr(diagnostics, "_resource_via_proxy", lambda *_args: {"status": "http_response", "http_status": 200})
    monkeypatch.setattr(diagnostics, "lookup_public_lists", lambda _raw: {"status": "unavailable"})
    ref = diagnostics.register_proxy_context([{"protocol": "vless"}], 1)
    result = diagnostics.compare_resource_paths({"url": "https://kino.watch/", "ref": ref, "index": 0})
    assert result["direct"]["status"] == "route_unverified"
    assert result["network"] == {"verdict": "direct_unverified", "confidence": "low"}
    assert result["proxy"]["http_status"] == 200


def test_resource_comparison_route_returns_separate_verdicts_without_secrets(monkeypatch, tmp_path):
    from services import provider_diagnostics as diagnostics

    monkeypatch.setattr(diagnostics, "_resource_addresses", lambda _host, port: [
        (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", port)),
    ])
    monkeypatch.setattr(diagnostics, "_xkeen_direct_mark", lambda: 0)
    monkeypatch.setattr(diagnostics, "_resource_http_request", lambda _parts, *, address, bypass_mark=0: {
        "status": "http_response", "http_status": 200, "connected_ip": address[4][0],
    })
    monkeypatch.setattr(diagnostics, "_resource_via_proxy", lambda _entry, _parts, address: {
        "status": "http_response", "http_status": 200, "connected_ip": address[4][0],
    })
    monkeypatch.setattr(diagnostics, "lookup_public_lists", lambda _raw: {
        "status": "ok", "listed": True, "registry_domain": "kino.watch",
    })
    app = Flask(__name__)
    app.register_blueprint(create_provider_diagnostics_blueprint(
        xray_configs_dir=str(tmp_path), mihomo_config_file=str(tmp_path / "config.yaml")
    ))
    ref = diagnostics.register_proxy_context([{"protocol": "vless", "password": "private-secret"}], 1)
    response = app.test_client().post("/api/provider-diagnostics/resource-compare", json={
        "url": "https://kino.watch/?token=private-token", "ref": ref, "index": 0,
    })
    assert response.status_code == 200
    assert response.json["result"]["network"]["verdict"] == "both_reachable"
    assert response.json["result"]["registry"]["listed"] is True
    assert "private-secret" not in response.get_data(as_text=True)
    assert "private-token" not in response.get_data(as_text=True)


def test_resource_http_probe_does_not_follow_redirect_and_uses_pinned_proxy_ip():
    from services import provider_diagnostics as diagnostics

    seen = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            seen.append((self.path, self.headers.get("Host")))
            self.send_response(451 if self.path == "/blocked" else 200)
            if self.path == "/blocked":
                self.send_header("Location", "https://other.example/path")
            self.send_header("Content-Length", "0")
            self.end_headers()

        def log_message(self, *_args):
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        address = (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", server.server_port))
        direct = diagnostics._resource_http_request(("http", "kino.watch", server.server_port, "/blocked"), address=address)
        proxy = diagnostics._resource_http_request(("http", "kino.watch", 80, "/"), address=(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 80)), proxy_port=server.server_port)
    finally:
        server.shutdown()
        worker.join(timeout=2)
        server.server_close()
    assert direct["http_status"] == 451 and direct["block_page_hint"] is True
    assert direct["redirect_host"] == "other.example"
    assert proxy["http_status"] == 200
    assert seen == [("/blocked", f"kino.watch:{server.server_port}"), ("http://8.8.8.8:80/", "kino.watch")]


def test_mihomo_json_subscription_works_without_yaml(monkeypatch, tmp_path):
    monkeypatch.setitem(sys.modules, "yaml", None)
    app = Flask(__name__)
    app.register_blueprint(create_provider_diagnostics_blueprint(
        xray_configs_dir=str(tmp_path), mihomo_config_file=str(tmp_path / "config.yaml")
    ))
    source = json.dumps({"proxies": [{
        "name": "Private", "type": "vless", "server": "edge.example", "port": 443,
        "uuid": "private-uuid",
    }]})
    response = app.test_client().post("/api/provider-diagnostics/parse", json={
        "source": source, "core": "mihomo",
    })
    assert response.status_code == 200
    assert response.json["targets"][0]["proxy_engine"] == "mihomo"
    assert response.json["targets"][0]["proxy_ref"]
    assert "private-uuid" not in response.get_data(as_text=True)


def test_failed_subscription_is_not_reported_as_provider_server(monkeypatch):
    from services import xray_subscriptions

    def fail(_url, **_kwargs):
        raise TimeoutError("private-token")

    monkeypatch.setattr(xray_subscriptions, "fetch_subscription_body_for_xray", fail)
    result = parse_source("https://provider.example/subscription/private-token")
    assert result["targets"] == []
    assert "private-token" not in json.dumps(result)
    assert "Не удалось получить" in result["warnings"][0]


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


def test_tcp_probe_succeeds_and_udp_is_explicitly_unverified(direct_route):
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


def test_tcp_probe_marks_socket_before_connect_and_refuses_unmarked_route(monkeypatch):
    from services import provider_diagnostics as diagnostics

    address = (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("198.51.100.30", 443))
    monkeypatch.setattr(diagnostics.socket, "getaddrinfo", lambda *_args, **_kwargs: [address])
    events = []

    class ProbeSocket:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            pass

        def settimeout(self, _value):
            pass

        def setsockopt(self, *_args):
            events.append("mark")

        def connect(self, _endpoint):
            events.append("connect")
            raise ConnectionRefusedError

    monkeypatch.setattr(diagnostics.socket, "socket", lambda *_args: ProbeSocket())
    monkeypatch.setattr(diagnostics, "_xkeen_direct_mark", lambda: 0xff)
    assert diagnostics.probe_target(make_target("edge.example.org", 443))["status"] == "refused"
    assert events == ["mark", "connect"]

    monkeypatch.setattr(diagnostics, "_mark_direct_socket", lambda *_args: False)
    events.clear()
    result = diagnostics.probe_target(make_target("edge.example.org", 443))
    assert result["status"] == "route_unverified"
    assert events == []


def test_tls_comparison_attempt_distinguishes_tcp_and_tls_timeouts(monkeypatch):
    from services import provider_diagnostics as diagnostics

    address = (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("198.51.100.30", 443))
    events = []

    class ProbeSocket:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            pass

        def settimeout(self, _value):
            pass

        def setsockopt(self, *_args):
            events.append("mark")

        def connect(self, _endpoint):
            events.append("connect")
            if stage == "tcp":
                raise TimeoutError

    class TimeoutContext:
        check_hostname = True
        verify_mode = ssl.CERT_REQUIRED

        def wrap_socket(self, *_args, **_kwargs):
            raise TimeoutError

    monkeypatch.setattr(diagnostics.socket, "socket", lambda *_args: ProbeSocket())
    monkeypatch.setattr(diagnostics.ssl, "create_default_context", lambda: TimeoutContext())
    for stage, expected in (("tcp", "tcp_timeout"), ("tls", "tls_timeout")):
        events.clear()
        assert diagnostics._tls_comparison_attempt(address, server_name="front.example.org", bypass_mark=0xff) == expected
        assert events == ["mark", "connect"]
    monkeypatch.setattr(diagnostics, "_mark_direct_socket", lambda *_args: False)
    events.clear()
    assert diagnostics._tls_comparison_attempt(address, server_name="front.example.org", bypass_mark=0xff) == "route_unverified"
    assert events == []


def test_standard_tls_probe_reports_handshake_timeout(monkeypatch, direct_route):
    from services import provider_diagnostics as diagnostics

    class ProbeSocket:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            pass

        def settimeout(self, _value):
            pass

        def connect(self, _endpoint):
            pass

        def getsockname(self):
            return ("192.0.2.10", 45678)

    class TimeoutContext:
        def wrap_socket(self, *_args, **_kwargs):
            raise TimeoutError

    monkeypatch.setattr(diagnostics.socket, "getaddrinfo", lambda *_args, **_kwargs: [
        (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("198.51.100.30", 443)),
    ])
    monkeypatch.setattr(diagnostics.socket, "socket", lambda *_args: ProbeSocket())
    monkeypatch.setattr(diagnostics.ssl, "create_default_context", lambda: TimeoutContext())
    result = diagnostics.probe_target(make_target("edge.example.org", 443, tls=True, sni="front.example.org"))
    assert result["status"] == "tls_timeout"
    assert result["tcp_ms"] >= 0


def test_standard_tls_probe_uses_configured_sni_and_reports_socket_path(monkeypatch, direct_route):
    from services import provider_diagnostics

    seen = []

    class FakeSocket:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def settimeout(self, _timeout):
            pass

        def connect(self, address):
            seen.append(address)

        def getsockname(self):
            return ("192.0.2.10", 45678)

    class FakeTls:
        def wrap_socket(self, _socket, *, server_hostname):
            seen.append(server_hostname)
            return FakeSocket()

    monkeypatch.setattr(provider_diagnostics.socket, "getaddrinfo", lambda *_args, **_kwargs: [
        (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("198.51.100.30", 443)),
    ])
    monkeypatch.setattr(provider_diagnostics.socket, "socket", lambda *_args: FakeSocket())
    monkeypatch.setattr("ssl.create_default_context", lambda: FakeTls())
    result = probe_target(make_target("edge.example.org", 443, tls=True, sni="front.example.org"))
    assert seen == [("198.51.100.30", 443), "front.example.org"]
    assert (result["connected_ip"], result["source_ip"], result["status"]) == ("198.51.100.30", "192.0.2.10", "reachable")
    assert result["sni_sent"] is True

    seen.clear()
    ip_result = probe_target(make_target("198.51.100.30", 443, tls=True))
    assert ip_result["sni_sent"] is False


def test_reality_probe_reports_tcp_only(monkeypatch, direct_route):
    from services import provider_diagnostics

    class FakeSocket:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def settimeout(self, _timeout):
            pass

        def connect(self, _address):
            pass

        def getsockname(self):
            return ("192.0.2.10", 45678)

    monkeypatch.setattr(provider_diagnostics.socket, "getaddrinfo", lambda *_args, **_kwargs: [
        (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("198.51.100.30", 443)),
    ])
    monkeypatch.setattr(provider_diagnostics.socket, "socket", lambda *_args: FakeSocket())
    result = probe_target(make_target("edge.example.org", 443, tls_mode="reality", sni="front.example.org"))
    assert result["status"] == "reachable"
    assert result["tls"] is False
    assert "REALITY" in result["message"]


def test_certificate_failure_is_separate_from_handshake_failure(monkeypatch, direct_route):
    from services import provider_diagnostics

    class FakeSocket:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def settimeout(self, _timeout):
            pass

        def connect(self, _address):
            pass

        def getsockname(self):
            return ("192.0.2.10", 45678)

    class FakeTls:
        def __init__(self):
            self.check_hostname = True
            self.verify_mode = ssl.CERT_REQUIRED

        def wrap_socket(self, _socket, *, server_hostname):
            assert server_hostname == "front.example.org"
            if self.verify_mode == ssl.CERT_REQUIRED:
                raise ssl.SSLCertVerificationError("bad certificate")
            return FakeSocket()

    contexts = []

    def context():
        instance = FakeTls()
        contexts.append(instance)
        return instance

    monkeypatch.setattr(provider_diagnostics.socket, "getaddrinfo", lambda *_args, **_kwargs: [
        (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("198.51.100.30", 443)),
    ])
    monkeypatch.setattr(provider_diagnostics.socket, "socket", lambda *_args: FakeSocket())
    monkeypatch.setattr(provider_diagnostics.ssl, "create_default_context", context)
    raw = make_target("edge.example.org", 443, tls=True, sni="front.example.org")
    failed = probe_target(raw)
    assert failed["status"] == "tls_cert_error"
    assert "не указывает на блокировку" in failed["message"]
    raw["verify_tls"] = False
    reachable = probe_target(raw)
    assert reachable["status"] == "reachable"
    assert contexts[-1].check_hostname is False
    assert contexts[-1].verify_mode == ssl.CERT_NONE


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


def test_invalid_tls_mode_is_rejected():
    with pytest.raises(ValueError, match="режим TLS"):
        make_target("example.com", 443, tls_mode=["standard"])


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
    assert client.get("/api/provider-diagnostics/targets?core=xray&offset=bad").status_code == 400
    assert client.post("/api/provider-diagnostics/parse", json={"source": "example.com"}).json["targets"][0]["host"] == "example.com"
    assert client.post("/api/provider-diagnostics/probe", json={"host": "bad host", "port": 443}).status_code == 400
    assert client.post("/api/provider-diagnostics/dns-compare", json={"host": "router.local"}).status_code == 400
    assert client.post("/api/provider-diagnostics/public-lists", json={"host": "192.168.1.1"}).status_code == 400

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
APP_DIR = ROOT / "xkeen-ui"
FIXTURES = ROOT / "tests" / "fixtures" / "mihomo_clash"

if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))


def fixture(name: str):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def test_contract_fixture_set_is_complete_and_redacted():
    expected = {
        "version.json",
        "configs.json",
        "proxies.json",
        "group.json",
        "providers-proxies.json",
        "providers-rules.json",
        "rules.json",
        "connections-01.json",
        "connections-02.json",
        "connections-03.json",
        "errors.json",
    }
    assert expected.issubset({item.name for item in FIXTURES.glob("*.json")})
    serialized = "\n".join(
        (FIXTURES / name).read_text(encoding="utf-8") for name in expected
    ).lower()
    assert "secret" not in serialized
    assert "subscription" not in serialized


def test_target_discovery_prefers_ready_unix_socket_and_redacts_secret(tmp_path: Path):
    from services.mihomo_clash_target import discover_mihomo_clash_target

    root = tmp_path / "mihomo"
    root.mkdir()
    config = root / "config.yaml"
    config.write_text(
        "external-controller-unix: run/mihomo.sock\n"
        "external-controller: 0.0.0.0:9090\n"
        "secret: \"fixture-secret\"\n",
        encoding="utf-8",
    )
    result = discover_mihomo_clash_target(
        config,
        root,
        socket_probe=lambda path: path == root / "run" / "mihomo.sock",
    )

    assert result.target is not None
    assert result.target.transport == "unix"
    assert result.target.authorization_header() == "Bearer fixture-secret"
    assert "fixture-secret" not in repr(result)
    assert "fixture-secret" not in repr(result.target)
    assert result.public_dict()["secret_configured"] is True
    assert result.public_dict()["target_ready"] is True


def test_target_discovery_forces_loopback_and_rejects_unallowed_port(tmp_path: Path):
    from services.mihomo_clash_target import discover_mihomo_clash_target

    root = tmp_path / "mihomo"
    root.mkdir()
    config = root / "config.yaml"
    config.write_text(
        "external-controller: 10.0.0.2:9191\nsecret: router-secret\n",
        encoding="utf-8",
    )
    result = discover_mihomo_clash_target(
        config,
        root,
        environ={"XKEEN_CLASH_API_ALLOWED_PORTS": "9090"},
    )

    assert result.target is None
    assert any(item.code == "port_not_allowed" for item in result.diagnostics)
    assert all("10.0.0.2" not in str(item.public_dict()) for item in result.diagnostics)


def test_target_discovery_flags_lan_binding_without_secret(tmp_path: Path):
    from services.mihomo_clash_target import discover_mihomo_clash_target

    root = tmp_path / "mihomo"
    root.mkdir()
    config = root / "config.yaml"
    config.write_text("external-controller: 0.0.0.0:9090\n", encoding="utf-8")
    result = discover_mihomo_clash_target(config, root)

    assert result.target is not None
    assert result.target.loopback_host == "127.0.0.1"
    assert any(item.code == "secret_missing_on_lan_bind" for item in result.diagnostics)


def test_status_dto_is_versioned_and_drops_raw_sensitive_fields(tmp_path: Path):
    from services.mihomo_clash_dto import build_mihomo_clash_status_dto
    from services.mihomo_clash_target import discover_mihomo_clash_target

    root = tmp_path / "mihomo"
    root.mkdir()
    config = root / "config.yaml"
    config.write_text("external-controller: 127.0.0.1:9090\nsecret: fixture-secret\n", encoding="utf-8")
    discovery = discover_mihomo_clash_target(config, root)
    dto = build_mihomo_clash_status_dto(
        discovery,
        version_payload={"version": "Mihomo Meta v1", "secret": "leak"},
        config_payload={"mode": "RULE", "secret": "leak", "tun": {"enable": True}},
        capabilities={
            "status": True,
            "proxy_groups": False,
            "unknown_future_endpoint": True,
        },
    )

    assert dto["schema_version"] == 1
    assert dto["core"]["version"] == "Mihomo Meta v1"
    assert dto["runtime"]["mode"] == "rule"
    assert dto["runtime"]["tun_enabled"] is True
    assert dto["capabilities"]["status"] is True
    assert dto["capabilities"]["proxy_groups"] is False
    assert dto["capabilities"]["connections_stream"] is None
    assert "unknown_future_endpoint" not in dto["capabilities"]
    serialized = json.dumps(dto).lower()
    assert "fixture-secret" not in serialized
    assert "leak" not in serialized


def test_proxy_groups_dto_retains_order_and_provider_enrichment():
    from services.mihomo_clash_dto import build_mihomo_clash_proxy_groups_dto

    dto = build_mihomo_clash_proxy_groups_dto(
        fixture("proxies.json"), fixture("providers-proxies.json")
    )

    assert [group["name"] for group in dto["groups"]] == ["AUTO"]
    auto = next(group for group in dto["groups"] if group["name"] == "AUTO")
    assert auto["now"] == "node-a"
    assert auto["nodes"][1]["provider"] == "demo-provider"
    assert auto["nodes"][1]["provider_candidates"] == ["demo-provider"]
    assert auto["nodes"][1]["provider_ambiguous"] is False
    assert auto["nodes"][0]["delay_ms"] == 87
    assert auto["nodes"][0]["delay_history"] == [
        {"measured_at": "2026-08-09T16:00:00Z", "delay_ms": 87}
    ]
    assert auto["nodes"][0]["availability"] == "available"
    assert auto["nodes"][1]["availability"] == "unavailable"


def test_proxy_groups_dto_bounds_and_sanitizes_delay_history():
    from services.mihomo_clash_dto import build_mihomo_clash_proxy_groups_dto

    proxies = fixture("proxies.json")
    proxies["proxies"]["node-a"]["history"] = [
        {
            "time": f"2026-08-16T12:00:{index:02d}Z",
            "delay": index * 10,
            "secret": "must-not-leak",
        }
        for index in range(12)
    ] + [{"time": "ignored", "delay": "not-a-number"}]

    node = build_mihomo_clash_proxy_groups_dto(proxies)["groups"][0]["nodes"][0]

    assert len(node["delay_history"]) == 10
    assert node["delay_history"][0] == {
        "measured_at": "2026-08-16T12:00:02Z",
        "delay_ms": 20,
    }
    assert node["delay_history"][-1]["delay_ms"] == 110
    assert node["delay_ms"] == 110
    assert "secret" not in json.dumps(node["delay_history"])


def test_proxy_groups_dto_exposes_only_safe_https_group_icon_urls():
    from services.mihomo_clash_dto import build_mihomo_clash_proxy_groups_dto

    proxies = fixture("proxies.json")
    proxies["proxies"]["AUTO"]["icon"] = "https://cdn.example.test/icons/auto.png"
    dto = build_mihomo_clash_proxy_groups_dto(proxies)
    assert dto["groups"][0]["icon"] == "https://cdn.example.test/icons/auto.png"

    for unsafe in ("http://cdn.example.test/icon.png", "data:image/svg+xml,boom", "javascript:alert(1)"):
        proxies["proxies"]["AUTO"]["icon"] = unsafe
        assert build_mihomo_clash_proxy_groups_dto(proxies)["groups"][0]["icon"] == ""


def test_proxy_groups_dto_does_not_guess_provider_when_names_collide():
    from services.mihomo_clash_dto import build_mihomo_clash_proxy_groups_dto

    providers = fixture("providers-proxies.json")
    providers["providers"]["second-provider"] = {
        "name": "second-provider",
        "proxies": [{"name": "node-b", "type": "VLESS", "alive": True}],
    }
    dto = build_mihomo_clash_proxy_groups_dto(fixture("proxies.json"), providers)

    auto = dto["groups"][0]
    node = next(item for item in auto["nodes"] if item["name"] == "node-b")
    assert node["provider"] == ""
    assert node["provider_candidates"] == ["demo-provider", "second-provider"]
    assert node["provider_ambiguous"] is True


def test_proxy_groups_dto_adds_display_safe_transport_details_by_provider():
    from services.mihomo_clash_dto import build_mihomo_clash_proxy_groups_dto

    dto = build_mihomo_clash_proxy_groups_dto(
        fixture("proxies.json"),
        fixture("providers-proxies.json"),
        {
            "providers": {
                "demo-provider": {
                    "node-b": {
                        "server": "edge.example.test",
                        "port": 443,
                        "network": "xhttp",
                        "security": "tls",
                        "host": "cdn.example.test",
                        "path": "/api/v2/",
                    }
                }
            }
        },
    )

    node = next(item for item in dto["groups"][0]["nodes"] if item["name"] == "node-b")
    assert node["server"] == "edge.example.test"
    assert node["port"] == 443
    assert node["network"] == "xhttp"
    assert node["security"] == "tls"
    assert node["host"] == "cdn.example.test"
    assert node["path"] == "/api/v2/"


def test_proxy_groups_dto_keeps_shared_details_for_ambiguous_provider_membership():
    from services.mihomo_clash_dto import build_mihomo_clash_proxy_groups_dto

    providers = fixture("providers-proxies.json")
    providers["providers"]["second-provider"] = {
        "name": "second-provider",
        "proxies": [{"name": "node-b", "type": "VLESS", "alive": True}],
    }
    common = {"server": "shared.example.test", "port": 443, "network": "xhttp"}
    dto = build_mihomo_clash_proxy_groups_dto(
        fixture("proxies.json"),
        providers,
        {"providers": {
            "demo-provider": {"node-b": common},
            "second-provider": {"node-b": common},
        }},
    )

    node = next(item for item in dto["groups"][0]["nodes"] if item["name"] == "node-b")
    assert node["provider_ambiguous"] is True
    assert node["server"] == "shared.example.test"
    assert node["network"] == "xhttp"


def test_proxy_groups_dto_uses_safe_runtime_details_as_fallback():
    from services.mihomo_clash_dto import build_mihomo_clash_proxy_groups_dto

    proxies = fixture("proxies.json")
    proxies["proxies"]["node-a"].update({
        "server": "runtime.example.test", "port": 8443, "network": "ws", "tls": "tls",
    })
    dto = build_mihomo_clash_proxy_groups_dto(proxies)
    node = dto["groups"][0]["nodes"][0]
    assert node["server"] == "runtime.example.test"
    assert node["port"] == 8443
    assert node["network"] == "ws"
    assert node["security"] == "tls"


def test_rules_and_providers_dtos_are_bounded_and_drop_raw_source_fields():
    from services.mihomo_clash_dto import (
        build_mihomo_clash_providers_dto,
        build_mihomo_clash_rules_dto,
    )

    proxy_payload = fixture("providers-proxies.json")
    proxy_payload["providers"]["demo-provider"].update(
        {
            "url": "https://credential.invalid/list",
            "path": "/private/provider.yaml",
            "headers": {"Authorization": "secret"},
            "healthCheck": {"enable": True},
            "subscriptionInfo": {
                "Upload": 123,
                "Download": 456,
                "Total": 107374182400,
                "Expire": 1780000000000,
                "url": "https://nested-secret.invalid/list",
            },
        }
    )
    rules = build_mihomo_clash_rules_dto(fixture("rules.json"))
    providers = build_mihomo_clash_providers_dto(
        proxy_payload,
        fixture("providers-rules.json"),
    )

    assert rules["rules"][0] == {
        "index": 7,
        "type": "DomainSuffix",
        "payload": "example.invalid",
        "target": "AUTO",
        "disabled": None,
        "size": None,
    }
    assert [item["kind"] for item in providers["providers"]] == ["proxy", "rule"]
    assert rules["rules"][2]["index"] == 9
    assert rules["rules"][2]["disabled"] is False
    assert providers["providers"][0]["healthcheck"] is True
    assert providers["providers"][0]["subscription"] == {
        "used": 579,
        "total": 107374182400,
        "expires_at": 1780000000,
    }
    assert providers["providers"][1]["subscription"] is None
    assert providers["providers"][1]["count"] == 42
    serialized = json.dumps([rules, providers])
    assert "credential.invalid" not in serialized
    assert "nested-secret.invalid" not in serialized
    assert "Authorization" not in serialized
    assert "/private/provider.yaml" not in serialized


def test_structured_log_dto_redacts_secret_headers_and_sensitive_fields():
    from services.mihomo_clash_dto import build_mihomo_clash_log_entry_dto

    entry = build_mihomo_clash_log_entry_dto(
        {
            "time": "2026-08-10T10:00:00Z",
            "level": "warning",
            "message": "dial failed Authorization=fixture-secret Bearer fixture-secret",
            "fields": {
                "host": "example.invalid",
                "token": "fixture-secret",
                "detail": "password=fixture-secret",
            },
        },
        sequence=7,
        secret="fixture-secret",
    )

    assert entry["sequence"] == 7
    assert entry["level"] == "warning"
    assert entry["fields"] == {"host": "example.invalid", "detail": "password=[redacted]"}
    assert "fixture-secret" not in json.dumps(entry)

    list_fields = build_mihomo_clash_log_entry_dto(
        {
            "level": "info",
            "message": "list fields",
            "fields": [
                {"key": "network", "value": "tcp"},
                {"name": "token", "value": "fixture-secret"},
            ],
        },
        secret="fixture-secret",
    )
    assert list_fields["fields"] == {"network": "tcp"}


def test_structured_log_dto_enriches_only_router_known_ips():
    from services.mihomo_clash_dto import build_mihomo_clash_log_entry_dto

    entry = build_mihomo_clash_log_entry_dto(
        {
            "level": "info",
            "message": "accepted 192.0.2.10:51432 from [fd00::10]:443; ignored 203.0.113.9",
            "fields": {"source": "192.0.2.10", "invalid": "999.999.999.999"},
        },
        device_map={
            "192.0.2.10": {"name": "Ноутбук"},
            "fd00::10": {"name": "Телефон"},
        },
    )

    assert entry["devices"] == [
        {"ip": "192.0.2.10", "name": "Ноутбук"},
        {"ip": "fd00::10", "name": "Телефон"},
    ]
    assert "203.0.113.9" in entry["message"]


def test_structured_log_dto_bounds_device_aliases():
    from services.mihomo_clash_dto import build_mihomo_clash_log_entry_dto

    ips = [f"192.0.2.{index}" for index in range(1, 12)]
    entry = build_mihomo_clash_log_entry_dto(
        {"message": " ".join(ips)},
        device_map={ip: {"name": f"device-{index}"} for index, ip in enumerate(ips)},
    )

    assert len(entry["devices"]) == 8


def test_delay_dto_normalizes_proxy_and_group_results():
    from services.mihomo_clash_dto import build_mihomo_clash_delay_dto

    proxy = build_mihomo_clash_delay_dto(
        {"delay": 87, "secret": "drop"},
        scope="proxy",
        name="node-a",
        preset="google",
    )
    group = build_mihomo_clash_delay_dto(
        {"node-a": 87, "node-b": 0, "invalid": "timeout"},
        scope="group",
        name="AUTO",
        preset="cloudflare",
    )

    assert proxy["results"] == [{"name": "node-a", "delay_ms": 87}]
    assert group["results"] == [
        {"name": "node-a", "delay_ms": 87},
        {"name": "node-b", "delay_ms": 0},
    ]
    assert "secret" not in json.dumps(proxy).lower()


def test_delay_dto_normalizes_wrapped_mihomo_group_results():
    from services.mihomo_clash_dto import build_mihomo_clash_delay_dto

    group = build_mihomo_clash_delay_dto(
        {"proxies": [{"name": "node-a", "delay": 62}, {"name": "node-b", "delay": 95}]},
        scope="group",
        name="AUTO",
        preset="google",
    )

    assert group["results"] == [
        {"name": "node-a", "delay_ms": 62},
        {"name": "node-b", "delay_ms": 95},
    ]


def test_connections_dto_is_bounded_and_resolves_source_device():
    from services.mihomo_clash_dto import build_mihomo_clash_connections_dto

    payload = fixture("connections-02.json")
    payload["connections"].append({"id": "conn-003", "metadata": {}})
    dto = build_mihomo_clash_connections_dto(
        payload, device_map={"192.0.2.10": {"name": "operator-laptop"}}, max_rows=2
    )

    assert dto["schema_version"] == 1
    assert dto["total_connections"] == 3
    assert dto["truncated"] is True
    assert len(dto["connections"]) == 2
    assert dto["connections"][0]["metadata"]["source_name"] == "operator-laptop"
    assert dto["connections"][0]["metadata"]["remote_destination"] == "198.51.100.20:443"
    assert dto["connections"][0]["metadata"]["dns_mode"] == "normal-redir"
    assert dto["connections"][0]["metadata"]["inbound_ip"] == "192.0.2.254"
    assert dto["connections"][0]["metadata"]["process_path"] == "/usr/bin/browser"
    assert dto["connections"][0]["metadata"]["uid"] == 1000
    assert dto["connections"][0]["chains"] == ["AUTO", "node-a"]
    assert "secret" not in json.dumps(dto).lower()
